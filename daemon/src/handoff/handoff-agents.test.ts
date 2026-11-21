// Session handoff P2a (Codex) and P3 (ACP) through SessionService: handoff.list with and without the new phones' flag,
// handoff.inspect / import, and the first phone turn resuming the same native session. The Codex and Grok adapters
// are the real ones, talking to the offline fakes with recorded shapes (see sources.test.ts); Claude is test-kit's.
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAcpAdapter } from "../adapter/acp"
import { createCodexAdapter } from "../adapter/codex"
import { BUILTIN_AGENTS } from "../adapter/index"
import type { AgentAdapter } from "../adapter/types"
import { ACP_REPLAYS, ADAPTER_FIXTURES, acpScenario, CODEX_THREAD, codexScript, codexThread, type Json, withCwd } from "./agent-fixtures"
import { harness, waitFor } from "./test-kit"

const spec = (id: string) => BUILTIN_AGENTS.find((entry) => entry.spec.id === id)!.spec

type Kit = ReturnType<typeof harness>

const kits: Kit[] = []
const adapters: AgentAdapter[] = []
afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.dispose?.()
  for (const made of kits.splice(0)) await made.cleanup()
})

const at = (ms: number) => Math.floor(ms / 1000)
const iso = (ms: number) => new Date(ms).toISOString()

/** Everything a fake received, by method (the codex fake logs {dir, msg}; the ACP fake logs messages). */
function sentTo(log: string, method: string): Json[] {
  if (!existsSync(log)) return []
  return readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Json)
    .map((entry) => (entry.dir ? entry.msg : entry))
    .filter((message) => message?.method === method)
}

/**
 * A kit whose registry has the fake Claude, a real Codex adapter on `codexSteps` (after the handshake), a real Grok
 * adapter with `grok` sessions and the recorded replay, and a Copilot that cannot list (its capabilities trimmed).
 */
function setup(codexSteps: (cwd: string, now: number) => Json[]) {
  const now = Date.now()
  const root = mkdtempSync(join(tmpdir(), "rudder-handoff-"))
  const cwd = join(root, "work", "agents")
  mkdirSync(cwd, { recursive: true })
  const codexLog = join(root, "codex.jsonl")
  const codex = createCodexAdapter({
    spec: spec("codex"),
    command: [process.execPath, join(ADAPTER_FIXTURES, "codex", "fake-app-server.ts"), codexScript(root, codexSteps(cwd, now)), codexLog],
    lockHolders: async (ids) => new Map(ids.filter((id) => id === "thr-busy").map((id) => [id, [424_242]])),
  })
  const grokLog = join(root, "grok.jsonl")
  const session = withCwd(ACP_REPLAYS.grok.session, cwd)
  const grokScenario = acpScenario(root, "grok", {
    listPages: [[{ ...session, sessionId: "g-1", updatedAt: iso(now - 60_000) }]],
    loadReplayFrames: withCwd(ACP_REPLAYS.grok.replay, cwd),
  })
  const grok = createAcpAdapter({ spec: spec("grok"), command: [process.execPath, join(ADAPTER_FIXTURES, "acp", "fake-agent.ts"), grokScenario, grokLog] })
  // A Copilot whose initialize lacks session/list: it cannot be listed.
  const copilotScenario = acpScenario(root, "copilot", {})
  const raw = JSON.parse(readFileSync(copilotScenario, "utf8")) as Json
  raw.initialize.agentCapabilities.sessionCapabilities = { close: {} }
  writeFileSync(copilotScenario, JSON.stringify(raw))
  const copilot = createAcpAdapter({
    spec: spec("copilot"),
    command: [process.execPath, join(ADAPTER_FIXTURES, "acp", "fake-agent.ts"), copilotScenario, join(root, "copilot.jsonl")],
  })
  adapters.push(codex, grok, copilot)
  const k = harness({ root, agents: [codex, grok, copilot] })
  kits.push(k)
  return { k, cwd, now, codexLog, grokLog }
}

const codexList = (cwd: string, now: number) => ({
  expect: "thread/list",
  result: {
    data: [
      codexThread({ id: "thr-a", cwd, updatedAt: at(now - 30_000), name: "Codex thread A" }),
      codexThread({ id: "thr-busy", cwd, updatedAt: at(now - 90_000), preview: "busy one" }),
    ],
    nextCursor: null,
    backwardsCursor: null,
  },
})
const codexItems = { expect: "thread/items/list", result: { data: CODEX_THREAD.items, nextCursor: null, backwardsCursor: null } }

/** A Claude transcript the terminal has left, newest of the three agents' entries by a little. */
function claudeTranscript(k: Kit) {
  const nativeId = crypto.randomUUID()
  const term = k.terminal(nativeId)
  term.writer.title("Claude one")
  term.writer.turn("prompt", "reply")
  term.exit()
  return nativeId
}

describe("handoff.list across agents", () => {
  test("old phones (no flag) get exactly the Claude list; new phones get every agent with `agent` on each entry", async () => {
    const { k, cwd } = setup((cwd, now) => [codexList(cwd, now)])
    claudeTranscript(k)
    const old = await k.ok<{ entries: Json[]; unsupported: Json[] }>("handoff.list")
    expect(old.entries.map((entry) => entry.agent)).toEqual(["claude"])
    expect(old.unsupported).toEqual([])
    // Old phones never start the other agents.
    expect(sentTo(join(k.root, "codex.jsonl"), "thread/list")).toEqual([])

    const all = await k.ok<{ entries: Json[]; unsupported: Json[] }>("handoff.list", { agents: "all" })
    expect(all.entries.map((entry) => `${entry.agent}:${entry.title}`)).toEqual([
      "claude:Claude one",
      "codex:Codex thread A",
      "grok:MultiSelect pizza toppings cheese mushroom olive",
      "codex:busy one",
    ])
    const [claude, codexA, grok, busy] = all.entries
    expect(Object.keys(claude!).sort()).toEqual(Object.keys(old.entries[0]!).sort())
    expect(codexA).toMatchObject({ agent: "codex", cwd, live: null, importable: true, writable: true })
    expect(codexA!.closeFirst).toBeUndefined()
    expect(busy).toMatchObject({ agent: "codex", importable: false, reason: "in_use" })
    expect(grok).toMatchObject({ agent: "grok", cwd, live: null, importable: true, closeFirst: true })
    expect(all.unsupported).toEqual([{ agent: "copilot", reason: "no_session_list" }])
  })

  test("`agent` filters to one agent", async () => {
    const { k } = setup((cwd, now) => [codexList(cwd, now)])
    claudeTranscript(k)
    const codex = await k.ok<{ entries: Json[]; unsupported: Json[] }>("handoff.list", { agent: "codex" })
    expect(codex.entries.map((entry) => entry.agent)).toEqual(["codex", "codex"])
    expect(codex.unsupported).toEqual([])
    const claude = await k.ok<{ entries: Json[] }>("handoff.list", { agent: "claude", agents: "all" })
    expect(claude.entries.map((entry) => entry.agent)).toEqual(["claude"])
  })
})

describe("handoff.import for Codex", () => {
  test("a thread comes over as history bound to its thread id; the phone's next turn resumes that thread", async () => {
    const { k, codexLog } = setup((cwd, now) => [
      codexList(cwd, now),
      codexItems,
      { expect: "thread/list", result: { data: [codexThread({ id: "thr-a", cwd, updatedAt: at(now - 30_000), name: "Codex thread A" })], nextCursor: null, backwardsCursor: null } },
      { expect: "account/read", result: { account: { type: "chatgpt", email: null, planType: "plus" }, requiresOpenaiAuth: true } },
      { expect: "thread/resume", result: { thread: { id: "thr-a", status: { type: "idle" }, turns: [] }, model: "gpt-6-luna", cwd, approvalPolicy: "untrusted", approvalsReviewer: "user", sandbox: { type: "workspaceWrite" }, reasoningEffort: "low" } },
      { expect: "turn/start", result: { turn: { id: "turn-p1", rootTurnId: "turn-p1", items: [], itemsView: "notLoaded", status: "inProgress", error: null } } },
      { send: { method: "item/completed", params: { threadId: "thr-a", turnId: "turn-p1", item: { type: "agentMessage", id: "msg-p1", text: "phone reply", phase: "final_answer", memoryCitation: null, delivery: null, questions: null } } } },
      { send: { method: "turn/completed", params: { threadId: "thr-a", turn: { id: "turn-p1", rootTurnId: "turn-p1", items: [{ type: "agentMessage", id: "msg-p1", text: "phone reply", phase: "final_answer" }], itemsView: "full", status: "completed", error: null } } } },
    ])
    const { entries } = await k.ok<{ entries: Json[] }>("handoff.list", { agent: "codex" })
    const ref = entries.find((entry) => entry.title === "Codex thread A")!.ref
    const inspect = await k.ok<Json>("handoff.inspect", { ref })
    expect(inspect).toMatchObject({ title: "Codex thread A", messages: 5, earlier: 0, live: null })
    expect(inspect.closeFirst).toBeUndefined()
    const { session } = await k.ok<{ session: Json }>("handoff.import", { ref })
    const row = k.store.getSession(session.id)!
    expect(row).toMatchObject({ agent: "codex", native_id: "thr-a", origin: "terminal", permission_mode: "ask", title: "Codex thread A" })
    const rows = k.store.listMessages(session.id)
    expect(rows.map((message) => message.kind)).toEqual(["handoff", "text", "reasoning", "text", "tool", "tool", "tool", "text", "text", "tool", "compaction", "text"])
    expect(rows[1]).toMatchObject({ role: "user", text: "USER asks one", id: "codex:thr-a:01a1867f-a3e7-7281-8eed-be7384adec08" })
    expect(JSON.parse(rows[4]!.payload!)).toMatchObject({ tool: "Shell", status: "completed", imported: true })
    // inspect and import read the thread once.
    expect(sentTo(codexLog, "thread/items/list")).toHaveLength(1)
    // Again: the same session, nothing read again.
    const again = await k.ok<{ session: Json }>("handoff.import", { ref })
    expect(again.session.id).toBe(session.id)
    const relisted = await k.ok<{ entries: Json[] }>("handoff.list", { agent: "codex" })
    expect(relisted.entries[0]).toMatchObject({ sessionId: session.id })

    await k.ok("message.send", { sessionId: session.id, text: "from the phone" })
    await waitFor(() => k.store.listMessages(session.id).some((message) => message.text === "phone reply"), 5000)
    expect(sentTo(codexLog, "thread/resume")[0]!.params).toMatchObject({ threadId: "thr-a" })
    expect(sentTo(codexLog, "turn/start")[0]!.params).toMatchObject({ threadId: "thr-a" })
    const texts = k.store.listMessages(session.id).map((message) => message.text)
    expect(texts.slice(-3)).toEqual(["以下在手机上", "from the phone", "phone reply"])
  })

  test("a long thread keeps its last 200 turns; 「更早的」 brings the rest by reading the thread again", async () => {
    const turns = 205
    const items = Array.from({ length: turns }, (_, n) => [
      { turnId: `t${n}`, item: { type: "userMessage", id: `u${n}`, content: [{ type: "text", text: `ask ${n}`, text_elements: [] }], startedAtMs: 1_790_000_000_000 + n * 10 } },
      { turnId: `t${n}`, item: { type: "agentMessage", id: `a${n}`, text: `answer ${n}`, phase: "final_answer", startedAtMs: 1_790_000_000_000 + n * 10 + 1 } },
    ]).flat()
    const page = { expect: "thread/items/list", result: { data: items, nextCursor: null, backwardsCursor: null } }
    const { k, codexLog } = setup((cwd, now) => [codexList(cwd, now), page, page])
    const { entries } = await k.ok<{ entries: Json[] }>("handoff.list", { agent: "codex" })
    const { session } = await k.ok<{ session: Json }>("handoff.import", { ref: entries[0]!.ref })
    expect(session.importedEarlier).toBe(10)
    const rows = k.store.listMessages(session.id)
    expect(rows[0]).toMatchObject({ kind: "handoff", seq: 1 })
    expect(rows.filter((row) => row.role === "user")).toHaveLength(200)
    const { session: after } = await k.ok<{ session: Json }>("handoff.importEarlier", { id: session.id })
    expect(after.importedEarlier).toBeUndefined()
    expect(k.store.listMessages(session.id).filter((row) => row.role === "user").map((row) => row.text).slice(0, 2)).toEqual(["ask 0", "ask 1"])
    expect(sentTo(codexLog, "thread/items/list")).toHaveLength(2)
  })

  test("a thread another process has loaded is refused", async () => {
    const { k } = setup((cwd, now) => [codexList(cwd, now)])
    const { entries } = await k.ok<{ entries: Json[] }>("handoff.list", { agent: "codex" })
    const busy = entries.find((entry) => entry.reason === "in_use")!
    const frame = await k.call("handoff.import", { ref: busy.ref })
    expect(frame.error?.code).toBe("in_use")
    expect(k.store.findByNative("codex", "thr-busy")).toBeNull()
  })
})

describe("handoff.import for ACP", () => {
  test("Grok: the replay comes over, the session is closed after the read, and the phone's turn resumes it", async () => {
    const { k, grokLog } = setup(() => [])
    const { entries } = await k.ok<{ entries: Json[] }>("handoff.list", { agent: "grok" })
    const ref = entries[0]!.ref
    const inspect = await k.ok<Json>("handoff.inspect", { ref })
    expect(inspect).toMatchObject({ closeFirst: true, live: null, earlier: 0 })
    const { session } = await k.ok<{ session: Json }>("handoff.import", { ref })
    const row = k.store.getSession(session.id)!
    expect(row).toMatchObject({ agent: "grok", native_id: "g-1", origin: "terminal", permission_mode: "autoApproval" })
    const rows = k.store.listMessages(session.id)
    expect(rows[0]!.kind).toBe("handoff")
    expect(rows[1]).toMatchObject({ kind: "text", role: "user", id: "grok:g-1:0" })
    expect(rows.filter((message) => message.kind === "tool")).toHaveLength(3)
    // One load for inspect + import; closed right after.
    expect(sentTo(grokLog, "session/load")).toHaveLength(1)
    expect(sentTo(grokLog, "session/close").map((message) => message.params.sessionId)).toEqual(["g-1"])

    await k.ok("message.send", { sessionId: session.id, text: "hello again" })
    await waitFor(() => k.store.listMessages(session.id).some((message) => message.text === "ok"), 5000)
    expect(sentTo(grokLog, "session/resume")[0]!.params).toMatchObject({ sessionId: "g-1" })
    expect(sentTo(grokLog, "session/new")).toEqual([])
  })
})
