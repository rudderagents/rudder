import { homedir } from "node:os"
import { join } from "node:path"
import { readClaudeDiagnostics } from "./diagnostics"
import { openExternalUrl } from "../platform/open-url"
import { urlElicitation } from "./url-elicitation"
import type { ContinuationOffer, LateAgentEvent } from "./types"
import { tmpdir } from "node:os"
import { withCarryOver } from "../carry-over"
import { callMatch } from "../v32"
import { AgentError, classifyAgentFailure, stderrTail } from "./agent-error"
import { phoneCopy } from "../phone-copy"
import { BackgroundTracker, exitCodeIn, subagentResult } from "./background"
import { nativeClaudeCommands, type ClaudeNativeCommand } from "../commands"
import { fileContains } from "../file-search"
import { findTranscript } from "../handoff/claude-scan"
import { claudeHandoffDirs } from "../handoff/dirs"
import { elicitForm, formQuestions } from "./elicitation"
import { claudeUserContent } from "./images"
import { errorMessage, flattenAnswers, isObject, isString, num, obj, parseQuestions, str, type Json } from "./json"
import { CLAUDE_MODES } from "./modes"
import { spawnLines, type LineProcess } from "./stdio"
import { unavailable } from "./types"
import type {
  AdapterContext,
  AgentAdapter,
  AgentModel,
  AgentQuota,
  AgentSpec,
  PermissionOption,
  QuotaWindow,
  RudderPermissionMode,
  ToolDiff,
  ToolKind,
  ToolStatus,
  TurnUsage,
  WarmContext,
} from "./types"

// Claude Code over the stream-json control protocol, one long-lived process per Rudder session.
// Field sources: the agent protocol notes and the research captures it cites.

export type ClaudeAdapterOptions = {
  openUrl?: (url: string) => Promise<void>
  spec: AgentSpec
  command?: string
  // Rewrites the launch argv; tests put a scripted fake agent in front of the Claude flags.
  args?: (base: string[]) => string[]
  // A session's process is closed after this long without a turn; the next turn resumes it.
  idleTimeoutMs?: number
  // A process warmed for an opened chat that no turn has used yet: closed after this long, and only the newest
  // `warmLimit` of them are kept.
  warmIdleMs?: number
  warmLimit?: number
  // At most this many processes with no running turn (warm or used) stay alive; the least recently used goes first.
  idleLimit?: number
  // How long an interrupted turn may take to deliver its result before the process is killed.
  interruptTimeoutMs?: number
  // A continuation turn with nothing terminal from the CLI settles after this (plan 2026-11-17 D3).
  continuationDeadlineMs?: number
  // Where the CLI keeps its transcripts (`<projects>/<folder>/<session>.jsonl`); a native rewind checks its cut there.
  projectsDir?: string
}

export const CLAUDE_IDLE_TIMEOUT_MS = 10 * 60_000
// 2026-11-12 (perf-1112 R6): each opened Claude chat kept a warm CLI for 10 min, with no cap, so browsing chats
// stacked processes. An unused warm one now lives 2 min and at most two are kept (the oldest is stopped).
export const CLAUDE_WARM_IDLE_MS = 2 * 60_000
export const CLAUDE_WARM_LIMIT = 2
// perf-1112 round two (R6): a used process also idled 10 min with no cap, so a morning of chats left a CLI (about
// 300 MB each) per chat touched. Every idle process now counts against one cap; running turns do not.
export const CLAUDE_IDLE_LIMIT = 3
const INTERRUPT_TIMEOUT_MS = 5_000
// A continuation turn whose CLI never writes a result ends after this (T3 Code waits 2 minutes too).
const CONTINUATION_DEADLINE_MS = 120_000
const REQUEST_TIMEOUT_MS = 10_000
const CONTEXT_TIMEOUT_MS = 2_000
const MODELS_TIMEOUT_MS = 20_000
const USAGE_TIMEOUT_MS = 20_000
const USAGE_TTL_MS = 60_000
const USAGE_RETRY_MS = 10 * 60_000
const STOP_GRACE_MS = 3_000
const STDERR_TAIL = 2_000

// Shown before the reply when a stale --resume id forced a fresh Claude session.
export const STALE_RESUME_NOTICE = phoneCopy.staleResume().text

const STREAM_FLAGS = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"]
// Probe processes (models, usage, sign-in) start often, as often as once a minute: keep the user's settings (for the
// `/` list) but run none of their hooks (SessionStart would fire every time) and load no MCP server (T3 Code's
// Claude capabilities probe, MIT).
const PROBE_FLAGS = [
  ...STREAM_FLAGS,
  "--no-session-persistence",
  "--settings",
  JSON.stringify({ disableAllHooks: true }),
  "--strict-mcp-config",
  "--mcp-config",
  JSON.stringify({ mcpServers: {} }),
]
const PROBE_ENV = { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: "false", CLAUDE_CODE_AUTO_CONNECT_IDE: "0", CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1" }
// 2026-11-18: the CLI writes system/session_state_changed (idle | running | requires_action); `idle` is its
// authoritative turn-over signal, and a turn ends on it (plan 2026-11-18-turn-end-authoritative).
const SESSION_ENV = { CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1" }
const SESSION_FLAGS = [
  ...STREAM_FLAGS,
  "--include-partial-messages",
  // Each line the CLI takes is echoed when it takes it: a steer echoed inside a run was folded into that run. Read only
  // on the older path (a CLI without session state events, `ClaudeSession.stateEvents`).
  "--replay-user-messages",
  "--thinking-display",
  "summarized",
  "--permission-prompt-tool",
  "stdio",
]

// list_models.supportsFastMode (Claude Code 2.1.310). Off is the launch default; fast merges {"fastMode":true}.
const CLAUDE_FAST_SPEEDS = [
  { id: "off", label: "Standard", description: "Standard speed" },
  { id: "fast", label: "Fast", description: "Faster responses, higher cost" },
]

export const CLAUDE_PERMISSION_OPTIONS: PermissionOption[] = [
  { id: "allow", label: "批准", kind: "allow_once" },
  { id: "allow_session", label: "本会话总是允许", kind: "allow_always" },
  { id: "reject", label: "拒绝", kind: "reject_once" },
  { id: "reject_stop", label: "拒绝并停止", kind: "reject_once" },
]

const TOOL_KINDS: Record<string, ToolKind> = {
  Read: "read",
  NotebookRead: "read",
  Glob: "search",
  Grep: "search",
  Edit: "edit",
  MultiEdit: "edit",
  Write: "edit",
  NotebookEdit: "edit",
  Bash: "execute",
  WebFetch: "fetch",
  WebSearch: "fetch",
}

type CostMark = { cost: number; output: number }
type ToolState = {
  id: string
  tool: string
  title: string
  kind: ToolKind
  detail: string
  status: ToolStatus
  diffs?: ToolDiff[]
  output?: string
  exitCode?: number
}
type Block = { type: "text" | "thinking"; index: number; id: string; text: string; done: boolean; matched: boolean; startedAt?: number }

// `--permission-mode` value. `claude --help` (2.1.309) lists "manual" for the asking mode; "default" is its alias.
export function claudePermissionFlag(mode: RudderPermissionMode): string {
  return mode === "ask" ? "manual" : mode
}

// set_permission_mode takes the SDK names, where the asking mode is "default".
function claudeControlMode(mode: RudderPermissionMode): string {
  return mode === "ask" ? "default" : mode
}

// The mode the CLI reports (system/init, system/status) as a Rudder id.
export function fromClaudeMode(mode: string): RudderPermissionMode {
  return mode === "default" || mode === "manual" ? "ask" : mode
}

// Modes the CLI only takes at launch (bypassPermissions): switching to them relaunches with --resume.
const LAUNCH_ONLY_MODES = new Set(CLAUDE_MODES.filter((mode) => mode.restart).map((mode) => mode.id))

type RateLimitStatus = NonNullable<QuotaWindow["status"]>
const RATE_LIMIT_STATUSES = new Set<string>(["allowed", "allowed_warning", "rejected"])

// rate_limit_event.rate_limit_info → one window. `utilization` is a fraction in current CLIs; a value over 1 is
// already a percent. `resetsAt` is unix seconds (a value that large is milliseconds already).
export function claudeRateLimit(info: Json, now = Date.now()): QuotaWindow | undefined {
  const kind = str(info.rateLimitType)
  const status = str(info.status)
  if (!kind || !RATE_LIMIT_STATUSES.has(status)) return undefined
  const reset = num(info.resetsAt)
  const used = num(info.utilization)
  const window: QuotaWindow = { kind, status: status as RateLimitStatus }
  if (reset !== undefined) window.resetsAt = reset > 1e12 ? reset : reset * 1000
  if (used !== undefined) window.usedPercent = Math.max(0, Math.min(100, Math.round(used > 1 ? used : used * 100)))
  // A warning whose window has already reset says nothing about now.
  if (window.resetsAt !== undefined && window.resetsAt <= now) return { kind, status: "allowed" }
  return window
}

const USAGE_WINDOWS: Record<string, number> = { five_hour: 300, seven_day: 10080, seven_day_opus: 10080, seven_day_sonnet: 10080 }

// get_usage (Claude Code 2.1.312, experimental) → the quota card. The account's own numbers, so use in the
// terminal or on claude.ai counts too. `utilization` is a percent here (14 = 14%); `resets_at` is ISO. A model with
// its own weekly limit (`model_scoped`) is a bucket of its own. Unavailable (API key login): nothing to show.
export function claudeUsage(response: Json, now = Date.now()): AgentQuota | undefined {
  if (response.rate_limits_available !== true) return undefined
  const limits = obj(response.rate_limits)
  const window = (entry: Json, kind: string, limit?: string): QuotaWindow[] => {
    const used = num(entry.utilization)
    if (used === undefined) return []
    const reset = Date.parse(str(entry.resets_at))
    return [
      {
        ...(limit ? { limit } : {}),
        kind,
        minutes: USAGE_WINDOWS[kind],
        usedPercent: Math.max(0, Math.min(100, Math.round(used))),
        ...(Number.isFinite(reset) ? { resetsAt: reset } : {}),
      },
    ]
  }
  const windows = Object.keys(USAGE_WINDOWS).flatMap((kind) => window(obj(limits[kind]), kind))
  for (const scoped of Array.isArray(limits.model_scoped) ? limits.model_scoped.filter(isObject) : []) {
    const name = str(scoped.display_name)
    if (name) windows.push(...window(scoped, "seven_day", name))
  }
  const plan = str(response.subscription_type)
  return { ...(plan ? { plan } : {}), windows, updatedAt: now }
}

// An MCP form with no fields: a bare confirmation.
const ELICIT_CONFIRM: PermissionOption[] = [
  { id: "accept", label: "批准", kind: "allow_once" },
  { id: "decline", label: "拒绝", kind: "reject_once" },
]

export function createClaudeAdapter(options: ClaudeAdapterOptions): AgentAdapter {
  let lateSink: ((event: LateAgentEvent) => Promise<void>) | undefined
  let continuationSink: ((offer: ContinuationOffer) => boolean) | undefined
  const command = options.command ?? process.env.RUDDER_CLAUDE_BIN ?? "claude"
  const argv = (base: string[]) => [command, ...(options.args ? options.args(base) : base)]
  const idleTimeoutMs = options.idleTimeoutMs ?? CLAUDE_IDLE_TIMEOUT_MS
  const warmIdleMs = options.warmIdleMs ?? CLAUDE_WARM_IDLE_MS
  const warmLimit = options.warmLimit ?? CLAUDE_WARM_LIMIT
  const idleLimit = options.idleLimit ?? CLAUDE_IDLE_LIMIT
  const interruptTimeoutMs = options.interruptTimeoutMs ?? INTERRUPT_TIMEOUT_MS
  const continuationDeadlineMs = options.continuationDeadlineMs ?? CONTINUATION_DEADLINE_MS
  const sessions = new Map<string, ClaudeSession>()
  // Sessions whose process has no running turn, least recently used first; `warmed` is the part no turn has used yet.
  const resting = new Set<string>()
  const warmed = new Set<string>()
  // Last cumulative cost seen per Rudder session; survives respawns (see turnCost).
  const costMarks = new Map<string, CostMark>()
  let models: Promise<AgentModel[]> | undefined
  // The latest rate_limit_event per rateLimitType, from any session's process.
  const rateLimits = new Map<string, Json>()
  let rateLimitsAt = 0
  // Native rewinds waiting for the next process of the session: --resume-session-at cuts the CLI's own transcript
  // after that record. Kept until a turn ran on such a process, so a warm process stopped unused does not lose it.
  const resumeAt = new Map<string, { nativeId: string; uuid: string }>()

  function spawn(ctx: WarmContext): ClaudeSession {
    const nativeId = ctx.nativeId ?? crypto.randomUUID()
    const base = [...SESSION_FLAGS]
    if (ctx.permissionMode !== "native") base.push("--permission-mode", claudePermissionFlag(ctx.permissionMode))
    if (ctx.model) base.push("--model", ctx.model)
    if (ctx.effort) base.push("--effort", ctx.effort)
    // --settings merges. Fast is a launch setting, so turning it off respawns without the flag.
    const fast = ctx.speed === "fast"
    if (fast) base.push("--settings", JSON.stringify({ fastMode: true }))
    // A copy forks its source on the first turn; --session-id names the fork (allowed only with --fork-session).
    const fork = !ctx.nativeId && ctx.forkFrom ? ctx.forkFrom : undefined
    if (fork) base.push("--resume", fork, "--fork-session", "--session-id", nativeId)
    else base.push(ctx.nativeId ? "--resume" : "--session-id", nativeId)
    const cut = resumeAt.get(ctx.sessionId)
    const cutAt = !fork && cut && cut.nativeId === ctx.nativeId ? cut.uuid : undefined
    if (cutAt) base.push("--resume-session-at", cutAt)
    const session = new ClaudeSession(
      {
        sessionId: ctx.sessionId,
        nativeId,
        resumed: Boolean(ctx.nativeId || fork),
        resumeAt: cutAt,
        cwd: ctx.cwd,
        effort: ctx.effort,
        fast,
        model: ctx.model,
        mode: ctx.permissionMode,
        onLateFrame: (frame) => {
          if (!lateSink || !session.owner || frame.type !== "assistant") return false
          const task = str(frame.task_id)
          // Only a proven task patches its old anchor; anything else after the turn waits for a continuation.
          if (!task) return false
          const content = obj(frame.message).content
          const text = (Array.isArray(content) ? content : []).map(obj).filter(block => block.type === "text").map(block => str(block.text)).join("")
          if (!text) return false
          void lateSink({ identity: { ...session.owner, turnId: "", nativeSessionId: nativeId },
            eventId: str(frame.uuid), ...(task ? { nativeTaskId: task } : {}), text, complete: true })
            .catch(error => console.warn("Late Claude reply persistence failed", error))
          return true
        },
        onWake: (key, detail) => {
          if (!continuationSink || !session.owner) return false
          return continuationSink({ identity: { ...session.owner, nativeSessionId: nativeId }, key, detail, delivery: "buffered" })
        },
        onRateLimit: (info) => {
          const kind = str(info.rateLimitType)
          if (!kind) return
          rateLimits.set(kind, info)
          rateLimitsAt = Date.now()
        },
      },
      argv(base),
    )
    session.owner = ctx.executionIdentity
    session.proc.closed.then((code) => {
      clearTimeout(session.idle)
      if (sessions.get(ctx.sessionId) === session) sessions.delete(ctx.sessionId)
      if (!sessions.has(ctx.sessionId)) unpark(ctx.sessionId)
      session.turn?.exited(code, session.proc.stderr)
    })
    sessions.set(ctx.sessionId, session)
    return session
  }

  // The one way a process goes idle: a stop timer, a place at the young end of the pool, and the pool trimmed to its
  // caps (the oldest warm ones past `warmLimit`, then the oldest of any past `idleLimit`).
  function park(session: ClaudeSession, ms: number, warm: boolean) {
    clearTimeout(session.idle)
    const stopWhenIdle = () => {
      // A kept wake is waiting for its continuation turn; stopping the CLI would lose it.
      if (session.keeping) session.idle = setTimeout(stopWhenIdle, ms)
      else void session.proc.stop()
    }
    session.idle = setTimeout(stopWhenIdle, ms)
    session.idle.unref?.()
    if (sessions.get(session.sessionId) !== session) return
    unpark(session.sessionId)
    resting.add(session.sessionId)
    if (warm) warmed.add(session.sessionId)
    for (const id of resting) {
      const over = resting.size > idleLimit
      if (!over && warmed.size <= warmLimit) break
      if (!over && !warmed.has(id)) continue
      unpark(id)
      const idle = sessions.get(id)
      if (!idle || idle.turn || idle.keeping) continue
      sessions.delete(id)
      clearTimeout(idle.idle)
      void idle.proc.stop()
    }
  }

  function unpark(sessionId: string) {
    resting.delete(sessionId)
    warmed.delete(sessionId)
  }

  // Reuses the live process when it still matches the session; otherwise respawns with --resume.
  async function acquire(ctx: AdapterContext): Promise<ClaudeSession> {
    let session = sessions.get(ctx.sessionId)
    if (session?.turn) throw new Error(`Claude session ${ctx.sessionId} already has a running turn`)
    if (session) clearTimeout(session.idle)
    unpark(ctx.sessionId)
    const fast = ctx.speed === "fast"
    const matches =
      session?.proc.usable &&
      session.cwd === ctx.cwd &&
      // Clearing the effort needs a new process, so the user's own settings load again (T3 Code, MIT).
      (session.effort === ctx.effort || ctx.effort !== undefined) &&
      (ctx.nativeId ? session.nativeId === ctx.nativeId : !session.confirmed)
    if (session && !matches) {
      await session.proc.stop()
      session = undefined
    }
    if (session && (session.effort !== ctx.effort || session.fast !== fast)) {
      try {
        // Effort and fast mode change in place, saving the ~3 s cold start a respawn costs.
        await session.proc.request({ subtype: "apply_flag_settings", settings: { effortLevel: ctx.effort, fastMode: fast ? true : null } })
        session.effort = ctx.effort
        session.fast = fast
      } catch {
        // The respawn below passes --effort / --settings instead.
        await session.proc.stop()
        session = undefined
      }
    }
    if (session && session.model !== ctx.model) {
      try {
        await session.proc.request({ subtype: "set_model", model: ctx.model ?? "default" })
        session.model = ctx.model
      } catch {
        // The respawn below passes --model instead.
        await session.proc.stop()
        session = undefined
      }
    }
    const mode = ctx.permissionMode
    if (session && session.mode !== mode && LAUNCH_ONLY_MODES.has(mode)) {
      await session.proc.stop()
      session = undefined
    }
    if (session && session.mode !== mode) {
      try {
        await session.proc.request({ subtype: "set_permission_mode", mode: claudeControlMode(mode) })
        session.mode = mode
      } catch {
        // The respawn below passes --permission-mode instead.
        await session.proc.stop()
        session = undefined
      }
    }
    return session ?? spawn(ctx)
  }

  async function runTurn(session: ClaudeSession, userText: string, ctx: AdapterContext) {
    const turn = new Turn(session, ctx, options.openUrl ?? openExternalUrl)
    turn.manualCompact = /^\/compact(\s|$)/.test(userText.trim())
    session.owner = ctx.executionIdentity
    session.turn = turn
    const onAbort = () => turn.interrupt(interruptTimeoutMs)
    let deadline: ReturnType<typeof setTimeout> | undefined
    const outcome = turn.done.then(
      () => undefined,
      (error: Error) => error,
    )
    try {
      const content = await claudeUserContent(userText, ctx.images ?? [])
      // An interrupt sent before the user line would not stop the run that line starts.
      if (ctx.signal.aborted) {
        ctx.emit({ type: "text", id: crypto.randomUUID(), text: "Cancelled.", notice: true })
        return
      }
      ctx.signal.addEventListener("abort", onAbort, { once: true })
      if (ctx.continuation) {
        // Plan 2026-11-17 D3: the CLI is told nothing; what it said with no turn replays here, then it is heard live.
        turn.started = true
        // The CLI may still be running past the deadline: stop it as the stop button would, so it opens no further turn.
        deadline = setTimeout(() => turn.interrupt(interruptTimeoutMs), continuationDeadlineMs)
        // Nothing kept (the process was replaced, or the offer was refused): there is nothing to wait for.
        if (session.replayWake() === 0) turn.expire()
      } else {
        session.hear()
        session.foldWake(turn)
        session.proc.send({ type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: "" })
        turn.started = true
      }
      let failure = await outcome
      turn.closeTools()
      turn.closeCompaction()
      turn.reportNative()
      const results = turn.results
      const reported = results.map((entry) => resultFailure(entry, turn, session)).find(Boolean)
      const stale = staleResume(failure ?? reported, turn, session)
      if (stale) throw stale
      const result = mergeResults(results)
      if (result) {
        if (!turn.interrupted) {
          for (const entry of results) if (!entry.is_error && typeof entry.result === "string" && entry.result) turn.recoverResult(entry)
        }
        const usage = await turnUsage(result, session, costMarks)
        if (usage) ctx.emit({ type: "usage", usage })
        failure ??= reported
      }
      if (turn.interrupted && !turn.wroteText) ctx.emit({ type: "text", id: crypto.randomUUID(), text: "Cancelled.", notice: true })
      ctx.emit({ type: "replyDisposition", value: turn.finalText ? "present" : turn.wroteText ? "unknown" : "absent", nativeMessageIds: [...turn.finalIds] })
      if (failure) throw failure
    } finally {
      clearTimeout(deadline)
      ctx.signal.removeEventListener("abort", onAbort)
      turn.dispose()
      session.turn = undefined
      // The CLI has written the cut transcript once a turn ran on it; resuming plainly keeps the cut from here on.
      if (session.resumeAt && session.confirmed && turn.started && resumeAt.get(ctx.sessionId)?.uuid === session.resumeAt) {
        resumeAt.delete(ctx.sessionId)
      }
      if (session.proc.usable) park(session, idleTimeoutMs, false)
    }
    ctx.emit({ type: "lifecycle", phase: "terminal", terminalStatus: turn.interrupted ? "interrupted" : "completed", pendingFinalization: false })
  }

  async function fetchModels(): Promise<AgentModel[]> {
    // list_models is answered before any user message, so no session is created.
    const proc = new ClaudeProcess(argv(PROBE_FLAGS), tmpdir(), () => undefined, PROBE_ENV)
    try {
      const response = await proc.request({ subtype: "list_models" }, MODELS_TIMEOUT_MS)
      const list = Array.isArray(response.models) ? response.models : []
      return list.filter(isObject).flatMap((entry) => {
        const id = str(entry.value)
        if (!id) return []
        const efforts = Array.isArray(entry.supportedEffortLevels) ? entry.supportedEffortLevels.filter(isString) : []
        const speeds = entry.supportsFastMode === true ? CLAUDE_FAST_SPEEDS : undefined
        return [{ id, label: str(entry.displayName) || id, efforts, ...(speeds ? { speeds, defaultSpeed: "off" } : {}) }]
      })
    } finally {
      await proc.stop()
    }
  }

  // get_usage, at most once a minute (a new rate_limit_event reads again sooner). A cold read takes about 6 s, so an
  // older answer is returned at once while a new one is read. "unsupported": the CLI has no get_usage or it failed;
  // asked again after USAGE_RETRY_MS.
  let usage: { at: number; value: AgentQuota | undefined | "unsupported" } | undefined
  let usageReading: Promise<AgentQuota | undefined | "unsupported"> | undefined

  function readUsage(): Promise<AgentQuota | undefined | "unsupported"> {
    const now = Date.now()
    if (usage && now - usage.at < (usage.value === "unsupported" ? USAGE_RETRY_MS : USAGE_TTL_MS) && usage.at > rateLimitsAt) {
      return Promise.resolve(usage.value)
    }
    usageReading ??= fetchUsage()
      .catch(() => "unsupported" as const)
      .then((value) => {
        usage = { at: Date.now(), value }
        return value
      })
      .finally(() => {
        usageReading = undefined
      })
    const reading = usageReading
    return usage && usage.value !== "unsupported" ? Promise.resolve(usage.value) : reading
  }

  async function fetchUsage(): Promise<AgentQuota | undefined> {
    // Answered before any user message, like list_models: nothing is sent to the model and no session is kept.
    const proc = new ClaudeProcess(argv(PROBE_FLAGS), tmpdir(), () => undefined, PROBE_ENV)
    try {
      return claudeUsage(await proc.request({ subtype: "get_usage", skip_behaviors: true }, USAGE_TIMEOUT_MS))
    } finally {
      await proc.stop()
    }
  }

  // The initialize reply names the account; only a definite "no credentials" counts as signed out.
  async function fetchAccount(): Promise<Json | undefined> {
    const proc = new ClaudeProcess(argv(PROBE_FLAGS), tmpdir(), () => undefined, PROBE_ENV)
    try {
      const response = await proc.request({ subtype: "initialize" }, MODELS_TIMEOUT_MS)
      return isObject(response.account) ? response.account : undefined
    } finally {
      await proc.stop()
    }
  }

  return {
    setLateEventSink(sink) { lateSink = sink },
    setContinuationSink(sink) {
      continuationSink = sink
    },
    cancelContinuation(sessionId) {
      sessions.get(sessionId)?.quieten()
    },
    spec: options.spec,
    async detect() {
      if (!Bun.which(command)) return unavailable(phoneCopy.commandMissing(command))
      const found = { available: true }
      // A probe that fails or times out proves nothing: the agent stays available and a turn says why.
      const account = await fetchAccount().catch(() => undefined)
      return account && claudeSignedOut(account) ? unavailable(phoneCopy.claudeSignedOut()) : found
    },
    async diagnostics(cwd, nativeId) {
      const configRoot = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")
      const live = nativeId ? [...sessions.values()].find(session => session.nativeId === nativeId && session.cwd === cwd && session.proc.usable) : undefined
      if (live) return readClaudeDiagnostics(method => live.proc.request({ subtype: method }), cwd, configRoot, nativeId)
      let proc: ClaudeProcess | undefined
      try {
        proc = new ClaudeProcess(argv([...STREAM_FLAGS, "--no-session-persistence", "--settings", JSON.stringify({ disableAllHooks: true })]), cwd,
          () => undefined, { ...process.env, CLAUDE_CODE_AUTO_CONNECT_IDE: "0", CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1" })
        await proc.request({ subtype: "initialize" }, MODELS_TIMEOUT_MS)
        const probe = proc
        return await readClaudeDiagnostics(method => probe.request({ subtype: method }, MODELS_TIMEOUT_MS), cwd, configRoot)
      } catch {
        throw new Error("Claude diagnostics unavailable; verify CLI installation and configuration")
      } finally {
        await proc?.stop()
      }
    },
    async listCommands(cwd) {
      const proc = new ClaudeProcess(argv(PROBE_FLAGS), cwd, () => undefined, PROBE_ENV)
      try {
        const response = await proc.request({ subtype: "initialize" }, MODELS_TIMEOUT_MS)
        if (!Array.isArray(response.commands)) throw new Error(`Claude initialize returned no commands catalogue for ${cwd}`)
        const commands: ClaudeNativeCommand[] = []
        for (const raw of response.commands) {
          const command = obj(raw)
          if (typeof command.name !== "string" || !command.name.trim() || /\p{Cc}/u.test(command.name) ||
              (command.description !== undefined && typeof command.description !== "string")) {
            throw new Error(`Claude initialize returned invalid commands metadata for ${cwd}`)
          }
          commands.push({ name: command.name, description: command.description })
        }
        return nativeClaudeCommands(commands)
      } finally {
        await proc.stop()
      }
    },
    listModels() {
      models ??= fetchModels().catch((error: unknown) => {
        models = undefined
        throw error
      })
      return models
    },
    // The account's own windows from get_usage; a CLI without it falls back to the last rate_limit_event, with
    // empty windows until a turn on this computer reported one (the phone writes 「还没有数据」).
    async limits(): Promise<AgentQuota | undefined> {
      if (!Bun.which(command)) return undefined
      const usage = await readUsage()
      if (usage !== "unsupported") return usage
      const now = Date.now()
      const windows = [...rateLimits.values()].flatMap((info) => claudeRateLimit(info, now) ?? [])
      return { windows, updatedAt: rateLimitsAt || now }
    },
    async setMode(sessionId, mode) {
      const session = sessions.get(sessionId)
      if (!session?.turn || !session.proc.usable || session.mode === mode || LAUNCH_ONLY_MODES.has(mode)) return false
      await session.proc.request({ subtype: "set_permission_mode", mode: claudeControlMode(mode) })
      session.mode = mode
      return true
    },
    async steer(sessionId, text) {
      const session = sessions.get(sessionId)
      if (!session?.turn?.steerable || !session.proc.usable) return false
      // The CLI queues this line or folds it into the run it is in; either way the turn ends on the CLI's next idle.
      // An older CLI is counted: one more result, unless the echo shows it folded (`Turn.replayed`).
      session.turn.expectRun(text)
      session.proc.send({
        type: "user",
        message: { role: "user", content: text },
        parent_tool_use_id: null,
        session_id: "",
      })
      return true
    },
    warm(ctx) {
      // CLI start-up (hooks, plugins) took about 3 s before a turn could begin. The process waits on stdin until
      // the first message; unused, the warm idle timer stops it, and the idle pool's caps stop the oldest.
      const live = sessions.get(ctx.sessionId)
      if (live?.proc.usable) {
        // Opened again: it moves to the young end with the lifetime it already had.
        if (!live.turn && resting.delete(ctx.sessionId)) {
          resting.add(ctx.sessionId)
          if (warmed.delete(ctx.sessionId)) warmed.add(ctx.sessionId)
        }
        return
      }
      park(spawn(ctx), warmIdleMs, true)
    },
    async reply(userText, ctx) {
      if (ctx.signal.aborted) return
      ctx.emit({ type: "status", status: "running" })
      const session = await acquire(ctx)
      if (ctx.signal.aborted) {
        // No turn ran on it and acquire cleared any idle timer: left alone, the process would run until rudderd exits.
        await session.proc.stop()
        ctx.emit({ type: "text", id: crypto.randomUUID(), text: "Cancelled.", notice: true })
        return
      }
      try {
        await runTurn(session, userText, ctx)
      } catch (error) {
        if (!(error instanceof StaleResumeError) || ctx.signal.aborted) throw error
        // The resume id is gone (deleted, other machine): carry on in a fresh session, like Codex and ACP.
        await session.proc.stop()
        // An abort that landed while the stale process stopped ends the turn here.
        if (ctx.signal.aborted) {
          ctx.emit({ type: "text", id: crypto.randomUUID(), text: "Cancelled.", notice: true })
          return
        }
        const fresh = { ...ctx, nativeId: undefined, forkFrom: undefined }
        // A copy whose source is gone still carries the transcript over, so nothing is lost to announce.
        if (ctx.forkFrom && !ctx.nativeId) return runTurn(spawn(fresh), withCarryOver(userText, ctx.carryOver), fresh)
        // Rudder's own line, not the agent's: a notice the phone words in its own language.
        ctx.emit({ type: "text", id: crypto.randomUUID(), text: STALE_RESUME_NOTICE, notice: true, copy: phoneCopy.staleResume() })
        await runTurn(spawn(fresh), userText, fresh)
      }
    },
    async stopBackground(sessionId) {
      const turn = sessions.get(sessionId)?.turn
      if (!turn) return false
      return turn.stopBackground(REQUEST_TIMEOUT_MS)
    },
    forks: true,
    processes() {
      return [...sessions.values()]
        .filter((session) => session.proc.alive)
        .map((session) => ({ agent: options.spec.id, pid: session.proc.pid, sessionIds: [session.sessionId], shared: false }))
    },
    release(sessionId) {
      const session = sessions.get(sessionId)
      if (!session || session.turn) return
      sessions.delete(sessionId)
      unpark(sessionId)
      clearTimeout(session.idle)
      void session.proc.stop()
    },
    async rewind(sessionId, cut) {
      if (!cut.keepThrough) return false
      const session = sessions.get(sessionId)
      if (session?.turn) return false
      // The CLI exits with "No message found with message.uuid" at a record its transcript no longer has (rewound
      // or cleared in a terminal), which would fail every later turn.
      const path = findTranscript(options.projectsDir ?? claudeHandoffDirs().projectsDir, cut.nativeId)
      // Streamed (review2-1117): a long session's transcript is tens of MB, read whole just to find one uuid.
      if (!path || !(await fileContains(path, `"uuid":"${cut.keepThrough}"`))) return false
      resumeAt.set(sessionId, { nativeId: cut.nativeId, uuid: cut.keepThrough })
      if (session) {
        // A live process still holds the removed turns in memory; the next one starts at the cut.
        sessions.delete(sessionId)
        unpark(sessionId)
        clearTimeout(session.idle)
        await session.proc.stop()
      }
      return true
    },
    forget(sessionId) {
      costMarks.delete(sessionId)
      resumeAt.delete(sessionId)
      const session = sessions.get(sessionId)
      if (!session) return
      sessions.delete(sessionId)
      unpark(sessionId)
      clearTimeout(session.idle)
      void session.proc.stop()
    },
    async dispose() {
      const live = [...sessions.values()]
      sessions.clear()
      resting.clear()
      warmed.clear()
      await Promise.all(
        live.map((session) => {
          clearTimeout(session.idle)
          return session.proc.stop()
        }),
      )
    },
  }
}

type Pending = { resolve: (response: Json) => void; reject: (error: Error) => void }

// Transport: NDJSON over stdio, host-initiated control requests, exit tracking.
class ClaudeProcess {
  readonly closed: Promise<number>
  alive = true
  private stopping = false
  private readonly lines: LineProcess
  private readonly requests = new Map<string, Pending>()
  private nextRequest = 0

  constructor(argv: string[], cwd: string, private readonly onFrame: (frame: Json) => void, env?: Record<string, string | undefined>) {
    this.lines = spawnLines(argv, { cwd, onLine: (line) => this.line(line), stderrMax: STDERR_TAIL, ...(env ? { env } : {}) })
    // Reported after stdout drained (bounded), so a final result line is never lost.
    this.closed = this.lines.exited.then((code) => {
      this.alive = false
      const detail = this.stderr ? `: ${this.stderr}` : ""
      for (const pending of this.requests.values()) pending.reject(new Error(`Claude exited with code ${code}${detail}`))
      this.requests.clear()
      return code
    })
  }

  get pid(): number {
    return this.lines.pid
  }

  get stderr(): string {
    return this.lines.stderrTail()
  }

  // False once stdin is closed: the CLI is on its way out.
  get usable(): boolean {
    return this.alive && !this.stopping
  }

  send(frame: Json) {
    this.lines.write(JSON.stringify(frame))
  }

  request(request: Json, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Json> {
    if (!this.alive) return Promise.reject(new Error(`Claude process exited; cannot send ${String(request.subtype)}`))
    const id = `rudder_${++this.nextRequest}`
    return new Promise<Json>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(id)
        reject(new Error(`Claude did not answer ${String(request.subtype)} within ${timeoutMs} ms`))
      }, timeoutMs)
      this.requests.set(id, {
        resolve: (response) => {
          clearTimeout(timer)
          resolve(response)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      this.send({ type: "control_request", request_id: id, request })
    })
  }

  respond(requestId: string, response: Json) {
    this.send({ type: "control_response", response: { subtype: "success", request_id: requestId, response } })
  }

  respondError(requestId: string, error: string) {
    this.send({ type: "control_response", response: { subtype: "error", request_id: requestId, error } })
  }

  // Closing stdin lets the CLI finish and exit on its own; SIGTERM, then SIGKILL, if it lingers.
  async stop() {
    this.stopping = true
    await this.lines.stop({ closeStdinFirst: true, graceMs: STOP_GRACE_MS })
    await this.closed
  }

  // An interrupt that went unanswered: no graceful exit is expected any more.
  kill() {
    this.stopping = true
    void this.lines.stop()
  }

  private line(text: string) {
    if (!text.startsWith("{")) return
    let frame: unknown
    try {
      frame = JSON.parse(text)
    } catch {
      // Not a protocol frame; unknown output is ignored.
      return
    }
    if (!isObject(frame)) return
    if (frame.type !== "control_response") return this.onFrame(frame)
    const response = obj(frame.response)
    const pending = this.requests.get(str(response.request_id))
    if (!pending) return
    this.requests.delete(str(response.request_id))
    if (response.subtype === "error") pending.reject(new Error(`Claude control request failed: ${str(response.error) || "unknown error"}`))
    else pending.resolve(obj(response.response))
  }
}

type SessionInit = {
  onLateFrame?: (frame: Json) => boolean
  // The CLI spoke with no turn about no proven task: offer a continuation once (key = its task, detail = its summary).
  onWake?: (key: string, detail: string) => boolean
  sessionId: string
  nativeId: string
  resumed: boolean
  resumeAt?: string
  cwd: string
  effort?: string
  fast: boolean
  model?: string
  mode: string
  onRateLimit?: (info: Json) => void
}

// One Claude process bound to one Rudder session.
class ClaudeSession {
  readonly proc: ClaudeProcess
  owner?: AdapterContext["executionIdentity"]
  private readonly onLateFrame?: (frame: Json) => boolean
  readonly sessionId: string
  readonly nativeId: string
  readonly resumed: boolean
  // The --resume-session-at record this process started from, if any.
  readonly resumeAt?: string
  readonly cwd: string
  effort?: string
  fast: boolean
  private readonly onRateLimit?: (info: Json) => void
  model?: string
  // The CLI's current mode as a Rudder id (from init / system status); ExitPlanMode approval switches it.
  mode: RudderPermissionMode
  // Set by the first system/init: the CLI accepted the session id.
  confirmed = false
  // The CLI reports its own state (initialize answered with session_state, or a session_state_changed arrived): a turn
  // ends on its `idle`. False for an older CLI, whose turns end by counting results.
  stateEvents = false
  // Background tasks the CLI still lists (its latest background_tasks_changed), by task id.
  tasks: string[] = []
  // system/init capabilities (interrupt_cancel_queued_v1).
  capabilities = new Set<string>()
  // Kept frames going through `frame` again: the state they carry is old news.
  private replaying = false
  turn?: Turn
  // Frames the CLI wrote with no turn, kept for a continuation turn (plan 2026-11-17 D2/D3); a stop quiets them.
  private wake: Json[] = []
  private wakeOffered = false
  private quiet = false
  // A refused offer: the rest of that run (up to its result) is dropped too, or its result would replay its text.
  private dropRun = false
  private readonly onWake?: (key: string, detail: string) => boolean
  idle?: ReturnType<typeof setTimeout>
  // total_cost_usd already billed before this process's next turn; null when unknown.
  costBase?: number | null

  constructor(init: SessionInit, argv: string[]) {
    this.onLateFrame = init.onLateFrame
    this.onWake = init.onWake
    this.sessionId = init.sessionId
    this.nativeId = init.nativeId
    this.resumed = init.resumed
    this.resumeAt = init.resumeAt
    this.cwd = init.cwd
    this.effort = init.effort
    this.fast = init.fast
    this.model = init.model
    this.mode = init.mode
    this.onRateLimit = init.onRateLimit
    this.proc = new ClaudeProcess(argv, init.cwd, (frame) => this.frame(frame), { ...process.env, ...SESSION_ENV })
    // Answered before any user line (no model call). Without session_state this is an older CLI: no state events.
    this.proc.request({ subtype: "initialize" }).then(
      (response) => {
        if (typeof response.session_state === "string") this.stateEvents = true
      },
      () => undefined,
    )
  }

  private frame(frame: Json) {
    if (frame.type === "system" && frame.subtype === "session_state_changed") this.stateEvents = true
    if (frame.type === "system" && frame.subtype === "background_tasks_changed" && !this.replaying) {
      this.tasks = (Array.isArray(frame.tasks) ? frame.tasks : []).map((task) => str(obj(task).task_id))
    }
    if (frame.type === "system" && (frame.subtype === "init" || frame.subtype === "status")) {
      if (typeof frame.permissionMode === "string" && this.mode !== "native") {
        const mode = fromClaudeMode(frame.permissionMode)
        // A switch the CLI made itself during a turn (approved ExitPlanMode) goes back to the session.
        if (frame.subtype === "status" && this.turn && mode !== this.mode) this.turn.modeChanged(mode)
        this.mode = mode
      }
      if (frame.subtype === "init") {
        this.confirmed = true
        if (Array.isArray(frame.capabilities)) this.capabilities = new Set(frame.capabilities.filter(isString))
      }
    }
    if (frame.type === "control_request") {
      const requestId = str(frame.request_id)
      const request = obj(frame.request)
      if (request.subtype === "can_use_tool" && this.turn) return void this.turn.canUseTool(requestId, request)
      // An MCP server's form (2.1.312). With no turn there is nobody to ask.
      if (request.subtype === "elicitation") return this.turn ? void this.turn.elicit(requestId, request) : this.proc.respond(requestId, { action: "cancel" })
      // Unanswered control requests block the CLI.
      return this.proc.respondError(requestId, `Unsupported control request subtype: ${str(request.subtype) || "(none)"}`)
    }
    if (frame.type === "control_cancel_request") return this.turn?.withdraw(str(frame.request_id))
    if (frame.type === "rate_limit_event") return this.onRateLimit?.(obj(frame.rate_limit_info))
    if (this.onLateFrame?.(frame)) return
    if (!this.turn) return this.collect(frame)
    this.turn.frame(frame)
  }

  /** A notification of a task no turn tracked, and the run the CLI starts for it, wait here for a continuation turn. */
  private collect(frame: Json) {
    // Not the agent speaking: the echo of a line the CLI took, or a control request's local-command output (set_model
    // on a warm process writes `<local-command-stdout>Set model to …`). Kept, it made the next prompt wait for a run
    // that never came (2026-11-18 stuck turn).
    if (frame.type === "user" && (frame.isReplay === true || localCommand(frame))) return
    if (this.quiet || frame.parent_tool_use_id != null) return
    const state = frame.type === "system" && frame.subtype === "session_state_changed" ? str(frame.state) : undefined
    if (this.dropRun) {
      // A refused run lasts until the CLI is idle again (an older CLI: until its result).
      if (this.stateEvents ? state === "idle" : frame.type === "result") this.dropRun = false
      return
    }
    if (state !== undefined) {
      // `running` opens the CLI's own run and `idle` closes it; kept, they open and end the continuation turn.
      if (state === "running") this.wake.push(frame)
      if (state !== "idle" || this.wake.length === 0) return
      // A run that said nothing worth a turn is not kept: nothing will ask for it.
      if (!this.wakeOffered) return this.quieten(false)
      this.wake.push(frame)
      return
    }
    if (!WAKE_FRAMES.has(frame.type === "system" ? str(frame.subtype) : str(frame.type))) return
    this.wake.push(frame)
    if (this.wakeOffered) return
    const notified = this.wake.some((entry) => entry.subtype === "task_notification")
    if (!(frame.type === "assistant" && assistantText(frame)) && !(frame.type === "result" && notified)) return
    this.wakeOffered = true
    const note = this.wake.findLast((entry) => entry.subtype === "task_notification")
    // Refused (stale, a repeat, nobody listening): nothing will replay it, so it is not kept.
    if (!this.onWake?.(str(note?.task_id) || str(this.wake[0]?.uuid) || crypto.randomUUID(), str(note?.summary))) {
      this.quieten(false)
      this.dropRun = this.stateEvents || frame.type !== "result"
    }
  }

  /** Frames are waiting for a turn: the idle timer and the pool trim leave this process alone. */
  get keeping(): boolean {
    return this.wake.length > 0
  }

  /**
   * A prompt arrives while the CLI's own run is kept: that run replays first, in this turn. With state events the turn
   * then ends on the first idle after the prompt is written (a prompt the CLI takes while running joins that run).
   * An older CLI is counted: the turn waits for the kept run's result as well as the prompt's (one per kept result,
   * plus one if the kept run has not finished).
   */
  foldWake(turn: Turn) {
    const frames = this.wake
    if (frames.length === 0) return
    if (!this.stateEvents) {
      const results = frames.filter((frame) => frame.type === "result").length
      const finished = frames.at(-1)?.type === "result"
      for (let index = 0; index < results + (finished ? 0 : 1); index += 1) turn.expectRun()
    }
    this.replayWake()
  }

  /** The continuation turn takes what was kept, in arrival order. Returns how many frames it replayed. */
  replayWake(): number {
    const frames = this.wake
    this.wake = []
    this.wakeOffered = false
    this.replaying = true
    try {
      for (const [index, frame] of frames.entries()) {
        // A finished task's empty result right before the CLI starts its own run (T3 Code saw it settle newer turns).
        if (frame.type === "result" && frame.num_turns === 0 && frames[index + 1]?.subtype === "init") continue
        this.frame(frame)
      }
    } finally {
      this.replaying = false
    }
    return frames.length
  }

  /** A stop (quiet until the next prompt), or a refused offer: forget what was kept. */
  quieten(quiet = true) {
    this.wake = []
    this.wakeOffered = false
    if (quiet) this.quiet = true
  }

  /** A prompt from the user lifts a stop's quiet. */
  hear() {
    this.quiet = false
  }
}

// What the CLI writes on its own after a turn: a task's notification, the run it starts, and that run's result.
const WAKE_FRAMES = new Set(["task_notification", "task_started", "task_updated", "init", "assistant", "user", "result"])

// A user frame carrying a local command's output (`<local-command-stdout>…`, `<local-command-stderr>…`).
function localCommand(frame: Json): boolean {
  const content = obj(frame.message).content
  const text = typeof content === "string" ? content : (Array.isArray(content) ? content : []).map(obj).map((block) => str(block.text)).join("")
  return text.trimStart().startsWith("<local-command-")
}

function assistantText(frame: Json): string {
  const content = obj(frame.message).content
  return (Array.isArray(content) ? content : []).map(obj).filter((block) => block.type === "text").map((block) => str(block.text)).join("")
}

// Maps one turn's frames to AgentEvents. Event ids are fresh UUIDs; native ids only key the maps.
class Turn {
  readonly done: Promise<void>
  readonly results: Json[] = []
  started = false
  interrupted = false
  // The user chose "reject and stop"; the CLI then ends the turn with an error result.
  stopped = false
  wroteText = false
  finalText = false
  readonly finalIds = new Set<string>()
  private readonly recoveredTexts = new Set<string>()
  private settle!: (error?: Error) => void
  private settled = false
  // Older CLI only (no state events): one result per user line written during the turn, the first message plus each
  // steer, less the steers the CLI folded into a run it was already in (`replayed`). With state events the CLI's idle
  // ends the turn and nothing is counted.
  private runs = 1
  // A run is going: from the turn's start, or a steer's echo after a result, until the next result.
  private runOpen = true
  // Steers written and not yet echoed back (--replay-user-messages), by their text.
  private readonly steers: string[] = []
  // The first result arrived while a background task was still open. The concluding result settles the turn.
  private speechPaused = false
  // 全部停止 asked the CLI to stop the open tasks.
  private stoppingBackground = false
  // Tasks the CLI marked is_backgrounded (at start, or later by task_updated). A foreground task never enters.
  readonly background = new BackgroundTracker((event) => this.ctx.emit(event), () => this.speechPaused)
  // Foreground task_started frames, kept so a later move to the background has its description and tool id.
  private readonly foreground = new Map<string, Json>()
  private readonly blocks = new Map<string, Block[]>()
  private readonly tools = new Map<string, ToolState>()
  private readonly hiddenTools = new Set<string>()
  private readonly withdrawals = new Map<string, AbortController>()
  private currentMessage = ""
  private nativeSent = false
  private killTimer?: ReturnType<typeof setTimeout>
  // The user sent /compact; the CLI's status frame does not say whether a compaction is manual.
  manualCompact = false
  // Set by `status: compacting`; compact_boundary finishes the same timeline row.
  private compactionId?: string
  // The newest main-chain assistant record; a native rewind to after this turn resumes at it.
  private lastMessageId?: string

  constructor(
    private readonly session: ClaudeSession,
    private readonly ctx: AdapterContext,
    private readonly openUrl: (url: string) => Promise<void>,
  ) {
    this.done = new Promise<void>((resolve, reject) => {
      this.settle = (error) => {
        if (this.settled) return
        this.settled = true
        if (error) reject(error)
        else resolve()
      }
    })
  }

  /** A continuation turn the CLI never finished (plan 2026-11-17 D3 deadline). */
  expire() {
    this.settle()
  }

  frame(frame: Json) {
    if (frame.type === "system" && frame.subtype === "task_started") {
      this.noteBackground(frame)
      return
    }
    if (frame.type === "system" && frame.subtype === "task_updated") {
      this.movedToBackground(frame)
      return
    }
    if (frame.type === "system" && frame.subtype === "task_notification") {
      this.finishBackground(frame)
      return
    }
    if (frame.type === "system" && frame.subtype === "status" && frame.status === "compacting") {
      // Without this the compaction (often tens of seconds) looks like a stalled turn.
      if (this.compactionId) return
      this.compactionId = crypto.randomUUID()
      this.ctx.emit({
        type: "compaction",
        id: this.compactionId,
        state: "running",
        trigger: this.manualCompact ? "manual" : "auto",
        startedAt: Date.now(),
      })
      return
    }
    if (frame.type === "system" && frame.subtype === "compact_boundary") {
      const metadata = obj(frame.compact_metadata)
      const trigger = metadata.trigger === "manual" ? "manual" : "auto"
      const before = num(metadata.pre_tokens)
      const after = num(metadata.post_tokens)
      this.ctx.emit({
        type: "compaction",
        id: this.compactionId ?? crypto.randomUUID(),
        state: "done",
        trigger,
        ...(before !== undefined ? { tokensBefore: before } : {}),
        ...(after !== undefined ? { tokensAfter: after } : {}),
      })
      this.compactionId = undefined
      return
    }
    if (frame.type === "system" && frame.subtype === "api_retry") {
      const attempt = num(frame.attempt)
      const maxAttempts = num(frame.max_retries)
      const delayMs = num(frame.retry_delay_ms)
      const reason = str(frame.error)
      this.ctx.emit({
        type: "retry",
        attempt: attempt !== undefined ? Math.max(1, Math.trunc(attempt)) : 1,
        ...(maxAttempts !== undefined ? { maxAttempts: Math.trunc(maxAttempts) } : {}),
        ...(delayMs !== undefined ? { delayMs: Math.max(0, Math.trunc(delayMs)) } : {}),
        ...(reason ? { reason } : {}),
      })
      return
    }
    if (frame.type === "system" && frame.subtype === "session_state_changed") return this.stateChanged(str(frame.state))
    if (frame.type === "system" && frame.subtype === "init") return this.init(frame)
    if (frame.type === "stream_event" && frame.parent_tool_use_id == null) return this.stream(frame)
    if (frame.type === "assistant") return this.assistant(frame)
    if (frame.type === "user") return frame.isReplay === true ? this.replayed(frame) : this.toolResults(frame)
    if (frame.type === "result") {
      this.runOpen = false
      this.results.push(frame)
      // The CLI says this speech is done while a background command is still running. Keep the turn so the
      // later task_notification and the follow-up sentence land here. An interrupt still settles.
      if (this.background.open > 0 && !this.interrupted) return this.pause()
      // With state events a result is not the end: queued lines and the background loop run on until idle.
      if (this.session.stateEvents) return
      // After an interrupt the CLI may drop queued lines, so the first result ends the turn.
      if (this.interrupted || this.results.length >= this.runs) this.settle()
    }
  }

  /**
   * The CLI's own state. Its first `idle` after this turn's line was written ends the turn (Claude Code 2.1.312: idle
   * comes after queued lines ran and held-back results flushed); idle with background tasks still listed is a pause:
   * the speech is done, and the CLI goes running and idle again when a task ends (or is stopped).
   */
  private stateChanged(state: string) {
    if (state !== "idle" || !this.started) return
    // Only this turn's own tasks hold it: one an earlier turn left running (a dev server) would hold every later turn.
    if (this.interrupted || !this.session.tasks.some((id) => this.background.knows(id))) return this.settle()
    this.pause()
  }

  private pause() {
    if (this.speechPaused) return
    this.speechPaused = true
    this.background.publish()
  }

  private noteBackground(frame: Json) {
    const taskId = str(frame.task_id)
    if (!taskId) return
    if (frame.is_backgrounded !== true) {
      this.foreground.set(taskId, frame)
      return
    }
    this.trackBackground(taskId, frame)
  }

  // A foreground Bash or subagent the user (or the agent) sent to the background mid-call.
  private movedToBackground(frame: Json) {
    const taskId = str(frame.task_id)
    const started = this.foreground.get(taskId)
    if (!started || obj(frame.patch).is_backgrounded !== true) return
    this.foreground.delete(taskId)
    this.trackBackground(taskId, started)
  }

  private trackBackground(taskId: string, frame: Json) {
    // SendMessage to a finished background agent starts it again under the same id: it works for this turn again.
    if (this.background.reopen(taskId)) return
    const toolUseId = str(frame.tool_use_id)
    const kind = str(frame.task_type) === "local_agent" || str(frame.subagent_type) ? "subagent" : "command"
    const tool = toolUseId ? this.tools.get(toolUseId) : undefined
    // A command reads as itself (mono on the phone); a subagent by what it was asked to do.
    const title = (kind === "command" && tool?.detail ? tool.detail.split("\n")[0] : "") || str(frame.description) || tool?.title || ""
    this.background.start(taskId, { kind, title, ...(tool ? { toolId: tool.id } : {}), ...(toolUseId ? { nativeToolId: toolUseId } : {}) })
  }

  private finishBackground(frame: Json) {
    const taskId = str(frame.task_id)
    this.foreground.delete(taskId)
    if (!taskId || !this.background.has(taskId)) return
    const toolId = this.background.nativeToolId(taskId) || str(frame.tool_use_id)
    const status = str(frame.status)
    const summary = str(frame.summary)
    const exitCode = exitCodeIn(summary)
    const subagent = this.background.kind(taskId) === "subagent"
    // Read before end(): ending the last task can let the follow-up result settle the turn.
    const result = subagent ? subagentResult(str(frame.output_file)) : undefined
    this.background.end(taskId, status === "failed" ? "failed" : status === "stopped" ? "cancelled" : "done", exitCode)
    const state = toolId ? this.tools.get(toolId) : undefined
    // An async Agent's card was answered at launch; its notification is the real result.
    if (state && (state.status === "pending" || state.status === "running" || (subagent && state.status === "completed"))) {
      state.status = status === "failed" ? "failed" : status === "stopped" ? "cancelled" : "completed"
      if (result || summary) state.output = result || summary
      if (exitCode !== undefined) state.exitCode = exitCode
      this.emitTool(state)
    }
    this.settleIfStopped()
  }

  /** Stop all: `stop_task` per running task (Claude Code 2.1.312 stops one task and reports it stopped). */
  async stopBackground(timeoutMs: number): Promise<boolean> {
    const ids = this.background.running()
    if (ids.length === 0) return true
    this.stoppingBackground = true
    const results = await Promise.all(
      ids.map((id) =>
        this.session.proc.request({ subtype: "stop_task", task_id: id }, timeoutMs).then(
          () => true,
          () => false,
        ),
      ),
    )
    this.settleIfStopped()
    return results.every(Boolean)
  }

  // A stopped task brings no follow-up speech or result (Claude Code 2.1.312, unlike a task that finishes on its
  // own), so a paused turn whose tasks were all stopped ends here; waiting for a result left it running forever.
  /**
   * The CLI took a user line. A steer it takes while a run is going is folded into that run (Claude Code 2.1.312: one
   * result answers both), so it brings no result of its own; one it takes after a result starts its own run.
   */
  private replayed(frame: Json) {
    if (this.session.stateEvents) return
    const content = obj(frame.message).content
    const index = typeof content === "string" ? this.steers.indexOf(content) : -1
    if (index < 0) return
    this.steers.splice(index, 1)
    if (this.runOpen) {
      this.runs -= 1
      return
    }
    this.runOpen = true
  }

  // Older CLI only: with state events the CLI writes idle again once the stopped tasks are gone.
  private settleIfStopped() {
    if (this.session.stateEvents) return
    if (this.stoppingBackground && this.speechPaused && this.background.open === 0) this.settle()
  }

  get steerable() {
    return this.started && !this.settled && !this.interrupted
  }

  expectRun(steer?: string) {
    if (!this.session.stateEvents) {
      this.runs += 1
      if (steer !== undefined) this.steers.push(steer)
    }
    // A line written while only background work held the turn: the agent is working again from here, whether its
    // answer opens with words or with a tool.
    this.resumeSpeech()
  }

  exited(code: number, stderr: string) {
    if (this.interrupted) return this.settle()
    const detail = stderrTail(stderr)
    this.settle(
      new AgentError(`Claude exited with code ${code} before the turn finished${stderr ? `: ${stderr}` : ""}`, {
        code: "agent_exited",
        exitCode: code,
        ...(detail ? { detail } : {}),
      }),
    )
  }

  interrupt(timeoutMs: number) {
    if (this.settled || this.interrupted) return
    this.interrupted = true
    // A Stop: lines the CLI has queued are cancelled with the run (otherwise they still run after it, probe G).
    const cancelQueued = this.session.capabilities.has("interrupt_cancel_queued_v1") ? { cancel_queued: true } : {}
    // A lost interrupt is covered by the kill timer.
    this.session.proc.request({ subtype: "interrupt", ...cancelQueued }, timeoutMs).catch(() => undefined)
    this.killTimer = setTimeout(() => this.session.proc.kill(), timeoutMs)
  }

  withdraw(requestId: string) {
    this.withdrawals.get(requestId)?.abort()
  }

  modeChanged(mode: RudderPermissionMode) {
    if (this.ctx.permissionMode !== "native") this.ctx.emit({ type: "mode", mode })
  }

  async canUseTool(requestId: string, request: Json) {
    const withdraw = new AbortController()
    this.withdrawals.set(requestId, withdraw)
    try {
      const name = str(request.tool_name)
      const input = obj(request.input)
      const response =
        name === "AskUserQuestion" ? await this.question(input, withdraw.signal) : await this.permission(request, name, input, withdraw.signal)
      if (!withdraw.signal.aborted) this.session.proc.respond(requestId, response)
    } catch (error) {
      this.session.proc.respond(requestId, { behavior: "deny", message: `Rudder could not ask the user: ${errorMessage(error)}` })
    } finally {
      this.withdrawals.delete(requestId)
    }
  }

  recoverResult(result: Json) {
    const text = str(result.result)
    if (!text || this.recoveredTexts.has(text)) return
    this.recoveredTexts.add(text)
    this.finalText = true
    for (const [id, blocks] of this.blocks) {
      if (blocks.filter(block => block.type === "text").map(block => block.text).join("") === text) {
        if (id) this.finalIds.add(id)
        return
      }
    }
    if (str(result.uuid)) this.finalIds.add(str(result.uuid))
    this.writeText(text)
  }

  writeText(text: string) {
    this.wroteText = true
    this.ctx.emit({ type: "text", id: crypto.randomUUID(), text, phase: "final" })
  }

  // A compaction the CLI never finished (no compact_boundary) must not leave a timer ticking on the phone.
  closeCompaction() {
    if (!this.compactionId) return
    this.ctx.emit({
      type: "compaction",
      id: this.compactionId,
      state: "done",
      trigger: this.manualCompact ? "manual" : "auto",
    })
    this.compactionId = undefined
  }

  // Tools that never got a result in this turn will not get one.
  closeTools() {
    for (const state of this.tools.values()) {
      if (state.status !== "pending" && state.status !== "running") continue
      state.status = "cancelled"
      this.emitTool(state)
    }
  }

  dispose() {
    clearTimeout(this.killTimer)
  }

  reportNative() {
    if (this.lastMessageId) this.ctx.emit({ type: "nativeTurn", nativeId: this.session.nativeId, lastMessageId: this.lastMessageId })
  }

  private init(frame: Json) {
    const nativeId = str(frame.session_id)
    if (!nativeId || this.nativeSent || nativeId === this.ctx.nativeId) return
    this.nativeSent = true
    this.ctx.emit({ type: "native", nativeId })
  }

  private stream(frame: Json) {
    const event = obj(frame.event)
    if (event.type === "message_start") {
      this.currentMessage = str(obj(event.message).id) || str(frame.api_message_id)
      return
    }
    const list = this.blockList(str(frame.api_message_id) || this.currentMessage)
    const index = typeof event.index === "number" ? event.index : -1
    if (event.type === "content_block_start") {
      const type = obj(event.content_block).type
      if (type === "text" || type === "thinking") {
        list.push({ type, index, id: crypto.randomUUID(), text: "", done: false, matched: false, startedAt: Date.now() })
      }
      return
    }
    const block = list.find((entry) => entry.index === index)
    if (!block) return
    if (event.type === "content_block_stop") {
      if (block.type === "thinking") this.setThinking(block, block.text, true)
      return
    }
    if (event.type !== "content_block_delta") return
    const delta = obj(event.delta)
    if (block.type === "text" && delta.type === "text_delta") this.setText(block, block.text + str(delta.text))
    if (block.type === "thinking" && delta.type === "thinking_delta") this.setThinking(block, block.text + str(delta.thinking), false)
    // signature_delta is the last delta of a thinking block.
    if (block.type === "thinking" && delta.type === "signature_delta") this.setThinking(block, block.text, true)
  }

  // Whole assistant messages carry one block each; blocks of one API call share message.id.
  private assistant(frame: Json) {
    const message = obj(frame.message)
    const main = frame.parent_tool_use_id == null
    if (main && typeof frame.uuid === "string" && frame.uuid) this.lastMessageId = frame.uuid
    const content = Array.isArray(message.content) ? message.content : []
    for (const block of content.filter(isObject)) {
      if (block.type === "tool_use") {
        if (main) this.openTool(str(block.id), str(block.name), obj(block.input))
        continue
      }
      if (!main || (block.type !== "text" && block.type !== "thinking")) continue
      const list = this.blockList(str(message.id))
      let entry = list.find((candidate) => candidate.type === block.type && !candidate.matched)
      if (!entry) {
        entry = { type: block.type, index: -1, id: crypto.randomUUID(), text: "", done: false, matched: false }
        list.push(entry)
      }
      entry.matched = true
      if (block.type === "text") this.setText(entry, str(block.text) || entry.text)
      else this.setThinking(entry, str(block.thinking) || entry.text, true)
    }
  }

  private toolResults(frame: Json) {
    const content = obj(frame.message).content
    for (const block of (Array.isArray(content) ? content : []).filter(isObject)) {
      if (block.type !== "tool_result") continue
      const state = this.tools.get(str(block.tool_use_id))
      if (!state) continue
      const failed = block.is_error === true
      // Left whole: the daemon cuts it to TOOL_OUTPUT_LIMIT and flags the cut.
      state.output = resultText(block.content)
      // A backgrounded Agent answers at launch ("Async agent launched"); it runs until its task_notification.
      const launched = !failed && this.background.runningForTool(str(block.tool_use_id))
      if (state.status !== "declined" && state.status !== "cancelled") {
        state.status = this.interrupted ? "cancelled" : failed ? "failed" : launched ? "running" : "completed"
      }
      const exit = failed && state.tool === "Bash" ? /^Exit code (\d+)/.exec(state.output) : null
      if (exit) state.exitCode = Number(exit[1])
      this.emitTool(state)
    }
  }

  private async permission(request: Json, name: string, input: Json, withdraw: AbortSignal): Promise<Json> {
    const info = describeTool(name, input)
    const state = this.openTool(str(request.tool_use_id), name, input)
    if (state) {
      state.status = "pending"
      this.emitTool(state)
    }
    const choice = await this.ctx.askPermission(
      {
        tool: name,
        title: str(request.title) || info.title,
        detail: info.detail,
        kind: info.kind,
        options: CLAUDE_PERMISSION_OPTIONS,
        ...(info.diffs ? { diffs: info.diffs } : {}),
        ...(state ? { toolId: state.id } : {}),
        match: callMatch(name, input),
      },
      withdraw,
    )
    if (state) {
      const allowed = choice === "allow" || choice === "allow_session"
      const rejected = choice === "reject" || choice === "reject_stop"
      state.status = allowed ? "running" : rejected ? "declined" : "cancelled"
      this.emitTool(state)
    }
    // 本会话总是允许 is the daemon's rule (session-service `permission_rules`): it answers the next matching request
    // itself and can revoke the rule. Handing the CLI a session rule as well would allow the whole tool past any
    // revoke (audit 2026-11-10 #5), so the CLI only ever hears this one use allowed.
    if (choice === "allow" || choice === "allow_session") return { behavior: "allow", updatedInput: input }
    if (choice === "reject") {
      // r47: line comments from the phone become the deny message, so Claude revises in this same turn.
      const note = state ? this.ctx.reviewNote?.(state.id) : undefined
      return { behavior: "deny", message: note ? `The user declined this tool use with these comments:\n\n${note}` : "The user declined this tool use." }
    }
    if (choice === "reject_stop") {
      this.stopped = true
      return { behavior: "deny", message: "The user declined this tool use and stopped the turn.", interrupt: true }
    }
    return { behavior: "deny", message: "The permission request was cancelled." }
  }

  /** control_request `elicitation`: the form as a question card (an empty form as a yes / no), replied `{action, content}`. */
  async elicit(requestId: string, request: Json) {
    const withdraw = new AbortController()
    this.withdrawals.set(requestId, withdraw)
    try {
      const response = await this.elicitation(request, withdraw.signal)
      if (!withdraw.signal.aborted) this.session.proc.respond(requestId, response)
    } catch (error) {
      console.warn(`rudderd: Claude elicitation could not be asked: ${errorMessage(error)}`)
      this.session.proc.respond(requestId, { action: "cancel" })
    } finally {
      this.withdrawals.delete(requestId)
    }
  }

  private async elicitation(request: Json, withdraw: AbortSignal): Promise<Json> {
    const server = str(request.mcp_server_name)
    const message = str(request.message)
    if (request.mode === "url") return urlElicitation({
      server, message, url: str(request.url), elicitationId: str(request.elicitationId) || str(request.elicitation_id),
    }, this.ctx.askQuestion, this.openUrl, AbortSignal.any([withdraw, this.ctx.signal]))
    const form = request.mode === "form" ? formQuestions(message, request.requested_schema) : undefined
    if (!form) {
      const copy = request.mode === "form" ? phoneCopy.mcpFormUnsupported(server) : phoneCopy.mcpUrlUnsupported(server, message)
      this.ctx.emit({ type: "text", id: crypto.randomUUID(), text: copy.text, notice: true, copy })
      return { action: "decline" }
    }
    if (form.request.questions.length === 0) {
      const choice = await this.ctx.askPermission({ tool: `mcp__${server}`, title: message || server, detail: "", kind: "other", options: ELICIT_CONFIRM }, withdraw)
      return choice === "accept" ? { action: "accept", content: {} } : { action: "decline" }
    }
    return elicitForm(form, this.ctx.askQuestion, AbortSignal.any([withdraw, this.ctx.signal]))
  }

  private async question(input: Json, withdraw: AbortSignal): Promise<Json> {
    const answers = await this.ctx.askQuestion({ questions: parseQuestions(input.questions, true) }, withdraw)
    if (!answers) return { behavior: "deny", message: "The user did not answer the question." }
    return { behavior: "allow", updatedInput: { ...input, answers: flattenAnswers(answers) } }
  }

  private openTool(toolUseId: string, name: string, input: Json): ToolState | undefined {
    if (!toolUseId || this.hiddenTools.has(toolUseId)) return undefined
    const known = this.tools.get(toolUseId)
    if (known) return known
    // The question card stands in for the tool card.
    if (name === "AskUserQuestion") {
      this.hiddenTools.add(toolUseId)
      return undefined
    }
    const state: ToolState = { id: crypto.randomUUID(), tool: name, ...describeTool(name, input), status: "running" }
    this.tools.set(toolUseId, state)
    this.emitTool(state)
    return state
  }

  private emitTool(state: ToolState) {
    this.ctx.emit({ type: "tool", ...state })
  }

  private setText(block: Block, text: string) {
    if (text === block.text) return
    block.text = text
    if (!text) return
    this.resumeSpeech()
    this.wroteText = true
    this.ctx.emit({ type: "text", id: block.id, text })
  }

  // Empty thinking (default display, low effort) never produces an event.
  private setThinking(block: Block, text: string, done: boolean) {
    const changed = text !== block.text || (done && !block.done)
    block.text = text
    block.done ||= done
    if (!changed || !text) return
    this.resumeSpeech()
    this.ctx.emit({ type: "reasoning", id: block.id, text, done: block.done, ...(block.startedAt === undefined ? {} : { startedAt: block.startedAt }) })
  }

  // The first speech happens before any pause, so this stays quiet until a background result has been held.
  private resumeSpeech() {
    if (!this.speechPaused) return
    this.speechPaused = false
    this.ctx.emit({ type: "status", status: "running" })
  }

  private blockList(messageId: string): Block[] {
    let list = this.blocks.get(messageId)
    if (!list) {
      list = []
      this.blocks.set(messageId, list)
    }
    return list
  }
}

export function describeTool(name: string, input: Json): { title: string; kind: ToolKind; detail: string; diffs?: ToolDiff[] } {
  const path = str(input.file_path) || str(input.notebook_path)
  const pattern = str(input.pattern) ? `${str(input.pattern)}${str(input.path) ? ` in ${str(input.path)}` : ""}` : ""
  const detail = str(input.command) || path || pattern || str(input.url) || str(input.query) || str(input.plan) || compactJson(input)
  const title = str(input.description) || detail.split("\n")[0]?.slice(0, 80) || name
  const kind = TOOL_KINDS[name] ?? "other"
  const diffs = toolDiffs(name, input, path)
  return diffs ? { title, kind, detail, diffs } : { title, kind, detail }
}

function toolDiffs(name: string, input: Json, path: string): ToolDiff[] | undefined {
  if (!path) return undefined
  if (name === "Write") return [{ path, newText: str(input.content) }]
  if (name === "Edit") return [{ path, oldText: str(input.old_string), newText: str(input.new_string) }]
  if (name === "NotebookEdit") return [{ path, newText: str(input.new_source) }]
  if (name === "MultiEdit" && Array.isArray(input.edits)) {
    return input.edits.filter(isObject).map((edit) => ({ path, oldText: str(edit.old_string), newText: str(edit.new_string) }))
  }
  return undefined
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter(isObject)
    .map((block) => (block.type === "text" ? str(block.text) : ""))
    .filter(Boolean)
    .join("\n")
}

const USAGE_FIELDS = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]

// A steered turn has one result per run: token counts add up, while total_cost_usd and modelUsage are
// cumulative, so the last result carries them.
function mergeResults(results: Json[]): Json | undefined {
  const last = results.at(-1)
  if (!last || results.length === 1) return last
  const parts = results.map((entry) => obj(entry.usage))
  if (!parts.some((part) => Object.keys(part).length > 0)) return last
  const usage: Json = { ...obj(last.usage) }
  for (const field of USAGE_FIELDS) {
    const values = parts.map((part) => num(part[field])).filter((value) => value !== undefined)
    if (values.length > 0) usage[field] = values.reduce((sum, value) => sum + value, 0)
  }
  const thinking = parts.map((part) => num(obj(part.output_tokens_details).thinking_tokens)).filter((value) => value !== undefined)
  if (thinking.length > 0) usage.output_tokens_details = { ...obj(usage.output_tokens_details), thinking_tokens: thinking.reduce((sum, value) => sum + value, 0) }
  return { ...last, usage }
}

function resultFailure(result: Json, turn: Turn, session: ClaudeSession): Error | undefined {
  if (turn.interrupted || turn.stopped) return undefined
  if (result.terminal_reason === "aborted_tools" || result.terminal_reason === "aborted_streaming") return undefined
  const said = str(result.result)
  if (result.subtype === "success") {
    // The CLI reports API failures as subtype "success" with api_error_status / terminal_reason set, sometimes
    // without is_error (judged as T3 Code's Claude adapter does, MIT).
    const status = num(result.api_error_status)
    if (status === 429) {
      const resetsAt = resetAfter(said)
      return new AgentError(`Claude: ${said || "API rate limit reached"}`, { code: "usage_limit", ...(resetsAt ? { resetsAt } : {}) })
    }
    if (status === 529) return new Error("Claude API is overloaded (529). Try again shortly.")
    const ended = terminalReasonText(result.terminal_reason)
    if (ended) return new Error(said && result.terminal_reason === "api_error" ? `Claude: ${said}` : ended)
  }
  if (result.is_error !== true) return undefined
  // r48: a usage limit or a signed-out CLI ends the turn with is_error and the reason as the result text, even
  // under subtype "success" ("Claude AI usage limit reached|1761944400", "Invalid API key · Please run /login").
  const known = said ? classifyAgentFailure("claude", said) : undefined
  if (known && known.code !== "agent_exited") return new AgentError(`Claude: ${said}`, known)
  if (result.subtype === "success") return undefined
  const errors = Array.isArray(result.errors) ? result.errors.filter(isString) : []
  const detail = errors.join("; ") || str(result.subtype) || "unknown error"
  if (session.resumed && !session.confirmed) return new Error(`Claude could not resume session ${session.nativeId}: ${detail}`)
  return new Error(`Claude ${str(result.subtype) || "error"}: ${detail}`)
}

const CONTEXT_FULL = "Claude stopped: the prompt exceeds the model's context window. Run /compact or start a new session."

// Why the CLI ended a turn it did not finish (result.terminal_reason). Undefined: a normal end.
function terminalReasonText(reason: unknown): string | undefined {
  switch (reason) {
    case "api_error":
      return "Claude gave up after repeated API errors."
    case "malformed_tool_use_exhausted":
      return "Claude gave up after repeated malformed tool calls."
    case "budget_exhausted":
      return "Claude stopped: the turn's token budget was exhausted."
    case "structured_output_retry_exhausted":
      return "Claude could not produce the requested structured output."
    case "tool_deferred_unavailable":
      return "Claude could not resume a deferred tool call: the tool is no longer available."
    case "turn_setup_failed":
      return "Claude could not start the turn."
    case "blocking_limit":
    case "prompt_too_long":
      return CONTEXT_FULL
    case "rapid_refill_breaker":
      return "Claude stopped: the context refilled too quickly after compaction."
    case "image_error":
      return "Claude stopped: an image in the conversation could not be processed."
    case "model_error":
      return "Claude stopped: the model returned an error."
    default:
      return undefined
  }
}

// A gateway's 429 carries its reset only as text: "... (reset after 1h 2m 3s)". Ms on the daemon clock.
function resetAfter(text: string): number | undefined {
  const match = /\(reset after (?:(\d+)h ?)?(?:(\d+)m ?)?(?:(\d+)s)?\)/.exec(text)
  if (!match || !(match[1] || match[2] || match[3])) return undefined
  const seconds = Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0)
  return Date.now() + seconds * 1000
}

// Matches agent-error's AUTH pattern, so hello.agents[] says auth_required.
export const CLAUDE_SIGNED_OUT = phoneCopy.claudeSignedOut().text

/** initialize's account: signed out only when tokenSource is "none" with no API key, email or plan (T3 Code, MIT). */
export function claudeSignedOut(account: Json): boolean {
  const provider = str(account.apiProvider)
  if (provider && provider !== "firstParty") return false
  if (account.tokenSource !== "none") return false
  const key = str(account.apiKeySource)
  return !(key && key !== "none") && !str(account.email) && !str(account.subscriptionType)
}

// A resumed process that never confirmed its session and failed with the CLI's "No conversation
// found" (the resume id is unknown to Claude). Any other failure is reported as is.
class StaleResumeError extends Error {}

function staleResume(failure: Error | undefined, turn: Turn, session: ClaudeSession): StaleResumeError | undefined {
  if (!failure || !session.resumed || session.confirmed || turn.interrupted) return undefined
  if (!/no conversation found/i.test(failure.message)) return undefined
  return new StaleResumeError(failure.message, { cause: failure })
}

async function turnUsage(result: Json, session: ClaudeSession, marks: Map<string, CostMark>): Promise<TurnUsage | undefined> {
  if (!isObject(result.usage)) return undefined
  const raw = result.usage
  const usage: TurnUsage = {}
  const fields: [keyof TurnUsage, unknown][] = [
    ["inputTokens", raw.input_tokens],
    ["outputTokens", raw.output_tokens],
    ["cacheReadTokens", raw.cache_read_input_tokens],
    ["cacheWriteTokens", raw.cache_creation_input_tokens],
    ["reasoningTokens", obj(raw.output_tokens_details).thinking_tokens],
    ["costUsd", turnCost(result, session, marks)],
  ]
  for (const [key, value] of fields) {
    const number = num(value)
    if (number !== undefined) usage[key] = number
  }
  // get_context_usage reports the live context window; without it the ring is simply not updated.
  const context = await session.proc.request({ subtype: "get_context_usage", detail: "summary" }, CONTEXT_TIMEOUT_MS).catch(() => undefined)
  const used = num(context?.totalTokens)
  const size = num(context?.maxTokens)
  if (used !== undefined) usage.contextUsed = used
  if (size !== undefined) usage.contextSize = size
  return usage
}

// total_cost_usd is cumulative. --resume restores the previous totals only when that session was the
// cwd's last one, so a resumed process's first bill is matched against the last totals seen here.
function turnCost(result: Json, session: ClaudeSession, marks: Map<string, CostMark>): number | undefined {
  const total = num(result.total_cost_usd)
  if (total === undefined) return undefined
  const output = Object.values(obj(result.modelUsage)).reduce<number>((sum, entry) => sum + (num(obj(entry).outputTokens) ?? 0), 0)
  // Interrupted turns can report a zero total with empty modelUsage; that is not a reset.
  if (total === 0 && output === 0) return 0
  if (session.costBase === undefined) {
    const restored = output - (num(obj(result.usage).output_tokens) ?? 0)
    const mark = marks.get(session.sessionId)
    session.costBase = !session.resumed || restored <= 0 ? 0 : mark && mark.output === restored ? mark.cost : null
  }
  const cost = session.costBase === null ? undefined : Math.max(0, total - session.costBase)
  session.costBase = Math.max(session.costBase ?? 0, total)
  marks.set(session.sessionId, { cost: total, output })
  return cost
}

function compactJson(input: Json): string {
  if (Object.keys(input).length === 0) return ""
  const text = JSON.stringify(input)
  return text.length > 400 ? `${text.slice(0, 400)}…` : text
}
