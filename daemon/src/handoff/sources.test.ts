// Session handoff P2a / P3 at the adapter boundary: Codex threads and ACP sessions listed and read back as history,
// against the offline fakes (fixtures/codex/fake-app-server.ts, fixtures/acp/fake-agent.ts) fed with shapes recorded
// from the real CLIs (fixtures/codex/handoff-thread.json, fixtures/acp/handoff-replays.json). No real agent runs.
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAcpAdapter } from "../adapter/acp"
import { codexHistoryEntries, createCodexAdapter } from "../adapter/codex"
import { BUILTIN_AGENTS } from "../adapter/index"
import { HandoffUnsupported, type AgentAdapter, type HistoryEntry } from "../adapter/types"
import { ACP_REPLAYS, ADAPTER_FIXTURES as ADAPTER, acpScenario, CODEX_THREAD, codexScript, codexThread, type Json, withCwd } from "./agent-fixtures"

const CODEX_SPEC = BUILTIN_AGENTS.find((entry) => entry.spec.id === "codex")!.spec
const GROK_SPEC = BUILTIN_AGENTS.find((entry) => entry.spec.id === "grok")!.spec
const COPILOT_SPEC = BUILTIN_AGENTS.find((entry) => entry.spec.id === "copilot")!.spec
const DAY = 86_400_000

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "rudder-handoff-src-"))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function codex(script: string, holders: (ids: string[], own: number) => Map<string, number[]> = () => new Map()) {
  const dir = tempRoot()
  const log = join(dir, "log.jsonl")
  let own = 0
  const adapter: AgentAdapter = createCodexAdapter({
    spec: CODEX_SPEC,
    command: [process.execPath, join(ADAPTER, "codex", "fake-app-server.ts"), script, log],
    lockHolders: async (ids) => {
      own = adapter.processes?.()[0]?.pid ?? 0
      return holders(ids, own)
    },
  })
  cleanup.push(async () => {
    await adapter.dispose?.()
  })
  const sent = (method: string) =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Json)
          .filter((entry) => entry.msg?.method === method)
          .map((entry) => entry.msg.params as Json)
      : []
  return { adapter, sent }
}

describe("Codex history mapping", () => {
  test("items map the way the live turn maps them, plus the user's own messages", () => {
    const threadId = CODEX_THREAD.thread.id as string
    const entries = CODEX_THREAD.items.flatMap((entry) => codexHistoryEntries(threadId, entry.item))
    const id = (item: string) => `codex:${threadId}:${item}`
    expect(entries.map((entry) => entry.type)).toEqual(["user", "reasoning", "text", "tool", "tool", "tool", "text", "user", "tool", "compaction", "text"])
    expect(entries[0]).toEqual({ type: "user", id: id("01a1867f-a3e7-7281-8eed-be7384adec08"), text: "USER asks one", at: 1793257874408 })
    expect(entries[1]).toMatchObject({ type: "reasoning", text: "THOUGHT summary", done: true, startedAt: 1793257876900, at: 1793257877000 })
    expect(entries[2]).toMatchObject({ type: "text", id: id("msg_0ec0dbc145d1cde3016ae34418"), text: "REPLY commentary", phase: "commentary" })
    expect(entries[3]).toMatchObject({ type: "tool", tool: "Shell", status: "completed", detail: "cat README.md", output: "OUTPUT of the command\n", exitCode: 0 })
    expect(entries[4]).toMatchObject({ type: "tool", tool: "mem.session_start_context", output: "MCP RESULT", status: "completed" })
    expect(entries[5]).toMatchObject({ type: "tool", tool: "WebSearch", detail: "SEARCH query", status: "completed" })
    expect(entries[6]).toMatchObject({ type: "text", text: "REPLY final one", phase: "final" })
    expect(entries[8]).toMatchObject({ type: "tool", tool: "Edit", diffs: [{ path: "/tmp/ws/a.txt", patch: "@@ -1 +1 @@\n-old\n+new\n" }] })
    expect(entries[9]).toMatchObject({ type: "compaction", id: id("compact-c1"), state: "done" })
  })
})

describe("Codex listExternal / readExternal", () => {
  test("lists interactive threads newest first, without Rudder's own, gone folders, old ones; marks loaded elsewhere", async () => {
    const root = tempRoot()
    const cwd = join(root, "proj")
    mkdirSync(cwd)
    const now = Date.now()
    const at = (ms: number) => Math.floor(ms / 1000)
    const page1 = [
      codexThread({ id: "thr-a", cwd, updatedAt: at(now - 1000), name: "Named A", preview: "first A" }),
      codexThread({ id: "thr-rudder", cwd, updatedAt: at(now - 2000), originator: "rudder" }),
      codexThread({ id: "thr-gone", cwd: join(root, "removed"), updatedAt: at(now - 3000) }),
      codexThread({ id: "thr-busy", cwd, updatedAt: at(now - 4000), preview: "busy preview" }),
      codexThread({ id: "thr-ours", cwd, updatedAt: at(now - 5000), preview: "" }),
    ]
    const page2 = [codexThread({ id: "thr-old", cwd, updatedAt: at(now - 20 * DAY) })]
    const script = codexScript(root, [
      { expect: "thread/list", result: { data: page1, nextCursor: "p2", backwardsCursor: null } },
      { expect: "thread/list", result: { data: page2, nextCursor: "p3", backwardsCursor: null } },
    ])
    const { adapter, sent } = codex(script, (ids, own) => new Map([["thr-busy", [99_999]], ["thr-ours", [own]], ["thr-a", []]].filter(([id]) => ids.includes(id as string)) as [string, number[]][]))
    const found = await adapter.listExternal!({ since: now - 14 * DAY, limit: 50 })
    expect(found.map((entry) => entry.nativeId)).toEqual(["thr-a", "thr-busy", "thr-ours"])
    expect(found[0]).toMatchObject({ title: "Named A", cwd, preview: "first A", updatedAt: at(now - 1000) * 1000 })
    expect(found[0]!.inUse).toBeUndefined()
    expect(found[1]).toMatchObject({ title: "busy preview", inUse: true })
    expect(found[2]!.inUse).toBeUndefined()
    const lists = sent("thread/list")
    expect(lists[0]).toMatchObject({ sourceKinds: ["cli", "vscode"], sortKey: "updated_at" })
    expect(lists[1]).toMatchObject({ cursor: "p2" })
    // The second page reached past the window: no third request.
    expect(lists).toHaveLength(2)
  })

  test("readExternal pages thread/items/list across the whole thread", async () => {
    const root = tempRoot()
    const threadId = CODEX_THREAD.thread.id as string
    const script = codexScript(root, [
      { expect: "thread/items/list", result: { data: CODEX_THREAD.items.slice(0, 8), nextCursor: "c1", backwardsCursor: null } },
      { expect: "thread/items/list", result: { data: CODEX_THREAD.items.slice(8), nextCursor: null, backwardsCursor: null } },
    ])
    const { adapter, sent } = codex(script)
    const entries = await adapter.readExternal!(threadId, "/tmp/ws")
    expect(entries.filter((entry) => entry.type === "user").map((entry) => (entry as { text: string }).text)).toEqual(["USER asks one", "USER asks two"])
    expect(entries).toHaveLength(11)
    const reads = sent("thread/items/list")
    expect(reads[0]).toMatchObject({ threadId })
    expect(reads[0]!.turnId).toBeUndefined()
    expect(reads[1]).toMatchObject({ threadId, cursor: "c1" })
    // Reading never loads the thread into this process.
    expect(sent("thread/resume")).toEqual([])
  })

  test("readExternal refuses a thread another process opened since the list", async () => {
    const root = tempRoot()
    const { adapter, sent } = codex(codexScript(root, []), (ids) => new Map(ids.map((id) => [id, [99_999]])))
    const error = await adapter.readExternal!("thr-x", "/tmp/ws").catch((caught: unknown) => caught)
    expect((error as { code?: string }).code).toBe("in_use")
    expect(sent("thread/items/list")).toEqual([])
  })
})

function acp(spec: typeof GROK_SPEC, scenario: string) {
  const log = join(tempRoot(), "acp.jsonl")
  const adapter = createAcpAdapter({ spec, command: [process.execPath, join(ADAPTER, "acp", "fake-agent.ts"), scenario, log] })
  cleanup.push(async () => {
    await adapter.dispose?.()
  })
  const received = (method: string) =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Json)
          .filter((message) => message.method === method)
      : []
  return { adapter, received }
}

describe("ACP listExternal / readExternal", () => {
  test("Grok: session/list pages, gone folders and old sessions left out", async () => {
    const root = tempRoot()
    const cwd = join(root, "proj")
    mkdirSync(cwd)
    const now = Date.now()
    const iso = (ms: number) => new Date(ms).toISOString()
    const base = withCwd(ACP_REPLAYS.grok.session, cwd)
    const scenario = acpScenario(root, "grok", {
      listPages: [
        [
          { ...base, sessionId: "g-1", updatedAt: iso(now - 1000) },
          { ...base, sessionId: "g-gone", cwd: join(root, "gone"), updatedAt: iso(now - 2000) },
        ],
        [
          { ...base, sessionId: "g-2", title: null, updatedAt: iso(now - 3000) },
          { ...base, sessionId: "g-old", updatedAt: iso(now - 30 * DAY) },
        ],
      ],
    })
    const { adapter, received } = acp(GROK_SPEC, scenario)
    const found = await adapter.listExternal!({ since: now - 14 * DAY, limit: 50 })
    expect(found.map((entry) => entry.nativeId)).toEqual(["g-1", "g-2"])
    expect(found[0]).toMatchObject({ title: base.title, cwd, updatedAt: now - 1000 })
    expect(found[1]!.title).toBe("")
    expect(received("session/list").map((message) => message.params.cursor ?? null)).toEqual([null, "page-1"])
    expect(received("session/new")).toEqual([])
  })

  test("an agent without session/list or loadSession says no_session_list", async () => {
    const root = tempRoot()
    const scenario = acpScenario(root, "grok", {})
    const raw = JSON.parse(readFileSync(scenario, "utf8")) as Json
    raw.initialize.agentCapabilities.sessionCapabilities = { resume: {} }
    writeFileSync(scenario, JSON.stringify(raw))
    const { adapter } = acp(GROK_SPEC, scenario)
    const error = await adapter.listExternal!({ since: 0, limit: 50 }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(HandoffUnsupported)
    expect((error as HandoffUnsupported).reason).toBe("no_session_list")
  })

  test("a missing command says not_installed", async () => {
    const adapter = createAcpAdapter({ spec: GROK_SPEC, command: ["rudder-no-such-agent-binary"] })
    cleanup.push(async () => {
      await adapter.dispose?.()
    })
    const error = await adapter.listExternal!({ since: 0, limit: 50 }).catch((caught: unknown) => caught)
    expect((error as HandoffUnsupported).reason).toBe("not_installed")
  })

  test("Grok: session/load's replay becomes history; the session is closed after", async () => {
    const root = tempRoot()
    const cwd = join(root, "proj")
    mkdirSync(cwd)
    const replay = withCwd(ACP_REPLAYS.grok.replay, cwd)
    const scenario = acpScenario(root, "grok", { loadReplayFrames: replay })
    const { adapter, received } = acp(GROK_SPEC, scenario)
    const entries = await adapter.readExternal!("g-1", cwd)
    expect(received("session/load")[0].params).toMatchObject({ sessionId: "g-1", cwd })
    expect(received("session/close").map((message) => message.params.sessionId)).toEqual(["g-1"])
    const kinds = entries.map((entry) => entry.type)
    expect(kinds[0]).toBe("user")
    expect((entries[0] as { text: string }).text).toContain("order_pizza")
    expect(kinds.filter((kind) => kind === "tool")).toHaveLength(3)
    expect(kinds).toContain("reasoning")
    const reply = entries.filter((entry): entry is Extract<HistoryEntry, { type: "text" }> => entry.type === "text").at(-1)!
    expect(reply.text).toContain("probe__order_pizza")
    // Deterministic ids: importing the same replay twice gives the same rows.
    const again = await adapter.readExternal!("g-1", cwd)
    expect(again.map((entry) => entry.id)).toEqual(entries.map((entry) => entry.id))
    expect(entries[0]!.id).toBe("grok:g-1:0")
    // Grok stamps each frame: rows keep the agent's own time.
    expect(entries[0]!.at).toBeGreaterThan(1_700_000_000_000)
    for (const entry of entries) if (entry.type === "tool") expect(entry.status).toBe("completed")
  })

  test("Copilot: chunks merge per message, Info lines drop, a tool left open ends cancelled", async () => {
    const root = tempRoot()
    const cwd = join(root, "proj")
    mkdirSync(cwd)
    const scenario = acpScenario(root, "copilot", { loadReplay: [], loadReplayFrames: withCwd(ACP_REPLAYS.copilot.replay, cwd) })
    const { adapter } = acp(COPILOT_SPEC, scenario)
    const entries = await adapter.readExternal!("c-1", cwd)
    const brief = entries.map((entry) => (entry.type === "tool" ? `tool:${entry.title}:${entry.status}` : `${entry.type}:${(entry as { text: string }).text}`))
    expect(brief).toEqual([
      "user:USER hello",
      "text:REPLY part one, part two.",
      "user:USER make a file",
      "tool:Create rudder.txt:completed",
      "tool:Still running:cancelled",
      "text:REPLY made it.",
    ])
  })
})
