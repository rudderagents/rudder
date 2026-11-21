import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import { SessionService } from "../session-service"
import { Store } from "../store"
import { acpCallMatch, copilotLostSession, createAcpAdapter, grokQuota, PLAN_OPTIONS, wantedMode, type AcpAdapterOptions } from "./acp"
import { ACP_ASK, ACP_PLAN, acpModeInfo, acpRudderMode, capabilityModes } from "./modes"
import type { AdapterContext, AgentAdapter, AgentEvent, AgentModel, AgentSpec, PermissionOption, PermissionRequest, QuestionRequest } from "./types"

// Offline replay against fixtures/acp/fake-agent.ts, scripted from sanitized Grok / Copilot captures.
const DIR = join(import.meta.dir, "fixtures", "acp")
const LOGS = mkdtempSync(join(tmpdir(), "rudder-acp-test-"))

const SPEC: AgentSpec = {
  id: "grok",
  label: "Grok",
  transport: "acp",
  experimental: false,
  capabilities: {
    reasoning: true,
    steer: false,
    interrupt: true,
    plan: true,
    question: true,
    usage: "tokens",
    models: "dynamic",
    efforts: true,
    ...capabilityModes([ACP_ASK, ACP_PLAN]),
  },
}

// biome-ignore lint/suspicious/noExplicitAny: test double reading arbitrary JSON-RPC frames loosely
type Json = Record<string, any>

const running: AgentAdapter[] = []
afterEach(async () => {
  await Promise.all(running.splice(0).map((adapter) => adapter.dispose?.()))
})

function agent(scenario: string, options: Partial<AcpAdapterOptions> = {}) {
  const log = join(LOGS, `${scenario}-${crypto.randomUUID()}.jsonl`)
  const adapter = createAcpAdapter({
    spec: SPEC,
    command: [process.execPath, join(DIR, "fake-agent.ts"), join(DIR, `${scenario}.json`), log],
    cancelGraceMs: 300,
    ...options,
  })
  running.push(adapter)
  // Everything the fake agent received from the adapter, in order.
  const received = (): Json[] =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Json)
      : []
  const calls = (method: string) => received().filter((message) => message.method === method)
  const answers = () => received().filter((message) => message.method === undefined)
  return { adapter, log, received, calls, answers }
}

function context(overrides: Partial<AdapterContext> = {}) {
  const events: AgentEvent[] = []
  const controller = new AbortController()
  const ctx: AdapterContext = {
    sessionId: "rudder-1",
    emit: (event) => {
      events.push(event)
    },
    askPermission: async () => null,
    askQuestion: async () => null,
    cwd: "/tmp/ws",
    permissionMode: "ask",
    signal: controller.signal,
    ...overrides,
  }
  const of = <T extends AgentEvent["type"]>(type: T) => events.filter((event): event is Extract<AgentEvent, { type: T }> => event.type === type)
  return { ctx, events, controller, of }
}

function nativeOf(events: AgentEvent[]) {
  return events.find((event): event is Extract<AgentEvent, { type: "native" }> => event.type === "native")?.nativeId
}

const GROK_OPTIONS: PermissionOption[] = [
  { id: "always-allow", label: "Yes, and don't ask again for bash commands", kind: "allow_always" },
  { id: "allow-once", label: "Yes, proceed", kind: "allow_once" },
  { id: "reject-once", label: "No, and tell Grok what to do differently", kind: "reject_once" },
  { id: "reject-always", label: "No, and don't ask again for this command", kind: "reject_always" },
]

const COPILOT_OPTIONS: PermissionOption[] = [
  { id: "allow_once", label: "Allow once", kind: "allow_once" },
  { id: "allow_always", label: "Always allow", kind: "allow_always" },
  { id: "reject_once", label: "Deny", kind: "reject_once" },
]

// grok.json with its initialize reply rewritten, written next to the logs.
function grokWithInit(rewrite: (init: Json) => Json) {
  const scenario = JSON.parse(readFileSync(join(DIR, "grok.json"), "utf8")) as Json
  scenario.initialize = rewrite(scenario.initialize)
  const path = join(LOGS, `grok-init-${crypto.randomUUID()}.json`)
  writeFileSync(path, JSON.stringify(scenario))
  const log = join(LOGS, `grok-init-${crypto.randomUUID()}.jsonl`)
  return { command: [process.execPath, join(DIR, "fake-agent.ts"), path, log] }
}

describe("ACP adapter · initialize", () => {
  test("detect carries the agent's own permission lock (v71)", async () => {
    const lock = { mode: "always-approve" as const, source: "/tmp/grok/config.toml" }
    const { adapter } = agent("grok", { command: ["sh", "-c", "exit 0"], permissionLock: () => lock })
    expect(await adapter.detect!()).toEqual({ available: true, permissionLock: lock })
    const { adapter: plain } = agent("grok", { command: ["sh", "-c", "exit 0"] })
    expect(await plain.detect!()).toEqual({ available: true })
  })

  test("protocolVersion 2 with the v1 reply shape still starts", async () => {
    const { adapter } = agent("grok", grokWithInit((init) => ({ ...init, protocolVersion: 2 })))
    const { ctx, of } = context()
    await adapter.reply("think", ctx)
    expect(of("text").at(-1)?.text).toBe("391")
  })

  test("a v2-shaped reply fails with a clear message", async () => {
    const { adapter } = agent(
      "grok",
      grokWithInit(({ agentInfo: _a, agentCapabilities: _c, ...rest }) => ({ ...rest, protocolVersion: 2, info: { name: "grok" }, capabilities: {} })),
    )
    await expect(adapter.reply("think", context().ctx)).rejects.toThrow(/v2 message shape/)
  })
})

describe("ACP adapter · streaming", () => {
  test("thought chunks become one reasoning block, closed when text starts; noise is ignored", async () => {
    const { adapter, calls } = agent("grok")
    const { ctx, events, of } = context()
    await adapter.reply("think", ctx)
    // v112 ①: Grok's session_info_update title is the agent's own session title, no longer noise.
    expect(events.map((event) => event.type)).toEqual(["status", "native", "steer", "title", "reasoning", "reasoning", "reasoning", "text", "text", "usage", "replyDisposition", "status", "lifecycle"])
    expect(of("title")).toHaveLength(1)
    expect(nativeOf(events)).toBe("sess-1")
    expect(of("reasoning").map((event) => [event.text, event.done])).toEqual([
      ["I will calculate 17 ", false],
      ["I will calculate 17 times 23.", false],
      ["I will calculate 17 times 23.", true],
    ])
    expect(new Set(of("reasoning").map((event) => event.id)).size).toBe(1)
    expect(of("text").map((event) => event.text)).toEqual(["39", "391"])
    expect(new Set(of("text").map((event) => event.id)).size).toBe(1)
    const usage = of("usage")[0]!.usage
    expect(usage).toMatchObject({ inputTokens: 60221, outputTokens: 99, cacheReadTokens: 2176, cacheWriteTokens: 0, reasoningTokens: 98 })
    expect(usage.costUsd).toBeCloseTo(0.117354, 9)
    expect(calls("initialize")[0]!.params).toEqual({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "rudderd", version: "0.1.0" },
    })
    expect(calls("session/new")[0]!.params).toEqual({ cwd: "/tmp/ws", mcpServers: [] })
  })

  test("a cold grok probe waits, then -32601 on the live rpc publishes missing", async () => {
    const { adapter, calls } = agent("grok")
    expect(await adapter.probeSteer?.()).toBe("unavailable")
    const { ctx, of } = context()
    await adapter.reply("hi", ctx)
    expect(of("steer")).toEqual([{ type: "steer", result: "missing" }])
    expect(calls("x.ai/interject").map((message) => message.params)).toEqual([{ probe: true }])
    expect(await adapter.probeSteer?.()).toBe("missing")
  })

  test("copilot stays on the queue and never asks x.ai/interject", async () => {
    const spec: AgentSpec = {
      ...SPEC,
      id: "copilot",
      label: "Copilot",
      capabilities: { ...SPEC.capabilities, steer: false, question: false },
    }
    const { adapter, calls } = agent("grok", { spec })
    expect(await adapter.probeSteer?.()).toBe("unavailable")
    expect(calls("x.ai/interject")).toEqual([])
    const store = new Store(":memory:")
    const service = new SessionService(store, adapter, () => {})
    const created = await service.invoke("session.create", { agent: "copilot", title: "img" }, "1")
    expect(created.error).toBeUndefined()
    expect((created.result as { steerControl: string }).steerControl).toBe("queue")
    const id = (created.result as { session: { id: string } }).session.id
    const opened = await service.invoke("session.get", { id }, "2")
    expect((opened.result as { steerControl: string }).steerControl).toBe("queue")
    expect(calls("x.ai/interject")).toEqual([])
    expect(calls("initialize")).toEqual([])
  })

  test("available_commands_update becomes the `/` list", async () => {
    const { adapter } = agent("grok")
    expect(await adapter.listCommands?.("/tmp/ws")).toEqual([])
    await adapter.reply("think", context().ctx)
    expect(await adapter.listCommands?.("/tmp/ws")).toEqual([
      { name: "compact", insert: "/compact", kind: "command", description: "Summarize the conversation", source: "agent" },
    ])
  })

  test("a fresh process learns the `/` list from a probe session, without a prompt", async () => {
    const { adapter, received } = agent("grok-commands")
    expect(await adapter.listCommands?.("/tmp/ws")).toEqual([
      { name: "compact", insert: "/compact", kind: "command", description: "Summarize the conversation", source: "agent" },
    ])
    const methods = received().map((message) => message.method)
    expect(methods).toContain("session/new")
    expect(methods).not.toContain("session/prompt")
  })

  test("Grok compaction updates one event id and uses the agent timestamp", async () => {
    const { adapter } = agent("grok")
    const { ctx, of } = context()
    await adapter.reply("compact", ctx)
    expect(of("compaction")).toHaveLength(2)
    expect(of("compaction")[0]).toMatchObject({ state: "running", trigger: "auto", startedAt: 123000 })
    expect(of("compaction")[1]).toMatchObject({ state: "done", tokensBefore: 206000, tokensAfter: 69000, contextSize: 256000 })
    expect(of("compaction")[0]!.id).toBe(of("compaction")[1]!.id)
    expect(of("usage")[0]?.usage).toMatchObject({ contextUsed: 69000, contextSize: 256000 })
  })

  test("an empty thought chunk creates no reasoning block", async () => {
    const { adapter } = agent("grok")
    const { ctx, of } = context()
    await adapter.reply("empty thought", ctx)
    expect(of("reasoning")).toEqual([])
    expect(of("text").map((event) => event.text)).toEqual(["ok"])
  })

  test("text resumes in a new block after a tool or a thought", async () => {
    const { adapter } = agent("grok")
    const { ctx, events, of } = context()
    await adapter.reply("read", ctx)
    expect(events.map((event) => event.type).filter((type) => !["status", "lifecycle", "replyDisposition"].includes(type))).toEqual([
      "native",
      "steer",
      "text",
      "tool",
      "tool",
      "tool",
      "reasoning",
      "reasoning",
      "text",
    ])
    const [first, second] = of("text")
    expect(first!.text).toBe("I'll read notes.txt.")
    expect(second!.text).toBe("The code is MAPLE-42.")
    expect(first!.id).not.toBe(second!.id)
  })
})

describe("ACP adapter · tools", () => {
  test("Grok tool_call + updates merge field by field; missing status is pending", async () => {
    const { adapter } = agent("grok")
    const { ctx, of } = context()
    await adapter.reply("read", ctx)
    const tools = of("tool")
    expect(new Set(tools.map((event) => event.id)).size).toBe(1)
    expect(tools[0]!.id).not.toBe("call-r-0")
    expect(tools.map(({ id, ...rest }) => rest)).toEqual([
      { type: "tool", tool: "read_file", title: "read_file", kind: "other", status: "pending", detail: "" },
      { type: "tool", tool: "read_file", title: "Read `/tmp/ws/notes.txt`", kind: "read", status: "pending", detail: "/tmp/ws/notes.txt" },
      {
        type: "tool",
        tool: "read_file",
        title: "Read `/tmp/ws/notes.txt`",
        kind: "read",
        status: "completed",
        detail: "/tmp/ws/notes.txt",
        output: "1→The secret code is MAPLE-42.\n",
      },
    ])
  })

  test("Grok shell: running then completed with exit_code; failures stay failed", async () => {
    const { adapter } = agent("grok")
    const { ctx, of } = context()
    await adapter.reply("bash", ctx)
    const tools = of("tool")
    const [ok, bad] = [...new Set(tools.map((event) => event.id))]
    const okEvents = tools.filter((event) => event.id === ok)
    expect(okEvents.map((event) => event.status)).toEqual(["pending", "pending", "running", "completed"])
    expect(okEvents.at(-1)).toMatchObject({ tool: "run_terminal_command", title: "Execute `echo hi`", kind: "execute", detail: "echo hi", output: "hi\n", exitCode: 0 })
    expect(tools.filter((event) => event.id === bad).at(-1)).toMatchObject({ status: "failed", exitCode: 1, detail: "false" })
  })

  test("diff content blocks become diffs", async () => {
    const { adapter } = agent("grok")
    const { ctx, of } = context()
    await adapter.reply("write", ctx)
    const tools = of("tool")
    expect(tools[1]!.diffs).toEqual([{ path: "/tmp/ws/out.txt", oldText: "", newText: "ok\n" }])
    expect(tools.at(-1)).toMatchObject({ kind: "edit", status: "completed", detail: "/tmp/ws/out.txt", diffs: [{ path: "/tmp/ws/out.txt", newText: "ok\n" }] })
  })

  test("Copilot: read results from rawOutput, shell exitCode from shell_exit", async () => {
    const { adapter } = agent("copilot", { cumulativeUsage: true })
    const read = context()
    await adapter.reply("read", read.ctx)
    const finals = [...new Map(read.of("tool").map((event) => [event.id, event])).values()]
    expect(finals.map((event) => [event.status, event.output])).toEqual([
      ["failed", "Path does not exist"],
      ["completed", "hello from rudder probe\nline two\n"],
    ])
    const echo = context({ nativeId: "sess-1", askPermission: async () => "allow_once" })
    await adapter.reply("echo", echo.ctx)
    expect(echo.of("tool").at(-1)).toMatchObject({ status: "completed", exitCode: 0, output: "hi\n<shellId: 0 completed with exit code 0>", detail: "echo hi" })
  })

  test("plan updates upsert one plan block per turn", async () => {
    const { adapter } = agent("grok")
    const { ctx, of } = context()
    await adapter.reply("plan", ctx)
    const plans = of("plan")
    expect(plans.length).toBe(2)
    expect(plans[0]!.id).toBe(plans[1]!.id)
    expect(plans[1]!.entries).toEqual([
      { content: "Read notes.txt", status: "completed" },
      { content: "Count lines", status: "completed" },
    ])
    expect(plans[0]!.entries[0]!.status).toBe("in_progress")
  })
})

describe("ACP permission match", () => {
  test("covers the raw input and locations, not the display title or description", () => {
    const call = (title: string, description: string) =>
      acpCallMatch("execute", { title, rawInput: { command: "npm test", description }, locations: [{ path: "/w" }] })
    expect(call("Run `npm test`", "Run tests")).toBe(call("npm test", "Run the test suite"))
    expect(acpCallMatch("execute", { title: "x", rawInput: { command: "npm test" }, locations: [{ path: "/other" }] })).not.toBe(call("x", ""))
    expect(acpCallMatch("execute", { title: "x", rawInput: { command: "rm -rf /" }, locations: [{ path: "/w" }] })).not.toBe(call("x", ""))
  })

  test("without a raw input the title is what identifies the call", () => {
    expect(acpCallMatch("execute", { title: "npm test" })).not.toBe(acpCallMatch("execute", { title: "rm -rf /" }))
  })
})

describe("ACP adapter · permissions and questions", () => {
  test("Grok's four options pass through as-is; the chosen optionId goes back", async () => {
    const { adapter, answers } = agent("grok")
    const seen: PermissionRequest[] = []
    const { ctx, of } = context({
      askPermission: async (request) => {
        seen.push(request)
        return "allow-once"
      },
    })
    await adapter.reply("perm", ctx)
    // toolId is the card the earlier tool_call opened for the same toolCallId.
    const card = of("tool")[0]!.id
    expect(seen).toEqual([
      {
        tool: "run_terminal_command",
        title: "Execute `printf hi > a.txt`",
        detail: "printf hi > a.txt",
        kind: "execute",
        options: GROK_OPTIONS,
        toolId: card,
        match: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    ])
    expect(new Set(of("tool").map((event) => event.id))).toEqual(new Set([card]))
    expect(answers()[0]).toMatchObject({ id: 0, result: { outcome: { outcome: "selected", optionId: "allow-once" } } })
    expect(of("tool").at(-1)!.status).toBe("completed")
  })

  test("Grok reject_once ends the turn (stopReason cancelled) and the tool is declined", async () => {
    const { adapter, answers } = agent("grok")
    const { ctx, of } = context({ askPermission: async () => "reject-once" })
    await adapter.reply("perm reject", ctx)
    expect(answers()[0]!.result).toEqual({ outcome: { outcome: "selected", optionId: "reject-once" } })
    expect(of("tool").at(-1)).toMatchObject({ status: "declined", output: "User rejected the execution for tool `run_terminal_command`" })
  })

  test("Copilot's three options; deny marks the tool declined", async () => {
    const { adapter, answers } = agent("copilot")
    const seen: PermissionRequest[] = []
    const { ctx, of } = context({
      askPermission: async (request) => {
        seen.push(request)
        return "reject_once"
      },
    })
    await adapter.reply("deny", ctx)
    expect(seen[0]!.options).toEqual(COPILOT_OPTIONS)
    expect(seen[0]!.toolId).toBe(of("tool")[0]!.id)
    expect(answers()[0]!.result).toEqual({ outcome: { outcome: "selected", optionId: "reject_once" } })
    expect(of("tool").at(-1)).toMatchObject({ status: "declined", output: "The user rejected this tool call." })
  })

  test("Copilot edit approval carries the diff; its Info note is not reply text", async () => {
    const { adapter } = agent("copilot")
    const seen: PermissionRequest[] = []
    const { ctx, of } = context({
      askPermission: async (request) => {
        seen.push(request)
        return "allow_once"
      },
    })
    await adapter.reply("write", ctx)
    expect(seen[0]).toMatchObject({ title: "Create file", kind: "edit", diffs: [{ path: "/tmp/ws/note.txt", oldText: "", newText: "ok\n" }] })
    expect(of("text").map((event) => event.text)).toEqual(["File created."])
  })

  test("abort while a permission is open: session/cancel, then outcome cancelled; leftover tool cancelled", async () => {
    const { adapter, received } = agent("copilot")
    const harness = context({
      askPermission: async () => {
        harness.controller.abort()
        return null
      },
    })
    await adapter.reply("cancel me", harness.ctx)
    const tail = received().slice(-2)
    expect(tail[0]).toMatchObject({ method: "session/cancel", params: { sessionId: "sess-1" } })
    expect(tail[1]).toMatchObject({ id: 0, result: { outcome: { outcome: "cancelled" } } })
    expect(harness.of("tool").at(-1)!.status).toBe("cancelled")
    // No reply text before the interrupt: the turn says so, like Claude and Codex.
    expect(harness.of("text").map((event) => event.text)).toEqual(["Cancelled."])
    expect(harness.events.filter(event => event.type === "status").at(-1)).toEqual({ type: "status", status: "idle" })
  })

  test("_x.ai/ask_user_question round trip: accepted, multi-select joined, cancelled", async () => {
    const { adapter, answers } = agent("grok")
    const seen: QuestionRequest[] = []
    const replies = [{ "Do you prefer tea or coffee?": "Coffee" }, { "Do you prefer tea or coffee?": ["Tea (Recommended)", "Coffee"] }, null]
    let nativeId: string | undefined
    for (const reply of replies) {
      const { ctx, events } = context({
        nativeId,
        askQuestion: async (request) => {
          seen.push(request)
          return reply
        },
      })
      await adapter.reply("ask", ctx)
      nativeId = nativeOf(events)
    }
    expect(seen[0]).toEqual({
      questions: [
        {
          question: "Do you prefer tea or coffee?",
          options: [
            { label: "Tea (Recommended)", description: "You prefer tea." },
            { label: "Coffee", description: "You prefer coffee." },
          ],
          multiSelect: false, allowsOther: true,
        },
      ],
    })
    expect(answers().map((message) => message.result)).toEqual([
      { outcome: "accepted", answers: { "Do you prefer tea or coffee?": "Coffee" } },
      { outcome: "accepted", answers: { "Do you prefer tea or coffee?": "Tea (Recommended), Coffee" } },
      { outcome: "cancelled" },
    ])
  })

  test("_x.ai/exit_plan_mode becomes a plan approval card", async () => {
    const { adapter, answers } = agent("grok")
    const seen: PermissionRequest[] = []
    const { ctx } = context({
      askPermission: async (request) => {
        seen.push(request)
        return "approved"
      },
    })
    await adapter.reply("exit plan", ctx)
    expect(seen[0]).toEqual({
      tool: "exit_plan_mode",
      title: "Approve plan",
      detail: "# Append a line\n\n1. Read notes.txt\n2. Append the line\n",
      kind: "other",
      options: PLAN_OPTIONS,
    })
    expect(answers()[0]!.result).toEqual({ outcome: "approved" })
  })

  test("unknown server requests (fs/*, terminal/*) get JSON-RPC errors and the turn goes on", async () => {
    const { adapter, answers } = agent("grok")
    const { ctx, of } = context()
    await adapter.reply("fs", ctx)
    expect(answers().map((message) => message.error?.code)).toEqual([-32601, -32601])
    expect(of("text").map((event) => event.text)).toEqual(["continued"])
  })
})

describe("ACP adapter · interrupt", () => {
  test("abort mid-turn sends session/cancel, keeps late chunks, cancels running tools", async () => {
    const { adapter, calls } = agent("grok")
    const harness = context({
      emit: (event) => {
        harness.events.push(event)
        if (event.type === "tool") harness.controller.abort()
      },
    })
    await adapter.reply("long", harness.ctx)
    expect(calls("session/cancel").length).toBe(1)
    expect(harness.of("reasoning").at(-1)).toMatchObject({ text: " about ships.", done: true })
    expect(harness.of("tool").map((event) => event.status)).toEqual(["running", "cancelled"])
  })

  test("an agent that never answers the cancel is given up on after the grace period", async () => {
    const { adapter, calls } = agent("grok", { cancelGraceMs: 200 })
    const harness = context({
      emit: (event) => {
        harness.events.push(event)
        if (event.type === "text") harness.controller.abort()
      },
    })
    const started = Date.now()
    await adapter.reply("hang", harness.ctx)
    expect(Date.now() - started).toBeLessThan(3000)
    expect(calls("session/cancel").length).toBe(1)
    expect(harness.events.filter(event => event.type === "status").at(-1)).toEqual({ type: "status", status: "idle" })
  })
})

describe("ACP adapter · abandoned prompts", () => {
  const abortOnText = (harness: ReturnType<typeof context>) => (event: AgentEvent) => {
    harness.events.push(event)
    if (event.type === "text") harness.controller.abort()
  }

  test("late updates of an abandoned prompt never land in the next turn", async () => {
    const { adapter, calls } = agent("grok", { cancelGraceMs: 300 })
    const first = context()
    first.ctx.emit = abortOnText(first)
    await adapter.reply("slow cancel", first.ctx)
    const second = context({ nativeId: nativeOf(first.events) })
    await adapter.reply("pause", second.ctx)
    expect(second.of("text").map((event) => event.text)).toEqual(["after pause"])
    expect(first.of("text").map((event) => event.text)).toEqual(["thinking"])
    expect(calls("initialize").length).toBe(1)
  })

  test("a prompt that never ends is cut off: the agent restarts and the session resumes", async () => {
    const { adapter, calls } = agent("grok", { cancelGraceMs: 200 })
    const first = context()
    first.ctx.emit = abortOnText(first)
    await adapter.reply("hang", first.ctx)
    const second = context({ nativeId: nativeOf(first.events) })
    await adapter.reply("hello", second.ctx)
    expect(second.of("text").map((event) => event.text)).toEqual(["ok"])
    expect(calls("initialize").length).toBe(2)
    expect(calls("session/resume").map((message) => message.params.sessionId)).toEqual(["sess-1"])
  })

  test("a prompt that never ends waits for other sessions' turns on the same process before the restart", async () => {
    const { adapter, calls } = agent("grok", { cancelGraceMs: 200 })
    const first = context()
    first.ctx.emit = abortOnText(first)
    await adapter.reply("hang", first.ctx)
    const other = context({ sessionId: "rudder-2" })
    const otherDone = adapter.reply("busy", other.ctx)
    while (!other.of("text").length) await Bun.sleep(10)
    const second = context({ nativeId: nativeOf(first.events) })
    await adapter.reply("hello", second.ctx)
    await otherDone
    expect(other.of("text").map((event) => event.text)).toEqual(["working", "working done"])
    expect(other.events.filter(event => event.type === "status").at(-1)).toEqual({ type: "status", status: "idle" })
    expect(second.of("text").map((event) => event.text)).toEqual(["ok"])
    expect(calls("initialize").length).toBe(2)
  })

  test("an abort while waiting out other sessions ends the turn and leaves the process up", async () => {
    const { adapter, calls } = agent("grok", { cancelGraceMs: 200 })
    const first = context()
    first.ctx.emit = abortOnText(first)
    await adapter.reply("hang", first.ctx)
    const other = context({ sessionId: "rudder-2" })
    const otherDone = adapter.reply("busy", other.ctx)
    while (!other.of("text").length) await Bun.sleep(10)
    const second = context({ nativeId: nativeOf(first.events) })
    setTimeout(() => second.controller.abort(), 400)
    await adapter.reply("hello", second.ctx)
    expect(second.of("text").map((event) => event.text)).toEqual(["Cancelled."])
    await otherDone
    expect(other.of("text").map((event) => event.text)).toEqual(["working", "working done"])
    await Bun.sleep(100)
    expect(calls("initialize").length).toBe(1)
    expect(calls("session/prompt").length).toBe(2)
  })

  test("Copilot: an abandoned turn's late cumulative usage is not billed to the next turn", async () => {
    const { adapter } = agent("copilot", { cumulativeUsage: true, cancelGraceMs: 300 })
    const first = context()
    first.ctx.emit = abortOnText(first)
    await adapter.reply("slow cancel", first.ctx)
    expect(first.of("usage").map((event) => event.usage.inputTokens)).toEqual([undefined])
    const second = context({ nativeId: nativeOf(first.events) })
    await adapter.reply("again", second.ctx)
    expect(second.of("usage")[0]!.usage).toMatchObject({ inputTokens: 50085 - 30000, outputTokens: 464 - 400, cacheReadTokens: 39785 - 20000 })
  })

  test("an abort during session setup ends the turn without a prompt", async () => {
    const { adapter, calls } = agent("grok")
    const harness = context()
    harness.ctx.emit = (event) => {
      harness.events.push(event)
      if (event.type === "native") harness.controller.abort()
    }
    await adapter.reply("hello", harness.ctx)
    expect(harness.of("text").map((event) => event.text)).toEqual(["Cancelled."])
    expect(harness.events.filter(event => event.type === "status").at(-1)).toEqual({ type: "status", status: "idle" })
    await Bun.sleep(100)
    expect(calls("session/prompt")).toEqual([])
  })

  test("an abort before the session is ready ends the turn without a prompt", async () => {
    const { adapter, calls } = agent("grok")
    const harness = context()
    harness.controller.abort()
    await adapter.reply("hello", harness.ctx)
    expect(harness.of("text").map((event) => event.text)).toEqual(["Cancelled."])
    expect(calls("session/prompt")).toEqual([])
  })

  test.each([
    ["refuse", /refused/],
    ["long reply", /max_tokens/],
  ])("stopReason of %p fails the turn", async (prompt, pattern) => {
    const { adapter } = agent("grok")
    const harness = context()
    await expect(adapter.reply(prompt, harness.ctx)).rejects.toThrow(pattern)
    expect(harness.of("text").length).toBe(1)
  })

  test("forget drops the live session, so the next turn resumes it", async () => {
    const { adapter, calls } = agent("grok")
    const first = context()
    await adapter.reply("hello", first.ctx)
    adapter.forget!("rudder-1")
    await adapter.reply("hello", context({ nativeId: nativeOf(first.events) }).ctx)
    expect(calls("session/resume").map((message) => message.params.sessionId)).toEqual(["sess-1"])
  })
})

describe("ACP adapter · sessions", () => {
  test("same live session is reused; Copilot cumulative usage is diffed per turn", async () => {
    const { adapter, calls } = agent("copilot", { cumulativeUsage: true })
    const first = context({ askPermission: async () => "allow_once" })
    await adapter.reply("echo", first.ctx)
    expect(first.of("usage")[0]!.usage).toEqual({
      inputTokens: 29758,
      outputTokens: 371,
      cacheReadTokens: 19940,
      cacheWriteTokens: 0,
      contextUsed: 9334,
      contextSize: 60000,
    })
    const second = context({ nativeId: nativeOf(first.events) })
    await adapter.reply("again", second.ctx)
    expect(second.of("usage")[0]!.usage).toEqual({
      inputTokens: 50085 - 29758,
      outputTokens: 464 - 371,
      cacheReadTokens: 39785 - 19940,
      cacheWriteTokens: 0,
      contextUsed: 9500,
      contextSize: 60000,
    })
    expect(calls("session/new").length).toBe(1)
    expect(calls("session/load").length).toBe(0)
  })

  test("Grok resumes a session that is not live in this process", async () => {
    const { adapter, calls } = agent("grok")
    const { ctx, events } = context({ nativeId: "old-1" })
    await adapter.reply("hello", ctx)
    expect(calls("session/resume")[0]!.params).toEqual({ sessionId: "old-1", cwd: "/tmp/ws", mcpServers: [] })
    expect(calls("session/new").length).toBe(0)
    expect(nativeOf(events)).toBe("old-1")
  })

  test("Copilot loads instead; the replayed history is not re-emitted", async () => {
    const { adapter, calls } = agent("copilot")
    const { ctx, of } = context({ nativeId: "old-2" })
    await adapter.reply("hello", ctx)
    expect(calls("session/load").length).toBe(1)
    expect(of("tool")).toEqual([])
    expect(of("text").map((event) => event.text)).toEqual(["ok"])
  })

  test("a reopen that times out fails the turn instead of silently starting a new session", async () => {
    const { adapter, calls } = agent("grok", { requestTimeoutMs: 300 })
    const { ctx, events } = context({ nativeId: "slow-1" })
    await expect(adapter.reply("hello", ctx)).rejects.toThrow(/did not answer session\/resume/)
    expect(calls("session/new")).toEqual([])
    expect(nativeOf(events)).toBeUndefined()
  })

  // perf-1112 round two (R6): every session a turn ran on stayed open in the agent until rudderd exited.
  test("a session idle past idleCloseMs is closed where the agent advertises close, and the next turn resumes it", async () => {
    const { adapter, calls } = agent("grok", { idleCloseMs: 50 })
    const first = context()
    await adapter.reply("hello", first.ctx)
    const native = nativeOf(first.events)
    expect(adapter.processes!()[0]?.sessionIds).toEqual(["rudder-1"])
    const started = Date.now()
    while (calls("session/close").length === 0) {
      if (Date.now() - started > 2000) throw new Error("idle session was not closed")
      await Bun.sleep(10)
    }
    expect(calls("session/close").map((message) => message.params)).toEqual([{ sessionId: native }])
    expect(adapter.processes!()[0]?.sessionIds).toEqual([])
    await adapter.reply("hello", context({ nativeId: native }).ctx)
    expect(calls("session/resume").map((message) => message.params.sessionId)).toEqual([native])
  })

  test("an agent without session/close (or a way to reopen) keeps its idle sessions", async () => {
    for (const rewrite of [
      (init: Json) => ({ ...init, agentCapabilities: { ...(init.agentCapabilities as Json), sessionCapabilities: { list: {}, resume: {} } } }),
      (init: Json) => ({ ...init, agentCapabilities: { ...(init.agentCapabilities as Json), loadSession: false, sessionCapabilities: { close: {} } } }),
    ]) {
      const { adapter } = agent("grok", { ...grokWithInit(rewrite), idleCloseMs: 20 })
      await adapter.reply("hello", context().ctx)
      await Bun.sleep(120)
      expect(adapter.processes!()[0]?.sessionIds).toEqual(["rudder-1"])
    }
  })

  test("a session the agent no longer knows falls back to a new one", async () => {
    const { adapter, calls } = agent("grok")
    const { ctx, events } = context({ nativeId: "missing-1" })
    await adapter.reply("hello", ctx)
    expect(calls("session/resume").length).toBe(1)
    expect(nativeOf(events)).toBe("sess-1")
  })

  test("bypass moves one session onto --always-approve and leaves the sibling on the plain process", async () => {
    const { adapter, calls, log } = agent("grok")
    const sibling = context({ sessionId: "rudder-sib" })
    const mover = context({ sessionId: "rudder-move" })
    await adapter.reply("hello", sibling.ctx)
    await adapter.reply("hello", mover.ctx)
    const siblingNative = nativeOf(sibling.events)
    const moverNative = nativeOf(mover.events)
    const plainPid = adapter.processes!()[0]!.pid

    const running = context({ sessionId: "rudder-sib", nativeId: siblingNative })
    const hung = adapter.reply("long", running.ctx)
    const started = Date.now()
    while (running.of("tool").length === 0) {
      if (Date.now() - started > 2000) throw new Error("sibling turn did not start")
      await Bun.sleep(10)
    }

    await adapter.reply("hello", context({ sessionId: "rudder-move", nativeId: moverNative, permissionMode: "bypassPermissions" }).ctx)
    const listed = adapter.processes!()
    expect(listed).toHaveLength(2)
    expect(listed.find((entry) => entry.pid === plainPid)?.sessionIds).toEqual(["rudder-sib"])
    expect(() => process.kill(plainPid, 0)).not.toThrow()
    expect(listed.find((entry) => entry.pid !== plainPid)?.sessionIds).toEqual(["rudder-move"])

    const argvs = readFileSync(`${log}.argv`, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[])
    expect(argvs).toHaveLength(2)
    expect(argvs[0]).not.toContain("--always-approve")
    expect(argvs[1]!.at(-1)).toBe("--always-approve")
    expect(calls("session/close").map((message) => message.params.sessionId)).toEqual([moverNative])
    expect(calls("session/resume").map((message) => message.params.sessionId)).toEqual([moverNative])
    expect(calls("session/set_mode").map((message) => message.params.modeId)).not.toContain("bypassPermissions")

    await adapter.reply("hello", context({ sessionId: "rudder-move", nativeId: moverNative, permissionMode: "autoApproval" }).ctx)
    const after = adapter.processes!()
    expect(after.map((entry) => entry.pid)).toEqual([plainPid])
    expect(new Set(after[0]!.sessionIds)).toEqual(new Set(["rudder-sib", "rudder-move"]))
    expect(
      readFileSync(`${log}.argv`, "utf8")
        .trim()
        .split("\n"),
    ).toHaveLength(2)
    expect(calls("session/resume").map((message) => message.params.sessionId)).toEqual([moverNative, moverNative])

    running.controller.abort()
    await hung
  })

  test("the last plain session moving to --always-approve keeps the plain process warm for its return", async () => {
    const { adapter, log } = agent("grok")
    const first = context({ sessionId: "rudder-only" })
    await adapter.reply("hello", first.ctx)
    const native = nativeOf(first.events)
    const plainPid = adapter.processes!()[0]!.pid
    await adapter.reply("hello", context({ sessionId: "rudder-only", nativeId: native, permissionMode: "bypassPermissions" }).ctx)
    expect(adapter.processes!().map((entry) => entry.pid)).toContain(plainPid)
    await adapter.reply("hello", context({ sessionId: "rudder-only", nativeId: native, permissionMode: "autoApproval" }).ctx)
    const started = Date.now()
    while (adapter.processes!().length > 1) {
      if (Date.now() - started > 3000) throw new Error("always-approve process still running")
      await Bun.sleep(10)
    }
    expect(adapter.processes!().map((entry) => entry.pid)).toEqual([plainPid])
    expect(readFileSync(`${log}.argv`, "utf8").trim().split("\n")).toHaveLength(2)
  })

  test("concurrent sessions share one process and never share event ids", async () => {
    const { adapter, calls } = agent("grok")
    const a = context({ sessionId: "rudder-a" })
    const b = context({ sessionId: "rudder-b" })
    await Promise.all([adapter.reply("bash", a.ctx), adapter.reply("bash", b.ctx)])
    expect(calls("initialize").length).toBe(1)
    expect(new Set([nativeOf(a.events), nativeOf(b.events)])).toEqual(new Set(["sess-1", "sess-2"]))
    const ids = (events: AgentEvent[]) => new Set(events.flatMap((event) => ("id" in event ? [event.id] : [])))
    const shared = [...ids(a.events)].filter((id) => ids(b.events).has(id))
    expect(shared).toEqual([])
  })

  test("a crashed agent fails the turn, closes its tools, and restarts for the next turn", async () => {
    const { adapter, calls } = agent("grok")
    const first = context()
    await expect(adapter.reply("crash", first.ctx)).rejects.toThrow(/exited \(code 3\)/)
    expect(first.of("tool").at(-1)!.status).toBe("cancelled")
    const second = context({ nativeId: nativeOf(first.events) })
    await adapter.reply("hello", second.ctx)
    expect(calls("initialize").length).toBe(2)
    expect(calls("session/resume")[0]!.params.sessionId).toBe("sess-1")
  })

  test("dispose stops the agent process", async () => {
    const { adapter, calls } = agent("grok")
    await adapter.reply("hello", context().ctx)
    await adapter.dispose!()
    await adapter.reply("hello", context().ctx)
    expect(calls("initialize").length).toBe(2)
  })
})

describe("ACP adapter · modes, models, availability", () => {
  test("permission modes map to the agent's own mode ids and are applied only on change", async () => {
    const grok = agent("grok")
    let nativeId: string | undefined
    for (const permissionMode of ["plan", "ask", "ask", "autoApproval"] as const) {
      const { ctx, events } = context({ nativeId, permissionMode })
      await grok.adapter.reply("hello", ctx)
      nativeId = nativeOf(events)
    }
    expect(grok.calls("session/set_mode").map((message) => message.params.modeId)).toEqual(["plan", "default"])
    expect(grok.calls("initialize").length).toBe(1)
    expect(wantedMode({ modes: [], modeId: undefined }, "bypassPermissions")).toBeUndefined()
    expect(wantedMode({ modes: ["default", "plan"], modeId: "default" }, "bypassPermissions")).toBeUndefined()

    const copilot = agent("copilot")
    await copilot.adapter.reply("hello", context({ permissionMode: "plan" }).ctx)
    expect(copilot.calls("session/set_mode").map((message) => message.params.modeId)).toEqual([
      "https://agentclientprotocol.com/protocol/session-modes#plan",
    ])
    expect(wantedMode({ modes: [], modeId: undefined }, "ask")).toBeUndefined()
    expect(wantedMode({ modes: [], modeId: undefined }, "acceptEdits")).toBeUndefined()
    expect(wantedMode({ modes: ["default", "plan"], modeId: "plan" }, "autoApproval")).toBe("default")
    expect(wantedMode({ modes: ["default", "plan"], modeId: "default" }, "autoApproval")).toBeUndefined()
  })

  test("goose's approve is Always ask: a new ask session leaves goose's own auto mode (2026-10-30)", () => {
    const goose = ["auto", "approve", "smart_approve", "chat"]
    expect(wantedMode({ modes: goose, modeId: "auto" }, "ask")).toBe("approve")
    expect(wantedMode({ modes: goose, modeId: "approve" }, "ask")).toBeUndefined()
    expect(acpRudderMode("approve")).toBe("ask")
    expect(acpModeInfo(goose.map((id) => ({ id }))).map((mode) => mode.id)).toEqual(["auto", "ask", "smart_approve", "chat"])
    // Qwen Code starts in its classifier mode "auto"; ask still lands on its "default".
    expect(wantedMode({ modes: ["plan", "default", "auto-edit", "auto", "yolo"], modeId: "auto" }, "ask")).toBe("default")
  })

  test("the session's availableModes become the permission list, with the agent's names; its own modes are switchable", async () => {
    const copilot = agent("copilot")
    expect(copilot.adapter.listPermissionModes?.()).toBeUndefined()
    const first = context()
    await copilot.adapter.reply("hello", first.ctx)
    const AUTOPILOT = "https://agentclientprotocol.com/protocol/session-modes#autopilot"
    expect(copilot.adapter.listPermissionModes?.()).toEqual([
      { id: "ask", native: "#agent", label: "Agent", risk: "normal", fromAgent: true },
      { id: "plan", native: "#plan", label: "Plan", risk: "normal", fromAgent: true },
      { id: AUTOPILOT, native: "#autopilot", label: "Autopilot", risk: "danger", fromAgent: true },
    ])
    await copilot.adapter.reply("hello", context({ permissionMode: AUTOPILOT, nativeId: nativeOf(first.events) }).ctx)
    expect(copilot.calls("session/set_mode").map((message) => message.params.modeId)).toEqual([AUTOPILOT])
    expect(wantedMode({ modes: [AUTOPILOT], modeId: undefined }, "bypassPermissions")).toBeUndefined()
  })

  test("an agent leaving plan mode by itself (approved plan) reports the new mode once", async () => {
    const { adapter } = agent("grok", {
      spec: { ...SPEC, capabilities: { ...SPEC.capabilities, autoApproval: true } },
    })
    const { ctx, of } = context({ permissionMode: "plan", askPermission: async () => "approved" })
    await adapter.reply("exit plan", ctx)
    expect(of("mode")).toEqual([{ type: "mode", mode: "autoApproval" }])
  })

  test("model and effort go through set_config_option when they differ", async () => {
    const { adapter, calls } = agent("grok")
    const first = context({ model: "grok-4.5", effort: "low" })
    await adapter.reply("hello", first.ctx)
    await adapter.reply("hello", context({ nativeId: nativeOf(first.events), model: "grok-4.5", effort: "low" }).ctx)
    expect(calls("session/set_config_option").map((message) => [message.params.configId, message.params.value])).toEqual([
      ["model", "grok-4.5"],
      ["reasoning_effort", "low"],
    ])
    await expect(adapter.reply("hello", context({ model: "claude-opus" }).ctx)).rejects.toThrow(/does not offer model "claude-opus"/)
  })

  test("context windows are validated against the selected model and sent through set_model metadata", async () => {
    const { adapter, calls } = agent("grok")
    const { ctx, of } = context({ model: "grok-4.7", contextWindow: 500000 })
    await adapter.reply("hello", ctx)
    expect(calls("session/set_model").map((message) => message.params)).toEqual([
      { sessionId: "sess-1", modelId: "grok-4.7", _meta: { contextWindow: 500000 } },
    ])
    expect(of("contextWindow")).toEqual([{ type: "contextWindow", value: 500000 }])
    await expect(adapter.reply("hello", context({ model: "grok-4.7", contextWindow: 300000 }).ctx)).rejects.toThrow(/does not offer context window 300000/)
  })

  test("listModels: Grok initialize metadata before any session; none for Copilot BYOK", async () => {
    const grok = agent("grok")
    const expected = [
      { id: "grok-4.7", label: "Grok 4.7", efforts: ["xhigh", "high", "medium", "low"], defaultEffort: "high", contextWindows: [256000, 500000] },
      { id: "grok-4.5", label: "Grok 4.5", efforts: ["high", "medium", "low"], defaultEffort: "high", contextWindows: [256000, 500000] },
    ]
    expect(await grok.adapter.listModels!()).toEqual(expected)
    await grok.adapter.reply("hello", context().ctx)
    expect(await grok.adapter.listModels!()).toEqual(expected)
    const copilot = agent("copilot")
    expect(await copilot.adapter.listModels!()).toEqual([])
  })

  test("auth failure (Copilot 403) fails the turn and makes the agent unavailable, reason verbatim", async () => {
    const reason = '403 "unauthorized: not authorized to use this Copilot feature\\n"'
    const { adapter } = agent("copilot-403", { spec: { ...SPEC, id: "copilot", label: "Copilot" } })
    expect(await adapter.detect!()).toEqual({ available: true })
    await expect(adapter.reply("hello", context().ctx)).rejects.toThrow(reason)
    expect(await adapter.detect!()).toEqual({ available: false, reason })
    const retry = agent("copilot-403", { authRetryMs: 0 })
    await expect(retry.adapter.reply("hello", context().ctx)).rejects.toThrow(/403/)
    expect(await retry.adapter.detect!()).toEqual({ available: true })
  })

  test("probeSession: detect reports the Copilot 403 up front, verbatim, without a turn", async () => {
    const reason = '403 "unauthorized: not authorized to use this Copilot feature\\n"'
    const copilot = { ...SPEC, id: "copilot", label: "Copilot" }
    const { adapter, calls } = agent("copilot-403", { spec: copilot, probeSession: true })
    expect(await adapter.detect!()).toEqual({ available: false, reason })
    expect(calls("session/new")).toHaveLength(1)
    expect(calls("session/new")[0]!.params.cwd).toContain("rudder-acp-probe-")
    expect(calls("session/prompt")).toEqual([])
    // Latched like a failed turn: no second probe inside authRetryMs.
    expect(await adapter.detect!()).toEqual({ available: false, reason })
    expect(calls("session/new")).toHaveLength(1)
  })

  test("probeSession: a working account is available and the probe session is closed", async () => {
    const { adapter, calls } = agent("copilot", { spec: { ...SPEC, id: "copilot", label: "Copilot" }, probeSession: true })
    expect(await adapter.detect!()).toEqual({ available: true })
    expect(calls("session/new")).toHaveLength(1)
    expect(calls("session/close").map((message) => message.params)).toEqual([{ sessionId: "sess-1" }])
    expect(calls("session/prompt")).toEqual([])
    // The probe session is not reused for the real turn.
    const { ctx, events } = context()
    await adapter.reply("again", ctx)
    expect(nativeOf(events)).toBe("sess-2")
  })

  test("listModels: Copilot 1.0.105 carries multiplier, price tier, vendor, family and version (v53 B)", async () => {
    const { adapter, calls } = agent("copilot-models", { spec: { ...SPEC, id: "copilot", label: "Copilot" }, probeSession: true })
    const models = await adapter.listModels!()
    expect(calls("session/new")).toHaveLength(1)
    // 26 ids; the doubled "auto" in the model option is listed once.
    expect(models).toHaveLength(26)
    expect(models.filter((model) => model.id === "auto")).toHaveLength(1)
    const by = (id: string) => models.find((model) => model.id === id)
    expect(by("auto")).toEqual({ id: "auto", label: "Auto", efforts: ["low", "medium", "high", "xhigh", "max"] })
    expect(by("claude-sonnet-5.5")).toEqual({
      id: "claude-sonnet-5.5",
      label: "Claude Sonnet 5.5",
      efforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "medium",
      multiplier: 1,
      priceTier: "medium",
      vendor: "Anthropic",
      family: "claude-sonnet",
      version: "5.5",
    })
    const pick = ({ multiplier, priceTier, vendor, family, version }: AgentModel) => ({ multiplier, priceTier, vendor, family, version })
    expect(pick(by("claude-opus-4.8-fast")!)).toEqual({ multiplier: 30, priceTier: "very_high", vendor: "Anthropic", family: "claude-opus", version: "4.8" })
    expect(pick(by("claude-haiku-4.5")!)).toEqual({ multiplier: 0.33, priceTier: "low", vendor: "Anthropic", family: "claude-haiku", version: "4.5" })
    expect(pick(by("gemini-3.8-flash")!)).toEqual({ multiplier: 14, priceTier: "low", vendor: "Google", family: "gemini-flash", version: "3.8" })
    expect(pick(by("gpt-6.1-sol")!)).toEqual({ multiplier: 1, priceTier: "medium", vendor: "OpenAI", family: "gpt-sol", version: "6.1" })
    expect(pick(by("kimi-k3")!)).toEqual({ multiplier: 1, priceTier: "medium", vendor: "Moonshot", family: "kimi-k3", version: undefined })
    expect(pick(by("mai-code-1.1-flash")!)).toEqual({ multiplier: 0.33, priceTier: "low", vendor: "Microsoft", family: "mai-code-flash", version: "1.1" })
    expect([...new Set(models.flatMap((model) => (model.vendor ? [model.vendor] : [])))]).toEqual([
      "Anthropic",
      "OpenAI",
      "Google",
      "xAI",
      "Moonshot",
      "Microsoft",
    ])
  })

  test("Copilot refusing reasoning_effort: the turn runs, the model is reported once and lists no efforts (v57 A)", async () => {
    const { adapter, calls } = agent("copilot-models", { spec: { ...SPEC, id: "copilot", label: "Copilot" } })
    const first = context({ effort: "high" })
    await adapter.reply("hello", first.ctx)
    expect(first.of("effortRefused")).toEqual([{ type: "effortRefused", model: "claude-sonnet-5.5" }])
    expect(first.of("text").length).toBeGreaterThan(0)
    const second = context({ nativeId: nativeOf(first.events), effort: "high" })
    await adapter.reply("again", second.ctx)
    expect(second.of("effortRefused")).toEqual([])
    // Asked once; the second turn does not try again.
    expect(calls("session/set_config_option").filter((message) => message.params.configId === "reasoning_effort")).toHaveLength(1)
    const models = await adapter.listModels!()
    const sonnet = models.find((model) => model.id === "claude-sonnet-5.5")!
    expect(sonnet.efforts).toEqual([])
    expect(sonnet.defaultEffort).toBeUndefined()
    expect(models.find((model) => model.id === "auto")!.efforts).toEqual(["low", "medium", "high", "xhigh", "max"])
  })

  test("listModels: Grok's list gets no vendor fields", async () => {
    const models = await agent("grok").adapter.listModels!()
    expect(models.some((model) => "vendor" in model || "multiplier" in model)).toBe(false)
  })

  test("without probeSession detect never opens a session (Grok persists each one)", async () => {
    const { adapter, received } = agent("grok")
    expect(await adapter.detect!()).toEqual({ available: true })
    expect(received()).toEqual([])
  })

  test("identity check rejects the wrong agent behind an ambiguous command", async () => {
    const cursor = { ...SPEC, id: "cursor", label: "Cursor" }
    const wrong = agent("grok", { spec: cursor, expectAgent: /cursor/i })
    const detected = await wrong.adapter.detect!()
    expect(detected.available).toBe(false)
    expect(detected.reason).toContain("不是 Cursor")
    expect(detected.reason).toContain("grok.com")
    // Worded on the phone: the start failure carries the mismatch as copy, the agent's own report as is.
    const started = detected.reasonCopy
    expect(started?.code).toMatch(/^agent_start_failed(_at)?$/)
    expect(started?.text).toBe(detected.reason!)
    const mismatch = started?.args?.detail
    expect(typeof mismatch === "object" ? mismatch.code : mismatch).toBe("agent_mismatch")
    expect(typeof mismatch === "object" ? mismatch.args : undefined).toMatchObject({ agent: "Cursor" })
    await expect(wrong.adapter.reply("hello", context().ctx)).rejects.toThrow(/不是 Cursor/)
    expect(wrong.calls("session/new")).toEqual([])

    const exits = agent("exit-on-start", { spec: cursor, expectAgent: /cursor/i })
    const failed = await exits.adapter.detect!()
    expect(failed.available).toBe(false)
    expect(failed.reason).toContain("Device not configured")

    const right = agent("copilot", { expectAgent: /copilot/i })
    expect(await right.adapter.detect!()).toEqual({ available: true })
  })

  test("detect reports a missing command without spawning", async () => {
    const adapter = createAcpAdapter({ spec: SPEC, command: ["rudder-no-such-agent", "acp"] })
    running.push(adapter)
    expect(await adapter.detect!()).toEqual({ available: false, reason: "未找到命令 rudder-no-such-agent", reasonCopy: { code: "command_missing", args: { command: "rudder-no-such-agent" }, text: "未找到命令 rudder-no-such-agent" } })
  })

  test("a missing required command (pi-acp runs pi) blocks detect and the turn without spawning", async () => {
    const { adapter, received } = agent("grok", { requires: ["rudder-no-such-pi"] })
    expect(await adapter.detect!()).toEqual({ available: false, reason: "未找到命令 rudder-no-such-pi", reasonCopy: { code: "command_missing", args: { command: "rudder-no-such-pi" }, text: "未找到命令 rudder-no-such-pi" } })
    await expect(adapter.reply("hello", context().ctx)).rejects.toThrow("未找到命令 rudder-no-such-pi")
    expect(received()).toEqual([])
    expect(adapter.processes!()).toEqual([])
  })
})

describe("ACP adapter · processes", () => {
  test("one shared process per agent kind, listing its live sessions", async () => {
    const { adapter } = agent("grok")
    expect(adapter.processes!()).toEqual([])
    await adapter.reply("think", context().ctx)
    const listed = adapter.processes!()
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ agent: "grok", sessionIds: ["rudder-1"], shared: true })
    expect(() => process.kill(listed[0]!.pid, 0)).not.toThrow()
    adapter.forget!("rudder-1")
    expect(adapter.processes!()).toEqual([{ agent: "grok", pid: listed[0]!.pid, sessionIds: [], shared: true }])
    await adapter.dispose!()
    expect(adapter.processes!()).toEqual([])
  })

  test("a sign-in written after launch replaces the idle process on its next turn", async () => {
    const auth = join(LOGS, `auth-${crypto.randomUUID()}.json`)
    writeFileSync(auth, "{}")
    utimesSync(auth, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
    const { adapter } = agent("grok", { credentialFiles: [auth] })
    await adapter.reply("hello", context({ sessionId: "rudder-1" }).ctx)
    const first = adapter.processes!()[0]!.pid
    await adapter.reply("again", context({ sessionId: "rudder-1" }).ctx)
    expect(adapter.processes!()[0]!.pid).toBe(first)
    writeFileSync(auth, '{"account":"b"}')
    await adapter.reply("after login", context({ sessionId: "rudder-1" }).ctx)
    const started = Date.now()
    while (adapter.processes!().some((entry) => entry.pid === first)) {
      if (Date.now() - started > 3000) throw new Error("old process still running")
      await Bun.sleep(10)
    }
    expect(adapter.processes!().map((entry) => entry.pid)).not.toContain(first)
    expect(adapter.processes!()).toHaveLength(1)
    await adapter.dispose!()
  })

  test("forgetting the last session on the --always-approve process stops that process", async () => {
    const { adapter } = agent("grok")
    await adapter.reply("hello", context({ sessionId: "rudder-plain" }).ctx)
    const plainPid = adapter.processes!()[0]!.pid
    await adapter.reply("hello", context({ sessionId: "rudder-bypass", permissionMode: "bypassPermissions" }).ctx)
    const listed = adapter.processes!()
    expect(listed).toHaveLength(2)
    const approvePid = listed.find((entry) => entry.pid !== plainPid)!.pid
    adapter.forget!("rudder-bypass")
    const started = Date.now()
    while (adapter.processes!().some((entry) => entry.pid === approvePid)) {
      if (Date.now() - started > 3000) throw new Error("always-approve process still running")
      await Bun.sleep(10)
    }
    expect(() => process.kill(approvePid, 0)).toThrow()
    expect(adapter.processes!().map((entry) => [entry.pid, entry.sessionIds])).toEqual([[plainPid, ["rudder-plain"]]])
    await adapter.dispose!()
  })
})

describe("ACP adapter · Grok background hold", () => {
  test("a cold warmed session routes late task text while suppressing load replay", async () => {
    const { adapter } = agent("grok-warm-late")
    const late: import("./types").LateAgentEvent[] = []
    adapter.setLateEventSink!(async event => { late.push(event) })
    // The task's link is in the database from before the restart (continuation turns: only registered tasks patch).
    adapter.setLateTaskLookup!(() => true)
    adapter.warm!({ sessionId: "rudder-1", cwd: "/tmp/ws", permissionMode: "ask", nativeId: "warm-native",
      executionIdentity: { sessionId: "rudder-1", turnId: "", generation: 2, agentId: "grok", nativeSessionId: "warm-native" } })
    await Bun.sleep(120)
    expect(late.map(event => event.text)).toEqual(["WARM_LATE"])
    expect(late[0]?.identity).toMatchObject({ sessionId: "rudder-1", generation: 2, nativeSessionId: "warm-native" })
  })

  test("Grok routes native task follow-up after prompt completion through the durable late sink", async () => {
    const { adapter } = agent("grok-late")
    const late: import("./types").LateAgentEvent[] = []
    adapter.setLateEventSink!(async event => { late.push(event) })
    const identity = { sessionId: "rudder-1", turnId: "old", generation: 0, agentId: "grok" }
    const { ctx, of } = context({ executionIdentity: identity })
    await adapter.reply("late", ctx)
    expect(late).toHaveLength(0)
    await Bun.sleep(120)
    expect(late).toHaveLength(1)
    expect(late[0]).toMatchObject({ identity: { ...identity, turnId: "", nativeSessionId: "sess-1" },
      eventId: "sess-1-late", nativeTaskId: "a2eb8f22-bb85-4674-991f-d877982ceb46", text: "LATE_FINAL" })
    expect(of("text").some(event => event.text.includes("LATE_FINAL"))).toBe(false)
  })

  test("Grok keeps the turn until the follow-up turn_completed", async () => {
    const { adapter } = agent("grok-background")
    const { ctx, events, of } = context()
    await adapter.reply("bg", ctx)
    expect(of("text").map((event) => event.text)).toEqual(["已经在后台开始", "后台任务已跑完，输出是 BG_DONE。"])
    const background = of("background")
    expect(background.map((event) => [event.open, event.paused])).toEqual([
      [1, false],
      [1, true],
      [0, true],
    ])
    expect(background[0]?.tasks).toEqual([
      expect.objectContaining({ id: "a2eb8f22-bb85-4674-991f-d877982ceb46", kind: "command", title: "sleep 20 && echo BG_DONE", status: "running" }),
    ])
    expect(background.at(-1)?.tasks[0]).toMatchObject({ status: "done", exitCode: 0 })
    const backgroundAt = events.findIndex((event) => event.type === "background" && event.paused)
    const resumedAt = events.findIndex((event, index) => index > backgroundAt && event.type === "status" && event.status === "running")
    const followAt = events.findIndex((event) => event.type === "text" && event.text.startsWith("后台任务已跑完"))
    expect(resumedAt).toBeGreaterThan(backgroundAt)
    expect(followAt).toBeGreaterThan(resumedAt)
    const tools = of("tool")
    expect(tools.at(-1)?.status).toBe("completed")
    expect(tools.some((event) => event.status === "cancelled")).toBe(false)
    expect(tools.some((event) => event.output?.includes("BG_DONE"))).toBe(true)
  })

  test("a Grok subagent holds the turn until its wake reply lands, and its result fills the spawn card", async () => {
    const { adapter } = agent("grok-subagent")
    const late: import("./types").LateAgentEvent[] = []
    adapter.setLateEventSink!(async event => { late.push(event) })
    const { ctx, of } = context({ executionIdentity: { sessionId: "rudder-1", turnId: "t1", generation: 0, agentId: "grok" } })
    await adapter.reply("sub", ctx)
    expect(of("text").map((event) => event.text)).toEqual(["派出子代理", "根据子代理：ALPHA"])
    expect(late).toEqual([])
    const background = of("background")
    expect(background[0]?.tasks).toEqual([
      expect.objectContaining({ id: "01a1e524-9515-7702-b598-5f633b9f0a7c", kind: "subagent", title: "Review perf hot paths", status: "running" }),
    ])
    expect(background.at(-1)?.tasks[0]).toMatchObject({ status: "done" })
    const spawn = of("tool").filter((event) => event.tool === "spawn_subagent")
    expect(spawn.at(-1)?.output).toBe("子代理结论 ALPHA")
    expect(background.at(-1)?.tasks[0]?.toolId).toBe(spawn[0]?.id)
  })

  test("Grok TaskOutput results show the subagent and command output", async () => {
    const { adapter } = agent("grok-subagent")
    const { ctx, of } = context()
    await adapter.reply("subwait", ctx)
    const tools = of("tool")
    expect(tools.filter((event) => event.title?.includes("get_command") || event.tool === "get_command_or_subagent_output").map((event) => event.output).filter(Boolean)).toEqual([
      "FOUND three files",
      "echo ONE\nONE\n\necho TWO\nTWO\n",
    ])
    expect(of("text").map((event) => event.text)).toEqual(["都找到了"])
  })

  test("a held Grok turn ends when its last subagent finishes without a wake", async () => {
    const { adapter } = agent("grok-subagent")
    const { ctx, of } = context()
    const winner = await Promise.race([
      adapter.reply("subcancel", ctx).then(() => "done" as const),
      Bun.sleep(2000).then(() => "stuck" as const),
    ])
    expect(winner).toBe("done")
    expect(of("background").at(-1)?.tasks[0]).toMatchObject({ kind: "subagent", status: "cancelled" })
  })

  test("a held Grok turn ends when its subagent finishes quietly after a command's wake reply", async () => {
    const { adapter } = agent("grok-subagent")
    const { ctx, of } = context()
    const winner = await Promise.race([
      adapter.reply("cmdsub", ctx).then(() => "done" as const),
      Bun.sleep(2000).then(() => "stuck" as const),
    ])
    expect(winner).toBe("done")
    expect(of("text").map((event) => event.text)).toEqual(["命令 A 跑完了"])
  })

  test("a held Grok turn takes its own command's wake reply and ignores another turn's subagent", async () => {
    const { adapter } = agent("grok-subagent")
    const late: import("./types").LateAgentEvent[] = []
    adapter.setLateEventSink!(async event => { late.push(event) })
    const { ctx, of } = context({ executionIdentity: { sessionId: "rudder-1", turnId: "t1", generation: 0, agentId: "grok" } })
    await adapter.reply("foreign", ctx)
    expect(of("text").map((event) => event.text)).toEqual(["命令 A 的结果"])
    expect(late).toEqual([])
  })

  // Plan 2026-11-17-agent-questions Task 4: Grok 1.0.88 `_x.ai/mcp/elicit` (shape from grok/recorded/elicit-form.jsonl)
  // is answered `{outcome, content}`; an MCP-style `action` reads as malformed there and the tool sees cancel.
  const elicitAnswers = (answers: () => Json[]) =>
    answers().filter((message) => ["accept", "decline", "cancel"].includes(message.result?.outcome)).map((message) => message.result)

  test("Grok mcp-elicit: the form is a question card, answered with outcome accept and the content", async () => {
    const { adapter, answers } = agent("grok")
    const asked: QuestionRequest[] = []
    const { ctx } = context({
      askQuestion: async (request) => {
      asked.push(request)
      return { [request.questions[0]!.question]: ["cheese", "olive"], [request.questions[1]!.question]: "Large" }
    },
    })
    await adapter.reply("mcp-elicit", ctx)
    expect(asked[0]!.questions.map((item) => item.header)).toEqual(["Toppings", "Size"])
    expect(elicitAnswers(answers)).toEqual([{ outcome: "accept", content: { toppings: ["cheese", "olive"], size: "l" } }])
  })

  test("Grok mcp-elicit retries invalid enum input and preserves cancellation", async () => {
    const {adapter,answers}=agent("grok")
    let count=0
    const {ctx}=context({askQuestion:async request => {
      count++
      return count===1 ? {[request.questions[0]!.question]:["invalid"],[request.questions[1]!.question]:"Large"} : null
    }})
    await adapter.reply("mcp-elicit",ctx)
    expect(count).toBe(2)
    expect(elicitAnswers(answers)).toEqual([{outcome:"cancel"}])
  })

  test("Grok mcp-elicit: no answer cancels, a form it cannot show declines", async () => {
    const first = agent("grok")
    await first.adapter.reply("mcp-elicit", context({ askQuestion: async () => null }).ctx)
    expect(elicitAnswers(first.answers)).toEqual([{ outcome: "cancel" }])
    const odd = agent("grok")
    await odd.adapter.reply("mcp-elicit-odd", context().ctx)
    expect(elicitAnswers(odd.answers)).toEqual([{ outcome: "decline" }])
  })

  // Plan 2026-11-17-copilot-optimal Task 1: two background subagents, each with its own card and result.
  test("Copilot two-background: each subagent fills its own card; one ending leaves the other running", async () => {
    const { adapter } = agent("copilot", { spec: { ...SPEC, id: "copilot", label: "Copilot" } })
    const { ctx, of } = context()
    await adapter.reply("two-background", ctx)
    const tools = of("tool")
    expect(tools.some((tool) => tool.status === "completed" && tool.output?.startsWith("Agent started"))).toBe(false)
    const firstDone = tools.findIndex((tool) => tool.title === "first" && tool.status === "completed")
    const secondAfter = tools.slice(0, firstDone + 1).filter((tool) => tool.title === "second").at(-1)
    expect(secondAfter?.status).toBe("running")
    expect(tools.filter((tool) => tool.title === "first").at(-1)).toMatchObject({ status: "completed", output: "one" })
    expect(tools.filter((tool) => tool.title === "second").at(-1)).toMatchObject({ status: "completed", output: "two" })
    expect(of("text").map((event) => event.text)).toEqual(["both done"])
  })

  // Plan 2026-11-17 Task 4: output after the turn about no task an earlier turn tracked becomes a continuation.
  const continuationOwner = { sessionId: "rudder-1", turnId: "t1", generation: 0, agentId: "grok" }
  const offersOf = (adapter: AgentAdapter) => {
    const offers: import("./types").ContinuationOffer[] = []
    adapter.setContinuationSink!((offer) => offers.push(offer) > 0)
    return offers
  }

  // Plan 2026-11-17-copilot-optimal Task 4: Copilot fails every prompt after losing a session until it is replaced.
  test("Copilot lost: a lost session before any output replaces the process and runs the turn again", async () => {
    const { adapter, log, calls } = agent("copilot", { spec: { ...SPEC, id: "copilot", label: "Copilot" } })
    const { ctx, of } = context()
    await adapter.reply("lost", ctx)
    expect(of("text").map((event) => event.text)).toEqual(["fresh"])
    expect(readFileSync(`${log}.argv`, "utf8").trim().split("\n")).toHaveLength(2)
    expect(calls("session/load").map((message) => (message.params as Json).sessionId)).toEqual(["sess-1"])
  })

  test("Copilot lost-after-speech: no retry once the agent spoke, but the next turn gets a new process", async () => {
    const { adapter, log, calls } = agent("copilot", { spec: { ...SPEC, id: "copilot", label: "Copilot" } })
    const first = context()
    await expect(adapter.reply("lost-after-speech", first.ctx)).rejects.toThrow("session not found")
    expect(calls("session/prompt")).toHaveLength(1)
    const next = context({ nativeId: "sess-1" })
    await adapter.reply("lost-after-speech", next.ctx)
    expect(readFileSync(`${log}.argv`, "utf8").trim().split("\n")).toHaveLength(2)
  })

  test("copilotLostSession knows both markers in message or data.details", () => {
    const rpcError = (message: string, data?: Json) => Object.assign(new Error(message), { code: -32603, ...(data ? { data } : {}) })
    expect(copilotLostSession(rpcError("session event delivery failed: session not found: s"))).toBe(true)
    expect(copilotLostSession(rpcError("x", { details: "session lock unavailable during is_session_generation_current: acquisition timed out" }))).toBe(true)
    expect(copilotLostSession(rpcError("Internal error"))).toBe(false)
  })

  // Plan 2026-11-17-copilot-optimal Task 3: Copilot's own Error line (no messageId) is a notice, not the reply.
  // Final review I2: a subagent this turn did not start (a stopped turn's background subagent) is not the reply.
  test("Copilot foreign-agent: output tagged with an agentId this turn never started stays out of the reply", async () => {
    const { adapter } = agent("copilot", { spec: { ...SPEC, id: "copilot", label: "Copilot" } })
    const { ctx, of } = context()
    await adapter.reply("foreign-agent", ctx)
    expect(of("text").map((event) => event.text)).toEqual(["fresh reply"])
    expect(of("tool")).toEqual([])
  })

  test("Copilot status-error: a root Error line without messageId is a notice", async () => {
    const { adapter } = agent("copilot", { spec: { ...SPEC, id: "copilot", label: "Copilot" } })
    const { ctx, of } = context()
    await adapter.reply("status-error", ctx)
    expect(of("text").map((event) => [event.text, event.notice ?? false])).toEqual([
      ["Error: Execution failed: 500 boom", true],
      ["after", false],
    ])
  })

  test("Copilot sql-other: an sql call that is not about todos stays a card", async () => {
    const { adapter } = agent("copilot", { spec: { ...SPEC, id: "copilot", label: "Copilot" } })
    const { ctx, of } = context()
    await adapter.reply("sql-other", ctx)
    expect(of("tool").at(-1)).toMatchObject({ title: "Count users", status: "completed" })
  })

  // Plan 2026-11-17-copilot-optimal Task 2: a stopped turn's background subagent keeps talking with no turn.
  test("Copilot: orphan subagent speech after a stop is not offered", async () => {
    const copilot = { ...SPEC, id: "copilot", label: "Copilot" }
    const { adapter } = agent("copilot", { spec: copilot, continuationQuietMs: 30 })
    const offers = offersOf(adapter)
    const owner = { ...continuationOwner, agentId: "copilot" }
    const first = context({ executionIdentity: owner })
    first.ctx.emit = ((emit) => (event: AgentEvent) => {
      emit(event)
      if (event.type === "background") first.controller.abort()
    })(first.ctx.emit)
    await adapter.reply("stop-background", first.ctx)
    for (let i = 0; i < 100 && offers.length === 0; i++) await Bun.sleep(10)
    await Bun.sleep(100)
    expect(offers).toHaveLength(1)
    const next = context({ executionIdentity: { ...owner, turnId: "t2" }, nativeId: "sess-1", continuation: { key: offers[0]!.key, delivery: "buffered" } })
    await adapter.reply("wake", next.ctx)
    const texts = next.of("text").map((event) => event.text).join("|")
    expect(texts).toContain("parent back")
    expect(texts).not.toContain("subagent internals")
  })

  // Plan 2026-11-17-copilot-optimal Task 5: like Claude's interrupt at its deadline (95249877).
  test("a continuation past its deadline cancels the agent", async () => {
    const copilot = { ...SPEC, id: "copilot", label: "Copilot" }
    const { adapter, calls } = agent("copilot", { spec: copilot, continuationQuietMs: 1000, continuationDeadlineMs: 200 })
    const offers = offersOf(adapter)
    const owner = { ...continuationOwner, agentId: "copilot" }
    await adapter.reply("endless-wake", context({ executionIdentity: owner }).ctx)
    for (let i = 0; i < 100 && offers.length === 0; i++) await Bun.sleep(10)
    expect(offers).toHaveLength(1)
    const next = context({ executionIdentity: { ...owner, turnId: "t2" }, nativeId: "sess-1", continuation: { key: offers[0]!.key, delivery: "buffered" } })
    const started = Date.now()
    await adapter.reply("wake", next.ctx)
    expect(Date.now() - started).toBeLessThan(1000)
    await Bun.sleep(50)
    expect(calls("session/cancel").map((message) => (message.params as Json).sessionId)).toEqual(["sess-1"])
    // What the agent still sends after the cancel opens no further continuation.
    await Bun.sleep(300)
    expect(offers).toHaveLength(1)
  })

  // recorded/background-done.jsonl's shape (Copilot 1.0.112): a detached shell, the turn ends, ~5 s later Copilot
  // reads the shell and speaks with no prompt. The replay tool keeps no gaps, so this is scripted.
  test("Copilot detached-shell: the follow-up after the turn opens a continuation with the read card", async () => {
    const { adapter } = agent("copilot", { spec: { ...SPEC, id: "copilot", label: "Copilot" }, continuationQuietMs: 50 })
    const offers = offersOf(adapter)
    const owner = { ...continuationOwner, agentId: "copilot" }
    const first = context({ executionIdentity: owner })
    await adapter.reply("detached-shell", first.ctx)
    expect(first.of("text").map((event) => event.text)).toEqual(["Started in the background."])
    for (let i = 0; i < 100 && offers.length === 0; i++) await Bun.sleep(10)
    expect(offers).toHaveLength(1)
    const next = context({ executionIdentity: { ...owner, turnId: "t2" }, nativeId: "sess-1", continuation: { key: offers[0]!.key, delivery: "buffered" } })
    await adapter.reply("wake", next.ctx)
    expect(next.of("text").map((event) => event.text)).toEqual(["The background command completed successfully."])
    expect(next.of("tool").at(-1)).toMatchObject({ kind: "read", status: "completed" })
  })

  test("a Grok wake after the turn ended becomes a continuation", async () => {
    const { adapter } = agent("grok-subagent")
    const late: import("./types").LateAgentEvent[] = []
    adapter.setLateEventSink!(async event => { late.push(event) })
    const offers = offersOf(adapter)
    const first = context({ executionIdentity: continuationOwner })
    await adapter.reply("orphan", first.ctx)
    for (let i = 0; i < 100 && offers.length === 0; i++) await Bun.sleep(10)
    expect(offers).toHaveLength(1)
    expect(offers[0]).toMatchObject({ key: "01a1ffff-1111-7000-8000-000000000000", delivery: "buffered", identity: { ...continuationOwner, nativeSessionId: "sess-1" } })
    const next = context({ executionIdentity: { ...continuationOwner, turnId: "t2" }, nativeId: "sess-1", continuation: { key: offers[0]!.key, delivery: "buffered" } })
    await adapter.reply("wake", next.ctx)
    expect(next.of("text").at(-1)?.text.trim()).toBe("没人登记的子代理回来了")
    expect(first.of("text").map((event) => event.text)).toEqual(["先结束这一轮"])
    expect(late).toEqual([])
  })

  test("a held Grok turn keeps its own wake reply and offers nothing", async () => {
    const { adapter } = agent("grok-subagent")
    const offers = offersOf(adapter)
    const { ctx, of } = context({ executionIdentity: continuationOwner })
    await adapter.reply("sub", ctx)
    await Bun.sleep(50)
    expect(of("text").map((event) => event.text)).toEqual(["派出子代理", "根据子代理：ALPHA"])
    expect(offers).toEqual([])
  })

  test("a non-Grok continuation ends after its quiet time", async () => {
    const { adapter } = agent("grok-subagent", { spec: { ...SPEC, id: "copilot", label: "Copilot" }, continuationQuietMs: 30 })
    const offers = offersOf(adapter)
    await adapter.reply("orphan", context({ executionIdentity: { ...continuationOwner, agentId: "copilot" } }).ctx)
    for (let i = 0; i < 100 && offers.length === 0; i++) await Bun.sleep(10)
    expect(offers).toHaveLength(1)
    const next = context({ executionIdentity: { ...continuationOwner, agentId: "copilot", turnId: "t2" }, nativeId: "sess-1", continuation: { key: offers[0]!.key, delivery: "buffered" } })
    const started = Date.now()
    await adapter.reply("wake", next.ctx)
    expect(Date.now() - started).toBeLessThan(1000)
    expect(next.of("text").map((event) => event.text).join("")).toContain("回来了")
  })

  test("a prompt after a kept Grok wake replays it first in that prompt's turn", async () => {
    const { adapter } = agent("grok-subagent")
    const offers = offersOf(adapter)
    await adapter.reply("orphan", context({ executionIdentity: continuationOwner }).ctx)
    for (let i = 0; i < 100 && offers.length === 0; i++) await Bun.sleep(10)
    const next = context({ executionIdentity: { ...continuationOwner, turnId: "t2" }, nativeId: "sess-1" })
    await adapter.reply("anything", next.ctx)
    const texts = next.of("text").map((event) => event.text).join("|")
    expect(texts).toContain("没人登记的子代理回来了")
    expect(texts).toContain("ok")
  })

  test("stopping a continuation turn ends it at once and keeps the agent process", async () => {
    const { adapter, calls } = agent("grok-subagent")
    const offers = offersOf(adapter)
    await adapter.reply("orphan-open", context({ executionIdentity: continuationOwner }).ctx)
    for (let i = 0; i < 100 && offers.length === 0; i++) await Bun.sleep(10)
    // Nothing ends the replayed wake: drop its turn_completed so only the stop can.
    const next = context({ executionIdentity: { ...continuationOwner, turnId: "t2" }, nativeId: "sess-1", continuation: { key: offers[0]!.key, delivery: "buffered" } })
    const started = Date.now()
    const running = adapter.reply("wake", next.ctx)
    await Bun.sleep(20)
    next.controller.abort()
    await running
    expect(Date.now() - started).toBeLessThan(1000)
    await adapter.reply("anything", context({ executionIdentity: continuationOwner, nativeId: "sess-1" }).ctx)
    expect(calls("initialize")).toHaveLength(1)
  })

  test("cancelContinuation keeps a session quiet until its next prompt", async () => {
    const { adapter } = agent("grok-subagent")
    const offers = offersOf(adapter)
    const { ctx } = context({ executionIdentity: continuationOwner }, )
    let stopped = false
    const run = adapter.reply("orphan", { ...ctx, emit: (event) => {
      ctx.emit(event)
      if (!stopped && event.type === "text") {
        stopped = true
        adapter.cancelContinuation!("rudder-1")
      }
    } })
    await run
    await Bun.sleep(200)
    expect(offers).toEqual([])
  })

  test("a Grok turn with no background id still ends on session/prompt", async () => {
    const { adapter } = agent("grok")
    const quiet = context()
    await adapter.reply("empty thought", quiet.ctx)
    expect(quiet.of("background")).toEqual([])
    const bash = context()
    await adapter.reply("bash", bash.ctx)
    expect(bash.of("background")).toEqual([])
    expect(bash.of("tool").some((event) => event.status === "cancelled")).toBe(false)
  })

  test("Copilot does not hold on Grok's background frames", async () => {
    const { adapter } = agent("grok-background", { spec: { ...SPEC, id: "copilot", label: "Copilot" } })
    const { ctx, of } = context()
    const started = Date.now()
    const winner = await Promise.race([
      adapter.reply("bg", ctx).then(() => "done" as const),
      Bun.sleep(500).then(() => "slow" as const),
    ])
    expect(winner).toBe("done")
    expect(Date.now() - started).toBeLessThan(500)
    expect(of("background")).toEqual([])
    expect(of("text").map((event) => event.text)).toEqual(["已经在后台开始"])
  })
})

// Plan 2026-11-18 (turn end on the agent's own signal): a held Grok turn ends on Grok's `_x.ai/queue/changed` (shapes
// from grok/recorded/background-done.jsonl), every wait has a breaker in the process's exit, and a continuation that
// ended on quiet says so.
describe("ACP adapter · authoritative turn end", () => {
  const within = <T>(run: Promise<T>, ms = 2000) =>
    Promise.race([run.then(() => "done" as const, () => "failed" as const), Bun.sleep(ms).then(() => "stuck" as const)])
  const lifecycle = (events: AgentEvent[]) => events.filter((event): event is Extract<AgentEvent, { type: "lifecycle" }> => event.type === "lifecycle")

  test("Grok's idle queue report ends a held turn whose wake sent no turn_completed", async () => {
    const { adapter } = agent("grok-queue")
    const { ctx, of } = context()
    expect(await within(adapter.reply("queue-settles", ctx))).toBe("done")
    expect(of("text").map((event) => event.text)).toEqual(["已经在后台开始", "后台任务跑完了"])
    expect(of("background").at(-1)?.tasks[0]).toMatchObject({ status: "done" })
  })

  test("a task_completed after the last turn_completed ends the held turn", async () => {
    const { adapter } = agent("grok-queue")
    const { ctx, of } = context()
    expect(await within(adapter.reply("late-task-end", ctx))).toBe("done")
    expect(of("text").map((event) => event.text)).toEqual(["已经在后台开始", "后台任务跑完了"])
  })

  test("a task Grok no longer lists as running does not hold the turn", async () => {
    const { adapter } = agent("grok-queue")
    expect(await within(adapter.reply("unknown-status", context().ctx))).toBe("done")
  })

  test("a wake Grok announced (will_wake) holds the turn past an idle queue report until it ran", async () => {
    const { adapter } = agent("grok-queue")
    const { ctx, of } = context()
    expect(await within(adapter.reply("announced-wake", ctx))).toBe("done")
    expect(of("text").map((event) => event.text)).toEqual(["已经在后台开始", "后台任务跑完了"])
  })

  // No recording has it: the frames are grok/recorded/wake-subagent.jsonl's, with the wake queued behind the running
  // prompt (an entry while `p-1` runs, still queued after it, then the dequeue's empty report before it runs).
  test("a wake Grok queued behind the running prompt keeps the turn open until it ran", async () => {
    const { adapter } = agent("grok-queue")
    const { ctx, of } = context()
    expect(await within(adapter.reply("queued-wake", ctx))).toBe("done")
    expect(of("text").at(-1)?.text).toBe("主任务也说完了子代理做完了")
  })

  // Same frames as queued-wake up to the dequeue's empty report; then neither the queue nor a turn_completed shows the
  // wake again. The owed wake is given up at the continuation deadline and the end recorded as inferred.
  test("a wake Grok took off its queue but never ran ends the held turn at the deadline, as inferred", async () => {
    const { adapter } = agent("grok-queue", { continuationDeadlineMs: 200 })
    const { ctx, events } = context()
    expect(await within(adapter.reply("dropped-wake", ctx))).toBe("done")
    expect(lifecycle(events).at(-1)).toMatchObject({ phase: "terminal", terminalStatus: "completed", inferred: { trigger: "long" } })
  })

  test("a queued wake Grok folds into the running prompt does not hold the turn past that prompt", async () => {
    const { adapter } = agent("grok-queue")
    const { ctx, of } = context()
    expect(await within(adapter.reply("folded-wake", ctx))).toBe("done")
    expect(of("text").at(-1)?.text).toBe("子代理也做完了")
  })

  test("the agent exiting while a Grok turn holds ends the turn with a closed transport", async () => {
    const { adapter } = agent("grok-queue")
    const { ctx, events } = context()
    let error: Error | undefined
    const run = adapter.reply("exit-held", ctx).catch((caught: Error) => {
      error = caught
      throw caught
    })
    expect(await within(run)).toBe("failed")
    expect(error?.message).toMatch(/exited \(code 1\)/)
    expect(lifecycle(events).at(-1)).toMatchObject({ transport: "closed" })
  })

  test("a prompt in flight when the agent exits ends the turn with a closed transport", async () => {
    const { adapter } = agent("grok")
    const { ctx, events } = context()
    await expect(adapter.reply("crash", ctx)).rejects.toThrow(/exited \(code 3\)/)
    const closed = lifecycle(events).find((event) => event.transport === "closed")
    expect(closed).toBeDefined()
    expect(closed?.detail).toMatch(/exited \(code 3\)/)
  })

  test("a Copilot continuation that ended on quiet is recorded as inferred, not as the agent's own end", async () => {
    const copilot = { ...SPEC, id: "copilot", label: "Copilot" }
    const { adapter } = agent("grok-subagent", { spec: copilot, continuationQuietMs: 30 })
    const offers: import("./types").ContinuationOffer[] = []
    adapter.setContinuationSink!((offer) => {
      offers.push(offer)
      return true
    })
    const owner = { sessionId: "rudder-1", turnId: "t1", generation: 0, agentId: "copilot" }
    await adapter.reply("orphan", context({ executionIdentity: owner }).ctx)
    for (let i = 0; i < 100 && offers.length === 0; i++) await Bun.sleep(10)
    const next = context({ executionIdentity: { ...owner, turnId: "t2" }, nativeId: "sess-1", continuation: { key: offers[0]!.key, delivery: "buffered" } })
    await adapter.reply("wake", next.ctx)
    expect(lifecycle(next.events).at(-1)).toMatchObject({ phase: "terminal", terminalStatus: "completed", inferred: { trigger: "short", quietMs: 30 } })
  })

  // Plan 2026-11-18 step 4, frames from copilot/recorded/idle-background.jsonl: Copilot's own run after end_turn ends
  // with `session.idle`; its reply came 26 s after it started reading the command's output, far past the quiet window.
  test("a Copilot continuation ends on Copilot's session.idle, not on quiet", async () => {
    const copilot = { ...SPEC, id: "copilot", label: "Copilot" }
    const { adapter } = agent("copilot", { spec: copilot, continuationQuietMs: 100 })
    const offers: import("./types").ContinuationOffer[] = []
    adapter.setContinuationSink!((offer) => {
      offers.push(offer)
      return true
    })
    const owner = { sessionId: "rudder-1", turnId: "t1", generation: 0, agentId: "copilot" }
    await adapter.reply("idle-wake", context({ executionIdentity: owner }).ctx)
    for (let i = 0; i < 100 && offers.length === 0; i++) await Bun.sleep(10)
    const next = context({ executionIdentity: { ...owner, turnId: "t2" }, nativeId: "sess-1", continuation: { key: offers[0]!.key, delivery: "buffered" } })
    expect(await within(adapter.reply("wake", next.ctx))).toBe("done")
    expect(next.of("text").map((event) => event.text)).toEqual(["Finished."])
    const end = lifecycle(next.events).at(-1)
    expect(end).toMatchObject({ phase: "terminal", terminalStatus: "completed" })
    expect(end?.inferred).toBeUndefined()
  })

  test("a Copilot continuation whose session.idle came before it started ends after the replay", async () => {
    const copilot = { ...SPEC, id: "copilot", label: "Copilot" }
    const { adapter } = agent("copilot", { spec: copilot, continuationQuietMs: 5000 })
    const offers: import("./types").ContinuationOffer[] = []
    adapter.setContinuationSink!((offer) => {
      offers.push(offer)
      return true
    })
    const owner = { sessionId: "rudder-1", turnId: "t1", generation: 0, agentId: "copilot" }
    await adapter.reply("idle-wake", context({ executionIdentity: owner }).ctx)
    await Bun.sleep(600)
    const next = context({ executionIdentity: { ...owner, turnId: "t2" }, nativeId: "sess-1", continuation: { key: offers[0]!.key, delivery: "buffered" } })
    expect(await within(adapter.reply("wake", next.ctx), 1000)).toBe("done")
    expect(next.of("text").map((event) => event.text)).toEqual(["Finished."])
    expect(lifecycle(next.events).at(-1)?.inferred).toBeUndefined()
  })

  test("Copilot is asked for its idle and turn-start session events", async () => {
    const { adapter, received } = agent("copilot", { spec: { ...SPEC, id: "copilot", label: "Copilot" } })
    await adapter.reply("echo", context().ctx)
    const init = received().find((message) => message.method === "initialize")
    expect(init?.params.clientCapabilities._meta["github.com/copilot"].events).toEqual(
      expect.arrayContaining(["session.idle", "assistant.turn_start", "subagent.started"]),
    )
  })

  test("a continuation cut at its deadline is recorded as inferred too", async () => {
    const copilot = { ...SPEC, id: "copilot", label: "Copilot" }
    const { adapter } = agent("copilot", { spec: copilot, continuationQuietMs: 1000, continuationDeadlineMs: 200 })
    const offers: import("./types").ContinuationOffer[] = []
    adapter.setContinuationSink!((offer) => {
      offers.push(offer)
      return true
    })
    const owner = { sessionId: "rudder-1", turnId: "t1", generation: 0, agentId: "copilot" }
    await adapter.reply("endless-wake", context({ executionIdentity: owner }).ctx)
    for (let i = 0; i < 100 && offers.length === 0; i++) await Bun.sleep(10)
    const next = context({ executionIdentity: { ...owner, turnId: "t2" }, nativeId: "sess-1", continuation: { key: offers[0]!.key, delivery: "buffered" } })
    await adapter.reply("wake", next.ctx)
    expect(lifecycle(next.events).at(-1)).toMatchObject({ phase: "terminal", inferred: { trigger: "long" } })
  })

  test("a prompt's own answer is never recorded as inferred", async () => {
    const { adapter } = agent("grok")
    const { ctx, events } = context()
    await adapter.reply("hello", ctx)
    expect(lifecycle(events).at(-1)).toMatchObject({ phase: "terminal", terminalStatus: "completed" })
    expect(lifecycle(events).at(-1)?.inferred).toBeUndefined()
  })
})

describe("grok billing", () => {
  // A real `_x.ai/billing` answer (grok agent stdio, 2026-11-05).
  const BILLING = {
    config: {
      creditUsagePercent: 76.0,
      currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-10-31T17:05:36.858+00:00", end: "2026-11-07T17:05:36.858+00:00" },
      prepaidBalance: { val: 0 },
      isUnifiedBillingUser: true,
      billingPeriodStart: "2026-10-31T17:05:36.858+00:00",
      billingPeriodEnd: "2026-11-07T17:05:36.858+00:00",
    },
    subscription_tier: "SuperGrok Heavy",
  }

  test("the weekly credit share is one window with the period's end as its reset", () => {
    expect(grokQuota(BILLING, 5)).toEqual({
      plan: "SuperGrok Heavy",
      windows: [{ minutes: 10080, usedPercent: 76, resetsAt: Date.parse("2026-11-07T17:05:36.858+00:00") }],
      updatedAt: 5,
    })
  })

  test("no usage share, nothing to show; only Grok reports limits", () => {
    expect(grokQuota({ config: {}, subscription_tier: "SuperGrok" })).toBeUndefined()
    expect(createAcpAdapter({ spec: SPEC, command: ["rudder-no-such-agent"] }).limits).toBeDefined()
    expect(createAcpAdapter({ spec: { ...SPEC, id: "copilot", label: "Copilot" }, command: ["rudder-no-such-agent"] }).limits).toBeUndefined()
  })
})
