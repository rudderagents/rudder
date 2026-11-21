import { basename } from "node:path"
import type { PlanEntry, ToolKind, ToolStatus } from "./adapter/types"
import { type AppLocale, appLocale } from "./app-locale"
import { type LiveTurnEnd, RESULT_COPY_CHARS, SWIFT_REFERENCE_UNIX } from "./live-activity"
import type { PhoneCopy } from "./phone-copy"
import { AlertLadder, type LiveAlert } from "./live-alerts"
import { AUTO_TITLE_COMMAND, commandTitle, isSubagentTool, subagentStep } from "./session-title"
import { BAD_TICKET_REASONS, firstPromptLine, firstSentence, GATEWAY_TIMEOUT_MS, isPushTicket, type PushChanges, type LiveField, type PushReason, sealLive } from "./push"
import type { DeviceRow, LiveCardRow, LiveStart, Store } from "./store"

/**
 * One Live Activity per phone for this computer. The phone
 * starts it (`liveActivity.register {scope: "computer"}`); from then on rudderd decides which session it shows and
 * pushes every session's turns into the same card, including turns the phone did not start.
 *
 * Per session it keeps a `Track` (the turn's step, approval, question, result) in plaintext; each card seals what it
 * shows with its own phone's key at push time.
 */

const KEEP_CHOICES = new Set([300, 900, 3600, 14400])
const DEFAULT_KEEP_SECONDS = 900
/**
 * This long without a push and the card says the computer is not responding. Five minutes: plain frames go at APNs
 * priority 5, which the phone may hold back for power, so the window leaves room for a held heartbeat and for one priority-10 frame (`CARD_SURE_MS`).
 */
export const CARD_STALE_SECONDS = 300
/** While a session runs or waits, a quiet card is pushed this often, well inside the stale window. */
export const CARD_HEARTBEAT_MS = 60_000
/**
 * Priority-5 frames carry no delivery promise. A frame this long after the card's last priority-10 one goes at 10,
 * so a live computer reaches the phone before the stale date even when every priority-5 frame is held. At most one
 * such frame per card every three minutes, which keeps the ActivityKit budget for the alerts.
 */
export const CARD_SURE_MS = 180_000
/** A frame lost to the network or a gateway 5xx is tried again this soon, not at the next heartbeat. */
export const CARD_RETRY_MS = 15_000
/**
 * v103: the followed session's 做完 (or a failure that took the card) holds this long before the card moves on to a
 * running session.
 */
export const FOLLOW_HOLD_MS = 5 * 60_000
/** v103: with everything finished the island keeps 「做完」 this long; the lock screen keeps the card for `keep_seconds`. */
export const LINGER_MS = 5 * 60_000
const ROTATE_AFTER_MS = (7 * 60 + 50) * 60 * 1000
const ACTIVITY_TOKEN = /^[0-9a-fA-F]{32,400}$/
const STEP_CHARS = 80
const SUMMARY_CHARS = 120
const RESULT_CHARS = 90
const QUESTION_CHARS = 80
const TITLE_CHARS = 60
const PROJECT_CHARS = 40
const PLAN_ITEM_CHARS = 60
const PLAN_MAX = 999
const OTHER_TITLES = 2
const REGISTER_GRACE_MS = 60_000
/** r70 1.2a: a phone that is open starts its own card when it sends; rudderd starts one only after this long without. */
const START_DELAY_MS = 5_000
/** After an approval or question cut a frame's post short, its state goes once more: the aborted post may still land later. */
const REASSERT_MS = 3_000
const ACCOUNT_ID = /^[\x21-\x7e]{1,128}$/

type TrackPhase = "running" | "waiting" | "done" | "failed" | "interrupted"
export type CardPhase = "running" | "waiting" | "done" | "failed" | "interrupted"

export type Track = {
  sessionId: string
  phase: TrackPhase
  prompt?: string
  /** The turn is a continuation (origin agent_continue): its prompt line is the notice, in each phone's language. */
  continuation?: boolean
  turnStartedAt: number
  lastEventAt: number
  endedAt?: number
  stepKind?: string
  /** 11-19: 「agent」 while the step waits on a sub-agent; the phone words it 「等子 agent」, the description short. */
  stepTool?: "agent"
  stepPlain?: string
  stepStartedAt?: number
  stepToolId?: string
  stepToolStatus?: ToolStatus
  toolCount: number
  started: Set<string>
  completed: Set<string>
  backgroundOpen: number
  approval?: { requestId: string; tool: string; summary: string }
  question?: { requestId: string; title: string; count: number }
  /** When this stretch of waiting began (v79: the card gives way after `yieldAfter`). */
  waitingSince?: number
  /** When rudderd first saw the session: the order of the card's 「1/3」. */
  seenAt: number
  /** v103: the turn's task list, 「第 3/7 项」. */
  plan?: PlanProgress
  result?: string
  /** A failed turn's result as phone copy; sealed beside `result` so the card words it in the phone's language. */
  resultCopy?: PhoneCopy
  reason?: PushReason
  changes?: PushChanges
  /**
   * v115: the user stopped the turn. It stays a finished turn (`done`) for focus and stay, and goes out as
   * 「已中断」 (`interrupted`) without an alert, as it leaves the notifications quiet.
   */
  stopped?: boolean
}

/** What `pickFocus` needs of a session. */
export type FocusCandidate = {
  sessionId: string
  phase: TrackPhase
  waitingOn?: "approval" | "question"
  waitingSince?: number
  lastEventAt: number
  endedAt?: number
  /** `Track.seenAt`: the order of the card's 「1/3」. */
  seenAt?: number
}

/**
 * v79: how long a waiting session keeps the card's main area once it was told. After that a running session takes it
 * and the waiting one stays counted in the bottom line (「N 个在等你」). An approval blocks the agent, so it holds longer.
 */
export const YIELD_QUESTION_MS = 5 * 60_000
export const YIELD_APPROVAL_MS = 15 * 60_000

function yielded(candidate: FocusCandidate, now: number): boolean {
  if (candidate.phase !== "waiting" || candidate.waitingSince === undefined) return false
  return now - candidate.waitingSince >= (candidate.waitingOn === "approval" ? YIELD_APPROVAL_MS : YIELD_QUESTION_MS)
}

export type Focus = { sessionId: string; since: number }

function rank(candidate: FocusCandidate, now: number, holdMs: number): number {
  // Past its hold it ranks under running, over done: alone it keeps the card, beside running work it gives way.
  if (yielded(candidate, now)) return 0.5
  if (candidate.phase === "waiting") return candidate.waitingOn === "question" ? 3 : 4
  // v103: a failure takes the card for its hold, then it is a finished turn like any other.
  if (candidate.phase === "failed") return (candidate.endedAt ?? candidate.lastEventAt) + holdMs > now ? 2 : 0
  if (candidate.phase === "running") return 1
  if (candidate.phase === "done") return 0
  return -1
}

/**
 * Approval > question > failure (for `holdMs`) take the card at once, first come first
 * served, and the one shown keeps it among equals (its buttons stay put; a second goes out as a notification).
 * Otherwise the card follows `follow`, the session the phone last sent to, until its turn ends; its 做完 then holds
 * `holdMs` before the card follows the running session with the latest event. Running sessions never rotate: the one
 * shown stays. `candidates` must already exclude finished sessions past their stay.
 */
export function pickFocus(
  candidates: FocusCandidate[],
  current: Focus | undefined,
  now: number,
  follow?: string,
  holdMs = FOLLOW_HOLD_MS,
): string | undefined {
  const live = candidates.filter((candidate) => rank(candidate, now, holdMs) >= 0)
  if (live.length === 0) return undefined
  const top = Math.max(...live.map((candidate) => rank(candidate, now, holdMs)))
  if (top >= 2) {
    const best = live.filter((candidate) => rank(candidate, now, holdMs) === top)
    const shown = current ? best.find((candidate) => candidate.sessionId === current.sessionId) : undefined
    if (shown) return shown.sessionId
    const since = (candidate: FocusCandidate) => (top === 2 ? candidate.endedAt : candidate.waitingSince) ?? candidate.lastEventAt
    return best.reduce((a, b) => (since(b) < since(a) ? b : a)).sessionId
  }
  const followed = follow ? live.find((candidate) => candidate.sessionId === follow) : undefined
  if (followed?.phase === "running") return followed.sessionId
  if (followed && (followed.phase === "done" || followed.phase === "failed") && (followed.endedAt ?? 0) + holdMs > now) return followed.sessionId
  // Running work first; a wait past its v79 hold only when nothing runs.
  const running = live.filter((candidate) => candidate.phase === "running")
  const pool = running.length > 0 ? running : live.filter((candidate) => candidate.phase === "waiting")
  if (pool.length > 0) {
    const kept = pool.find((candidate) => candidate.sessionId === follow) ?? pool.find((candidate) => candidate.sessionId === current?.sessionId)
    if (kept) return kept.sessionId
    return pool.reduce((a, b) => (b.lastEventAt > a.lastEventAt ? b : a)).sessionId
  }
  if (followed) return followed.sessionId
  const ended = (candidate: FocusCandidate) => candidate.endedAt ?? candidate.lastEventAt
  return live.reduce((a, b) => (ended(b) > ended(a) ? b : a)).sessionId
}

/** v103 「1/3」: where the shown session sits among the card's sessions, in the order rudderd first saw them. */
export function positionOf(candidates: FocusCandidate[], focus: string): { position: number; total: number } | undefined {
  const ordered = [...candidates].sort((a, b) => (a.seenAt ?? a.lastEventAt) - (b.seenAt ?? b.lastEventAt) || (a.sessionId < b.sessionId ? -1 : 1))
  const index = ordered.findIndex((candidate) => candidate.sessionId === focus)
  return index < 0 ? undefined : { position: index + 1, total: ordered.length }
}

export type PlanProgress = { index: number; total: number; item?: string }

/**
 * v103 「第 3/7 项 · 补测试」: the item in progress, else the first not yet done, out of all; every item done reads the
 * last. No item text then.
 */
export function planProgress(entries: PlanEntry[]): PlanProgress | undefined {
  if (entries.length === 0) return undefined
  const total = Math.min(PLAN_MAX, entries.length)
  let index = entries.findIndex((entry) => entry.status === "in_progress")
  if (index < 0) index = entries.findIndex((entry) => entry.status !== "completed")
  if (index < 0) return { index: total, total }
  const item = clip(entries[index]!.content.replace(/\s+/g, " ").trim(), PLAN_ITEM_CHARS)
  return { index: Math.min(total, index + 1), total, ...(item ? { item } : {}) }
}

export type OthersWait = { sessionId: string; kind: "question" | "approval" }

/**
 * fB1's 「另外 N 个在跑 · 标题 · 标题」: the other running or waiting sessions, latest event first. v79: `wait` is the
 * one of them that has waited longest — the card's 「N 个在等你 · 最早：…」 line names it and a tap opens it.
 */
export function othersOf(
  candidates: FocusCandidate[],
  focus: string | undefined,
  withWait = true,
): { count: number; waiting: number; sessionIds: string[]; wait?: OthersWait } {
  const rest = candidates
    .filter((candidate) => candidate.sessionId !== focus && (candidate.phase === "running" || candidate.phase === "waiting"))
    .sort((a, b) => b.lastEventAt - a.lastEventAt)
  const waiting = rest.filter((candidate) => candidate.phase === "waiting")
  const since = (candidate: FocusCandidate) => candidate.waitingSince ?? candidate.lastEventAt
  const earliest = withWait && waiting.length > 0 ? waiting.reduce((a, b) => (since(b) < since(a) ? b : a)) : undefined
  // With a 在等你 line the waiting ones are named there; 「另外 N 个在跑」 names only the running ones.
  const named = earliest ? rest.filter((candidate) => candidate.phase === "running") : rest
  return {
    count: rest.length,
    waiting: waiting.length,
    sessionIds: named.slice(0, OTHER_TITLES).map((candidate) => candidate.sessionId),
    ...(earliest ? { wait: { sessionId: earliest.sessionId, kind: earliest.waitingOn ?? "question" } } : {}),
  }
}

type Card = {
  seq: number
  focus?: Focus
  /** The last focus key an alert went out for (`session:request` / `session:done:t`). One alert per thing. */
  alerted?: string
  timer: ReturnType<typeof setTimeout> | null
  heartbeat: ReturnType<typeof setTimeout> | null
  retryTimer?: ReturnType<typeof setTimeout>
  retryFailures?: number
  dismiss: ReturnType<typeof setTimeout> | null
  rotate: ReturnType<typeof setTimeout> | null
  lastSentAt: number
  /** Settles once nothing is in flight and nothing waits. */
  chain: Promise<void>
  /** The one frame waiting for the post in flight. A newer frame replaces it: each carries the whole state. */
  pending?: Frame
  inflight?: { urgent: boolean; abort: AbortController }
  /** Updates the gateway accepted for this card. */
  sent?: number
  reassert?: ReturnType<typeof setTimeout> | null
  failure?: string
  /** When the gateway last took a priority-10 frame for this card (or when the card was made). */
  lastSureAt: number
  /** The request the phone could still be showing until it receives a clearing frame. */
  asked?: string
  gen: number
}

/** A rendered update. `urgent` (an approval or question on the card) cuts a slower frame's post short. */
type Frame = {
  row: LiveCardRow
  state: Record<string, unknown>
  forceSure: boolean
  kind: AlertKind | undefined
  focus: string
  gen: number
  busy: boolean
  urgent: boolean
  /** It aborted another frame's post (`enqueue`). */
  cutShort?: boolean
}

export type LiveCardOptions = {
  gateway: string | null
  fetch?: typeof fetch
  coalesceMs?: number
  minStepIntervalMs?: number
  heartbeatMs?: number
  sureMs?: number
  retryMs?: number
  random?: () => number
  trackKeepMs?: number
  rotateAfterMs?: number
  /** v103: how long the followed session's 做完, or a failure, holds the card (`FOLLOW_HOLD_MS`). */
  holdMs?: number
  /** v103: how long the island keeps 「做完」 once everything finished (`LINGER_MS`). */
  lingerMs?: number
  requestTimeoutMs?: number
  reassertMs?: number
  now?: () => number
  log?: (line: string) => void
  /** The adapter's display name for a session's agent (`Claude Code`). */
  agentLabel?: (agentId: string) => string | undefined
  /** 7h50: the phone ends this card and starts a new one (ActivityKit's 8-hour cap). */
  onRotate?: (deviceKey: string) => void
  onTicketDropped?: (device: DeviceRow, reason: string) => void
  /** The name hello shows; sealed into a card rudderd starts (r70 1.2a). */
  machineName?: () => string
  startDelayMs?: number
}

type RegisterInput = {
  activityId: string
  pushToken: string
  keepSeconds: number
  locale: string
  deviceKey: string | undefined
}

/** The fallback notification a card stood in for: sent if a push to the card fails before it is settled. */
type Fallback = { sessionId: string; send: () => void }

export class LiveCardNotifier {
  private readonly fetch: typeof fetch
  private readonly coalesceMs: number
  private readonly minStepIntervalMs: number
  private readonly heartbeatMs: number
  private readonly sureMs: number
  private readonly retryMs: number
  private readonly rotateAfterMs: number
  private readonly holdMs: number
  private readonly lingerMs: number
  /** v103: the session the phone last sent to (not a continuation). Every card follows it. */
  private follow: string | undefined
  private readonly requestTimeoutMs: number
  private readonly now: () => number
  private readonly log: (line: string) => void
  private readonly tracks = new Map<string, Track>()
  private trackPruneTimer?: ReturnType<typeof setTimeout>
  private readonly cards = new Map<string, Card>()
  private readonly fallbacks = new Map<string, Fallback>()
  /** Results a card carried (fB3): the done / failed notification is not sent for these. */
  private readonly carried = new Map<string, "pending" | "ok">()
  /** The deployed gateway may predate the 等你回答 alert (B-4); after one refusal, questions alert without it. */
  private questionAlertRefused = false
  /** The deployed gateway may predate `titleKey` / `bodyKey`; after one refusal, alerts go as the paired language's text. */
  private readonly ladder: AlertLadder
  /** The deployed gateway predates v79's `others.wait`; after one refusal, cards go without it until restart. */
  private waitRefused = false
  /** r70 1.2a: phones whose card rudderd started this busy stretch (no activity token yet), and starts waiting to go. */
  private readonly startSent = new Set<string>()
  private readonly startTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** The deployed gateway predates push-to-start: stop asking until restart. */
  private startRefused = false
  private readonly startDelayMs: number
  private readonly reassertMs: number

  constructor(
    private readonly store: Store,
    private readonly options: LiveCardOptions,
  ) {
    this.fetch = options.fetch ?? fetch
    this.coalesceMs = options.coalesceMs ?? 1000
    this.minStepIntervalMs = options.minStepIntervalMs ?? 2000
    this.heartbeatMs = options.heartbeatMs ?? CARD_HEARTBEAT_MS
    this.sureMs = options.sureMs ?? CARD_SURE_MS
    this.retryMs = options.retryMs ?? CARD_RETRY_MS
    this.rotateAfterMs = options.rotateAfterMs ?? ROTATE_AFTER_MS
    this.holdMs = options.holdMs ?? FOLLOW_HOLD_MS
    this.lingerMs = options.lingerMs ?? LINGER_MS
    this.requestTimeoutMs = options.requestTimeoutMs ?? GATEWAY_TIMEOUT_MS
    this.reassertMs = options.reassertMs ?? REASSERT_MS
    this.now = options.now ?? Date.now
    this.log = options.log ?? ((line) => console.warn(line))
    this.ladder = new AlertLadder((line) => this.log(`live-card: ${line}`))
    this.startDelayMs = options.startDelayMs ?? START_DELAY_MS
  }

  // MARK: phone

  register(input: RegisterInput): { ok: true } {
    if (!input.deviceKey) fail("device key required", "unauthorized")
    if (!ACTIVITY_TOKEN.test(input.pushToken)) fail("pushToken must be 32–400 hex characters", "invalid")
    if (!input.activityId) fail("activityId required", "invalid")
    const keep = KEEP_CHOICES.has(input.keepSeconds) ? input.keepSeconds : DEFAULT_KEEP_SECONDS
    const locale = appLocale(input.locale)
    const previous = this.store.liveCard(input.deviceKey)
    this.startSent.delete(input.deviceKey)
    this.cancelStart(input.deviceKey)
    const same = previous?.push_token === input.pushToken
    this.store.putLiveCard({
      device_key: input.deviceKey,
      activity_id: input.activityId,
      push_token: input.pushToken,
      keep_seconds: keep,
      locale,
      started_at: same && previous ? previous.started_at : this.now(),
      focus_session: same && previous ? previous.focus_session : null,
      state: same && previous ? previous.state : null,
    })
    if (previous && !same) void this.postEnd(previous)
    if (!same) this.resetCard(input.deviceKey)
    this.armRotate(input.deviceKey)
    if (this.trackPruneTimer) this.pruneTracks(this.store.listLiveCards())
    // A fresh card shows the computer as it is now (the session the phone just sent is already a track).
    this.schedule(input.deviceKey, !same)
    return { ok: true }
  }

  async end(activityId: string): Promise<{ ok: true }> {
    const row = this.store.liveCardByActivity(activityId)
    if (!row) return { ok: true }
    await this.postEnd(row)
    this.drop(row)
    return { ok: true }
  }

  owns(deviceKey: string | undefined): boolean {
    return deviceKey !== undefined && this.store.liveCard(deviceKey) !== null
  }

  // MARK: sessions

  turnStarted(sessionId: string, prompt: string, options: { continuation?: boolean } = {}) {
    const now = this.now()
    const track = this.track(sessionId, true)!
    Object.assign(track, {
      phase: "running" as TrackPhase,
      // A continuation's text is the agent's own summary (Codex: "Subagent finished: …"), not something the user asked.
      prompt: options.continuation ? undefined : firstPromptLine(prompt),
      continuation: options.continuation === true,
      turnStartedAt: now,
      lastEventAt: now,
      endedAt: undefined,
      stepKind: undefined,
      stepTool: undefined,
      stepPlain: undefined,
      stepStartedAt: undefined,
      stepToolId: undefined,
      stepToolStatus: undefined,
      toolCount: 0,
      started: new Set<string>(),
      completed: new Set<string>(),
      backgroundOpen: 0,
      approval: undefined,
      question: undefined,
      result: undefined,
      resultCopy: undefined,
      reason: undefined,
      changes: undefined,
      plan: undefined,
      stopped: undefined,
    })
    // v103: the card follows what you last sent; an agent's own continuation does not move it.
    if (!options.continuation) this.follow = sessionId
    this.carried.delete(sessionId)
    this.touchAll(false)
  }

  /** v103: the turn's task list changed (`plan` event). */
  plan(sessionId: string, entries: PlanEntry[]) {
    const track = this.tracks.get(sessionId)
    if (!track || (track.phase !== "running" && track.phase !== "waiting")) return
    const next = planProgress(entries)
    const same = next?.index === track.plan?.index && next?.total === track.plan?.total && next?.item === track.plan?.item
    if (same) return
    track.plan = next
    track.lastEventAt = this.now()
    this.touchAll(false)
  }

  tool(sessionId: string, event: { id: string; tool?: string; title: string; kind: ToolKind; status: ToolStatus }) {
    const track = this.tracks.get(sessionId)
    if (!track || track.phase !== "running") return
    const now = this.now()
    track.lastEventAt = now
    const terminal = event.status === "completed" || event.status === "failed" || event.status === "declined" || event.status === "cancelled"
    const counted = terminal && !track.completed.has(event.id)
    if (counted) {
      track.completed.add(event.id)
      track.toolCount = track.completed.size
    }
    const starting = event.status === "running" || (event.status === "pending" && !track.started.has(event.id))
    let changed = false
    if (starting) {
      track.started.add(event.id)
      const kind = mapKind(event.kind)
      const agent = isSubagentTool(event.tool)
      // A sub-agent's description is a sentence, not a tool name: a short head of it, or nothing (Codex `wait`).
      const title = agent ? subagentStep(event.title, event.tool!) || undefined : clip(event.title, STEP_CHARS)
      const stepTool = agent ? ("agent" as const) : undefined
      changed =
        track.stepToolId !== event.id || track.stepToolStatus !== event.status || track.stepKind !== kind || track.stepPlain !== title || track.stepTool !== stepTool
      if (changed) {
        track.stepToolId = event.id
        track.stepToolStatus = event.status
        track.stepKind = kind
        track.stepTool = stepTool
        track.stepPlain = title
        track.stepStartedAt = now
      }
    }
    // A competing session can still change focus or the other-session line through lastEventAt.
    if (counted || changed || ((terminal || starting) && this.tracks.size > 1)) this.touchAll(false)
  }

  background(sessionId: string, open: number) {
    const track = this.tracks.get(sessionId)
    if (!track || track.backgroundOpen === open) return
    track.backgroundOpen = open
    if (track.phase === "running") this.touchAll(false)
  }

  /**
   * An approval: true when a card that can be reached now shows it (fB2), so the caller sends no notification. `send`
   * is that notification; it goes out if the card's push then fails. False: the card shows another approval already,
   * or there is no reachable card — notify as usual.
   */
  armPermission(sessionId: string, request: { id: string; tool: string; detail: string; kind: ToolKind }, send: () => void): boolean {
    const track = this.tracks.get(sessionId)
    if (!track) return false
    track.approval = { requestId: request.id, tool: request.tool, summary: clip(request.detail, SUMMARY_CHARS) }
    track.stepKind = mapKind(request.kind)
    track.stepTool = undefined
    if (track.phase !== "waiting") track.waitingSince = this.now()
    track.phase = "waiting"
    track.lastEventAt = this.now()
    return this.carry(sessionId, request.id, send)
  }

  /** Same for a question (B-3: the card's 「打开作答 ↗」 stands in for the notification; deviation §1203). */
  armQuestion(sessionId: string, request: { id: string; questions: { question: string }[] }, send: () => void): boolean {
    const track = this.tracks.get(sessionId)
    if (!track) return false
    track.question = { requestId: request.id, title: clip(request.questions[0]?.question ?? "", QUESTION_CHARS), count: request.questions.length }
    if (track.phase !== "waiting") track.waitingSince = this.now()
    if (!track.approval) track.phase = "waiting"
    track.lastEventAt = this.now()
    return this.carry(sessionId, request.id, send)
  }

  settle(sessionId: string, requestId: string) {
    this.fallbacks.delete(requestId)
    const track = this.tracks.get(sessionId)
    if (!track) return
    if (track.approval?.requestId === requestId) track.approval = undefined
    if (track.question?.requestId === requestId) track.question = undefined
    // Answered: the agent goes on, so the card shows it running now instead of holding the 等你 rank until the
    // agent's next status (device test 11-08: an answered question kept the card).
    if (track.phase === "waiting" && !track.approval && !track.question) {
      track.phase = "running"
      track.lastEventAt = this.now()
      this.touchAll(true)
    }
  }

  status(sessionId: string, status: "running" | "idle" | "waiting", end?: LiveTurnEnd) {
    const track = this.tracks.get(sessionId)
    if (!track) return
    track.lastEventAt = this.now()
    if (status === "idle") {
      this.finish(track, end ?? { phase: "done" })
      return
    }
    if (status === "waiting") {
      if (!track.approval && !track.question) return
      if (track.phase !== "waiting") track.waitingSince = this.now()
      track.phase = "waiting"
      this.touchAll(true)
      return
    }
    if (track.phase === "running" && !track.approval && !track.question) return
    track.approval = undefined
    track.question = undefined
    track.phase = "running"
    this.touchAll(true)
  }

  /**
   * After a turn ended: true when the card carries its result (fB3), so no done / failed notification. `send` is that
   * notification, sent if the card's push fails.
   */
  takeResult(sessionId: string, send: () => void): boolean {
    const state = this.carried.get(sessionId)
    this.carried.delete(sessionId)
    if (!state) return false
    if (state === "pending") this.fallbacks.set(`result:${sessionId}`, { sessionId, send })
    return true
  }

  forget(sessionId: string) {
    this.tracks.delete(sessionId)
    if (this.follow === sessionId) this.follow = undefined
    this.carried.delete(sessionId)
    for (const [key, fallback] of [...this.fallbacks]) if (fallback.sessionId === sessionId) this.fallbacks.delete(key)
    this.touchAll(true)
  }

  /** A restart cannot resume a turn: every card ends now, and the phone starts a new one with its next message. */
  async abandonAll() {
    if (this.trackPruneTimer) clearTimeout(this.trackPruneTimer)
    this.trackPruneTimer = undefined
    const rows = this.store.listLiveCards()
    if (rows.length === 0) return
    if (this.options.gateway) await Promise.all(rows.map((row) => this.postEnd(row)))
    for (const row of rows) this.drop(row)
  }

  /** Test and debug view: what each card would show now. */
  snapshot(deviceKey: string): Record<string, unknown> | undefined {
    const row = this.store.liveCard(deviceKey)
    const card = this.cards.get(deviceKey)
    if (!row || !card) return undefined
    return this.render(row, card, false)
  }

  // MARK: focus

  private carry(sessionId: string, requestId: string, send: () => void): boolean {
    const rows = this.store.listLiveCards()
    let carried = false
    for (const row of rows) {
      const card = this.card(row.device_key)
      if (!this.deliverable(row, card)) continue
      if (this.focusFor(row, card) === sessionId) carried = true
    }
    if (carried) this.fallbacks.set(requestId, { sessionId, send })
    this.touchAll(true, rows)
    return carried
  }

  private finish(track: Track, end: LiveTurnEnd) {
    const now = this.now()
    track.approval = undefined
    track.question = undefined
    track.endedAt = now
    track.backgroundOpen = 0
    // v115 (replaces deviation §1205, where it left the card): a turn the user stopped stays as 「已中断」, quietly.
    const stopped = end.phase === "interrupted" && !end.silent
    const failed = !stopped && (end.silent || end.phase === "failed")
    track.phase = failed ? "failed" : "done"
    track.stopped = stopped || undefined
    track.reason = end.silent ? { code: "agent_silent" } : stopped ? undefined : end.reason
    track.changes = end.changes
    const text = !stopped && end.result ? firstSentence(end.result.replace(/^Error: /, ""), RESULT_CHARS) : ""
    track.result = text || undefined
    track.resultCopy = failed && !end.silent ? end.copy : undefined
    const rows = this.store.listLiveCards()
    this.pruneTracks(rows)
    if (stopped) {
      this.touchAll(true, rows)
      return
    }
    let carried = false
    for (const row of rows) {
      const card = this.card(row.device_key)
      if (this.deliverable(row, card) && this.focusFor(row, card) === track.sessionId) carried = true
    }
    if (carried) this.carried.set(track.sessionId, "pending")
    this.touchAll(true, rows)
  }

  private candidates(row: LiveCardRow): FocusCandidate[] {
    const now = this.now()
    // v103: the card itself lingers `lingerMs` (at least the phone's shortest choice, 5 minutes); `keep_seconds` is how
    // long the ended card stays on the lock screen (`endAndDrop`).
    const stayMs = Math.min(this.lingerMs, row.keep_seconds * 1000)
    const out: FocusCandidate[] = []
    for (const track of this.tracks.values()) {
      if ((track.phase === "done" || track.phase === "failed") && (track.endedAt ?? 0) + stayMs <= now) continue
      out.push({
        sessionId: track.sessionId,
        phase: track.phase,
        ...(track.phase === "waiting"
          ? { waitingOn: track.approval ? ("approval" as const) : ("question" as const), waitingSince: track.waitingSince }
          : {}),
        lastEventAt: track.lastEventAt,
        seenAt: track.seenAt,
        ...(track.endedAt !== undefined ? { endedAt: track.endedAt } : {}),
      })
    }
    return out
  }

  private focusFor(row: LiveCardRow, card: Card): string | undefined {
    return pickFocus(this.candidates(row), card.focus, this.now(), this.follow, this.holdMs)
  }

  private pruneTracks(rows: readonly LiveCardRow[]) {
    if (this.trackPruneTimer) clearTimeout(this.trackPruneTimer)
    this.trackPruneTimer = undefined
    const now = this.now()
    const keep = rows.reduce((longest, row) => Math.max(longest, row.keep_seconds * 1000),
      this.options.trackKeepMs ?? DEFAULT_KEEP_SECONDS * 1000)
    let next = Infinity
    for (const [id, track] of this.tracks) {
      if (track.phase !== "done" && track.phase !== "failed") continue
      const due = (track.endedAt ?? now) + keep
      if (due <= now) this.tracks.delete(id)
      else next = Math.min(next, due)
    }
    if (next === Infinity) return
    this.trackPruneTimer = setTimeout(() => this.pruneTracks(this.store.listLiveCards()), next - now)
    this.trackPruneTimer.unref?.()
  }

  // MARK: pushing

  private touchAll(urgent: boolean, rows = this.store.listLiveCards()) {
    for (const row of rows) this.schedule(row.device_key, urgent)
    this.considerStarts(rows)
  }

  // MARK: push-to-start (r70 1.2a)

  /**
   * Something runs or waits and a phone that allows it has no card from this computer: start one by push, so a turn
   * begun in the terminal or while the app was killed still shows. One start per phone per busy stretch — rudderd cannot
   * update or end that card until the phone wakes and registers its activity token.
   */
  private considerStarts(rows: readonly LiveCardRow[]) {
    if (!this.options.gateway || this.startRefused) return
    if (!this.busy(DEFAULT_KEEP_SECONDS)) {
      this.startSent.clear()
      for (const key of [...this.startTimers.keys()]) this.cancelStart(key)
      return
    }
    const registered = new Set(rows.map((row) => row.device_key))
    for (const device of this.store.listDevices()) {
      const key = device.session_key
      if (registered.has(key) || this.startSent.has(key) || this.startTimers.has(key) || !this.startable(device, false)) continue
      const timer = setTimeout(() => {
        this.startTimers.delete(key)
        void this.start(key)
      }, this.startDelayMs)
      timer.unref?.()
      this.startTimers.set(key, timer)
    }
  }

  private startable(device: DeviceRow, checkRegistered = true): LiveStart | undefined {
    if (!device.push_token || !isPushTicket(device.push_token)) return undefined
    if (checkRegistered && this.store.liveCard(device.session_key)) return undefined
    return readLiveStart(device.live_start)
  }

  private cancelStart(deviceKey: string) {
    const timer = this.startTimers.get(deviceKey)
    if (timer) clearTimeout(timer)
    this.startTimers.delete(deviceKey)
  }

  private busy(keepSeconds: number): boolean {
    const now = this.now()
    return [...this.tracks.values()].some(
      (track) => (track.phase === "running" || track.phase === "waiting") && !((track.endedAt ?? Number.POSITIVE_INFINITY) + keepSeconds * 1000 <= now),
    )
  }

  private async start(deviceKey: string) {
    const device = this.store.deviceByKey(deviceKey)
    const start = device ? this.startable(device) : undefined
    if (!device || !start || this.startSent.has(deviceKey) || this.startRefused || !this.busy(start.keepSeconds)) return
    const now = this.now()
    const row: LiveCardRow = {
      device_key: deviceKey,
      activity_id: "",
      push_token: start.token,
      keep_seconds: start.keepSeconds,
      locale: start.locale,
      started_at: now,
      focus_session: null,
      state: null,
    }
    const focus = pickFocus(this.candidates(row), undefined, now, this.follow, this.holdMs)
    const track = focus ? this.tracks.get(focus) : undefined
    if (!focus || !track) return
    const card: Card = { seq: 0, focus: { sessionId: focus, since: now }, timer: null, heartbeat: null, dismiss: null, rotate: null, lastSentAt: 0, lastSureAt: now, chain: Promise.resolve(), gen: 0 }
    const contentState = this.render(row, card, true)
    const kind = alertKind(track) ?? "started"
    const alert = () => this.alertFor(start.locale, kind) ?? this.alertFor(start.locale, "started")
    // Clear on the lock screen without the app: only the phone's own id for this pairing, its colour, and a date.
    const attributes: Record<string, unknown> = { accountId: start.accountId, startedAt: swiftSeconds(now) }
    const name = this.options.machineName?.() ?? ""
    if (name) attributes.machineNameSealed = sealLive(deviceKey, clip(name, TITLE_CHARS), { field: "machineName", sessionId: "" })
    if (start.hue !== undefined) attributes.machineHue = start.hue
    const body: Record<string, unknown> = {
      ticket: device.push_token,
      kind: "liveactivity",
      token: start.token,
      priority: 10,
      event: "start",
      attributesType: "RudderComputerAttributes",
      attributes,
      contentState,
      staleDate: Math.floor(now / 1000) + CARD_STALE_SECONDS,
      relevanceScore: relevance(contentState.phase),
      alert: alert(),
    }
    this.startSent.add(deviceKey)
    for (let attempt = 1; attempt <= 2; attempt++) {
      let response: Response
      try {
        response = await this.fetch(`${this.options.gateway}/v1/push`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        })
      } catch (error) {
        if (attempt === 1) continue
        this.startSent.delete(deviceKey)
        this.log(`live-card: device ${deviceKey.slice(0, 8)} start: gateway unreachable: ${error instanceof Error ? error.message : String(error)}`)
        return
      }
      if (response.ok) return
      if (response.status >= 500 && attempt === 1) continue
      const reply = (await response.json().catch(() => ({}))) as { error?: string; reason?: string; message?: string }
      if (this.ladder.refused(response.status, body.alert, reply.message)) {
        body.alert = alert()
        attempt = 0
        continue
      }
      if (response.status === 400 && /event|attributes/.test(reply.message ?? "")) {
        // A gateway older than r70 1.2a: cards start from the phone only, as before.
        this.startRefused = true
        this.log("live-card: the push gateway does not start cards yet; the phone starts them")
        return
      }
      if ((response.status === 410 && reply.reason && BAD_TICKET_REASONS.has(reply.reason)) || (response.status === 400 && reply.error === "bad_ticket")) {
        if (this.store.clearDevicePushToken(device.id, device.push_token!)) this.options.onTicketDropped?.(device, reply.reason ?? reply.error ?? "bad_ticket")
        return
      }
      if (response.status === 410) {
        // The push-to-start token is gone; the phone sends its next one with `device.registerPush`.
        this.store.setDeviceLiveStart(deviceKey, null)
        this.log(`live-card: device ${deviceKey.slice(0, 8)} push-to-start token gone`)
        return
      }
      this.log(`live-card: device ${deviceKey.slice(0, 8)} start failed with ${response.status} ${reply.error ?? ""}`.trimEnd())
      return
    }
  }

  private schedule(deviceKey: string, urgent: boolean) {
    const card = this.card(deviceKey)
    if (urgent) {
      if (card.timer) clearTimeout(card.timer)
      card.timer = null
      this.flush(deviceKey)
      return
    }
    if (card.timer) return
    const since = this.now() - card.lastSentAt
    const wait = Math.max(this.coalesceMs, this.minStepIntervalMs - since)
    card.timer = setTimeout(() => {
      card.timer = null
      this.flush(deviceKey)
    }, Math.max(0, wait))
    card.timer.unref?.()
  }

  private flush(deviceKey: string, reassert = false) {
    const row = this.store.liveCard(deviceKey)
    const card = this.cards.get(deviceKey)
    if (!row || !card) return
    const now = this.now()
    const candidates = this.candidates(row)
    const focus = pickFocus(candidates, card.focus, now, this.follow, this.holdMs)
    if (!focus) {
      // A card registered just before its turn starts waits a moment for it instead of ending unseen.
      const grace = row.started_at + REGISTER_GRACE_MS - now
      if (card.seq === 0 && grace > 0) {
        card.timer = setTimeout(() => {
          card.timer = null
          this.flush(deviceKey)
        }, grace)
        card.timer.unref?.()
        return
      }
      // Nothing to show: every session finished past its stay, or the shown one was stopped.
      void this.endAndDrop(row, this.lockDismissal(row))
      return
    }
    if (card.focus?.sessionId !== focus) card.focus = { sessionId: focus, since: now }
    const busy = candidates.some((candidate) => candidate.phase === "running" || candidate.phase === "waiting")
    const track = this.tracks.get(focus)!
    const key = alertKey(track)
    const alert = key !== undefined && key !== card.alerted
    if (alert) card.alerted = key
    const state = this.render(row, card, true, candidates)
    card.lastSentAt = now
    this.armDismiss(row, card, track, busy)
    const kind: AlertKind | undefined = alert ? alertKind(track) : undefined
    const urgent = state.approval !== undefined || state.question !== undefined
    void this.enqueue(card, { row, state, forceSure: alert || reassert, kind, focus, gen: card.gen, busy, urgent })
  }

  /**
   * fB3 / v103: the shown turn ended. With nothing else running the island's stay (`lingerMs`) ends the card; beside
   * running work its 做完 (or failure) holds `holdMs`, then the card looks again and follows the running one.
   */
  private armDismiss(row: LiveCardRow, card: Card, shown: Track, busy: boolean) {
    if (card.dismiss) clearTimeout(card.dismiss)
    card.dismiss = null
    if (shown.endedAt === undefined || (shown.phase !== "done" && shown.phase !== "failed")) return
    const stay = busy ? this.holdMs : Math.min(this.lingerMs, row.keep_seconds * 1000)
    const due = shown.endedAt + stay - this.now()
    card.dismiss = setTimeout(() => {
      card.dismiss = null
      this.schedule(row.device_key, true)
    }, Math.max(0, due))
    card.dismiss.unref?.()
  }

  private armHeartbeat(deviceKey: string, busy: boolean) {
    const card = this.cards.get(deviceKey)
    const row = this.store.liveCard(deviceKey)
    if (!card || !row) return
    if (card.heartbeat) clearTimeout(card.heartbeat)
    card.heartbeat = null
    if (!busy) return
    card.heartbeat = setTimeout(() => {
      card.heartbeat = null
      this.schedule(deviceKey, false)
    }, this.heartbeatMs)
    card.heartbeat.unref?.()
  }

  private armRetry(row: LiveCardRow, retryAfter: string | null = null) {
    const card = this.cards.get(row.device_key)
    if (!card || !this.holds(row)) return
    if (card.heartbeat) clearTimeout(card.heartbeat)
    card.heartbeat = null
    if (card.retryTimer) clearTimeout(card.retryTimer)
    const failures = (card.retryFailures ?? 0) + 1
    card.retryFailures = failures
    const base = Math.min(this.retryMs * 2 ** Math.min(failures - 1, 3), 120_000)
    const local = Math.ceil(base * (1 + 0.2 * (this.options.random ?? Math.random)()))
    const after = retryAfter?.trim()
    const now = this.now()
    const server = after ? (/^\d+$/.test(after) ? Number(after) * 1000 : Date.parse(after) - now) : 0
    const due = now + Math.max(local, Number.isFinite(server) ? server : 0)
    const generation = card.gen
    const retry = (remaining: number) => {
      card.retryTimer = setTimeout(() => {
        card.retryTimer = undefined
        if (card.gen !== generation || !this.holds(row)) return
        if (remaining > 2_147_483_647) {
          retry(due - this.now())
          return
        }
        // Render once again to reflect ongoing work and to give APNs a fresh stale date.
        const queued = card.pending !== undefined
        this.flush(row.device_key)
        if (queued && card.pending && !card.inflight && card.gen === generation) card.chain = this.drain(card)
      }, Math.max(0, Math.min(remaining, 2_147_483_647)))
      card.retryTimer.unref?.()
    }
    retry(due - now)
  }

  private render(row: LiveCardRow, card: Card, advance: boolean, preparedCandidates?: FocusCandidate[]): Record<string, unknown> {
    const now = this.now()
    const focus = card.focus?.sessionId
    const track = focus ? this.tracks.get(focus) : undefined
    const state: Record<string, unknown> = { seq: advance ? ++card.seq : card.seq, updatedAt: swiftSeconds(now) }
    if (!track) return { ...state, phase: "done", sessionId: "", toolCount: 0 }
    // Bound to the field, the session and the request it describes: the gateway cannot move it to another.
    const seal = (text: string, field: LiveField, requestId = "", sessionId = track.sessionId) =>
      sealLive(row.device_key, text, { field, sessionId, requestId })
    const session = this.store.getSession(track.sessionId)
    const phase: CardPhase = track.stopped ? "interrupted" : track.phase === "interrupted" ? "done" : track.phase
    state.sessionId = track.sessionId
    state.phase = phase
    state.toolCount = track.toolCount
    state.turnStartedAt = swiftSeconds(track.turnStartedAt)
    const label = session ? this.options.agentLabel?.(session.agent) : undefined
    // Sealed like every other word on the card: the gateway and APNs see only enum words and numbers (r59 F-10).
    if (label) state.agentSealed = seal(label, "agent")
    const title = clip(session ? cardTitle(session, row.locale) : "", TITLE_CHARS)
    if (title) state.titleSealed = seal(title, "title")
    // v103 line 2: 「项目 · agent · 电脑」. The project is the folder the session runs in.
    const project = session?.cwd ? clip(basename(session.cwd), PROJECT_CHARS) : ""
    if (project) state.projectSealed = seal(project, "project")
    // v103 「1/3」: only with more than one session on the card (older apps read none of these).
    const candidates = preparedCandidates ?? this.candidates(row)
    const where = positionOf(candidates, track.sessionId)
    if (where && where.total > 1) {
      state.position = where.position
      state.total = Math.min(50, where.total)
    }
    const prompt = track.continuation ? continueNotice(appLocale(row.locale)) : track.prompt
    if (prompt) state.promptSealed = seal(prompt, "prompt")
    if (track.stepKind) state.stepKind = track.stepKind
    // A word the gateway passes untouched and an older app ignores (it keeps 「正在使用」 with the short description).
    if (track.stepTool) state.stepTool = track.stepTool
    if (track.stepPlain) state.stepSealed = seal(track.stepPlain, "step")
    if (track.stepStartedAt !== undefined) state.stepStartedAt = swiftSeconds(track.stepStartedAt)
    if (phase === "running" && track.backgroundOpen > 0) state.backgroundOpen = track.backgroundOpen
    if ((phase === "running" || phase === "waiting") && track.plan) {
      state.planIndex = track.plan.index
      state.planTotal = track.plan.total
      if (track.plan.item) state.planSealed = seal(track.plan.item, "plan")
    }
    if (phase === "waiting" && track.approval) {
      // `toolName` stays "": the name travels sealed (r59 F-10), and the gateway checks it.
      const approval: Record<string, unknown> = { requestId: track.approval.requestId, toolName: "" }
      // Always sealed, even empty: the phone shows 批准 only once a field bound to this requestId opens.
      approval.toolSealed = seal(track.approval.tool, "approval.tool", track.approval.requestId)
      if (track.approval.summary) approval.summarySealed = seal(track.approval.summary, "approval.summary", track.approval.requestId)
      state.approval = approval
    }
    if (phase === "waiting" && track.question) {
      const question: Record<string, unknown> = { requestId: track.question.requestId, count: Math.max(1, Math.min(20, track.question.count)) }
      if (track.question.title) question.titleSealed = seal(track.question.title, "question.title", track.question.requestId)
      state.question = question
    }
    if (phase === "done" || phase === "failed" || phase === "interrupted") {
      if (track.endedAt !== undefined) {
        state.endedAt = swiftSeconds(track.endedAt)
        // When the card leaves the lock screen (the island goes after `lingerMs`).
        state.dismissAt = swiftSeconds(track.endedAt + Math.max(row.keep_seconds * 1000, this.lingerMs))
      }
      if (track.result) state.resultSealed = seal(track.result, "result")
      // Older apps read only `resultSealed`. A copy too long for the card's push budget stays rudderd's text.
      const copy = phase === "failed" && track.resultCopy ? JSON.stringify(track.resultCopy) : ""
      if (copy && copy.length <= RESULT_COPY_CHARS) state.resultCopySealed = seal(copy, "resultCopy")
      if (track.changes) state.changes = { added: track.changes.added, removed: track.changes.removed, files: track.changes.files }
      if (phase === "failed" && track.reason) state.reasonSealed = seal(JSON.stringify(track.reason), "reason")
    }
    const others = othersOf(candidates, focus, !this.waitRefused)
    if (others.count > 0) {
      const titleOf = (id: string) => {
        const other = this.store.getSession(id)
        return other ? cardTitle(other, row.locale) : ""
      }
      const names = others.sessionIds.map((id) => clip(titleOf(id), 24)).filter((name) => name !== "")
      const out: Record<string, unknown> = {
        count: Math.min(50, others.count),
        waiting: Math.min(50, others.waiting),
        ...(names.length > 0 ? { titleSealed: seal(names.join(" · "), "others.title") } : {}),
      }
      if (others.wait) {
        const waitTitle = clip(titleOf(others.wait.sessionId), 24)
        out.wait = { ...others.wait, ...(waitTitle ? { titleSealed: seal(waitTitle, "others.wait.title", "", others.wait.sessionId) } : {}) }
      }
      state.others = out
    }
    return state
  }

  /**
   * One post in flight per card, at most one frame behind it, so a slow gateway costs one wait, not a queue of them.
   * An approval or question does not wait at all: it aborts a plain frame's post and goes next. Sending it beside
   * that post instead could let the older frame reach the gateway second, take the newer APNs `timestamp` and
   * cover the approval on the phone.
   */
  private enqueue(card: Card, frame: Frame): Promise<void> {
    const older = card.pending
    if (older?.kind && !frame.kind && older.focus === frame.focus && older.state.phase === frame.state.phase) {
      // The replaced frame was the one to sound; the newer copy of the same moment sounds instead.
      frame.kind = older.kind
      frame.forceSure = true
    }
    if (older?.cutShort) frame.cutShort = true
    card.pending = frame
    if (frame.urgent && card.inflight && !card.inflight.urgent) {
      card.inflight.abort.abort()
      frame.cutShort = true
    }
    if (!card.inflight && !older && !card.retryTimer) card.chain = this.drain(card)
    return card.chain
  }

  private async drain(card: Card) {
    await undefined
    for (let frame = card.pending; frame && !card.retryTimer; frame = card.pending) {
      card.pending = undefined
      if (card.gen !== frame.gen || !this.holds(frame.row)) continue
      const abort = new AbortController()
      card.inflight = { urgent: frame.urgent, abort }
      const before = card.sent
      const asked = requestOf(frame.state)
      const cleared = card.asked !== undefined && card.asked !== asked
      const priority = frame.forceSure || cleared || this.now() - card.lastSureAt >= this.sureMs ? 10 : 5
      // An aborted update can still reach the phone, so a subsequent clearing frame must be sure.
      card.asked ??= asked
      try {
        await this.post(frame.row, "update", frame.state, priority, frame.kind, undefined, frame.focus, abort.signal)
      } catch {
        // `post` reports its own failures.
      } finally {
        card.inflight = undefined
      }
      if (card.sent !== before && frame.gen === card.gen) {
        card.asked = asked
        this.armHeartbeat(frame.row.device_key, frame.busy)
        if (frame.cutShort) this.armReassert(card, frame)
      }
    }
  }

  /**
   * The aborted post may already be on its way and reach the gateway after the approval, taking the newer APNs
   * timestamp. Send the waiting state once more, unless something newer went out or the wait is over.
   */
  private armReassert(card: Card, frame: Frame) {
    if (card.reassert) clearTimeout(card.reassert)
    const sent = card.sent
    const request = requestOf(frame.state)
    card.reassert = setTimeout(() => {
      card.reassert = null
      if (card.gen !== frame.gen || card.sent !== sent || card.pending || card.inflight) return
      const track = this.tracks.get(frame.focus)
      if (card.focus?.sessionId !== frame.focus || track?.phase !== "waiting") return
      if ((track.approval?.requestId ?? track.question?.requestId) !== request) return
      this.flush(frame.row.device_key, true)
    }, this.reassertMs)
    card.reassert.unref?.()
  }

  private async endAndDrop(row: LiveCardRow, dismissal?: number) {
    const card = this.cards.get(row.device_key)
    if (card) {
      card.gen += 1
      await card.chain
    }
    if (!this.holds(row)) return
    await this.postEnd(row, dismissal)
    this.drop(row)
  }

  /**
   * v103: the island goes after `lingerMs`, but the last result stays on the lock screen for the phone's 「做完后留在锁屏」
   * (`keep_seconds`, 15 minutes by default) — unless nothing finished is left to show (a stopped turn).
   */
  private lockDismissal(row: LiveCardRow): number | undefined {
    const now = this.now()
    let last: number | undefined
    for (const track of this.tracks.values()) {
      if ((track.phase === "done" || track.phase === "failed") && track.endedAt !== undefined) last = Math.max(last ?? 0, track.endedAt)
    }
    if (last === undefined) return undefined
    const until = last + row.keep_seconds * 1000
    return until > now ? until : undefined
  }

  private async postEnd(row: LiveCardRow, dismissal?: number) {
    const card = this.cards.get(row.device_key)
    const state = card && this.holds(row) ? this.render(row, card, true) : { phase: "done", seq: 1_000_000, sessionId: "", toolCount: 0 }
    const until = dismissal ?? this.now()
    state.dismissAt = swiftSeconds(until)
    await this.post(row, "end", state, 10, undefined, Math.floor(until / 1000), undefined)
  }

  private holds(row: LiveCardRow): boolean {
    return this.store.liveCard(row.device_key)?.push_token === row.push_token
  }

  private deliverable(row: LiveCardRow, card: Card): boolean {
    if (!this.options.gateway) return false
    const ticket = this.store.deviceByKey(row.device_key)?.push_token
    if (!ticket || !isPushTicket(ticket)) return false
    return card.failure === undefined
  }

  private async post(
    row: LiveCardRow,
    event: "update" | "end",
    contentState: Record<string, unknown>,
    priority: 5 | 10,
    alertKindValue: AlertKind | undefined,
    dismissalDate: number | undefined,
    focus: string | undefined,
    superseded?: AbortSignal,
  ) {
    if (!this.options.gateway) return
    const device = this.store.deviceByKey(row.device_key)
    const ticket = device?.push_token
    if (!device || !ticket || !isPushTicket(ticket)) {
      this.failed(row, "has no gateway ticket; not pushed")
      return
    }
    const alert = alertKindValue ? this.alertText(row, alertKindValue) : undefined
    const others = contentState.others as Record<string, unknown> | undefined
    // Frames rendered before the refusal came back are still queued with the line.
    if (this.waitRefused) delete others?.wait
    const body: Record<string, unknown> = {
      ticket,
      kind: "liveactivity",
      token: row.push_token,
      priority,
      event,
      contentState,
      staleDate: Math.floor(this.now() / 1000) + CARD_STALE_SECONDS,
      relevanceScore: relevance(contentState.phase),
    }
    if (dismissalDate !== undefined) body.dismissalDate = dismissalDate
    if (alert) body.alert = alert
    const timeout = () => AbortSignal.timeout(this.requestTimeoutMs)
    for (let attempt = 1; attempt <= 2; attempt++) {
      // A newer frame took this one's place (`enqueue`): not a failure, nothing to retry or fall back to.
      if (superseded?.aborted) return
      let response: Response
      try {
        response = await this.fetch(`${this.options.gateway}/v1/push`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: superseded ? AbortSignal.any([timeout(), superseded]) : timeout(),
        })
      } catch (error) {
        if (superseded?.aborted) return
        if (event === "end" && attempt === 1) continue
        this.failed(row, `gateway unreachable: ${error instanceof Error ? error.message : String(error)}`)
        if (event === "update") this.armRetry(row)
        return
      }
      if (response.ok) {
        this.posted(row, event, focus, priority)
        return
      }
      if (event === "end" && response.status >= 500 && attempt === 1) continue
      const reply = (await response.json().catch(() => ({}))) as { error?: string; reason?: string; message?: string }
      if (alertKindValue && this.ladder.refused(response.status, body.alert, reply.message)) {
        const plain = this.alertText(row, alertKindValue)
        if (plain) body.alert = plain
        else delete body.alert
        attempt = 0
        continue
      }
      if (response.status === 400 && body.alert && alertKindValue === "question" && /alert/.test(reply.message ?? "")) {
        // A gateway older than B-4 knows no 等你回答 alert: show the question silently rather than not at all.
        this.questionAlertRefused = true
        delete body.alert
        attempt = 0
        continue
      }
      if (response.status === 400 && others?.wait !== undefined && /others/.test(reply.message ?? "")) {
        // A gateway older than v79 knows no `others.wait`: the card keeps its counts, only the 在等你 line goes.
        this.waitRefused = true
        delete others.wait
        attempt = 0
        continue
      }
      if ((response.status === 410 && reply.reason && BAD_TICKET_REASONS.has(reply.reason)) || (response.status === 400 && reply.error === "bad_ticket")) {
        if (this.store.clearDevicePushToken(device.id, ticket)) this.options.onTicketDropped?.(device, reply.reason ?? reply.error ?? "bad_ticket")
        this.failed(row, `push failed with ${response.status} ${reply.reason ?? reply.error ?? ""}; ticket dropped`.trimEnd())
        return
      }
      if (response.status === 410) {
        // The phone ended the card (or the gateway predates r68 0-4 and says no more): drop the row, stop the beat.
        this.failed(row, `push failed with 410 ${reply.reason ?? ""}; card gone`.trimEnd())
        if (event === "update") this.drop(row)
        return
      }
      this.failed(row, `push failed with ${response.status} ${reply.error ?? ""}`.trimEnd())
      if (event === "update" && (response.status === 429 || response.status >= 500)) this.armRetry(row, response.headers.get("Retry-After"))
      return
    }
  }

  private posted(row: LiveCardRow, event: "update" | "end", focus: string | undefined, priority: 5 | 10) {
    if (!this.holds(row)) return
    const card = this.cards.get(row.device_key)
    if (!card) return
    card.failure = undefined
    if (event === "end") return
    card.retryFailures = 0
    if (priority === 10) card.lastSureAt = this.now()
    card.sent = (card.sent ?? 0) + 1
    this.store.noteLiveCard(row.device_key, row.push_token, focus ?? null, null)
    for (const [key, fallback] of [...this.fallbacks]) {
      if (fallback.sessionId === focus) this.fallbacks.delete(key)
    }
    if (focus && this.carried.get(focus) === "pending") this.carried.set(focus, "ok")
  }

  /** Logs on a change only, and sends every notification a card stood in for. */
  private failed(row: LiveCardRow, what: string) {
    if (!this.holds(row)) return
    const card = this.cards.get(row.device_key)
    if (card) {
      if (card.failure !== what) this.log(`live-card: device ${row.device_key.slice(0, 8)} ${what}`)
      card.failure = what
    }
    for (const [key, fallback] of [...this.fallbacks]) {
      this.fallbacks.delete(key)
      fallback.send()
    }
    for (const [id, state] of [...this.carried]) if (state === "pending") this.carried.delete(id)
  }

  private alertText(row: LiveCardRow, kind: AlertKind): LiveAlert | undefined {
    return this.alertFor(row.locale, kind)
  }

  /**
   * Fixed texts only: the alert crosses Cloudflare and APNs in the clear (r59 F-10). Sent as the Chinese pair in
   * `titleKey` / `bodyKey`, which the phone translates from the app's catalog into its own language; an older
   * gateway gets plain text (`AlertLadder`).
   */
  private alertFor(locale: string, kind: AlertKind | "started"): LiveAlert | undefined {
    if (kind === "question" && this.questionAlertRefused) return undefined
    return this.ladder.alert(locale, kind)
  }

  // MARK: bookkeeping

  private track(sessionId: string, create: boolean): Track | undefined {
    let track = this.tracks.get(sessionId)
    if (!track && create) {
      const now = this.now()
      track = { sessionId, phase: "running", turnStartedAt: now, lastEventAt: now, seenAt: now, toolCount: 0, started: new Set(), completed: new Set(), backgroundOpen: 0 }
      this.tracks.set(sessionId, track)
    }
    return track
  }

  private card(deviceKey: string): Card {
    let card = this.cards.get(deviceKey)
    if (!card) {
      card = { seq: 0, timer: null, heartbeat: null, dismiss: null, rotate: null, lastSentAt: 0, lastSureAt: this.now(), chain: Promise.resolve(), gen: 0 }
      this.cards.set(deviceKey, card)
    }
    return card
  }

  private resetCard(deviceKey: string) {
    this.clearTimers(deviceKey)
    this.cards.delete(deviceKey)
    this.card(deviceKey)
  }

  private clearTimers(deviceKey: string) {
    const card = this.cards.get(deviceKey)
    if (!card) return
    card.gen += 1
    for (const timer of [card.timer, card.heartbeat, card.dismiss, card.rotate, card.reassert, card.retryTimer]) if (timer) clearTimeout(timer)
    card.timer = card.heartbeat = card.dismiss = card.rotate = card.reassert = null
    card.retryTimer = undefined
  }

  private drop(row: LiveCardRow) {
    if (!this.holds(row)) return
    this.store.deleteLiveCard(row.device_key, row.push_token)
    this.clearTimers(row.device_key)
    this.cards.delete(row.device_key)
    if (this.trackPruneTimer) this.pruneTracks(this.store.listLiveCards())
  }

  private armRotate(deviceKey: string) {
    const row = this.store.liveCard(deviceKey)
    const card = this.cards.get(deviceKey)
    if (!row || !card) return
    if (card.rotate) clearTimeout(card.rotate)
    card.rotate = setTimeout(() => {
      card.rotate = null
      void this.rotate(row)
    }, Math.max(0, row.started_at + this.rotateAfterMs - this.now()))
    card.rotate.unref?.()
  }

  private async rotate(row: LiveCardRow) {
    if (!this.holds(row)) return
    await this.postEnd(row)
    this.drop(row)
    this.options.onRotate?.(row.device_key)
  }
}

type AlertKind = "waiting" | "question" | "done" | "failed"

/** The approval's or question's id a rendered state carries (`render` puts the approval first). */
function requestOf(state: Record<string, unknown>): string | undefined {
  const approval = state.approval as { requestId?: string } | undefined
  const question = state.question as { requestId?: string } | undefined
  return approval?.requestId ?? question?.requestId
}

/** `device.registerPush`'s `liveStart`: `{token, accountId, hue?, locale?, keepSeconds?}`. Throws `invalid`. */
export function parseLiveStart(value: unknown): LiveStart {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("liveStart must be an object or null", "invalid")
  const input = value as Record<string, unknown>
  if (typeof input.token !== "string" || !ACTIVITY_TOKEN.test(input.token)) fail("liveStart.token must be 32–400 hex characters", "invalid")
  if (typeof input.accountId !== "string" || !ACCOUNT_ID.test(input.accountId)) fail("liveStart.accountId must be 1–128 printable ASCII characters", "invalid")
  const hue = input.hue
  if (hue !== undefined && hue !== null && (typeof hue !== "number" || !Number.isInteger(hue) || hue < 0 || hue > 359)) {
    fail("liveStart.hue must be an integer 0–359", "invalid")
  }
  const keep = typeof input.keepSeconds === "number" && KEEP_CHOICES.has(input.keepSeconds) ? input.keepSeconds : DEFAULT_KEEP_SECONDS
  return {
    token: input.token,
    accountId: input.accountId,
    ...(typeof hue === "number" ? { hue } : {}),
    // The app language (`language`, newer phones) before the zh / en pair every phone sends.
    locale: appLocale(typeof input.language === "string" && input.language ? input.language : input.locale),
    keepSeconds: keep,
  }
}

function readLiveStart(json: string | null | undefined): LiveStart | undefined {
  if (!json) return undefined
  try {
    return parseLiveStart(JSON.parse(json))
  } catch {
    return undefined
  }
}

function alertKey(track: Track): string | undefined {
  if (track.stopped) return undefined
  if (track.phase === "waiting") return `${track.sessionId}:${track.approval?.requestId ?? track.question?.requestId ?? ""}`
  if (track.phase === "done" || track.phase === "failed") return `${track.sessionId}:${track.phase}:${track.endedAt ?? 0}`
  return undefined
}

function alertKind(track: Track): AlertKind | undefined {
  if (track.stopped) return undefined
  if (track.phase === "waiting") return track.approval ? "waiting" : "question"
  if (track.phase === "done" || track.phase === "failed") return track.phase
  return undefined
}

function relevance(phase: unknown): number {
  if (phase === "waiting") return 100
  if (phase === "failed") return 80
  if (phase === "running") return 50
  return 20
}

function swiftSeconds(ms: number): number {
  return ms / 1000 - SWIFT_REFERENCE_UNIX
}

function mapKind(kind: ToolKind): string {
  if (kind === "execute") return "bash"
  if (kind === "fetch") return "web"
  return kind
}

/** The title the card shows: a command-named session's (v112 ③) in the card's language, else the stored one. */
function cardTitle(session: { title: string; auto_title?: number; title_command?: string | null }, locale: string): string {
  if (session.auto_title === AUTO_TITLE_COMMAND && session.title_command) return commandTitle(session.title_command, appLocale(locale))
  return session.title
}

function clip(text: string, maxChars: number): string {
  const chars = [...text]
  return chars.length <= maxChars ? text : `${chars.slice(0, Math.max(0, maxChars - 1)).join("")}…`
}

function fail(message: string, code: string): never {
  throw Object.assign(new Error(message), { code })
}

// The phone's v94 notice row 「后台任务做完，Agent 会主动汇报」 (ios/App/Localizable.xcstrings), for the card's prompt line.
const CONTINUE_NOTICE: Record<AppLocale, string> = {
  "zh-Hans": "后台任务做完，Agent 会主动汇报",
  "zh-Hant": "背景任務做完，Agent 會主動回報",
  en: "Background work done, agent reports back",
  de: "Hintergrundarbeit erledigt, Agent meldet sich",
  fr: "Tâche d’arrière-plan terminée, l’agent fait le point",
  ja: "バックグラウンドの作業が完了、エージェントが報告します",
  ko: "백그라운드 작업 완료, 에이전트가 알려 드립니다",
  "es-419": "Trabajo en segundo plano listo, el agente informa",
}

export function continueNotice(locale: AppLocale): string {
  return CONTINUE_NOTICE[locale]
}
