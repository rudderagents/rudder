import { createHash } from "node:crypto"
import { describe, expect, test } from "bun:test"
import { createFakeAdapter } from "../adapter/fake"
import { SessionService } from "../session-service"
import { Store } from "../store"
import { chunkFrame, MAX_FRAME_BYTES, Reassembler, SecureChannel } from "./frame"
import { NoiseError, NoiseHandshake, pairingPsk, relayPrologue, relayPsk } from "./noise"

const hex = (value: string) => Buffer.from(value, "hex")

// cacophony vectors/cacophony.txt, entry Noise_NNpsk0_25519_AESGCM_SHA256.
const OFFICIAL = {
  prologue: "4a6f686e2047616c74",
  psk: "54686973206973206d7920417573747269616e20706572737065637469766521",
  initEphemeral: "893e28b9dc6ca8d611ab664754b8ceb7bac5117349a4439a6b0569da977c464a",
  respEphemeral: "bbdb4cdbd309f1a1f2e1456967fe288cadd6f712d65dc7b7793d5e63da6b375b",
  handshakeHash: "9f3b1f9afd7767767b5b9d1069844a6154fdbdcc36dfb3e31c0fffc5c973d530",
  messages: [
    ["4c756477696720766f6e204d69736573", "ca35def5ae56cec33dc2036731ab14896bc4c75dbb07a61f879f8e3afa4c79447c37a89fc17813788d30df2d59501d6066f5f8aecc3406bbd9829f2d24a531b1"],
    ["4d757272617920526f746862617264", "95ebc60d2b1fa672c1f46a8aa265ef51bfe38e7ccb39ec5be34069f1448088432f29d79368ef9de4e1ae7a362fb05bf0ad668e026bf5714554497b3a720461"],
    ["462e20412e20486179656b", "7c01e898a6201f36aecee532e29cd0b7f8ffa29d3366ad0dce39a6"],
    ["4361726c204d656e676572", "a9ff535aace3db6a1da1a7fb00fe2de2622bb373abad9fb42c00e0"],
    ["4a65616e2d426170746973746520536179", "6cfc49a3e65472edc2d0152abe5ce950170a8a47c959f30bd48b5f0aacf29adbfd"],
    ["457567656e2042f6686d20766f6e2042617765726b", "9bc86e6d974ed21ba04604a94aa68de21677eb409ead070c0cd569b069ee19ba142aa4c1a9"],
  ],
}

/**
 * Rudder's own vector, checked byte for byte by RudderKitTests `RelayNoiseTests` (same constants): the phone and
 * rudderd must agree on PSK, prologue, handshake and chunking.
 */
const RELAY_VECTOR = {
  sessionKey: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  relayPsk: "18e3d4824d4ec6cf0ef70834741c79fc7015d7bbb764d0a108028b150cab7f37",
  pairingToken: "00112233445566778899aabbccddeeff",
  pairingPsk: "55b2f8988115d88bc91077e75db09dca35aff895c1c37b053749dad639525ebf",
  slotId: "k5q3hn4rcd2zqmpwt7vbx6yf2a",
  deviceId: "8f6c2b9e-1d4a-4c3b-9e7f-2a5d6c8b1e03",
  initEphemeral: "893e28b9dc6ca8d611ab664754b8ceb7bac5117349a4439a6b0569da977c464a",
  respEphemeral: "bbdb4cdbd309f1a1f2e1456967fe288cadd6f712d65dc7b7793d5e63da6b375b",
  message1: "ca35def5ae56cec33dc2036731ab14896bc4c75dbb07a61f879f8e3afa4c7944e68dec6f606664c89c6fb55544bec7f4",
  message2: "95ebc60d2b1fa672c1f46a8aa265ef51bfe38e7ccb39ec5be34069f144808843a6ef37e40d2def92e7af0915f4521b53",
  handshakeHash: "60b16079ce90115bea047fc9ba9e111d3c895949ed1c2384e53dc3f4110d1a30",
  /** Phone → rudderd, one chunk. */
  hello: '{"v":1,"id":"h1","type":"invoke","method":"hello","params":{}}',
  helloSealed: "ec46552e75b23df2033c25f48897ce12fd7dfe32909fed2291f7d59076127d61d7e9ea38743845eb1653c59532c6e6e1bd0991b20e6f35fbf41ef856c5b4d9ecdb39a6bffe229275ff5416f6265ca3",
  /** rudderd → phone: "x" × 70,000 is two chunks; SHA-256 over both ciphertexts concatenated. */
  bigLength: 70_000,
  bigSealedSha256: "707fe4817eda34b083c34fc46069f320130335a7caccc08a43fff81cc118a8ee",
  bigChunks: 2,
}

function pair(options: { psk: Buffer; prologue: Buffer; initEphemeral?: Buffer; respEphemeral?: Buffer }) {
  const initiator = new NoiseHandshake("initiator", { psk: options.psk, prologue: options.prologue, ephemeral: options.initEphemeral })
  const responder = new NoiseHandshake("responder", { psk: options.psk, prologue: options.prologue, ephemeral: options.respEphemeral })
  return { initiator, responder }
}

describe("Noise NNpsk0 (AESGCM)", () => {
  test("matches the official cacophony vector in both roles", () => {
    const { initiator, responder } = pair({
      psk: hex(OFFICIAL.psk),
      prologue: hex(OFFICIAL.prologue),
      initEphemeral: hex(OFFICIAL.initEphemeral),
      respEphemeral: hex(OFFICIAL.respEphemeral),
    })
    const [m1, m2, ...rest] = OFFICIAL.messages
    const c1 = initiator.writeMessage(hex(m1![0]))
    expect(c1.toString("hex")).toBe(m1![1])
    expect(responder.readMessage(c1).toString("hex")).toBe(m1![0])
    const c2 = responder.writeMessage(hex(m2![0]))
    expect(c2.toString("hex")).toBe(m2![1])
    expect(initiator.readMessage(c2).toString("hex")).toBe(m2![0])
    const a = initiator.split()
    const b = responder.split()
    expect(a.handshakeHash.toString("hex")).toBe(OFFICIAL.handshakeHash)
    expect(b.handshakeHash.toString("hex")).toBe(OFFICIAL.handshakeHash)
    // Transport messages alternate, initiator first.
    for (const [index, [payload, ciphertext]] of rest.entries()) {
      const [sender, receiver] = index % 2 === 0 ? [a, b] : [b, a]
      const sealed = sender.send.encrypt(Buffer.alloc(0), hex(payload))
      expect(sealed.toString("hex")).toBe(ciphertext)
      expect(receiver.receive.decrypt(Buffer.alloc(0), sealed).toString("hex")).toBe(payload)
    }
  })

  test("a wrong PSK fails the responder on message 1", () => {
    const initiator = new NoiseHandshake("initiator", { psk: Buffer.alloc(32, 1), prologue: Buffer.alloc(0) })
    const responder = new NoiseHandshake("responder", { psk: Buffer.alloc(32, 2), prologue: Buffer.alloc(0) })
    expect(() => responder.readMessage(initiator.writeMessage())).toThrow(NoiseError)
  })

  test("another slot's prologue fails the handshake", () => {
    const psk = relayPsk(RELAY_VECTOR.sessionKey)
    const initiator = new NoiseHandshake("initiator", { psk, prologue: relayPrologue("slot-a", "d") })
    const responder = new NoiseHandshake("responder", { psk, prologue: relayPrologue("slot-b", "d") })
    expect(() => responder.readMessage(initiator.writeMessage())).toThrow(NoiseError)
  })

  test("a replayed or reordered transport message is refused", () => {
    const { initiator, responder } = pair({ psk: Buffer.alloc(32, 9), prologue: Buffer.alloc(0) })
    responder.readMessage(initiator.writeMessage())
    initiator.readMessage(responder.writeMessage())
    const a = initiator.split()
    const b = responder.split()
    const first = a.send.encrypt(Buffer.alloc(0), Buffer.from("one"))
    const second = a.send.encrypt(Buffer.alloc(0), Buffer.from("two"))
    expect(() => b.receive.decrypt(Buffer.alloc(0), second)).toThrow(NoiseError)
    expect(b.receive.decrypt(Buffer.alloc(0), first).toString()).toBe("one")
    expect(() => b.receive.decrypt(Buffer.alloc(0), first)).toThrow(NoiseError)
    expect(b.receive.decrypt(Buffer.alloc(0), second).toString()).toBe("two")
  })

  test("a role cannot write out of turn", () => {
    const responder = new NoiseHandshake("responder", { psk: Buffer.alloc(32), prologue: Buffer.alloc(0) })
    expect(() => responder.writeMessage()).toThrow(NoiseError)
  })
})

describe("relay framing", () => {
  test("chunks at 65,000 bytes with FIN on the last and rejoins", () => {
    const frame = Buffer.alloc(150_000, 0x61)
    const chunks = chunkFrame(frame)
    expect(chunks.map((c) => c.byteLength)).toEqual([65_001, 65_001, 20_001])
    expect(chunks.map((c) => c[0])).toEqual([0, 0, 1])
    const join = new Reassembler()
    expect(join.push(chunks[0]!)).toBeNull()
    expect(join.push(chunks[1]!)).toBeNull()
    expect(join.push(chunks[2]!)?.equals(frame)).toBe(true)
  })

  test("an empty frame is one FIN chunk", () => {
    expect(chunkFrame(Buffer.alloc(0)).map((c) => c.toString("hex"))).toEqual(["01"])
  })

  test("refuses a frame past 16 MB, before and after chunking", () => {
    expect(() => chunkFrame(Buffer.alloc(MAX_FRAME_BYTES + 1))).toThrow(NoiseError)
    const join = new Reassembler()
    const chunk = Buffer.concat([Buffer.from([0]), Buffer.alloc(1024 * 1024)])
    expect(() => {
      for (let i = 0; i < 17; i++) join.push(chunk)
    }).toThrow(NoiseError)
  })

  test("refuses unknown flag bits", () => {
    expect(() => new Reassembler().push(Buffer.from([0x02, 0x41]))).toThrow(NoiseError)
  })
})

describe("rudder relay vector (shared with RudderKitTests)", () => {
  test("derives the PSKs and reproduces the handshake and transport bytes", () => {
    const psk = relayPsk(RELAY_VECTOR.sessionKey)
    expect(psk.toString("hex")).toBe(RELAY_VECTOR.relayPsk)
    expect(pairingPsk(RELAY_VECTOR.pairingToken).toString("hex")).toBe(RELAY_VECTOR.pairingPsk)
    const { initiator, responder } = pair({
      psk,
      prologue: relayPrologue(RELAY_VECTOR.slotId, RELAY_VECTOR.deviceId),
      initEphemeral: hex(RELAY_VECTOR.initEphemeral),
      respEphemeral: hex(RELAY_VECTOR.respEphemeral),
    })
    const m1 = initiator.writeMessage()
    expect(m1.toString("hex")).toBe(RELAY_VECTOR.message1)
    responder.readMessage(m1)
    const m2 = responder.writeMessage()
    expect(m2.toString("hex")).toBe(RELAY_VECTOR.message2)
    initiator.readMessage(m2)
    const phone = initiator.split()
    const daemon = responder.split()
    expect(phone.handshakeHash.toString("hex")).toBe(RELAY_VECTOR.handshakeHash)

    const phoneChannel = new SecureChannel(phone.send, phone.receive)
    const daemonChannel = new SecureChannel(daemon.send, daemon.receive)
    const hello = phoneChannel.seal(RELAY_VECTOR.hello)
    expect(hello.map((m) => m.toString("hex"))).toEqual([RELAY_VECTOR.helloSealed])
    expect(daemonChannel.open(hello[0]!)?.toString("utf8")).toBe(RELAY_VECTOR.hello)

    const big = daemonChannel.seal("x".repeat(RELAY_VECTOR.bigLength))
    expect(big.length).toBe(RELAY_VECTOR.bigChunks)
    expect(createHash("sha256").update(Buffer.concat(big)).digest("hex")).toBe(RELAY_VECTOR.bigSealedSha256)
    expect(phoneChannel.open(big[0]!)).toBeNull()
    expect(phoneChannel.open(big[1]!)?.toString("utf8")).toBe("x".repeat(RELAY_VECTOR.bigLength))
  })
})


describe("body page transport", () => {
  test("SecureChannel authenticates and reassembles every page including a six MiB singleton", async () => {
    const store = new Store(":memory:")
    store.seedIfEmpty()
    const sessionId = store.listSessions()[0]!.id
    const ids = Array.from({ length: 12 }, (_, index) => `noise-body-${index}`)
    const text = '雪"\\\n'.repeat(90_000)
    for (const id of ids) store.insertMessage({ id, session_id: sessionId, kind: "text", role: "assistant", text, created_at: 1 })
    ids.push("six-mib")
    store.insertMessage({ id: "six-mib", session_id: sessionId, kind: "text", role: "assistant", text: "x".repeat(6 * 1024 * 1024), created_at: 1 })
    const service = new SessionService(store, createFakeAdapter(), () => {})
    try {
      const { initiator, responder } = pair({ psk: Buffer.alloc(32, 7), prologue: Buffer.alloc(0) })
      responder.readMessage(initiator.writeMessage())
      initiator.readMessage(responder.writeMessage())
      const phone = initiator.split(), daemon = responder.split()
      const sender = new SecureChannel(daemon.send, daemon.receive)
      const receiver = new SecureChannel(phone.send, phone.receive)
      const found: string[] = []
      let offset = 0
      let pages = 0
      let oversizedPage = false
      do {
        const frame = await service.invoke("message.bodies", { sessionId, ids, paged: true, offset }, `noise-${pages}`)
        expect(frame.type).toBe("result")
        const raw = JSON.stringify(frame)
        const bytes = Buffer.byteLength(raw)
        expect(bytes).toBeLessThanOrEqual(MAX_FRAME_BYTES)
        oversizedPage ||= bytes > 4_194_304
        let opened: Buffer | null = null
        const sealed = sender.seal(raw)
        for (const [index, part] of sealed.entries()) {
          opened = receiver.open(part)
          if (index < sealed.length - 1) expect(opened).toBeNull()
        }
        expect(opened?.toString("utf8") === raw).toBe(true)
        const page = JSON.parse(opened!.toString("utf8")) as { result: { messages: { id: string; text: string }[]; nextOffset?: number } }
        expect(page.result.messages.every((row) => row.id === "six-mib" ? row.text.length === 6 * 1024 * 1024 : row.text === text)).toBe(true)
        found.push(...page.result.messages.map((row) => row.id))
        pages += 1
        if (page.result.nextOffset === undefined) break
        expect(page.result.nextOffset).toBeGreaterThan(offset)
        offset = page.result.nextOffset
        if (pages > ids.length) throw new Error("noise body cursor did not terminate")
      } while (offset < ids.length)
      expect(found).toEqual(ids)
      expect(pages).toBeGreaterThan(2)
      expect(oversizedPage).toBe(true)
    } finally { service.shutdown() }
  })
})
