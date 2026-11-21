import { readCodexDiagnostics } from "./diagnostics"
import { openExternalUrl } from "../platform/open-url"
import { urlElicitation } from "./url-elicitation"
import { existsSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import { ATTACHMENT_LIMIT_BYTES, readPlainFile, safeName } from "../attachments"
import { withCarryOver } from "../carry-over"
import { codexCommands } from "../commands"
import { bytesFromImageResult, sniffImage } from "../image-bytes"
import { AgentError, type AgentErrorInfo, loginCommand } from "./agent-error"
import { type PhoneCopy, phoneCopy } from "../phone-copy"
import { codexTurnInput } from "./images"
import { distinctTexts, elicitForm, formQuestions } from "./elicitation"
import { arr, errorMessage, isObject, obj, str } from "./json"
import { NO_REPLY, RpcError, spawnRpc, type Rpc, type RpcId } from "./jsonrpc"
import { HandoffUnsupported, unavailable, unlessAborted } from "./types"
import type {
  AdapterContext,
  AgentAdapter,
  AgentCommand,
  AgentEvent,
  AgentModel,
  AgentQuota,
  AgentSpec,
  ContinuationOffer,
  ExternalSession,
  HistoryEntry,
  PermissionOption,
  PermissionRequest,
  QuestionItem,
  RudderPermissionMode,
  ToolDiff,
  QuotaWindow,
  ToolStatus,
  TurnUsage,
} from "./types"
import { callMatch } from "../v32"
import type { TurnExecutionIdentity } from "../turn-termination"

// A subagent's words in a continuation prompt: enough to act on, not a whole transcript (T3 Code keeps 1,000).
const CHILD_WAKE_CHARS = 1_000

// `codex app-server` JSON-RPC adapter. Mapping: the agent protocol notes.
export type CodexAdapterOptions = {
  openUrl?: (url: string) => Promise<void>
  spec: AgentSpec
  command?: string[]
  // How long turn/interrupt may go unanswered before the adapter asks the thread's state (thread/read).
  interruptGraceMs?: number
  // A thread with no turn this long is unsubscribed (CODEX_THREAD_IDLE_MS).
  threadIdleMs?: number
  // Read at app-server launch (`$CODEX_HOME/auth.json`). A newer file means this process still holds the
  // previous ChatGPT refresh token, which OpenAI has already revoked.
  credentialFile?: string
  // Session handoff: pids holding each thread's writer lock (`$CODEX_HOME/thread-writer-locks/<id>.lock`). Every
  // process that loads a thread holds its lock open; one that is not this adapter's app-server has it loaded
  // elsewhere. Default: `lsof` on the lock files that exist.
  lockHolders?: (threadIds: string[]) => Promise<Map<string, number[]>>
  // Model id → catalog context window. The turn's `modelContextWindow` is that window times
  // `effective_context_window_percent` (95 → 272000 reports 258400). Absent: keep the reported number.
  catalogWindow?: (model: string) => number | undefined
}

type CommandAction = { type: string; command: string }
type FileUpdateChange = { path: string; kind?: { type?: string; move_path?: string | null }; diff: string }
type ThreadItem = {
  type: string
  id: string
  text?: string
  phase?: "commentary" | "final_answer"
  delivery?: string | null
  questions?: { title: string; options: string[] | null }[] | null
  summary?: string[]
  content?: string[]
  status?: string
  command?: string
  commandActions?: CommandAction[] | null
  aggregatedOutput?: string | null
  exitCode?: number | null
  changes?: FileUpdateChange[]
  // collabAgentToolCall (tool "spawnAgent"): the subagent threads it started.
  receiverThreadIds?: string[]
  prompt?: string | null
  // Per receiver thread: its state and, once it has spoken, its last message.
  agentsStates?: Record<string, { status?: string; message?: string | null } | undefined>
  server?: string
  tool?: string
  arguments?: unknown
  // Tool calls use `{content}`. imageGeneration uses a base64 string or a data URL. An object is never pixels.
  result?: string | { content?: { type?: string; text?: string }[] } | null
  savedPath?: string | null
  fileId?: string | null
  error?: { message?: string } | null
  contentItems?: { type: string; text?: string }[] | null
  success?: boolean | null
  query?: string
  path?: string
  // thread/items/list (history): when the item started and finished, ms.
  startedAtMs?: number | null
  completedAtMs?: number | null
}
type TokenBreakdown = {
  totalTokens: number
  inputTokens: number
  cachedInputTokens: number
  cacheWriteInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
}
// codexErrorInfo: a string ("usageLimitExceeded", "unauthorized") or a one-key object for variants with fields.
type CodexError = { message?: string; codexErrorInfo?: unknown }
type Turn = { id: string; status: string; items?: ThreadItem[]; itemsView?: "notLoaded" | "summary" | "full"; error?: CodexError | null }
type ModelPage = {
  data: {
    id: string
    displayName?: string
    description?: string | null
    isDefault?: boolean
    hidden?: boolean
    supportedReasoningEfforts?: { reasoningEffort: string }[]
    defaultReasoningEffort?: string | null
    serviceTiers?: { id: string; name?: string; description?: string }[]
    defaultServiceTier?: string | null
  }[]
  nextCursor: string | null
}
// Loose view over notification / server-request params; fields per schema-ts v2.
type Params = {
  threadId?: string
  turnId?: string
  itemId?: string
  item?: ThreadItem
  delta?: string
  summaryIndex?: number
  contentIndex?: number
  turn?: Turn
  tokenUsage?: { total?: TokenBreakdown; last?: TokenBreakdown; modelContextWindow?: number | null }
  requestId?: RpcId
  plan?: { step: string; status: string }[]
  error?: CodexError
  willRetry?: boolean
  command?: string | null
  cwd?: string | null
  commandActions?: CommandAction[] | null
  reason?: string | null
  availableDecisions?: unknown[]
  // item/tool/requestUserInput and mcpServer/elicitation/request (plan 2026-11-17-agent-questions).
  questions?: unknown[]
  serverName?: string
  mode?: string
  message?: string
  requestedSchema?: unknown
  url?: string
  elicitationId?: string
  // thread/name/updated
  threadName?: string | null
  _meta?: unknown
  // thread/status/changed: idle | active{activeFlags} | notLoaded | systemError.
  status?: { type?: unknown }
}
type ToolEvent = Extract<AgentEvent, { type: "tool" }>

const REQUEST_TIMEOUT_MS = 120_000
const INITIALIZE_TIMEOUT_MS = 20_000
const CLIENT_INFO = { name: "rudder", title: "Rudder", version: "0.1.0" }
// perf-1112 round two (R6): the last three carry a running turn's whole diff and every output chunk, none of which the
// adapter reads (tool cards take aggregatedOutput and the item's final changes).
const OPT_OUT_NOTIFICATIONS = [
  "mcpServer/startupStatus/updated",
  "remoteControl/status/changed",
  "hook/started",
  "hook/completed",
  "turn/diff/updated",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
]
// perf-1112 round two (R6): a loaded thread stays in app-server memory (history, MCP state) for as long as rudderd
// runs. One idle this long is unsubscribed (app-server 0.165 `thread/unsubscribe`), and the next turn resumes it.
export const CODEX_THREAD_IDLE_MS = 15 * 60_000
const APPROVAL_REQUESTS = new Set(["item/commandExecution/requestApproval", "item/fileChange/requestApproval"])

// Shapes as echoed back by thread/start for the matching SandboxMode (research fixtures).
const WORKSPACE_WRITE = { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
const READ_ONLY = { type: "readOnly", networkAccess: false }
const FULL_ACCESS = { type: "dangerFullAccess" }

type CodexPermission = { approvalPolicy: string; sandbox: string; sandboxPolicy: object }

// §6. Codex inherits ~/.codex/config.toml (the owner runs never + danger-full-access), so every field is always sent.
// Keys are the ids of modes.ts CODEX_MODES.
export const CODEX_PERMISSIONS: Record<string, CodexPermission> = {
  ask: { approvalPolicy: "untrusted", sandbox: "workspace-write", sandboxPolicy: WORKSPACE_WRITE },
  acceptEdits: { approvalPolicy: "on-request", sandbox: "workspace-write", sandboxPolicy: WORKSPACE_WRITE },
  plan: { approvalPolicy: "untrusted", sandbox: "read-only", sandboxPolicy: READ_ONLY },
  fullAccess: { approvalPolicy: "never", sandbox: "danger-full-access", sandboxPolicy: FULL_ACCESS },
}

// An id this table does not know falls back to asking, never to more access.
function codexPermission(mode: RudderPermissionMode): CodexPermission {
  return CODEX_PERMISSIONS[mode] ?? CODEX_PERMISSIONS.ask!
}

// Option ids are the wire decisions. Permanent-rule decisions (acceptWithExecpolicyAmendment, …) are never offered.
// "cancel" is reject_once: it creates no rule, it only also ends the turn; decline stays first so legacy {allow:false} continues.
// acceptForSession only covers the same command (Codex's session approval cache) or the same files, so the label
// names that instead of promising the whole session (the phone used to read 本会话总是允许).
export const CODEX_PERMISSION_OPTIONS: PermissionOption[] = [
  { id: "accept", label: "批准", kind: "allow_once" },
  { id: "acceptForSession", label: "本会话允许这条命令", kind: "allow_always" },
  { id: "decline", label: "拒绝", kind: "reject_once" },
  { id: "cancel", label: "拒绝并停止", kind: "reject_once" },
]

// An MCP tool approval (`codex_approval_kind: "mcp_tool_call"`). The session option is the daemon's own rule for the
// same tool (its `match`), so Codex's `persist` is not needed.
const MCP_APPROVAL_OPTIONS: PermissionOption[] = [
  { id: "accept", label: "批准", kind: "allow_once" },
  { id: "acceptForSession", label: "本会话允许这个工具", kind: "allow_always" },
  { id: "decline", label: "拒绝", kind: "reject_once" },
]
const ELICIT_CONFIRM_OPTIONS: PermissionOption[] = [
  { id: "accept", label: "批准", kind: "allow_once" },
  { id: "decline", label: "拒绝", kind: "reject_once" },
]
const ELICIT_DECLINE = { action: "decline", content: null, _meta: null }
const ELICIT_CANCEL = { action: "cancel", content: null, _meta: null }

/** request_user_input with every question unanswered (no turn, a stop). */
function emptyAnswers(params: Params) {
  return { answers: Object.fromEntries(arr(params.questions).filter(isObject).map((question) => [str(question.id), { answers: [] }])) }
}

export const CODEX_EDIT_PERMISSION_OPTIONS: PermissionOption[] = CODEX_PERMISSION_OPTIONS.map((option) =>
  option.id === "acceptForSession" ? { ...option, label: "本会话允许改这些文件" } : option,
)

// availableDecisions omits decisions the server still accepts, so it only reorders the ones it names.
export function codexPermissionOptions(available: unknown): PermissionOption[] {
  if (!Array.isArray(available)) return CODEX_PERMISSION_OPTIONS
  const rank = (option: PermissionOption) => available.indexOf(option.id)
  const named = CODEX_PERMISSION_OPTIONS.filter((option) => rank(option) >= 0).sort((a, b) => rank(a) - rank(b))
  return CODEX_PERMISSION_OPTIONS.map((option) => (rank(option) >= 0 ? named.shift()! : option))
}

// tool: the card this request is about, when it is one on the asking turn's own thread.
function approvalRequest(method: string, params: Params, tool?: ToolEvent): PermissionRequest {
  return method === "item/fileChange/requestApproval"
    ? {
        tool: "Edit",
        title: params.reason || "Edit files",
        detail: tool?.detail ?? "",
        kind: "edit",
        options: CODEX_EDIT_PERMISSION_OPTIONS,
        ...(tool?.diffs?.length ? { diffs: tool.diffs } : {}),
      }
    : {
        tool: "Shell",
        title: params.reason || "Run command",
        detail: commandText(params.command, params.commandActions),
        kind: "execute",
        options: codexPermissionOptions(params.availableDecisions),
        // The same command elsewhere is another call: an always-allow rule covers this directory only.
        match: callMatch("Shell", { command: params.command ?? null, cwd: params.cwd ?? null }),
      }
}

// The phone's choice as a wire decision; null (turn interrupted or ended) stops rather than lets the model carry on.
function approvalDecision(request: PermissionRequest, choice: string | null): string {
  return request.options.some((option) => option.id === choice) ? choice! : "cancel"
}

function eventId(threadId: string, itemId: string) {
  return `codex:${threadId}:${itemId}`
}

function textInput(text: string) {
  return codexTurnInput(text)
}

type ConnectionHandlers = {
  notification(conn: CodexConnection, method: string, params: Params): void
  request(conn: CodexConnection, method: string, params: Params, id: RpcId): Promise<unknown>
  exit(conn: CodexConnection, reason: string): void
}

// The last stderr line, without colour codes, explains most startup failures.
function lastStderrLine(tail: string) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI color codes, which start with ESC
  return (tail.replace(/\x1b\[[0-9;]*m/g, "").trim().split("\n").pop() ?? "").slice(-300)
}

// One `codex app-server` process (JSON-RPC 2.0 lines) plus the per-process thread state.
export class CodexConnection {
  configRoot?: string
  // Threads loaded in this process; anything else needs thread/resume.
  readonly loaded = new Set<string>()
  // Latest thread total per thread, to drop re-reported token usage.
  readonly totals = new Map<string, number>()
  private readonly rpc: Rpc

  constructor(command: string[], handlers: ConnectionHandlers) {
    try {
      this.rpc = spawnRpc(
        command,
        {
          onNotification: (method, params) => handlers.notification(this, method, (params ?? {}) as Params),
          // Every server request gets an answer (or the turn hangs), except ones the server already resolved.
          onRequest: (method, params, id) => handlers.request(this, method, (params ?? {}) as Params, id),
          onClose: (error) => handlers.exit(this, error.message),
        },
        { name: "codex app-server", defaultTimeoutMs: REQUEST_TIMEOUT_MS, formatStderr: lastStderrLine },
      )
    } catch (error) {
      throw new Error(`cannot start ${command.join(" ")}: ${errorMessage(error)}`)
    }
  }

  async initialize() {
    const response = await this.rpc.request(
      "initialize",
      {
        clientInfo: CLIENT_INFO,
        capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: OPT_OUT_NOTIFICATIONS },
      },
      INITIALIZE_TIMEOUT_MS,
    )
    this.configRoot = str(obj(response).codexHome) || undefined
    this.rpc.notify("initialized")
    return this
  }

  request<T>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    return this.rpc.request<T>(method, params, timeoutMs)
  }

  get pid(): number {
    return this.rpc.pid
  }

  get closed(): boolean {
    return this.rpc.closed
  }

  // Resolves once the process is gone, so the thread rollouts are free for other writers.
  dispose() {
    return this.rpc.close()
  }
}

function unsupported(method: string) {
  return new RpcError(method, -32601, `Rudder does not handle ${method}`)
}

function threadSettings(ctx: AdapterContext) {
  const policy = codexPermission(ctx.permissionMode)
  return {
    cwd: ctx.cwd,
    ...(ctx.permissionMode === "native" ? {} : { approvalPolicy: policy.approvalPolicy, approvalsReviewer: "user", sandbox: policy.sandbox }),
    ...(ctx.model ? { model: ctx.model } : {}),
  }
}

// turn/start overrides persist for later turns, so re-sending them each turn tracks per-session changes.
function turnSettings(ctx: AdapterContext) {
  const policy = codexPermission(ctx.permissionMode)
  return {
    cwd: ctx.cwd,
    ...(ctx.permissionMode === "native" ? {} : { approvalPolicy: policy.approvalPolicy, approvalsReviewer: "user", sandboxPolicy: policy.sandboxPolicy }),
    ...(ctx.model ? { model: ctx.model } : {}),
    ...(ctx.effort ? { effort: ctx.effort } : {}),
    // Overrides persist, so a later turn must resend the chosen tier. "default" is standard speed.
    ...(ctx.speed ? { serviceTier: ctx.speed } : {}),
    summary: "detailed",
  }
}

function publishedSpeeds(model: ModelPage["data"][number]): Pick<AgentModel, "speeds" | "defaultSpeed"> {
  const tiers = (model.serviceTiers ?? []).filter((tier) => tier.id && tier.id !== "default")
  if (!tiers.length) return {}
  return {
    speeds: [
      { id: "default", label: "Standard", description: "Standard speed" },
      ...tiers.map((tier) => ({
        id: tier.id,
        label: tier.name || tier.id,
        ...(tier.description ? { description: tier.description } : {}),
      })),
    ],
    defaultSpeed: model.defaultServiceTier || "default",
  }
}

function toolStatus(status: string | undefined, done: boolean): ToolStatus {
  if (status === "completed" || status === "failed" || status === "declined") return status
  if (status === "interrupted") return "cancelled"
  return done ? "completed" : "running"
}

function commandText(command: string | null | undefined, actions: CommandAction[] | null | undefined) {
  return actions?.length === 1 ? actions[0]!.command : (command ?? "")
}

function fileDiffs(changes: FileUpdateChange[] | undefined): ToolDiff[] {
  return (changes ?? []).map((change) => {
    // add carries the new file content; update a unified hunk.
    if (change.kind?.type === "add") return { path: change.path, newText: change.diff }
    if (change.kind?.type === "delete") return { path: change.path, oldText: change.diff }
    return { path: change.kind?.move_path ?? change.path, patch: change.diff }
  })
}

function joinText(parts: (string | undefined)[] | undefined) {
  return (parts ?? []).filter((part): part is string => Boolean(part)).join("\n")
}

function mcpResultText(result: ThreadItem["result"]): string {
  if (!result || typeof result === "string") return ""
  return joinText(result.content?.map((part) => part.text))
}

type LoadedImage = { name: string; mediaType: string; width: number; height: number; bytes: Uint8Array }

// Where Codex app-server saves generated images: `$CODEX_HOME/generated_images` (default `~/.codex`).
export function codexGeneratedImagesDir(): string {
  return join(process.env.CODEX_HOME || join(homedir(), ".codex"), "generated_images")
}

// A readable savedPath wins. A file that exists but is not an image, is over the cap, or is a symlink does not fall
// through to `result` — that would show a different picture than the one Codex saved. A missing path, or one outside
// the session folder and Codex's image folder (never read), does.
async function loadGeneratedImage(item: ThreadItem, cwd: string): Promise<LoadedImage | null> {
  if (item.status !== "completed") return null
  const saved = typeof item.savedPath === "string" ? item.savedPath : ""
  if (saved) {
    const fromFile = await readSavedImage(saved, [cwd, codexGeneratedImagesDir()])
    if (fromFile === "skip") return null
    if (fromFile) return fromFile
  }
  const decoded = bytesFromImageResult(item.result)
  if (!decoded) return null
  if (decoded.byteLength > ATTACHMENT_LIMIT_BYTES) {
    console.error(`rudderd: image over 50 MB (${decoded.byteLength} bytes); not shown`)
    return null
  }
  const sniffed = sniffImage(decoded)
  if (!sniffed) return null
  const ext = sniffed.mediaType === "image/jpeg" ? "jpg" : sniffed.mediaType.slice("image/".length)
  return { name: `image.${ext}`, ...sniffed, bytes: decoded }
}

async function readSavedImage(saved: string, roots: string[]): Promise<LoadedImage | "skip" | null> {
  let data: Uint8Array
  try {
    data = await readPlainFile(saved, ATTACHMENT_LIMIT_BYTES, roots)
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === "outside") console.error(`rudderd: image ${basename(saved)} is outside the session and Codex image folders; not read`)
    if (code === "not_found" || code === "outside") return null
    console.error(`rudderd: image ${basename(saved)} not shown: ${error instanceof Error ? error.message : String(error)}`)
    return "skip"
  }
  const sniffed = sniffImage(data)
  if (!sniffed) return "skip"
  return { name: safeName(basename(saved)), ...sniffed, bytes: data }
}

function toolEvent(threadId: string, item: ThreadItem, done: boolean): ToolEvent | undefined {
  const base = { type: "tool" as const, id: eventId(threadId, item.id), status: toolStatus(item.status, done) }
  switch (item.type) {
    case "commandExecution":
      return {
        ...base,
        tool: "Shell",
        title: "Run command",
        kind: "execute",
        detail: commandText(item.command, item.commandActions),
        // aggregatedOutput, not outputDelta: deltas drop the first chunk.
        ...(item.aggregatedOutput != null ? { output: item.aggregatedOutput } : {}),
        ...(item.exitCode != null ? { exitCode: item.exitCode } : {}),
      }
    case "fileChange":
      return {
        ...base,
        tool: "Edit",
        title: "Edit files",
        kind: "edit",
        detail: (item.changes ?? []).map((change) => change.path).join("\n"),
        diffs: fileDiffs(item.changes),
      }
    case "mcpToolCall": {
      const output = item.error?.message ?? mcpResultText(item.result)
      return {
        ...base,
        tool: `${item.server ?? "mcp"}.${item.tool ?? "tool"}`,
        title: item.tool ?? "MCP tool",
        kind: "other",
        detail: JSON.stringify(item.arguments ?? {}),
        ...(output ? { output } : {}),
      }
    }
    case "dynamicToolCall": {
      const output = joinText(item.contentItems?.map((part) => part.text))
      return {
        ...base,
        status: item.success === false ? "failed" : base.status,
        tool: item.tool ?? "tool",
        title: item.tool ?? "Tool",
        kind: "other",
        detail: JSON.stringify(item.arguments ?? {}),
        ...(output ? { output } : {}),
      }
    }
    case "collabAgentToolCall": {
      const output = joinText(Object.values(item.agentsStates ?? {}).map((state) => state?.message ?? undefined))
      const prompt = item.prompt ?? ""
      // spawnAgent reads as a subagent card on the phone, like Claude's Agent tool.
      return {
        ...base,
        tool: item.tool === "spawnAgent" ? "Agent" : (item.tool ?? "agent"),
        title: item.tool === "spawnAgent" ? prompt.split("\n")[0] || "Subagent" : (item.tool ?? "Agent"),
        kind: "other",
        detail: prompt,
        ...(output ? { output } : {}),
      }
    }
    case "webSearch":
      return { ...base, tool: "WebSearch", title: "Search the web", kind: "search", detail: item.query ?? "" }
    case "imageView":
      return { ...base, tool: "ImageView", title: "View image", kind: "read", detail: item.path ?? "" }
    default:
      return undefined
  }
}

/**
 * Session handoff (P2a): one `thread/items/list` item as history, mapped the way a live turn maps it (CodexTurn.item)
 * with the same ids, plus the user's own messages, which a live turn never emits (Rudder wrote them itself).
 */
export function codexHistoryEntries(threadId: string, item: ThreadItem): HistoryEntry[] {
  if (!item?.id || typeof item.type !== "string") return []
  const at = item.completedAtMs ?? item.startedAtMs
  const stamp = typeof at === "number" ? { at } : {}
  const id = eventId(threadId, item.id)
  switch (item.type) {
    case "userMessage": {
      const text = arr((item as { content?: unknown }).content)
        .map(obj)
        .filter((part) => part.type === "text")
        .map((part) => str(part.text))
        .join("\n")
        .trim()
      return text ? [{ type: "user", id, text, ...(typeof item.startedAtMs === "number" ? { at: item.startedAtMs } : {}) }] : []
    }
    case "agentMessage":
      if (!item.text) return []
      return [{ type: "text", id, text: item.text, ...(item.phase ? { phase: item.phase === "final_answer" ? "final" : item.phase } : {}), ...stamp }]
    case "reasoning": {
      const summary = (item.summary ?? []).filter(Boolean)
      const text = (summary.length ? summary : (item.content ?? []).filter(Boolean)).join("\n\n")
      if (!text) return []
      return [{ type: "reasoning", id, text, done: true, ...(typeof item.startedAtMs === "number" ? { startedAt: item.startedAtMs } : {}), ...stamp }]
    }
    case "contextCompaction":
      return [{ type: "compaction", id, state: "done", trigger: "auto", ...stamp }]
    default: {
      const tool = toolEvent(threadId, item, true)
      return tool ? [{ ...tool, ...stamp }] : []
    }
  }
}

/** Pids holding each thread's writer lock, from `lsof -F pn` on the lock files that exist. */
async function lsofLockHolders(threadIds: string[]): Promise<Map<string, number[]>> {
  const dir = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "thread-writer-locks")
  const files = threadIds.map((id) => join(dir, `${id}.lock`)).filter((path) => existsSync(path))
  const holders = new Map<string, number[]>()
  if (files.length === 0 || !Bun.which("lsof")) return holders
  const proc = Bun.spawn(["lsof", "-F", "pn", ...files], { stdout: "pipe", stderr: "ignore" })
  // lsof exits 1 when some file is open by nobody; its output still lists the others.
  const text = await new Response(proc.stdout).text()
  await proc.exited
  let pid = 0
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1))
    else if (line.startsWith("n") && pid > 0) {
      const name = basename(line.slice(1))
      if (!name.endsWith(".lock")) continue
      const threadId = name.slice(0, -".lock".length)
      holders.set(threadId, [...(holders.get(threadId) ?? []), pid])
    }
  }
  return holders
}

// handoff.list: thread/list pages of this size, at most this many; history reads page thread/items/list the same way.
const HANDOFF_PAGE = 50
const HANDOFF_PAGES = 5
const HISTORY_PAGE = 200
const HISTORY_PAGES = 500

type ListedThread = {
  id: string
  name?: string | null
  preview?: string | null
  cwd?: string
  updatedAt?: number
  originator?: string | null
}

// startedAt: when item/started opened this reasoning item (summaries arrive well after the model began thinking).
// text / textOf: the text last joined and the part list it came from, so a delta to its last part extends it.
type ReasoningState = {
  summary: string[]
  content: string[]
  emitted: boolean
  done: boolean
  startedAt?: number
  text?: string
  textOf?: string[]
}

// One user turn on one thread. Notifications are routed here by threadId.
class CodexTurn {
  turnId?: string
  finished = false

  /** The app-server already said turn/completed for this turn (`finished` waits for its images to land). */
  get ended(): boolean {
    return this.finished || this.nativeTerminal !== undefined || this.concluded !== undefined
  }
  private readonly buffered: [string, Params, string?][] = []
  private readonly texts = new Map<string, string>()
  // Subagent thread -> the spawnAgent item that started it, and that thread's latest message.
  private readonly spawnItems = new Map<string, ThreadItem>()
  private readonly childTexts = new Map<string, string>()
  private readonly childDone = new Set<string>()
  private nativeTerminal?: Turn
  private finalSnapshotKnown = false
  private readonly finalIds = new Set<string>()
  private readonly messagePhases = new Map<string, string>()
  private readonly imageIds = new Set<string>()
  private readonly completedItems = new Map<string, string>()
  private readonly reasoning = new Map<string, ReasoningState>()
  private readonly tools = new Map<string, ToolEvent>()
  private readonly withdraws = new Map<string, AbortController>()
  private usage?: TurnUsage
  // imageGeneration reads the file before it emits, so later items must not finish the turn first.
  private imageChain: Promise<void> = Promise.resolve()
  private lastError?: string
  private lastErrorInfo?: AgentErrorInfo
  private retries = 0
  private interruptTimer?: Timer
  // The thread's latest thread/status/changed (or thread/read) state: Codex's own word on whether it still runs
  // anything here. The turn settles on its turn/completed only once the thread is not active.
  private threadActive = false
  private statusKnown = false
  // This turn's turn/completed with its final items in, waiting for the thread to leave `active`.
  private completed?: Turn
  // turn/interrupt went unanswered past the grace: a thread that is not active ends the turn as interrupted.
  private interruptPending = false
  // What the turn settled with; nothing is adopted after it.
  private concluded?: Turn
  // A subagent's request still open when this turn closes goes back to the adapter (late approval path).
  private closing = false
  private settle!: (turn: Turn) => void
  private fail!: (error: Error) => void
  private readonly done = new Promise<Turn>((resolve, reject) => {
    this.settle = resolve
    this.fail = reject
  })
  private markStarted!: (turnId: string | undefined) => void
  readonly started = new Promise<string | undefined>((resolve) => {
    this.markStarted = resolve
  })

  constructor(
    readonly conn: CodexConnection,
    readonly threadId: string,
    private readonly ctx: AdapterContext,
    private readonly interruptGraceMs: number,
    private readonly catalogWindow?: (model: string) => number | undefined,
    // A subagent's approval this turn can no longer ask (it ended first): handed to the adapter's late path.
    private readonly orphan: (method: string, params: Params, requestId: RpcId) => Promise<unknown> = async () => ({ decision: "cancel" }),
    private readonly nativeModel?: string,
    private readonly nativeEffort?: string,
    private readonly openUrl: (url: string) => Promise<void> = openExternalUrl,
  ) {
    // abandon() can fire while run() is still awaiting turn/start or a resume; run() awaits `done` itself later.
    this.done.catch(() => {})
  }

  async run(text: string, reopen: () => Promise<void>) {
    let turn: Turn
    try {
      const model = this.ctx.model || this.nativeModel
      if (this.ctx.permissionMode === "plan" && !model) throw new Error("Codex did not report a model for native Plan mode; select a model and retry")
      const collaborationMode = model ? {
        mode: this.ctx.permissionMode === "plan" ? "plan" : "default",
        settings: { model, reasoning_effort: this.ctx.effort || this.nativeEffort || null, developer_instructions: null },
      } : undefined
      const params = { threadId: this.threadId, input: codexTurnInput(text, this.ctx.images ?? []), ...turnSettings(this.ctx), ...(collaborationMode ? { collaborationMode } : {}) }
      let started: { turn: Turn }
      try {
        started = await this.conn.request<{ turn: Turn }>("turn/start", params)
      } catch (error) {
        // The process may have unloaded the thread; resume once and retry.
        if (!(error instanceof RpcError && /thread not found/i.test(error.message))) throw error
        await reopen()
        started = await this.conn.request<{ turn: Turn }>("turn/start", params)
      }
      this.begin(started.turn.id)
      const interrupt = () => this.interrupt()
      if (this.ctx.signal.aborted) interrupt()
      else this.ctx.signal.addEventListener("abort", interrupt, { once: true })
      try {
        turn = await this.done
      } finally {
        this.ctx.signal.removeEventListener("abort", interrupt)
      }
    } finally {
      // The turn stays open until every completed image is emitted, including when the turn itself failed.
      await this.imageChain
      this.finished = true
      this.markStarted(undefined)
      clearTimeout(this.interruptTimer)
      this.closeOpen()
    }
    if (this.usage) this.ctx.emit({ type: "usage", usage: { ...this.usage } })
    if (turn.status === "interrupted" && this.texts.size === 0) {
      this.ctx.emit({ type: "text", id: eventId(this.threadId, `${turn.id}:cancelled`), text: "Cancelled.", notice: true })
    }
    this.ctx.emit({ type: "replyDisposition", value: this.finalIds.size ? "present" : this.imageIds.size ? "not_applicable" : !this.finalSnapshotKnown || [...this.texts.keys()].some(id => !this.messagePhases.has(id)) ? "unknown" : "absent",
      nativeMessageIds: [...this.finalIds] })
    if (turn.status === "failed") {
      const message = turn.error?.message || this.lastError || "Codex turn failed"
      const info = codexErrorInfo(turn.error) ?? this.lastErrorInfo
      throw info ? new AgentError(message, info) : new Error(message)
    }
    return turn.status === "interrupted" ? "interrupted" as const : "completed" as const
  }

  abandon(error: Error) {
    if (this.finished) return
    const turn = this.nativeTerminal
    if (turn) {
      this.ctx.emit({ type: "lifecycle", phase: "terminal", transport: "closed", pendingFinalization: true,
        terminalStatus: turn.status === "failed" ? "failed" : turn.status === "interrupted" ? "interrupted" : "completed" })
      // No idle will come from a closed transport: the breaker. A final-item read still in flight settles when it fails.
      this.threadActive = false
      this.check()
      return
    }
    this.ctx.emit({ type: "lifecycle", phase: "working", transport: "closed", pendingFinalization: false })
    this.fail(error)
  }

  private async readFinalItems(turn: Turn) {
    let cursor: string | undefined
    const visited = new Set<string>()
    try {
      do {
        const page = await this.conn.request<{ data: Array<{ turnId: string; item: ThreadItem }>; nextCursor: string | null }>(
          "thread/items/list", { threadId: this.threadId, turnId: turn.id, limit: 100, sortDirection: "asc", ...(cursor ? { cursor } : {}) }, 5_000)
        if (!page || !Array.isArray(page.data) || (page.nextCursor !== null && typeof page.nextCursor !== "string")) {
          throw new Error(`Invalid final item page for turn ${turn.id}`)
        }
        if (this.ctx.signal.aborted) return
        for (const entry of page.data) {
          if (entry.turnId !== turn.id) continue
          if (!entry.item || typeof entry.item.id !== "string" || typeof entry.item.type !== "string") throw new Error(`Invalid final item for turn ${turn.id}`)
          this.item(entry.item, true)
        }
        cursor = page.nextCursor ?? undefined
        if (cursor) {
          if (visited.has(cursor)) throw new Error(`Repeated final item cursor for turn ${turn.id}`)
          visited.add(cursor)
        }
      } while (cursor)
      this.finalSnapshotKnown = true
    } catch (error) {
      console.warn(`rudderd: final item read for ${turn.id} remains unknown:`, errorMessage(error))
    }
  }

  notify(method: string, params: Params) {
    if (!this.turnId) {
      this.buffered.push([method, params])
      return
    }
    if (method === "thread/tokenUsage/updated") return this.trackUsage(params)
    // v112 ①: the thread's own name becomes the session's title unless the user named it.
    if (method === "thread/name/updated") {
      const name = typeof params.threadName === "string" ? params.threadName.trim() : ""
      if (name) this.ctx.emit({ type: "title", title: name })
      return
    }
    if (method === "serverRequest/resolved") return this.withdraws.get(String(params.requestId))?.abort()
    if (method === "turn/completed") {
      if (params.turn?.id === this.turnId && !this.nativeTerminal) {
        const terminal = params.turn
        this.nativeTerminal = terminal
        this.finalSnapshotKnown = terminal.itemsView === "full" || (!terminal.itemsView && Boolean(terminal.items?.length))
        this.ctx.emit({ type: "lifecycle", phase: "terminal", pendingFinalization: true,
          terminalStatus: params.turn.status === "failed" ? "failed" : params.turn.status === "interrupted" ? "interrupted" : "completed" })
        for (const item of params.turn.items ?? []) this.item(item, true)
        if (terminal.status === "completed" && (terminal.itemsView === "notLoaded" || terminal.itemsView === "summary") && !this.ctx.signal.aborted) {
          void this.readFinalItems(terminal).then(() => this.complete(terminal), error => this.fail(error))
        } else this.complete(terminal)
      }
      return
    }
    if (method === "thread/status/changed") {
      const type = params.status?.type
      if (typeof type !== "string") return
      this.threadActive = type === "active"
      this.statusKnown = true
      return this.check()
    }
    if (method === "turn/started") return this.adopt(params.turn)
    if (params.turnId !== undefined && params.turnId !== this.turnId) return
    switch (method) {
      case "item/started":
      case "item/completed":
        return this.item(params.item, method === "item/completed")
      case "item/agentMessage/delta":
        if (params.itemId) this.setText(params.itemId, (this.texts.get(params.itemId) ?? "") + (params.delta ?? ""))
        return
      case "item/reasoning/summaryPartAdded":
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta": {
        if (!params.itemId || !params.delta) return
        const state = this.reasoningState(params.itemId)
        const parts = method === "item/reasoning/textDelta" ? state.content : state.summary
        const index = (method === "item/reasoning/textDelta" ? params.contentIndex : params.summaryIndex) ?? 0
        const grows = Boolean(parts[index]) && index === parts.length - 1
        parts[index] = (parts[index] ?? "") + params.delta
        return this.emitReasoning(params.itemId, false, grows ? { parts, delta: params.delta } : undefined)
      }
      case "turn/plan/updated":
        this.ctx.emit({
          type: "plan",
          id: eventId(this.threadId, `${this.turnId}:plan`),
          entries: (params.plan ?? []).map((step) => ({
            content: step.step,
            status: step.status === "inProgress" ? "in_progress" : step.status === "completed" ? "completed" : "pending",
          })),
        })
        return
      case "error":
        if (params.willRetry) {
          // Codex backs off and retries the request itself; tell the turn guard it is still alive.
          this.retries += 1
          this.ctx.emit({ type: "retry", attempt: this.retries, ...(params.error?.message ? { reason: params.error.message } : {}) })
          return
        }
        if (params.error?.message) {
          this.lastError = params.error.message
          this.lastErrorInfo = codexErrorInfo(params.error)
        }
        return
    }
  }

  // fromSubagent: the request came from a thread this turn spawned; its item ids are not this thread's cards.
  async approve(method: string, params: Params, requestId: RpcId, fromSubagent = false): Promise<unknown> {
    // A request can share a stdout chunk with the turn/start response; let begin() replay buffered items first.
    await this.started
    // A subagent runs on after its parent's turn: its request is still the phone's to answer.
    if (this.finished) return fromSubagent ? this.orphan(method, params, requestId) : { decision: "cancel" }
    const key = String(requestId)
    const withdraw = new AbortController()
    this.withdraws.set(key, withdraw)
    // The child's item ids are not cards on this thread.
    const tool = params.itemId && !fromSubagent ? this.tools.get(params.itemId) : undefined
    if (tool && params.itemId) this.emitTool(params.itemId, { ...tool, status: "pending" })
    const request = approvalRequest(method, params, tool)
    // Tool event ids are derived from the item id, so this matches the card even if it opens later.
    if (params.itemId && !fromSubagent) request.toolId = eventId(this.threadId, params.itemId)
    try {
      const choice = await this.ctx.askPermission(request, withdraw.signal)
      if (withdraw.signal.aborted) return fromSubagent && this.closing ? this.orphan(method, params, requestId) : NO_REPLY
      const decision = approvalDecision(request, choice)
      const current = params.itemId ? this.tools.get(params.itemId) : undefined
      if (current && params.itemId && decision.startsWith("accept")) this.emitTool(params.itemId, { ...current, status: "running" })
      return { decision }
    } finally {
      this.withdraws.delete(key)
    }
  }

  /** serverRequest/resolved on a subagent's thread: Codex took back a request this turn is asking. */
  withdraw(requestId: RpcId | undefined) {
    this.withdraws.get(String(requestId))?.abort()
  }

  /** item/tool/requestUserInput: the option questions as a question card; a secret one is not shown (no secure field yet). */
  async askUser(params: Params, requestId: RpcId): Promise<unknown> {
    await this.started
    if (this.finished) return emptyAnswers(params)
    const questions = arr(params.questions).filter(isObject)
    for (const question of questions.filter((item) => item.isSecret === true)) {
      this.notice(`question:${str(question.id)}`, phoneCopy.questionSecretSkipped("Codex", str(question.question)))
    }
    // id → the card's question; a secret one gets none.
    const shown = new Map<string, QuestionItem>()
    for (const question of questions) {
      if (question.isSecret === true) continue
      const options = arr(question.options)
        .filter(isObject)
        .map((option) => ({ label: str(option.label), ...(str(option.description) ? { description: str(option.description) } : {}) }))
      shown.set(str(question.id), {
        question: str(question.question),
        ...(str(question.header) ? { header: str(question.header) } : {}),
        options,
        multiSelect: false,
        // With no options, typing is the only way to answer.
        allowsOther: question.isOther === true || options.length === 0,
      })
    }
    const items = [...shown.values()]
    distinctTexts(items)
    const answers = items.length ? await this.ask((signal) => this.ctx.askQuestion({ questions: items }, signal), requestId) : null
    if (answers === NO_REPLY) return NO_REPLY
    return {
      answers: Object.fromEntries(
        questions.map((question) => {
          const item = shown.get(str(question.id))
          const value = item ? answers?.[item.question] : undefined
          return [str(question.id), { answers: value === undefined ? [] : Array.isArray(value) ? value : [value] }]
        }),
      ),
    }
  }

  /** mcpServer/elicitation/request: an MCP tool approval as a permission card, a form as a question card. */
  async elicit(params: Params, requestId: RpcId): Promise<unknown> {
    await this.started
    if (this.finished) return ELICIT_CANCEL
    const server = str(params.serverName)
    const meta = obj(params._meta)
    const message = str(params.message)
    if (params.mode === "url") {
      const response = await this.ask(signal => urlElicitation({
        server, message, url: str(params.url), elicitationId: str(params.elicitationId),
      }, this.ctx.askQuestion, this.openUrl, AbortSignal.any([signal, this.ctx.signal])), requestId)
      return response === NO_REPLY ? NO_REPLY : { ...response, content: null, _meta: null }
    }
    if (params.mode !== "form") {
      this.notice(`elicit:${String(requestId)}`, phoneCopy.mcpUrlUnsupported(server, message))
      return ELICIT_DECLINE
    }
    const form = formQuestions(message, params.requestedSchema)
    // A form with no fields that is not a tool approval: a bare yes / no, with no rule to remember it by.
    if (meta.codex_approval_kind !== "mcp_tool_call" && form && form.request.questions.length === 0) {
      const request: PermissionRequest = { tool: `mcp__${server}`, title: message || server, detail: "", kind: "other", options: ELICIT_CONFIRM_OPTIONS }
      const choice = await this.ask((signal) => this.ctx.askPermission(request, signal), requestId)
      if (choice === NO_REPLY) return NO_REPLY
      return choice === "accept" ? { action: "accept", content: {}, _meta: null } : ELICIT_DECLINE
    }
    if (meta.codex_approval_kind === "mcp_tool_call") {
      const tool = `mcp__${server}__${str(meta.tool_name)}`
      const request: PermissionRequest = {
        tool,
        title: message || tool,
        detail: isObject(meta.tool_params) && Object.keys(meta.tool_params).length ? JSON.stringify(meta.tool_params) : str(meta.tool_description),
        kind: "other",
        options: MCP_APPROVAL_OPTIONS,
        match: callMatch(tool, {}),
      }
      const choice = await this.ask((signal) => this.ctx.askPermission(request, signal), requestId)
      if (choice === NO_REPLY) return NO_REPLY
      return choice === "accept" || choice === "acceptForSession" ? { action: "accept", content: {}, _meta: null } : ELICIT_DECLINE
    }
    if (!form) {
      this.notice(`elicit:${String(requestId)}`, phoneCopy.mcpFormUnsupported(server))
      return ELICIT_DECLINE
    }
    const response = await this.ask(signal => elicitForm(form, this.ctx.askQuestion, AbortSignal.any([signal, this.ctx.signal])), requestId)
    if (response === NO_REPLY) return NO_REPLY
    return response.action === "accept" ? { ...response, _meta: null } : ELICIT_CANCEL
  }

  // Like approve(): withdrawn when the server resolves the request first (no reply is sent then).
  private async ask<T>(question: (signal: AbortSignal) => Promise<T>, requestId: RpcId): Promise<T | typeof NO_REPLY> {
    const key = String(requestId)
    const withdraw = new AbortController()
    this.withdraws.set(key, withdraw)
    try {
      const answer = await question(withdraw.signal)
      return withdraw.signal.aborted ? NO_REPLY : answer
    } finally {
      this.withdraws.delete(key)
    }
  }

  // Rudder's own line, which the phone words in its own language.
  private notice(key: string, copy: PhoneCopy) {
    this.ctx.emit({ type: "text", id: eventId(this.threadId, `${this.turnId ?? "turn"}:${key}`), text: copy.text, notice: true, copy })
  }

  private begin(turnId: string) {
    this.turnId = turnId
    this.ctx.emit({ type: "nativeTurn", nativeId: this.threadId, turnId })
    this.markStarted(turnId)
    for (const [method, params, child] of this.buffered.splice(0)) {
      if (child) this.child(child, method, params)
      else this.notify(method, params)
    }
  }

  private interrupt() {
    if (!this.turnId || this.finished || this.interruptTimer) return
    void this.conn.request("turn/interrupt", { threadId: this.threadId, turnId: this.turnId }, 10_000).catch(() => {})
    this.interruptTimer = setTimeout(() => void this.readThreadStatus(), this.interruptGraceMs)
  }

  // turn/interrupt went unanswered: ask Codex whether the thread still runs. Not active ends the turn as interrupted;
  // active keeps waiting for its idle (a turn/start now would steer the old turn). Transport close is the breaker.
  private async readThreadStatus() {
    if (this.concluded) return
    try {
      const read = await this.conn.request<{ thread?: { status?: { type?: unknown } } }>("thread/read", { threadId: this.threadId }, 10_000)
      const type = read?.thread?.status?.type
      if (typeof type !== "string") throw new Error(`no thread status in ${JSON.stringify(read)}`)
      this.threadActive = type === "active"
      this.statusKnown = true
    } catch (error) {
      console.warn(`rudderd: codex thread/read after interrupting ${this.turnId} failed; waiting for the thread's own idle: ${errorMessage(error)}`)
    }
    this.interruptPending = true
    this.check()
  }

  private complete(terminal: Turn) {
    if (this.nativeTerminal !== terminal) return
    this.completed = terminal
    this.check()
  }

  // The shared contract: this turn's turn/completed and a thread that is not active. With no status ever seen,
  // turn/completed alone (older app-servers). After an unanswered interrupt, a known not-active thread alone.
  private check() {
    if (this.threadActive || this.concluded) return
    const turn = this.completed ?? (this.interruptPending && this.statusKnown && this.turnId ? { id: this.turnId, status: "interrupted" } : undefined)
    if (!turn) return
    this.concluded = turn
    this.settle(turn)
  }

  // Codex started another turn on this thread after ours completed while the thread stayed active: its output is this
  // turn's, not dropped (handled defensively; not seen in recordings).
  private adopt(turn: Turn | undefined) {
    if (!turn?.id || turn.id === this.turnId || !this.nativeTerminal || this.concluded) return
    console.warn(`rudderd: codex thread ${this.threadId} continued ${this.turnId} with ${turn.id}; adopting it into the running turn`)
    this.turnId = turn.id
    this.nativeTerminal = undefined
    this.completed = undefined
    this.ctx.emit({ type: "nativeTurn", nativeId: this.threadId, turnId: turn.id })
    this.ctx.emit({ type: "lifecycle", phase: "working", pendingFinalization: false })
  }

  private item(item: ThreadItem | undefined, done: boolean) {
    if (!item?.id) return
    if (done) {
      const signature = JSON.stringify(item)
      if (this.completedItems.get(item.id) === signature) return
      this.completedItems.set(item.id, signature)
    }
    if (item.type === "contextCompaction") {
      if (done) {
        this.ctx.emit({
          type: "compaction",
          id: eventId(this.threadId, item.id),
          state: "done",
          trigger: "auto",
        })
      }
      return
    }
    if (item.type === "agentMessage") {
      if (item.phase) this.messagePhases.set(item.id, item.phase)
      const options = item.delivery === "async" && item.questions?.length === 1 ? item.questions[0]?.options : null
      const replyChoices =
        Array.isArray(options) && options.length >= 2 && options.length <= 6 && options.every((option) => typeof option === "string" && option.trim())
          ? options
          : undefined
      if (item.phase === "final_answer" && item.text) this.finalIds.add(item.id)
      if (item.text) this.setText(item.id, item.text, replyChoices, item.phase === "final_answer" ? "final" : item.phase)
      return
    }
    if (item.type === "reasoning") {
      const state = this.reasoningState(item.id)
      if (!done) {
        state.startedAt ??= Date.now()
        return
      }
      if (item.summary?.length) state.summary = [...item.summary]
      if (item.content?.length) state.content = [...item.content]
      return this.emitReasoning(item.id, true)
    }
    if (item.type === "imageGeneration") {
      if (!done || this.imageIds.has(item.id)) return
      this.imageIds.add(item.id)
      const current = item
      this.imageChain = this.imageChain.then(() => this.publishImage(current))
      return
    }
    if (item.type === "collabAgentToolCall" && item.tool === "spawnAgent") {
      for (const child of item.receiverThreadIds ?? []) this.spawnItems.set(child, item)
    }
    const tool = toolEvent(this.threadId, item, done)
    // A replayed spawn item must not wipe the result its subagent thread already reported.
    const reported = item.type === "collabAgentToolCall" && tool && !tool.output ? this.tools.get(item.id)?.output : undefined
    if (tool) this.emitTool(item.id, reported ? { ...tool, output: reported } : tool)
  }

  /** This turn started the subagent thread (another turn of the same thread may have). */
  spawned(threadId: string): boolean {
    if (this.spawnItems.has(threadId)) return true
    if (this.turnId || this.buffered.some(([method, , child]) => !child && method === "turn/completed")) return false
    return this.buffered.some(([, params, child]) => !child && params.item?.type === "collabAgentToolCall" && params.item.tool === "spawnAgent" && params.item.receiverThreadIds?.includes(threadId))
  }

  /** A subagent thread's own notification: its last message becomes the spawn card's output when it finishes. */
  child(threadId: string, method: string, params: Params) {
    if (!this.turnId) {
      this.buffered.push([method, params, threadId])
      return
    }
    const item = params.item
    if (method === "item/completed" && item?.type === "agentMessage" && item.text) this.childTexts.set(threadId, item.text)
    if (method !== "turn/completed") return
    const spawn = this.spawnItems.get(threadId)
    const base = spawn && toolEvent(this.threadId, spawn, true)
    if (!spawn || !base) return
    this.childDone.add(threadId)
    const failed = params.turn?.status === "failed"
    // One spawn can start several threads: the card carries every finished one's words.
    const output = joinText((spawn.receiverThreadIds ?? []).filter((child) => this.childDone.has(child)).map((child) => this.childTexts.get(child)))
    if (!output && !failed) return
    this.emitTool(spawn.id, { ...base, status: failed ? "failed" : "completed", ...(output ? { output } : {}) })
  }

  private async publishImage(item: ThreadItem) {
    try {
      const image = await loadGeneratedImage(item, this.ctx.cwd)
      if (!image) return
      await this.ctx.emit({
        type: "image",
        id: eventId(this.threadId, item.id),
        name: image.name,
        mediaType: image.mediaType,
        width: image.width,
        height: image.height,
        bytes: image.bytes,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`rudderd: image ${item.id} was not stored: ${message}`)
    }
  }

  private emitTool(itemId: string, tool: ToolEvent) {
    this.tools.set(itemId, tool)
    this.ctx.emit(tool)
  }

  private setText(itemId: string, text: string, replyChoices?: string[], phase?: "commentary" | "final") {
    if (!text || (this.texts.get(itemId) === text && !replyChoices)) return
    this.texts.set(itemId, text)
    this.ctx.emit({ type: "text", id: eventId(this.threadId, itemId), text, ...(phase ? { phase } : {}), ...(replyChoices ? { replyChoices } : {}) })
  }

  private reasoningState(itemId: string) {
    let state = this.reasoning.get(itemId)
    if (!state) {
      state = { summary: [], content: [], emitted: false, done: false }
      this.reasoning.set(itemId, state)
    }
    return state
  }

  // Summaries are preferred; raw reasoning text only as fallback. Empty reasoning never surfaces.
  // `grew`: the delta just appended to the last, already non-empty part of `parts`. When the text last joined came
  // from that same list, it is that text plus the delta; joining every part again per delta copied the whole thought
  // each time (2026-11-12, perf-1112 R6).
  private emitReasoning(itemId: string, done: boolean, grew?: { parts: string[]; delta: string }) {
    const state = this.reasoningState(itemId)
    const parts = state.summary.some(Boolean) ? state.summary : state.content
    const text =
      grew && grew.parts === parts && state.textOf === parts && state.text !== undefined
        ? state.text + grew.delta
        : parts.filter(Boolean).join("\n\n")
    state.text = text
    state.textOf = parts
    if (!text || (state.done && done)) return
    state.emitted = true
    state.done = done
    const startedAt = state.startedAt === undefined ? {} : { startedAt: state.startedAt }
    this.ctx.emit({ type: "reasoning", id: eventId(this.threadId, itemId), text, done, ...startedAt })
  }

  // One update per model request: `last` is that request, `total` the thread sum. Summing `last` within the
  // turn equals the total's growth (basic.jsonl: 27757 + 34058 + 34154 = 95969); an unchanged total is a
  // re-report (thread/resume replays the latest one) and is skipped.
  private trackUsage(params: Params) {
    const usage = params.tokenUsage
    const last = usage?.last
    const total = usage?.total?.totalTokens
    if (!usage || !last || total === undefined) return
    const previous = this.conn.totals.get(this.threadId)
    this.conn.totals.set(this.threadId, total)
    if (params.turnId !== this.turnId || total === previous) return
    const sum = this.usage
    const size = windowSize(this.catalogWindow, this.ctx.model, usage.modelContextWindow)
    this.usage = {
      // Codex input includes cached input; split it like Claude does.
      inputTokens: (sum?.inputTokens ?? 0) + last.inputTokens - last.cachedInputTokens,
      outputTokens: (sum?.outputTokens ?? 0) + last.outputTokens,
      cacheReadTokens: (sum?.cacheReadTokens ?? 0) + last.cachedInputTokens,
      cacheWriteTokens: (sum?.cacheWriteTokens ?? 0) + last.cacheWriteInputTokens,
      reasoningTokens: (sum?.reasoningTokens ?? 0) + last.reasoningOutputTokens,
      // The latest request's prompt + output is what occupies the window; `total` sums every request.
      contextUsed: last.totalTokens,
      // Catalog window (272k / 500k) when we know the model. `modelContextWindow` is the 95% effective budget.
      ...(size !== undefined ? { contextSize: size } : {}),
    }
  }

  // Interrupted items never get item/completed: close whatever is still open.
  private closeOpen() {
    this.closing = true
    for (const [itemId, tool] of this.tools) {
      if (tool.status === "pending" || tool.status === "running") this.emitTool(itemId, { ...tool, status: "cancelled" })
    }
    for (const [itemId, state] of this.reasoning) {
      if (state.emitted && !state.done) this.emitReasoning(itemId, true)
    }
    for (const withdraw of this.withdraws.values()) withdraw.abort()
  }
}

// account/rateLimits/read and account/rateLimits/updated (schema GetAccountRateLimitsResponse). Fields are nullable.
type RateLimitWindow = { usedPercent?: number | null; windowDurationMins?: number | null; resetsAt?: number | null }
export type RateLimitSnapshot = {
  limitId?: string | null
  limitName?: string | null
  planType?: string | null
  credits?: { hasCredits?: boolean; unlimited?: boolean; balance?: string | null } | null
  primary?: RateLimitWindow | null
  secondary?: RateLimitWindow | null
}
export type RateLimitsRead = { rateLimits?: RateLimitSnapshot | null; rateLimitsByLimitId?: Record<string, RateLimitSnapshot> | null }

const RATE_LIMITS_TTL_MS = 15_000
const RATE_LIMITS_TIMEOUT_MS = 5_000
// The bucket every model draws on; other ids are separately metered aliases.
const MAIN_LIMIT_ID = "codex"

// Buckets keyed by limit id, main bucket first. Older servers only send the single-bucket view.
export function rateLimitBuckets(read: RateLimitsRead): Map<string, RateLimitSnapshot> {
  const buckets = new Map<string, RateLimitSnapshot>()
  const byId = read.rateLimitsByLimitId ?? {}
  const main = byId[MAIN_LIMIT_ID] ?? read.rateLimits ?? undefined
  if (main) buckets.set(main.limitId || MAIN_LIMIT_ID, main)
  for (const [id, snapshot] of Object.entries(byId)) if (!buckets.has(id) && id !== MAIN_LIMIT_ID) buckets.set(id, snapshot)
  return buckets
}

// A sparse update only replaces what it carries; a null never clears an observed value.
export function mergeRateLimits(buckets: Map<string, RateLimitSnapshot>, update: RateLimitSnapshot) {
  const id = update.limitId || MAIN_LIMIT_ID
  const merged: RateLimitSnapshot = { ...buckets.get(id) }
  for (const [key, value] of Object.entries(update) as [keyof RateLimitSnapshot, unknown][]) {
    if (value !== null && value !== undefined) (merged as Record<string, unknown>)[key] = value
  }
  buckets.set(id, merged)
}

export function codexQuota(buckets: Map<string, RateLimitSnapshot>, now = Date.now()): AgentQuota | undefined {
  const windows: QuotaWindow[] = []
  let first = true
  let plan: string | undefined
  let credits: string | undefined
  for (const [id, snapshot] of buckets) {
    const limit = first ? undefined : snapshot.limitName || id
    if (first) {
      plan = snapshot.planType && snapshot.planType !== "unknown" ? snapshot.planType : undefined
      const c = snapshot.credits
      if (c?.hasCredits && !c.unlimited && c.balance) credits = c.balance
    }
    first = false
    for (const window of [snapshot.primary, snapshot.secondary]) {
      if (!window || typeof window.usedPercent !== "number") continue
      windows.push({
        ...(limit ? { limit } : {}),
        ...(typeof window.windowDurationMins === "number" ? { minutes: window.windowDurationMins } : {}),
        usedPercent: Math.max(0, Math.min(100, Math.round(window.usedPercent))),
        ...(typeof window.resetsAt === "number" ? { resetsAt: window.resetsAt * 1000 } : {}),
      })
    }
  }
  // API-key login: the read answers with no windows, so there is nothing to show.
  if (!windows.length) return undefined
  return { ...(plan ? { plan } : {}), ...(credits ? { credits } : {}), windows, updatedAt: now }
}

function isMissingThread(error: unknown) {
  return error instanceof RpcError && /no rollout found|thread not found/i.test(error.message)
}

// Codex's own model catalog (`models_cache.json`). `context_window` is the window the model runs;
// `modelContextWindow` on a turn is the smaller effective budget.
let catalogCache: { path: string; mtimeMs: number; windows: Map<string, number> } | undefined

export function codexCatalogWindow(model: string): number | undefined {
  const path = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "models_cache.json")
  try {
    const mtimeMs = statSync(path).mtimeMs
    if (!catalogCache || catalogCache.path !== path || catalogCache.mtimeMs !== mtimeMs) {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { models?: { slug?: string; context_window?: number }[] }
      const windows = new Map<string, number>()
      for (const entry of parsed.models ?? []) {
        if (entry.slug && typeof entry.context_window === "number" && entry.context_window > 0) windows.set(entry.slug, entry.context_window)
      }
      catalogCache = { path, mtimeMs, windows }
    }
  } catch {
    return undefined
  }
  return catalogCache.windows.get(model)
}

function windowSize(catalog: ((model: string) => number | undefined) | undefined, model: string | undefined, reported: number | null | undefined): number | undefined {
  const fromCatalog = model ? catalog?.(model) : undefined
  if (fromCatalog !== undefined) return fromCatalog
  return reported != null ? reported : undefined
}

function credentialMtime(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

export function createCodexAdapter(options: CodexAdapterOptions): AgentAdapter {
  const command = options.command ?? ["codex", "app-server"]
  const credentialFile = options.credentialFile ?? join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json")
  const catalogWindow = options.catalogWindow
  const interruptGraceMs = options.interruptGraceMs ?? 5_000
  const turns = new Map<string, CodexTurn>()
  // Per session, the turn being set up or running; steer waits through a cold thread/start.
  const sessionTurns = new Map<string, Promise<CodexTurn | undefined>>()
  const sessionSetups = new Map<string, { forgotten: boolean }>()
  const setupClaims = new WeakMap<CodexConnection, Map<string, { owner: { forgotten: boolean }; sessionId: string }>>()
  // Rudder session → its thread, for forget().
  const threadOf = new Map<string, string>()
  const permissionOf = new Map<string, string>()
  const modelOf = new Map<string, string>()
  const effortOf = new Map<string, string>()
  // A subagent's thread → the thread whose turn spawned it. Its approvals belong to that turn (T3 Code's Codex
  // adapter keeps the same map, MIT); without it they were answered cancel and the subagent silently refused.
  const parentOf = new Map<string, string>()
  // Continuation turns (plan 2026-11-17 Task 5): who a thread's last turn belonged to, each subagent thread's latest
  // message, and the Rudder sessions a stop quieted until their next prompt.
  const owners = new Map<string, TurnExecutionIdentity & { nativeSessionId: string }>()
  const childTexts = new Map<string, string>()
  const quieted = new Set<string>()
  let continuationSink: ((offer: ContinuationOffer) => boolean) | undefined
  // A subagent's approval that arrived after its parent's turn ended, by parent thread: held for the next turn on that
  // thread (a continuation opened for it, or a prompt that starts first). Answered when the phone answers.
  type LateAsk = { conn: CodexConnection; method: string; params: Params; requestId: RpcId; withdraw: AbortController; resolve: (answer: unknown) => void }
  const lateAsks = new Map<string, LateAsk[]>()
  let live: { conn: CodexConnection; ready: Promise<CodexConnection>; startedAt: number } | undefined
  // Set for the whole dispose-then-spawn, before the first await, so a second caller shares it.
  let replacing: Promise<CodexConnection> | undefined
  // Once the adapter is stopping, a recycle must not spawn the replacement.
  let stopped = false
  const threadIdleMs = options.threadIdleMs ?? CODEX_THREAD_IDLE_MS
  // Per loaded thread, the timer that unsubscribes it once idle; cleared when a turn takes it.
  const idleTimers = new Map<string, ReturnType<typeof setTimeout>>()
  // Set when the app-server has no thread/unsubscribe (older than 0.165): threads then stay loaded, as before.
  const unsubscribeMissing = new WeakSet<CodexConnection>()
  const unloading = new WeakMap<CodexConnection, Map<string, Promise<void>>>()
  const forgotten = new WeakMap<CodexConnection, Set<string>>()

  // A direct subagent ended after the turn that spawned it, with the parent thread idle or running a later turn:
  // nothing shows its words, so they wake the parent (T3 Code's Codex adapter does the same). Offered during a later
  // turn, the session holds it until that turn ends. A grandchild never wakes the root; a stopped session stays quiet.
  function childEnded(parent: string, child: string, status: string | undefined) {
    const text = childTexts.get(child)
    childTexts.delete(child)
    if (parentOf.has(parent) || (status !== "completed" && status !== "failed")) return
    const identity = owners.get(parent)
    if (!identity || !continuationSink || quieted.has(identity.sessionId)) return
    const words = (text ?? "").slice(0, CHILD_WAKE_CHARS)
    const detail = status === "failed" ? `Subagent failed.${words ? `\n${words}` : ""}` : `Subagent finished:\n${words}`
    continuationSink({ identity, key: child, detail, delivery: "message_text" })
  }

  // Before 2026-11-18 this answered cancel: the subagent stopped although its parent would have been told it finished.
  function lateApproval(conn: CodexConnection, parent: string, method: string, params: Params, requestId: RpcId): Promise<unknown> {
    const identity = owners.get(parent)
    if (conn.closed || parentOf.has(parent) || !identity || !continuationSink || quieted.has(identity.sessionId)) {
      return Promise.resolve({ decision: "cancel" })
    }
    return new Promise((resolve) => {
      const ask: LateAsk = { conn, method, params, requestId, withdraw: new AbortController(), resolve }
      lateAsks.set(parent, [...(lateAsks.get(parent) ?? []), ask])
      const request = approvalRequest(method, params)
      const detail = request.kind === "edit" ? "Subagent asks to edit files." : `Subagent asks to run: ${request.detail}`
      const key = `approval:${params.threadId ?? parent}:${String(requestId)}`
      if (!continuationSink!({ identity, key, detail, delivery: "buffered" })) takeLate(parent, ask)?.resolve({ decision: "cancel" })
    })
  }

  // Removes and returns one held ask (or every one of the thread's when `only` is absent).
  function takeLate(parent: string, only: LateAsk): LateAsk | undefined
  function takeLate(parent: string): LateAsk[]
  function takeLate(parent: string, only?: LateAsk) {
    const held = lateAsks.get(parent) ?? []
    const kept = only ? held.filter((ask) => ask !== only) : []
    if (kept.length) lateAsks.set(parent, kept)
    else lateAsks.delete(parent)
    return only ? (held.includes(only) ? only : undefined) : held
  }

  /** Codex took back a request (serverRequest/resolved): a held one is not asked and gets no reply. */
  function withdrawLate(requestId: RpcId | undefined) {
    for (const [parent, held] of lateAsks) {
      for (const ask of held) {
        if (String(ask.requestId) !== String(requestId)) continue
        ask.withdraw.abort()
        takeLate(parent, ask)
        ask.resolve(NO_REPLY)
      }
    }
  }

  // The continuation turn a held approval opened: the daemon owes the subagent this answer, nothing is sent to Codex.
  // A stop on that turn withdraws the card and tells the subagent no.
  async function askLate(ask: LateAsk, ctx: AdapterContext) {
    const request = approvalRequest(ask.method, ask.params)
    const choice = ctx.signal.aborted ? null : await ctx.askPermission(request, AbortSignal.any([ask.withdraw.signal, ctx.signal]))
    ask.resolve(ask.withdraw.signal.aborted ? NO_REPLY : { decision: ctx.signal.aborted ? "cancel" : approvalDecision(request, choice) })
  }

  // The one place a thread leaves this process's books: thread/closed from the server, or our own unsubscribe.
  function dropThread(conn: CodexConnection, threadId: string) {
    conn.loaded.delete(threadId)
    conn.totals.delete(threadId)
    setupClaims.get(conn)?.delete(threadId)
    if (live?.conn !== conn) return
    permissionOf.delete(threadId)
    modelOf.delete(threadId)
    effortOf.delete(threadId)
    clearTimeout(idleTimers.get(threadId))
    idleTimers.delete(threadId)
    for (const [sessionId, owner] of threadOf) if (owner === threadId) threadOf.delete(sessionId)
    parentOf.delete(threadId)
    for (const [child, parent] of parentOf) if (parent === threadId) parentOf.delete(child)
  }

  async function unloadThread(conn: CodexConnection, threadId: string): Promise<void> {
    const pending = unloading.get(conn)?.get(threadId)
    if (pending) {
      await pending
      // An older resume may load it again while this acknowledgement was in flight.
      if (!claimedByAnother(conn, threadId, {})) await unloadThread(conn, threadId)
      return
    }
    if (!conn.loaded.has(threadId)) return
    if (turns.get(threadId)?.conn === conn) {
      const threads = forgotten.get(conn) ?? new Set<string>()
      threads.add(threadId)
      forgotten.set(conn, threads)
      return
    }
    forgotten.get(conn)?.delete(threadId)
    // Schedule the native release before removing visibility; a resume waits for its answer.
    const request = conn.closed || unsubscribeMissing.has(conn)
      ? Promise.resolve()
      : conn.request("thread/unsubscribe", { threadId }).then(() => {}, (error: unknown) => {
          if (error instanceof RpcError && (error.code === -32601 || /unknown variant|method not found/i.test(error.message))) unsubscribeMissing.add(conn)
          else console.warn(`rudderd: codex thread/unsubscribe ${threadId} failed: ${errorMessage(error)}`)
        })
    const jobs = unloading.get(conn) ?? new Map<string, Promise<void>>()
    unloading.set(conn, jobs)
    const job = request.finally(() => { if (jobs.get(threadId) === job) jobs.delete(threadId) })
    jobs.set(threadId, job)
    dropThread(conn, threadId)
    return job
  }

  function claimedByAnother(conn: CodexConnection, threadId: string, owner: object): boolean {
    if (live?.conn === conn && [...threadOf.values()].includes(threadId)) return true
    const claim = setupClaims.get(conn)?.get(threadId)
    return !!claim && claim.owner !== owner && !claim.owner.forgotten && sessionSetups.get(claim.sessionId) === claim.owner
  }

  function restThread(conn: CodexConnection, threadId: string) {
    clearTimeout(idleTimers.get(threadId))
    if (forgotten.get(conn)?.has(threadId)) {
      void unloadThread(conn, threadId)
      return
    }
    if (unsubscribeMissing.has(conn)) return
    const timer = setTimeout(() => {
      idleTimers.delete(threadId)
      if (live?.conn !== conn || conn.closed || turns.has(threadId) || !conn.loaded.has(threadId)) return
      void unloadThread(conn, threadId)
    }, threadIdleMs)
    timer.unref?.()
    idleTimers.set(threadId, timer)
  }
  function currentConnection() { return live?.conn }

  // Last account/rateLimits/read, merged with every account/rateLimits/updated since.
  let rateLimits: { buckets: Map<string, RateLimitSnapshot>; at: number } | undefined
  let rateRead: Promise<void> | undefined

  const handlers: ConnectionHandlers = {
    notification(conn, method, params) {
      if (method === "account/rateLimits/updated") {
        const update = (params as { rateLimits?: RateLimitSnapshot }).rateLimits
        if (update && rateLimits) mergeRateLimits(rateLimits.buckets, update)
        return
      }
      if (!params.threadId) return
      if (method === "thread/closed") dropThread(conn, params.threadId)
      const item = params.item
      if ((method === "item/started" || method === "item/completed") && item?.type === "collabAgentToolCall") {
        for (const child of item.receiverThreadIds ?? []) if (child !== params.threadId) parentOf.set(child, params.threadId)
      }
      const turn = turns.get(params.threadId)
      if (turn?.conn === conn) return turn.notify(method, params)
      const parent = parentOf.get(params.threadId)
      if (!parent) {
        // Not seen in recordings: say so instead of dropping it unremarked.
        if (method === "turn/started") console.warn(`rudderd: codex thread ${params.threadId} started turn ${params.turn?.id} with no Rudder turn; its output is not shown`)
        return
      }
      if (method === "item/completed" && item?.type === "agentMessage" && item.text) childTexts.set(params.threadId, item.text)
      const owner = turns.get(parent)
      if (method === "serverRequest/resolved") {
        withdrawLate(params.requestId)
        if (owner?.conn === conn) owner.withdraw(params.requestId)
        return
      }
      if (owner?.conn === conn && !owner.ended && owner.spawned(params.threadId)) return owner.child(params.threadId, method, params)
      // No turn, an ended one, or a later turn on the parent thread that did not spawn it (its card is an earlier
      // turn's): Codex shows the parent thread nothing for the child's end, so it is offered as a continuation.
      if (method === "turn/completed") childEnded(parent, params.threadId, params.turn?.status)
    },
    async request(conn, method, params, id) {
      const asks = method === "item/tool/requestUserInput" || method === "mcpServer/elicitation/request"
      if (!APPROVAL_REQUESTS.has(method) && !asks) throw unsupported(method)
      const own = params.threadId ? turns.get(params.threadId) : undefined
      const parent = !own && params.threadId ? parentOf.get(params.threadId) : undefined
      const turn = own ?? (parent ? turns.get(parent) : undefined)
      const live = turn?.conn === conn && !turn.finished ? turn : undefined
      if (method === "item/tool/requestUserInput") return live ? live.askUser(params, id) : emptyAnswers(params)
      if (method === "mcpServer/elicitation/request") return live ? live.elicit(params, id) : ELICIT_CANCEL
      // A subagent's approval once its parent's turn has ended waits for the next turn on that thread.
      if (parent && (!live || live.ended)) return lateApproval(conn, parent, method, params, id)
      if (!live) return { decision: "cancel" }
      return live.approve(method, params, id, parent !== undefined)
    },
    exit(conn, reason) {
      if (live?.conn === conn) live = undefined
      for (const turn of turns.values()) if (turn.conn === conn) turn.abandon(new Error(reason))
      for (const [parent, held] of lateAsks) for (const ask of held) if (ask.conn === conn) takeLate(parent, ask)?.resolve(NO_REPLY)
    },
  }

  // One long-lived app-server for every session; respawned lazily after it exits.
  // ChatGPT refresh tokens rotate. Another Codex (the app, a second app-server) rewrites auth.json, and this
  // process keeps refreshing with the revoked token (`unauthorized` / "signed in to another account"). When
  // the file is newer than the process and no turn is in flight, start a new one that reads the new file.
  // reply has not bound a process yet, so its own sessionTurns entry does not count. Every other caller does.
  function spawnServer(): Promise<CodexConnection> {
    if (stopped) return Promise.reject(new Error("codex adapter is stopped"))
    const startedAt = Date.now()
    const conn = new CodexConnection(command, handlers)
    const ready = conn.initialize().catch((error: unknown) => {
      void conn.dispose()
      throw new Error(`codex app-server failed to initialize: ${errorMessage(error)}`)
    })
    live = { conn, ready, startedAt }
    return ready
  }

  function server(caller: "reply" | "other"): Promise<CodexConnection> {
    if (stopped) return Promise.reject(new Error("codex adapter is stopped"))
    if (replacing) return replacing
    const current = live && !live.conn.closed ? live : undefined
    const busy = caller === "reply" ? turns.size > 0 || sessionTurns.size > 1 : turns.size > 0 || sessionTurns.size > 0
    if (!(current && credentialMtime(credentialFile) > current.startedAt && !busy)) {
      return current ? current.ready : spawnServer()
    }
    const previous = current
    live = undefined
    rateLimits = undefined
    let resolveReplacing!: (conn: CodexConnection) => void
    let rejectReplacing!: (error: unknown) => void
    const promise = new Promise<CodexConnection>((resolve, reject) => {
      resolveReplacing = resolve
      rejectReplacing = reject
    })
    replacing = promise
    void (async () => {
      try {
        await previous.conn.dispose()
        if (stopped) throw new Error("codex adapter is stopped")
        resolveReplacing(await spawnServer())
      } catch (error) {
        live = undefined
        rejectReplacing(error)
      } finally {
        if (replacing === promise) replacing = undefined
      }
    })()
    return promise
  }

  async function resume(conn: CodexConnection, threadId: string, ctx: AdapterContext) {
    await unloading.get(conn)?.get(threadId)
    let nativePolicy: { approvalPolicy?: unknown; sandbox?: string; approvalsReviewer?: unknown } = {}
    if (ctx.permissionMode === "native") {
      // A saved thread may contain a previous phone override. Restore the current CLI policy explicitly.
      const config = obj(obj(await conn.request("config/read", { cwd: ctx.cwd, includeLayers: false })).config)
      const sandbox = str(config.sandbox_mode)
      if (["read-only", "workspace-write", "danger-full-access"].includes(sandbox) && config.approval_policy) {
        nativePolicy = { approvalPolicy: config.approval_policy, sandbox, ...(config.approvals_reviewer ? { approvalsReviewer: config.approvals_reviewer } : {}) }
      } else {
        // Config leaves defaults null. Let the native runtime resolve them without a model turn or saved history.
        const probe = obj(await conn.request("thread/start", { cwd: ctx.cwd, ephemeral: true }))
        const probeId = str(obj(probe.thread).id)
        if (!probeId) throw new Error("codex native policy probe returned no temporary thread id")
        try {
          const kind = str(obj(probe.sandbox).type)
          const resolved = ({ readOnly: "read-only", workspaceWrite: "workspace-write", dangerFullAccess: "danger-full-access" } as Record<string, string>)[kind]
          if (!resolved || !probe.approvalPolicy) throw new Error("codex native policy cannot be represented by thread/resume; review native sandbox settings")
          nativePolicy = { approvalPolicy: probe.approvalPolicy, sandbox: resolved, ...(probe.approvalsReviewer ? { approvalsReviewer: probe.approvalsReviewer } : {}) }
        } finally {
          await conn.request("thread/unsubscribe", { threadId: probeId })
        }
      }
    }
    const resumed = obj(await conn.request("thread/resume", { threadId, excludeTurns: true, ...threadSettings(ctx), ...nativePolicy }))
    if (typeof resumed.model === "string") modelOf.set(threadId, resumed.model)
    if (typeof resumed.reasoningEffort === "string") effortOf.set(threadId, resumed.reasoningEffort)
    conn.loaded.add(threadId)
  }

  // `forked`: the thread is a thread/fork of ctx.forkFrom, so the copy's history is already in it.
  async function openThread(conn: CodexConnection, ctx: AdapterContext): Promise<{ threadId: string; forked: boolean }> {
    if (ctx.nativeId) {
      await unloading.get(conn)?.get(ctx.nativeId)
      if (conn.loaded.has(ctx.nativeId) && ctx.permissionMode === "native" && permissionOf.get(ctx.nativeId) !== "native") {
        await unloadThread(conn, ctx.nativeId)
      }
      if (conn.loaded.has(ctx.nativeId)) {
        permissionOf.set(ctx.nativeId, ctx.permissionMode)
        return { threadId: ctx.nativeId, forked: false }
      }
      try {
        await resume(conn, ctx.nativeId, ctx)
        permissionOf.set(ctx.nativeId, ctx.permissionMode)
        return { threadId: ctx.nativeId, forked: false }
      } catch (error) {
        // The rollout is gone (deleted elsewhere): continue on a fresh thread instead of failing every turn.
        if (!isMissingThread(error)) throw error
      }
    } else if (ctx.forkFrom) {
      try {
        const forked = await conn.request<{ thread?: { id?: unknown }; model?: string; reasoningEffort?: string | null }>("thread/fork", {
          threadId: ctx.forkFrom,
          excludeTurns: true,
          ...threadSettings(ctx),
        })
        const threadId = forked.thread?.id
        if (typeof threadId === "string" && threadId) {
          conn.loaded.add(threadId)
          if (typeof forked.model === "string") modelOf.set(threadId, forked.model)
          if (typeof forked.reasoningEffort === "string") effortOf.set(threadId, forked.reasoningEffort)
          ctx.emit({ type: "native", nativeId: threadId })
          return { threadId, forked: true }
        }
      } catch (error) {
        // The source thread is gone or this app-server cannot fork: a fresh thread gets the transcript instead.
        if (!(error instanceof RpcError)) throw error
      }
    }
    const started = await conn.request<{ thread?: { id?: unknown }; model?: string; reasoningEffort?: string | null }>("thread/start", threadSettings(ctx))
    const threadId = started.thread?.id
    if (typeof threadId !== "string" || !threadId) throw new Error(`codex thread/start returned no thread id: ${JSON.stringify(started)}`)
    conn.loaded.add(threadId)
    if (typeof started.model === "string") modelOf.set(threadId, started.model)
    if (typeof started.reasoningEffort === "string") effortOf.set(threadId, started.reasoningEffort)
    permissionOf.set(threadId, ctx.permissionMode)
    ctx.emit({ type: "native", nativeId: threadId })
    return { threadId, forked: false }
  }

  return {
    spec: options.spec,
    async diagnostics(cwd, nativeId) {
      const conn = await server("other")
      return readCodexDiagnostics((method, params) => conn.request(method, params, 20_000), cwd,
        conn.configRoot ?? process.env.CODEX_HOME ?? join(homedir(), ".codex"), nativeId)
    },
    async listCommands(cwd) {
      const conn = await server("other")
      let response: unknown
      try {
        response = await conn.request("skills/list", { cwds: [cwd], forceReload: true })
      } catch (error) {
        if (error instanceof RpcError && (error.code === -32601 || /unknown variant|method not found/i.test(error.message))) {
          return codexCommands()
        }
        throw error
      }
      const invalid = () => new Error(`codex skills/list returned invalid metadata for ${cwd}`)
      if (!response || typeof response !== "object" || !("data" in response) || !Array.isArray(response.data)) throw invalid()
      const commands = new Map<string, AgentCommand>()
      for (const entry of response.data) {
        if (!entry || typeof entry !== "object" || !Array.isArray(entry.skills) || !Array.isArray(entry.errors)) throw invalid()
        for (const error of entry.errors) console.warn(`rudderd: codex skills/list ${cwd}: ${JSON.stringify(error)}`)
        for (const skill of entry.skills) {
          if (!skill || typeof skill !== "object" || typeof skill.name !== "string" || !skill.name ||
              typeof skill.description !== "string" || typeof skill.enabled !== "boolean" || typeof skill.scope !== "string" ||
              (skill.pluginId != null && typeof skill.pluginId !== "string")) throw invalid()
          if (!skill.enabled) continue
          const plugin = skill.pluginId?.split("@")[0]
          const name = plugin && !skill.name.startsWith(`${plugin}:`) ? `${plugin}:${skill.name}` : skill.name
          if (!commands.has(name)) commands.set(name, {
            name, insert: `$${name}`, kind: "skill", description: skill.description,
            source: plugin ? `plugin:${plugin}` : skill.scope === "repo" ? "project" : skill.scope === "user" ? "user" : "agent",
          })
        }
      }
      return [...commands.values()].sort((a, b) => a.name.localeCompare(b.name))
    },
    async reply(userText, ctx) {
      let terminalStatus: "completed" | "interrupted" = "completed"
      // A prompt (the user's, or a continuation) lifts a stop's quiet.
      quieted.delete(ctx.sessionId)
      ctx.emit({ type: "status", status: "running" })
      if (ctx.continuation?.delivery === "buffered") {
        // Opened for a subagent's held approval: answer what is held, send Codex no prompt.
        const threadId = threadOf.get(ctx.sessionId) ?? ctx.nativeId
        await Promise.all((threadId ? takeLate(threadId) : []).map((ask) => askLate(ask, ctx)))
        ctx.emit({ type: "replyDisposition", value: "not_applicable", nativeMessageIds: [] })
        ctx.emit({ type: "status", status: "idle" })
        ctx.emit({ type: "lifecycle", phase: "terminal", terminalStatus, pendingFinalization: false })
        return
      }
      let found!: (turn: CodexTurn | undefined) => void
      const pending = new Promise<CodexTurn | undefined>((resolve) => {
        found = resolve
      })
      sessionTurns.set(ctx.sessionId, pending)
      const owner = { forgotten: false }
      sessionSetups.set(ctx.sessionId, owner)
      let turn: CodexTurn | undefined
      try {
        // A cold start can take seconds; an abort ends the turn now and leaves the setup running for later turns.
        const setup = await unlessAborted(
          (async () => {
            try {
              const conn = await server("reply")
              const claims = setupClaims.get(conn) ?? new Map<string, { owner: { forgotten: boolean }; sessionId: string }>()
              setupClaims.set(conn, claims)
              // Claim a resumed native thread before suspension, including the gap before its turn is registered.
              const claim = { owner, sessionId: ctx.sessionId }
              if (ctx.nativeId) claims.set(ctx.nativeId, claim)
              let opened: { threadId: string; forked: boolean }
              try {
                opened = await openThread(conn, ctx)
              } catch (error) {
                if (ctx.nativeId) {
                  if (claims.get(ctx.nativeId)?.owner === owner) claims.delete(ctx.nativeId)
                  if (!claimedByAnother(conn, ctx.nativeId, owner)) await unloadThread(conn, ctx.nativeId)
                }
                throw error
              }
              const { threadId, forked } = opened
              if (threadId !== ctx.nativeId) claims.set(threadId, claim)
              if (owner.forgotten || sessionSetups.get(ctx.sessionId) !== owner || stopped || live?.conn !== conn) {
                if (!claimedByAnother(conn, threadId, owner)) await unloadThread(conn, threadId)
                return { conn, threadId, forked, discarded: true }
              }
              threadOf.set(ctx.sessionId, threadId)
              if (ctx.signal.aborted) restThread(conn, threadId)
              return { conn, threadId, forked, discarded: false }
            } finally {
              if (sessionSetups.get(ctx.sessionId) === owner) sessionSetups.delete(ctx.sessionId)
            }
          })(),
          ctx.signal,
        )
        if (!setup || setup.discarded || ctx.signal.aborted) {
          ctx.emit({ type: "text", id: `codex:${crypto.randomUUID()}:cancelled`, text: "Cancelled." })
        } else {
          const { conn, threadId, forked } = setup
          clearTimeout(idleTimers.get(threadId))
          idleTimers.delete(threadId)
          turn = new CodexTurn(conn, threadId, ctx, interruptGraceMs, catalogWindow, (method, params, id) => lateApproval(conn, threadId, method, params, id), modelOf.get(threadId), effortOf.get(threadId), options.openUrl ?? openExternalUrl)
          turns.set(threadId, turn)
          if (ctx.executionIdentity) owners.set(threadId, { ...ctx.executionIdentity, nativeSessionId: threadId })
          found(turn)
          // A prompt that starts first takes the subagent approvals held for this thread.
          for (const ask of takeLate(threadId)) {
            if (ask.conn === conn) ask.resolve(turn.approve(ask.method, ask.params, ask.requestId, true))
            else ask.resolve(NO_REPLY)
          }
          const text = ctx.forkFrom && !forked ? withCarryOver(userText, ctx.carryOver) : userText
          terminalStatus = await turn.run(text, async () => {
            conn.loaded.delete(threadId)
            await resume(conn, threadId, ctx)
          })
        }
      } finally {
        found(undefined)
        if (sessionTurns.get(ctx.sessionId) === pending) sessionTurns.delete(ctx.sessionId)
        if (turn && turns.get(turn.threadId) === turn) {
          turns.delete(turn.threadId)
          if (turn.conn.loaded.has(turn.threadId)) restThread(turn.conn, turn.threadId)
        }
      }
      ctx.emit({ type: "status", status: "idle" })
      ctx.emit({ type: "lifecycle", phase: "terminal", terminalStatus, pendingFinalization: false })
    },
    async steer(sessionId, text) {
      const turn = await sessionTurns.get(sessionId)
      // A turn whose turn/completed is in takes no steer: Codex would start a new turn from it, not join this one.
      if (!turn || !(await turn.started) || turn.ended || !turn.turnId) return false
      try {
        await turn.conn.request("turn/steer", {
          threadId: turn.threadId,
          expectedTurnId: turn.turnId,
          clientUserMessageId: crypto.randomUUID(),
          input: textInput(text),
        })
        return true
      } catch (error) {
        // Business errors (-32600) mean the turn it expected is no longer active.
        if (error instanceof RpcError) return false
        throw error
      }
    },
    async detect() {
      const binary = command[0]
      if (!binary || !Bun.which(binary)) return unavailable(phoneCopy.commandMissing(binary ?? "codex"))
      const conn = await server("other")
      const result = await conn.request<{ account: unknown; requiresOpenaiAuth: boolean }>("account/read", {})
      if (result.account || !result.requiresOpenaiAuth) return { available: true }
      return unavailable(phoneCopy.agentSignedOut("Codex", "codex login"))
    },
    async listModels() {
      const conn = await server("other")
      const models: AgentModel[] = []
      let cursor: string | null = null
      for (let page = 0; page < 20; page++) {
        const result: ModelPage = await conn.request<ModelPage>("model/list", cursor ? { cursor } : {})
        for (const model of result.data) {
          if (model.hidden) continue
          models.push({
            id: model.id,
            label: model.displayName || model.id,
            efforts: (model.supportedReasoningEfforts ?? []).map((effort) => effort.reasoningEffort),
            ...(model.defaultReasoningEffort ? { defaultEffort: model.defaultReasoningEffort } : {}),
            ...(model.isDefault ? { isDefault: true } : {}),
            ...(model.description ? { description: model.description } : {}),
            ...publishedSpeeds(model),
          })
        }
        cursor = result.nextCursor
        if (!cursor) break
      }
      return models
    },
    async limits() {
      const binary = command[0]
      if (!binary || !Bun.which(binary)) return undefined
      if (!rateLimits || Date.now() - rateLimits.at > RATE_LIMITS_TTL_MS) {
        rateRead ??= (async () => {
          const conn = await server("other")
          const read = await conn.request<RateLimitsRead>("account/rateLimits/read", { excludeResetCreditDetails: true }, RATE_LIMITS_TIMEOUT_MS)
          rateLimits = { buckets: rateLimitBuckets(read), at: Date.now() }
        })().finally(() => {
          rateRead = undefined
        })
        try {
          await rateRead
        } catch (error) {
          // Logged out, API-key login or an old server: keep what an earlier read saw, else report nothing.
          if (!rateLimits) {
            console.warn(`codex account/rateLimits/read failed: ${errorMessage(error)}`)
            return undefined
          }
        }
      }
      return rateLimits ? codexQuota(rateLimits.buckets) : undefined
    },
    forks: true,
    processes() {
      const conn = live?.conn
      if (!conn || conn.closed) return []
      const sessionIds = [...threadOf].filter(([, threadId]) => conn.loaded.has(threadId)).map(([sessionId]) => sessionId)
      return [{ agent: options.spec.id, pid: conn.pid, sessionIds, shared: true }]
    },
    // Session handoff P2a: interactive threads (cli / vscode), never Rudder's own (originator "rudder"), never one whose
    // folder is gone. A thread whose writer lock another process holds is loaded there and is only listed.
    async listExternal({ since, limit }) {
      if (!command[0] || !Bun.which(command[0])) throw new HandoffUnsupported("not_installed", `${command[0] ?? "codex"} is not installed`)
      const conn = await server("other")
      const kept: ListedThread[] = []
      let cursor: string | undefined
      for (let page = 0; page < HANDOFF_PAGES && kept.length < limit; page += 1) {
        const result = await conn.request<{ data?: ListedThread[]; nextCursor?: string | null }>("thread/list", {
          sourceKinds: ["cli", "vscode"],
          sortKey: "updated_at",
          limit: HANDOFF_PAGE,
          ...(cursor ? { cursor } : {}),
        })
        const threads = Array.isArray(result?.data) ? result.data : []
        let older = false
        for (const thread of threads) {
          if (typeof thread?.id !== "string" || typeof thread.cwd !== "string") continue
          if ((thread.updatedAt ?? 0) * 1000 < since) {
            older = true
            break
          }
          if (thread.originator === "rudder" || !existsSync(thread.cwd)) continue
          kept.push(thread)
          if (kept.length >= limit) break
        }
        cursor = typeof result?.nextCursor === "string" ? result.nextCursor : undefined
        if (older || !cursor) break
      }
      const holders = await (options.lockHolders ?? lsofLockHolders)(kept.map((thread) => thread.id)).catch((error: unknown) => {
        console.warn(`rudderd: codex thread lock check failed: ${errorMessage(error)}`)
        return new Map<string, number[]>()
      })
      return kept.map((thread): ExternalSession => {
        const elsewhere = (holders.get(thread.id) ?? []).some((pid) => pid !== conn.pid)
        const preview = thread.preview?.trim() || undefined
        return {
          nativeId: thread.id,
          title: thread.name?.trim() || preview?.split("\n")[0] || "",
          cwd: thread.cwd!,
          updatedAt: (thread.updatedAt ?? 0) * 1000,
          ...(preview ? { preview } : {}),
          ...(elsewhere ? { inUse: true } : {}),
        }
      })
    },
    // Reads the thread without loading it into this process (thread/items/list works on an unloaded thread).
    async readExternal(nativeId) {
      const conn = await server("other")
      // Checked again at import: the thread may have been opened since the list.
      const holders = await (options.lockHolders ?? lsofLockHolders)([nativeId]).catch(() => new Map<string, number[]>())
      if ((holders.get(nativeId) ?? []).some((pid) => pid !== conn.pid)) {
        throw Object.assign(new Error(`codex thread ${nativeId} is loaded by another process on this computer`), { code: "in_use" })
      }
      const entries: HistoryEntry[] = []
      const visited = new Set<string>()
      let cursor: string | undefined
      for (let page = 0; page < HISTORY_PAGES; page += 1) {
        const result = await conn.request<{ data?: Array<{ item?: ThreadItem }>; nextCursor?: string | null }>("thread/items/list", {
          threadId: nativeId,
          limit: HISTORY_PAGE,
          ...(cursor ? { cursor } : {}),
        })
        for (const entry of Array.isArray(result?.data) ? result.data : []) {
          if (entry?.item) entries.push(...codexHistoryEntries(nativeId, entry.item))
        }
        cursor = typeof result?.nextCursor === "string" ? result.nextCursor : undefined
        if (!cursor) return entries
        if (visited.has(cursor)) throw new Error(`codex thread/items/list repeated a cursor for ${nativeId}`)
        visited.add(cursor)
      }
      throw new Error(`codex thread ${nativeId} has more than ${HISTORY_PAGE * HISTORY_PAGES} items`)
    },
    // thread/revert (app-server 0.165) only works on a thread loaded in this process. The thread is unloaded after,
    // so the next turn resumes it with that turn's own settings.
    async rewind(sessionId, cut) {
      if (!cut.beforeTurnId || sessionTurns.has(sessionId)) return false
      const conn = await server("other")
      try {
        if (!conn.loaded.has(cut.nativeId)) await conn.request("thread/resume", { threadId: cut.nativeId, excludeTurns: true })
        await conn.request("thread/revert", { threadId: cut.nativeId, beforeTurnId: cut.beforeTurnId })
      } catch (error) {
        // An older app-server without thread/revert, a thread or turn it no longer has: the daemon carries over.
        if (error instanceof RpcError) return false
        throw error
      } finally {
        conn.loaded.delete(cut.nativeId)
        conn.totals.delete(cut.nativeId)
      }
      return true
    },
    setContinuationSink(sink) {
      continuationSink = sink
    },
    cancelContinuation(sessionId) {
      quieted.add(sessionId)
      // A stop drops held subagent approvals: the subagent is told no and stops.
      const threadId = threadOf.get(sessionId)
      if (threadId) for (const ask of takeLate(threadId)) ask.resolve({ decision: "cancel" })
    },
    forget(sessionId) {
      const setup = sessionSetups.get(sessionId)
      if (setup) setup.forgotten = true
      const threadId = threadOf.get(sessionId)
      threadOf.delete(sessionId)
      if (!threadId || !live) return
      void unloadThread(live.conn, threadId)
    },
    async dispose() {
      stopped = true
      const pending = replacing
      const conn = live?.conn
      live = undefined
      for (const timer of idleTimers.values()) clearTimeout(timer)
      idleTimers.clear()
      await conn?.dispose()
      if (!pending) return
      try {
        await pending
      } catch {
        // The recycle was abandoned because the adapter is stopping.
      }
      const late = currentConnection()
      live = undefined
      if (late && late !== conn) await late.dispose()
    },
  }
}

/** r48: the failures the phone draws a card for. The reset time comes from account/rateLimits (limits()). */
export function codexErrorInfo(error: CodexError | null | undefined): AgentErrorInfo | undefined {
  const raw = error?.codexErrorInfo
  const kind = typeof raw === "string" ? raw : raw && typeof raw === "object" ? Object.keys(raw)[0] : undefined
  if (kind === "usageLimitExceeded") return { code: "usage_limit" }
  if (kind === "unauthorized") return { code: "auth_required", command: loginCommand("codex") }
  return undefined
}
