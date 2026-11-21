// r66: reads recordings made by daemon/scripts/record (`<agent>/recorded/<scenario>.jsonl`) for the replay fakes.
// A recording is a header line, then {"dir": "spawn" | "in" | "out" | "err", ...} in the order things happened; a
// process restart (resume) starts a new spawn section.
import { readFileSync } from "node:fs"

// biome-ignore lint/suspicious/noExplicitAny: recorded CLI frames are arbitrary JSON
export type Frame = Record<string, any>
export type RecordedLine = { dir: "in" | "out"; frame: Frame } | { dir: "out"; raw: string } | { dir: "err"; text: string } | { dir: "spawn"; argv: string[] }

export function isRecording(spec: string): boolean {
  const path = parseReplay(spec)[0]?.path
  if (!path?.endsWith(".jsonl") || !path.includes("/recorded/")) return false
  const first = readFileSync(path, "utf8").split("\n", 1)[0] ?? ""
  return first.includes('"recorded"')
}

/** The lines of one process of a recording (1-based `spawn`). */
export function recordedSpawn(path: string, spawn = 1): RecordedLine[] {
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .slice(1)
    .map((line) => JSON.parse(line) as RecordedLine)
  const out: RecordedLine[] = []
  let current = 0
  for (const line of lines) {
    if (line.dir === "spawn") current += 1
    else if (current === spawn) out.push(line)
  }
  return out
}

/**
 * A replay spec: `path#spawn` picks a process (default 1); `a.jsonl+b.jsonl` plays a's process, then b's user turns
 * after it on the same process (the next-message invariant: any scenario, then a plain turn).
 */
export function parseReplay(spec: string): { path: string; spawn: number }[] {
  return spec.split("+").map((part) => {
    const [path, spawn] = part.split("#")
    return { path: path!, spawn: spawn ? Number(spawn) : 1 }
  })
}

/**
 * Claude stream-json recording → fake-claude steps. What Claude read becomes an await (user message, a
 * control_response to its can_use_tool, the host's interrupt / stop_task); what it wrote is written back, except its
 * control_responses to the host's requests, which fake-claude answers itself (an initialize answer becomes the
 * {"initialize": …} step). The recorded session id becomes $SID.
 */
export function claudeSteps(spec: string): Frame[] {
  const steps: Frame[] = []
  for (const [index, part] of parseReplay(spec).entries()) {
    const lines = recordedSpawn(part.path, part.spawn)
    const sid = lines.find((line): line is { dir: "out"; frame: Frame } => line.dir === "out" && "frame" in line && typeof line.frame.session_id === "string" && line.frame.session_id.length > 0)?.frame.session_id as string | undefined
    let started = index === 0
    for (const line of lines) {
      if (line.dir === "err" || line.dir === "spawn" || !("frame" in line)) continue
      const text = JSON.stringify(line.frame)
      const frame = JSON.parse(separateIds(sid ? text.replaceAll(sid, "$SID") : text, index)) as Frame
      if (line.dir === "in") {
        if (frame.type === "user") {
          started = true
          steps.push({ await: "user" })
        } else if (!started) continue
        else if (frame.type === "control_response") steps.push({ await: "control_response" })
        else if (frame.type === "control_request" && ["interrupt", "stop_task", "set_model"].includes(frame.request?.subtype)) steps.push({ await: frame.request.subtype })
        continue
      }
      if (frame.type === "control_response") {
        // The answer to initialize, sent before any user message: fake-claude answers initialize with it (session_state).
        const answer = frame.response?.response
        if (index === 0 && answer && typeof answer === "object" && "session_state" in answer) steps.unshift({ initialize: answer })
        continue
      }
      if (!started) continue
      steps.push(frame)
    }
  }
  return steps
}

/**
 * Redaction numbers ids per file, so two recordings reuse the same stand-ins for different ids. A later part of a
 * replay moves its stand-ins to their own range (part 1 → 8000-1…), which keeps the next-turn invariant honest.
 */
export function separateIds(text: string, part: number): string {
  if (part === 0) return text
  return text.replace(/00000000-0000-4000-8000-(\d)(\d{11})/g, (_all, _first, rest) => `00000000-0000-4000-8000-${part % 10}${rest}`)
}
