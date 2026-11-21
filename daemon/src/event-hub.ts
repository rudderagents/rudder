import type { Frame } from "./protocol"
import type { Store } from "./store"
import { sendGuarded } from "./ws-send"

/** Features a client may ask for in `hello {features}`. */
export const HUB_FEATURES = ["delta", "markUnread", "agentImages", "outline", "sendIdentity", "turnState", "chain", "sync", "bodyPages", "queueResume"] as const
export type HubFeature = (typeof HUB_FEATURES)[number]

/** How long a broadcast event stays replayable by default (`HubOptions.maxAgeMs`). */
export const REPLAY_MAX_AGE_MS = 30 * 60 * 1000

export type HubOptions = {
  /** Events kept for replay. */
  capacity?: number
  /** Events older than this are dropped from the replay ring. */
  maxAgeMs?: number
  /**
   * Retained-byte budget for the ring. Counts the UTF-16 length of the JSON text actually kept.
   * It is a budget, not `process.memoryUsage()`.
   */
  maxBytes?: number
  /** A socket that sends no invoke by then goes live with what it missed since it opened. */
  holdMs?: number
  now?: () => number
}

/** What a hub needs from a transport socket. */
export type HubSocket = { send(raw: string): unknown }

type Entry = {
  eventId: number
  at: number
  // message.* events reach only sockets with that session open; null reaches every socket.
  scope: string | null
  name: string
  fullRaw?: string
  deltaRaw?: string
  /** UTF-16 bytes of the JSON text this entry keeps. */
  bytes: number
}

type SocketState = {
  // held: opened, waiting for its first invoke; hello: a hello is being answered; live: gets events as they happen.
  phase: "held" | "hello" | "live"
  delta: boolean
  openSession: string | null
  // Last event id when the socket opened: a socket that never says hello still gets what happened since.
  openedAt: number
  holdTimer: ReturnType<typeof setTimeout> | null
  // Event names this socket may receive; null is every event. A free relay phone gets the approval line only.
  only: ReadonlySet<string> | null
}

export type AttachOptions = {
  /** Only these event names reach the socket (live and replayed); the rest are skipped. */
  only?: ReadonlySet<string>
}

export type ResumeRequest = { lastEventId?: unknown; features?: unknown; sessionId?: unknown }
export type ResumeResult = { eventId: number; resync: boolean; features: HubFeature[] }
export type ReplayResult = { replayed: boolean; count: number }

// Ids are reserved in blocks so the counter survives restarts with one meta write per block.
const RESERVE_KEY = "event_id_reserved"
const RESERVE_BLOCK = 10_000

/**
 * Numbers every broadcast event, keeps the recent ones for replay, and fans them out per socket: message.* only to
 * sockets that opened that session, and the `message.delta` variant to sockets that negotiated `delta`.
 */
export class EventHub<S extends HubSocket = HubSocket> {
  private readonly ring: Entry[] = []
  private readonly sockets = new Map<S, SocketState>()
  private readonly capacity: number
  private readonly maxAgeMs: number
  private readonly maxBytes: number
  private readonly holdMs: number
  private readonly now: () => number
  private last: number
  // Events with ids above floor are all still in the ring.
  private floor: number
  private reserved: number
  /** Sum of `bytes` for entries still in the ring. */
  private retained = 0
  private ageTimer: ReturnType<typeof setTimeout> | null = null
  private closed = false
  /**
   * Last event id published per session scope. Each message.* frame carries the one before it as `prev`, and a
   * global frame naming a session carries that session's as `tip`, so a phone can tell a frame of its open chat is
   * missing although the ids it sees skip every other session's. In memory: after a restart every cursor resyncs.
   */
  private readonly lastByScope = new Map<string, number>()

  constructor(private readonly store: Store | null, options: HubOptions = {}) {
    this.capacity = options.capacity ?? 20_000
    this.maxAgeMs = options.maxAgeMs ?? REPLAY_MAX_AGE_MS
    this.maxBytes = options.maxBytes ?? 16 * 1024 * 1024
    this.holdMs = options.holdMs ?? 5000
    this.now = options.now ?? Date.now
    const base = Number(store?.getMeta(RESERVE_KEY) ?? 0) || 0
    // One id is burned at boot: anything a client saw before the restart is then below floor, so it resyncs
    // (the restart itself reset statuses without events).
    this.last = base + 1
    this.floor = this.last
    this.reserved = this.last + RESERVE_BLOCK
    store?.setMeta(RESERVE_KEY, String(this.reserved))
  }

  get lastEventId(): number {
    return this.last
  }

  attach(socket: S, options: AttachOptions = {}) {
    const state: SocketState = {
      phase: "held",
      delta: false,
      openSession: null,
      openedAt: this.last,
      holdTimer: null,
      only: options.only ?? null,
    }
    state.holdTimer = setTimeout(() => {
      state.holdTimer = null
      if (state.phase === "held") this.goLive(socket, state, state.openedAt)
    }, this.holdMs)
    state.holdTimer.unref?.()
    this.sockets.set(socket, state)
  }

  detach(socket: S) {
    const state = this.sockets.get(socket)
    if (state?.holdTimer) clearTimeout(state.holdTimer)
    this.sockets.delete(socket)
  }

  /** Drops the age timer and every socket hold timer. Shutdown calls this so the process can exit. */
  close() {
    this.closed = true
    if (this.ageTimer) clearTimeout(this.ageTimer)
    this.ageTimer = null
    for (const state of this.sockets.values()) {
      if (state.holdTimer) clearTimeout(state.holdTimer)
      state.holdTimer = null
    }
  }

  /** The socket is about to read `sessionId` (session.get): its message.* events start now. */
  focus(socket: S, sessionId: string) {
    const state = this.sockets.get(socket)
    if (state) state.openSession = sessionId
  }

  /** Any invoke but hello: a socket still held goes live with what it missed since it opened. */
  invoked(socket: S) {
    const state = this.sockets.get(socket)
    if (state?.phase === "held") this.goLive(socket, state, state.openedAt)
  }

  /** A hello arrived: hold events until `resume` answers it. */
  helloStarted(socket: S) {
    const state = this.sockets.get(socket)
    if (state?.phase === "held") state.phase = "hello"
  }

  /**
   * Answers a hello: negotiates features, sets the open session, and decides replay. Returns the fields for the
   * hello result and a `flush` that must run right after that result is sent, with no await in between: it sends
   * the replay and makes the socket live.
   */
  resume(socket: S, request: ResumeRequest): { result: ResumeResult; flush: () => void } {
    const state = this.sockets.get(socket)
    // A socket that hears only some event names cannot tell a filtered frame from a lost one; nor can it page
    // message.changes (r64 sync) or resume a queue (queue.resume), which the free relay line does not serve.
    const fullOnly = new Set<string>(["chain", "sync", "bodyPages", "queueResume"])
    const features = readFeatures(request.features).filter((feature) => !fullOnly.has(feature) || !state?.only)
    if (!state) return { result: { eventId: this.last, resync: false, features }, flush: () => {} }
    state.delta = features.includes("delta")
    if (typeof request.sessionId === "string" && request.sessionId) state.openSession = request.sessionId
    const asked = typeof request.lastEventId === "number" && Number.isInteger(request.lastEventId) ? request.lastEventId : null
    // A cursor that is there but unreadable (a fraction, a string) names no point to replay from: resync, rather than
    // treat the phone as a fresh one that has nothing to catch up on.
    const garbled = asked === null && request.lastEventId !== undefined && request.lastEventId !== null
    // A socket that went live before its hello (another invoke or the hold timer got there first) cannot replay
    // without reordering what it already got, and it had no open session then, so it may also have missed message.*
    // for the session it now names. Unless the client is already at the tip, it must resync rather than be told it
    // is caught up.
    if (state.phase === "live") {
      return { result: { eventId: this.last, resync: garbled || (asked !== null && asked !== this.last), features }, flush: () => {} }
    }
    this.evict()
    // No cursor: what happened since the socket opened. That window gets the same checks as a cursor's, since a plain
    // socket in its hello did not stop deltas from dropping their full text (publish).
    const start = asked ?? state.openedAt
    const replayable = start >= this.floor && start <= this.last
    // A frame this socket would not be given (another session, a filtered name) is not a hole.
    // One it should see, with no text it can read, is: replaying part of the gap would skip ids.
    const gap = replayable && this.hasGap(state, start)
    const from = replayable && !gap ? start : this.last
    return {
      result: { eventId: this.last, resync: garbled || !replayable || gap, features },
      flush: () => this.goLive(socket, state, from),
    }
  }

  /** Numbers `frame`, keeps it for replay, and sends it (or its `delta` variant) to every live socket it concerns. */
  publish(frame: Frame, delta?: Frame) {
    this.last += 1
    if (this.last > this.reserved) {
      this.reserved += RESERVE_BLOCK
      this.store?.setMeta(RESERVE_KEY, String(this.reserved))
    }
    const eventId = this.last
    const scope = scopeOf(frame)
    // Both variants carry the same link. The ring keeps the JSON text and lets the object go.
    const link = this.link(frame, scope, eventId)
    const full = { ...frame, eventId, ...link }
    const deltaFrame = delta ? { ...delta, eventId, ...link } : undefined
    // Only live sockets count. One still opening (held, or its hello being answered) has not negotiated delta yet;
    // counting it as a plain socket made every streamed delta keep its full text too while any phone connected. If it
    // turns out plain, its resume finds the frame it cannot read (hasGap) and tells it to resync.
    const everyoneDelta = [...this.sockets.values()].every((socket) => socket.delta || socket.phase !== "live")
    // While every live socket takes deltas the ring keeps only the delta text (2026-11-12, perf-1112 R4): an
    // occasional full copy let a 1 MB reply fill the 16 MB budget in about 20 s, and a plain socket that resumes
    // across a delta-only frame resyncs anyway (hasGap).
    const fullRaw = !deltaFrame || !everyoneDelta ? JSON.stringify(full) : undefined
    const deltaRaw = deltaFrame ? JSON.stringify(deltaFrame) : undefined
    const entry: Entry = {
      eventId,
      at: this.now(),
      scope,
      name: frame.name ?? "",
      fullRaw,
      deltaRaw,
      bytes: (fullRaw?.length ?? 0) * 2 + (deltaRaw?.length ?? 0) * 2,
    }
    // A single frame larger than the budget is sent live and then forgotten. Keeping it would make
    // every older cursor replay a hole, so the floor jumps to this id and those cursors resync.
    if (entry.bytes > this.maxBytes) {
      this.discardRing(eventId)
      this.fanout(entry)
      return
    }
    this.retain(entry)
    this.evict()
    // Live sockets still receive this frame when eviction dropped it for capacity or age.
    this.fanout(entry)
  }

  /** `prev` for a message.* frame (0 for a session's first), `tip` for a global frame about a session that has any. */
  private link(frame: Frame, scope: string | null, eventId: number): { prev: number } | { tip: number } | undefined {
    if (scope !== null) {
      const prev = this.lastByScope.get(scope) ?? 0
      this.lastByScope.set(scope, eventId)
      return { prev }
    }
    const named = sessionNamed(frame)
    if (named === null) return undefined
    const tip = this.lastByScope.get(named)
    if (frame.name === "session.removed") this.lastByScope.delete(named)
    return tip === undefined ? undefined : { tip }
  }

  /**
   * `events.replay`: sends a live socket the retained message.* frames of `sessionId` after `after`, in order, right
   * away. The phone found a hole in that session's `prev` chain. Refused (the phone reloads instead) when the socket
   * is not live on that session, hears only some events, or the ring no longer reaches back to `after`.
   */
  replayScope(socket: S, sessionId: string, after: unknown): ReplayResult {
    const state = this.sockets.get(socket)
    if (!state || state.phase !== "live" || state.openSession !== sessionId || state.only) return { replayed: false, count: 0 }
    this.evict()
    if (typeof after !== "number" || !Number.isInteger(after) || after < this.floor || after > this.last) {
      return { replayed: false, count: 0 }
    }
    const matched: Entry[] = []
    for (const entry of this.ring) {
      if (entry.eventId <= after || entry.scope !== sessionId) continue
      if (!this.canServe(state, entry)) return { replayed: false, count: 0 }
      matched.push(entry)
    }
    for (const entry of matched) this.deliver(socket, state, entry)
    return { replayed: true, count: matched.length }
  }

  private retain(entry: Entry) {
    this.ring.push(entry)
    this.retained += entry.bytes
  }

  private fanout(entry: Entry) {
    for (const [socket, state] of this.sockets) {
      if (state.phase === "live") this.deliver(socket, state, entry)
    }
  }

  /** Forgets every retained id at or below `throughId`. */
  private discardRing(throughId: number) {
    while (this.ring.length > 0) this.dropFront()
    this.floor = throughId
    this.armAgeTimer()
  }

  private goLive(socket: S, state: SocketState, after: number) {
    if (state.holdTimer) {
      clearTimeout(state.holdTimer)
      state.holdTimer = null
    }
    state.phase = "live"
    for (const entry of this.ring) {
      if (entry.eventId > after) this.deliver(socket, state, entry)
    }
  }

  /** True when `entry` is not for this socket, or the text it would be sent is still in the ring. */
  private canServe(state: SocketState, entry: Entry): boolean {
    if (!this.concerns(state, entry)) return true
    return this.rawFor(state, entry) !== undefined
  }

  /** A retained frame this socket would be given. Another session, or a name outside `only`, is not one. */
  private concerns(state: SocketState, entry: Entry): boolean {
    if (entry.scope !== null && entry.scope !== state.openSession) return false
    if (state.only && !state.only.has(entry.name)) return false
    return true
  }

  private rawFor(state: SocketState, entry: Entry): string | undefined {
    return state.delta ? (entry.deltaRaw ?? entry.fullRaw) : entry.fullRaw
  }

  /** Any frame after `after` that this socket should see and cannot. */
  private hasGap(state: SocketState, after: number): boolean {
    for (const entry of this.ring) {
      if (entry.eventId <= after) continue
      if (!this.canServe(state, entry)) return true
    }
    return false
  }

  private deliver(socket: S, state: SocketState, entry: Entry) {
    if (!this.concerns(state, entry)) return
    const raw = this.rawFor(state, entry)
    if (raw !== undefined) {
      sendGuarded(socket, raw)
      return
    }
    // canServe / hasGap keep replays away from entries without text this socket can read, and a live frame keeps
    // its full text whenever a non-delta socket is attached. Reaching here means the phone silently misses a frame.
    console.warn(`rudderd: event ${entry.eventId} (${entry.name}) has no ${state.delta ? "delta or full" : "full"} text for a socket; skipped`)
  }

  private dropFront() {
    const dropped = this.ring.shift()
    if (!dropped) return
    this.retained -= dropped.bytes
    if (this.retained < 0) this.retained = 0
    this.floor = dropped.eventId
  }

  private evict() {
    const oldest = this.now() - this.maxAgeMs
    while (this.ring.length > 0) {
      const head = this.ring[0]
      if (!head) break
      const tooMany = this.ring.length > this.capacity
      const tooOld = head.at < oldest
      const tooBig = this.retained > this.maxBytes
      if (!tooMany && !tooOld && !tooBig) break
      this.dropFront()
    }
    this.armAgeTimer()
  }

  /**
   * One timer, aimed at the oldest retained frame. A non-positive delay is not scheduled: publish and resume
   * already evict expired frames, and a zero delay would run under a frozen test clock.
   */
  private armAgeTimer() {
    if (this.ageTimer) clearTimeout(this.ageTimer)
    this.ageTimer = null
    if (this.closed) return
    const head = this.ring[0]
    if (!head) return
    const delay = head.at + this.maxAgeMs - this.now()
    if (!(delay > 0)) return
    this.ageTimer = setTimeout(() => {
      this.ageTimer = null
      this.evict()
    }, delay)
    this.ageTimer.unref?.()
  }
}

function scopeOf(frame: Frame): string | null {
  if (!frame.name?.startsWith("message.")) return null
  const sessionId = (frame.payload as { sessionId?: unknown } | undefined)?.sessionId
  return typeof sessionId === "string" ? sessionId : null
}

/** The session a global frame is about, for its `tip`. */
function sessionNamed(frame: Frame): string | null {
  const payload = frame.payload as { id?: unknown; sessionId?: unknown; turn?: { sessionId?: unknown } } | undefined
  if (!payload || typeof payload !== "object") return null
  if (frame.name === "session.upsert" || frame.name === "session.removed") return typeof payload.id === "string" ? payload.id : null
  if (typeof payload.sessionId === "string") return payload.sessionId
  return typeof payload.turn?.sessionId === "string" ? payload.turn.sessionId : null
}

function readFeatures(value: unknown): HubFeature[] {
  if (!Array.isArray(value)) return []
  return HUB_FEATURES.filter((feature) => value.includes(feature))
}
