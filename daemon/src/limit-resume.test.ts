import { describe, expect, test } from "bun:test"
import type { AdapterRegistry } from "./adapter"
import { AgentError } from "./adapter/agent-error"
import { createFakeAdapter, FAKE_SPEC } from "./adapter/fake"
import type { AdapterContext, AgentAdapter } from "./adapter/types"
import type { Frame } from "./protocol"
import type { PushPayload } from "./push"
import { type AutoResumeTimings, RESUME_PROMPT, SessionService } from "./session-service"
import { Store } from "./store"

async function waitFor(predicate: () => boolean, timeoutMs = 2000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out")
    await Bun.sleep(5)
  }
}

type Mode = { kind: "ok" } | { kind: "limit"; resetIn: number } | { kind: "hold" }

// One fake Claude whose next turns answer, hit a usage limit resetting `resetIn` ms from now, or wait for release
// and then end as the mode then says.
function harness(timings: Partial<AutoResumeTimings> = {}, store = new Store(":memory:")) {
  const seen: string[] = []
  const releases: Array<() => void> = []
  const pushes: PushPayload[] = []
  const events: Frame[] = []
  let mode: Mode = { kind: "ok" }
  const fake = createFakeAdapter({ ...FAKE_SPEC, id: "claude", label: "Claude" })
  const claude: AgentAdapter = {
    ...fake,
    reply: async (text: string, ctx: AdapterContext) => {
      seen.push(text)
      if (mode.kind === "hold") await new Promise<void>((resolve) => releases.push(resolve))
      // Read after the hold: a released turn ends the way the test set it meanwhile.
      const now = mode
      if (now.kind === "limit") {
        ctx.emit({ type: "native", nativeId: ctx.nativeId ?? `native-${ctx.sessionId}` })
        throw new AgentError("usage limit", { code: "usage_limit", resetsAt: Date.now() + now.resetIn })
      }
      return fake.reply("ok", ctx)
    },
  }
  // A second agent to switch to (r73 G); it always answers.
  const codexSeen: string[] = []
  const fakeCodex = createFakeAdapter({ ...FAKE_SPEC, id: "codex", label: "Codex" })
  const codex: AgentAdapter = {
    ...fakeCodex,
    reply: async (text: string, ctx: AdapterContext) => {
      codexSeen.push(text)
      return fakeCodex.reply("ok", ctx)
    },
  }
  const registry: AdapterRegistry = {
    get: (id) => (id === "claude" ? claude : id === "codex" ? codex : undefined),
    list: () => [claude, codex],
  }
  const service = new SessionService(store, registry, (frame) => events.push(frame), {
    push: (payload) => pushes.push(payload),
    autoResume: { jitterMs: 0, restartDelayMs: 20, ...timings },
  })
  const idle = (id: string) =>
    events.filter((event) => {
      const payload = (event.payload ?? {}) as Record<string, unknown>
      return event.name === "agent.status" && payload.sessionId === id && payload.status === "idle"
    }).length
  const send = async (id: string, text: string) => {
    const before = idle(id)
    const sent = await service.invoke("message.send", { sessionId: id, text }, crypto.randomUUID())
    expect(sent.error).toBeUndefined()
    if (mode.kind !== "hold") await waitFor(() => idle(id) > before)
  }
  const resumes = (origin = "auto_resume") =>
    store.listMessages(store.listSessions()[0]?.id ?? "", { limit: 100 })
      .filter((message) => message.role === "user" && JSON.parse(message.payload ?? "{}").origin === origin).length
  return {
    store, service, seen, codexSeen, pushes, events, send, idle, resumes,
    setMode: (next: Mode) => {
      mode = next
    },
    release: () => releases.shift()?.(),
  }
}

describe("continuing after a usage limit resets (r73 A)", () => {
  test("continues once at the reset, tells the phone, and lets the paused queue go", async () => {
    const h = harness()
    const id = h.store.createSession({ agent: "claude" }).id
    h.setMode({ kind: "hold" })
    await h.send(id, "first")
    await h.send(id, "queued")
    h.setMode({ kind: "limit", resetIn: 80 })
    h.release()
    await waitFor(() => h.store.getLimitResume(id) !== null)
    const upsert = h.events.findLast((event) => event.name === "session.upsert" && (event.payload as { id?: string }).id === id)
    expect((upsert?.payload as { autoResumeAt?: number } | undefined)?.autoResumeAt).toBe(h.store.getLimitResume(id)?.resets_at)
    h.setMode({ kind: "ok" })
    await waitFor(() => h.seen.length === 3)
    expect(h.seen).toEqual(["first", RESUME_PROMPT, "queued"])
    expect(h.resumes()).toBe(1)
    expect(h.store.getLimitResume(id)).toBeNull()
    expect(h.pushes.filter((push) => push.kind === "resumed")).toEqual([
      expect.objectContaining({ kind: "resumed", resume: "limit", sessionId: id }),
    ])
    await Bun.sleep(100)
    expect(h.seen.length).toBe(3)
  })

  test("a message sent by hand meanwhile replaces the resume", async () => {
    const h = harness()
    const id = h.store.createSession({ agent: "claude" }).id
    h.setMode({ kind: "limit", resetIn: 60 })
    await h.send(id, "first")
    expect(h.store.getLimitResume(id)).not.toBeNull()
    h.setMode({ kind: "ok" })
    await h.send(id, "by hand")
    expect(h.store.getLimitResume(id)).toBeNull()
    await Bun.sleep(120)
    expect(h.seen).toEqual(["first", "by hand"])
  })

  test("off in settings: nothing waits, and turning it off drops what was waiting", async () => {
    const h = harness()
    const id = h.store.createSession({ agent: "claude" }).id
    h.setMode({ kind: "limit", resetIn: 60 })
    await h.send(id, "first")
    expect(h.store.getLimitResume(id)).not.toBeNull()
    const patched = await h.service.invoke("machine.patch", { autoResumeLimits: false }, crypto.randomUUID())
    expect((patched.result as { machine: { autoResumeLimits: boolean } }).machine.autoResumeLimits).toBe(false)
    expect(h.store.getLimitResume(id)).toBeNull()
    await h.send(id, "again")
    expect(h.store.getLimitResume(id)).toBeNull()
    h.setMode({ kind: "ok" })
    await Bun.sleep(120)
    expect(h.seen).toEqual(["first", "again"])
  })

  test("a restart picks the wait up from the table", async () => {
    const store = new Store(":memory:")
    const before = harness({}, store)
    const id = store.createSession({ agent: "claude" }).id
    before.setMode({ kind: "limit", resetIn: 150 })
    await before.send(id, "first")
    await before.service.shutdown(0)
    const after = harness({}, store)
    await waitFor(() => after.seen.length === 1)
    expect(after.seen).toEqual([RESUME_PROMPT])
    expect(before.seen).toEqual(["first"])
  })

  test("a reset more than 24 hours away is given up", async () => {
    const h = harness({ maxArmMs: 100 })
    const id = h.store.createSession({ agent: "claude" }).id
    h.setMode({ kind: "limit", resetIn: 500 })
    await h.send(id, "first")
    expect(h.store.getLimitResume(id)).toBeNull()
    // A stored row past the cap (an older rudderd, a changed clock) is dropped when armed after a restart.
    h.store.setLimitResume(id, h.store.listLatestTurns()[0]!.id, Date.now() + 500)
    await h.service.shutdown(0)
    harness({ maxArmMs: 100 }, h.store)
    expect(h.store.getLimitResume(id)).toBeNull()
  })

  test("cancel from the phone stops the resume", async () => {
    const h = harness()
    const id = h.store.createSession({ agent: "claude" }).id
    h.setMode({ kind: "limit", resetIn: 60 })
    await h.send(id, "first")
    const cancelled = await h.service.invoke("session.autoResume", { id, cancel: true }, crypto.randomUUID())
    expect(cancelled.result).toEqual(expect.objectContaining({ ok: true, cancelled: true }))
    expect((cancelled.result as { session: { autoResumeAt?: number } }).session.autoResumeAt).toBeUndefined()
    h.setMode({ kind: "ok" })
    await Bun.sleep(120)
    expect(h.seen).toEqual(["first"])
  })

  test("rewinding drops a paused queue: it was written against the turns removed", async () => {
    const h = harness()
    const id = h.store.createSession({ agent: "claude" }).id
    h.setMode({ kind: "hold" })
    await h.send(id, "first")
    const request = { sessionId: id, text: "queued", clientMessageId: "12121212-1212-4212-8212-121212121212" }
    expect((await h.service.invoke("message.send", request, crypto.randomUUID())).result).toHaveProperty("queued")
    h.setMode({ kind: "limit", resetIn: 60_000 })
    h.release()
    await waitFor(() => h.store.getLimitResume(id) !== null)
    const before = h.events.length
    const rewound = await h.service.invoke("session.rewind", { id, seq: 1 }, crypto.randomUUID())
    expect(rewound.error).toBeUndefined()
    const listed = await h.service.invoke("queue.list", { sessionId: id }, crypto.randomUUID())
    expect((listed.result as { items: unknown[] }).items).toEqual([])
    const frames = h.events.slice(before).filter((event) => event.name === "queue.upsert")
    expect(frames.map((event) => (event.payload as { items: unknown[] }).items)).toContainEqual([])
    const retried = await h.service.invoke("message.send", request, crypto.randomUUID())
    expect((retried.result as { cancelled?: boolean }).cancelled).toBe(true)
    h.setMode({ kind: "ok" })
    await h.send(id, "after")
    await Bun.sleep(60)
    expect(h.seen).toHaveLength(2)
    expect(h.seen[1]?.endsWith("after")).toBe(true)
    expect(h.seen.some((text) => text.includes("queued"))).toBe(false)
  })
})

describe("turning the resume back on from the phone (r73 A 恢复)", () => {
  test("cancel then re-arm: the resume waits again and runs at the reset", async () => {
    const h = harness()
    const id = h.store.createSession({ agent: "claude" }).id
    h.setMode({ kind: "limit", resetIn: 80 })
    await h.send(id, "first")
    const resetsAt = h.store.getLimitResume(id)?.resets_at
    await h.service.invoke("session.autoResume", { id, cancel: true }, crypto.randomUUID())
    expect(h.store.getLimitResume(id)).toBeNull()
    const armed = await h.service.invoke("session.autoResume", { id, cancel: false }, crypto.randomUUID())
    expect(armed.result).toEqual(expect.objectContaining({ ok: true, armed: true }))
    expect((armed.result as { session: { autoResumeAt?: number } }).session.autoResumeAt).toBe(resetsAt)
    const upsert = h.events.findLast((event) => event.name === "session.upsert" && (event.payload as { id?: string }).id === id)
    expect((upsert?.payload as { autoResumeAt?: number } | undefined)?.autoResumeAt).toBe(resetsAt)
    h.setMode({ kind: "ok" })
    await waitFor(() => h.seen.length === 2)
    expect(h.seen).toEqual(["first", RESUME_PROMPT])
    expect(h.resumes()).toBe(1)
  })

  test("nothing to arm: setting off, reset passed, or the last turn did not stop at a limit", async () => {
    const h = harness()
    const id = h.store.createSession({ agent: "claude" }).id
    await h.send(id, "fine")
    const notFailed = await h.service.invoke("session.autoResume", { id, cancel: false }, crypto.randomUUID())
    expect(notFailed.result).toEqual(expect.objectContaining({ ok: true, armed: false }))

    h.setMode({ kind: "limit", resetIn: 60 })
    await h.send(id, "limited")
    await h.service.invoke("session.autoResume", { id, cancel: true }, crypto.randomUUID())
    await h.service.invoke("machine.patch", { autoResumeLimits: false }, crypto.randomUUID())
    const off = await h.service.invoke("session.autoResume", { id, cancel: false }, crypto.randomUUID())
    expect(off.result).toEqual(expect.objectContaining({ ok: true, armed: false }))
    expect(h.store.getLimitResume(id)).toBeNull()

    await h.service.invoke("machine.patch", { autoResumeLimits: true }, crypto.randomUUID())
    await Bun.sleep(80)
    const passed = await h.service.invoke("session.autoResume", { id, cancel: false }, crypto.randomUUID())
    expect(passed.result).toEqual(expect.objectContaining({ ok: true, armed: false }))
    expect(h.seen).toEqual(["fine", "limited"])

    const bad = await h.service.invoke("session.autoResume", { id }, crypto.randomUUID())
    expect(bad.error?.code).toBe("invalid")
  })
})

describe("carrying on with a fallback agent (r73 G)", () => {
  test("switching drops the wait; an empty fallback_resume send gives the new agent the resume prompt", async () => {
    const h = harness()
    const id = h.store.createSession({ agent: "claude" }).id
    h.setMode({ kind: "limit", resetIn: 60 })
    await h.send(id, "first")
    expect(h.store.getLimitResume(id)).not.toBeNull()
    const switched = await h.service.invoke("session.switchAgent", { id, agent: "codex", model: "" }, crypto.randomUUID())
    expect(switched.error).toBeUndefined()
    expect(h.store.getLimitResume(id)).toBeNull()
    const notice = h.events.findLast((event) => event.name === "message.append")?.payload as { agentSwitch?: unknown }
    expect(notice.agentSwitch).toEqual({ from: { agent: "claude", model: "" }, to: { agent: "codex", model: "" } })

    const before = h.idle(id)
    const sent = await h.service.invoke("message.send", { sessionId: id, text: "", origin: "fallback_resume" }, crypto.randomUUID())
    expect(sent.error).toBeUndefined()
    await waitFor(() => h.idle(id) > before)
    expect(h.codexSeen).toEqual([expect.stringContaining(RESUME_PROMPT)])
    expect(h.resumes("fallback_resume")).toBe(1)
    const appended = h.events.filter((event) => event.name === "message.append").map((event) => event.payload as { role?: string; origin?: string })
    expect(appended.findLast((message) => message.role === "user")?.origin).toBe("fallback_resume")
    await Bun.sleep(100)
    expect(h.seen).toEqual(["first"])
  })

  test("switchAgent {resume: true} marks the notice and sends the continuation itself (r72 App)", async () => {
    const h = harness()
    const id = h.store.createSession({ agent: "claude" }).id
    h.setMode({ kind: "limit", resetIn: 60 })
    await h.send(id, "first")
    const before = h.idle(id)
    const switched = await h.service.invoke("session.switchAgent", { id, agent: "codex", model: "", resume: true }, crypto.randomUUID())
    expect(switched.error).toBeUndefined()
    expect(switched.result).toEqual(expect.objectContaining({ resumed: true }))
    expect(h.store.getLimitResume(id)).toBeNull()
    await waitFor(() => h.idle(id) > before)
    expect(h.codexSeen).toEqual([expect.stringContaining(RESUME_PROMPT)])
    expect(h.resumes("fallback_resume")).toBe(1)

    // The notice (already `resume: true`) reaches the phone before the continuation message does.
    const appended = h.events.filter((event) => event.name === "message.append").map((event) => event.payload as {
      role?: string; origin?: string; agentSwitch?: unknown
    })
    const noticeAt = appended.findIndex((message) => message.agentSwitch !== undefined)
    const resumeAt = appended.findIndex((message) => message.origin === "fallback_resume")
    expect(appended[noticeAt]?.agentSwitch).toEqual({ from: { agent: "claude", model: "" }, to: { agent: "codex", model: "" }, resume: true })
    expect(resumeAt).toBeGreaterThan(noticeAt)

    // History pages carry the same flag.
    const listed = await h.service.invoke("session.get", { id, markRead: false }, crypto.randomUUID())
    const rows = (listed.result as { messages: { agentSwitch?: { resume?: boolean } }[] }).messages
    expect(rows.find((message) => message.agentSwitch)?.agentSwitch?.resume).toBe(true)
  })

  test("a plain switch has no resume flag; a refused resume switch sends nothing", async () => {
    const h = harness()
    const id = h.store.createSession({ agent: "claude" }).id
    await h.send(id, "first")
    h.setMode({ kind: "hold" })
    await h.send(id, "long job")
    await waitFor(() => h.seen.length === 2)
    const refused = await h.service.invoke("session.switchAgent", { id, agent: "codex", model: "", resume: true }, crypto.randomUUID())
    expect(refused.error?.code).toBe("busy")
    expect(h.resumes("fallback_resume")).toBe(0)
    expect(h.codexSeen).toEqual([])
  })
})

describe("continuing after rudderd restarts (r73 B)", () => {
  async function cutShort(timings: Partial<AutoResumeTimings> = {}) {
    const store = new Store(":memory:")
    const before = harness(timings, store)
    const id = store.createSession({ agent: "claude" }).id
    await before.send(id, "warm up")
    expect(store.getSession(id)?.native_id).not.toBeNull()
    before.setMode({ kind: "hold" })
    await before.send(id, "long job")
    await waitFor(() => before.seen.length === 2)
    return { store, id, before }
  }

  test("a turn the restart cut short is continued once", async () => {
    const { store } = await cutShort()
    const after = harness({}, store)
    await waitFor(() => after.seen.length === 1)
    expect(after.seen).toEqual([RESUME_PROMPT])
    expect(after.resumes("restart_resume")).toBe(1)
    await Bun.sleep(80)
    expect(after.seen.length).toBe(1)
  })

  test("off in settings: not continued", async () => {
    const { store } = await cutShort()
    store.setMeta("continue_after_restart", "0")
    const after = harness({}, store)
    await Bun.sleep(80)
    expect(after.seen).toEqual([])
    expect((after.service.machine() as { continueAfterRestart: boolean }).continueAfterRestart).toBe(false)
  })

  test("cut short longer ago than the window: not continued", async () => {
    const { store } = await cutShort()
    await Bun.sleep(30)
    const after = harness({ restartWindowMs: 10 }, store)
    await Bun.sleep(80)
    expect(after.seen).toEqual([])
  })

  test("no agent-native session to go back to: not continued", async () => {
    const { store, id } = await cutShort()
    store.patchSession(id, { nativeId: null })
    const after = harness({}, store)
    await Bun.sleep(80)
    expect(after.seen).toEqual([])
  })
})
