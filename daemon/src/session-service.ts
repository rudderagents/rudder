import { LateAgentEvents } from "./late-agent-events"
import { CONTINUE_FALLBACK, continuationClientId } from "./continuation"
import { decideTurnHealth, type TurnHealthSnapshot } from "./turn-health"
import { restartCandidate, restartMessageId, type TurnExecutionIdentity, type TurnTermination, type TurnTerminationCause } from "./turn-termination"
import { statSync } from "node:fs"
import { resolve } from "node:path"
import { homedir, hostname } from "node:os"
import { createHash } from "node:crypto"
import { singleAdapterRegistry, type AdapterRegistry } from "./adapter"
import { AgentError, type AgentErrorInfo, classifyAgentFailure, loginCommand, unavailableCode } from "./adapter/agent-error"
import { compareVersions } from "./adapter/version"
import { copyError, copyOf, phoneCopy, type PhoneCopy } from "./phone-copy"
import { imageMediaType } from "./adapter/images"
import {
  enqueueItem,
  modelAcceptsImages,
  ruleMatches,
  steerControl,
  takeNext,
  type DaemonQueueItem,
  type SessionRule,
  type SteerControl,
} from "./v32"
import { APP_VERSION, BLOB_API, THUMBS_DIR } from "./config"
import { FileService, type FileVariant } from "./file-service"
import { searchLimit, searchPaged, searchQuery } from "./message-search"
import { CARRY_OVER_ROWS, carryOverTranscript, withCarryOver } from "./carry-over"
import { capabilityModes, modesForAutoApproval } from "./adapter/modes"
import type {
  AdapterImage,
  AgentAdapter,
  AgentEvent,
  AgentModel,
  BackgroundTask,
  ContinuationOffer,
  AgentQuota,
  Availability,
  PermissionModeInfo,
  PermissionOption,
  PermissionRequest,
  QuestionAnswers,
  QuestionItem,
  QuestionRequest,
  RudderPermissionMode,
  ToolDiff,
  ToolKind,
  ToolStatus,
} from "./adapter/types"
import { eventFrame, errorFrame, resultFrame, type Frame } from "./protocol"
import { MAX_FRAME_BYTES } from "./relay/frame"
import { Handoff, type HandoffOptions } from "./handoff"
import type { LiveActivityNotifier, LiveTurnEnd } from "./live-activity"
import { type LiveCardNotifier, parseLiveStart } from "./live-card"
import type { MachineIdentity } from "./perf"
import { NotifyPolicy } from "./notify-policy"
import { firstPromptLine, firstSentence, isPushTicket, type PushPayload, type PushQuestion, type PushReason } from "./push"
import { AUTO_TITLE_AGENT, AUTO_TITLE_COMMAND, AUTO_TITLE_MESSAGE, AUTO_TITLE_PLACEHOLDER, agentMayRetitle, commandName, commandTitle, shortTitle, titleFromMessage } from "./session-title"
import {
  messageOutline,
  messagePublic,
  OUTLINE_MAX_MESSAGES,
  OUTLINE_PAGE,
  readOutlineMessages,
  NOTICE_PAYLOAD,
  parseSteer,
  parsePermission,
  parseQuestion,
  parseReasoning,
  previewText,
  scheduledPublic,
  sessionPublic,
  TOOL_OUTPUT_LIMIT,
  truncateDiff,
  truncateUtf8,
  type CancelReason,
  type MessageRow,
  type PendingKind,
  type PermissionPayload,
  type PlanPayload,
  type QuestionPayload,
  type ReasoningPayload,
  type SessionStep,
  type SessionRow,
  type Store,
  type SendIdentity,
  type TurnNative,
  type TurnRow,
  type TurnOutcome,
  type LimitResumeRow,
  type TurnPhase,
  lastTurnPublic,
  turnPublic,
  type ToolPayload,
  type UsageQuery,
  type UsageTurn,
} from "./store"
import {
  ATTACHMENT_LIMIT_BYTES,
  type Attachment,
  attachmentDir,
  attachmentPublic,
  findAttachment,
  readPlainFile,
  readPlainWindow,
  removeAttachments,
  saveAttachment,
  withAttachments,
} from "./attachments"
import { AGENT_IMAGE_RETENTION, type AgentImageRetention, pruneAgentImages } from "./agent-image-retention"
import { RelayUploadBoard, sliceBase64, sliceWindow } from "./relay-attachment"
import { sniffImage } from "./image-bytes"
import { collectTurnImages, TurnImageScan } from "./turn-images"
import { gitDiff, gitStatus, listDir, MODELS, readWorkspaceFile, resolveSafe, searchFiles, SKILLS, WORKSPACE_ROOT } from "./workspace"
import {
  canonicalPath,
  changesPublic,
  changesTotals,
  countTreeEdits,
  currentStates,
  diffSnapshots,
  insideGitRepo,
  ownFiles,
  restoreWorktree,
  snapshotImage,
  snapshotPatch,
  snapshotToRestore,
  skippedChanged,
  snapshotTree,
  summarizeToolDiffs,
  type ToolWindow,
  type TurnChanges,
  type TurnSnapshot,
} from "./turn-changes"

/** `delta`, when given, is what sockets that negotiated the delta feature get instead of `frame`. */
export type Broadcaster = (frame: Frame, delta?: Frame) => void

export type ServiceHooks = {
  /** How long one agent's quota read may take before the answer goes out with its last numbers. Tests shorten it. */
  quotaTimeoutMs?: number
  // A revoked device's session key; the transport closes every socket opened with it.
  deviceRevoked?: (sessionKey: string) => void
  /** Id of the last broadcast event; session.get reports it so a client can skip events its snapshot holds. */
  eventCursor?: () => number
  /** Set when a push gateway is configured: hands a lock-screen notification to every registered phone. */
  push?: (payload: PushPayload, options?: { collapseId?: string }) => void
  /** v67 A4's done window; tests shorten it or fix its clock. */
  notifyPolicy?: NotifyPolicy
  /** Dynamic Island for the turn started from the phone. Absent in tests that do not exercise it. */
  live?: LiveActivityNotifier
  /** one card per phone for this computer (`liveActivity.register {scope: "computer"}`). */
  card?: LiveCardNotifier
  /** Root a session folder must stay inside when a turn starts (default WORKSPACE_ROOT; tests use their temp dir). */
  workspaceRoot?: string
  /** Model and OS version once the perf sampler has read them; `machine()` carries them when known. */
  machineIdentity?: () => MachineIdentity | undefined
  /** `process.platform` unless a test pretends to be another one. */
  platform?: string
  /** Session handoff with terminal Claude (handoff/index.ts). Absent: no `handoff.*` methods and no holder. */
  handoff?: HandoffOptions
  /** Turn guard timings (ms); tests shrink them. Defaults are TURN_GUARD below. */
  turnGuard?: Partial<TurnGuardTimings>
  /** r73 A/B timings (ms); tests shrink them. Defaults are AUTO_RESUME below. */
  autoResume?: Partial<AutoResumeTimings>
  /** r75 `file.*` and `attachment.fetch`; tests pass one with a temp cache, a fake fetch or fake tools. */
  files?: FileService
  /** Agent image budget, age limit and timings (agent-image-retention.ts); tests shrink them. */
  imageRetention?: Partial<AgentImageRetention>
  /** The working-tree snapshot a turn's changes are diffed between (turn-changes.ts); tests slow it down. */
  snapshotTree?: typeof snapshotTree
  /** How long an opened chat stays open before its agent is warmed (WARM_DELAY_MS); tests shorten it. */
  warmDelayMs?: number
}

/**
 * r73 A: a turn a usage limit stopped is continued `jitterMs` after the limit resets, if that is at most `maxArmMs`
 * away. r73 B: a turn a restart cut short is continued `restartDelayMs` after startup (time for phones to reconnect)
 * when it was cut at most `restartWindowMs` ago.
 */
export type AutoResumeTimings = { jitterMs: number; maxArmMs: number; restartWindowMs: number; restartDelayMs: number }
const AUTO_RESUME: AutoResumeTimings = { jitterMs: 60_000, maxArmMs: 24 * 60 * 60_000, restartWindowMs: 30 * 60_000, restartDelayMs: 5_000 }
/** What the agent is told when rudderd continues a cut-short turn on its own (r73 A, B, G). */
export const RESUME_PROMPT = "Continue where you left off. Your previous turn stopped before it was finished; carry on from that point without redoing work that is already done."

/**
 * r66 step 1: a turn must end. A live turn is checked every `checkMs`; it is stuck when nothing is waiting on the
 * phone, no tool or background task is open. Silence requests inspection; only an explicit engine terminal
 * or a closed transport settles a turn. Usage is not terminal evidence.
 */
export type TurnGuardTimings = { checkMs: number; afterSpeechMs: number; silentMs: number }
const TURN_GUARD: TurnGuardTimings = { checkMs: 30_000, afterSpeechMs: 20_000, silentMs: 5 * 60_000 }

// Placeholders an app older than `autoTitle` sends; a newer one says so with the flag, in whatever language it shows.
const DEFAULT_TITLES = new Set(["新会话", "New session"])
// Legacy ask/allow/deny plus the per-session names; the value is the default for new sessions.
const CONFIG_PERMISSION_MODES = new Set(["ask", "allow", "deny", "acceptEdits", "plan"])
const HISTORY_PAGE = 80
// r64 `message.changes` default and cap.
const CHANGES_PAGE = 200
const CHANGES_MAX = 500

/** A session rule as the phone sees it: `match` is the daemon's own hash of the allowed call. */
function rulePublic({ match: _, ...rule }: SessionRule): Omit<SessionRule, "match"> {
  return rule
}

/**
 * `limit` on an outline `session.get` / `session.rewind`: the newest page only, older pages through `history.page`.
 * Without it (an older phone) the window stays the whole light history (`OUTLINE_MAX_MESSAGES`). A whole long session
 * over the relay took seconds to land on each reconnect (2026-11-02, 496 rows).
 */
function outlineLimit(limit: unknown): number | undefined {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return undefined
  return Math.min(OUTLINE_MAX_MESSAGES, Math.max(1, Math.floor(limit)))
}

// perf-1112 round two (R4): the methods that read a session's message rows, and the param naming that session. Only
// these write the session's streamed blocks back before they run; everything else leaves the throttle alone.
const TRANSCRIPT_READERS: Record<string, "id" | "sessionId"> = {
  "session.get": "id",
  "session.export": "id",
  "session.fork": "id",
  "session.rewind": "id",
  "history.page": "sessionId",
  "message.changes": "sessionId",
  "message.bodies": "sessionId",
  "message.search": "sessionId",
}

function transcriptReader(method: string, params: Record<string, unknown> | undefined): string | undefined {
  const key = Object.hasOwn(TRANSCRIPT_READERS, method) ? TRANSCRIPT_READERS[method] : undefined
  const id = key ? params?.[key] : undefined
  return typeof id === "string" && id ? id : undefined
}
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
// One slow agent (a cold `codex app-server`) must not hold usage.summary past the phone's 10 s budget.
const QUOTA_TIMEOUT_MS = 6_000
const QUOTA_LATE: unique symbol = Symbol("quota read past its limit")
// Claude list; used when an agent cannot list its own models.
const STATIC_MODELS: AgentModel[] = MODELS.map((model) => ({ ...model, efforts: [] }))
const PLAN_MARKS = { pending: "[ ]", in_progress: "[~]", completed: "[x]" } as const
// Streamed text/reasoning is broadcast at most this often per session.
const STREAM_FLUSH_MS = 100
// ...and written back to SQLite at most this often: each write is the whole block, so a long reply at the broadcast
// rate rewrites megabytes. A block's first write, a preview change, its end, the turn's end, any request and shutdown
// write at once, so nothing reads a row that is behind what was sent.
const STREAM_PERSIST_MS = 2000
// Past this many UTF-16 units the interval grows with the block, so the bytes written per second stay level, up to
// STREAM_PERSIST_MAX_MS: the most text a crash can lose. These in-flight writes take no rev (see flushStream).
// 2026-11-12 (perf-1112 R4): 1 s / 64 K / 10 s rewrote a 1 MB reply 129 times, 37.8 MB; 2 s / 16 K / 30 s, 31 times
// and 11 MB (daemon/src/stream-budget.test.ts).
const STREAM_PERSIST_SCALE = 16 * 1024
const STREAM_PERSIST_MAX_MS = 30_000
// 2026-11-12 (perf-1112 R6): scheduled sends wake the daemon when the next one is due, not every second. The wait is
// capped so a Mac that slept past fire_at (timers do not count sleep) still sends within a minute of waking; a job
// already due but held back (its session busy, a terminal holding it) is looked at again every second.
const SCHEDULE_MAX_WAIT_MS = 60_000
const SCHEDULE_RETRY_MS = 1000
// 2026-11-12 (perf-1112 R6): a chat opened and left again within this long (browsing the list) starts no agent.
const WARM_DELAY_MS = 1500
// Long enough for an adapter to interrupt and, failing that, escalate to SIGKILL.
const STOP_GRACE_MS = 8000
// Real UTC offsets run from -12:00 to +14:00.
const MAX_TZ_MINUTES = 14 * 60

// Latest accumulated text of a streaming block, held in memory between flushes.
type StreamBlock = {
  id: string
  kind: "text" | "reasoning"
  text: string
  replyChoices?: string[]
  phase?: "commentary" | "final"
  // A text block Rudder wrote itself (Cancelled.); stored with NOTICE_PAYLOAD, or beside its copy when it has one.
  notice?: boolean
  copy?: PhoneCopy
  createdAt: number
  startedAt?: number
  endedAt?: number
  // Changed since the last broadcast.
  dirty: boolean
  // Broadcast but not yet written back.
  unsaved?: boolean
  // Written back quietly (Store.insertMessage quiet): the stored text has not taken its rev yet.
  quiet?: boolean
  // The row as last broadcast; its seq and created_at come from the first write.
  row?: MessageRow
  // Set when the id belongs to another session; later deltas for it are ignored.
  dropped?: boolean
  // Text and endedAt as last broadcast.
  sentText?: string
  sentEndedAt?: number
  // A text block's list preview as last announced; it stops changing once the block outgrows PREVIEW_CHARS.
  preview?: string
  // The list has been told this block exists, so later flushes do not bump unread again.
  counted?: boolean
  // Its first write has already marked the pending steer read; later flushes of the same block do not.
  steerChecked?: boolean
}

function streamPayload(block: StreamBlock): string | null {
  if (block.kind !== "reasoning") {
    if (block.replyChoices || block.phase) return JSON.stringify({ ...(block.replyChoices ? { replyChoices: block.replyChoices } : {}), ...(block.phase ? { phase: block.phase } : {}) })
    if (!block.notice) return null
    return block.copy ? JSON.stringify({ notice: true, copy: block.copy }) : NOTICE_PAYLOAD
  }
  const reasoning: ReasoningPayload = { startedAt: block.startedAt ?? block.createdAt }
  if (block.endedAt !== undefined) reasoning.endedAt = block.endedAt
  return JSON.stringify(reasoning)
}

/** How long a stream waits between write-backs: a second, longer once its biggest unsaved block outgrows the scale. */
export function persistInterval(blocks: Iterable<Pick<StreamBlock, "text" | "dirty" | "unsaved" | "dropped">>): number {
  let size = 0
  for (const block of blocks) {
    if ((block.dirty || block.unsaved) && !block.dropped) size = Math.max(size, block.text.length)
  }
  return Math.min(STREAM_PERSIST_MAX_MS, Math.max(STREAM_PERSIST_MS, Math.round((STREAM_PERSIST_MS * size) / STREAM_PERSIST_SCALE)))
}

type SessionStream = {
  blocks: Map<string, StreamBlock>
  lastFlush: number
  lastPersist: number
  timer: ReturnType<typeof setTimeout> | null
  persistTimer: ReturnType<typeof setTimeout> | null
}

type PendingPermission = {
  sessionId: string
  tool: string
  detail: string
  match?: string
  kind?: string
  options: PermissionOption[]
  toolId?: string
  resolve: (optionId: string | null) => void
}

type PendingQuestion = {
  sessionId: string
  firstKey: string
  questions: QuestionItem[]
  resolve: (answers: QuestionAnswers | null) => void
}

/** Image attachments the adapter can show. Other files stay a path inside the text. */
// The device a continuation's send identity names: the daemon, on the agent's behalf.
const CONTINUE_DEVICE = "daemon:agent"

function promptOrigin(row: { payload: string | null } | null): string | undefined {
  if (!row?.payload) return undefined
  return (JSON.parse(row.payload) as { origin?: string }).origin
}

function agentImages(attachments: Attachment[]): AdapterImage[] {
  const images: AdapterImage[] = []
  for (const attachment of attachments) {
    const mediaType = imageMediaType(attachment.name)
    if (mediaType) images.push({ path: attachment.path, mediaType, bytes: attachment.bytes })
  }
  return images
}

/**
 * `session.export` answers in one frame and the app's WebSocket buffer is 8 MiB (implementation.md, outline), so the
 * markdown stops before 4 MiB, leaving room for JSON escaping.
 */
export const EXPORT_LIMIT_BYTES = 4 * 1024 * 1024
const EXPORT_TRUNCATED_NOTE = "_Export stopped here: the rest of this session is over the 4 MB export limit._\n"

// "fallback_resume" (r73 G): the phone switched agents from a usage-limit card and asked the new one to carry on.
type MessageOrigin = "review" | "relay" | "auto_resume" | "restart_resume" | "fallback_resume" | "agent_continue"
/** Why a queue waits after its turn ended instead of starting the next turn (r64 W1). Cleared when a turn starts. */
type QueuePause = "usage_limit" | "auth_required" | "restart"
const PAUSING_ERRORS = new Set<string>(["usage_limit", "auth_required"])

function errorCode(payload: string | null | undefined): string | undefined {
  try {
    const code = (JSON.parse(payload ?? "null") as { error?: { code?: unknown } } | null)?.error?.code
    return typeof code === "string" ? code : undefined
  } catch {
    return undefined
  }
}

/** `permission.respond` comments: `note` is the text as the phone formatted it (in the app's language). */
function readReview(params: Record<string, unknown>): { note: string; count: number } | undefined {
  if (params.comments === undefined && params.note === undefined) return undefined
  const comments = params.comments
  if (!Array.isArray(comments) || comments.length === 0 || comments.length > 100) {
    throw Object.assign(new Error("comments must be 1 to 100 entries"), { code: "invalid" })
  }
  for (const entry of comments) {
    const comment = entry as Record<string, unknown> | null
    if (typeof comment?.path !== "string" || typeof comment.text !== "string" || !comment.text.trim()) {
      throw Object.assign(new Error("each comment needs path and text"), { code: "invalid" })
    }
    if (comment.line !== undefined && (typeof comment.line !== "number" || !Number.isSafeInteger(comment.line) || comment.line < 1)) {
      throw Object.assign(new Error("comment line must be a positive integer"), { code: "invalid" })
    }
  }
  if (typeof params.note !== "string" || !params.note.trim() || Buffer.byteLength(params.note) > 64 * 1024) {
    throw Object.assign(new Error("note must be the comments' text, at most 64 KB"), { code: "invalid" })
  }
  return { note: params.note, count: comments.length }
}

type TurnToolTrack = {

  tools: Map<string, { title: string; status: string; exitCode?: number }>
  diffs: Map<string, ToolDiff[]>
  // picture files the turn wrote or named.
  images: TurnImageScan
  // Which tree changes are this turn's (`ownFiles`): when each tool ran (from its first non-pending event to its
  // close), the file paths each tool named, whether a shell command ran, and the folder relative paths resolve in.
  startedAt: number
  cwd?: string
  windows: Map<string, ToolWindow>
  named: Map<string, string[]>
  shell: boolean
}

/** A path another session's tool named, kept past that turn while a turn that overlapped it is still running. */
type ToolClaim = { sessionId: string; path: string; start: number; end: number }
/** `ownFiles`'s view of a turn's tools, less the end time. */
type ToolOwnership = { windows: ToolWindow[]; named: Set<string>; others: Set<string>; shell: boolean }

const CLOSED_TOOL = new Set(["completed", "failed", "declined", "cancelled"])

function firstLine(text: string): string {
  const line = text.split("\n").find((entry) => entry.trim())?.trim() ?? ""
  return line.length > 200 ? `${line.slice(0, 200)}…` : line
}

type BodyPage = { messages: ReturnType<typeof messagePublic>[]; nextOffset?: number }
const BODY_PAGE_BYTES = 4_194_304
const BODY_FRAME_BYTES = MAX_FRAME_BYTES

export class SessionService {

  private readonly sendRequests = new Map<string, { hash: string; task: Promise<unknown> }>()
  private readonly queuedIdentities = new Map<string, SendIdentity>()
  private shuttingDown = false
  private readonly latestTurns = new Map<string, TurnRow>()
  // Agent continuations (plan 2026-11-17): those waiting per session, in the order they came (two subagents can end
  // behind one turn; each gets its own), and the offer behind each started turn by its clientMessageId until generate()
  // reads it.
  private readonly continuations = new Map<string, ContinuationOffer[]>()
  private readonly continuationTurns = new Map<string, ContinuationOffer>()
  private readonly startingQueued = new Set<string>()
  private readonly sessionMutations = new Map<string, symbol>()
  private readonly sendEpoch: string
  private readonly generating = new Set<string>()
  // Background tasks still running, sent to the phone as `backgroundOpen`. Cleared when reply() actually returns.
  private readonly backgroundOpen = new Map<string, number>()
  // The last list of this turn's background tasks. Kept after the turn closes (B2's failed line) until the next starts.
  private readonly backgroundTasks = new Map<string, BackgroundTask[]>()
  // Sessions whose speech has paused on background work: the phone was idled with the live activity held.
  private readonly backgroundPaused = new Set<string>()
  /** Each agent's last quota answer, for a read that comes late or fails. */
  private readonly lastQuota = new Map<string, AgentQuota>()
  // r66 turn guard: when the running turn last heard from its adapter, whether the agent has said it is done, and the
  // rule a stuck turn was ended by (read by recordTurnOutcome).
  private readonly lastAgentEventAt = new Map<string, number>()
  // The agent said it is backing off until then (a `retry` event); the turn guard does not call it stuck before.
  private readonly retryingUntil = new Map<string, number>()
  private readonly agentSpoke = new Set<string>()
  // A paused speech whose background work finished on its own: the agent owes the follow-up (it reads the results
  // first, which takes a while on a long context), so the guard waits the long limit until it speaks again.
  private readonly followUpDue = new Set<string>()
  private readonly stuckTurns = new Map<string, string>()
  private readonly health = new Map<string, TurnHealthSnapshot>()
  private readonly terminalReceipts = new Map<string, { resolve: () => void; reject: (error: Error) => void }>()
  private readonly healthInspected = new Set<string>()
  private readonly notifyPolicy: NotifyPolicy
  private readonly guard: TurnGuardTimings
  private readonly outbound = new Map<string, DaemonQueueItem[]>()
  private readonly pausedQueues = new Map<string, QueuePause>()
  // r73 A: armed limit resumes by session; the rows in `limit_resumes` outlive a restart, the timers do not.
  private readonly resumeTimers = new Map<string, ReturnType<typeof setTimeout>>()
  // Set while the scheduler runs (startScheduler): the timer for the next scheduled send, if one is pending.
  private scheduler: { timer: ReturnType<typeof setTimeout> | null } | null = null
  // One pending warm per phone (device key; "" without one): opening another chat replaces it.
  private readonly warmTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly autoResume: AutoResumeTimings
  private readonly imageRetention: AgentImageRetention
  private imagePruneTimer: ReturnType<typeof setTimeout> | null = null
  private imagePrune: Promise<unknown> = Promise.resolve()
  private readonly rules: SessionRule[] = []
  private readonly steerCache = new Map<string, SteerControl>()
  private readonly pendingPermissions = new Map<string, PendingPermission>()
  private readonly pendingQuestions = new Map<string, PendingQuestion>()
  private readonly aborts = new Map<string, AbortController>()
  private readonly turns = new Map<string, Promise<void>>()
  private readonly streams = new Map<string, SessionStream>()
  // A finished turn's changes being counted after its idle (finishTurnChanges), per session.
  private readonly turnEnds = new Map<string, Promise<unknown>>()
  // The tail of each folder's snapshot queue (queueSnapshot).
  private readonly snapshotQueue = new Map<string, Promise<unknown>>()
  // r47: a declined approval's comments for Claude's deny message, by the tool id the request was about.
  private readonly reviewNotes = new Map<string, string>()
  // Chunked attachment bytes for a relay link. That route has no HTTP, so the phone cannot POST the file.
  private readonly relayUploads = new RelayUploadBoard()
  private readonly files: FileService
  // r47: the running turn's tools (last one started, final statuses) and edit diffs, for lastTurn and turn.changes.
  private readonly turnTools = new Map<string, TurnToolTrack>()
  // Paths named by tools of turns that already ended, for the turns still running that overlapped them.
  private toolClaims: ToolClaim[] = []
  // v48 H1: the running turn's current tool or thought per session, keyed by the event id that set it.
  private readonly steps = new Map<string, { id: string; step: SessionStep }>()
  private readonly replyDispositions = new Map<string, Extract<AgentEvent, { type: "replyDisposition" }>>()
  private readonly lateEvents: LateAgentEvents
  private readonly lateWrites = new Set<Promise<void>>()
  private readonly adapters: AdapterRegistry
  // Agent CLI versions fill in after the first hello. The probe is started, never awaited, so hello stays fast.
  private readonly agentVersions = new Map<string, string>()
  // The probe each agent's version came from; a new promise means the binary changed and was probed again.
  private readonly versionProbes = new Map<string, Promise<string | undefined>>()
  // Last detect() answer per agent. hello answers from it instead of waiting for every probe (Codex app-server,
  // Copilot's probe session, ACP initialize); `refreshAgents` checks again and pushes `agents.upsert` on a change.
  // A turn starts from it too when it says available (generate).
  private readonly knownAvailability = new Map<string, Availability>()
  private publishedAgents: string | undefined
  private agentRefresh: Promise<void> | undefined
  /// Newest still-sent steer id. Missing means unknown; null means the session has none.
  private readonly pendingSteer = new Map<string, string | null>()
  readonly handoff: Handoff | undefined
  private readonly broadcast: Broadcaster

  // A single adapter answers for every agent id (tests, demos).
  constructor(
    private readonly store: Store,
    adapters: AdapterRegistry | AgentAdapter,
    broadcast: Broadcaster,
    private readonly hooks: ServiceHooks = {},
  ) {
    // Every session.upsert also moves the session's list version: holder, lastTurn, pending and step live outside the
    // row, and this is how the phone hears of them (r64 sync). The frame carries the version it was given.
    this.broadcast = (frame, delta) => {
      if (frame.name === "session.upsert") {
        const pub = frame.payload as { id?: unknown; version?: number } | null
        if (pub && typeof pub.id === "string") {
          const version = store.touchSession(pub.id)
          if (version !== null) frame.payload = { ...pub, version }
        }
      }
      broadcast(frame, delta)
    }
    this.notifyPolicy = hooks.notifyPolicy ?? new NotifyPolicy()
    this.adapters = isAdapter(adapters) ? singleAdapterRegistry(adapters) : adapters
    this.lateEvents = new LateAgentEvents(store, row => {
      this.broadcast(eventFrame("message.append", messagePublic(row)))
      this.notifySession(row.session_id)
    })
    for (const adapter of this.adapters.list()) adapter.setLateEventSink?.(event => {
      if (this.shuttingDown) return Promise.resolve()
      const write = this.lateEvents.accept(event).then(() => {})
      this.lateWrites.add(write)
      void write.finally(() => this.lateWrites.delete(write)).catch(() => {})
      return write
    })
    void this.lateEvents.recover().catch(error => console.warn("Late reply recovery failed", error))
    for (const adapter of this.adapters.list()) {
      adapter.setLateTaskLookup?.((agentId, nativeSessionId, taskId) => this.lateEvents.knows(agentId, nativeSessionId, taskId))
      adapter.setContinuationSink?.(offer => this.continueFromAgent(offer))
    }
    this.guard = { ...TURN_GUARD, ...hooks.turnGuard }
    this.autoResume = { ...AUTO_RESUME, ...hooks.autoResume }
    this.imageRetention = { ...AGENT_IMAGE_RETENTION, ...hooks.imageRetention }
    this.handoff = hooks.handoff ? this.createHandoff(hooks.handoff) : undefined
    this.files = hooks.files ?? new FileService({ cacheDir: THUMBS_DIR, blobBase: BLOB_API, platform: hooks.platform })
    this.sendEpoch = store.getMeta("send_epoch") ?? crypto.randomUUID()
    store.setMeta("send_epoch", this.sendEpoch)
    this.rules.push(...store.listRules())
    // r73 B: turns this start cut short, with when they last showed life.
    const cutShort: Array<{ sessionId: string; turnId: string; at: number }> = []
    for (const row of store.listLatestTurns()) {
      const active = ["preparing", "running", "waiting"].includes(row.phase)
      const restored = active ? store.advanceTurn(row.id, "interrupted") ?? row : row
      let outcome = row.outcome ? JSON.parse(row.outcome) as TurnOutcome : undefined
      if (active) {
        const termination = store.setTurnTermination(row.id, { cause: "restart_recovery", requestedAt: Date.now() })
        outcome = { phase: "interrupted", endedAt: restored.updated_at, termination }
        store.setTurnOutcome(row.id, outcome)
        restored.outcome = JSON.stringify(outcome)
      }
      if (restartCandidate({ id: row.id, phase: restored.phase, updatedAt: row.updated_at, outcome }, Date.now(), true, this.autoResume.restartWindowMs)) {
        const last = store.listMessages(row.session_id, { limit: 1 })[0]
        cutShort.push({ sessionId: row.session_id, turnId: row.id, at: Math.max(row.updated_at, last?.created_at ?? 0) })
      }
      if (restored.phase === "interrupted") store.patchSession(row.session_id, { status: "idle" })
      if (store.getMessage(restored.user_message_id)) this.latestTurns.set(row.session_id, restored)
    }
    for (const row of store.listQueuedSends()) {
      const result = JSON.parse(row.result) as { queued: DaemonQueueItem }
      const item = result.queued
      if (!store.getSession(row.session_id) || item.sessionId !== row.session_id) continue
      this.outbound.set(item.sessionId, enqueueItem(this.outbound.get(item.sessionId) ?? [], item))
      this.queuedIdentities.set(item.id, {
        sessionId: row.session_id, deviceId: row.device_id, clientMessageId: row.client_message_id, requestHash: row.request_hash, queueId: item.id,
      })
    }
    // A queue left behind a turn this restart cut short waits for the session's next turn; so does one a usage
    // limit or sign-in had already paused (the pause itself is not stored, the failed turn's error card is).
    for (const sessionId of this.outbound.keys()) {
      const latest = this.latestTurns.get(sessionId)
      if (latest?.phase === "interrupted") this.pausedQueues.set(sessionId, "restart")
      else if (latest?.phase === "failed") {
        const last = store.listMessages(sessionId, { limit: 1 })[0]
        const code = last?.kind === "error" ? errorCode(last.payload) : undefined
        if (code && PAUSING_ERRORS.has(code)) this.pausedQueues.set(sessionId, code as QueuePause)
      }
    }
    queueMicrotask(() => {
      for (const sessionId of this.outbound.keys()) this.flushOutbound(sessionId)
    })
    for (const row of store.listLimitResumes()) this.armLimitResume(row)
    this.planRestartResumes(cutShort)
  }

  private settingOn(key: "auto_resume_limits" | "continue_after_restart"): boolean {
    return this.store.getMeta(key) !== "0"
  }

  /** r73 A: a usage limit with a known reset stopped this turn; continue it once the limit resets. */
  private scheduleLimitResume(sessionId: string, turnId: string, resetsAt: number) {
    const wait = resetsAt - Date.now()
    if (!this.settingOn("auto_resume_limits") || wait <= 0 || wait + this.autoResume.jitterMs > this.autoResume.maxArmMs) return
    this.armLimitResume(this.store.setLimitResume(sessionId, turnId, resetsAt))
    this.notifySession(sessionId)
  }

  private armLimitResume(row: LimitResumeRow, minimumDelay = 0) {
    clearTimeout(this.resumeTimers.get(row.session_id))
    const delay = row.resets_at + this.autoResume.jitterMs - Date.now()
    if (delay > this.autoResume.maxArmMs) {
      this.resumeTimers.delete(row.session_id)
      this.store.deleteLimitResume(row.session_id)
      return
    }
    const timer = setTimeout(() => this.fireLimitResume(row.session_id, row.turn_id), Math.max(minimumDelay, delay))
    timer.unref?.()
    this.resumeTimers.set(row.session_id, timer)
  }

  /** Drops a waiting limit resume: the user acted on the session, or turned the setting off. */
  private cancelLimitResume(sessionId: string, notify = true): boolean {
    clearTimeout(this.resumeTimers.get(sessionId))
    this.resumeTimers.delete(sessionId)
    const removed = this.store.deleteLimitResume(sessionId)
    if (removed && notify) this.notifySession(sessionId)
    return removed
  }

  /** The turn may be continued only while nothing has happened to the session since it was cut short. */
  private canContinue(sessionId: string, turnId: string, phase: TurnPhase): boolean {
    const session = this.store.getSession(sessionId)
    if (!session || session.archived === 1) return false
    const latest = this.latestTurns.get(sessionId)
    if (latest?.id !== turnId || latest.phase !== phase) return false
    if (this.generating.has(sessionId) || this.startingQueued.has(sessionId) || this.sessionMutations.has(sessionId)) return false
    if (this.pendingKind(sessionId)) return false
    return !this.handoff?.heldElsewhere(sessionId)
  }

  private fireLimitResume(sessionId: string, turnId: string) {
    this.resumeTimers.delete(sessionId)
    if (this.shuttingDown) return
    const row = this.store.getLimitResume(sessionId)
    if (!row || row.turn_id !== turnId) return
    if (this.sessionMutations.has(sessionId)) {
      this.armLimitResume(row, SCHEDULE_RETRY_MS)
      return
    }
    const go = this.settingOn("auto_resume_limits") && this.canContinue(sessionId, turnId, "failed")
    this.cancelLimitResume(sessionId, !go)
    if (!go) return
    if (!this.continueTurn(sessionId, "auto_resume")) return
    const session = this.store.getSession(sessionId)
    if (session) {
      this.hooks.push?.({
        v: 1, kind: "resumed", resume: "limit", sessionId, title: session.title,
        body: "Usage limit reset; continuing where it left off.", machine: this.machine().name, ...this.agentLabel(sessionId),
      }, { collapseId: `done-${sessionId}` })
    }
  }

  /**
   * r73 B: continue turns this restart cut short. Only recent ones (`restartWindowMs`) and only where the agent keeps
   * its own session (a native id); a session without one would replay its whole transcript as a carry-over.
   */
  private planRestartResumes(cutShort: Array<{ sessionId: string; turnId: string; at: number }>) {
    if (cutShort.length === 0 || !this.settingOn("continue_after_restart")) return
    const now = Date.now()
    const due = cutShort.filter((entry) => {
      const session = this.store.getSession(entry.sessionId)
      return session && session.archived !== 1 && session.native_id && now - entry.at <= this.autoResume.restartWindowMs
    })
    if (due.length === 0) return
    const timer = setTimeout(() => {
      if (this.shuttingDown || !this.settingOn("continue_after_restart")) return
      for (const entry of due) {
        if (!this.canContinue(entry.sessionId, entry.turnId, "interrupted")) continue
        const session = this.store.getSession(entry.sessionId)
        const row = this.store.getTurn(entry.turnId)
        if (!session || !row) continue
        // A continuation's buffered output died with the agent process: there is nothing to resume.
        if (promptOrigin(this.store.getMessage(row.user_message_id)) === "agent_continue") continue
        const execution = row.execution ? JSON.parse(row.execution) as TurnExecutionIdentity : undefined
        const generation = session.generation ?? 0
        if (execution && (execution.generation !== generation || execution.agentId !== session.agent
          || (execution.nativeSessionId && execution.nativeSessionId !== session.native_id))) continue
        const claim = this.store.claimRestartResume(row.id, generation)
        if (claim === "accepted" || claim === "obsolete") continue
        const identity: SendIdentity = { sessionId: entry.sessionId, deviceId: "daemon:restart",
          clientMessageId: restartMessageId(row.id, generation), requestHash: createHash("sha256").update(RESUME_PROMPT).digest("hex") }
        try {
          this.sendMessage(entry.sessionId, RESUME_PROMPT, undefined, [], true, identity, undefined, "restart_resume")
          this.store.completeRestartResume(row.id, generation)
        } catch (error) { console.warn(`rudderd: restart continuation for ${row.id} failed:`, error) }
      }
    }, this.autoResume.restartDelayMs)
    timer.unref?.()
  }

  private continueTurn(sessionId: string, origin: "auto_resume" | "restart_resume"): boolean {
    try {
      this.sendMessage(sessionId, RESUME_PROMPT, undefined, [], true, undefined, undefined, origin)
      return true
    } catch (error) {
      console.warn(`rudderd: continuing ${sessionId} (${origin}) failed:`, error)
      return false
    }
  }

  private createHandoff(options: HandoffOptions): Handoff {
    const agentProcesses = () => this.adapters.list().flatMap((adapter) => adapter.processes?.() ?? [])
    const handoff = new Handoff(
      {
        store: this.store,
        broadcast: this.broadcast,
        publicSession: (id) => this.publicSession(id),
        isGenerating: (id) => this.generating.has(id) || this.startingQueued.has(id),
        daemonPids: () => new Set(agentProcesses().map((entry) => entry.pid)),
        activeSessions: () => new Set([...this.generating, ...this.startingQueued, ...agentProcesses().flatMap((entry) => entry.sessionIds)]),
        hasAgentProcess: (id) => agentProcesses().some((entry) => entry.sessionIds.includes(id)),
        releaseAgent: (session) => this.adapters.get(session.agent)?.release?.(session.id),
        stopTurn: (id) => this.stopTurn(id),
        holderReleased: (id) => this.flushOutbound(id),
        adapter: (agent) => this.adapters.get(agent),
        agents: () => [...new Set(this.adapters.list().map((adapter) => adapter.spec.id))],
        permissionMode: (agent) => this.choosePermissionMode(agent, "ask"),
        writable: (cwd) => {
          try {
            if (cwd) resolveSafe(cwd, this.hooks.workspaceRoot ?? WORKSPACE_ROOT)
            return true
          } catch {
            return false
          }
        },
      },
      options,
    )
    handoff.start()
    return handoff
  }

  private requireHandoff(): Handoff {
    if (!this.handoff) throw Object.assign(new Error("session handoff is not available on this computer"), { code: "unknown_method" })
    return this.handoff
  }

  /** `rudder attach` over the local channel (local.ts). */
  attachLocal(body: Record<string, unknown>) {
    return this.requireHandoff().attach(body)
  }

  attachLocalDone(body: Record<string, unknown>): Promise<{ added: number }> {
    return this.requireHandoff().attachDone(body)
  }

  async invoke(method: string, params: Record<string, unknown> | undefined, id: string, context: { deviceKey?: string } = {}): Promise<Frame> {
    const started = Date.now()
    try {
      // A method that reads a session's rows sees what the sockets were already sent. Only that session, and only for
      // those methods: every request settling every stream rewrote a 1 MB reply 527 times with a phone polling drafts.
      const reads = transcriptReader(method, params)
      if (reads) this.persistStream(reads)
      const result = await this.dispatch(method, params ?? {}, context, id)
      // The settings sheet sometimes stays empty on an older chat: say how each model list went (count and time).
      if (method === "models.list") {
        const count = Array.isArray((result as { models?: unknown[] }).models) ? (result as { models: unknown[] }).models.length : -1
        console.log(`rudderd: models.list ${String(params?.agent ?? "")} -> ${count} in ${Date.now() - started} ms`)
      }
      return resultFrame(id, result)
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error"
      const code = (error as { code?: string }).code ?? "failed"
      console.warn(`rudderd: ${method} failed after ${Date.now() - started} ms (${code}): ${message}`)
      return errorFrame(id, code, message, copyOf(error))
    }
  }

  private async dispatch(method: string, params: Record<string, unknown>, context: { deviceKey?: string }, requestId: string): Promise<unknown> {
    switch (method) {
      case "hello":
        return this.hello(context.deviceKey)
      case "session.list":
        return this.listSessions(params.sinceVersion)
      case "message.changes":
        return this.messageChanges(params)
      case "session.get": {
        const id = String(params.id ?? "")
        // Opening the transcript marks it read. A refresh of a chat the phone is not showing must not,
        // or thinking and tool rows written before the final answer never become unread.
        const current = this.store.getSession(id)
        if (!current) throw Object.assign(new Error("session not found"), { code: "not_found" })
        // 2026-11-12 (perf-1112 R6): a session.upsert (and a list version) only when this actually read something; a
        // chat already read went out to every phone and moved the list version on each open and reload.
        const reads = params.markRead !== false && (current.last_read_seq !== current.last_seq || current.marked_unread !== 0)
        const session = reads ? (this.store.markRead(id) ?? current) : current
        // The phone is opening this chat: the agent starts while the reader reads and types.
        if (params.markRead !== false) this.scheduleWarm(session.id, context.deviceKey ?? "")
        if (reads) this.broadcast(eventFrame("session.upsert", this.publicSession(session.id)!))
        const probed = await this.ensureSteerProbe(session.agent)
        // The socket is already focused, so deltas flushed during that await reached it: write them before reading
        // the rows and the cursor, with no await in between, or the snapshot would lag the cursor it claims.
        this.persistStream(session.id)
        // Read with the messages, after the await: the rows below hold every change up to this rev.
        const pub = this.publicSession(session.id)
        if (!pub) throw Object.assign(new Error("session not found"), { code: "not_found" })
        const adapter = this.adapters.get(pub.agent)
        const steer = pub.agent === session.agent ? probed
          : this.steerCache.get(pub.agent) ?? steerControl(pub.agent, adapter?.spec.capabilities.steer === true, typeof adapter?.steer === "function", null)
        const sync = this.syncCursor(session.id)
        if (params.outline === true) {
          const window = this.outlineWindow(session.id, { maxMessages: outlineLimit(params.limit) })
          return { session: pub, messages: window.messages, hasMore: window.hasMore, eventId: this.hooks.eventCursor?.(), steerControl: steer, ...sync }
        }
        const messages = this.store.listMessages(session.id, { limit: HISTORY_PAGE }).map(messagePublic)
        const oldest = messages[0]?.seq
        const hasMore = oldest !== undefined && this.store.listMessages(session.id, { beforeSeq: oldest, limit: 1 }).length > 0
        return { session: pub, messages, hasMore, eventId: this.hooks.eventCursor?.(), steerControl: steer, ...sync }
      }
      case "session.ack": {
        const current = this.store.getSession(String(params.id ?? ""))
        if (!current) throw Object.assign(new Error("session not found"), { code: "not_found" })
        // perf-1112 round two (R6): as in session.get, only an ack that reads something goes out to every phone.
        const reads = current.last_read_seq !== current.last_seq || current.marked_unread !== 0
        const session = reads ? (this.store.markRead(current.id) ?? current) : current
        const pub = this.publicSession(session.id)!
        if (reads) this.broadcast(eventFrame("session.upsert", pub))
        return { session: pub }
      }
      case "session.ackAll": {
        const sessions = this.store.markAllRead().map((row) => this.publicSession(row.id)!)
        for (const session of sessions) this.broadcast(eventFrame("session.upsert", session))
        return { sessions }
      }
      case "session.patch": {
        const id = String(params.id ?? "")
        const current = this.store.getSession(id)
        if (!current) throw Object.assign(new Error("session not found"), { code: "not_found" })
        const nextModel = typeof params.model === "string" ? params.model : current.model
        if (params.contextWindow !== undefined && params.contextWindow !== null) {
          await this.requireContextWindow(current.agent, nextModel, params.contextWindow)
        }
        let speed = typeof params.speed === "string" ? params.speed : undefined
        if (typeof params.model === "string" && speed === undefined && current.speed) {
          const offered = (await this.adapters.get(current.agent)?.listModels?.())?.find((entry) => entry.id === params.model)?.speeds ?? []
          if (!offered.some((choice) => choice.id === current.speed)) speed = ""
        }
        if (speed) await this.requireSpeed(current.agent, nextModel, speed)
        const cwd = typeof params.cwd === "string" ? resolveSafe(params.cwd) : undefined
        const permissionMode = params.permissionMode === undefined ? undefined : this.requirePermissionMode(id, params.permissionMode)
        const session = this.store.patchSession(id, {
          title: typeof params.title === "string" ? params.title : undefined,
          pinned: typeof params.pinned === "boolean" ? params.pinned : undefined,
          archived: typeof params.archived === "boolean" ? params.archived : undefined,
          cwd,
          model: typeof params.model === "string" ? params.model : undefined,
          contextWindow: params.contextWindow === null ? null : typeof params.contextWindow === "number" ? params.contextWindow : undefined,
          effort: typeof params.effort === "string" ? params.effort : undefined,
          speed,
          permissionMode,
          unread: typeof params.unread === "boolean" ? params.unread : undefined,
        })
        if (!session) throw Object.assign(new Error("session not found"), { code: "not_found" })
        if (permissionMode) {
          this.releaseForMode(session.id)
          this.adapters
            .get(session.agent)
            ?.setMode?.(session.id, permissionMode)
            .catch((error: unknown) => console.warn(`rudderd: live mode switch for ${session.id} failed; it applies next turn:`, error))
        }
        const pub = this.publicSession(session.id)!
        this.broadcast(eventFrame("session.upsert", pub))
        return { session: pub }
      }
      case "session.create":
        return this.createSession(params)
      case "session.delete": {
        const id = String(params.id ?? "")
        return this.withSessionMutation(id, () => this.deleteSession(id))
      }
      case "session.clear": {
        const id = String(params.id ?? "")
        return this.withSessionMutation(id, () => this.clearSession(id))
      }
      case "session.reopen":
        return this.reopenSession(String(params.id ?? ""))
      case "session.fork":
        return this.forkSession(String(params.id ?? ""), typeof params.title === "string" ? params.title : undefined)
      case "session.rewind": {
        const id = String(params.id ?? "")
        return this.withSessionMutation(id, () => this.rewindSession(id, params.seq, params.outline === true, outlineLimit(params.limit)))
      }
      case "session.switchAgent": {
        const id = String(params.id ?? "")
        return this.withSessionMutation(id, (owner) => this.switchAgent(id, params.agent, params.model, params.resume === true, owner))
      }
      case "session.export":
        return this.exportSession(String(params.id ?? ""))
      case "session.autoResume":
        return this.patchAutoResume(String(params.id ?? ""), params.cancel)
      case "message.send":
        return this.sendOnce(params, context.deviceKey)
      case "message.status": {
        const identity = this.identifySend(params, context.deviceKey)
        const record = this.store.getSend(identity)
        return record ? { found: true, ...this.sendResult(record.result) } : { found: false, clientMessageId: identity.clientMessageId }
      }
      case "message.steer":
        return this.steerMessage(String(params.sessionId ?? ""), String(params.action ?? "cancel"), String(params.text ?? ""))
      case "queue.list": {
        const sessionId = String(params.sessionId ?? "")
        const paused = this.pausedQueues.get(sessionId)
        return { items: this.outbound.get(sessionId) ?? [], ...(paused ? { paused } : {}) }
      }
      case "queue.resume":
        return this.resumeQueue(String(params.sessionId ?? ""))
      case "queue.remove":
        return this.removeQueued(String(params.sessionId ?? ""), String(params.id ?? ""))
      case "queue.steer":
        return this.steerQueued(String(params.sessionId ?? ""), String(params.id ?? ""))
      case "queue.send":
        return this.sendQueued(String(params.sessionId ?? ""), String(params.id ?? ""), context.deviceKey)
      case "queue.edit":
        return this.editQueued(params, context.deviceKey)
      case "queue.insert":
        if (typeof params.index !== "number" || !Number.isSafeInteger(params.index) || params.index < 0) {
          throw Object.assign(new Error("queue index must be a nonnegative integer"), { code: "invalid" })
        }
        return this.sendOnce(params, context.deviceKey, params.index)
      case "permission.rules":
        return { rules: this.rules.filter((rule) => rule.sessionId === String(params.sessionId ?? "")).map(rulePublic) }
      case "permission.revoke":
        return this.revokeRule(String(params.id ?? ""))
      case "permission.restore":
        return this.restoreRule(String(params.id ?? ""))
      case "background.stop":
        return this.stopBackground(String(params.sessionId ?? ""))
      case "permission.remove":
        return this.removeRule(String(params.id ?? ""))
      case "message.search":
        return this.searchSession(String(params.sessionId ?? ""), params)
      case "history.page":
        return this.historyPage(String(params.sessionId ?? ""), Number(params.beforeSeq ?? 0), params.limit, params.outline === true)
      case "message.bodies": {
        const paged = params.paged === true
        if (paged && params.offset !== undefined && (typeof params.offset !== "number" || !Number.isInteger(params.offset))) {
          throw Object.assign(new Error("body offset must be an integer array index"), { code: "invalid" })
        }
        return this.messageBodies(String(params.sessionId ?? ""), params.ids, {
          paged, offset: typeof params.offset === "number" ? params.offset : 0, requestId,
        })
      }
      case "attachment.put":
        return this.putAttachment(params, context.deviceKey)
      case "attachment.get":
        return this.getAttachment(params)
      case "turn.preview":
        return this.previewTurnSlice(params)
      case "file.stat":
        return this.fileCall(params, (located) => this.files.stat(located, fileVariant(params.variant)))
      case "file.thumb":
        return this.fileCall(params, (located) => this.files.thumb(located))
      case "file.get":
        return this.fileCall(params, (located) => this.files.slice(located, fileVariant(params.variant), params.offset, params.length))
      case "file.ship":
        return this.fileCall(params, (located) => this.files.ship(located, fileVariant(params.variant), params.blob))
      case "attachment.fetch":
        return this.fetchAttachment(params)
      case "permission.respond":
        return this.respondPermission(String(params.id ?? ""), params)
      case "question.respond":
        return this.respondQuestion(String(params.id ?? ""), params)
      case "config.set":
        return this.setConfig(params)
      case "machine.get":
        return { machine: this.machine() }
      case "machine.patch":
        return this.patchMachine(params)
      case "fs.list":
        return listDir(String(params.path ?? "."))
      case "fs.read":
        return readWorkspaceFile(String(params.path ?? ""))
      case "fs.search":
        return searchFiles(String(params.query ?? ""), String(params.path ?? "."))
      case "git.status":
        return gitStatus(String(params.cwd ?? params.path ?? "."))
      case "turn.changes":
        return this.turnChanges(String(params.sessionId ?? ""), String(params.turnId ?? ""), params.summaryOnly === true)
      case "turn.diff":
        return this.turnDiff(String(params.sessionId ?? ""), String(params.turnId ?? ""), String(params.path ?? ""))
      case "git.diff":
        return gitDiff(String(params.cwd ?? params.path ?? "."), typeof params.file === "string" && params.file ? params.file : undefined)
      case "skills.list":
        return { skills: SKILLS }
      case "agent.diagnostics": {
        const session = this.store.getSession(String(params.sessionId ?? ""))
        if (!session) throw Object.assign(new Error("session not found"), { code: "not_found" })
        const adapter = this.adapters.get(session.agent)
        if (!adapter?.diagnostics) throw Object.assign(new Error("native diagnostics are not supported by this agent"), { code: "unsupported" })
        const snapshot = await adapter.diagnostics(session.cwd || WORKSPACE_ROOT, session.native_id ?? undefined)
        return { diagnostics: { ...snapshot, ...(session.native_id ? { nativeId: session.native_id } : {}), permissionSource: session.permission_mode === "native" ? snapshot.permissionSource : "override" } }
      }
      case "commands.list":
        return this.listCommands(String(params.sessionId ?? ""))
      case "models.list":
        return this.listModels(params)
      case "scheduled.list":
        return {
          scheduled: this.store.listScheduled(typeof params.sessionId === "string" ? params.sessionId : undefined).map(scheduledPublic),
        }
      case "scheduled.cancel":
        return this.cancelScheduled(String(params.id ?? ""))
      case "draft.set":
        return this.setDraft(
          String(params.sessionId ?? ""),
          String(params.text ?? ""),
          typeof params.ifText === "string" ? params.ifText : undefined,
        )
      case "draft.get":
        return this.getDraft(String(params.sessionId ?? ""))
      case "draft.list":
        return { drafts: this.store.listDrafts().map((row) => ({ sessionId: row.session_id, text: row.text, updatedAt: row.updated_at })) }
      case "device.registerPush":
        return this.registerPush(context.deviceKey, String(params.ticket ?? ""), params.prefs, params.liveStart)
      case "device.list":
        return {
          devices: this.store.listDevices().map((row) => ({
            id: row.id,
            name: row.name,
            createdAt: row.created_at,
            current: context.deviceKey !== undefined && row.session_key === context.deviceKey,
          })),
        }
      case "device.revoke":
        return this.revokeDevice(String(params.id ?? ""))
      case "usage.get":
        return { usage: this.store.usage(), machine: this.machine() }
      case "usage.summary":
        return this.usageSummary(params)
      case "usage.limits":
        return { generatedAt: Date.now(), limits: await this.quotaLimits() }
      case "liveActivity.register":
        if (params.scope === "computer") {
          if (!this.hooks.card) throw Object.assign(new Error("live activities are off"), { code: "failed" })
          return this.hooks.card.register({
            activityId: String(params.activityId ?? ""),
            pushToken: String(params.pushToken ?? ""),
            keepSeconds: typeof params.keepSeconds === "number" ? params.keepSeconds : Number(params.keepSeconds ?? 900),
            locale: reportedLanguage(params),
            deviceKey: context.deviceKey,
          })
        }
        return this.requireLive().register({
          sessionId: String(params.sessionId ?? ""),
          activityId: String(params.activityId ?? ""),
          pushToken: String(params.pushToken ?? ""),
          keepSeconds: typeof params.keepSeconds === "number" ? params.keepSeconds : Number(params.keepSeconds ?? 900),
          locale: reportedLanguage(params),
          deviceKey: context.deviceKey,
        })
      case "liveActivity.end":
        await this.hooks.card?.end(String(params.activityId ?? ""))
        return this.requireLive().end(String(params.activityId ?? ""))
      case "handoff.list":
        return this.requireHandoff().list(params)
      case "handoff.inspect":
        return this.requireHandoff().inspect(params)
      case "handoff.import":
        return this.requireHandoff().import(params)
      case "handoff.importEarlier":
        return this.requireHandoff().importEarlier(params)
      case "handoff.takeover":
        return this.requireHandoff().takeover(params)
      case "handoff.cancelTakeover":
        return this.requireHandoff().cancelTakeover(params)
      case "handoff.release":
        return this.requireHandoff().release(params)
      default:
        throw Object.assign(new Error(`unknown method ${method}`), { code: "unknown_method" })
    }
  }

  /** Fires scheduled sends as they fall due (server.ts). Without it only explicit `tickScheduled` calls fire them. */
  startScheduler() {
    this.scheduler ??= { timer: null }
    this.armScheduler()
  }

  stopScheduler() {
    if (this.scheduler?.timer) clearTimeout(this.scheduler.timer)
    this.scheduler = null
  }

  // Aims the one timer at the earliest pending job; none pending, no timer.
  private armScheduler() {
    const scheduler = this.scheduler
    if (!scheduler) return
    if (scheduler.timer) clearTimeout(scheduler.timer)
    scheduler.timer = null
    const at = this.store.nextScheduledAt()
    if (at === null) return
    const wait = at - Date.now()
    const timer = setTimeout(
      () => {
        if (scheduler.timer !== timer) return
        scheduler.timer = null
        void this.tickScheduled()
      },
      wait > 0 ? Math.min(wait, SCHEDULE_MAX_WAIT_MS) : SCHEDULE_RETRY_MS,
    )
    timer.unref?.()
    scheduler.timer = timer
  }

  async tickScheduled() {
    try {
      await this.fireDueScheduled()
    } finally {
      this.armScheduler()
    }
  }

  private async fireDueScheduled() {
    for (const job of this.store.dueScheduled()) {
      // A busy session keeps the job pending; it fires on the first tick after the turn ends.
      if (this.generating.has(job.session_id) || this.startingQueued.has(job.session_id) || this.sessionMutations.has(job.session_id)) continue
      // A terminal holds the session: the job stays pending until it gives the session back.
      if (this.handoff?.heldElsewhere(job.session_id)) continue
      const claimed = this.store.claimScheduled(job.id, "sent")
      if (!claimed) continue
      this.broadcast(eventFrame("scheduled.fired", scheduledPublic(claimed)))
      const session = this.store.getSession(job.session_id)
      if (session) this.broadcast(eventFrame("session.upsert", this.publicSession(session.id)))
      try {
        await this.sendMessage(job.session_id, job.text)
      } catch (error) {
        const message = error instanceof Error ? error.message : "scheduled send failed"
        this.broadcast(eventFrame("scheduled.failed", { id: job.id, sessionId: job.session_id, message }))
      }
    }
  }

  private async hello(deviceKey?: string) {
    const agents = await this.agentList({ cached: true })
    this.publishedAgents = JSON.stringify(agents)
    void this.refreshAgents()
    return {
      ok: true,
      agent: "claude",
      mode: agents.length > 0 && agents.every((agent) => agent.transport === "fake") ? "fake" : "live",
      permissionMode: this.configPermissionMode(),
      machine: this.machine(),
      models: STATIC_MODELS,
      agents,
      skills: SKILLS,
      version: APP_VERSION,
      features: ["compaction", "contextWindow", "lastTurn", "turnChanges"],
      sendEpoch: this.sendEpoch,
      senderId: this.senderId(deviceKey),
      // r68 0-2: whether this machine still holds the phone's push ticket; the phone registers again when it does not.
      push: { registered: Boolean(deviceKey && this.store.deviceByKey(deviceKey)?.push_token) },
      // takes `liveActivity.register {scope: "computer"}`. An older rudderd omits it and the phone keeps one card
      // per session.
      ...(this.hooks.card ? { liveCard: true } : {}),
    }
  }

  /**
   * Probes every agent again (each adapter caches its own answer, see `cachedDetect`) and broadcasts `agents.upsert`
   * when the list differs from what the last hello or upsert said. Concurrent calls share one run. Started at launch
   * so the first hello finds answers, and after each hello so a stale one corrects itself.
   */
  refreshAgents(): Promise<void> {
    this.agentRefresh ??= (async () => {
      try {
        const agents = await this.agentList()
        const key = JSON.stringify(agents)
        if (this.publishedAgents !== undefined && key !== this.publishedAgents) {
          this.broadcast(eventFrame("agents.upsert", { agents }))
        }
        this.publishedAgents = key
      } catch (error) {
        console.warn(`rudderd: agent refresh failed: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        this.agentRefresh = undefined
      }
    })()
    return this.agentRefresh
  }

  /** `cached`: an agent probed before answers from that result; one never probed is still awaited. */
  private async agentList(options: { cached?: boolean } = {}) {
    return Promise.all(
      this.adapters.list().map(async (adapter) => {
        const version = this.noteAgentVersion(adapter)
        const known = options.cached ? this.knownAvailability.get(adapter.spec.id) : undefined
        const availability = known ? this.versionGate(adapter, known) : await this.availability(adapter)
        const live = adapter.listPermissionModes?.()
        // A live list replaces the static one. Auto-approval also replaces it when there is no live list,
        // so a static "ask" is never published. Other agents keep the spec object untouched (hello equality).
        const replaceModes = Boolean(adapter.spec.capabilities.autoApproval) || Boolean(live?.length)
        return {
          id: adapter.spec.id,
          label: adapter.spec.label,
          transport: adapter.spec.transport,
          experimental: adapter.spec.experimental,
          available: availability.available,
          unavailableReason: availability.available ? undefined : availability.reason,
          // r48: lets the phone word the reason in its own language (not_installed · auth_required · failed).
          unavailableCode: availability.available ? undefined : (availability.code ?? unavailableCode(availability.reason)),
          // The reason as a code with its arguments, worded by the phone in its own language (phone-copy.ts).
          ...(!availability.available && availability.reasonCopy ? { unavailableCopy: availability.reasonCopy } : {}),
          // v83: the phone words 「需 x.y+」 and shows the upgrade command (only sent when the install is known).
          ...(adapter.spec.minimumVersion ? { minimumVersion: adapter.spec.minimumVersion } : {}),
          ...(availability.upgradeCommand ? { upgradeCommand: availability.upgradeCommand } : {}),
          // v71: the agent's own settings pin its permission mode (Grok always-approve); the phone shows it as such.
          ...(availability.permissionLock ? { permissionLock: availability.permissionLock } : {}),
          capabilities: replaceModes
            ? { ...adapter.spec.capabilities, ...capabilityModes(this.publishedModeInfos(adapter)) }
            : adapter.spec.capabilities,
          ...(version ? { version } : {}),
        }
      }),
    )
  }

  // Starts adapter.version() and returns only a value that has already settled: the first hello does not wait for
  // the probe. The registry probes again after an upgrade replaced the binary; a changed answer is published.
  private noteAgentVersion(adapter: AgentAdapter): string | undefined {
    const id = adapter.spec.id
    const probe = adapter.version?.()
    if (probe && this.versionProbes.get(id) !== probe) {
      this.versionProbes.set(id, probe)
      probe.then(
        (value) => {
          if (this.versionProbes.get(id) !== probe) return
          const before = this.agentVersions.get(id)
          if (value) this.agentVersions.set(id, value)
          else this.agentVersions.delete(id)
          if (before !== value) void this.refreshAgents()
        },
        () => {},
      )
    }
    return this.agentVersions.get(id)
  }

  /** The version this turn is gated on: waits for the probe (cached per binary), unlike hello. */
  private async settledAgentVersion(adapter: AgentAdapter): Promise<void> {
    // Only a version gate needs the answer; other agents start without an extra await.
    if (!adapter.spec.minimumVersion) return
    this.noteAgentVersion(adapter)
    await this.versionProbes.get(adapter.spec.id)?.catch(() => undefined)
  }

  // v83: installed and signed in but older than the spec's minimum counts as unavailable, with an upgrade command.
  private versionGate(adapter: AgentAdapter, availability: Availability): Availability {
    const minimum = adapter.spec.minimumVersion
    const version = this.agentVersions.get(adapter.spec.id)
    if (!availability.available || !minimum || !version || compareVersions(version, minimum) >= 0) return availability
    const upgradeCommand = adapter.upgradeCommand?.()
    const reason = phoneCopy.agentOutdated(adapter.spec.label, version, minimum)
    return {
      available: false,
      reason: reason.text,
      reasonCopy: reason,
      code: "outdated",
      ...(upgradeCommand ? { upgradeCommand } : {}),
    }
  }

  /** Drops the session's agent's cached detect answer and probes again, so the list stops calling it available. */
  private forgetAvailability(sessionId: string) {
    const agent = this.store.getSession(sessionId)?.agent
    const adapter = agent ? this.adapters.get(agent) : undefined
    if (!adapter?.forgetDetect) return
    adapter.forgetDetect()
    this.knownAvailability.delete(adapter.spec.id)
    void this.refreshAgents()
  }

  private async availability(adapter: AgentAdapter): Promise<Availability> {
    if (!adapter.detect) return this.versionGate(adapter, { available: true })
    let result: Availability
    try {
      result = await adapter.detect()
    } catch (error) {
      result = { available: false, reason: error instanceof Error ? error.message : String(error) }
    }
    this.knownAvailability.set(adapter.spec.id, result)
    return this.versionGate(adapter, result)
  }

  /** The composer's `/` list for a session: its agent's skills and commands in the session's folder. */
  private async listCommands(sessionId: string) {
    const session = this.store.getSession(sessionId)
    if (!session) throw Object.assign(new Error("session not found"), { code: "not_found" })
    const adapter = this.adapters.get(session.agent)
    return { commands: adapter?.listCommands ? await adapter.listCommands(session.cwd || WORKSPACE_ROOT) : [] }
  }

  private async listModels(params: Record<string, unknown>) {
    const agents = await this.agentList()
    const agentId = typeof params.agent === "string" && params.agent ? params.agent : undefined
    if (!agentId) return { models: STATIC_MODELS, agents }
    const adapter = this.adapters.get(agentId)
    if (!adapter) throw Object.assign(new Error(`unknown agent ${agentId}`), { code: "invalid" })
    const listed = adapter.listModels ? await adapter.listModels() : STATIC_MODELS
    const refused = this.effortRefused(agentId)
    // a model that once refused a reasoning effort publishes none, so the phone greys the effort tab.
    const models = listed.map((model) => {
      if (!refused.has(model.id)) return model
      const { defaultEffort: _default, ...rest } = model
      return { ...rest, efforts: [] }
    })
    return { models, agents, modes: this.permissionModes(agentId) }
  }

  /** Model ids per agent that refused a reasoning effort (`effortRefused`), kept in meta so a restart remembers them. */
  private effortRefusals(): Record<string, string[]> {
    try {
      const parsed: unknown = JSON.parse(this.store.getMeta("effort_refused") ?? "{}")
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
      return Object.fromEntries(
        Object.entries(parsed).map(([agent, ids]) => [agent, Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : []]),
      )
    } catch {
      return {}
    }
  }

  private effortRefused(agent: string): Set<string> {
    return new Set(this.effortRefusals()[agent] ?? [])
  }

  private rememberEffortRefused(agent: string, model: string) {
    const all = this.effortRefusals()
    const ids = all[agent] ?? []
    if (ids.includes(model)) return
    all[agent] = [...ids, model]
    this.store.setMeta("effort_refused", JSON.stringify(all))
    console.log(`rudderd: ${agent} model ${model} takes no reasoning effort; models.list now publishes none for it`)
  }

  // The agent's permission-mode list: what a live session advertised (ACP) or else its static list. §6.
  // Auto-approval agents drop "ask" here, including when the live list mapped default/agent back to ask.
  private permissionModes(agentId: string): PermissionModeInfo[] {
    const adapter = this.adapters.get(agentId)
    return adapter ? this.publishedModeInfos(adapter) : []
  }

  private publishedModeInfos(adapter: AgentAdapter): PermissionModeInfo[] {
    const live = adapter.listPermissionModes?.()
    const modes = live?.length ? live : (adapter.spec.capabilities.modes ?? [])
    const published = adapter.spec.capabilities.autoApproval ? modesForAutoApproval(modes) : modes
    // A live ACP list replaces the static one and would hide a mode the agent never advertises as a mode
    // (Grok bypassPermissions is a launch flag, Copilot's is its allow_all option). Put those back from the static list.
    if (!live?.length) return published
    const have = new Set(published.map((mode) => mode.id))
    const restartOnly = (adapter.spec.capabilities.modes ?? []).filter(
      (mode) => (mode.restart || mode.id === "bypassPermissions") && !have.has(mode.id),
    )
    return restartOnly.length ? [...published, ...restartOnly] : published
  }

  // Ids a session may be switched to. Auto-approval agents publish only the filtered list, so a static
  // "ask" is not unioned back in. Everyone else keeps the static ids plus anything a live session added.
  private supportedModes(agentId: string): RudderPermissionMode[] {
    const adapter = this.adapters.get(agentId)
    if (!adapter) return ["ask"]
    if (adapter.spec.capabilities.autoApproval) {
      const ids = this.publishedModeInfos(adapter).map((mode) => mode.id)
      return ids.length ? ids : ["autoApproval"]
    }
    const ids = new Set<RudderPermissionMode>(adapter.spec.capabilities.permissionModes ?? ["ask"])
    for (const mode of adapter.listPermissionModes?.() ?? []) ids.add(mode.id)
    return [...ids]
  }

  // Permission policy for modes the agent reports on its own: only a mode this agent publishes, that is not danger
  // and needs no restart. Danger modes (bypassPermissions, fullAccess) come only from a session.patch the phone confirmed.
  private agentMayEnterMode(agentId: string, mode: RudderPermissionMode): boolean {
    const adapter = this.adapters.get(agentId)
    if (!adapter) return false
    // A live list may relabel an id the static list knows as danger; either list saying danger or restart refuses.
    const infos = [...this.publishedModeInfos(adapter), ...(adapter.spec.capabilities.modes ?? [])].filter((info) => info.id === mode)
    return infos.length > 0 && infos.every((info) => info.risk !== "danger" && info.restart !== true)
  }

  private requirePermissionMode(sessionId: string, value: unknown): RudderPermissionMode {
    const session = this.store.getSession(sessionId)
    if (!session) throw Object.assign(new Error("session not found"), { code: "not_found" })
    if (typeof value !== "string") {
      throw Object.assign(new Error(`permissionMode ${String(value)} is not supported by ${session.agent}`), { code: "invalid" })
    }
    const supported = this.supportedModes(session.agent)
    // An old app still sends "ask" for Grok. That agent cannot ask, so store the mode the phone now shows.
    const mode = value === "ask" && supported.includes("autoApproval") ? "autoApproval" : value
    if (!supported.includes(mode)) {
      throw Object.assign(new Error(`permissionMode ${String(value)} is not supported by ${session.agent}`), { code: "invalid" })
    }
    return mode
  }

  // Create accepts an unknown mode (falls back) instead of throwing. "ask" on an auto-approval agent becomes autoApproval.
  private choosePermissionMode(agentId: string, requested: unknown): RudderPermissionMode {
    const supported = this.supportedModes(agentId)
    const asked = typeof requested === "string" ? requested : "ask"
    if (supported.includes(asked)) return asked
    if (asked === "ask" && supported.includes("autoApproval")) return "autoApproval"
    if (supported.includes("ask")) return "ask"
    return supported[0] ?? "ask"
  }

  // What this turn's CLI actually runs. An empty live list has not advertised yet, so a mode id that
  // only a previous session reported is left stored. A list that is present and no longer contains the
  // stored id is written back, so the phone's switch matches the process. Legacy "ask" on an
  // auto-approval agent is sent as autoApproval and left in the row; presentRow already shows that.
  private modeForLaunch(agentId: string, stored: string): { mode: RudderPermissionMode; persist: boolean } {
    const adapter = this.adapters.get(agentId)
    const mode = stored || "ask"
    if (!adapter) return { mode, persist: false }
    if (mode === "ask" && adapter.spec.capabilities.autoApproval) return { mode: "autoApproval", persist: false }
    const live = adapter.listPermissionModes?.() ?? []
    if (live.length === 0) return { mode, persist: false }
    const next = this.choosePermissionMode(agentId, mode)
    return { mode: next, persist: next !== mode }
  }

  // v53 quota card: every adapter that reports subscription limits, each bounded so a slow agent cannot hold the
  // summary. An agent that fails is left out (the phone keeps its cached copy).
  private async quotaLimits() {
    const adapters = this.adapters.list().filter((adapter) => adapter.limits)
    const limit = this.hooks.quotaTimeoutMs ?? QUOTA_TIMEOUT_MS
    const read = await Promise.all(
      adapters.map(async (adapter) => {
        const id = adapter.spec.id
        const row = (quota: AgentQuota | undefined) => (quota ? [{ agent: id, label: adapter.spec.label, ...quota }] : [])
        try {
          const quota = await Promise.race<AgentQuota | undefined | typeof QUOTA_LATE>([adapter.limits!(), Bun.sleep(limit).then(() => QUOTA_LATE)])
          // Slow (Claude starts a CLI to read, 2–6 s and more on a busy Mac): the last numbers, not a missing agent.
          if (quota === QUOTA_LATE) return row(this.lastQuota.get(id))
          if (quota) this.lastQuota.set(id, quota)
          else this.lastQuota.delete(id)
          return row(quota)
        } catch (error) {
          console.warn(`${id} limits failed: ${error instanceof Error ? error.message : String(error)}`)
          return row(this.lastQuota.get(id))
        }
      }),
    )
    return read.flat()
  }

  /** At start: each agent's quota is read once, unhurried, so the first ask from a phone has numbers to show. */
  async warmQuota() {
    await Promise.all(
      this.adapters.list().filter((adapter) => adapter.limits).map(async (adapter) => {
        try {
          const quota = await adapter.limits!()
          if (quota) this.lastQuota.set(adapter.spec.id, quota)
        } catch {
          // The phone's own ask reports it.
        }
      }),
    )
  }

  private async usageSummary(params: Record<string, unknown>) {
    const query = readUsageQuery(params)
    const summary = this.store.usageSummary(query)
    const label = (agent: string) => this.adapters.get(agent)?.spec.label ?? agent
    const limits = await this.quotaLimits()
    return {
      machine: { name: this.machine().name },
      generatedAt: Date.now(),
      range: { from: query.from ?? null, to: query.to ?? null },
      totals: summary.totals,
      byDay: summary.byDay,
      byAgent: summary.byAgent.map(({ agent, ...totals }) => ({ agent, label: label(agent), ...totals })),
      byModel: summary.byModel,
      limits,
    }
  }

  // `platform` lets the phone pick the path separator and the OS label before the first perf sample.
  machine() {
    const identity = this.hooks.machineIdentity?.()
    return {
      name: this.store.getMeta("machine_name") || hostname(),
      cwd: WORKSPACE_ROOT,
      home: homedir(),
      platform: this.hooks.platform ?? process.platform,
      ...(identity?.model ? { model: identity.model } : {}),
      ...(identity?.osVersion ? { osVersion: identity.osVersion } : {}),
      autoResumeLimits: this.settingOn("auto_resume_limits"),
      continueAfterRestart: this.settingOn("continue_after_restart"),
    }
  }

  private publicSession(id: string) {
    const row = this.store.getSession(id)
    if (!row) return null
    const pub = this.presentRow(row, {
      scheduledCount: this.store.scheduledCount(id),
      pending: this.pendingKind(id),
      step: this.steps.get(id)?.step,
    })
    const open = this.backgroundOpen.get(id) ?? 0
    const tasks = this.backgroundTasks.get(id)
    const resume = this.store.getLimitResume(id)
    return {
      ...pub,
      ...(open > 0 ? { backgroundOpen: open } : {}),
      ...(tasks?.length ? { backgroundTasks: tasks } : {}),
      ...(resume ? { autoResumeAt: resume.resets_at } : {}),
    }
  }

  // Rows written before autoApproval existed still say "ask". The phone should see the same mode as the banner.
  private presentRow(row: Parameters<typeof sessionPublic>[0], extras: Parameters<typeof sessionPublic>[1]) {
    const turn = this.latestTurns.get(row.id)
    const outcome = lastTurnPublic(turn)
    // The failure as phone copy rides beside `lastTurn`, so the list words it in the phone's language.
    const { reasonCopy, ...lastTurn } = outcome ?? {}
    const pub = {
      ...sessionPublic(row, extras),
      turn: turn ? turnPublic(turn) : undefined,
      ...(outcome ? { lastTurn } : {}),
      ...(outcome && reasonCopy ? { lastResultCopy: reasonCopy } : {}),
      ...(this.handoff ? this.handoff.publicFields(row as SessionRow) : {}),
    }
    if (pub.permissionMode === "ask" && this.adapters.get(row.agent)?.spec.capabilities.autoApproval) {
      return { ...pub, permissionMode: "autoApproval" }
    }
    return pub
  }

  // A pending approval outranks a pending question: it blocks a tool the agent is about to run.
  private pendingKind(sessionId: string): PendingKind | null {
    if ([...this.pendingPermissions.values()].some((entry) => entry.sessionId === sessionId)) return "permission"
    if ([...this.pendingQuestions.values()].some((entry) => entry.sessionId === sessionId)) return "question"
    return null
  }

  /** One pass over the open requests for a whole list; a permission is never overwritten by a question. */
  private pendingKinds(): Map<string, PendingKind> {
    const kinds = new Map<string, PendingKind>()
    for (const entry of this.pendingPermissions.values()) kinds.set(entry.sessionId, "permission")
    for (const entry of this.pendingQuestions.values()) if (!kinds.has(entry.sessionId)) kinds.set(entry.sessionId, "question")
    return kinds
  }

  private async createSession(params: Record<string, unknown>) {
    const agent = typeof params.agent === "string" && params.agent ? params.agent : "claude"
    if (!this.adapters.get(agent)) throw Object.assign(new Error(`unknown agent ${agent}`), { code: "invalid" })
    const cwd = typeof params.cwd === "string" && params.cwd.trim() ? resolveSafe(params.cwd) : WORKSPACE_ROOT
    // r48: a folder that is gone (the phone pre-fills the last one) is refused here, not at the first turn.
    if (!isDirectory(cwd)) throw Object.assign(new Error(`folder not found: ${cwd}`), { code: "not_found" })
    const requested = params.permissionMode === undefined ? this.defaultPermissionMode() : params.permissionMode
    const permissionMode = this.choosePermissionMode(agent, requested)
    const model = typeof params.model === "string" ? params.model : ""
    const contextWindow = typeof params.contextWindow === "number" ? params.contextWindow : undefined
    if (contextWindow !== undefined) await this.requireContextWindow(agent, model, contextWindow)
    const speed = typeof params.speed === "string" ? params.speed : ""
    if (speed) await this.requireSpeed(agent, model, speed)
    const steer = await this.ensureSteerProbe(agent)
    const title = typeof params.title === "string" ? params.title : undefined
    const session = this.store.createSession({
      title,
      autoTitle: params.autoTitle === true || !title?.trim() || DEFAULT_TITLES.has(title.trim()),
      agent,
      cwd,
      // Empty leaves the agent on its own configured default model.
      model,
      contextWindow,
      effort: typeof params.effort === "string" ? params.effort : "",
      speed,
      permissionMode,
    })
    const pub = this.publicSession(session.id)!
    this.broadcast(eventFrame("session.upsert", pub))
    this.broadcast(eventFrame("machine.upsert", this.machine()))
    return { session: pub, steerControl: steer }
  }

  private async ensureSteerProbe(agent: string): Promise<SteerControl> {
    const cached = this.steerCache.get(agent)
    if (cached) return cached
    const adapter = this.adapters.get(agent)
    const probed = adapter?.probeSteer ? await adapter.probeSteer() : null
    const capability = adapter?.spec.capabilities.steer === true
    const hasSteer = typeof adapter?.steer === "function"
    // No process to ask yet. Do not cache that: the next turn may connect and answer.
    if (probed === "unavailable") return steerControl(agent, capability, hasSteer, null)
    const control = steerControl(agent, capability, hasSteer, probed)
    this.steerCache.set(agent, control)
    return control
  }

  private async requireSpeed(agent: string, model: string, value: string) {
    const models = await this.adapters.get(agent)?.listModels?.()
    const offered = models?.find((entry) => entry.id === model)?.speeds ?? []
    if (!offered.some((choice) => choice.id === value)) {
      throw Object.assign(new Error(`${agent} model "${model}" does not offer speed ${value}`), { code: "invalid" })
    }
  }

  private async requireContextWindow(agent: string, model: string, value: unknown) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
      throw Object.assign(new Error("contextWindow must be a positive integer"), { code: "invalid" })
    }
    const models = await this.adapters.get(agent)?.listModels?.()
    const offered = models?.find((entry) => entry.id === model)?.contextWindows ?? []
    if (!offered.includes(value)) {
      throw Object.assign(new Error(`${agent} model "${model}" does not offer contextWindow ${value}`), { code: "invalid" })
    }
  }

  // A busy session is stopped first so deleting it takes one action (owner, 2026-10-22).
  private async deleteSession(id: string) {
    const session = this.store.getSession(id)
    if (!session) throw Object.assign(new Error("session not found"), { code: "not_found" })
    if (this.generating.has(id)) await this.stopTurn(id, STOP_GRACE_MS, "session_removed")
    await this.turnSettled(id)
    this.requireIdle(id)
    this.cancelQueued(id)
    this.hooks.live?.forget(id)
    this.hooks.card?.forget(id)
    this.store.deleteSession(id)
    this.latestTurns.delete(id)
    this.steps.delete(id)
    this.turnTools.delete(id)
    for (let index = this.rules.length - 1; index >= 0; index -= 1) {
      if (this.rules[index]!.sessionId === id) this.rules.splice(index, 1)
    }
    this.pendingSteer.delete(id)
    this.forgetAgentSession(session)
    await removeAttachments(session.cwd || WORKSPACE_ROOT, id)
    this.broadcast(eventFrame("session.removed", { id }))
    return { ok: true }
  }

  private async clearSession(id: string) {
    const session = this.store.getSession(id)
    if (!session) throw Object.assign(new Error("session not found"), { code: "not_found" })
    this.handoff?.gate(id)
    this.requireIdle(id)
    await this.turnSettled(id)
    const files = await this.restoreRemovedTurns(session, 1)
    this.cancelQueued(id)
    this.store.clearMessages(id)
    this.cancelLimitResume(id, false)
    this.latestTurns.delete(id)
    this.pendingSteer.delete(id)
    this.forgetAgentSession(session)
    const generation = this.store.getSession(id)?.generation ?? 0
    this.broadcast(eventFrame("message.invalidate", { sessionId: id, reason: "clear", generation }))
    this.notifySession(id)
    return { ok: true, files, generation, eventId: this.hooks.eventCursor?.() }
  }

  /**
   * r73 A: `{id, cancel: true}` drops the session's waiting limit resume (the error card's 取消); `{id, cancel: false}`
   * arms it again (恢复) while the latest turn is still the one a usage limit stopped and its reset is ahead.
   */
  private patchAutoResume(id: string, cancel: unknown) {
    if (!this.store.getSession(id)) throw Object.assign(new Error("session not found"), { code: "not_found" })
    if (cancel === true) {
      const cancelled = this.cancelLimitResume(id)
      return { ok: true, cancelled, session: this.publicSession(id) }
    }
    if (cancel !== false) throw Object.assign(new Error("cancel must be true or false"), { code: "invalid" })
    return { ok: true, armed: this.rearmLimitResume(id), session: this.publicSession(id) }
  }

  private rearmLimitResume(sessionId: string): boolean {
    if (!this.settingOn("auto_resume_limits")) return false
    const latest = this.latestTurns.get(sessionId)
    if (!latest || latest.phase !== "failed") return false
    if (this.store.getLimitResume(sessionId)?.turn_id === latest.id) return true
    const resetsAt = this.limitResetAfterLastPrompt(sessionId)
    if (resetsAt === undefined) return false
    this.scheduleLimitResume(sessionId, latest.id, resetsAt)
    return this.store.getLimitResume(sessionId) !== null
  }

  /** The `resetsAt` of a usage-limit error row written after the session's last prompt (`appendError`). */
  private limitResetAfterLastPrompt(sessionId: string): number | undefined {
    for (const row of this.store.listMessages(sessionId, { limit: 20 }).reverse()) {
      if (row.role === "user" && row.kind !== "error") return undefined
      if (row.kind !== "error" || !row.payload) continue
      try {
        const info = (JSON.parse(row.payload) as { error?: { code?: unknown; resetsAt?: unknown } }).error
        if (info?.code === "usage_limit" && typeof info.resetsAt === "number") return info.resetsAt
      } catch {
        // An error row whose payload does not parse names no reset.
      }
      return undefined
    }
    return undefined
  }

  private reopenSession(id: string) {
    const session = this.store.getSession(id)
    if (!session) throw Object.assign(new Error("session not found"), { code: "not_found" })
    const updated = this.store.patchSession(id, { archived: false })
    const pub = this.publicSession(updated?.id ?? id)!
    this.broadcast(eventFrame("session.upsert", pub))
    return { session: pub }
  }

  // The copy keeps the agent's memory: its first turn forks the source's agent-native session where the
  // adapter can (`forks`), else carries the transcript over. `title` is the phone's localized name.
  private async forkSession(id: string, title?: string) {
    // A live turn has open requests and reasoning the copy could never resolve.
    this.requireIdle(id)
    // While a terminal writes the source, what the copy would fork is still changing.
    this.handoff?.gate(id)
    const copy = await this.store.forkSession(id, title?.slice(0, 200))
    if (!copy) throw Object.assign(new Error("session not found"), { code: "not_found" })
    const pub = this.publicSession(copy.id)!
    this.broadcast(eventFrame("session.upsert", pub))
    return { session: pub }
  }

  // r72: same session, another agent. Its next turn starts a fresh agent-native session with the transcript carried
  // in front (the copy / rewind path); a notice row in the timeline marks where the agent changed.
  // `resume` (r72 App): the usage-limit card's 「换成 X 接着做」 in one call. The notice row carries `resume: true` from
  // the start, so the phone draws the final continuation line before the continuation message itself arrives.
  private async switchAgent(id: string, agentParam: unknown, modelParam: unknown, resume: boolean, owner: symbol) {
    const session = this.store.getSession(id)
    if (!session) throw Object.assign(new Error("session not found"), { code: "not_found" })
    const agent = typeof agentParam === "string" ? agentParam : ""
    const model = typeof modelParam === "string" ? modelParam : ""
    if (agent === session.agent) throw Object.assign(new Error(`session already runs ${agent}; change the model with session.patch`), { code: "invalid" })
    const adapter = this.adapters.get(agent)
    if (!adapter) throw Object.assign(new Error(`unknown agent ${agent}`), { code: "invalid" })
    this.handoff?.gate(id)
    this.requireIdle(id)
    if (this.pendingKind(id)) throw Object.assign(new Error("session is waiting for an answer"), { code: "busy" })
    const availability = await adapter.detect?.()
    if (availability && !availability.available) {
      throw Object.assign(new Error(`${agent} is not available: ${availability.reason ?? "unknown reason"}`), { code: "unavailable" })
    }
    if (model) {
      const models = await adapter.listModels?.()
      if (models && models.length > 0 && !models.some((entry) => entry.id === model)) {
        throw Object.assign(new Error(`model ${model} is not offered by ${agent}`), { code: "invalid" })
      }
    }
    const from = { agent: session.agent, model: session.model }
    const to = { agent, model }
    const label = model ? `${adapter.spec.label} · ${model}` : adapter.spec.label
    const switched = this.store.switchSessionAgent(
      id,
      { agent, model, permissionMode: this.choosePermissionMode(agent, session.permission_mode) },
      { id: crypto.randomUUID(), text: `Switched to ${label}`, payload: JSON.stringify({ notice: true, agentSwitch: { from, to, ...(resume ? { resume: true } : {}) } }) },
    )
    if (!switched) throw Object.assign(new Error("session not found"), { code: "not_found" })
    this.cancelLimitResume(id, false)
    this.pendingSteer.delete(id)
    this.forgetAgentSession(session)
    const pub = this.publicSession(id)!
    this.broadcast(eventFrame("message.append", messagePublic(switched.notice)))
    this.broadcast(eventFrame("session.upsert", pub))
    if (!resume) return { session: pub }
    // Same path as `message.send {origin: "fallback_resume"}`; a refusal here reaches the caller, not a log.
    this.sendMessage(id, RESUME_PROMPT, undefined, [], true, undefined, undefined, "fallback_resume", owner)
    return { session: this.publicSession(id)!, resumed: true }
  }

  private async rewindSession(id: string, seq: unknown, outline = false, limit?: number) {
    const session = this.store.getSession(id)
    if (!session) throw Object.assign(new Error("session not found"), { code: "not_found" })
    this.handoff?.gate(id)
    this.requireIdle(id)
    // Keeps messages up to and including seq; a missing seq must never mean "drop everything".
    if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1) {
      throw Object.assign(new Error("seq must be an integer >= 1"), { code: "invalid" })
    }
    // The kept prompt's own turn is included: its reply is past seq, so its file changes go too.
    await this.turnSettled(id)
    const files = await this.restoreRemovedTurns(session, seq)
    const native = await this.rewindNative(session, seq)
    // Queued messages were written against the turns being removed.
    this.cancelQueued(id)
    const updated = this.store.rewindSession(id, seq, native)
    this.cancelLimitResume(id, false)
    this.pendingSteer.delete(id)
    if (!native) this.forgetAgentSession(session)
    const pub = this.publicSession(updated?.id ?? id)!
    this.broadcast(eventFrame("message.invalidate", { sessionId: id, reason: "rewind", generation: updated?.generation ?? 0 }))
    this.broadcast(eventFrame("session.upsert", pub))
    if (outline) {
      const window = this.outlineWindow(id, { maxMessages: limit })
      return { session: pub, messages: window.messages, hasMore: window.hasMore, eventId: this.hooks.eventCursor?.(), files }
    }
    return {
      session: pub,
      messages: this.store.listMessages(id, { limit: HISTORY_PAGE }).map(messagePublic),
      eventId: this.hooks.eventCursor?.(),
      files,
    }
  }

  /**
   * Asks the agent to cut its own session where the chat is cut (idea from T3 Code), so the next turn keeps the
   * agent's whole context of the kept turns (tool results, files read) instead of a replayed transcript. Only at a
   * turn boundary inside the current native session, and not across a compaction; otherwise false, and the caller
   * drops the native session and carries the transcript over as before.
   */
  private async rewindNative(session: SessionRow, seq: number): Promise<boolean> {
    const adapter = this.adapters.get(session.agent)
    const nativeId = session.native_id
    if (!adapter?.rewind || !nativeId) return false
    const boundary = this.store.rewindBoundary(session.id, seq)
    if (!boundary || boundary.compacted || boundary.kept.session !== nativeId || boundary.removed.session !== nativeId) return false
    try {
      const cut = { nativeId, keepThrough: boundary.kept.lastMessageId, beforeTurnId: boundary.removed.turnId }
      if (!(await adapter.rewind(session.id, cut))) return false
    } catch (error) {
      console.warn(`rudderd: native rewind of ${session.id} failed:`, error instanceof Error ? error.message : error)
      return false
    }
    // Copies not yet forked would fork the cut session while their transcript still has the removed turns.
    this.store.dropForksOf(nativeId)
    return true
  }

  // Puts the folder back to the start of the first turn at or after `seq`. No snapshot, or a turn that
  // changed files without one: the chat still rewinds and the files stay.
  private async restoreRemovedTurns(session: SessionRow, seq: number): Promise<"restored" | "kept"> {
    const changes = this.store
      .turnIdsFromSeq(session.id, seq)
      .map((turnId) => this.store.getTurnChanges(turnId))
      .filter((row): row is TurnChanges => row !== null)
    const tree = snapshotToRestore(changes)
    if (!tree) return "kept"
    try {
      const restored = await restoreWorktree(session.cwd || WORKSPACE_ROOT, tree, this.hooks.workspaceRoot ?? WORKSPACE_ROOT)
      return restored ? "restored" : "kept"
    } catch (error) {
      console.warn(`rudderd: file restore for ${session.id} failed:`, error instanceof Error ? error.message : error)
      return "kept"
    }
  }

  // What the next turn must carry for a copy or a rewound session (v48 B / C). Copies that would fork this
  // session's agent-native session stop doing so now: this turn changes it.
  /**
   * Starts the agent the next turn of `session` would start, with the same folder, model, effort and launch mode,
   * so the first message after opening a chat does not wait for the CLI (about 3 s for Claude, 1.3 s for a Grok
   * resume). Not while a turn runs, a terminal holds the session, or a copy still has to fork on its first turn.
   */
  private scheduleWarm(sessionId: string, phone: string) {
    const pending = this.warmTimers.get(phone)
    if (pending) clearTimeout(pending)
    const timer = setTimeout(() => {
      if (this.warmTimers.get(phone) !== timer) return
      this.warmTimers.delete(phone)
      if (this.shuttingDown) return
      const session = this.store.getSession(sessionId)
      if (session) this.warm(session)
    }, this.hooks.warmDelayMs ?? WARM_DELAY_MS)
    timer.unref?.()
    this.warmTimers.set(phone, timer)
  }

  private warm(session: SessionRow) {
    const adapter = this.adapters.get(session.agent)
    if (!adapter?.warm || this.turns.has(session.id) || this.handoff?.heldElsewhere(session.id)) return
    if (!session.native_id && (session.carry_seq ?? 0) > 0) return
    let cwd: string
    try {
      cwd = session.cwd ? resolveSafe(session.cwd, this.hooks.workspaceRoot ?? WORKSPACE_ROOT) : WORKSPACE_ROOT
    } catch {
      return
    }
    const fallbackModel = session.agent === "claude" ? this.store.getMeta("default_model") : null
    const model = session.model || fallbackModel || undefined
    try {
      adapter.warm({
        executionIdentity: { sessionId: session.id, turnId: "", generation: session.generation ?? 0, agentId: session.agent,
          ...(session.native_id ? { nativeSessionId: session.native_id } : {}) },
        sessionId: session.id,
        cwd,
        model,
        contextWindow: session.context_window ?? undefined,
        effort: model && this.effortRefused(session.agent).has(model) ? undefined : session.effort || undefined,
        speed: session.speed || undefined,
        permissionMode: this.modeForLaunch(session.agent, session.permission_mode || "ask").mode,
        nativeId: session.native_id ?? undefined,
      })
    } catch (error) {
      console.warn(`rudderd: warming ${session.agent} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private carryOver(session: SessionRow, forks: boolean, text: string): { text?: string; fork?: { forkFrom: string; carryOver?: string } } {
    if (session.native_id) {
      this.store.dropForksOf(session.native_id)
      return {}
    }
    const upTo = session.carry_seq ?? 0
    if (upTo <= 0) return {}
    // Bounded read: the newest rows up to the cut; carryOverTranscript keeps the newest part of those anyway.
    const transcript = carryOverTranscript(this.store.listMessages(session.id, { beforeSeq: upTo + 1, limit: CARRY_OVER_ROWS }))
    if (forks && session.fork_native) return { fork: { forkFrom: session.fork_native, carryOver: transcript } }
    return transcript ? { text: withCarryOver(text, transcript) } : {}
  }

  // The stored native id is gone; the adapter drops whatever it keeps for the session (a live child, a thread).
  private forgetAgentSession(session: { id: string; agent: string }) {
    this.adapters.get(session.agent)?.forget?.(session.id)
  }

  /** Markdown of the whole transcript, read in pages; past `EXPORT_LIMIT_BYTES` it stops at a whole message with `truncated`. */
  private exportSession(id: string) {
    const session = this.store.getSession(id)
    if (!session) throw Object.assign(new Error("session not found"), { code: "not_found" })
    const parts = [`# ${session.title}\n\n`]
    const turnEnds: Array<{ promptId: string; turnEnd: NonNullable<ReturnType<typeof messagePublic>["turnEnd"]> }> = []
    let bytes = Buffer.byteLength(parts[0]!) + Buffer.byteLength(EXPORT_TRUNCATED_NOTE)
    let truncated = false
    for (const message of this.store.messagesInPages(id)) {
      const part = `## ${message.role}\n${message.text}\n\n`
      bytes += Buffer.byteLength(part)
      if (bytes > EXPORT_LIMIT_BYTES) {
        truncated = true
        break
      }
      parts.push(part)
      const end = messagePublic(message).turnEnd
      if (end) turnEnds.push({ promptId: message.id, turnEnd: end })
    }
    if (truncated) parts.push(EXPORT_TRUNCATED_NOTE)
    // Same text as before for an untruncated export: blocks joined by one blank line, no trailing newline.
    return { title: session.title, markdown: parts.join("").replace(/\n$/, ""), truncated, turnEnds }
  }

  private outlineWindow(sessionId: string, options: { beforeSeq?: number; maxMessages?: number } = {}) {
    const messages = readOutlineMessages(
      (before, limit) => this.store.listMessages(sessionId, { beforeSeq: before, limit }),
      this.store.lastPromptSeq(sessionId),
      options,
    )
    const oldest = messages[0]?.seq
    const hasMore = oldest !== undefined && this.store.hasMessageBefore(sessionId, oldest)
    return { messages, hasMore }
  }

  private syncCursor(sessionId: string): { generation: number; lastRev: number } {
    const row = this.store.getSession(sessionId)
    return { generation: row?.generation ?? 0, lastRev: row?.rev_counter ?? 0 }
  }

  /** Without `sinceVersion` the whole list (plus the cursor); with it only what changed and what was deleted since. */
  private listSessions(sinceVersion: unknown) {
    const counts = this.store.pendingScheduledCounts()
    const kinds = this.pendingKinds()
    // Product decision (2026-11-19): the step rides along, so a cold list does not fill that line row by row.
    const present = (row: SessionRow) =>
      this.presentRow(row, { scheduledCount: counts.get(row.id) ?? 0, pending: kinds.get(row.id) ?? null, step: this.steps.get(row.id)?.step })
    if (sinceVersion === undefined || sinceVersion === null) {
      const version = this.store.sessionVersion()
      return { sessions: this.store.listSessions().map(present), version }
    }
    if (typeof sinceVersion !== "number" || !Number.isSafeInteger(sinceVersion) || sinceVersion < 0) {
      throw Object.assign(new Error("sinceVersion must be a nonnegative integer"), { code: "invalid" })
    }
    const changes = this.store.sessionChanges(sinceVersion)
    if (changes.reset) return { reset: true, version: changes.version }
    return { sessions: changes.sessions.map(present), deleted: changes.deleted, version: changes.version }
  }

  /** r64 `message.changes`: rows changed after `sinceRev` in the phone's generation; another generation is a reset. */
  private messageChanges(params: Record<string, unknown>) {
    const sessionId = String(params.sessionId ?? "")
    const session = this.store.getSession(sessionId)
    if (!session) throw Object.assign(new Error("session not found"), { code: "not_found" })
    const { generation, sinceRev } = params
    if (typeof generation !== "number" || !Number.isSafeInteger(generation) || typeof sinceRev !== "number" || !Number.isSafeInteger(sinceRev) || sinceRev < 0) {
      throw Object.assign(new Error("generation and sinceRev must be integers"), { code: "invalid" })
    }
    const current = session.generation ?? 0
    const lastRev = session.rev_counter ?? 0
    if (generation !== current) return { reset: true, generation: current, lastRev }
    const requested = typeof params.limit === "number" && Number.isFinite(params.limit) ? Math.floor(params.limit) : CHANGES_PAGE
    const limit = Math.min(Math.max(1, requested), CHANGES_MAX)
    const { rows, hasMore } = this.store.messageChanges(sessionId, sinceRev, limit)
    const lastPromptSeq = params.outline === true ? this.store.lastPromptSeq(sessionId) : null
    const messages = params.outline === true ? rows.map((row) => messageOutline(row, lastPromptSeq)) : rows.map(messagePublic)
    return { generation: current, lastRev, hasMore, rows: messages }
  }

  private historyPage(sessionId: string, beforeSeq: number, limit: unknown, outline = false) {
    if (!this.store.getSession(sessionId)) throw Object.assign(new Error("session not found"), { code: "not_found" })
    const cap = outline ? OUTLINE_PAGE : 100
    const fallback = outline ? OUTLINE_PAGE : 40
    const requested = typeof limit === "number" && Number.isFinite(limit) ? Math.floor(limit) : fallback
    const safeLimit = Math.min(Math.max(1, requested), cap)
    if (outline) return this.outlineWindow(sessionId, { beforeSeq, maxMessages: safeLimit })
    const rows = this.store.listMessages(sessionId, { beforeSeq, limit: safeLimit })
    const messages = rows.map(messagePublic)
    const oldest = messages[0]?.seq
    const hasMore = oldest !== undefined && this.store.hasMessageBefore(sessionId, oldest)
    return { messages, hasMore }
  }

  private messageBodies(sessionId: string, ids: unknown, options: { paged: boolean; offset: number; requestId: string }): BodyPage {
    if (!this.store.getSession(sessionId)) throw Object.assign(new Error("session not found"), { code: "not_found" })
    if (!Array.isArray(ids) || ids.length > 200 || ids.some((id) => typeof id !== "string")) {
      throw Object.assign(new Error("ids must be at most 200 strings"), { code: "invalid" })
    }
    const { paged, offset, requestId } = options
    if (paged && (offset < 0 || offset > ids.length)) {
      throw Object.assign(new Error("body offset is outside the requested ids"), { code: "invalid" })
    }
    const messages: BodyPage["messages"] = []
    let bodyBytes = 0
    const emptyBytes = Buffer.byteLength(JSON.stringify(resultFrame(requestId, { messages: [] })), "utf8")
    const bytes = (total: number, count: number, nextOffset?: number) => emptyBytes + total + Math.max(0, count - 1)
      + (nextOffset === undefined ? 0 : Buffer.byteLength(JSON.stringify({ nextOffset }), "utf8") - 1)
    const page = (nextOffset?: number): BodyPage => nextOffset === undefined ? { messages } : { messages, nextOffset }
    const tooLarge = (messageId: string, encodedBytes: number): never => {
      throw Object.assign(new Error(`Message bodies response at ${messageId} is ${encodedBytes} bytes; the transport limit is ${BODY_FRAME_BYTES} bytes. View the complete original text on the computer.`), { code: "body_too_large" })
    }
    for (let index = paged ? offset : 0; index < ids.length; index++) {
      const id = ids[index] as string
      const row = this.store.getMessage(id)
      if (!row || row.session_id !== sessionId) continue
      const message = messagePublic(row)
      const encoded = Buffer.byteLength(JSON.stringify(message), "utf8")
      const nextOffset = index + 1 < ids.length ? index + 1 : undefined
      const total = bodyBytes + encoded
      if (paged) {
        // Reserve the longest possible cursor header; skipped ids can advance its digit count before the next row.
        if (messages.length > 0 && bytes(total, messages.length + 1, ids.length) > BODY_PAGE_BYTES) return page(index)
        const singletonBytes = bytes(total, messages.length + 1, nextOffset)
        if (singletonBytes > BODY_FRAME_BYTES) tooLarge(id, singletonBytes)
        messages.push(message)
        bodyBytes = total
        if (bytes(total, messages.length, ids.length) > BODY_PAGE_BYTES) return page(nextOffset)
      } else {
        const encodedBytes = bytes(total, messages.length + 1)
        if (encodedBytes > BODY_FRAME_BYTES) tooLarge(id, encodedBytes)
        messages.push(message)
        bodyBytes = total
      }
    }
    return page()
  }

  /**
   * The folder `file.*` paths are bounded by: the session's cwd, once it passes the same check a turn's cwd does
   * (`resolveSafe`). An imported terminal session keeps whatever cwd the transcript named, which may be `/` or outside
   * the workspace; such a session reads no file by path and saves no upload there. Attachments already saved (by id,
   * under `.rudder/`) are unaffected.
   */
  private fileRoot(session: SessionRow): string {
    if (!session.cwd) return WORKSPACE_ROOT
    return resolveSafe(session.cwd, this.hooks.workspaceRoot ?? WORKSPACE_ROOT)
  }

  /** The file lands under the session's working directory (`attachments.ts`); `message.send {attachments}` refers to it by id. */
  async uploadAttachment(sessionId: string, name: string, data: Uint8Array): Promise<Attachment> {
    const session = this.store.getSession(sessionId)
    if (!session) throw Object.assign(new Error("session not found"), { code: "not_found" })
    return saveAttachment(this.fileRoot(session), sessionId, name, data)
  }

  /** `attachment.put`: one base64 chunk of a file arriving over the relay. The last chunk is the one that saves. */
  private async putAttachment(params: Record<string, unknown>, deviceKey?: string) {
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : ""
    const session = sessionId ? this.store.getSession(sessionId) : undefined
    if (!session) throw Object.assign(new Error("session not found"), { code: "not_found" })
    const cwd = this.fileRoot(session)
    return this.relayUploads.accept(deviceKey ?? "local", params, async (name, bytes) => {
      const saved = await saveAttachment(cwd, sessionId, name, bytes)
      return { id: saved.id, name: saved.name, bytes: saved.bytes }
    })
  }

  /** `attachment.get`: one window of a stored attachment. The phone loops until `offset` reaches `bytes`. */
  private async getAttachment(params: Record<string, unknown>) {
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : ""
    const attachmentId = typeof params.attachmentId === "string" ? params.attachmentId : ""
    if (!sessionId || !attachmentId) throw Object.assign(new Error("sessionId and attachmentId required"), { code: "invalid" })
    const session = this.store.getSession(sessionId)
    const cwd = session ? session.cwd || WORKSPACE_ROOT : ""
    const found = session ? await findAttachment(cwd, sessionId, attachmentId) : null
    if (!found) throw Object.assign(new Error("not found"), { code: "not_found" })
    // Only this window is read: the whole file per window made a 50 MB pull read 5 GB.
    const window = await readPlainWindow(
      found.path,
      ATTACHMENT_LIMIT_BYTES,
      (bytes) => sliceWindow(bytes, params.offset, params.length),
      [attachmentDir(cwd, sessionId)],
      true,
    )
    return { bytes: window.bytes, offset: window.offset, data: Buffer.from(window.data).toString("base64") }
  }

  /** r75 `file.*`: the session's folder bounds every path (`file-service.ts`). */
  private async fileCall<T>(params: Record<string, unknown>, run: (located: { path: string; name: string }) => Promise<T>): Promise<T> {
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : ""
    const session = sessionId ? this.store.getSession(sessionId) : undefined
    if (!session) throw Object.assign(new Error("session not found"), { code: "not_found" })
    const byId = typeof params.attachmentId === "string" && params.attachmentId
    return run(await this.files.locate(byId ? session.cwd || WORKSPACE_ROOT : this.fileRoot(session), sessionId, params))
  }

  /** r75 `attachment.fetch`: a phone's upload through the blob lane, saved like `attachment.put`'s last chunk. */
  private async fetchAttachment(params: Record<string, unknown>) {
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : ""
    const session = sessionId ? this.store.getSession(sessionId) : undefined
    if (!session) throw Object.assign(new Error("session not found"), { code: "not_found" })
    const name = typeof params.name === "string" && params.name ? params.name : ""
    if (!name) throw Object.assign(new Error("name required"), { code: "invalid" })
    const cwd = this.fileRoot(session)
    return this.files.fetchAttachment(params.blob, async (bytes) => {
      const saved = await saveAttachment(cwd, sessionId, name, bytes)
      return { id: saved.id, name: saved.name, bytes: saved.bytes }
    })
  }

  /** `turn.preview`: one window of a before/after image from this turn. Same slice shape as `attachment.get`. */
  private async previewTurnSlice(params: Record<string, unknown>) {
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : ""
    const turnId = typeof params.turnId === "string" ? params.turnId : ""
    const path = typeof params.path === "string" ? params.path : ""
    const side = typeof params.side === "string" ? params.side : ""
    if (!sessionId || !turnId || !path || !side) {
      throw Object.assign(new Error("sessionId, turnId, path and side required"), { code: "invalid" })
    }
    const file = await this.readTurnPreview(sessionId, turnId, path, side)
    if (!file) throw Object.assign(new Error("not found"), { code: "not_found" })
    return sliceBase64(file.data, params.offset, params.length)
  }

  private async sendOnce(params: Record<string, unknown>, deviceKey?: string, queueIndex?: number): Promise<unknown> {
    const sessionId = String(params.sessionId ?? "")
    const origin = params.origin === "review" || params.origin === "fallback_resume" ? params.origin : undefined
    // r73 G: the phone sends the continuation without words; the agent gets the automatic resume's prompt.
    const text = origin === "fallback_resume" && !String(params.text ?? "").trim() ? RESUME_PROMPT : String(params.text ?? "")
    const fireAt = optionalNumber(params.fireAt)
    const reportsImages = params.agentReportsImages !== false
    if (params.clientMessageId === undefined) {
      return this.sendWithAttachments(sessionId, text, fireAt, params.attachments, reportsImages, undefined, undefined, origin)
    }
    const identity: SendIdentity = {
      ...this.identifySend(params, deviceKey),
      requestHash: createHash("sha256").update(JSON.stringify({ text, fireAt: fireAt ?? null, attachments: params.attachments ?? [], reportsImages,
        ...(queueIndex !== undefined ? { queueIndex } : {}) })).digest("hex"),
    }
    const existing = this.store.getSend(identity)
    if (existing) {
      if (existing.request_hash !== identity.requestHash) throw Object.assign(new Error("clientMessageId already used with different content"), { code: "conflict" })
      return this.sendResult(existing.result)
    }
    const key = JSON.stringify([identity.sessionId, identity.deviceId, identity.clientMessageId])
    const pending = this.sendRequests.get(key)
    if (pending) {
      if (pending.hash !== identity.requestHash) throw Object.assign(new Error("clientMessageId already used with different content"), { code: "conflict" })
      return pending.task
    }
    const task = this.sendWithAttachments(sessionId, text, fireAt, params.attachments, reportsImages, identity, queueIndex, origin)
    this.sendRequests.set(key, { hash: identity.requestHash, task })
    try {
      return await task
    } finally {
      this.sendRequests.delete(key)
    }
  }

  private identifySend(params: Record<string, unknown>, deviceKey?: string): SendIdentity {
    if (typeof params.clientMessageId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(params.clientMessageId)) {
      throw Object.assign(new Error("clientMessageId must be a UUID"), { code: "invalid" })
    }
    return {
      sessionId: String(params.sessionId ?? ""), clientMessageId: params.clientMessageId.toLowerCase(), requestHash: "",
      deviceId: this.senderId(deviceKey),
    }
  }

  private senderId(deviceKey?: string): string {
    if (!deviceKey) return "local"
    return this.store.deviceByKey(deviceKey)?.id
      ?? createHash("sha256").update(deviceKey).digest("hex")
  }

  private sendResult(stored: string): Record<string, unknown> {
    const result = JSON.parse(stored) as { message?: { id: string }; turn?: { id: string } }
    if (result.message && !this.store.getMessage(result.message.id)) return { ...result, message: undefined, turn: undefined, removed: true }
    const turn = result.turn ? this.store.getTurn(result.turn.id) : null
    return { ...result, ...(turn ? { turn: turnPublic(turn) } : {}) }
  }

  // `attachments`: ids from POST /v1/sessions/:id/attachments. The agent gets their paths after the text.
  private async sendWithAttachments(sessionId: string, text: string, fireAt: number | undefined, raw: unknown, agentReportsImages = true, identity?: SendIdentity, queueIndex?: number, origin?: MessageOrigin, owner?: symbol) {
    this.requireMutationFree(sessionId, owner)
    if (raw === undefined || raw === null) return this.sendMessage(sessionId, text, fireAt, [], agentReportsImages, identity, queueIndex, origin, owner)
    if (!Array.isArray(raw) || raw.length > 20 || !raw.every((id) => typeof id === "string")) {
      throw Object.assign(new Error("attachments must be at most 20 ids"), { code: "invalid" })
    }
    const session = this.store.getSession(sessionId)
    if (!session) throw Object.assign(new Error("session not found"), { code: "not_found" })
    const attachments: Attachment[] = []
    for (const id of raw as string[]) {
      const found = await findAttachment(session.cwd || WORKSPACE_ROOT, sessionId, id)
      if (!found) throw Object.assign(new Error(`attachment ${id} not found`), { code: "not_found" })
      attachments.push(found)
    }
    const current = this.store.getSession(sessionId)
    if (current && (current.generation !== session.generation || current.agent !== session.agent)) {
      throw Object.assign(new Error("session changed while loading attachments"), { code: "busy" })
    }
    return this.sendMessage(sessionId, text, fireAt, attachments, agentReportsImages, identity, queueIndex, origin, owner)
  }

  private sendMessage(sessionId: string, text: string, fireAt?: number, attachments: Attachment[] = [], agentReportsImages = true, identity?: SendIdentity, queueIndex?: number, origin?: MessageOrigin, owner?: symbol) {
    this.requireMutationFree(sessionId, owner)
    const session = this.store.getSession(sessionId)
    if (!session) throw Object.assign(new Error("session not found"), { code: "not_found" })
    if (!text.trim() && attachments.length === 0) throw Object.assign(new Error("text required"), { code: "invalid" })
    // One writer per Claude session: a terminal holds it, so this send is refused, not queued.
    this.handoff?.gate(sessionId)
    const decision = modelAcceptsImages(session.agent, session.model, agentReportsImages)
    const images = agentImages(attachments)
    if (images.length > 0 && !decision.accepts) {
      throw Object.assign(new Error(`${session.model || session.agent} does not accept images`), { code: "invalid" })
    }
    if (images.length > decision.cap) {
      throw Object.assign(new Error(`at most ${decision.cap} images`), { code: "invalid" })
    }
    if ((this.generating.has(sessionId) || queueIndex !== undefined) && fireAt === undefined) {
      // A continuation starts only once the queue is empty (startContinuation); it never joins the phone's queue.
      if (origin === "agent_continue") throw Object.assign(new Error("session is busy"), { code: "busy" })
      const queued = this.enqueueSend(sessionId, text, attachments, identity, queueIndex, origin)
      // The agent has said its piece and only background work holds the turn (a shell that never exits holds it for
      // hours): with nothing ahead of it, the phone's message goes in now. Refused or with images, it stays queued.
      if (queueIndex === undefined && origin === undefined && this.backgroundPaused.has(sessionId) && this.outbound.get(sessionId)?.length === 1) {
        queueMicrotask(() => {
          void this.steerQueued(sessionId, queued.queued.id, true).catch(() => undefined)
        })
      }
      return queued
    }
    const agentText = withAttachments(text, attachments)
    if (fireAt !== undefined) {
      if (!Number.isFinite(fireAt)) throw Object.assign(new Error("fireAt invalid"), { code: "invalid" })
      if (fireAt > Date.now() + SEVEN_DAYS_MS) {
        throw Object.assign(new Error("fireAt must be within 7 days"), { code: "invalid" })
      }
      if (fireAt > Date.now() + 500) {
        const job = this.store.transaction(() => {
          const job = this.store.insertScheduled({
            id: crypto.randomUUID(), session_id: sessionId, text: agentText, fire_at: fireAt,
          })
          if (identity) this.store.putSend(identity, { ok: true, scheduled: scheduledPublic(job), clientMessageId: identity.clientMessageId })
          return job
        })
        const pub = this.publicSession(sessionId)!
        this.broadcast(eventFrame("session.upsert", pub))
        this.broadcast(eventFrame("scheduled.upsert", scheduledPublic(job)))
        this.armScheduler()
        return { ok: true, scheduled: scheduledPublic(job), ...(identity ? { clientMessageId: identity.clientMessageId } : {}) }
      }
    }
    this.requireIdle(sessionId)
    // A prompt's turn replays what the agent kept for a buffered continuation (the adapter folds it in first).
    if (origin !== "agent_continue") {
      const waiting = (this.continuations.get(sessionId) ?? []).filter((offer) => offer.delivery !== "buffered")
      if (waiting.length > 0) this.continuations.set(sessionId, waiting)
      else this.continuations.delete(sessionId)
    }
    this.handoff?.phoneTurn(sessionId)
    // A new turn, by hand or by the resume itself, replaces the one a limit resume was waiting to continue.
    this.cancelLimitResume(sessionId, false)
    if (this.pausedQueues.delete(sessionId)) this.broadcast(this.queueFrame(sessionId, this.outbound.get(sessionId)))

    const { user, result, turn } = this.store.transaction(() => {
      const userId = crypto.randomUUID()
      const turn = this.store.createTurn(sessionId, userId, identity?.clientMessageId)
      const execution: TurnExecutionIdentity = { sessionId, turnId: turn.id, generation: session.generation ?? 0,
        agentId: session.agent, ...(session.native_id ? { nativeSessionId: session.native_id } : {}), ...(this.agentVersions.get(session.agent) ? { agentVersion: this.agentVersions.get(session.agent) } : {}) }
      this.store.setTurnExecution(turn.id, execution)
      const fields = {
        turnId: turn.id,
        ...(origin ? { origin } : {}),
        ...(attachments.length ? { attachments: attachments.map(attachmentPublic) } : {}),
        ...(identity ? { clientMessageId: identity.clientMessageId } : {}),
        ...(identity ? { clientDeviceId: identity.deviceId } : {}),
      }
      const user = this.store.insertMessage({
        id: userId, session_id: sessionId, kind: "text", role: "user", text,
        payload: Object.keys(fields).length ? JSON.stringify(fields) : null, created_at: Date.now(),
      })
      const result = { ok: true, ...(identity ? { clientMessageId: identity.clientMessageId, message: messagePublic(user), turn: turnPublic(turn) } : {}) }
      if (identity) this.store.putSend(identity, result)
      return { user, result, turn }
    })
    this.latestTurns.set(sessionId, turn)
    this.broadcast(eventFrame("message.append", messagePublic(user)))
    this.broadcast(eventFrame("turn.state", { sessionId, turn: turnPublic(turn) }))

    this.notifySession(sessionId)
    if (origin !== "agent_continue") this.nameFromMessage(session, text)

    this.generating.add(sessionId)
    this.backgroundTasks.delete(sessionId)
    this.hooks.card?.turnStarted(sessionId, text, ...(origin === "agent_continue" ? [{ continuation: true }] : []))
    this.emitStatus(sessionId, "running")
    const abort = new AbortController()
    this.aborts.set(sessionId, abort)
    const generationTask = this.generate(sessionId, agentText, abort, agentImages(attachments))
    this.turns.set(sessionId, generationTask)
    void generationTask.finally(() => {
      if (this.turns.get(sessionId) === generationTask) this.turns.delete(sessionId)
    })
    return result
  }

  private requireMutationFree(sessionId: string, owner?: symbol) {
    const active = this.sessionMutations.get(sessionId)
    if (active !== undefined && active !== owner) throw Object.assign(new Error("session is busy"), { code: "busy" })
  }

  private async withSessionMutation<T>(sessionId: string, work: (owner: symbol) => Promise<T>): Promise<T> {
    this.requireMutationFree(sessionId)
    const owner = Symbol()
    this.sessionMutations.set(sessionId, owner)
    try {
      return await work(owner)
    } finally {
      this.sessionMutations.delete(sessionId)
      this.flushOutbound(sessionId)
    }
  }

  // Busy means a turn is live in this process; the stored status can be stale after a crash.
  private requireIdle(sessionId: string) {
    if (this.generating.has(sessionId) || this.startingQueued.has(sessionId)) throw Object.assign(new Error("session is busy"), { code: "busy" })
  }

  private enqueueSend(sessionId: string, text: string, attachments: Attachment[], identity?: SendIdentity, queueIndex?: number, origin?: Exclude<MessageOrigin, "agent_continue">) {
    const item: DaemonQueueItem = {
      id: crypto.randomUUID(),
      sessionId,
      text,
      ...(origin ? { origin } : {}),
      attachmentIds: attachments.map((attachment) => attachment.id),
      hasImages: agentImages(attachments).length > 0,
      ...(identity ? { clientMessageId: identity.clientMessageId } : {}),
      ...(identity ? { clientDeviceId: identity.deviceId } : {}),
    }
    const queue = enqueueItem(this.outbound.get(sessionId) ?? [], item)
    if (queueIndex !== undefined) {
      queue.pop()
      queue.splice(Math.min(queueIndex, queue.length), 0, item)
    }
    if (identity) {
      const queuedIdentity = { ...identity, queueId: item.id }
      this.queuedIdentities.set(item.id, queuedIdentity)
      this.store.putSend(queuedIdentity, { ok: true, queued: item, clientMessageId: identity.clientMessageId })
    }
    this.outbound.set(sessionId, queue)
    this.broadcast(this.queueFrame(sessionId, this.outbound.get(sessionId)))
    if (queueIndex !== undefined) queueMicrotask(() => this.flushOutbound(sessionId))
    return { ok: true, queued: item, ...(identity ? { clientMessageId: identity.clientMessageId } : {}) }
  }

  private removeQueued(sessionId: string, id: string) {
    const item = this.outbound.get(sessionId)?.find((entry) => entry.id === id)
    if (item) this.finishQueued(item, { ok: true, cancelled: true })
    const rest = (this.outbound.get(sessionId) ?? []).filter((item) => item.id !== id)
    this.outbound.set(sessionId, rest)
    this.broadcast(this.queueFrame(sessionId, rest))
    return { ok: true, cancelled: item !== undefined, items: rest }
  }

  private async sendQueued(sessionId: string, id: string, deviceKey?: string) {
    const identity = this.queuedIdentities.get(id)
    const item = this.outbound.get(sessionId)?.find((entry) => entry.id === id)
    if (!item) {
      const record = this.store.findSendByQueue(sessionId, this.senderId(deviceKey), id)
      if (record) return this.sendResult(record.result)
      throw Object.assign(new Error("queued message not found"), { code: "not_found" })
    }
    if (!identity || identity.deviceId !== this.senderId(deviceKey)) throw Object.assign(new Error("queued send identity is not owned by this device"), { code: "forbidden" })
    return this.withSessionMutation(sessionId, async (owner) => {
      await this.stopTurn(sessionId, STOP_GRACE_MS, "queue_promote")
      this.requireIdle(sessionId)
      // Removed or cancelled while the turn stopped: sending it now would undo that.
      if (!this.outbound.get(sessionId)?.some((entry) => entry.id === id)) throw Object.assign(new Error("queued message not found"), { code: "not_found" })
      this.outbound.set(sessionId, (this.outbound.get(sessionId) ?? []).filter((entry) => entry.id !== id))
      try {
        const result = await this.sendWithAttachments(sessionId, item.text, undefined, item.attachmentIds, true, identity, undefined, item.origin, owner)
        this.queuedIdentities.delete(id)
        this.broadcast(this.queueFrame(sessionId, this.outbound.get(sessionId) ?? []))
        return result
      } catch (error) {
        this.finishQueued(item, { ok: false, failed: true })
        throw error
      }
    })
  }

  private editQueued(params: Record<string, unknown>, deviceKey?: string) {
    const sessionId = String(params.sessionId ?? "")
    const id = String(params.id ?? "")
    const text = typeof params.text === "string" ? params.text.trim() : ""
    if (!text) throw Object.assign(new Error("text required"), { code: "invalid" })
    const identity = this.identifySend(params, deviceKey)
    identity.queueId = id
    const existing = this.store.getSend(identity)
    if (existing) {
      const result = this.sendResult(existing.result)
      const content = (result.queued as DaemonQueueItem | undefined)?.text ?? (result.message as { text?: string } | undefined)?.text
      if (result.queueId !== id || (content !== undefined && content !== text)) throw Object.assign(new Error("clientMessageId already used with different content"), { code: "conflict" })
      return { ...result, items: this.outbound.get(sessionId) ?? [] }
    }
    const queue = this.outbound.get(sessionId) ?? []
    const item = queue.find((entry) => entry.id === id)
    const original = this.queuedIdentities.get(id)
    if (!item || !original) throw Object.assign(new Error("queued message not found"), { code: "not_found" })
    if (original.deviceId !== identity.deviceId) throw Object.assign(new Error("queued send identity is not owned by this device"), { code: "forbidden" })
    identity.requestHash = createHash("sha256").update(JSON.stringify({ text, fireAt: null, attachments: item.attachmentIds, reportsImages: true })).digest("hex")
    const edited = { ...item, text, clientMessageId: identity.clientMessageId, clientDeviceId: identity.deviceId }
    enqueueItem(queue.filter((entry) => entry.id !== id), edited)
    const next = queue.map((entry) => entry.id === id ? edited : entry)
    this.store.transaction(() => {
      this.finishQueued(item, { ok: true, cancelled: true })
      this.store.putSend(identity, { ok: true, queued: edited, clientMessageId: identity.clientMessageId })
    })
    this.queuedIdentities.set(id, identity)
    this.outbound.set(sessionId, next)
    this.broadcast(this.queueFrame(sessionId, next))
    return { ok: true, queued: edited, items: next, clientMessageId: identity.clientMessageId }
  }

  /** `waiting`: the phone's own send while the turn was paused on background work, not a tapped 插话. */
  private async steerQueued(sessionId: string, id: string, waiting = false) {
    const item = (this.outbound.get(sessionId) ?? []).find((entry) => entry.id === id)
    if (!item) throw Object.assign(new Error("queued message not found"), { code: "not_found" })
    const session = this.store.getSession(sessionId)
    if (!session) throw Object.assign(new Error("session not found"), { code: "not_found" })
    const control = await this.ensureSteerProbe(session.agent)
    if (control === "stop-and-send") {
      throw Object.assign(new Error("this computer stops the turn before sending"), { code: "stop-and-send" })
    }
    const attachments: Attachment[] = []
    for (const attachmentId of item.attachmentIds) {
      const attachment = await findAttachment(session.cwd || WORKSPACE_ROOT, sessionId, attachmentId)
      if (!attachment) throw Object.assign(new Error(`queued attachment ${attachmentId} is missing`), { code: "not_found" })
      attachments.push(attachment)
    }
    if (agentImages(attachments).length > 0) throw Object.assign(new Error("image attachments require stop-and-send"), { code: "stop-and-send" })
    return this.withSessionMutation(sessionId, async () => {
      const currentSession = this.store.getSession(sessionId)
      if (!currentSession || currentSession.generation !== session.generation || currentSession.agent !== session.agent) {
        throw Object.assign(new Error("session changed while preparing to steer"), { code: "busy" })
      }
      const originalTurn = this.latestTurns.get(sessionId)
      // A probe or attachment read may have overlapped a queue flush. Use the current queue.
      const current = this.outbound.get(sessionId) ?? []
      const index = current.findIndex((entry) => entry.id === id)
      if (index < 0) throw Object.assign(new Error("queued message is already being sent"), { code: "idle" })
      this.outbound.set(sessionId, current.filter((entry) => entry.id !== id))
      // Back to the place it left; past the end of a queue that shrank meanwhile, it goes first.
      const putBack = () => {
        const now = [...(this.outbound.get(sessionId) ?? [])]
        now.splice(index > now.length ? 0 : index, 0, item)
        this.outbound.set(sessionId, now)
      }
      const adapter = this.adapters.get(session.agent)
      if (!adapter?.steer || !this.aborts.has(sessionId)) {
        putBack()
        throw Object.assign(new Error("no active turn to steer"), { code: "idle" })
      }
      const identity = this.queuedIdentities.get(item.id)
      if (identity) this.store.putSend(identity, { ok: false, uncertain: true, clientMessageId: identity.clientMessageId })
      let accepted: boolean
      try {
        accepted = await adapter.steer(sessionId, withAttachments(item.text, attachments))
      } catch (error) {
        this.finishQueued(item, { ok: false, uncertain: true })
        this.broadcast(this.queueFrame(sessionId, this.outbound.get(sessionId) ?? [], item.id))
        throw error
      }
      if (!accepted) {
        if (identity) this.store.putSend(identity, { ok: true, queued: item, clientMessageId: identity.clientMessageId })
        putBack()
        this.broadcast(this.queueFrame(sessionId, this.outbound.get(sessionId), item.id))
        throw Object.assign(new Error("steer was not accepted"), { code: "idle" })
      }
      const steered = this.store.transaction(() => {
        const message = this.store.insertMessage({
          id: crypto.randomUUID(), session_id: sessionId, kind: "text", role: "user", text: item.text,
          payload: JSON.stringify({ steer: "sent", ...(waiting ? { steerWaiting: true } : {}), turnId: originalTurn?.id, ...(item.origin ? { origin: item.origin } : {}),
            attachments: attachments.map(attachmentPublic),
            ...(identity ? { clientMessageId: identity.clientMessageId, clientDeviceId: identity.deviceId } : {}) }), created_at: Date.now(),
        })
        this.finishQueued(item, { ok: true, message: messagePublic(message), ...(originalTurn ? { turn: turnPublic(originalTurn) } : {}) })
        return message
      })
      this.broadcast(eventFrame("message.append", messagePublic(steered)))
      this.pendingSteer.set(sessionId, steered.id)
      this.broadcast(this.queueFrame(sessionId, this.outbound.get(sessionId) ?? []))
      return { ok: true, steered: item.id }
    })
  }

  /** r64 v64 A2: 继续发送. Lets a paused queue go without a new message, whichever phone queued it. */
  private resumeQueue(sessionId: string) {
    if (!this.store.getSession(sessionId)) throw Object.assign(new Error("session not found"), { code: "not_found" })
    const items = this.outbound.get(sessionId) ?? []
    if (items.length === 0) throw Object.assign(new Error("nothing is queued"), { code: "idle" })
    this.pausedQueues.delete(sessionId)
    this.broadcast(this.queueFrame(sessionId, items))
    this.flushOutbound(sessionId)
    return { ok: true, items: this.outbound.get(sessionId) ?? [] }
  }

  private flushOutbound(sessionId: string) {
    if (this.shuttingDown || this.generating.has(sessionId) || this.startingQueued.has(sessionId) || this.sessionMutations.has(sessionId)) return
    // A usage limit, a sign-in or a restart left this queue waiting; the next turn that starts lets it go.
    if (this.pausedQueues.has(sessionId)) return
    // Queued behind a turn that overlapped a terminal: it waits until the terminal gives the session back.
    if (this.handoff?.heldElsewhere(sessionId)) return
    const { next, rest } = takeNext(this.outbound.get(sessionId) ?? [])
    // The user's queued sends go first; an agent continuation waits for an empty queue.
    if (!next) return this.startContinuation(sessionId)
    this.startingQueued.add(sessionId)
    this.outbound.set(sessionId, rest)
    this.broadcast(this.queueFrame(sessionId, rest))
    const session = this.store.getSession(sessionId)
    if (!session) {
      this.startingQueued.delete(sessionId)
      this.finishQueued(next, { ok: false, cancelled: true })
      return
    }
    const identity = this.queuedIdentities.get(next.id)
    const attachments: Attachment[] = []
    void (async () => {
      for (const id of next.attachmentIds) {
        const found = await findAttachment(session.cwd || WORKSPACE_ROOT, sessionId, id)
        if (!found) throw new Error(`queued attachment ${id} is missing`)
        attachments.push(found)
      }
      this.startingQueued.delete(sessionId)
      this.sendMessage(sessionId, next.text, undefined, attachments, true, identity, undefined, next.origin)
      this.queuedIdentities.delete(next.id)
    })().catch((error: unknown) => {
      this.startingQueued.delete(sessionId)
      this.finishQueued(next, { ok: false, failed: true })
      console.warn(`rudderd: queued send ${next.id} failed:`, error)
      this.broadcast(this.queueFrame(sessionId, this.outbound.get(sessionId) ?? [], next.id))
      this.flushOutbound(sessionId)
    })
  }

  /**
   * The agent spoke after its turn about nothing that turn's tasks own (plan 2026-11-17 D1–D6): a new turn carries it,
   * after the user's queued sends. Offers wait in the order they came; a repeat of one waiting or already sent is taken
   * once.
   */
  private continueFromAgent(offer: ContinuationOffer): boolean {
    const sessionId = offer.identity.sessionId
    if (this.shuttingDown || this.staleOffer(offer)) {
      console.warn(`rudderd: continuation ${offer.key} for ${sessionId} dropped (${this.shuttingDown ? "shutting down" : "stale identity"})`)
      return false
    }
    const waiting = this.continuations.get(sessionId) ?? []
    if (waiting.some((held) => held.key === offer.key)) return true
    if (this.store.getSend({ sessionId, deviceId: CONTINUE_DEVICE, clientMessageId: continuationClientId(offer), requestHash: "" })) return false
    this.continuations.set(sessionId, [...waiting, offer])
    this.flushOutbound(sessionId)
    return true
  }

  /** D6: the session is gone or archived, or its generation, agent or native session moved on since the offer. */
  private staleOffer(offer: ContinuationOffer): boolean {
    const session = this.store.getSession(offer.identity.sessionId)
    return !session || session.archived === 1 || (session.generation ?? 0) !== offer.identity.generation
      || session.agent !== offer.identity.agentId || session.native_id !== offer.identity.nativeSessionId
  }

  private startContinuation(sessionId: string): void {
    const [offer, ...rest] = this.continuations.get(sessionId) ?? []
    if (!offer) return
    if (rest.length > 0) this.continuations.set(sessionId, rest)
    else this.continuations.delete(sessionId)
    // Held behind a turn, a rewind, a fork or an agent switch may have moved the session on.
    if (this.staleOffer(offer)) {
      console.warn(`rudderd: continuation ${offer.key} for ${sessionId} dropped (stale identity when it came up)`)
      // The next one waiting is checked on its own.
      this.startContinuation(sessionId)
      return
    }
    const clientMessageId = continuationClientId(offer)
    this.continuationTurns.set(clientMessageId, offer)
    const text = offer.detail.trim() || CONTINUE_FALLBACK
    try {
      this.sendMessage(sessionId, text, undefined, [], true,
        { sessionId, deviceId: CONTINUE_DEVICE, clientMessageId, requestHash: createHash("sha256").update(text).digest("hex") }, undefined, "agent_continue")
    } catch (error) {
      this.continuationTurns.delete(clientMessageId)
      console.warn(`rudderd: continuation ${offer.key} for ${sessionId} failed:`, error)
    }
  }

  /** A stop: the pending continuations go, and the agent forgets what it buffered for them. */
  private dropContinuation(sessionId: string) {
    this.continuations.delete(sessionId)
    const session = this.store.getSession(sessionId)
    if (session) this.adapters.get(session.agent)?.cancelContinuation?.(sessionId)
  }

  private queueFrame(sessionId: string, items: DaemonQueueItem[] | undefined, failed?: string): Frame {
    const paused = this.pausedQueues.get(sessionId)
    return eventFrame("queue.upsert", { sessionId, items: items ?? [], ...(failed ? { failed } : {}), ...(paused ? { paused } : {}) })
  }

  private finishQueued(item: DaemonQueueItem, result: Record<string, unknown>) {
    const identity = this.queuedIdentities.get(item.id)
    if (identity) this.store.putSend(identity, { ...result, clientMessageId: identity.clientMessageId })
    this.queuedIdentities.delete(item.id)
  }

  private cancelQueued(sessionId: string) {
    this.dropContinuation(sessionId)
    for (const item of this.outbound.get(sessionId) ?? []) this.finishQueued(item, { ok: true, cancelled: true })
    this.outbound.delete(sessionId)
    this.pausedQueues.delete(sessionId)
    this.broadcast(this.queueFrame(sessionId, []))
  }

  private findRule(id: string): SessionRule {
    const rule = this.rules.find((entry) => entry.id === id)
    if (!rule) throw Object.assign(new Error("rule not found"), { code: "not_found" })
    return rule
  }

  private revokeRule(id: string) {
    const rule = this.findRule(id)
    rule.enabled = false
    this.store.saveRule(rule)
    return { ok: true, rule: rulePublic(rule) }
  }

  /** a rule turned off stays listed and can be turned back on. */
  private restoreRule(id: string) {
    const rule = this.findRule(id)
    rule.enabled = true
    this.store.saveRule(rule)
    return { ok: true, rule: rulePublic(rule) }
  }

  /** Remove drops the rule; the next request for that command asks again. */
  private removeRule(id: string) {
    const rule = this.findRule(id)
    this.rules.splice(this.rules.indexOf(rule), 1)
    this.store.deleteRule(id)
    return { ok: true, id }
  }

  /**
   * every match in the session's history, so the phone can count and reach pages it has not loaded. Read in
   * pages with a scan budget, yielding between them; a cut-short search says `truncated` and `resumeAfterSeq`, which
   * a later call passes as `afterSeq` to go on.
   */
  private searchSession(sessionId: string, params: Record<string, unknown>) {
    if (!this.store.getSession(sessionId)) throw Object.assign(new Error("session not found"), { code: "not_found" })
    const query = searchQuery(params.query)
    const beforeSeq = typeof params.beforeSeq === "number" && Number.isFinite(params.beforeSeq) ? params.beforeSeq : Number.MAX_SAFE_INTEGER
    const afterSeq = typeof params.afterSeq === "number" && Number.isFinite(params.afterSeq) ? params.afterSeq : 0
    return searchPaged((after, limit) => this.store.searchPage(sessionId, after, beforeSeq, limit), query, searchLimit(params.limit), {
      afterSeq,
    })
  }

  private noteBackground(sessionId: string, event: Extract<AgentEvent, { type: "background" }>) {
    const row = this.latestTurns.get(sessionId)
    const executed = row && this.store.getTurn(row.id)
    const session = this.store.getSession(sessionId)
    if (executed?.execution && session?.native_id) {
      const identity = { ...JSON.parse(executed.execution) as TurnExecutionIdentity, nativeSessionId: session.native_id }
      for (const task of event.tasks) this.lateEvents.register(identity, task.id)
    }
    this.backgroundTasks.set(sessionId, event.tasks)
    if (event.open > 0) this.backgroundOpen.set(sessionId, event.open)
    else this.backgroundOpen.delete(sessionId)
    const pause = event.paused && event.open > 0
    if (event.paused && event.open === 0 && event.tasks.some((task) => task.status === "done" || task.status === "failed")) {
      this.followUpDue.add(sessionId)
      // The agent is reading the results to answer: the phone shows it running, with its stop key, not idle.
      if (this.backgroundPaused.delete(sessionId)) {
        this.hooks.live?.background(sessionId, 0)
        this.hooks.card?.background(sessionId, 0)
        this.resumeStatus(sessionId)
        return
      }
    }
    if (pause) this.hooks.live?.background(sessionId, event.open)
    if (pause) this.hooks.card?.background(sessionId, event.open)
    if (pause && !this.backgroundPaused.has(sessionId)) {
      this.backgroundPaused.add(sessionId)
      this.emitStatus(sessionId, "idle", { holdLive: true })
      return
    }
    this.notifySession(sessionId)
  }

  private closeBackground(sessionId: string) {
    const tasks = this.backgroundTasks.get(sessionId)
    if (!tasks?.length) return
    const now = Date.now()
    this.backgroundTasks.set(
      sessionId,
      tasks.map((task) => (task.status === "running" ? { ...task, status: "cancelled", endedAt: now } : task)),
    )
  }

  /** Stop all. The agent stops the tasks one by one where it can; otherwise this turn stops (`stoppedTurn`). */
  private async stopBackground(sessionId: string) {
    const session = this.store.getSession(sessionId)
    if (!session) throw Object.assign(new Error("session not found"), { code: "not_found" })
    if (!this.generating.has(sessionId) || (this.backgroundOpen.get(sessionId) ?? 0) === 0) return { ok: true, stopped: 0 }
    const stopped = this.backgroundOpen.get(sessionId) ?? 0
    this.followUpDue.delete(sessionId)
    const adapter = this.adapters.get(session.agent)
    const done = adapter?.stopBackground ? await adapter.stopBackground(sessionId).catch(() => false) : false
    if (done) return { ok: true, stopped }
    await this.stopTurn(sessionId, STOP_GRACE_MS, "background_stop")
    return { ok: true, stopped, stoppedTurn: true }
  }

  /**
   * Returns true once authoritative lifecycle evidence can settle the turn. Quiet unknown work stays inspectable;
   * explicit user stops never pass through this guard.
   */
  private checkStuck(sessionId: string, now = Date.now()): boolean {
    if (!this.generating.has(sessionId)) return true
    const health = this.health.get(sessionId)
    if (!health) return false
    health.waiting = [...this.pendingPermissions.values(), ...this.pendingQuestions.values()].some((entry) => entry.sessionId === sessionId)
    health.openTools = [...(this.turnTools.get(sessionId)?.tools.values() ?? [])].filter((tool) => tool.status === "running" || tool.status === "pending").length
    health.openBackground = this.backgroundOpen.get(sessionId) ?? 0
    health.retryUntil = this.retryingUntil.get(sessionId) ?? 0
    health.lastEventAt = this.lastAgentEventAt.get(sessionId) ?? health.lastEventAt
    const decision = decideTurnHealth(health, now, this.guard)
    const gap = now - health.lastCheckAt
    health.lastCheckAt = now
    if (decision === "continue") return false
    if (decision === "inspect") {
      if (gap > this.guard.checkMs * 2) this.lastAgentEventAt.set(sessionId, now)
      if (!this.healthInspected.has(sessionId)) {
        this.healthInspected.add(sessionId)
        console.warn(`rudderd: turn ${health.identity.turnId} quiet: inspect (agent ${health.identity.agentId}, transport ${health.transport}, check gap ${Math.max(0, gap)} ms)`)
      }
      return false
    }
    if (decision === "fail_transport") {
      this.recordStop(sessionId, "transport_closed")
      this.terminalReceipts.get(sessionId)?.reject(new Error(health.closeDetail ?? "Agent transport closed before completion"))
    } else this.terminalReceipts.get(sessionId)?.resolve()
    return true
  }

  private recordStop(sessionId: string, cause: TurnTerminationCause, evidence?: TurnTermination["evidence"]): TurnTermination | undefined {
    const turn = this.latestTurns.get(sessionId)
    if (!turn) return undefined
    const row = this.store.getTurn(turn.id)
    const engine = row?.execution ? JSON.parse(row.execution) as TurnExecutionIdentity : undefined
    return this.store.setTurnTermination(turn.id, { cause, requestedAt: Date.now(), ...(engine ? { engine } : {}), ...(evidence ? { evidence } : {}) })
  }

  private async stopTurn(sessionId: string, graceMs = STOP_GRACE_MS, cause: TurnTerminationCause = "user_stop") {
    if (cause !== "queue_promote") this.dropContinuation(sessionId)
    this.recordStop(sessionId, cause)
    this.aborts.get(sessionId)?.abort()
    const turn = this.turns.get(sessionId)
    if (turn) await Promise.race([turn.catch(() => {}), Bun.sleep(graceMs)])
  }

  // Interrupts every live turn and waits up to graceMs for them to write their last rows.
  async shutdown(graceMs = 2000) {
    this.shuttingDown = true
    const handoffStopped = this.handoff?.stop()
    if (this.imagePruneTimer) clearTimeout(this.imagePruneTimer)
    this.imagePruneTimer = null
    for (const timer of this.resumeTimers.values()) clearTimeout(timer)
    this.resumeTimers.clear()
    for (const timer of this.warmTimers.values()) clearTimeout(timer)
    this.warmTimers.clear()
    this.stopScheduler()
    for (const [sessionId, abort] of this.aborts) {
      this.recordStop(sessionId, "daemon_shutdown")
      abort.abort()
    }
    const settled = Promise.allSettled([...this.turns.values()]).then(() => Promise.allSettled([...this.turnEnds.values()]))
    await Promise.race([settled, Bun.sleep(graceMs)])
    this.persistStreams()
    await Promise.allSettled([...this.lateWrites])
    await handoffStopped
  }

  private async steerMessage(sessionId: string, action: string, text: string) {
    if (action === "cancel") {
      const abort = this.aborts.get(sessionId)
      if (!abort) throw Object.assign(new Error("session is not generating"), { code: "idle" })
      this.dropContinuation(sessionId)
      this.recordStop(sessionId, "user_stop")
      abort.abort()
      return { ok: true }
    }
    if (action !== "steer") throw Object.assign(new Error("unsupported steer action"), { code: "invalid" })
    const session = this.store.getSession(sessionId)
    if (!session) throw Object.assign(new Error("session not found"), { code: "not_found" })
    const adapter = this.adapters.get(session.agent)
    const control = await this.ensureSteerProbe(session.agent)
    if (control !== "steer" || !adapter?.steer) {
      const code = control === "stop-and-send" ? "stop-and-send" : "unsupported"
      throw Object.assign(new Error(`${adapter?.spec.label ?? session.agent} cannot take input mid-turn`), { code })
    }
    const steer = adapter.steer.bind(adapter)
    if (!text.trim()) throw Object.assign(new Error("text required"), { code: "invalid" })
    return this.withSessionMutation(sessionId, async () => {
      const current = this.store.getSession(sessionId)
      if (!current || current.generation !== session.generation || current.agent !== session.agent) {
        throw Object.assign(new Error("session changed while preparing to steer"), { code: "busy" })
      }
      if (!this.aborts.has(sessionId)) throw Object.assign(new Error("session is not generating"), { code: "idle" })
      const accepted = await steer(sessionId, text)
      if (!accepted) throw Object.assign(new Error("no active turn to steer"), { code: "idle" })
      const steered = this.appendMessage({
        id: crypto.randomUUID(),
        session_id: sessionId,
        kind: "text",
        role: "user",
        text,
        payload: JSON.stringify({ steer: "sent" }),
        created_at: Date.now(),
      })
      this.pendingSteer.set(sessionId, steered.id)
      return { ok: true }
    })
  }

  // Raw config value, legacy names included, so older clients keep their picker state.
  private configPermissionMode(): string {
    const value = this.store.getMeta("permission_mode")
    return value && CONFIG_PERMISSION_MODES.has(value) ? value : "ask"
  }

  private defaultPermissionMode(): RudderPermissionMode {
    const value = this.configPermissionMode()
    if (value === "allow" || value === "acceptEdits") return "acceptEdits"
    if (value === "deny" || value === "plan") return "plan"
    return "ask"
  }

  private setConfig(params: Record<string, unknown>) {
    const mode = params.permissionMode
    if (typeof mode === "string" && CONFIG_PERMISSION_MODES.has(mode)) {
      this.store.setMeta("permission_mode", mode)
    }
    if (typeof params.model === "string") {
      this.store.setMeta("default_model", params.model)
    }
    const permissionMode = this.configPermissionMode()
    this.broadcast(eventFrame("config.upsert", { permissionMode, model: this.store.getMeta("default_model") }))
    return { permissionMode, model: this.store.getMeta("default_model") }
  }

  private patchMachine(params: Record<string, unknown>) {
    if (typeof params.name === "string" && params.name.trim()) {
      this.store.setMeta("machine_name", params.name.trim())
    }
    for (const [param, key] of [["autoResumeLimits", "auto_resume_limits"], ["continueAfterRestart", "continue_after_restart"]] as const) {
      const value = params[param]
      if (value === undefined) continue
      if (typeof value !== "boolean") throw Object.assign(new Error(`${param} must be a boolean`), { code: "invalid" })
      this.store.setMeta(key, value ? "1" : "0")
    }
    // Off means off for turns already waiting too.
    if (params.autoResumeLimits === false) {
      for (const row of this.store.listLimitResumes()) this.cancelLimitResume(row.session_id)
    }
    const machine = this.machine()
    this.broadcast(eventFrame("machine.upsert", machine))
    return { machine }
  }

  private cancelScheduled(id: string) {
    const updated = this.store.claimScheduled(id, "cancelled")
    if (!updated) {
      const current = this.store.getScheduled(id)
      if (!current) throw Object.assign(new Error("scheduled not found"), { code: "not_found" })
      throw Object.assign(new Error(`scheduled already ${current.status}`), { code: "conflict" })
    }
    const pub = this.publicSession(updated.session_id)
    if (pub) this.broadcast(eventFrame("session.upsert", pub))
    this.broadcast(eventFrame("scheduled.upsert", scheduledPublic(updated)))
    this.armScheduler()
    return { scheduled: scheduledPublic(updated) }
  }

  /** `ifText`: write only while the stored draft still reads that (no row reads ""). The app clears a sent draft this
   * way, so a draft saved after the send, by this phone or another, is kept. `applied: false` returns what is stored. */
  private setDraft(sessionId: string, text: string, ifText?: string) {
    if (!this.store.getSession(sessionId)) throw Object.assign(new Error("session not found"), { code: "not_found" })
    if (ifText !== undefined) {
      const current = this.store.getDraft(sessionId)
      if ((current?.text ?? "") !== ifText) {
        return {
          draft: { sessionId, text: current?.text ?? "", updatedAt: current?.updated_at ?? null },
          applied: false,
        }
      }
    }
    const draft = this.store.setDraft(sessionId, text)
    return { draft: { sessionId: draft.session_id, text: draft.text, updatedAt: draft.updated_at }, applied: true }
  }

  private getDraft(sessionId: string) {
    if (!this.store.getSession(sessionId)) throw Object.assign(new Error("session not found"), { code: "not_found" })
    const draft = this.store.getDraft(sessionId)
    return { draft: draft ? { sessionId: draft.session_id, text: draft.text, updatedAt: draft.updated_at } : null }
  }

  private revokeDevice(id: string) {
    const removed = this.store.deleteDevice(id)
    if (!removed) throw Object.assign(new Error("device not found"), { code: "not_found" })
    this.hooks.deviceRevoked?.(removed.session_key)
    return { ok: true }
  }

  // `remote: false` tells the app this machine has no push gateway, so it keeps posting local notifications.
  // `prefs` (v67 A5, optional): `{done: false}` mutes done notices for this phone; an app that sends none keeps the last.
  // `liveStart` (r70 1.2a, optional): the phone's push-to-start token, so rudderd can start its card; null withdraws it.
  private registerPush(deviceKey: string | undefined, ticket: string, prefs: unknown, liveStart: unknown) {
    if (!deviceKey) throw Object.assign(new Error("device unknown"), { code: "unauthorized" })
    if (!isPushTicket(ticket)) throw Object.assign(new Error("ticket must be the push gateway's base64url ticket"), { code: "invalid" })
    if (prefs !== undefined && (typeof prefs !== "object" || prefs === null || typeof (prefs as { done?: unknown }).done !== "boolean")) {
      throw Object.assign(new Error("prefs must be {done: boolean}"), { code: "invalid" })
    }
    const start = liveStart === undefined || liveStart === null ? liveStart : parseLiveStart(liveStart)
    const device = this.store.setDevicePushToken(deviceKey, ticket)
    if (!device) throw Object.assign(new Error("device unknown"), { code: "unauthorized" })
    if (prefs !== undefined) this.store.setDevicePushPrefs(deviceKey, JSON.stringify({ done: (prefs as { done: boolean }).done }))
    if (start !== undefined) this.store.setDeviceLiveStart(deviceKey, start)
    return { ok: true, remote: this.hooks.push !== undefined }
  }

  /** Whether an approval or question with this id still waits for the phone (a delayed push may still matter). */
  awaitsAnswer(id: string): boolean {
    return this.pendingPermissions.has(id) || this.pendingQuestions.has(id)
  }

  // params: { optionId } or legacy { allow } (first allow_* / reject_* option).
  private respondPermission(id: string, params: Record<string, unknown>) {
    const pending = this.pendingPermissions.get(id)
    if (!pending) throw Object.assign(new Error("permission not pending"), { code: "not_found" })
    const option = pickPermissionOption(pending.options, params)
    if (!option) {
      throw Object.assign(new Error("optionId (or allow) must match an offered option"), { code: "invalid" })
    }
    const allowed = option.kind === "allow_once" || option.kind === "allow_always"
    const review = readReview(params)
    // Comments ride only on a decline; an approval leaves them on the phone (they wait in 本轮改动).
    if (review && !allowed) this.deliverReview(pending, review)
    // A request with no command to show (some ACP tools) would make a rule nobody can read that covers every such
    // call of the tool: it is allowed this once. An agent that offers no allow-once option can only be told its own
    // allow-always, which outlives anything the phone revokes, so no rule is listed for it either.
    const once = pending.options.find((entry) => entry.kind === "allow_once")
    if (option.kind === "allow_always" && once && pending.detail.trim()) {
      // Allowing a command that is already listed (turned off, or from before `match`) turns that rule back on for
      // this call instead of listing it twice.
      const existing = this.rules.find((rule) => rule.sessionId === pending.sessionId && rule.tool === pending.tool && rule.command === pending.detail)
      if (existing) {
        existing.enabled = true
        existing.createdAt = Date.now()
        if (pending.match) existing.match = pending.match
        else delete existing.match
        this.store.saveRule(existing)
      } else {
        const rule: SessionRule = {
          id: crypto.randomUUID(),
          sessionId: pending.sessionId,
          tool: pending.tool,
          command: pending.detail,
          enabled: true,
          createdAt: Date.now(),
          ...(pending.match ? { match: pending.match } : {}),
        }
        this.rules.push(rule)
        this.store.saveRule(rule)
      }
    }
    this.settlePermission(id, allowed ? "allowed" : "denied", option.id)
    this.resumeStatus(pending.sessionId)
    // The rule above is the daemon's to apply and revoke (askPermission checks it). The agent hears allow-once, so it
    // keeps asking and a revoked rule takes effect; an agent's own allow-always would outlive the revoke.
    const forAgent = option.kind === "allow_always" ? (once ?? option) : option
    pending.resolve(forAgent.id)
    return { ok: true, optionId: option.id, allow: allowed }
  }

  /**
   * r47 line comments on a declined approval. Claude takes them as the deny message (the turn goes on); the other
   * agents have no field for it, so Rudder sends them as the next user message: steered into Codex's running turn,
   * or queued, which an ACP agent's reject turn end then sends as a new turn.
   */
  private deliverReview(pending: PendingPermission, review: { note: string; count: number }) {
    const session = this.store.getSession(pending.sessionId)
    if (!session) return
    const adapter = this.adapters.get(session.agent)
    if (adapter?.spec.transport === "claude" && pending.toolId) {
      this.reviewNotes.set(pending.toolId, review.note)
      return
    }
    const queued = this.enqueueSend(pending.sessionId, review.note, [], undefined, undefined, "relay")
    if (!adapter?.steer || adapter.spec.capabilities.steer !== true) return
    // After the decline reaches the agent, so the comments land in the same turn.
    queueMicrotask(() => {
      void this.steerQueued(pending.sessionId, queued.queued.id).catch(() => undefined)
    })
  }

  // params: { answers } or legacy { answer } (answers the first question).
  private respondQuestion(id: string, params: Record<string, unknown>) {
    const pending = this.pendingQuestions.get(id)
    if (!pending) throw Object.assign(new Error("question not pending"), { code: "not_found" })
    const answers = readAnswers(params, pending.firstKey)
    if (!answers) throw Object.assign(new Error("answers required"), { code: "invalid" })
    if (!answersFitOptions(pending.questions, answers)) {
      throw Object.assign(new Error("answer must be one of the options"), { code: "invalid" })
    }
    this.settleQuestion(id, "answered", answers)
    this.resumeStatus(pending.sessionId)
    pending.resolve(answers)
    return { ok: true, answers, answer: formatAnswer(answers[pending.firstKey]) }
  }

  // The agent enforces its own permission mode; the daemon only relays the request (except bypassPermissions
  // chosen mid-turn and an agent locked to approve everything, which askPermission answers itself).
  private askPermission(
    sessionId: string,
    request: PermissionRequest,
    withdraw: AbortSignal | undefined,
    turn: AbortSignal,
  ): Promise<string | null> {
    if (withdraw?.aborted || turn.aborted) return Promise.resolve(null)
    const id = crypto.randomUUID()
    // Switched to a looser mode after the agent started this turn, or an enabled 本会话总是允许 rule names exactly this
    // tool and command: the agent still asks, so answer for it.
    const bypass = this.modeAllows(sessionId, request.tool, request.kind, request.options) ?? this.ruleAllows(sessionId, request)
    const permission: PermissionPayload = {
      id,
      tool: request.tool,
      title: request.title,
      detail: request.detail,
      kind: request.kind,
      options: request.options,
      status: bypass ? "allowed" : "pending",
    }
    if (bypass) permission.decision = bypass.id
    if (request.toolId) permission.toolId = request.toolId
    if (request.diffs?.length) permission.diffs = request.diffs.map((diff) => truncateDiff(diff))
    const row = this.appendMessage({
      id,
      session_id: sessionId,
      kind: "permission",
      role: "assistant",
      text: `${request.tool}: ${request.detail}`,
      payload: JSON.stringify(permission),
      created_at: Date.now(),
    })
    if (bypass) {
      this.broadcast(eventFrame("permission.resolved", { ...permission, sessionId }))
      return Promise.resolve(bypass.id)
    }
    this.broadcast(eventFrame("permission.asked", messagePublic(row)))
    const notice = () =>
      this.hooks.push?.({
        v: 1,
        kind: "permission",
        sessionId,
        title: this.store.getSession(sessionId)?.title ?? "",
        body: `${request.tool}: ${request.title}`,
        permissionId: id,
        machine: this.machine().name,
        ...this.agentLabel(sessionId),
        tool: request.tool,
        command: request.title,
      })
    // One channel per request: a card that can be reached carries the buttons, and falls back to the notification
    // if its push then fails. A card with no ticket or a failing last push is no channel at all (r68 0-3). The
    // per-computer card goes first; a second approval while it shows another one is a notification.
    const live = this.hooks.live
    const permissionRequest = { id, tool: request.tool, detail: request.detail, kind: request.kind }
    if (this.hooks.card?.armPermission(sessionId, permissionRequest, () => notice())) {
      if (live?.covers(sessionId)) live.armPermission(sessionId, permissionRequest)
    } else if (live?.deliverable(sessionId)) {
      live.armPermission(sessionId, { id, tool: request.tool, detail: request.detail, kind: request.kind }, notice)
    } else {
      if (live?.covers(sessionId)) live.armPermission(sessionId, { id, tool: request.tool, detail: request.detail, kind: request.kind })
      notice()
    }
    return new Promise<string | null>((resolve) => {
      const withdrawn = () => this.cancelPermission(id, "withdrawn")
      const interrupted = () => this.cancelPermission(id, "interrupted")
      withdraw?.addEventListener("abort", withdrawn, { once: true })
      turn.addEventListener("abort", interrupted, { once: true })
      this.pendingPermissions.set(id, {
        sessionId,
        tool: request.tool,
        detail: request.detail,
        ...(request.match ? { match: request.match } : {}),
        kind: request.kind,
        options: request.options,
        ...(request.toolId ? { toolId: request.toolId } : {}),
        resolve: (optionId) => {
          withdraw?.removeEventListener("abort", withdrawn)
          turn.removeEventListener("abort", interrupted)
          resolve(optionId)
        },
      })
      this.emitStatus(sessionId, "waiting")
    })
  }

  /**
   * The allow-once option to answer with when the session's current mode would not have asked: everything in
   * bypassPermissions / fullAccess, file edits in acceptEdits. Never a plan approval. Modes the agent judges itself
   * (auto, autoApproval, dontAsk) and stricter modes still reach the phone and apply from the next turn.
   * An agent whose own settings approve everything (v71 lock) counts as bypassPermissions outside plan: the phone
   * already says commands run without asking, yet Grok 1.0.77 under autoApproval still asks for some (2026-11-07).
   */
  private modeAllows(sessionId: string, tool: string, kind: string | undefined, options: PermissionOption[]): PermissionOption | undefined {
    const session = this.store.getSession(sessionId)
    const mode = session?.permission_mode
    if (/plan/i.test(tool)) return undefined
    const agent = session ? this.adapters.get(session.agent)?.spec.id : undefined
    const locked = mode !== "plan" && agent !== undefined && this.knownAvailability.get(agent)?.permissionLock?.mode === "always-approve"
    const allowed = locked || mode === "bypassPermissions" || mode === "fullAccess" || (mode === "acceptEdits" && kind === "edit")
    return allowed ? options.find((option) => option.kind === "allow_once") : undefined
  }

  /** The allow-once option when an enabled session rule records this exact tool and command. Never a plan approval. */
  private ruleAllows(sessionId: string, request: PermissionRequest): PermissionOption | undefined {
    if (/plan/i.test(request.tool) || !ruleMatches(this.rules, sessionId, request.detail, request.tool, request.match)) return undefined
    return request.options.find((option) => option.kind === "allow_once")
  }

  /** Loosening the mode mid-turn also lets through what this session is already waiting on. */
  private releaseForMode(sessionId: string) {
    for (const [id, pending] of [...this.pendingPermissions]) {
      if (pending.sessionId !== sessionId) continue
      const option = this.modeAllows(sessionId, pending.tool, pending.kind, pending.options)
      if (option) this.respondPermission(id, { optionId: option.id })
    }
  }

  private askQuestion(
    sessionId: string,
    request: QuestionRequest,
    withdraw: AbortSignal | undefined,
    turn: AbortSignal,
  ): Promise<QuestionAnswers | null> {
    if (withdraw?.aborted || turn.aborted) return Promise.resolve(null)
    const id = crypto.randomUUID()
    const first = request.questions[0]
    const question: QuestionPayload = {
      id,
      prompt: first?.question ?? "",
      options: first?.options.map((option) => option.label) ?? [],
      status: "pending",
      questions: request.questions,
    }
    const row = this.appendMessage({
      id,
      session_id: sessionId,
      kind: "question",
      role: "assistant",
      text: request.questions.map((item) => item.question).join("\n"),
      payload: JSON.stringify(question),
      created_at: Date.now(),
    })
    this.broadcast(eventFrame("question.asked", messagePublic(row)))
    if (this.hooks.live?.covers(sessionId)) this.hooks.live.armQuestion(sessionId, { id, questions: request.questions })
    // Sent even while a per-session Live Activity covers it (answering from the lock screen only works from this
    // notice). The per-computer card carries it instead (fA1: one channel), with this notice as its fallback.
    const questionNotice = () => this.hooks.push?.({
      v: 1,
      kind: "question",
      sessionId,
      title: this.store.getSession(sessionId)?.title ?? "",
      body: row.text,
      questionId: id,
      machine: this.machine().name,
      agent: this.adapters.get(this.store.getSession(sessionId)?.agent ?? "")?.spec.label,
      q: pushQuestion(request.questions),
    })
    if (!this.hooks.card?.armQuestion(sessionId, { id, questions: request.questions }, questionNotice)) questionNotice()
    return new Promise<QuestionAnswers | null>((resolve) => {
      const withdrawn = () => this.cancelQuestion(id, "withdrawn")
      const interrupted = () => this.cancelQuestion(id, "interrupted")
      withdraw?.addEventListener("abort", withdrawn, { once: true })
      turn.addEventListener("abort", interrupted, { once: true })
      this.pendingQuestions.set(id, {
        sessionId,
        firstKey: question.prompt,
        questions: request.questions,
        resolve: (answers) => {
          withdraw?.removeEventListener("abort", withdrawn)
          turn.removeEventListener("abort", interrupted)
          resolve(answers)
        },
      })
      this.emitStatus(sessionId, "waiting")
    })
  }

  private settlePermission(id: string, status: "allowed" | "denied" | "cancelled", decision?: string, cancelReason?: CancelReason) {
    const pending = this.pendingPermissions.get(id)
    if (!pending) return undefined
    this.pendingPermissions.delete(id)
    this.hooks.live?.settle(pending.sessionId, id)
    this.hooks.card?.settle(pending.sessionId, id)
    const row = this.store.getMessage(id)
    if (row) {
      const permission: PermissionPayload = parsePermission(row.payload) ?? {
        id,
        tool: "tool",
        title: row.text,
        detail: row.text,
        status: "pending",
      }
      permission.status = status
      if (decision) permission.decision = decision
      if (cancelReason) permission.cancelReason = cancelReason
      this.appendMessage({ ...row, payload: JSON.stringify(permission), created_at: Date.now() })
      this.broadcast(eventFrame("permission.resolved", { ...permission, sessionId: pending.sessionId }))
    }
    return pending
  }

  private settleQuestion(id: string, status: "answered" | "cancelled", answers?: QuestionAnswers, cancelReason?: CancelReason) {
    const pending = this.pendingQuestions.get(id)
    if (!pending) return undefined
    this.pendingQuestions.delete(id)
    this.hooks.live?.settle(pending.sessionId, id)
    this.hooks.card?.settle(pending.sessionId, id)
    const row = this.store.getMessage(id)
    if (row) {
      const question: QuestionPayload = parseQuestion(row.payload) ?? {
        id,
        prompt: row.text,
        options: [],
        status: "pending",
      }
      question.status = status
      if (cancelReason) question.cancelReason = cancelReason
      let text = row.text
      if (answers) {
        question.answers = answers
        question.answer = formatAnswer(answers[pending.firstKey])
        const asked = question.questions?.length ? question.questions.map((item) => item.question) : [question.prompt]
        text = asked.map((item) => `${item}\n→ ${formatAnswer(answers[item])}`).join("\n")
      }
      this.appendMessage({ ...row, text, payload: JSON.stringify(question), created_at: Date.now() })
      this.broadcast(eventFrame("question.resolved", { ...question, sessionId: pending.sessionId }))
    }
    return pending
  }

  // withdrawn: the agent retracted the request; interrupted: the turn was aborted or ended first.
  private cancelPermission(id: string, reason: CancelReason) {
    const pending = this.settlePermission(id, "cancelled", undefined, reason)
    if (!pending) return
    this.resumeStatus(pending.sessionId)
    pending.resolve(null)
  }

  private cancelQuestion(id: string, reason: CancelReason) {
    const pending = this.settleQuestion(id, "cancelled", undefined, reason)
    if (!pending) return
    this.resumeStatus(pending.sessionId)
    pending.resolve(null)
  }

  // Called after a request settles; the upsert also carries the new `pending`.
  private resumeStatus(sessionId: string) {
    if (!this.generating.has(sessionId)) return this.notifySession(sessionId)
    const waiting =
      [...this.pendingPermissions.values()].some((entry) => entry.sessionId === sessionId) ||
      [...this.pendingQuestions.values()].some((entry) => entry.sessionId === sessionId)
    this.emitStatus(sessionId, waiting ? "waiting" : "running")
  }

  // Turn end: settles without a status per request; the idle upsert that follows carries pending null.
  private rejectPendingFor(sessionId: string) {
    for (const [id, pending] of this.pendingPermissions) {
      if (pending.sessionId === sessionId) this.settlePermission(id, "cancelled", undefined, "interrupted")?.resolve(null)
    }
    for (const [id, pending] of this.pendingQuestions) {
      if (pending.sessionId === sessionId) this.settleQuestion(id, "cancelled", undefined, "interrupted")?.resolve(null)
    }
  }

  private async generate(sessionId: string, text: string, abort: AbortController, images: AdapterImage[] = []) {
    const signal = abort.signal
    let failure: string | undefined
    // `failure` as phone copy, for the done notice: the extension words it in the phone's language.
    let failureCopy: PhoneCopy | undefined
    // Reasoning blocks still open when the turn ends get closed so clients stop the timer.
    const openReasoning = new Set<string>()
    // Adapters may call back after reply() settles (stray stdout, late requests); those are dropped.
    let live = true
    let outcome: LiveTurnEnd = { phase: "done" }
    let settled = false
    // Set when the turn ends on a usage limit or a missing sign-in: the queue would only fail the same way.
    let pause: QueuePause | undefined
    let failureInfo: AgentErrorInfo | undefined
    const turnRow = this.latestTurns.get(sessionId)
    const continuation = turnRow?.client_message_id ? this.continuationTurns.get(turnRow.client_message_id) : undefined
    // A continuation's text is the agent's own summary: the done notice's 「你：…」 title fallback must not quote it.
    const noticePrompt = continuation ? "" : text
    if (turnRow?.client_message_id) this.continuationTurns.delete(turnRow.client_message_id)
    const startedAt = Date.now()
    let turnCwd: string | undefined
    let snapshot: Promise<TurnSnapshot | null> | undefined
    let snapshotDone = false
    let snapshotLate = false
    // The probe started beside a turn begun on the agent's last answer.
    let recheck: { adapter: AgentAdapter; probe: Promise<Availability> } | undefined
    const failUnavailable = (adapter: AgentAdapter, availability: Availability) => {
      const copy = phoneCopy.agentUnavailable(adapter.spec.label, availability.reasonCopy ?? availability.reason)
      failure = copy.text
      failureCopy = copy
      const command = loginCommand(adapter.spec.id, availability.reason)
      const needsLogin = unavailableCode(availability.reason) === "auth_required"
      if (needsLogin) {
        pause = "auth_required"
        failureInfo = { code: "auth_required", ...(command ? { command } : {}) }
      }
      this.appendError(sessionId, failure, needsLogin ? { code: "auth_required", ...(command ? { command } : {}) } : undefined, copy)
      outcome = { phase: "failed", result: failure }
      settled = true
    }
    this.turnTools.set(sessionId, {
      tools: new Map(),
      diffs: new Map(),
      images: new TurnImageScan(),
      startedAt,
      windows: new Map(),
      named: new Map(),
      shell: false,
    })
    this.replyDispositions.delete(sessionId)
    this.lastAgentEventAt.set(sessionId, startedAt)
    this.retryingUntil.delete(sessionId)
    this.agentSpoke.delete(sessionId)
    this.followUpDue.delete(sessionId)
    this.stuckTurns.delete(sessionId)
    this.healthInspected.delete(sessionId)
    if (turnRow) {
      const execution = this.store.getTurn(turnRow.id)?.execution
      if (execution) this.health.set(sessionId, { identity: JSON.parse(execution) as TurnExecutionIdentity,
        lastEventAt: startedAt, lastProgressAt: startedAt, lastCheckAt: startedAt, retryUntil: 0,
        waiting: false, openTools: 0, openBackground: 0, pendingFinalization: false, transport: "unknown" })
    }
    let receiveTerminal!: () => void
    let rejectTerminal!: (error: Error) => void
    const terminal = new Promise<void>((resolve, reject) => { receiveTerminal = resolve; rejectTerminal = reject })
    this.terminalReceipts.set(sessionId, { resolve: receiveTerminal, reject: rejectTerminal })
    const guard = setInterval(() => {
      if (this.checkStuck(sessionId)) clearInterval(guard)
    }, this.guard.checkMs)
    guard.unref?.()
    try {
      const session = this.store.getSession(sessionId)
      if (!session) {
        outcome = { phase: "failed" }
        settled = true
        return
      }
      const adapter = this.adapters.get(session.agent)
      if (!adapter) {
        const copy = phoneCopy.agentUnknown(session.agent)
        failure = copy.text
        failureCopy = copy
        this.appendError(sessionId, failure, undefined, copy)
        outcome = { phase: "failed", result: failure }
        settled = true
        return
      }
      await this.settledAgentVersion(adapter)
      // Stale-while-revalidate: an agent last seen available starts on that answer while the probe runs again beside
      // it (a probe past its TTL took up to seconds: Codex app-server, Copilot's probe session). If the agent is gone
      // the spawn fails, and the catch below reports what the fresh probe says, as an awaited probe would have.
      const known = this.knownAvailability.get(adapter.spec.id)
      if (known?.available) recheck = { adapter, probe: this.availability(adapter) }
      const availability = known?.available ? this.versionGate(adapter, known) : await this.availability(adapter)
      if (!availability.available) {
        failUnavailable(adapter, availability)
        return
      }
      // The folder was checked at create / patch; it may since have been swapped for a symlink out of the
      // workspace or into a dot folder. Check again right before the agent is started in it.
      let cwd: string
      try {
        // No folder means the workspace root itself.
        cwd = session.cwd ? resolveSafe(session.cwd, this.hooks.workspaceRoot ?? WORKSPACE_ROOT) : WORKSPACE_ROOT
      } catch (error) {
        const copy = phoneCopy.cwdUnavailable(session.cwd || WORKSPACE_ROOT, copyOf(error) ?? (error instanceof Error ? error.message : String(error)))
        failure = copy.text
        failureCopy = copy
        this.appendError(sessionId, failure, undefined, copy)
        outcome = { phase: "failed", result: failure }
        settled = true
        return
      }
      turnCwd = cwd
      const track = this.turnTools.get(sessionId)
      if (track) track.cwd = cwd
      // The snapshot runs beside the agent's start instead of before it (up to its 5 s timeout on a big checkout):
      // nothing is written before the agent's first model response. One still running when the first tool event
      // arrives may have caught that tool's writes, so the turn then counts its tools' diffs (finishTurnChanges).
      if (insideGitRepo(cwd)) {
        const done = (taken: TurnSnapshot | null) => {
          snapshotDone = true
          return taken
        }
        snapshot = this.queueSnapshot(cwd).then(done, () => done(null))
      }
      // default_model is a Claude model id; other agents fall back to their own default.
      const fallbackModel = session.agent === "claude" ? this.store.getMeta("default_model") : null
      const model = session.model || fallbackModel || undefined
      // Usage rows are keyed by this turn; agent and model are what the turn was started with.
      const turn: UsageTurn = { turnId: crypto.randomUUID(), agent: session.agent, model: model ?? "" }
      // §2 rule 3: checked again right before the agent starts; a terminal may have opened it meanwhile.
      if (this.handoff?.heldElsewhere(sessionId)) {
        throw copyError(phoneCopy.terminalTookOver(), { code: "held_elsewhere" })
      }
      const carry = this.carryOver(session, adapter.forks === true, text)
      const launch = this.modeForLaunch(session.agent, session.permission_mode || "ask")
      if (launch.persist) {
        const updated = this.store.patchSession(sessionId, { permissionMode: launch.mode })
        if (updated) this.notifySession(sessionId)
      }
      const identity = turnRow ? JSON.parse(this.store.getTurn(turnRow.id)?.execution ?? "null") as TurnExecutionIdentity | null : null
      const ownsExecution = () => live && (!identity || this.executionIsCurrent(identity))
      await Promise.race([terminal, adapter.reply(carry.text ?? text, {
        sessionId,
        executionIdentity: identity ?? undefined,
        ...(continuation ? { continuation: { key: continuation.key, delivery: continuation.delivery } } : {}),
        emit: (event) => {
          if (!ownsExecution()) return undefined
          if (event.type === "tool" && !snapshotDone) snapshotLate = true
          return this.handleEvent(sessionId, turn, event, openReasoning, identity ?? undefined)
        },
        askPermission: (request, withdraw) =>
          ownsExecution() ? this.askPermission(sessionId, request, withdraw, signal) : Promise.resolve(null),
        askQuestion: (request, withdraw) =>
          ownsExecution() ? this.askQuestion(sessionId, request, withdraw, signal) : Promise.resolve(null),
        cwd,
        model,
        contextWindow: session.context_window ?? undefined,
        // A model known to refuse an effort runs at its own default; the session keeps the choice for other models.
        effort: model && this.effortRefused(session.agent).has(model) ? undefined : session.effort || undefined,
        speed: session.speed || undefined,
        permissionMode: launch.mode,
        nativeId: session.native_id ?? undefined,
        ...carry.fork,
        images: images.length > 0 ? images : undefined,
        allowsCommand: (command) => ruleMatches(this.rules, sessionId, command),
        reviewNote: (toolId) => {
          const note = this.reviewNotes.get(toolId)
          this.reviewNotes.delete(toolId)
          return note
        },
        signal,
      })])
      const engineTerminal = this.health.get(sessionId)?.terminalStatus
      if (engineTerminal === "failed") throw new Error("Agent reported failed completion")
      if (engineTerminal === "interrupted") { outcome = { phase: "interrupted" }; settled = true }
    } catch (error) {
      settled = true
      if (signal.aborted) {
        this.appendMessage({
          id: crypto.randomUUID(),
          session_id: sessionId,
          kind: "text",
          role: "assistant",
          text: "Cancelled.",
          payload: NOTICE_PAYLOAD,
          created_at: Date.now(),
        })
        outcome = { phase: "interrupted" }
      } else if (recheck && !(await recheck.probe).available) {
        // `availability()` already applied the version gate to its answer.
        failUnavailable(recheck.adapter, await recheck.probe)
      } else {
        const detail = error instanceof Error ? error.message : "adapter failed"
        failure = `Error: ${detail}`
        const info = await this.agentErrorInfo(sessionId, error, detail)
        failureInfo = info
        if (info?.code === "auth_required" || info?.code === "usage_limit") this.recordStop(sessionId, info.code)
        if (info?.code === "usage_limit" || info?.code === "auth_required") pause = info.code
        // A "yes" can be cached for long (Claude: 30 min); a sign-in failure says it no longer holds.
        if (info?.code === "auth_required") this.forgetAvailability(sessionId)
        failureCopy = copyOf(error)
        this.appendError(sessionId, failure, info, failureCopy)
        outcome = { phase: "failed", result: failure }
      }
    } finally {
      live = false
      clearInterval(guard)
      // perf-1112 round two: the phone hears idle, and a queued message starts, before the turn's git work. Only the
      // end snapshot is taken in order (queued ahead of any next turn's start snapshot of the folder); the diff, the
      // counts and the stored changes follow in `finishTurnChanges`, which then sends the session again.
      const track = this.turnTools.get(sessionId)
      const endedAt = Date.now()
      const gitEnd = snapshot && turnCwd && !snapshotLate ? { before: snapshot, after: this.queueSnapshot(turnCwd).catch(() => null) } : undefined
      let ownership: ToolOwnership | undefined
      let recorded: TurnOutcome | undefined
      try {
        if (gitEnd && track) ownership = await this.toolOwnership(sessionId, track, endedAt)
        if (track) await this.keepToolClaims(sessionId, track, endedAt)
        if (turnRow) {
          const phase = signal.aborted ? "interrupted" : settled ? outcome.phase : "done"
          recorded = this.recordTurnOutcome(sessionId, turnRow.id, phase, failure, endedAt, track, failureCopy)
        }
      } catch (error) {
        console.warn(`rudderd: recording turn ${turnRow?.id ?? "?"} failed:`, error)
      }
      const scan = track?.images
      this.turnTools.delete(sessionId)
      // These write the db. A failed write (disk full, a locked file) is logged and the turn still ends: skipping the
      // rest would leave the session generating, busy to every send, until rudderd restarts.
      const survive = (label: string, step: () => void) => {
        try {
          step()
        } catch (error) {
          console.warn(`rudderd: ending ${sessionId}'s turn: ${label} failed:`, error)
        }
      }
      survive("closing reasoning", () => {
        for (const id of openReasoning) this.streamReasoning(sessionId, id, "", true)
      })
      survive("flushing the stream", () => this.flushStream(sessionId))
      survive("dropping the stream", () => this.dropStream(sessionId))
      if (scan && turnCwd) await this.attachTurnImages(sessionId, turnRow?.id ?? crypto.randomUUID(), scan, turnCwd)
      survive("cancelling open approvals", () => this.rejectPendingFor(sessionId))
      if (this.aborts.get(sessionId) === abort) this.aborts.delete(sessionId)
      this.generating.delete(sessionId)
      if (signal.aborted) outcome = { phase: "interrupted" }
      this.terminalReceipts.delete(sessionId)
      this.health.delete(sessionId)
      this.healthInspected.delete(sessionId)
      if (!signal.aborted && !settled) outcome = { phase: "done", result: this.assistantSentence(sessionId) }
      // Drop the speech-pause count before the phone hears done, so the closing idle is a real close. The list stays,
      // with anything still marked running put down as cancelled: nobody reports on it after the turn.
      this.backgroundOpen.delete(sessionId)
      this.backgroundPaused.delete(sessionId)
      this.closeBackground(sessionId)
      const silent = signal.aborted && this.stuckTurns.has(sessionId)
      survive("recording the turn's phase", () => this.emitTurn(sessionId, outcome.phase))
      const end: LiveTurnEnd = {
        ...outcome,
        ...(failureInfo ? { reason: failureInfo } : {}),
        ...(silent ? { silent } : {}),
        ...(outcome.phase === "failed" && failureCopy ? { copy: failureCopy } : {}),
      }
      this.steps.delete(sessionId)
      // The lock screen waits for the changes: the card and the notice both show them.
      this.emitStatus(sessionId, "idle", { holdLive: true })
      this.lastAgentEventAt.delete(sessionId)
      this.agentSpoke.delete(sessionId)
      this.followUpDue.delete(sessionId)
      this.stuckTurns.delete(sessionId)
      try {
        this.handoff?.turnEnded(sessionId)
      } catch (error) {
        console.warn(`rudderd: handoff bookkeeping after ${sessionId}'s turn failed:`, error)
      }
      // Read now: by the time the changes are counted a queued message may have started the next turn.
      const reply = failure === undefined && !silent && recorded?.phase !== "failed" ? this.assistantSentence(sessionId) : undefined
      if (pause && !signal.aborted) {
        this.pausedQueues.set(sessionId, pause)
        if (this.outbound.get(sessionId)?.length) this.broadcast(this.queueFrame(sessionId, this.outbound.get(sessionId)))
        if (turnRow && failureInfo?.code === "usage_limit" && failureInfo.resetsAt !== undefined) {
          this.scheduleLimitResume(sessionId, turnRow.id, failureInfo.resetsAt)
        }
      }
      // After this turn's idle: a queued message starts the next turn, and its running must be the last status the
      // phone hears (flushing first broadcast running, then this turn's idle over it).
      this.flushOutbound(sessionId)
      if (turnRow && recorded) {
        const turnId = turnRow.id
        const ended = this.finishTurnChanges({ sessionId, turnId, startedAt, endedAt, cwd: turnCwd, git: gitEnd, track, ownership, outcome: recorded })
          .catch((error: unknown) => console.warn(`rudderd: recording turn ${turnId}'s changes failed:`, error))
          .then((changes) => {
            // The next turn (a queued message) already owns the card; this one's end would show over its running.
            if (!this.generating.has(sessionId)) this.liveStatus(sessionId, "idle", end, changes ?? undefined)
            // A turn the user stopped (or a deleted session) needs no notice; the phone was just used for it. The
            // guard's stop of a silent agent is not the user's and is told as a failure.
            if (!signal.aborted || silent) this.pushTurnEnd(sessionId, noticePrompt, failure, failureInfo, silent, failureCopy, { ...recorded, changes: changes ?? undefined }, reply)
          })
        this.turnEnds.set(sessionId, ended)
        void ended.finally(() => {
          if (this.turnEnds.get(sessionId) === ended) this.turnEnds.delete(sessionId)
        })
      } else {
        if (!this.generating.has(sessionId)) this.liveStatus(sessionId, "idle", end)
        if (!signal.aborted || silent) this.pushTurnEnd(sessionId, noticePrompt, failure, failureInfo, silent, failureCopy, recorded, reply)
      }
    }
  }

  private trackTool(sessionId: string, event: Extract<AgentEvent, { type: "tool" }>, diffs: ToolDiff[] | undefined) {
    const track = this.turnTools.get(sessionId)
    if (!track) return
    const known = track.tools.get(event.id)
    // A new id goes to the end, so the last entry is the tool started last; an update keeps its place.
    const exitCode = event.exitCode ?? known?.exitCode
    track.tools.set(event.id, { title: event.title, status: event.status, ...(exitCode !== undefined ? { exitCode } : {}) })
    if (event.kind === "edit" && diffs?.length) track.diffs.set(event.id, diffs)
    if (event.kind === "edit") track.images.notePaths((event.diffs ?? []).map((diff) => diff.path))
    // A tool waiting for approval is not running yet; its window opens with the first event past pending.
    const now = Date.now()
    const window = track.windows.get(event.id) ?? (event.status === "pending" ? undefined : { start: now })
    if (window) {
      if (window.end === undefined && CLOSED_TOOL.has(event.status)) window.end = now
      track.windows.set(event.id, window)
    }
    if (event.kind === "execute") track.shell = true
    const paths = (event.diffs ?? []).map((diff) => diff.path)
    if (event.kind === "edit" && event.detail && !event.detail.includes("\n")) paths.push(event.detail)
    if (paths.length > 0) track.named.set(event.id, [...new Set([...(track.named.get(event.id) ?? []), ...paths])])
  }

  /** The paths a turn's tools named, canonical, each with the window of the tool that named it. Declined tools wrote nothing. */
  private async claimsOf(sessionId: string, track: TurnToolTrack, now: number): Promise<ToolClaim[]> {
    const claims: ToolClaim[] = []
    for (const [toolId, paths] of track.named) {
      if (track.tools.get(toolId)?.status === "declined") continue
      const window = track.windows.get(toolId)
      if (!window) continue
      for (const path of paths) {
        claims.push({ sessionId, path: await canonicalPath(resolve(track.cwd ?? WORKSPACE_ROOT, path)), start: window.start, end: window.end ?? now })
      }
    }
    return claims
  }

  /** What `ownFiles` needs to cut a turn's diff to the files its tools account for, read as the turn ends. */
  private async toolOwnership(sessionId: string, track: TurnToolTrack, endedAt: number): Promise<ToolOwnership> {
    const own = await this.claimsOf(sessionId, track, endedAt)
    const others = new Set<string>()
    const live: ToolClaim[] = []
    for (const [otherId, other] of this.turnTools) if (otherId !== sessionId) live.push(...(await this.claimsOf(otherId, other, endedAt)))
    for (const claim of [...this.toolClaims, ...live]) {
      if (claim.sessionId !== sessionId && claim.start <= endedAt && claim.end >= track.startedAt) others.add(claim.path)
    }
    return { windows: [...track.windows.values()], named: new Set(own.map((claim) => claim.path)), others, shell: track.shell }
  }

  /** Keeps this turn's named paths for the turns still running; drops claims no running turn overlaps. */
  private async keepToolClaims(sessionId: string, track: TurnToolTrack, endedAt: number) {
    const own = await this.claimsOf(sessionId, track, endedAt)
    const running = [...this.turnTools].filter(([id]) => id !== sessionId).map(([, other]) => other.startedAt)
    const floor = running.length > 0 ? Math.min(...running) : Number.POSITIVE_INFINITY
    this.toolClaims = [...this.toolClaims, ...own].filter((claim) => claim.end >= floor)
  }

  /** the turn's picture files as `kind:"image"` rows after its reply. Row ids are per turn, so a replay adds none. */
  private async attachTurnImages(sessionId: string, turnId: string, scan: TurnImageScan, cwd: string) {
    try {
      const images = await collectTurnImages(scan.candidates(), cwd)
      for (const [index, image] of images.entries()) {
        await this.storeImage(sessionId, {
          type: "image",
          id: `${turnId}-img-${index}`,
          name: image.fileName,
          mediaType: image.mediaType,
          width: image.width,
          height: image.height,
          bytes: image.bytes,
          fileName: image.fileName,
          sourcePath: image.sourcePath,
        })
      }
    } catch (error) {
      console.warn(`rudderd: attaching ${sessionId}'s turn images failed:`, error)
    }
  }

  /**
   * r47: writes the turn's `lastTurn` as the turn ends, before any git work. A turn fails when the agent errored, or
   * when its last tool failed (the one the fold keeps in view); the reason is that tool's title. `finishTurnChanges`
   * adds what it changed.
   */
  private recordTurnOutcome(
    sessionId: string,
    turnId: string,
    phase: LiveTurnEnd["phase"],
    failure: string | undefined,
    endedAt: number,
    track: TurnToolTrack | undefined,
    failureCopy?: PhoneCopy,
  ): TurnOutcome {
    const row = this.store.getTurn(turnId)
    const termination = row?.termination ? JSON.parse(row.termination) as TurnTermination : undefined
    const reply = this.replyDispositions.get(sessionId)
    const outcome: TurnOutcome = { phase, endedAt, replyDisposition: reply?.value ?? "unknown",
      ...(reply ? { finalMessageIds: reply.nativeMessageIds } : {}),
      ...(termination ? { termination } : phase === "interrupted" || phase === "failed"
        ? { termination: { cause: phase === "failed" ? "engine_error" : "unknown", requestedAt: endedAt } as TurnTermination } : {}) }
    const lastTool = track ? [...track.tools.entries()].at(-1) : undefined
    if (phase === "interrupted" && this.stuckTurns.has(sessionId)) {
      outcome.reason = "agent_silent"
    } else if (phase === "failed" && failure) {
      outcome.reason = firstLine(failure.replace(/^Error: /, ""))
      if (failureCopy) outcome.reasonCopy = failureCopy
    } else if (phase === "done" && lastTool?.[1].status === "failed") {
      outcome.phase = "failed"
      outcome.reason = firstLine(lastTool[1].title)
      outcome.toolId = lastTool[0]
      if (lastTool[1].exitCode !== undefined) outcome.exitCode = lastTool[1].exitCode
    }
    this.setTurnOutcome(sessionId, turnId, outcome)
    return outcome
  }

  private setTurnOutcome(sessionId: string, turnId: string, outcome: TurnOutcome) {
    const prompt = this.store.setTurnOutcome(turnId, outcome)
    if (prompt) this.broadcast(eventFrame("message.append", messagePublic(prompt)))
    const row = this.latestTurns.get(sessionId)
    if (row?.id === turnId) this.latestTurns.set(sessionId, { ...row, outcome: JSON.stringify(outcome) })
  }

  /**
   * r47: the turn's `turn.changes`, after its idle: between the two snapshots when both were taken, else from its
   * tools' diffs. When it changed files the totals join `lastTurn` and the session goes out again. Returns the totals.
   */
  private async finishTurnChanges(end: {
    sessionId: string
    turnId: string
    startedAt: number
    endedAt: number
    cwd: string | undefined
    git: { before: Promise<TurnSnapshot | null>; after: Promise<TurnSnapshot | null> } | undefined
    track: TurnToolTrack | undefined
    ownership: ToolOwnership | undefined
    outcome: TurnOutcome
  }): Promise<TurnOutcome["changes"]> {
    const { sessionId, turnId, startedAt, endedAt, track } = end
    let changes: TurnChanges | undefined
    const before = end.git ? await end.git.before : null
    const after = before && end.git ? await end.git.after : null
    if (before && after) {
      const changed = await diffSnapshots(before, after)
      const files = end.ownership && changed.length > 0 ? await ownFiles(changed, after, { ...end.ownership, endedAt }) : changed
      if (files.length > 0) {
        // Counted over the kept files only when some were left out (a long path list for a big turn is avoided).
        const paths = files.length < changed.length ? files.map((file) => (before.scope ? `${before.scope}/${file.path}` : file.path)) : undefined
        const edits = await countTreeEdits(before.top, before.tree, after.tree, files, paths)
        changes = { turnId, sessionId, source: "git", root: before.root, base: before.tree, head: after.tree, startedAt, endedAt, files, approx: skippedChanged(before, after), edits }
      }
    } else if (track && track.diffs.size > 0) {
      const byPath = new Map<string, ToolDiff[]>()
      for (const [toolId, diffs] of track.diffs) {
        if (track.tools.get(toolId)?.status !== "completed") continue
        for (const diff of diffs) {
          const existing = byPath.get(diff.path)
          if (existing) existing.push(diff)
          else byPath.set(diff.path, [diff])
        }
      }
      const root = end.cwd ?? WORKSPACE_ROOT
      const summary = await summarizeToolDiffs(byPath, root)
      if (summary.files.length > 0) {
        const diffs: Record<string, ToolDiff[]> = {}
        for (const [path, list] of byPath) diffs[path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path] = list
        const edits = [...byPath.values()].reduce((sum, list) => sum + list.length, 0)
        changes = { turnId, sessionId, source: "tools", root, startedAt, endedAt, files: summary.files, approx: summary.approx, diffs, edits }
      }
    }
    // Deleted meanwhile: nothing to attach the changes to.
    if (!changes || !this.store.getSession(sessionId)) return undefined
    this.store.putTurnChanges(changes)
    const totals = changesTotals(changes.files)
    this.setTurnOutcome(sessionId, turnId, { ...end.outcome, changes: totals })
    this.notifySession(sessionId)
    return totals
  }

  /** Waits for the session's last turn to store its changes: a rewind, a clear or a changes read needs them. */
  async turnSettled(sessionId: string) {
    await this.turnEnds.get(sessionId)
  }

  /**
   * perf-1112 round two: snapshots of one folder run one after another, so a turn's end snapshot (queued as the turn
   * ends) is taken before the start snapshot of a next turn that a queued message begins at once.
   */
  private queueSnapshot(cwd: string): Promise<TurnSnapshot | null> {
    const take = this.hooks.snapshotTree ?? snapshotTree
    const run = () => take(cwd, this.hooks.workspaceRoot ?? WORKSPACE_ROOT)
    const prior = this.snapshotQueue.get(cwd)
    // Started at once when nothing is ahead: a turn's start snapshot races the agent's first write.
    const next = prior ? prior.then(run, run) : run()
    this.snapshotQueue.set(cwd, next)
    const clear = () => {
      if (this.snapshotQueue.get(cwd) === next) this.snapshotQueue.delete(cwd)
    }
    next.then(clear, clear)
    return next
  }


  private async turnChanges(sessionId: string, turnId: string, summaryOnly: boolean) {
    await this.turnSettled(sessionId)
    const changes = this.store.getTurnChanges(turnId)
    if (!changes || changes.sessionId !== sessionId) {
      if (!this.store.getSession(sessionId)) throw Object.assign(new Error("session not found"), { code: "not_found" })
      // A turn that changed nothing (or ran before r47) has no record: an empty list, not an error.
      return { turnId, sessionId, files: [], totals: { files: 0, added: 0, removed: 0 }, approx: false, filesTruncated: false }
    }
    return changesPublic(changes, summaryOnly ? undefined : await currentStates(changes).catch(() => undefined))
  }

  private async turnDiff(sessionId: string, turnId: string, path: string) {
    await this.turnSettled(sessionId)
    const changes = this.store.getTurnChanges(turnId)
    if (!changes || changes.sessionId !== sessionId) throw Object.assign(new Error("turn has no changes"), { code: "not_found" })
    return snapshotPatch(changes, path, this.hooks.workspaceRoot ?? WORKSPACE_ROOT)
  }

  /**
   * The lock-screen "done" notice: the reply's first sentence and the turn's changes, or
   * failed with its reason. `NotifyPolicy` folds several finished sessions into one notice.
   */
  private pushTurnEnd(
    sessionId: string,
    prompt: string,
    failure: string | undefined,
    info: AgentErrorInfo | undefined,
    silent: boolean,
    copy: PhoneCopy | undefined,
    recorded: TurnOutcome | undefined,
    reply: string | undefined,
  ) {
    const session = this.store.getSession(sessionId)
    if (!session || !this.hooks.push) return
    const failed = silent || failure !== undefined || recorded?.phase === "failed"
    const reason: PushReason | undefined = silent ? { code: "agent_silent" } : info
    // A failed last tool fails the turn without an error: its title is the reason (the list's red line).
    const body = failure?.replace(/^Error: /, "") ?? (failed ? recorded?.reason ?? "" : reply ? firstSentence(reply) : "")
    const changes = recorded?.changes ?? { files: 0, added: 0, removed: 0 }
    const prompted = firstPromptLine(prompt)
    const payload: PushPayload = {
      v: 1,
      kind: "done",
      sessionId,
      title: session.title,
      body: silent ? "" : body,
      machine: this.machine().name,
      ...this.agentLabel(sessionId),
      outcome: failed ? "failed" : "done",
      ...(prompted ? { firstPrompt: prompted } : {}),
      changes: { added: changes.added, removed: changes.removed, files: changes.files },
      ...(reason ? { reason } : {}),
      // The body in the phone's language; `body` stays rudderd's text for an extension that predates it.
      ...(copy && failure !== undefined && !silent ? { copy } : {}),
    }
    const planned = this.notifyPolicy.turnEnded(payload, { stoppedByUser: false })
    if (!planned) return
    const send = () => this.hooks.push?.(planned.payload, { collapseId: planned.collapseId })
    // the per-computer card already shows this result with its alert; the notice goes out only if that fails.
    if (this.hooks.card?.takeResult(sessionId, send)) return
    send()
  }

  private agentLabel(sessionId: string): { agent?: string } {
    const label = this.adapters.get(this.store.getSession(sessionId)?.agent ?? "")?.spec.label
    return label ? { agent: label } : {}
  }

  private handleEvent(sessionId: string, turn: UsageTurn, event: AgentEvent, openReasoning: Set<string>, identity?: TurnExecutionIdentity) {
    this.lastAgentEventAt.set(sessionId, Date.now())
    if ((event.type === "text" && !event.notice) || event.type === "reasoning" || event.type === "tool" || (event.type === "status" && event.status === "running")) {
      this.followUpDue.delete(sessionId)
    }
    const health = this.health.get(sessionId)
    if (health && (event.type === "text" || event.type === "reasoning" || event.type === "tool" || event.type === "plan")) {
      health.lastProgressAt = Date.now()
      this.healthInspected.delete(sessionId)
      if (!health.pendingFinalization) health.terminalStatus = undefined
    }
    if ((event.type === "text" && !event.notice && event.text.length > 0) || event.type === "reasoning" || event.type === "tool" || event.type === "plan" || event.type === "image") {
      this.emitTurn(sessionId, "running")
    }
    switch (event.type) {
      case "lifecycle":
        if (health) {
          health.pendingFinalization = event.pendingFinalization ?? false
          if (event.transport) health.transport = event.transport
          if (event.transport === "closed" && event.detail) health.closeDetail = event.detail
          // Plan 2026-11-18: an end the adapter inferred (no idle signal from the agent) is recorded as such.
          if (event.phase === "terminal" && event.inferred) this.recordStop(sessionId, "inferred_quiet", event.inferred)
          if (event.phase === "working") { health.terminalStatus = undefined; health.lastProgressAt = Date.now() }
          if (event.phase === "terminal") health.terminalStatus = event.terminalStatus
          if (event.phase === "terminal" || event.transport === "closed") this.checkStuck(sessionId)
        }
        return
      // The daemon owns idle (turn end) and derives running vs waiting from open requests.
      case "status":
        if (event.status === "running" && this.backgroundPaused.delete(sessionId)) {
          this.hooks.live?.background(sessionId, 0)
          this.hooks.card?.background(sessionId, 0)
        }
        if (event.status === "waiting") this.emitStatus(sessionId, "waiting")
        else if (event.status === "running") this.resumeStatus(sessionId)
        return
      // Every change to the turn's background work. When the speech has paused with some still open, idle the phone
      // without the snapshot or the lock-screen done. A later status running (the follow-up sentence) does not clear
      // the count; reply() returning does.
      case "background":
        this.noteBackground(sessionId, event)
        return
      case "retry":
        this.retryingUntil.set(sessionId, Date.now() + (event.delayMs ?? 0))
        return
      case "effortRefused": {
        const session = this.store.getSession(sessionId)
        if (session) this.rememberEffortRefused(session.agent, event.model)
        return
      }
      case "steer": {
        const session = this.store.getSession(sessionId)
        if (!session) return
        const adapter = this.adapters.get(session.agent)
        const control = steerControl(
          session.agent,
          adapter?.spec.capabilities.steer === true,
          typeof adapter?.steer === "function",
          event.result,
        )
        this.steerCache.set(session.agent, control)
        this.broadcast(eventFrame("steer.control", { sessionId, steerControl: control }))
        return
      }
      case "replyDisposition":
        this.replyDispositions.set(sessionId, event)
        return
      case "text":
        if (event.notice !== true) this.turnTools.get(sessionId)?.images.noteText(event.id, event.text)
        this.streamText(sessionId, event.id, event.text, event.notice === true, event.copy, event.replyChoices, event.phase)
        return
      case "reasoning": {
        const block = this.streamReasoning(sessionId, event.id, event.text, event.done, event.startedAt)
        if (!block) return
        if (block.endedAt === undefined) {
          if (!openReasoning.has(event.id)) this.setStep(sessionId, event.id, { kind: "think" })
          openReasoning.add(event.id)
        } else {
          openReasoning.delete(event.id)
          this.endStep(sessionId, event.id)
        }
        return
      }
      case "tool": {
        const tool: ToolPayload = {
          id: event.id,
          tool: event.tool,
          title: event.title,
          detail: event.detail,
          kind: event.kind,
          status: event.status,
        }
        if (event.output !== undefined) {
          tool.output = truncateUtf8(event.output, TOOL_OUTPUT_LIMIT)
          if (tool.output !== event.output) tool.outputTruncated = true
        }
        if (event.exitCode !== undefined) tool.exitCode = event.exitCode
        if (event.diffs?.length) tool.diffs = event.diffs.map((diff) => truncateDiff(diff))
        this.trackTool(sessionId, event, tool.diffs)
        const payload = JSON.stringify(tool)
        const previous = this.store.getMessage(event.id)
        if (previous?.session_id === sessionId && previous.kind === "tool" && previous.payload === payload) {
          this.flushStream(sessionId)
          this.markSteerRead(sessionId)
        } else {
          this.appendMessage({
            id: event.id,
            session_id: sessionId,
            kind: "tool",
            role: "assistant",
            text: `${event.tool}: ${event.title}`,
            payload,
            created_at: Date.now(),
          })
        }
        this.hooks.live?.tool(sessionId, { id: event.id, tool: event.tool, title: event.title, kind: event.kind, status: event.status })
        this.hooks.card?.tool(sessionId, { id: event.id, tool: event.tool, title: event.title, kind: event.kind, status: event.status })
        this.toolStep(sessionId, event)
        return
      }
      case "title": {
        this.retitleFromAgent(sessionId, event.title)
        return
      }
      case "plan": {
        this.hooks.card?.plan(sessionId, event.entries)
        const plan: PlanPayload = { entries: event.entries }
        this.appendMessage({
          id: event.id,
          session_id: sessionId,
          kind: "plan",
          role: "assistant",
          text: event.entries.map((entry) => `${PLAN_MARKS[entry.status]} ${entry.content}`).join("\n"),
          payload: JSON.stringify(plan),
          created_at: Date.now(),
        })
        return
      }
      case "usage": {
        this.flushStream(sessionId)
        const tokens = (event.usage.inputTokens ?? 0) + (event.usage.outputTokens ?? 0)
        if (tokens > 0) this.hooks.live?.usage(sessionId, tokens)
        if (!this.store.recordUsage(sessionId, turn, event.usage)) return
        this.notifySession(sessionId)
        return
      }
      case "compaction": {
        const session = this.store.getSession(sessionId)
        if (!session) return
        const previous = this.store.getMessage(event.id)
        let prior: Record<string, unknown> = {}
        if (previous?.session_id === sessionId && previous.kind === "compaction" && previous.payload) {
          try {
            const parsed: unknown = JSON.parse(previous.payload)
            if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) prior = parsed as Record<string, unknown>
          } catch (error) {
            throw new Error(`compaction ${event.id} has invalid prior payload`, { cause: error })
          }
        }
        if (event.state === "done" && prior.state === "done") return
        const count = event.trigger === "auto" ? session.compaction_count + 1 : session.compaction_count
        const payload = {
          ...prior,
          state: event.state,
          trigger: event.trigger,
          count,
          ...(event.startedAt !== undefined || prior.startedAt !== undefined
            ? { startedAt: event.startedAt ?? prior.startedAt }
            : {}),
          ...(event.tokensBefore !== undefined ? { tokensBefore: event.tokensBefore } : {}),
          ...(event.tokensAfter !== undefined ? { tokensAfter: event.tokensAfter } : {}),
        }
        this.appendMessage({
          id: event.id,
          session_id: sessionId,
          kind: "compaction",
          role: "assistant",
          text: event.state === "running" ? "正在压缩上下文…" : "上下文已压缩",
          payload: JSON.stringify(payload),
          created_at: Date.now(),
        })
        if (event.state === "done") {
          if (event.trigger === "auto") this.store.patchSession(sessionId, { compactionCount: count })
          if (session.agent === "grok" && event.tokensAfter !== undefined) {
            this.store.patchContextUsage(sessionId, event.tokensAfter, event.contextSize)
          }
          this.notifySession(sessionId)
        }
        return
      }
      case "contextWindow": {
        const session = this.store.patchSession(sessionId, { contextWindow: event.value })
        if (session) this.notifySession(sessionId)
        return
      }
      case "nativeTurn": {
        const row = this.latestTurns.get(sessionId)
        if (!row) return
        const stored = row.native ? (JSON.parse(row.native) as TurnNative) : undefined
        const same = stored?.session === event.nativeId ? stored : undefined
        // Codex's first turn id of this turn stays (revert drops it and every later one); Claude's last record moves on.
        const native: TurnNative = {
          session: event.nativeId,
          ...((same?.turnId ?? event.turnId) ? { turnId: same?.turnId ?? event.turnId } : {}),
          ...((event.lastMessageId ?? same?.lastMessageId) ? { lastMessageId: event.lastMessageId ?? same?.lastMessageId } : {}),
        }
        row.native = JSON.stringify(native)
        this.store.setTurnNative(row.id, native)
        const executed = this.store.getTurn(row.id)
        if (executed?.execution) {
          const execution = JSON.parse(executed.execution) as TurnExecutionIdentity
          this.store.setTurnExecution(row.id, { ...execution, nativeSessionId: native.session,
            ...(native.turnId ? { nativeTurnId: native.turnId } : {}) })
        }
        return
      }
      case "native": {
        const current = this.latestTurns.get(sessionId)
        const executed = current && this.store.getTurn(current.id)
        if (executed?.execution) this.store.setTurnExecution(executed.id, {
          ...JSON.parse(executed.execution) as TurnExecutionIdentity, nativeSessionId: event.nativeId,
        })
        const session = this.store.getSession(sessionId)
        if (!session || !event.nativeId || session.native_id === event.nativeId) return
        this.store.patchSession(sessionId, { nativeId: event.nativeId })
        this.store.settleCarryOver(sessionId)
        return
      }
      // The agent left the mode on its own (approved plan): the session follows, so the next turn does not undo it.
      case "mode": {
        const session = this.store.getSession(sessionId)
        if (!session || !event.mode || session.permission_mode === event.mode) return
        if (!this.agentMayEnterMode(session.agent, event.mode)) return
        this.store.patchSession(sessionId, { permissionMode: event.mode })
        this.notifySession(sessionId)
        return
      }
      case "image":
        return this.storeImage(sessionId, event, identity)
    }
  }

  private executionIsCurrent(identity: TurnExecutionIdentity): boolean {
    if (this.latestTurns.get(identity.sessionId)?.id !== identity.turnId) return false
    const session = this.store.getSession(identity.sessionId)
    return session?.agent === identity.agentId && (session.generation ?? 0) === identity.generation
  }

  // The row id is the agent item id, so a replayed turn does not copy the file a second time.
  private async storeImage(sessionId: string, event: Extract<AgentEvent, { type: "image" }>, identity?: TurnExecutionIdentity) {
    const existing = this.store.getMessage(event.id)
    if (existing?.kind === "image" && existing.session_id === sessionId) return
    const session = this.store.getSession(sessionId)
    if (!session) return
    const saved = await saveAttachment(session.cwd || WORKSPACE_ROOT, sessionId, event.name, event.bytes)
    if (identity && !this.executionIsCurrent(identity)) return
    this.appendMessage({
      id: event.id,
      session_id: sessionId,
      kind: "image",
      role: "assistant",
      text: "",
      payload: JSON.stringify({
        id: saved.id,
        name: saved.name,
        bytes: saved.bytes,
        mediaType: event.mediaType,
        width: event.width,
        height: event.height,
        ...(event.fileName ? { fileName: event.fileName } : {}),
        ...(event.sourcePath ? { sourcePath: event.sourcePath } : {}),
      }),
      created_at: Date.now(),
    })
    this.scheduleImagePrune()
  }

  /**
   * Removes agent images past the budget or age limit (agent-image-retention.ts). Run at startup and a while after
   * an image is saved; passes never overlap. Never throws.
   */
  pruneAgentImages(now = Date.now()): Promise<{ removed: number; freedBytes: number; keptBytes: number } | null> {
    const pass = this.imagePrune.then(async () => {
      try {
        const scopes = this.store.listAgentImageScopes().map((scope) => ({ ...scope, cwd: scope.cwd || WORKSPACE_ROOT }))
        const result = await pruneAgentImages(scopes, (sessionId, id) => this.store.findAgentImageCreatedAt(sessionId, id), now, this.imageRetention)
        if (result.removed > 0) {
          console.log(`rudderd: removed ${result.removed} old agent image(s), ${Math.round(result.freedBytes / 1024 / 1024)} MB; ${Math.round(result.keptBytes / 1024 / 1024)} MB kept`)
        }
        return result
      } catch (error) {
        console.warn("rudderd: pruning agent images failed:", error)
        return null
      }
    })
    this.imagePrune = pass
    return pass
  }

  private scheduleImagePrune() {
    if (this.imagePruneTimer || this.shuttingDown) return
    this.imagePruneTimer = setTimeout(() => {
      this.imagePruneTimer = null
      void this.pruneAgentImages()
    }, this.imageRetention.afterWriteDelayMs)
    this.imagePruneTimer.unref?.()
  }

  /** Bytes for `GET /v1/sessions/:id/attachments/:attachmentId`. Null when the session or id is unknown. */
  async readAttachment(sessionId: string, attachmentId: string): Promise<{ data: Uint8Array; mediaType: string } | null> {
    const session = this.store.getSession(sessionId)
    if (!session) return null
    const cwd = session.cwd || WORKSPACE_ROOT
    const found = await findAttachment(cwd, sessionId, attachmentId)
    if (!found) return null
    const data = await readPlainFile(found.path, ATTACHMENT_LIMIT_BYTES, [attachmentDir(cwd, sessionId)], true)
    return { data, mediaType: sniffImage(data)?.mediaType ?? "application/octet-stream" }
  }

  /** Bytes for `GET /v1/sessions/:id/turns/:turnId/preview?path=&side=`. Null when there is no such picture. */
  async readTurnPreview(sessionId: string, turnId: string, path: string, side: string): Promise<{ data: Uint8Array; mediaType: string } | null> {
    if (side !== "before" && side !== "after") return null
    await this.turnSettled(sessionId)
    const changes = this.store.getTurnChanges(turnId)
    if (!changes || changes.sessionId !== sessionId) return null
    return snapshotImage(changes, path, side, this.hooks.workspaceRoot ?? WORKSPACE_ROOT)
  }

  private stream(sessionId: string): SessionStream {
    let stream = this.streams.get(sessionId)
    if (!stream) {
      stream = { blocks: new Map(), lastFlush: 0, lastPersist: Date.now(), timer: null, persistTimer: null }
      this.streams.set(sessionId, stream)
    }
    return stream
  }

  private streamText(sessionId: string, id: string, text: string, notice: boolean, copy?: PhoneCopy, replyChoices?: string[], phase?: "commentary" | "final") {
    const stream = this.stream(sessionId)
    const block = stream.blocks.get(id)
    if (block) {
      if (block.dropped || (block.text === text && (!phase || block.phase === phase) && (!replyChoices || block.replyChoices?.join("\u0000") === replyChoices.join("\u0000")))) return
      block.text = text
      if (phase) block.phase = phase
      if (replyChoices) block.replyChoices = replyChoices
      block.dirty = true
    } else {
      stream.blocks.set(id, { id, kind: "text", text, notice, ...(phase ? { phase } : {}), ...(copy ? { copy } : {}), ...(replyChoices ? { replyChoices } : {}), createdAt: Date.now(), dirty: true })
    }
    this.scheduleFlush(sessionId)
  }

  // Empty text never creates a block. startedAt is set once; endedAt on the first done.
  // The stored row is read once per block, never per delta. `began` is the adapter's start signal
  // (earlier than the first text); a value ahead of our clock is clamped to now.
  private streamReasoning(sessionId: string, id: string, text: string, done: boolean, began?: number): StreamBlock | undefined {
    const stream = this.stream(sessionId)
    const now = Date.now()
    let block = stream.blocks.get(id)
    if (block?.dropped) return undefined
    if (!block) {
      const existing = this.store.getMessage(id)
      const prior = existing?.kind === "reasoning" && existing.session_id === sessionId ? existing : null
      const previous = parseReasoning(prior?.payload ?? null)
      const body = text || prior?.text || ""
      if (!body) return undefined
      block = {
        id,
        kind: "reasoning",
        text: body,
        createdAt: prior?.created_at ?? now,
        startedAt: previous?.startedAt ?? Math.min(began ?? now, now),
        endedAt: previous?.endedAt,
        dirty: true,
      }
      stream.blocks.set(id, block)
    } else if (text && text !== block.text) {
      block.text = text
      block.dirty = true
    }
    if (done && block.endedAt === undefined) {
      block.endedAt = now
      block.dirty = true
    }
    if (done) this.flushStream(sessionId)
    else this.scheduleFlush(sessionId)
    return block
  }

  // Leading edge: a delta after a quiet period goes out at once; the rest wait for the timer.
  private scheduleFlush(sessionId: string) {
    const stream = this.streams.get(sessionId)
    if (!stream) return
    const wait = stream.lastFlush + STREAM_FLUSH_MS - Date.now()
    if (wait <= 0) return this.flushStream(sessionId, "tick")
    if (stream.timer) return
    stream.timer = setTimeout(() => {
      stream.timer = null
      if (this.streams.get(sessionId) === stream) this.flushStream(sessionId, "tick")
    }, wait)
  }

  /** Writes back every block that was broadcast but not stored yet, or stored without its rev, in every session. */
  private persistStreams() {
    for (const sessionId of this.streams.keys()) this.persistStream(sessionId)
  }

  /** Writes back what one session's stream broadcast but has not stored yet (or stored without its rev). */
  private persistStream(sessionId: string) {
    const stream = this.streams.get(sessionId)
    if (stream && [...stream.blocks.values()].some((block) => block.dirty || block.unsaved || block.quiet)) this.flushStream(sessionId)
  }

  // Runs before anything else is written or broadcast for the session, so clients see blocks in order.
  // `tick` is the streaming flush: it broadcasts, and writes back only what is new, moves the preview, or is a write-back
  // interval old. `timer` writes back whatever is still unsaved. Both write quietly (no rev, no session version): the
  // sockets already have the text. `settle` (the default: a block ending, the turn ending, any request, shutdown)
  // writes everything and gives every quietly written block its one rev, sent in a frame like any other.
  private flushStream(sessionId: string, mode: "tick" | "timer" | "settle" = "settle") {
    const stream = this.streams.get(sessionId)
    if (!stream) return
    if (stream.timer) {
      clearTimeout(stream.timer)
      stream.timer = null
    }
    if (stream.persistTimer) {
      clearTimeout(stream.persistTimer)
      stream.persistTimer = null
    }
    const now = Date.now()
    const blocks = [...stream.blocks.values()].filter((block) => !block.dropped)
    const dirty = blocks.filter((block) => block.dirty)
    const quiet = mode !== "settle"
    const interval = persistInterval(blocks)
    const due = mode !== "tick" || now - stream.lastPersist >= interval
    const saving = blocks.filter(
      (block) =>
        (block.dirty || block.unsaved) &&
        (due || !block.row || (block.kind === "text" && !block.notice && previewText(block.text) !== block.preview)),
    )
    // Stored quietly and unchanged since: only the rev is owed.
    const settling = quiet ? [] : blocks.filter((block) => block.quiet && !block.dirty && !block.unsaved)
    if (dirty.length === 0 && saving.length === 0 && settling.length === 0) return
    if (dirty.length > 0) stream.lastFlush = now
    if (due) stream.lastPersist = now
    const saved = new Set<StreamBlock>()
    // Blocks that took a new rev with no new text: they still go out once, so the phone's cursor can pass that rev.
    const revOnly: StreamBlock[] = []
    // Never throws: this also runs from a timer, where an exception would take the daemon down.
    this.store.transaction(() => {
      for (const block of saving) {
        const before = block.row?.rev
        try {
          block.row = this.store.insertMessage(
            {
              id: block.id,
              session_id: sessionId,
              kind: block.kind,
              role: "assistant",
              text: block.text,
              payload: streamPayload(block),
              created_at: block.createdAt,
            },
            { quiet },
          )
          block.unsaved = false
          block.quiet = quiet
          saved.add(block)
          if (!block.dirty && before !== undefined && block.row.rev !== before) revOnly.push(block)
        } catch (error) {
          // An id owned by another session: drop the block rather than overwrite that session.
          block.dropped = true
          console.error(`rudderd: dropped streamed block ${block.id} for session ${sessionId}: ${String(error)}`)
        }
      }
      for (const block of settling) {
        block.quiet = false
        const rev = this.store.settleMessage(block.id)
        if (rev === null || !block.row) continue
        block.row = { ...block.row, rev }
        revOnly.push(block)
      }
    })
    const written: { block: StreamBlock; row: MessageRow }[] = []
    for (const block of dirty) {
      block.dirty = false
      if (block.dropped || !block.row) continue
      if (!saved.has(block)) {
        block.row = { ...block.row, text: block.text, payload: streamPayload(block) }
        block.unsaved = true
      }
      written.push({ block, row: block.row })
    }
    if (blocks.some((block) => block.unsaved && !block.dropped)) {
      stream.persistTimer = setTimeout(
        () => {
          stream.persistTimer = null
          if (this.streams.get(sessionId) === stream) this.flushStream(sessionId, "timer")
        },
        Math.max(0, stream.lastPersist + interval - now),
      )
    }
    for (const block of revOnly) {
      if (!block.dropped && block.row && !block.dirty) this.broadcastBlock(block, block.row)
    }
    let previewMoved = false
    for (const { block, row } of written) {
      this.broadcastBlock(block, row)
      if (block.kind !== "text" || block.notice) continue
      const preview = previewText(row.text)
      if (preview && preview !== block.preview) {
        block.preview = preview
        previewMoved = true
      }
    }
    // The list shows the reply's opening words as they stream in. A thinking block is not a preview,
    // but it is still a bubble the unread count has to include, once.
    const freshThoughts = written.filter((item) => item.block.kind === "reasoning" && !item.block.counted)
    for (const item of freshThoughts) item.block.counted = true
    if (previewMoved || freshThoughts.length > 0) this.notifySession(sessionId)
    // A streamed row is a new assistant row too, the same signal appendMessage uses for steer reads.
    const freshRows = written.filter((item) => !item.block.notice && !item.block.steerChecked)
    for (const item of freshRows) item.block.steerChecked = true
    if (freshRows.length > 0) this.markSteerRead(sessionId)
  }

  // Every socket gets the full row; delta sockets get only the appended text when the block grew at its end. Nothing
  // re-sends the whole text on a schedule (2026-11-12, plan perf-1112 R4): the phone checks each delta's offset against
  // the text it holds and reads the chat again on a mismatch, so a periodic full frame corrected nothing and cost a
  // 1 MB reply 57 MB per phone. A full frame still goes out when the block did not grow at its end (a rewrite, a
  // reasoning block ending, a split surrogate), since a delta carries only text and rev.
  private broadcastBlock(block: StreamBlock, row: MessageRow) {
    const full = eventFrame("message.append", messagePublic(row))
    const sent = block.sentText
    const appended =
      sent !== undefined &&
      block.endedAt === block.sentEndedAt &&
      // Equal length is a write that only took a rev: an empty delta carries it.
      row.text.length >= sent.length &&
      row.text.startsWith(sent) &&
      !endsInHighSurrogate(sent)
    block.sentText = row.text
    block.sentEndedAt = block.endedAt
    if (!appended) return this.broadcast(full)
    const delta = eventFrame("message.delta", {
      sessionId: row.session_id,
      id: row.id,
      seq: row.seq,
      rev: row.rev ?? 0,
      // UTF-16 code units, the unit of both JS and Swift's utf16 view.
      offset: sent.length,
      append: row.text.slice(sent.length),
    })
    this.broadcast(full, delta)
  }

  // The settling flush gives each block its final rev, sent as an (often empty) delta: the turn's end re-sends no text.
  private dropStream(sessionId: string) {
    this.flushStream(sessionId)
    const stream = this.streams.get(sessionId)
    if (stream?.timer) clearTimeout(stream.timer)
    if (stream?.persistTimer) clearTimeout(stream.persistTimer)
    this.streams.delete(sessionId)
  }

  private appendMessage(row: Omit<MessageRow, "seq" | "payload"> & { seq?: number; payload?: string | null }) {
    this.flushStream(row.session_id)
    const stored = this.store.insertMessage(row)
    this.broadcast(eventFrame("message.append", messagePublic(stored)))
    // Every new row counts, not only the final prose. Updates of an existing row do not move last_seq;
    // the extra upsert just keeps the badge in step.
    this.notifySession(stored.session_id)
    if (stored.role === "assistant" && stored.kind !== "error") this.markSteerRead(stored.session_id)
    return stored
  }

  /** The next assistant row means the live turn has read the newest steered line still marked sent. */
  private markSteerRead(sessionId: string) {
    const pendingId = this.pendingSteer.has(sessionId)
      ? (this.pendingSteer.get(sessionId) ?? null)
      : this.store.latestSentSteer(sessionId)
    if (!pendingId) {
      this.pendingSteer.set(sessionId, null)
      return
    }
    const pending = this.store.getMessage(pendingId)
    if (!pending || pending.session_id !== sessionId || parseSteer(pending.payload)?.state !== "sent") {
      const next = this.store.latestSentSteer(sessionId)
      this.pendingSteer.set(sessionId, next)
      if (!next || next === pendingId) return
      this.markSteerRead(sessionId)
      return
    }
    const stored = this.store.insertMessage({
      ...pending,
      payload: JSON.stringify({ steer: "read", readAt: Date.now(), ...(parseSteer(pending.payload)?.waiting ? { steerWaiting: true } : {}) }),
    })
    this.broadcast(eventFrame("message.append", messagePublic(stored)))
    this.pendingSteer.set(sessionId, this.store.latestSentSteer(sessionId))
  }

  // copy: the text as a code the phone words in its own language; `text` is what older phones show.
  private appendError(sessionId: string, text: string, info?: AgentErrorInfo, copy?: PhoneCopy) {
    this.appendMessage({
      id: crypto.randomUUID(),
      session_id: sessionId,
      kind: "error",
      role: "assistant",
      text,
      payload: info || copy ? JSON.stringify({ ...(info ? { error: info } : {}), ...(copy ? { copy } : {}) }) : null,
      created_at: Date.now(),
    })
  }

  /** r48: the card a failed turn gets. A usage limit without its reset time takes the agent's rejected window. */
  private async agentErrorInfo(sessionId: string, error: unknown, detail: string): Promise<AgentErrorInfo | undefined> {
    const agent = this.store.getSession(sessionId)?.agent ?? ""
    const info = error instanceof AgentError ? error.info : classifyAgentFailure(agent, detail)
    if (info?.code !== "usage_limit" || info.resetsAt !== undefined) return info
    const quota = await this.adapters
      .get(agent)
      ?.limits?.()
      .catch(() => undefined)
    const now = Date.now()
    const resets = (quota?.windows ?? [])
      .filter((window) => window.status === "rejected" || (window.usedPercent ?? 0) >= 100)
      .flatMap((window) => (window.resetsAt !== undefined && window.resetsAt > now ? [window.resetsAt] : []))
    return resets.length > 0 ? { code: "usage_limit", resetsAt: Math.min(...resets) } : info
  }

  /**
   * v112 fallbacks ②–③: the first message names a session still under the phone's placeholder. A slash command names
   * it after the command (each phone words it, `title_command`) and leaves it open, so the first ordinary message
   * names it after all; a later command does not. The agent's own title (①, `retitleFromAgent`) may still replace
   * either; a user's name is never replaced.
   */
  private nameFromMessage(session: SessionRow, text: string) {
    const placeholder = session.auto_title === AUTO_TITLE_PLACEHOLDER || DEFAULT_TITLES.has(session.title) || session.title.startsWith("Demo")
    const name = commandName(text)
    let renamed: SessionRow | null = null
    if (name && placeholder) renamed = this.store.setAutoTitle(session.id, commandTitle(name), AUTO_TITLE_COMMAND, name)
    else if (!name && (placeholder || session.auto_title === AUTO_TITLE_COMMAND)) renamed = this.store.setAutoTitle(session.id, titleFromMessage(text), AUTO_TITLE_MESSAGE)
    if (renamed) this.broadcast(eventFrame("session.upsert", this.publicSession(renamed.id)))
  }

  /** v112 ①: the agent named the session (an ACP `session_info_update`, a Codex thread name). */
  private retitleFromAgent(sessionId: string, title: string) {
    const session = this.store.getSession(sessionId)
    const short = shortTitle(title)
    if (!session || !short || !agentMayRetitle(session.auto_title) || session.title === short) return
    const renamed = this.store.setAutoTitle(sessionId, short, AUTO_TITLE_AGENT)
    if (renamed) this.broadcast(eventFrame("session.upsert", this.publicSession(renamed.id)))
  }

  /** A tool that starts becomes the step (edit and execute say what; other kinds clear it); its end clears it. */
  private toolStep(sessionId: string, event: { id: string; kind: ToolKind; status: ToolStatus; detail: string; diffs?: ToolDiff[] }) {
    if (event.status !== "pending" && event.status !== "running") {
      this.endStep(sessionId, event.id)
      return
    }
    if (this.steps.get(sessionId)?.id === event.id) return
    const step = stepFor(event)
    if (step) this.setStep(sessionId, event.id, step)
    else if (this.steps.delete(sessionId)) this.notifySession(sessionId)
  }

  private setStep(sessionId: string, id: string, step: SessionStep) {
    const current = this.steps.get(sessionId)
    if (current?.id === id && current.step.kind === step.kind && current.step.text === step.text) return
    this.steps.set(sessionId, { id, step })
    this.notifySession(sessionId)
  }

  private endStep(sessionId: string, id: string) {
    if (this.steps.get(sessionId)?.id !== id) return
    this.steps.delete(sessionId)
    this.notifySession(sessionId)
  }

  private emitStatus(sessionId: string, status: "running" | "idle" | "waiting", options?: { holdLive?: boolean }) {
    if (status === "waiting") this.emitTurn(sessionId, "waiting")
    else if (status === "running" && this.latestTurns.get(sessionId)?.phase === "waiting") this.emitTurn(sessionId, "running")
    // The phone hears the status even when the db write fails; a stored status is only read back after a restart.
    try {
      this.flushStream(sessionId)
      const updated = this.store.patchSession(sessionId, { status })
      if (updated) this.broadcast(eventFrame("session.upsert", this.publicSession(updated.id)))
    } catch (error) {
      console.warn(`rudderd: storing ${sessionId}'s status ${status} failed:`, error)
    }
    this.broadcast(eventFrame("agent.status", { sessionId, status }))
    if (options?.holdLive) return
    this.liveStatus(sessionId, status)
  }

  /** The Live Activity and the per-computer card; a turn's end carries its outcome and changes. */
  private liveStatus(sessionId: string, status: "running" | "idle" | "waiting", end?: LiveTurnEnd, changes?: TurnOutcome["changes"]) {
    this.hooks.live?.status(sessionId, status, end)
    this.hooks.card?.status(sessionId, status, end && changes ? { ...end, changes } : end)
  }

  private emitTurn(sessionId: string, phase: TurnPhase) {
    const current = this.latestTurns.get(sessionId)
    if (!current || current.phase === phase) return
    const next = this.store.advanceTurn(current.id, phase)
    if (!next || next.revision === current.revision) return
    this.latestTurns.set(sessionId, next)
    this.broadcast(eventFrame("turn.state", { sessionId, turn: turnPublic(next) }))
  }

  private requireLive(): LiveActivityNotifier {
    if (!this.hooks.live) throw Object.assign(new Error("live activities are off"), { code: "failed" })
    return this.hooks.live
  }

  /**
   * The newest assistant reply, for a turn's done outcome and push. Called while a turn ends: a failed db read is
   * logged and answers nothing, or the session would stay generating, busy to every send.
   */
  private assistantSentence(sessionId: string): string | undefined {
    let before: number | undefined
    try {
      for (;;) {
        const rows = this.store.assistantTexts(sessionId, before, 32)
        if (rows.length === 0) return undefined
        for (const row of rows) {
          const sentence = row.text.trim()
          if (sentence) return sentence
        }
        const oldest = rows[rows.length - 1]
        if (!oldest || rows.length < 32) return undefined
        before = oldest.seq
      }
    } catch (error) {
      console.warn(`rudderd: reading ${sessionId}'s last reply failed:`, error)
      return undefined
    }
  }

  private notifySession(sessionId: string) {
    const session = this.publicSession(sessionId)
    if (session) this.broadcast(eventFrame("session.upsert", session))
  }
}

const STEP_CHARS = 80

/** edit: the file's name; execute: the command's first line; any other kind has no step word. */
export function stepFor(event: { kind: ToolKind; detail: string; diffs?: ToolDiff[] }): SessionStep | null {
  const clip = (text: string) => {
    const chars = Array.from(text.trim())
    return chars.length <= STEP_CHARS ? chars.join("") : `${chars.slice(0, STEP_CHARS - 1).join("")}…`
  }
  if (event.kind === "edit") {
    const path = event.diffs?.[0]?.path || event.detail.split("\n")[0] || ""
    const name = path.replace(/[/\\]+$/, "").split(/[/\\]/).pop() ?? ""
    return name ? { kind: "edit", text: clip(name) } : { kind: "edit" }
  }
  if (event.kind === "execute") {
    const command = event.detail.split("\n")[0] ?? ""
    return command.trim() ? { kind: "execute", text: clip(command) } : { kind: "execute" }
  }
  return null
}

function endsInHighSurrogate(text: string): boolean {
  const last = text.charCodeAt(text.length - 1)
  return last >= 0xd800 && last <= 0xdbff
}

function isAdapter(value: AdapterRegistry | AgentAdapter): value is AgentAdapter {
  return typeof (value as AgentAdapter).reply === "function"
}

export function pickPermissionOption(options: PermissionOption[], params: Record<string, unknown>): PermissionOption | undefined {
  if (typeof params.optionId === "string") return options.find((option) => option.id === params.optionId)
  // A bare allow / reject (lock screen, Live Activity, notification actions) means this time only. Grok lists
  // allow_always first, so a prefix match turned 「允许」 into a standing rule. No once option: no answer.
  if (typeof params.allow === "boolean") {
    const kind = params.allow ? "allow_once" : "reject_once"
    return options.find((option) => option.kind === kind)
  }
  return undefined
}

function readAnswers(params: Record<string, unknown>, firstKey: string): QuestionAnswers | undefined {
  const raw = params.answers
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const answers: QuestionAnswers = {}
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === "string") answers[key] = value
      else if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) answers[key] = value
      else return undefined
    }
    return answers
  }
  if (typeof params.answer === "string") return { [firstKey]: params.answer }
  return undefined
}

/** A question with allowsOther false takes only its option labels. Rows from older payloads (no field) allow anything. */
function answersFitOptions(questions: QuestionItem[], answers: QuestionAnswers): boolean {
  return questions.every((item) => {
    if (item.allowsOther !== false) return true
    const value = answers[item.question]
    if (value === undefined) return true
    const labels = new Set(item.options.map((option) => option.label))
    return (Array.isArray(value) ? value : [value]).every((entry) => labels.has(entry))
  })
}

/** What the lock screen needs to lay out the notice; options only when they become buttons (one single-choice, ≤ 3). */
function pushQuestion(questions: QuestionItem[]): PushQuestion {
  const first = questions[0]
  const multiSelect = questions.some((item) => item.multiSelect)
  const optionCount = first?.options.length ?? 0
  const buttons = questions.length === 1 && !multiSelect && optionCount <= 3
  return {
    count: questions.length,
    question: first?.question ?? "",
    headers: questions.map((item) => item.header ?? ""),
    multiSelect,
    optionCount,
    ...(buttons && first ? { options: first.options.map((option) => ({ ...option })) } : {}),
    allowsOther: first?.allowsOther !== false,
  }
}

function formatAnswer(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join(", ") : value ?? ""
}

function readUsageQuery(params: Record<string, unknown>): UsageQuery {
  const invalid = (message: string) => Object.assign(new Error(message), { code: "invalid" })
  const time = (key: "from" | "to") => {
    const value = params[key]
    if (value === undefined || value === null) return undefined
    if (typeof value !== "number" || !Number.isFinite(value)) throw invalid(`${key} must be a time in ms`)
    return value
  }
  const from = time("from")
  const to = time("to")
  if (from !== undefined && to !== undefined && from > to) throw invalid("from must not be after to")
  const bucket = params.bucket ?? "day"
  if (bucket !== "day" && bucket !== "none") throw invalid(`bucket must be "day" or "none"`)
  const tz = params.tz ?? 0
  if (typeof tz !== "number" || !Number.isInteger(tz) || Math.abs(tz) > MAX_TZ_MINUTES) {
    throw invalid(`tz must be whole minutes within ±${MAX_TZ_MINUTES}`)
  }
  return { from, to, bucket, tz }
}

/** r75: `variant` of `file.*`; anything but "screen" is the original. */
function fileVariant(value: unknown): FileVariant {
  return value === "screen" ? "screen" : "original"
}

function optionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** `liveActivity.register`: the app language a phone reports, the full tag (`language`) before the zh / en pair. */
function reportedLanguage(params: Record<string, unknown>): string {
  if (typeof params.language === "string" && params.language) return params.language
  return typeof params.locale === "string" ? params.locale : "zh"
}
