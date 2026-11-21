import { generateKeyPairSync } from "node:crypto"
import { join } from "node:path"
import { afterEach, describe, expect, jest, test } from "bun:test"
import { createFakeAdapter, FAKE_SPEC } from "../adapter/fake"
import type { AgentAdapter } from "../adapter/types"
import { DEFAULT_RELAY, RELAY_ON_BY_DEFAULT, relayBases, relayPlan, relaySetting } from "../config"
import { pairUrl } from "../pair"
import { eventFrame } from "../protocol"
import { startServer } from "../server"
import { Store } from "../store"
import { type FakeRelay, type RelayPhone, relayPhone, startFakeRelay } from "./fake-relay"
import { base32, identityFrom, type RelayIdentity, slotIdFor } from "./identity"
import { CONFIRM_MS, RelayConn } from "./conn"
import { decodeMux, MuxType, parseClose, RelayClose } from "./mux"
import { SecureChannel } from "./frame"
import { NoiseHandshake, pairingPsk, relayPrologue, relayPsk } from "./noise"

// Local copy of relay/src/pass.ts (see fixtures/README.md), loaded at run time so typings stay out of this package's lib.
const { verifyPass } = (await import(join(import.meta.dir, "fixtures/verify-pass.ts"))) as { verifyPass: (pass: string, slot: string, device: string, nowSec: number) => Promise<boolean> }

type Started = ReturnType<typeof startServer>

let relay: FakeRelay | null = null
let started: Started | null = null
const phones: RelayPhone[] = []

afterEach(() => {
  for (const phone of phones.splice(0)) phone.close()
  started?.stopRelay()
  started?.server.stop(true)
  relay?.stop()
  started = null
  relay = null
})

async function until(check: () => boolean, label: string, ms = 3000) {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await Bun.sleep(5)
  }
}

function identity(): RelayIdentity {
  return identityFrom(generateKeyPairSync("ed25519").privateKey)
}

async function boot(options: { onPairingRotated?: () => void; adapter?: AgentAdapter } = {}) {
  relay = startFakeRelay()
  const store = new Store(":memory:")
  store.seedIfEmpty()
  const id = identity()
  started = startServer({
    store,
    host: "127.0.0.1",
    port: 0,
    relay: { bases: [relay.url], identity: id, minBackoffMs: 10, maxBackoffMs: 50 },
    onPairingRotated: options.onPairingRotated,
    // The real registry probes every installed CLI before the first hello answers (copilot alone ~3 s), which
    // put these transport tests at the mercy of this computer's load.
    adapter: options.adapter ?? createFakeAdapter(),
  })
  await until(() => started!.relayLinks()[0]!.state === "connected", "the relay link")
  return { store, id, started, relay }
}

function phone(options: Parameters<typeof relayPhone>[0]) {
  const made = relayPhone(options)
  phones.push(made)
  return made
}

/** Pairs a device through the relay and returns its credentials. */
async function pairOverRelay(id: RelayIdentity, name = "iPhone") {
  const token = started!.pairLink().token
  const pairing = phone({ relayUrl: relay!.url, slotId: id.slotId, deviceId: "", pairingToken: token })
  await pairing.ready
  const result = await pairing.call("pair.redeem", { token, name })
  expect(result.type).toBe("result")
  const paired = result.result as { deviceId: string; sessionKey: string }
  expect((await pairing.closed).code).toBe(1000)
  return paired
}

describe("relay identity and config", () => {
  test("slot id is the first 26 base32 characters of SHA-256(public key)", () => {
    expect(base32(Buffer.from("foobar"))).toBe("mzxw6ytboi")
    const id = identity()
    expect(id.slotId).toMatch(/^[a-z2-7]{26}$/)
    expect(slotIdFor(id.publicKey)).toBe(id.slotId)
  })

  test("RUDDER_RELAY: unset follows the on-by-default switch, on is the default base, a list is kept in order", () => {
    const saved = process.env.RUDDER_RELAY
    delete process.env.RUDDER_RELAY
    try {
    expect(RELAY_ON_BY_DEFAULT).toBe(true)
    expect(relayBases(undefined)).toEqual([DEFAULT_RELAY])
    expect(relayBases("")).toEqual([DEFAULT_RELAY])
    expect(relayBases(undefined, false)).toEqual([])
    expect(relayBases("", false)).toEqual([])
    expect(relayBases("off")).toEqual([])
    expect(relayBases(" OFF ")).toEqual([])
    expect(relayBases("on")).toEqual([DEFAULT_RELAY])
    // The one-line switch: on by default means unset dials DEFAULT_RELAY.
    expect(relayBases(undefined, true)).toEqual([DEFAULT_RELAY])
    expect(relayBases("off", true)).toEqual([])
    expect(relayBases("wss://a.example/, wss://b.example")).toEqual(["wss://a.example", "wss://b.example"])
    expect(() => relayBases("https://a.example")).toThrow("RUDDER_RELAY")
    expect(() => relayBases("wss://a.example/path")).toThrow("RUDDER_RELAY")
    } finally {
      if (saved === undefined) delete process.env.RUDDER_RELAY
      else process.env.RUDDER_RELAY = saved
    }
  })

  test("a saved relay mode applies only when RUDDER_RELAY is unset; the default is now on", () => {
    expect(RELAY_ON_BY_DEFAULT).toBe(true)
    expect(relaySetting(undefined, null)).toBeUndefined()
    expect(relayPlan(relaySetting(undefined, "on"))).toEqual({ bases: [DEFAULT_RELAY], discover: true })
    expect(relayPlan(relaySetting(undefined, "off"), true)).toEqual({ bases: [], discover: false })
    expect(relayPlan(relaySetting("off", "on"))).toEqual({ bases: [], discover: false })
    expect(relayPlan(relaySetting("wss://mine.example", "on"))).toEqual({ bases: ["wss://mine.example"], discover: false })
  })

  test("only on / unset-with-default lets the relay list pick the bases; an explicit list always wins", () => {
    const saved = process.env.RUDDER_RELAY
    delete process.env.RUDDER_RELAY
    try {
    expect(relayPlan(undefined)).toEqual({ bases: [DEFAULT_RELAY], discover: true })
    expect(relayPlan(undefined, false)).toEqual({ bases: [], discover: false })
    expect(relayPlan("off", true)).toEqual({ bases: [], discover: false })
    expect(relayPlan("on")).toEqual({ bases: [DEFAULT_RELAY], discover: true })
    expect(relayPlan(" ON ")).toEqual({ bases: [DEFAULT_RELAY], discover: true })
    expect(relayPlan("", true)).toEqual({ bases: [DEFAULT_RELAY], discover: true })
    expect(relayPlan(DEFAULT_RELAY)).toEqual({ bases: [DEFAULT_RELAY], discover: false })
    expect(relayPlan("wss://relay.mine.example", true)).toEqual({ bases: ["wss://relay.mine.example"], discover: false })
    } finally {
      if (saved === undefined) delete process.env.RUDDER_RELAY
      else process.env.RUDDER_RELAY = saved
    }
  })

  test("the pair link carries relay= only when the relay is on", () => {
    expect(pairUrl(["10.0.0.2"], 7749, "t", "f".repeat(64), 1_000_000, "slot")).toBe(
      `rudder://pair?host=10.0.0.2:7749&fp=${"f".repeat(64)}&relay=slot&exp=1000&token=t`,
    )
    expect(pairUrl(["10.0.0.2"], 7749, "t")).toBe("rudder://pair?host=10.0.0.2:7749&token=t")
    expect(pairUrl(["10.0.0.2"], 7749, "t", null, null, "slot", "wss://relay.mine.example")).toBe(
      "rudder://pair?host=10.0.0.2:7749&relay=slot&relayUrl=wss%3A%2F%2Frelay.mine.example&token=t",
    )
    // No slot, no relayUrl.
    expect(pairUrl(["10.0.0.2"], 7749, "t", null, null, null, "wss://relay.mine.example")).not.toContain("relayUrl")
  })

  test("without relay options the server opens no outbound connection", () => {
    const store = new Store(":memory:")
    started = startServer({ store, host: "127.0.0.1", port: 0 })
    expect(started.relayLinks()).toEqual([])
    expect(started.pairLink().url).not.toContain("relay=")
  })
})

describe("rudderd over the relay", () => {
  test("pairs, says hello, lists sessions and gets chunked events end to end", async () => {
    const rotated: number[] = []
    const { id } = await boot({ onPairingRotated: () => rotated.push(Date.now()) })
    expect(started!.pairLink().url).toContain(`&relay=${id.slotId}`)
    // A non-default relay (here the test one) rides in the link for the phone to dial.
    expect(started!.pairLink().url).toContain(`&relayUrl=${encodeURIComponent(relay!.url)}`)
    const paired = await pairOverRelay(id)
    expect(rotated.length).toBe(1)

    const device = phone({ relayUrl: relay!.url, slotId: id.slotId, deviceId: paired.deviceId, sessionKey: paired.sessionKey })
    await device.ready
    const hello = await device.call("hello", { features: ["delta"] })
    expect(hello.type).toBe("result")
    const listed = await device.call("session.list")
    expect(listed.type).toBe("result")
    const sessions = (listed.result as { sessions: { title: string }[] }).sessions
    expect(sessions.map((s) => s.title)).toContain("示例会话")

    // 200 KB is four Noise messages each way of the relay.
    const big = "流".repeat(70_000)
    started!.broadcast(eventFrame("test.big", { text: big, marker: "plaintext-marker-7f3a" }))
    const event = await device.nextEvent((frame) => frame.name === "test.big")
    expect((event.payload as { text: string }).text).toBe(big)

    // The relay forwarded everything above and never held any of it in the clear.
    const seen = Buffer.concat(relay!.seen)
    for (const plain of ["示例会话", "session.list", "plaintext-marker-7f3a", "pair.redeem", paired.sessionKey, "hello"]) {
      expect(seen.includes(Buffer.from(plain, "utf8"))).toBe(false)
    }
  })

  test("denseSearchReturnsBelowNoiseFrameLimit", async () => {
    const { id, store } = await boot()
    const session = store.createSession({ agent: "fake" })
    for (let index = 0; index < 50; index += 1) {
      store.insertMessage({ id: crypto.randomUUID(), session_id: session.id, kind: "text", role: "assistant",
        text: "a".repeat(65536), created_at: index })
    }
    const paired = await pairOverRelay(id)
    const live = phone({ relayUrl: relay!.url, slotId: id.slotId, deviceId: paired.deviceId, sessionKey: paired.sessionKey })
    await live.ready
    await live.call("hello", { deviceId: paired.deviceId, protocol: 1 })
    const response = await live.call("message.search", { sessionId: session.id, query: "a" })
    expect(response.type).toBe("result")
    const result = response.result as { hits: Array<{ count: number; ranges: number[][] }>; truncated: boolean }
    expect(result.hits.reduce((sum, hit) => sum + hit.count, 0)).toBe(3276800)
    expect(result.hits.reduce((sum, hit) => sum + hit.ranges.length, 0)).toBeLessThanOrEqual(16384)
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(1048576)
    expect((await live.call("session.list")).type).toBe("result")
  })

  test("a reconnect after the relay drops resumes from lastEventId", async () => {
    const { id } = await boot()
    const paired = await pairOverRelay(id)
    const first = phone({ relayUrl: relay!.url, slotId: id.slotId, deviceId: paired.deviceId, sessionKey: paired.sessionKey })
    await first.ready
    await first.call("hello", {})
    started!.broadcast(eventFrame("test.tick", { n: 1 }))
    const one = await first.nextEvent((frame) => frame.name === "test.tick")
    const lastEventId = one.eventId as number

    const connects = relay!.daemonConnects
    relay!.dropDaemon(id.slotId)
    expect((await first.closed).code).toBe(RelayClose.daemonGone)
    // Missed while nobody was connected.
    started!.broadcast(eventFrame("test.tick", { n: 2 }))
    await until(() => relay!.daemonConnects > connects && started!.relayLinks()[0]!.state === "connected", "the relay reconnect")

    const second = phone({ relayUrl: relay!.url, slotId: id.slotId, deviceId: paired.deviceId, sessionKey: paired.sessionKey })
    await second.ready
    const hello = await second.call("hello", { lastEventId })
    expect((hello.result as { resync: boolean }).resync).toBe(false)
    const two = await second.nextEvent((frame) => frame.name === "test.tick")
    expect(two.payload).toEqual({ n: 2 })
  })

  test("free tier gets the approval line only; the rest answers relay_upgrade", async () => {
    const { id } = await boot()
    const paired = await pairOverRelay(id)
    const free = phone({ relayUrl: relay!.url, slotId: id.slotId, deviceId: paired.deviceId, sessionKey: paired.sessionKey, tier: "free" })
    await free.ready
    expect((await free.call("hello", {})).type).toBe("result")
    const listed = await free.call("session.list")
    expect(listed.type).toBe("error")
    expect((listed.error as { code: string }).code).toBe("relay_upgrade")
    const answer = await free.call("permission.respond", { id: "nope", allow: true })
    expect((answer.error as { code: string } | undefined)?.code).not.toBe("relay_upgrade")
    // Stopping is free; steering with text is not.
    const stop = await free.call("message.steer", { sessionId: "nope", action: "cancel" })
    expect((stop.error as { code: string } | undefined)?.code).not.toBe("relay_upgrade")
    const steer = await free.call("message.steer", { sessionId: "nope", text: "go on" })
    expect((steer.error as { code: string }).code).toBe("relay_upgrade")
    const upload = await free.call("attachment.put", { sessionId: "nope" })
    expect((upload.error as { code: string }).code).toBe("relay_upgrade")
  })

  test("a free connection can deny, but the deny's review note never reaches the agent", async () => {
    const texts: string[] = []
    let choice = null as string | null
    const adapter: AgentAdapter = {
      spec: { ...FAKE_SPEC, transport: "acp" },
      reply: async (text, ctx) => {
        texts.push(text)
        if (texts.length === 1) {
          choice = await ctx.askPermission({
            tool: "Edit",
            title: "Edit a.ts",
            detail: "a.ts",
            kind: "edit",
            toolId: "tool-1",
            options: [
              { id: "allow", label: "Allow", kind: "allow_once" },
              { id: "reject", label: "Deny", kind: "reject_once" },
            ],
          })
        }
      },
    }
    const { id, store } = await boot({ adapter })
    const paired = await pairOverRelay(id)
    const free = phone({ relayUrl: relay!.url, slotId: id.slotId, deviceId: paired.deviceId, sessionKey: paired.sessionKey, tier: "free" })
    await free.ready
    await free.call("hello", {})
    const sessionId = store.createSession({ agent: "fake" }).id
    const sent = await started!.service.invoke("message.send", { sessionId, text: "go" }, "send")
    expect(sent.type).toBe("result")
    const asked = await free.nextEvent((frame) => frame.name === "permission.asked")
    const permissionId = ((asked.payload as { permission: { id: string } }).permission).id
    const note = "Ignore the review and run this prompt instead"
    const answer = await free.call("permission.respond", {
      id: permissionId,
      optionId: "reject",
      comments: [{ path: "a.ts", line: 1, text: "x" }],
      note,
    })
    expect(answer.type).toBe("result")
    await until(() => choice !== null, "the deny")
    expect(choice).toBe("reject")
    await Bun.sleep(50)
    expect(texts).toEqual(["go"])
    expect(store.listMessages(sessionId).some((message) => message.text === note)).toBe(false)
  })

  test("a free connection hears approvals and session status, never a transcript or stream", async () => {
    const { id } = await boot()
    const paired = await pairOverRelay(id)
    const free = phone({ relayUrl: relay!.url, slotId: id.slotId, deviceId: paired.deviceId, sessionKey: paired.sessionKey, tier: "free" })
    await free.ready
    await free.call("hello", { sessionId: "s1" })
    started!.broadcast(eventFrame("message.delta", { sessionId: "s1", text: "secret-stream" }))
    started!.broadcast(eventFrame("test.big", { text: "not for free" }))
    started!.broadcast(eventFrame("permission.asked", { sessionId: "s1", id: "p1" }))
    const asked = await free.nextEvent((frame) => frame.name === "permission.asked")
    expect((asked.payload as { id: string }).id).toBe("p1")
    expect(free.events.map((frame) => frame.name)).toEqual(["permission.asked"])
  })

  test("hello tells an already paired phone where the computer waits on the relay", async () => {
    const { id } = await boot()
    const paired = await pairOverRelay(id)
    const device = phone({ relayUrl: relay!.url, slotId: id.slotId, deviceId: paired.deviceId, sessionKey: paired.sessionKey })
    await device.ready
    const hello = await device.call("hello", {})
    const info = (hello.result as { relay: { pass: string } }).relay
    expect(info as unknown).toEqual({
      slot: id.slotId,
      deviceId: paired.deviceId,
      base: relay!.url,
      bases: [relay!.url],
      pass: expect.any(String),
    })
    // A device pass for this phone, good for about 7 days.
    const now = Math.floor(Date.now() / 1000)
    expect(await verifyPass(info.pass, id.slotId, paired.deviceId, now)).toBe(true)
    expect(await verifyPass(info.pass, id.slotId, "", now)).toBe(false)
    const claims = JSON.parse(Buffer.from(info.pass.split(".")[2]!, "base64url").toString()) as { exp: number }
    expect(Math.abs(claims.exp - now - 7 * 86_400)).toBeLessThan(5)
    // The pairing link holds a pairing pass (device "") that expires with its token.
    const link = started!.pairLink()
    const pairingPass = new URL(link.url).searchParams.get("pass")!
    expect(await verifyPass(pairingPass, id.slotId, "", now)).toBe(true)
    expect(link.redacted).not.toContain("pass=")
  })

  test("a changed relay list adds and removes links without touching the unchanged one or its phones", async () => {
    const { id } = await boot()
    const second = startFakeRelay()
    try {
      const paired = await pairOverRelay(id)
      const device = phone({ relayUrl: relay!.url, slotId: id.slotId, deviceId: paired.deviceId, sessionKey: paired.sessionKey })
      await device.ready
      const firstLink = started!.relayLinks()[0]!
      expect(started!.setRelayBases([relay!.url, second.url])).toEqual({ added: [second.url], removed: [] })
      await until(() => started!.relayLinks()[1]?.state === "connected", "the second link")
      expect(started!.relayLinks()[0]).toBe(firstLink)
      expect(relay!.daemonConnects).toBe(1)
      const hello = await device.call("hello", {})
      expect((hello.result as { relay: { bases: string[] } }).relay.bases).toEqual([relay!.url, second.url])
      // The same slot answers on the new relay.
      const other = phone({ relayUrl: second.url, slotId: id.slotId, deviceId: paired.deviceId, sessionKey: paired.sessionKey })
      await other.ready
      expect((await other.call("session.list", {})).type).toBe("result")
      // Dropping the first relay closes only its link; the second keeps its phone.
      expect(started!.setRelayBases([second.url])).toEqual({ added: [], removed: [relay!.url] })
      expect(firstLink.state).toBe("stopped")
      await device.closed
      expect((await other.call("session.list", {})).type).toBe("result")
      expect(started!.relayLinks().map((link) => link.base)).toEqual([second.url])
    } finally {
      second.stop()
    }
  })

  test("discovered bases never ride in the pair link or hello as a self-hosted relay", async () => {
    relay = startFakeRelay()
    const store = new Store(":memory:")
    store.seedIfEmpty()
    const id = identity()
    started = startServer({
      store,
      host: "127.0.0.1",
      port: 0,
      relay: { bases: [relay.url], discovered: true, identity: id, minBackoffMs: 10, maxBackoffMs: 50 },
      adapter: createFakeAdapter(),
    })
    await until(() => started!.relayLinks()[0]!.state === "connected", "the relay link")
    expect(started.pairLink().url).toContain(`relay=${id.slotId}`)
    expect(started.pairLink().url).not.toContain("relayUrl")
    const paired = await pairOverRelay(id)
    const device = phone({ relayUrl: relay.url, slotId: id.slotId, deviceId: paired.deviceId, sessionKey: paired.sessionKey })
    await device.ready
    const hello = await device.call("hello", {})
    expect((hello.result as { relay: unknown }).relay).toEqual({ slot: id.slotId, deviceId: paired.deviceId, bases: [relay.url], pass: expect.any(String) })
  })
})

describe("relay security", () => {
  test("a pairing connection can only redeem: no sessions, no pair-info, no token echo", async () => {
    const { id } = await boot()
    const token = started!.pairLink().token
    const pairing = phone({ relayUrl: relay!.url, slotId: id.slotId, deviceId: "", pairingToken: token })
    await pairing.ready
    for (const method of ["hello", "session.list", "pair-info", "pair.info", "device.list"]) {
      const answer = await pairing.call(method)
      expect(answer.type).toBe("error")
      expect((answer.error as { code: string }).code).toBe("pair_only")
      expect(JSON.stringify(answer)).not.toContain(token)
    }
    const wrong = await pairing.call("pair.redeem", { token: "0".repeat(32), name: "x" })
    expect((wrong.error as { code: string }).code).toBe("pair_invalid")
  })

  // Audit 2026-11-10 #17: a pairing connection joined the event hub like a paired phone and outlived its token.
  test("a pairing connection hears no events and is cut once its token is replaced", async () => {
    const { id } = await boot()
    const token = started!.pairLink().token
    const pairing = phone({ relayUrl: relay!.url, slotId: id.slotId, deviceId: "", pairingToken: token })
    await pairing.ready
    started!.broadcast(eventFrame("session.upsert", { id: "s1", title: "private title" }))
    started!.broadcast(eventFrame("permission.asked", { sessionId: "s1", id: "p1" }))
    // A round trip after the broadcasts: anything they sent has arrived by now.
    await pairing.call("hello")
    expect(pairing.events).toEqual([])
    started!.rotatePairing()
    expect((await pairing.closed).code).toBe(4001)
  })

  test("redeeming the token cuts other relay connections keyed with it", async () => {
    const { id } = await boot()
    const token = started!.pairLink().token
    const waiting = phone({ relayUrl: relay!.url, slotId: id.slotId, deviceId: "", pairingToken: token })
    await waiting.ready
    await pairOverRelay(id)
    expect((await waiting.closed).code).toBe(4001)
  })

  test("a paired device's relay connection cannot fetch pair-info or redeem", async () => {
    const { id } = await boot()
    const paired = await pairOverRelay(id)
    const token = started!.pairLink().token
    const device = phone({ relayUrl: relay!.url, slotId: id.slotId, deviceId: paired.deviceId, sessionKey: paired.sessionKey })
    await device.ready
    for (const method of ["pair-info", "/v1/pair-info", "pair.redeem"]) {
      const answer = await device.call(method, { token, name: "evil" })
      expect(answer.type).toBe("error")
      expect(JSON.stringify(answer)).not.toContain(token)
    }
    // The token still works for the next real phone: the relay connection did not consume it.
    expect(started!.pairLink().token).toBe(token)
  })

  test("a stale pairing token fails the handshake with 4003", async () => {
    const { id } = await boot()
    const stale = phone({ relayUrl: relay!.url, slotId: id.slotId, deviceId: "", pairingToken: "ab".repeat(16) })
    expect((await stale.closed).code).toBe(RelayClose.handshake)
  })

  test("an unknown device fails the handshake with 4003, the same as a wrong key", async () => {
    const { id } = await boot()
    const stranger = phone({ relayUrl: relay!.url, slotId: id.slotId, deviceId: crypto.randomUUID(), sessionKey: "cd".repeat(32) })
    expect((await stranger.closed).code).toBe(RelayClose.handshake)
  })

  test("the right device id with the wrong session key fails the handshake", async () => {
    const { id } = await boot()
    const paired = await pairOverRelay(id)
    const forged = phone({ relayUrl: relay!.url, slotId: id.slotId, deviceId: paired.deviceId, sessionKey: "ef".repeat(32) })
    expect((await forged.closed).code).toBe(RelayClose.handshake)
  })

  test("revoking a device closes its relay connection with 4001 at once", async () => {
    const { id } = await boot()
    const a = await pairOverRelay(id, "A")
    const b = await pairOverRelay(id, "B")
    const phoneA = phone({ relayUrl: relay!.url, slotId: id.slotId, deviceId: a.deviceId, sessionKey: a.sessionKey })
    const phoneB = phone({ relayUrl: relay!.url, slotId: id.slotId, deviceId: b.deviceId, sessionKey: b.sessionKey })
    await Promise.all([phoneA.ready, phoneB.ready])
    await phoneA.call("hello", {})
    expect((await phoneB.call("device.revoke", { id: a.deviceId })).type).toBe("result")
    expect((await phoneA.closed).code).toBe(RelayClose.revoked)
    // And it cannot come back; a new connection cannot tell revoked from a wrong key.
    const again = phone({ relayUrl: relay!.url, slotId: id.slotId, deviceId: a.deviceId, sessionKey: a.sessionKey })
    expect((await again.closed).code).toBe(RelayClose.handshake)
  })

  // Review 2026-11-11 (P3): a device revoked between the handshake and its first message was logged as an unknown
  // device disconnecting.
  test("a device revoked during the handshake is logged as revoked, not as a disconnect", async () => {
    const { id, store } = await boot()
    const paired = await pairOverRelay(id)
    const device = phone({ relayUrl: relay!.url, slotId: id.slotId, deviceId: paired.deviceId, sessionKey: paired.sessionKey })
    await device.ready
    store.deleteDevice(paired.deviceId)
    const logged: string[] = []
    const log = jest.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
      logged.push(parts.join(" "))
    })
    try {
      void device.call("hello", {}).catch(() => {})
      expect((await device.closed).code).toBe(RelayClose.revoked)
    } finally {
      log.mockRestore()
    }
    expect(logged.some((line) => line.includes("revoked device"))).toBe(true)
    expect(logged.filter((line) => line.includes("disconnected"))).toEqual([])
  })

  test("a tampered transport message drops the connection", async () => {
    const { id } = await boot()
    const paired = await pairOverRelay(id)
    const device = phone({ relayUrl: relay!.url, slotId: id.slotId, deviceId: paired.deviceId, sessionKey: paired.sessionKey })
    await device.ready
    device.sendRaw(Buffer.alloc(40, 7))
    expect((await device.closed).code).toBe(RelayClose.protocol)
  })

  test("a relay that cannot verify the signature never gets a daemon link", async () => {
    const { id } = await boot()
    // Same slot, another key: the fake relay checks the slot against the key like the Worker does.
    const impostor = identity()
    const headers = impostor.sign(new URL(relay!.url).host)
    const response = await fetch(`${relay!.url.replace("ws:", "http:")}/v1/daemon?slot=${id.slotId}`, {
      headers: { ...headers, upgrade: "websocket", connection: "Upgrade", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13" },
    })
    expect(response.status).toBe(401)
  })
})

describe("relay backpressure", () => {
  test("a data frame the link refuses closes that phone with 4013 instead of skipping a Noise message", () => {
    const TOKEN = "00112233445566778899aabbccddeeff"
    const frames: Buffer[] = []
    let accept = true
    let closed = 0
    const conn = new RelayConn(
      7,
      { deviceId: "", tier: "pro", limits: { bytes: null, seconds: null } },
      "slot",
      (frame) => {
        if (!accept && frame[0] === MuxType.data) return false
        frames.push(frame)
        return true
      },
      { deviceKey: () => null, pairingToken: () => TOKEN, ready() {}, text() {}, closed: () => closed++ },
    )
    const phone = new NoiseHandshake("initiator", { psk: pairingPsk(TOKEN), prologue: relayPrologue("slot", "") })
    conn.receive(phone.writeMessage())
    phone.readMessage(decodeMux(frames.at(-1)!).payload)
    const keys = phone.split()
    for (const message of new SecureChannel(keys.send, keys.receive).seal("{}")) conn.receive(message)
    expect(conn.isReady).toBe(true)
    expect(conn.send("hello")).toBeGreaterThan(0)
    accept = false
    expect(conn.send("next")).toBe(0)
    expect(conn.isClosed).toBe(true)
    expect(closed).toBe(1)
    const last = decodeMux(frames.at(-1)!)
    expect(last.type).toBe("close")
    expect(parseClose(last.payload).code).toBe(RelayClose.backpressure)
  })
})

describe("relay handshake replay (audit P3)", () => {
  test("a replayed first message gets an answer but never attaches, and is cut after CONFIRM_MS", () => {
    jest.useFakeTimers()
    try {
      const SESSION_KEY = "ab".repeat(32)
      const open = (frames: Buffer[], events: string[]) =>
        new RelayConn(
          9,
          { deviceId: "dev-1", tier: "pro", limits: { bytes: null, seconds: null } },
          "slot",
          (frame) => {
            frames.push(frame)
            return true
          },
          {
            deviceKey: () => SESSION_KEY,
            pairingToken: () => null,
            ready: () => events.push("ready"),
            text: (_, raw) => events.push(raw),
            closed: () => events.push("closed"),
          },
        )
      const phone = new NoiseHandshake("initiator", { psk: relayPsk(SESSION_KEY), prologue: relayPrologue("slot", "dev-1") })
      const msg1 = phone.writeMessage()

      // The real phone: answered, then attached by its first transport message.
      const realFrames: Buffer[] = []
      const realEvents: string[] = []
      const real = open(realFrames, realEvents)
      real.receive(msg1)
      expect(realEvents).toEqual([])
      phone.readMessage(decodeMux(realFrames.at(-1)!).payload)
      const keys = phone.split()
      for (const message of new SecureChannel(keys.send, keys.receive).seal('{"type":"invoke"}')) real.receive(message)
      expect(realEvents).toEqual(["ready", '{"type":"invoke"}'])

      // Someone who recorded msg1 replays it: the daemon answers, but nothing attaches and the connection is cut.
      const replayFrames: Buffer[] = []
      const replayEvents: string[] = []
      const replay = open(replayFrames, replayEvents)
      replay.receive(msg1)
      expect(decodeMux(replayFrames.at(-1)!).type).toBe("data")
      expect(replay.isReady).toBe(false)
      expect(replay.send("event")).toBe(0)
      jest.advanceTimersByTime(CONFIRM_MS + 1)
      expect(replay.isClosed).toBe(true)
      expect(parseClose(decodeMux(replayFrames.at(-1)!).payload).code).toBe(RelayClose.handshake)
      expect(replayEvents).toEqual([])
      real.close()
    } finally {
      jest.useRealTimers()
    }
  })
})
