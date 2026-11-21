import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Frame } from "../protocol"
import { readRegistry } from "./claude-registry"
import { harness, linearChain, TranscriptWriter, waitFor } from "./test-kit"

type Kit = ReturnType<typeof harness>
let kits: Kit[] = []
function kit(options: Parameters<typeof harness>[0] = {}) {
  const made = harness(options)
  kits.push(made)
  return made
}
afterEach(async () => {
  for (const made of kits) await made.cleanup()
  kits = []
})

type Entry = { ref: string; title: string; live: { status: string } | null; sessionId?: string; importable: boolean; cwd: string }
type Pub = { id: string; holder?: { kind: string; status?: string; pendingTakeover?: boolean; takeoverFailed?: boolean; conflict?: boolean; via?: string }; origin?: string; importedEarlier?: number; permissionMode: string }

/** A terminal session with `turns` turns already in its transcript; still running unless `exited`. */
function terminalSession(k: Kit, turns = 2, options: { exited?: boolean; status?: string } = {}) {
  const nativeId = crypto.randomUUID()
  const term = k.terminal(nativeId, { status: options.status })
  term.writer.title("Fix the login timeout")
  for (let n = 0; n < turns; n += 1) term.writer.turn(`prompt ${n}`, `reply ${n}`)
  if (options.exited) term.exit()
  return { nativeId, term }
}

/** Imports the newest listed transcript (the one the test just wrote). */
async function importOne(k: Kit, nativeId: string): Promise<Pub> {
  const { entries } = await k.ok<{ entries: Entry[] }>("handoff.list")
  const { session } = await k.ok<{ session: Pub }>("handoff.import", { ref: entries[0]!.ref })
  expect(k.store.getSession(session.id)?.native_id).toBe(nativeId)
  return session
}

const errorCode = (frame: Frame) => frame.error?.code

describe("registry and holder (step 3)", () => {
  test("a dead pid, a recycled pid and the daemon's own pid are not holders", () => {
    const k = kit()
    const { term } = terminalSession(k)
    expect(readRegistry(k.registryDir, { alive: (pid) => k.procs.get(pid)?.alive === true, startTime: (pid) => k.procs.get(pid)?.start ?? null })).toHaveLength(1)
    // Same pid, different start time: the file outlived its Claude and the pid was reused.
    k.procs.get(term.pid)!.start = "Sun Nov  1 09:00:00 2026"
    expect(readRegistry(k.registryDir, { alive: () => true, startTime: (pid) => k.procs.get(pid)?.start ?? null })).toHaveLength(0)
    k.procs.get(term.pid)!.start = "x"
    expect(readRegistry(k.registryDir, { alive: () => false, startTime: () => "x" })).toHaveLength(0)
    expect(readRegistry(k.registryDir, { alive: () => true, startTime: () => k.procs.get(term.pid)!.start }, new Set([term.pid]))).toHaveLength(0)
  })

  test("the tick prefetches registry pids before reading the registry", async () => {
    const prefetched: number[][] = []
    const k = kit({
      probe: {
        alive: (pid) => k.procs.get(pid)?.alive === true,
        startTime: (pid) => k.procs.get(pid)?.start ?? null,
        prefetch: async (pids) => void prefetched.push([...pids]),
      },
    })
    const { term } = terminalSession(k)
    await k.handoff.tick()
    expect(prefetched.at(-1)).toEqual([term.pid])
  })

  // Audit 2026-11-10 (P3): the 2 s poll read every registry file and the whole session table each time.
  test("the poll reads only bound Claude sessions, and a same-length status rewrite is still seen", async () => {
    const k = kit()
    const { nativeId, term } = terminalSession(k, 1, { status: "busy" })
    await importOne(k, nativeId)
    k.store.createSession({ agent: "codex" })
    const store = k.store as unknown as { listSessions: () => unknown }
    const listSessions = store.listSessions
    let fullReads = 0
    store.listSessions = () => {
      fullReads += 1
      return listSessions.call(k.store)
    }
    const probe = { alive: () => true, startTime: (pid: number) => k.procs.get(pid)?.start ?? null }
    expect(readRegistry(k.registryDir, probe)[0]?.status).toBe("busy")
    term.setStatus("idle")
    expect(readRegistry(k.registryDir, probe)[0]?.status).toBe("idle")
    await k.handoff.tick()
    expect(fullReads).toBe(0)
    store.listSessions = listSessions
  })

  test("while a terminal holds the session, message.send answers held_elsewhere and nothing is written", async () => {
    const k = kit()
    const { nativeId, term } = terminalSession(k)
    const session = await importOne(k, nativeId)
    expect(session.holder?.kind).toBe("terminal")
    expect(session.holder?.status).toBe("idle")
    const before = k.store.listMessages(session.id).length
    const refused = await k.call("message.send", { sessionId: session.id, text: "from the phone" })
    expect(errorCode(refused)).toBe("held_elsewhere")
    expect(k.store.listMessages(session.id).length).toBe(before)
    expect(k.daemonProcs.size).toBe(0)
    for (const method of ["session.clear", "session.fork"]) expect(errorCode(await k.call(method, { id: session.id }))).toBe("held_elsewhere")
    expect(errorCode(await k.call("session.rewind", { id: session.id, seq: 2 }))).toBe("held_elsewhere")
    // An SDK session of the same id (say claude-mem) is not a terminal.
    term.exit()
    const sdk = k.terminal(nativeId, { entrypoint: "sdk-ts" })
    const free = await k.call("message.send", { sessionId: session.id, text: "now it goes" })
    expect(free.type).toBe("result")
    sdk.exit()
  })
})

// Review 2026-11-11 (P3): the turn refused because a terminal opened the session meanwhile was English-only.
describe("a terminal opening the session between the send and the agent's start", () => {
  test("fails the turn with copy the phone words in its language", async () => {
    const k = kit()
    const { nativeId, term } = terminalSession(k)
    term.exit()
    const session = await importOne(k, nativeId)
    let checks = 0
    // The send's gate passes; the check right before the agent starts finds the terminal.
    k.handoff.heldElsewhere = () => {
      checks += 1
      return checks > 1
    }
    expect((await k.call("message.send", { sessionId: session.id, text: "from the phone" })).type).toBe("result")
    await waitFor(() => k.store.listMessages(session.id).some((row) => row.kind === "error"))
    const error = k.store.listMessages(session.id).find((row) => row.kind === "error")!
    expect(JSON.parse(error.payload!).copy).toEqual({ code: "terminal_took_over", text: "这个会话刚在电脑终端里打开，这一轮没有开始" })
    expect(k.daemonProcs.size).toBe(0)
  })
})

describe("list and import (step 4)", () => {
  test("lists terminal sessions only, with live state and the Rudder session once imported", async () => {
    const k = kit()
    const running = terminalSession(k, 1, { status: "busy" })
    const exited = terminalSession(k, 1, { exited: true })
    // The daemon's own transcripts (sdk-cli) are not listed.
    const own = new TranscriptWriter(k.transcriptPath(crypto.randomUUID()), crypto.randomUUID(), "sdk-cli", k.cwd)
    own.turn("x", "y")
    const { entries } = await k.ok<{ entries: Entry[] }>("handoff.list")
    expect(entries).toHaveLength(2)
    const live = entries.find((entry) => entry.live)
    expect(live?.live?.status).toBe("busy")
    expect(entries.every((entry) => entry.title === "Fix the login timeout" && entry.importable)).toBe(true)
    const { session } = await k.ok<{ session: Pub }>("handoff.import", { ref: entries.find((entry) => !entry.live)!.ref })
    expect(session.origin).toBe("terminal")
    expect(session.permissionMode).toBe("ask")
    const again = await k.ok<{ entries: Entry[] }>("handoff.list")
    expect(again.entries.find((entry) => entry.sessionId === session.id)).toBeDefined()
    expect(k.store.findByNative("claude", exited.nativeId)?.id).toBe(session.id)
    void running
  })

  test("a session in a hidden folder is listed and imported as view-only; takeover is refused (v57 C)", async () => {
    const k = kit()
    const inside = terminalSession(k, 1, { exited: true })
    const nativeId = crypto.randomUUID()
    k.terminal(nativeId)
    const hidden = join(k.root, ".config", "clash")
    const writer = new TranscriptWriter(k.transcriptPath(nativeId), nativeId, "cli", hidden)
    writer.title("Dedupe Clash rules")
    writer.turn("dedupe", "done")
    const { entries } = await k.ok<{ entries: Array<Entry & { writable?: boolean }> }>("handoff.list")
    const byCwd = Object.fromEntries(entries.map((entry) => [entry.cwd, entry]))
    expect(byCwd[hidden]?.writable).toBe(false)
    expect(byCwd[k.cwd]?.writable).toBe(true)
    const inspected = await k.ok<{ writable: boolean }>("handoff.inspect", { ref: byCwd[hidden]!.ref })
    expect(inspected.writable).toBe(false)
    const { session } = await k.ok<{ session: Pub & { writable?: boolean } }>("handoff.import", { ref: byCwd[hidden]!.ref })
    expect(session.writable).toBe(false)
    const refused = await k.call("handoff.takeover", { id: session.id, when: "now" })
    expect(errorCode(refused)).toBe("read_only")
    expect(k.kills).toEqual([])
    const ok = await k.ok<{ session: Pub & { writable?: boolean } }>("handoff.import", { ref: byCwd[k.cwd]!.ref })
    expect(ok.session.writable).toBe(true)
    void inside
  })

  test("import twice gives the same session and the same rows", async () => {
    const k = kit()
    const { nativeId } = terminalSession(k, 3, { exited: true })
    const { entries } = await k.ok<{ entries: Entry[] }>("handoff.list")
    const first = await k.ok<{ session: Pub }>("handoff.import", { ref: entries[0]!.ref })
    const rows = k.store.listMessages(first.session.id).map((row) => [row.id, row.seq, row.kind])
    const second = await k.ok<{ session: Pub }>("handoff.import", { ref: entries[0]!.ref })
    expect(second.session.id).toBe(first.session.id)
    expect(k.store.listMessages(first.session.id).map((row) => [row.id, row.seq, row.kind])).toEqual(rows)
    // Divider, then three user / assistant pairs.
    expect(rows.map((row) => row[2])).toEqual(["handoff", "text", "text", "text", "text", "text", "text"])
    expect(k.store.listSessions().filter((row) => row.native_id === nativeId)).toHaveLength(1)
    expect(k.store.getSession(first.session.id)?.last_read_seq).toBe(k.store.getSession(first.session.id)?.last_seq)
  })

  test("an exited session continues with --resume on the phone; the phone side gets its divider", async () => {
    const k = kit()
    const { nativeId } = terminalSession(k, 1, { exited: true })
    const session = await importOne(k, nativeId)
    expect(session.holder?.kind).toBe("none")
    const sent = await k.call("message.send", { sessionId: session.id, text: "next step" })
    expect(sent.type).toBe("result")
    await k.service.shutdown(500)
    const kinds = k.store.listMessages(session.id).map((row) => `${row.kind}:${row.role}`)
    expect(kinds.slice(-3)).toEqual(["handoff:assistant", "text:user", "text:assistant"])
    const divider = k.store.listMessages(session.id).filter((row) => row.kind === "handoff").map((row) => JSON.parse(row.payload!).handoff)
    expect(divider).toEqual(["terminal", "phone"])
    expect(linearChain(k.transcriptPath(nativeId)).ok).toBe(true)
  })

  test("only the last 200 turns come over; the rest load into their reserved place", async () => {
    const k = kit()
    const { nativeId } = terminalSession(k, 230, { exited: true })
    const { entries } = await k.ok<{ entries: Entry[] }>("handoff.list")
    const inspect = await k.ok<{ messages: number; earlier: number }>("handoff.inspect", { ref: entries[0]!.ref })
    expect(inspect.messages).toBe(460)
    expect(inspect.earlier).toBe(60)
    const { session } = await k.ok<{ session: Pub }>("handoff.import", { ref: entries[0]!.ref })
    expect(session.importedEarlier).toBe(60)
    // The marker, the divider and the last 200 turns.
    expect(k.store.listMessages(session.id, { limit: 10_000 })).toHaveLength(402)
    expect(JSON.parse(k.store.listMessages(session.id, { limit: 1 }).at(0)?.payload ?? "{}")).toBeTruthy()
    const after = await k.ok<{ session: Pub }>("handoff.importEarlier", { id: session.id })
    expect(after.session.importedEarlier).toBeUndefined()
    const rows = k.store.listMessages(session.id, { limit: 10_000 })
    expect(rows).toHaveLength(462)
    expect(JSON.parse(rows[0]!.payload!)).toEqual({ handoff: "earlier", count: 0 })
    expect(JSON.parse(rows[1]!.payload!).handoff).toBe("terminal")
    expect(rows[2]?.text).toBe("prompt 0")
    expect(rows.map((row) => row.seq)).toEqual([...rows.map((row) => row.seq)].sort((a, b) => a - b))
    void nativeId
  })

  // Review 2026-11-11 (P3): the parsed transcript was stored but never read back, and every file read stayed cached.
  test("inspect and import parse the transcript once; the cache keeps only the last files", async () => {
    const k = kit()
    const { nativeId, term } = terminalSession(k, 3, { exited: true })
    const reads = (k.handoff as unknown as { reads: Map<string, { read: unknown }> }).reads
    const { entries } = await k.ok<{ entries: Entry[] }>("handoff.list")
    await k.ok("handoff.inspect", { ref: entries[0]!.ref })
    const parsed = reads.get(k.transcriptPath(nativeId))?.read
    expect(parsed).toBeTruthy()
    await k.ok("handoff.inspect", { ref: entries[0]!.ref })
    expect(reads.get(k.transcriptPath(nativeId))?.read).toBe(parsed)
    term.writer.turn("prompt 3", "reply 3")
    const after = await k.ok<{ messages: number }>("handoff.inspect", { ref: entries[0]!.ref })
    expect(after.messages).toBe(8)
    expect(reads.get(k.transcriptPath(nativeId))?.read).not.toBe(parsed)
    for (let n = 0; n < 3; n += 1) terminalSession(k, 1, { exited: true })
    const { entries: all } = await k.ok<{ entries: Entry[] }>("handoff.list")
    for (const entry of all) await k.ok("handoff.inspect", { ref: entry.ref })
    expect(reads.size).toBe(2)
  })

  test("a transcript in a shape the parser does not know is not importable", async () => {
    const k = kit()
    const nativeId = crypto.randomUUID()
    writeFileSync(k.transcriptPath(nativeId), `${JSON.stringify({ type: "turn", version: "9.0.0", body: {} })}\n`)
    const { entries } = await k.ok<{ entries: (Entry & { reason?: string; version?: string })[] }>("handoff.list")
    expect(entries[0]?.importable).toBe(false)
    expect(entries[0]?.reason).toBe("unsupported_format")
    expect(errorCode(await k.call("handoff.import", { ref: entries[0]!.ref }))).toBe("unsupported_format")
  })

  test("an unknown ref is not_found; a daemon without handoff answers unknown_method", async () => {
    const k = kit()
    expect(errorCode(await k.call("handoff.import", { ref: "nope" }))).toBe("not_found")
  })
})

describe("follow (step 5)", () => {
  // Product decision (2026-11-19): a terminal turn moves the home list at its start and end, not with each row.
  test("a terminal turn moves activeAt when it starts and ends, not while it streams", async () => {
    const k = kit()
    const { nativeId, term } = terminalSession(k, 1)
    const session = await importOne(k, nativeId)
    const sent: Frame[] = []
    const socket = { send: (raw: string) => void sent.push(JSON.parse(raw) as Frame) }
    k.hub.attach(socket)
    k.hub.helloStarted(socket)
    k.hub.resume(socket, { lastEventId: k.hub.lastEventId, sessionId: session.id }).flush()
    const order = () => {
      const row = k.store.getSession(session.id)!
      return { activeAt: row.active_at ?? row.updated_at, updatedAt: row.updated_at }
    }
    await k.handoff.tick()
    const idle = order()
    await Bun.sleep(3)
    term.setStatus("busy")
    await k.handoff.tick()
    const started = order()
    expect(started.activeAt).toBeGreaterThan(idle.activeAt)
    const upserted = sent.filter((frame) => frame.name === "session.upsert").at(-1)?.payload as { activeAt?: number } | undefined
    expect(upserted?.activeAt).toBe(started.activeAt)
    await Bun.sleep(3)
    term.writer.turn("terminal prompt", "terminal reply")
    await k.handoff.tick()
    const streamed = order()
    expect(streamed.updatedAt).toBeGreaterThan(started.activeAt)
    expect(streamed.activeAt).toBe(started.activeAt)
    await Bun.sleep(3)
    term.setStatus("idle")
    await k.handoff.tick()
    expect(order().activeAt).toBeGreaterThan(streamed.updatedAt)
    k.hub.detach(socket)
  })

  test("a transcript larger than one chunk is followed whole by one follow, in order", async () => {
    const k = kit({ followChunkBytes: 4096 })
    const { nativeId, term } = terminalSession(k, 1)
    const session = await importOne(k, nativeId)
    for (let i = 0; i < 40; i += 1) term.writer.turn(`p${i}`, "r".repeat(300))
    const commits = spyOn(k.store, "setImportCursor")
    const added = await k.handoff.follow(session.id)
    expect(commits.mock.calls.length).toBeGreaterThan(1)
    const texts = k.store.listMessages(session.id).map((row) => row.text).filter((text) => /^p\d+$/.test(text))
    expect(texts).toEqual(Array.from({ length: 40 }, (_, i) => `p${i}`))
    expect(added).toBe(80)
    expect(JSON.parse(k.store.getSession(session.id)!.import_cursor!).offset).toBe(statSync(term.writer.path).size)
  })

  test("concurrent follows of one session append each terminal line once", async () => {
    const k = kit({ followChunkBytes: 4096 })
    const { nativeId, term } = terminalSession(k, 1)
    const session = await importOne(k, nativeId)
    for (let i = 0; i < 5; i += 1) term.writer.turn(`c${i}`, "r".repeat(300))
    await Promise.all([k.handoff.follow(session.id), k.handoff.follow(session.id), k.handoff.tick()])
    const ids = k.store.listMessages(session.id).map((row) => row.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(k.store.listMessages(session.id).filter((row) => row.text.startsWith("c")).length).toBe(5)
  })

  test("turnEnded while a later chunk is being read drops that chunk and keeps the cursor at the end", async () => {
    const k = kit({ followChunkBytes: 4096 })
    const { nativeId, term } = terminalSession(k, 1)
    const session = await importOne(k, nativeId)
    for (let i = 0; i < 20; i += 1) term.writer.turn(`t${i}`, "r".repeat(300))
    term.exit()
    // After the first chunk commits and follow has gone on to read the next one, the cursor is moved under it.
    const original = k.store.setImportCursor.bind(k.store)
    let armed = true
    spyOn(k.store, "setImportCursor").mockImplementation((id: string, cursor: string) => {
      original(id, cursor)
      if (!armed) return
      armed = false
      setImmediate(() => setImmediate(() => k.handoff.turnEnded(session.id)))
    })
    const pending = k.handoff.follow(session.id)
    const added = await pending
    expect(JSON.parse(k.store.getSession(session.id)!.import_cursor!).offset).toBe(statSync(term.writer.path).size)
    expect(added).toBeLessThan(40)
    expect(added).toBeGreaterThan(0)
  })

  test("a file that shrinks during the read does not hang follow", async () => {
    const k = kit({ followChunkBytes: 1024 })
    const { nativeId, term } = terminalSession(k, 1)
    const session = await importOne(k, nativeId)
    term.writer.turn("big", "x".repeat(10_000))
    const original = k.store.getSession.bind(k.store)
    let calls = 0
    spyOn(k.store, "getSession").mockImplementation((id: string) => {
      const row = original(id)
      // Call 1 is the start of followOnce, call 2 the top of its loop: truncate right before the first read.
      if (++calls === 2) writeFileSync(term.writer.path, "")
      return row
    })
    await k.handoff.follow(session.id)
  }, 2000)

  test("a single line longer than a chunk does not stall the cursor", async () => {
    const k = kit({ followChunkBytes: 1024 })
    const { nativeId, term } = terminalSession(k, 1)
    const session = await importOne(k, nativeId)
    term.writer.turn("big", "x".repeat(10_000))
    term.writer.turn("after", "done")
    await k.handoff.follow(session.id)
    const texts = k.store.listMessages(session.id).map((row) => row.text)
    expect(texts).toContain("after")
    expect(texts).toContain("done")
    expect(JSON.parse(k.store.getSession(session.id)!.import_cursor!).offset).toBe(statSync(term.writer.path).size)
  })

  test("terminal lines arrive as message.append with event ids, and a reconnect replays them once", async () => {
    const k = kit()
    const { nativeId, term } = terminalSession(k, 1)
    const session = await importOne(k, nativeId)
    const sent: Frame[] = []
    const socket = { send: (raw: string) => void sent.push(JSON.parse(raw) as Frame) }
    k.hub.attach(socket)
    k.hub.helloStarted(socket)
    k.hub.resume(socket, { lastEventId: k.hub.lastEventId, sessionId: session.id }).flush()
    term.writer.turn("terminal prompt", "terminal reply")
    await k.handoff.tick()
    const appended = sent.filter((frame) => frame.name === "message.append")
    expect(appended.map((frame) => (frame.payload as { text: string }).text)).toEqual(["terminal prompt", "terminal reply"])
    expect(appended.every((frame) => typeof frame.eventId === "number" && (frame.payload as { imported?: boolean }).imported)).toBe(true)
    // Drop the socket; two more lines arrive meanwhile; the next socket resumes from the last id it saw.
    const seen = sent.at(-1)!.eventId!
    k.hub.detach(socket)
    term.writer.tool("bun test auth", "24 pass")
    await k.handoff.tick()
    await k.handoff.tick()
    const again: Frame[] = []
    const next = { send: (raw: string) => void again.push(JSON.parse(raw) as Frame) }
    k.hub.attach(next)
    k.hub.helloStarted(next)
    const resumed = k.hub.resume(next, { lastEventId: seen, sessionId: session.id })
    expect(resumed.result.resync).toBe(false)
    resumed.flush()
    const replayed = again.filter((frame) => frame.name === "message.append")
    const ids = replayed.map((frame) => (frame.payload as { id: string }).id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(replayed.some((frame) => (frame.payload as { kind: string }).kind === "tool")).toBe(true)
    expect(replayed.some((frame) => (frame.payload as { kind: string }).kind === "permission")).toBe(true)
    expect(replayed.every((frame) => frame.eventId! > seen)).toBe(true)
    k.hub.detach(next)
  })

  test("a restarted daemon follows from import_cursor without duplicating rows", async () => {
    const first = kit()
    const { nativeId, term } = terminalSession(first, 1)
    const session = await importOne(first, nativeId)
    term.writer.turn("a", "b")
    await first.handoff.tick()
    const count = first.store.listMessages(session.id, { limit: 1000 }).length
    await first.close()
    kits = kits.filter((made) => made !== first)
    const second = kit({ root: first.root })
    // The same pid table: the terminal Claude is still running across the daemon restart.
    for (const [pid, proc] of first.procs) second.procs.set(pid, proc)
    await second.handoff.tick()
    expect(second.store.listMessages(session.id, { limit: 1000 })).toHaveLength(count)
    term.writer.turn("c", "d")
    await second.handoff.tick()
    expect(second.store.listMessages(session.id, { limit: 1000 })).toHaveLength(count + 2)
  })

  test("a rename in Rudder is kept; a new ai-title replaces an untouched title", async () => {
    const k = kit()
    const { nativeId, term } = terminalSession(k, 1)
    const session = await importOne(k, nativeId)
    term.writer.title("Second title")
    term.writer.turn("x", "y")
    await k.handoff.tick()
    expect(k.store.getSession(session.id)?.title).toBe("Second title")
    await k.ok("session.patch", { id: session.id, title: "Mine" })
    term.writer.title("Third title")
    term.writer.turn("x2", "y2")
    await k.handoff.tick()
    expect(k.store.getSession(session.id)?.title).toBe("Mine")
  })
})

/** Holds the next page read after it parsed. Spies the private `transcript`: it breaks silently if that method is renamed. */
function holdTranscript(k: Kit) {
  const priv = k.handoff as unknown as { transcript: (path: string) => Promise<unknown> }
  const original = priv.transcript.bind(k.handoff)
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let reading!: () => void
  const started = new Promise<void>((resolve) => {
    reading = resolve
  })
  spyOn(priv, "transcript").mockImplementation(async (path: string) => {
    const read = await original(path)
    reading()
    await gate
    return read
  })
  return { release, started }
}

describe("importEarlier (A5)", () => {
  test("importEarlier keeps a cursor a follow advanced meanwhile", async () => {
    const k = kit()
    const { nativeId, term } = terminalSession(k, 230)
    const session = await importOne(k, nativeId)
    expect(session.importedEarlier).toBe(60)
    const { release, started } = holdTranscript(k)
    const page = k.ok<{ session: Pub }>("handoff.importEarlier", { id: session.id })
    await started
    term.writer.turn("late prompt", "late reply")
    await k.handoff.follow(session.id)
    const advanced = JSON.parse(k.store.getSession(session.id)!.import_cursor!).offset as number
    expect(advanced).toBe(statSync(term.writer.path).size)
    release()
    await page
    const cursor = JSON.parse(k.store.getSession(session.id)!.import_cursor!)
    expect(cursor.offset).toBe(advanced)
    expect(cursor.earlier).toBe(0)
    const texts = k.store.listMessages(session.id, { limit: 10_000 }).map((row) => row.text)
    expect(texts.filter((text) => text === "late prompt")).toHaveLength(1)
    expect(texts.filter((text) => text === "late reply")).toHaveLength(1)
    expect(texts.filter((text) => text === "prompt 0")).toHaveLength(1)
    // The next follow starts from the kept cursor and adds nothing twice.
    expect(await k.handoff.follow(session.id)).toBe(0)
  })

  test("importEarlier keeps the path a follow moved to, with its offset", async () => {
    const k = kit()
    const { nativeId } = terminalSession(k, 230)
    const session = await importOne(k, nativeId)
    const { release, started } = holdTranscript(k)
    const page = k.ok<{ session: Pub }>("handoff.importEarlier", { id: session.id })
    await started
    // The original file moved: a follow resolved another copy and stored its path with its own offset.
    const moved = join(k.root, "moved.jsonl")
    const before = JSON.parse(k.store.getSession(session.id)!.import_cursor!)
    writeFileSync(moved, readFileSync(before.path))
    k.store.setImportCursor(session.id, JSON.stringify({ ...before, path: moved, offset: before.offset + 7 }))
    release()
    await page
    const cursor = JSON.parse(k.store.getSession(session.id)!.import_cursor!)
    expect(cursor.path).toBe(moved)
    expect(cursor.offset).toBe(before.offset + 7)
    expect(cursor.earlier).toBe(0)
  })
})

describe("takeover and release (step 6)", () => {
  test("idle terminal: SIGTERM to that pid only, then the phone writes the same Claude session", async () => {
    const k = kit()
    const { nativeId, term } = terminalSession(k, 1)
    const session = await importOne(k, nativeId)
    const taken = await k.ok<{ session: Pub }>("handoff.takeover", { id: session.id, when: "now" })
    expect(k.kills).toEqual([{ pid: term.pid, signal: "SIGTERM" }])
    expect(taken.session.holder?.kind).toBe("none")
    const last = k.store.lastMessage(session.id)
    expect(last?.kind).toBe("handoff")
    expect(JSON.parse(last!.payload!).handoff).toBe("phone")
    expect((await k.call("message.send", { sessionId: session.id, text: "continue" })).type).toBe("result")
    await k.service.shutdown(500)
    const chain = linearChain(k.transcriptPath(nativeId))
    expect(chain.ok).toBe(true)
    // Exactly one divider for the phone side even though takeover and the send both checked.
    expect(k.store.listMessages(session.id).filter((row) => row.kind === "handoff")).toHaveLength(2)
  })

  test("busy terminal: now is refused, afterTurn waits and takes over once the turn ends", async () => {
    const k = kit()
    const { nativeId, term } = terminalSession(k, 1, { status: "busy" })
    const session = await importOne(k, nativeId)
    expect(errorCode(await k.call("handoff.takeover", { id: session.id, when: "now" }))).toBe("takeover_busy")
    const waiting = await k.ok<{ session: Pub }>("handoff.takeover", { id: session.id, when: "afterTurn" })
    expect(waiting.session.holder?.pendingTakeover).toBe(true)
    await k.handoff.tick()
    expect(k.kills).toHaveLength(0)
    term.setStatus("idle")
    await k.handoff.tick()
    expect(k.kills).toEqual([{ pid: term.pid, signal: "SIGTERM" }])
    expect(k.handoff.holder(k.store.getSession(session.id)!).kind).toBe("none")
  })

  test("takeover and release push no notice (v67 A3b: the person did it and sees it)", async () => {
    const k = kit()
    const { nativeId } = terminalSession(k, 1)
    const session = await importOne(k, nativeId)
    await k.ok("handoff.takeover", { id: session.id, when: "now" })
    await k.ok("handoff.release", { id: session.id })
    await Bun.sleep(20)
    expect(k.pushes).toHaveLength(0)
  })

  test("cancelTakeover clears the wait", async () => {
    const k = kit()
    const { nativeId } = terminalSession(k, 1, { status: "busy" })
    const session = await importOne(k, nativeId)
    await k.ok("handoff.takeover", { id: session.id, when: "afterTurn" })
    const cancelled = await k.ok<{ session: Pub }>("handoff.cancelTakeover", { id: session.id })
    expect(cancelled.session.holder?.pendingTakeover).toBeUndefined()
  })

  test("a Claude that ignores SIGTERM: takeover_failed, one SIGTERM, never SIGKILL, the terminal keeps the session", async () => {
    const k = kit()
    const nativeId = crypto.randomUUID()
    const term = k.terminal(nativeId, { quitsOnTerm: false })
    term.writer.turn("p", "r")
    const session = await importOne(k, nativeId)
    expect(errorCode(await k.call("handoff.takeover", { id: session.id, when: "now" }))).toBe("takeover_failed")
    expect(k.kills).toEqual([{ pid: term.pid, signal: "SIGTERM" }])
    const held = k.handoff.holder(k.store.getSession(session.id)!)
    expect(held.kind).toBe("terminal")
    expect(held.takeoverFailed).toBe(true)
    expect(errorCode(await k.call("message.send", { sessionId: session.id, text: "x" }))).toBe("held_elsewhere")
  })

  test("takeover of a session no terminal holds is a conflict", async () => {
    const k = kit()
    const { nativeId } = terminalSession(k, 1, { exited: true })
    const session = await importOne(k, nativeId)
    expect(errorCode(await k.call("handoff.takeover", { id: session.id, when: "now" }))).toBe("conflict")
    expect(k.kills).toHaveLength(0)
  })

  test("release hands nothing over and gives both commands", async () => {
    const k = kit()
    const { nativeId } = terminalSession(k, 1, { exited: true })
    const session = await importOne(k, nativeId)
    const release = await k.ok<{ command: string; native: string; short: string; running: boolean }>("handoff.release", { id: session.id })
    expect(release.short).toBe(session.id.slice(0, 4))
    expect(release.command).toBe(`rudder attach ${session.id.slice(0, 4)}`)
    expect(release.native).toContain(`claude --resume ${nativeId}`)
    expect(release.running).toBe(false)
    expect(k.handoff.holder(k.store.getSession(session.id)!).kind).toBe("none")
  })

  test("a terminal opening a session mid-turn is a conflict; the turn ends, the daemon lets go, the queue waits", async () => {
    const k = kit()
    const { nativeId } = terminalSession(k, 1, { exited: true })
    const session = await importOne(k, nativeId)
    k.holdNextTurn()
    await k.ok("message.send", { sessionId: session.id, text: "long turn" })
    const term = k.terminal(nativeId)
    expect(k.handoff.holder(k.store.getSession(session.id)!, true).conflict).toBe(true)
    await k.ok("message.send", { sessionId: session.id, text: "queued behind it" })
    k.releaseTurn()
    await Bun.sleep(30)
    expect(k.daemonProcs.size).toBe(0)
    expect(k.handoff.holder(k.store.getSession(session.id)!, true).kind).toBe("terminal")
    expect((await k.ok<{ items: unknown[] }>("queue.list", { sessionId: session.id })).items).toHaveLength(1)
    term.exit()
    await k.handoff.tick()
    await Bun.sleep(30)
    expect((await k.ok<{ items: unknown[] }>("queue.list", { sessionId: session.id })).items).toHaveLength(0)
  })
})

describe("attachDone", () => {
  test("two overlapping calls release the lease once", async () => {
    const k = kit()
    const { nativeId, term } = terminalSession(k, 1)
    const session = await importOne(k, nativeId)
    await k.ok("handoff.takeover", { id: session.id, when: "now" })
    const attach = await k.handoff.attach({ target: session.id.slice(0, 4), pid: 4242 })
    expect(attach.state).toBe("ready")
    const attached = k.terminal(nativeId)
    attached.writer.turn("once", "only once")
    attached.exit()
    const released = spyOn(k.service as unknown as { flushOutbound: (id: string) => void }, "flushOutbound")
    const [first, second] = await Promise.all([k.handoff.attachDone({ sessionId: session.id }), k.handoff.attachDone({ sessionId: session.id })])
    expect(first.added + second.added).toBe(2)
    expect(released.mock.calls.filter((call) => call[0] === session.id)).toHaveLength(1)
    await k.handoff.tick()
    void term
  })

  async function closingSetup() {
    const k = kit()
    const { nativeId } = terminalSession(k, 1)
    const session = await importOne(k, nativeId)
    await k.ok("handoff.takeover", { id: session.id, when: "now" })
    expect((await k.handoff.attach({ target: session.id.slice(0, 4), pid: 4242 })).state).toBe("ready")
    const attached = k.terminal(nativeId)
    attached.writer.turn("last", "words")
    attached.exit()
    const released = spyOn(k.service as unknown as { flushOutbound: (id: string) => void }, "flushOutbound")
    return { k, session, released }
  }

  test("a tick running beside attachDone releases the session once", async () => {
    const { k, session, released } = await closingSetup()
    await Promise.all([k.handoff.attachDone({ sessionId: session.id }), k.handoff.tick()])
    expect(released.mock.calls.filter((call) => call[0] === session.id)).toHaveLength(1)
  })

  test("an earlier-page commit during attachDone's final read keeps the last lines", async () => {
    const { k, session } = await closingSetup()
    const original = k.store.getSession.bind(k.store)
    const setCursor = k.store.setImportCursor.bind(k.store)
    let calls = 0
    spyOn(k.store, "getSession").mockImplementation((id: string) => {
      const row = original(id)
      // Calls 1-2 are attachDone and the start of followOnce, call 3 the top of its loop: rewrite only `earlier` right before the read.
      if (++calls === 3 && row) setCursor(id, JSON.stringify({ ...JSON.parse(row.import_cursor!), earlier: 5 }))
      return row
    })
    const done = await k.handoff.attachDone({ sessionId: session.id })
    expect(done.added).toBe(2)
    expect(k.store.listMessages(session.id).map((row) => row.text)).toContain("words")
  })

  test("releasing an attach drops a queued afterTurn takeover", async () => {
    const { k, session } = await closingSetup()
    ;(k.handoff as unknown as { pending: Map<string, number> }).pending.set(session.id, Date.now())
    await k.handoff.attachDone({ sessionId: session.id })
    expect((k.handoff as unknown as { pending: Map<string, number> }).pending.has(session.id)).toBe(false)
  })

  test("the phone stays gated while attachDone reads the terminal's last lines", async () => {
    const { k, session } = await closingSetup()
    const done = k.handoff.attachDone({ sessionId: session.id })
    expect(() => k.handoff.gate(session.id)).toThrow()
    await done
    expect(() => k.handoff.gate(session.id)).not.toThrow()
  })
})

describe("single writer (acceptance)", () => {
  test("terminal → phone → terminal (attach) → phone: the transcript never branches", async () => {
    const k = kit()
    const path = (id: string) => k.transcriptPath(id)
    // 1. A terminal session, imported while it still runs: the phone may only watch.
    const { nativeId, term } = terminalSession(k, 2)
    const session = await importOne(k, nativeId)
    expect(errorCode(await k.call("message.send", { sessionId: session.id, text: "too early" }))).toBe("held_elsewhere")
    term.writer.turn("terminal 3", "reply 3")
    await k.handoff.tick()
    // 2. Take over: the terminal Claude quits, then the daemon's claude resumes and writes.
    await k.ok("handoff.takeover", { id: session.id, when: "now" })
    await k.ok("message.send", { sessionId: session.id, text: "phone 1" })
    await Bun.sleep(20)
    expect(k.daemonProcs.size).toBe(1)
    // 3. rudder attach: the daemon's process is let go before the terminal one starts.
    const attach = await k.handoff.attach({ target: session.id.slice(0, 4), pid: 4242 })
    expect(attach.state).toBe("ready")
    expect(k.daemonProcs.size).toBe(0)
    expect(errorCode(await k.call("message.send", { sessionId: session.id, text: "during attach" }))).toBe("held_elsewhere")
    const attached = k.terminal(nativeId)
    attached.writer.turn("terminal again", "reply again")
    attached.exit()
    const done = await k.handoff.attachDone({ sessionId: session.id })
    expect(done.added).toBe(2)
    // 4. Back on the phone.
    await k.ok("message.send", { sessionId: session.id, text: "phone 2" })
    await k.service.shutdown(500)
    const chain = linearChain(path(nativeId))
    expect(chain.forks).toEqual([])
    expect(chain.records).toBeGreaterThan(10)
    const texts = k.store.listMessages(session.id, { limit: 1000 }).map((row) => (row.kind === "handoff" ? `[${JSON.parse(row.payload!).handoff}]` : row.text))
    expect(texts).toEqual([
      "[terminal]",
      "prompt 0", "reply 0", "prompt 1", "reply 1",
      "terminal 3", "reply 3",
      "[phone]",
      "phone 1", "daemon heard: phone 1",
      "[terminal]",
      "terminal again", "reply again",
      "[phone]",
      "phone 2", "daemon heard: phone 2",
    ])
  })
})

describe("paths", () => {
  test("a hidden registry file does not crash the reader", () => {
    const k = kit()
    writeFileSync(join(k.registryDir, "bad.json"), "{")
    expect(readRegistry(k.registryDir, { alive: () => true, startTime: () => "x" })).toEqual([])
  })
})

// review2-1117: every 2 s the poll worked out each bound Claude session's holder, archived ones included, and built
// its whole public session before finding the holder unchanged.
describe("poll skips idle work (review2-1117)", () => {
  function spyHolders(k: Kit) {
    const ids: string[] = []
    const handoff = k.handoff as unknown as { holder: (row: { id: string }, fresh?: boolean) => unknown }
    const holder = handoff.holder.bind(k.handoff)
    handoff.holder = (row, fresh) => {
      ids.push(row.id)
      return holder(row, fresh)
    }
    return ids
  }

  function spyPublic(k: Kit) {
    const ids: string[] = []
    const host = (k.handoff as unknown as { host: { publicSession: (id: string) => unknown } }).host
    const publicSession = host.publicSession
    host.publicSession = (id) => {
      ids.push(id)
      return publicSession(id)
    }
    return ids
  }

  test("idle history is not scanned alongside a live terminal", async () => {
    const k = kit()
    const { nativeId, term } = terminalSession(k, 1)
    const active = await importOne(k, nativeId)
    for (let index = 0; index < 1000; index += 1) {
      k.store.createSession({ agent: "claude", nativeId: `idle-${index}` })
    }
    const looked = spyHolders(k)
    await k.handoff.tick()
    expect(new Set(looked)).toEqual(new Set([active.id]))
    term.exit()
    const published = spyPublic(k)
    await k.handoff.tick()
    expect(published).toContain(active.id)
  })

  test("an archived session no terminal holds is not looked at", async () => {
    const k = kit()
    const { nativeId, term } = terminalSession(k, 1)
    const session = await importOne(k, nativeId)
    term.exit()
    await k.handoff.tick()
    await k.ok("session.patch", { id: session.id, archived: true })
    await k.handoff.tick()
    const looked = spyHolders(k)
    await k.handoff.tick()
    expect(looked).not.toContain(session.id)
  })

  test("an archived session a terminal holds is still followed and shown as held", async () => {
    const k = kit()
    const { nativeId, term } = terminalSession(k, 1)
    const session = await importOne(k, nativeId)
    await k.ok("session.patch", { id: session.id, archived: true })
    await k.handoff.tick()
    const count = k.store.listMessages(session.id, { limit: 1000 }).length
    term.writer.turn("archived prompt", "archived reply")
    await k.handoff.tick()
    expect(k.store.listMessages(session.id, { limit: 1000 })).toHaveLength(count + 2)
    expect((k.handoff.holder(k.store.getSession(session.id)!) as { kind: string }).kind).toBe("terminal")
    // The terminal exits: the release is still published for the archived row.
    const published = spyPublic(k)
    term.exit()
    await k.handoff.tick()
    expect(published).toContain(session.id)
    expect((k.handoff.holder(k.store.getSession(session.id)!) as { kind: string }).kind).not.toBe("terminal")
  })

  test("a holder that has not changed builds no public session", async () => {
    const k = kit()
    const { nativeId } = terminalSession(k, 1)
    const session = await importOne(k, nativeId)
    await k.handoff.tick()
    await k.handoff.tick()
    const published = spyPublic(k)
    await k.handoff.tick()
    expect(published).not.toContain(session.id)
  })

  // review3-1117: archived rows came back only for a terminal, so one last shown held by Rudder's own process kept
  // that holder after the process exited (an idle Claude stopping on its timer broadcasts nothing itself).
  test("an archived session last shown held by Rudder publishes its release", async () => {
    const k = kit()
    const { nativeId, term } = terminalSession(k, 1)
    const session = await importOne(k, nativeId)
    term.exit()
    await k.handoff.tick()
    const host = (k.handoff as unknown as { host: { activeSessions: () => Iterable<string>; hasAgentProcess: (id: string) => boolean } }).host
    let processAlive = true
    host.activeSessions = () => processAlive ? [session.id] : []
    host.hasAgentProcess = (id) => processAlive && id === session.id
    await k.handoff.tick()
    expect((k.handoff.holder(k.store.getSession(session.id)!) as { kind: string }).kind).toBe("rudder")
    await k.ok("session.patch", { id: session.id, archived: true })
    await k.handoff.tick()
    processAlive = false
    const published = spyPublic(k)
    await k.handoff.tick()
    expect(published).toContain(session.id)
    // Shown released, the row drops out of the poll again.
    const looked = spyHolders(k)
    await k.handoff.tick()
    expect(looked).not.toContain(session.id)
  })
})
