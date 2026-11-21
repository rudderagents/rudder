import { describe, expect, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { createFakeAdapter } from "./adapter/fake"
import { SessionService } from "./session-service"
import { messagePublic, NOTICE_PAYLOAD, previewText, sessionPublic, Store, type MessageRow } from "./store"

function message(sessionId: string, overrides: Partial<MessageRow> = {}) {
  return {
    id: crypto.randomUUID(),
    session_id: sessionId,
    kind: "text",
    role: "assistant",
    text: "x",
    created_at: 1,
    ...overrides,
  }
}

// A database from before r64 sync had no triggers; they name every column, so a column cannot go while they exist.
function dropTriggers(db: Database) {
  for (const row of db.query("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as Array<{ name: string }>) {
    db.exec(`DROP TRIGGER ${row.name}`)
  }
}

test("lastPromptSeq seeks past a 100k assistant tail in an upgraded database", () => {
  const directory = mkdtempSync(join(tmpdir(), "rudder-prompt-index-"))
  const path = join(directory, "old.sqlite")
  let store = new Store(path)
  try {
    store.db.exec("DROP INDEX IF EXISTS messages_user_prompt_seq")
    const id = store.createSession().id
    const other = store.createSession().id
    store.insertMessage(message(id, { role: "user", text: "prompt" }))
    store.insertMessage(message(other, { role: "user", kind: "error" }))
    store.db.query(`WITH RECURSIVE tail(n) AS (SELECT 2 UNION ALL SELECT n + 1 FROM tail WHERE n <= 100000)
      INSERT INTO messages(id, session_id, seq, kind, role, text, created_at)
      SELECT 'tail-' || n, ?1, n, CASE WHEN n = 100001 THEN 'error' ELSE 'text' END,
        CASE WHEN n = 100001 THEN 'user' ELSE 'assistant' END, 'tail', 1 FROM tail`).run(id)
    store.db.close()
    store = new Store(path)
    expect(store.lastPromptSeq(id)).toBe(1)
    expect(store.lastPromptSeq(other)).toBeNull()
    const plan = store.db.query(`EXPLAIN QUERY PLAN SELECT MAX(seq) AS seq
      FROM messages WHERE session_id = ? AND role = 'user' AND kind != 'error'`).all(id)
    expect(JSON.stringify(plan)).toContain("messages_user_prompt_seq")
    store.rewindSession(id, 1)
    expect(store.lastPromptSeq(id)).toBe(1)
    store.clearMessages(id)
    expect(store.lastPromptSeq(id)).toBeNull()
  } finally {
    store.db.close()
    rmSync(directory, { recursive: true, force: true })
  }
}, 30_000)

describe("store writes", () => {
  test("the sample session's first message carries copy, and the session is named by its first message", () => {
    const store = new Store(":memory:")
    store.seedIfEmpty()
    const session = store.listSessions()[0]!
    expect(session.auto_title).toBe(1)
    const row = messagePublic(store.listMessages(session.id)[0]!) as { text: string; copy?: unknown }
    expect(row.text).toBe("rudderd 已就绪。发一条消息试试。")
    expect(row.copy).toEqual({ code: "welcome", text: "rudderd 已就绪。发一条消息试试。" })
    // Second review: the placeholder title rides as copy, so a non-Chinese phone does not open on 「示例会话」.
    expect(sessionPublic(session).titleCopy).toEqual({ code: "demo_title", text: "示例会话" })
    const renamed = store.patchSession(session.id, { title: "mine" })!
    expect(renamed.auto_title).toBe(0)
    expect(sessionPublic(renamed).titleCopy).toBeUndefined()
  })

  test("revoking a device also deletes the Live Activity rows that hold its key", () => {
    const store = new Store(":memory:")
    const keep = { id: "a", session_key: "k".repeat(64), name: "A", created_at: 1, push_token: null }
    const gone = { id: "b", session_key: "g".repeat(64), name: "B", created_at: 2, push_token: null }
    store.putDevice(keep)
    store.putDevice(gone)
    const live = (sessionId: string, deviceKey: string) => ({
      session_id: sessionId,
      activity_id: `act-${sessionId}`,
      push_token: "aa",
      device_key: deviceKey,
      keep_seconds: 0,
      locale: "zh",
      started_at: 1,
    })
    store.putLiveActivity(live("s1", gone.session_key))
    store.putLiveActivity(live("s2", keep.session_key))
    store.putLiveActivity(live("s3", gone.session_key))
    expect(store.deleteDevice("b")?.id).toBe("b")
    expect(store.listLiveActivities().map((row) => row.session_id)).toEqual(["s2"])
  })

  test("pragmas favour WAL throughput and wait on a locked database", () => {
    const store = new Store(":memory:")
    expect(store.db.query("PRAGMA synchronous").get()).toEqual({ synchronous: 1 })
    expect(store.db.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 2000 })
  })

  test("an upsert keeps the first created_at", () => {
    const store = new Store(":memory:")
    const row = message("s", { created_at: 100 })
    store.insertMessage(row)
    store.insertMessage({ ...row, text: "more", created_at: 200 })
    expect(store.getMessage(row.id)).toMatchObject({ text: "more", created_at: 100 })
  })

  test("re-upserting an existing message leaves the session row alone", () => {
    const store = new Store(":memory:")
    const session = store.createSession()
    const row = message(session.id)
    store.insertMessage(row)
    store.db.query("UPDATE sessions SET updated_at = 5 WHERE id = ?").run(session.id)
    store.insertMessage({ ...row, text: "patched" })
    expect(store.getSession(session.id)).toMatchObject({ updated_at: 5, last_seq: 1 })
  })

  test("pin and archive keep updated_at; a rename in the same patch still refreshes it", () => {
    const store = new Store(":memory:")
    const session = store.createSession({ title: "keep" })
    store.db.query("UPDATE sessions SET updated_at = 5 WHERE id = ?").run(session.id)
    expect(store.patchSession(session.id, { pinned: true })).toMatchObject({ updated_at: 5, pinned: 1 })
    expect(store.patchSession(session.id, { archived: true })).toMatchObject({ updated_at: 5, archived: 1 })
    expect(store.patchSession(session.id, { pinned: false, unread: true })).toMatchObject({ updated_at: 5, pinned: 0, marked_unread: 1 })
    const renamed = store.patchSession(session.id, { title: "renamed", archived: false })
    expect(renamed).toMatchObject({ title: "renamed", archived: 0 })
    expect(renamed!.updated_at).toBeGreaterThan(5)
    const other = store.createSession()
    store.db.query("UPDATE sessions SET updated_at = 5 WHERE id = ?").run(other.id)
    expect(store.patchSession(other.id)!.updated_at).toBeGreaterThan(5)
  })

  test("a message id cannot move to another session", () => {
    const store = new Store(":memory:")
    const row = message("a", { text: "mine" })
    store.insertMessage(row)
    expect(() => store.insertMessage({ ...row, session_id: "b", text: "stolen" })).toThrow()
    expect(store.getMessage(row.id)).toMatchObject({ session_id: "a", text: "mine" })
    expect(store.listMessages("b")).toHaveLength(0)
  })

  test("fork is all or nothing", async () => {
    const store = new Store(":memory:")
    const source = store.createSession({ title: "src" })
    for (let i = 0; i < 3; i++) store.insertMessage(message(source.id))
    const insert = store.insertMessage.bind(store)
    let calls = 0
    store.insertMessage = (row) => {
      calls += 1
      if (calls === 2) throw new Error("disk full")
      return insert(row)
    }
    await expect(store.forkSession(source.id)).rejects.toThrow("disk full")
    expect(store.listSessions()).toHaveLength(1)
    expect(store.db.query("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 3 })
  })

  test("delete, clear and rewind run in one transaction each", () => {
    const store = new Store(":memory:")
    const session = store.createSession()
    for (let i = 0; i < 3; i++) store.insertMessage(message(session.id))
    const seen: boolean[] = []
    const original = store.db.query.bind(store.db)
    ;(store.db as { query: typeof store.db.query }).query = ((sql: string) => {
      if (/^\s*(DELETE|UPDATE)/i.test(sql)) seen.push(store.db.inTransaction)
      return original(sql)
    }) as typeof store.db.query
    store.rewindSession(session.id, 2)
    store.clearMessages(session.id)
    store.deleteSession(session.id)
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every(Boolean)).toBe(true)
  })
})

describe("list and get queries", () => {
  test("scheduled counts come from one grouped query on an index", async () => {
    const store = new Store(":memory:")
    const a = store.createSession()
    const b = store.createSession()
    for (let i = 0; i < 2; i++) store.insertScheduled({ id: crypto.randomUUID(), session_id: a.id, text: "t", fire_at: Date.now() + 60_000 })
    const done = store.insertScheduled({ id: crypto.randomUUID(), session_id: b.id, text: "t", fire_at: Date.now() + 60_000 })
    store.claimScheduled(done.id, "cancelled")
    expect(store.pendingScheduledCounts()).toEqual(new Map([[a.id, 2]]))
    const plan = JSON.stringify(
      store.db.query("EXPLAIN QUERY PLAN SELECT COUNT(*) FROM scheduled WHERE session_id = ? AND status = 'pending'").all("x"),
    )
    expect(plan).toContain("scheduled_session_status")

    const service = new SessionService(store, createFakeAdapter(), () => {})
    let perSession = 0
    const count = store.scheduledCount.bind(store)
    store.scheduledCount = (id) => {
      perSession += 1
      return count(id)
    }
    const listed = await service.invoke("session.list", {}, "l")
    const sessions = (listed.result as { sessions: Array<{ id: string; scheduledCount: number }> }).sessions
    expect(sessions.find((session) => session.id === a.id)?.scheduledCount).toBe(2)
    expect(sessions.find((session) => session.id === b.id)?.scheduledCount).toBe(0)
    expect(perSession).toBe(0)
  })

  test("session.get pages the newest 80 and probes for more without loading the rest", async () => {
    const store = new Store(":memory:")
    const service = new SessionService(store, createFakeAdapter(), () => {})
    const exact = store.createSession()
    const over = store.createSession()
    for (let i = 0; i < 80; i++) store.insertMessage(message(exact.id))
    for (let i = 0; i < 81; i++) store.insertMessage(message(over.id))
    const list = store.listMessages.bind(store)
    let unbounded = 0
    store.listMessages = (id, options = {}) => {
      if (options.limit === undefined) unbounded += 1
      return list(id, options)
    }
    const a = (await service.invoke("session.get", { id: exact.id }, "a")).result as { messages: unknown[]; hasMore: boolean }
    const b = (await service.invoke("session.get", { id: over.id }, "b")).result as { messages: unknown[]; hasMore: boolean }
    expect([a.messages.length, a.hasMore]).toEqual([80, false])
    expect([b.messages.length, b.hasMore]).toEqual([80, true])
    expect(unbounded).toBe(0)
  })
})

describe("list preview", () => {
  test("previewText strips Markdown marks into one capped line", () => {
    expect(previewText("## Plan\n\n**Bold** and `code`  here")).toBe("Plan Bold and code here")
    expect(previewText("- [x] done\n- second\n1. third\n> quoted")).toBe("done second third quoted")
    expect(previewText("| file | lines |\n| --- | ---: |\n| a.ts | 12 |")).toBe("file lines a.ts 12")
    expect(previewText("see [the docs](https://x.dev) and ![img](a.png)\n---\n```ts\nconst a = 1\n```")).toBe(
      "see the docs and img const a = 1",
    )
    expect(previewText("an *emphasis* in __init__ and snake_case_name, 2 * 3 * 4")).toBe(
      "an emphasis in __init__ and snake_case_name, 2 * 3 * 4",
    )
    expect(previewText("  \n```\n\n```\n  ")).toBe("")
    const long = "字".repeat(130)
    expect(previewText(long)).toBe(`${"字".repeat(120)}…`)
    expect(Array.from(previewText("😀".repeat(200)))).toHaveLength(121)
  })

  test("the newest user or assistant text row is the preview; other rows and older blocks leave it", () => {
    const store = new Store(":memory:")
    const session = store.createSession()
    const preview = () => sessionPublic(store.getSession(session.id)!).preview
    expect(preview()).toBeNull()

    store.insertMessage(message(session.id, { role: "user", text: "run **ls**", created_at: 10 }))
    expect(preview()).toEqual({ role: "user", text: "run ls", createdAt: 10 })

    const block = message(session.id, { text: "Here", created_at: 20 })
    store.insertMessage(block)
    store.insertMessage({ ...block, text: "Here are the files:" })
    expect(preview()).toEqual({ role: "assistant", text: "Here are the files:", createdAt: 20 })

    store.insertMessage(message(session.id, { kind: "tool", text: "Bash: ls" }))
    store.insertMessage(message(session.id, { kind: "error", text: "Error: boom" }))
    store.insertMessage(message(session.id, { text: "```\n```" }))
    expect(preview()?.text).toBe("Here are the files:")

    const later = message(session.id, { text: "Done.", created_at: 30 })
    store.insertMessage(later)
    store.insertMessage({ ...block, text: "Here are the files: a, b" })
    expect(preview()?.text).toBe("Done.")
  })

  test("a notice Rudder wrote itself (Cancelled.) never becomes the preview", () => {
    const store = new Store(":memory:")
    const session = store.createSession()
    store.insertMessage(message(session.id, { role: "user", text: "run ls" }))
    store.insertMessage(message(session.id, { text: "Cancelled.", payload: NOTICE_PAYLOAD }))
    expect(sessionPublic(store.getSession(session.id)!).preview).toMatchObject({ role: "user", text: "run ls" })
    store.rewindSession(session.id, 2)
    expect(sessionPublic(store.getSession(session.id)!).preview).toMatchObject({ role: "user", text: "run ls" })
  })

  test("rewind and clear recompute the preview, fork copies it", async () => {
    const store = new Store(":memory:")
    const session = store.createSession()
    store.insertMessage(message(session.id, { role: "user", text: "first" }))
    store.insertMessage(message(session.id, { text: "reply one" }))
    store.insertMessage(message(session.id, { kind: "tool", text: "Bash: ls" }))
    store.insertMessage(message(session.id, { role: "user", text: "second" }))
    const fork = (await store.forkSession(session.id))!
    expect(sessionPublic(fork).preview?.text).toBe("second")

    store.rewindSession(session.id, 3)
    expect(sessionPublic(store.getSession(session.id)!).preview).toMatchObject({ role: "assistant", text: "reply one" })
    store.clearMessages(session.id)
    expect(sessionPublic(store.getSession(session.id)!).preview).toBeNull()
  })

  test("a database from before the preview columns is backfilled once on open", () => {
    const dir = mkdtempSync(join(tmpdir(), "rudder-preview-"))
    try {
      const path = join(dir, "rudder.db")
      const old = new Store(path)
      const session = old.createSession()
      old.insertMessage(message(session.id, { role: "user", text: "# hello" }))
      old.insertMessage(message(session.id, { kind: "tool", text: "Bash: ls" }))
      dropTriggers(old.db)
      for (const column of ["preview_role", "preview_text", "preview_at", "preview_seq"]) {
        old.db.exec(`ALTER TABLE sessions DROP COLUMN ${column}`)
      }
      old.db.close()
      const reopened = new Store(path)
      expect(sessionPublic(reopened.getSession(session.id)!).preview).toMatchObject({ role: "user", text: "hello" })
      reopened.db.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("session.list reads previews from the session rows, not the messages", async () => {
    const store = new Store(":memory:")
    for (let i = 0; i < 3; i++) {
      const session = store.createSession()
      store.insertMessage(message(session.id, { text: `reply ${i}` }))
    }
    const service = new SessionService(store, createFakeAdapter(), () => {})
    const seen: string[] = []
    const original = store.db.query.bind(store.db)
    ;(store.db as { query: typeof store.db.query }).query = ((sql: string) => {
      seen.push(sql)
      return original(sql)
    }) as typeof store.db.query
    const listed = await service.invoke("session.list", {}, "l")
    const sessions = (listed.result as { sessions: Array<{ preview: { text: string } | null }> }).sessions
    expect(sessions.map((session) => session.preview?.text).sort()).toEqual(["reply 0", "reply 1", "reply 2"])
    expect(seen.some((sql) => /FROM messages/i.test(sql))).toBe(false)
  })
})

describe("send records", () => {
  const identity = (clientMessageId: string) => ({
    sessionId: "s", deviceId: "d", clientMessageId, requestHash: "h",
  })

  test("a start reads only queued records, through the partial index, and drops settled ones past 30 days", () => {
    const dir = mkdtempSync(join(tmpdir(), "rudder-sends-"))
    const path = join(dir, "rudder.db")
    try {
      const store = new Store(path)
      store.putSend(identity("a"), { ok: true, queued: { id: "q1", sessionId: "s", text: "wait", attachmentIds: [] } })
      store.putSend(identity("b"), { ok: true, message: { id: "m" } })
      store.putSend(identity("c"), { ok: true, queued: { id: "q2", sessionId: "s", text: "then sent", attachmentIds: [] } })
      store.putSend(identity("c"), { ok: true, message: { id: "m2" } })
      store.putSend(identity("old-queued"), { ok: true, queued: { id: "q3", sessionId: "s", text: "old", attachmentIds: [] } })
      expect(store.listQueuedSends().map((row) => row.client_message_id)).toEqual(["a", "old-queued"])

      const db = new Database(path)
      const plan = db.query("EXPLAIN QUERY PLAN SELECT * FROM message_sends WHERE queued = 1 ORDER BY rowid").all() as Array<{ detail: string }>
      expect(plan.map((row) => row.detail).join(" ")).toContain("message_sends_queued")
      const old = Date.now() - 31 * 86_400_000
      db.query("UPDATE message_sends SET updated_at = ? WHERE client_message_id IN ('b', 'old-queued')").run(old)
      db.close()

      const reopened = new Store(path)
      expect(reopened.getSend(identity("b"))).toBeNull()
      expect(reopened.getSend(identity("c"))).not.toBeNull()
      // A queued record is kept whatever its age: the queue still holds it.
      expect(reopened.listQueuedSends().map((row) => row.client_message_id)).toEqual(["a", "old-queued"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("an older database gets the columns filled from its results", () => {
    const dir = mkdtempSync(join(tmpdir(), "rudder-sends-"))
    const path = join(dir, "rudder.db")
    try {
      const db = new Database(path)
      db.exec(`CREATE TABLE message_sends (
        session_id TEXT NOT NULL, device_id TEXT NOT NULL, client_message_id TEXT NOT NULL,
        request_hash TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY (session_id, device_id, client_message_id))`)
      const insert = db.query("INSERT INTO message_sends VALUES ('s', 'd', ?, 'h', ?)")
      insert.run("queued", JSON.stringify({ ok: true, queued: { id: "q" } }))
      insert.run("done", JSON.stringify({ ok: true }))
      db.close()
      const store = new Store(path)
      expect(store.listQueuedSends().map((row) => row.client_message_id)).toEqual(["queued"])
      expect(store.getSend(identity("done"))).not.toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("messagePublic", () => {
  const row = (kind: string, role: string, payload: string | null): MessageRow => ({
    id: "m1",
    session_id: "s1",
    seq: 1,
    kind,
    role,
    text: "hi",
    payload,
    created_at: 1,
  })

  test("parses a payload once and reads every field from it", () => {
    const parse = spyOn(JSON, "parse")
    try {
      const steered = messagePublic(
        row("text", "user", JSON.stringify({ clientMessageId: "c1", turnId: "t1", origin: "relay", steer: "read", readAt: 5, attachments: [{ id: "a", name: "x.png", bytes: 3 }] })),
      )
      expect(parse).toHaveBeenCalledTimes(1)
      expect(steered.clientMessageId).toBe("c1")
      expect(steered.turnId).toBe("t1")
      expect(steered.origin).toBe("relay")
      expect(steered.steer).toEqual({ state: "read", readAt: 5 })
      expect(steered.attachments).toEqual([{ id: "a", name: "x.png", bytes: 3 }])
      parse.mockClear()
      const tool = messagePublic(row("tool", "agent", JSON.stringify({ id: "t", tool: "Bash", status: "running", clientMessageId: "c2" })))
      expect(parse).toHaveBeenCalledTimes(1)
      expect(tool.tool?.tool).toBe("Bash")
      expect(tool.clientMessageId).toBe("c2")
      expect(tool.steer).toBeUndefined()
    } finally {
      parse.mockRestore()
    }
  })

  test("a broken payload reads as absent, except on rows rudderd writes itself", () => {
    const tool = messagePublic(row("tool", "agent", "{nope"))
    expect(tool.tool).toBeUndefined()
    expect(tool.clientMessageId).toBeUndefined()
    expect(messagePublic(row("text", "user", "null")).steer).toBeUndefined()
    expect(messagePublic(row("permission", "agent", null)).permission).toBeUndefined()
    expect(() => messagePublic(row("compaction", "system", "{nope"))).toThrow("invalid compaction message payload")
    expect(() => messagePublic(row("error", "agent", "{nope"))).toThrow("invalid error message payload")
    expect(messagePublic(row("error", "agent", JSON.stringify({ error: { code: "usage_limit" } }))).error).toEqual({ code: "usage_limit" })
  })
})


test("late inbox migrates task indexes and projection checkpoints idempotently", () => {
  const root = mkdtempSync(join(tmpdir(), "rudder-late-migration-"))
  const path = join(root, "store.sqlite")
  let store = new Store(path)
  try {
    // Build a pre-projection schema even when the test starts on the new implementation.
    for (const row of store.db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'late_agent_events'").all() as Array<{ name: string }>) {
      if (!row.name.startsWith("sqlite_autoindex")) store.db.exec(`DROP INDEX ${row.name}`)
    }
    for (const [table, names] of [["late_agent_events", ["task_id"]],
      ["turn_background_links", ["projected_count", "sequence_ordered", "last_sequence", "last_rowid"]]] as const) {
      const columns = store.db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
      for (const name of names) if (columns.some(column => column.name === name)) store.db.exec(`ALTER TABLE ${table} DROP COLUMN ${name}`)
    }
    const body = JSON.stringify({ nativeTaskId: "old-task", text: "evidence" })
    store.db.query("INSERT INTO late_agent_events(agent_id,native_session_id,event_id,body,status) VALUES (?,?,?,?,?)")
      .run("grok", "native", "old-event", body, "patched")
    store.db.query("INSERT INTO turn_background_links(agent_id,native_session_id,task_id,identity,anchor_id) VALUES (?,?,?,?,?)")
      .run("grok", "native", "old-task", "{}", "anchor")
    store.db.close()
    store = new Store(path)
    expect(store.db.query("SELECT body, task_id, status FROM late_agent_events").get()).toEqual({ body, task_id: "old-task", status: "patched" })
    expect(store.db.query("SELECT projected_count, sequence_ordered, last_sequence, last_rowid FROM turn_background_links").get())
      .toEqual({ projected_count: 0, sequence_ordered: 1, last_sequence: null, last_rowid: 0 })
    store.db.exec("UPDATE turn_background_links SET projected_count = 7, last_rowid = 9")
    store.db.close()
    store = new Store(path)
    expect(store.db.query("SELECT projected_count, last_rowid FROM turn_background_links").get()).toEqual({ projected_count: 7, last_rowid: 9 })
    expect(store.db.query("SELECT body FROM late_agent_events").get()).toEqual({ body })
  } finally { store.db.close(); rmSync(root, { recursive: true, force: true }) }
})

// review2-1117: the open-time expiry of pending permissions and questions scanned the whole messages table, and
// deleting a session's turn changes scanned turn_changes.
describe("indexes for the startup expiry and turn-change cleanup (review2-1117)", () => {
  const db = (store: Store) => (store as unknown as { db: Database }).db
  const plan = (store: Store, sql: string, ...args: string[]) =>
    (db(store).query(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[]).map((row) => row.detail).join("; ")

  test("the pending expiry reads only permission and question rows through an index", () => {
    const store = new Store(":memory:")
    expect(plan(store, "SELECT * FROM messages WHERE kind IN ('permission', 'question')")).toContain("messages_pending_kind")
  })

  test("a session's turn changes are found through an index", () => {
    const store = new Store(":memory:")
    expect(plan(store, "DELETE FROM turn_changes WHERE session_id = ?", "s")).toContain("turn_changes_session")
  })

  test("reopening a database that already has the indexes is fine", () => {
    const dir = mkdtempSync(join(tmpdir(), "rudder-index-"))
    try {
      const path = join(dir, "r.sqlite")
      db(new Store(path)).close()
      const again = new Store(path)
      expect(plan(again, "DELETE FROM turn_changes WHERE session_id = ?", "s")).toContain("turn_changes_session")
      db(again).close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// 11-19: titles named before then kept a raw slash command (「/superpowers:requesting-code-review」).
test("opening the db names a slash-command title after its first ordinary message, else reads the command", () => {
  const dir = mkdtempSync(join(tmpdir(), "rudder-command-title-"))
  try {
    const path = join(dir, "rudder.db")
    const first = new Store(path)
    const later = first.createSession({ title: "/superpowers:requesting-code-review", agent: "claude" })
    const only = first.createSession({ title: "/compact", agent: "claude" })
    const typed = first.createSession({ title: "修复登录", agent: "claude" })
    const message = (session_id: string, id: string, text: string, role = "user") =>
      first.insertMessage({ id, session_id, kind: "text", role, text, payload: null, created_at: 1 })
    message(later.id, "m1", "/superpowers:requesting-code-review")
    message(later.id, "m2", "on it", "assistant")
    message(later.id, "m3", "review   the D10\nranking change please, it is long enough to clip")
    message(only.id, "m4", "/compact")
    const stamps = [later, only, typed].map((row) => first.getSession(row.id)!.updated_at)
    first.db.close()

    const reopened = new Store(path)
    expect(reopened.getSession(later.id)?.title).toBe("Review the D10")
    expect(reopened.getSession(later.id)?.auto_title).toBe(3)
    expect(reopened.getSession(only.id)?.title).toBe("压缩上下文")
    expect(reopened.getSession(only.id)?.auto_title).toBe(2)
    expect(reopened.getSession(only.id)?.title_command).toBe("compact")
    expect(reopened.getSession(typed.id)?.title).toBe("修复登录")
    // A rename, not new content: the list does not reorder.
    expect([later, only, typed].map((row) => reopened.getSession(row.id)!.updated_at)).toEqual(stamps)
    reopened.db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
