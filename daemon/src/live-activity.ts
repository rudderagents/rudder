import { isSubagentTool, subagentStep } from "./session-title"
import type { PhoneCopy } from "./phone-copy"
import { appLocale } from "./app-locale"
import { AlertLadder, type LiveAlert, liveAlertKind } from "./live-alerts"
import type { ToolKind, ToolStatus } from "./adapter/types"
import { BAD_TICKET_REASONS, firstSentence as cardSentence, GATEWAY_TIMEOUT_MS, isPushTicket, type PushChanges, type LiveField, type PushReason, sealLive } from "./push"
import type { DeviceRow, LiveActivityRow, Store } from "./store"

/** The only Live Activity alert texts; push-gateway/src/index.ts accepts exactly these (keep the two lists equal). */

/** A fixed alert as sent: plain text, or the Chinese pair as keys the phone looks up in the app's catalog. */
export type LiveActivityAlert = LiveAlert

/** Unix seconds of 2001-01-01. `content-state` dates are unix seconds minus this; APNs header dates are not. */
export const SWIFT_REFERENCE_UNIX = 978_307_200
const KEEP_CHOICES = new Set([300, 900, 3600, 14400])
const DEFAULT_KEEP_SECONDS = 900
const STALE_SECONDS = 5 * 60
// A beat inside the 5-minute stale window, so a long command does not look disconnected.
const HEARTBEAT_MS = 240_000
// The expanded alert is an update. End has no alert, so it follows once the alert has been seen.
const END_AFTER_ALERT_MS = 4000
const ROTATE_AFTER_MS = (7 * 60 + 50) * 60 * 1000
const ACTIVITY_TOKEN = /^[0-9a-fA-F]{32,400}$/
const STEP_CHARS = 80
const SUMMARY_CHARS = 120
const RESULT_CHARS = 80
/** The longest result copy (JSON) a card carries; the content-state shares APNs' 4 KB with everything else. */
export const RESULT_COPY_CHARS = 600
const QUESTION_CHARS = 80

export type LiveTurnEnd = {
  phase: "done" | "failed" | "interrupted"
  result?: string
  /** why the turn failed (r48) and what it changed (r47), for the per-computer card. */
  reason?: PushReason
  changes?: PushChanges
  /** The r66 guard stopped a silent agent: the card tells it as a failure, like the notification. */
  silent?: boolean
  /** A failed turn's `result` as phone copy, so the card words it in the phone's language like the notification. */
  copy?: PhoneCopy
}

type Phase = "running" | "waiting" | "done" | "failed" | "interrupted"

/** A finished turn's line for the card, and a failure's copy as JSON (`resultCopySealed`, as on the per-computer card). */
type CardResult = { result: string; copy?: string }

type Volatile = {
  seq: number
  phase: Phase
  stepKind?: string
  /** 11-19: 「agent」 while the step waits on a sub-agent (live-card.ts `Track.stepTool`). */
  stepTool?: "agent"
  stepPlain?: string
  toolCount: number
  // v65 B5: the speech has paused on this many background tasks; the card stays 正在做 and names them as the step.
  backgroundOpen: number
  started: Set<string>
  completed: Set<string>
  tokens: number
  approval?: { requestId: string; toolSealed?: string; summarySealed?: string }
  // r68 0-3: the permission notification held back while the card shows the approval, sent if the card cannot be reached.
  fallback?: { requestId: string; send: () => void }
  question?: { requestId: string; titleSealed?: string; count: number }
  lastStepSentAt: number
  stepTimer: ReturnType<typeof setTimeout> | null
  stepGen: number
  rotateTimer: ReturnType<typeof setTimeout> | null
  heartbeatTimer: ReturnType<typeof setTimeout> | null
  lastPostAt: number
}

export type LiveActivityOptions = {
  gateway: string | null
  fetch?: typeof fetch
  coalesceMs?: number
  minStepIntervalMs?: number
  rotateAfterMs?: number
  heartbeatMs?: number
  endAfterAlertMs?: number
  requestTimeoutMs?: number
  log?: (line: string) => void
  onRotate?: (sessionId: string) => void
  /** The gateway refused the device's ticket on a card push and it was cleared (same as `PushNotifier.onTicketDropped`). */
  onTicketDropped?: (device: DeviceRow, reason: string) => void
}

type RegisterInput = {
  sessionId: string
  activityId: string
  pushToken: string
  keepSeconds: number
  locale: string
  deviceKey: string | undefined
}

/**
 * One Live Activity per session. Step updates coalesce; waiting / done / failed go out at once.
 * With no gateway (or no device ticket) the row is stored and nothing is posted: the phone writes the island itself.
 */
export class LiveActivityNotifier {
  /** The deployed gateway may predate keyed alerts; after one refusal, alerts go as plain text until restart. */
  private readonly ladder: AlertLadder
  private readonly fetch: typeof fetch
  private readonly coalesceMs: number
  private readonly minStepIntervalMs: number
  private readonly rotateAfterMs: number
  private readonly heartbeatMs: number
  private readonly endAfterAlertMs: number
  private readonly requestTimeoutMs: number
  private readonly log: (line: string) => void
  private readonly volatile = new Map<string, Volatile>()
  // Per session, the last failure logged. A card that cannot be pushed logs once per change, not once per step.
  private readonly lastFailure = new Map<string, string>()

  constructor(
    private readonly store: Store,
    private readonly options: LiveActivityOptions,
  ) {
    this.fetch = options.fetch ?? fetch
    this.requestTimeoutMs = options.requestTimeoutMs ?? GATEWAY_TIMEOUT_MS
    this.coalesceMs = options.coalesceMs ?? 1000
    this.minStepIntervalMs = options.minStepIntervalMs ?? 2000
    this.rotateAfterMs = options.rotateAfterMs ?? ROTATE_AFTER_MS
    this.heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS
    this.endAfterAlertMs = options.endAfterAlertMs ?? END_AFTER_ALERT_MS
    this.log = options.log ?? ((line) => console.warn(line))
    this.ladder = new AlertLadder((line) => this.log(`live-activity: ${line}`))
  }

  covers(sessionId: string): boolean {
    return this.store.liveActivity(sessionId) !== null
  }

  /**
   * The card can carry this session's approval: a row, a gateway, a ticket for its device, and the last push to it
   * did not fail. Otherwise the permission notification goes out as well (r68 0-3).
   */
  deliverable(sessionId: string): boolean {
    const row = this.store.liveActivity(sessionId)
    if (!row || !this.options.gateway || !this.volatile.has(sessionId)) return false
    const ticket = this.store.deviceByKey(row.device_key)?.push_token
    if (!ticket || !isPushTicket(ticket)) return false
    return !this.lastFailure.has(sessionId)
  }

  register(input: RegisterInput): { ok: true } {
    if (!input.deviceKey) fail("device key required", "unauthorized")
    const session = this.store.getSession(input.sessionId)
    if (!session) fail("session not found", "not_found")
    if (!ACTIVITY_TOKEN.test(input.pushToken)) fail("pushToken must be 32–400 hex characters", "invalid")
    if (!input.activityId) fail("activityId required", "invalid")
    const keep = KEEP_CHOICES.has(input.keepSeconds) ? input.keepSeconds : DEFAULT_KEEP_SECONDS
    const locale = appLocale(input.locale)
    const previous = this.store.liveActivity(input.sessionId)
    const row: LiveActivityRow = {
      session_id: input.sessionId,
      activity_id: input.activityId,
      push_token: input.pushToken,
      device_key: input.deviceKey,
      keep_seconds: keep,
      locale,
      started_at: previous?.push_token === input.pushToken ? previous.started_at : Date.now(),
    }
    this.store.putLiveActivity(row)
    if (!previous || previous.push_token !== input.pushToken) {
      this.resetVolatile(input.sessionId)
      this.lastFailure.delete(input.sessionId)
    }
    if (previous && previous.push_token !== input.pushToken) void this.pushEnd(previous, "interrupted", true)
    this.armRotate(input.sessionId)
    // The phone's card goes stale 5 minutes after it was requested. A first command that runs longer than that
    // posts nothing, so the beat starts here rather than after the first successful push.
    this.armHeartbeat(input.sessionId)
    return { ok: true }
  }

  async end(activityId: string): Promise<{ ok: true }> {
    const row = this.store.liveActivityByActivity(activityId)
    if (!row) return { ok: true }
    await this.pushEnd(row, "interrupted", true)
    this.store.deleteLiveActivity(row.session_id)
    this.dropVolatile(row.session_id)
    return { ok: true }
  }

  /** The session is being deleted: end its card on the phone now (while the title can still be read) and drop the timers. */
  forget(sessionId: string) {
    const row = this.store.liveActivity(sessionId)
    this.dropVolatile(sessionId)
    if (!row) return
    void this.pushEnd(row, "interrupted", true)
    this.store.deleteLiveActivity(sessionId)
  }

  /** `fallback` sends the permission notification; it runs once if a push to this card fails before the answer. */
  armPermission(sessionId: string, request: { id: string; tool: string; detail: string; kind: ToolKind }, fallback?: () => void) {
    const vol = this.volatile.get(sessionId)
    const row = this.store.liveActivity(sessionId)
    if (!vol || !row) {
      fallback?.()
      return
    }
    vol.fallback = fallback ? { requestId: request.id, send: fallback } : undefined
    const summary = clip(request.detail, SUMMARY_CHARS)
    vol.approval = {
      requestId: request.id,
      // Sealed like the command line: MCP tool names (`mcp__gmail__send`) say which services the owner uses (r59 F-10).
      // Bound to this request: the gateway cannot pair an old command with a current id. The tool is
      // always sealed, even empty, because the phone shows 批准 only once a field bound to this requestId opens.
      toolSealed: this.seal(row, request.tool, "approval.tool", request.id),
      summarySealed: summary ? this.seal(row, summary, "approval.summary", request.id) : undefined,
    }
    vol.stepKind = mapKind(request.kind)
    vol.stepTool = undefined
  }

  armQuestion(sessionId: string, request: { id: string; questions: { question: string }[] }) {
    const vol = this.volatile.get(sessionId)
    const row = this.store.liveActivity(sessionId)
    if (!vol || !row) return
    const title = clip(request.questions[0]?.question ?? "", QUESTION_CHARS)
    vol.question = {
      requestId: request.id,
      titleSealed: title ? this.seal(row, title, "question.title", request.id) : undefined,
      count: request.questions.length,
    }
  }

  /** A request was answered or withdrawn. The status call that follows decides whether the card still waits. */
  settle(sessionId: string, requestId: string) {
    const vol = this.volatile.get(sessionId)
    if (!vol) return
    if (vol.approval?.requestId === requestId) vol.approval = undefined
    if (vol.fallback?.requestId === requestId) vol.fallback = undefined
    if (vol.question?.requestId === requestId) vol.question = undefined
  }

  tool(sessionId: string, event: { id: string; tool?: string; title: string; kind: ToolKind; status: ToolStatus }) {
    const vol = this.volatile.get(sessionId)
    if (vol === undefined) return
    if (vol.phase !== "running") return
    const terminal = event.status === "completed" || event.status === "failed" || event.status === "declined" || event.status === "cancelled"
    if (terminal && !vol.completed.has(event.id)) {
      vol.completed.add(event.id)
      vol.toolCount = vol.completed.size
      this.scheduleStep(sessionId)
    }
    const starting = event.status === "running" || (event.status === "pending" && !vol.started.has(event.id))
    if (!starting) return
    vol.started.add(event.id)
    vol.stepKind = mapKind(event.kind)
    const agent = isSubagentTool(event.tool)
    vol.stepTool = agent ? "agent" : undefined
    vol.stepPlain = agent ? subagentStep(event.title, event.tool!) || undefined : clip(event.title, STEP_CHARS)
    this.scheduleStep(sessionId)
  }

  /** v65 B5: the speech paused on `open` background tasks (0: it resumed). The step line names them. */
  background(sessionId: string, open: number) {
    const vol = this.volatile.get(sessionId)
    if (!vol || vol.backgroundOpen === open) return
    vol.backgroundOpen = open
    if (vol.phase === "running") this.scheduleStep(sessionId)
  }

  usage(sessionId: string, tokens: number) {
    const vol = this.volatile.get(sessionId)
    if (!vol || tokens <= 0) return
    vol.tokens += tokens
  }

  status(sessionId: string, status: "running" | "idle" | "waiting", end?: LiveTurnEnd) {
    if (!this.covers(sessionId)) return
    if (status === "idle") {
      void this.finish(sessionId, end ?? { phase: "done" })
      return
    }
    const vol = this.volatile.get(sessionId)
    if (!vol) return
    if (status === "waiting") {
      if (!vol.approval && !vol.question) return
      vol.phase = "waiting"
      this.clearStep(vol)
      // A question alone carries no alert: its own notification already sounds, and the gateway only takes
      // the fixed approval / done / failed texts.
      void this.pushUpdate(sessionId, "waiting", 10, vol.approval !== undefined)
      return
    }
    if (vol.phase !== "waiting" && !vol.approval && !vol.question) return
    vol.approval = undefined
    vol.question = undefined
    vol.phase = "running"
    this.clearStep(vol)
    void this.pushUpdate(sessionId, "running", 10, false)
  }

  /** A restart cannot resume a turn. End stored activities when a gateway can deliver that, otherwise just drop the rows. */
  async abandonAll() {
    const rows = this.store.listLiveActivities()
    if (rows.length === 0) return
    if (this.options.gateway) {
      await Promise.all(rows.map((row) => this.pushEnd(row, "interrupted", true)))
    }
    for (const row of rows) {
      this.store.deleteLiveActivity(row.session_id)
      this.dropVolatile(row.session_id)
    }
  }

  private resetVolatile(sessionId: string) {
    this.dropVolatile(sessionId)
    this.volatile.set(sessionId, {
      seq: 0,
      phase: "running",
      toolCount: 0,
      backgroundOpen: 0,
      started: new Set(),
      completed: new Set(),
      tokens: 0,
      lastStepSentAt: 0,
      stepTimer: null,
      stepGen: 0,
      rotateTimer: null,
      heartbeatTimer: null,
      lastPostAt: 0,
    })
  }

  private dropVolatile(sessionId: string) {
    const vol = this.volatile.get(sessionId)
    if (!vol) return
    this.lastFailure.delete(sessionId)
    this.clearStep(vol)
    this.clearHeartbeat(vol)
    if (vol.rotateTimer) clearTimeout(vol.rotateTimer)
    this.volatile.delete(sessionId)
  }

  private clearStep(vol: Volatile) {
    vol.stepGen += 1
    if (vol.stepTimer) clearTimeout(vol.stepTimer)
    vol.stepTimer = null
  }

  private clearHeartbeat(vol: Volatile) {
    if (vol.heartbeatTimer) clearTimeout(vol.heartbeatTimer)
    vol.heartbeatTimer = null
  }

  /** Only the row that still owns the activity may keep the beat. A replaced token must not inherit it. */
  private notePosted(row: LiveActivityRow) {
    const vol = this.volatile.get(row.session_id)
    if (!vol || this.store.liveActivity(row.session_id)?.push_token !== row.push_token) return
    vol.lastPostAt = Date.now()
    this.armHeartbeat(row.session_id)
  }

  private armHeartbeat(sessionId: string) {
    const vol = this.volatile.get(sessionId)
    if (!vol) return
    this.clearHeartbeat(vol)
    if (vol.phase !== "running" && vol.phase !== "waiting") return
    vol.heartbeatTimer = setTimeout(() => {
      void this.heartbeat(sessionId)
    }, this.heartbeatMs)
    vol.heartbeatTimer.unref?.()
  }

  private async heartbeat(sessionId: string) {
    const vol = this.volatile.get(sessionId)
    if (!vol) return
    vol.heartbeatTimer = null
    if (vol.phase !== "running" && vol.phase !== "waiting") return
    await this.pushUpdate(sessionId, vol.phase, 5, false)
  }

  private delay(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms)
      timer.unref?.()
    })
  }

  private scheduleStep(sessionId: string) {
    const vol = this.volatile.get(sessionId)
    if (vol === undefined) return
    if (vol.phase !== "running") return
    if (vol.stepTimer) return
    const since = Date.now() - vol.lastStepSentAt
    const wait = Math.max(this.coalesceMs, this.minStepIntervalMs - since)
    const generation = ++vol.stepGen
    vol.stepTimer = setTimeout(() => {
      if (vol.stepGen !== generation) return
      vol.stepTimer = null
      void this.flushStep(sessionId)
    }, Math.max(0, wait))
    vol.stepTimer.unref?.()
  }

  private async flushStep(sessionId: string) {
    const vol = this.volatile.get(sessionId)
    if (vol === undefined) return
    if (vol.phase !== "running") return
    vol.lastStepSentAt = Date.now()
    await this.pushUpdate(sessionId, "running", 5, false)
  }

  private async finish(sessionId: string, end: LiveTurnEnd) {
    const row = this.store.liveActivity(sessionId)
    const vol = this.volatile.get(sessionId)
    if (!row || !vol) return
    this.clearStep(vol)
    this.clearHeartbeat(vol)
    vol.phase = end.phase
    vol.approval = undefined
    vol.question = undefined
    const result = end.result ? clip(firstSentence(end.result), RESULT_CHARS) : ""
    // Older apps read only `resultSealed`. A copy too long for the card's push budget stays rudderd's text.
    const copy = end.phase === "failed" && !end.silent && end.copy ? JSON.stringify(end.copy) : ""
    const text = result ? { result, ...(copy && copy.length <= RESULT_COPY_CHARS ? { copy } : {}) } : undefined
    // ActivityKit end does not present an alert. Done and failed update first, then end.
    if (end.phase === "done" || end.phase === "failed") {
      await this.pushUpdate(sessionId, end.phase, 10, true, text)
      await this.delay(this.endAfterAlertMs)
      await this.pushEnd(row, end.phase, false, text)
    } else {
      await this.pushEnd(row, end.phase, false, text)
    }
    // A new register during the wait replaces the row. Ending the old token must not drop the new one.
    const current = this.store.liveActivity(sessionId)
    if (current?.activity_id === row.activity_id && current.push_token === row.push_token) {
      this.store.deleteLiveActivity(sessionId)
      this.dropVolatile(sessionId)
    }
  }

  private async pushUpdate(sessionId: string, phase: Phase, priority: 5 | 10, alert: boolean, result?: CardResult) {
    const row = this.store.liveActivity(sessionId)
    const vol = this.volatile.get(sessionId)
    if (!row || !vol) return
    await this.post(row, "update", this.content(row, vol, phase, result), priority, alert ? this.alert(row, phase) : undefined, undefined)
  }

  private async pushEnd(row: LiveActivityRow, phase: Phase, immediate: boolean, result?: CardResult) {
    const current = this.volatile.get(row.session_id)
    const owned = current !== undefined && this.store.liveActivity(row.session_id)?.push_token === row.push_token
    const vol = owned && current ? current : emptyVolatile()
    const state = this.content(row, vol, phase, result)
    const dismissal = unixSeconds() + (immediate ? 0 : row.keep_seconds)
    state.dismissAt = dismissal - SWIFT_REFERENCE_UNIX
    await this.post(row, "end", state, 10, undefined, dismissal)
  }

  private content(row: LiveActivityRow, vol: Volatile, phase: Phase, result?: CardResult): Record<string, unknown> {
    const state: Record<string, unknown> = {
      phase,
      seq: ++vol.seq,
      toolCount: vol.toolCount,
      updatedAt: Date.now() / 1000 - SWIFT_REFERENCE_UNIX,
    }
    const title = clip(this.store.getSession(row.session_id)?.title ?? "", 60)
    if (title) state.titleSealed = this.seal(row, title, "title")
    if (vol.stepKind) state.stepKind = vol.stepKind
    if (vol.stepTool) state.stepTool = vol.stepTool
    if (vol.stepPlain) state.stepSealed = this.seal(row, vol.stepPlain, "step")
    if (vol.tokens > 0) state.tokens = vol.tokens
    if (phase === "running" && vol.backgroundOpen > 0) state.backgroundOpen = vol.backgroundOpen
    if (phase === "waiting" && vol.approval) {
      // `toolName` stays as an empty string: builds before r59 decode it as required, and read `toolSealed` from r59 on.
      const approval: Record<string, unknown> = { requestId: vol.approval.requestId, toolName: "" }
      if (vol.approval.toolSealed) approval.toolSealed = vol.approval.toolSealed
      if (vol.approval.summarySealed) approval.summarySealed = vol.approval.summarySealed
      state.approval = approval
    }
    if (phase === "waiting" && vol.question) {
      const question: Record<string, unknown> = { requestId: vol.question.requestId, count: vol.question.count }
      if (vol.question.titleSealed) question.titleSealed = vol.question.titleSealed
      state.question = question
    }
    if (phase === "done" || phase === "failed" || phase === "interrupted") {
      state.endedAt = Date.now() / 1000 - SWIFT_REFERENCE_UNIX
    }
    if (result && (phase === "done" || phase === "failed")) state.resultSealed = this.seal(row, result.result, "result")
    if (result?.copy && phase === "failed") state.resultCopySealed = this.seal(row, result.copy, "resultCopy")
    return state
  }

  // Fixed texts only: the alert crosses Cloudflare and APNs in the clear, and the gateway accepts no others (r59 F-10).
  // As keys the phone translates into its own language; plain text for an older gateway (`AlertLadder`).
  private alert(row: LiveActivityRow, phase: Phase): LiveActivityAlert | undefined {
    if (phase !== "waiting" && phase !== "done" && phase !== "failed") return undefined
    return this.ladder.alert(row.locale, phase)
  }

  private seal(row: LiveActivityRow, text: string, field: LiveField, requestId = ""): string {
    return sealLive(row.device_key, text, { field, sessionId: row.session_id, requestId })
  }

  private async post(
    row: LiveActivityRow,
    event: "update" | "end",
    contentState: Record<string, unknown>,
    priority: 5 | 10,
    alert: LiveActivityAlert | undefined,
    dismissalDate: number | undefined,
  ) {
    if (!this.options.gateway) return
    const device = this.store.deviceByKey(row.device_key)
    const ticket = device?.push_token
    if (!device || !ticket || !isPushTicket(ticket)) {
      this.failed(row, "has no gateway ticket; not pushed")
      return
    }
    const body: Record<string, unknown> = {
      ticket,
      kind: "liveactivity",
      token: row.push_token,
      priority,
      event,
      contentState,
      staleDate: unixSeconds() + STALE_SECONDS,
      relevanceScore: relevance(phaseOf(contentState)),
    }
    if (dismissalDate !== undefined) body.dismissalDate = dismissalDate
    if (alert) body.alert = alert
    let payload = JSON.stringify(body)
    for (let attempt = 1; attempt <= 2; attempt++) {
      let response: Response
      try {
        response = await this.fetch(`${this.options.gateway}/v1/push`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: payload,
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        })
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        if (attempt === 1) continue
        this.failed(row, `gateway unreachable: ${reason}`)
        return
      }
      if (response.ok) {
        if (this.owns(row)) this.lastFailure.delete(row.session_id)
        this.notePosted(row)
        return
      }
      if (response.status >= 500 && attempt === 1) continue
      const reply = (await response.json().catch(() => ({}))) as { error?: string; reason?: string; message?: string }
      const kind = alert ? liveAlertKind(alert) : undefined
      if (kind && this.ladder.refused(response.status, body.alert, reply.message)) {
        // An older gateway: from now on, the next rung down.
        body.alert = this.ladder.alert(row.locale, kind)
        payload = JSON.stringify(body)
        attempt = 0
        continue
      }
      if ((response.status === 410 && reply.reason && BAD_TICKET_REASONS.has(reply.reason)) || (response.status === 400 && reply.error === "bad_ticket")) {
        // The ticket is wrong for every push to this phone, not just this card.
        if (this.store.clearDevicePushToken(device.id, ticket)) this.options.onTicketDropped?.(device, reply.reason ?? reply.error ?? "bad_ticket")
        this.failed(row, `push failed with ${response.status} ${reply.reason ?? reply.error ?? ""}; ticket dropped`.trimEnd())
        return
      }
      if (response.status === 410) {
        // The card ended on the phone (Unregistered / ExpiredToken), or a gateway older than r68 sent no reason.
        // Either way this token takes no more pushes: stop the beat and drop the row (only if it still owns the card).
        this.failed(row, `push failed with 410 ${reply.reason ?? ""}; card gone`.trimEnd())
        if (this.owns(row)) {
          this.store.deleteLiveActivity(row.session_id)
          this.dropVolatile(row.session_id)
        }
        return
      }
      this.failed(row, `push failed with ${response.status} ${reply.error ?? ""}`.trimEnd())
      return
    }
  }

  private owns(row: LiveActivityRow): boolean {
    return this.store.liveActivity(row.session_id)?.push_token === row.push_token
  }

  /** Logs on a change only, and sends the permission notification the card was standing in for. */
  private failed(row: LiveActivityRow, what: string) {
    if (!this.owns(row)) {
      this.log(`live-activity: session ${row.session_id} (replaced card) ${what}`)
      return
    }
    if (this.lastFailure.get(row.session_id) !== what) this.log(`live-activity: session ${row.session_id} ${what}`)
    this.lastFailure.set(row.session_id, what)
    const vol = this.volatile.get(row.session_id)
    const fallback = vol?.fallback
    if (vol && fallback) {
      vol.fallback = undefined
      fallback.send()
    }
  }

  private armRotate(sessionId: string) {
    const row = this.store.liveActivity(sessionId)
    const vol = this.volatile.get(sessionId)
    if (!row || !vol) return
    if (vol.rotateTimer) clearTimeout(vol.rotateTimer)
    const due = row.started_at + this.rotateAfterMs - Date.now()
    vol.rotateTimer = setTimeout(() => {
      void this.rotate(sessionId)
    }, Math.max(0, due))
    vol.rotateTimer.unref?.()
  }

  private async rotate(sessionId: string) {
    const row = this.store.liveActivity(sessionId)
    if (!row) return
    await this.pushEnd(row, "interrupted", true)
    this.store.deleteLiveActivity(sessionId)
    this.dropVolatile(sessionId)
    this.options.onRotate?.(sessionId)
  }
}

/** The per-session island's result: the card's first sentence (push.ts), without its full stop. */
export function firstSentence(text: string): string {
  return cardSentence(text, Number.MAX_SAFE_INTEGER).replace(/[。.]$/, "").trim()
}

function emptyVolatile(): Volatile {
  return {
    seq: 0,
    phase: "running",
    toolCount: 0,
    backgroundOpen: 0,
    started: new Set(),
    completed: new Set(),
    tokens: 0,
    lastStepSentAt: 0,
    stepTimer: null,
    stepGen: 0,
    rotateTimer: null,
    heartbeatTimer: null,
    lastPostAt: 0,
  }
}

function relevance(phase: Phase): number {
  if (phase === "waiting") return 100
  if (phase === "failed") return 80
  if (phase === "running") return 50
  return 20
}

function phaseOf(contentState: Record<string, unknown>): Phase {
  const phase = contentState.phase
  if (phase === "waiting" || phase === "failed" || phase === "running" || phase === "done" || phase === "interrupted") {
    return phase
  }
  return "running"
}

function mapKind(kind: ToolKind): string {
  if (kind === "execute") return "bash"
  if (kind === "fetch") return "web"
  return kind
}

function clip(text: string, maxChars: number): string {
  const chars = [...text]
  return chars.length <= maxChars ? text : `${chars.slice(0, Math.max(0, maxChars - 1)).join("")}…`
}

function unixSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

function fail(message: string, code: string): never {
  throw Object.assign(new Error(message), { code })
}
