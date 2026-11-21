// Session handoff between a terminal Claude and the phone (the session handoff notes, P1: Claude), and
// computer → phone import of Codex threads (P2a) and ACP sessions (P3) through their adapters (listExternal /
// readExternal). Holder, takeover, release and attach stay Claude-only.
// One writer per Claude session at any time: the daemon's adapter, a terminal `claude`, or nobody. The holder is
// computed from the daemon's own state plus Claude's live registry each time it is needed; only `rudder attach`
// leases live in memory. Ending a terminal process is the one place Rudder stops a process it did not start, and only
// the registry's pid whose start time still matches, after the phone confirmed, with SIGTERM and never SIGKILL.
import { AUTO_TITLE_AGENT, shortTitle } from "../session-title"
import { createHash, randomBytes } from "node:crypto"
import { homedir } from "node:os"
import { basename } from "node:path"
import { existsSync, statSync, watch, type FSWatcher } from "node:fs"
import { open, readFile, stat } from "node:fs/promises"
import { HandoffUnsupported, type AgentAdapter, type ExternalSession, type RudderPermissionMode } from "../adapter/types"
import type { Broadcaster } from "../session-service"
import { eventFrame, type Frame } from "../protocol"
import { messagePublic, type MessageRow, type SessionRow, type Store } from "../store"
import { readRegistry, registryPids, systemProbe, terminalEntries, type ProcessProbe, type RegistryEntry } from "./claude-registry"
import { findTranscript, SCAN_DAYS, SCAN_LIMIT, TranscriptScanner, type ScannedTranscript } from "./claude-scan"
import {
  ClaudeMapper,
  dividerRow,
  type HandoffSide,
  type ImportedRow,
  parseRecords,
  readTranscript,
  recentStart,
  splitLines,
  type TranscriptRead,
} from "./claude-transcript"
import { historyRows } from "./history"

export type HolderKind = "rudder" | "terminal" | "none"

/** `session.holder` (§5). No pid: the phone never needs one. */
export type Holder = {
  kind: HolderKind
  status?: "busy" | "idle"
  since: number
  /** `handoff.takeover {when: "afterTurn"}` is waiting for the terminal's turn to end. */
  pendingTakeover?: true
  /** The terminal did not quit within the wait; cleared by a retry or cancelTakeover. */
  takeoverFailed?: true
  /** Rudder is running a turn while the terminal opened the same session. */
  conflict?: true
  /** Claimed by `rudder attach`. */
  via?: "attach"
}

/** What SessionService lends the handoff module. */
export type HandoffHost = {
  store: Store
  broadcast: Broadcaster
  publicSession(id: string): unknown
  isGenerating(id: string): boolean
  /** Pids of agent processes the daemon started; their registry entries are the daemon's own. */
  daemonPids(): Set<number>
  /** Sessions with a process or an in-flight turn, for discovering holders without scanning history. */
  activeSessions(): Iterable<string>
  /** The adapter keeps a process for this session (idle or running). */
  hasAgentProcess(id: string): boolean
  /** Stops the adapter's process for this session and keeps its native id (`AgentAdapter.release`). */
  releaseAgent(session: SessionRow): void
  stopTurn(id: string): Promise<void>
  /** The terminal gave the session back: queued sends and scheduled ones may go now. */
  holderReleased(id: string): void
  /** Whether a turn may run in `cwd`: inside the workspace and no hidden folder on the way (`resolveSafe`, v57 C). */
  writable(cwd: string): boolean
  /** The adapter that runs `agent`: P2a / P3 list and read that agent's own sessions through it. */
  adapter(agent: string): AgentAdapter | undefined
  /** Every agent id the daemon runs. */
  agents(): string[]
  /** An imported session's starting mode: "ask", or what stands for it on that agent (Grok: autoApproval). */
  permissionMode(agent: string): RudderPermissionMode
}

export type HandoffOptions = {
  /** ~/.claude/sessions */
  registryDir: string
  /** ~/.claude/projects */
  projectsDir: string
  probe?: ProcessProbe
  /** Only ever called with a registry pid whose start time was just checked. */
  kill?: (pid: number, signal: NodeJS.Signals) => void
  pollMs?: number
  /** How long a SIGTERM'd terminal Claude gets to quit (§3.2: 5 s). */
  exitWaitMs?: number
  /** argv[0] for the commands `handoff.release` and `rudder attach` print and run. */
  claudeCommand?: string
  /** Most bytes one `follow` pass reads and commits at a time. */
  followChunkBytes?: number
}

type Cursor = { path?: string; offset?: number; earlier?: number; title?: string }

/** What a `handoff.list` ref stands for. Claude refs carry the transcript path; the others what the agent listed. */
type RefTarget = { agent: string; nativeId: string; path?: string; cwd?: string; title?: string; updatedAt?: number; inUse?: boolean }

const DAY_MS = 24 * 60 * 60 * 1000
/** One agent's listExternal may take this long before handoff.list answers without it (`unavailable`). */
const LIST_TIMEOUT_MS = 20_000
/** History read for the inspect → import pair, kept this long. */
const HISTORY_TTL_MS = 10 * 60_000
/** `closing`: attachDone is reading the terminal's last lines; the lease still holds the session until it finishes. */
type Lease = { sessionId: string; pid: number; since: number; added: number; closing?: Promise<unknown> }

const REGISTRY_TTL_MS = 1000
// Imported rows start at this seq: 1 is the 「更早的」 marker, 2 the first divider.
const ROW_SEQ = 3
/** Parsed transcripts kept for the inspect → import pair; each can hold a long session's rows. */
const TRANSCRIPT_CACHE_FILES = 2

/** 「更早的 N 条留在电脑上 · 点按取一页」 as a timeline row; count 0 once every page has come over (the phone hides it). */
// created_at 0: the phone draws no day chip above it (the chip belongs to the divider under it).
function earlierRow(sessionId: string, count: number) {
  return {
    id: `handoff:earlier:${sessionId}`,
    kind: "handoff",
    role: "assistant",
    text: `更早的 ${count} 条留在电脑上`,
    payload: JSON.stringify({ handoff: "earlier", count }),
    createdAt: 0,
  }
}
const FOLLOW_CHUNK_BYTES = 512 * 1024

export class HandoffError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
  }
}

const parseCursor = (raw: string | null | undefined): Cursor => {
  if (!raw) return {}
  try {
    const value = JSON.parse(raw) as Cursor
    return typeof value === "object" && value ? value : {}
  } catch {
    return {}
  }
}

async function readFrom(path: string, offset: number, max: number): Promise<string> {
  const handle = await open(path, "r")
  try {
    const size = (await handle.stat()).size
    const length = Math.max(0, Math.min(max, size - offset))
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, offset)
    return buffer.subarray(0, bytesRead).toString("utf8")
  } finally {
    await handle.close()
  }
}

const isImported = (row: MessageRow | null) => {
  if (!row?.payload) return false
  if (row.kind === "handoff") return row.payload.includes('"terminal"')
  return row.payload.includes('"imported":true')
}

export class Handoff {
  private readonly probe: ProcessProbe
  private readonly kill: (pid: number, signal: NodeJS.Signals) => void
  private readonly scanner: TranscriptScanner
  // Kept in the db so a ref survives a restart: the phone remembers dismissed tips by it.
  private readonly secret: string
  private readonly refs = new Map<string, RefTarget>()
  private readonly histories = new Map<string, { at: number; rows: ImportedRow[] }>()
  private readonly leases = new Map<string, Lease>()
  private readonly pending = new Map<string, number>()
  private readonly failed = new Set<string>()
  private readonly running = new Set<string>()
  private readonly following = new Map<string, Promise<number>>()
  private readonly mappers = new Map<string, ClaudeMapper>()
  private readonly published = new Map<string, string>()
  private readonly reads = new Map<string, { size: number; mtime: number; read: TranscriptRead & { consumed: number } }>()
  private snapshot: { at: number; byNative: Map<string, RegistryEntry> } | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private watcher: FSWatcher | undefined
  private ticking: Promise<void> | undefined

  constructor(
    private readonly host: HandoffHost,
    private readonly options: HandoffOptions,
  ) {
    this.probe = options.probe ?? systemProbe()
    this.kill = options.kill ?? ((pid, signal) => process.kill(pid, signal))
    this.scanner = new TranscriptScanner(options.projectsDir)
    const stored = host.store.getMeta("handoff_ref_secret")
    this.secret = stored ?? randomBytes(16).toString("hex")
    if (!stored) host.store.setMeta("handoff_ref_secret", this.secret)
  }

  get claudeCommand(): string {
    return this.options.claudeCommand ?? process.env.RUDDER_CLAUDE_BIN ?? "claude"
  }

  start() {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), this.options.pollMs ?? 2000)
    this.timer.unref?.()
    try {
      this.watcher = watch(this.options.registryDir, () => void this.tick())
      this.watcher.unref?.()
    } catch {
      // No registry folder yet (Claude never ran): the poll still notices when it appears.
    }
  }

  /** Stops polling; resolves once the tick and the follows already running have finished. */
  async stop(): Promise<void> {
    clearInterval(this.timer)
    this.timer = undefined
    this.watcher?.close()
    this.watcher = undefined
    await Promise.allSettled([this.ticking, ...this.following.values()])
  }

  // ---------- holder ----------

  /** Terminal Claude processes by session id; cached briefly so a session.list does not read the folder per row. */
  private registry(fresh = false): Map<string, RegistryEntry> {
    const now = Date.now()
    if (!fresh && this.snapshot && now - this.snapshot.at < REGISTRY_TTL_MS) return this.snapshot.byNative
    const entries = terminalEntries(readRegistry(this.options.registryDir, this.probe, this.host.daemonPids()))
    const byNative = new Map(entries.map((entry) => [entry.sessionId, entry]))
    this.snapshot = { at: now, byNative }
    return byNative
  }

  private terminalOf(row: SessionRow, fresh = false): RegistryEntry | undefined {
    return row.agent === "claude" && row.native_id ? this.registry(fresh).get(row.native_id) : undefined
  }

  holder(row: SessionRow, fresh = false): Holder {
    const lease = this.leases.get(row.id)
    const entry = this.terminalOf(row, fresh)
    const now = Date.now()
    if (this.host.isGenerating(row.id)) return { kind: "rudder", since: now, ...(entry || lease ? { conflict: true as const } : {}) }
    if (lease || entry) {
      return {
        kind: "terminal",
        status: entry?.status ?? "idle",
        since: entry?.since ?? lease?.since ?? now,
        ...(this.pending.has(row.id) ? { pendingTakeover: true as const } : {}),
        ...(this.failed.has(row.id) ? { takeoverFailed: true as const } : {}),
        ...(lease ? { via: "attach" as const } : {}),
      }
    }
    if (this.host.hasAgentProcess(row.id)) return { kind: "rudder", since: now }
    return { kind: "none", since: now }
  }

  /** The `session` fields this module adds: `holder`, and the count still on the computer. */
  publicFields(row: SessionRow): Record<string, unknown> {
    const cursor = parseCursor(row.import_cursor)
    return {
      holder: this.holder(row),
      ...(cursor.earlier ? { importedEarlier: cursor.earlier } : {}),
      // a session brought over from a folder Rudder cannot write to is view-only on the phone.
      ...(row.origin === "terminal" ? { writable: this.host.writable(row.cwd) } : {}),
    }
  }

  /** Reads the registry afresh: a write must not slip through a cached "nobody". */
  heldElsewhere(sessionId: string): boolean {
    const row = this.host.store.getSession(sessionId)
    return row ? this.holder(row, true).kind === "terminal" : false
  }

  /** Throws `held_elsewhere` while a terminal holds the session (§2 rule 2). */
  gate(sessionId: string) {
    if (this.heldElsewhere(sessionId)) {
      throw Object.assign(new Error("this session is in use in a terminal on this computer"), { code: "held_elsewhere" })
    }
  }

  // ---------- list / inspect / import ----------

  private refKey(agent: string, nativeId: string): string {
    return createHash("sha256").update(`${this.secret}:${agent}:${nativeId}`).digest("hex").slice(0, 32)
  }

  private refFor(nativeId: string, path: string): string {
    const ref = this.refKey("claude", nativeId)
    this.refs.set(ref, { agent: "claude", nativeId, path })
    return ref
  }

  /**
   * Old phones send nothing and get exactly the 1.0 Claude list (their screens say Claude everywhere). New phones send
   * `agents: "all"`, or name one agent in `agent`, and get every agent's sessions (P2a / P3).
   */
  async list(params: Record<string, unknown>) {
    const named = typeof params.agent === "string" ? params.agent : undefined
    if (params.agents === "all" || (named !== undefined && named !== "claude")) return this.listAll(params, named)
    return this.listClaude(params)
  }

  private async listClaude(params: Record<string, unknown>) {
    const limit = typeof params.limit === "number" && params.limit > 0 ? Math.min(50, Math.floor(params.limit)) : undefined
    if (params.agent !== undefined && params.agent !== "claude") return { entries: [], unsupported: [{ agent: String(params.agent), reason: "later" }] }
    if (!(await this.scanner.available())) return { entries: [], unsupported: [{ agent: "claude", reason: "not_installed" }] }
    const live = this.registry(true)
    const scanned = await this.scanner.scan({ limit, include: new Set(live.keys()) })
    const seen = new Set(scanned.map((entry) => entry.nativeId))
    // A running terminal session whose file is older than the window (or past the limit) still belongs on top.
    for (const nativeId of live.keys()) {
      if (seen.has(nativeId)) continue
      const path = findTranscript(this.options.projectsDir, nativeId)
      if (!path) continue
      try {
        scanned.unshift(await this.scanner.inspect(path))
      } catch {
        // Removed meanwhile.
      }
    }
    const cwd = typeof params.cwd === "string" && params.cwd ? params.cwd : undefined
    const entries = scanned
      .filter((entry) => !cwd || entry.cwd === cwd)
      .map((entry) => this.entry(entry, live.get(entry.nativeId)))
    return { entries, unsupported: [] }
  }

  private entry(scanned: ScannedTranscript, live: RegistryEntry | undefined) {
    const existing = this.host.store.findByNative("claude", scanned.nativeId)
    return {
      ref: this.refFor(scanned.nativeId, scanned.path),
      agent: "claude",
      title: scanned.title,
      cwd: scanned.cwd,
      updatedAt: Math.round(scanned.mtime),
      ...(scanned.preview ? { preview: scanned.preview } : {}),
      live: live ? { status: live.status, since: live.since } : null,
      ...(existing ? { sessionId: existing.id } : {}),
      importable: scanned.importable,
      writable: this.host.writable(scanned.cwd),
      ...(scanned.reason ? { reason: scanned.reason } : {}),
      ...(scanned.version ? { version: scanned.version } : {}),
    }
  }

  private async listAll(params: Record<string, unknown>, only: string | undefined) {
    const limit = typeof params.limit === "number" && params.limit > 0 ? Math.min(SCAN_LIMIT, Math.floor(params.limit)) : SCAN_LIMIT
    const cwd = typeof params.cwd === "string" && params.cwd ? params.cwd : undefined
    const known = this.host.agents()
    const agents = only ? [only] : known
    const found = await Promise.all(
      agents.map(async (agent): Promise<{ entries: Array<Record<string, unknown>>; unsupported: Array<{ agent: string; reason: string }> }> => {
        if (agent === "claude") return this.listClaude({ ...params, agent: undefined })
        const adapter = known.includes(agent) ? this.host.adapter(agent) : undefined
        if (!adapter) return { entries: [], unsupported: [{ agent, reason: "not_installed" }] }
        if (!adapter.listExternal) return { entries: [], unsupported: [{ agent, reason: "no_session_list" }] }
        try {
          const sessions = await withTimeout(adapter.listExternal({ since: Date.now() - SCAN_DAYS * DAY_MS, limit }), LIST_TIMEOUT_MS)
          const entries = sessions.flatMap((session) => this.externalEntry(agent, adapter, session))
          return { entries: cwd ? entries.filter((entry) => entry.cwd === cwd) : entries, unsupported: [] }
        } catch (error) {
          if (error instanceof HandoffUnsupported) return { entries: [], unsupported: [{ agent, reason: error.reason }] }
          console.warn(`rudderd: handoff.list for ${agent} failed:`, error instanceof Error ? error.message : error)
          return { entries: [], unsupported: [{ agent, reason: "unavailable" }] }
        }
      }),
    )
    const entries = found.flatMap((part) => part.entries)
    // A running terminal Claude first (as in the Claude list), then newest first across agents.
    const order = (entry: Record<string, unknown>) => (entry.live ? 1 : 0)
    entries.sort((a, b) => order(b) - order(a) || Number(b.updatedAt) - Number(a.updatedAt))
    return { entries, unsupported: found.flatMap((part) => part.unsupported) }
  }

  /** A Codex thread or ACP session as a list entry; none for one that started in Rudder (it is a Rudder session). */
  private externalEntry(agent: string, adapter: AgentAdapter, session: ExternalSession): Array<Record<string, unknown>> {
    const existing = this.host.store.findByNative(agent, session.nativeId)
    if (existing && existing.origin !== "terminal") return []
    const ref = this.refKey(agent, session.nativeId)
    const title = session.title || session.preview?.split("\n")[0]?.trim() || basename(session.cwd) || session.nativeId
    this.refs.set(ref, { agent, nativeId: session.nativeId, cwd: session.cwd, title, updatedAt: session.updatedAt, ...(session.inUse ? { inUse: true } : {}) })
    return [
      {
        ref,
        agent,
        title,
        cwd: session.cwd,
        updatedAt: Math.round(session.updatedAt),
        ...(session.preview ? { preview: session.preview } : {}),
        live: null,
        ...(existing ? { sessionId: existing.id } : {}),
        importable: !session.inUse,
        writable: this.host.writable(session.cwd),
        ...(session.inUse ? { reason: "in_use" } : {}),
        // ACP says nothing about who has a session open: the phone asks to close it on the computer first.
        ...(adapter.spec.transport === "acp" ? { closeFirst: true } : {}),
      },
    ]
  }

  private target(ref: unknown): RefTarget & { ref: string } {
    const found = typeof ref === "string" ? this.refs.get(ref) : undefined
    if (!found) throw new HandoffError("unknown or expired ref; list again", "not_found")
    return { ...found, ref: ref as string }
  }

  private resolveRef(ref: unknown): { nativeId: string; path: string } {
    const found = typeof ref === "string" ? this.refs.get(ref) : undefined
    if (!found?.path || !existsSync(found.path)) throw new HandoffError("unknown or expired ref; list again", "not_found")
    return { nativeId: found.nativeId, path: found.path }
  }

  /** A non-Claude session's history as rows, read through its adapter; kept briefly for the inspect → import pair. */
  private async externalRows(target: RefTarget & { ref: string }): Promise<ImportedRow[]> {
    const now = Date.now()
    for (const [key, cached] of this.histories) if (now - cached.at > HISTORY_TTL_MS) this.histories.delete(key)
    const cached = this.histories.get(target.ref)
    if (cached) return cached.rows
    const adapter = this.host.adapter(target.agent)
    if (!adapter?.readExternal) throw new HandoffError(`${target.agent} sessions cannot be brought over`, "unsupported")
    let rows: ImportedRow[]
    try {
      rows = historyRows(await adapter.readExternal(target.nativeId, target.cwd ?? ""))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if ((error as { code?: unknown }).code === "in_use") throw new HandoffError(message, "in_use")
      throw new HandoffError(`${adapter.spec.label} could not read the session: ${message}`, "unavailable")
    }
    this.histories.delete(target.ref)
    this.histories.set(target.ref, { at: now, rows })
    for (const key of this.histories.keys()) {
      if (this.histories.size <= TRANSCRIPT_CACHE_FILES) break
      this.histories.delete(key)
    }
    return rows
  }

  /**
   * ACP imports the whole replay at once: reading an earlier page again would mean a second session/load of a session
   * Rudder now runs. Codex reads its thread again for each earlier page, like a Claude transcript.
   */
  private wholeHistory(agent: string): boolean {
    return this.host.adapter(agent)?.spec.transport === "acp"
  }

  private async inspectExternal(target: RefTarget & { ref: string }) {
    const existing = this.host.store.findByNative(target.agent, target.nativeId)
    const closeFirst = this.wholeHistory(target.agent) ? { closeFirst: true as const } : {}
    const base = {
      title: target.title ?? "",
      cwd: target.cwd ?? "",
      updatedAt: Math.round(target.updatedAt ?? 0),
      writable: this.host.writable(target.cwd ?? ""),
      live: null,
      ...closeFirst,
    }
    if (existing) return { ...base, messages: 0, earlier: 0, sessionId: existing.id }
    if (target.inUse) throw new HandoffError("the session is open in another program on this computer", "in_use")
    const rows = await this.externalRows(target)
    const start = this.wholeHistory(target.agent) ? 0 : recentStart(rows)
    const messages = (list: ImportedRow[]) => list.filter((row) => row.kind === "text").length
    return { ...base, messages: messages(rows), earlier: messages(rows.slice(0, start)) }
  }

  /** P2a / P3: a Rudder session bound to the agent's own session, its history as read-only rows. */
  private async importExternal(target: RefTarget & { ref: string }) {
    const store = this.host.store
    const imported = () => store.findByNative(target.agent, target.nativeId)
    const existing = imported()
    if (existing) return { session: this.host.publicSession(existing.id) }
    if (target.inUse) throw new HandoffError("the session is open in another program on this computer", "in_use")
    const rows = await this.externalRows(target)
    const raced = imported()
    if (raced) return { session: this.host.publicSession(raced.id) }
    const start = this.wholeHistory(target.agent) ? 0 : recentStart(rows)
    const title = target.title ?? ""
    const session = store.transaction(() => {
      const session = store.createSession({
        title,
        agent: target.agent,
        cwd: target.cwd ?? "",
        // §9 Q2: the computer's own mode does not come over.
        permissionMode: this.host.permissionMode(target.agent),
        origin: "terminal",
        nativeId: target.nativeId,
      })
      this.insertImported(session.id, rows, start)
      store.setImportCursor(session.id, JSON.stringify({ earlier: start, title } satisfies Cursor))
      store.markRead(session.id)
      return session
    })
    this.histories.delete(target.ref)
    console.log(`rudderd: imported ${target.agent} session into ${session.id} (${rows.length - start} rows, ${start} left on the computer)`)
    this.host.broadcast(eventFrame("session.upsert", this.host.publicSession(session.id)))
    this.host.broadcast(eventFrame("message.invalidate", { sessionId: session.id }))
    return { session: this.host.publicSession(session.id) }
  }

  /**
   * seq 1: 「更早的 N 条留在电脑上」 when rows stay behind; seq 2: the divider; row i keeps seq i + ROW_SEQ whether or not
   * it comes over now, so older pages slot in under the divider later.
   */
  private insertImported(sessionId: string, rows: ImportedRow[], start: number) {
    const store = this.host.store
    const first = rows[start]?.createdAt ?? Date.now()
    if (start > 0) {
      const marker = earlierRow(sessionId, start)
      store.insertMessage({ ...marker, session_id: sessionId, seq: 1, created_at: marker.createdAt })
    }
    const divider = dividerRow(crypto.randomUUID(), "terminal", rows[0]?.createdAt ?? first)
    store.insertMessage({ id: divider.id, session_id: sessionId, seq: 2, kind: divider.kind, role: divider.role, text: divider.text, payload: divider.payload, created_at: divider.createdAt })
    rows.forEach((row, index) => {
      if (index < start) return
      store.insertMessage({ id: row.id, session_id: sessionId, seq: index + ROW_SEQ, kind: row.kind, role: row.role, text: row.text, payload: row.payload, created_at: row.createdAt })
    })
  }

  /**
   * The whole transcript, mapped; cached by size and mtime (the import sheet and the import read it back to back). Read
   * off the event loop; only the last few files stay cached. The stat comes first, so a write during the read only
   * makes the next call read again.
   */
  private async transcript(path: string): Promise<TranscriptRead & { consumed: number }> {
    const info = await stat(path)
    const cached = this.reads.get(path)
    if (cached && cached.size === info.size && cached.mtime === info.mtimeMs) return cached.read
    const text = await readFile(path, "utf8")
    const { consumed } = splitLines(text)
    const read = { ...readTranscript(text.slice(0, consumed)), consumed }
    this.reads.delete(path)
    this.reads.set(path, { size: info.size, mtime: info.mtimeMs, read })
    for (const key of this.reads.keys()) {
      if (this.reads.size <= TRANSCRIPT_CACHE_FILES) break
      this.reads.delete(key)
    }
    return read
  }

  /** For the import sheet: how much comes over and how much stays. */
  async inspect(params: Record<string, unknown>) {
    const target = this.target(params.ref)
    if (target.agent !== "claude") return this.inspectExternal(target)
    const { nativeId, path } = this.resolveRef(params.ref)
    const read = await this.transcript(path)
    if (!read.recognized) throw new HandoffError(`unrecognized Claude transcript format (Claude ${read.version ?? "?"})`, "unsupported_format")
    const start = recentStart(read.rows)
    const live = this.registry(true).get(nativeId)
    const messages = (rows: ImportedRow[]) => rows.filter((row) => row.kind === "text").length
    return {
      title: read.title ?? (await this.scanner.inspect(path)).title,
      cwd: read.cwd ?? "",
      updatedAt: Math.round(statSync(path).mtimeMs),
      messages: messages(read.rows),
      earlier: messages(read.rows.slice(0, start)),
      writable: this.host.writable(read.cwd ?? ""),
      live: live ? { status: live.status, since: live.since } : null,
      ...(this.host.store.findByNative("claude", nativeId) ? { sessionId: this.host.store.findByNative("claude", nativeId)!.id } : {}),
    }
  }

  /** §3.2: a Rudder session bound to the terminal one, its last 200 turns as read-only history. */
  async import(params: Record<string, unknown>) {
    const target = this.target(params.ref)
    if (target.agent !== "claude") return this.importExternal(target)
    const { nativeId, path } = this.resolveRef(params.ref)
    const store = this.host.store
    const imported = () => store.findByNative("claude", nativeId)
    const existing = imported()
    if (existing) return { session: this.host.publicSession(existing.id) }
    const read = await this.transcript(path)
    // A second import of the same session may have finished during the read.
    const raced = imported()
    if (raced) return { session: this.host.publicSession(raced.id) }
    if (!read.recognized) throw new HandoffError(`unrecognized Claude transcript format (Claude ${read.version ?? "?"})`, "unsupported_format")
    const title = read.title || (await this.scanner.inspect(path)).title
    const start = recentStart(read.rows)
    const session = store.transaction(() => {
      const session = store.createSession({
        title,
        agent: "claude",
        cwd: read.cwd ?? "",
        // §9 Q2: the terminal's own mode (often auto) does not come over.
        permissionMode: "ask",
        origin: "terminal",
        nativeId,
      })
      this.insertImported(session.id, read.rows, start)
      store.setImportCursor(session.id, JSON.stringify({ path, offset: read.consumed, earlier: start, title } satisfies Cursor))
      store.markRead(session.id)
      return session
    })
    console.log(`rudderd: imported terminal Claude session into ${session.id} (${read.rows.length - start} rows, ${start} left on the computer)`)
    this.host.broadcast(eventFrame("session.upsert", this.host.publicSession(session.id)))
    this.host.broadcast(eventFrame("message.invalidate", { sessionId: session.id }))
    return { session: this.host.publicSession(session.id) }
  }

  /** 「更早的 N 条留在电脑上 · 点按取一页」: the next 200 turns into their reserved seqs. */
  async importEarlier(params: Record<string, unknown>) {
    const id = String(params.id ?? "")
    const store = this.host.store
    const row = store.getSession(id)
    if (!row) throw new HandoffError("session not found", "not_found")
    const cursor = parseCursor(row.import_cursor)
    const earlier = cursor.earlier ?? 0
    if (earlier > 0) {
      let rows: ImportedRow[]
      let path: string | null = null
      if (row.agent === "claude") {
        path = cursor.path && existsSync(cursor.path) ? cursor.path : row.native_id ? findTranscript(this.options.projectsDir, row.native_id) : null
        if (!path) throw new HandoffError("the transcript is no longer on this computer", "not_found")
        rows = (await this.transcript(path)).rows.slice(0, earlier)
      } else {
        // P2a: Codex reads its thread again (thread/items/list works on a thread this process has loaded).
        if (!row.native_id) throw new HandoffError("the session is no longer bound to the computer's", "not_found")
        const target = { ref: this.refKey(row.agent, row.native_id), agent: row.agent, nativeId: row.native_id, cwd: row.cwd }
        rows = (await this.externalRows(target)).slice(0, earlier)
      }
      const start = recentStart(rows)
      // Another page request may have moved the cursor during the read; that one already wrote this page.
      if (parseCursor(store.getSession(id)?.import_cursor).earlier !== earlier) return { session: this.host.publicSession(id) }
      store.transaction(() => {
        rows.forEach((imported, index) => {
          if (index < start) return
          store.insertMessage({ id: imported.id, session_id: id, seq: index + ROW_SEQ, kind: imported.kind, role: imported.role, text: imported.text, payload: imported.payload, created_at: imported.createdAt })
        })
        const marker = earlierRow(id, start)
        store.insertMessage({ ...marker, session_id: id, seq: 1, created_at: marker.createdAt })
        // A follow may have advanced the offset during the read: keep its fields, change only this page's.
        const fresh = parseCursor(store.getSession(id)?.import_cursor)
        store.setImportCursor(id, JSON.stringify({ ...fresh, path: fresh.path ?? path ?? undefined, earlier: start }))
        store.markRead(id)
      })
      this.host.broadcast(eventFrame("message.invalidate", { sessionId: id }))
      this.host.broadcast(eventFrame("session.upsert", this.host.publicSession(id)))
    }
    return { session: this.host.publicSession(id) }
  }

  // ---------- follow ----------

  private transcriptPath(row: SessionRow, cursor: Cursor): string | null {
    if (cursor.path && existsSync(cursor.path)) return cursor.path
    return row.native_id ? findTranscript(this.options.projectsDir, row.native_id) : null
  }

  /** Inserts the divider when the timeline switches sides (§3.3: 「以下在电脑终端里」/「以下在手机上」). */
  private divider(sessionId: string, side: HandoffSide, out?: Frame[]) {
    const last = this.host.store.lastMessage(sessionId)
    const onTerminal = isImported(last)
    if (side === "terminal" ? onTerminal : !last || !onTerminal) return
    const row = dividerRow(crypto.randomUUID(), side, Date.now())
    const stored = this.host.store.insertMessage({ id: row.id, session_id: sessionId, kind: row.kind, role: row.role, text: row.text, payload: row.payload, created_at: row.createdAt })
    const frame = eventFrame("message.append", messagePublic(stored))
    if (out) out.push(frame)
    else this.host.broadcast(frame)
  }

  /** Before a phone turn of a session whose last stretch came from the terminal. */
  phoneTurn(sessionId: string) {
    const row = this.host.store.getSession(sessionId)
    // Claude as before; P2a / P3: any session brought over from the computer.
    if (row?.agent === "claude" || row?.origin === "terminal") this.divider(sessionId, "phone")
  }

  /**
   * Reads what the terminal appended since the cursor. Only `cli` records count: the daemon's own `claude -p` writes
   * the same file as `sdk-cli`, and those rows are already in the timeline under the daemon's ids.
   */
  follow(sessionId: string): Promise<number> {
    // One follow per session at a time: a call made meanwhile reads again after the running one, so no line is
    // read twice and the cursor never moves backwards.
    const previous = this.following.get(sessionId)
    const run: Promise<number> = (previous ? previous.then(() => undefined, () => undefined) : Promise.resolve()).then(() => this.followOnce(sessionId))
    this.following.set(sessionId, run)
    const clear = () => {
      if (this.following.get(sessionId) === run) this.following.delete(sessionId)
    }
    run.then(clear, clear)
    return run
  }

  private async followOnce(sessionId: string): Promise<number> {
    const store = this.host.store
    const first = store.getSession(sessionId)
    if (first?.agent !== "claude") return 0
    const firstCursor = parseCursor(first.import_cursor)
    const path = this.transcriptPath(first, firstCursor)
    if (!path) return 0
    const target = (await stat(path)).size
    const chunkBytes = this.options.followChunkBytes ?? FOLLOW_CHUNK_BYTES
    let total = 0
    for (;;) {
      const row = store.getSession(sessionId)
      if (row?.agent !== "claude") return total
      const cursor = parseCursor(row.import_cursor)
      const startOffset = cursor.offset ?? 0
      let offset = startOffset
      if (offset > target) offset = 0
      if (offset >= target) return total
      // A line longer than the chunk has no newline in it: read wider from the same offset until one shows up or the
      // snapshot ends, or the cursor would sit in front of that line for good.
      let max = chunkBytes
      let text = await readFrom(path, offset, max)
      let split = splitLines(text)
      // A short read means the file shrank under us: stop widening.
      while (split.consumed === 0 && Buffer.byteLength(text) >= max && offset + max < target) {
        max *= 2
        text = await readFrom(path, offset, max)
        split = splitLines(text)
      }
      // The reads yielded: if turnEnded (or anything else) moved the cursor meanwhile, this chunk is stale.
      const after = store.getSession(sessionId)
      if (!after) return total
      // Something rewrote the cursor under the read (turnEnded, an earlier page): read again from what it says now.
      // Giving up here would lose the tail for good when this is the last follow before the holder is released.
      if (after.import_cursor !== row.import_cursor) continue
      const { lines, consumed } = split
      if (consumed === 0) return total
      total += this.commitChunk(sessionId, after, parseCursor(after.import_cursor), path, offset, lines, consumed)
      if (offset + consumed >= target) return total
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }

  /** Maps one chunk of lines and stores it with its cursor in one transaction; the frames go out once it commits. */
  private commitChunk(sessionId: string, row: SessionRow, cursor: Cursor, path: string, offset: number, lines: string[], consumed: number): number {
    const store = this.host.store
    const { records } = parseRecords(lines)
    let mapper = this.mappers.get(sessionId)
    if (!mapper) {
      mapper = new ClaudeMapper((id) => {
        const known = store.getMessage(id)
        return known && known.session_id === sessionId
          ? { id: known.id, kind: known.kind, role: known.role as "user" | "assistant", text: known.text, payload: known.payload ?? "{}", createdAt: known.created_at }
          : undefined
      })
      this.mappers.set(sessionId, mapper)
    }
    const titleBefore = mapper.title
    // One frame per row per read: a tool_use and its result in the same read go out as the finished card.
    const batch = new Map<string, ImportedRow>()
    for (const record of records) {
      if (record.type === "ai-title") {
        mapper.map(record)
        continue
      }
      if (record.entrypoint !== "cli") continue
      for (const imported of mapper.map(record)) batch.set(imported.id, imported)
    }
    const frames: Frame[] = []
    let added = 0
    const next: Cursor = { ...cursor, path, offset: offset + consumed }
    store.transaction(() => {
      for (const imported of batch.values()) {
        const existing = store.getMessage(imported.id)
        if (existing && existing.session_id !== sessionId) continue
        if (!existing) {
          this.divider(sessionId, "terminal", frames)
          added += 1
        }
        const stored = store.insertMessage({ id: imported.id, session_id: sessionId, kind: imported.kind, role: imported.role, text: imported.text, payload: imported.payload, created_at: imported.createdAt })
        frames.push(eventFrame("message.append", messagePublic(stored)))
      }
      // The terminal's new title (Claude's ai-title, v112 ①) replaces the session's only while nobody renamed it in
      // Rudder; v112's short form, as every title.
      if (mapper.title && mapper.title !== titleBefore && (row.title === cursor.title || cursor.title === undefined)) {
        const title = shortTitle(mapper.title)
        store.patchSession(sessionId, { title, autoTitle: AUTO_TITLE_AGENT })
        next.title = title
      }
      store.setImportCursor(sessionId, JSON.stringify(next))
    })
    for (const frame of frames) this.host.broadcast(frame)
    if (added > 0) {
      const lease = this.leases.get(sessionId)
      if (lease) lease.added += added
    }
    if (added > 0 || next.title !== cursor.title) this.publish(sessionId, true)
    return added
  }

  /** After a phone turn: the file up to here is the daemon's own writing. Kept while a terminal also has it open. */
  turnEnded(sessionId: string) {
    const row = this.host.store.getSession(sessionId)
    if (row?.agent !== "claude" || !row.native_id) return
    if (this.terminalOf(row, true)) {
      // §2 rule 4: the turn that overlapped the terminal is over; the daemon lets go now.
      this.host.releaseAgent(row)
      this.publish(sessionId, true)
      return
    }
    const cursor = parseCursor(row.import_cursor)
    const path = this.transcriptPath(row, cursor)
    if (!path) return
    this.host.store.setImportCursor(sessionId, JSON.stringify({ ...cursor, path, offset: statSync(path).size }))
  }

  // ---------- takeover ----------

  private requireClaude(id: unknown): SessionRow {
    const row = this.host.store.getSession(String(id ?? ""))
    if (!row) throw new HandoffError("session not found", "not_found")
    if (row.agent !== "claude") throw new HandoffError(`${row.agent} sessions cannot be handed over yet`, "unsupported")
    return row
  }

  /** SIGTERM to the registry's pid, then wait for it to go. True when it is gone. */
  private async terminate(entry: RegistryEntry, sessionId: string): Promise<boolean> {
    // The entry is up to a second old: check the pid is still that Claude before signalling it.
    if (!this.probe.alive(entry.pid) || this.probe.startTime(entry.pid) !== entry.procStart) return true
    console.log(`rudderd: handoff takeover: SIGTERM to terminal Claude pid ${entry.pid} (session ${sessionId}, confirmed on the phone)`)
    this.kill(entry.pid, "SIGTERM")
    const deadline = Date.now() + (this.options.exitWaitMs ?? 5000)
    while (Date.now() < deadline) {
      if (!this.probe.alive(entry.pid)) return true
      await Bun.sleep(100)
    }
    console.warn(`rudderd: handoff takeover: Claude pid ${entry.pid} did not quit; not escalating`)
    return false
  }

  private async takeNow(row: SessionRow): Promise<void> {
    // The terminal already exited and attachDone is importing its tail: the session is going back to the phone anyway.
    const closing = this.leases.get(row.id)?.closing
    if (closing) {
      await closing.catch(() => undefined)
      this.pending.delete(row.id)
      return
    }
    if (this.running.has(row.id)) throw new HandoffError("a takeover is already running", "busy")
    const entry = this.terminalOf(row, true)
    if (entry?.status === "busy") throw new HandoffError("the terminal is running a turn", "takeover_busy")
    this.running.add(row.id)
    try {
      const gone = entry ? await this.terminate(entry, row.id) : !this.leases.has(row.id)
      if (!gone) {
        this.failed.add(row.id)
        this.pending.delete(row.id)
        this.publish(row.id, true)
        throw new HandoffError("Claude in the terminal did not quit", "takeover_failed")
      }
      this.snapshot = undefined
      await this.follow(row.id)
      this.leases.delete(row.id)
      this.pending.delete(row.id)
      this.failed.delete(row.id)
      this.mappers.delete(row.id)
      this.divider(row.id, "phone")
      this.publish(row.id, true)
      this.host.holderReleased(row.id)
    } finally {
      this.running.delete(row.id)
    }
  }

  async takeover(params: Record<string, unknown>) {
    const row = this.requireClaude(params.id)
    // taking it over would not let the phone send anything either.
    if (!this.host.writable(row.cwd)) throw new HandoffError("the session's folder is outside what Rudder can write to", "read_only")
    const holder = this.holder(row, true)
    if (holder.kind !== "terminal") throw new HandoffError("the session is not held by a terminal", "conflict")
    if (params.when === "afterTurn") {
      this.pending.set(row.id, Date.now())
      this.failed.delete(row.id)
      this.publish(row.id, true)
      if (holder.status === "idle") void this.tick()
      return { session: this.host.publicSession(row.id) }
    }
    if (params.when !== undefined && params.when !== "now") throw new HandoffError("when must be now or afterTurn", "invalid")
    this.failed.delete(row.id)
    await this.takeNow(row)
    return { session: this.host.publicSession(row.id) }
  }

  cancelTakeover(params: Record<string, unknown>) {
    const row = this.requireClaude(params.id)
    this.pending.delete(row.id)
    this.failed.delete(row.id)
    this.publish(row.id, true)
    return { session: this.host.publicSession(row.id) }
  }

  // ---------- back to the computer ----------

  /** Shortest unique id prefix of at least 4 characters: what `rudder attach` takes. */
  shortId(id: string): string {
    const others = this.host.store.listSessions().map((row) => row.id).filter((other) => other !== id)
    for (let length = 4; length < id.length; length += 1) {
      const prefix = id.slice(0, length)
      if (!others.some((other) => other.startsWith(prefix))) return prefix
    }
    return id
  }

  /** Opening the sheet hands nothing over; that happens when the command runs on the computer. */
  release(params: Record<string, unknown>) {
    const row = this.requireClaude(params.id)
    const short = this.shortId(row.id)
    const home = homedir()
    const cwd = row.cwd.startsWith(`${home}/`) ? `~${row.cwd.slice(home.length)}` : row.cwd
    const quoted = cwd ? `cd ${shellQuote(cwd)} && ` : ""
    return {
      short,
      command: `rudder attach ${short}`,
      native: row.native_id ? `${quoted}${this.claudeCommand} --resume ${row.native_id}` : null,
      running: this.host.isGenerating(row.id),
    }
  }

  findForAttach(target: string): SessionRow {
    const wanted = target.trim().toLowerCase()
    if (wanted.length < 4) throw new HandoffError(`no session ${target}`, "not_found")
    const hits = this.host.store.listSessions().filter((row) => row.id.startsWith(wanted))
    if (hits.length === 0) throw new HandoffError(`no session ${target}`, "not_found")
    if (hits.length > 1) throw new HandoffError(`${target} matches ${hits.length} sessions; use more characters`, "ambiguous")
    return hits[0]!
  }

  /**
   * `rudder attach`: `waiting` while the phone's turn runs (the CLI asks again), then the lease and the argv to run.
   * `now` stops that turn first (like 停止 on the phone).
   */
  async attach(body: { target?: unknown; now?: unknown; pid?: unknown }) {
    const row = this.findForAttach(String(body.target ?? ""))
    if (row.agent !== "claude") throw new HandoffError(`${row.agent} sessions cannot be opened in a terminal yet`, "unsupported")
    const sessionInfo = { id: row.id, title: row.title, agent: row.agent, cwd: row.cwd }
    if (this.terminalOf(row, true) && !this.leases.has(row.id)) throw new HandoffError("already open in another terminal", "held_elsewhere")
    if (this.host.isGenerating(row.id)) {
      if (body.now !== true) return { state: "waiting", session: sessionInfo }
      await this.host.stopTurn(row.id)
      if (this.host.isGenerating(row.id)) return { state: "waiting", session: sessionInfo }
    }
    const pid = typeof body.pid === "number" && Number.isSafeInteger(body.pid) ? body.pid : 0
    const store = this.host.store
    this.host.releaseAgent(row)
    let nativeId = row.native_id
    const fresh = !nativeId
    if (!nativeId) {
      nativeId = crypto.randomUUID()
      store.patchSession(row.id, { nativeId })
    }
    const cursor = parseCursor(row.import_cursor)
    const path = this.transcriptPath({ ...row, native_id: nativeId }, cursor)
    store.setImportCursor(row.id, JSON.stringify({ ...cursor, ...(path ? { path, offset: statSync(path).size } : { offset: 0 }) }))
    this.leases.set(row.id, { sessionId: row.id, pid, since: Date.now(), added: 0 })
    this.mappers.delete(row.id)
    console.log(`rudderd: session ${row.id} handed to a terminal (rudder attach, pid ${pid})`)
    this.publish(row.id, true)
    const argv = [this.claudeCommand, fresh ? "--session-id" : "--resume", nativeId]
    if (row.permission_mode !== "native") argv.push("--permission-mode", attachMode(row.permission_mode))
    if (row.model) argv.push("--model", row.model)
    return { state: "ready", session: sessionInfo, argv, cwd: row.cwd }
  }

  /** The terminal Claude exited: read in what it wrote and give the session back to the phone. */
  async attachDone(body: { sessionId?: unknown }): Promise<{ added: number }> {
    const id = String(body.sessionId ?? "")
    const lease = this.leases.get(id)
    // A call already closing this lease does the whole release; this one has nothing left to do.
    if (!lease || lease.closing) return { added: 0 }
    const closing = (async () => {
      this.snapshot = undefined
      const row = this.host.store.getSession(id)
      // Claude may still be writing its last lines while it exits; what is not in yet comes in on the next follow.
      if (row) await this.follow(id)
      this.leases.delete(id)
      this.mappers.delete(id)
      // An afterTurn takeover queued meanwhile has nothing left to take: the terminal is gone.
      this.pending.delete(id)
      this.publish(id, true)
      this.host.holderReleased(id)
    })()
    // The lease stays in the table (the phone stays gated) until the last lines are in; a failure leaves it for the next tick.
    lease.closing = closing
    try {
      await closing
    } finally {
      delete lease.closing
    }
    return { added: lease.added }
  }

  // ---------- poll ----------

  private publish(sessionId: string, force = false) {
    const pub = this.host.publicSession(sessionId) as { holder?: Holder } | null
    if (!pub) return
    const key = holderKey(pub.holder)
    if (!force && this.published.get(sessionId) === key) return
    this.published.set(sessionId, key)
    this.host.broadcast(eventFrame("session.upsert", pub))
  }

  tick(): Promise<void> {
    this.ticking ??= this.runTick().finally(() => {
      this.ticking = undefined
    })
    return this.ticking
  }

  private async runTick() {
    const store = this.host.store
    await this.probe.prefetch?.(registryPids(this.options.registryDir, this.host.daemonPids()))
    this.registry(true)
    for (const lease of [...this.leases.values()]) {
      const row = store.getSession(lease.sessionId)
      if (!row) {
        this.leases.delete(lease.sessionId)
        continue
      }
      // The CLI was killed before it could say done: its pid and Claude's are both gone.
      const cliGone = lease.pid > 0 && !this.probe.alive(lease.pid)
      if (cliGone && !lease.closing && !this.terminalOf(row)) {
        try {
          await this.attachDone({ sessionId: lease.sessionId })
        } catch (error) {
          console.warn(`rudderd: closing the attach of ${lease.sessionId} failed:`, error)
        }
      }
    }
    // The registry discovers a terminal even for an archived session. Previously held rows are visited once
    // more to publish a release after the terminal or an idle Rudder process goes away.
    const rows: SessionRow[] = []
    const listed = new Set<string>()
    const add = (row: SessionRow | null) => {
      if (!row || listed.has(row.id)) return
      listed.add(row.id)
      rows.push(row)
    }
    for (const id of this.leases.keys()) add(store.getSession(id))
    for (const id of this.host.activeSessions()) add(store.getSession(id))
    for (const nativeId of this.registry().keys()) add(store.findByNative("claude", nativeId))
    for (const [id, key] of this.published) {
      const row = shownHeld(key) ? store.getSession(id) : null
      if (row) add(row)
      else this.published.delete(id)
    }
    for (const row of rows) {
      if (row.agent !== "claude" || (!row.native_id && !this.leases.has(row.id))) continue
      const holder = this.holder(row)
      const before = this.published.get(row.id)
      const wasTerminal = before?.includes('"kind":"terminal"') === true
      if (holder.kind === "terminal") {
        // §2 rule 4: a terminal opened a session whose daemon process sits idle.
        if (this.host.hasAgentProcess(row.id) && !this.host.isGenerating(row.id)) this.host.releaseAgent(row)
        try {
          await this.follow(row.id)
        } catch (error) {
          console.warn(`rudderd: following ${row.id} failed:`, error)
        }
        // Product decision (2026-11-19): the terminal's turn starting (idle → busy) or ending (busy → idle) moves the
        // home list, as a phone turn does; the rows it streams do not. The changed holder key publishes the row below.
        const was = wasTerminal ? terminalStatus(before) : undefined
        if (was && holder.status && was !== holder.status) store.touchActive(row.id)
        if (this.pending.has(row.id) && holder.status === "idle" && !this.running.has(row.id)) {
          await this.takeNow(row).catch((error: unknown) => console.warn(`rudderd: takeover after the turn for ${row.id}:`, error))
          continue
        }
      } else if (wasTerminal) {
        try {
          await this.follow(row.id)
        } catch (error) {
          console.warn(`rudderd: final read of ${row.id} failed:`, error)
        }
        this.pending.delete(row.id)
        this.failed.delete(row.id)
        this.mappers.delete(row.id)
        this.publish(row.id)
        this.host.holderReleased(row.id)
        continue
      }
      if (before === undefined && holder.kind !== "terminal" && !holder.conflict) {
        this.published.set(row.id, holderKey(holder))
        continue
      }
      // Unchanged: skip building the whole public session only to find the same key.
      if (before === holderKey(holder)) continue
      this.publish(row.id)
    }
  }
}

/** The terminal's busy / idle in a published holder key, if it recorded one. */
function terminalStatus(key: string | undefined): string | undefined {
  if (!key) return undefined
  const parsed = JSON.parse(key) as { kind?: string; status?: string } | null
  return parsed?.kind === "terminal" ? parsed.status : undefined
}

/** A published holder key (`holderKey`) that shows the session held by someone. */
function shownHeld(key: string): boolean {
  return key !== "null" && !key.includes('"kind":"none"')
}

// `since` moves on every read for rudder / none; a change is anything else.
function holderKey(holder: Holder | undefined): string {
  if (!holder) return "null"
  const { since: _since, ...rest } = holder
  return JSON.stringify(holder.kind === "terminal" ? holder : rest)
}

// ask is Claude's "default" (the design's CLI copy shows it that way); the rest are Claude's own mode names.
function attachMode(mode: string): string {
  return mode === "ask" || mode === "autoApproval" ? "default" : mode
}

function shellQuote(text: string): string {
  return /^[\w./~+-]+$/.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`
}

/** Rejects after `ms`; the work itself goes on (an agent's list call cannot be taken back). */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms)
  })
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
}
