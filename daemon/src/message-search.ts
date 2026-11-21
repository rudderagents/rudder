import { isNoticePayload, parseTool, type MessageRow } from "./store"

/** One message with at least one match. `ranges` are [start, length] in UTF-16 units of `field`'s text. */
export type SearchHit = {
  id: string
  seq: number
  kind: string
  role: string
  /** `text` for a message body, `tool` for a tool card's title and command. */
  field: "text" | "tool"
  count: number
  ranges: Array<[number, number]>
  rangesTruncated?: true
}

/**
 * `truncated` says the search stopped before the end: more matched than `limit`, or the scan budget ran out.
 * `resumeAfterSeq` (only then) is the last seq it covered; the same call with `afterSeq` set to it goes on from there.
 */
export type SearchResult = { hits: SearchHit[]; truncated: boolean; resumeAfterSeq?: number }

export const SEARCH_LIMIT = 500
export const SEARCH_CAP = 2000
const QUERY_MAX = 200
export const SEARCH_RANGES_PER_HIT = 2048
export const SEARCH_RANGES_TOTAL = 16384
export const SEARCH_RESULT_BYTES = 1024 * 1024
const RESULT_WRAPPER_BYTES = Buffer.byteLength(JSON.stringify({ hits: [], truncated: false }))

export type MatchSummary = { count: number; ranges: Array<[number, number]>; rangesTruncated: boolean }

const INLINE_MATCH_UNITS = 65_536
const FOLD_SLICE_UNITS = 8_192

/**
 * How much one `message.search` reads: rows and UTF-16 units searched, apart from the hit limit, so a rare word in a
 * huge session stops instead of reading all of it. Rows come `pageRows` at a time, and the event loop gets a turn
 * after every page and every `yieldChars` units, so stream flushes and other sockets are not held up by a search.
 */
export type SearchBudget = { rows: number; chars: number; pageRows: number; yieldChars: number }
export const SEARCH_BUDGET: SearchBudget = { rows: 50_000, chars: 32 * 1024 * 1024, pageRows: 200, yieldChars: 512 * 1024 }

/** Folded text and, per folded unit (plus one past the end), the unit of the original it came from; null = the same. */
type Folded = { folded: string; origin: number[] | null }

/**
 * Case and width are ignored (`ＣＡＣＨＥ` finds `cache`), as the phone's own matcher does. Most text is already NFKC
 * and lower-cases unit for unit, so it is folded whole and offsets need no map. Otherwise (full-width letters,
 * ligatures, `İ`, or `Σ`, whose lower case depends on the next letter) NFKC and lower case can change a string's
 * length, so the text is folded one code point at a time and every folded unit remembers where it came from.
 */
export function fold(text: string): Folded {
  const steps = foldSteps(text)
  for (;;) {
    const step = steps.next()
    if (step.done) return step.value
  }
}

function* foldSteps(text: string): Generator<void, Folded> {
  if (!text.includes("Σ") && text.normalize("NFKC") === text) {
    const lower = text.toLowerCase()
    if (lower.length === text.length) return { folded: lower, origin: null }
  }
  const chunks: string[] = []
  let pieces: string[] = []
  const origin: number[] = []
  let index = 0
  let sliceEnd = FOLD_SLICE_UNITS
  for (const char of text) {
    const code = char.charCodeAt(0)
    const piece =
      code < 0x80 ? (code >= 0x41 && code <= 0x5a ? String.fromCharCode(code + 32) : char) : char.normalize("NFKC").toLowerCase()
    for (let unit = 0; unit < piece.length; unit += 1) origin.push(index)
    pieces.push(piece)
    index += char.length
    if (index >= sliceEnd) {
      sliceEnd = index + FOLD_SLICE_UNITS
      chunks.push(pieces.join(""))
      pieces = []
      yield
    }
  }
  origin.push(index)
  chunks.push(pieces.join(""))
  return { folded: chunks.join(""), origin }
}

export function normalizeQuery(query: string): string {
  return query.trim().normalize("NFKC").toLowerCase()
}

/** Non-overlapping matches of an already normalized `needle`, mapped back to `text`. */
export function matchRanges(text: string, needle: string): Array<[number, number]> {
  return matchSummary(text, needle, Infinity).ranges
}

/** Counts every match but retains only the ranges the caller can return. */
export function matchSummary(text: string, needle: string, rangeLimit: number): MatchSummary {
  if (!needle || !text) return { count: 0, ranges: [], rangesTruncated: false }
  const steps = matchSteps(fold(text), text.length, needle, rangeLimit)
  for (;;) {
    const step = steps.next()
    if (step.done) return step.value
  }
}

function* matchSteps(
  { folded, origin }: Folded,
  originalLength: number,
  needle: string,
  rangeLimit: number,
): Generator<void, MatchSummary> {
  const ranges: Array<[number, number]> = []
  let count = 0
  let from = 0
  while (from <= folded.length - needle.length) {
    const at = folded.indexOf(needle, from)
    if (at < 0) break
    count += 1
    if (ranges.length < rangeLimit) {
      const start = origin ? origin[at]! : at
      const end = origin ? (origin[at + needle.length] ?? originalLength) : at + needle.length
      ranges.push([start, Math.max(1, end - start)])
    }
    from = at + needle.length
    if (count % FOLD_SLICE_UNITS === 0) yield
  }
  return { count, ranges, rangesTruncated: count > ranges.length }
}

/** What a tool card shows: its title and its command (the first line of the detail). */
function toolText(row: MessageRow): string {
  const tool = parseTool(row.payload)
  if (!tool) return ""
  const command = (tool.detail ?? "").split("\n", 1)[0] ?? ""
  return [tool.tool, tool.title, command].filter((part) => typeof part === "string" && part.trim()).join("\n")
}

/** The searched field of a row, or null for a row search skips (thinking, Rudder's own notices). */
function searched(row: MessageRow): { field: SearchHit["field"]; text: string } | null {
  if (row.kind === "text" && (row.role === "user" || row.role === "assistant") && !isNoticePayload(row.payload)) {
    return { field: "text", text: row.text }
  }
  if (row.kind === "tool") return { field: "tool", text: toolText(row) }
  return null
}

function hitFor(row: MessageRow, field: SearchHit["field"], match: MatchSummary): SearchHit {
  return { id: row.id, seq: row.seq, kind: row.kind, role: row.role, field, count: match.count, ranges: match.ranges,
    ...(match.rangesTruncated ? { rangesTruncated: true as const } : {}) }
}

class SearchPage {
  readonly hits: SearchHit[] = []
  private ranges = 0
  private bytes = 0
  private readonly sizes: number[] = []

  match(text: string, needle: string): MatchSummary {
    return matchSummary(text, needle, this.rangeLimit)
  }

  get rangeLimit(): number {
    return Math.min(SEARCH_RANGES_PER_HIT, SEARCH_RANGES_TOTAL - this.ranges)
  }

  add(row: MessageRow, field: SearchHit["field"], match: MatchSummary): boolean {
    const hit = hitFor(row, field, match)
    let bytes = Buffer.byteLength(JSON.stringify(hit))
    if (bytes + RESULT_WRAPPER_BYTES > SEARCH_RESULT_BYTES && hit.ranges.length > 0) {
      // Counts and identity are required; optional highlight coordinates must not make an otherwise valid hit fail.
      hit.ranges = []
      hit.rangesTruncated = true
      bytes = Buffer.byteLength(JSON.stringify(hit))
    }
    if (bytes + RESULT_WRAPPER_BYTES > SEARCH_RESULT_BYTES) this.oversized(row.seq)
    if (this.bytes + bytes + RESULT_WRAPPER_BYTES > SEARCH_RESULT_BYTES) return false
    this.hits.push(hit)
    this.sizes.push(bytes + 1)
    // One comma per hit, less the first comma when the wrapper is accounted for at finish.
    this.bytes += bytes + 1
    this.ranges += hit.ranges.length
    return true
  }

  finish(truncated: boolean, resumeAfterSeq?: number): SearchResult {
    const result: SearchResult = { hits: this.hits, truncated, ...(resumeAfterSeq === undefined ? {} : { resumeAfterSeq }) }
    const wrapperBytes = () => Buffer.byteLength(JSON.stringify({ ...result, hits: [] }))
    while (this.bytes - (this.hits.length > 0 ? 1 : 0) + wrapperBytes() > SEARCH_RESULT_BYTES) {
      const last = this.hits.at(-1)!
      if (result.resumeAfterSeq !== undefined && result.resumeAfterSeq > last.seq) {
        result.resumeAfterSeq = last.seq
        continue
      }
      const compact: SearchHit = { ...last, ranges: [], rangesTruncated: true }
      const compactSize = Buffer.byteLength(JSON.stringify(compact)) + 1
      const size = this.sizes.at(-1)!
      if (last.ranges.length > 0 && compactSize < size) {
        this.bytes += compactSize - size
        this.hits[this.hits.length - 1] = compact
        this.sizes[this.sizes.length - 1] = compactSize
      } else {
        if (this.hits.length === 1) this.oversized(last.seq)
        this.hits.pop()
        this.bytes -= this.sizes.pop()!
        // A final hit removed to make room for the cursor must be searched again on the next page.
        if (result.resumeAfterSeq !== undefined) result.resumeAfterSeq = this.hits.at(-1)!.seq
      }
    }
    return result
  }

  private oversized(seq: number): never {
    throw Object.assign(new Error(`search result for seq ${seq} exceeds ${SEARCH_RESULT_BYTES} bytes`), { code: "search_result_too_large" })
  }
}

/**
 * Searches message bodies and tool cards (never thinking, never Rudder's own notices), oldest first.
 * `rows` must be in seq order. Stops after `limit` messages; `truncated` says more matched.
 */
export function searchMessages(rows: Iterable<MessageRow>, query: string, limit: number): { hits: SearchHit[]; truncated: boolean } {
  const needle = normalizeQuery(query)
  const page = new SearchPage()
  const hits = page.hits
  if (!needle) return page.finish(false)
  for (const row of rows) {
    const target = searched(row)
    if (!target) continue
    const match = page.match(target.text, needle)
    if (match.count === 0) continue
    if (hits.length === limit || !page.add(row, target.field, match)) return page.finish(true)
  }
  return page.finish(false)
}

// A macrotask, so timers, socket reads and stream flushes queued meanwhile run before the search goes on.
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve))

/** Drain exactly the same search as the synchronous matcher, but let other sockets run between slices. */
async function drainSlices<T>(steps: Generator<void, T>): Promise<T> {
  for (;;) {
    await nextTurn()
    const step = steps.next()
    if (step.done) return step.value
  }
}

async function matchLongRow(text: string, needle: string, rangeLimit: number): Promise<MatchSummary> {
  const folded = await drainSlices(foldSteps(text))
  return drainSlices(matchSteps(folded, text.length, needle, rangeLimit))
}

/**
 * `searchMessages` over pages read by `page(afterSeq, limit)` (seq order, seq above `afterSeq`), from
 * `options.afterSeq` on, within `options.budget`, giving the event loop a turn between pages.
 */
export async function searchPaged(
  page: (afterSeq: number, limit: number) => MessageRow[],
  query: string,
  limit: number,
  options: { afterSeq?: number; budget?: SearchBudget } = {},
): Promise<SearchResult> {
  const budget = options.budget ?? SEARCH_BUDGET
  const needle = normalizeQuery(query)
  const result = new SearchPage()
  const hits = result.hits
  if (!needle) return result.finish(false)
  let after = options.afterSeq ?? 0
  let rows = 0
  let chars = 0
  let sinceTurn = 0
  for (;;) {
    const batch = page(after, budget.pageRows)
    for (const row of batch) {
      if (rows >= budget.rows || chars >= budget.chars) return result.finish(true, after)
      const target = searched(row)
      if (target) {
        const match = target.text.length > INLINE_MATCH_UNITS
          ? await matchLongRow(target.text, needle, result.rangeLimit)
          : result.match(target.text, needle)
        if (match.count > 0) {
          if (hits.length === limit) return result.finish(true, hits.at(-1)?.seq ?? after)
          if (!result.add(row, target.field, match)) return result.finish(true, after)
        }
        chars += target.text.length
        sinceTurn += target.text.length
      }
      rows += 1
      after = row.seq
      if (sinceTurn >= budget.yieldChars) {
        sinceTurn = 0
        await nextTurn()
      }
    }
    if (batch.length < budget.pageRows) return result.finish(false)
    sinceTurn = 0
    await nextTurn()
  }
}

export function searchLimit(raw: unknown): number {
  const requested = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : SEARCH_LIMIT
  return Math.min(Math.max(1, requested), SEARCH_CAP)
}

export function searchQuery(raw: unknown): string {
  if (typeof raw !== "string") throw Object.assign(new Error("query must be a string"), { code: "invalid" })
  if (raw.length > QUERY_MAX) throw Object.assign(new Error(`query must be at most ${QUERY_MAX} characters`), { code: "invalid" })
  return raw
}
