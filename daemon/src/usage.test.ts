import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import type { AdapterRegistry } from "./adapter"
import { FAKE_SPEC } from "./adapter/fake"
import type { AgentAdapter, TurnUsage } from "./adapter/types"
import type { Frame } from "./protocol"
import { SessionService } from "./session-service"
import { Store, type UsageEventRow } from "./store"

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

function scripted(id: string, label: string, reply: AgentAdapter["reply"]): AgentAdapter {
  return { spec: { ...FAKE_SPEC, id, label }, reply }
}

function registryOf(...adapters: AgentAdapter[]): AdapterRegistry {
  return { get: (id) => adapters.find((adapter) => adapter.spec.id === id), list: () => adapters }
}

function harness(adapters: AdapterRegistry, store = new Store(":memory:"), hooks: ConstructorParameters<typeof SessionService>[3] = {}) {
  const events: Frame[] = []
  const service = new SessionService(store, adapters, (frame) => events.push(frame), hooks)
  const idles = (sessionId: string) =>
    events.filter((event) => {
      const payload = (event.payload ?? {}) as Record<string, unknown>
      return event.name === "agent.status" && payload.sessionId === sessionId && payload.status === "idle"
    }).length
  return {
    store,
    service,
    async call(method: string, params: Record<string, unknown> = {}) {
      return service.invoke(method, params, crypto.randomUUID())
    },
    async create(params: Record<string, unknown>) {
      const created = await service.invoke("session.create", params, crypto.randomUUID())
      if (created.type !== "result") throw new Error(created.error?.message)
      return (created.result as { session: { id: string } }).session.id
    },
    async turn(sessionId: string, text: string) {
      const before = idles(sessionId)
      const sent = await service.invoke("message.send", { sessionId, text }, crypto.randomUUID())
      if (sent.type !== "result") throw new Error(sent.error?.message)
      const started = Date.now()
      while (idles(sessionId) <= before) {
        if (Date.now() - started > 2000) throw new Error("turn timed out")
        await Bun.sleep(5)
      }
    },
    events(sessionId?: string): UsageEventRow[] {
      const rows = store.db.query("SELECT * FROM usage_events ORDER BY created_at, rowid").all() as UsageEventRow[]
      return sessionId ? rows.filter((row) => row.session_id === sessionId) : rows
    },
  }
}

// Each prompt is a JSON list of usage events for that turn.
function usageAgent(id = "claude", label = "Claude Code") {
  return scripted(id, label, async (text, ctx) => {
    for (const usage of JSON.parse(text) as TurnUsage[]) ctx.emit({ type: "usage", usage })
  })
}

type Seed = { session: string; agent: string; model?: string; at: number; usage: TurnUsage; turn?: string }

function seed(store: Store, rows: Seed[]) {
  const sessions = new Map<string, string>()
  for (const row of rows) {
    let id = sessions.get(row.session)
    if (!id) {
      id = store.createSession({ title: row.session, agent: row.agent, model: row.model }).id
      sessions.set(row.session, id)
    }
    store.recordUsage(id, { turnId: row.turn ?? crypto.randomUUID(), agent: row.agent, model: row.model ?? "" }, row.usage, row.at)
  }
  return sessions
}

describe("usage events", () => {
  test("each turn writes one row with the session's agent, model and title", async () => {
    const h = harness(registryOf(usageAgent()))
    const id = await h.create({ agent: "claude", model: "opus", title: "Fix login" })
    await h.turn(id, JSON.stringify([{ inputTokens: 10, outputTokens: 5, cacheReadTokens: 7, cacheWriteTokens: 3, reasoningTokens: 2, costUsd: 0.25, contextUsed: 100, contextSize: 1000 }]))
    await h.turn(id, JSON.stringify([{ inputTokens: 1, outputTokens: 1, costUsd: 0.5 }]))
    const rows = h.events(id)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      session_title: "Fix login",
      agent: "claude",
      model: "opus",
      input_tokens: 10,
      output_tokens: 5,
      cache_read_tokens: 7,
      cache_write_tokens: 3,
      reasoning_tokens: 2,
      cost_usd: 0.25,
      context_used: 100,
      context_size: 1000,
    })
    expect(rows[1]).toMatchObject({ input_tokens: 1, cost_usd: 0.5, context_used: null, context_size: null })
    expect(rows[0]!.turn_id).not.toBe(rows[1]!.turn_id)
    // The session's running total is unchanged by the new table.
    expect(h.store.getSession(id)!.usage).toBe(JSON.stringify({ inputTokens: 11, outputTokens: 6, cacheReadTokens: 7, cacheWriteTokens: 3, reasoningTokens: 2, costUsd: 0.75, contextUsed: 100, contextSize: 1000 }))
  })

  test("two usage events in one turn merge into that turn's row", async () => {
    const h = harness(registryOf(usageAgent()))
    const id = await h.create({ agent: "claude" })
    await h.turn(id, JSON.stringify([
      { inputTokens: 10, outputTokens: 5, contextUsed: 100, contextSize: 1000 },
      { inputTokens: 4, costUsd: 0.1, contextUsed: 150 },
    ]))
    const rows = h.events(id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ model: "", input_tokens: 14, output_tokens: 5, cost_usd: 0.1, context_used: 150, context_size: 1000 })
  })

  test("a missing cost is NULL, a reported zero stays 0", async () => {
    const h = harness(registryOf(usageAgent()))
    const id = await h.create({ agent: "claude" })
    await h.turn(id, JSON.stringify([{ inputTokens: 1 }]))
    await h.turn(id, JSON.stringify([{ inputTokens: 1, costUsd: 0 }]))
    await h.turn(id, JSON.stringify([{ inputTokens: 1 }, { outputTokens: 1 }]))
    expect(h.events(id).map((row) => row.cost_usd)).toEqual([null, 0, null])
  })

  test("deleting a session keeps its usage rows and title snapshot", async () => {
    const h = harness(registryOf(usageAgent()))
    const id = await h.create({ agent: "claude", title: "Gone soon" })
    await h.turn(id, JSON.stringify([{ inputTokens: 9, costUsd: 0.2 }]))
    const deleted = await h.call("session.delete", { id })
    expect(deleted.type).toBe("result")
    expect(h.store.getSession(id)).toBeNull()
    expect(h.events(id)).toHaveLength(1)
    expect(h.events(id)[0]).toMatchObject({ session_title: "Gone soon", input_tokens: 9 })
    const summary = await h.call("usage.summary", {})
    expect((summary.result as { totals: { inputTokens: number; sessions: number } }).totals).toMatchObject({ inputTokens: 9, sessions: 1 })
  })
})

describe("usage.summary", () => {
  // 2026-10-21 23:30 and 2026-10-22 00:30 in UTC+8 are both 2026-10-21 in UTC.
  const BEFORE_MIDNIGHT = Date.UTC(2026, 9, 21, 15, 30)
  const AFTER_MIDNIGHT = Date.UTC(2026, 9, 21, 16, 30)

  function fixture() {
    const h = harness(registryOf(usageAgent("claude", "Claude Code"), usageAgent("grok", "Grok")))
    seed(h.store, [
      { session: "a", agent: "claude", model: "opus", at: BEFORE_MIDNIGHT, usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 50, costUsd: 0.5 } },
      { session: "a", agent: "claude", model: "opus", at: AFTER_MIDNIGHT, usage: { inputTokens: 200, outputTokens: 20, cacheWriteTokens: 5, costUsd: 1 } },
      { session: "b", agent: "claude", model: "sonnet", at: AFTER_MIDNIGHT, usage: { inputTokens: 10, outputTokens: 1 } },
      { session: "c", agent: "grok", at: AFTER_MIDNIGHT + HOUR, usage: { inputTokens: 1000, outputTokens: 100, reasoningTokens: 30 } },
    ])
    return h
  }

  type Summary = {
    machine: { name: string }
    generatedAt: number
    range: { from: number | null; to: number | null }
    totals: Record<string, unknown>
    byDay: Array<Record<string, unknown>>
    byAgent: Array<Record<string, unknown>>
    byModel: Array<Record<string, unknown>>
  }

  async function summary(h: ReturnType<typeof harness>, params: Record<string, unknown> = {}) {
    const frame = await h.call("usage.summary", params)
    if (frame.type !== "result") throw new Error(frame.error?.message)
    return frame.result as Summary
  }

  test("days split at the phone's local midnight", async () => {
    const h = fixture()
    const utc = await summary(h)
    expect(utc.byDay.map((day) => [day.day, day.turns])).toEqual([["2026-10-21", 4]])
    const beijing = await summary(h, { tz: 480 })
    expect(beijing.byDay.map((day) => [day.day, day.turns])).toEqual([["2026-10-21", 1], ["2026-10-22", 3]])
    expect(beijing.byDay[1]).toMatchObject({ inputTokens: 1210, costUsd: 1, costPartial: true, sessions: 3 })
    // UTC-16:30 would put the first row on 2026-10-20, but offsets stop at ±14 h.
    const samoa = await summary(h, { tz: -660 })
    expect(samoa.byDay.map((day) => [day.day, day.turns])).toEqual([["2026-10-21", 4]])
  })

  test("totals, byAgent and byModel add up; cost sums only what was reported", async () => {
    const h = fixture()
    const result = await summary(h)
    expect(result.totals).toEqual({
      inputTokens: 1310,
      outputTokens: 131,
      cacheReadTokens: 50,
      cacheWriteTokens: 5,
      reasoningTokens: 30,
      costUsd: 1.5,
      costPartial: true,
      turns: 4,
      sessions: 3,
    })
    expect(result.byAgent).toEqual([
      { agent: "grok", label: "Grok", inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 30, costUsd: null, costPartial: false, turns: 1, sessions: 1 },
      { agent: "claude", label: "Claude Code", inputTokens: 310, outputTokens: 31, cacheReadTokens: 50, cacheWriteTokens: 5, reasoningTokens: 0, costUsd: 1.5, costPartial: true, turns: 3, sessions: 2 },
    ])
    expect(result.byModel.map((row) => [row.agent, row.model, row.inputTokens, row.costUsd, row.costPartial])).toEqual([
      ["grok", "", 1000, null, false],
      ["claude", "opus", 300, 1.5, false],
      ["claude", "sonnet", 10, null, false],
    ])
    expect(result.machine).toEqual({ name: expect.any(String) })
    expect(result.range).toEqual({ from: null, to: null })
  })

  test("from is inclusive, to exclusive; bucket none drops byDay", async () => {
    const h = fixture()
    const result = await summary(h, { from: AFTER_MIDNIGHT, to: AFTER_MIDNIGHT + HOUR, bucket: "none" })
    expect(result.range).toEqual({ from: AFTER_MIDNIGHT, to: AFTER_MIDNIGHT + HOUR })
    expect(result.byDay).toEqual([])
    expect(result.totals).toMatchObject({ inputTokens: 210, turns: 2, sessions: 2, costUsd: 1, costPartial: true })
  })

  test("an empty range returns zero totals and empty groups", async () => {
    const h = fixture()
    const result = await summary(h, { from: AFTER_MIDNIGHT + DAY })
    expect(result.totals).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      costUsd: null,
      costPartial: false,
      turns: 0,
      sessions: 0,
    })
    expect(result.byDay).toEqual([])
    expect(result.byAgent).toEqual([])
    expect(result.byModel).toEqual([])
  })

  test("bad params are invalid", async () => {
    const h = fixture()
    for (const params of [
      { from: 10, to: 5 },
      { from: "yesterday" },
      { to: Number.NaN },
      { bucket: "week" },
      { tz: 841 },
      { tz: -841 },
      { tz: 30.5 },
    ]) {
      const frame = await h.call("usage.summary", params)
      expect(frame.type).toBe("error")
      expect(frame.error?.code).toBe("invalid")
    }
    expect((await h.call("usage.summary", { tz: 840, from: 5, to: 5 })).type).toBe("result")
  })

  // 2,000 sessions of 25 turns each; a session's turns fall within two hours, about 20 sessions a day.
  test("50k rows summarise in under 50 ms", () => {
    const store = new Store(":memory:")
    const insert = store.db.query(
      `INSERT INTO usage_events(id, session_id, session_title, agent, model, turn_id, created_at,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, cost_usd)
       VALUES (?, ?, 't', ?, ?, ?, ?, 100, 10, 50, 5, 1, ?)`,
    )
    const agents = ["claude", "codex", "grok", "copilot"]
    const start = Date.UTC(2026, 6, 1)
    store.transaction(() => {
      for (let i = 0; i < 50_000; i++) {
        const session = Math.floor(i / 25)
        const agent = agents[session % agents.length]!
        const at = start + session * 72 * 60_000 + (i % 25) * 4 * 60_000
        insert.run(crypto.randomUUID(), `00000000-0000-4000-8000-${String(session).padStart(12, "0")}`, agent, `${agent}-m${session % 3}`, crypto.randomUUID(), at, agent === "grok" ? null : 0.01)
      }
    })
    const query = { bucket: "day" as const, tz: 480 }
    const t0 = performance.now()
    const result = store.usageSummary(query)
    const first = performance.now() - t0
    const t1 = performance.now()
    store.usageSummary({ ...query, from: start + 30 * DAY })
    const ranged = performance.now() - t1
    console.log(`usage.summary 50k rows: ${first.toFixed(1)} ms all, ${ranged.toFixed(1)} ms from day 30`)
    expect(result.totals).toMatchObject({ inputTokens: 5_000_000, turns: 50_000, costPartial: true })
    expect(result.byDay.length).toBe(101)
    expect(result.byModel).toHaveLength(12)
    // Shared CI runners are several times slower than a Mac and share their cores; the 50 ms budget is for a Mac.
    expect(first).toBeLessThan(process.env.CI ? 250 : 50)
  })

  // perf-1112 round two (R6): the stats page re-read every event on each visit, 25 ms at 50k rows on a Mac.
  test("the same range is answered from memory until a usage event is written", () => {
    const store = new Store(":memory:")
    const session = store.createSession({ agent: "claude" })
    const query = { bucket: "day" as const, tz: 480 }
    const reads: string[] = []
    const query0 = store.db.query.bind(store.db)
    store.db.query = ((sql: string) => {
      if (sql.includes("FROM usage_events")) reads.push(sql)
      return query0(sql)
    }) as typeof store.db.query
    store.recordUsage(session.id, { turnId: "t1", agent: "claude", model: "m" }, { inputTokens: 10 })
    const first = store.usageSummary(query)
    for (let i = 0; i < 5; i++) expect(store.usageSummary(query)).toBe(first)
    expect(reads).toHaveLength(1)
    store.usageSummary({ ...query, from: 0 })
    expect(reads).toHaveLength(2)
    store.recordUsage(session.id, { turnId: "t2", agent: "claude", model: "m" }, { inputTokens: 5 })
    expect(store.usageSummary(query).totals.inputTokens).toBe(15)
    expect(reads).toHaveLength(3)
  })
})

describe("usage limits", () => {
  const quota = { plan: "plus", windows: [{ minutes: 300, usedPercent: 34, resetsAt: 1_793_400_000_000 }], updatedAt: 1 }

  test("usage.summary and usage.limits carry each reporting agent's limits; failures and hangs are left out", async () => {
    const codex: AgentAdapter = { ...scripted("codex", "Codex", async () => {}), limits: async () => quota }
    const claude: AgentAdapter = { ...scripted("claude", "Claude Code", async () => {}), limits: async () => ({ windows: [], updatedAt: 2 }) }
    const broken: AgentAdapter = {
      ...scripted("pi", "pi", async () => {}),
      limits: async () => {
        throw new Error("boom")
      },
    }
    const silent: AgentAdapter = { ...scripted("grok", "Grok", async () => {}), limits: async () => undefined }
    const h = harness(registryOf(codex, claude, broken, silent))
    const expected = [
      { agent: "codex", label: "Codex", ...quota },
      { agent: "claude", label: "Claude Code", windows: [], updatedAt: 2 },
    ]
    const summary = await h.call("usage.summary", {})
    expect(summary.type).toBe("result")
    expect((summary.result as { limits: unknown }).limits).toEqual(expected)
    const limits = await h.call("usage.limits", {})
    expect((limits.result as { limits: unknown }).limits).toEqual(expected)
  })
})

// Owner 2026-11-18: the stats page showed Codex and Grok but no Claude. Claude's first read after a rudderd restart
// starts a CLI (2–6 s, longer on a busy Mac) and a read over the limit dropped the agent from the answer.
describe("usage limits that answer late", () => {
  const read = (percent: number, at: number) => ({ plan: "max", windows: [{ kind: "five_hour", minutes: 300, usedPercent: percent }], updatedAt: at })

  test("a read past the limit answers with the last numbers", async () => {
    let next: () => Promise<ReturnType<typeof read> | undefined> = async () => read(11, 1)
    const claude: AgentAdapter = { ...scripted("claude", "Claude Code", async () => {}), limits: () => next() }
    const h = harness(registryOf(claude), new Store(":memory:"), { quotaTimeoutMs: 20 })
    const first = await h.call("usage.limits", {})
    expect((first.result as { limits: unknown }).limits).toEqual([{ agent: "claude", label: "Claude Code", ...read(11, 1) }])
    next = () => new Promise((resolve) => setTimeout(() => resolve(read(12, 2)), 200))
    const late = await h.call("usage.limits", {})
    expect((late.result as { limits: unknown }).limits).toEqual([{ agent: "claude", label: "Claude Code", ...read(11, 1) }])
    next = async () => {
      throw new Error("boom")
    }
    const failed = await h.call("usage.summary", {})
    expect((failed.result as { limits: unknown }).limits).toEqual([{ agent: "claude", label: "Claude Code", ...read(11, 1) }])
  })

  test("an agent that reports nothing is dropped, not kept from before", async () => {
    let next: ReturnType<typeof read> | undefined = read(11, 1)
    const claude: AgentAdapter = { ...scripted("claude", "Claude Code", async () => {}), limits: async () => next }
    const h = harness(registryOf(claude), new Store(":memory:"), { quotaTimeoutMs: 20 })
    await h.call("usage.limits", {})
    next = undefined
    const now = await h.call("usage.limits", {})
    expect((now.result as { limits: unknown }).limits).toEqual([])
  })

  test("warmQuota reads every agent once so the first ask has numbers", async () => {
    let reads = 0
    const claude: AgentAdapter = {
      ...scripted("claude", "Claude Code", async () => {}),
      limits: () => {
        reads += 1
        return reads === 1 ? new Promise((resolve) => setTimeout(() => resolve(read(11, 1)), 60)) : new Promise(() => {})
      },
    }
    const h = harness(registryOf(claude), new Store(":memory:"), { quotaTimeoutMs: 20 })
    await h.service.warmQuota()
    const first = await h.call("usage.limits", {})
    expect((first.result as { limits: unknown }).limits).toEqual([{ agent: "claude", label: "Claude Code", ...read(11, 1) }])
  })
})

describe("usage backfill", () => {
  test("an install without usage_events gets one row per session with usage, once", () => {
    const dir = mkdtempSync(join(tmpdir(), "rudder-usage-"))
    try {
      const path = join(dir, "rudder.sqlite")
      const old = new Store(path)
      const used = old.createSession({ title: "Old work", agent: "codex", model: "gpt-5" })
      const empty = old.createSession({ title: "Nothing yet" })
      old.patchSession(used.id, { usage: { inputTokens: 500, outputTokens: 50, costUsd: 0.75, contextUsed: 10, contextSize: 100 } })
      old.db.query("UPDATE sessions SET updated_at = 1700000000000 WHERE id = ?").run(used.id)
      old.db.query("UPDATE sessions SET usage = '{}' WHERE id = ?").run(empty.id)
      // Simulate the schema before this table existed.
      old.db.exec("DROP TABLE usage_events")
      old.db.close()

      const upgraded = new Store(path)
      const rows = upgraded.db.query("SELECT * FROM usage_events").all() as UsageEventRow[]
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        session_id: used.id,
        session_title: "Old work",
        agent: "codex",
        model: "gpt-5",
        turn_id: "backfill",
        created_at: 1700000000000,
        input_tokens: 500,
        output_tokens: 50,
        cache_read_tokens: 0,
        cost_usd: 0.75,
        context_used: 10,
        context_size: 100,
      })
      const summary = upgraded.usageSummary({ bucket: "day", tz: 0 })
      // A backfilled row carries totals, not a turn count.
      expect(summary.totals).toMatchObject({ inputTokens: 500, turns: 0, sessions: 1 })
      upgraded.db.close()

      const again = new Store(path)
      expect((again.db.query("SELECT COUNT(*) AS n FROM usage_events").get() as { n: number }).n).toBe(1)
      again.db.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
