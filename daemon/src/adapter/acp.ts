import { TOOL_OUTPUT_LIMIT, truncateUtf8 } from "../store"
import type { BackgroundTaskKind, ContinuationOffer, LateAgentEvent } from "./types"
import type { TurnExecutionIdentity } from "../turn-termination"
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { AgentError, loginCommand } from "./agent-error"
import { copyError, copyOf, phoneCopy } from "../phone-copy"
import { acpAcceptsImages, acpPrompt } from "./images"
import { callMatch, modelAcceptsImages, withoutDisplayFields } from "../v32"
import { withCarryOver } from "../carry-over"
import { arr, errorMessage, flattenAnswers, num, obj, parseQuestions, str, type Json } from "./json"
import { BackgroundTracker } from "./background"
import { RpcError, spawnRpc, type Rpc } from "./jsonrpc"
import { ACP_ASK_IDS, acpModeInfo, acpRudderMode, acpShortId, type AcpMode } from "./modes"
import { elicitForm, formQuestions } from "./elicitation"
import { copilotMultiplier, modelLineage } from "./model-vendor"
import { HandoffUnsupported, unavailable, unlessAborted } from "./types"
import type {
  AdapterContext,
  AgentAdapter,
  AgentEvent,
  AgentCommand,
  AgentModel,
  AgentQuota,
  AgentSpec,
  ExternalSession,
  HistoryEntry,
  PermissionOption,
  PermissionModeInfo,
  PermissionOptionKind,
  PlanEntry,
  RudderPermissionMode,
  ToolDiff,
  ToolKind,
  ToolStatus,
  TurnUsage,
  WarmContext,
  PermissionLock,
} from "./types"

// Generic Agent Client Protocol adapter (Grok, Copilot, Cursor, opencode, Kimi, pi).
// Mapping: the agent protocol notes.
export type AcpAdapterOptions = {
  spec: AgentSpec
  // Stdio launch line, e.g. ["grok", "agent", "stdio"].
  command: string[]
  // Identity check on initialize against agentInfo name/title and authMethods id/name.
  // Set it when the command name is ambiguous (Grok also installs itself as `agent`).
  expectAgent?: RegExp
  // Other commands the agent runs itself (pi-acp spawns `pi`); missing from PATH means it cannot start.
  requires?: string[]
  // PromptResponse.usage counts the whole live session rather than one turn (Copilot).
  cumulativeUsage?: boolean
  // A continuation turn (plan 2026-11-17 D3) of an agent without Grok's turn_completed ends after this long quiet;
  // any continuation ends at the deadline.
  continuationQuietMs?: number
  continuationDeadlineMs?: number
  cwd?: string
  initTimeoutMs?: number
  requestTimeoutMs?: number
  // How long an interrupted turn waits for the agent to answer session/prompt.
  cancelGraceMs?: number
  // An auth failure keeps the agent unavailable this long before a turn may retry. Short, so signing in
  // on the computer (e.g. Copilot `/login`) shows up in the app within a minute.
  authRetryMs?: number
  // detect() also opens (and closes) a throwaway session, for agents whose auth only fails at
  // session/new (Copilot 403). Off for agents that persist every session (Grok).
  probeSession?: boolean
  // Files the agent reads its sign-in from at launch (Grok `~/.grok/auth.json`). A running process keeps the account
  // it started with, so after one of these changes an idle process is replaced before its next use.
  credentialFiles?: string[]
  /** The agent's own settings that pin its permission mode, read on each detect (Grok: `grokPermissionLock`). */
  permissionLock?: () => PermissionLock | undefined
  // A session with no turn this long is closed where the agent can close and reopen it (ACP_IDLE_CLOSE_MS).
  idleCloseMs?: number
}

// perf-1112 round two (R6): every session a turn ran on stayed open in the agent process until rudderd exited. One
// idle this long is closed with session/close where the agent advertises it and can reopen it (session/resume or
// session/load); the next turn reopens it. Grok 1.0.77, Copilot 1.0.105 and goose 1.57 advertise close; Qwen 0.26.3
// does not and keeps its sessions open.
export const ACP_IDLE_CLOSE_MS = 15 * 60_000

type Turn = {
  ctx: AdapterContext
  // Any reply text this turn; an interrupted turn without it says "Cancelled.".
  wrote: boolean
  text?: { id: string; text: string }
  thought?: { id: string; text: string }
  tools: Map<string, ToolEntry>
  rejected: Set<string>
  planId?: string
  context?: { used: number; size: number }
  compactionId?: string
  withdraw: AbortController
  // Grok background tasks of this turn. Other ACP agents leave this empty.
  background: BackgroundTracker
  // The first speech ended with background work still open. Follow-up text returns the phone to running.
  paused: boolean
  // A turn_completed arrived after the background set was already empty: the CLI's own follow-up is done.
  followupSettled: boolean
  releaseHold?: () => void
  // Grok subagent id -> the spawn_subagent tool call that started it, whose card shows the subagent's result.
  subagentCalls: Map<string, string>
  // A wake prompt for one of this turn's tasks is streaming; its own turn_completed ends it.
  waking?: boolean
  // Tool calls a subagent made inside this turn (Qwen Code `_meta.parentToolCallId`).
  childCalls: Set<string>
  // Copilot subagent `agentId` -> the task call that started it (`subagent.started`).
  copilotAgents: Map<string, string>
  // Tool calls that get no card (Copilot's todo bookkeeping).
  hiddenCalls: Set<string>
  // Copilot subagent `agentId` -> what it has said so far: a background subagent's result.
  copilotSpeech: Map<string, string>
  // A continuation turn (plan 2026-11-17): what ends it besides releaseHold.
  continuation?: boolean
  // This turn replayed a kept wake: that wake's later chunks are its too.
  absorbed?: boolean
  activity?: () => void
  quietTimer?: ReturnType<typeof setTimeout>
  // Something of this turn arrived besides usage and bookkeeping: a turn with none is a silent failure (pi).
  heard?: boolean
  // Plan 2026-11-18, Grok with `_x.ai/queue/changed`: what Grok itself reports still running for this turn (background
  // commands, subagents) and the wake prompts it announced (`will_wake`) that its queue has not shown yet. These end a
  // held turn; the BackgroundTracker only draws the phone's list.
  grokTasks: Set<string>
  grokSubagents: Set<string>
  grokWakes: Set<string>
  // Prompts Grok's queue listed during this turn that have not run yet (a wake queued behind the running prompt). The
  // empty report Grok sends when it takes one off the queue comes before the one that shows it running, so it stays
  // owed until the queue shows it (or another prompt) running, or its own turn_completed.
  grokQueued: Set<string>
  // A wake off the queue with nothing running that never runs or completes: given up after grokOwedMs (inferred).
  grokOwedMs: number
  grokOwedTimer?: ReturnType<typeof setTimeout>
  // The agent process exited during this turn: every wait ends and the turn fails with the exit line.
  closed?: Error
  // A continuation ended on quiet or its deadline, not on the agent's own signal (recorded as inferred_quiet).
  inferred?: { trigger: "short" | "long"; quietMs?: number }
}

type ToolEntry = { id: string; raw: Json }

type LiveSession = {
  owner?: TurnExecutionIdentity
  id: string
  // session/load replays history as updates; they are not new messages.
  loading: boolean
  modes: string[]
  modeId?: string
  config: Json[]
  usageTotal?: TurnUsage
  turn?: Turn
  contextWindow?: number
  // pi-acp's banner (session/new `_meta.piAcp.startupInfo`), said once as the first chunk of the first prompt.
  startupInfo?: string
  // Plan 2026-11-17: updates with no turn kept for a continuation turn, whether it was offered, a stop's quiet, and the
  // task ids earlier turns tracked (their wake replies still patch the old anchor through the late inbox).
  wake?: Array<{ params: Json; meta: Json }>
  wakeOffered?: boolean
  quiet?: boolean
  pastTasks?: Set<string>
  // A prompt given up on after the cancel grace period that the agent has not answered yet.
  inflight?: Promise<void>
  // Opened by session/fork from AdapterContext.forkFrom: the copy's history is already in it.
  forked?: boolean
  // Grok's latest `_x.ai/queue/changed` for this session: queued prompt ids and the one running (cleared by its own
  // turn_completed). Undefined until Grok sends one: an older Grok keeps the background-count hold.
  grokQueue?: { entries: string[]; running?: string }
  // Prompt ids the queue has shown since the last user prompt: an announced wake already seen is not waited for.
  grokSeen?: Set<string>
  // Copilot's own `session.idle` (opted in): true after it, false once the agent runs again (`assistant.turn_start` of
  // the main agent, or output with no turn). Undefined until this session's first one: a CLI that sends none keeps
  // the quiet rule for continuations (plan 2026-11-18 step 4).
  copilotIdle?: boolean
}

type Connection = { rpc: Rpc; init: Json; sessions: Map<string, LiveSession>; startedAt: number }

// efforts is absent when the agent lists none per model (Copilot): the shared thought_level option applies then.
type ModelMeta = {
  label: string
  efforts?: string[]
  defaultEffort?: string
  contextWindows?: number[]
  // Copilot `_meta.copilotUsage` / `copilotPriceCategory`.
  multiplier?: number
  priceTier?: string
}

// fs/terminal stay off: Grok switches to fs/* callbacks when they are advertised, Copilot ignores
// them, and the agent's own file access keeps behaviour identical to its CLI.
const CLIENT_INFO = {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  clientInfo: { name: "rudderd", version: "0.1.0" },
}

// Copilot sends `_github.com/copilot/sessionEvent` notifications only for the events a client lists here; the
// subagent ones link a subagent's `agentId` (on its chunks and tool calls) to the task call that started it.
// `session.idle` is its authoritative "idle with no background agents or attached shell commands in flight" (its
// session-events schema in 1.0.105 and 1.0.112); `assistant.turn_start` says the main agent runs again (recording idle-background).
const COPILOT_SESSION_EVENT = "github.com/copilot/sessionEvent"
export const COPILOT_CAPABILITIES_META = {
  "github.com/copilot": { events: ["subagent.started", "subagent.completed", "subagent.failed", "session.idle", "assistant.turn_start"] },
}

const COPILOT_CLIENT_INFO = { ...CLIENT_INFO, clientCapabilities: { ...CLIENT_INFO.clientCapabilities, _meta: COPILOT_CAPABILITIES_META } }

const PERMISSION_KINDS: PermissionOptionKind[] = ["allow_once", "allow_always", "reject_once", "reject_always"]
const TOOL_KINDS: ToolKind[] = ["read", "edit", "execute", "search", "fetch", "think", "other"]
const TOOL_FIELDS = ["title", "kind", "status", "content", "locations", "rawInput", "rawOutput"] as const

// Grok `_x.ai/exit_plan_mode` outcomes (approved / rejected); anything else means "revise".
export const PLAN_OPTIONS: PermissionOption[] = [
  { id: "approved", label: "Approve plan", kind: "allow_once" },
  { id: "rejected", label: "Keep planning", kind: "reject_once" },
]

/**
 * `PermissionRequest.match` for an ACP tool call. The raw input and locations say what runs; the title is display
 * text written from them (or, from an agent like Claude's, its free-text description), so it counts only when there
 * is no raw input to go by.
 */
export function acpCallMatch(tool: string, raw: { title?: unknown; rawInput?: unknown; locations?: unknown }): string {
  const rawInput = raw.rawInput ?? null
  return callMatch(tool, {
    ...(rawInput === null ? { title: raw.title ?? null } : {}),
    rawInput: withoutDisplayFields(rawInput),
    locations: raw.locations ?? null,
  })
}

const CANCELLED_PERMISSION = { outcome: { outcome: "cancelled" } }
// The `/` list's probe: how long to wait for the agent's available_commands_update, and how soon an agent that
// advertised none is asked again.
const COMMANDS_WAIT_MS = 2000
const COMMANDS_REPROBE_MS = 5 * 60_000

// Standard PromptResponse.usage field names.
const USAGE_FIELDS: Partial<Record<keyof TurnUsage, string>> = {
  inputTokens: "inputTokens",
  outputTokens: "outputTokens",
  cacheReadTokens: "cachedReadTokens",
  cacheWriteTokens: "cachedWriteTokens",
  reasoningTokens: "thoughtTokens",
}

// stopReasons that end a turn early without the user asking; reported as a failed turn like Claude / Codex do.
// Plan 2026-11-17 D3: a non-Grok continuation ends after this quiet; any continuation by the deadline.
const CONTINUATION_QUIET_MS = 3_000
const CONTINUATION_DEADLINE_MS = 120_000

// Updates that say nothing about the turn's work: a turn of only these produced nothing.
const QUIET_UPDATES = new Set(["usage_update", "session_info_update"])

const STOP_FAILURES: Record<string, string> = {
  refusal: "refused to continue",
  max_tokens: "hit its output token limit",
  max_turn_requests: "hit its per-turn model request limit",
  // ACP v2: the turn failed; PromptResponse.error says why.
  error: "ended with an error",
}

const BILLING_TTL_MS = 60_000
const BILLING_TIMEOUT_MS = 15_000
const PERIOD_MINUTES: Record<string, number> = { USAGE_PERIOD_TYPE_DAILY: 1440, USAGE_PERIOD_TYPE_WEEKLY: 10080 }

// Grok `_x.ai/billing` (checked live 2026-11-05) → one window: the credit share used this period, reset at its end.
// `subscription_tier` is the plan as Grok names it (「SuperGrok Heavy」).
export function grokQuota(result: Json, now = Date.now()): AgentQuota | undefined {
  const config = obj(result.config)
  const used = num(config.creditUsagePercent)
  if (used === undefined) return undefined
  const period = obj(config.currentPeriod)
  const minutes = PERIOD_MINUTES[str(period.type)]
  const reset = Date.parse(str(period.end) || str(config.billingPeriodEnd))
  const plan = str(result.subscription_tier)
  return {
    ...(plan ? { plan } : {}),
    windows: [
      {
        ...(minutes ? { minutes } : {}),
        usedPercent: Math.max(0, Math.min(100, Math.round(used))),
        ...(Number.isFinite(reset) ? { resetsAt: reset } : {}),
      },
    ],
    updatedAt: now,
  }
}

export function createAcpAdapter(options: AcpAdapterOptions): AgentAdapter {
  let lateSink: ((event: LateAgentEvent) => Promise<void>) | undefined
  let continuationSink: ((offer: ContinuationOffer) => boolean) | undefined
  let lateTask: ((agentId: string, nativeSessionId: string, taskId: string) => boolean) | undefined
  const { spec, command } = options
  const label = spec.label
  const executable = command[0] ?? ""
  const initTimeoutMs = options.initTimeoutMs ?? 20_000
  const requestTimeoutMs = options.requestTimeoutMs ?? 60_000
  const cancelGraceMs = options.cancelGraceMs ?? 5_000
  const continuationQuietMs = options.continuationQuietMs ?? CONTINUATION_QUIET_MS
  const continuationDeadlineMs = options.continuationDeadlineMs ?? CONTINUATION_DEADLINE_MS
  const authRetryMs = options.authRetryMs ?? 60_000
  const idleCloseMs = options.idleCloseMs ?? ACP_IDLE_CLOSE_MS
  // Per live session, the timer that closes it once idle; cleared when a turn takes it.
  const idleTimers = new Map<LiveSession, ReturnType<typeof setTimeout>>()

  // `--always-approve` is a process flag. Bypass sessions cannot share a process with sessions that still ask,
  // so Grok keeps two pools. Every other agent uses `plain` only.
  type PoolName = "plain" | "approve"
  type Pool = { connection?: Connection; connecting?: Promise<Connection> }
  const pools = new Map<PoolName, Pool>()
  // Rudder session → the pool that currently holds its ACP session.
  const poolOf = new Map<string, PoolName>()
  // Definitive steer probe for this process. Cleared when the process exits so the next one is asked again.
  let steerResult: "ok" | "missing" | undefined
  let authFailure: { reason: string; at: number } | undefined
  let lastConfig: Json[] = []
  // availableModes of the latest session the agent opened, for the phone's permission list.
  let lastModes: AcpMode[] = []
  const modelMeta = new Map<string, ModelMeta>()
  // Models that refused a reasoning effort since launch; the daemon keeps the list across restarts.
  const effortRefused = new Set<string>()
  // Every agent process not yet exited, including one still initializing, so dispose reaches them all.
  const processes = new Set<Rpc>()
  // Rudder session → ACP sessionId, for forget().
  const sessionOf = new Map<string, string>()
  // The agent's latest available_commands_update, for the composer's `/` list.
  let advertised: AgentCommand[] = []
  // When the `/` list last opened a probe session to learn the commands (a fresh process has none until a turn).
  let commandsProbedAt = 0
  // Session handoff: ACP session id → the updates its session/load is replaying (readExternal).
  const captures = new Map<string, ReplayFrame[]>()

  function missingRequired(): string | undefined {
    return options.requires?.find((name) => !Bun.which(name))
  }

  function otherPool(name: PoolName): PoolName {
    return name === "plain" ? "approve" : "plain"
  }

  function poolName(mode: RudderPermissionMode | undefined): PoolName {
    return spec.id === "grok" && mode === "bypassPermissions" ? "approve" : "plain"
  }

  function commandFor(name: PoolName): string[] {
    if (name !== "approve") return command
    // grok 1.0.70 accepts `--always-approve` on `agent`, before `stdio`.
    // `grok agent stdio --always-approve` exits 2. A test double has no `stdio` token, so the flag stays last.
    const at = command.lastIndexOf("stdio")
    if (at < 0) return [...command, "--always-approve"]
    return [...command.slice(0, at), "--always-approve", ...command.slice(at)]
  }

  function poolState(name: PoolName): Pool {
    let pool = pools.get(name)
    if (!pool) {
      pool = {}
      pools.set(name, pool)
    }
    return pool
  }

  // Newest modification time of the credential files, in ms (0 when none is set or none exists).
  function credentialsChangedAt(): number {
    let newest = 0
    for (const path of options.credentialFiles ?? []) {
      try {
        newest = Math.max(newest, statSync(path).mtimeMs)
      } catch {}
    }
    return newest
  }

  function busy(conn: Connection): boolean {
    for (const live of conn.sessions.values()) if (live.turn || live.inflight) return true
    return false
  }

  function connect(name: PoolName = "plain"): Promise<Connection> {
    const pool = poolState(name)
    const open = pool.connection && !pool.connection.rpc.closed ? pool.connection : undefined
    // Signed in to another account on the computer: the process still holds the old one (an exhausted Grok
    // account kept failing every turn). Its sessions resume on the new process like after an exit.
    if (open && credentialsChangedAt() > open.startedAt && !busy(open)) {
      pool.connection = undefined
      authFailure = undefined
      void open.rpc.close()
    } else if (open) {
      return Promise.resolve(open)
    }
    pool.connecting ??= start(name).finally(() => {
      pool.connecting = undefined
    })
    return pool.connecting
  }

  async function start(name: PoolName): Promise<Connection> {
    const pool = poolState(name)
    const found = executable ? Bun.which(executable) : null
    if (!found) throw copyError(phoneCopy.commandMissing(executable ?? ""))
    const missing = missingRequired()
    if (missing) throw copyError(phoneCopy.commandMissing(missing))
    const sessions = new Map<string, LiveSession>()
    const startedAt = Date.now()
    let rpc: Rpc
    try {
      rpc = spawnRpc(
        commandFor(name),
        {
          onNotification: (method, params, meta) => {
            if (
              method === "session/update" ||
              method === "_x.ai/session/update" ||
              method === "_x.ai/session_notification" ||
              method === "_x.ai/task_backgrounded" ||
              method === "_x.ai/task_completed"
            ) {
              onUpdate(sessions, obj(params), obj(meta))
            }
            if (method === "_x.ai/models/update") absorbModels(obj(params))
            if (method === "_x.ai/queue/changed") grokQueueChanged(sessions, obj(params))
            if (method === COPILOT_SESSION_EVENT) copilotEvent(sessions, obj(params))
          },
          onRequest: (method, params) => onRequest(sessions, method, obj(params)),
          onClose: (error) => {
            processes.delete(rpc)
            // Plan 2026-11-18: the exit is every wait's breaker. A held turn (background work, a continuation) stops
            // waiting; replyTurn reports the closed transport and fails the turn with the exit line.
            for (const live of sessions.values()) {
              if (!live.turn) continue
              live.turn.closed ??= error
              live.turn.releaseHold?.()
            }
            if (pool.connection?.sessions === sessions) {
              pool.connection = undefined
              steerResult = undefined
            }
          },
        },
        { cwd: options.cwd ?? homedir() },
      )
    } catch (error) {
      throw copyError(phoneCopy.agentStartFailed(label, errorMessage(error)))
    }
    processes.add(rpc)
    try {
      const init = obj(await rpc.request("initialize", spec.id === "copilot" ? COPILOT_CLIENT_INFO : CLIENT_INFO, initTimeoutMs))
      checkInitShape(init)
      if (options.expectAgent) {
        const who = identity(init)
        if (!options.expectAgent.test(who)) {
          throw copyError(phoneCopy.agentMismatch(executable ?? "", label, who))
        }
      }
      absorbModels(obj(obj(init._meta).modelState))
      pool.connection = { rpc, init, sessions, startedAt }
      return pool.connection
    } catch (error) {
      await rpc.close()
      const real = resolvedPath(found)
      const detail = copyOf(error) ?? errorMessage(error)
      throw copyError(real ? phoneCopy.agentStartFailedAt(label, executable ?? "", real, detail) : phoneCopy.agentStartFailed(label, detail))
    }
  }

  async function askSteer(rpc: Rpc): Promise<"ok" | "missing" | "unavailable"> {
    if (steerResult) return steerResult
    try {
      // Bounded: `session.get` waits on this probe, and an unanswered probe held the chat's reload open (the sent
      // message and 输入中 stayed hidden until it returned). A timeout counts as unavailable and is asked again later.
      await rpc.request("x.ai/interject", { probe: true }, 3000)
      steerResult = "ok"
      return "ok"
    } catch (error) {
      const code = error instanceof RpcError ? error.code : undefined
      if (code === -32601) {
        steerResult = "missing"
        return "missing"
      }
      return "unavailable"
    }
  }

  // Grok's `_x.ai/billing` on the plain process (the CLI's own extension; nothing is sent to the model), at most once
  // a minute; an older answer is returned at once while a new one is read. A failure shows nothing rather than a
  // stale number.
  let billing: { at: number; value: AgentQuota | undefined } | undefined
  let billingReading: Promise<AgentQuota | undefined> | undefined
  function grokLimits(): Promise<AgentQuota | undefined> {
    if (billing && Date.now() - billing.at < BILLING_TTL_MS) return Promise.resolve(billing.value)
    billingReading ??= connect()
      .then((conn) => call(conn.rpc, "_x.ai/billing", {}, BILLING_TIMEOUT_MS))
      .then((result) => grokQuota(obj(result)))
      .catch((error: unknown) => {
        console.warn(`rudderd: ${label} billing failed: ${errorMessage(error)}`)
        return undefined
      })
      .then((value) => {
        billing = { at: Date.now(), value }
        return value
      })
      .finally(() => {
        billingReading = undefined
      })
    const reading = billingReading
    return billing?.value ? Promise.resolve(billing.value) : reading
  }

  async function call<T = unknown>(rpc: Rpc, method: string, params: unknown, timeoutMs = requestTimeoutMs): Promise<T> {
    try {
      return await rpc.request<T>(method, params, timeoutMs)
    } catch (error) {
      const message = `${label} ${method} failed: ${errorMessage(error)}`
      if (isAuthError(error)) {
        authFailure = { reason: error.message.trim(), at: Date.now() }
        const command = loginCommand(spec.id, error.message)
        throw new AgentError(message, { code: "auth_required", ...(command ? { command } : {}) }, { cause: error })
      }
      throw new Error(message, { cause: error })
    }
  }

  async function openSession(conn: Connection, ctx: WarmContext): Promise<LiveSession> {
    const live = ctx.nativeId ? conn.sessions.get(ctx.nativeId) : undefined
    if (live) {
      if (ctx.executionIdentity && !live.turn) live.owner = { ...ctx.executionIdentity, nativeSessionId: live.id }
      return live
    }
    const caps = obj(conn.init.agentCapabilities)
    // session/resume keeps context without replay (Grok); session/load replays it (Copilot).
    const method = obj(caps.sessionCapabilities).resume ? "session/resume" : caps.loadSession === true ? "session/load" : undefined
    if (ctx.nativeId && method) {
      const session = blankSession(ctx.nativeId, true)
      session.owner = ctx.executionIdentity ? { ...ctx.executionIdentity, nativeSessionId: session.id } : undefined
      conn.sessions.set(session.id, session)
      try {
        absorbSession(session, obj(await call(conn.rpc, method, { sessionId: session.id, cwd: ctx.cwd, mcpServers: [] })))
        return session
      } catch (error) {
        conn.sessions.delete(session.id)
        if (isAuthError((error as Error).cause)) throw error
        // Only the agent saying it cannot reopen the session (a JSON-RPC error) starts a fresh one. A timeout or a dead
        // process says nothing about the session: failing this turn keeps its context for the next, where a silent
        // new session would lose it.
        if (!((error as Error).cause instanceof RpcError)) throw error
        // The agent no longer knows this session (deleted, other machine): start a fresh one.
      } finally {
        session.loading = false
      }
    }
    // A copy forks its source where the agent advertises session/fork (ACP unstable sessionCapabilities.fork).
    // session/load and session/resume reopen the same session, which two Rudder sessions must not share.
    if (!ctx.nativeId && ctx.forkFrom && obj(caps.sessionCapabilities).fork) {
      try {
        const forked = obj(await call(conn.rpc, "session/fork", { sessionId: ctx.forkFrom, cwd: ctx.cwd, mcpServers: [] }))
        const id = str(forked.sessionId)
        if (id) {
          const session = blankSession(id, false)
          session.forked = true
          absorbSession(session, forked)
          conn.sessions.set(id, session)
          return session
        }
      } catch (error) {
        if (isAuthError((error as Error).cause)) throw error
        // The source is gone: a new session gets the transcript instead.
      }
    }
    const result = obj(await call(conn.rpc, "session/new", { cwd: ctx.cwd, mcpServers: [] }))
    const id = str(result.sessionId)
    if (!id) throw new Error(`${label} session/new returned no sessionId`)
    const session = blankSession(id, false)
    absorbSession(session, result)
    conn.sessions.set(id, session)
    return session
  }

  // session/new in an empty temp dir, then session/close when the agent advertises it (Copilot
  // does); otherwise the session is just left unused. No prompt is ever sent.
  async function probeSession(conn: Connection, waitForCommandsMs = 0) {
    const dir = mkdtempSync(join(tmpdir(), "rudder-acp-probe-"))
    try {
      const result = obj(await call(conn.rpc, "session/new", { cwd: dir, mcpServers: [] }))
      const id = str(result.sessionId)
      if (!id) throw new Error(`${label} session/new returned no sessionId`)
      authFailure = undefined
      const available = parseModes(arr(obj(result.modes).availableModes))
      if (available.length) lastModes = available
      // Copilot only lists its models on a session; keep them so the phone can pick one before the first turn.
      if (Array.isArray(result.configOptions)) lastConfig = result.configOptions.map(obj)
      absorbModels(obj(result.models))
      // available_commands_update arrives as a notification shortly after session/new.
      const until = Date.now() + waitForCommandsMs
      while (!advertised.length && Date.now() < until) await Bun.sleep(50)
      if (obj(obj(conn.init.agentCapabilities).sessionCapabilities).close) {
        // Best effort: the probe has already succeeded, a failed close only leaves an idle session.
        await conn.rpc.request("session/close", { sessionId: id }, requestTimeoutMs).catch(() => undefined)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  function absorbSession(session: LiveSession, result: Json) {
    const modes = obj(result.modes)
    if (Array.isArray(modes.availableModes)) {
      const available = parseModes(modes.availableModes)
      session.modes = available.map((mode) => mode.id)
      if (available.length) lastModes = available
    }
    if (typeof modes.currentModeId === "string") session.modeId = modes.currentModeId
    if (Array.isArray(result.configOptions)) setConfig(session, result.configOptions)
    absorbModels(obj(result.models))
    const selection = obj(result._meta).context_window_selection
    if (typeof selection === "number") session.contextWindow = selection
    const banner = obj(obj(result._meta).piAcp).startupInfo
    if (typeof banner === "string" && banner) session.startupInfo = banner
  }

  function setConfig(session: LiveSession, configOptions: unknown[]) {
    session.config = configOptions.map(obj)
    lastConfig = session.config
  }

  // `models` on session/new (Grok, Copilot) or `_meta.modelState` on initialize (Grok): Grok's per-model effort
  // lists and context windows, Copilot's premium-request multiplier and price category.
  function absorbModels(models: Json) {
    for (const item of arr(models.availableModels)) {
      const model = obj(item)
      const id = str(model.modelId)
      if (!id) continue
      const multiplier = copilotMultiplier(obj(model._meta).copilotUsage)
      const priceTier = str(obj(model._meta).copilotPriceCategory)
      const listed = obj(model._meta).reasoningEfforts
      const efforts = arr(listed).map(obj)
      const contextWindows = arr(obj(model._meta).contextWindows)
      const fallback = efforts.find((effort) => effort.default === true)
      modelMeta.set(id, {
        label: str(model.name) || id,
        ...(Array.isArray(listed) ? { efforts: efforts.map((effort) => str(effort.value)).filter(Boolean) } : {}),
        ...(fallback ? { defaultEffort: str(fallback.value) } : {}),
        ...(contextWindows.length > 1 && contextWindows.every((value) => typeof value === "number" && Number.isSafeInteger(value) && value > 0)
          ? { contextWindows: contextWindows as number[] }
          : {}),
        ...(multiplier !== undefined ? { multiplier } : {}),
        ...(priceTier ? { priceTier } : {}),
      })
    }
  }

  async function applySettings(conn: Connection, session: LiveSession, ctx: AdapterContext) {
    const mode = wantedMode(session, ctx.permissionMode)
    if (mode) {
      await call(conn.rpc, "session/set_mode", { sessionId: session.id, modeId: mode })
      session.modeId = mode
    }
    await setAllowAll(conn, session, ctx.permissionMode)
    await setOption(conn, session, "model", ctx.model)
    if (ctx.contextWindow !== undefined) await setContextWindow(conn, session, ctx, ctx.model, ctx.contextWindow)
    const modelId = ctx.model ?? currentModel(session)
    if (modelId && effortRefused.has(modelId)) return
    try {
      await setOption(conn, session, "thought_level", ctx.effort)
    } catch (error) {
      // Copilot lists one reasoning_effort option for every model, then refuses it for some (claude-sonnet-5.5:
      // "This model does not support reasoning_effort configuration"). The turn runs at the model's own level.
      if (!/does not support reasoning_effort/i.test(errorMessage(error))) throw error
      console.warn(`rudderd: ${label} model ${modelId ?? "(default)"} takes no reasoning effort; running without "${ctx.effort}"`)
      if (modelId) {
        effortRefused.add(modelId)
        await ctx.emit({ type: "effortRefused", model: modelId })
      }
    }
  }

  // Copilot bypassPermissions = agent mode + its `allow_all` permissions option; every other mode turns it off.
  async function setAllowAll(conn: Connection, session: LiveSession, mode: RudderPermissionMode) {
    if (!session.config.some((entry) => entry.category === "permissions")) return
    if (mode === "bypassPermissions") {
      // Out of plan / autopilot back to the agent mode, where allow_all is what stops the asking.
      const agent = wantedMode(session, "ask")
      if (agent) {
        await call(conn.rpc, "session/set_mode", { sessionId: session.id, modeId: agent })
        session.modeId = agent
      }
    }
    await setOption(conn, session, "permissions", mode === "bypassPermissions" ? "on" : "off")
  }

  async function setContextWindow(conn: Connection, session: LiveSession, ctx: AdapterContext, modelId: string | undefined, value: number) {
    const id = modelId ?? str(obj(obj(conn.init._meta).modelState).currentModelId)
    const meta = modelMeta.get(id)
    if (!meta?.contextWindows?.includes(value)) {
      throw Object.assign(new Error(`${label} model "${id}" does not offer context window ${value}`), { code: "invalid" })
    }
    if (session.contextWindow === value) return
    await call(conn.rpc, "session/set_model", { sessionId: session.id, modelId: id, _meta: { contextWindow: value } })
    if (session.contextWindow !== value) throw new Error(`${label} did not confirm context window ${value} for model "${id}"`)
    ctx.emit({ type: "contextWindow", value })
  }

  function currentModel(session: LiveSession): string | undefined {
    const value = session.config.find((entry) => entry.category === "model")?.currentValue
    return typeof value === "string" && value ? value : undefined
  }

  async function setOption(conn: Connection, session: LiveSession, category: string, value: string | undefined) {
    if (!value) return
    const option = session.config.find((entry) => entry.category === category)
    if (!option || option.currentValue === value) return
    const values = selectValues(option)
    if (!values.some((entry) => entry.value === value)) {
      throw new Error(`${label} does not offer ${category} "${value}" (available: ${values.map((entry) => entry.value).join(", ")})`)
    }
    const result = obj(await call(conn.rpc, "session/set_config_option", { sessionId: session.id, configId: option.id, value }))
    if (Array.isArray(result.configOptions)) setConfig(session, result.configOptions)
    else option.currentValue = value
  }

  function copilotEvent(sessions: Map<string, LiveSession>, params: Json) {
    const session = sessions.get(str(params.sessionId))
    // The main agent's own state; a subagent's events carry its agentId.
    if (session && !params.agentId && (params.type === "session.idle" || params.type === "assistant.turn_start")) {
      session.copilotIdle = params.type === "session.idle"
      // A continuation ends on it (the prompt of an ordinary turn has its own answer).
      if (session.copilotIdle && session.turn?.continuation && !session.loading) session.turn.releaseHold?.()
      return
    }
    const turn = session?.turn
    const agentId = str(params.agentId)
    const callId = str(obj(params.data).toolCallId)
    if (!turn || !agentId || !callId) return
    const entry = turn.tools.get(callId)
    if (params.type === "subagent.started") {
      turn.copilotAgents.set(agentId, callId)
      // A background task call completes at launch; the card and a background task stay running until the subagent ends.
      const input = obj(entry?.raw.rawInput)
      if (!entry || input.mode !== "background") return
      entry.raw.copilotBackground = agentId
      turn.background.start(agentId, { kind: "subagent", title: str(input.description) || str(input.name), toolId: entry.id })
    } else if (params.type === "subagent.completed" || params.type === "subagent.failed") {
      if (!entry?.raw.copilotBackground || entry.raw.copilotEnded) return
      const completed = params.type === "subagent.completed"
      const output = completed ? (turn.copilotSpeech.get(agentId) ?? "").trim() : str(obj(params.data).error)
      entry.raw.copilotEnded = { status: completed ? "completed" : "failed", ...(output ? { output } : {}) }
      turn.background.end(agentId, completed ? "done" : "failed")
    } else return
    turn.ctx.emit(toolEvent(entry, turn.rejected.has(callId)))
  }

  function onUpdate(sessions: Map<string, LiveSession>, params: Json, meta: Json = {}) {
    meta = { ...obj(params._meta), ...meta }
    const update = obj(params.update)
    const kind = update.sessionUpdate
    // The commands belong to the agent, not one session: a probe session's list counts too.
    if (kind === "available_commands_update") {
      if (Array.isArray(update.availableCommands)) advertised = update.availableCommands.flatMap(availableCommand)
      return
    }
    const session = sessions.get(str(params.sessionId))
    if (!session) return
    // Session handoff (readExternal): everything a session/load replays before its answer is the history to import.
    const capture = captures.get(session.id)
    if (capture && session.loading) {
      capture.push({ update, meta })
      return
    }
    // History an agent replays for session/load, wherever it lands: never a turn's output or a late reply.
    if (meta.isReplay === true || obj(update._meta).isReplay === true) return
    if (kind === "model_changed" && typeof update.context_window_selection === "number") {
      session.contextWindow = update.context_window_selection
      session.turn?.ctx.emit({ type: "contextWindow", value: update.context_window_selection })
      return
    }
    if (kind === "current_mode_update") {
      if (typeof update.currentModeId === "string") {
        // A switch the agent made itself mid-turn (Grok after an approved plan) goes back to the session.
        const turn = session.loading ? undefined : session.turn
        if (turn) turn.heard = true
        // default/agent map to ask. An auto-approval agent has no ask mode; the phone's id is autoApproval.
        const mapped = acpRudderMode(update.currentModeId)
        const mode = spec.capabilities.autoApproval && mapped === "ask" ? "autoApproval" : mapped
        if (turn && update.currentModeId !== session.modeId && mode !== turn.ctx.permissionMode) turn.ctx.emit({ type: "mode", mode })
        session.modeId = update.currentModeId
      }
      return
    }
    if (kind === "config_option_update") {
      if (Array.isArray(update.configOptions)) setConfig(session, update.configOptions)
      return
    }
    // Grok's queue keeps showing a wake as running until that prompt's own turn_completed (the recordings send no idle
    // report after a wake), whether or not a turn is there to take it.
    if (kind === "turn_completed" && session.grokQueue && str(update.prompt_id)) {
      session.grokSeen ??= new Set()
      session.grokSeen.add(str(update.prompt_id))
      if (session.grokQueue.running === str(update.prompt_id)) session.grokQueue.running = undefined
    }
    const promptId = str(meta.promptId)
    const wake = kind === "agent_message_chunk" ? GROK_WAKE_PROMPTS.find((prefix) => promptId.startsWith(prefix)) : undefined
    const taskId = wake ? promptId.slice(wake.length) : ""
    // A turn still holding for that task takes its wake reply, and a continuation turn takes the one it replays; a
    // wake for a task an earlier turn tracked goes to the late inbox. Anything else with no turn waits for a continuation.
    const ownWake = wake !== undefined && Boolean(session.turn?.continuation || session.turn?.absorbed || session.turn?.background.knows(taskId))
    if (ownWake && session.turn && !session.loading) session.turn.waking = true
    const tracked = taskId !== "" && (session.pastTasks?.has(taskId) || Boolean(session.owner && lateTask?.(session.owner.agentId, session.id, taskId)))
    if (!session.loading && !session.turn && !tracked) return collectWake(session, params, meta, update, kind)
    if (!session.loading && kind === "agent_message_chunk" && session.owner && lateSink) {
      if (!session.turn || (wake && !ownWake)) {
        const event: LateAgentEvent = { identity: { ...session.owner, turnId: "" },
          eventId: str(meta.eventId), nativePromptId: promptId,
          ...(wake ? { nativeTaskId: promptId.slice(wake.length) } : {}),
          text: chunkText(update), complete: true, mode: "delta",
          ...(Number.isSafeInteger(meta.chunkId) ? { sequence: meta.chunkId as number } : {}) }
        void lateSink(event).catch(error => console.warn("Late ACP reply persistence failed", error))
        return
      }
    }
    const turn = session.loading ? undefined : session.turn
    if (!turn) return
    turn.activity?.()
    if (!QUIET_UPDATES.has(str(kind)) && !(kind === "agent_message_chunk" && chunkText(update) === session.startupInfo)) turn.heard = true
    if (subagentUpdate(turn, update)) return
    switch (kind) {
      case "auto_compact_started": {
        turn.compactionId = crypto.randomUUID()
        const startedAt = typeof meta.agentTimestampMs === "number" ? meta.agentTimestampMs : Date.now()
        const used = typeof update.tokens_used === "number" ? update.tokens_used : undefined
        const size = typeof update.context_window === "number" ? update.context_window : undefined
        if (used !== undefined && size !== undefined) turn.context = { used, size }
        turn.ctx.emit({
          type: "compaction",
          id: turn.compactionId,
          state: "running",
          trigger: "auto",
          startedAt,
          ...(used !== undefined ? { tokensBefore: used } : {}),
          ...(size !== undefined ? { contextSize: size } : {}),
        })
        return
      }
      case "auto_compact_completed": {
        const id = turn.compactionId ?? crypto.randomUUID()
        const before = typeof update.tokens_before === "number" ? update.tokens_before : undefined
        const after = typeof update.tokens_after === "number" ? update.tokens_after : undefined
        if (after !== undefined && turn.context) turn.context = { used: after, size: turn.context.size }
        turn.ctx.emit({
          type: "compaction",
          id,
          state: "done",
          trigger: "auto",
          ...(before !== undefined ? { tokensBefore: before } : {}),
          ...(after !== undefined ? { tokensAfter: after } : {}),
          ...(turn.context ? { contextSize: turn.context.size } : {}),
        })
        turn.compactionId = undefined
        return
      }
      case "model_changed":
        if (typeof update.context_window_selection === "number") {
          session.contextWindow = update.context_window_selection
          turn.ctx.emit({ type: "contextWindow", value: update.context_window_selection })
        }
        return
      case "agent_message_chunk": {
        const text = chunkText(update)
        // pi-acp says its startup banner (version, update notice) as the first chunk of a session: not a reply.
        if (session.startupInfo && text === session.startupInfo) {
          session.startupInfo = undefined
          return
        }
        // Copilot's own status lines carry no messageId (every model reply has one): "Info: Operation cancelled by
        // user", "Info: Response was interrupted due to a server error. Retrying...".
        if (spec.id === "copilot" && !update.messageId && text.startsWith("Info: ")) return
        // Its own failure lines ("Error: Execution failed: …") are said as a notice, beside the reply.
        if (spec.id === "copilot" && !update.messageId && text.startsWith("Error: ")) {
          breakBlocks(turn)
          turn.ctx.emit({ type: "text", id: crypto.randomUUID(), text, notice: true })
          return
        }
        return onText(turn, text)
      }
      case "agent_thought_chunk":
        return onThought(turn, chunkText(update))
      case "background_tasks":
      case "task_backgrounded":
      case "task_completed":
      case "subagent_spawned":
      case "subagent_finished":
      case "turn_completed":
        if (spec.id === "grok") noteGrokBackground(session, turn, kind, update)
        return
      case "tool_call":
      case "tool_call_update":
        // Copilot keeps its todo list with sql on a `todos` table and sends the same list as a plan: no card for it.
        if (spec.id === "copilot" && kind === "tool_call" && update.kind === "other" && /\btodos\b/i.test(str(obj(update.rawInput).query))) {
          turn.hiddenCalls.add(str(update.toolCallId))
        }
        if (turn.hiddenCalls.has(str(update.toolCallId))) return
        // The card first: a spawn result on the first tool_call links its subagent to this card.
        onTool(turn, update)
        if (spec.id === "grok") noteGrokBackground(session, turn, kind, update)
        return
      case "plan":
        return onPlan(turn, update)
      case "usage_update":
        if (typeof update.used === "number" && typeof update.size === "number") turn.context = { used: update.used, size: update.size }
        return
      case "session_info_update":
        // v112 ①: the agent's own title for the session.
        if (typeof update.title === "string" && update.title.trim()) turn.ctx.emit({ type: "title", title: update.title.trim() })
        return
    }
  }

  /** No turn holds this session: keep what the agent says for a continuation turn, offered on real evidence (D2). */
  function collectWake(session: LiveSession, params: Json, meta: Json, update: Json, kind: unknown) {
    // A subagent's own output (Qwen `parentToolCallId`, Copilot `agentId`) is never the agent speaking to the user.
    const marks = obj(update._meta)
    if (session.quiet || !session.owner || !continuationSink || QUIET_UPDATES.has(str(kind)) || marks.parentToolCallId || obj(marks["github.com/copilot"]).agentId) return
    // Copilot runs again on its own (its tool call can come before its assistant.turn_start).
    if (session.copilotIdle) session.copilotIdle = false
    session.wake ??= []
    session.wake.push({ params, meta })
    if (session.wakeOffered) return
    const text = kind === "agent_message_chunk" ? chunkText(update) : ""
    const spoke = text.trim() !== "" && text !== session.startupInfo
    const finished = kind === "tool_call_update" && (update.status === "completed" || update.status === "failed")
    if (!spoke && !finished) return
    session.wakeOffered = true
    const promptId = str(meta.promptId)
    const wake = GROK_WAKE_PROMPTS.find((prefix) => promptId.startsWith(prefix))
    const key = wake ? promptId.slice(wake.length) : str(meta.eventId) || crypto.randomUUID()
    // Refused (stale, a repeat): nothing will replay it, so it is not kept.
    if (!continuationSink({ identity: { ...session.owner, nativeSessionId: session.id }, key, detail: "", delivery: "buffered" })) {
      session.wake = []
      session.wakeOffered = false
    }
  }

  function replayWake(session: LiveSession, turn: Turn, conn: Connection): Promise<Json> {
    const sessions = conn.sessions
    turn.continuation = true
    const ended = new Promise<Json>((resolve) => {
      let deadline: ReturnType<typeof setTimeout> | undefined
      const finish = () => {
        clearTimeout(deadline)
        clearTimeout(turn.quietTimer)
        resolve({ stopReason: "end_turn" })
      }
      turn.releaseHold = finish
      // Past the deadline the agent may still be running: stop it as the stop button would, so it opens no further turn.
      deadline = setTimeout(() => {
        turn.inferred = { trigger: "long" }
        conn.rpc.notify("session/cancel", { sessionId: session.id })
        // What it still sends after the cancel is not a new continuation (as after a stop: until the next prompt).
        session.quiet = true
        finish()
      }, continuationDeadlineMs)
      // A stop ends it now: nothing was sent to the agent, so there is no prompt to wait out.
      turn.ctx.signal.addEventListener("abort", finish, { once: true })
      // Copilot with `session.idle`: it ends there (copilotEvent), or at once below if Copilot was idle already.
      if (spec.id !== "grok" && session.copilotIdle === undefined) {
        // No end frame in what this agent sends (an older Copilot, another ACP agent): the end is inferred from quiet,
        // and recorded so.
        turn.activity = () => {
          clearTimeout(turn.quietTimer)
          turn.quietTimer = setTimeout(() => {
            turn.inferred = { trigger: "short", quietMs: continuationQuietMs }
            finish()
          }, continuationQuietMs)
        }
        turn.activity()
      }
    })
    if (!foldWake(session, sessions)) turn.releaseHold?.()
    else if (session.copilotIdle) turn.releaseHold?.()
    // Grok with a queue: the replayed wake may already be over (its turn_completed came while no turn was there).
    else if (spec.id === "grok" && session.grokQueue) settleGrok(session)
    return ended
  }

  /** Replays what was kept into the session's current turn (a continuation, or a prompt that arrived first). */
  function foldWake(session: LiveSession, sessions: Map<string, LiveSession>): boolean {
    const frames = session.wake ?? []
    session.wake = []
    session.wakeOffered = false
    if (session.turn && frames.length) session.turn.absorbed = true
    for (const frame of frames) onUpdate(sessions, frame.params, frame.meta)
    return frames.length > 0
  }

  async function onRequest(sessions: Map<string, LiveSession>, method: string, params: Json): Promise<unknown> {
    const session = sessions.get(str(params.sessionId))
    const turn = session && !session.loading ? session.turn : undefined
    if (turn) turn.heard = true
    switch (method) {
      case "session/request_permission":
        return turn ? permission(turn, params) : CANCELLED_PERMISSION
      case "_x.ai/ask_user_question":
        return turn ? question(turn, params) : { outcome: "cancelled" }
      case "_x.ai/mcp/elicit":
        return turn ? grokElicit(turn, params) : { outcome: "cancel" }
      case "_x.ai/exit_plan_mode":
        return turn ? exitPlan(turn, params) : { outcome: "rejected" }
    }
    // fs/* and terminal/* land here: they are not advertised in clientCapabilities.
    throw new RpcError(method, -32601, `rudderd does not implement ${method}`)
  }

  function advertisesClose(conn: Connection): boolean {
    return Boolean(obj(obj(conn.init.agentCapabilities).sessionCapabilities).close)
  }

  function canReopen(conn: Connection): boolean {
    const caps = obj(conn.init.agentCapabilities)
    return Boolean(obj(caps.sessionCapabilities).resume) || caps.loadSession === true
  }

  function wake(session: LiveSession) {
    clearTimeout(idleTimers.get(session))
    idleTimers.delete(session)
  }

  function rest(conn: Connection, session: LiveSession) {
    wake(session)
    if (!advertisesClose(conn) || !canReopen(conn)) return
    const timer = setTimeout(() => {
      idleTimers.delete(session)
      if (conn.rpc.closed || conn.sessions.get(session.id) !== session || session.turn || session.loading || session.inflight) return
      // Off the books first, as releaseSession does: a turn starting meanwhile reopens it.
      conn.sessions.delete(session.id)
      call(conn.rpc, "session/close", { sessionId: session.id }).catch((error: unknown) =>
        console.warn(`rudderd: ${label} idle session/close failed: ${errorMessage(error)}`),
      )
      // Nothing may stay on the --always-approve process once its last session is gone (as in forget).
      const approve = pools.get("approve")?.connection
      if (approve === conn && conn.sessions.size === 0) {
        conn.rpc.close().catch((error: unknown) => console.warn(`rudderd: ${label} always-approve process did not close:`, error))
      }
    }, idleCloseMs)
    timer.unref?.()
    idleTimers.set(session, timer)
  }

  // Take this session off every other pool before the next turn. session/close is per session; the
  // --always-approve process is closed once nobody is left on it, the plain one stays warm like after forget.
  async function releaseSession(ctx: AdapterContext, target: PoolName) {
    const nativeId = sessionOf.get(ctx.sessionId) ?? ctx.nativeId
    for (const [name, pool] of pools) {
      if (name === target) continue
      const conn = pool.connection
      if (!conn || conn.rpc.closed || !nativeId || !conn.sessions.has(nativeId)) continue
      const live = conn.sessions.get(nativeId)
      conn.sessions.delete(nativeId)
      try {
        if (advertisesClose(conn)) await call(conn.rpc, "session/close", { sessionId: nativeId })
      } catch (error) {
        if (live) conn.sessions.set(nativeId, live)
        throw error
      }
      if (name === "approve" && conn.sessions.size === 0 && !conn.rpc.closed) await conn.rpc.close()
    }
    if (poolOf.get(ctx.sessionId) !== target) poolOf.delete(ctx.sessionId)
  }

  async function prepare(ctx: AdapterContext): Promise<{ conn: Connection; session: LiveSession }> {
    const name = poolName(ctx.permissionMode)
    await releaseSession(ctx, name)
    let conn = await connect(name)
    let session = await openSession(conn, ctx)
    if (session.inflight && !(await settles(session.inflight, cancelGraceMs)) && !(await outlast(conn, session, ctx.signal))) {
      // The abandoned prompt still runs and its updates would land in this turn: restart this pool and resume.
      // Sessions on the other pool stay up; outlast waited until no session on this one was mid-turn.
      await conn.rpc.close()
      conn = await connect(name)
      session = await openSession(conn, ctx)
    }
    authFailure = undefined
    sessionOf.set(ctx.sessionId, session.id)
    poolOf.set(ctx.sessionId, name)
    ctx.emit({ type: "native", nativeId: session.id })
    if (session.turn) throw new Error(`${label} session ${session.id} already has a turn running`)
    await applySettings(conn, session, ctx)
    return { conn, session }
  }

  // True once the abandoned prompt settles; false once no other session on this process is mid-turn, so a
  // restart drops nobody's running turn. Killing the process at once cut off every other session's turn.
  async function outlast(conn: Connection, session: LiveSession, signal: AbortSignal): Promise<boolean> {
    while (session.inflight) {
      const busy = [...conn.sessions.values()].flatMap((other) => (other !== session && other.turn ? [other.turn.withdraw.signal] : []))
      if (busy.length === 0 || conn.rpc.closed) return false
      await Promise.race([session.inflight, ...[...busy, signal].map(onceAborted)])
      if (signal.aborted) throw new Error(`${label} turn cancelled while an earlier prompt was still stopping`)
    }
    return true
  }

  // The turn ended without the agent's answer. Its late answer still moves the cumulative usage baseline,
  // so the next turn is not billed for it.
  function abandon(session: LiveSession, prompt: Promise<Json>) {
    const inflight: Promise<void> = prompt
      .then((late) => {
        const usage = obj(obj(late).usage)
        if (options.cumulativeUsage && Object.keys(usage).length) session.usageTotal = pickUsage(usage, USAGE_FIELDS)
      })
      .catch(() => {})
      .finally(() => {
        if (session.inflight === inflight) session.inflight = undefined
      })
    session.inflight = inflight
  }

  function turnUsage(result: Json | undefined, session: LiveSession, turn: Turn): TurnUsage | undefined {
    const usage: TurnUsage = {}
    const standard = obj(result?.usage)
    const grok = obj(obj(result?._meta).usage)
    if (Object.keys(standard).length) {
      let tokens = pickUsage(standard, USAGE_FIELDS)
      if (options.cumulativeUsage) {
        const previous = session.usageTotal ?? {}
        session.usageTotal = tokens
        tokens = diffUsage(tokens, previous)
      }
      Object.assign(usage, tokens)
    } else if (Object.keys(grok).length) {
      Object.assign(
        usage,
        pickUsage(grok, {
          inputTokens: "inputTokens",
          outputTokens: "outputTokens",
          cacheReadTokens: "cachedReadTokens",
          cacheWriteTokens: "cacheCreationTokens",
          reasoningTokens: "reasoningTokens",
        }),
      )
      // xAI bills in USD ticks of 1e-10 dollars (inferred, research §8).
      if (typeof grok.costUsdTicks === "number") usage.costUsd = grok.costUsdTicks / 1e10
    }
    if (turn.context) {
      usage.contextUsed = turn.context.used
      usage.contextSize = turn.context.size
    }
    return Object.keys(usage).length ? usage : undefined
  }

  function modelsFrom(config: Json[]): AgentModel[] {
    const modelOption = config.find((entry) => entry.category === "model")
    const effortOption = config.find((entry) => entry.category === "thought_level")
    const shared = effortOption ? selectValues(effortOption).map((entry) => entry.value) : []
    const listed = modelOption
      ? selectValues(modelOption).map((entry) => ({ id: entry.value, label: entry.name || entry.value }))
      : [...modelMeta].map(([id, meta]) => ({ id, label: meta.label }))
    // Copilot lists "auto" twice in its model option; keep the first of each id.
    const unique = listed.filter((entry, index) => listed.findIndex((other) => other.id === entry.id) === index)
    // Vendor groups only for a list that carries Copilot multipliers; Grok's single-vendor list stays as cards.
    const multiVendor = unique.some(({ id }) => modelMeta.get(id)?.multiplier !== undefined)
    return unique.map(({ id, label: name }) => {
      const meta = modelMeta.get(id)
      const current = modelOption?.currentValue === id && typeof effortOption?.currentValue === "string" ? effortOption.currentValue : undefined
      const refused = effortRefused.has(id)
      const defaultEffort = refused ? undefined : (meta?.defaultEffort ?? current)
      return {
        id,
        label: name,
        efforts: refused ? [] : (meta?.efforts ?? shared),
        ...(defaultEffort ? { defaultEffort } : {}),
        ...(meta?.contextWindows ? { contextWindows: meta.contextWindows } : {}),
        ...(meta?.multiplier !== undefined ? { multiplier: meta.multiplier } : {}),
        ...(meta?.priceTier ? { priceTier: meta.priceTier } : {}),
        ...(multiVendor ? modelLineage(id) : {}),
      }
    })
  }

  async function replyTurn(userText: string, ctx: AdapterContext): Promise<void> {
    ctx.emit({ type: "status", status: "running" })
    // Startup can take seconds (initialize, resume, settings); an abort ends the turn without waiting for it.
    const ready = ctx.signal.aborted ? undefined : await unlessAborted(prepare(ctx), ctx.signal)
    if (!ready || ctx.signal.aborted) {
      ctx.emit({ type: "text", id: crypto.randomUUID(), text: "Cancelled.", notice: true })
      ctx.emit({ type: "status", status: "idle" })
      return
    }
    const { conn, session } = ready
    wake(session)
    if (spec.id === "grok") {
      const before = steerResult
      const probed = await askSteer(conn.rpc)
      if (probed !== "unavailable" && before !== probed) ctx.emit({ type: "steer", result: probed })
    }
    const turn: Turn = {
      ctx,
      wrote: false,
      tools: new Map(),
      rejected: new Set(),
      withdraw: new AbortController(),
      background: new BackgroundTracker(ctx.emit, () => turn.paused),
      paused: false,
      followupSettled: false,
      subagentCalls: new Map(),
      childCalls: new Set(),
      copilotAgents: new Map(),
      hiddenCalls: new Set(),
      copilotSpeech: new Map(),
      grokTasks: new Set(),
      grokSubagents: new Set(),
      grokWakes: new Set(),
      grokQueued: new Set(),
      grokOwedMs: continuationDeadlineMs,
    }
    session.owner = ctx.executionIdentity ? { ...ctx.executionIdentity, nativeSessionId: session.id } : undefined
    session.turn = turn
    const cancel = () => conn.rpc.notify("session/cancel", { sessionId: session.id })
    ctx.signal.addEventListener("abort", cancel, { once: true })
    let result: Json | undefined
    const images = modelAcceptsImages(spec.id, ctx.model ?? "", acpAcceptsImages(conn.init))
    const text = ctx.forkFrom && !ctx.nativeId && !session.forked ? withCarryOver(userText, ctx.carryOver) : userText
    const blocks = ctx.continuation ? [] : await acpPrompt(text, ctx.images ?? [], images.accepts)
    if (!ctx.continuation) {
      session.quiet = false
      session.grokSeen = undefined
      // The agent's own run kept for a continuation goes first, in this turn (the continuation is dropped upstream).
      foldWake(session, conn.sessions)
    }
    // Plan 2026-11-17 D3: a continuation sends no prompt. It replays what was kept and ends on Grok's own
    // turn_completed (releaseHold), on a quiet spell for other agents, or at the deadline.
    const prompt = ctx.continuation
      ? replayWake(session, turn, conn)
      : call<Json>(conn.rpc, "session/prompt", { sessionId: session.id, prompt: blocks }, 0)
    let answered = false
    const settle = () => {
      answered = true
    }
    prompt.then(settle, settle)
    try {
      try {
        result = await untilCancelled(prompt, ctx.signal, cancelGraceMs)
      } catch (error) {
        // Copilot fails every later prompt the same way until its process is replaced (T3 Code's finding).
        if (spec.id === "copilot" && copilotLostSession(error)) {
          await conn.rpc.close()
          // Replaced on purpose and run again: not a closed transport for this turn.
          turn.closed = undefined
          throw Object.assign(error as Error, { lostSession: { nativeId: session.id, heard: turn.heard ?? false } })
        }
        throw error
      }
      // Grok's first end_turn can arrive while a background command or subagent is still open. Keep the turn so the
      // later output and the CLI's own follow-up sentence land here. Other ACP agents close on this return. With a
      // queue report the hold ends when Grok's queue is idle and nothing it reported running or announced is left
      // (plan 2026-11-18); without one (older Grok), when the background count is 0 at a turn_completed.
      const queued = session.grokQueue !== undefined
      const holds = queued ? !grokIdle(session, turn) : turn.background.open > 0 && !turn.followupSettled
      if (spec.id === "grok" && !ctx.signal.aborted && !turn.closed && holds) {
        turn.paused = true
        const held = new Promise<void>((resolve) => {
          turn.releaseHold = resolve
        })
        turn.background.publish()
        if (queued || !(turn.followupSettled && turn.background.open === 0)) await untilCancelled(held, ctx.signal, cancelGraceMs)
      }
      if (turn.closed && !ctx.signal.aborted) throw turn.closed
    } catch (error) {
      // Plan 2026-11-18: the agent process is gone (a prompt in flight, a hold, a continuation): say so to the turn's
      // health check, with the exit line as the reason.
      if (turn.closed && !ctx.signal.aborted) {
        ctx.emit({ type: "lifecycle", phase: "working", transport: "closed", pendingFinalization: false, detail: errorMessage(error) })
      }
      throw error
    } finally {
      ctx.signal.removeEventListener("abort", cancel)
      clearTimeout(turn.quietTimer)
      clearTimeout(turn.grokOwedTimer)
      session.pastTasks ??= new Set()
      for (const id of turn.background.ids()) session.pastTasks.add(id)
      session.turn = undefined
      turn.withdraw.abort()
      endTurn(turn)
      if (!answered) abandon(session, prompt)
      rest(conn, session)
    }
    const usage = turnUsage(result ? obj(result) : undefined, session, turn)
    if (usage) ctx.emit({ type: "usage", usage })
    if (ctx.signal.aborted && !turn.wrote) ctx.emit({ type: "text", id: crypto.randomUUID(), text: "Cancelled.", notice: true })
    const stopReason = str(result?.stopReason)
    // pi on a refused key ends the turn cleanly with nothing at all: say so instead of an empty reply. Only pi is
    // known to fail this way; another agent's empty turn (a slash command) is not a sign-in problem.
    if (spec.id === "pi" && stopReason === "end_turn" && !ctx.signal.aborted && !turn.heard) {
      throw copyError(phoneCopy.agentSilentTurn(label))
    }
    if (STOP_FAILURES[stopReason] && !ctx.signal.aborted) {
      const reason = str(obj(result?.error).message)
      throw new Error(`${label} ${STOP_FAILURES[stopReason]}${reason ? `: ${reason}` : ""} (stopReason ${stopReason})`)
    }
    ctx.emit({ type: "replyDisposition", value: turn.wrote ? "unknown" : "absent", nativeMessageIds: [] })
    ctx.emit({ type: "status", status: "idle" })
    ctx.emit({ type: "lifecycle", phase: "terminal", terminalStatus: ctx.signal.aborted ? "interrupted" : "completed", pendingFinalization: false,
      ...(turn.inferred && !ctx.signal.aborted ? { inferred: turn.inferred } : {}) })
  }

  return {
    setLateEventSink(sink) { lateSink = sink },
    setContinuationSink(sink) {
      continuationSink = sink
    },
    setLateTaskLookup(lookup) {
      lateTask = lookup
    },
    cancelContinuation(sessionId) {
      for (const pool of pools.values()) {
        for (const live of pool.connection?.sessions.values() ?? []) {
          if (live.owner?.sessionId !== sessionId) continue
          live.wake = []
          live.wakeOffered = false
          live.quiet = true
        }
      }
    },
    spec,
    forks: true,
    async listCommands() {
      // After a rudderd restart the agent has not run yet, so nothing has advertised its commands: ask a probe
      // session once (no prompt, nothing billed). An agent with no commands is asked again after a while.
      if (!advertised.length && Date.now() - commandsProbedAt > COMMANDS_REPROBE_MS) {
        commandsProbedAt = Date.now()
        try {
          await probeSession(await connect(), COMMANDS_WAIT_MS)
        } catch (error) {
          console.warn(`rudderd: ${label} commands probe failed: ${errorMessage(error)}`)
        }
      }
      return advertised
    },
    async detect() {
      if (!executable || !Bun.which(executable)) return unavailable(phoneCopy.commandMissing(executable ?? ""))
      const missing = missingRequired()
      if (missing) return unavailable(phoneCopy.commandMissing(missing))
      if (authFailure && credentialsChangedAt() > authFailure.at) authFailure = undefined
      if (authFailure && Date.now() - authFailure.at < authRetryMs) return { available: false, reason: authFailure.reason }
      const lock = options.permissionLock?.()
      const ok = lock ? { available: true, permissionLock: lock } : { available: true }
      if (!options.expectAgent && !options.probeSession) return ok
      try {
        const conn = await connect()
        if (options.probeSession) await probeSession(conn)
        return ok
      } catch (error) {
        // An auth failure is reported verbatim (the agent's own text), like after a failed turn.
        if (isAuthError((error as Error).cause) && authFailure) return { available: false, reason: authFailure.reason }
        const copy = copyOf(error)
        return copy ? unavailable(copy) : { available: false, reason: errorMessage(error) }
      }
    },
    listPermissionModes(): PermissionModeInfo[] | undefined {
      return lastModes.length ? acpModeInfo(lastModes) : undefined
    },
    async listModels() {
      // Without a session the list can still come from initialize (Grok `_meta.modelState`).
      if (!lastConfig.length && !modelMeta.size) await connect()
      // Copilot names its models only on a session: open the throwaway probe session once.
      if (!lastConfig.length && !modelMeta.size && options.probeSession) await probeSession(await connect())
      return modelsFrom(lastConfig)
    },
    ...(spec.id === "grok" ? { limits: grokLimits } : {}),
    async setMode(sessionId, mode) {
      // Grok's bypassPermissions is a process flag: it moves pools at the next turn, never mid-turn.
      const pool = poolOf.get(sessionId)
      if (!pool || pool !== poolName(mode)) return false
      const conn = pools.get(pool)?.connection
      const nativeId = sessionOf.get(sessionId)
      const session = nativeId ? conn?.sessions.get(nativeId) : undefined
      if (!conn || conn.rpc.closed || !session?.turn) return false
      const target = wantedMode(session, mode)
      if (target) {
        await call(conn.rpc, "session/set_mode", { sessionId: session.id, modeId: target })
        session.modeId = target
      }
      await setAllowAll(conn, session, mode)
      return true
    },
    async probeSteer() {
      // Only Grok is asked. The other ACP agents publish steer: false and have no steer(),
      // so reporting "ok" made the phone offer steer and message.steer then threw.
      if (spec.id !== "grok") return "unavailable" as const
      if (steerResult) return steerResult
      const live = pools.get("plain")?.connection ?? [...pools.values()].find((item) => item.connection && !item.connection.rpc.closed)?.connection
      if (!live || live.rpc.closed) return "unavailable" as const
      return askSteer(live.rpc)
    },
    warm(ctx) {
      // Start-up and resume (about 1.3 s for a long Grok session) before the first prompt. A session not yet
      // created only gets its process: session/new here would leave an id the daemon never stores.
      const name = poolName(ctx.permissionMode)
      void (async () => {
        const conn = await connect(name)
        if (ctx.nativeId && !conn.sessions.has(ctx.nativeId) && poolOf.get(ctx.sessionId) !== otherPool(name)) {
          rest(conn, await openSession(conn, ctx))
        }
      })().catch((error) => console.warn(`rudderd: ${label} warm failed: ${errorMessage(error)}`))
    },
    async reply(userText, ctx) {
      try {
        await replyTurn(userText, ctx)
      } catch (error) {
        // A lost Copilot session (its process already replaced) before the agent said anything: run the turn again.
        const lost = (error as { lostSession?: { nativeId: string; heard: boolean } }).lostSession
        if (!lost || lost.heard || ctx.signal.aborted) throw error
        await replyTurn(userText, { ...ctx, nativeId: lost.nativeId })
      }
    },
    // Session handoff P3: agents that advertise session/list and loadSession (Grok, Copilot). ACP has no in-use
    // signal, so nothing here says whether the CLI on the computer still has one open. A session whose folder is
    // gone is left out: session/load fails there (Copilot "Directory does not exist").
    async listExternal({ since, limit }) {
      if (!executable || !Bun.which(executable) || missingRequired()) {
        throw new HandoffUnsupported("not_installed", `${executable || label} is not installed`)
      }
      const conn = await connect()
      const caps = obj(conn.init.agentCapabilities)
      if (!obj(caps.sessionCapabilities).list || caps.loadSession !== true) {
        throw new HandoffUnsupported("no_session_list", `${label} cannot list and reload its sessions`)
      }
      const kept: ExternalSession[] = []
      let cursor: string | undefined
      for (let page = 0; page < HANDOFF_PAGES && kept.length < limit; page += 1) {
        const result = obj(await call(conn.rpc, "session/list", cursor ? { cursor } : {}))
        let older = false
        for (const raw of arr(result.sessions)) {
          const entry = obj(raw)
          const nativeId = str(entry.sessionId)
          const cwd = str(entry.cwd)
          const updatedAt = Date.parse(str(entry.updatedAt))
          if (!nativeId || !cwd) continue
          if (!Number.isFinite(updatedAt) || updatedAt < since) {
            older = true
            continue
          }
          if (!existsSync(cwd)) continue
          kept.push({ nativeId, title: str(entry.title).trim(), cwd, updatedAt })
          if (kept.length >= limit) break
        }
        cursor = str(result.nextCursor) || undefined
        if (older || !cursor) break
      }
      return kept
    },
    // session/load replays the whole conversation before it answers (ACP Session Setup); that replay is the history.
    // The session is closed after where the agent can close it; the next turn reopens it as usual.
    async readExternal(nativeId, cwd) {
      const conn = await connect()
      const caps = obj(conn.init.agentCapabilities)
      if (caps.loadSession !== true) throw new HandoffUnsupported("no_session_list", `${label} cannot reload its sessions`)
      if (conn.sessions.has(nativeId)) {
        throw Object.assign(new Error(`${label} session ${nativeId} is open in Rudder`), { code: "in_use" })
      }
      const session = blankSession(nativeId, true)
      conn.sessions.set(nativeId, session)
      const frames: ReplayFrame[] = []
      captures.set(nativeId, frames)
      try {
        absorbSession(session, obj(await call(conn.rpc, "session/load", { sessionId: nativeId, cwd, mcpServers: [] })))
      } catch (error) {
        conn.sessions.delete(nativeId)
        throw error
      } finally {
        captures.delete(nativeId)
        session.loading = false
      }
      if (advertisesClose(conn)) {
        conn.sessions.delete(nativeId)
        await call(conn.rpc, "session/close", { sessionId: nativeId }).catch((error: unknown) =>
          console.warn(`rudderd: ${label} session/close after an import read failed: ${errorMessage(error)}`),
        )
      } else {
        rest(conn, session)
      }
      return acpReplayEntries(spec.id, nativeId, frames)
    },
    processes() {
      // Includes a process still initializing. Each pool only lists the sessions on its own process.
      return [...processes]
        .filter((rpc) => !rpc.closed)
        .map((rpc) => {
          const live = [...pools.values()].find((pool) => pool.connection?.rpc === rpc)?.connection?.sessions
          const sessionIds = live ? [...sessionOf].filter(([, id]) => live.has(id)).map(([sessionId]) => sessionId) : []
          return { agent: spec.id, pid: rpc.pid, sessionIds, shared: true }
        })
    },
    forget(sessionId) {
      const id = sessionOf.get(sessionId)
      const owner = poolOf.get(sessionId)
      sessionOf.delete(sessionId)
      poolOf.delete(sessionId)
      if (!id) return
      for (const [name, pool] of pools) {
        // ACP ids are per process, so two pools can both hold an "sess-1": only touch the pool this session is on.
        if (owner && name !== owner) continue
        const conn = pool.connection
        if (!conn?.sessions.delete(id)) continue
        // Nothing may stay on the --always-approve process once its last session is gone (deleted, archived).
        // The plain process stays warm for the next session.
        if (name === "approve" && conn.sessions.size === 0 && !conn.rpc.closed) {
          conn.rpc.close().catch((error: unknown) => console.warn(`rudderd: ${label} always-approve process did not close:`, error))
        }
      }
    },
    async dispose() {
      for (const timer of idleTimers.values()) clearTimeout(timer)
      idleTimers.clear()
      for (const pool of pools.values()) pool.connection = undefined
      await Promise.all([...processes].map((rpc) => rpc.close()))
    },
  }
}

function blankSession(id: string, loading: boolean): LiveSession {
  return { id, loading, modes: [], config: [] }
}

// ask and autoApproval → the agent's default/agent (goose: approve) mode, plan → plan. Agents that list no modes (Grok)
// take the bare ids; an unknown current mode is left alone. acceptEdits has no ACP mapping.
// Grok bypassPermissions is a launch flag, not an advertised mode, so this stays undefined and no set_mode is sent.
export function wantedMode(session: Pick<LiveSession, "modes" | "modeId">, mode: RudderPermissionMode): string | undefined {
  const pick = (names: string[]) => (session.modes.length ? session.modes.find((id) => names.includes(acpShortId(id))) : names[0])
  let target: string | undefined
  if (mode === "plan") target = pick(["plan"])
  else if (mode === "ask" || mode === "autoApproval") target = session.modeId !== undefined ? pick(ACP_ASK_IDS) : undefined
  // Any other id is one the agent advertised itself (acpModeInfo keeps it verbatim).
  else target = session.modes.find((id) => id === mode)
  return target && target !== session.modeId ? target : undefined
}

function parseModes(list: unknown[]): AcpMode[] {
  return list.flatMap((item) => {
    const mode = obj(item)
    const id = str(mode.id)
    if (!id) return []
    const name = str(mode.name)
    const description = str(mode.description)
    return [{ id, ...(name ? { name } : {}), ...(description ? { description } : {}) }]
  })
}

function onText(turn: Turn, text: string) {
  if (!text) return
  resumeSpeech(turn)
  closeThought(turn)
  if (!turn.text) {
    // Copilot interleaves "Info: <path>" notes into file edits; they are not part of the reply.
    if (/^Info: \S/.test(text) && [...turn.tools.values()].some((entry) => isOpen(entry.raw))) return
    turn.text = { id: crypto.randomUUID(), text: "" }
  }
  turn.text.text += text
  turn.wrote = true
  turn.ctx.emit({ type: "text", id: turn.text.id, text: turn.text.text })
}

function onThought(turn: Turn, text: string) {
  if (!text) return
  resumeSpeech(turn)
  turn.text = undefined
  turn.thought ??= { id: crypto.randomUUID(), text: "" }
  turn.thought.text += text
  turn.ctx.emit({ type: "reasoning", id: turn.thought.id, text: turn.thought.text, done: false })
}

// Qwen Code streams its subagent inside the parent session: speech, thoughts and tool calls carry
// `_meta.parentToolCallId` = the Agent call. They belong to that card, whose result is the subagent's answer, not to
// the parent's reply or card list. Later lifecycle updates of a child call drop the marker, so the ids are kept.
// Copilot marks them `_meta["github.com/copilot"].agentId`, which `subagent.started` maps to the task call.
function subagentUpdate(turn: Turn, update: Json): boolean {
  const callId = str(update.toolCallId)
  if (callId && turn.childCalls.has(callId)) return true
  const meta = obj(update._meta)
  const agentId = str(obj(meta["github.com/copilot"]).agentId)
  const parent = str(meta.parentToolCallId) || turn.copilotAgents.get(agentId) || ""
  // A Copilot subagent this turn did not start (one left running by a stopped turn): never this turn's reply or cards.
  if (agentId && !parent) return true
  if (!parent || !turn.tools.has(parent)) return false
  if (callId) turn.childCalls.add(callId)
  if (agentId && update.sessionUpdate === "agent_message_chunk") turn.copilotSpeech.set(agentId, (turn.copilotSpeech.get(agentId) ?? "") + chunkText(update))
  return true
}

// Quiet until the first speech has paused on an open background task. Tool updates do not resume.
function resumeSpeech(turn: Turn) {
  if (!turn.paused) return
  turn.paused = false
  turn.ctx.emit({ type: "status", status: "running" })
}

const GROK_TASK_DONE = new Set(["completed", "failed", "killed", "cancelled"])
// Grok's own follow-up prompt after a background command or a subagent ends: `_meta.promptId` is prefix + task id.
const GROK_WAKE_PROMPTS = ["task-completed-", "subagent-completed-"]
const GROK_SUBAGENT_ID = /^Subagent started in background\.\nsubagent_id: (\S+)$/m

/** Grok's `_x.ai/queue/changed` (plan 2026-11-18). Subagents report their own session ids: only sessions Rudder opened count. */
function grokQueueChanged(sessions: Map<string, LiveSession>, params: Json) {
  const session = sessions.get(str(params.sessionId))
  if (!session) return
  const entries = arr(params.entries).map((entry) => str(obj(entry).id)).filter(Boolean)
  const running = str(params.runningPromptId)
  session.grokQueue = { entries, ...(running ? { running } : {}) }
  session.grokSeen ??= new Set()
  const turn = session.turn
  for (const id of running ? [...entries, running] : entries) {
    session.grokSeen.add(id)
    turn?.grokWakes.delete(id)
  }
  for (const id of entries) turn?.grokQueued.add(id)
  // Off the queue with a prompt running: it runs now, or Grok folded it into the running prompt. Off the queue with
  // nothing running: Grok is about to start it.
  if (turn && running) for (const id of turn.grokQueued) if (!entries.includes(id)) turn.grokQueued.delete(id)
  if (turn) watchOwedWake(session, turn)
  settleGrok(session)
}

/** Prompts Grok took off its queue that no running prompt or turn_completed has shown since. */
function owedWakes(session: LiveSession, turn: Turn): string[] {
  const queue = session.grokQueue
  if (!queue || queue.running) return []
  return [...turn.grokQueued].filter((id) => !queue.entries.includes(id))
}

/** An owed wake that never shows up again would hold the turn until a stop: give it up at the deadline. */
function watchOwedWake(session: LiveSession, turn: Turn) {
  if (owedWakes(session, turn).length === 0) {
    clearTimeout(turn.grokOwedTimer)
    turn.grokOwedTimer = undefined
    return
  }
  turn.grokOwedTimer ??= setTimeout(() => {
    turn.grokOwedTimer = undefined
    const owed = session.turn === turn ? owedWakes(session, turn) : []
    if (owed.length === 0) return
    for (const id of owed) turn.grokQueued.delete(id)
    turn.inferred = { trigger: "long" }
    settleGrok(session)
  }, turn.grokOwedMs)
}

/** Grok with a queue report: idle with nothing queued, nothing it reported running and no announced wake left. */
function grokIdle(session: LiveSession, turn: Turn): boolean {
  const queue = session.grokQueue
  return (
    queue !== undefined &&
    queue.entries.length === 0 &&
    !queue.running &&
    turn.grokQueued.size === 0 &&
    turn.grokTasks.size === 0 &&
    turn.grokSubagents.size === 0 &&
    turn.grokWakes.size === 0
  )
}

/** Ends a held turn (after its prompt returned, or a continuation) once Grok reports itself idle. */
function settleGrok(session: LiveSession) {
  const turn = session.loading ? undefined : session.turn
  if (!turn?.releaseHold || !grokIdle(session, turn)) return
  turn.followupSettled = true
  turn.releaseHold()
}

function noteGrokBackground(session: LiveSession, turn: Turn, kind: unknown, update: Json) {
  trackGrok(session, turn, kind, update)
  if (session.grokQueue) settleGrok(session)
}

// Grok only. rawInput.is_background stays false on a real background command, so it is not a signal.
function trackGrok(session: LiveSession, turn: Turn, kind: unknown, update: Json) {
  // An older Grok without queue reports: the background count and turn_completed end the hold (pre-2026-11-18).
  const legacy = session.grokQueue === undefined
  const expectWake = (promptId: string) => {
    if (!session.grokSeen?.has(promptId) && session.grokQueue?.running !== promptId) turn.grokWakes.add(promptId)
  }
  const start = (id: string, command: unknown, callId?: string, taskKind: BackgroundTaskKind = "command") => {
    const entry = callId ? turn.tools.get(callId) : undefined
    const title = str(command) || str(obj(entry?.raw.rawInput).command) || str(obj(update.rawInput).command)
    turn.background.start(id, { kind: taskKind, title: title.split("\n")[0] ?? "", ...(entry ? { toolId: entry.id } : {}) })
    if (turn.background.has(id)) (taskKind === "subagent" ? turn.grokSubagents : turn.grokTasks).add(id)
  }
  if (kind === "tool_call" || kind === "tool_call_update") {
    const callId = str(update.toolCallId)
    const raw = obj(update.rawOutput)
    const spawned = GROK_SUBAGENT_ID.exec(str(raw.text))?.[1]
    if (spawned && callId) {
      // subagent_spawned usually comes first; this links its task to the card either way.
      turn.subagentCalls.set(spawned, callId)
      const entry = turn.tools.get(callId)
      if (turn.background.has(spawned)) {
        if (entry) turn.background.attachTool(spawned, entry.id)
      } else start(spawned, obj(entry?.raw.rawInput).description, callId, "subagent")
      return
    }
    if (str(raw.type) !== "BackgroundTaskStarted") return
    const id = str(raw.task_id)
    if (id) start(id, undefined, callId || undefined)
    return
  }
  if (kind === "subagent_spawned") {
    const id = str(update.subagent_id)
    const callId = turn.subagentCalls.get(id)
    if (id) start(id, update.description, callId, "subagent")
    return
  }
  if (kind === "subagent_finished") {
    const id = str(update.subagent_id)
    // Another turn's subagent: neither its card nor this turn's hold.
    if (!id || !turn.background.knows(id)) return
    const callId = turn.subagentCalls.get(id)
    const entry = callId ? turn.tools.get(callId) : undefined
    const output = str(update.output)
    if (entry && output) {
      entry.raw.content = [{ type: "content", content: { type: "text", text: output } }]
      turn.ctx.emit(toolEvent(entry, turn.rejected.has(callId!)))
    }
    const status = str(update.status)
    turn.background.end(id, status === "completed" ? "done" : status === "cancelled" || status === "killed" ? "cancelled" : "failed")
    turn.grokSubagents.delete(id)
    if (update.will_wake === true) expectWake(`subagent-completed-${id}`)
    // No wake prompt follows (will_wake false): nothing else will send the turn_completed that releases a held turn.
    if (legacy && update.will_wake !== true && turn.releaseHold && !turn.waking && turn.background.open === 0) {
      turn.followupSettled = true
      turn.releaseHold?.()
    }
    return
  }
  if (kind === "task_backgrounded") {
    const id = str(update.task_id)
    if (id) start(id, update.command, str(update.tool_call_id) || undefined)
    return
  }
  if (kind === "task_completed") {
    const snapshot = obj(update.task_snapshot)
    const id = str(snapshot.task_id) || str(update.task_id)
    const exit = num(snapshot.exit_code)
    if (id) turn.background.end(id, exit !== undefined && exit !== 0 ? "failed" : "done", exit)
    if (id) turn.grokTasks.delete(id)
    if (id && update.will_wake === true) expectWake(`task-completed-${id}`)
    return
  }
  if (kind === "background_tasks") {
    // Grok's whole list: a task it no longer lists as running (any other status, or gone) is not running.
    const listed = new Set(arr(update.tasks).map(obj).filter((task) => str(task.status) === "running").map((task) => str(task.task_id)))
    for (const id of turn.grokTasks) if (!listed.has(id)) turn.grokTasks.delete(id)
    for (const task of arr(update.tasks).map(obj)) {
      const id = str(task.task_id)
      if (!id) continue
      const status = str(task.status)
      const exit = num(task.exit_code)
      if (status === "running") start(id, task.command)
      else if (status === "failed" || (status === "completed" && exit !== undefined && exit !== 0)) turn.background.end(id, "failed", exit)
      else if (status === "killed" || status === "cancelled") turn.background.end(id, "cancelled", exit)
      else if (GROK_TASK_DONE.has(status)) turn.background.end(id, "done", exit)
    }
    return
  }
  // A later turn_completed of this session: an announced wake ran, or Grok folded it into the prompt it was running.
  if (kind === "turn_completed") {
    turn.grokWakes.clear()
    turn.grokQueued.delete(str(update.prompt_id))
  }
  if (!legacy) return
  // The first turn_completed still has ids open, so it does not release. response_completed is not a close.
  if (kind === "turn_completed") turn.waking = false
  if (kind === "turn_completed" && turn.background.open === 0) {
    turn.followupSettled = true
    turn.releaseHold?.()
  }
}

function closeThought(turn: Turn) {
  if (turn.thought) turn.ctx.emit({ type: "reasoning", id: turn.thought.id, text: turn.thought.text, done: true })
  turn.thought = undefined
}

// Anything that is not a text chunk ends the current text and thought blocks.
function breakBlocks(turn: Turn) {
  closeThought(turn)
  turn.text = undefined
}

function onTool(turn: Turn, update: Json) {
  const callId = str(update.toolCallId)
  if (!callId) return
  breakBlocks(turn)
  let entry = turn.tools.get(callId)
  if (!entry) {
    entry = { id: crypto.randomUUID(), raw: {} }
    turn.tools.set(callId, entry)
  }
  mergeTool(entry.raw, update)
  turn.ctx.emit(toolEvent(entry, turn.rejected.has(callId)))
}

function onPlan(turn: Turn, update: Json) {
  breakBlocks(turn)
  const entries: PlanEntry[] = arr(update.entries)
    .map(obj)
    .filter((entry) => typeof entry.content === "string")
    .map((entry) => ({ content: entry.content as string, status: planStatus(entry.status) }))
  turn.planId ??= crypto.randomUUID()
  turn.ctx.emit({ type: "plan", id: turn.planId, entries })
}

// The turn is over: whatever the agent left pending or running will not finish now.
function endTurn(turn: Turn) {
  closeThought(turn)
  for (const [callId, entry] of turn.tools) {
    if (!isOpen(entry.raw)) continue
    if (entry.raw.copilotBackground) turn.background.end(str(entry.raw.copilotBackground), "cancelled")
    turn.ctx.emit({ ...toolEvent(entry, turn.rejected.has(callId)), status: "cancelled" })
  }
}

async function permission(turn: Turn, params: Json) {
  breakBlocks(turn)
  const toolCall = obj(params.toolCall)
  const callId = str(toolCall.toolCallId)
  const card = turn.tools.get(callId)
  const raw = { ...(card?.raw ?? {}) }
  mergeTool(raw, toolCall)
  const view = toolEvent({ id: callId, raw }, false)
  const options: PermissionOption[] = arr(params.options)
    .map(obj)
    .filter((option) => typeof option.optionId === "string" && PERMISSION_KINDS.includes(option.kind as PermissionOptionKind))
    .map((option) => ({ id: option.optionId as string, label: str(option.name) || (option.optionId as string), kind: option.kind as PermissionOptionKind }))
  const choice = await turn.ctx.askPermission(
    {
      tool: view.tool,
      title: view.title,
      detail: view.detail,
      kind: view.kind,
      options,
      ...(view.diffs ? { diffs: view.diffs } : {}),
      // Only when a tool_call already opened the card (always so in the Grok / Copilot captures).
      ...(card ? { toolId: card.id } : {}),
      match: acpCallMatch(view.tool, raw),
    },
    turn.withdraw.signal,
  )
  const option = options.find((entry) => entry.id === choice)
  if (!option) return CANCELLED_PERMISSION
  if (option.kind === "reject_once" || option.kind === "reject_always") turn.rejected.add(callId)
  return { outcome: { outcome: "selected", optionId: option.id } }
}

// Grok `_x.ai/ask_user_question`: answers are { question: label }; multi-select is untested, so
// several labels are sent comma-joined.
async function question(turn: Turn, params: Json) {
  breakBlocks(turn)
  const answers = await turn.ctx.askQuestion({ questions: parseQuestions(params.questions, true) }, turn.withdraw.signal)
  if (!answers) return { outcome: "cancelled" }
  return { outcome: "accepted", answers: flattenAnswers(answers) }
}

// Grok `_x.ai/mcp/elicit`: an MCP server's form. Answered `{outcome, content}` (Grok 1.0.88 reads an MCP-style
// `action` as malformed and cancels the tool call).
async function grokElicit(turn: Turn, params: Json) {
  breakBlocks(turn)
  const server = str(params.serverName)
  const message = str(params.message)
  const form = params.mode === "form" ? formQuestions(message, params.requestedSchema) : undefined
  if (!form) {
    const copy = params.mode === "form" ? phoneCopy.mcpFormUnsupported(server) : phoneCopy.mcpUrlUnsupported(server, message)
    turn.ctx.emit({ type: "text", id: crypto.randomUUID(), text: copy.text, notice: true, copy })
    return { outcome: "decline" }
  }
  // A form with no fields is a bare confirmation.
  if (form.request.questions.length === 0) {
    const options: PermissionOption[] = [
      { id: "accept", label: "批准", kind: "allow_once" },
      { id: "decline", label: "拒绝", kind: "reject_once" },
    ]
    const choice = await turn.ctx.askPermission({ tool: `mcp__${server}`, title: message || server, detail: "", kind: "other", options }, turn.withdraw.signal)
    return choice === "accept" ? { outcome: "accept", content: {} } : { outcome: "decline" }
  }
  const result = await elicitForm(form, (request, signal) => turn.ctx.askQuestion(request, signal), AbortSignal.any([turn.withdraw.signal, turn.ctx.signal]))
  return result.action === "accept" ? { outcome: "accept", content: result.content } : { outcome: result.action }
}

async function exitPlan(turn: Turn, params: Json) {
  breakBlocks(turn)
  const choice = await turn.ctx.askPermission(
    { tool: "exit_plan_mode", title: "Approve plan", detail: str(params.planContent), kind: "other", options: PLAN_OPTIONS },
    turn.withdraw.signal,
  )
  return { outcome: choice === "approved" ? "approved" : "rejected" }
}

// ACP tool_call / tool_call_update are partial: each present field replaces the old one.
function mergeTool(raw: Json, update: Json) {
  for (const field of TOOL_FIELDS) {
    if (update[field] !== undefined && update[field] !== null) raw[field] = update[field]
  }
  if (update._meta && typeof update._meta === "object") raw._meta = { ...obj(raw._meta), ...obj(update._meta) }
  // goose's later updates replace `_meta.goose` without the tool name, and Qwen Code names a call `tool_call` until
  // it knows which tool it is: keep the last real name.
  const named = nativeToolName(obj(update._meta))
  if (named && named !== "tool_call") raw.nativeName = named
  // pi (pi-acp): a `terminal` content block; the output streams in `_meta.terminal_output.data` pieces and the exit
  // code comes last in `_meta.terminal_exit`. Kept beside the ACP fields, since each update replaces `_meta`'s keys.
  const meta = obj(update._meta)
  const piece = obj(meta.terminal_output).data
  if (typeof piece === "string") {
    const held = str(raw.terminalOutput)
    if (Buffer.byteLength(held) <= TOOL_OUTPUT_LIMIT) {
      // Keep enough bytes for the downstream 4 KiB clip to set its truncation marker.
      const retainedBytes = TOOL_OUTPUT_LIMIT + 4
      raw.terminalOutput = truncateUtf8(held + piece.slice(0, retainedBytes), retainedBytes)
    }
  }
  const exit = num(obj(meta.terminal_exit).exit_code)
  if (exit !== undefined) raw.terminalExit = exit
}

function toolEvent(entry: ToolEntry, rejected: boolean): Extract<AgentEvent, { type: "tool" }> {
  const raw = entry.raw
  const native = str(raw.nativeName)
  const kind = TOOL_KINDS.includes(raw.kind as ToolKind) && raw.kind !== "other" ? toolKind(raw.kind) : (NATIVE_TOOL_KINDS[native] ?? toolKind(raw.kind))
  // The card header shows this name: Grok's own, else the kind (Qwen Code's `run_shell_command` reads worse).
  const name = SUBAGENT_TOOLS.has(native) || copilotTask(obj(raw.rawInput)) ? "Agent" : str(obj(obj(raw._meta)["x.ai/tool"]).name) || (raw.kind && raw.kind !== "other" ? str(raw.kind) : kind !== "other" ? kind : str(raw.kind)) || "tool"
  const event: Extract<AgentEvent, { type: "tool" }> = {
    type: "tool",
    id: entry.id,
    tool: name,
    title: str(raw.title) || name,
    kind,
    status: toolStatus(raw.status, rejected),
    detail: toolDetail(raw),
  }
  const output = toolOutput(raw)
  if (output !== undefined) event.output = output
  // A Copilot background subagent: its launch output is not its result (see copilotEvent).
  if (raw.copilotBackground) {
    const ended = obj(raw.copilotEnded)
    event.status = ended.status === "failed" ? "failed" : ended.status === "completed" ? "completed" : "running"
    if (typeof ended.output === "string") event.output = ended.output
    else delete event.output
  }
  const exitCode = toolExitCode(obj(raw.rawOutput)) ?? num(raw.terminalExit)
  if (exitCode !== undefined) event.exitCode = exitCode
  const diffs = toolDiffs(raw.content)
  if (!diffs.length) diffs.push(...inputDiffs(native, obj(raw.rawInput)))
  if (diffs.length) event.diffs = diffs
  return event
}

// The agent's own tool name when it sends a vague ACP kind: Qwen Code `toolName`, goose `goose.toolCall.toolName`.
// Grok's `x.ai/tool.name` already heads its cards and keeps its own kinds.
function nativeToolName(meta: Json): string {
  return str(meta.toolName) || str(obj(obj(meta.goose).toolCall).toolName)
}

// Qwen Code `agent`, goose `delegate`: the phone draws these as subagent cards (tool "Agent", like Claude's).
const SUBAGENT_TOOLS = new Set(["agent", "delegate"])
// Copilot's errors after it loses a session (message from 1.0.105, `data.details` before), until the process goes.
const COPILOT_LOST_SESSION = [
  "session event delivery failed: session not found: ",
  "session lock unavailable during is_session_generation_current: acquisition timed out",
]

export function copilotLostSession(error: unknown): boolean {
  for (let cause: unknown = error; cause instanceof Error; cause = cause.cause) {
    const rpc = cause as Error & { code?: unknown; data?: unknown }
    if (rpc.code !== -32603) continue
    const texts = [rpc.message, str(obj(rpc.data).details)]
    if (texts.some((text) => COPILOT_LOST_SESSION.some((marker) => text.includes(marker)))) return true
  }
  return false
}

// Copilot's task tool (kind `other`): `agent_type` names the subagent it starts.
function copilotTask(input: Json): boolean {
  return typeof input.agent_type === "string" && typeof input.prompt === "string"
}

// Agents that send no ACP kind (goose) or `other` for everything: their own names say what the call does.
const NATIVE_TOOL_KINDS: Record<string, ToolKind> = {
  shell: "execute",
  run_shell_command: "execute",
  write: "edit",
  write_file: "edit",
  edit: "edit",
  read: "read",
  read_file: "read",
}

// goose sends no diff blocks: `write` carries the new file, `edit` the replaced text and its replacement.
function inputDiffs(native: string, input: Json): ToolDiff[] {
  const path = str(input.path)
  if (!path) return []
  if (native === "write" && typeof input.content === "string") return [{ path, newText: input.content }]
  if (native === "edit" && typeof input.before === "string" && typeof input.after === "string") return [{ path, oldText: input.before, newText: input.after }]
  return []
}

function isOpen(raw: Json) {
  if (raw.copilotBackground) return !raw.copilotEnded
  return raw.status !== "completed" && raw.status !== "failed"
}

function toolKind(kind: unknown): ToolKind {
  if (kind === "delete" || kind === "move") return "edit"
  return TOOL_KINDS.includes(kind as ToolKind) ? (kind as ToolKind) : "other"
}

// A missing status is pending (Grok's first two frames carry none).
function toolStatus(status: unknown, rejected: boolean): ToolStatus {
  if (status === "in_progress") return "running"
  if (status === "completed") return "completed"
  if (status === "failed") return rejected ? "declined" : "failed"
  return "pending"
}

function toolDetail(raw: Json): string {
  const commandLine = obj(raw.rawInput).command
  if (typeof commandLine === "string") return commandLine
  if (Array.isArray(commandLine)) return commandLine.filter((part) => typeof part === "string").join(" ")
  const paths = arr(raw.locations)
    .map((location) => str(obj(location).path))
    .filter(Boolean)
    .join("\n")
  if (!paths && typeof obj(raw.rawInput).path === "string") return obj(raw.rawInput).path as string
  // pi names a shell call by its command line and sends no rawInput.
  return paths || (raw.kind === "execute" && arr(raw.content).some((block) => obj(block).type === "terminal") ? str(raw.title) : "")
}

// Text content blocks first; Copilot puts read results and failures only in rawOutput.
function toolOutput(raw: Json): string | undefined {
  const texts = arr(raw.content)
    .map(obj)
    .filter((block) => block.type === "content" && obj(block.content).type === "text")
    .map((block) => str(obj(block.content).text))
  if (texts.length) return texts.join("\n")
  const rawOutput = obj(raw.rawOutput)
  // Grok get_command_or_subagent_output: one task's output, or one per waited task headed by its command line.
  if (rawOutput.type === "TaskOutput") {
    const single = obj(rawOutput.Result)
    if (typeof single.output === "string") return single.output
    const results = arr(obj(rawOutput.MultiResult).results).map(obj)
    if (results.length) return results.map((task) => `${str(task.command).split("\n")[0]}\n${str(task.output)}`).join("\n")
  }
  if (typeof rawOutput.content === "string") return rawOutput.content
  if (typeof rawOutput.message === "string") return rawOutput.message
  if (typeof raw.terminalOutput === "string") return raw.terminalOutput
  return undefined
}

// Grok Bash: rawOutput.exit_code; Copilot shell: rawOutput.contents[{type:"shell_exit", exitCode}].
function toolExitCode(rawOutput: Json): number | undefined {
  if (typeof rawOutput.exit_code === "number") return rawOutput.exit_code
  for (const item of arr(rawOutput.contents)) {
    const content = obj(item)
    if (content.type === "shell_exit" && typeof content.exitCode === "number") return content.exitCode
  }
  return undefined
}

function toolDiffs(content: unknown): ToolDiff[] {
  return arr(content)
    .map(obj)
    .filter((block) => block.type === "diff" && typeof block.path === "string")
    .map((block) => ({
      path: block.path as string,
      ...(typeof block.oldText === "string" ? { oldText: block.oldText } : {}),
      ...(typeof block.newText === "string" ? { newText: block.newText } : {}),
    }))
}

function planStatus(status: unknown): PlanEntry["status"] {
  return status === "in_progress" || status === "completed" ? status : "pending"
}

function chunkText(update: Json): string {
  const content = obj(update.content)
  return content.type === "text" ? str(content.text) : ""
}

// Select options are flat ({value, name}) or grouped ({group, name, options}).
function selectValues(option: Json): { value: string; name: string }[] {
  return arr(option.options).flatMap((item) => {
    const entry = obj(item)
    if (Array.isArray(entry.options)) return selectValues(entry)
    return typeof entry.value === "string" ? [{ value: entry.value, name: str(entry.name) }] : []
  })
}

// handoff.list: session/list pages read at most.
const HANDOFF_PAGES = 5

/** One update a session/load replayed, with the frame's `_meta` (Grok stamps `agentTimestampMs`, `isReplay`). */
type ReplayFrame = { update: Json; meta: Json }

/**
 * Session handoff (P3): a session/load replay as history, by the live turn's rules (chunks of one message join, the
 * tool card keeps its last state, Copilot's `Info:` lines drop, a subagent's own output is not the agent speaking), plus
 * the user's messages. Ids `<agent>:<session>:<n>` in replay order, so the same replay maps to the same rows. A tool
 * still open when its turn ends (the next user message, Grok's turn_completed, the end) is cancelled, as endTurn does.
 */
export function acpReplayEntries(agentId: string, nativeId: string, frames: ReplayFrame[]): HistoryEntry[] {
  const entries: HistoryEntry[] = []
  let next = 0
  const nextId = () => `${agentId}:${nativeId}:${next++}`
  // The text block chunks are joining into.
  let open: { index: number; type: "user" | "text" | "reasoning"; messageId: string } | undefined
  let tools = new Map<string, { index: number; entry: ToolEntry }>()
  let planIndex: number | undefined
  const hidden = new Set<string>()
  const endTurn = () => {
    open = undefined
    planIndex = undefined
    for (const { index, entry } of tools.values()) {
      if (isOpen(entry.raw)) entries[index] = { ...entries[index]!, status: "cancelled" } as HistoryEntry
    }
    tools = new Map()
  }
  for (const { update, meta } of frames) {
    const kind = str(update.sessionUpdate)
    const marks = obj(update._meta)
    if (marks.parentToolCallId || obj(marks["github.com/copilot"]).agentId) continue
    const at = typeof meta.agentTimestampMs === "number" ? { at: meta.agentTimestampMs } : {}
    if (kind === "user_message_chunk" || kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
      const text = chunkText(update)
      if (!text) continue
      if (kind === "agent_message_chunk" && agentId === "copilot" && !update.messageId && /^(Info|Error): /.test(text)) {
        if (text.startsWith("Info: ")) continue
        open = undefined
        entries.push({ type: "text", id: nextId(), text, notice: true, ...at })
        continue
      }
      const type = kind === "user_message_chunk" ? "user" : kind === "agent_message_chunk" ? "text" : "reasoning"
      // A user message opens the next turn.
      if (type === "user" && open?.type !== "user") endTurn()
      const messageId = str(update.messageId)
      if (open && open.type === type && (open.messageId === messageId || !open.messageId || !messageId)) {
        const current = entries[open.index] as { text: string }
        entries[open.index] = { ...current, text: current.text + text } as HistoryEntry
        continue
      }
      open = { index: entries.length, type, messageId }
      if (type === "user") entries.push({ type: "user", id: nextId(), text, ...at })
      else if (type === "text") entries.push({ type: "text", id: nextId(), text, ...at })
      else entries.push({ type: "reasoning", id: nextId(), text, done: true, ...at })
      continue
    }
    if (kind === "tool_call" || kind === "tool_call_update") {
      const callId = str(update.toolCallId)
      if (!callId) continue
      if (agentId === "copilot" && kind === "tool_call" && update.kind === "other" && /\btodos\b/i.test(str(obj(update.rawInput).query))) hidden.add(callId)
      if (hidden.has(callId)) continue
      open = undefined
      let slot = tools.get(callId)
      if (!slot) {
        slot = { index: entries.length, entry: { id: nextId(), raw: {} } }
        tools.set(callId, slot)
      }
      mergeTool(slot.entry.raw, update)
      entries[slot.index] = { ...toolEvent(slot.entry, false), ...at }
      continue
    }
    if (kind === "plan") {
      open = undefined
      const plan = arr(update.entries)
        .map(obj)
        .filter((entry) => typeof entry.content === "string")
        .map((entry) => ({ content: entry.content as string, status: planStatus(entry.status) }))
      if (planIndex === undefined) {
        planIndex = entries.length
        entries.push({ type: "plan", id: nextId(), entries: plan, ...at })
      } else entries[planIndex] = { ...(entries[planIndex] as Extract<HistoryEntry, { type: "plan" }>), entries: plan }
      continue
    }
    if (kind === "turn_completed") endTurn()
  }
  endTurn()
  return entries
}

function pickUsage(source: Json, fields: Partial<Record<keyof TurnUsage, string>>): TurnUsage {
  const usage: TurnUsage = {}
  for (const [key, from] of Object.entries(fields) as [keyof TurnUsage, string][]) {
    const value = source[from]
    if (typeof value === "number" && Number.isFinite(value)) usage[key] = value
  }
  return usage
}

// A smaller total means the agent restarted its counter; the new total is then this turn.
function diffUsage(total: TurnUsage, previous: TurnUsage): TurnUsage {
  const turn: TurnUsage = {}
  for (const [key, value] of Object.entries(total) as [keyof TurnUsage, number][]) {
    const before = previous[key] ?? 0
    turn[key] = value >= before ? value - before : value
  }
  return turn
}

function onceAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
}

function settles(promise: Promise<void>, ms: number): Promise<boolean> {
  return Promise.race([promise.then(() => true), Bun.sleep(ms).then(() => false)])
}

function untilCancelled<T>(promise: Promise<T>, signal: AbortSignal, graceMs: number): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    let timer: Timer | undefined
    const onAbort = () => {
      timer = setTimeout(() => resolve(undefined), graceMs)
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener("abort", onAbort, { once: true })
    promise
      .then(resolve, (error: unknown) => (signal.aborted ? resolve(undefined) : reject(error)))
      .finally(() => {
        clearTimeout(timer)
        signal.removeEventListener("abort", onAbort)
      })
  })
}

// Judge the reply by its shape, not its number: some agents (Antigravity) report protocolVersion 2 with the v1
// agentInfo / agentCapabilities shape (T3 Code `effect-acp/src/client.ts`, MIT). A real v2 reply carries `info`
// and renamed methods, which this adapter does not speak yet.
export function checkInitShape(init: Json) {
  if (typeof init.protocolVersion !== "number") throw new Error("ACP initialize reply has no protocolVersion")
  if ("info" in init && !("agentInfo" in init) && !("agentCapabilities" in init)) {
    throw new Error(`ACP protocol v${init.protocolVersion} (v2 message shape) is not supported yet`)
  }
}

function identity(init: Json): string {
  const info = obj(init.agentInfo)
  const names = [str(info.name), str(info.title)]
  for (const method of arr(init.authMethods)) names.push(str(obj(method).id), str(obj(method).name))
  return [...new Set(names.filter(Boolean))].join(" ")
}

// ACP auth_required, or Copilot's 403 (error.data.category "permission_denied").
function isAuthError(error: unknown): error is RpcError {
  return error instanceof RpcError && (error.code === -32000 || obj(error.data).category === "permission_denied")
}

function resolvedPath(path: string): string | undefined {
  try {
    const real = realpathSync(path)
    return real === path ? undefined : real
  } catch {
    return undefined
  }
}

/** ACP AvailableCommand `{ name, description }`; invoked as `/name`. */
function availableCommand(value: unknown): AgentCommand[] {
  const command = obj(value)
  const name = str(command.name)
  if (!name) return []
  const description = str(command.description)
  return [{ name, insert: `/${name}`, kind: "command", description: description || undefined, source: "agent" }]
}
