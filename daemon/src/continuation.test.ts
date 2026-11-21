import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AdapterContext, AgentAdapter, AgentSpec, ContinuationOffer } from "./adapter/types"
import type { Frame } from "./protocol"
import { SessionService } from "./session-service"
import { Store } from "./store"

const spec: AgentSpec = { id: "claude", label: "Claude", transport: "fake", experimental: false,
  capabilities: { reasoning: false, steer: false, interrupt: true, plan: false, question: false, usage: "none",
    models: "static", efforts: false, modes: [] } } as unknown as AgentSpec

type Harness = {
  store: Store
  service: SessionService
  sessionId: string
  contexts: AdapterContext[]
  cancelled: string[]
  frames: Frame[]
  offer: (offer: Omit<ContinuationOffer, "identity"> & { identity?: Partial<ContinuationOffer["identity"]> }) => void
  release: () => void
}

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function until(check: () => boolean) {
  const deadline = Date.now() + 5000
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out")
    await Bun.sleep(5)
  }
}

/** A real SessionService over an adapter that records each reply's context and can hold a turn open. */
function harness(hooks: Record<string, unknown> = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), "rudder-continue-"))
  const contexts: AdapterContext[] = []
  const cancelled: string[] = []
  let sink: ((offer: ContinuationOffer) => void) | undefined
  let hold: Promise<void> = Promise.resolve()
  let release = () => {}
  const adapter: AgentAdapter = {
    spec,
    async reply(text, ctx) {
      contexts.push(ctx)
      ctx.emit({ type: "native", nativeId: "native-1" })
      await hold
      ctx.emit({ type: "text", id: crypto.randomUUID(), text: `re: ${text}` })
    },
    setContinuationSink(next) {
      sink = next
    },
    cancelContinuation(sessionId) {
      cancelled.push(sessionId)
    },
  }
  const store = new Store(":memory:")
  const frames: Frame[] = []
  const service = new SessionService(store, adapter, (frame) => frames.push(frame), { workspaceRoot: root, ...hooks } as never)
  const session = store.createSession({ agent: "claude", cwd: root })
  cleanups.push(async () => {
    release()
    await service.shutdown()
    store.db.close()
    rmSync(root, { recursive: true, force: true })
  })
  const h: Harness = {
    store, service, sessionId: session.id, contexts, cancelled, frames,
    offer: (offer) => {
      const current = store.getSession(session.id)!
      sink!({ ...offer, identity: { sessionId: session.id, turnId: "", generation: current.generation ?? 0, agentId: "claude",
        nativeSessionId: current.native_id ?? "native-1", ...offer.identity } })
    },
    release: () => release(),
  }
  Object.defineProperty(h, "hold", { value: () => {
    hold = new Promise((resolve) => { release = resolve })
  } })
  return h
}

const holdNext = (h: Harness) => (h as unknown as { hold: () => void }).hold()
const idle = (h: Harness) => until(() => h.store.getSession(h.sessionId)?.status === "idle" && !h.store.listMessages(h.sessionId).some(() => false))
const userRows = (h: Harness) => h.store.listMessages(h.sessionId).filter((row) => row.role === "user")
const origin = (row: { payload: string | null }) => (JSON.parse(row.payload ?? "{}") as { origin?: string }).origin

async function firstTurn(h: Harness) {
  await h.service.invoke("message.send", { sessionId: h.sessionId, text: "hello" }, "phone")
  await until(() => h.contexts.length === 1 && h.store.getSession(h.sessionId)?.status === "idle")
}

test("an offer opens a turn whose user row is an agent_continue notice", async () => {
  const h = harness()
  await firstTurn(h)
  h.offer({ key: "t1", detail: "Agent \"Review\" finished", delivery: "buffered" })
  await until(() => h.contexts.length === 2)
  await idle(h)
  const rows = userRows(h)
  expect(rows).toHaveLength(2)
  expect(origin(rows[1]!)).toBe("agent_continue")
  expect(rows[1]!.text).toBe("Agent \"Review\" finished")
  expect(h.contexts[1]!.continuation).toEqual({ key: "t1", delivery: "buffered" })
  expect(h.contexts[0]!.continuation).toBeUndefined()
  expect(h.store.db.query("SELECT COUNT(*) AS n FROM session_turns").get()).toEqual({ n: 2 })
})

test("the same offer twice opens one turn", async () => {
  const h = harness()
  await firstTurn(h)
  h.offer({ key: "t1", detail: "done", delivery: "buffered" })
  await until(() => h.contexts.length === 2)
  await idle(h)
  h.offer({ key: "t1", detail: "done", delivery: "buffered" })
  await Bun.sleep(50)
  expect(h.contexts).toHaveLength(2)
  expect(userRows(h)).toHaveLength(2)
})

test("an offer for an old generation or another native session is dropped", async () => {
  const h = harness()
  await firstTurn(h)
  const generation = h.store.getSession(h.sessionId)!.generation ?? 0
  h.store.db.query("UPDATE sessions SET generation = generation + 1 WHERE id = ?").run(h.sessionId)
  h.offer({ key: "old", detail: "stale", delivery: "buffered", identity: { generation } })
  h.offer({ key: "other", detail: "elsewhere", delivery: "buffered", identity: { nativeSessionId: "native-2" } })
  await Bun.sleep(50)
  expect(h.contexts).toHaveLength(1)
  expect(userRows(h)).toHaveLength(1)
})

test("a user turn that starts while a buffered continuation is held takes its place", async () => {
  const h = harness()
  await firstTurn(h)
  holdNext(h)
  await h.service.invoke("message.send", { sessionId: h.sessionId, text: "second" }, "phone")
  await until(() => h.contexts.length === 2)
  await h.service.invoke("message.send", { sessionId: h.sessionId, text: "third" }, "phone")
  h.offer({ key: "t1", detail: "wake", delivery: "buffered" })
  h.release()
  await until(() => h.contexts.length === 3)
  await idle(h)
  await Bun.sleep(50)
  // The adapter replays what it kept at the start of "third"; no separate continuation turn follows.
  expect(userRows(h).map((row) => row.text)).toEqual(["hello", "second", "third"])
})

test("a message_text continuation still runs after the user's queued sends", async () => {
  const h = harness()
  await firstTurn(h)
  holdNext(h)
  await h.service.invoke("message.send", { sessionId: h.sessionId, text: "second" }, "phone")
  await until(() => h.contexts.length === 2)
  await h.service.invoke("message.send", { sessionId: h.sessionId, text: "third" }, "phone")
  h.offer({ key: "child", detail: "Subagent finished:\nX", delivery: "message_text" })
  h.release()
  await until(() => h.contexts.length === 4)
  await idle(h)
  expect(userRows(h).map((row) => row.text)).toEqual(["hello", "second", "third", "Subagent finished:\nX"])
})

// Two subagents ending while a turn runs: each one's words come up in its own turn, in order. A second offer used to be
// answered "taken" and dropped (one pending offer per session).
test("two continuations held behind a turn both run, in the order they came", async () => {
  const h = harness()
  await firstTurn(h)
  holdNext(h)
  await h.service.invoke("message.send", { sessionId: h.sessionId, text: "second" }, "phone")
  await until(() => h.contexts.length === 2)
  h.offer({ key: "child-a", detail: "Subagent A finished", delivery: "message_text" })
  h.offer({ key: "child-b", detail: "Subagent B finished", delivery: "message_text" })
  h.offer({ key: "child-a", detail: "Subagent A finished", delivery: "message_text" })
  h.release()
  await until(() => h.contexts.length === 4)
  await idle(h)
  expect(userRows(h).map((row) => row.text)).toEqual(["hello", "second", "Subagent A finished", "Subagent B finished"])
})

test("the phone's message.append carries origin agent_continue", async () => {
  const h = harness()
  await firstTurn(h)
  h.offer({ key: "t1", detail: "wake", delivery: "buffered" })
  await until(() => h.contexts.length === 2)
  const appended = h.frames.filter((frame) => frame.name === "message.append").map((frame) => frame.payload as { role?: string; text?: string; origin?: string })
  expect(appended.find((row) => row.role === "user" && row.text === "wake")?.origin).toBe("agent_continue")
})

test("the live card is told a continuation started, not the agent's summary as a prompt", async () => {
  const starts: unknown[][] = []
  // Every other card call is a no-op here.
  const card = new Proxy({}, { get: (_, name) => name === "turnStarted" ? (...args: unknown[]) => starts.push(args.slice(1)) : () => undefined })
  const h = harness({ card })
  await firstTurn(h)
  h.offer({ key: "child", detail: "Subagent finished:\nX", delivery: "message_text" })
  await until(() => h.contexts.length === 2)
  expect(starts).toEqual([["hello"], ["Subagent finished:\nX", { continuation: true }]])
})

test("a continuation's done notice carries no first prompt: the agent wrote it, not the user", async () => {
  const pushed: { firstPrompt?: string }[] = []
  const h = harness({ push: (payload: { kind: string; firstPrompt?: string }) => { if (payload.kind === "done") pushed.push(payload) } })
  await firstTurn(h)
  h.offer({ key: "child", detail: "Subagent finished:\nX", delivery: "message_text" })
  await until(() => h.contexts.length === 2)
  await idle(h)
  await until(() => pushed.length >= 1)
  expect(pushed.some((payload) => payload.firstPrompt?.startsWith("Subagent finished"))).toBe(false)
})

test("a held continuation is checked again before it starts", async () => {
  const h = harness()
  await firstTurn(h)
  holdNext(h)
  await h.service.invoke("message.send", { sessionId: h.sessionId, text: "second" }, "phone")
  await until(() => h.contexts.length === 2)
  h.offer({ key: "child", detail: "late", delivery: "message_text" })
  h.store.db.query("UPDATE sessions SET generation = generation + 1 WHERE id = ?").run(h.sessionId)
  h.release()
  await idle(h)
  await Bun.sleep(50)
  expect(h.contexts).toHaveLength(2)
})

test("stop drops a queued continuation and quiets the adapter", async () => {
  const h = harness()
  await firstTurn(h)
  holdNext(h)
  await h.service.invoke("message.send", { sessionId: h.sessionId, text: "second" }, "phone")
  await until(() => h.contexts.length === 2)
  h.offer({ key: "t1", detail: "wake", delivery: "buffered" })
  await h.service.invoke("message.steer", { sessionId: h.sessionId, action: "cancel" }, "phone")
  h.release()
  await idle(h)
  await Bun.sleep(50)
  expect(h.contexts).toHaveLength(2)
  expect(h.cancelled).toContain(h.sessionId)
  expect(userRows(h).map((row) => row.text)).toEqual(["hello", "second"])
})

test("an empty detail uses the fallback text", async () => {
  const h = harness()
  await firstTurn(h)
  h.offer({ key: "t1", detail: "", delivery: "buffered" })
  await until(() => h.contexts.length === 2)
  expect(userRows(h)[1]!.text).toBe("后台任务完成")
})
