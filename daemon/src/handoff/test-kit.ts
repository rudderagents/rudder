// Test doubles for session handoff: a fake Claude registry and transcripts in a temp dir, fake terminal processes
// (a pid table the probe reads, never a real process), and a "claude" adapter that writes the transcript the way
// Claude does: each live process keeps its own leaf and chains new records under it. Nothing here touches ~/.claude.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FAKE_SPEC } from "../adapter/fake"
import type { AgentAdapter } from "../adapter/types"
import { EventHub } from "../event-hub"
import type { Frame } from "../protocol"
import type { PushPayload } from "../push"
import { SessionService } from "../session-service"
import { Store } from "../store"
import type { ProcessProbe } from "./claude-registry"

export type FakeProc = { alive: boolean; start: string; quitsOnTerm: boolean }

/** The last record uuid in the file: where a freshly started Claude continues. */
export function lastUuid(path: string): string | null {
  if (!existsSync(path)) return null
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const record = JSON.parse(lines[index]!) as { uuid?: string }
      if (record.uuid) return record.uuid
    } catch {
      // skip
    }
  }
  return null
}

/** One writer of a transcript, like one Claude process: it remembers its own leaf. */
export class TranscriptWriter {
  leaf: string | null
  constructor(
    readonly path: string,
    readonly nativeId: string,
    readonly entrypoint: string,
    readonly cwd: string,
  ) {
    this.leaf = lastUuid(path)
  }

  private record(type: "user" | "assistant", content: unknown, extra: Record<string, unknown> = {}) {
    const uuid = crypto.randomUUID()
    const record = {
      parentUuid: this.leaf,
      isSidechain: false,
      type,
      uuid,
      timestamp: new Date().toISOString(),
      entrypoint: this.entrypoint,
      cwd: this.cwd,
      sessionId: this.nativeId,
      version: "2.1.312",
      message: type === "user" ? { role: "user", content } : { id: `msg-${uuid}`, role: "assistant", type: "message", content },
      ...extra,
    }
    appendFileSync(this.path, `${JSON.stringify(record)}\n`)
    this.leaf = uuid
    return uuid
  }

  turn(prompt: string, reply: string) {
    this.record("user", prompt, { origin: { kind: "human" } })
    this.record("assistant", [{ type: "text", text: reply }])
  }

  tool(command: string, output: string) {
    const id = `toolu-${crypto.randomUUID()}`
    this.record("assistant", [{ type: "tool_use", id, name: "Bash", input: { command, description: command } }])
    this.record("user", [{ type: "tool_result", tool_use_id: id, content: output, is_error: false }], {
      toolUseResult: { stdout: output, stderr: "", interrupted: false },
      permissionDecision: { decision: "accept", source: "user_temporary", grantScope: "once" },
    })
  }

  title(text: string) {
    appendFileSync(this.path, `${JSON.stringify({ type: "ai-title", aiTitle: text, sessionId: this.nativeId })}\n`)
  }
}

/** `agents`: more adapters beside the fake Claude (session handoff P2a / P3 tests); absent, the fake answers for every id. */
export function harness(options: { root?: string; probe?: ProcessProbe; claudeCommand?: string; agents?: AgentAdapter[]; followChunkBytes?: number } = {}) {
  const root = options.root ?? mkdtempSync(join(tmpdir(), "rudder-handoff-"))
  const registryDir = join(root, "claude", "sessions")
  const projectsDir = join(root, "claude", "projects")
  const cwd = join(root, "work", "demo")
  const project = join(projectsDir, "-work-demo")
  for (const dir of [registryDir, project, cwd]) mkdirSync(dir, { recursive: true })
  const procs = new Map<number, FakeProc>()
  const kills: Array<{ pid: number; signal: string }> = []
  let nextPid = 70_000
  const probe: ProcessProbe = options.probe ?? {
    alive: (pid) => procs.get(pid)?.alive === true,
    startTime: (pid) => (procs.get(pid)?.alive ? procs.get(pid)!.start : null),
  }
  const kill = (pid: number, signal: NodeJS.Signals) => {
    kills.push({ pid, signal })
    const proc = procs.get(pid)
    // A real child of the test (system probe): the signal really goes to it.
    if (!proc && options.probe) return void process.kill(pid, signal)
    if (!proc) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" })
    if (proc.quitsOnTerm && signal === "SIGTERM") {
      proc.alive = false
      rmSync(join(registryDir, `${pid}.json`), { force: true })
    }
  }
  const transcriptPath = (nativeId: string) => join(project, `${nativeId}.jsonl`)

  /** A `claude` in a terminal: a pid, a registry file, and a writer of its own. */
  function terminal(nativeId: string, options: { status?: string; quitsOnTerm?: boolean; entrypoint?: string } = {}) {
    const pid = nextPid++
    const start = `Sat Oct 31 0${pid % 9}:00:00 2026`
    procs.set(pid, { alive: true, start, quitsOnTerm: options.quitsOnTerm ?? true })
    const file = join(registryDir, `${pid}.json`)
    const write = (status: string) =>
      writeFileSync(
        file,
        JSON.stringify({ pid, sessionId: nativeId, cwd, startedAt: Date.now(), procStart: start, version: "2.1.312", kind: "interactive", entrypoint: options.entrypoint ?? "cli", status, updatedAt: Date.now(), statusUpdatedAt: Date.now() }),
      )
    write(options.status ?? "idle")
    const writer = new TranscriptWriter(transcriptPath(nativeId), nativeId, options.entrypoint ?? "cli", cwd)
    return {
      pid,
      writer,
      setStatus: write,
      exit() {
        procs.get(pid)!.alive = false
        rmSync(file, { force: true })
      },
    }
  }

  // The daemon's own claude: one fake process per session, created on the first turn (resume = load the leaf).
  const daemonProcs = new Map<string, { pid: number; writer: TranscriptWriter }>()
  let daemonPid = 90_000
  // Set to hold the next daemon turn open until it resolves (a turn that overlaps a terminal).
  const turnGate: { wait?: Promise<void>; release?: () => void } = {}
  const holdNextTurn = () => {
    turnGate.wait = new Promise((resolve) => {
      turnGate.release = resolve
    })
  }
  const adapter: AgentAdapter = {
    spec: { ...FAKE_SPEC, id: "claude", label: "Claude Code" },
    async reply(text, ctx) {
      const nativeId = ctx.nativeId ?? crypto.randomUUID()
      let proc = daemonProcs.get(ctx.sessionId)
      if (!proc) {
        proc = { pid: daemonPid++, writer: new TranscriptWriter(transcriptPath(nativeId), nativeId, "sdk-cli", cwd) }
        daemonProcs.set(ctx.sessionId, proc)
      }
      ctx.emit({ type: "native", nativeId })
      if (turnGate.wait) {
        const wait = turnGate.wait
        turnGate.wait = undefined
        await wait
      }
      const reply = `daemon heard: ${text}`
      proc.writer.turn(text, reply)
      ctx.emit({ type: "text", id: crypto.randomUUID(), text: reply })
    },
    processes: () => [...daemonProcs.entries()].map(([sessionId, proc]) => ({ agent: "claude", pid: proc.pid, sessionIds: [sessionId], shared: false })),
    release: (sessionId) => void daemonProcs.delete(sessionId),
    forget: (sessionId) => void daemonProcs.delete(sessionId),
  }

  const store = new Store(join(root, "rudder.sqlite"))
  const frames: Frame[] = []
  // Every lock-screen notice the service hands the gateway (v67 A3b: takeover and release send none).
  const pushes: PushPayload[] = []
  const hub = new EventHub(store, { holdMs: 0 })
  const extra = options.agents ?? []
  const adapters = extra.length
    ? { get: (id: string) => (id === "claude" ? adapter : extra.find((entry) => entry.spec.id === id)), list: () => [adapter, ...extra] }
    : adapter
  const service = new SessionService(store, adapters, (frame) => {
    frames.push(frame)
    hub.publish(frame)
  }, {
    workspaceRoot: root,
    push: (payload) => pushes.push(payload),
    handoff: { registryDir, projectsDir, probe, kill, pollMs: 60_000, exitWaitMs: 300, claudeCommand: options.claudeCommand ?? "claude", followChunkBytes: options.followChunkBytes },
  })
  const call = async (method: string, params: Record<string, unknown> = {}) => {
    const frame = await service.invoke(method, params, crypto.randomUUID())
    return frame
  }
  const ok = async <T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    const frame = await call(method, params)
    if (frame.type !== "result") throw new Error(`${method} failed: ${JSON.stringify(frame.error)}`)
    return frame.result as T
  }
  return {
    root,
    cwd,
    registryDir,
    projectsDir,
    project,
    procs,
    kills,
    store,
    frames,
    pushes,
    service,
    adapter,
    daemonProcs,
    terminal,
    transcriptPath,
    call,
    ok,
    handoff: service.handoff!,
    hub,
    holdNextTurn,
    releaseTurn: () => turnGate.release?.(),
    async close() {
      await service.shutdown(10)
      hub.close()
      store.db.close()
    },
    async cleanup() {
      await service.shutdown(10)
      hub.close()
      store.db.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

export async function waitFor(predicate: () => boolean, timeoutMs = 2000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out")
    await Bun.sleep(10)
  }
}

/** Every user / assistant record chains to the one before it: one writer at a time, no interleaved branch. */
export function linearChain(path: string): { ok: boolean; records: number; forks: string[] } {
  const records = readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { uuid?: string; parentUuid?: string | null })
    .filter((record) => record.uuid)
  const forks: string[] = []
  records.forEach((record, index) => {
    const expected = index === 0 ? null : records[index - 1]!.uuid
    if ((record.parentUuid ?? null) !== expected) forks.push(record.uuid!)
  })
  return { ok: forks.length === 0, records: records.length, forks }
}
