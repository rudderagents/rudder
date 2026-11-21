import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import { unavailableCode } from "./agent-error"
import { CLAUDE_SIGNED_OUT, claudeSignedOut, claudeUsage, createClaudeAdapter, STALE_RESUME_NOTICE, type ClaudeAdapterOptions } from "./claude"
import { BUILTIN_AGENTS, commandAvailability } from "./index"
import { PIZZA } from "../../scripts/record/mcp-elicit-server"
import { obj } from "./json"
import type { AdapterContext, AgentAdapter, AgentEvent, PermissionRequest, QuestionAnswers, QuestionRequest } from "./types"

const FIXTURES = join(import.meta.dir, "fixtures", "claude")
const FAKE = join(FIXTURES, "fake-claude.ts")
const SPEC = BUILTIN_AGENTS.find((entry) => entry.spec.id === "claude")!.spec

// biome-ignore lint/suspicious/noExplicitAny: test double reading arbitrary JSON-RPC frames loosely
type Json = Record<string, any>
type ToolEvent = Extract<AgentEvent, { type: "tool" }>

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

// Each spawn takes the next scenario (the last one repeats); argv and stdin are recorded per spawn.
function harness(scenarios: string[], options: Partial<ClaudeAdapterOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "rudder-claude-test-"))
  const spawns: string[][] = []
  const adapter = createClaudeAdapter({
    spec: SPEC,
    command: process.execPath,
    args: (base) => {
      const scenario = scenarios[spawns.length] ?? scenarios.at(-1) ?? "-"
      const log = join(dir, `stdin-${spawns.length}.jsonl`)
      spawns.push(base)
      return [FAKE, scenario === "-" ? "-" : join(FIXTURES, `${scenario}.jsonl`), log, ...base]
    },
    ...options,
  })
  cleanups.push(async () => {
    await adapter.dispose?.()
    rmSync(dir, { recursive: true, force: true })
  })
  const stdin = (spawn = 0): Json[] => {
    const path = join(dir, `stdin-${spawn}.jsonl`)
    if (!existsSync(path)) return []
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  }
  return { adapter, spawns, stdin, dir }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out")
    await Bun.sleep(10)
  }
}

type Hooks = {
  askPermission?: (request: PermissionRequest, withdraw?: AbortSignal) => Promise<string | null>
  askQuestion?: (request: QuestionRequest, withdraw?: AbortSignal) => Promise<QuestionAnswers | null>
  onEvent?: (event: AgentEvent, controller: AbortController) => void
}

async function run(adapter: AgentAdapter, text: string, overrides: Partial<AdapterContext> = {}, hooks: Hooks = {}) {
  const events: AgentEvent[] = []
  const permissions: PermissionRequest[] = []
  const questions: QuestionRequest[] = []
  const controller = new AbortController()
  const ctx: AdapterContext = {
    sessionId: "s1",
    cwd: tmpdir(),
    permissionMode: "ask",
    signal: controller.signal,
    emit: (event) => {
      events.push(event)
      hooks.onEvent?.(event, controller)
    },
    askPermission: async (request, withdraw) => {
      permissions.push(request)
      return hooks.askPermission ? hooks.askPermission(request, withdraw) : null
    },
    askQuestion: async (request, withdraw) => {
      questions.push(request)
      return hooks.askQuestion ? hooks.askQuestion(request, withdraw) : null
    },
    ...overrides,
  }
  let error: Error | undefined
  await adapter.reply(text, ctx).catch((caught: Error) => {
    error = caught
  })
  return { events, permissions, questions, error }
}

function of<T extends AgentEvent["type"]>(events: AgentEvent[], type: T): Extract<AgentEvent, { type: T }>[] {
  return events.filter((event): event is Extract<AgentEvent, { type: T }> => event.type === type)
}

// Final state per tool card id, in first-seen order.
function finalTools(events: AgentEvent[]): ToolEvent[] {
  const byId = new Map<string, ToolEvent>()
  for (const event of of(events, "tool")) byId.set(event.id, event)
  return [...byId.values()]
}

function finalTexts(events: AgentEvent[]): string[] {
  const byId = new Map<string, string>()
  for (const event of of(events, "text")) byId.set(event.id, event.text)
  return [...byId.values()]
}

function controlResponses(lines: Json[]): Json[] {
  return lines.filter((line) => line.type === "control_response").map((line) => line.response)
}

function controlRequests(lines: Json[], subtype: string): Json[] {
  return lines.filter((line) => line.type === "control_request" && line.request.subtype === subtype).map((line) => line.request)
}

function nativeOf(events: AgentEvent[]): string | undefined {
  return of(events, "native")[0]?.nativeId
}

describe("Claude adapter launch", () => {
  test("a warmed session takes its first turn on the process started when the chat opened", async () => {
    const { adapter, spawns, stdin } = harness(["turn-ok"])
    adapter.warm?.({ sessionId: "s1", cwd: tmpdir(), permissionMode: "ask", model: "haiku" })
    expect(spawns).toHaveLength(1)
    // Opened again: the live process is kept.
    adapter.warm?.({ sessionId: "s1", cwd: tmpdir(), permissionMode: "ask", model: "haiku" })
    expect(spawns).toHaveLength(1)
    const { error } = await run(adapter, "Reply with exactly: ok", { model: "haiku" })
    expect(error).toBeUndefined()
    expect(spawns).toHaveLength(1)
    expect(stdin(0).find((line) => line.type === "user")).toMatchObject({ message: { content: "Reply with exactly: ok" } })
  })

  // 2026-11-12 (perf-1112 R6): every opened chat kept its own warm CLI for 10 min, with no cap.
  test("at most two warmed processes no turn has used are kept; the oldest is stopped", async () => {
    const { adapter, spawns } = harness(["turn-ok"], { warmLimit: 2 })
    for (let i = 1; i <= 5; i++) adapter.warm?.({ sessionId: `s${i}`, cwd: tmpdir(), permissionMode: "ask" })
    expect(spawns).toHaveLength(5)
    await waitUntil(() => (adapter.processes?.() ?? []).length <= 2)
    expect((adapter.processes?.() ?? []).flatMap((entry) => entry.sessionIds).sort()).toEqual(["s4", "s5"])
  })

  // perf-1112 round two (R6): a process that ran a turn idled 10 min with no cap, one per chat touched.
  test("at most three idle processes are kept, used or warm; the least recently used is stopped", async () => {
    const { adapter, spawns } = harness(["turn-ok"])
    for (let i = 1; i <= 5; i++) {
      const { error } = await run(adapter, "Reply with exactly: ok", { sessionId: `s${i}` })
      expect(error).toBeUndefined()
    }
    expect(spawns).toHaveLength(5)
    await waitUntil(() => (adapter.processes?.() ?? []).length <= 3)
    expect((adapter.processes?.() ?? []).flatMap((entry) => entry.sessionIds).sort()).toEqual(["s3", "s4", "s5"])
    // Opening a chat again makes it the youngest; a new warm one then stops the oldest other.
    adapter.warm?.({ sessionId: "s3", cwd: tmpdir(), permissionMode: "ask" })
    adapter.warm?.({ sessionId: "s6", cwd: tmpdir(), permissionMode: "ask" })
    await waitUntil(() => (adapter.processes?.() ?? []).length <= 3)
    expect((adapter.processes?.() ?? []).flatMap((entry) => entry.sessionIds).sort()).toEqual(["s3", "s5", "s6"])
  })

  test("a running turn does not count against the idle cap", async () => {
    const { adapter } = harness(["interrupt-hang", "turn-ok"], { idleLimit: 1, interruptTimeoutMs: 100 })
    let stop!: AbortController
    let streaming = false
    const running = run(adapter, "go", { sessionId: "s1" }, {
      onEvent: (event, controller) => {
        stop = controller
        if (event.type === "text") streaming = true
      },
    })
    await waitUntil(() => streaming)
    for (const id of ["s2", "s3"]) expect((await run(adapter, "Reply with exactly: ok", { sessionId: id })).error).toBeUndefined()
    await waitUntil(() => (adapter.processes?.() ?? []).length <= 2)
    expect((adapter.processes?.() ?? []).flatMap((entry) => entry.sessionIds).sort()).toEqual(["s1", "s3"])
    stop.abort()
    await running
  })

  test("a warmed process no turn used stops after the warm idle time", async () => {
    const { adapter } = harness(["turn-ok"], { warmIdleMs: 50 })
    adapter.warm?.({ sessionId: "s1", cwd: tmpdir(), permissionMode: "ask" })
    expect(adapter.processes?.()).toHaveLength(1)
    await waitUntil(() => (adapter.processes?.() ?? []).length === 0)
  })

  test("first turn pins a fresh session id and passes explicit flags", async () => {
    const { adapter, spawns, stdin } = harness(["turn-ok"])
    const { events, error } = await run(adapter, "Reply with exactly: ok", { model: "haiku", effort: "low", permissionMode: "acceptEdits" })
    expect(error).toBeUndefined()
    const argv = spawns[0]!
    for (const flag of ["--input-format", "--include-partial-messages", "--permission-prompt-tool"]) expect(argv).toContain(flag)
    expect(argv.slice(argv.indexOf("--thinking-display"), argv.indexOf("--thinking-display") + 2)).toEqual(["--thinking-display", "summarized"])
    expect(argv.slice(argv.indexOf("--permission-mode"), argv.indexOf("--permission-mode") + 2)).toEqual(["--permission-mode", "acceptEdits"])
    expect(argv.slice(argv.indexOf("--model"), argv.indexOf("--model") + 2)).toEqual(["--model", "haiku"])
    expect(argv.slice(argv.indexOf("--effort"), argv.indexOf("--effort") + 2)).toEqual(["--effort", "low"])
    expect(argv).not.toContain("--resume")
    expect(argv).not.toContain("--settings")
    const sessionId = argv[argv.indexOf("--session-id") + 1]
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/)
    expect(nativeOf(events)).toBe(sessionId)
    // initialize goes first (its session_state says whether the CLI reports turn end), then the user line.
    expect(stdin(0)[0]).toMatchObject({ type: "control_request", request: { subtype: "initialize" } })
    expect(stdin(0)[1]).toEqual({
      type: "user",
      message: { role: "user", content: "Reply with exactly: ok" },
      parent_tool_use_id: null,
      session_id: "",
    })
    expect(finalTexts(events)).toEqual(["OK"])
  })

  test("an image is a content block beside the text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rudder-claude-image-"))
    const path = join(dir, "shot.png")
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    writeFileSync(path, bytes)
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const { adapter, stdin } = harness(["turn-ok"])
    const { error } = await run(adapter, "look", { images: [{ path, mediaType: "image/png", bytes: bytes.length }] })
    expect(error).toBeUndefined()
    expect(stdin(0).find((line) => line.type === "user")?.message.content).toEqual([
      { type: "text", text: "look" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: bytes.toString("base64") } },
    ])
  })

  test("native initialize commands include built-ins without filesystem descriptions", async () => {
    const { adapter } = harness(["turn-ok", "catalogue-builtin"])
    await run(adapter, "hi")
    expect(await adapter.listCommands?.(tmpdir())).toContainEqual({ name: "rudder-fixture-builtin", insert: "/rudder-fixture-builtin", kind: "command", source: "agent" })
  })

  test("limits keeps the latest rate_limit_event per rateLimitType; a past reset reads as allowed", async () => {
    const { adapter } = harness(["rate-limit"])
    expect(await adapter.limits!()).toMatchObject({ windows: [] })
    const { error } = await run(adapter, "hi")
    expect(error).toBeUndefined()
    const quota = await adapter.limits!()
    expect(quota?.plan).toBeUndefined()
    expect(quota?.windows).toEqual([
      { kind: "five_hour", status: "rejected", resetsAt: 4102444800_000 },
      { kind: "seven_day_opus", status: "allowed_warning", resetsAt: 4102444800_000, usedPercent: 82 },
      { kind: "seven_day", status: "allowed" },
    ])
  })

  test("api_retry frames become retry events; a 429 result is a usage limit with the gateway's reset", async () => {
    const { adapter } = harness(["api-retry-429"])
    const before = Date.now()
    const { events, error } = await run(adapter, "hi")
    expect(of(events, "retry")).toEqual([
      { type: "retry", attempt: 1, maxAttempts: 10, delayMs: 1200, reason: "rate_limit" },
      { type: "retry", attempt: 2, maxAttempts: 10, delayMs: 2400, reason: "rate_limit" },
    ])
    const info = (error as Error & { info?: { code: string; resetsAt?: number } }).info
    expect(info?.code).toBe("usage_limit")
    expect(info!.resetsAt! - before).toBeGreaterThanOrEqual(3720_000)
    expect(info!.resetsAt! - before).toBeLessThan(3730_000)
  })

  test("a 529 result under subtype success fails the turn as overloaded", async () => {
    const { adapter } = harness(["overloaded-529"])
    const { error } = await run(adapter, "hi")
    expect(error?.message).toBe("Claude API is overloaded (529). Try again shortly.")
  })

  test("terminal_reason prompt_too_long fails the turn even without is_error", async () => {
    const { adapter } = harness(["context-full"])
    const { error } = await run(adapter, "hi")
    expect(error?.message).toMatch(/context window/)
  })

  // usage.jsonl is a real 2.1.312 get_usage answer (utilization numbers raised to tell the windows apart).
  test("limits reads the account's windows from get_usage, a per-model limit as its own bucket", async () => {
    const { adapter, spawns } = harness(["usage"])
    const quota = await adapter.limits!()
    expect(quota?.plan).toBe("max")
    expect(quota?.windows).toEqual([
      { kind: "five_hour", minutes: 300, usedPercent: 37, resetsAt: Date.parse("2026-11-05T11:19:59.823253+00:00") },
      { kind: "seven_day", minutes: 10080, usedPercent: 14, resetsAt: Date.parse("2026-11-11T10:00:00.823276+00:00") },
      { limit: "Fable", kind: "seven_day", minutes: 10080, usedPercent: 12, resetsAt: Date.parse("2026-11-11T10:00:00+00:00") },
    ])
    expect(spawns[0]).toContain("--no-session-persistence")
    await adapter.limits!()
    expect(spawns).toHaveLength(1)
  })

  test("claudeUsage: an API-key login has no windows to show", () => {
    expect(claudeUsage({ rate_limits_available: false, rate_limits: null })).toBeUndefined()
  })

  test("detect: a definite no-credentials account is signed out; a probe the CLI cannot answer stays available", async () => {
    expect(await harness(["signed-out"]).adapter.detect!()).toEqual({
      available: false,
      reason: CLAUDE_SIGNED_OUT,
      reasonCopy: { code: "claude_signed_out", text: CLAUDE_SIGNED_OUT },
    })
    expect(unavailableCode(CLAUDE_SIGNED_OUT)).toBe("auth_required")
    expect(await harness(["signed-in"]).adapter.detect!()).toEqual({ available: true })
    expect(await harness(["-"]).adapter.detect!()).toEqual({ available: true })
    expect(await createClaudeAdapter({ spec: SPEC, command: "rudder-no-such-claude" }).detect!()).toEqual({
      available: false,
      reason: "未找到命令 rudder-no-such-claude",
      reasonCopy: { code: "command_missing", args: { command: "rudder-no-such-claude" }, text: "未找到命令 rudder-no-such-claude" },
    })
  })

  test("claudeSignedOut follows the account fields", () => {
    expect(claudeSignedOut({ tokenSource: "none" })).toBe(true)
    expect(claudeSignedOut({ tokenSource: "none", apiKeySource: "ANTHROPIC_API_KEY" })).toBe(false)
    expect(claudeSignedOut({ tokenSource: "none", email: "a@b.c" })).toBe(false)
    expect(claudeSignedOut({ tokenSource: "none", apiProvider: "bedrock" })).toBe(false)
    expect(claudeSignedOut({ email: "a@b.c", apiProvider: "firstParty" })).toBe(false)
  })

  test("probe processes run no hooks and load no MCP server", async () => {
    const { adapter, spawns } = harness(["-"])
    await adapter.listModels!()
    const probe = spawns[0]!
    expect(probe[probe.indexOf("--settings") + 1]).toBe(JSON.stringify({ disableAllHooks: true }))
    expect(probe).toContain("--strict-mcp-config")
    expect(probe[probe.indexOf("--mcp-config") + 1]).toBe(JSON.stringify({ mcpServers: {} }))
  })

  test("listModels", async () => {
    const { adapter } = harness(["-"])
    const models = await adapter.listModels!()
    expect(models[0]).toEqual({ id: "default", label: "Default (recommended)", efforts: ["low", "medium", "high", "xhigh", "max"] })
    expect(models.find((model) => model.id === "claude-haiku-4-5-20251001")?.efforts).toEqual([])
    expect(models.find((model) => model.id === "opus")?.speeds).toEqual([
      { id: "off", label: "Standard", description: "Standard speed" },
      { id: "fast", label: "Fast", description: "Faster responses, higher cost" },
    ])
    expect(models.find((model) => model.id === "opus")?.defaultSpeed).toBe("off")
    expect(models[0]?.speeds).toBeUndefined()
    expect(commandAvailability("rudder-no-such-claude").available).toBe(false)
  })
})

describe("Claude adapter stream mapping", () => {
  test("streams text and summarized thinking with globally unique ids", async () => {
    const { adapter } = harness(["text-thinking"])
    const before = Date.now()
    const { events, error } = await run(adapter, "Is 391 prime?")
    expect(error).toBeUndefined()
    const reasoning = of(events, "reasoning")
    // content_block_start is the start signal: every event of the block carries that moment.
    const startedAt = reasoning[0]!.startedAt!
    expect(startedAt).toBeGreaterThanOrEqual(before)
    expect(reasoning.every((event) => event.startedAt === startedAt)).toBe(true)
    expect(reasoning.map((event) => [event.text, event.done])).toEqual([
      ["391 chec", false],
      ["391 checks out as 17 times 23.", false],
      ["391 checks out as 17 times 23.", true],
    ])
    const texts = of(events, "text")
    expect(texts.map((event) => event.text)).toEqual(["391 is not prime,", "391 is not prime, because 17 × 23 = 391."])
    expect(new Set(texts.map((event) => event.id)).size).toBe(1)
    expect(texts[0]!.id).not.toBe(reasoning[0]!.id)
    expect(texts[0]!.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(texts[0]!.id).not.toContain("msg_")
    const usage = of(events, "usage")
    expect(usage).toEqual([
      {
        type: "usage",
        usage: {
          inputTokens: 4,
          outputTokens: 204,
          cacheReadTokens: 29661,
          cacheWriteTokens: 5281,
          reasoningTokens: 32,
          costUsd: 0.0522762,
          contextUsed: 17582,
          contextSize: 1000000,
        },
      },
    ])
  })

  test("empty thinking produces no reasoning event", async () => {
    const { adapter } = harness(["thinking-empty"])
    const { events } = await run(adapter, "What were you doing?")
    expect(of(events, "reasoning")).toEqual([])
    expect(finalTexts(events)).toEqual(["I had just started"])
  })

  test("compact_boundary reports whether the compaction was manual and includes available token counts", async () => {
    // Recorded from Claude Code 2.1.312 (r66): one turn, then /compact on the same process.
    const { adapter } = harness(["recorded/compaction"])
    const first = await run(adapter, "Reply ok.")
    expect(first.error).toBeUndefined()
    const { events, error } = await run(adapter, "/compact", { nativeId: nativeOf(first.events) })
    expect(error).toBeUndefined()
    const rows = of(events, "compaction")
    expect(rows).toMatchObject([
      { state: "running", trigger: "manual" },
      { state: "done", trigger: "manual", tokensBefore: 18792, tokensAfter: 3090 },
    ])
    // status: compacting opens the row; compact_boundary finishes the same one.
    expect(rows[0]!.id).toBe(rows[1]!.id)
    // The CLI's summary of itself is not a reply.
    expect(finalTexts(events).some((text) => text.includes("continued from a previous conversation"))).toBe(false)
  })

  test("a compaction that never reaches compact_boundary is closed when the turn ends", async () => {
    // status: compacting, then a failed compact_result and the result, with no compact_boundary.
    const { adapter } = harness(["compaction-unfinished"])
    const { events } = await run(adapter, "/compact")
    const rows = of(events, "compaction")
    expect(rows.map((row) => row.state)).toEqual(["running", "done"])
    expect(rows[0]!.id).toBe(rows[1]!.id)
  })

  test("tool cards finish as completed or failed, with kinds, exit codes and diffs", async () => {
    const { adapter } = harness(["tools"])
    const { events } = await run(adapter, "Read, echo, ls, write")
    const tools = finalTools(events)
    expect(tools.map((tool) => [tool.tool, tool.kind, tool.status])).toEqual([
      ["Read", "read", "completed"],
      ["Bash", "execute", "completed"],
      ["Bash", "execute", "failed"],
      ["Write", "edit", "completed"],
    ])
    expect(tools[0]!.detail).toBe("/tmp/ws/hello.txt")
    expect(tools[1]).toMatchObject({ title: "Print hi", detail: "echo hi", output: "hi" })
    expect(tools[2]!.exitCode).toBe(1)
    expect(tools[3]!.diffs).toEqual([{ path: "/tmp/ws/notes.md", newText: "# Notes\n" }])
    expect(tools[3]!.output).toBe("File created successfully at: /tmp/ws/notes.md")
    expect(of(events, "tool")[0]!.status).toBe("running")
  })
})

describe("Claude adapter permissions", () => {
  const cases = [
    ["allow", "perm-allow", "completed", { behavior: "allow", updatedInput: { command: "touch probe.txt", description: "Create empty file probe.txt" } }],
    [
      "allow_session",
      "perm-allow",
      "completed",
      // The daemon keeps the session rule; the CLI is never given one it would keep past a revoke.
      { behavior: "allow", updatedInput: { command: "touch probe.txt", description: "Create empty file probe.txt" } },
    ],
    ["reject", "perm-deny", "declined", { behavior: "deny", message: "The user declined this tool use." }],
    [
      "reject_stop",
      "perm-deny-stop",
      "declined",
      { behavior: "deny", message: "The user declined this tool use and stopped the turn.", interrupt: true },
    ],
    [null, "perm-deny", "cancelled", { behavior: "deny", message: "The permission request was cancelled." }],
  ] as const

  for (const [choice, scenario, status, response] of cases) {
    test(`${choice ?? "no answer"} maps to its control_response`, async () => {
      const { adapter, stdin } = harness([scenario])
      const { events, permissions, error } = await run(adapter, "touch probe.txt", {}, { askPermission: async () => choice })
      expect(error).toBeUndefined()
      expect(permissions).toHaveLength(1)
      expect(permissions[0]).toMatchObject({ tool: "Bash", title: "Create empty file probe.txt", detail: "touch probe.txt", kind: "execute" })
      // can_use_tool.tool_use_id resolves to the card the adapter opened for that tool_use.
      expect(permissions[0]!.toolId).toBe(finalTools(events)[0]!.id)
      expect(permissions[0]!.options.map((option) => [option.id, option.kind])).toEqual([
        ["allow", "allow_once"],
        ["allow_session", "allow_always"],
        ["reject", "reject_once"],
        ["reject_stop", "reject_once"],
      ])
      const responses = controlResponses(stdin(0))
      expect(responses).toEqual([{ subtype: "success", request_id: "perm-1", response }])
      expect(JSON.stringify(responses)).not.toContain("localSettings")
      expect(JSON.stringify(responses)).not.toContain("setMode")
      const statuses = of(events, "tool").map((event) => event.status)
      expect(statuses.slice(0, 2)).toEqual(["running", "pending"])
      expect(finalTools(events).map((tool) => tool.status)).toEqual([status])
    })
  }

  test("control_cancel_request withdraws the card and leaves the request unanswered", async () => {
    const { adapter, stdin } = harness(["perm-withdraw"])
    let withdrawn = false
    const { events, error } = await run(
      adapter,
      "touch probe.txt",
      {},
      {
        askPermission: (_request, withdraw) =>
          new Promise((resolve) => {
            withdraw?.addEventListener("abort", () => {
              withdrawn = true
              resolve(null)
            })
          }),
        onEvent: (event, controller) => {
          if (event.type === "tool" && event.status === "pending") controller.abort()
        },
      },
    )
    expect(error).toBeUndefined()
    expect(withdrawn).toBe(true)
    expect(controlRequests(stdin(0), "interrupt")).toHaveLength(1)
    expect(controlResponses(stdin(0))).toEqual([])
    expect(finalTools(events).map((tool) => tool.status)).toEqual(["cancelled"])
    expect(finalTexts(events)).toEqual(["Cancelled."])
  })

  test("AskUserQuestion becomes a question card and answers go back in updatedInput", async () => {
    const { adapter, stdin } = harness(["ask"])
    const { events, questions } = await run(
      adapter,
      "Ask me Red or Blue",
      {},
      { askQuestion: async () => ({ "Do you prefer Red or Blue?": "Blue" }) },
    )
    expect(questions).toEqual([
      {
        questions: [
          {
            question: "Do you prefer Red or Blue?",
            header: "Color",
            options: [
              { label: "Red", description: "Choose Red" },
              { label: "Blue", description: "Choose Blue" },
            ],
            multiSelect: false, allowsOther: true,
          },
        ],
      },
    ])
    const [response] = controlResponses(stdin(0))
    expect(response!.response.behavior).toBe("allow")
    expect(response!.response.updatedInput.answers).toEqual({ "Do you prefer Red or Blue?": "Blue" })
    expect(response!.response.updatedInput.questions[0].question).toBe("Do you prefer Red or Blue?")
    expect(of(events, "tool")).toEqual([])
    expect(finalTexts(events)).toEqual(["You prefer Blue."])
  })

  test("ExitPlanMode is a permission card with the plan; the CLI leaving plan mode is reported back", async () => {
    const { adapter, spawns, stdin } = harness(["plan"])
    const first = await run(adapter, "Plan it", { permissionMode: "plan" }, { askPermission: async () => "allow" })
    expect(spawns[0]).toContain("plan")
    expect(first.permissions[0]).toMatchObject({ tool: "ExitPlanMode", detail: "# Plan: create empty probe-plan.txt\n\n- Run `touch probe-plan.txt`.\n" })
    expect(controlResponses(stdin(0))[0]!.response).toEqual({
      behavior: "allow",
      updatedInput: { plan: "# Plan: create empty probe-plan.txt\n\n- Run `touch probe-plan.txt`.\n", planFilePath: "/tmp/plans/plan.md" },
    })
    // r29: the approved plan put the CLI in "default"; the session must follow or the next turn re-enters plan mode.
    expect(of(first.events, "mode")).toEqual([{ type: "mode", mode: "ask" }])
    const second = await run(adapter, "Next", { permissionMode: "ask", nativeId: nativeOf(first.events) })
    expect(second.error).toBeUndefined()
    expect(spawns).toHaveLength(1)
    expect(controlRequests(stdin(0), "set_permission_mode")).toEqual([])
    expect(of(second.events, "mode")).toEqual([])
  })

  test("choosing plan again after an approved plan switches the live process back", async () => {
    const { adapter, spawns, stdin } = harness(["plan"])
    const first = await run(adapter, "Plan it", { permissionMode: "plan" }, { askPermission: async () => "allow" })
    await run(adapter, "Next", { permissionMode: "plan", nativeId: nativeOf(first.events) })
    expect(spawns).toHaveLength(1)
    expect(controlRequests(stdin(0), "set_permission_mode")).toEqual([{ subtype: "set_permission_mode", mode: "plan" }])
  })

  test("asking is launched as manual and switched to as default; bypassPermissions relaunches with --resume", async () => {
    const { adapter, spawns, stdin } = harness(["two-turns"])
    const flag = (argv: string[]) => argv[argv.indexOf("--permission-mode") + 1]
    const first = await run(adapter, "hi", { permissionMode: "ask" })
    expect(flag(spawns[0]!)).toBe("manual")
    const nativeId = nativeOf(first.events)
    await run(adapter, "edits", { permissionMode: "acceptEdits", nativeId })
    expect(controlRequests(stdin(0), "set_permission_mode")).toEqual([{ subtype: "set_permission_mode", mode: "acceptEdits" }])
    // Claude cannot enter bypassPermissions mid-session.
    const bypass = await run(adapter, "go", { permissionMode: "bypassPermissions", nativeId })
    expect(bypass.error).toBeUndefined()
    expect(spawns).toHaveLength(2)
    expect(flag(spawns[1]!)).toBe("bypassPermissions")
    expect(spawns[1]![spawns[1]!.indexOf("--resume") + 1]).toBe(nativeId!)
    // Leaving it is a plain switch; the control request uses the SDK name for asking.
    await run(adapter, "ask", { permissionMode: "ask", nativeId })
    expect(spawns).toHaveLength(2)
    expect(controlRequests(stdin(1), "set_permission_mode")).toEqual([{ subtype: "set_permission_mode", mode: "default" }])
    expect(of(bypass.events, "mode")).toEqual([])
  })

  test("unknown control requests are answered with an error", async () => {
    const { adapter, stdin } = harness(["unknown-control"])
    const { events, error } = await run(adapter, "hi")
    expect(error).toBeUndefined()
    expect(controlResponses(stdin(0))).toEqual([
      { subtype: "error", request_id: "hook-1", error: "Unsupported control request subtype: hook_callback" },
    ])
    expect(finalTexts(events)).toEqual(["Done."])
  })
})

describe("Claude adapter steer", () => {
  test("a steered line's run stays in the same turn and leaves nothing for the next one", async () => {
    const { adapter, stdin } = harness(["steer"])
    const steered: boolean[] = []
    const first = await run(adapter, "hi", {}, {
      onEvent: (event) => {
        if (event.type === "text" && event.text === "First") void adapter.steer!("s1", "and more").then((ok) => steered.push(ok))
      },
    })
    expect(first.error).toBeUndefined()
    expect(steered).toEqual([true])
    expect(finalTexts(first.events)).toEqual(["First", "Second"])
    const usage = of(first.events, "usage")
    expect(usage).toHaveLength(1)
    expect(usage[0]!.usage.inputTokens).toBe(5)
    expect(usage[0]!.usage.outputTokens).toBe(12)
    expect(usage[0]!.usage.costUsd).toBeCloseTo(0.003, 10)
    // The steered turn is over: another steer is refused instead of becoming a stray run.
    expect(await adapter.steer!("s1", "late")).toBe(false)

    const second = await run(adapter, "next", { nativeId: nativeOf(first.events) })
    expect(second.error).toBeUndefined()
    expect(finalTexts(second.events)).toEqual(["Third"])
    expect(of(second.events, "usage")[0]!.usage.costUsd).toBeCloseTo(0.001, 10)
    expect(stdin(0).filter((line) => line.type === "user")).toHaveLength(3)
  })

  // Claude Code 2.1.312 folds a line written mid-run into that run (it echoes the line, then one result answers both):
  // waiting for a second result left the turn running until the next message pushed it out (owner, 2026-11-18).
  test("a steered line the CLI folds into the running run ends the turn on that run's result", async () => {
    const { adapter } = harness(["steer-folded"])
    const steered: boolean[] = []
    const started = Date.now()
    const { events, error } = await run(adapter, "hi", {}, {
      onEvent: (event) => {
        if (event.type === "text" && event.text === "First") void adapter.steer!("s1", "and more").then((ok) => steered.push(ok))
      },
    })
    expect(error).toBeUndefined()
    expect(steered).toEqual([true])
    expect(Date.now() - started).toBeLessThan(3_000)
    expect(finalTexts(events)).toEqual(["First", "Both"])
  })

  test("an interrupt after a steer still ends the turn on the first result", async () => {
    const { adapter, stdin } = harness(["steer-interrupt"], { interruptTimeoutMs: 5_000 })
    const started = Date.now()
    const { events, error } = await run(adapter, "hi", {}, {
      onEvent: (event, controller) => {
        if (event.type === "text" && event.text === "First") void adapter.steer!("s1", "and more").then(() => controller.abort())
      },
    })
    expect(error).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(3_000)
    expect(controlRequests(stdin(0), "interrupt")).toEqual([{ subtype: "interrupt" }])
    expect(finalTexts(events)).toEqual(["First"])
  })
})

describe("Claude adapter interrupts", () => {
  test("an abort while the user content is prepared never writes the user line", async () => {
    const { adapter, spawns, stdin } = harness(["turn-ok"], { interruptTimeoutMs: 5_000 })
    const controller = new AbortController()
    const events: AgentEvent[] = []
    const started = Date.now()
    const ctx: AdapterContext = {
      sessionId: "s1",
      cwd: tmpdir(),
      permissionMode: "ask",
      signal: controller.signal,
      emit: (event) => {
        events.push(event)
      },
      askPermission: async () => null,
      askQuestion: async () => null,
      // Read right before the content is built, i.e. after the process is up.
      get images() {
        controller.abort()
        return []
      },
    }
    await adapter.reply("hi", ctx)
    expect(Date.now() - started).toBeLessThan(3_000)
    expect(spawns).toHaveLength(1)
    expect(finalTexts(events)).toEqual(["Cancelled."])
    expect(stdin(0).filter((line) => line.type === "user")).toEqual([])
    expect(controlRequests(stdin(0), "interrupt")).toEqual([])
  })

  test("mid-text interrupt keeps the partial text and resolves", async () => {
    const { adapter, stdin } = harness(["interrupt-text"])
    const { events, error } = await run(adapter, "Write a story", {}, {
      onEvent: (event, controller) => {
        if (event.type === "text" && event.text === "The lighthouse keeper woke") controller.abort()
      },
    })
    expect(error).toBeUndefined()
    expect(controlRequests(stdin(0), "interrupt")).toEqual([{ subtype: "interrupt" }])
    expect(finalTexts(events)).toEqual(["The lighthouse keeper woke"])
    expect(of(events, "usage")[0]!.usage.costUsd).toBe(0)
  })

  test("interrupt during a running tool cancels the card", async () => {
    const { adapter } = harness(["interrupt-tool"])
    const { events, error } = await run(adapter, "ping", {}, {
      onEvent: (event, controller) => {
        if (event.type === "tool" && event.status === "running") controller.abort()
      },
    })
    expect(error).toBeUndefined()
    expect(finalTools(events).map((tool) => [tool.tool, tool.status])).toEqual([["Bash", "cancelled"]])
    expect(finalTexts(events)).toEqual(["Cancelled."])
  })

  test("a lost interrupt result is bounded by killing the process", async () => {
    const { adapter } = harness(["interrupt-hang"], { interruptTimeoutMs: 100 })
    const started = Date.now()
    const { events, error } = await run(adapter, "go", {}, {
      onEvent: (event, controller) => {
        if (event.type === "text") controller.abort()
      },
    })
    expect(error).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(3000)
    expect(finalTexts(events)).toEqual(["Partial"])
  })
})

describe("Claude adapter background hold", () => {
  // Owner 2026-11-18: a reply sat under 「正在回复」 and the session read 运行中 while a resumed subagent worked. SendMessage
  // resumes a finished background agent under its old task id (Claude Code 2.1.312, recorded with Haiku the same day).
  test("a background agent resumed under its finished task id holds the turn again until it reports", async () => {
    const { adapter } = harness(["background-resume"])
    const { events, error } = await Promise.race([run(adapter, "probe"), Bun.sleep(5_000).then(() => { throw new Error("the turn never ended") })])
    expect(error).toBeUndefined()
    expect(of(events, "background").map((event) => [event.open, event.paused])).toEqual([
      [1, false],
      [0, false],
      [1, false],
      [1, true],
      [0, true],
    ])
    expect(finalTexts(events)).toEqual(["它答了 ONE，再问一句", "已经续上它，等它回话", "它答了 TWO"])
  })

  test("a line written while the speech is paused is answered, and its result pauses the turn again", async () => {
    const { adapter, stdin } = harness(["background-steer"])
    const steered: boolean[] = []
    let pauses = 0
    const { events, error } = await run(adapter, "把 sleep 放到后台", {}, {
      onEvent: (event) => {
        if (event.type !== "background" || !event.paused || event.open !== 1) return
        pauses += 1
        if (pauses === 1) void adapter.steer!("s1", "顺便问一句").then((ok) => steered.push(ok))
      },
    })
    expect(error).toBeUndefined()
    expect(steered).toEqual([true])
    expect(stdin(0).filter((line) => line.type === "user").map((line) => line.message.content)).toEqual(["把 sleep 放到后台", "顺便问一句"])
    expect(finalTexts(events)).toEqual(["已经在后台开始", "收到，等后台跑完", "输出是 BG_DONE"])
    const marks = events.flatMap((event) =>
      event.type === "background" ? [`background ${event.open} ${event.paused ? "paused" : "speaking"}`] : event.type === "status" ? [`status ${event.status}`] : event.type === "text" ? [event.text] : event.type === "tool" && event.title === "Print hi" ? [`tool ${event.status}`] : [],
    )
    expect(marks).toEqual([
      "status running",
      "已经在后台开始",
      "background 1 speaking",
      "background 1 paused",
      // The line starts a run: the phone shows the agent working before its first word or tool.
      "status running",
      "tool running",
      "tool completed",
      "收到，等后台跑完",
      "background 1 paused",
      "background 0 paused",
      "status running",
      "输出是 BG_DONE",
    ])
  })

  test("a background task keeps the turn open until the concluding result", async () => {
    const { adapter } = harness(["background-hold"])
    const { events, error } = await run(adapter, "把 sleep 放到后台")
    expect(error).toBeUndefined()
    expect(finalTexts(events)).toEqual(["已经在后台开始", "输出是 BG_DONE"])
    const background = of(events, "background")
    expect(background.map((event) => [event.open, event.paused])).toEqual([
      [1, false],
      [1, true],
      [0, true],
    ])
    expect(background[0]?.tasks).toEqual([
      expect.objectContaining({ id: "bsn5ucobf", kind: "command", title: "sleep 20 && echo BG_DONE", status: "running" }),
    ])
    expect(background.at(-1)?.tasks[0]).toMatchObject({ status: "done", exitCode: 0 })
    const backgroundAt = events.findIndex((event) => event.type === "background" && event.paused)
    const resumedAt = events.findIndex((event, index) => index > backgroundAt && event.type === "status" && event.status === "running")
    const followAt = events.findIndex((event) => event.type === "text" && event.text === "输出是 BG_DONE")
    expect(resumedAt).toBeGreaterThan(backgroundAt)
    expect(followAt).toBeGreaterThan(resumedAt)
    expect(finalTools(events).map((tool) => [tool.tool, tool.status])).toEqual([["Bash", "completed"]])
  })

  test("an async Agent card stays running until its notification, then shows the subagent's final words", async () => {
    const transcript = [
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "draft" }] } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "…" }] } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "HOT PATH: list rows" }] } },
    ]
    await Bun.write("/tmp/rudder-fixture-agent-output.jsonl", `${transcript.map((line) => JSON.stringify(line)).join("\n")}\n`)
    const { adapter } = harness(["background-agent"])
    const { events, error } = await run(adapter, "派子代理")
    expect(error).toBeUndefined()
    expect(finalTexts(events)).toEqual(["派一个子代理去查", "子代理说热点在列表"])
    const cards = of(events, "tool").filter((tool) => tool.tool === "Agent")
    const launched = cards.find((tool) => tool.output?.startsWith("Async agent launched"))
    expect(launched?.status).toBe("running")
    expect(finalTools(events).map((tool) => [tool.tool, tool.status, tool.output])).toEqual([["Agent", "completed", "HOT PATH: list rows"]])
    expect(of(events, "background").at(-1)?.tasks[0]).toMatchObject({ kind: "subagent", status: "done" })
  })

  // wake-untracked.jsonl: recorded/wake-agent.jsonl without its task_started frames, so the turn settles on the first
  // result and the subagent's notification and Claude's own follow-up arrive with no turn (an untracked task).
  const owner = { sessionId: "s1", turnId: "t1", generation: 0, agentId: "claude" }
  const offersOf = (adapter: AgentAdapter) => {
    const offers: import("./types").ContinuationOffer[] = []
    adapter.setContinuationSink!((offer) => offers.push(offer) > 0)
    return offers
  }
  const waitFor = async (check: () => boolean) => {
    const deadline = Date.now() + 3000
    while (!check() && Date.now() < deadline) await Bun.sleep(10)
  }

  test("output after the turn settles is offered once and replayed into the continuation", async () => {
    const { adapter, stdin } = harness(["wake-untracked"])
    const offers = offersOf(adapter)
    const first = await run(adapter, "派后台子代理", { executionIdentity: owner })
    expect(first.error).toBeUndefined()
    await waitFor(() => offers.length > 0)
    await Bun.sleep(100)
    expect(offers).toHaveLength(1)
    expect(offers[0]).toMatchObject({ delivery: "buffered", key: "a3f61b73981700042", detail: "DONE", identity: { ...owner, turnId: "t1" } })
    const sent = stdin().filter((line) => line.type === "user").length
    const native = nativeOf(first.events)
    const next = await run(adapter, "DONE", { nativeId: native, executionIdentity: { ...owner, turnId: "t2" }, continuation: { key: offers[0]!.key, delivery: "buffered" } })
    expect(next.error).toBeUndefined()
    expect(stdin().filter((line) => line.type === "user")).toHaveLength(sent)
    expect(finalTexts(next.events).join("")).toContain("The background agent finished")
    expect(finalTexts(first.events).join("")).not.toContain("The background agent finished")
  })

  test("a prompt after a buffered wake replays it first and waits for its own result", async () => {
    const { adapter } = harness(["wake-untracked-reply"])
    const offers = offersOf(adapter)
    const first = await run(adapter, "派后台子代理", { executionIdentity: owner })
    await waitFor(() => offers.length > 0)
    const next = await run(adapter, "再问一句", { nativeId: nativeOf(first.events), executionIdentity: { ...owner, turnId: "t2" } })
    expect(next.error).toBeUndefined()
    const texts = finalTexts(next.events).join("|")
    expect(texts).toContain("The background agent finished")
    expect(texts).toContain("USER REPLY")
  })

  test("a refused offer drops what was kept", async () => {
    const { adapter } = harness(["wake-untracked"])
    const offers: unknown[] = []
    adapter.setContinuationSink!((offer) => offers.push(offer) < 0)
    const first = await run(adapter, "派后台子代理", { executionIdentity: owner })
    await waitFor(() => offers.length > 0)
    await Bun.sleep(100)
    const started = Date.now()
    const next = await run(adapter, "wake", { nativeId: nativeOf(first.events), executionIdentity: owner, continuation: { key: "k", delivery: "buffered" } })
    expect(Date.now() - started).toBeLessThan(1000)
    expect(finalTexts(next.events).join("")).not.toContain("The background agent finished")
  })

  test("a resting process with a kept wake is not stopped by the idle timer", async () => {
    // The wake frames come ~150 ms after the turn; the 250 ms idle timer fires while they are kept.
    const { adapter, spawns } = harness(["wake-untracked"], { idleTimeoutMs: 250 })
    const offers = offersOf(adapter)
    const first = await run(adapter, "派后台子代理", { executionIdentity: owner })
    await waitFor(() => offers.length > 0)
    await Bun.sleep(600)
    const next = await run(adapter, "wake", { nativeId: nativeOf(first.events), executionIdentity: { ...owner, turnId: "t2" }, continuation: { key: offers[0]!.key, delivery: "buffered" } })
    expect(spawns).toHaveLength(1)
    expect(finalTexts(next.events).join("")).toContain("The background agent finished")
  })

  test("cancelContinuation clears the buffer and refuses offers until the next user turn", async () => {
    const { adapter } = harness(["wake-untracked"])
    const offers = offersOf(adapter)
    await run(adapter, "派后台子代理", { executionIdentity: owner }, { onEvent: (event: AgentEvent) => {
      if (event.type === "text") adapter.cancelContinuation!("s1")
    } } as never)
    await Bun.sleep(400)
    expect(offers).toEqual([])
  })

  test("a continuation with nothing kept settles at once", async () => {
    const { adapter } = harness(["-"])
    const started = Date.now()
    const next = await run(adapter, "wake", { executionIdentity: owner, continuation: { key: "k", delivery: "buffered" } })
    expect(next.error).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(2000)
  })

  // wake-unfinished.jsonl: wake-untracked.jsonl with the wake's result held back until the CLI is interrupted.
  test("a continuation past its deadline interrupts the CLI like a stop", async () => {
    const { adapter, spawns, stdin } = harness(["wake-unfinished"], { continuationDeadlineMs: 300, interruptTimeoutMs: 5_000 })
    const offers = offersOf(adapter)
    const first = await run(adapter, "派后台子代理", { executionIdentity: owner })
    await waitFor(() => offers.length > 0)
    const next = await run(adapter, "wake", { nativeId: nativeOf(first.events), executionIdentity: { ...owner, turnId: "t2" }, continuation: { key: offers[0]!.key, delivery: "buffered" } })
    expect(next.error).toBeUndefined()
    expect(stdin().filter((line) => line.type === "control_request" && obj(line.request).subtype === "interrupt")).toHaveLength(1)
    expect(of(next.events, "lifecycle").at(-1)).toMatchObject({ phase: "terminal", terminalStatus: "interrupted" })
    await Bun.sleep(200)
    expect(offers).toHaveLength(1)
    expect(spawns).toHaveLength(1)
  })

  test("two background tasks: every change carries the list, a failure keeps its exit code", async () => {
    const { adapter } = harness(["background-two"])
    const { events, error } = await run(adapter, "清并发警告，顺手跑测试")
    expect(error).toBeUndefined()
    const background = of(events, "background")
    expect(background.map((event) => [event.open, event.paused])).toEqual([
      [1, false],
      [2, false],
      [2, true],
      [1, true],
      [0, true],
    ])
    expect(background[1]?.tasks.map((task) => [task.id, task.kind, task.title])).toEqual([
      ["a1", "subagent", "查并发警告"],
      ["b2", "command", "bun test --watch daemon"],
    ])
    // toolId is the tool card's row id, so the phone can jump to it.
    const cards = new Map(finalTools(events).map((tool) => [tool.tool, tool.id]))
    expect(background[1]?.tasks.map((task) => task.toolId)).toEqual([cards.get("Task"), cards.get("Bash")])
    const last = background.at(-1)!
    expect(last.tasks.map((task) => [task.id, task.status, task.exitCode])).toEqual([
      ["a1", "done", undefined],
      ["b2", "failed", 1],
    ])
    expect(last.tasks.every((task) => typeof task.endedAt === "number" && task.endedAt >= task.startedAt)).toBe(true)
    expect(finalTexts(events)).toEqual(["开了两个后台任务", "测试挂了 1 个"])
    expect(finalTools(events).map((tool) => [tool.tool, tool.status])).toEqual([
      ["Task", "completed"],
      ["Bash", "failed"],
    ])
  })

  test("a task opened after the pause counts, and the turn waits for it too", async () => {
    const { adapter } = harness(["background-later"])
    const { events, error } = await run(adapter, "睡两次")
    expect(error).toBeUndefined()
    const background = of(events, "background")
    expect(background.map((event) => event.open)).toEqual([1, 1, 0, 1, 1, 0])
    expect(background.at(-1)?.tasks.map((task) => [task.id, task.status])).toEqual([
      ["c1", "done"],
      ["c2", "done"],
    ])
    expect(finalTexts(events)).toEqual(["先睡一下", "再睡一下", "都睡完了"])
  })

  // Claude Code 2.1.312 says nothing after a stopped task: no follow-up speech, no result. The turn ends on the stop.
  // Recorded (r66): after stop_task the CLI writes task_updated (killed), task_notification (stopped) and an empty
  // background_tasks_changed, then nothing.
  test("stopBackground sends stop_task per running task, the task ends cancelled and the turn ends", async () => {
    const { adapter, stdin } = harness(["recorded/background-stop"])
    const { events, error } = await run(adapter, "睡很久", {}, {
      onEvent: (event) => {
        if (event.type === "background" && event.paused && event.open === 1) void adapter.stopBackground?.("s1")
      },
    })
    expect(error).toBeUndefined()
    expect(stdin().filter((frame) => obj(frame.request).subtype === "stop_task").map((frame) => obj(frame.request).task_id)).toEqual(["bzhd92ogs"])
    expect(of(events, "background").at(-1)?.tasks[0]).toMatchObject({ id: "bzhd92ogs", status: "cancelled" })
    expect(finalTexts(events)).toEqual(["started"])
  })

  // Plan 2026-11-17-agent-questions Task 3: Claude 2.1.312 forwards an MCP server's form as control_request
  // `elicitation` (recorded/elicit-form.jsonl: the probe server's pizza form).
  const elicitReplies = (frames: Json[]) =>
    frames.filter((frame) => frame.type === "control_response" && "action" in obj(obj(frame.response).response)).map((frame) => obj(obj(frame.response).response))

  test("an MCP elicitation is a question card and its answers go back as the form's content", async () => {
    const { adapter, stdin } = harness(["recorded/elicit-form"])
    const { questions, error } = await run(adapter, "order", {}, {
      askPermission: async () => "allow",
      askQuestion: async (request) => {
        const [toppings, size, crust, sauce, count, note] = request.questions.map((item) => item.question)
        return { [toppings!]: ["cheese", "olive"], [size!]: "Large", [crust!]: "thin", [sauce!]: "Yes", [count!]: "2", [note!]: "no onions" }
      },
    })
    expect(error).toBeUndefined()
    expect(questions[0]!.questions.map((item) => item.header)).toEqual(["Toppings", "Size", "Crust", "Extra sauce", "How many", "Note for the kitchen"])
    expect(elicitReplies(stdin())).toEqual([{ action: "accept", content: PIZZA }])
  })

  // recorded/ask-multi.jsonl: AskUserQuestion with multiSelect; Claude reads the picks comma-joined.
  test("a multi-select question goes back comma-joined", async () => {
    const { adapter, stdin } = harness(["recorded/ask-multi"])
    const { questions } = await run(adapter, "toppings", {}, {
      askQuestion: async (request) => ({ [request.questions[0]!.question]: ["Cheese", "Mushroom"] }),
    })
    expect(questions[0]!.questions[0]).toMatchObject({ question: "Which toppings do you want?", multiSelect: true })
    const answered = stdin().find((frame) => frame.type === "control_response" && obj(obj(obj(frame.response).response).updatedInput).answers)
    expect(obj(obj(obj(answered!.response).response).updatedInput).answers).toEqual({ "Which toppings do you want?": "Cheese, Mushroom" })
  })

  test("an unanswered MCP elicitation is cancelled", async () => {
    const { adapter, stdin } = harness(["recorded/elicit-form"])
    await run(adapter, "order", {}, { askPermission: async () => "allow", askQuestion: async () => null })
    expect(elicitReplies(stdin())).toEqual([{ action: "cancel" }])
  })

  test("stopBackground without a live turn answers false", async () => {
    const { adapter } = harness(["turn-ok"])
    expect(await adapter.stopBackground?.("nobody")).toBe(false)
  })

  test("a foreground task_started still closes on the first result", async () => {
    const { adapter } = harness(["foreground-task"])
    const { events, error } = await run(adapter, "hi")
    expect(error).toBeUndefined()
    expect(of(events, "background")).toEqual([])
    expect(finalTexts(events)).toEqual(["Done."])
  })
})

describe("Claude adapter process control", () => {
  test("a child that ignores SIGTERM is killed after an unanswered interrupt", async () => {
    const adapter = createClaudeAdapter({ spec: SPEC, command: "sh", args: () => ["-c", "trap '' TERM; while read line; do :; done"], interruptTimeoutMs: 200 })
    cleanups.push(() => adapter.dispose?.())
    const outcome = run(adapter, "hi", {}, {
      onEvent: (event, controller) => {
        if (event.type === "status") setTimeout(() => controller.abort(), 100)
      },
    })
    const result = await Promise.race([outcome, Bun.sleep(4500).then(() => undefined)])
    expect(result).toBeDefined()
    expect(result!.error).toBeUndefined()
    expect(finalTexts(result!.events)).toEqual(["Cancelled."])
  }, 10_000)

  test("a grandchild holding stdout open does not delay exit detection", async () => {
    const adapter = createClaudeAdapter({ spec: SPEC, command: "sh", args: () => ["-c", "sleep 6 & exit 0"] })
    const started = Date.now()
    await expect(adapter.listModels!()).rejects.toThrow(/exited with code 0/)
    expect(Date.now() - started).toBeLessThan(2000)
  }, 10_000)

  test("an abort while the stale process stops ends the turn instead of retrying", async () => {
    const { adapter, spawns } = harness(["resume-missing-slow", "turn-ok"])
    const outcome = run(adapter, "hi", { nativeId: "00000000-0000-4000-8000-000000000000" }, {
      onEvent: (event, controller) => {
        if (event.type === "status") setTimeout(() => controller.abort(), 500)
      },
    })
    const { events, error } = await outcome
    expect(error).toBeUndefined()
    expect(spawns).toHaveLength(1)
    expect(finalTexts(events)).toEqual(["Cancelled."])
  }, 10_000)

  // Audit 2026-11-10 #23: a stop while the process was still being acquired returned with the CLI left running and
  // no idle timer to end it.
  test("a stop during the cold start leaves no Claude process behind", async () => {
    const { adapter, spawns } = harness(["turn-ok"])
    const { events, error } = await run(adapter, "hi", {}, {
      onEvent: (event, controller) => {
        if (event.type === "status") controller.abort()
      },
    })
    expect(error).toBeUndefined()
    expect(spawns).toHaveLength(1)
    expect(finalTexts(events)).toEqual(["Cancelled."])
    expect(adapter.processes!()).toEqual([])
  })

  test("forget stops the session's process; the next turn resumes in a new one", async () => {
    const { adapter, spawns } = harness(["turn-ok", "resume"])
    const first = await run(adapter, "one")
    adapter.forget!("s1")
    const second = await run(adapter, "two", { nativeId: nativeOf(first.events) })
    expect(second.error).toBeUndefined()
    expect(spawns).toHaveLength(2)
    expect(spawns[1]).toContain("--resume")
  })
})

describe("Claude native rewind", () => {
  test("a turn reports its last main-chain record; rewind resumes the next process at the kept one, once", async () => {
    const projects = mkdtempSync(join(tmpdir(), "rudder-claude-projects-"))
    cleanups.push(() => rmSync(projects, { recursive: true, force: true }))
    const { adapter, spawns } = harness(["native-turn"], { projectsDir: projects })
    const first = await run(adapter, "one")
    const nativeId = nativeOf(first.events)!
    expect(of(first.events, "nativeTurn")).toEqual([{ type: "nativeTurn", nativeId, lastMessageId: "a-2" }])

    // No transcript, or one without the record: the CLI would fail every turn, so the daemon carries over instead.
    expect(await adapter.rewind!("s1", { nativeId, keepThrough: "a-1" })).toBe(false)
    mkdirSync(join(projects, "-tmp-ws"))
    writeFileSync(join(projects, "-tmp-ws", `${nativeId}.jsonl`), `{"type":"assistant","uuid":"a-0"}\n`)
    expect(await adapter.rewind!("s1", { nativeId, keepThrough: "a-1" })).toBe(false)
    writeFileSync(join(projects, "-tmp-ws", `${nativeId}.jsonl`), `{"type":"assistant","uuid":"a-1"}\n`)
    expect(await adapter.rewind!("s1", { nativeId })).toBe(false)
    expect(await adapter.rewind!("s1", { nativeId, keepThrough: "a-1" })).toBe(true)

    await run(adapter, "two", { nativeId })
    expect(spawns).toHaveLength(2)
    expect(spawns[1]!.slice(spawns[1]!.indexOf("--resume-session-at"), spawns[1]!.indexOf("--resume-session-at") + 2)).toEqual([
      "--resume-session-at",
      "a-1",
    ])
    adapter.release!("s1")
    await run(adapter, "three", { nativeId })
    expect(spawns).toHaveLength(3)
    expect(spawns[2]).not.toContain("--resume-session-at")
  })
})

describe("Claude adapter lifecycle", () => {
  test("multi-turn on one process; cumulative cost is diffed; set_model switches live", async () => {
    const { adapter, spawns, stdin } = harness(["two-turns"])
    const first = await run(adapter, "Remember KIWI-9", { model: "haiku" })
    const nativeId = nativeOf(first.events)
    const second = await run(adapter, "What was it?", { model: "sonnet", nativeId })
    expect(second.error).toBeUndefined()
    expect(spawns).toHaveLength(1)
    expect(controlRequests(stdin(0), "set_model")).toEqual([{ subtype: "set_model", model: "sonnet" }])
    expect(stdin(0).filter((line) => line.type === "user")).toHaveLength(2)
    expect(of(second.events, "native")).toEqual([])
    expect(finalTexts(second.events)).toEqual(["KIWI-9"])
    expect(of(first.events, "usage")[0]!.usage.costUsd).toBeCloseTo(0.00127629, 10)
    expect(of(second.events, "usage")[0]!.usage.costUsd).toBeCloseTo(0.00211517 - 0.00127629, 10)
  })

  test("idle reclaim closes the process; the next turn resumes it and the restored cost is not re-billed", async () => {
    const { adapter, spawns } = harness(["turn-ok", "resume"], { idleTimeoutMs: 50 })
    const first = await run(adapter, "Remember TANGERINE-42")
    const nativeId = nativeOf(first.events)!
    await Bun.sleep(400)
    const second = await run(adapter, "What was the codeword?", { nativeId })
    expect(second.error).toBeUndefined()
    expect(spawns).toHaveLength(2)
    expect(spawns[1]!.slice(spawns[1]!.indexOf("--resume"), spawns[1]!.indexOf("--resume") + 2)).toEqual(["--resume", nativeId])
    expect(spawns[1]).not.toContain("--session-id")
    expect(of(second.events, "native")).toEqual([])
    expect(of(second.events, "usage")[0]!.usage.costUsd).toBeCloseTo(0.00175961 - 0.00091911, 10)
  })

  test("after a daemon restart a restored total is not billed as one turn", async () => {
    const { adapter, spawns } = harness(["resume"])
    const { events } = await run(adapter, "What was the codeword?", { nativeId: "11111111-2222-4333-8444-555555555555" })
    expect(spawns[0]).toContain("--resume")
    const usage = of(events, "usage")[0]!.usage
    expect(usage.outputTokens).toBe(10)
    expect(usage.costUsd).toBeUndefined()
  })

  test("fast mode starts as a launch setting; turning it off on a CLI without apply_flag_settings respawns", async () => {
    const { adapter, spawns } = harness(["turn-ok-old-cli", "resume"])
    const first = await run(adapter, "one", { speed: "fast" })
    expect(spawns[0]!.slice(spawns[0]!.indexOf("--settings"), spawns[0]!.indexOf("--settings") + 2)).toEqual([
      "--settings",
      JSON.stringify({ fastMode: true }),
    ])
    const second = await run(adapter, "two", { speed: "off", nativeId: nativeOf(first.events) })
    expect(second.error).toBeUndefined()
    expect(spawns).toHaveLength(2)
    expect(spawns[1]).toContain("--resume")
    expect(spawns[1]).not.toContain("--settings")
  })

  test("an effort or fast change is applied in place with apply_flag_settings", async () => {
    const { adapter, spawns, stdin } = harness(["two-turns"])
    const first = await run(adapter, "one", { effort: "low" })
    const second = await run(adapter, "two", { effort: "high", speed: "fast", nativeId: nativeOf(first.events) })
    expect(second.error).toBeUndefined()
    expect(spawns).toHaveLength(1)
    const applied = stdin(0).filter((line) => line.request?.subtype === "apply_flag_settings")
    expect(applied.map((line) => line.request.settings)).toEqual([{ effortLevel: "high", fastMode: true }])
  })

  test("clearing the effort restarts the process with --resume", async () => {
    const { adapter, spawns } = harness(["turn-ok", "resume"])
    const first = await run(adapter, "one", { effort: "low" })
    const second = await run(adapter, "two", { nativeId: nativeOf(first.events) })
    expect(second.error).toBeUndefined()
    expect(spawns).toHaveLength(2)
    expect(spawns[1]).toContain("--resume")
    expect(spawns[1]).not.toContain("--effort")
  })

  test("a CLI without apply_flag_settings restarts with --resume and the new --effort", async () => {
    const { adapter, spawns } = harness(["turn-ok-old-cli", "resume"])
    const first = await run(adapter, "one", { effort: "low" })
    const second = await run(adapter, "two", { effort: "high", nativeId: nativeOf(first.events) })
    expect(second.error).toBeUndefined()
    expect(spawns).toHaveLength(2)
    expect(spawns[1]!.slice(spawns[1]!.indexOf("--effort"), spawns[1]!.indexOf("--effort") + 2)).toEqual(["--effort", "high"])
  })

  test("a crash surfaces stderr; the next turn respawns with --resume", async () => {
    const { adapter, spawns } = harness(["crash", "resume"])
    const first = await run(adapter, "go")
    expect(first.error?.message).toContain("code 3")
    expect(first.error?.message).toContain("fatal: stream broke")
    const nativeId = nativeOf(first.events)!
    const second = await run(adapter, "again", { nativeId })
    expect(second.error).toBeUndefined()
    expect(spawns[1]!.slice(spawns[1]!.indexOf("--resume"), spawns[1]!.indexOf("--resume") + 2)).toEqual(["--resume", nativeId])
  })

  test("a missing resume id self-heals: fresh session, new native, a notice, then the reply", async () => {
    const { adapter, spawns, stdin } = harness(["resume-missing", "turn-ok"])
    const stale = "00000000-0000-4000-8000-000000000000"
    const { events, error } = await run(adapter, "hi", { nativeId: stale })
    expect(error).toBeUndefined()
    expect(spawns).toHaveLength(2)
    expect(spawns[0]!.slice(spawns[0]!.indexOf("--resume"), spawns[0]!.indexOf("--resume") + 2)).toEqual(["--resume", stale])
    expect(spawns[1]).not.toContain("--resume")
    const fresh = spawns[1]![spawns[1]!.indexOf("--session-id") + 1]!
    expect(fresh).toMatch(/^[0-9a-f-]{36}$/)
    expect(fresh).not.toBe(stale)
    expect(of(events, "native")).toEqual([{ type: "native", nativeId: fresh }])
    const texts = finalTexts(events)
    expect(texts[0]).toBe(STALE_RESUME_NOTICE)
    // A notice the phone words in its own language, not agent text.
    expect(events.find((event) => event.type === "text" && event.text === STALE_RESUME_NOTICE)).toMatchObject({
      notice: true,
      copy: { code: "stale_resume", text: STALE_RESUME_NOTICE },
    })
    expect(texts).toHaveLength(2)
    // The notice comes before anything of the reply, and the user text reached the fresh process.
    expect(events.findIndex((event) => event.type === "text")).toBe(events.findIndex((event) => event.type === "text" && event.text === STALE_RESUME_NOTICE))
    expect(stdin(1).filter((line) => line.type === "user")).toHaveLength(1)
    // The stale attempt bills nothing.
    expect(of(events, "usage")).toHaveLength(1)
  })

  test("a copy forks its source: --resume source --fork-session names the fork with --session-id (v48 B)", async () => {
    const { adapter, spawns, stdin } = harness(["turn-ok"])
    const source = "11111111-2222-4333-8444-555555555555"
    const { events, error } = await run(adapter, "which word", { forkFrom: source, carryOver: "User: remember PINEAPPLE" })
    expect(error).toBeUndefined()
    const argv = spawns[0]!
    expect(argv.slice(argv.indexOf("--resume"), argv.indexOf("--resume") + 2)).toEqual(["--resume", source])
    expect(argv).toContain("--fork-session")
    const fork = argv[argv.indexOf("--session-id") + 1]!
    expect(fork).not.toBe(source)
    expect(nativeOf(events)).toBe(fork)
    expect(stdin(0).find((line) => line.type === "user")?.message.content).toBe("which word")
  })

  test("a copy whose source is gone carries the transcript into a fresh session, without the stale notice", async () => {
    const { adapter, spawns, stdin } = harness(["resume-missing", "turn-ok"])
    const { events, error } = await run(adapter, "which word", {
      forkFrom: "00000000-0000-4000-8000-000000000000",
      carryOver: "User: remember PINEAPPLE",
    })
    expect(error).toBeUndefined()
    expect(spawns).toHaveLength(2)
    expect(spawns[1]).not.toContain("--resume")
    expect(spawns[1]).not.toContain("--fork-session")
    expect(finalTexts(events)).not.toContain(STALE_RESUME_NOTICE)
    const sent = stdin(1).find((line) => line.type === "user")?.message.content as string
    expect(sent).toContain("User: remember PINEAPPLE")
    expect(sent.endsWith("which word")).toBe(true)
  })

  test("a fresh session that fails the same way is not retried again", async () => {
    const { adapter, spawns } = harness(["resume-missing"])
    const { error } = await run(adapter, "hi", { nativeId: "00000000-0000-4000-8000-000000000000" })
    expect(error?.message).toContain("No conversation found")
    expect(spawns).toHaveLength(2)
  })

  test("other failures of a resumed session still throw", async () => {
    const { adapter, spawns } = harness(["crash"])
    const { error } = await run(adapter, "go", { nativeId: "11111111-2222-4333-8444-555555555555" })
    expect(error?.message).toContain("fatal: stream broke")
    expect(spawns).toHaveLength(1)
  })

  test("clearing the session (no nativeId) starts a fresh process", async () => {
    const { adapter, spawns } = harness(["turn-ok"])
    await run(adapter, "one")
    await run(adapter, "two")
    expect(spawns).toHaveLength(2)
    expect(spawns[1]).toContain("--session-id")
    expect(spawns[1]![spawns[1]!.indexOf("--session-id") + 1]).not.toBe(spawns[0]![spawns[0]!.indexOf("--session-id") + 1])
  })
})

describe("claude adapter · processes", () => {
  test("one process per session, not shared; gone after forget", async () => {
    const { adapter } = harness(["turn-ok"])
    expect(adapter.processes!()).toEqual([])
    await run(adapter, "one")
    await run(adapter, "two", { sessionId: "s2" })
    const listed = adapter.processes!()
    expect(listed.map(({ agent, sessionIds, shared }) => ({ agent, sessionIds, shared }))).toEqual([
      { agent: "claude", sessionIds: ["s1"], shared: false },
      { agent: "claude", sessionIds: ["s2"], shared: false },
    ])
    expect(listed[0]!.pid).not.toBe(listed[1]!.pid)
    for (const entry of listed) expect(() => process.kill(entry.pid, 0)).not.toThrow()
    adapter.forget!("s1")
    expect(adapter.processes!().map((entry) => entry.sessionIds)).toEqual([["s2"]])
  })
})

 test("Claude recovers result text after preliminary speech", async () => {
  const { adapter } = harness(["final-recovery"])
  const { events, error } = await run(adapter, "merge")
  expect(error).toBeUndefined()
  expect(events.filter(event => event.type === "text").map(event => event.text)).toEqual(["I will merge", "MERGED_FINAL"])
  expect(events.find(event => event.type === "replyDisposition")).toMatchObject({ value: "present" })
})

// Plan 2026-11-18-turn-end-authoritative: with CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1 a turn ends on the CLI's own
// `idle` (system/session_state_changed), never on a count of results. recorded/state-*.jsonl are Claude Code 2.1.312
// with that switch on (scripts/record/record-claude.ts); state-wake*.jsonl are the same frames written by hand.
describe("Claude adapter turn end on the CLI's idle", () => {
  const owner = { sessionId: "s1", turnId: "t1", generation: 0, agentId: "claude" }
  // A turn that has not ended after `ms` fails the test instead of hanging it.
  const within = <T>(ms: number, promise: Promise<T>) =>
    Promise.race([promise, Bun.sleep(ms).then(() => Promise.reject(new Error(`the turn did not end within ${ms} ms`)))])
  const terminal = (events: AgentEvent[]) => of(events, "lifecycle").at(-1)

  test("A: the process is launched with state events and the turn ends on idle", async () => {
    const { adapter, dir, stdin } = harness(["recorded/state-turn"])
    const { events, error } = await within(5_000, run(adapter, "Reply with the single word: ok"))
    expect(error).toBeUndefined()
    expect(finalTexts(events)).toEqual(["ok"])
    expect(terminal(events)).toMatchObject({ phase: "terminal", terminalStatus: "completed" })
    expect(readFileSync(join(dir, "stdin-0.jsonl.env"), "utf8")).toContain('"CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS":"1"')
    expect(controlRequests(stdin(0), "initialize")).toHaveLength(1)
  })

  // The 18:01 stuck turn: set_model on a warm process writes an isReplay `<local-command-stdout>` user frame with no
  // turn set; kept as the CLI's own run, it made the next prompt wait for a result that never came.
  test("set_model's local-command echo between turns does not hold the next turn", async () => {
    const { adapter, stdin } = harness(["recorded/state-set-model"])
    const first = await within(5_000, run(adapter, "Reply with the single word: ok", { executionIdentity: owner }))
    expect(first.error).toBeUndefined()
    const second = await within(3_000, run(adapter, "Reply with the single word: again", { nativeId: nativeOf(first.events), model: "sonnet", executionIdentity: { ...owner, turnId: "t2" } }))
    expect(second.error).toBeUndefined()
    expect(controlRequests(stdin(0), "set_model")).toEqual([{ subtype: "set_model", model: "sonnet" }])
    expect(finalTexts(second.events)).toEqual(["again"])
    expect(terminal(second.events)).toMatchObject({ terminalStatus: "completed" })
  })

  test("B: a line the CLI folds into the running run ends with that run", async () => {
    const { adapter } = harness(["recorded/state-steer-folded"])
    const steered: boolean[] = []
    const { events, error } = await within(5_000, run(adapter, "Run `sleep 6` with the Bash tool (not in the background), then say done.", {}, {
      onEvent: (event) => {
        if (event.type === "tool" && event.tool === "Bash" && steered.length === 0) void adapter.steer!("s1", "Also add the word lantern to your final answer.").then((ok) => steered.push(ok))
      },
    }))
    expect(error).toBeUndefined()
    expect(steered).toEqual([true])
    expect(finalTexts(events)).toEqual(["Done. lantern"])
    expect(await adapter.steer!("s1", "late")).toBe(false)
  })

  test("C: a line queued behind the final text runs in the same turn, which ends on the one idle after both", async () => {
    const { adapter } = harness(["recorded/state-steer-queued"])
    let steered = false
    const { events, error } = await within(5_000, run(adapter, "Write one paragraph of about 120 words about lighthouses.", {}, {
      onEvent: (event) => {
        if (event.type !== "text" || steered) return
        steered = true
        void adapter.steer!("s1", "Then reply with the single word: done")
      },
    }))
    expect(error).toBeUndefined()
    const texts = finalTexts(events)
    expect(texts[0]).toStartWith("Lighthouses")
    expect(texts.at(-1)).toBe("done")
    expect(of(events, "usage")).toHaveLength(1)
  })

  test("D: idle with the task still listed pauses; the turn ends on the idle after the task's follow-up", async () => {
    const { adapter } = harness(["recorded/state-background"])
    const { events, error } = await within(5_000, run(adapter, "Start `sleep 5 && echo finished` in the background"))
    expect(error).toBeUndefined()
    const texts = finalTexts(events)
    expect(texts[0]).toBe("Started.")
    expect(texts.at(-1)).toStartWith("The background command finished")
    expect(of(events, "background").map((event) => [event.open, event.paused])).toEqual([
      [1, false],
      [1, true],
      [0, true],
    ])
  })

  test("F: a background subagent holds the turn until the CLI is idle after its follow-up", async () => {
    const { adapter } = harness(["recorded/state-background-agent"])
    const { events, error } = await within(5_000, run(adapter, "launch a background subagent"))
    expect(error).toBeUndefined()
    expect(finalTexts(events).at(-1)).toStartWith("The background agent finished")
    expect(of(events, "background").at(-1)?.tasks[0]).toMatchObject({ kind: "subagent", status: "done" })
  })

  test("a stopped background task: the CLI's idle after the stop ends the turn", async () => {
    const { adapter, stdin } = harness(["recorded/state-background-stop"])
    const { events, error } = await within(5_000, run(adapter, "sleep 60 in the background", {}, {
      onEvent: (event) => {
        if (event.type === "background" && event.paused && event.open === 1) void adapter.stopBackground?.("s1")
      },
    }))
    expect(error).toBeUndefined()
    expect(controlRequests(stdin(0), "stop_task")).toHaveLength(1)
    expect(of(events, "background").at(-1)?.tasks[0]).toMatchObject({ status: "cancelled" })
    expect(finalTexts(events)).toEqual(["started"])
  })

  test("G: Stop cancels a queued line with the run (interrupt cancel_queued) and the turn ends on idle", async () => {
    const { adapter, stdin } = harness(["recorded/state-interrupt-queued"], { interruptTimeoutMs: 5_000 })
    let sent = false
    const { events, error } = await within(5_000, run(adapter, "Count slowly from 1 to 200, one number per line.", {}, {
      onEvent: (event, controller) => {
        if (event.type !== "text" || sent) return
        sent = true
        void adapter.steer!("s1", "Reply with the single word: queued").then(() => controller.abort())
      },
    }))
    expect(error).toBeUndefined()
    expect(controlRequests(stdin(0), "interrupt")).toEqual([{ subtype: "interrupt", cancel_queued: true }])
    expect(terminal(events)).toMatchObject({ terminalStatus: "interrupted" })
  })

  test("the CLI running on its own with no turn: offered once, and the continuation ends on its idle", async () => {
    const { adapter, stdin } = harness(["state-wake"])
    const offers: import("./types").ContinuationOffer[] = []
    adapter.setContinuationSink!((offer) => offers.push(offer) > 0)
    const first = await within(5_000, run(adapter, "launch", { executionIdentity: owner }))
    expect(first.error).toBeUndefined()
    await waitUntil(() => offers.length > 0)
    await Bun.sleep(100)
    expect(offers).toHaveLength(1)
    expect(offers[0]).toMatchObject({ key: "t9", detail: "DONE" })
    const next = await within(3_000, run(adapter, "DONE", { nativeId: nativeOf(first.events), executionIdentity: { ...owner, turnId: "t2" }, continuation: { key: "t9", delivery: "buffered" } }))
    expect(next.error).toBeUndefined()
    expect(finalTexts(next.events)).toEqual(["The task finished"])
    expect(terminal(next.events)).toMatchObject({ terminalStatus: "completed" })
    expect(stdin().filter((line) => line.type === "user")).toHaveLength(1)
  })

  test("a prompt written while the CLI runs on its own joins that run and ends on the idle after both", async () => {
    const { adapter } = harness(["state-wake-join"])
    const offers: unknown[] = []
    adapter.setContinuationSink!((offer) => offers.push(offer) > 0)
    const first = await within(5_000, run(adapter, "launch", { executionIdentity: owner }))
    await waitUntil(() => offers.length > 0)
    const next = await within(3_000, run(adapter, "and you?", { nativeId: nativeOf(first.events), executionIdentity: { ...owner, turnId: "t2" } }))
    expect(next.error).toBeUndefined()
    expect(finalTexts(next.events)).toEqual(["The task finished", "Answer"])
  })
})


describe("native CLI permission inheritance", () => {
  test("does not pass a permission override on a new native session", async () => {
    const { adapter, spawns } = harness(["turn-ok"])
    const result = await run(adapter, "fixture", { permissionMode: "native" })
    expect(result.error).toBeUndefined()
    expect(spawns[0]).not.toContain("--permission-mode")
  })

  test("restarts an explicit session before inheriting CLI permissions", async () => {
    const { adapter, spawns } = harness(["turn-ok", "turn-ok"])
    const first = await run(adapter, "fixture")
    const nativeId = first.events.find((event) => event.type === "native")?.nativeId
    const next = await run(adapter, "fixture", { permissionMode: "native", nativeId })
    expect(next.error).toBeUndefined()
    expect(spawns).toHaveLength(2)
    expect(spawns[1]).not.toContain("--permission-mode")
    expect(spawns[1]).toContain("--resume")
  })
})

test("native inheritance survives the CLI reporting its effective mode", async () => {
  const { adapter, spawns } = harness(["two-turns", "turn-ok"])
  const first = await run(adapter, "fixture", { permissionMode: "native" })
  const nativeId = first.events.find((event) => event.type === "native")?.nativeId
  const next = await run(adapter, "fixture", { permissionMode: "native", nativeId })
  expect(next.error).toBeUndefined()
  expect(spawns).toHaveLength(1)
  expect([...first.events, ...next.events].filter((event) => event.type === "mode")).toEqual([])
})


describe("native Claude catalogue probes", () => {
  test("uses a no-side-effect probe for each requested directory", async () => {
    const { adapter, spawns, stdin, dir } = harness(["catalogue", "catalogue-other"])
    expect((await adapter.listCommands?.(dir))?.map(command => command.name)).toEqual(["parent-skill", "fixture:enabled", "fixture:Agent Cost Report"])
    expect((await adapter.listCommands?.(tmpdir()))?.map(command => command.name)).toEqual(["other-directory"])
    expect(spawns).toHaveLength(2)
    expect(spawns[0]).toContain("--no-session-persistence")
    expect(spawns[0]).toContain("--strict-mcp-config")
    expect(JSON.parse(spawns[0][spawns[0].indexOf("--settings") + 1]!)).toMatchObject({ disableAllHooks: true })
    expect(stdin(0).some(frame => frame.type === "user")).toBe(false)
  })
  test("surfaces malformed native metadata instead of scanning a different catalogue", async () => {
    const { adapter, dir } = harness(["catalogue-invalid"])
    await expect(adapter.listCommands?.(dir)).rejects.toThrow("commands")
  })
})


test("MCP URL consent reaches the computer browser through Claude", async () => {
  const opened: string[] = []
  const { adapter, stdin } = harness(["elicit-url"], { openUrl: async url => { opened.push(url) } })
  const result = await run(adapter, "fixture", {}, {
    askQuestion: async request => ({ [request.questions[0]!.question]: request.questions[0]!.options[0]!.label }),
  })
  expect(result.error).toBeUndefined()
  expect(opened).toEqual(["https://example.com/auth"])
  const reply = stdin().find(frame => frame.type === "control_response" && frame.response?.request_id === "url-fixture")
  expect(reply?.response.response).toEqual({ action: "accept" })
})
