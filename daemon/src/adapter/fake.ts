import { AgentError } from "./agent-error"
import { SKILLS } from "../workspace"
import { CLAUDE_MODES, capabilityModes } from "./modes"
import {
  sleep,
  type AdapterContext,
  type AgentAdapter,
  type AgentSpec,
  type PermissionOption,
  type QuestionItem,
  type TurnUsage,
} from "./types"

export const FAKE_NATIVE_PREFIX = "fake-native-"

export const FAKE_SPEC: AgentSpec = {
  id: "fake",
  label: "Fake",
  transport: "fake",
  experimental: false,
  capabilities: {
    reasoning: true,
    steer: false,
    interrupt: true,
    plan: false,
    question: true,
    usage: "both",
    models: "static",
    efforts: false,
    ...capabilityModes(CLAUDE_MODES.filter((mode) => ["ask", "acceptEdits", "plan"].includes(mode.id))),
  },
}

export const FAKE_PERMISSION_OPTIONS: PermissionOption[] = [
  { id: "allow_once", label: "Allow once", kind: "allow_once" },
  { id: "allow_always", label: "Always allow", kind: "allow_always" },
  { id: "reject_once", label: "Reject", kind: "reject_once" },
]

export function looksLikeCommand(text: string): boolean {
  return /(?:^|\s)(\$|run\b|bash\b|ls\b|write\b|edit\b|rm\b|mkdir\b|执行|运行|写入|删除)/i.test(text)
}

export function fakeCommand(text: string): string {
  if (/\bls\b|list files|列出/.test(text)) return "ls -la"
  if (/write|写入|edit/.test(text)) return "cat >/tmp/rudder-demo.txt"
  const clipped = text.replace(/^\$\s*/, "").slice(0, 80)
  return `echo ${JSON.stringify(clipped)}`
}

export function expandSkill(text: string): string {
  const match = text.match(/^\$(\w+)\s*(.*)$/)
  if (!match) return text
  const skill = SKILLS.find((entry) => entry.trigger === `$${match[1]}` || entry.id === match[1])
  if (!skill) return text
  const rest = match[2]?.trim() ?? ""
  return rest ? `${skill.detail}: ${rest}` : skill.detail
}

// Prefixes that make the fake agent ask (simulator checks of the question card, r46):
// ask / 提问 one single choice with "Other"; ask-many / 多题 three questions, the second multi-select;
// ask-strict / 限选 options only; ask-bare the options-only question without a header.
const QUESTION_PREFIX = /^(ask-many:|多题[:：]|ask-strict:|限选[:：]|ask-bare:|ask:|提问[:：])\s*/i

export type FakeQuestionKind = "single" | "many" | "strict" | "bare"

export function looksLikeQuestion(text: string): boolean {
  return QUESTION_PREFIX.test(text.trim())
}

export function questionKind(text: string): FakeQuestionKind {
  const prefix = text.trim().match(QUESTION_PREFIX)?.[1]?.toLowerCase() ?? ""
  if (prefix.startsWith("ask-many") || prefix.startsWith("多题")) return "many"
  if (prefix.startsWith("ask-strict") || prefix.startsWith("限选")) return "strict"
  if (prefix.startsWith("ask-bare")) return "bare"
  return "single"
}

export function questionPrompt(text: string): string {
  return text.trim().replace(QUESTION_PREFIX, "").trim() || "Choose an option"
}

const SINGLE_QUESTION: QuestionItem = {
  question: "会话缓存放在哪里？",
  header: "存储",
  options: [
    { label: "SQLite", description: "单文件，支持按会话查询，重启不丢" },
    { label: "内存", description: "最快，daemon 重启后清空" },
  ],
  multiSelect: false,
  allowsOther: true,
}

const STRICT_QUESTION: QuestionItem = {
  question: "旧快照怎么处理？",
  header: "保留",
  options: [
    { label: "保留 30 天", description: "每天一份，超过 30 天的删掉" },
    { label: "每周留一份", description: "30 天以前的只留每周日那份" },
    { label: "全部保留", description: "不删，只压缩" },
  ],
  multiSelect: false,
  allowsOther: false,
}

export function fakeQuestions(kind: FakeQuestionKind): QuestionItem[] {
  if (kind === "strict") return [STRICT_QUESTION]
  if (kind === "bare") {
    const { header: _header, ...bare } = STRICT_QUESTION
    return [bare]
  }
  if (kind === "many") {
    return [
      SINGLE_QUESTION,
      {
        question: "这次要补哪些测试？",
        header: "测试范围",
        options: [
          { label: "单元测试", description: "缓存读写和过期的边界条件" },
          { label: "集成测试", description: "真起一次 daemon，重启后再读" },
          { label: "压测", description: "1 万个会话的读写耗时" },
        ],
        multiSelect: true,
        allowsOther: true,
      },
      {
        question: "缓存改动怎么发布？",
        header: "发布",
        options: [
          { label: "直接合并", description: "测试过了就进 main" },
          { label: "先开开关", description: "默认关，手动打开试一周" },
        ],
        multiSelect: false,
        allowsOther: true,
      },
    ]
  }
  return [SINGLE_QUESTION]
}

// The long thought from the design (思考 ③): six paragraphs, more than 12 lines on a phone.
const FAKE_THOUGHT = [
  "先看 401 是从哪儿来的。refresh.ts 里刷新时机是 expiresAt − 60 秒，用的是手机本地时钟；服务端签发时用的是自己的时钟。两边差 30 秒左右，刷新就晚了，请求带着已经过期的 token 出去。",
  "日志里的 401 都集中在整点附近，正好是 token 一小时有效期的边界，和时钟差对得上。",
  "两种改法：一是把刷新提前到 90 秒，简单但只是掩盖；二是从响应头的 Date 算出服务端时钟偏移，刷新时间按服务端时间算。第二种更稳，偏移变了也能跟上。",
  "已经发出去的请求也要管：收到 401 时先刷新一次再重放原请求，只重放一次，免得死循环。",
  "所以顺序是：1) 加 clockOffset，每个响应的 Date 头都更新它；2) 刷新时间改成 expiresAt − 60 秒 − offset；3) 给 fetch 包一层，401 时刷新并重放一次。",
  "测试用假时钟补三条：偏移为正、偏移为负、401 后只重放一次。三条都过了再跑全量。",
].join("\n\n")

/** RUDDER_FAKE_THINK_MS stretches the thought so the simulator shows the timer; tests keep the 20 ms default. */
export function fakeThinkMs(raw = process.env.RUDDER_FAKE_THINK_MS): number {
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 && raw !== undefined && raw !== "" ? value : 20
}

/** RUDDER_FAKE_START_MS: how long the turn runs before its first step (default 0). */
export function fakeStartMs(raw = process.env.RUDDER_FAKE_START_MS): number {
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 && raw !== undefined && raw !== "" ? value : 0
}

export function createFakeAdapter(spec: AgentSpec = FAKE_SPEC): AgentAdapter {
  // Sessions where the user picked "Always allow"; the agent, not the daemon, enforces it.
  const alwaysAllowed = new Set<string>()
  return {
    spec,
    // The demo `$` skills it expands (workspace SKILLS), so the simulator has something to pick.
    async listCommands() {
      return SKILLS.map((skill) => ({ name: skill.id, insert: skill.trigger, kind: "skill" as const, description: skill.detail, source: "agent" }))
    },
    async reply(userText, ctx) {
      ctx.emit({ type: "status", status: "running" })
      ctx.emit({ type: "native", nativeId: ctx.nativeId ?? `${FAKE_NATIVE_PREFIX}${ctx.sessionId}` })
      const id = crypto.randomUUID()
      const failure = fakeFailure(userText)
      if (failure) throw failure
      const expanded = expandSkill(userText)
      // A real agent is quiet for a second or more before its first step (the 正在准备 row's time on screen).
      const quiet = fakeStartMs()
      if (quiet > 0) await sleep(quiet)
      await think(ctx, expanded)
      let sentence: string
      if (looksLikeQuestion(expanded)) sentence = await askFlow(ctx, expanded)
      else if (looksLikeCommand(expanded)) sentence = await commandFlow(ctx, expanded, alwaysAllowed)
      else sentence = `Fake Claude heard: ${expanded}`
      if (ctx.signal.aborted) ctx.emit({ type: "text", id, text: "Cancelled.", notice: true })
      else await streamWords(ctx, id, sentence)
      ctx.emit({ type: "usage", usage: fakeUsage(expanded, sentence) })
      ctx.emit({ type: "status", status: "idle" })
    },
  }
}

// r48 simulator checks of the error cards: fail-usage / fail-auth / fail-exit end the turn the way a real agent would.
export function fakeFailure(text: string): AgentError | undefined {
  const prefix = text.trim().toLowerCase()
  if (prefix.startsWith("fail-usage")) {
    return new AgentError("Claude AI usage limit reached", { code: "usage_limit", resetsAt: Date.now() + 3 * 3600_000 })
  }
  if (prefix.startsWith("fail-auth")) return new AgentError("Not logged in", { code: "auth_required", command: "codex login" })
  if (prefix.startsWith("fail-exit")) {
    const detail = "FATAL ERROR: Reached heap limit\nAllocation failed - JavaScript heap out of memory"
    return new AgentError(`Claude exited with code 1 before the turn finished: ${detail}`, { code: "agent_exited", exitCode: 1, detail })
  }
  return undefined
}

async function think(ctx: AdapterContext, text: string) {
  const id = crypto.randomUUID()
  const ms = fakeThinkMs()
  const startedAt = Date.now()
  const thought = ms > 20 ? FAKE_THOUGHT : `The user wrote "${text.slice(0, 60)}". Working out a reply.`
  // Streams in a few pieces over the whole duration, like a real agent's deltas.
  const pieces = ms > 20 ? 10 : 2
  for (let piece = 1; piece < pieces; piece++) {
    ctx.emit({ type: "reasoning", id, text: thought.slice(0, Math.ceil((thought.length * piece) / pieces)), done: false, startedAt })
    await sleep(ms / (pieces - 1))
    if (ctx.signal.aborted) break
  }
  ctx.emit({ type: "reasoning", id, text: thought, done: true, startedAt })
}

async function askFlow(ctx: AdapterContext, text: string): Promise<string> {
  const questions = fakeQuestions(questionKind(text))
  const answers = await ctx.askQuestion({ questions })
  if (!answers) return "Question cancelled."
  const values = questions.map((item) => {
    const answer = answers[item.question]
    return Array.isArray(answer) ? answer.join(", ") : answer
  })
  return `You answered: ${values.map((value) => value || "(empty)").join(" / ")}`
}

async function commandFlow(ctx: AdapterContext, text: string, alwaysAllowed: Set<string>): Promise<string> {
  const detail = fakeCommand(text)
  if (ctx.permissionMode === "plan") return `Plan mode: I would run \`${detail}\` but did not execute it.`
  const tool = { type: "tool", id: crypto.randomUUID(), tool: "Bash", title: "Run command", kind: "execute", detail } as const
  ctx.emit({ ...tool, status: "pending" })
  const already = ctx.allowsCommand ? ctx.allowsCommand(detail) : alwaysAllowed.has(ctx.sessionId)
  if (ctx.permissionMode !== "acceptEdits" && !already) {
    const choice = await ctx.askPermission({
      tool: tool.tool,
      title: tool.title,
      detail,
      kind: tool.kind,
      options: FAKE_PERMISSION_OPTIONS,
    })
    const option = FAKE_PERMISSION_OPTIONS.find((entry) => entry.id === choice)
    if (!option) {
      ctx.emit({ ...tool, status: "cancelled" })
      return "Cancelled."
    }
    if (option.kind === "reject_once" || option.kind === "reject_always") {
      ctx.emit({ ...tool, status: "declined" })
      return "Permission denied. I did not run the command."
    }
    if (option.kind === "allow_always" && !ctx.allowsCommand) alwaysAllowed.add(ctx.sessionId)
  }
  ctx.emit({ ...tool, status: "running" })
  await sleep(30)
  if (ctx.signal.aborted) {
    ctx.emit({ ...tool, status: "cancelled" })
    return "Cancelled."
  }
  ctx.emit({ ...tool, status: "completed", output: fakeOutput(detail), exitCode: 0 })
  return `Ran \`${detail}\`. Fake Claude heard: ${text}`
}

function fakeOutput(command: string): string {
  if (command === "ls -la") return "total 8\ndrwxr-xr-x  4 you  staff  128 .\n-rw-r--r--  1 you  staff   42 README.md"
  if (command.startsWith("echo ")) return String(JSON.parse(command.slice(5)))
  return ""
}

function fakeUsage(input: string, output: string): TurnUsage {
  const inputTokens = Math.max(1, Math.ceil(input.length / 4))
  const outputTokens = Math.max(1, Math.ceil(output.length / 4))
  return {
    inputTokens,
    outputTokens,
    costUsd: (inputTokens * 3 + outputTokens * 15) / 1_000_000,
    contextUsed: inputTokens + outputTokens,
    contextSize: 200_000,
  }
}

async function streamWords(ctx: AdapterContext, id: string, sentence: string) {
  const words = sentence.split(" ")
  let text = ""
  for (const word of words) {
    if (ctx.signal?.aborted) {
      ctx.emit({ type: "text", id, text: text ? `${text} (cancelled)` : "Cancelled.", notice: !text })
      return
    }
    text = text ? `${text} ${word}` : word
    ctx.emit({ type: "text", id, text })
    await sleep(40)
  }
}
