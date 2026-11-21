// Finds recent terminal Claude transcripts under ~/.claude/projects without reading whole files: the head names the
// session (cwd, version, entrypoint, first prompt), the tail its title and last line.
import { readdirSync, statSync } from "node:fs"
import { open, readdir, stat } from "node:fs/promises"
import { basename, join } from "node:path"
import { isObject, isString, obj, str, type Json } from "../adapter/json"
import { previewText } from "../store"
import { isSlashCommand, readableCommand } from "../session-title"
import { userText } from "./claude-transcript"

export type ScannedTranscript = {
  nativeId: string
  path: string
  mtime: number
  size: number
  cwd: string
  title: string
  preview?: string
  version: string
  entrypoint: string
  importable: boolean
  reason?: string
}

const HEAD_BYTES = 256 * 1024
const TAIL_BYTES = 64 * 1024
export const SCAN_DAYS = 14
export const SCAN_LIMIT = 50
// Record types seen in Claude Code 2.1.x transcripts; anything else in a file without a single
// readable turn means the format changed.
const KNOWN_TYPES = new Set([
  "user", "assistant", "system", "attachment", "ai-title", "last-prompt", "summary", "custom-title", "permission-mode", "mode",
  "file-history-snapshot", "file-history-delta", "queue-operation", "bridge-session", "api-request", "api-request-blob",
  "api-request-shape", "atis-latch", "cost-state", "tools-used",
])
const SESSION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i

async function readSlice(path: string, start: number, length: number): Promise<string> {
  const handle = await open(path, "r")
  try {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, start)
    return buffer.subarray(0, bytesRead).toString("utf8")
  } finally {
    await handle.close()
  }
}

function records(text: string, dropFirst: boolean): Json[] {
  const lines = text.split("\n")
  // A slice starting mid-file begins inside a line; a slice ending mid-file ends inside one.
  if (dropFirst) lines.shift()
  const out: Json[] = []
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const value: unknown = JSON.parse(line)
      if (isObject(value)) out.push(value)
    } catch {
      // A cut line or a broken one.
    }
  }
  return out
}

function textOf(record: Json): string {
  const content = obj(record.message).content
  if (isString(content)) return content
  return (Array.isArray(content) ? content : [])
    .filter(isObject)
    .filter((block) => block.type === "text")
    .map((block) => str(block.text))
    .join("\n")
}

const isTurn = (record: Json) => (record.type === "user" || record.type === "assistant") && isObject(record.message) && isString(record.uuid)
function isPrompt(record: Json): boolean {
  if (record.type !== "user" || record.isMeta === true || record.isCompactSummary === true) return false
  const origin = obj(record.origin).kind
  if (origin !== undefined && origin !== "human") return false
  const content = obj(record.message).content
  return !(Array.isArray(content) && content.some((block) => isObject(block) && block.type === "tool_result"))
}

/** Head and tail of one transcript. */
export async function inspectTranscript(path: string): Promise<ScannedTranscript> {
  const info = await stat(path)
  const head = records(await readSlice(path, 0, Math.min(HEAD_BYTES, info.size)), false)
  const tailStart = Math.max(0, info.size - TAIL_BYTES)
  const tail = tailStart === 0 ? head : records(await readSlice(path, tailStart, info.size - tailStart), true)
  const first = head.find((record) => isTurn(record) && record.isSidechain !== true)
  const prompts = head.filter((record) => isTurn(record) && record.isSidechain !== true && isPrompt(record)).map((record) => userText(textOf(record))).filter((text) => text !== "")
  // 11-19: a session opened with a slash command is named by its first ordinary prompt, else by the command read.
  const prompt = prompts.find((text) => !isSlashCommand(text)) ?? (prompts[0] !== undefined ? readableCommand(prompts[0]) : undefined)
  const titled = [...tail].reverse().find((record) => record.type === "ai-title" && str(record.aiTitle))
    ?? [...head].reverse().find((record) => record.type === "ai-title" && str(record.aiTitle))
  const lastText = [...tail]
    .reverse()
    .find((record) => isTurn(record) && record.isSidechain !== true && (record.type === "assistant" || isPrompt(record)) && userText(textOf(record)))
  const nativeId = basename(path, ".jsonl")
  const base: ScannedTranscript = {
    nativeId,
    path,
    mtime: info.mtimeMs,
    size: info.size,
    cwd: first ? str(first.cwd) : "",
    title: str(titled?.aiTitle) || previewText(prompt ?? "") || nativeId.slice(0, 8),
    ...(lastText ? { preview: previewText(userText(textOf(lastText))) } : {}),
    version: first ? str(first.version) : str(head.find((record) => str(record.version))?.version),
    entrypoint: first ? str(first.entrypoint) : "",
    importable: true,
  }
  // Records but none this parser knows: the format moved on. A file of only bookkeeping lines (a session that never
  // got a prompt) is just skipped.
  if (!first && head.length > 0) {
    const shapeless = head.some((record) => (record.type === "user" || record.type === "assistant") && !isTurn(record))
    const unknown = head.some((record) => !KNOWN_TYPES.has(str(record.type)))
    if (shapeless || unknown) return { ...base, entrypoint: "cli", importable: false, reason: "unsupported_format" }
  }
  return base
}

// `<projects>/<any project folder>/<nativeId>.jsonl`, or null.
export function findTranscript(projectsDir: string, nativeId: string): string | null {
  let dirs: string[]
  try {
    dirs = readdirSync(projectsDir)
  } catch {
    return null
  }
  for (const dir of dirs) {
    const path = join(projectsDir, dir, `${nativeId}.jsonl`)
    try {
      if (statSync(path).isFile()) return path
    } catch {
      // Not in this project folder.
    }
  }
  return null
}

/**
 * perf-1112 round two (R6): a project folder whose own mtime has not moved (no transcript added or removed) is not
 * listed again, and its transcripts already older than the window are not stat'ed again (8,828 files: 24 ms a scan).
 * Recent ones are, since appending moves a file's mtime but not its folder's. An old session resumed in a terminal
 * shows within this long (a live one at once: `include`).
 */
export const SCAN_FOLDER_REFRESH_MS = 10 * 60_000

/** Recent terminal transcripts, newest first; results are cached by path, size and mtime. */
export class TranscriptScanner {
  private readonly cache = new Map<string, ScannedTranscript>()
  // Per project folder: its mtime when listed, when that was, and each transcript's mtime then.
  private readonly folders = new Map<string, { mtime: number; at: number; files: Map<string, number> }>()

  // Concurrent inspects of one path share a single read.
  private readonly inflight = new Map<string, Promise<ScannedTranscript>>()

  constructor(
    private readonly projectsDir: string,
    private readonly refreshMs = SCAN_FOLDER_REFRESH_MS,
    private readonly read: (path: string) => Promise<ScannedTranscript> = inspectTranscript,
  ) {}

  async available(): Promise<boolean> {
    try {
      return (await stat(this.projectsDir)).isDirectory()
    } catch {
      return false
    }
  }

  async inspect(path: string): Promise<ScannedTranscript> {
    const info = await stat(path)
    const cached = this.cache.get(path)
    if (cached && cached.size === info.size && cached.mtime === info.mtimeMs) return cached
    const pending = this.inflight.get(path)
    if (pending) return pending
    const reading = this.read(path).then((fresh) => {
      this.cache.set(path, fresh)
      return fresh
    })
    this.inflight.set(path, reading)
    try {
      return await reading
    } finally {
      this.inflight.delete(path)
    }
  }

  async scan(options: { now?: number; days?: number; limit?: number; include?: ReadonlySet<string> } = {}): Promise<ScannedTranscript[]> {
    const now = options.now ?? Date.now()
    const oldest = now - (options.days ?? SCAN_DAYS) * 24 * 60 * 60 * 1000
    const limit = options.limit ?? SCAN_LIMIT
    const files: { path: string; mtime: number }[] = []
    let dirs: string[] = []
    try {
      dirs = await readdir(this.projectsDir)
    } catch {
      return []
    }
    const listed = new Set(dirs)
    for (const dir of this.folders.keys()) if (!listed.has(dir)) this.folders.delete(dir)
    for (const dir of dirs) {
      const folder = join(this.projectsDir, dir)
      let mtime: number
      try {
        mtime = (await stat(folder)).mtimeMs
      } catch {
        continue
      }
      let known = this.folders.get(dir)
      if (!known || known.mtime !== mtime || now - known.at >= this.refreshMs) {
        let names: string[]
        try {
          names = await readdir(folder)
        } catch {
          this.folders.delete(dir)
          continue
        }
        known = { mtime, at: now, files: new Map(names.filter((name) => SESSION_FILE.test(name)).map((name) => [name, Number.NaN])) }
        this.folders.set(dir, known)
      }
      for (const [name, seen] of known.files) {
        const wanted = options.include?.has(basename(name, ".jsonl")) === true
        // Old when last stat'ed and the folder unchanged since: still old (see SCAN_FOLDER_REFRESH_MS).
        if (seen < oldest && !wanted) continue
        const path = join(folder, name)
        try {
          const info = await stat(path)
          known.files.set(name, info.mtimeMs)
          if (info.isFile() && (info.mtimeMs >= oldest || wanted)) files.push({ path, mtime: info.mtimeMs })
        } catch {
          // Removed while listing.
          known.files.delete(name)
        }
      }
    }
    files.sort((a, b) => b.mtime - a.mtime)
    const out: ScannedTranscript[] = []
    for (const file of files) {
      if (out.length >= limit) break
      let entry: ScannedTranscript
      try {
        entry = await this.inspect(file.path)
      } catch {
        continue
      }
      // The daemon's own sessions and other SDK clients (sdk-cli, sdk-ts) are not the user's terminal sessions.
      if (entry.importable && entry.entrypoint !== "cli") continue
      out.push(entry)
    }
    return out
  }
}
