import { closeSync, fstatSync, openSync, readSync } from "node:fs"
import type { AgentEvent, BackgroundTask, BackgroundTaskKind, BackgroundTaskStatus } from "./types"

// One turn's background work (Claude Code `is_backgrounded` tasks, Grok background commands). Every change goes to the
// daemon as one `background` event with the whole list, including the change that empties it.
export class BackgroundTracker {
  private readonly tasks = new Map<string, BackgroundTask>()
  // The agent's own id for the tool call (Claude `tool_use_id`), to find the card again when the task ends.
  private readonly native = new Map<string, string>()

  constructor(
    private readonly emit: (event: AgentEvent) => void,
    private readonly paused: () => boolean,
  ) {}

  get open(): number {
    let count = 0
    for (const task of this.tasks.values()) if (task.status === "running") count += 1
    return count
  }

  get size(): number {
    return this.tasks.size
  }

  has(id: string): boolean {
    return this.tasks.get(id)?.status === "running"
  }

  /** Every task this turn started. */
  ids(): string[] {
    return [...this.tasks.keys()]
  }

  /** This turn started the task, running or not. */
  knows(id: string): boolean {
    return this.tasks.has(id)
  }

  kind(id: string): BackgroundTaskKind | undefined {
    return this.tasks.get(id)?.kind
  }

  /** A running subagent task started by this native tool call (Claude `tool_use_id`). */
  runningForTool(nativeToolId: string): boolean {
    for (const [id, native] of this.native) {
      if (native === nativeToolId && this.tasks.get(id)?.status === "running" && this.tasks.get(id)?.kind === "subagent") return true
    }
    return false
  }

  nativeToolId(id: string): string | undefined {
    return this.native.get(id)
  }

  running(): string[] {
    return [...this.tasks.values()].filter((task) => task.status === "running").map((task) => task.id)
  }

  /** A task went to the background. A repeat of a running id is quiet; a finished id does not restart. */
  start(id: string, info: { kind: BackgroundTaskKind; title: string; toolId?: string; nativeToolId?: string }) {
    if (this.tasks.has(id)) return
    if (info.nativeToolId) this.native.set(id, info.nativeToolId)
    this.tasks.set(id, {
      id,
      kind: info.kind,
      title: info.title,
      ...(info.toolId ? { toolId: info.toolId } : {}),
      startedAt: Date.now(),
      status: "running",
    })
    this.publish()
  }

  /**
   * A finished task started again under its own id: Claude Code's SendMessage resumes a background agent that way.
   * Returns false for an id this turn never started or one still running.
   */
  reopen(id: string): boolean {
    const task = this.tasks.get(id)
    if (!task || task.status === "running") return false
    task.status = "running"
    delete task.endedAt
    delete task.exitCode
    this.publish()
    return true
  }

  /** The card that started a task, learned after the task itself (Grok announces a subagent before its tool result). */
  attachTool(id: string, toolId: string) {
    const task = this.tasks.get(id)
    if (!task || task.toolId) return
    task.toolId = toolId
    this.publish()
  }

  /** Returns false for an id this turn never backgrounded or that already ended. */
  end(id: string, status: Exclude<BackgroundTaskStatus, "running">, exitCode?: number): boolean {
    const task = this.tasks.get(id)
    if (!task || task.status !== "running") return false
    task.status = status
    task.endedAt = Date.now()
    if (exitCode !== undefined) task.exitCode = exitCode
    this.publish()
    return true
  }

  /** The speech paused or resumed: same list, new pause flag. Quiet before the first task. */
  publish() {
    if (this.tasks.size === 0) return
    this.emit({ type: "background", open: this.open, paused: this.paused(), tasks: [...this.tasks.values()].map((task) => ({ ...task })) })
  }
}

/** `exit code 7` in a Claude Code summary (task_notification carries no number of its own). */
export function exitCodeIn(text: string): number | undefined {
  const match = /exit code (-?\d+)/i.exec(text)
  return match ? Number(match[1]) : undefined
}

/**
 * A finished subagent's last words. Claude Code's task_notification `output_file` for an Agent is the subagent's own
 * transcript (JSONL): its last assistant text is the result the parent agent reads. Only the tail is read.
 */
export function subagentResult(path: string): string | undefined {
  if (!path) return undefined
  let tail: string
  let size = 0
  try {
    const fd = openSync(path, "r")
    try {
      size = fstatSync(fd).size
      const length = Math.min(size, SUBAGENT_TAIL_BYTES)
      const buffer = Buffer.alloc(length)
      readSync(fd, buffer, 0, length, size - length)
      tail = buffer.toString("utf8")
    } finally {
      closeSync(fd)
    }
  } catch {
    return undefined
  }
  const lines = tail.split("\n")
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let line: unknown
    try {
      line = JSON.parse(lines[index]!)
    } catch {
      // The tail cut this line: it may be the newest assistant text, so an older one would be the wrong answer.
      if (index === 0 && size > SUBAGENT_TAIL_BYTES) return undefined
      continue
    }
    const message = (line as { type?: unknown; message?: { content?: unknown } }).type === "assistant" ? (line as { message?: { content?: unknown } }).message : undefined
    const content = Array.isArray(message?.content) ? message.content : []
    const text = content
      .filter((block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n")
    if (text) return text
  }
  return undefined
}

const SUBAGENT_TAIL_BYTES = 512 * 1024
