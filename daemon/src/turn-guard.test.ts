import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { FAKE_SPEC } from "./adapter/fake"
import type { AdapterContext, AgentAdapter, BackgroundTask } from "./adapter/types"
import type { Frame } from "./protocol"
import { SessionService } from "./session-service"
import { Store, type TurnOutcome } from "./store"

// Silence alone is not completion evidence. Explicit stop remains immediate.

const GUARD = { checkMs: 10, afterSpeechMs: 50, silentMs: 150 }

async function waitFor(predicate: () => boolean, timeoutMs = 2000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out")
    await Bun.sleep(5)
  }
}

// Holds the turn open the way a hung CLI does; only the daemon's abort lets reply() go.
function hang(ctx: AdapterContext): Promise<void> {
  return new Promise((_resolve, reject) => {
    if (ctx.signal.aborted) return reject(new Error("aborted"))
    ctx.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
  })
}

function task(id: string, status: BackgroundTask["status"]): BackgroundTask {
  return { id, kind: "command", title: id, startedAt: 1, status }
}

function harness(reply: AgentAdapter["reply"]) {
  const store = new Store(":memory:")
  const adapter: AgentAdapter = {
    spec: { id: "claude", label: "Claude Code", transport: "fake", experimental: false, capabilities: FAKE_SPEC.capabilities },
    reply,
  }
  const events: Frame[] = []
  const service = new SessionService(store, adapter, (frame) => events.push(frame), { turnGuard: GUARD })
  const idles = () =>
    events.filter((event) => event.name === "agent.status" && (event.payload as { status?: string }).status === "idle").length
  const outcome = (sessionId: string): TurnOutcome | undefined => {
    const row = store.listLatestTurns().find((turn) => turn.session_id === sessionId)
    return row?.outcome ? (JSON.parse(row.outcome) as TurnOutcome) : undefined
  }
  const start = async () => {
    const created = await service.invoke("session.create", { title: "守护", agent: "claude" }, "c1")
    const sessionId = (created.result as { session: { id: string } }).session.id
    await service.invoke("message.send", { sessionId, text: "go" }, "s1")
    return sessionId
  }
  return { store, service, events, idles, outcome, start }
}

let warn: ReturnType<typeof spyOn<Console, "warn">>
beforeEach(() => {
  warn = spyOn(console, "warn").mockImplementation(() => {})
})
afterEach(() => warn.mockRestore())
const warned = (text: string) => warn.mock.calls.some((call: unknown[]) => String(call[0]).includes(text))

describe("turn guard", () => {
  test("usage is not terminal evidence and silence remains inspectable", async () => {
    const h = harness(async (_text, ctx) => {
      ctx.emit({ type: "text", id: "t1", text: "working" })
      ctx.emit({ type: "usage", usage: { inputTokens: 1, outputTokens: 1 } })
      ctx.emit({ type: "reasoning", id: "r1", text: "still thinking", done: false })
      await hang(ctx)
    })
    const sessionId = await h.start()
    await Bun.sleep(GUARD.silentMs * 2)
    expect(h.outcome(sessionId)).toBeUndefined()
    expect(warned("quiet: inspect")).toBe(true)
    await h.service.invoke("message.steer", { sessionId, action: "cancel" }, "stop")
    await waitFor(() => h.outcome(sessionId) !== undefined)
    expect(h.outcome(sessionId)?.termination?.cause).toBe("user_stop")
  })

  test("stopped background work without a terminal result stays unknown", async () => {
    const h = harness(async (_text, ctx) => {
      ctx.emit({ type: "background", open: 1, paused: true, tasks: [task("b1", "running")] })
      ctx.emit({ type: "background", open: 0, paused: true, tasks: [task("b1", "cancelled")] })
      await hang(ctx)
    })
    const sessionId = await h.start()
    await Bun.sleep(GUARD.silentMs * 2)
    expect(h.outcome(sessionId)).toBeUndefined()
    await h.service.invoke("message.steer", { sessionId, action: "cancel" }, "stop")
    await waitFor(() => h.outcome(sessionId) !== undefined)
  })

  test("background work that finished on its own waits for the follow-up past the short limit", async () => {
    let whileOwed: (string | undefined)[] = []
    const h = harness(async (_text, ctx) => {
      ctx.emit({ type: "text", id: "t1", text: "started the tests in the background" })
      ctx.emit({ type: "background", open: 1, paused: true, tasks: [task("b1", "running")] })
      await Bun.sleep(40)
      ctx.emit({ type: "background", open: 0, paused: true, tasks: [task("b1", "done")] })
      await Bun.sleep(GUARD.afterSpeechMs * 2)
      whileOwed = h.events.filter((event) => event.name === "agent.status").map((event) => (event.payload as { status?: string }).status)
      ctx.emit({ type: "status", status: "running" })
      ctx.emit({ type: "text", id: "t2", text: "all green" })
      ctx.emit({ type: "usage", usage: { inputTokens: 1, outputTokens: 1 } })
    })
    const sessionId = await h.start()
    await waitFor(() => h.outcome(sessionId) !== undefined)
    expect(h.outcome(sessionId)).toMatchObject({ phase: "done" })
    expect(warned("stuck")).toBe(false)
    // idle while the work ran (the lock screen keeps it), running again once it finished and the answer is owed
    expect(whileOwed.slice(-2)).toEqual(["idle", "running"])
  })

  test("an absent follow-up is inspected rather than invented or interrupted", async () => {
    const h = harness(async (_text, ctx) => {
      ctx.emit({ type: "background", open: 1, paused: true, tasks: [task("b1", "running")] })
      ctx.emit({ type: "background", open: 0, paused: true, tasks: [task("b1", "done")] })
      await hang(ctx)
    })
    const sessionId = await h.start()
    await Bun.sleep(GUARD.silentMs * 2)
    expect(h.outcome(sessionId)).toBeUndefined()
    await h.service.invoke("message.steer", { sessionId, action: "cancel" }, "stop")
    await waitFor(() => h.outcome(sessionId) !== undefined)
  })

  test("explicit engine completion settles even when the adapter promise hangs", async () => {
    const h = harness(async (_text, ctx) => {
      ctx.emit({ type: "text", id: "t1", text: "verified result" })
      ctx.emit({ type: "lifecycle", phase: "terminal", terminalStatus: "completed", pendingFinalization: false })
      await hang(ctx)
    })
    const sessionId = await h.start()
    await waitFor(() => h.outcome(sessionId) !== undefined)
    expect(h.outcome(sessionId)?.phase).toBe("done")
  })

  test("an announced back-off is not stopped by the guard", async () => {
    const h = harness(async (_text, ctx) => {
      ctx.emit({ type: "retry", attempt: 1, delayMs: GUARD.silentMs * 2 })
      await hang(ctx)
    })
    const sessionId = await h.start()
    await Bun.sleep(GUARD.silentMs * 3)
    expect(h.outcome(sessionId)).toBeUndefined()
    await h.service.invoke("message.steer", { sessionId, action: "cancel" }, "stop")
    await waitFor(() => h.outcome(sessionId) !== undefined)
  })

  test("a tool still running keeps the turn alive", async () => {
    const h = harness(async (_text, ctx) => {
      ctx.emit({ type: "tool", id: "x1", tool: "Bash", title: "make", kind: "execute", status: "running", detail: "" })
      ctx.emit({ type: "usage", usage: { inputTokens: 1, outputTokens: 1 } })
      await hang(ctx)
    })
    const sessionId = await h.start()
    await Bun.sleep(GUARD.silentMs * 2)
    expect(h.idles()).toBe(0)
    await h.service.invoke("message.steer", { sessionId, action: "cancel" }, "x")
    await waitFor(() => h.outcome(sessionId) !== undefined)
    expect(h.outcome(sessionId)?.reason).toBeUndefined()
  })

  test("a pending approval keeps the turn alive", async () => {
    const h = harness(async (_text, ctx) => {
      await ctx.askPermission({
        tool: "Bash",
        title: "rm",
        detail: "rm -rf build",
        kind: "execute",
        options: [{ id: "a", label: "Allow", kind: "allow_once" }],
      })
      await hang(ctx)
    })
    const sessionId = await h.start()
    await Bun.sleep(GUARD.silentMs * 2)
    expect(h.idles()).toBe(0)
    await h.service.invoke("message.steer", { sessionId, action: "cancel" }, "x")
    await waitFor(() => h.outcome(sessionId) !== undefined)
    expect(h.outcome(sessionId)?.reason).toBeUndefined()
  })

  test("a turn that ends on its own is untouched, and the next one starts and answers", async () => {
    let turns = 0
    const h = harness(async (_text, ctx) => {
      turns += 1
      ctx.emit({ type: "text", id: `t${turns}`, text: `reply ${turns}` })
      ctx.emit({ type: "usage", usage: { inputTokens: 1, outputTokens: 1 } })
    })
    const sessionId = await h.start()
    await waitFor(() => h.outcome(sessionId) !== undefined)
    expect(h.outcome(sessionId)).toEqual(expect.objectContaining({ phase: "done" }))
    expect(h.outcome(sessionId)?.reason).toBeUndefined()
    await Bun.sleep(GUARD.silentMs)
    await h.service.invoke("message.send", { sessionId, text: "again" }, "s2")
    await waitFor(() => h.idles() >= 2)
    expect(turns).toBe(2)
    expect(h.outcome(sessionId)?.phase).toBe("done")
    expect(warned("stuck")).toBe(false)
  })

  // Plan 2026-11-18: process exit is every wait's breaker, open background work included, and the reason is the
  // agent's own exit line rather than a generic one.
  test("open background work does not keep a closed transport's turn open", async () => {
    const h = harness(async (_text, ctx) => {
      ctx.emit({ type: "text", id: "t1", text: "started it in the background" })
      ctx.emit({ type: "background", open: 1, paused: true, tasks: [task("b1", "running")] })
      ctx.emit({ type: "lifecycle", phase: "working", transport: "closed", pendingFinalization: false, detail: "grok exited (code 1): boom" })
      await hang(ctx)
    })
    const sessionId = await h.start()
    await waitFor(() => h.outcome(sessionId) !== undefined)
    expect(h.outcome(sessionId)).toMatchObject({ phase: "failed", reason: "grok exited (code 1): boom", termination: { cause: "transport_closed" } })
  })

  test("an end the adapter inferred from quiet is recorded as inferred, the turn itself done", async () => {
    const h = harness(async (_text, ctx) => {
      ctx.emit({ type: "text", id: "t1", text: "the background command finished" })
      ctx.emit({ type: "lifecycle", phase: "terminal", terminalStatus: "completed", pendingFinalization: false, inferred: { trigger: "short", quietMs: 3000 } })
    })
    const sessionId = await h.start()
    await waitFor(() => h.outcome(sessionId) !== undefined)
    expect(h.outcome(sessionId)).toMatchObject({ phase: "done", termination: { cause: "inferred_quiet", evidence: { trigger: "short", quietMs: 3000 } } })
  })
})
