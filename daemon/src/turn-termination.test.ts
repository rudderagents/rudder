import { describe, expect, test } from "bun:test"
import { FAKE_SPEC } from "./adapter/fake"
import type { AgentAdapter } from "./adapter/types"
import { SessionService } from "./session-service"
import { Store } from "./store"
import { recordTermination, type TurnTermination } from "./turn-termination"

const stopped: TurnTermination = { cause: "user_stop", requestedAt: 1 }
const shutdown: TurnTermination = { cause: "daemon_shutdown", requestedAt: 2 }

describe("termination provenance", () => {
  test("user stop survives shutdown in either order", () => {
    expect(recordTermination(stopped, shutdown)).toEqual(stopped)
    expect(recordTermination(shutdown, stopped)).toEqual(stopped)
  })

  test("legacy interruptions keep unknown provenance", () => {
    expect(recordTermination(undefined, { cause: "unknown", requestedAt: 1 }).cause).toBe("unknown")
  })

  test("execution identity belongs to the turn, not the current session agent", () => {
    const store = new Store(":memory:")
    const session = store.createSession({ agent: "codex" })
    const turn = store.createTurn(session.id, "prompt")
    store.setTurnExecution(turn.id, { sessionId: session.id, turnId: turn.id, generation: 1, agentId: "codex" })
    store.patchSession(session.id, { agent: "claude" })
    expect(JSON.parse(store.getTurn(turn.id)!.execution!).agentId).toBe("codex")
    store.db.close()
  })

  test.each(["daemon_shutdown", "user_stop"] as const)("termination persists %s before ending the active turn", async (cause) => {
    const store = new Store(":memory:")
    let entered = false
    const adapter: AgentAdapter = {
      spec: FAKE_SPEC,
      reply: async (_text, ctx) => {
        entered = true
        await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true }))
      },
    }
    const service = new SessionService(store, adapter, () => {})
    const session = store.createSession({ agent: FAKE_SPEC.id })
    await service.invoke("message.send", { sessionId: session.id, text: "hello" }, "send")
    for (let i = 0; !entered && i < 100; i++) await Bun.sleep(5)
    expect(entered).toBe(true)
    if (cause === "user_stop") await service.invoke("message.steer", { sessionId: session.id, action: "cancel" }, "stop")
    await service.shutdown()
    const turn = store.listLatestTurns()[0]!
    expect(JSON.parse(turn.outcome!).termination.cause).toBe(cause)
    expect(JSON.parse(turn.execution!).agentId).toBe(FAKE_SPEC.id)
    store.db.close()
  })
})
