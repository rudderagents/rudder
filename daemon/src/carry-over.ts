import type { MessageRow } from "./store"

// A copied or rewound session whose agent cannot continue the old agent-native session (no fork, or the
// parent is gone) gets the earlier transcript in front of its next message, so the agent still knows
// what was said. Only the conversation is carried: tool output and
// reasoning are summarised to one line each.

// Keeps the newest part when the transcript is longer; the agent is told the start was cut.
export const CARRY_OVER_BUDGET = 60_000
// Rows read for it at most (newest first).
export const CARRY_OVER_ROWS = 2_000

export function carryOverTranscript(messages: MessageRow[], budget = CARRY_OVER_BUDGET): string | undefined {
  const lines: string[] = []
  for (const message of messages) {
    const line = transcriptLine(message)
    if (line) lines.push(line)
  }
  if (lines.length === 0) return undefined
  let cut = false
  let size = lines.reduce((sum, line) => sum + line.length + 2, 0)
  while (lines.length > 1 && size > budget) {
    size -= (lines.shift()?.length ?? 0) + 2
    cut = true
  }
  let body = lines.join("\n\n")
  if (body.length > budget) {
    body = body.slice(body.length - budget)
    cut = true
  }
  return `${cut ? "[earlier messages omitted]\n\n" : ""}${body}`
}

// The user's next message, behind the carried transcript.
export function withCarryOver(text: string, transcript: string | undefined): string {
  if (!transcript) return text
  return [
    "[Rudder] This session continues an earlier conversation (possibly held with a different assistant) that you no longer have in memory.",
    "Here is that conversation so far, oldest first. Treat it as already said and done; do not redo the work it describes.",
    "<earlier-conversation>",
    transcript,
    "</earlier-conversation>",
    "",
    "The user's new message:",
    text,
  ].join("\n")
}

function transcriptLine(message: MessageRow): string | undefined {
  const text = message.text.trim()
  if (message.kind === "text") {
    if (!text || isNotice(message.payload)) return undefined
    return message.role === "user" ? `User: ${text}` : `Assistant: ${text}`
  }
  if (message.kind === "tool") return text ? `(tool) ${firstLine(text)}` : undefined
  if (message.kind === "error") return text ? `(error) ${firstLine(text)}` : undefined
  return undefined
}

function firstLine(text: string) {
  const line = text.split("\n", 1)[0] ?? ""
  return line.length > 200 ? `${line.slice(0, 200)}…` : line
}

function isNotice(payload: string | null) {
  if (!payload) return false
  try {
    return (JSON.parse(payload) as { notice?: unknown }).notice === true
  } catch {
    return false
  }
}
