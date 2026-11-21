// Session handoff P2a / P3: an agent's history entries (adapter readExternal) → Rudder message rows. The payloads are
// the ones SessionService writes for the same live events, marked `imported: true` like the Claude importer's rows.
import type { HistoryEntry } from "../adapter/types"
import { TOOL_OUTPUT_LIMIT, truncateDiff, truncateUtf8, type PlanPayload, type ToolPayload } from "../store"
import type { ImportedRow } from "./claude-transcript"

const PLAN_MARKS = { pending: "[ ]", in_progress: "[~]", completed: "[x]" } as const

export function historyRows(entries: HistoryEntry[], now = Date.now()): ImportedRow[] {
  // Entries without a time take the one before them, so the rows stay in order.
  let last = 0
  return entries.map((entry) => {
    const createdAt = entry.at ?? (last || now)
    last = createdAt
    return historyRow(entry, createdAt)
  })
}

function historyRow(entry: HistoryEntry, createdAt: number): ImportedRow {
  const base = { id: entry.id, createdAt }
  switch (entry.type) {
    case "user":
      return { ...base, kind: "text", role: "user", text: entry.text, payload: JSON.stringify({ imported: true }) }
    case "text":
      return {
        ...base,
        kind: "text",
        role: "assistant",
        text: entry.text,
        payload: JSON.stringify({ ...(entry.notice ? { notice: true } : {}), ...(entry.phase ? { phase: entry.phase } : {}), imported: true }),
      }
    case "reasoning":
      return {
        ...base,
        kind: "reasoning",
        role: "assistant",
        text: entry.text,
        payload: JSON.stringify({ startedAt: entry.startedAt ?? createdAt, endedAt: createdAt, imported: true }),
      }
    case "tool": {
      const tool: ToolPayload & { imported: true } = {
        id: entry.id,
        tool: entry.tool,
        title: entry.title,
        detail: entry.detail,
        kind: entry.kind,
        status: entry.status,
        imported: true,
      }
      if (entry.output !== undefined) {
        tool.output = truncateUtf8(entry.output, TOOL_OUTPUT_LIMIT)
        if (tool.output !== entry.output) tool.outputTruncated = true
      }
      if (entry.exitCode !== undefined) tool.exitCode = entry.exitCode
      if (entry.diffs?.length) tool.diffs = entry.diffs.map((diff) => truncateDiff(diff))
      return { ...base, kind: "tool", role: "assistant", text: `${entry.tool}: ${entry.title}`, payload: JSON.stringify(tool) }
    }
    case "plan": {
      const plan: PlanPayload & { imported: true } = { entries: entry.entries, imported: true }
      const text = entry.entries.map((item) => `${PLAN_MARKS[item.status]} ${item.content}`).join("\n")
      return { ...base, kind: "plan", role: "assistant", text, payload: JSON.stringify(plan) }
    }
    case "compaction":
      return {
        ...base,
        kind: "compaction",
        role: "assistant",
        text: "上下文已压缩",
        payload: JSON.stringify({
          state: "done",
          trigger: entry.trigger,
          ...(entry.tokensBefore !== undefined ? { tokensBefore: entry.tokensBefore } : {}),
          ...(entry.tokensAfter !== undefined ? { tokensAfter: entry.tokensAfter } : {}),
          imported: true,
        }),
      }
  }
}
