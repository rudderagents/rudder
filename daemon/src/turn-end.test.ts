import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "bun:test"
import { Store, messagePublic } from "./store"

test("each original prompt owns its durable outcome and revision", () => {
  const store = new Store(":memory:")
  const session = store.createSession({ agent: "fake" })
  const prompt = store.insertMessage({ id: "p", session_id: session.id, kind: "text", role: "user", text: "merge", created_at: 1 })
  const turn = store.createTurn(session.id, prompt.id)
  const outcome = { phase: "interrupted" as const, endedAt: 2, termination: { cause: "daemon_shutdown" as const, requestedAt: 2 } }
  store.setTurnOutcome(turn.id, outcome)
  const patched = store.getMessage(prompt.id)!
  expect(messagePublic(patched)).toMatchObject({ turnEnd: { id: turn.id, revision: 1, outcome } })
  expect(patched.rev).toBeGreaterThan(prompt.rev ?? 0)
  store.setTurnOutcome(turn.id, outcome)
  expect(store.getMessage(prompt.id)!.rev).toBe(patched.rev)
  store.db.close()
})

test("prompt patch and outcome roll back together", () => {
  const store = new Store(":memory:")
  const session = store.createSession({ agent: "fake" })
  store.insertMessage({ id: "p", session_id: session.id, kind: "text", role: "user", text: "merge", created_at: 1 })
  const turn = store.createTurn(session.id, "p")
  store.db.exec("CREATE TRIGGER reject_prompt BEFORE UPDATE OF payload ON messages BEGIN SELECT RAISE(ABORT, 'injected'); END")
  expect(() => store.setTurnOutcome(turn.id, { phase: "done", endedAt: 2 })).toThrow("injected")
  expect(store.getTurn(turn.id)!.outcome).toBeNull()
  store.db.close()
})

test("historical and newer outcomes remain separate across a reopen", () => {
  const directory = mkdtempSync(join(tmpdir(), "rudder-outcome-"))
  try {
    const path = join(directory, "store.sqlite")
    const first = new Store(path)
    const session = first.createSession({ agent: "fake" })
    first.insertMessage({ id: "old", session_id: session.id, role: "user", kind: "text", text: "old", created_at: 1 })
    const old = first.createTurn(session.id, "old")
    first.advanceTurn(old.id, "done")
    first.db.query("UPDATE session_turns SET outcome = ? WHERE id = ?").run(JSON.stringify({ phase: "interrupted", endedAt: 2 }), old.id)
    first.insertMessage({ id: "new", session_id: session.id, role: "user", kind: "text", text: "new", created_at: 2 })
    const next = first.createTurn(session.id, "new")
    first.advanceTurn(next.id, "done")
    first.setTurnOutcome(next.id, { phase: "done", endedAt: 3 })
    first.db.close()
    const second = new Store(path)
    expect(messagePublic(second.getMessage("old")!)).toMatchObject({ turnEnd: { id: old.id, outcome: { phase: "interrupted", termination: { cause: "unknown" } } } })
    expect(messagePublic(second.getMessage("new")!)).toMatchObject({ turnEnd: { id: next.id, revision: 1, outcome: { phase: "done" } } })
    second.db.close()
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
