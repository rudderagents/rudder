import { describe, expect, test } from "bun:test"
import { EventHub, type HubSocket } from "./event-hub"
import { eventFrame, type Frame } from "./protocol"

function sample(frame: Frame): number {
  // The first id a hub with no store publishes is 2, one digit, so every frame in the budget test is this long.
  return JSON.stringify({ ...frame, eventId: 2 }).length * 2
}

function ask(hub: EventHub, lastEventId: number, sessionId?: string) {
  const socket = { send() {} }
  hub.attach(socket)
  hub.helloStarted(socket)
  const result = hub.resume(socket, { lastEventId, sessionId }).result
  hub.detach(socket)
  return result
}

function open(hub: EventHub, options: { delta?: boolean; sessionId?: string } = {}) {
  const sent: Frame[] = []
  const socket: HubSocket & { sent: Frame[] } = {
    sent,
    send(raw: string) {
      sent.push(JSON.parse(raw) as Frame)
    },
  }
  hub.attach(socket)
  hub.helloStarted(socket)
  const resumed = hub.resume(socket, {
    features: options.delta ? ["delta"] : [],
    lastEventId: hub.lastEventId,
    sessionId: options.sessionId,
  })
  resumed.flush()
  sent.length = 0
  return socket
}

describe("replay byte budget", () => {
  test("by default the ring reaches back 20,000 events and 30 minutes", () => {
    let now = 1_000_000
    const hub = new EventHub(null, { now: () => now })
    const cursor = hub.lastEventId
    const frame = eventFrame("session.upsert", { id: "s" })
    for (let i = 0; i < 20_000; i++) hub.publish(frame)
    expect(ask(hub, cursor).resync).toBe(false)
    hub.publish(frame)
    expect(ask(hub, cursor).resync).toBe(true)
    expect(ask(hub, cursor + 1).resync).toBe(false)
    now += 29 * 60 * 1000
    hub.publish(frame)
    expect(ask(hub, cursor + 2).resync).toBe(false)
    now += 2 * 60 * 1000
    hub.publish(frame)
    expect(ask(hub, cursor + 2).resync).toBe(true)
    hub.close()
  })

  test("a budget that fits two frames drops the oldest and resyncs an older cursor", () => {
    const frame = eventFrame("session.upsert", { id: "s" })
    const hub = new EventHub(null, { maxBytes: sample(frame) * 2 })
    const cursor = hub.lastEventId
    hub.publish(frame)
    hub.publish(frame)
    expect(ask(hub, cursor).resync).toBe(false)
    hub.publish(frame)
    expect(ask(hub, cursor).resync).toBe(true)
    expect(ask(hub, cursor + 1).resync).toBe(false)
    const replay = { sent: [] as Frame[], send(raw: string) { this.sent.push(JSON.parse(raw) as Frame) } }
    hub.attach(replay)
    hub.helloStarted(replay)
    const resumed = hub.resume(replay, { lastEventId: cursor + 1 })
    expect(resumed.result.resync).toBe(false)
    resumed.flush()
    expect(replay.sent.map((item) => item.eventId)).toEqual([cursor + 2, cursor + 3])
    hub.close()
  })

  test("one oversized frame is delivered live and is not replayed", () => {
    const payload = "x".repeat(10_000)
    const frame = eventFrame("session.upsert", { id: payload })
    const hub = new EventHub(null, { maxBytes: sample(frame) - 1 })
    const live = open(hub)
    const before = hub.lastEventId
    hub.publish(frame)
    expect(live.sent).toHaveLength(1)
    const delivered = live.sent[0]
    expect(delivered).toBeDefined()
    expect((delivered!.payload as { id: string }).id).toBe(payload)
    expect(ask(hub, before).resync).toBe(true)
    const again = open(hub)
    expect(again.sent).toEqual([])
    expect(hub.lastEventId).toBe(before + 1)
    hub.close()
  })

  test("full and delta stay ordered, and a message stays inside its session", () => {
    const hub = new EventHub(null, { maxBytes: 16 * 1024 * 1024 })
    const deltaSocket = open(hub, { delta: true, sessionId: "a" })
    const fullSocket = open(hub, { sessionId: "b" })
    const full = eventFrame("message.append", { sessionId: "a", id: "m", text: "hello" })
    const delta = eventFrame("message.delta", { sessionId: "a", id: "m", text: "h" })
    hub.publish(full, delta)
    hub.publish(eventFrame("session.upsert", { id: "a" }))
    expect(deltaSocket.sent.map((item) => item.name)).toEqual(["message.delta", "session.upsert"])
    expect(fullSocket.sent.map((item) => item.name)).toEqual(["session.upsert"])
    const deltaId = deltaSocket.sent[0]?.eventId
    const upsertId = deltaSocket.sent[1]?.eventId
    expect(typeof deltaId).toBe("number")
    expect(upsertId).toBeGreaterThan(deltaId ?? 0)
    hub.close()
  })

  test("close leaves a fresh frame replayable and does not keep an age timer", () => {
    const hub = new EventHub(null, { maxAgeMs: 60_000 })
    const cursor = hub.lastEventId
    hub.publish(eventFrame("session.upsert", { id: "s" }))
    hub.close()
    expect(ask(hub, cursor).resync).toBe(false)
  })

  // 2026-11-12 (perf-1112 R4): a full copy every 50 deltas let one long reply fill the byte budget in seconds.
  test("delta-only retention keeps no full text, and a non-message always keeps its text", () => {
    const hub = new EventHub(null)
    const delta = open(hub, { delta: true, sessionId: "s" })
    const cursor = hub.lastEventId
    const full = eventFrame("message.append", { sessionId: "s", id: "m", text: "x".repeat(10_000) })
    const variant = eventFrame("message.delta", { sessionId: "s", id: "m", offset: 0, append: "x" })
    for (let i = 0; i < 200; i++) hub.publish(full, variant)
    expect(ask(hub, cursor, "s").resync).toBe(true)
    expect(hub.replayScope(delta, "s", cursor)).toEqual({ replayed: true, count: 200 })
    // Every retained entry is the small delta text: 200 full copies would be 4 MB.
    expect((hub as unknown as { retained: number }).retained).toBeLessThan(200 * 500)
    const beforeConfig = hub.lastEventId
    hub.publish(eventFrame("config.upsert", { permissionMode: "ask" }))
    expect(ask(hub, beforeConfig).resync).toBe(false)
    const beforeDelta = hub.lastEventId
    hub.publish(full, variant)
    expect(ask(hub, beforeDelta, "s").resync).toBe(true)
    hub.close()
  })
})

// Audit 2026-11-10 (P3): a phone still opening counted as a plain socket, so every streamed delta kept its full
// text as well; and an unreadable cursor was taken as a fresh phone with nothing to catch up on.
describe("sockets still opening", () => {
  test("do not make streamed deltas keep full text; a plain one that then resumes across them resyncs", () => {
    const hub = new EventHub(null)
    open(hub, { delta: true, sessionId: "s" })
    const opening = { send() {} }
    hub.attach(opening)
    hub.helloStarted(opening)
    const cursor = hub.lastEventId
    const full = eventFrame("message.append", { sessionId: "s", id: "m", text: "x".repeat(2000) })
    const variant = eventFrame("message.delta", { sessionId: "s", id: "m", offset: 0, append: "x" })
    hub.publish(full, variant)
    const resumed = hub.resume(opening, { lastEventId: cursor, sessionId: "s" })
    expect(resumed.result.resync).toBe(true)
    resumed.flush()
    // The plain socket is live now: from here deltas keep their full text again.
    const next = hub.lastEventId
    hub.publish(full, variant)
    expect(ask(hub, next, "s").resync).toBe(false)
    hub.close()
  })

  // Review 2026-11-11 (P3): a plain socket whose hello carries no cursor replayed from when it opened without the
  // gap check, and silently skipped the delta-only frames streamed during its hello.
  test("a plain socket with no cursor resyncs across deltas streamed during its hello", () => {
    const hub = new EventHub(null)
    open(hub, { delta: true, sessionId: "s" })
    const sent: string[] = []
    const opening = { send: (raw: string) => sent.push(raw) }
    hub.attach(opening)
    hub.helloStarted(opening)
    const full = eventFrame("message.append", { sessionId: "s", id: "m", text: "x".repeat(2000) })
    hub.publish(full, eventFrame("message.delta", { sessionId: "s", id: "m", offset: 0, append: "x" }))
    const resumed = hub.resume(opening, { sessionId: "s" })
    expect(resumed.result.resync).toBe(true)
    resumed.flush()
    expect(sent).toEqual([])

    // With nothing it cannot read in the window, a socket without a cursor still gets what it missed, no resync.
    const replayed: string[] = []
    const plain = { send: (raw: string) => replayed.push(raw) }
    hub.attach(plain)
    hub.helloStarted(plain)
    hub.publish(eventFrame("session.upsert", { id: "s" }))
    const caughtUp = hub.resume(plain, { sessionId: "s" })
    expect(caughtUp.result.resync).toBe(false)
    caughtUp.flush()
    expect(replayed.map((raw) => (JSON.parse(raw) as Frame).name)).toEqual(["session.upsert"])
    hub.close()
  })

  test("a cursor that is present but not an integer resyncs", () => {
    const hub = new EventHub(null)
    hub.publish(eventFrame("session.upsert", { id: "s" }))
    const socket = { send() {} }
    hub.attach(socket)
    hub.helloStarted(socket)
    expect(hub.resume(socket, { lastEventId: "12" }).result.resync).toBe(true)
    expect(ask(hub, hub.lastEventId).resync).toBe(false)
    hub.close()
  })
})

describe("a socket live before its hello", () => {
  test("an invoke before hello makes an older cursor resync instead of claiming a replay", () => {
    const hub = new EventHub(null)
    const cursor = hub.lastEventId
    hub.publish(eventFrame("message.append", { sessionId: "s", message: { id: "m" } }))
    hub.publish(eventFrame("agent.status", { sessionId: "s", status: "idle" }))
    const socket = { send() {} }
    hub.attach(socket)
    hub.invoked(socket)
    hub.helloStarted(socket)
    expect(hub.resume(socket, { lastEventId: cursor, sessionId: "s" }).result.resync).toBe(true)
    hub.close()
  })

  test("a client already at the tip stays resumed", () => {
    const hub = new EventHub(null)
    hub.publish(eventFrame("session.upsert", { id: "s" }))
    const socket = { send() {} }
    hub.attach(socket)
    hub.invoked(socket)
    hub.helloStarted(socket)
    expect(hub.resume(socket, { lastEventId: hub.lastEventId }).result.resync).toBe(false)
    hub.close()
  })
})

type Linked = Frame & { prev?: number; tip?: number }
const linked = (frame: Frame | undefined) => (frame ?? {}) as Linked
const named = (frame: Frame) => (frame.payload ?? {}) as Record<string, unknown>

describe("per-session chain", () => {
  test("prev links each session's frames across interleaving, on full and delta alike, and globals carry tip", () => {
    const hub = new EventHub(null)
    const a = open(hub, { delta: true, sessionId: "a" })
    const b = open(hub, { sessionId: "b" })
    const order = ["a", "b", "b", "a", "a", "b", "a"]
    for (const sessionId of order) {
      hub.publish(
        eventFrame("message.append", { sessionId, id: "m", text: "x" }),
        eventFrame("message.delta", { sessionId, id: "m", offset: 0, append: "x" }),
      )
      hub.publish(eventFrame("session.upsert", { id: sessionId }))
    }
    for (const [socket, sessionId] of [[a, "a"], [b, "b"]] as const) {
      const messages = socket.sent.filter((frame) => frame.name?.startsWith("message."))
      expect(messages).toHaveLength(order.filter((id) => id === sessionId).length)
      let last = 0
      for (const frame of messages) {
        expect(linked(frame).prev).toBe(last)
        last = frame.eventId ?? -1
      }
      // A row update right after a frame names that frame as its session's tip.
      const upserts = socket.sent.filter((frame) => frame.name === "session.upsert" && named(frame).id === sessionId)
      expect(upserts.map((frame) => linked(frame).tip)).toEqual(messages.map((frame) => frame.eventId))
    }
    expect(a.sent.filter((frame) => frame.name?.startsWith("message.")).every((frame) => frame.name === "message.delta")).toBe(true)
    // A global frame about no session, or about one with nothing published yet, has no tip.
    hub.publish(eventFrame("config.upsert", { permissionMode: "ask" }))
    expect(linked(a.sent.at(-1)).tip).toBeUndefined()
    hub.publish(eventFrame("agent.status", { sessionId: "c", status: "idle" }))
    expect(linked(a.sent.at(-1)).tip).toBeUndefined()
    hub.publish(eventFrame("agent.status", { sessionId: "a", status: "idle" }))
    expect(linked(a.sent.at(-1)).tip).toBe(a.sent.filter((frame) => frame.name === "message.delta").at(-1)?.eventId)
    hub.close()
  })

  test("turn.state names its session through turn.sessionId", () => {
    const hub = new EventHub(null)
    const socket = open(hub, { sessionId: "s" })
    hub.publish(eventFrame("message.append", { sessionId: "s", id: "m" }))
    hub.publish(eventFrame("turn.state", { turn: { sessionId: "s", phase: "done" } }))
    expect(linked(socket.sent[1]).tip).toBe(socket.sent[0]?.eventId)
    hub.close()
  })

  test("prev still points at a frame the ring dropped; replay from before the floor is refused", () => {
    const hub = new EventHub(null, { capacity: 2 })
    const socket = open(hub, { sessionId: "s" })
    for (let i = 0; i < 5; i++) hub.publish(eventFrame("message.append", { sessionId: "s", id: `m${i}` }))
    const ids = socket.sent.map((frame) => frame.eventId ?? 0)
    expect(socket.sent.map((frame) => linked(frame).prev)).toEqual([0, ...ids.slice(0, 4)])
    expect(hub.replayScope(socket, "s", ids[0])).toEqual({ replayed: false, count: 0 })
    socket.sent.length = 0
    expect(hub.replayScope(socket, "s", ids[2])).toEqual({ replayed: true, count: 2 })
    expect(socket.sent.map((frame) => frame.eventId)).toEqual(ids.slice(3))
    hub.close()
  })

  test("replay sends only the asked session's frames, as the socket's variant, and only to a socket on it", () => {
    const hub = new EventHub(null)
    const socket = open(hub, { delta: true, sessionId: "s" })
    const cursor = hub.lastEventId
    hub.publish(eventFrame("message.append", { sessionId: "s", id: "m" }), eventFrame("message.delta", { sessionId: "s", id: "m" }))
    hub.publish(eventFrame("message.append", { sessionId: "t", id: "n" }))
    hub.publish(eventFrame("session.upsert", { id: "s" }))
    hub.publish(eventFrame("message.append", { sessionId: "s", id: "m2" }))
    socket.sent.length = 0
    expect(hub.replayScope(socket, "s", cursor)).toEqual({ replayed: true, count: 2 })
    expect(socket.sent.map((frame) => frame.name)).toEqual(["message.delta", "message.append"])
    expect(hub.replayScope(socket, "t", cursor).replayed).toBe(false)
    expect(hub.replayScope(socket, "s", hub.lastEventId + 1).replayed).toBe(false)
    expect(hub.replayScope(socket, "s", "1").replayed).toBe(false)
    hub.close()
  })

  test("a socket that hears only some events is not offered the chain and cannot replay", () => {
    const hub = new EventHub(null)
    const restricted = { send() {} }
    hub.attach(restricted, { only: new Set(["session.upsert"]) })
    hub.helloStarted(restricted)
    const resumed = hub.resume(restricted, { features: ["delta", "chain"], sessionId: "s" })
    expect(resumed.result.features).toEqual(["delta"])
    resumed.flush()
    expect(hub.replayScope(restricted, "s", hub.lastEventId).replayed).toBe(false)
    const full = { send() {} }
    hub.attach(full)
    hub.helloStarted(full)
    expect(hub.resume(full, { features: ["chain"] }).result.features).toEqual(["chain"])
    hub.close()
  })
})


test("bodyPages is negotiated only for full clients that request it", () => {
  const hub = new EventHub(null)
  const full = { send() {} }
  hub.attach(full)
  hub.helloStarted(full)
  expect(hub.resume(full, { features: ["bodyPages"] }).result.features).toEqual(["bodyPages"])
  const restricted = { send() {} }
  hub.attach(restricted, { only: new Set(["session.upsert"]) })
  hub.helloStarted(restricted)
  expect(hub.resume(restricted, { features: ["outline", "bodyPages"] }).result.features).toEqual(["outline"])
  const legacy = { send() {} }
  hub.attach(legacy)
  hub.helloStarted(legacy)
  expect(hub.resume(legacy, { features: ["outline"] }).result.features).toEqual(["outline"])
  hub.close()
})
