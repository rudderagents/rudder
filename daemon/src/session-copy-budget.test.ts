import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type MessageRow, Store } from "./store"

type CopyOptions = { signal?: AbortSignal; yieldControl?: () => Promise<void> }
const copy = (store: Store, id: string, options: CopyOptions = {}) =>
  store.forkSession(id, "Copy", options)

function seed(store: Store, count: number) {
  const source = store.createSession({ title: "Source", nativeId: "native-source", cwd: "/tmp/project", model: "model", effort: "high" })
  store.transaction(() => {
    for (let i = 0; i < count; i++) store.insertMessage({
      id: `source-${i}`, session_id: source.id, seq: i + 1, kind: "text", role: i % 2 ? "assistant" : "user",
      text: `Message ${i} 汉字`, payload: JSON.stringify({ value: i }), created_at: i,
    })
  })
  return source
}

function stripNewIdentity({ id: _id, session_id: _session, rev: _rev, ...message }: MessageRow) { return message }

// 50,000 rows take about 6 s on hosted CI runners; the test is about yielding, not speed.
test("longCopyYieldsBeforePublishing", async () => {
  const store = new Store(":memory:")
  try {
    const source = seed(store, 50_000)
    let yielded = 0
    const result = await copy(store, source.id, { yieldControl: async () => {
      yielded++
      expect(store.listSessions().map((row) => row.id)).toEqual([source.id])
      const delta = store.sessionChanges(0)
      expect(delta.reset).toBe(false)
      if (!delta.reset) expect(delta.sessions.map((row) => row.id)).toEqual([source.id])
    } })
    expect(yielded).toBeGreaterThan(0)
    expect(result?.last_seq).toBe(50_000)
    expect(store.listSessions()).toHaveLength(2)
  } finally { store.db.close() }
}, 30_000)

test("copyPreservesSourceMessageAndForkSemantics", async () => {
  const store = new Store(":memory:")
  try {
    const source = seed(store, 450)
    const result = (await copy(store, source.id))!
    expect(result).toMatchObject({ native_id: null, fork_native: "native-source", carry_seq: 450, cwd: "/tmp/project", model: "model", effort: "high" })
    const before = store.listMessages(source.id)
    const after = store.listMessages(result.id)
    expect(after.map(stripNewIdentity)).toEqual(before.map(stripNewIdentity))
    expect(new Set(after.map((row) => row.id)).size).toBe(450)
    expect(after.some((row) => row.id.startsWith("source-"))).toBe(false)
    expect(after.map((row) => row.rev)).toEqual(Array.from({ length: 450 }, (_, i) => i + 1))
    expect(result.preview_text).toBe(store.getSession(source.id)!.preview_text)
  } finally { store.db.close() }
})

test("the default copy scheduler lets an event-loop timer run before completion", async () => {
  const store = new Store(":memory:")
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const source = seed(store, 450)
    let worked = false
    timer = setTimeout(() => { worked = true }, 0)
    await copy(store, source.id)
    expect(worked).toBe(true)
  } finally {
    clearTimeout(timer)
    store.db.close()
  }
})

test("failedCopyIsNeverVisible", async () => {
  const store = new Store(":memory:")
  try {
    const source = seed(store, 450)
    await expect(copy(store, source.id, { yieldControl: async () => { throw new Error("copy interrupted") } })).rejects.toThrow("copy interrupted")
    expect(store.listSessions().map((row) => row.id)).toEqual([source.id])
    expect(store.db.query("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 450 })
    expect(store.db.query("SELECT COUNT(*) AS n FROM session_copy_jobs").get()).toEqual({ n: 0 })
  } finally { store.db.close() }
})

test("sourceMutationCancelsCopy", async () => {
  for (const mutation of ["append", "clear", "delete"] as const) {
    const store = new Store(":memory:")
    try {
      const source = seed(store, 450)
      await expect(copy(store, source.id, { yieldControl: async () => {
        if (mutation === "append") store.insertMessage({ id: "changed", session_id: source.id, kind: "text", role: "user", text: "new", created_at: 999 })
        else if (mutation === "clear") store.clearMessages(source.id)
        else store.deleteSession(source.id)
      } })).rejects.toMatchObject({ code: "source_changed" })
      expect(store.listSessions().every((row) => row.id === source.id)).toBe(true)
      expect(store.db.query("SELECT COUNT(*) AS n FROM session_copy_jobs").get()).toEqual({ n: 0 })
    } finally { store.db.close() }
  }
})

test("copyDoesNotBlockAnUnrelatedSessionWrite", async () => {
  const store = new Store(":memory:")
  try {
    const source = seed(store, 450)
    const other = store.createSession()
    let worked = false
    await copy(store, source.id, { yieldControl: async () => {
      worked = true
      store.insertMessage({ id: "other-message", session_id: other.id, kind: "text", role: "user", text: "still responsive", created_at: 1 })
      const job = store.db.query("SELECT destination_id FROM session_copy_jobs").get() as { destination_id: string }
      expect(store.getSession(job.destination_id)).toBeNull()
      expect(store.usage()).toMatchObject({ sessions: 2, messages: 451 })
    } })
    expect(worked).toBe(true)
    expect(store.listMessages(other.id)[0]?.text).toBe("still responsive")
  } finally { store.db.close() }
})

test("abortingACopyRemovesItsStagingRows", async () => {
  const store = new Store(":memory:")
  try {
    const source = seed(store, 450)
    const controller = new AbortController()
    await expect(copy(store, source.id, { signal: controller.signal, yieldControl: async () => controller.abort() })).rejects.toThrow()
    expect(store.listSessions()).toHaveLength(1)
    expect(store.db.query("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 450 })
  } finally { store.db.close() }
})

test("startupRemovesAnInterruptedCopy", () => {
  const root = mkdtempSync(join(tmpdir(), "rudder-copy-recovery-"))
  const path = join(root, "store.sqlite")
  let store = new Store(path)
  try {
    const source = seed(store, 2)
    const pending = store.createSession({ title: "Unfinished" })
    store.insertMessage({ id: "partial", session_id: pending.id, kind: "text", role: "user", text: "partial", created_at: 1 })
    store.db.exec("CREATE TABLE IF NOT EXISTS session_copy_jobs(destination_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, source_generation INTEGER NOT NULL, source_rev INTEGER NOT NULL, source_last_seq INTEGER NOT NULL)")
    store.db.query("INSERT INTO session_copy_jobs VALUES (?, ?, 1, 2, 2)").run(pending.id, source.id)
    store.db.close()
    store = new Store(path)
    store.recoverIncompleteCopies()
    expect(store.getSession(pending.id)).toBeNull()
    expect(store.listMessages(pending.id)).toHaveLength(0)
    expect(store.getSession(source.id)).not.toBeNull()
  } finally {
    store.db.close()
    rmSync(root, { recursive: true, force: true })
  }
})
