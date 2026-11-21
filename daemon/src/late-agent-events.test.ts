import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LateAgentEvents } from "./late-agent-events"
import { Store } from "./store"

function fixture(path = ":memory:") {
  const store = new Store(path)
  const session = store.createSession({ agent: "grok" })
  const turn = store.createTurn(session.id, "prompt")
  const identity = { sessionId: session.id, turnId: turn.id, generation: session.generation ?? 0, agentId: "grok", nativeSessionId: "native" }
  store.setTurnExecution(turn.id, identity)
  const published: string[] = []
  const inbox = new LateAgentEvents(store, row => { published.push(row.id) })
  const anchor = inbox.register(identity, "task")!
  const event = { identity, eventId: "e1", nativeTaskId: "task", text: "done", complete: true }
  return { store, session, turn, identity, published, inbox, anchor, event }
}

test("late reply patches its original anchor after a newer turn starts, once", async () => {
  const f = fixture()
  f.store.createTurn(f.session.id, "new-prompt")
  expect(await f.inbox.accept(f.event)).toBe("patched")
  const row = f.store.getMessage(f.anchor.id)!
  expect(row.text).toBe("done")
  expect(JSON.parse(row.payload!).turnId).toBe(f.turn.id)
  expect(await f.inbox.accept(f.event)).toBe("duplicate")
  expect(f.store.getMessage(f.anchor.id)!.rev).toBe(row.rev)
  expect(f.published).toEqual([row.id])
  f.store.db.close()
})

test("unproven task, stale generation, and removed anchor stay quarantined", async () => {
  const f = fixture()
  expect(await f.inbox.accept({ ...f.event, eventId: "unknown", nativeTaskId: "other" })).toBe("quarantined")
  f.store.db.query("DELETE FROM messages WHERE id = ?").run(f.anchor.id)
  expect(await f.inbox.accept(f.event)).toBe("quarantined")
  expect(f.store.getMessage(f.anchor.id)).toBeNull()
  f.store.db.close()
  const g = fixture()
  g.store.db.query("UPDATE sessions SET generation = generation + 1 WHERE id = ?").run(g.session.id)
  expect(await g.inbox.accept(g.event)).toBe("quarantined")
  g.store.db.close()
})

test("durable inbox recovers before patch and broadcast failure never reapplies text", async () => {
  const f = fixture()
  f.inbox.stage(f.event)
  const recovered = new LateAgentEvents(f.store, () => { throw new Error("offline") })
  await expect(recovered.recover()).rejects.toThrow("offline")
  expect(f.store.getMessage(f.anchor.id)!.text).toBe("done")
  const rev = f.store.getMessage(f.anchor.id)!.rev
  expect(await f.inbox.accept(f.event)).toBe("duplicate")
  expect(f.store.getMessage(f.anchor.id)!.rev).toBe(rev)
  f.store.db.close()
})

test("native chunk order wins over delayed arrival order", async () => {
  const f = fixture()
  await f.inbox.accept({ ...f.event, eventId: "second", text: "B", mode: "delta", sequence: 2 })
  await f.inbox.accept({ ...f.event, eventId: "first", text: "A", mode: "delta", sequence: 1 })
  expect(f.store.getMessage(f.anchor.id)!.text).toBe("AB")
  f.store.db.close()
})

test("unidentified notifications retain separate quarantine evidence", async () => {
  const f = fixture()
  expect(await f.inbox.accept({ ...f.event, eventId: "", text: "first" })).toBe("quarantined")
  expect(await f.inbox.accept({ ...f.event, eventId: "", text: "second" })).toBe("quarantined")
  expect(f.store.db.query("SELECT body FROM late_agent_events WHERE status = 'quarantined'").all()).toHaveLength(2)
  f.store.db.close()
})

function watchHistoryQueries(store: Store) {
  const seen: string[] = []
  const query = store.db.query.bind(store.db)
  store.db.query = ((sql: string) => { seen.push(sql); return query(sql) }) as typeof store.db.query
  return seen
}

test("otherTasksDoNotEnterProjectionQuery", async () => {
  const f = fixture()
  try {
    f.store.transaction(() => {
      for (let index = 0; index < 20000; index += 1) {
        f.inbox.stage({ ...f.event, eventId: `other-${index}`, nativeTaskId: "other", text: "unrelated" })
      }
      f.store.db.exec("UPDATE late_agent_events SET status = 'patched'")
    })
    const seen = watchHistoryQueries(f.store)
    expect(await f.inbox.accept({ ...f.event, eventId: "a", text: "A", mode: "delta", sequence: 1 })).toBe("patched")
    const history = seen.filter(sql => /SELECT body(?:, rowid)? FROM late_agent_events/i.test(sql))
    expect(history.length).toBeLessThanOrEqual(1)
    expect(history.every(sql => /task_id/i.test(sql))).toBe(true)
    expect(f.store.getMessage(f.anchor.id)!.text).toBe("A")
    const plan = f.store.db.query(`EXPLAIN QUERY PLAN SELECT body FROM late_agent_events
      WHERE agent_id = ? AND native_session_id = ? AND task_id IS ? AND status = 'patched'`).all("grok", "native", "task")
    expect(JSON.stringify(plan)).toContain("task_id=?")
  } finally { f.store.db.close() }
})

test("monotonicLateChunksDoNotReadHistory", async () => {
  const f = fixture()
  try {
    await f.inbox.accept({ ...f.event, eventId: "a", text: "A", mode: "delta", sequence: 1 })
    const seen = watchHistoryQueries(f.store)
    await f.inbox.accept({ ...f.event, eventId: "b", text: "B", mode: "delta", sequence: 2 })
    expect(f.store.getMessage(f.anchor.id)!.text).toBe("AB")
    expect(seen.filter(sql => /SELECT body(?:, rowid)? FROM late_agent_events/i.test(sql))).toHaveLength(0)
  } finally { f.store.db.close() }
})

test("unorderedAndSnapshotModesSurviveReopen", async () => {
  const root = mkdtempSync(join(tmpdir(), "rudder-late-projection-"))
  const path = join(root, "store.sqlite")
  const f = fixture(path)
  try {
    await f.inbox.accept({ ...f.event, eventId: "b", text: "B", mode: "delta", sequence: 2 })
    await f.inbox.accept({ ...f.event, eventId: "a", text: "A", mode: "delta", sequence: 1 })
    expect(f.store.getMessage(f.anchor.id)!.text).toBe("AB")
    await f.inbox.accept({ ...f.event, eventId: "snap", text: "X", mode: "snapshot" })
    await f.inbox.accept({ ...f.event, eventId: "y", text: "Y", mode: "delta" })
    expect(f.store.getMessage(f.anchor.id)!.text).toBe("XY")
    f.store.db.close()
    const reopened = new Store(path)
    try {
      const inbox = new LateAgentEvents(reopened, () => {})
      await inbox.recover()
      expect(reopened.getMessage(f.anchor.id)!.text).toBe("XY")
      const seen = watchHistoryQueries(reopened)
      await inbox.accept({ ...f.event, eventId: "z", text: "Z", mode: "delta", sequence: 1 })
      expect(reopened.getMessage(f.anchor.id)!.text).toBe("XYZ")
      expect(seen.filter(sql => /SELECT body(?:, rowid)? FROM late_agent_events/i.test(sql))).toHaveLength(0)
    } finally { reopened.db.close() }
  } finally { f.store.db.close(); rmSync(root, { recursive: true, force: true }) }
})

test("sequenceModeSwitchRebuildsInArrivalOrder", async () => {
  const f = fixture()
  try {
    await f.inbox.accept({ ...f.event, eventId: "b", text: "B", mode: "delta", sequence: 2 })
    await f.inbox.accept({ ...f.event, eventId: "a", text: "A", mode: "delta", sequence: 1 })
    await f.inbox.accept({ ...f.event, eventId: "c", text: "C", mode: "delta" })
    expect(f.store.getMessage(f.anchor.id)!.text).toBe("BAC")
  } finally { f.store.db.close() }
})

test("stagedEqualSequenceAndArrivalOrderRemainStable", async () => {
  for (const sequence of [undefined, 7]) {
    const f = fixture()
    try {
      const a = { ...f.event, eventId: "a", text: "A", mode: "delta" as const, sequence }
      f.inbox.stage(a)
      await f.inbox.accept({ ...a, eventId: "b", text: "B" })
      await f.inbox.accept(a)
      expect(f.store.getMessage(f.anchor.id)!.text).toBe("AB")
      await f.inbox.accept({ ...a, text: "replacement" })
      expect(f.store.getMessage(f.anchor.id)!.text).toBe("AB")
    } finally { f.store.db.close() }
  }
})

test("projectionCheckpointFailureRollsBackAnchorAndReceipt", async () => {
  const f = fixture()
  try {
    const before = f.store.getMessage(f.anchor.id)!
    f.store.db.exec(`CREATE TRIGGER refuse_projection BEFORE UPDATE ON turn_background_links
      BEGIN SELECT RAISE(ABORT, 'checkpoint-write'); END`)
    await expect(f.inbox.accept(f.event)).rejects.toThrow("checkpoint-write")
    expect(f.store.getMessage(f.anchor.id)).toEqual(before)
    expect(f.store.db.query("SELECT status FROM late_agent_events WHERE event_id = 'e1'").get()).toEqual({ status: "pending" })
    f.store.db.exec("DROP TRIGGER refuse_projection")
    await f.inbox.recover()
    expect(f.store.getMessage(f.anchor.id)!.text).toBe("done")
    expect(f.published).toEqual([f.anchor.id])
  } finally { f.store.db.close() }
})
