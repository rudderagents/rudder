// Guard for plan perf-1112 R4 (2026-11-12): a streamed reply goes over the wire as deltas only, the replay ring keeps
// those deltas rather than copies of the whole text, and the SQLite write-back is throttled. Counts, not timings: the
// clock is virtual, so other builds running in parallel do not move the numbers.
import { afterEach, describe, expect, test } from "bun:test"
import { FAKE_SPEC } from "./adapter/fake"
import type { AgentAdapter } from "./adapter/types"
import { EventHub } from "./event-hub"
import { SessionService } from "./session-service"
import { Store } from "./store"

const CHUNK = 20
// About 1 MB, in whole chunks.
const REPLY_CHARS = Math.ceil((1024 * 1024) / CHUNK) * CHUNK
const TOKENS_PER_SECOND = 100

type Socket = { bytes: number; appends: number; deltas: number; send(raw: string): void }

function socket(): Socket {
  const sock: Socket = {
    bytes: 0,
    appends: 0,
    deltas: 0,
    send(raw: string) {
      sock.bytes += Buffer.byteLength(raw)
      const name = (JSON.parse(raw) as { name?: string }).name
      if (name === "message.append") sock.appends += 1
      if (name === "message.delta") sock.deltas += 1
    },
  }
  return sock
}

const realNow = Date.now
afterEach(() => {
  Date.now = realNow
})

async function streamReply(plain: boolean, poll?: (service: SessionService, sessionId: string) => Promise<unknown>) {
  const store = new Store(":memory:")
  const hub = new EventHub(store)
  let writes = 0
  let writtenUnits = 0
  const insert = store.insertMessage.bind(store)
  store.insertMessage = (row, options) => {
    if (row.role === "assistant") {
      writes += 1
      writtenUnits += row.text.length
    }
    return insert(row, options)
  }
  let clock = realNow()
  Date.now = () => clock
  const textId = "reply"
  const adapter: AgentAdapter = {
    spec: { ...FAKE_SPEC, id: "s", label: "s" },
    async reply(_text, ctx) {
      const piece = "lorem ipsum dolor si".slice(0, CHUNK)
      let text = ""
      for (let i = 0; i < REPLY_CHARS / CHUNK; i++) {
        clock += 1000 / TOKENS_PER_SECOND
        text += i % 50 === 49 ? `${piece.slice(0, -1)}\n` : piece
        await ctx.emit({ type: "text", id: textId, text })
        // Every 200 ms of stream, a request from the phone.
        if (poll && i % 20 === 19) await poll(service, ctx.sessionId)
      }
    },
  }
  const service = new SessionService(store, adapter, (frame, delta) => hub.publish(frame, delta))
  const id = store.createSession({ agent: "s" }).id
  const delta = socket()
  hub.attach(delta)
  hub.resume(delta, { features: ["delta"], sessionId: id }).flush()
  const legacy = plain ? socket() : null
  if (legacy) {
    hub.attach(legacy)
    hub.resume(legacy, { sessionId: id }).flush()
  }
  const firstEvent = hub.lastEventId
  await service.invoke("message.send", { sessionId: id, text: "go" }, "1")
  for (let i = 0; i < 20_000 && store.getSession(id)?.status !== "idle"; i++) await Bun.sleep(5)
  Date.now = realNow
  const ring = hub as unknown as { floor: number }
  return { store, hub, textId, delta, legacy, writes, writtenUnits, firstEvent, floor: ring.floor }
}

describe("a 1 MB streamed reply", () => {
  test("costs a delta phone at most 2.5 MB, and the replay ring still holds every delta", async () => {
    const { store, hub, textId, delta, firstEvent, floor } = await streamReply(false)
    expect(store.getMessage(textId)?.text.length).toBe(REPLY_CHARS)
    // Was 57.1 MB with a full message.append every 50 deltas and again at the turn's end.
    expect(delta.bytes).toBeLessThanOrEqual(2.5 * 1000 * 1000)
    // Prompt, first text frame, and the small terminal prompt patch. The reply body is never resent.
    expect(delta.appends).toBe(3)
    // Every event since the turn began is still replayable (was about 20 s of stream in a 16 MB ring).
    expect(floor).toBeLessThanOrEqual(firstEvent)
    hub.close()
  }, 30_000)

  test("is written back to SQLite about every 2 s at first and at most every 30 s later, not per broadcast", async () => {
    const { hub, writes, writtenUnits } = await streamReply(false)
    // Was 129 writes and 37.8 M UTF-16 units at 1 s / 64 K / 10 s.
    expect(writes).toBeLessThanOrEqual(36)
    expect(writtenUnits).toBeLessThanOrEqual(12 * 1000 * 1000)
    hub.close()
  }, 30_000)

  test("is written back as often with a phone polling a non-reading method every 200 ms as with none", async () => {
    const quiet = await streamReply(false)
    quiet.hub.close()
    const polled = await streamReply(false, (service, sessionId) => service.invoke("draft.get", { sessionId }, "poll"))
    // Was 527 writes (about 550 MB) when every request settled every stream.
    expect(polled.writes).toBe(quiet.writes)
    expect(polled.writtenUnits).toBe(quiet.writtenUnits)
    polled.hub.close()
  }, 60_000)

  test("still reaches a phone without delta support as full frames only", async () => {
    const { store, hub, textId, legacy } = await streamReply(true)
    expect(legacy?.deltas).toBe(0)
    expect(legacy?.appends).toBeGreaterThan(1000)
    expect(store.getMessage(textId)?.text.length).toBe(REPLY_CHARS)
    hub.close()
  }, 30_000)
})
