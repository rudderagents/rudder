// Claude Code's live-process registry: every running `claude` writes ~/.claude/sessions/<pid>.json
// ({pid, sessionId, cwd, status, entrypoint, procStart, …}). Only that JSON is read; the
// messaging socket and peer protocol it names are private to Claude and never touched.
import { spawnSync } from "node:child_process"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { isObject, num, str } from "../adapter/json"

export type RegistryEntry = {
  pid: number
  sessionId: string
  cwd: string
  /** `idle` as Claude writes it; every other value (busy, shell, …) means a turn or a command is running. */
  status: "busy" | "idle"
  entrypoint: string
  procStart: string
  version: string
  /** When `status` last changed, ms. */
  since: number
  file: string
}

/** How a pid is checked. Tests pass their own; the system one asks the kernel and `ps`. */
export type ProcessProbe = {
  alive(pid: number): boolean
  /** The process's start time as `ps -o lstart=` prints it, whitespace collapsed; null when unknown. */
  startTime(pid: number): string | null
  /** Looks up several start times in one `ps` off the event loop, so `startTime` answers from memory. Optional. */
  prefetch?(pids: readonly number[]): Promise<void>
}

const collapse = (text: string) => text.trim().replace(/\s+/g, " ")

/** Reads `ps -o pid=,lstart=` output: one `<pid> <start time>` per line. */
export function parsePsStarts(stdout: string): Map<number, string> {
  const starts = new Map<number, string>()
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line)
    if (match) starts.set(Number(match[1]), collapse(match[2] ?? ""))
  }
  return starts
}

const psSync = (pid: number): string | null => {
  const run = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 })
  return run.status === 0 ? (run.stdout ?? "") : null
}

const psBatch = async (pids: readonly number[]): Promise<string> => {
  try {
    const child = Bun.spawn(["ps", "-o", "pid=,lstart=", "-p", pids.join(",")], { stdout: "pipe", stderr: "ignore" })
    const timer = setTimeout(() => child.kill(), 2000)
    try {
      return await new Response(child.stdout).text()
    } finally {
      clearTimeout(timer)
    }
  } catch {
    // No `ps` (Windows): nothing prefetched, `startTime` falls back to the synchronous check.
    return ""
  }
}

export function systemProbe(run: { sync: (pid: number) => string | null; batch: (pids: readonly number[]) => Promise<string> } = { sync: psSync, batch: psBatch }): ProcessProbe {
  // A pid's start time never changes while it lives; ask `ps` once per pid.
  const starts = new Map<number, string>()
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      // ESRCH: gone. EPERM: another user's process, so not the Claude this user's registry names.
      return false
    }
  }
  return {
    alive(pid) {
      const yes = alive(pid)
      if (!yes) starts.delete(pid)
      return yes
    },
    startTime(pid) {
      const known = starts.get(pid)
      if (known) return known
      const start = collapse(run.sync(pid) ?? "")
      if (!start) return null
      starts.set(pid, start)
      return start
    },
    async prefetch(pids) {
      // Dead pids (a registry file left by a crashed Claude) would have `ps` spawned for them every poll.
      const unknown = pids.filter((pid) => !starts.has(pid) && alive(pid))
      if (unknown.length === 0) return
      for (const [pid, start] of parsePsStarts(await run.batch(unknown))) if (unknown.includes(pid) && start) starts.set(pid, start)
    },
  }
}

/** Pids named by the registry's files (through the parse cache), minus `exclude`; what the poll prefetches. */
export function registryPids(dir: string, exclude: ReadonlySet<number> = new Set()): number[] {
  let names: string[]
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json"))
  } catch {
    return []
  }
  const pids: number[] = []
  for (const name of names) {
    try {
      const value = readJsonCached(join(dir, name))
      const pid = isObject(value) ? num(value.pid) : undefined
      if (pid !== undefined && Number.isSafeInteger(pid) && pid > 1 && !exclude.has(pid)) pids.push(pid)
    } catch {
      // Unreadable file: readRegistry skips it too.
    }
  }
  return pids
}

/**
 * Registry entries whose process is alive and is the one that wrote the file: `procStart` must match the pid's
 * start time, or a recycled pid would pass. Pids in `exclude` (the daemon's own children) are left out.
 */
// Parsed registry files by path, kept while their inode, size and times stay: the poll stats each file instead of reading
// and parsing all of them every 2 s.
const parsedFiles = new Map<string, { key: string; value: unknown }>()

function readJsonCached(file: string): unknown {
  const stat = statSync(file)
  // "busy" and "idle" are the same length: size alone would miss a status change, so the inode and both times count.
  const key = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
  const known = parsedFiles.get(file)
  if (known?.key === key) return known.value
  const value: unknown = JSON.parse(readFileSync(file, "utf8"))
  parsedFiles.set(file, { key, value })
  return value
}

export function readRegistry(dir: string, probe: ProcessProbe, exclude: ReadonlySet<number> = new Set()): RegistryEntry[] {
  let names: string[]
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json"))
  } catch {
    return []
  }
  const present = new Set(names.map((name) => join(dir, name)))
  for (const file of parsedFiles.keys()) if (dirname(file) === dir && !present.has(file)) parsedFiles.delete(file)
  const entries: RegistryEntry[] = []
  for (const name of names) {
    const file = join(dir, name)
    let value: unknown
    try {
      value = readJsonCached(file)
    } catch {
      continue
    }
    if (!isObject(value)) continue
    const pid = num(value.pid)
    const sessionId = str(value.sessionId)
    if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 1 || !sessionId || exclude.has(pid)) continue
    if (!probe.alive(pid)) continue
    const procStart = collapse(str(value.procStart))
    if (!procStart || probe.startTime(pid) !== procStart) continue
    entries.push({
      pid,
      sessionId,
      cwd: str(value.cwd),
      status: str(value.status) === "idle" ? "idle" : "busy",
      entrypoint: str(value.entrypoint),
      procStart,
      version: str(value.version),
      since: num(value.statusUpdatedAt) ?? num(value.updatedAt) ?? num(value.startedAt) ?? Date.now(),
      file,
    })
  }
  return entries
}

/** Terminal sessions only: the daemon's own `claude -p` and other SDK clients say `sdk-*`. */
export function terminalEntries(entries: RegistryEntry[]): RegistryEntry[] {
  return entries.filter((entry) => entry.entrypoint === "cli")
}
