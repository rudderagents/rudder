import { describe, expect, test } from "bun:test"
import type { AgentAdapter } from "./adapter/types"
import { FAKE_SPEC } from "./adapter/fake"
import type { Frame } from "./protocol"
import { SessionService } from "./session-service"
import { sessionPublic, Store } from "./store"

// Product decision (2026-11-19): the home list moves a row only when a turn starts, when the owner is needed and when
// the turn ends. `activeAt` is that key; `updatedAt` keeps moving with every streamed row.

async function tick() {
  await Bun.sleep(2)
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out")
    await Bun.sleep(5)
  }
}

function activeAt(store: Store, id: string) {
  return sessionPublic(store.getSession(id)!, {}).activeAt
}

describe("session activeAt", () => {
  test("a new session starts with activeAt equal to updatedAt", () => {
    const store = new Store(":memory:")
    const row = store.createSession({ title: "a" })
    const pub = sessionPublic(row, {})
    expect(pub.activeAt).toBe(pub.updatedAt)
  })

  test("streamed messages move updatedAt but not activeAt", async () => {
    const store = new Store(":memory:")
    const row = store.createSession({ title: "a" })
    store.patchSession(row.id, { status: "running" })
    const started = activeAt(store, row.id)
    await tick()
    store.insertMessage({ id: "m1", session_id: row.id, kind: "tool", role: "assistant", text: "ls", created_at: Date.now() })
    store.patchSession(row.id, { usage: { inputTokens: 1 } as never })
    const after = sessionPublic(store.getSession(row.id)!, {})
    expect(after.updatedAt).toBeGreaterThan(started)
    expect(after.activeAt).toBe(started)
  })

  test("turn start, needing the owner and turn end move activeAt", async () => {
    const store = new Store(":memory:")
    const row = store.createSession({ title: "a" })
    const created = activeAt(store, row.id)
    await tick()
    store.patchSession(row.id, { status: "running" })
    const started = activeAt(store, row.id)
    expect(started).toBeGreaterThan(created)
    await tick()
    store.patchSession(row.id, { status: "waiting" })
    const waiting = activeAt(store, row.id)
    expect(waiting).toBeGreaterThan(started)
    await tick()
    // Answering resumes the same turn: no new move.
    store.patchSession(row.id, { status: "running" })
    expect(activeAt(store, row.id)).toBe(waiting)
    await tick()
    store.patchSession(row.id, { status: "idle" })
    expect(activeAt(store, row.id)).toBeGreaterThan(waiting)
  })

  test("pin, archive, read and a repeated status leave activeAt alone", async () => {
    const store = new Store(":memory:")
    const row = store.createSession({ title: "a" })
    const created = activeAt(store, row.id)
    await tick()
    store.patchSession(row.id, { pinned: true })
    store.patchSession(row.id, { archived: true })
    store.patchSession(row.id, { lastReadSeq: 0 })
    store.patchSession(row.id, { status: "idle" })
    store.patchSession(row.id, { title: "renamed" })
    expect(activeAt(store, row.id)).toBe(created)
  })

  test("a row written before activeAt existed falls back to updatedAt", () => {
    const store = new Store(":memory:")
    const row = store.createSession({ title: "a" })
    const legacy = { ...store.getSession(row.id)!, active_at: null }
    expect(sessionPublic(legacy, {}).activeAt).toBe(legacy.updated_at)
  })
})

describe("session.list step", () => {
  test("the full list carries a running session's current step", async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const adapter: AgentAdapter = {
      spec: { id: "s", label: "s", transport: "fake", experimental: false, capabilities: FAKE_SPEC.capabilities },
      reply: async (_text, ctx) => {
        ctx.emit({ type: "tool", id: "t1", tool: "Bash", title: "Run", kind: "execute", status: "running", detail: "bun test --filter relay" })
        await gate
      },
    }
    const store = new Store(":memory:")
    const events: Frame[] = []
    const service = new SessionService(store, adapter, (frame) => events.push(frame))
    const created = await service.invoke("session.create", { title: "a", agent: "s" }, "c1")
    const id = (created.result as { session: { id: string } }).session.id
    await service.invoke("message.send", { sessionId: id, text: "go" }, "m1")
    const stepOf = (frame: Frame) => (frame.payload as { id?: string; step?: unknown } | undefined)
    await waitFor(() => events.some((event) => event.name === "session.upsert" && stepOf(event)?.id === id && stepOf(event)?.step))
    const listed = await service.invoke("session.list", {}, "l1")
    const row = (listed.result as { sessions: Array<{ id: string; step?: { kind: string; text: string } }> }).sessions.find((s) => s.id === id)
    expect(row?.step?.kind).toBe("execute")
    const delta = await service.invoke("session.list", { sinceVersion: 0 }, "l2")
    const changed = (delta.result as { sessions: Array<{ id: string; step?: unknown }> }).sessions.find((s) => s.id === id)
    expect(changed?.step).toBeDefined()
    release()
  })
})
