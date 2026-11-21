import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFakeAdapter } from "./adapter/fake"
import type { Frame } from "./protocol"
import { fold, matchRanges, normalizeQuery, searchMessages, searchPaged } from "./message-search"
import { SessionService } from "./session-service"
import { phoneCopy } from "./phone-copy"
import { NOTICE_PAYLOAD, type MessageRow, Store } from "./store"

function row(seq: number, kind: string, role: string, text: string, payload: string | null = null): MessageRow {
  return { id: `m${seq}`, session_id: "s", seq, kind, role, text, payload, created_at: seq }
}

function payload(frame: Frame): Record<string, unknown> {
  return (frame.payload ?? {}) as Record<string, unknown>
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out")
    await Bun.sleep(10)
  }
}

describe("message search matching", () => {
  test("ignores case and full / half width, and maps ranges back to the original text", () => {
    expect(matchRanges("Add a session CACHE; the cache warms", normalizeQuery("cache"))).toEqual([
      [14, 5],
      [25, 5],
    ])
    expect(matchRanges("加一层会话缓存，缓存满了", normalizeQuery("缓存"))).toEqual([
      [5, 2],
      [8, 2],
    ])
    expect(matchRanges("ＣＡＣＨＥ hit", normalizeQuery("cache"))).toEqual([[0, 5]])
    expect(matchRanges("aaaa", "aa")).toEqual([
      [0, 2],
      [2, 2],
    ])
    expect(matchRanges("anything", "")).toEqual([])
  })

  test("maps offsets back through text NFKC lengthens or shortens", () => {
    // Already folded whole: no map.
    expect(fold("plain ascii and 中文").origin).toBeNull()
    // ﬁ (one unit) folds to "fi" (two): both point back at it.
    expect(fold("ﬁle")).toEqual({ folded: "file", origin: [0, 0, 1, 2, 3] })
    expect(matchRanges("the ﬁle", normalizeQuery("file"))).toEqual([[4, 3]])
    expect(matchRanges("the ﬁle", normalizeQuery("le"))).toEqual([[5, 2]])
    // ㎏ (one unit) folds to "kg"; full-width letters fold one to one.
    expect(matchRanges("5㎏ and ５ＫＧ", normalizeQuery("kg"))).toEqual([
      [1, 1],
      [8, 2],
    ])
    // A surrogate pair (two units) folds to one letter: 𝐀 is U+1D400.
    expect(matchRanges("x𝐀𝐁y", normalizeQuery("ab"))).toEqual([[1, 4]])
    expect(matchRanges("缓存ＣＡＣＨＥ命中，cache", normalizeQuery("Cache"))).toEqual([
      [2, 5],
      [10, 5],
    ])
    // İ lower-cases to two units; the match after it stays on the original offsets.
    expect(matchRanges("İ cache", normalizeQuery("cache"))).toEqual([[2, 5]])
    // Σ is folded per letter, as before (σ, never the word-final ς).
    expect(matchRanges("ΟΔΟΣ", "οδοσ")).toEqual([[0, 4]])
  })

  test("searches bodies and tool cards, never thinking or notices, oldest first", () => {
    const tool = JSON.stringify({ id: "t", tool: "Edit", title: "daemon/src/cache.ts", detail: "daemon/src/cache.ts\n+48", status: "completed" })
    const rows = [
      row(1, "text", "user", "add a cache"),
      row(2, "reasoning", "assistant", "the cache should be an LRU"),
      row(3, "tool", "assistant", "", tool),
      row(4, "text", "assistant", "cache restored", NOTICE_PAYLOAD),
      row(5, "text", "assistant", "no match here"),
      row(6, "text", "assistant", "Cache, cache"),
    ]
    const { hits, truncated } = searchMessages(rows, "  CACHE ", 10)
    expect(truncated).toBe(false)
    expect(hits.map((hit) => [hit.id, hit.field, hit.count])).toEqual([
      ["m1", "text", 1],
      ["m3", "tool", 2],
      ["m6", "text", 2],
    ])
    expect(searchMessages(rows, "cache", 2)).toMatchObject({ truncated: true, hits: [{ id: "m1" }, { id: "m3" }] })
    expect(searchMessages(rows, "   ", 10).hits).toEqual([])
  })
})

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "rudder-search-"))
  const store = new Store(":memory:")
  const events: Frame[] = []
  // The turn re-checks its folder against the workspace root, so the temp folder is the root here.
  const service = new SessionService(store, createFakeAdapter(), (frame) => events.push(frame), { workspaceRoot: dir })
  return { dir, store, events, service }
}

describe("message.search", () => {
  test("a single long Unicode row lets other requests run without losing match ranges", async () => {
    const text = `${"Ａ".repeat(65_535)}ＣａＣｈｅ`
    const source = row(1, "text", "assistant", text)
    let otherRequestRan = false
    const otherRequest = new Promise<void>((resolve) => {
      setImmediate(() => {
        otherRequestRan = true
        resolve()
      })
    })
    const result = await searchPaged((after) => (after === 0 ? [source] : []), "cache", 10)
    const searchYielded = otherRequestRan
    await otherRequest
    expect(searchYielded).toBe(true)
    expect(result.hits).toMatchObject([{ id: "m1", count: 1, ranges: [[65_535, 5]] }])
  })

  test("finds matches across the whole history, below beforeSeq when given", async () => {
    const h = harness()
    const id = h.store.createSession({ agent: "fake", cwd: h.dir }).id
    for (let index = 0; index < 120; index += 1) {
      h.store.insertMessage({
        id: `m${index}`,
        session_id: id,
        kind: "text",
        role: index % 2 ? "assistant" : "user",
        text: index % 10 === 0 ? `cache note ${index}` : `line ${index}`,
        created_at: index,
      })
    }
    const all = await h.service.invoke("message.search", { sessionId: id, query: "Cache" }, "s1")
    const result = all.result as { hits: Array<{ id: string; seq: number; count: number; ranges: number[][] }>; truncated: boolean }
    expect(result.hits.map((hit) => hit.id)).toEqual(["m0", "m10", "m20", "m30", "m40", "m50", "m60", "m70", "m80", "m90", "m100", "m110"])
    expect(result.hits[0]!.ranges).toEqual([[0, 5]])
    const older = await h.service.invoke("message.search", { sessionId: id, query: "cache", beforeSeq: result.hits[3]!.seq }, "s2")
    expect((older.result as { hits: unknown[] }).hits).toHaveLength(3)
    const capped = await h.service.invoke("message.search", { sessionId: id, query: "cache", limit: 2 }, "s3")
    expect(capped.result).toMatchObject({ truncated: true })
  })

  // Review 2026-11-11 (P3): the v88 resume notice carries a phone copy, so its payload is not NOTICE_PAYLOAD; it was
  // searched, and it became the completion push's reply.
  test("a notice with a phone copy is neither searched nor a reply", async () => {
    const h = harness()
    const id = h.store.createSession({ agent: "fake", cwd: h.dir }).id
    const stale = phoneCopy.staleResume()
    const add = (n: number, text: string, payload: string | null) =>
      h.store.insertMessage({ id: `m${n}`, session_id: id, kind: "text", role: "assistant", text, payload, created_at: n })
    add(1, "Claude 会话 reply", null)
    add(2, stale.text, JSON.stringify({ notice: true, copy: stale }))
    add(3, "Switched to Claude", JSON.stringify({ notice: true, agentSwitch: { from: {}, to: {} } }))
    const viaService = await h.service.invoke("message.search", { sessionId: id, query: "Claude" }, "s")
    expect((viaService.result as { hits: { id: string }[] }).hits.map((hit) => hit.id)).toEqual(["m1"])
    expect(searchMessages(h.store.messagesInPages(id), "Claude", 10).hits.map((hit) => hit.id)).toEqual(["m1"])
    expect(h.store.assistantTexts(id, undefined, 32).map((row) => row.text)).toEqual(["Claude 会话 reply"])
    expect(h.store.assistantTexts(id, 4, 32).map((row) => row.text)).toEqual(["Claude 会话 reply"])
  })

  test("the paged search finds what a whole read finds, however small the pages and however often it yields", async () => {
    const h = harness()
    const id = h.store.createSession({ agent: "fake", cwd: h.dir }).id
    const words = ["cache", "ＣＡＣＨＥ", "ﬁle cache", "nothing", "Cache it\nand cache"]
    for (let index = 0; index < 90; index += 1) {
      const kind = index % 9 === 4 ? "tool" : index % 11 === 5 ? "reasoning" : "text"
      const tool = { id: `t${index}`, tool: "Bash", title: `run ${words[index % 5]}`, detail: `cache --x ${index}\nsecond cache line`, status: "completed" }
      h.store.insertMessage({
        id: `m${index}`,
        session_id: id,
        kind,
        role: index % 3 === 0 ? "user" : "assistant",
        text: kind === "tool" ? "" : `${words[index % 5]} ${index}`,
        payload: kind === "tool" ? JSON.stringify(tool) : index % 13 === 0 ? NOTICE_PAYLOAD : null,
        created_at: index,
      })
    }
    const whole = searchMessages(h.store.messagesInPages(id), "cache", 2000)
    expect(whole.hits.length).toBeGreaterThan(40)
    expect(whole.hits.some((hit) => hit.field === "tool")).toBe(true)
    const viaService = await h.service.invoke("message.search", { sessionId: id, query: "cache" }, "w")
    expect(viaService.result).toEqual(whole)
    // Other work queued as macrotasks runs while it searches.
    let turns = 0
    let searching = true
    const tick = () => {
      turns += 1
      if (searching) setImmediate(tick)
    }
    setImmediate(tick)
    const page = (after: number, limit: number) => h.store.searchPage(id, after, Number.MAX_SAFE_INTEGER, limit)
    const tiny = await searchPaged(page, "cache", 2000, { budget: { rows: 1_000, chars: 1_000_000, pageRows: 3, yieldChars: 1 } })
    searching = false
    expect(tiny).toEqual(whole)
    expect(turns).toBeGreaterThan(10)
  })

  test("a scan budget cuts the search short and says where to go on", async () => {
    const h = harness()
    const id = h.store.createSession({ agent: "fake", cwd: h.dir }).id
    for (let index = 0; index < 30; index += 1) {
      h.store.insertMessage({
        id: `m${index}`,
        session_id: id,
        kind: "text",
        role: "assistant",
        text: index === 25 ? "the rare word" : `filler ${index}`,
        created_at: index,
      })
    }
    const page = (after: number, limit: number) => h.store.searchPage(id, after, Number.MAX_SAFE_INTEGER, limit)
    const budget = { rows: 10, chars: 1_000_000, pageRows: 4, yieldChars: 1_000_000 }
    const first = await searchPaged(page, "rare", 10, { budget })
    expect(first).toEqual({ hits: [], truncated: true, resumeAfterSeq: 10 })
    const second = await searchPaged(page, "rare", 10, { budget, afterSeq: first.resumeAfterSeq })
    expect(second).toEqual({ hits: [], truncated: true, resumeAfterSeq: 20 })
    const third = await searchPaged(page, "rare", 10, { budget, afterSeq: second.resumeAfterSeq })
    expect(third.truncated).toBe(false)
    expect(third.hits.map((hit) => hit.id)).toEqual(["m25"])
    // By characters too, and over the protocol: afterSeq goes on from resumeAfterSeq.
    const byChars = await searchPaged(page, "rare", 10, { budget: { ...budget, rows: 1_000, chars: 20 } })
    expect(byChars).toMatchObject({ truncated: true, resumeAfterSeq: 3 })
    const resumed = await h.service.invoke("message.search", { sessionId: id, query: "rare", afterSeq: 20 }, "r")
    expect(resumed.result).toEqual({ hits: [expect.objectContaining({ id: "m25", seq: 26 })], truncated: false })
    // The hit limit says where it stopped as well: after the last hit it returned.
    const capped = await searchPaged(page, "filler", 2, { budget })
    expect(capped).toMatchObject({ truncated: true, resumeAfterSeq: 2, hits: [{ seq: 1 }, { seq: 2 }] })
  })

  test("rejects a missing session and a bad query", async () => {
    const h = harness()
    const id = h.store.createSession({ agent: "fake", cwd: h.dir }).id
    expect((await h.service.invoke("message.search", { sessionId: "nope", query: "x" }, "a")).error?.code).toBe("not_found")
    expect((await h.service.invoke("message.search", { sessionId: id, query: 3 }, "b")).error?.code).toBe("invalid")
    expect((await h.service.invoke("message.search", { sessionId: id, query: "x".repeat(201) }, "c")).error?.code).toBe("invalid")
  })
})

describe("bounded search responses", () => {
  const pageOf = (rows: MessageRow[]) => (after: number, limit: number) => rows.filter(item => item.seq > after).slice(0, limit)

  test("denseMatchesKeepExactCountsWithinWireBudget", async () => {
    const rows = Array.from({ length: 50 }, (_, index) => row(index + 1, "text", "assistant", "a".repeat(65536)))
    const result = await searchPaged(pageOf(rows), "a", 500)
    expect(result.hits.reduce((sum, hit) => sum + hit.count, 0)).toBe(3276800)
    expect(result.hits.every(hit => hit.ranges.length <= 2048)).toBe(true)
    expect(result.hits.reduce((sum, hit) => sum + hit.ranges.length, 0)).toBeLessThanOrEqual(16384)
    expect(result.hits.some(hit => "rangesTruncated" in hit && hit.rangesTruncated === true)).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(1048576)
    expect(result.truncated).toBe(false)
    const sync = searchMessages(rows, "a", 500)
    expect(sync).toEqual(result)
  })

  test("escapedMetadataResumesAtWholeHits", async () => {
    const rows = Array.from({ length: 12 }, (_, index) => ({
      ...row(index + 1, "text", "assistant", "a"), id: `${index}:${"\\\"中文".repeat(14000)}`,
    }))
    const seen: number[] = []
    let afterSeq = 0
    for (let requests = 0; requests < 12; requests += 1) {
      const result = await searchPaged(pageOf(rows), "a", 500, { afterSeq })
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(1048576)
      seen.push(...result.hits.map(hit => hit.seq))
      if (!result.truncated) break
      expect(result.resumeAfterSeq!).toBeGreaterThan(afterSeq)
      afterSeq = result.resumeAfterSeq!
    }
    expect(seen).toEqual(Array.from({ length: 12 }, (_, index) => index + 1))
  })

  test("paginationFieldsCanRemoveTheLastWholeHitWithoutSkippingIt", async () => {
    const rows = [1, 2].map(seq => ({ ...row(seq, "text", "assistant", "a"), id: "x".repeat(524174) }))
    rows.push(row(3, "text", "assistant", "a"))
    const first = await searchPaged(pageOf(rows), "a", 500)
    expect(first.hits.map(hit => hit.seq)).toEqual([1])
    expect(first).toMatchObject({ truncated: true, resumeAfterSeq: 1 })
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(1048576)
    const rest = await searchPaged(pageOf(rows), "a", 500, { afterSeq: first.resumeAfterSeq })
    expect(rest.hits.map(hit => hit.seq)).toEqual([2, 3])
    expect(rest.truncated).toBe(false)
  })

  test("aLongNonHitCursorCanResumeFromTheLastReturnedHit", async () => {
    const rows = [{ ...row(1, "text", "assistant", "a"), id: "x".repeat(1048576 - 145) },
      row(Number.MAX_SAFE_INTEGER - 1, "text", "assistant", "none"), row(Number.MAX_SAFE_INTEGER, "text", "assistant", "a")]
    const result = await searchPaged(pageOf(rows), "a", 500, { budget: { rows: 2, chars: 1000, pageRows: 200, yieldChars: 1000 } })
    expect(result).toMatchObject({ truncated: true, resumeAfterSeq: 1 })
    expect(result.hits.map(hit => hit.seq)).toEqual([1])
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(1048576)
    const rest = await searchPaged(pageOf(rows), "a", 500, { afterSeq: result.resumeAfterSeq })
    expect(rest.hits.map(hit => hit.seq)).toEqual([Number.MAX_SAFE_INTEGER])
  })

  test("nearFullSingleHitUsesActualWrapperBudget", async () => {
    const large = { ...row(1, "text", "assistant", "a"), id: "x".repeat(1048576 - 200) }
    const complete = await searchPaged(pageOf([large]), "a", 500)
    expect(complete.hits[0]!.id).toBe(large.id)
    expect(complete.hits[0]!.ranges).toEqual([[0, 1]])
    expect(complete.truncated).toBe(false)
    expect(Buffer.byteLength(JSON.stringify(complete))).toBeLessThanOrEqual(1048576)
    const rows = [large, row(2, "text", "assistant", "a")]
    const page = await searchPaged(pageOf(rows), "a", 500)
    expect(page).toMatchObject({ truncated: true, resumeAfterSeq: 1 })
    expect(page.hits).toHaveLength(1)
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(1048576)
    const rest = await searchPaged(pageOf(rows), "a", 500, { afterSeq: page.resumeAfterSeq })
    expect(rest.hits.map(hit => hit.seq)).toEqual([2])
  })

  test("optionalRangesYieldToMetadataWithinTheWireBudget", async () => {
    const rows = [{ ...row(1, "text", "assistant", "a".repeat(4000)), id: "x".repeat(1048576 - 350) }]
    const result = await searchPaged(pageOf(rows), "a", 500)
    expect(result.hits[0]!.count).toBe(4000)
    expect(result.hits[0]).toHaveProperty("rangesTruncated", true)
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(1048576)
    expect(result.truncated).toBe(false)
  })

  test("emptyAndLimitBoundaryStayCompatible", async () => {
    const rows = [row(1, "text", "assistant", "a".repeat(2048)), row(2, "text", "assistant", "a".repeat(2049))]
    expect(await searchPaged(pageOf(rows), "  ", 500)).toEqual({ hits: [], truncated: false })
    const result = await searchPaged(pageOf(rows), "a", 1)
    expect(result).toMatchObject({ truncated: true, resumeAfterSeq: 1 })
    expect(result.hits[0]!.count).toBe(2048)
    expect(result.hits[0]).not.toHaveProperty("rangesTruncated")
    const resumed = await searchPaged(pageOf(rows), "a", 1, { afterSeq: 1 })
    expect(resumed.hits[0]).toMatchObject({ count: 2049, rangesTruncated: true })
  })

  test("oversizeSingleHitReportsActionableError", async () => {
    const rows = [{ ...row(1, "text", "assistant", "a"), id: "x".repeat(1048576) }]
    await expect(searchPaged(pageOf(rows), "a", 500)).rejects.toMatchObject({ code: "search_result_too_large" })
    expect(() => searchMessages(rows, "a", 500)).toThrow("search result")
  })

  test("unicodeSummaryMatchesReference", async () => {
    const text = "x𝐀Ｂ ﬁle İ Σ 中文 ".repeat(3000)
    const rows = [row(1, "text", "assistant", text)]
    for (const query of ["ab", "file", "i", "σ", "中文"]) {
      const expected = matchRanges(text, normalizeQuery(query))
      const result = await searchPaged(pageOf(rows), query, 500)
      expect(result.hits[0]!.count).toBe(expected.length)
      expect(result.hits[0]!.ranges).toEqual(expected.slice(0, 2048))
      expect(result.hits[0]).toHaveProperty("rangesTruncated", true)
    }
  })
})

describe("permission rules (v48 E)", () => {
  test("rules carry createdAt and can be restored and removed", async () => {
    const h = harness()
    const id = h.store.createSession({ agent: "fake", cwd: h.dir }).id
    const asked = () => h.events.filter((event) => event.name === "permission.asked")
    const idle = () => h.events.filter((event) => event.name === "agent.status" && payload(event).status === "idle").length
    void h.service.invoke("message.send", { sessionId: id, text: "run ls" }, "1")
    await waitFor(() => asked().length === 1)
    const before = Date.now()
    await h.service.invoke("permission.respond", { id: String(payload(asked()[0]!).id), optionId: "allow_always" }, "p1")
    await waitFor(() => idle() >= 1)
    const list = async () =>
      ((await h.service.invoke("permission.rules", { sessionId: id }, "r")).result as {
        rules: Array<{ id: string; tool: string; enabled: boolean; createdAt: number }>
      }).rules
    const [rule] = await list()
    expect(rule!.createdAt).toBeGreaterThanOrEqual(before - 1000)
    expect(rule!.tool.length).toBeGreaterThan(0)

    await h.service.invoke("permission.revoke", { id: rule!.id }, "rev")
    expect((await list())[0]!.enabled).toBe(false)
    const restored = await h.service.invoke("permission.restore", { id: rule!.id }, "res")
    expect(restored.result).toMatchObject({ ok: true, rule: { enabled: true } })
    const quiet = asked().length
    void h.service.invoke("message.send", { sessionId: id, text: "run ls" }, "2")
    await waitFor(() => idle() >= 2)
    expect(asked().length).toBe(quiet)

    await h.service.invoke("permission.remove", { id: rule!.id }, "rm")
    expect(await list()).toEqual([])
    expect((await h.service.invoke("permission.remove", { id: rule!.id }, "rm2")).error?.code).toBe("not_found")
    expect((await h.service.invoke("permission.restore", { id: rule!.id }, "res2")).error?.code).toBe("not_found")
    void h.service.invoke("message.send", { sessionId: id, text: "run ls" }, "3")
    await waitFor(() => asked().length === quiet + 1)
  })

  test("rules outlive a rudderd restart and leave with their session (§627)", async () => {
    const h = harness()
    const id = h.store.createSession({ agent: "fake", cwd: h.dir }).id
    const asked = () => h.events.filter((event) => event.name === "permission.asked")
    const idle = () => h.events.filter((event) => event.name === "agent.status" && payload(event).status === "idle").length
    void h.service.invoke("message.send", { sessionId: id, text: "run ls" }, "1")
    await waitFor(() => asked().length === 1)
    await h.service.invoke("permission.respond", { id: String(payload(asked()[0]!).id), optionId: "allow_always" }, "p1")
    await waitFor(() => idle() >= 1)
    const rulesOf = async (service: SessionService) =>
      ((await service.invoke("permission.rules", { sessionId: id }, "r")).result as {
        rules: Array<{ id: string; command: string; enabled: boolean; createdAt: number }>
      }).rules
    const [rule] = await rulesOf(h.service)
    await h.service.invoke("permission.revoke", { id: rule!.id }, "rev")

    // A new service on the same store is a restarted rudderd.
    const events: Frame[] = []
    const restarted = new SessionService(h.store, createFakeAdapter(), (frame) => events.push(frame), { workspaceRoot: h.dir })
    expect(await rulesOf(restarted)).toEqual([{ ...rule!, enabled: false }])
    await restarted.invoke("permission.restore", { id: rule!.id }, "res")
    void restarted.invoke("message.send", { sessionId: id, text: "run ls" }, "2")
    await waitFor(() => events.some((event) => event.name === "agent.status" && payload(event).status === "idle"))
    expect(events.some((event) => event.name === "permission.asked")).toBe(false)

    await restarted.invoke("session.delete", { id }, "del")
    const again = new SessionService(h.store, createFakeAdapter(), () => {}, { workspaceRoot: h.dir })
    expect(await rulesOf(again)).toEqual([])
  })

  test("allowing a turned-off command again turns its rule back on instead of listing it twice", async () => {
    const h = harness()
    const id = h.store.createSession({ agent: "fake", cwd: h.dir }).id
    const asked = () => h.events.filter((event) => event.name === "permission.asked")
    const idle = () => h.events.filter((event) => event.name === "agent.status" && payload(event).status === "idle").length
    void h.service.invoke("message.send", { sessionId: id, text: "run ls" }, "1")
    await waitFor(() => asked().length === 1)
    await h.service.invoke("permission.respond", { id: String(payload(asked()[0]!).id), optionId: "allow_always" }, "p1")
    await waitFor(() => idle() >= 1)
    const rules = (await h.service.invoke("permission.rules", { sessionId: id }, "r")).result as { rules: Array<{ id: string }> }
    await h.service.invoke("permission.revoke", { id: rules.rules[0]!.id }, "rev")
    void h.service.invoke("message.send", { sessionId: id, text: "run ls" }, "2")
    await waitFor(() => asked().length === 2)
    await h.service.invoke("permission.respond", { id: String(payload(asked()[1]!).id), optionId: "allow_always" }, "p2")
    await waitFor(() => idle() >= 2)
    const after = (await h.service.invoke("permission.rules", { sessionId: id }, "r2")).result as { rules: Array<{ id: string; enabled: boolean }> }
    expect(after.rules).toHaveLength(1)
    expect(after.rules[0]).toMatchObject({ id: rules.rules[0]!.id, enabled: true })
  })
})
