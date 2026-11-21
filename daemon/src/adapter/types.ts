// Contract between SessionService and agent adapters.
// Field sources and per-agent mapping: the agent protocol notes.

import type { TurnExecutionIdentity } from "../turn-termination"
import type { PhoneCopy } from "../phone-copy"
import type { AgentDiagnostics } from "./diagnostics"

// A session's permission mode id. "ask", "acceptEdits" and "plan" mean the same thing for every agent that offers
// them; other ids belong to one agent (Claude "auto", Codex "fullAccess", an ACP agent's own mode id). §6.
export type RudderPermissionMode = string

export type PermissionRisk = "normal" | "caution" | "danger"

// One entry of an agent's permission-mode list. `native` is the agent's own name for the mode; `fromAgent` marks a
// label and description the agent sent itself (ACP availableModes) rather than Rudder's fallback copy.
export type PermissionModeInfo = {
  id: RudderPermissionMode
  label: string
  description?: string
  risk: PermissionRisk
  // Switching to it restarts the agent process; the conversation is resumed.
  restart?: boolean
  native?: string
  fromAgent?: boolean
}

export type ToolKind = "read" | "edit" | "execute" | "search" | "fetch" | "think" | "other"
export type ToolStatus = "pending" | "running" | "completed" | "failed" | "declined" | "cancelled"

// `truncated` is set by the daemon when it cut a text field to the per-diff budget; adapters leave it unset.
export type ToolDiff = { path: string; oldText?: string; newText?: string; patch?: string; truncated?: boolean }

// Per-turn increments. Cumulative-style agents diff inside the adapter.
export type TurnUsage = {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
  costUsd?: number
  contextUsed?: number
  contextSize?: number
}

export type BackgroundTaskKind = "subagent" | "command"
export type BackgroundTaskStatus = "running" | "done" | "failed" | "cancelled"
// ms on the daemon clock. `toolId`: the tool card's row id (the tool event's id) that started it, when known.
export type BackgroundTask = {
  id: string
  kind: BackgroundTaskKind
  title: string
  toolId?: string
  startedAt: number
  endedAt?: number
  status: BackgroundTaskStatus
  exitCode?: number
}

export type PlanEntry = { content: string; status: "pending" | "in_progress" | "completed" }

export type ReplyDisposition = "present" | "absent" | "not_applicable" | "unknown"

export type AgentEvent =
  | { type: "replyDisposition"; value: ReplyDisposition; nativeMessageIds: string[] }
  | { type: "lifecycle"; phase: "working" | "speech_paused" | "terminal"; nativeTurnId?: string;
      terminalStatus?: "completed" | "interrupted" | "failed"; pendingFinalization?: boolean; transport?: "open" | "closed" | "unknown"
      // Plan 2026-11-18: why the transport closed (the agent's exit line), kept as the turn's failure reason.
      detail?: string
      // The adapter ended the turn without the agent's own end signal (a continuation's quiet spell or deadline).
      inferred?: { trigger: "short" | "long"; quietMs?: number } }
  | { type: "status"; status: "running" | "idle" | "waiting" }
  // Background work changed: every start and end, the emptying one too. `open` counts the running tasks.
  // `paused`: the agent's speech has ended while some are open; the daemon idles the phone and keeps listening.
  | { type: "background"; open: number; paused: boolean; tasks: BackgroundTask[] }
  // Accumulated text so far; the same id is upserted. `notice`: Rudder's own wording (Cancelled.), never the list preview.
  // copy: a notice the phone words in its own language (phone-copy.ts); `text` is what older phones show.
  | { type: "text"; id: string; text: string; phase?: "commentary" | "final"; notice?: boolean; copy?: PhoneCopy; replyChoices?: string[] }
  // startedAt: ms on the daemon clock when the agent opened this block (its start signal), when the adapter sees one.
  | { type: "reasoning"; id: string; text: string; done: boolean; startedAt?: number }
  | {
      type: "tool"
      id: string
      tool: string
      title: string
      kind: ToolKind
      status: ToolStatus
      detail: string
      output?: string
      exitCode?: number
      diffs?: ToolDiff[]
    }
  | { type: "plan"; id: string; entries: PlanEntry[] }
  // v112 ①: the agent's own name for the session (ACP `session_info_update.title`, Codex `thread/name/updated`).
  | { type: "title"; title: string }
  | { type: "usage"; usage: TurnUsage }
  | {
      type: "compaction"
      id: string
      state: "running" | "done"
      trigger: "auto" | "manual"
      startedAt?: number
      tokensBefore?: number
      tokensAfter?: number
      contextSize?: number
    }
  | { type: "contextWindow"; value: number }
  // Agent-native session id (Claude session_id, Codex thread id, ACP sessionId) for resuming.
  | { type: "native"; nativeId: string }
  // Where this turn sits in the agent-native session, for a later native rewind: Codex's turn id (the first of the
  // turn), Claude's last main-chain assistant record uuid. Each report replaces the fields it carries.
  | { type: "nativeTurn"; nativeId: string; turnId?: string; lastMessageId?: string }
  // The agent changed its own permission mode mid-turn (Claude after an approved ExitPlanMode, ACP current_mode_update).
  | { type: "mode"; mode: RudderPermissionMode }
  // A finished image from the agent. Bytes stay on the computer; the phone hears only the descriptor.
  // fileName / sourcePath: a file the agent wrote in the session folder; Codex imageGeneration has neither.
  | {
      type: "image"
      id: string
      name: string
      mediaType: string
      width: number
      height: number
      bytes: Uint8Array
      fileName?: string
      sourcePath?: string
    }
  // The live process answered a steer probe. `missing` is JSON-RPC -32601.
  | { type: "steer"; result: "ok" | "missing" }
  // The agent refused a reasoning effort for this model (Copilot claude-sonnet-5.5); the daemon remembers it.
  | { type: "effortRefused"; model: string }
  // The agent's CLI is backing off and will retry the API call itself (Claude system api_retry, Codex error with
  // willRetry). delayMs: how long until the next attempt; the turn guard waits it out instead of calling the turn stuck.
  | { type: "retry"; attempt: number; maxAttempts?: number; delayMs?: number; reason?: string }

export type PermissionOptionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always"

export type PermissionOption = { id: string; label: string; kind: PermissionOptionKind }

export type PermissionRequest = {
  tool: string
  title: string
  detail: string
  kind: ToolKind
  options: PermissionOption[]
  diffs?: ToolDiff[]
  // Id of the tool event (as emitted by this adapter) the request is about, when there is one.
  toolId?: string
  // The whole call (`callMatch` of the tool's full input). `detail` is a summary that may be cut or leave arguments out,
  // so a 本会话总是允许 rule recorded with this matches only the identical call.
  match?: string
}

export type QuestionItem = {
  question: string
  header?: string
  options: { label: string; description?: string }[]
  multiSelect: boolean
  // false: every answer must be one of the option labels.
  allowsOther: boolean
}

export type QuestionRequest = { questions: QuestionItem[] }

// Keyed by question text; multi-select answers are arrays.
export type QuestionAnswers = Record<string, string | string[]>

/** An image already saved on this computer. Adapters that can show pixels include it; the text still names the path. */
export type AdapterImage = { path: string; mediaType: string; bytes: number }

export type LateAgentEvent = {
  identity: TurnExecutionIdentity
  eventId: string
  nativeTaskId?: string
  nativePromptId?: string
  text: string
  complete: boolean
  mode?: "delta" | "snapshot"
  sequence?: number
}

// Continuation turns: `buffered`: the adapter replays what it kept and sends the
// agent nothing; `message_text`: the turn's text is a real prompt (Codex: a subagent's result after its parent ended).
export type ContinuationDelivery = "buffered" | "message_text"
export type ContinuationOffer = {
  identity: TurnExecutionIdentity & { nativeSessionId: string }
  // The agent's own id for what woke it (a task, a wake prompt, a child thread): one offer, one turn.
  key: string
  // The agent's summary of what finished; the row text the phone shows.
  detail: string
  delivery: ContinuationDelivery
}

export type AdapterContext = {
  executionIdentity?: TurnExecutionIdentity
  // Set on the turn a continuation opened.
  continuation?: { key: string; delivery: ContinuationDelivery }
  sessionId: string
  // May return a promise (an image is saved before the turn goes idle). Callers that do not care can ignore it.
  emit: (event: AgentEvent) => void | Promise<void>
  // Resolves to the chosen option id, or null when withdrawn or the turn ended.
  // Abort `withdraw` when the agent itself retracts the request (Claude control_cancel_request,
  // Codex serverRequest/resolved); the card is then marked cancelled.
  askPermission: (request: PermissionRequest, withdraw?: AbortSignal) => Promise<string | null>
  // Resolves to the answers, or null when cancelled or withdrawn.
  askQuestion: (request: QuestionRequest, withdraw?: AbortSignal) => Promise<QuestionAnswers | null>
  cwd: string
  model?: string
  contextWindow?: number
  effort?: string
  // A speed id from the selected model's `speeds`. Empty leaves the agent's own default.
  speed?: string
  permissionMode: RudderPermissionMode
  // Present when the session already has an agent-native session to resume.
  nativeId?: string
  // Only for adapters with `forks` and only without nativeId: the session is a copy; continue a fork of this
  // agent-native session (its new id goes out as a `native` event). When the fork is impossible (the agent
  // cannot, the source is gone), start fresh and send withCarryOver(userText, carryOver) instead.
  forkFrom?: string
  carryOver?: string
  // Images for this turn. Empty or absent means text only.
  images?: AdapterImage[]
  // True when this session still has an enabled always-allow rule for the command.
  allowsCommand?: (command: string) => boolean
  // r47: the line comments the user attached when declining the request about this tool id, taken once. Only
  // adapters whose decline carries a message (Claude deny.message) ask; the daemon relays them for the others.
  reviewNote?: (toolId: string) => string | undefined
  signal: AbortSignal
}

export type AgentCapabilities = {
  reasoning: boolean
  steer: boolean
  interrupt: boolean
  plan: boolean
  question: boolean
  usage: "tokens" | "context" | "both" | "none"
  models: "static" | "dynamic"
  efforts: boolean
  // Ids of `modes`, kept for clients that predate the list.
  permissionModes: RudderPermissionMode[]
  modes: PermissionModeInfo[]
  // The agent approves tools itself and cannot be told to ask over its protocol (Grok, §6).
  autoApproval?: boolean
  // Takes images in a prompt (ACP promptCapabilities.image). Claude, Codex and Grok are known to the phone already.
  images?: boolean
}

export type AgentSpec = {
  id: string
  label: string
  transport: "fake" | "claude" | "codex" | "acp"
  experimental: boolean
  capabilities: AgentCapabilities
  // v83: the oldest CLI version Rudder works with. An older one is published as unavailable (`outdated`).
  minimumVersion?: string
}

export type AgentModel = {
  id: string
  label: string
  efforts: string[]
  defaultEffort?: string
  // The agent's own default model (Codex model/list isDefault).
  isDefault?: boolean
  description?: string
  contextWindows?: number[]
  // Absent when this model has no speed choice. `defaultSpeed` is the id used when the session leaves it unset.
  speeds?: ModelChoice[]
  defaultSpeed?: string
  // Copilot (1.0.105 `_meta`): premium requests per message (`copilotUsage` "14x" → 14) and `copilotPriceCategory`
  // (low · medium · high · very_high). Older apps ignore all five fields.
  multiplier?: number
  priceTier?: string
  // From the id prefix, for the phone's vendor groups and 「更早」 folding (model-vendor.ts).
  vendor?: string
  family?: string
  version?: string
}

// One discrete speed an agent publishes for a model (Codex service tier, Claude fast mode).
export type ModelChoice = { id: string; label: string; description?: string }

// One entry of the composer's `/` list. `insert` is what goes into the message: `/name`, or `$name` for Codex skills.
// `source`: "project" | "user" | "plugin:<name>" | "agent" (only the agent reported it).
export type AgentCommand = { name: string; insert: string; kind: "skill" | "command"; description?: string; source: string }

// The agent's own settings fix its permission mode and Rudder cannot change it (Grok always-approve, v71).
export type PermissionLock = { mode: "always-approve"; source: string }

export type Availability = {
  available: boolean
  reason?: string
  // `reason` as a code the phone words in its own language (phone-copy.ts).
  reasonCopy?: PhoneCopy
  permissionLock?: PermissionLock
  // v83: installed and signed in, but older than spec.minimumVersion. `upgradeCommand` only when the install is known.
  code?: "outdated"
  upgradeCommand?: string
}

// A live agent process the adapter launched. `shared`: several sessions run in it, so its resources
// cannot be split per session.
export type AgentProcess = { agent: string; pid: number; sessionIds: string[]; shared: boolean }

// One window of a subscription limit (v53 quota card). `limit` names a second, separately metered bucket (Codex
// limitName); the main bucket leaves it out. `kind` is Claude's rateLimitType. `usedPercent` 0–100; `resetsAt` ms.
// `status` is Claude's own verdict; Codex has none and the phone reads usedPercent.
export type QuotaWindow = {
  limit?: string
  kind?: string
  minutes?: number
  usedPercent?: number
  resetsAt?: number
  status?: "allowed" | "allowed_warning" | "rejected"
}

// What a subscription agent last said about its limits. Empty `windows`: the agent can report limits but has not yet.
export type AgentQuota = { plan?: string; credits?: string; windows: QuotaWindow[]; updatedAt: number }

/** What `warm` gets: the parts of the next turn's context that pick and start its process. */
export type WarmContext = Pick<
  AdapterContext,
  "sessionId" | "cwd" | "model" | "contextWindow" | "effort" | "speed" | "permissionMode" | "nativeId" | "forkFrom" | "executionIdentity"
>

export type NativeCut = { nativeId: string; keepThrough?: string; beforeTurnId?: string }

export type AgentAdapter = {
  diagnostics?(cwd: string, nativeId?: string): Promise<AgentDiagnostics>
  setLateEventSink?(sink: (event: LateAgentEvent) => Promise<void>): void
  // Whether an earlier turn registered this task with the late inbox (its wake reply patches that anchor). Survives a
  // process restart, unlike the adapter's own memory.
  setLateTaskLookup?(lookup: (agentId: string, nativeSessionId: string, taskId: string) => boolean): void
  // The agent spoke after its turn ended, about nothing a task of that turn owns: Rudder opens a new turn for it.
  // false: refused (stale, duplicate, shutting down); the adapter drops what it kept for that offer.
  setContinuationSink?(sink: (offer: ContinuationOffer) => boolean): void
  // A stop on this session: drop what the agent buffered for a continuation and offer nothing until the next prompt.
  cancelContinuation?(sessionId: string): void
  spec: AgentSpec
  // Subscription limits (Codex account/rateLimits, Claude rate_limit_event). Undefined: none to report.
  limits?(): Promise<AgentQuota | undefined>
  // Runs one user turn; resolves when the turn ends. Abort ctx.signal to interrupt.
  reply(userText: string, ctx: AdapterContext): Promise<void>
  // The phone opened this session's chat: start what the next reply() needs (the process, the resumed session)
  // without a prompt, so the first turn does not pay for it. Best effort; reply() still does it when this did not.
  warm?(ctx: WarmContext): void
  // Mid-turn input. Returns false when there is no active turn.
  steer?(sessionId: string, text: string): Promise<boolean>
  // Stop all: stops this session's background tasks one by one. False when the agent cannot (the daemon then
  // stops the turn instead) or there is no active turn.
  stopBackground?(sessionId: string): Promise<boolean>
  // Mid-turn permission switch the agent can take live. False when there is no active turn or the mode needs a relaunch.
  setMode?(sessionId: string, mode: RudderPermissionMode): Promise<boolean>
  // `missing` is JSON-RPC -32601 (Grok has no x.ai/interject). `unavailable` means there is no process to ask yet.
  probeSteer?(): Promise<"ok" | "missing" | "unavailable">
  detect?(): Promise<Availability>
  // Drops the cached detect() answer (the registry sets it): a turn just failed in a way the probe should see.
  forgetDetect?(): void
  // CLI version for hello.agents[].version. The registry probes again when the binary changes; a miss is undefined.
  version?(): Promise<string | undefined>
  // v83: the command that upgrades this CLI the way it was installed, or undefined when that is unclear.
  upgradeCommand?(): string | undefined
  listModels?(): Promise<AgentModel[]>
  // Permission modes as last advertised by a live session (ACP availableModes); absent means spec.capabilities.modes.
  listPermissionModes?(): PermissionModeInfo[] | undefined
  // Skills and commands for the composer's `/` list in a session working in `cwd`.
  listCommands?(cwd: string): Promise<AgentCommand[]>
  // The session was deleted or cleared: drop whatever the adapter keeps for it (process, cost marks, thread state).
  forget?(sessionId: string): void
  // Session handoff: stop this session's process but keep its native id and cost baseline, so the next turn
  // resumes the same agent session (`forget` drops both).
  release?(sessionId: string): void
  // Session handoff P2a / P3: the agent's own sessions on this computer, newest first, updated
  // since `since` (ms), at most `limit`, for `handoff.list`. Throws HandoffUnsupported when the agent cannot list or
  // reload its sessions.
  listExternal?(options: { since: number; limit: number }): Promise<ExternalSession[]>
  // The whole history of one of them, oldest first, as the live mapping would have shown it, for `handoff.import`.
  readExternal?(nativeId: string, cwd: string): Promise<HistoryEntry[]>
  // Native rewind: make the agent-native session `nativeId` forget everything after a turn boundary, keeping its id.
  // Claude takes `keepThrough` (the last kept turn's lastMessageId), Codex `beforeTurnId` (the first removed turn's
  // turnId). False when it cannot; the daemon then drops the native session and carries the transcript over.
  rewind?(sessionId: string, cut: NativeCut): Promise<boolean>
  // reply() honours ctx.forkFrom / ctx.carryOver. Without it the daemon puts the carried transcript in the text.
  forks?: boolean
  // Root processes alive right now, for the performance panel (the daemon adds their descendants).
  processes?(): AgentProcess[]
  dispose?(): Promise<void>
}

/** One agent-native session on this computer that `handoff.list` may show. */
export type ExternalSession = {
  nativeId: string
  title: string
  cwd: string
  /** ms */
  updatedAt: number
  preview?: string
  /** Codex: another process on this computer has the thread loaded (it holds the thread's writer lock). */
  inUse?: boolean
}

/** One imported history entry: what the live mapping emits, plus the user's own messages. `at`: ms, when known. */
export type HistoryEntry = (
  | { type: "user"; id: string; text: string }
  | Extract<AgentEvent, { type: "text" | "reasoning" | "tool" | "plan" | "compaction" }>
) & { at?: number }

export type HandoffUnsupportedReason = "not_installed" | "no_session_list"

/** listExternal: this agent's sessions cannot be brought over (handoff.list `unsupported`). */
export class HandoffUnsupported extends Error {
  constructor(
    readonly reason: HandoffUnsupportedReason,
    message: string,
  ) {
    super(message)
  }
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Not available, for the reason `copy` gives (its text is the reason older phones show). */
export function unavailable(copy: PhoneCopy): Availability {
  return { available: false, reason: copy.text, reasonCopy: copy }
}

// Resolves to undefined as soon as `signal` aborts; `work` itself keeps running and its failure is then ignored.
export function unlessAborted<T extends object>(work: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) {
    work.catch(() => {})
    return Promise.resolve(undefined)
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve(undefined)
    signal.addEventListener("abort", onAbort, { once: true })
    work
      .then(resolve, (error: unknown) => (signal.aborted ? resolve(undefined) : reject(error)))
      .finally(() => signal.removeEventListener("abort", onAbort))
  })
}
