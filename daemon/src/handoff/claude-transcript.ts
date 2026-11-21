// Claude Code transcript (~/.claude/projects/<cwd>/<session>.jsonl) → Rudder message rows.
// The format is Claude's own and has no published schema: only a handful of fields are read, every one of them
// loosely, and unknown record types are skipped. Row ids are the transcript's own record uuids and tool_use ids
// (`claude:<uuid>`, `claude:tool:<id>`), so importing the same file twice upserts the same rows.
import { describeTool } from "../adapter/claude"
import { arr, isObject, isString, num, obj, parseQuestions, str, type Json } from "../adapter/json"
import type { QuestionAnswers } from "../adapter/types"
import { TOOL_OUTPUT_LIMIT, truncateDiff, truncateUtf8, type PermissionPayload, type QuestionPayload, type ToolPayload } from "../store"

export type ImportedRow = {
  id: string
  kind: string
  role: "user" | "assistant"
  text: string
  payload: string
  createdAt: number
}

/** Who wrote a stretch of the timeline; the divider row's payload. */
export type HandoffSide = "terminal" | "phone"

export const TURNS_IMPORTED = 200
const INTERRUPTED = /^\[Request interrupted by user/
const COMPACTED_TEXT = "上下文已压缩"

export function dividerRow(id: string, side: HandoffSide, createdAt: number): ImportedRow {
  return {
    id,
    kind: "handoff",
    role: "assistant",
    text: side === "terminal" ? "以下在电脑终端里" : "以下在手机上",
    payload: JSON.stringify({ handoff: side }),
    createdAt,
  }
}

type ToolSlot = { row: ImportedRow; payload: ToolPayload } | { question: Json }

/**
 * Maps records one at a time. Earlier rows a later record updates (a tool card its result finishes) come from
 * `known`, which the full parse fills itself and the follower backs with the store.
 */
export class ClaudeMapper {
  private readonly tools = new Map<string, ToolSlot>()
  title: string | undefined

  constructor(private readonly known: (id: string) => ImportedRow | undefined = () => undefined) {}

  map(record: Json): ImportedRow[] {
    const type = str(record.type)
    if (type === "ai-title" && str(record.aiTitle)) this.title = str(record.aiTitle)
    if (record.isSidechain === true) return []
    const at = time(record.timestamp)
    if (type === "user") return this.user(record, at)
    if (type === "assistant") return this.assistant(record, at)
    if (type === "system" && record.subtype === "compact_boundary") {
      const meta = obj(record.compactMetadata)
      const payload = {
        state: "done",
        trigger: str(meta.trigger) === "manual" ? "manual" : "auto",
        ...(num(meta.preTokens) !== undefined ? { tokensBefore: num(meta.preTokens) } : {}),
        ...(num(meta.postTokens) !== undefined ? { tokensAfter: num(meta.postTokens) } : {}),
        imported: true,
      }
      return [{ id: `claude:${str(record.uuid)}`, kind: "compaction", role: "assistant", text: COMPACTED_TEXT, payload: JSON.stringify(payload), createdAt: at }]
    }
    return []
  }

  private user(record: Json, at: number): ImportedRow[] {
    const message = obj(record.message)
    const content = message.content
    const results = arr(content).filter(isObject).filter((block) => block.type === "tool_result")
    if (results.length > 0) return results.flatMap((block) => this.toolResult(block, record))
    if (record.isMeta === true || record.isCompactSummary === true) return []
    // Peer messages (a subagent handing back) and task notifications are not something the user typed.
    const origin = obj(record.origin)
    if (origin.kind !== undefined && origin.kind !== "human") return []
    const raw = isString(content)
      ? content
      : arr(content)
          .filter(isObject)
          .filter((block) => block.type === "text")
          .map((block) => str(block.text))
          .join("\n")
    const id = `claude:${str(record.uuid)}`
    if (INTERRUPTED.test(raw.trim())) {
      return [{ id, kind: "text", role: "assistant", text: "Cancelled.", payload: JSON.stringify({ notice: true, imported: true }), createdAt: at }]
    }
    const text = userText(raw)
    if (!text) return []
    return [{ id, kind: "text", role: "user", text, payload: JSON.stringify({ imported: true }), createdAt: at }]
  }

  // One content block per line in current transcripts; each line has its own uuid, so ids need no counting state.
  private assistant(record: Json, at: number): ImportedRow[] {
    const message = obj(record.message)
    const base = `claude:${str(record.uuid) || str(message.id)}`
    const rows: ImportedRow[] = []
    arr(message.content).filter(isObject).forEach((block, index) => {
      const id = index === 0 ? base : `${base}:${index}`
      if (block.type === "text" && str(block.text).trim()) {
        rows.push({ id, kind: "text", role: "assistant", text: str(block.text), payload: JSON.stringify({ imported: true }), createdAt: at })
      } else if (block.type === "thinking" && str(block.thinking).trim()) {
        const took = num(record.thinkingDurationMs)
        const reasoning = { startedAt: took !== undefined ? at - took : at, endedAt: at, imported: true }
        rows.push({ id, kind: "reasoning", role: "assistant", text: str(block.thinking), payload: JSON.stringify(reasoning), createdAt: at })
      } else if (block.type === "tool_use") {
        const row = this.toolUse(block, at)
        if (row) rows.push(row)
      }
    })
    return rows
  }

  private toolUse(block: Json, at: number): ImportedRow | undefined {
    const useId = str(block.id)
    if (!useId) return undefined
    const name = str(block.name)
    const input = obj(block.input)
    if (name === "AskUserQuestion") {
      this.tools.set(useId, { question: input })
      return undefined
    }
    const info = describeTool(name, input)
    const id = `claude:tool:${useId}`
    const payload: ToolPayload & { imported: true } = {
      id,
      tool: name,
      title: info.title,
      detail: info.detail,
      kind: info.kind,
      status: "running",
      ...(info.diffs?.length ? { diffs: info.diffs.map((diff) => truncateDiff(diff)) } : {}),
      imported: true,
    }
    const row: ImportedRow = { id, kind: "tool", role: "assistant", text: `${name}: ${info.title}`, payload: JSON.stringify(payload), createdAt: at }
    this.tools.set(useId, { row, payload })
    return row
  }

  private toolResult(block: Json, record: Json): ImportedRow[] {
    const useId = str(block.tool_use_id)
    const at = time(record.timestamp)
    const slot = this.tools.get(useId) ?? this.knownTool(useId)
    if (!slot) return []
    const result = record.toolUseResult
    if ("question" in slot) {
      const answers = obj(obj(result).answers)
      if (Object.keys(answers).length === 0) return []
      return [questionRow(useId, slot.question, answers, at)]
    }
    const { payload } = slot
    const decision = obj(record.permissionDecision)
    const failed = block.is_error === true
    const output = resultText(block.content)
    payload.output = truncateUtf8(output, TOOL_OUTPUT_LIMIT)
    if (payload.output !== output) payload.outputTruncated = true
    if (record.toolDenialKind !== undefined || decision.decision === "reject") payload.status = "declined"
    else if (obj(result).interrupted === true || INTERRUPTED.test(output.trim())) payload.status = "cancelled"
    else payload.status = failed ? "failed" : "completed"
    const exit = failed && payload.tool === "Bash" ? /^Exit code (\d+)/.exec(output) : null
    if (exit) payload.exitCode = Number(exit[1])
    const rows: ImportedRow[] = [{ ...slot.row, payload: JSON.stringify(payload) }]
    // Only a choice the user made in the terminal becomes a row; config, classifier and mode approvals stay silent.
    if (decision.decision === "accept" && decision.source === "user_temporary") {
      const permission: PermissionPayload & { imported: true } = {
        id: `claude:perm:${useId}`,
        tool: payload.tool,
        title: payload.title,
        detail: payload.detail,
        status: "allowed",
        ...(payload.kind ? { kind: payload.kind } : {}),
        decision: decision.grantScope === "session" ? "allow_session" : "allow",
        toolId: payload.id,
        imported: true,
      }
      rows.push({ id: permission.id, kind: "permission", role: "assistant", text: `${payload.tool}: ${payload.title}`, payload: JSON.stringify(permission), createdAt: at })
    }
    return rows
  }

  private knownTool(useId: string): ToolSlot | undefined {
    const row = this.known(`claude:tool:${useId}`)
    if (!row) return undefined
    try {
      const slot = { row, payload: JSON.parse(row.payload) as ToolPayload }
      this.tools.set(useId, slot)
      return slot
    } catch {
      return undefined
    }
  }
}

function questionRow(useId: string, input: Json, raw: Json, at: number): ImportedRow {
  const questions = parseQuestions(input.questions, true)
  const answers: QuestionAnswers = {}
  for (const [question, value] of Object.entries(raw)) {
    if (isString(value)) answers[question] = value
    else if (Array.isArray(value)) answers[question] = value.filter(isString)
  }
  const first = questions[0]
  const firstAnswer = first ? answers[first.question] : Object.values(answers)[0]
  const payload: QuestionPayload & { imported: true } = {
    id: `claude:q:${useId}`,
    prompt: first?.question ?? "",
    options: first?.options.map((option) => option.label) ?? [],
    status: "answered",
    ...(firstAnswer !== undefined ? { answer: Array.isArray(firstAnswer) ? firstAnswer.join(", ") : firstAnswer } : {}),
    questions,
    answers,
    imported: true,
  }
  return { id: payload.id, kind: "question", role: "assistant", text: payload.prompt, payload: JSON.stringify(payload), createdAt: at }
}

/** Slash commands and `!` shell lines come wrapped in tags; their own output (stdout, caveats) is not a message. */
export function userText(raw: string): string {
  const text = raw.trim()
  if (!text) return ""
  if (/^<(local-command-stdout|local-command-stderr|local-command-caveat|bash-stdout|bash-stderr)>/.test(text)) return ""
  const command = /<command-name>([^<]*)<\/command-name>/.exec(text)
  if (command) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim()
    const name = command[1]!.trim()
    return args ? `${name} ${args}` : name
  }
  const bash = /^<bash-input>([\s\S]*?)<\/bash-input>$/.exec(text)
  if (bash) return `!${bash[1]!.trim()}`
  return text
}

function resultText(content: unknown): string {
  if (isString(content)) return content
  return arr(content)
    .filter(isObject)
    .map((block) => (block.type === "text" ? str(block.text) : ""))
    .filter(Boolean)
    .join("\n")
}

function time(value: unknown): number {
  const at = isString(value) ? Date.parse(value) : Number.NaN
  return Number.isFinite(at) ? at : Date.now()
}

export type TranscriptRead = {
  /** The current branch, oldest first. */
  rows: ImportedRow[]
  title?: string
  cwd?: string
  version?: string
  entrypoint?: string
  nativeId?: string
  badLines: number
  /** False when the file has records but none in a shape this parser knows (the format changed). */
  recognized: boolean
  /** Rows from user text, for "the last 200 turns". */
  userTurns: number
}

/** Splits complete lines; `consumed` is the byte length up to and including the last newline. */
export function splitLines(text: string): { lines: string[]; consumed: number } {
  const end = text.lastIndexOf("\n")
  if (end < 0) return { lines: [], consumed: 0 }
  const head = text.slice(0, end)
  return { lines: head ? head.split("\n") : [""], consumed: Buffer.byteLength(text.slice(0, end + 1)) }
}

export function parseRecords(lines: string[]): { records: Json[]; badLines: number } {
  const records: Json[] = []
  let badLines = 0
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const value: unknown = JSON.parse(line)
      if (isObject(value)) records.push(value)
      else badLines += 1
    } catch {
      badLines += 1
    }
  }
  return { records, badLines }
}

const CHAIN_TYPES = new Set(["user", "assistant", "system", "attachment"])

/**
 * The branch `--resume` continues: back from the newest record along parentUuid (a compaction boundary links on
 * through logicalParentUuid). When last-prompt names a leaf that is not on that path (rewound, not typed into yet),
 * the newest record under that leaf is the tip instead.
 */
export function currentBranch(records: Json[]): Set<string> {
  const byId = new Map<string, Json>()
  for (const record of records) if (isString(record.uuid) && CHAIN_TYPES.has(str(record.type))) byId.set(record.uuid, record)
  const parentOf = (record: Json): string => str(record.parentUuid) || str(record.logicalParentUuid)
  const ancestry = (tip: string): Set<string> => {
    const seen = new Set<string>()
    let cursor: string | undefined = tip
    while (cursor && byId.has(cursor) && !seen.has(cursor)) {
      seen.add(cursor)
      cursor = parentOf(byId.get(cursor)!)
    }
    return seen
  }
  const main = records.filter((record) => record.isSidechain !== true && byId.has(str(record.uuid)))
  const newest = main.at(-1)
  if (!newest) return new Set()
  let branch = ancestry(str(newest.uuid))
  const leaf = records.filter((record) => record.type === "last-prompt").map((record) => str(record.leafUuid)).filter((id) => byId.has(id)).at(-1)
  if (leaf && !branch.has(leaf)) {
    // Parent links are functional: once a path's reachability is known, every node on it shares that answer.
    const reaches = new Map<string, boolean>([[leaf, true]])
    const reachesLeaf = (tip: string): boolean => {
      const path: string[] = []
      const visiting = new Set<string>()
      let cursor = tip
      while (cursor && byId.has(cursor) && !reaches.has(cursor) && !visiting.has(cursor)) {
        visiting.add(cursor)
        path.push(cursor)
        cursor = parentOf(byId.get(cursor)!)
      }
      const found = reaches.get(cursor) === true
      for (const id of path) reaches.set(id, found)
      return found
    }
    const tip = [...main].reverse().find((record) => reachesLeaf(str(record.uuid)))
    branch = ancestry(tip ? str(tip.uuid) : leaf)
  }
  return branch
}

/** The whole file: rows of the current branch with each tool card in its final state. */
export function readTranscript(text: string): TranscriptRead {
  const { records, badLines } = parseRecords(text.split("\n"))
  const rows = new Map<string, ImportedRow>()
  const mapper = new ClaudeMapper((id) => rows.get(id))
  const branch = currentBranch(records)
  let head: Json | undefined
  let recognized = false
  for (const record of records) {
    const type = str(record.type)
    if ((type === "user" || type === "assistant") && isObject(record.message) && isString(record.uuid)) {
      recognized = true
      if (record.isSidechain !== true) head ??= record
    }
    if (type === "user" || type === "assistant" || type === "system") {
      if (!branch.has(str(record.uuid))) continue
    }
    for (const row of mapper.map(record)) rows.set(row.id, row)
  }
  const list = [...rows.values()]
  return {
    rows: list,
    title: mapper.title,
    cwd: head ? str(head.cwd) || undefined : undefined,
    version: head ? str(head.version) || undefined : undefined,
    entrypoint: head ? str(head.entrypoint) || undefined : undefined,
    nativeId: head ? str(head.sessionId) || undefined : undefined,
    badLines,
    recognized: recognized || records.length === 0,
    userTurns: list.filter((row) => row.kind === "text" && row.role === "user").length,
  }
}

/** Index of the first row of the last `turns` user turns (0 when the whole transcript fits). */
export function recentStart(rows: ImportedRow[], turns = TURNS_IMPORTED): number {
  let seen = 0
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!
    if (row.kind === "text" && row.role === "user") {
      seen += 1
      if (seen === turns) return index
    }
  }
  return 0
}
