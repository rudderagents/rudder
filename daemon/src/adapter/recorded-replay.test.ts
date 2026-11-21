import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import { createAcpAdapter } from "./acp"
import { createClaudeAdapter } from "./claude"
import { createCodexAdapter } from "./codex"
import { BUILTIN_AGENTS } from "./index"
import type { AdapterContext, AgentAdapter, AgentEvent, PermissionRequest, QuestionRequest } from "./types"

// r66: every recorded CLI scenario (fixtures/<agent>/recorded, made by scripts/record) replayed through the real adapter,
// each checked against the same invariants: the turn ends; the next message starts and gets its reply; nothing from the
// first turn shows up in the second; every tool card and background task ends settled.

const FIXTURES = join(import.meta.dir, "fixtures")
const TERMINAL = new Set(["completed", "failed", "declined", "cancelled"])
const spec = (id: string) => BUILTIN_AGENTS.find((entry) => entry.spec.id === id)!.spec

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

type Answers = {
  permission?: (request: PermissionRequest) => string | null
  question?: (request: QuestionRequest) => Record<string, string> | null
  /** Called on every event of the first turn, with what the test needs to act (abort, stop background). */
  onEvent?: (event: AgentEvent, act: { abort: () => void; adapter: AgentAdapter }) => void
}

type Turn = { events: AgentEvent[]; error?: Error; ms: number }

async function turn(adapter: AgentAdapter, text: string, answers: Answers = {}, overrides: Partial<AdapterContext> = {}): Promise<Turn> {
  const events: AgentEvent[] = []
  const controller = new AbortController()
  const ctx: AdapterContext = {
    sessionId: "s1",
    cwd: tmpdir(),
    permissionMode: "ask",
    signal: controller.signal,
    emit: (event) => {
      events.push(event)
      answers.onEvent?.(event, { abort: () => controller.abort(), adapter })
    },
    askPermission: async (request) => answers.permission?.(request) ?? null,
    askQuestion: async (request) => answers.question?.(request) ?? null,
    ...overrides,
  }
  const started = Date.now()
  let error: Error | undefined
  const reply = adapter.reply(text, ctx).catch((caught: Error) => {
    error = caught
  })
  // Invariant 1: the turn ends. A replay has no model to wait for, so 15 s is far past any real ending.
  const ended = await Promise.race([reply.then(() => true), Bun.sleep(15_000).then(() => false)])
  if (!ended) throw new Error(`turn did not end; last events: ${JSON.stringify(events.slice(-3))}`)
  return { events, error, ms: Date.now() - started }
}

function nativeOf(events: AgentEvent[]): string | undefined {
  return events.find((event): event is Extract<AgentEvent, { type: "native" }> => event.type === "native")?.nativeId
}

function ids(events: AgentEvent[]): Set<string> {
  const out = new Set<string>()
  for (const event of events) if ("id" in event && typeof event.id === "string") out.add(event.id)
  return out
}

function texts(events: AgentEvent[]): string[] {
  const byId = new Map<string, string>()
  for (const event of events) if (event.type === "text" && !event.notice) byId.set(event.id, event.text)
  return [...byId.values()].filter((text) => text.trim())
}

/** Invariant 4: tools and background work end settled. */
function expectSettled(events: AgentEvent[]) {
  const tools = new Map<string, string>()
  for (const event of events) if (event.type === "tool") tools.set(event.id, event.status)
  for (const [id, status] of tools) expect({ id, status, settled: TERMINAL.has(status) }).toMatchObject({ settled: true })
  const background = events.filter((event): event is Extract<AgentEvent, { type: "background" }> => event.type === "background").at(-1)
  if (background) {
    expect(background.open).toBe(0)
    for (const task of background.tasks) expect(task.status).not.toBe("running")
  }
}

/** Invariants 2 and 3: a second message on the same session gets its own reply, with no event of the first turn. */
async function expectNextTurn(adapter: AgentAdapter, first: Turn) {
  // The daemon hands the agent's own session id back on the next turn, so the live process is reused.
  const second = await turn(adapter, "Reply with the single word: ok", {}, { nativeId: nativeOf(first.events) })
  expect(second.error).toBeUndefined()
  expect(texts(second.events).length).toBeGreaterThan(0)
  const before = ids(first.events)
  const leaked = [...ids(second.events)].filter((id) => before.has(id))
  expect(leaked).toEqual([])
  expectSettled(second.events)
}

// --- Claude: fake-claude replays the recording; the next turn is the recorded turn-ok on the same process.

function claude(scenario: string, extra: { spawns?: string[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "rudder-replay-claude-"))
  let spawn = 0
  const recorded = (name: string) => join(FIXTURES, "claude", "recorded", `${name}.jsonl`)
  const plan = extra.spawns ?? [`${recorded(scenario)}+${recorded("turn-ok")}`]
  const adapter = createClaudeAdapter({
    spec: spec("claude"),
    command: process.execPath,
    args: (base) => {
      const replay = plan[spawn] ?? plan.at(-1)!
      const log = join(dir, `stdin-${spawn}.jsonl`)
      spawn += 1
      return [join(FIXTURES, "claude", "fake-claude.ts"), replay, log, ...base]
    },
  })
  cleanups.push(async () => {
    await adapter.dispose?.()
    rmSync(dir, { recursive: true, force: true })
  })
  return adapter
}

const firstOption = (request: QuestionRequest) =>
  Object.fromEntries(request.questions.map((question) => [question.question, question.options[0]?.label ?? ""]))

describe("recorded Claude Code 2.1.312", () => {
  const cases: [string, Answers][] = [
    ["turn-ok", {}],
    ["tool-bash", { permission: (request) => request.options.find((option) => option.kind === "allow_once")?.id ?? null }],
    ["perm-deny", { permission: (request) => request.options.find((option) => option.kind === "reject_once")?.id ?? null }],
    ["ask", { question: firstOption }],
    // Stopped once the CLI has taken the message (its init): the recording sent its interrupt as the reply began.
    ["interrupt", { onEvent: (event, act) => event.type === "native" && act.abort() }],
    ["background-done", {}],
    [
      "background-stop",
      { onEvent: (event, act) => event.type === "background" && event.paused && event.open > 0 && void act.adapter.stopBackground?.("s1") },
    ],
  ]
  for (const [scenario, answers] of cases) {
    test(`${scenario}: the turn ends settled and the next one answers`, async () => {
      const adapter = claude(scenario)
      const first = await turn(adapter, scenario, answers)
      if (scenario !== "interrupt") expect(first.error).toBeUndefined()
      expectSettled(first.events)
      await expectNextTurn(adapter, first)
    }, 30_000)
  }

  test("set-model and compaction: both recorded turns end, on one process", async () => {
    for (const scenario of ["set-model", "compaction"]) {
      const adapter = claude(scenario, { spawns: [join(FIXTURES, "claude", "recorded", `${scenario}.jsonl`)] })
      const first = await turn(adapter, "Reply ok.")
      expect(first.error).toBeUndefined()
      // The recording switched to haiku between the turns; the replay writes what followed once the adapter does too.
      const second = await turn(adapter, "again", {}, { nativeId: nativeOf(first.events), model: "haiku" })
      expect(second.error).toBeUndefined()
      expectSettled(second.events)
      expect([...ids(second.events)].filter((id) => ids(first.events).has(id))).toEqual([])
    }
  }, 30_000)

  // The real CLI says nothing after stop_task: the stopped task's notification, then silence (no text, no result).
  test("background-stop as recorded: after stop_task only the task's end arrives", async () => {
    const { recordedSpawn } = await import("./fixtures/recorded")
    const lines = recordedSpawn(join(FIXTURES, "claude", "recorded", "background-stop.jsonl"))
    const stop = lines.findIndex((line) => line.dir === "in" && "frame" in line && line.frame.request?.subtype === "stop_task")
    expect(stop).toBeGreaterThan(0)
    const after = lines.slice(stop + 1).flatMap((line) => (line.dir === "out" && "frame" in line ? [line.frame] : []))
    expect(after.map((frame) => frame.subtype ?? frame.type)).toEqual(["task_updated", "task_notification", "background_tasks_changed", "control_response"])
    expect(after.some((frame) => frame.type === "result" || frame.type === "assistant")).toBe(false)
  })
})

// --- Codex and Grok: replay-rpc.ts plays the recording; the next turn is the recorded turn-ok, rewritten onto the
// first recording's thread / session id.

function rpcCommand(agent: string, replay: string) {
  const dir = mkdtempSync(join(tmpdir(), `rudder-replay-${agent}-`))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const recorded = join(FIXTURES, agent, "recorded")
  const bank = readdirSync(recorded).map((name) => join(recorded, name))
  return [process.execPath, join(FIXTURES, "replay-rpc.ts"), replay, join(dir, "launches"), ...bank]
}

function recordedPair(agent: string, scenario: string) {
  const recorded = (name: string) => join(FIXTURES, agent, "recorded", `${name}.jsonl`)
  return `${recorded(scenario)}+${recorded("turn-ok")}`
}

function codex(scenario: string) {
  const adapter = createCodexAdapter({ spec: spec("codex"), command: rpcCommand("codex", recordedPair("codex", scenario)) })
  cleanups.push(async () => {
    await adapter.dispose?.()
  })
  return adapter
}

function grok(scenario: string) {
  const adapter = createAcpAdapter({ spec: spec("grok"), command: rpcCommand("grok", recordedPair("grok", scenario)), cancelGraceMs: 300 })
  cleanups.push(async () => {
    await adapter.dispose?.()
  })
  return adapter
}

const pick = (kind: string) => (request: PermissionRequest) =>
  request.options.find((option) => option.kind === kind)?.id ?? request.options.find((option) => option.kind.startsWith(kind.split("_")[0]!))?.id ?? null

// 2026-11-17 questions: Codex 0.169 request_user_input and an MCP tool's approval + form (recorded on DeepSeek).
describe("recorded Codex questions", () => {
  test("request_user_input reaches askQuestion and the answer reaches Codex", async () => {
    const asked: QuestionRequest[] = []
    const run = await turn(codex("ask-default"), "ask", {
      question: (request) => {
      asked.push(request)
      return { [request.questions[0]!.question]: "Red" }
    },
    })
    expect(run.error).toBeUndefined()
    expect(asked[0]!.questions[0]).toMatchObject({ question: "Which color do you prefer: red or blue?", header: "Color", allowsOther: true })
    expect(texts(run.events).join("")).toContain("red")
  }, 30_000)

  test("an MCP tool's approval is a permission card and its form a question card", async () => {
    const permissions: PermissionRequest[] = []
    const asked: QuestionRequest[] = []
    const run = await turn(codex("elicit-form"), "order", {
      permission: (request) => {
      permissions.push(request)
      return "accept"
    },
      question: (request) => {
      asked.push(request)
      return null
    },
    })
    expect(run.error).toBeUndefined()
    expect(permissions[0]).toMatchObject({ tool: "mcp__probe__order_pizza" })
    expect(asked[0]!.questions.map((item) => item.header)).toEqual(["How many", "Crust", "Extra sauce", "Note for the kitchen", "Size", "Toppings"])
  }, 30_000)
})

// 2026-11-17 Grok 1.0.88: ask_user_question with multiSelect reaches the phone as a multi-select question.
describe("recorded Grok multi-select", () => {
  test("the question card is multi-select", async () => {
    const asked: QuestionRequest[] = []
    const run = await turn(grok("ask-multi"), "toppings", {
      question: (request) => {
        asked.push(request)
        return { [request.questions[0]!.question]: "Cheese (Recommended), Mushroom" }
      },
    })
    expect(run.error).toBeUndefined()
    expect(asked[0]!.questions[0]).toMatchObject({ question: "Which toppings do you want?", multiSelect: true })
  }, 30_000)
})

// 2026-11-17 Grok 1.0.88: an MCP form arrives as `_x.ai/mcp/elicit` and becomes a question card.
describe("recorded Grok MCP form", () => {
  test("the form reaches askQuestion with every field", async () => {
    const asked: QuestionRequest[] = []
    const run = await turn(grok("elicit-form"), "order", { permission: pick("allow_once"), question: (request) => {
      asked.push(request)
      return null
    } })
    expect(run.error).toBeUndefined()
    expect(asked[0]!.questions.map((item) => item.header)).toEqual(["Toppings", "Size", "Crust", "Extra sauce", "How many", "Note for the kitchen"])
    expect(asked[0]!.questions[0]).toMatchObject({ multiSelect: true })
  }, 30_000)
})

// 2026-11-17 continuation turns: the child thread ends after its parent's turn/completed (recorded on DeepSeek).
describe("recorded Codex wake-child", () => {
  // 2026-11-18: the recorded child asks to run its command after the parent's turn/completed. It is asked on a
  // continuation turn (it used to be answered cancel), and its end then offers the message_text continuation.
  test("a subagent's approval after its parent turn is asked on a continuation; its end offers a message_text continuation", async () => {
    const adapter = codex("wake-child")
    const offers: import("./types").ContinuationOffer[] = []
    adapter.setContinuationSink!((offer) => offers.push(offer) > 0)
    const identity = { sessionId: "s1", turnId: "t1", generation: 0, agentId: "codex" }
    const first = await turn(adapter, "wake-child", { permission: pick("allow_once") }, { executionIdentity: identity })
    expect(first.error).toBeUndefined()
    const until = async (count: number) => {
      const deadline = Date.now() + 5000
      while (offers.length < count && Date.now() < deadline) await Bun.sleep(10)
    }
    await until(1)
    expect(offers).toHaveLength(1)
    // Read before any toMatchObject: both offers share one identity object.
    const nativeId = offers[0]!.identity.nativeSessionId
    expect(nativeId).toEqual(expect.any(String))
    expect(offers[0]).toMatchObject({ delivery: "buffered", identity })
    expect(offers[0]!.detail).toContain("sleep 20 && echo CHILD_DONE")
    const asked: PermissionRequest[] = []
    const approval = await turn(adapter, offers[0]!.detail, {
      permission: (request) => {
        asked.push(request)
        return pick("allow_once")(request)
      },
    }, {
      executionIdentity: { ...identity, turnId: "t2" },
      nativeId,
      continuation: { key: offers[0]!.key, delivery: "buffered" },
    })
    expect(approval.error).toBeUndefined()
    expect(asked.map((request) => request.tool)).toEqual(["Shell"])
    await until(2)
    expect(offers).toHaveLength(2)
    expect(offers[1]).toMatchObject({ delivery: "message_text", identity: { ...identity, nativeSessionId: nativeId } })
    expect(offers[1]!.detail).toContain("CHILD_DONE")
    expect(offers[1]!.key).not.toBe(nativeId)
  }, 30_000)

  test("a stop quiets the session: the finished subagent offers nothing", async () => {
    const adapter = codex("wake-child")
    const offers: unknown[] = []
    adapter.setContinuationSink!((offer) => offers.push(offer) > 0)
    let stopped = false
    const onEvent = () => {
      if (stopped) return
      stopped = true
      adapter.cancelContinuation!("s1")
    }
    await turn(adapter, "wake-child", { permission: pick("allow_once"), onEvent }, { executionIdentity: { sessionId: "s1", turnId: "t1", generation: 0, agentId: "codex" } })
    await Bun.sleep(300)
    expect(offers).toEqual([])
  }, 30_000)
})

describe("recorded Codex 0.165.0 (DeepSeek)", () => {
  const cases: [string, Answers][] = [
    ["turn-ok", {}],
    ["tool-bash", { permission: pick("allow_once") }],
    ["perm-deny", { permission: pick("reject_once") }],
    ["interrupt", { onEvent: (event, act) => (event.type === "reasoning" || event.type === "text") && act.abort() }],
  ]
  for (const [scenario, answers] of cases) {
    test(`${scenario}: the turn ends settled and the next one answers`, async () => {
      const adapter = codex(scenario)
      const first = await turn(adapter, scenario, answers)
      if (scenario !== "interrupt") expect(first.error).toBeUndefined()
      expectSettled(first.events)
      await expectNextTurn(adapter, first)
    }, 30_000)
  }

  test("auth-error: the 401 ends the turn as an error and the next one answers", async () => {
    const adapter = codex("auth-error")
    const first = await turn(adapter, "Reply ok.")
    expect(first.error?.message).toContain("401")
    // Codex's own "Reconnecting... n/5" back-offs reach the turn guard as retry events.
    const retries = first.events.filter((event) => event.type === "retry")
    expect(retries.map((event) => (event as { attempt: number }).attempt)).toEqual([1, 2, 3, 4, 5])
    expectSettled(first.events)
    await expectNextTurn(adapter, first)
  }, 30_000)
})

describe("recorded Grok 1.0.70", () => {
  const cases: [string, Answers][] = [
    ["turn-ok", {}],
    ["tool-bash", { permission: pick("allow_once") }],
    ["ask", { question: firstOption }],
    ["interrupt", { onEvent: (event, act) => (event.type === "reasoning" || event.type === "text") && act.abort() }],
    ["background-done", {}],
    // 2026-11-18: the held turn ends on Grok's queue report and the wake's own turn_completed.
    ["wake-subagent", {}],
  ]
  for (const [scenario, answers] of cases) {
    test(`${scenario}: the turn ends settled and the next one answers`, async () => {
      const adapter = grok(scenario)
      const first = await turn(adapter, scenario, answers)
      if (scenario !== "interrupt") expect(first.error).toBeUndefined()
      expectSettled(first.events)
      await expectNextTurn(adapter, first)
    }, 30_000)
  }
})

// r66 recorded these three with a DeepSeek key in a throwaway config (scripts/record); r70 0.8 replays them.
for (const [agent, version] of [
  ["qwen", "Qwen Code 0.26.3"],
  ["goose", "goose"],
  ["pi", "pi-acp 0.0.34"],
  // 2026-11-17: the owner's Copilot Free login.
  ["copilot", "Copilot CLI 1.0.112"],
] as const) {
  describe(`recorded ${version}`, () => {
    const acp = (scenario: string) => {
      const adapter = createAcpAdapter({ spec: spec(agent), command: rpcCommand(agent, recordedPair(agent, scenario)), cancelGraceMs: 300 })
      cleanups.push(async () => {
        await adapter.dispose?.()
      })
      return adapter
    }
    const recorded = new Set(readdirSync(join(FIXTURES, agent, "recorded")).map((name) => name.replace(/\.jsonl$/, "")))
    const cases: [string, Answers][] = [
      ["turn-ok", {}],
      ["tool-bash", { permission: pick("allow_once") }],
      ["perm-deny", { permission: pick("reject_once") }],
      ["interrupt", { onEvent: (event, act) => (event.type === "reasoning" || event.type === "text") && act.abort() }],
      // 2026-11-17: subagent, file edits, a three-step task and a long reasoned answer.
      ["subagent", { permission: pick("allow_once") }],
      ["edit-file", { permission: pick("allow_once") }],
      ["plan", { permission: pick("allow_once") }],
      ["think", {}],
    ]
    for (const [scenario, answers] of cases.filter(([name]) => recorded.has(name))) {
      test(`${scenario}: the turn ends settled and the next one answers`, async () => {
        const adapter = acp(scenario)
        const first = await turn(adapter, scenario, answers)
        if (scenario !== "interrupt") expect(first.error).toBeUndefined()
        expectSettled(first.events)
        await expectNextTurn(adapter, first)
      }, 30_000)
    }
  })
}

// 2026-11-17: what the phone gets from the Qwen Code / goose / pi recordings (DeepSeek, owner-approved).
describe("recorded ACP cards", () => {
  const replay = async (agent: "qwen" | "goose" | "pi" | "copilot", scenario: string, answers: Answers = { permission: pick("allow_once") }) => {
    const adapter = createAcpAdapter({ spec: spec(agent), command: rpcCommand(agent, recordedPair(agent, scenario)), cancelGraceMs: 300 })
    cleanups.push(async () => {
      await adapter.dispose?.()
    })
    const result = await turn(adapter, scenario, answers)
    const tools = new Map<string, Extract<AgentEvent, { type: "tool" }>>()
    const texts = new Map<string, string>()
    for (const event of result.events) {
      if (event.type === "tool") tools.set(event.id, event)
      if (event.type === "text") texts.set(event.id, event.text)
    }
    return { ...result, tools: [...tools.values()], texts: [...texts.values()] }
  }

  test("Qwen Code: the subagent's speech and calls stay on its Agent card", async () => {
    const run = await replay("qwen", "subagent")
    const agents = run.tools.filter((tool) => tool.tool === "Agent")
    expect(agents).toHaveLength(1)
    expect(agents[0]).toMatchObject({ status: "completed", output: "Count: 3\nFiles: alpha.txt, beta.txt, gamma.md" })
    expect(run.tools.some((tool) => tool.kind === "execute")).toBe(false)
    expect(run.texts.some((text) => text.startsWith("Count: 3"))).toBe(false)
    expect(run.texts.at(-1)).toContain("The subagent reported back")
  }, 30_000)

  // Copilot CLI 1.0.112 (owner's Copilot Free login): the subagent's chunks and calls carry
  // `_meta["github.com/copilot"].agentId`, linked to the task call by the opted-in `subagent.started` event.
  test("Copilot: task calls are Agent cards and the subagent's speech and calls stay on them", async () => {
    const run = await replay("copilot", "subagent")
    const agents = run.tools.filter((tool) => tool.tool === "Agent")
    expect(agents.map((tool) => tool.status)).toEqual(["failed", "failed", "completed"])
    expect(agents[2]?.output).toContain("alpha.txt")
    expect(run.tools.some((tool) => tool.kind === "execute")).toBe(false)
    expect(run.texts.some((text) => text.includes("Error: Execution failed"))).toBe(false)
    const reasoning = run.events.flatMap((event) => (event.type === "reasoning" ? [event.text] : [])).join("")
    expect(reasoning).not.toContain("Counting files non-recursively")
    expect(run.texts.at(-1)).toContain("3")
  }, 60_000)

  // Copilot keeps session/prompt open until a background subagent ends; its task call completes at launch.
  test("Copilot: a background subagent is a running background task until it ends with its own words", async () => {
    const run = await replay("copilot", "wake-subagent")
    const card = run.tools.find((tool) => tool.tool === "Agent")!
    const states = run.events.flatMap((event) => (event.type === "tool" && event.id === card.id ? [event] : []))
    expect(states.findIndex((event) => event.status === "completed")).toBe(states.length - 1)
    expect(card).toMatchObject({ status: "completed", output: "DONE" })
    const background = run.events.flatMap((event) => (event.type === "background" ? [event] : []))
    expect(background[0]).toMatchObject({ open: 1, tasks: [{ kind: "subagent", title: "Run delayed completion task", status: "running", toolId: card.id }] })
    expect(background.at(-1)).toMatchObject({ open: 0, tasks: [{ status: "done" }] })
    expect(run.texts.some((text) => text.includes("Agent started in background"))).toBe(false)
    expect(run.texts.some((text) => text.includes("Launched."))).toBe(true)
    expect(run.texts.at(-1)).toBe("DONE")
  }, 60_000)

  test("Copilot: a background subagent that fails shows its error on the card, not in the reply", async () => {
    const run = await replay("copilot", "wake-subagent-failed")
    const card = run.tools.find((tool) => tool.tool === "Agent")!
    expect(card).toMatchObject({ status: "failed", output: "400 The requested model is not supported." })
    const background = run.events.flatMap((event) => (event.type === "background" ? [event] : []))
    expect(background.at(-1)).toMatchObject({ open: 0, tasks: [{ status: "failed" }] })
    expect(run.texts.some((text) => text.includes("Error: Execution failed"))).toBe(false)
  }, 60_000)

  test("Copilot: todo bookkeeping (sql on todos) adds no cards; the plan list still arrives", async () => {
    const run = await replay("copilot", "plan")
    expect(run.tools.map((tool) => tool.kind)).toEqual(["execute", "execute", "execute"])
    const plans = run.events.flatMap((event) => (event.type === "plan" ? [event] : []))
    expect(plans.at(-1)?.entries).toHaveLength(3)
  }, 60_000)

  // Copilot's own status lines ("Info: Operation cancelled by user", "Info: … Retrying...") come as chunks without a
  // messageId; every model reply has one.
  test("Copilot: its Info status lines are not part of the reply", async () => {
    const run = await replay("copilot", "perm-deny", { permission: pick("reject_once") })
    expect(run.texts.some((text) => text.includes("Info: Operation cancelled by user"))).toBe(false)
  }, 60_000)

  test("Qwen Code: writes and edits carry their diffs", async () => {
    const run = await replay("qwen", "edit-file")
    expect(run.tools.map((tool) => [tool.kind, tool.diffs?.length ?? 0])).toEqual([["edit", 1], ["read", 0], ["edit", 1]])
  }, 30_000)

  test("goose: kinds come from its tool names, delegate is an Agent card, write and edit carry diffs", async () => {
    const edit = await replay("goose", "edit-file")
    expect(edit.tools.map((tool) => [tool.kind, tool.diffs?.length ?? 0, tool.exitCode ?? null])).toEqual([
      ["edit", 1, null],
      ["execute", 0, 0],
      ["edit", 1, null],
      ["execute", 0, 0],
    ])
    expect(edit.tools[2]?.diffs?.[0]).toEqual({ path: "notes.txt", oldText: "hello", newText: "hello world" })
    const sub = await replay("goose", "subagent")
    expect(sub.tools.map((tool) => tool.tool)).toEqual(["Agent"])
  }, 30_000)

  test("pi: shell cards show the command, its streamed output and exit code; the startup banner is not a reply", async () => {
    const run = await replay("pi", "plan")
    // The model picks its own commands each recording (pi 1.5.2 also writes a todo file): check the card shape.
    const shells = run.tools.filter((tool) => tool.kind === "execute")
    expect(shells.length).toBeGreaterThan(0)
    for (const tool of shells) {
      expect(tool.detail).toBe(tool.title)
      expect(typeof tool.output).toBe("string")
      expect(tool.output!.length).toBeGreaterThan(0)
      expect(tool.exitCode).toBe(0)
    }
    expect(run.texts.some((text) => /^pi v\d/.test(text))).toBe(false)
  }, 30_000)

  test("pi: a refused key that ends the turn with nothing says so", async () => {
    const run = await replay("pi", "auth-error")
    expect((run.error as { copy?: { code?: string } } | undefined)?.copy?.code).toBe("agent_silent_turn")
  }, 30_000)
})
