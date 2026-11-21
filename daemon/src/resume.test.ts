import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import { FAKE_SPEC } from "./adapter/fake"
import type { AgentAdapter } from "./adapter/types"
import { EventHub } from "./event-hub"
import { currentPairingToken, redeemPairing } from "./pair"
import { eventFrame, invokeFrame, type Frame } from "./protocol"
import { startServer, type ServerOptions } from "./server"
import { Store } from "./store"

type Payload = Record<string, unknown>

async function waitFor(predicate: () => boolean, timeoutMs = 3000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out")
    await Bun.sleep(5)
  }
}

const payload = (frame: Frame) => (frame.payload ?? {}) as Payload

/** Streams `steps` growing chunks of text, `pauseMs` apart, so the daemon flushes several times. */
function streaming(steps: number, pauseMs: number, chunk = " word"): AgentAdapter {
  return {
    spec: { ...FAKE_SPEC, id: "s", label: "s" },
    async reply(_text, ctx) {
      let text = ""
      for (let i = 0; i < steps; i++) {
        text += chunk
        ctx.emit({ type: "text", id: `t-${ctx.sessionId}`, text })
        await Bun.sleep(pauseMs)
      }
    },
  }
}

type Client = {
  frames: Frame[]
  events(name?: string): Frame[]
  call(method: string, params?: Payload): Promise<Frame>
  close(): Promise<void>
}

async function connect(port: number, key: string): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`, { headers: { authorization: `Bearer ${key}` } } as never)
  const closed = new Promise<void>((resolve) => ws.addEventListener("close", () => resolve()))
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve())
    ws.addEventListener("error", () => reject(new Error("ws error")))
  })
  const frames: Frame[] = []
  const waiting = new Map<string, (frame: Frame) => void>()
  ws.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data)) as Frame
    frames.push(frame)
    if (frame.type !== "event") waiting.get(frame.id)?.(frame)
  })
  return {
    frames,
    events: (name) => frames.filter((frame) => frame.type === "event" && (!name || frame.name === name)),
    call(method, params = {}) {
      const id = crypto.randomUUID()
      return new Promise((resolve) => {
        waiting.set(id, resolve)
        ws.send(JSON.stringify(invokeFrame(id, method, params)))
      })
    },
    async close() {
      ws.close()
      await closed
    },
  }
}

/** What a phone shows for the session: full appends replace, deltas append when the offset matches. */
function transcript(frames: Frame[], sessionId: string, start: Map<string, string> = new Map()) {
  const texts = new Map(start)
  let drift = 0
  for (const frame of frames) {
    if (frame.type !== "event") continue
    const body = payload(frame)
    if (body.sessionId !== sessionId) continue
    if (frame.name === "message.append") texts.set(String(body.id), String(body.text))
    if (frame.name === "message.delta") {
      const current = texts.get(String(body.id))
      if (current === undefined || current.length !== body.offset) drift += 1
      else texts.set(String(body.id), current + String(body.append))
    }
  }
  return { texts, drift }
}

let servers: { server: { stop(force?: boolean): void } }[] = []
afterEach(() => {
  for (const started of servers) started.server.stop(true)
  servers = []
})

function boot(adapter: AgentAdapter, options: Partial<ServerOptions> = {}, store = new Store(":memory:")) {
  const started = startServer({ store, host: "127.0.0.1", port: 0, adapter, ...options })
  servers.push(started)
  const key = redeemPairing(store, currentPairingToken(store).token, "phone").sessionKey
  return { started, store, port: started.server.port as number, key }
}

describe("event ids and replay", () => {
  test("hello lists the computer's current addresses as host:port", async () => {
    const { port, key } = boot(streaming(1, 1))
    const client = await connect(port, key)
    const hello = await client.call("hello", { features: ["delta"] })
    expect((hello.result as { hosts: string[] }).hosts).toEqual([`127.0.0.1:${port}`])
    await client.close()
  })

  test("hello echoes markUnread only when the client asks for it", async () => {
    const { port, key } = boot(streaming(1, 0))
    const client = await connect(port, key)
    const both = await client.call("hello", { features: ["delta", "markUnread"] })
    expect(both.result).toMatchObject({ features: ["delta", "markUnread"] })
    await client.close()

    const older = await connect(port, key)
    const deltaOnly = await older.call("hello", { features: ["delta"] })
    expect(deltaOnly.result).toMatchObject({ features: ["delta"] })
    await older.close()

    const images = await connect(port, key)
    const asked = await images.call("hello", { features: ["delta", "markUnread", "agentImages", "nope"] })
    expect(asked.result).toMatchObject({ features: ["delta", "markUnread", "agentImages"] })
    await images.close()

    const outlined = await connect(port, key)
    const outline = await outlined.call("hello", { features: ["outline", "nope"] })
    expect(outline.result).toMatchObject({ features: ["outline"] })
    await outlined.close()
  })

  test("a socket that comes back within the ring gets exactly what it missed, and the transcript has no gap", async () => {
    const { store, port, key } = boot(streaming(40, 12))
    const first = await connect(port, key)
    const hello = await first.call("hello", { features: ["delta"] })
    expect(hello.result).toMatchObject({ resync: false, features: ["delta"] })
    const session = ((await first.call("session.create", { agent: "s" })).result as { session: { id: string } }).session
    const opened = await first.call("session.get", { id: session.id })
    expect(typeof (opened.result as Payload).eventId).toBe("number")
    await first.call("message.send", { sessionId: session.id, text: "go" })
    // Mid-stream: a few frames of the reply are in.
    await waitFor(() => first.events().filter((frame) => payload(frame).id === `t-${session.id}`).length >= 3)
    await first.close()
    const seen = Math.max(...first.events().map((frame) => frame.eventId ?? 0))
    await waitFor(() => store.getSession(session.id)?.status === "idle")

    const second = await connect(port, key)
    const resumed = await second.call("hello", { features: ["delta"], lastEventId: seen, sessionId: session.id })
    const result = resumed.result as { resync: boolean; eventId: number }
    expect(result.resync).toBe(false)
    await waitFor(() => second.events().length >= result.eventId - seen)
    const replayed = second.events()
    // Every id after the one the phone saw, in order, nothing twice; the hello result came first.
    expect(replayed.map((frame) => frame.eventId)).toEqual(Array.from({ length: result.eventId - seen }, (_, i) => seen + 1 + i))
    expect(second.frames.indexOf(resumed)).toBe(0)
    expect(replayed.some((frame) => frame.name === "agent.status" && payload(frame).status === "idle")).toBe(true)

    const { texts, drift } = transcript([...first.frames, ...second.frames], session.id)
    expect(drift).toBe(0)
    for (const row of store.listMessages(session.id)) expect(texts.get(row.id)).toBe(row.text)
    await second.close()
  })

  test("a gap beyond the ring answers resync and replays nothing", async () => {
    const { port, key } = boot(streaming(1, 1), { events: { capacity: 3 } })
    const first = await connect(port, key)
    const cursor = ((await first.call("hello", { features: ["delta"] })).result as { eventId: number }).eventId
    for (let i = 0; i < 4; i++) await first.call("session.create", { agent: "s" })
    await first.close()

    const second = await connect(port, key)
    const resumed = await second.call("hello", { features: ["delta"], lastEventId: cursor })
    expect(resumed.result).toMatchObject({ resync: true })
    await Bun.sleep(50)
    expect(second.events()).toHaveLength(0)
    // A cursor from the future (a reset database) resyncs too.
    const third = await connect(port, key)
    expect((await third.call("hello", { lastEventId: cursor + 10_000 })).result).toMatchObject({ resync: true })
    await second.close()
    await third.close()
  })

  test("ids keep rising across a restart, and a cursor from before it resyncs", () => {
    const dir = mkdtempSync(join(tmpdir(), "rudder-events-"))
    try {
      const path = join(dir, "db.sqlite")
      const store = new Store(path)
      const hub = new EventHub(store)
      for (let i = 0; i < 3; i++) hub.publish(eventFrame("session.upsert", { id: "s" }))
      const before = hub.lastEventId
      store.db.close()

      const reopened = new Store(path)
      const next = new EventHub(reopened)
      expect(next.lastEventId).toBeGreaterThan(before)
      const socket = { sent: [] as string[], send(raw: string) { this.sent.push(raw) } }
      next.attach(socket)
      next.helloStarted(socket)
      expect(next.resume(socket, { lastEventId: before }).result.resync).toBe(true)
      next.detach(socket)
      reopened.db.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("the ring also forgets events older than its age limit", () => {
    let now = 1_000
    const hub = new EventHub(null, { maxAgeMs: 100, now: () => now })
    const cursor = hub.lastEventId
    hub.publish(eventFrame("session.upsert", { id: "s" }))
    const socket = { send() {} }
    hub.attach(socket)
    hub.helloStarted(socket)
    expect(hub.resume(socket, { lastEventId: cursor }).result.resync).toBe(false)
    now += 200
    const late = { send() {} }
    hub.attach(late)
    hub.helloStarted(late)
    expect(hub.resume(late, { lastEventId: cursor }).result.resync).toBe(true)
    hub.detach(socket)
    hub.detach(late)
  })
})

describe("delta frames", () => {
  test("a delta socket gets offsets that rebuild the text; a legacy socket gets full appends only", async () => {
    const { store, port, key } = boot(streaming(30, 12))
    const delta = await connect(port, key)
    const legacy = await connect(port, key)
    await delta.call("hello", { features: ["delta"] })
    await legacy.call("hello", {})
    const session = ((await delta.call("session.create", { agent: "s" })).result as { session: { id: string } }).session
    await delta.call("session.get", { id: session.id })
    await legacy.call("session.get", { id: session.id })
    await delta.call("message.send", { sessionId: session.id, text: "go" })
    await waitFor(() => store.getSession(session.id)?.status === "idle")
    await waitFor(() => legacy.events("agent.status").some((frame) => payload(frame).status === "idle"))
    await Bun.sleep(30)

    const deltas = delta.events("message.delta")
    expect(deltas.length).toBeGreaterThan(3)
    expect(legacy.events("message.delta")).toHaveLength(0)
    const textId = `t-${session.id}`
    const finalText = store.getMessage(textId)!.text
    const { texts, drift } = transcript(delta.frames, session.id)
    expect(drift).toBe(0)
    expect(texts.get(textId)).toBe(finalText)
    // After the first frame the delta socket never gets the whole text again (2026-11-12, perf-1112 R4): the block
    // closes with a delta carrying the final rev. The legacy socket ends on the same text.
    const forBlock = delta.frames.filter((frame) => frame.type === "event" && payload(frame).id === textId)
    expect(forBlock.filter((frame) => frame.name === "message.append")).toHaveLength(1)
    expect(forBlock.at(-1)!.name).toBe("message.delta")
    expect(payload(forBlock.at(-1)!).rev).toBe(store.getMessage(textId)!.rev)
    expect(transcript(legacy.frames, session.id).texts.get(textId)).toBe(finalText)
    // Same events, same ids, on both sockets.
    const ids = (client: Client) => client.events().map((frame) => frame.eventId)
    expect(ids(delta)).toEqual(ids(legacy))
    // Legacy full frames are the old shape plus eventId and prev, which older phones ignore.
    const append = legacy.events("message.append").find((frame) => payload(frame).id === textId)!
    expect(Object.keys(append).sort()).toEqual(["eventId", "id", "name", "payload", "prev", "type", "v"])
    await delta.close()
    await legacy.close()
  })
})

describe("per-session fan-out", () => {
  test("message events go only to sockets with that session open; list events go to all", async () => {
    const { store, port, key } = boot(streaming(3, 5))
    const a = await connect(port, key)
    const b = await connect(port, key)
    const idle = await connect(port, key)
    for (const client of [a, b, idle]) await client.call("hello", { features: ["delta"] })
    const one = ((await a.call("session.create", { agent: "s" })).result as { session: { id: string } }).session.id
    const two = ((await a.call("session.create", { agent: "s" })).result as { session: { id: string } }).session.id
    await a.call("session.get", { id: one })
    await b.call("session.get", { id: two })
    await a.call("message.send", { sessionId: one, text: "go" })
    await waitFor(() => store.getSession(one)?.status === "idle")
    await waitFor(() => b.events("agent.status").some((frame) => payload(frame).status === "idle"))

    const messageSessions = (client: Client) =>
      new Set(client.events().filter((frame) => frame.name!.startsWith("message.")).map((frame) => payload(frame).sessionId))
    expect(messageSessions(a)).toEqual(new Set([one]))
    expect(messageSessions(b).size).toBe(0)
    expect(messageSessions(idle).size).toBe(0)
    for (const client of [a, b, idle]) {
      expect(client.events("session.upsert").some((frame) => payload(frame).id === one)).toBe(true)
      expect(client.events("agent.status").some((frame) => payload(frame).sessionId === one)).toBe(true)
    }
    for (const client of [a, b, idle]) await client.close()
  })

  test("a socket that never says hello still gets events once its hold ends", async () => {
    const { started, port, key } = boot(streaming(1, 1), { events: { holdMs: 50 } })
    const quiet = await connect(port, key)
    started.broadcast(eventFrame("machine.upsert", { name: "m" }))
    await waitFor(() => quiet.events("machine.upsert").length === 1)
    await quiet.close()
  })
})

describe("per-session chain over the socket", () => {
  test("two chats streaming at once each form an unbroken prev chain, and events.replay resends a tail", async () => {
    const { store, port, key } = boot(streaming(40, 6))
    const watcher = await connect(port, key)
    const other = await connect(port, key)
    expect((await watcher.call("hello", { features: ["delta", "chain"] })).result).toMatchObject({ features: ["delta", "chain"] })
    await other.call("hello", { features: ["delta", "chain"] })
    const create = async () => ((await watcher.call("session.create", { agent: "s" })).result as { session: { id: string } }).session.id
    const [a, b] = [await create(), await create()]
    const opened = (await watcher.call("session.get", { id: a })).result as { eventId: number }
    await other.call("session.get", { id: b })
    await Promise.all([watcher.call("message.send", { sessionId: a, text: "go" }), other.call("message.send", { sessionId: b, text: "go" })])
    await waitFor(() => store.getSession(a)?.status === "idle" && store.getSession(b)?.status === "idle")
    await Bun.sleep(20)

    for (const [client, sessionId] of [[watcher, a], [other, b]] as const) {
      const chain = client.events().filter((frame) => frame.name?.startsWith("message.")) as (Frame & { prev?: number })[]
      expect(chain.length).toBeGreaterThan(3)
      expect(chain.every((frame) => payload(frame).sessionId === sessionId)).toBe(true)
      expect(chain[0]?.prev ?? -1).toBeLessThanOrEqual(sessionId === a ? opened.eventId : Number.MAX_SAFE_INTEGER)
      for (let i = 1; i < chain.length; i++) expect(chain[i]?.prev).toBe(chain[i - 1]?.eventId)
    }
    // Interleaved for real: the other chat's ids fall between this one's.
    const ids = (client: Client) => client.events().filter((frame) => frame.name?.startsWith("message.")).map((frame) => frame.eventId ?? 0)
    const mine = ids(watcher)
    expect(ids(other).some((id) => id > (mine[0] ?? 0) && id < (mine.at(-1) ?? 0))).toBe(true)

    const from = mine[mine.length - 4] ?? 0
    const before = watcher.frames.length
    const replay = await watcher.call("events.replay", { sessionId: a, after: from })
    expect(replay.result).toEqual({ replayed: true })
    expect(watcher.frames.slice(before).filter((frame) => frame.type === "event").map((frame) => frame.eventId)).toEqual(mine.slice(-3))
    // Not this socket's open chat: refused, so the phone reloads instead.
    expect((await watcher.call("events.replay", { sessionId: b, after: from })).result).toEqual({ replayed: false })
    await watcher.close()
    await other.close()
  })
})

describe("snapshot and cursor", () => {
  test("session.get waiting on a slow steer probe still returns text that matches its cursor", async () => {
    // A long opening keeps the list preview still, so only the 1 s persist timer writes the row.
    const adapter: AgentAdapter = {
      spec: { ...FAKE_SPEC, id: "s", label: "s" },
      async reply(_text, ctx) {
        let text = "x".repeat(400)
        for (let i = 0; i < 40; i++) {
          text += " word"
          ctx.emit({ type: "text", id: `t-${ctx.sessionId}`, text })
          await Bun.sleep(15)
        }
      },
      // Never cached, so every session.get waits on it while the reply keeps flushing.
      probeSteer: async () => {
        await Bun.sleep(250)
        return "unavailable"
      },
    }
    const { store, port, key } = boot(adapter)
    const writer = await connect(port, key)
    await writer.call("hello", { features: ["delta"] })
    const session = ((await writer.call("session.create", { agent: "s" })).result as { session: { id: string } }).session
    await writer.call("message.send", { sessionId: session.id, text: "go" })
    const textId = `t-${session.id}`
    await waitFor(() => store.getMessage(textId) !== null)

    const reader = await connect(port, key)
    await reader.call("hello", { features: ["delta"] })
    const opened = (await reader.call("session.get", { id: session.id })).result as {
      messages: { id: string; text: string }[]
      eventId: number
    }
    const start = new Map(opened.messages.map((row) => [row.id, row.text]))
    await waitFor(() => store.getSession(session.id)?.status === "idle")
    await waitFor(() => reader.events("agent.status").some((frame) => payload(frame).status === "idle"))
    const after = reader.frames.filter((frame) => frame.type === "event" && (frame.eventId ?? 0) > opened.eventId)
    const { texts, drift } = transcript(after, session.id, start)
    expect(drift).toBe(0)
    expect(texts.get(textId)).toBe(store.getMessage(textId)!.text)
    await writer.close()
    await reader.close()
  })
})
