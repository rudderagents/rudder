import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, spyOn, test } from "bun:test"
import { FAKE_SPEC } from "./adapter/fake"
import type { AgentAdapter } from "./adapter/types"
import { RESUME_PROMPT, SessionService } from "./session-service"
import { Store } from "./store"
import { restartCandidate, restartMessageId } from "./turn-termination"

const candidate = { id: "t", phase: "interrupted", updatedAt: 10, outcome: { phase: "interrupted" as const, endedAt: 10,
  termination: { cause: "daemon_shutdown" as const, requestedAt: 10 } } }

test("only recent shutdown evidence can resume", () => {
  expect(restartCandidate(candidate, 20, true)).toBe(true)
  expect(restartCandidate(candidate, 20, false)).toBe(false)
  expect(restartCandidate(candidate, 1_800_011, true)).toBe(false)
  for (const cause of ["user_stop", "unknown", "watchdog"] as const) {
    expect(restartCandidate({ ...candidate, outcome: { ...candidate.outcome, termination: { cause, requestedAt: 10 } } }, 20, true)).toBe(false)
  }
  expect(restartMessageId("t", 1)).toBe(restartMessageId("t", 1))
  expect(restartMessageId("t", 1)).not.toBe(restartMessageId("t", 2))
})

test("pending and acknowledged resume claims are durable states", () => {
  const store = new Store(":memory:")
  const session = store.createSession({ agent: "fake" })
  const turn = store.createTurn(session.id, "prompt")
  store.advanceTurn(turn.id, "interrupted")
  expect(store.claimRestartResume(turn.id, session.generation ?? 0)).toBe("new")
  expect(store.claimRestartResume(turn.id, session.generation ?? 0)).toBe("pending")
  store.completeRestartResume(turn.id, session.generation ?? 0)
  expect(store.claimRestartResume(turn.id, session.generation ?? 0)).toBe("accepted")
  expect(store.claimRestartResume(turn.id, 999)).toBe("obsolete")
  store.db.close()
})

test("orderly shutdown is resumed once without replaying the original action", async () => {
  const store = new Store(":memory:")
  let entered = false
  const first: AgentAdapter = { spec: FAKE_SPEC, reply: async (_text, ctx) => {
    ctx.emit({ type: "native", nativeId: "kept-native" })
    entered = true
    await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true }))
  } }
  const service = new SessionService(store, first, () => {})
  const session = store.createSession({ agent: FAKE_SPEC.id })
  await service.invoke("message.send", { sessionId: session.id, text: "original action" }, "send")
  for (let i = 0; !entered && i < 200; i++) await Bun.sleep(5)
  expect(entered).toBe(true)
  await service.shutdown()
  const seen: string[] = []
  const second: AgentAdapter = { spec: FAKE_SPEC, reply: async (text) => { seen.push(text) } }
  const restarted = new SessionService(store, second, () => {}, { autoResume: { restartDelayMs: 5 } })
  for (let i = 0; seen.length === 0 && i < 100; i++) await Bun.sleep(5)
  expect(seen).toEqual([RESUME_PROMPT])
  await restarted.shutdown()
  const again = new SessionService(store, second, () => {}, { autoResume: { restartDelayMs: 5 } })
  await Bun.sleep(20)
  expect(seen).toHaveLength(1)
  await again.shutdown()
  store.db.close()
})

test("restart claims survive a database reopen", () => {
  const directory = mkdtempSync(join(tmpdir(), "rudder-restart-"))
  try {
    const path = join(directory, "store.sqlite")
    const first = new Store(path)
    const session = first.createSession({ agent: "fake" })
    const turn = first.createTurn(session.id, "prompt")
    first.advanceTurn(turn.id, "interrupted")
    const generation = session.generation ?? 0
    expect(first.claimRestartResume(turn.id, generation)).toBe("new")
    first.db.close()
    const second = new Store(path)
    expect(second.claimRestartResume(turn.id, generation)).toBe("pending")
    second.completeRestartResume(turn.id, generation)
    second.db.close()
    const third = new Store(path)
    expect(third.claimRestartResume(turn.id, generation)).toBe("accepted")
    third.db.close()
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test.each(["before_accept", "after_accept"] as const)("restart recovery is idempotent at %s", async (point) => {
  const store = new Store(":memory:")
  const session = store.createSession({ agent: FAKE_SPEC.id })
  store.patchSession(session.id, { nativeId: "kept-native" })
  const user = store.insertMessage({ id: "prompt", session_id: session.id, kind: "text", role: "user", text: "original", created_at: Date.now() })
  const turn = store.createTurn(session.id, user.id)
  store.advanceTurn(turn.id, "interrupted")
  store.setTurnOutcome(turn.id, { phase: "interrupted", endedAt: Date.now(), termination: { cause: "daemon_shutdown", requestedAt: Date.now() } })
  const seen: string[] = []
  const adapter: AgentAdapter = { spec: FAKE_SPEC, reply: async (text) => { seen.push(text) } }
  const injected = point === "before_accept"
    ? spyOn(store, "putSend").mockImplementationOnce(() => { throw new Error("injected before acceptance") })
    : spyOn(store, "completeRestartResume").mockImplementationOnce(() => { throw new Error("injected after acceptance") })
  const first = new SessionService(store, adapter, () => {}, { autoResume: { restartDelayMs: 5 } })
  await Bun.sleep(30)
  await first.shutdown()
  injected.mockRestore()
  const second = new SessionService(store, adapter, () => {}, { autoResume: { restartDelayMs: 5 } })
  for (let i = 0; seen.length === 0 && i < 100; i++) await Bun.sleep(5)
  await Bun.sleep(20)
  expect(seen).toEqual([RESUME_PROMPT])
  expect(store.claimRestartResume(turn.id, session.generation ?? 0)).toBe("accepted")
  await second.shutdown()
  store.db.close()
})

test.each(["agent", "native", "generation"] as const)("restart continuation rejects changed %s binding", async field => {
  const store = new Store(":memory:")
  const session = store.createSession({ agent: FAKE_SPEC.id })
  store.patchSession(session.id, { nativeId: "original-native" })
  store.insertMessage({ id: "p", session_id: session.id, role: "user", kind: "text", text: "original", created_at: Date.now() })
  const turn = store.createTurn(session.id, "p")
  store.setTurnExecution(turn.id, { sessionId: session.id, turnId: turn.id, generation: session.generation ?? 0,
    agentId: FAKE_SPEC.id, nativeSessionId: "original-native" })
  store.advanceTurn(turn.id, "interrupted")
  store.setTurnOutcome(turn.id, { phase: "interrupted", endedAt: Date.now(), termination: { cause: "daemon_shutdown", requestedAt: Date.now() } })
  const adapter: AgentAdapter = { spec: FAKE_SPEC, reply: async () => {} }
  const service = new SessionService(store, adapter, () => {}, { autoResume: { restartDelayMs: 15 } })
  if (field === "agent") store.patchSession(session.id, { agent: "other" })
  if (field === "native") store.patchSession(session.id, { nativeId: "replacement-native" })
  if (field === "generation") store.db.query("UPDATE sessions SET generation = generation + 1 WHERE id = ?").run(session.id)
  await Bun.sleep(50)
  expect(store.listLatestTurns().find(row => row.session_id === session.id)?.id).toBe(turn.id)
  await service.shutdown()
  store.db.close()
})
