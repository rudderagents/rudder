import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFakeAdapter } from "./adapter/fake"
import { EventHub } from "./event-hub"
import type { Frame } from "./protocol"
import { SessionService } from "./session-service"
import { Store, TOMBSTONE_DAYS } from "./store"

async function waitFor(predicate: () => boolean, timeoutMs = 4000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out")
    await Bun.sleep(5)
  }
}

function payload(frame: Frame): Record<string, unknown> {
  return (frame.payload ?? {}) as Record<string, unknown>
}

type Row = { id: string; rev: number; seq: number; text: string; kind: string; permission?: { status: string }; tool?: { status: string } }
type Changes = { reset?: true; generation: number; lastRev: number; hasMore?: boolean; rows?: Row[] }

function harness() {
  const store = new Store(":memory:")
  const events: Frame[] = []
  const service = new SessionService(store, createFakeAdapter(), (frame) => events.push(frame))
  let n = 0
  const call = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    const frame = await service.invoke(method, params, `c${n++}`)
    if (frame.type !== "result") throw new Error(`${method}: ${JSON.stringify(frame.error)}`)
    return frame.result as T
  }
  const idle = (id: string) =>
    events.filter((event) => event.name === "agent.status" && payload(event).sessionId === id && payload(event).status === "idle").length
  return { store, events, service, call, idle }
}

function insert(store: Store, sessionId: string, id: string, text: string, payload: string | null = null) {
  return store.insertMessage({ id, session_id: sessionId, kind: "text", role: "assistant", text, payload, created_at: Date.now() })
}

describe("message rev", () => {
  test("migration backfills rev in seq order and the session counter to the newest", () => {
    const dir = mkdtempSync(join(tmpdir(), "rudder-sync-"))
    try {
      const path = join(dir, "rudder.db")
      // A database from before r64: no rev, generation, version, counters or triggers.
      const db = new Database(path)
      db.exec(`
        CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, agent TEXT NOT NULL, status TEXT NOT NULL,
          pinned INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
        CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL,
          role TEXT NOT NULL, text TEXT NOT NULL, payload TEXT, created_at INTEGER NOT NULL);
        INSERT INTO sessions VALUES ('a', 'A', 'claude', 'idle', 0, 20), ('b', 'B', 'claude', 'idle', 0, 10);
        INSERT INTO messages VALUES ('a3', 'a', 3, 'text', 'user', 'three', NULL, 3), ('a1', 'a', 1, 'text', 'user', 'one', NULL, 1),
          ('a2', 'a', 2, 'text', 'assistant', 'two', NULL, 2), ('b1', 'b', 1, 'text', 'user', 'only', NULL, 1);
      `)
      db.close()
      const store = new Store(path)
      expect(store.listMessages("a").map((row) => [row.id, row.rev])).toEqual([["a1", 1], ["a2", 2], ["a3", 3]])
      expect(store.getSession("a")?.rev_counter).toBe(3)
      expect(store.getSession("b")?.rev_counter).toBe(1)
      expect(store.getSession("a")?.generation).toBe(0)
      // Every session has a version (the first open's own backfills move them again); the counter is the newest.
      const versions = ["a", "b"].map((id) => store.getSession(id)?.version ?? 0)
      expect(versions.every((version) => version > 0)).toBe(true)
      expect(new Set(versions).size).toBe(2)
      expect(store.sessionVersion()).toBe(Math.max(...versions))
      // The next write continues from the backfilled counter.
      expect(insert(store, "a", "a4", "four").rev).toBe(4)
      store.db.close()
      // Reopening does not backfill again.
      const again = new Store(path)
      expect(again.listMessages("a").map((row) => row.rev)).toEqual([1, 2, 3, 4])
      again.db.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("insert, changed upsert and payload update each take the next rev; seq stays", () => {
    const store = new Store(":memory:")
    const session = store.createSession()
    const first = insert(store, session.id, "m1", "hello")
    const second = insert(store, session.id, "m2", "world")
    expect([first.rev, second.rev]).toEqual([1, 2])
    const patched = insert(store, session.id, "m1", "hello again")
    expect(patched.rev).toBe(3)
    expect(patched.seq).toBe(first.seq)
    const withPayload = insert(store, session.id, "m1", "hello again", JSON.stringify({ steer: "read" }))
    expect(withPayload.rev).toBe(4)
    expect(store.getMessage("m1")?.rev).toBe(4)
    expect(store.getSession(session.id)?.rev_counter).toBe(4)
  })

  test("rewind and clear raise generation and never reuse a rev", () => {
    const store = new Store(":memory:")
    const session = store.createSession()
    for (let i = 1; i <= 3; i++) insert(store, session.id, `m${i}`, `t${i}`)
    store.rewindSession(session.id, 1)
    expect(store.getSession(session.id)?.generation).toBe(1)
    const after = insert(store, session.id, "n2", "new")
    expect(after.seq).toBe(2)
    expect(after.rev).toBe(4)
    store.clearMessages(session.id)
    expect(store.getSession(session.id)?.generation).toBe(2)
    expect(insert(store, session.id, "n1", "fresh").rev).toBe(5)
  })
})

describe("message.changes", () => {
  test("appended rows come back after the cursor, rev ascending, with rev on every message JSON", async () => {
    const h = harness()
    const session = h.store.createSession()
    insert(h.store, session.id, "m1", "one")
    const got = await h.call<{ generation: number; lastRev: number; session: { generation: number; lastRev: number }; messages: Row[] }>(
      "session.get",
      { id: session.id },
    )
    expect(got.generation).toBe(0)
    expect(got.lastRev).toBe(1)
    expect(got.session).toMatchObject({ generation: 0, lastRev: 1 })
    expect(got.messages[0]?.rev).toBe(1)
    insert(h.store, session.id, "m2", "two")
    insert(h.store, session.id, "m3", "three")
    const changes = await h.call<Changes>("message.changes", { sessionId: session.id, generation: 0, sinceRev: 1 })
    expect(changes).toMatchObject({ generation: 0, lastRev: 3, hasMore: false })
    expect(changes.rows?.map((row) => [row.id, row.rev])).toEqual([["m2", 2], ["m3", 3]])
    const none = await h.call<Changes>("message.changes", { sessionId: session.id, generation: 0, sinceRev: 3 })
    expect(none.rows).toEqual([])
  })

  test("pages with hasMore and caps the limit at 500", async () => {
    const h = harness()
    const session = h.store.createSession()
    for (let i = 0; i < 5; i++) insert(h.store, session.id, `m${i}`, `t${i}`)
    const first = await h.call<Changes>("message.changes", { sessionId: session.id, generation: 0, sinceRev: 0, limit: 2 })
    expect(first.hasMore).toBe(true)
    expect(first.rows?.map((row) => row.rev)).toEqual([1, 2])
    const second = await h.call<Changes>("message.changes", { sessionId: session.id, generation: 0, sinceRev: 2, limit: 2 })
    expect(second.rows?.map((row) => row.rev)).toEqual([3, 4])
    const last = await h.call<Changes>("message.changes", { sessionId: session.id, generation: 0, sinceRev: 4, limit: 2 })
    expect(last).toMatchObject({ hasMore: false, lastRev: 5 })
    for (let i = 5; i < 520; i++) insert(h.store, session.id, `m${i}`, `t${i}`)
    const capped = await h.call<Changes>("message.changes", { sessionId: session.id, generation: 0, sinceRev: 0, limit: 10_000 })
    expect(capped.rows).toHaveLength(500)
    expect(capped.hasMore).toBe(true)
    const defaulted = await h.call<Changes>("message.changes", { sessionId: session.id, generation: 0, sinceRev: 0 })
    expect(defaulted.rows).toHaveLength(200)
  })

  test("a tool completing and an approval result come back as in-place changes", async () => {
    const h = harness()
    const created = await h.call<{ session: { id: string } }>("session.create", { title: "新会话" })
    const sessionId = created.session.id
    await h.call("message.send", { sessionId, text: "run ls" })
    await waitFor(() => h.events.some((event) => event.name === "permission.asked"))
    const asked = payload(h.events.find((event) => event.name === "permission.asked")!)
    const before = await h.call<{ lastRev: number; messages: Row[] }>("session.get", { id: sessionId })
    const permissionRow = before.messages.find((row) => row.kind === "permission")!
    const toolRow = before.messages.find((row) => row.kind === "tool")
    await h.call("permission.respond", { id: asked.id as string, allow: true })
    await waitFor(() => h.idle(sessionId) >= 1)
    const changes = await h.call<Changes>("message.changes", { sessionId, generation: 0, sinceRev: before.lastRev })
    const rows = changes.rows ?? []
    const permission = rows.find((row) => row.id === permissionRow.id)
    expect(permission?.permission?.status).not.toBe("pending")
    expect(permission!.rev).toBeGreaterThan(permissionRow.rev)
    expect(permission!.seq).toBe(permissionRow.seq)
    if (toolRow) {
      const tool = rows.find((row) => row.id === toolRow.id)
      expect(tool?.tool?.status).toBe("completed")
      expect(tool!.rev).toBeGreaterThan(toolRow.rev)
    } else {
      expect(rows.some((row) => row.kind === "tool" && row.tool?.status === "completed")).toBe(true)
    }
    // Rev ascending, each row once, and the events carried the same revs.
    const revs = rows.map((row) => row.rev)
    expect(revs).toEqual([...revs].sort((a, b) => a - b))
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length)
    const appended = h.events.filter((event) => event.name === "message.append").map(payload)
    expect(appended.every((row) => typeof row.rev === "number")).toBe(true)
  })

  test("rewind and clear answer reset with the new generation", async () => {
    const h = harness()
    const session = h.store.createSession()
    for (let i = 1; i <= 3; i++) insert(h.store, session.id, `m${i}`, `t${i}`)
    await h.call("session.rewind", { id: session.id, seq: 1 })
    const rewound = await h.call<Changes>("message.changes", { sessionId: session.id, generation: 0, sinceRev: 3 })
    expect(rewound).toEqual({ reset: true, generation: 1, lastRev: 3 })
    await h.call("session.clear", { id: session.id })
    const cleared = await h.call<Changes>("message.changes", { sessionId: session.id, generation: 1, sinceRev: 3 })
    expect(cleared).toMatchObject({ reset: true, generation: 2 })
    insert(h.store, session.id, "n1", "fresh")
    const fresh = await h.call<Changes>("message.changes", { sessionId: session.id, generation: 2, sinceRev: 3 })
    expect(fresh.rows?.map((row) => row.id)).toEqual(["n1"])
  })

  test("outline trims bodies like session.get outline; unknown session is not_found", async () => {
    const h = harness()
    const session = h.store.createSession()
    const long = "x".repeat(500)
    h.store.insertMessage({ id: "r1", session_id: session.id, kind: "reasoning", role: "assistant", text: long, payload: JSON.stringify({ startedAt: 1, endedAt: 2 }), created_at: 1 })
    h.store.insertMessage({ id: "u1", session_id: session.id, kind: "text", role: "user", text: "later prompt", created_at: 2 })
    const light = await h.call<{ rows: Array<Row & { trimmed?: true }> }>("message.changes", { sessionId: session.id, generation: 0, sinceRev: 0, outline: true })
    expect(light.rows[0]?.trimmed).toBe(true)
    expect(light.rows[0]?.text.length).toBeLessThan(long.length)
    const full = await h.call<{ rows: Row[] }>("message.changes", { sessionId: session.id, generation: 0, sinceRev: 0 })
    expect(full.rows[0]?.text).toBe(long)
    const missing = await h.service.invoke("message.changes", { sessionId: "nope", generation: 0, sinceRev: 0 }, "x")
    expect(missing.error?.code).toBe("not_found")
  })
})

describe("session.list sinceVersion", () => {
  test("pin, archive, rename and delete each show up in the delta; the full list carries the cursor", async () => {
    const h = harness()
    const a = h.store.createSession({ title: "A" })
    const b = h.store.createSession({ title: "B" })
    const c = h.store.createSession({ title: "C" })
    const full = await h.call<{ sessions: Array<{ id: string; version: number }>; version: number }>("session.list", {})
    expect(full.sessions).toHaveLength(3)
    expect(full.sessions.every((row) => row.version > 0 && row.version <= full.version)).toBe(true)
    const quiet = await h.call<{ sessions: unknown[]; deleted: string[]; version: number }>("session.list", { sinceVersion: full.version })
    expect(quiet).toEqual({ sessions: [], deleted: [], version: full.version })

    await h.call("session.patch", { id: a.id, pinned: true })
    const pinned = await h.call<{ sessions: Array<{ id: string; pinned: boolean; updatedAt: number }>; version: number }>("session.list", { sinceVersion: full.version })
    expect(pinned.sessions.map((row) => row.id)).toEqual([a.id])
    expect(pinned.sessions[0]?.pinned).toBe(true)
    // Pinning still leaves updated_at alone.
    expect(pinned.sessions[0]?.updatedAt).toBe(a.updated_at)

    await h.call("session.patch", { id: b.id, archived: true })
    await h.call("session.patch", { id: c.id, title: "C renamed" })
    const later = await h.call<{ sessions: Array<{ id: string; title: string }>; version: number }>("session.list", { sinceVersion: pinned.version })
    expect(later.sessions.map((row) => row.id).sort()).toEqual([b.id, c.id].sort())
    expect(later.sessions.find((row) => row.id === c.id)?.title).toBe("C renamed")

    await h.call("session.delete", { id: b.id })
    const deleted = await h.call<{ sessions: unknown[]; deleted: string[]; version: number }>("session.list", { sinceVersion: later.version })
    expect(deleted.sessions).toEqual([])
    expect(deleted.deleted).toEqual([b.id])
    expect(deleted.version).toBeGreaterThan(later.version)
  })

  test("a change outside the row (a session.upsert) moves the version too", async () => {
    const h = harness()
    const a = h.store.createSession({ title: "A" })
    // An ack that reads something: one of a chat already read sends nothing (perf-1112 round two).
    h.store.patchSession(a.id, { unread: true })
    const start = h.store.sessionVersion()
    await h.call("session.ack", { id: a.id })
    const delta = await h.call<{ sessions: Array<{ id: string; version: number }>; version: number }>("session.list", { sinceVersion: start })
    expect(delta.sessions.map((row) => row.id)).toEqual([a.id])
    const upsert = h.events.filter((event) => event.name === "session.upsert").at(-1)!
    expect(payload(upsert).version).toBe(delta.version)
  })

  test("a cursor behind a pruned tombstone or ahead of this store resets", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rudder-sync-"))
    try {
      const path = join(dir, "rudder.db")
      const store = new Store(path)
      const gone = store.createSession({ title: "old" })
      const cursor = store.sessionVersion()
      store.deleteSession(gone.id)
      expect(store.sessionChanges(cursor)).toMatchObject({ reset: false, deleted: [gone.id] })
      store.db.query("UPDATE session_tombstones SET deleted_at = ?").run(Date.now() - (TOMBSTONE_DAYS + 1) * 86_400_000)
      store.db.close()
      const reopened = new Store(path)
      const service = new SessionService(reopened, createFakeAdapter(), () => {})
      const stale = await service.invoke("session.list", { sinceVersion: cursor }, "1")
      expect(stale.result).toEqual({ reset: true, version: reopened.sessionVersion() })
      const ahead = await service.invoke("session.list", { sinceVersion: reopened.sessionVersion() + 10 }, "2")
      expect(ahead.result).toMatchObject({ reset: true })
      const current = await service.invoke("session.list", { sinceVersion: reopened.sessionVersion() }, "3")
      expect(current.result).toMatchObject({ sessions: [], deleted: [] })
      reopened.db.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("sync feature", () => {
  test("offered on a full socket, not on a free relay (`only`) socket", () => {
    const hub = new EventHub(null)
    const restricted = { send() {} }
    hub.attach(restricted, { only: new Set(["session.upsert"]) })
    hub.helloStarted(restricted)
    expect(hub.resume(restricted, { features: ["chain", "sync", "queueResume", "delta"] }).result.features).toEqual(["delta"])
    const full = { send() {} }
    hub.attach(full)
    hub.helloStarted(full)
    expect(hub.resume(full, { features: ["sync"] }).result.features).toEqual(["sync"])
    hub.close()
  })
})
