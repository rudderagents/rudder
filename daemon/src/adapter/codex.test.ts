import { closeSync, existsSync, ftruncateSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import { CODEX_PERMISSION_OPTIONS, codexPermissionOptions, createCodexAdapter, type CodexAdapterOptions } from "./codex"
import { BUILTIN_AGENTS } from "./index"
import type { AdapterContext, AgentAdapter, AgentEvent, PermissionRequest, QuestionRequest } from "./types"
import { callMatch } from "../v32"

const FIXTURES = join(import.meta.dir, "fixtures", "codex")
const FAKE_SERVER = join(FIXTURES, "fake-app-server.ts")
const SPEC = BUILTIN_AGENTS.find((entry) => entry.spec.id === "codex")!.spec
const WORKSPACE_WRITE = { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }

type Wire = { jsonrpc?: string; id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code: number; message: string } }
type LogEntry = { dir?: string; msg?: Wire; spawn?: number; exit?: number }
type ToolEvent = Extract<AgentEvent, { type: "tool" }>

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const step of cleanup.splice(0)) await step()
})

function replay(script: string, options: Partial<CodexAdapterOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "rudder-codex-"))
  const logPath = join(dir, "log.jsonl")
  const adapter = createCodexAdapter({ spec: SPEC, command: [process.execPath, FAKE_SERVER, join(FIXTURES, `${script}.jsonl`), logPath], ...options })
  cleanup.push(async () => {
    await adapter.dispose?.()
    rmSync(dir, { recursive: true, force: true })
  })
  const log = (): LogEntry[] =>
    existsSync(logPath)
      ? readFileSync(logPath, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as LogEntry)
      : []
  return { adapter, log }
}

function requests(log: LogEntry[], method: string) {
  return log.filter((entry) => entry.msg?.method === method).map((entry) => entry.msg!.params)
}

function answerTo(log: LogEntry[], id: number) {
  return log.find((entry) => entry.dir === "c2s" && entry.msg?.method === undefined && entry.msg?.id === id)?.msg
}

function context(overrides: Partial<AdapterContext> = {}, onEvent?: (event: AgentEvent) => void) {
  const events: AgentEvent[] = []
  const asked: PermissionRequest[] = []
  const abort = new AbortController()
  const ctx: AdapterContext = {
    sessionId: "s1",
    emit: (event) => {
      events.push(event)
      onEvent?.(event)
    },
    askPermission: async (request) => {
      asked.push(request)
      return null
    },
    askQuestion: async () => null,
    cwd: "/tmp/ws",
    permissionMode: "ask",
    signal: abort.signal,
    ...overrides,
  }
  return { ctx, events, asked, abort }
}

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVQI12P4z8AAAAADAAEABf4C/tzMWecAAAAASUVORK5CYII=",
  "base64",
)

const of = <T extends AgentEvent["type"]>(events: AgentEvent[], type: T) => events.filter((event) => event.type === type) as Extract<AgentEvent, { type: T }>[]
const toolStates = (events: AgentEvent[], id: string) => of(events, "tool").filter((event) => event.id === id)
const lastTool = (events: AgentEvent[], id: string) => toolStates(events, id).at(-1) as ToolEvent

async function waitFor(predicate: () => boolean, timeoutMs = 3000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out")
    await Bun.sleep(10)
  }
}

describe("codex adapter (offline replay)", () => {
  test.each(["final-snapshot", "final-dedup"])("authoritative final items recover and deduplicate: %s", async script => {
    const { adapter } = replay(script)
    const { ctx, events } = context()
    await adapter.reply("merge", ctx)
    expect(of(events, "text").filter(event => event.text === "MERGED_FINAL")).toHaveLength(1)
    expect(of(events, "replyDisposition")).toEqual([{ type: "replyDisposition", value: "present", nativeMessageIds: ["final"] }])
    expect(events.at(-1)).toMatchObject({ type: "lifecycle", phase: "terminal", pendingFinalization: false })
  })

  test("commentary alone stays absent instead of becoming a final action result", async () => {
    const { adapter } = replay("final-absent")
    const { ctx, events } = context()
    await adapter.reply("merge", ctx)
    expect(of(events, "replyDisposition")).toEqual([{ type: "replyDisposition", value: "absent", nativeMessageIds: [] }])
    expect(of(events, "text").map(event => event.text)).toEqual(["I will merge"])
  })

  test("notLoaded completion retains routing through the authoritative item read", async () => {
    const { adapter, log } = replay("final-read-drain")
    const { ctx, events } = context()
    await adapter.reply("merge", ctx)
    expect(of(events, "text").filter(event => event.text === "MERGED_FINAL")).toHaveLength(1)
    expect(requests(log(), "thread/items/list")).toEqual([{ threadId: "thr-compact", turnId: "turn-c1", limit: 100, sortDirection: "asc" }])
  })

  test("pipe close preserves a known terminal while local image storage drains", async () => {
    const { adapter } = replay("final-image-close")
    const events: AgentEvent[] = []
    const { ctx } = context({ emit: async event => {
      if (event.type === "image") await Bun.sleep(80)
      events.push(event)
    } })
    await adapter.reply("image", ctx)
    expect(of(events, "image")).toHaveLength(1)
    const closed = of(events, "lifecycle").find(event => event.transport === "closed")
    expect(closed).toMatchObject({ phase: "terminal", terminalStatus: "completed", pendingFinalization: true })
    expect(events.at(-1)).toMatchObject({ phase: "terminal", terminalStatus: "completed", pendingFinalization: false })
  })

  test("contextCompaction items become completed compaction events without token estimates", async () => {
    const { adapter } = replay("compaction")
    const first = context()
    await adapter.reply("Continue", first.ctx)
    expect(of(first.events, "compaction")).toEqual([
      { type: "compaction", id: "codex:thr-compact:compact-c1", state: "done", trigger: "auto" },
    ])
  })

  test("streams text, finalizes a failed command from aggregatedOutput, hides empty reasoning, sums usage per turn", async () => {
    const { adapter, log } = replay("basic")
    const first = context()
    await adapter.reply("Read hello.txt", first.ctx)

    expect(of(first.events, "native")).toEqual([{ type: "native", nativeId: "thr-basic" }])
    expect(of(first.events, "text").map((event) => [event.id, event.text])).toEqual([
      ["codex:thr-basic:msg_b1", "Reading "],
      ["codex:thr-basic:msg_b1", "Reading the file."],
      ["codex:thr-basic:msg_b2", "pelican"],
      ["codex:thr-basic:msg_b2", "pelican-42"],
    ])
    expect(of(first.events, "reasoning")).toEqual([])
    const command = "codex:thr-basic:exec-b1"
    expect(toolStates(first.events, command).map((event) => event.status)).toEqual(["running", "failed"])
    expect(lastTool(first.events, command)).toMatchObject({
      tool: "Shell",
      kind: "execute",
      detail: "cat hello.txt; ls /missing",
      output: "The secret word is: pelican-42\nls: /missing: No such file or directory\n",
      exitCode: 1,
    })
    // 3 model requests, last re-reported once: input excludes cached (95710 - 61312).
    expect(of(first.events, "usage")).toEqual([
      {
        type: "usage",
        usage: { inputTokens: 34398, outputTokens: 259, cacheReadTokens: 61312, cacheWriteTokens: 0, reasoningTokens: 88, contextUsed: 34154, contextSize: 258400 },
      },
    ])

    const second = context({ nativeId: "thr-basic" })
    await adapter.reply("Again", second.ctx)
    expect(of(second.events, "native")).toEqual([])
    expect(of(second.events, "text").at(-1)).toMatchObject({ id: "codex:thr-basic:msg_b3", text: "pelican-42" })
    expect(of(second.events, "usage")[0]?.usage).toEqual({
      inputTokens: 7062,
      outputTokens: 8,
      cacheReadTokens: 33920,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      contextUsed: 40990,
      contextSize: 258400,
    })

    const wire = log()
    expect(wire.filter((entry) => entry.spawn !== undefined)).toHaveLength(1)
    expect(requests(wire, "initialize")[0]).toMatchObject({
      clientInfo: { name: "rudder" },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: expect.arrayContaining([
          "mcpServer/startupStatus/updated",
          "hook/started",
          "turn/diff/updated",
          "item/commandExecution/outputDelta",
          "item/fileChange/outputDelta",
        ]),
      },
    })
    expect(requests(wire, "thread/start")).toEqual([{ cwd: "/tmp/ws", approvalPolicy: "untrusted", approvalsReviewer: "user", sandbox: "workspace-write" }])
    expect(requests(wire, "thread/resume")).toEqual([])
    const turns = requests(wire, "turn/start")
    expect(turns).toHaveLength(2)
    expect(turns[0]).toEqual({
      collaborationMode: { mode: "default", settings: { model: "gpt-6-luna", reasoning_effort: "low", developer_instructions: null } },
      threadId: "thr-basic",
      input: [{ type: "text", text: "Read hello.txt", text_elements: [] }],
      cwd: "/tmp/ws",
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandboxPolicy: WORKSPACE_WRITE,
      summary: "detailed",
    })
    // Unknown server request: answered with a JSON-RPC error so the turn does not hang.
    expect(answerTo(wire, 0)?.error).toMatchObject({ code: -32601, message: expect.stringContaining("item/tool/call") })
  })

  test("an image is a localImage next to the text", async () => {
    const { adapter, log } = replay("basic")
    const { ctx } = context({ images: [{ path: "/tmp/shot.png", mediaType: "image/png", bytes: 4 }] })
    await adapter.reply("look", ctx)
    expect(requests(log(), "turn/start")[0]?.input).toEqual([
      { type: "text", text: "look", text_elements: [] },
      { type: "localImage", path: "/tmp/shot.png" },
    ])
  })

  async function imageReplay(prepare: (dir: string) => { png: string; cwd?: string }) {
    const dir = mkdtempSync(join(tmpdir(), "rudder-codex-img-"))
    const { png, cwd } = prepare(dir)
    const textPath = join(dir, "note.txt")
    const hugePath = join(dir, "huge.bin")
    writeFileSync(textPath, "hello")
    writeFileSync(hugePath, "")
    const scriptPath = join(dir, "image.jsonl")
    const logPath = join(dir, "log.jsonl")
    writeFileSync(
      scriptPath,
      readFileSync(join(FIXTURES, "image.jsonl"), "utf8").replaceAll("SAVED_PNG", png).replaceAll("SAVED_TEXT", textPath).replaceAll("SAVED_HUGE", hugePath),
    )
    const adapter = createCodexAdapter({ spec: SPEC, command: [process.execPath, FAKE_SERVER, scriptPath, logPath] })
    cleanup.push(async () => {
      await adapter.dispose?.()
      rmSync(dir, { recursive: true, force: true })
    })
    const { ctx, events } = context({ cwd: cwd ?? dir })
    await adapter.reply("做一张海报", ctx)
    return of(events, "image").map((event) => event.id)
  }

  test("a savedPath that is a symlink, or outside the session and Codex image folders, is not read", async () => {
    const secret = mkdtempSync(join(tmpdir(), "rudder-codex-secret-"))
    cleanup.push(() => rmSync(secret, { recursive: true, force: true }))
    const target = join(secret, "id_rsa.png")
    writeFileSync(target, PNG_1X1)
    // A symlink inside the session folder: refused, and it does not fall back to `result`.
    expect(
      await imageReplay((dir) => {
        symlinkSync(target, join(dir, "poster.png"))
        return { png: join(dir, "poster.png") }
      }),
    ).toEqual(["codex:thr-img:img-b64"])
    // A real image in another folder: never opened.
    expect(await imageReplay(() => ({ png: target }))).toEqual(["codex:thr-img:img-b64"])
  })

  test("imageGeneration emits only real png or jpeg bytes, in completion order", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rudder-codex-img-"))
    const pngPath = join(dir, "launch-poster.png")
    const textPath = join(dir, "note.txt")
    const hugePath = join(dir, "huge.bin")
    writeFileSync(pngPath, PNG_1X1)
    writeFileSync(textPath, "hello")
    const huge = openSync(hugePath, "w")
    ftruncateSync(huge, 50 * 1024 * 1024 + 1)
    closeSync(huge)
    const scriptPath = join(dir, "image.jsonl")
    const logPath = join(dir, "log.jsonl")
    writeFileSync(
      scriptPath,
      readFileSync(join(FIXTURES, "image.jsonl"), "utf8").replaceAll("SAVED_PNG", pngPath).replaceAll("SAVED_TEXT", textPath).replaceAll("SAVED_HUGE", hugePath),
    )
    const adapter = createCodexAdapter({ spec: SPEC, command: [process.execPath, FAKE_SERVER, scriptPath, logPath] })
    cleanup.push(async () => {
      await adapter.dispose?.()
      rmSync(dir, { recursive: true, force: true })
    })
    const { ctx, events } = context({ cwd: dir })
    await adapter.reply("做一张海报", ctx)
    const images = of(events, "image")
    expect(images.map((event) => event.id)).toEqual(["codex:thr-img:img-file", "codex:thr-img:img-b64"])
    expect(images[0]).toMatchObject({ name: "launch-poster.png", mediaType: "image/png", width: 1, height: 1 })
    expect(images[0]?.bytes).toEqual(new Uint8Array(PNG_1X1))
    expect(images[1]).toMatchObject({ name: "image.png", mediaType: "image/png", width: 1, height: 1 })
    expect(of(events, "text").at(-1)?.text).toBe("做好了。")
    expect(of(events, "tool")).toEqual([])
  })

  test("reasoning summary parts stream and close; model and effort pass through", async () => {
    const { adapter, log } = replay("reasoning")
    const { ctx, events } = context({ model: "gpt-6.1-sol", effort: "high" })
    const before = Date.now()
    await adapter.reply("Solve it", ctx)
    const reasoning = of(events, "reasoning")
    // item/started is the start signal; summaries arrive later but keep that moment.
    const startedAt = reasoning[0]!.startedAt!
    expect(startedAt).toBeGreaterThanOrEqual(before)
    expect(reasoning.every((event) => event.startedAt === startedAt)).toBe(true)
    expect(reasoning.map((event) => [event.text, event.done])).toEqual([
      ["**Calculating**\n\nI", false],
      ["**Calculating**\n\nI solve n mod 7.", false],
      ["**Calculating**\n\nI solve n mod 7.\n\nThen n = 269.", false],
      ["**Calculating**\n\nI solve n mod 7.\n\nThen n = 269.", true],
    ])
    expect(new Set(reasoning.map((event) => event.id))).toEqual(new Set(["codex:thr-reason:rs_r1"]))
    expect(of(events, "usage")[0]?.usage).toMatchObject({ reasoningTokens: 70, contextSize: 475000 })
    expect(requests(log(), "thread/start")[0]).toMatchObject({ model: "gpt-6.1-sol" })
    expect(requests(log(), "turn/start")[0]).toMatchObject({ model: "gpt-6.1-sol", effort: "high", summary: "detailed" })
    expect(requests(log(), "turn/start")[0]).not.toHaveProperty("serviceTier")
  })

  test("a catalog window replaces the 95% modelContextWindow", async () => {
    const { adapter } = replay("reasoning", { catalogWindow: (model) => (model === "gpt-6.1-sol" ? 500_000 : undefined) })
    const { ctx, events } = context({ model: "gpt-6.1-sol" })
    await adapter.reply("Solve it", ctx)
    expect(of(events, "usage")[0]?.usage.contextSize).toBe(500_000)
  })

  test("a chosen service tier is sent on every turn/start", async () => {
    const { adapter, log } = replay("reasoning")
    const { ctx } = context({ model: "gpt-6.1-sol", speed: "priority" })
    await adapter.reply("Solve it", ctx)
    expect(requests(log(), "turn/start")[0]).toMatchObject({ serviceTier: "priority" })
  })

  test("keeps structured options from an async Codex message after its text delta", async () => {
    const { adapter } = replay("async-question")
    const run = context()
    await adapter.reply("Choose a record", run.ctx)
    const texts = of(run.events, "text")
    expect(texts.at(-2)).toMatchObject({
      id: "codex:thr-async-question:ask-1",
      replyChoices: ["Keep both (Recommended)", "Keep one"],
    })
    expect(texts.at(-1)).toMatchObject({ id: "codex:thr-async-question:follow-up", text: "I am ready to continue." })
  })

  // Plan 2026-11-17-agent-questions Task 2 (shapes from recorded/ask-default.jsonl and recorded/elicit-form.jsonl).
  test("request_user_input asks the option question; a secret one is never shown and answered empty", async () => {
    const { adapter, log } = replay("user-input")
    const asked: QuestionRequest[] = []
    const run = context({
      askQuestion: async (request) => {
        asked.push(request)
        return { [request.questions[0]!.question]: "Red" }
      },
    })
    await adapter.reply("ask", run.ctx)
    expect(asked).toHaveLength(1)
    expect(asked[0]!.questions).toEqual([
      { question: "Which color do you prefer: red or blue?", header: "Color", multiSelect: false, allowsOther: true,
        options: [{ label: "Red", description: "Choose red." }, { label: "Blue", description: "Choose blue." }] },
    ])
    expect(answerTo(log(), 0)?.result).toEqual({ answers: { color_choice: { answers: ["Red"] }, token: { answers: [] } } })
    expect(of(run.events, "text").some((event) => event.notice && event.text.includes("Paste your deploy token"))).toBe(true)
  })

  test("request_user_input with no answer (a stop) answers every question empty", async () => {
    const { adapter, log } = replay("user-input")
    await adapter.reply("ask", context({ askQuestion: async () => null }).ctx)
    expect(answerTo(log(), 0)?.result).toEqual({ answers: { color_choice: { answers: [] }, token: { answers: [] } } })
  })

  test("an MCP tool approval is a permission card; the form after it is a question card", async () => {
    const { adapter, log } = replay("mcp-elicit")
    const permissions: PermissionRequest[] = []
    const run = context({
      askPermission: async (request) => {
        permissions.push(request)
        return "accept"
      },
      askQuestion: async (request) => ({ [request.questions[0]!.question]: ["cheese", "olive"], [request.questions[1]!.question]: "Large" }),
    })
    await adapter.reply("order", run.ctx)
    expect(permissions[0]).toMatchObject({ tool: "mcp__probe__order_pizza", title: "Allow the probe MCP server to run tool \"order_pizza\"?" })
    expect(answerTo(log(), 0)?.result).toEqual({ action: "accept", content: {}, _meta: null })
    expect(answerTo(log(), 1)?.result).toEqual({ action: "accept", content: { toppings: ["cheese", "olive"], size: "l" }, _meta: null })
  })

  test("a declined MCP approval and an unanswered form decline and cancel", async () => {
    const { adapter, log } = replay("mcp-elicit")
    await adapter.reply("order", context({ askPermission: async () => "decline", askQuestion: async () => null }).ctx)
    expect(answerTo(log(), 0)?.result).toEqual({ action: "decline", content: null, _meta: null })
    expect(answerTo(log(), 1)?.result).toEqual({ action: "cancel", content: null, _meta: null })
  })

  test("an unsupported form is declined while unanswered URL consent is cancelled", async () => {
    const { adapter, log } = replay("mcp-elicit-odd")
    const asked: QuestionRequest[] = []
    const run = context({ askQuestion: async (request) => {
      asked.push(request)
      return null
    } })
    await adapter.reply("odd", run.ctx)
    expect(asked).toHaveLength(1)
    expect(asked[0]?.questions[0]?.question).toContain("https://example.com/auth")
    expect(answerTo(log(), 0)?.result).toEqual({ action: "decline", content: null, _meta: null })
    expect(answerTo(log(), 1)?.result).toEqual({ action: "cancel", content: null, _meta: null })
    expect(of(run.events, "text").filter((event) => event.notice && event.text.includes("probe"))).toHaveLength(1)
  })

  // Final review fixes (plan 2026-11-17-agent-questions).
  test("questions with the same text stay apart; a question with no options can always be typed", async () => {
    const { adapter, log } = replay("user-input-edge")
    const asked: QuestionRequest[] = []
    await adapter.reply("edge", context({
      askQuestion: async (request) => {
        asked.push(request)
        return { [request.questions[0]!.question]: "typed", [request.questions[1]!.question]: "A" }
      },
    }).ctx)
    const [first, second] = asked[0]!.questions
    expect(first!.question).not.toBe(second!.question)
    expect(first!.allowsOther).toBe(true)
    expect(answerTo(log(), 0)?.result).toEqual({ answers: { first: { answers: ["typed"] }, second: { answers: ["A"] } } })
  })

  test("an empty form that is not an MCP tool approval is a plain yes / no with no session rule", async () => {
    const { adapter, log } = replay("mcp-confirm")
    const permissions: PermissionRequest[] = []
    await adapter.reply("confirm", context({
      askPermission: async (request) => {
        permissions.push(request)
        return "accept"
      },
    }).ctx)
    expect(permissions[0]).toMatchObject({ title: "Proceed with the deploy?" })
    expect(permissions[0]!.match).toBeUndefined()
    expect(permissions[0]!.options.map((option) => option.kind)).toEqual(["allow_once", "reject_once"])
    expect(answerTo(log(), 0)?.result).toEqual({ action: "accept", content: {}, _meta: null })
  })

  test("Rudder's notices about questions it cannot show carry phone copy", async () => {
    const odd = replay("mcp-elicit-odd")
    const run = context({ askQuestion: async () => null })
    await odd.adapter.reply("odd", run.ctx)
    const secret = replay("user-input")
    const asked = context({ askQuestion: async () => null })
    await secret.adapter.reply("ask", asked.ctx)
    const codes = [...of(run.events, "text"), ...of(asked.events, "text")].filter((event) => event.notice).map((event) => event.copy?.code)
    expect(codes).toEqual(["mcp_form_unsupported", "question_secret_skipped"])
  })

  test("the built-in Codex command turns on request_user_input outside plan mode", () => {
    expect(BUILTIN_AGENTS.find((entry) => entry.spec.id === "codex")!.command).toEqual(["codex", "app-server", "-c", "features.default_mode_request_user_input=true"])
  })

  test.each([
    ["acceptEdits", "on-request", "workspace-write", WORKSPACE_WRITE],
    ["plan", "untrusted", "read-only", { type: "readOnly", networkAccess: false }],
    ["fullAccess", "never", "danger-full-access", { type: "dangerFullAccess" }],
    // An id Codex does not have falls back to asking, never to more access.
    ["bypassPermissions", "untrusted", "workspace-write", WORKSPACE_WRITE],
  ] as const)("permission mode %s is sent explicitly on thread and turn", async (mode, approvalPolicy, sandbox, sandboxPolicy) => {
    const { adapter, log } = replay("reasoning")
    await adapter.reply("x", context({ permissionMode: mode }).ctx)
    expect(requests(log(), "thread/start")[0]).toMatchObject({ approvalPolicy, sandbox, approvalsReviewer: "user" })
    expect(requests(log(), "turn/start")[0]).toMatchObject({ approvalPolicy, sandboxPolicy, approvalsReviewer: "user" })
  })

  test("a subagent thread's approval is asked on the turn that spawned it", async () => {
    const { adapter, log } = replay("subagent-approval")
    const run = context({
      askPermission: async (request) => {
        run.asked.push(request)
        return "accept"
      },
    })
    await adapter.reply("Check with a subagent", run.ctx)
    expect(run.asked).toHaveLength(1)
    expect(run.asked[0]).toMatchObject({ tool: "Shell", kind: "execute", detail: "bun test", title: "Run the tests" })
    // The child's item ids are not cards on this thread.
    expect(run.asked[0]!.toolId).toBeUndefined()
    expect(answerTo(log(), 0)).toEqual({ jsonrpc: "2.0", id: 0, result: { decision: "accept" } })
  })

  test("after the parent turn, only a direct subagent's end offers a continuation, never a grandchild's", async () => {
    const { adapter } = replay("subagent-late")
    const offers: import("./types").ContinuationOffer[] = []
    adapter.setContinuationSink!((offer) => offers.push(offer) > 0)
    await adapter.reply("Check with a subagent", context({ executionIdentity: { sessionId: "rudder-1", turnId: "t1", generation: 0, agentId: "codex" } }).ctx)
    const deadline = Date.now() + 2000
    while (offers.length === 0 && Date.now() < deadline) await Bun.sleep(10)
    await Bun.sleep(50)
    expect(offers.map((offer) => [offer.key, offer.detail, offer.delivery])).toEqual([["thr-child", "Subagent finished:\nCHILD", "message_text"]])
  })

  test("a subagent that ends during a later turn of its parent's thread offers a continuation, not a silent drop", async () => {
    // Frame shapes from recorded/wake-child.jsonl (codex 0.169): the child's end only reaches its own thread; the
    // parent thread gets no item or turn for it.
    const { adapter } = replay("subagent-other-turn")
    const offers: import("./types").ContinuationOffer[] = []
    adapter.setContinuationSink!((offer) => offers.push(offer) > 0)
    const identity = (turnId: string) => ({ sessionId: "rudder-1", turnId, generation: 0, agentId: "codex" })
    await adapter.reply("Spawn and end", context({ executionIdentity: identity("t1") }).ctx)
    expect(offers).toEqual([])
    const second = context({ nativeId: "thr-other", executionIdentity: identity("t2") })
    await adapter.reply("Something else", second.ctx)
    await Bun.sleep(50)
    expect(offers.map((offer) => [offer.key, offer.detail, offer.delivery, offer.identity.nativeSessionId])).toEqual([
      ["thr-other-child", "Subagent finished:\nCHILD_DONE", "message_text", "thr-other"],
    ])
    // The child's words are not the second turn's reply, and it draws no card of its own there.
    expect(of(second.events, "text").map((event) => event.text)).toEqual(["Second answer."])
    expect(second.events.filter((event) => event.type === "tool")).toEqual([])
  })

  test("a subagent that ends inside its parent's turn fills the card and offers nothing", async () => {
    const { adapter } = replay("subagent-result")
    const offers: unknown[] = []
    adapter.setContinuationSink!((offer) => offers.push(offer) > 0)
    await adapter.reply("Check with a subagent", context({ executionIdentity: { sessionId: "rudder-1", turnId: "t1", generation: 0, agentId: "codex" } }).ctx)
    await Bun.sleep(50)
    expect(offers).toEqual([])
  })

  test("a spawned subagent shows as an Agent card that ends with the subagent's own final message", async () => {
    const { adapter } = replay("subagent-result")
    const run = context()
    await adapter.reply("Check with a subagent", run.ctx)
    const cards = run.events.filter((event) => event.type === "tool" && event.tool === "Agent")
    expect(cards.length).toBeGreaterThan(0)
    expect(cards[0]).toMatchObject({ title: "check the tests", detail: "check the tests\nthoroughly", kind: "other" })
    expect(cards.at(-1)).toMatchObject({ status: "completed", output: "CHILD REPORT: 3 failures" })
    // The child's message is the card's, not a second reply on the parent thread.
    expect(run.events.filter((event) => event.type === "text").map((event) => event.text)).toEqual(["Parent summary"])
  })

  test.each([
    ["accept", "accept", "completed"],
    ["acceptForSession", "acceptForSession", "completed"],
    ["decline", "decline", "declined"],
    ["cancel", "cancel", "declined"],
    [null, "cancel", "declined"],
  ] as const)("command approval choice %p answers decision %p", async (choice, decision, finalStatus) => {
    const { adapter, log } = replay("approval")
    const statusAtAsk: string[] = []
    const run = context({
      askPermission: async (request) => {
        run.asked.push(request)
        statusAtAsk.push(lastTool(run.events, "codex:thr-approve:exec-a1").status)
        return choice
      },
    })
    await adapter.reply("Run echo hi", run.ctx)

    expect(run.asked).toHaveLength(1)
    expect(run.asked[0]).toMatchObject({ tool: "Shell", kind: "execute", detail: "echo hi", title: "Run command" })
    // An always-allow rule covers this command in this directory only.
    expect(run.asked[0]!.match).toBe(callMatch("Shell", { command: "/bin/zsh -lc 'echo hi'", cwd: "/tmp/ws" }))
    expect(run.asked[0]!.match).not.toBe(callMatch("Shell", { command: "/bin/zsh -lc 'echo hi'", cwd: "/elsewhere" }))
    // toolId is the id of the command's tool card (namespaced by thread).
    expect(run.asked[0]!.toolId).toBe("codex:thr-approve:exec-a1")
    expect(run.asked[0]!.options).toEqual(CODEX_PERMISSION_OPTIONS)
    // acceptForSession covers this command only, and the label says so.
    expect(run.asked[0]!.options.find((option) => option.id === "acceptForSession")?.label).toBe("本会话允许这条命令")
    expect(statusAtAsk).toEqual(["pending"])
    expect(answerTo(log(), 0)).toEqual({ jsonrpc: "2.0", id: 0, result: { decision } })
    const tool = lastTool(run.events, "codex:thr-approve:exec-a1")
    expect(tool.status).toBe(finalStatus)
    if (finalStatus === "completed") expect(tool).toMatchObject({ output: "hi\n", exitCode: 0 })
    const texts = of(run.events, "text").map((event) => event.text)
    expect(texts).toEqual(decision === "cancel" ? ["Cancelled."] : ["Output: hi"])
  })

  test("serverRequest/resolved withdraws the card and the request is not answered", async () => {
    const { adapter, log } = replay("withdraw")
    let finished = false
    let withdrawnWhileRunning = false
    const run = context({
      askPermission: (_request, withdraw) =>
        new Promise((resolve) =>
          withdraw?.addEventListener("abort", () => {
            withdrawnWhileRunning = !finished
            resolve(null)
          }),
        ),
    })
    await adapter.reply("Run echo hi", run.ctx)
    finished = true
    await Bun.sleep(50)
    expect(withdrawnWhileRunning).toBe(true)
    expect(answerTo(log(), 0)).toBeUndefined()
    expect(lastTool(run.events, "codex:thr-withdraw:exec-w1").status).toBe("cancelled")
    expect(of(run.events, "text").map((event) => event.text)).toEqual(["Cancelled."])
  })

  test.each([
    ["accept", "completed"],
    ["decline", "declined"],
  ] as const)("file change approval %s carries the diffs of the earlier fileChange item", async (decision, finalStatus) => {
    const { adapter, log } = replay("filechange")
    const run = context({
      permissionMode: "acceptEdits",
      askPermission: async (request) => {
        run.asked.push(request)
        return decision
      },
    })
    await adapter.reply("Create note.txt", run.ctx)
    const diffs = [
      { path: "/tmp/ws/note.txt", newText: "hello from codex.\n" },
      { path: "/tmp/ws/old.txt", patch: "@@ -1 +1,2 @@\n hello\n+second line\n" },
    ]
    expect(run.asked[0]).toMatchObject({ tool: "Edit", kind: "edit", detail: "/tmp/ws/note.txt\n/tmp/ws/old.txt", diffs })
    expect(run.asked[0]!.options.map((option) => option.id)).toEqual(["accept", "acceptForSession", "decline", "cancel"])
    // On a file change it covers the same files.
    expect(run.asked[0]!.options.find((option) => option.id === "acceptForSession")?.label).toBe("本会话允许改这些文件")
    expect(answerTo(log(), 0)).toEqual({ jsonrpc: "2.0", id: 0, result: { decision } })
    expect(lastTool(run.events, "codex:thr-edit:exec-f1")).toMatchObject({ status: finalStatus, diffs })
  })

  test("interrupt sends turn/interrupt, cancels the running tool and keeps partial text", async () => {
    const { adapter, log } = replay("interrupt")
    const run = context({}, (event) => {
      if (event.type === "tool" && event.status === "running") run.abort.abort()
    })
    await adapter.reply("sleep 30", run.ctx)
    expect(requests(log(), "turn/interrupt")).toEqual([{ threadId: "thr-int", turnId: "turn-i1" }])
    expect(lastTool(run.events, "codex:thr-int:exec-i1").status).toBe("cancelled")
    expect(of(run.events, "text").map((event) => event.text)).toEqual(["Running sleep 30"])
    expect(of(run.events, "usage")).toHaveLength(1)
  })

  test("an unanswered interrupt asks thread/read; an idle thread ends the turn as interrupted", async () => {
    const { adapter, log } = replay("interrupt-silent", { interruptGraceMs: 100 })
    const run = context({}, (event) => {
      if (event.type === "tool" && event.status === "running") run.abort.abort()
    })
    const started = Date.now()
    await adapter.reply("sleep 30", run.ctx)
    expect(Date.now() - started).toBeLessThan(2000)
    expect(requests(log(), "thread/read")).toEqual([{ threadId: "thr-silent" }])
    expect(lastTool(run.events, "codex:thr-silent:exec-q1").status).toBe("cancelled")
    expect(of(run.events, "text").map((event) => event.text)).toEqual(["Cancelled."])
  })

  test("an unanswered interrupt on a thread thread/read reports active waits for the thread's idle", async () => {
    // The fixture sends idle 400 ms after thread/read. A synthesized end at the grace would let the next turn/start
    // steer the still-running turn.
    const { adapter, log } = replay("interrupt-active", { interruptGraceMs: 100 })
    const run = context({}, (event) => {
      if (event.type === "tool" && event.status === "running") run.abort.abort()
    })
    const started = Date.now()
    await adapter.reply("sleep 30", run.ctx)
    expect(Date.now() - started).toBeGreaterThanOrEqual(450)
    expect(requests(log(), "thread/read")).toEqual([{ threadId: "thr-busy" }])
    expect(lastTool(run.events, "codex:thr-busy:exec-q1").status).toBe("cancelled")
  })

  test("turn/completed while the thread is still active waits for its idle", async () => {
    const { adapter } = replay("completed-active")
    const run = context()
    const started = Date.now()
    await adapter.reply("go", run.ctx)
    expect(Date.now() - started).toBeGreaterThanOrEqual(350)
    expect(of(run.events, "text").map((event) => event.text)).toEqual(["done"])
    expect(run.events.at(-1)).toMatchObject({ type: "lifecycle", phase: "terminal", terminalStatus: "completed", pendingFinalization: false })
  })

  test("a turn whose turn/completed is in refuses a steer", async () => {
    const { adapter, log } = replay("completed-active")
    let steered: Promise<boolean> | undefined
    const run = context({}, (event) => {
      if (event.type === "lifecycle" && event.phase === "terminal" && !steered) steered = adapter.steer!("s1", "one more")
    })
    await adapter.reply("go", run.ctx)
    expect(await Promise.race([steered!, Bun.sleep(1000).then(() => "hung" as const)])).toBe(false)
    expect(requests(log(), "turn/steer")).toEqual([])
  })

  test("a turn Codex starts on the thread before going idle is adopted, not dropped", async () => {
    const { adapter } = replay("continue-adopt")
    const run = context()
    await adapter.reply("go", run.ctx)
    expect(of(run.events, "text").map((event) => event.text)).toEqual(["first", "second"])
    expect(of(run.events, "nativeTurn").map((event) => event.turnId)).toEqual(["turn-c1", "turn-c2"])
    expect(of(run.events, "replyDisposition")).toEqual([{ type: "replyDisposition", value: "present", nativeMessageIds: ["msg_c1", "msg_c2"] }])
    expect(run.events.at(-1)).toMatchObject({ type: "lifecycle", phase: "terminal", terminalStatus: "completed", pendingFinalization: false })
  })

  test("a subagent's approval after its parent's turn opens a continuation and is asked, not cancelled", async () => {
    const { adapter, log } = replay("subagent-late-approval")
    const offers: import("./types").ContinuationOffer[] = []
    adapter.setContinuationSink!((offer) => offers.push(offer) > 0)
    const identity = { sessionId: "s1", turnId: "t1", generation: 0, agentId: "codex" }
    await adapter.reply("Check with a subagent", context({ executionIdentity: identity }).ctx)
    await waitFor(() => offers.length === 1)
    expect(offers[0]).toMatchObject({ key: "approval:thr-child:0", delivery: "buffered", detail: "Subagent asks to run: sleep 20 && echo CHILD_DONE" })
    expect(answerTo(log(), 0)).toBeUndefined()
    const asked: PermissionRequest[] = []
    const later = context({
      executionIdentity: { ...identity, turnId: "t2" },
      nativeId: "thr-sub",
      continuation: { key: offers[0]!.key, delivery: "buffered" },
      askPermission: async (request) => {
        asked.push(request)
        return "accept"
      },
    })
    await adapter.reply(offers[0]!.detail, later.ctx)
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ tool: "Shell", kind: "execute", detail: "sleep 20 && echo CHILD_DONE" })
    expect(asked[0]!.toolId).toBeUndefined()
    await waitFor(() => answerTo(log(), 0) !== undefined)
    expect(answerTo(log(), 0)).toEqual({ jsonrpc: "2.0", id: 0, result: { decision: "accept" } })
    // Nothing was sent to Codex for the continuation itself; the child's end then wakes the parent as before.
    expect(requests(log(), "turn/start")).toHaveLength(1)
    expect(of(later.events, "replyDisposition")).toEqual([{ type: "replyDisposition", value: "not_applicable", nativeMessageIds: [] }])
    await waitFor(() => offers.length === 2)
    expect(offers[1]).toMatchObject({ key: "thr-child", delivery: "message_text", detail: "Subagent finished:\nCHILD_DONE" })
  })

  test("a subagent's card still open when its parent's turn ends moves to a continuation instead of going unanswered", async () => {
    const { adapter, log } = replay("subagent-orphan-approval")
    const offers: import("./types").ContinuationOffer[] = []
    adapter.setContinuationSink!((offer) => offers.push(offer) > 0)
    const identity = { sessionId: "s1", turnId: "t1", generation: 0, agentId: "codex" }
    const first = context({
      executionIdentity: identity,
      // The daemon withdraws an open card when its turn ends.
      askPermission: (request, withdraw) => {
        first.asked.push(request)
        return new Promise((resolve) => withdraw?.addEventListener("abort", () => resolve(null)))
      },
    })
    await adapter.reply("Check with a subagent", first.ctx)
    expect(first.asked).toHaveLength(1)
    await waitFor(() => offers.length === 1)
    expect(offers[0]).toMatchObject({ key: "approval:thr-child:0", delivery: "buffered" })
    expect(answerTo(log(), 0)).toBeUndefined()
    const later = context({
      nativeId: "thr-sub",
      continuation: { key: offers[0]!.key, delivery: "buffered" },
      askPermission: async () => "accept",
    })
    await adapter.reply(offers[0]!.detail, later.ctx)
    await waitFor(() => answerTo(log(), 0) !== undefined)
    expect(answerTo(log(), 0)).toEqual({ jsonrpc: "2.0", id: 0, result: { decision: "accept" } })
  })

  test("a stop answers a held subagent approval with cancel", async () => {
    const { adapter, log } = replay("subagent-late-approval")
    const offers: import("./types").ContinuationOffer[] = []
    adapter.setContinuationSink!((offer) => offers.push(offer) > 0)
    await adapter.reply("Check with a subagent", context({ executionIdentity: { sessionId: "s1", turnId: "t1", generation: 0, agentId: "codex" } }).ctx)
    await waitFor(() => offers.length === 1)
    adapter.cancelContinuation!("s1")
    await waitFor(() => answerTo(log(), 0) !== undefined)
    expect(answerTo(log(), 0)).toEqual({ jsonrpc: "2.0", id: 0, result: { decision: "cancel" } })
  })

  test("steer goes to the active turn with expectedTurnId; no turn means false", async () => {
    const { adapter, log } = replay("steer")
    let steered: Promise<boolean> | undefined
    const run = context({}, (event) => {
      if (event.type === "tool" && event.status === "running" && !steered) steered = adapter.steer!("s1", "Also say CHERRY.")
    })
    await adapter.reply("sleep 6", run.ctx)
    expect(await steered).toBe(true)
    expect(requests(log(), "turn/steer")).toEqual([
      {
        threadId: "thr-steer",
        expectedTurnId: "turn-s1",
        clientUserMessageId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        input: [{ type: "text", text: "Also say CHERRY.", text_elements: [] }],
      },
    ])
    expect(of(run.events, "text").at(-1)?.text).toBe("done CHERRY")
    expect(await adapter.steer!("s1", "late")).toBe(false)
    expect(await adapter.steer!("other", "none")).toBe(false)
  })

  test("after an app-server crash the next turn respawns and resumes the thread", async () => {
    const { adapter, log } = replay("resume")
    const first = context()
    await adapter.reply("first", first.ctx)
    expect(of(first.events, "native")).toEqual([{ type: "native", nativeId: "thr-resume" }])
    await waitFor(() => log().some((entry) => entry.exit !== undefined))
    await Bun.sleep(100)

    const second = context({ nativeId: "thr-resume" })
    await adapter.reply("second", second.ctx)
    const wire = log()
    const relaunch = wire.slice(wire.findIndex((entry) => entry.spawn === 2))
    expect(requests(relaunch, "thread/resume")).toEqual([
      { threadId: "thr-resume", excludeTurns: true, cwd: "/tmp/ws", approvalPolicy: "untrusted", approvalsReviewer: "user", sandbox: "workspace-write" },
    ])
    expect(requests(relaunch, "thread/start")).toEqual([])
    expect(of(second.events, "native")).toEqual([])
    expect(of(second.events, "text").map((event) => event.text)).toEqual(["second, still remembering first"])
    // The replayed update belongs to turn-x1 and is not counted again.
    expect(of(second.events, "usage")[0]?.usage).toEqual({
      inputTokens: 590,
      outputTokens: 10,
      cacheReadTokens: 900,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      contextUsed: 1500,
      contextSize: 258400,
    })
  })

  test("an app-server exit during turn/start fails that turn without an unhandled rejection", async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on("unhandledRejection", onUnhandled)
    cleanup.push(() => void process.off("unhandledRejection", onUnhandled))
    const { adapter, log } = replay("exit-on-turn-start")
    const run = context()
    await expect(adapter.reply("hi", run.ctx)).rejects.toThrow(/exited/)
    expect(requests(log(), "turn/start")).toHaveLength(1)
    await Bun.sleep(50)
    expect(unhandled).toEqual([])
  })

  test("a vanished thread falls back to a fresh thread", async () => {
    const { adapter, log } = replay("resume-missing")
    const run = context({ nativeId: "thr-gone" })
    await adapter.reply("hi", run.ctx)
    expect(requests(log(), "thread/resume")[0]).toMatchObject({ threadId: "thr-gone" })
    expect(of(run.events, "native")).toEqual([{ type: "native", nativeId: "thr-new" }])
    expect(of(run.events, "text").map((event) => event.text)).toEqual(["fresh start"])
  })

  test("a copy forks its source thread with thread/fork and sends the plain text (v48 B)", async () => {
    const { adapter, log } = replay("fork")
    const run = context({ forkFrom: "thr-source", carryOver: "User: remember PINEAPPLE" })
    await adapter.reply("which word", run.ctx)
    expect(requests(log(), "thread/fork")[0]).toMatchObject({ threadId: "thr-source", excludeTurns: true, cwd: "/tmp/ws" })
    expect(requests(log(), "thread/start")).toEqual([])
    expect(of(run.events, "native")).toEqual([{ type: "native", nativeId: "thr-fork" }])
    expect(requests(log(), "turn/start")[0]).toMatchObject({ threadId: "thr-fork", input: [{ type: "text", text: "which word" }] })
  })

  test("a copy whose source thread is gone starts a thread and carries the transcript in the text", async () => {
    const { adapter, log } = replay("fork-missing")
    const run = context({ forkFrom: "thr-gone", carryOver: "User: remember PINEAPPLE" })
    await adapter.reply("which word", run.ctx)
    expect(of(run.events, "native")).toEqual([{ type: "native", nativeId: "thr-new" }])
    const text = (requests(log(), "turn/start")[0] as { input: Array<{ text: string }> }).input[0]!.text
    expect(text).toContain("User: remember PINEAPPLE")
    expect(text.endsWith("which word")).toBe(true)
  })

  test("detect reads the account and listModels pages through model/list on the shared app-server", async () => {
    const { adapter, log } = replay("handshake")
    expect(await adapter.detect!()).toEqual({ available: true })
    expect(await adapter.listModels!()).toEqual([
      {
        id: "gpt-6.1-sol",
        label: "GPT-6.1-Sol",
        efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
        defaultEffort: "low",
        isDefault: true,
        speeds: [
          { id: "default", label: "Standard", description: "Standard speed" },
          { id: "priority", label: "Fast", description: "2x speed, increased usage" },
        ],
        defaultSpeed: "default",
      },
      { id: "gpt-6-luna", label: "GPT-6-Luna", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "medium" },
      { id: "gpt-5.6-luna", label: "GPT-5.6-Luna", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "medium" },
    ])
    expect(requests(log(), "model/list")).toEqual([{}, { cursor: "page-2" }])
    expect(log().filter((entry) => entry.spawn !== undefined)).toHaveLength(1)
  })

  test("a newer auth.json replaces the idle app-server before the next read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rudder-codex-auth-"))
    const auth = join(dir, "auth.json")
    writeFileSync(auth, "{}")
    const stale = new Date(Date.now() - 60_000)
    utimesSync(auth, stale, stale)
    const { adapter, log } = replay("auth-refresh", { credentialFile: auth })
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    expect(await adapter.detect!()).toEqual({ available: true })
    const first = adapter.processes!()[0]!.pid
    expect(await adapter.detect!()).toEqual({ available: true })
    expect(adapter.processes!()[0]!.pid).toBe(first)
    writeFileSync(auth, "{\"account\":\"refreshed\"}\n")
    expect(await adapter.detect!()).toEqual({ available: true })
    const started = Date.now()
    while (adapter.processes!().some((entry) => entry.pid === first)) {
      if (Date.now() - started > 3000) throw new Error("old app-server still running")
      await Bun.sleep(10)
    }
    expect(adapter.processes!()).toHaveLength(1)
    expect(adapter.processes!()[0]!.pid).not.toBe(first)
    expect(log().filter((entry) => entry.spawn !== undefined)).toHaveLength(2)
  })

  test("detect during thread/start keeps the app-server when auth.json is newer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rudder-codex-auth-"))
    const auth = join(dir, "auth.json")
    writeFileSync(auth, "{}")
    utimesSync(auth, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
    const { adapter, log } = replay("auth-hold", { credentialFile: auth })
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    const reply = adapter.reply("hi", context().ctx)
    await waitFor(() => requests(log(), "thread/start").length === 1)
    utimesSync(auth, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000))
    const pid = adapter.processes!()[0]!.pid
    expect(await adapter.detect!()).toEqual({ available: true })
    expect(adapter.processes!()[0]!.pid).toBe(pid)
    expect(log().filter((entry) => entry.spawn !== undefined)).toHaveLength(1)
    await reply
  }, 10_000)

  test("a second reply during thread/start does not replace the app-server", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rudder-codex-auth-"))
    const auth = join(dir, "auth.json")
    writeFileSync(auth, "{}")
    utimesSync(auth, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
    const { adapter, log } = replay("auth-hold", { credentialFile: auth })
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    const first = adapter.reply("hi", context().ctx)
    await waitFor(() => requests(log(), "thread/start").length === 1)
    utimesSync(auth, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000))
    const second = adapter.reply("hi", context({ sessionId: "s2" }).ctx)
    await waitFor(() => requests(log(), "thread/start").length === 2)
    expect(log().filter((entry) => entry.spawn !== undefined)).toHaveLength(1)
    expect(adapter.processes!()).toHaveLength(1)
    // The hold script answers account/read before either thread/start, so the turns can finish.
    expect(await adapter.detect!()).toEqual({ available: true })
    expect(log().filter((entry) => entry.spawn !== undefined)).toHaveLength(1)
    await first
    await second
  }, 10_000)

  test("a newer auth.json does not spawn until the old app-server has exited", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rudder-codex-term-"))
    const auth = join(dir, "auth.json")
    const logPath = join(dir, "order")
    writeFileSync(auth, "{}")
    utimesSync(auth, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
    const script = `const fs = require("fs"); fs.appendFileSync(${JSON.stringify(logPath)}, "spawn " + process.pid + "\\n");
process.on("SIGTERM", () => { setTimeout(() => { fs.appendFileSync(${JSON.stringify(logPath)}, "term " + process.pid + "\\n"); process.exit(0); }, 400); });
for await (const line of console) { const m = JSON.parse(line); if (m.id === undefined) continue;
if (m.method === "initialize" || m.method === "account/read") console.log(JSON.stringify({ id: m.id, result: m.method === "account/read" ? { account: { type: "chatgpt" }, requiresOpenaiAuth: true } : {} })); }`
    const adapter = createCodexAdapter({ spec: SPEC, command: [process.execPath, "-e", script], credentialFile: auth })
    cleanup.push(async () => {
      await adapter.dispose?.()
      rmSync(dir, { recursive: true, force: true })
    })
    expect(await adapter.detect!()).toEqual({ available: true })
    const firstPid = adapter.processes!()[0]!.pid
    utimesSync(auth, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000))
    expect(await adapter.detect!()).toEqual({ available: true })
    const text = readFileSync(logPath, "utf8")
    const termAt = text.indexOf(`term ${firstPid}`)
    const secondSpawn = text.indexOf("spawn ", text.indexOf("spawn ") + 1)
    expect(termAt).toBeGreaterThanOrEqual(0)
    expect(termAt).toBeLessThan(secondSpawn)
  }, 10_000)

  test("dispose during auth recycle does not start a replacement app-server", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rudder-codex-term-"))
    const auth = join(dir, "auth.json")
    const logPath = join(dir, "order")
    writeFileSync(auth, "{}")
    utimesSync(auth, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
    const script = `const fs = require("fs"); fs.appendFileSync(${JSON.stringify(logPath)}, "spawn " + process.pid + "\\n");
process.on("SIGTERM", () => { setTimeout(() => { fs.appendFileSync(${JSON.stringify(logPath)}, "term " + process.pid + "\\n"); process.exit(0); }, 400); });
for await (const line of console) { const m = JSON.parse(line); if (m.id === undefined) continue;
if (m.method === "initialize" || m.method === "account/read") console.log(JSON.stringify({ id: m.id, result: m.method === "account/read" ? { account: { type: "chatgpt" }, requiresOpenaiAuth: true } : {} })); }`
    const adapter = createCodexAdapter({ spec: SPEC, command: [process.execPath, "-e", script], credentialFile: auth })
    cleanup.push(async () => {
      await adapter.dispose?.()
      rmSync(dir, { recursive: true, force: true })
    })
    expect(await adapter.detect!()).toEqual({ available: true })
    const firstPid = adapter.processes!()[0]!.pid
    utimesSync(auth, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000))
    const recycle = adapter.detect!()
    const disposed = adapter.dispose!()
    await expect(recycle).rejects.toThrow("codex adapter is stopped")
    await disposed
    const text = readFileSync(logPath, "utf8")
    expect(text.match(/spawn /g)).toHaveLength(1)
    expect(text).toContain(`term ${firstPid}`)
    expect(adapter.processes!()).toHaveLength(0)
    await expect(adapter.detect!()).rejects.toThrow("codex adapter is stopped")
    expect(readFileSync(logPath, "utf8").match(/spawn /g)).toHaveLength(1)
  }, 10_000)

  test("detect reports a logged-out account and a missing binary", async () => {
    const { adapter } = replay("logged-out")
    expect(await adapter.detect!()).toEqual({
      available: false,
      reason: "Codex 未登录：在电脑上运行 codex login",
      reasonCopy: { code: "agent_signed_out", args: { agent: "Codex", command: "codex login" }, text: "Codex 未登录：在电脑上运行 codex login" },
    })
    const missing: AgentAdapter = createCodexAdapter({ spec: SPEC, command: ["rudder-no-such-codex", "app-server"] })
    expect(await missing.detect!()).toEqual({ available: false, reason: "未找到命令 rudder-no-such-codex", reasonCopy: { code: "command_missing", args: { command: "rudder-no-such-codex" }, text: "未找到命令 rudder-no-such-codex" } })
  })

  test("limits reads every bucket, main first, then merges account/rateLimits/updated", async () => {
    const { adapter, log } = replay("rate-limits")
    const first = await adapter.limits!()
    expect(first).toMatchObject({
      plan: "pro",
      credits: "12.40",
      windows: [
        { minutes: 300, usedPercent: 34, resetsAt: 1793400000_000 },
        { minutes: 10080, usedPercent: 61, resetsAt: 1793700000_000 },
        { limit: "GPT-6.1-Codex-Spark", minutes: 300, usedPercent: 8, resetsAt: 1793400000_000 },
        { limit: "GPT-6.1-Codex-Spark", minutes: 10080, usedPercent: 22, resetsAt: 1793700000_000 },
      ],
    })
    expect(requests(log(), "initialize")[0]).toMatchObject({
      capabilities: { optOutNotificationMethods: expect.not.arrayContaining(["account/rateLimits/updated"]) },
    })
    await Bun.sleep(400)
    // The sparse update carries only primary; plan, credits and the weekly window stay as read.
    const merged = await adapter.limits!()
    expect(merged?.plan).toBe("pro")
    expect(merged?.windows.slice(0, 2)).toEqual([
      { minutes: 300, usedPercent: 86, resetsAt: 1793400000_000 },
      { minutes: 10080, usedPercent: 61, resetsAt: 1793700000_000 },
    ])
    // Within the TTL the cache answers: one read.
    expect(requests(log(), "account/rateLimits/read")).toHaveLength(1)
  })

  test("limits is undefined when the account cannot read rate limits or the binary is missing", async () => {
    const { adapter } = replay("rate-limits-apikey")
    expect(await adapter.limits!()).toBeUndefined()
    const missing = createCodexAdapter({ spec: SPEC, command: ["rudder-no-such-codex", "app-server"] })
    expect(await missing.limits!()).toBeUndefined()
  })

  test("a malformed item does not stop the reader; plan updates become plan events", async () => {
    const { adapter } = replay("edge")
    const run = context()
    const outcome = adapter.reply("go", run.ctx).then(() => "done")
    expect(await Promise.race([outcome, Bun.sleep(3000).then(() => "stuck")])).toBe("done")
    expect(lastTool(run.events, "codex:thr-edge:fc-e1")).toMatchObject({ kind: "edit", diffs: [{ path: "/tmp/ws/a.txt", patch: "hello\n" }] })
    expect(of(run.events, "plan")).toEqual([
      {
        type: "plan",
        id: "codex:thr-edge:turn-e1:plan",
        entries: [
          { content: "Read", status: "completed" },
          { content: "Write", status: "in_progress" },
          { content: "Test", status: "pending" },
        ],
      },
    ])
    expect(of(run.events, "text").map((event) => event.text)).toEqual(["done"])
    expect(SPEC.capabilities.plan).toBe(true)
  })

  test("abort while the app-server is still starting ends the turn at once", async () => {
    const adapter = createCodexAdapter({ spec: SPEC, command: ["sh", "-c", "while read line; do :; done"] })
    cleanup.push(() => adapter.dispose?.())
    const run = context()
    setTimeout(() => run.abort.abort(), 100)
    const outcome = adapter.reply("hi", run.ctx).then(() => "done")
    expect(await Promise.race([outcome, Bun.sleep(3000).then(() => "stuck")])).toBe("done")
    expect(of(run.events, "text").map((event) => event.text)).toEqual(["Cancelled."])
  })

  test("dispose kills an app-server that ignores SIGTERM", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rudder-codex-term-"))
    const pidFile = join(dir, "pid")
    const script = `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on("SIGTERM", () => {});
for await (const line of console) { const m = JSON.parse(line); if (m.id !== undefined) console.log(JSON.stringify({ id: m.id, result: { data: [], nextCursor: null } })) }
await Bun.sleep(1e9)`
    const adapter = createCodexAdapter({ spec: SPEC, command: [process.execPath, "-e", script] })
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    expect(await adapter.listModels!()).toEqual([])
    await adapter.dispose!()
    const pid = Number(readFileSync(pidFile, "utf8"))
    expect(() => process.kill(pid, 0)).toThrow()
  }, 10_000)

  test("forget drops the loaded thread, so the next turn resumes it", async () => {
    const { adapter, log } = replay("forget")
    const first = context()
    await adapter.reply("one", first.ctx)
    adapter.forget!("s1")
    await adapter.reply("two", context({ nativeId: "thr-forget" }).ctx)
    expect(requests(log(), "thread/resume")).toEqual([
      { threadId: "thr-forget", excludeTurns: true, cwd: "/tmp/ws", approvalPolicy: "untrusted", approvalsReviewer: "user", sandbox: "workspace-write" },
    ])
  })

  test("rewind reverts the thread before the first removed turn and unloads it; a refused revert says false", async () => {
    const { adapter, log } = replay("revert")
    const first = context()
    await adapter.reply("one", first.ctx)
    expect(first.events.filter((event) => event.type === "nativeTurn")).toEqual([{ type: "nativeTurn", nativeId: "thr-rv", turnId: "turn-r1" }])
    expect(await adapter.rewind!("s1", { nativeId: "thr-rv", beforeTurnId: "turn-r1" })).toBe(true)
    expect(requests(log(), "thread/revert")).toEqual([{ threadId: "thr-rv", beforeTurnId: "turn-r1" }])
    // Unloaded: the next turn resumes with its own settings.
    await adapter.reply("two", context({ nativeId: "thr-rv" }).ctx)
    expect(requests(log(), "thread/resume")).toHaveLength(1)
    adapter.forget!("s1")
    expect(await adapter.rewind!("s1", { nativeId: "thr-rv" })).toBe(false)
    // Not loaded any more: resumed bare first, since thread/revert only sees loaded threads.
    expect(await adapter.rewind!("s1", { nativeId: "thr-rv", beforeTurnId: "turn-gone" })).toBe(false)
    expect(requests(log(), "thread/resume").at(-1)).toEqual({ threadId: "thr-rv", excludeTurns: true })
  })

  test("thread/closed unloads the thread and drops the session from processes until it resumes", async () => {
    const { adapter, log } = replay("closed")
    await adapter.reply("one", context().ctx)
    await waitFor(() => adapter.processes!()[0]?.sessionIds.length === 0)
    await adapter.reply("two", context({ nativeId: "thr-closed" }).ctx)
    expect(requests(log(), "thread/resume")).toHaveLength(1)
    expect(adapter.processes!()[0]?.sessionIds).toEqual(["s1"])
  })

  // perf-1112 round two (R6): loaded threads stayed in app-server memory for as long as rudderd ran.
  test("a thread idle past threadIdleMs is unsubscribed like thread/closed; the next turn resumes it", async () => {
    const { adapter, log } = replay("unsubscribe", { threadIdleMs: 50 })
    await adapter.reply("one", context().ctx)
    expect(adapter.processes!()[0]?.sessionIds).toEqual(["s1"])
    await waitFor(() => requests(log(), "thread/unsubscribe").length === 1)
    expect(requests(log(), "thread/unsubscribe")).toEqual([{ threadId: "thr-idle" }])
    expect(adapter.processes!()[0]?.sessionIds).toEqual([])
    await adapter.reply("two", context({ nativeId: "thr-idle" }).ctx)
    expect(requests(log(), "thread/resume")).toHaveLength(1)
    expect(adapter.processes!()[0]?.sessionIds).toEqual(["s1"])
  })

  test("lateResumeDuringUnsubscribeIsReleasedAfterThePendingAcknowledgement", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rudder-codex-pending-"))
    const logPath = join(dir, "requests.jsonl")
    const script = `let first,release,loaded=false,count=0;const fs=require("fs");
for await(const line of console){const m=JSON.parse(line);const log=x=>fs.appendFileSync(${JSON.stringify(logPath)},JSON.stringify(x)+"\\n");log(m);const answer=(id,result)=>console.log(JSON.stringify({id,result}));
 if(m.method==="thread/resume"){if(first===undefined){first=m.id;continue}loaded=true;answer(m.id,{thread:{id:"thr-same"}});continue}
 if(m.method==="thread/unsubscribe"){loaded=false;if(release===undefined)release=m.id;else{answer(m.id,{status:"unsubscribed"});log({remoteLoaded:loaded})}continue}
 if(m.method==="model/list"){count++;if(count===1){loaded=true;answer(first,{thread:{id:"thr-same"}})}else if(count===2)answer(release,{status:"unsubscribed"});answer(m.id,{data:[],nextCursor:null});continue}
 if(m.method==="turn/start"){answer(m.id,{turn:{id:"turn-new",status:"inProgress",error:null}});console.log(JSON.stringify({method:"turn/completed",params:{threadId:"thr-same",turn:{id:"turn-new",status:"completed",error:null}}}));continue}
 if(m.id!==undefined)answer(m.id,{})
}`
    const { adapter } = replay("unsubscribe", { command: [process.execPath, "-e", script], threadIdleMs: 60_000 })
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    const entries = (): Array<{ method?: string; remoteLoaded?: boolean }> => existsSync(logPath) ? readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : []
    const run = context({ nativeId: "thr-same" })
    const old = adapter.reply("old", run.ctx)
    await waitFor(() => entries().some(entry => entry.method === "thread/resume"))
    run.abort.abort()
    await old
    await adapter.reply("new", context({ nativeId: "thr-same" }).ctx)
    adapter.forget!("s1")
    await waitFor(() => entries().some(entry => entry.method === "thread/unsubscribe"))
    await adapter.listModels!()
    await adapter.listModels!()
    await waitFor(() => entries().some(entry => entry.remoteLoaded === false))
    expect(entries().filter(entry => entry.method === "thread/unsubscribe")).toHaveLength(2)
    expect(adapter.processes!()[0]?.sessionIds).toEqual([])
  })

  test.each(["failed", "forgotten"])("lateSetupReleasesAfterReplacementIsGone: %s", async replacement => {
    const dir = mkdtempSync(join(tmpdir(), "rudder-codex-owner-"))
    const logPath = join(dir, "requests.jsonl")
    const script = `let first; const fs=require("fs");
for await (const line of console) {
 const m=JSON.parse(line); fs.appendFileSync(${JSON.stringify(logPath)}, line+"\\n");
 const answer=(id,result)=>console.log(JSON.stringify({id,result}));
 if(m.method==="thread/resume") { if(first===undefined) { first=m.id; continue }; if(${JSON.stringify(replacement)}==="failed") console.log(JSON.stringify({id:m.id,error:{code:-32000,message:"temporary resume failure"}})); else answer(m.id,{thread:{id:"thr-same"}}); continue }
 if(m.method==="model/list") { answer(first,{thread:{id:"thr-same"}}); answer(m.id,{data:[],nextCursor:null}); continue }
 if(m.method==="turn/start") { answer(m.id,{turn:{id:"turn-new",status:"inProgress",error:null}}); console.log(JSON.stringify({method:"turn/completed",params:{threadId:"thr-same",turn:{id:"turn-new",status:"completed",error:null}}})); continue }
 if(m.id!==undefined) answer(m.id,{})
}`
    const { adapter } = replay("unsubscribe", { command: [process.execPath, "-e", script], threadIdleMs: 60_000 })
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    const methods = () => existsSync(logPath) ? readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line).method as string) : []
    const run = context({ nativeId: "thr-same" })
    const old = adapter.reply("old", run.ctx)
    await waitFor(() => methods().includes("thread/resume"))
    run.abort.abort()
    await old
    const next = adapter.reply("new", context({ nativeId: "thr-same" }).ctx)
    if (replacement === "failed") await expect(next).rejects.toThrow("temporary resume failure")
    else await next
    adapter.forget!("s1")
    const before = methods().filter(method => method === "thread/unsubscribe").length
    await adapter.listModels!()
    await waitFor(() => methods().filter(method => method === "thread/unsubscribe").length > before)
    expect(adapter.processes!()[0]?.sessionIds).toEqual([])
  })

  test("staleSetupCannotUnsubscribeTheThreadClaimedByItsReplacement", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rudder-codex-claim-"))
    const logPath = join(dir, "requests.jsonl")
    const script = `let first; const fs=require("fs");
for await (const line of console) {
 const m=JSON.parse(line); fs.appendFileSync(${JSON.stringify(logPath)}, line+"\\n");
 const answer=(id,result)=>console.log(JSON.stringify({id,result}));
 if(m.method==="thread/resume") { if(first===undefined) { first=m.id; continue }; answer(m.id,{thread:{id:"thr-same"}}); answer(first,{thread:{id:"thr-same"}}); continue }
 if(m.method==="turn/start") { answer(m.id,{turn:{id:"turn-new",status:"inProgress",error:null}}); console.log(JSON.stringify({method:"turn/completed",params:{threadId:"thr-same",turn:{id:"turn-new",status:"completed",error:null}}})); continue }
 if(m.id!==undefined) answer(m.id,{})
}`
    const { adapter } = replay("unsubscribe", { command: [process.execPath, "-e", script], threadIdleMs: 60_000 })
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    const methods = () => existsSync(logPath) ? readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line).method as string) : []
    const run = context({ nativeId: "thr-same" })
    const old = adapter.reply("old", run.ctx)
    await waitFor(() => methods().includes("thread/resume"))
    run.abort.abort()
    await old
    await adapter.reply("new", context({ nativeId: "thr-same" }).ctx)
    expect(methods()).not.toContain("thread/unsubscribe")
    expect(adapter.processes!()[0]?.sessionIds).toEqual(["s1"])
  })

  test("forgetDuringAbortedSetupUnsubscribesTheLateThread", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rudder-codex-late-"))
    const logPath = join(dir, "requests.jsonl")
    const script = `let start; const fs=require("fs");
for await (const line of console) {
 const m=JSON.parse(line); fs.appendFileSync(${JSON.stringify(logPath)}, line+"\\n");
 const answer=(id,result)=>console.log(JSON.stringify({id,result}));
 if(m.method==="thread/start") { start=m.id; continue }
 if(m.method==="model/list") { answer(start,{thread:{id:"thr-late"}}); answer(m.id,{data:[],nextCursor:null}); continue }
 if(m.id!==undefined) answer(m.id,m.method==="thread/unsubscribe"?{status:"unsubscribed"}:{})
}`
    const { adapter } = replay("unsubscribe", { command: [process.execPath, "-e", script], threadIdleMs: 60_000 })
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    const methods = () => existsSync(logPath) ? readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line).method as string) : []
    const run = context()
    const reply = adapter.reply("one", run.ctx)
    await waitFor(() => methods().includes("thread/start"))
    run.abort.abort()
    await reply
    adapter.forget!("s1")
    await adapter.listModels!()
    await waitFor(() => methods().includes("thread/unsubscribe"))
    expect(methods().filter(method => method === "thread/unsubscribe")).toHaveLength(1)
    expect(methods()).not.toContain("turn/start")
    expect(adapter.processes!()[0]?.sessionIds).toEqual([])
  })

  test("forgetUnsubscribesBeforeIdleExpires", async () => {
    const { adapter, log } = replay("unsubscribe", { threadIdleMs: 60_000 })
    await adapter.reply("one", context().ctx)
    adapter.forget!("s1")
    await waitFor(() => requests(log(), "thread/unsubscribe").length === 1)
    expect(requests(log(), "thread/unsubscribe")).toEqual([{ threadId: "thr-idle" }])
    await adapter.reply("two", context({ nativeId: "thr-idle" }).ctx)
    expect(log().filter(entry => entry.spawn !== undefined)).toHaveLength(1)
  })

  test("idleThenForgetUnsubscribesOnce", async () => {
    const { adapter, log } = replay("unsubscribe", { threadIdleMs: 30 })
    await adapter.reply("one", context().ctx)
    await waitFor(() => requests(log(), "thread/unsubscribe").length === 1)
    adapter.forget!("s1")
    await adapter.reply("two", context({ nativeId: "thr-idle" }).ctx)
    expect(requests(log(), "thread/unsubscribe")).toHaveLength(1)
  })

  test("forgetPreservesOtherLoadedThreads", async () => {
    const { adapter, log } = replay("forget-multiple", { threadIdleMs: 60_000 })
    await adapter.reply("one", context().ctx)
    await adapter.reply("two", context({ sessionId: "s2" }).ctx)
    const pid = adapter.processes!()[0]!.pid
    adapter.forget!("s1")
    adapter.forget!("s1")
    await waitFor(() => requests(log(), "thread/unsubscribe").length === 1)
    expect(requests(log(), "thread/unsubscribe")).toEqual([{ threadId: "thr-one" }])
    expect(adapter.processes!()).toEqual([{ agent: "codex", pid, sessionIds: ["s2"], shared: true }])
    expect(log().filter(entry => entry.spawn !== undefined)).toHaveLength(1)
  })

  test("forgetSupportsServersWithoutUnsubscribe", async () => {
    const { adapter, log } = replay("forget-legacy", { threadIdleMs: 60_000 })
    await adapter.reply("one", context().ctx)
    adapter.forget!("s1")
    await waitFor(() => requests(log(), "thread/unsubscribe").length === 1)
    await adapter.reply("two", context({ nativeId: "thr-idle" }).ctx)
    adapter.forget!("s1")
    expect(adapter.processes!()[0]?.sessionIds).toEqual([])
    expect(requests(log(), "thread/unsubscribe")).toHaveLength(1)
    expect(log().filter(entry => entry.spawn !== undefined)).toHaveLength(1)
  })

  test("availableDecisions only reorders the decisions it names", () => {
    expect(codexPermissionOptions(["accept", { acceptWithExecpolicyAmendment: {} }, "cancel"])).toEqual(CODEX_PERMISSION_OPTIONS)
    expect(codexPermissionOptions(["cancel", "accept"]).map((option) => option.id)).toEqual(["cancel", "acceptForSession", "decline", "accept"])
    expect(codexPermissionOptions(undefined)).toEqual(CODEX_PERMISSION_OPTIONS)
  })
})

describe("codex adapter · processes", () => {
  test("one shared app-server; sessions are the ones with a loaded thread", async () => {
    const { adapter } = replay("forget")
    expect(adapter.processes!()).toEqual([])
    await adapter.reply("one", context().ctx)
    const [entry, ...rest] = adapter.processes!()
    expect(rest).toEqual([])
    expect(entry).toMatchObject({ agent: "codex", sessionIds: ["s1"], shared: true })
    expect(() => process.kill(entry!.pid, 0)).not.toThrow()
    adapter.forget!("s1")
    expect(adapter.processes!()).toEqual([{ agent: "codex", pid: entry!.pid, sessionIds: [], shared: true }])
    await adapter.dispose!()
    expect(adapter.processes!()).toEqual([])
  })
})

describe("Codex skill discovery", () => {
  test("lists enabled plugin and project skills for the session directory", async () => {
    const { adapter, log } = replay("skills")
    expect(await adapter.listCommands?.("/tmp/ws")).toEqual([
      { name: "local", insert: "$local", kind: "skill", description: "Project", source: "project" },
      { name: "superpowers:brainstorming", insert: "$superpowers:brainstorming", kind: "skill", description: "Brainstorm", source: "plugin:superpowers" },
    ])
    expect(requests(log(), "skills/list")).toEqual([{ cwds: ["/tmp/ws"], forceReload: true }])
  })
  test("surfaces discovery errors rather than returning a partial local list", async () => {
    const { adapter } = replay("skills-error")
    await expect(adapter.listCommands?.("/tmp/ws")).rejects.toThrow("skills unavailable")
  })
  test("falls back for older app-servers without skills/list", async () => {
    const { adapter } = replay("skills-legacy")
    const { codexCommands } = await import("../commands")
    expect(await adapter.listCommands?.("/tmp/ws")).toEqual(await codexCommands())
  })
  test("rejects malformed skill metadata", async () => {
    const { adapter } = replay("skills-invalid")
    await expect(adapter.listCommands?.("/tmp/ws")).rejects.toThrow("skills/list")
  })
})


describe("native CLI permission inheritance", () => {
  test("does not override configured thread or turn policy", async () => {
    const { adapter, log } = replay("reasoning")
    await adapter.reply("fixture", context({ permissionMode: "native" }).ctx)
    const thread = requests(log(), "thread/start")[0]
    const turn = requests(log(), "turn/start")[0]
    expect(thread).not.toHaveProperty("approvalPolicy")
    expect(thread).not.toHaveProperty("sandbox")
    expect(thread).not.toHaveProperty("approvalsReviewer")
    expect(turn).not.toHaveProperty("sandboxPolicy")
    expect(turn).not.toHaveProperty("approvalsReviewer")
  })

  test("reloads effective native policy after a previous explicit override", async () => {
    const { adapter, log } = replay("native-policy")
    await adapter.reply("fixture", context().ctx)
    await adapter.reply("fixture", context({ permissionMode: "native", nativeId: "thr-native" }).ctx)
    expect(requests(log(), "thread/unsubscribe")).toEqual([{ threadId: "thr-native" }])
    expect(requests(log(), "thread/resume")[0]).toMatchObject({
      threadId: "thr-native", approvalPolicy: "never", sandbox: "danger-full-access", approvalsReviewer: "user",
    })
    expect(requests(log(), "turn/start")[1]).not.toHaveProperty("sandboxPolicy")
  })
})


describe("native Plan collaboration", () => {
  test("plan enables native instructions and resets after leaving plan", async () => {
    const { adapter, log } = replay("basic")
    await adapter.reply("fixture", context({ permissionMode: "plan" }).ctx)
    await adapter.reply("fixture", context({ permissionMode: "ask", nativeId: "thr-basic" }).ctx)
    const turns = requests(log(), "turn/start")
    expect(turns[0]?.collaborationMode).toMatchObject({ mode: "plan", settings: { model: "gpt-6-luna", reasoning_effort: "low", developer_instructions: null } })
    expect(turns[1]?.collaborationMode).toMatchObject({ mode: "default", settings: { developer_instructions: null } })
    expect(requests(log(), "initialize")[0]).toMatchObject({ capabilities: { experimentalApi: true } })
  })

  test("plan preserves a selected model and effort", async () => {
    const { adapter, log } = replay("reasoning")
    await adapter.reply("fixture", context({ permissionMode: "plan", model: "selected-model", effort: "high" }).ctx)
    expect(requests(log(), "turn/start")[0]?.collaborationMode).toEqual({
      mode: "plan", settings: { model: "selected-model", reasoning_effort: "high", developer_instructions: null },
    })
  })
})


test("MCP URL consent reaches the computer browser through Codex", async () => {
  const opened: string[] = []
  const { adapter, log } = replay("mcp-elicit-odd", { openUrl: async url => { opened.push(url) } })
  await adapter.reply("fixture", context({ askQuestion: async request => ({ [request.questions[0]!.question]: request.questions[0]!.options[0]!.label }) }).ctx)
  expect(opened).toEqual(["https://example.com/auth"])
  expect(answerTo(log(), 1)?.result).toEqual({ action: "accept", content: null, _meta: null })
})

test("invalid MCP form answers stay in the form until corrected", async () => {
  let attempts = 0
  const { adapter, log } = replay("mcp-elicit")
  await adapter.reply("fixture", context({
    askPermission: async () => "accept",
    askQuestion: async request => {
      attempts++
      const [toppings, size] = request.questions
      return { [toppings!.question]: ["cheese"], [size!.question]: attempts === 1 ? "invalid-size" : "Large" }
    },
  }).ctx)
  expect(attempts).toBe(2)
  expect(answerTo(log(), 1)?.result).toEqual({ action: "accept", content: { toppings: ["cheese"], size: "l" }, _meta: null })
})


test("native diagnostics reads inventories without starting a model turn", async () => {
  const { adapter, log } = replay("diagnostics")
  const result = await adapter.diagnostics!("/tmp/ws")
  expect(result.configRoot).toBe("/fixture/codex")
  expect(result.mcp.state).toBe("ready")
  expect(result.hooks.events).toEqual(["sessionStart"])
  expect(requests(log(), "thread/start")).toEqual([])
  expect(requests(log(), "turn/start")).toEqual([])
})

test("native default policy resolves through an ephemeral thread and releases it before resuming", async () => {
  const { adapter, log } = replay("native-default-policy")
  await adapter.reply("fixture", context({ permissionMode: "native", nativeId: "thr-native" }).ctx)
  expect(requests(log(), "thread/start")).toEqual([{ cwd: "/tmp/ws", ephemeral: true }])
  expect(requests(log(), "thread/unsubscribe")).toEqual([{ threadId: "thr-policy-probe" }])
  expect(requests(log(), "thread/resume")[0]).toMatchObject({ threadId: "thr-native", approvalPolicy: "on-request", sandbox: "read-only", approvalsReviewer: "user" })
  expect(requests(log(), "turn/start")).toHaveLength(1)
})

test("subagent notifications before turn/start response retain their original parent ordering", async () => {
  const {adapter}=replay("subagent-early")
  const offers:unknown[]=[]
  adapter.setContinuationSink!(offer => {offers.push(offer);return true})
  const run=context({executionIdentity:{sessionId:"rudder-1",turnId:"t1",generation:0,agentId:"codex"}})
  await adapter.reply("fixture",run.ctx)
  expect(offers).toEqual([])
  expect(run.events.filter(event => event.type === "tool" && event.tool === "Agent").at(-1)).toMatchObject({status:"completed",output:"CHILD REPORT: 3 failures"})
})
