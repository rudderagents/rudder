import { describe, expect, test } from "bun:test"
import type { AdapterContext, AgentAdapter, BackgroundTask } from "./adapter/types"
import { FAKE_SPEC } from "./adapter/fake"
import { LiveActivityNotifier } from "./live-activity"
import type { Frame } from "./protocol"
import { SessionService } from "./session-service"
import { Store } from "./store"

// background tasks on session.upsert, the list kept past the turn, background.stop, the lock-screen step.

const SESSION_KEY = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
const ACTIVITY = "ab".repeat(32)

async function waitFor(predicate: () => boolean, timeoutMs = 2000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out")
    await Bun.sleep(5)
  }
}

function payload(frame: Frame): Record<string, unknown> {
  return (frame.payload ?? {}) as Record<string, unknown>
}

function task(id: string, status: BackgroundTask["status"], extra: Partial<BackgroundTask> = {}): BackgroundTask {
  return { id, kind: id.startsWith("a") ? "subagent" : "command", title: id, startedAt: 1, status, ...extra }
}

type Script = { reply: AgentAdapter["reply"]; stopBackground?: AgentAdapter["stopBackground"]; steer?: AgentAdapter["steer"] }

function harness(script: Script) {
  const store = new Store(":memory:")
  const posts: { event: string; contentState: Record<string, unknown> }[] = []
  const live = new LiveActivityNotifier(store, {
    gateway: "https://push.example",
    coalesceMs: 10,
    minStepIntervalMs: 10,
    endAfterAlertMs: 0,
    fetch: (async (_url, init) => {
      posts.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({ ok: true }))
    }) as typeof fetch,
  })
  const adapter: AgentAdapter = {
    spec: { id: "claude", label: "Claude Code", transport: "fake", experimental: false, capabilities: { ...FAKE_SPEC.capabilities, steer: script.steer !== undefined } },
    reply: script.reply,
    ...(script.steer ? { steer: script.steer } : {}),
    ...(script.stopBackground ? { stopBackground: script.stopBackground } : {}),
  }
  const events: Frame[] = []
  const service = new SessionService(store, adapter, (frame) => events.push(frame), { live })
  store.putDevice({ id: "phone", session_key: SESSION_KEY, name: "Phone", created_at: 1, push_token: "ticket-one-aaaaaaaaaaaa" })
  const upserts = () => events.filter((event) => event.name === "session.upsert").map(payload)
  return { store, service, events, upserts, posts }
}

async function start(h: ReturnType<typeof harness>) {
  const created = await h.service.invoke("session.create", { title: "后台", agent: "claude" }, "c1")
  const sessionId = (created.result as { session: { id: string } }).session.id
  await h.service.invoke(
    "liveActivity.register",
    { sessionId, activityId: "act-bg", pushToken: ACTIVITY, keepSeconds: 900, locale: "zh" },
    "r1",
    { deviceKey: SESSION_KEY },
  )
  return sessionId
}

describe("background tasks on the session", () => {
  test("counts and the list ride session.upsert; the last list outlives the turn until the next one starts", async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let turns = 0
    const h = harness({
      reply: async (_text, ctx) => {
        turns += 1
        if (turns > 1) return
        ctx.emit({ type: "text", id: "a1", text: "开了两个后台任务" })
        ctx.emit({ type: "background", open: 1, paused: false, tasks: [task("a1", "running")] })
        ctx.emit({ type: "background", open: 2, paused: false, tasks: [task("a1", "running"), task("b2", "running")] })
        ctx.emit({ type: "background", open: 2, paused: true, tasks: [task("a1", "running"), task("b2", "running")] })
        await held
        ctx.emit({ type: "background", open: 1, paused: true, tasks: [task("a1", "done"), task("b2", "running")] })
        ctx.emit({ type: "background", open: 0, paused: true, tasks: [task("a1", "done"), task("b2", "failed", { exitCode: 1 })] })
        ctx.emit({ type: "status", status: "running" })
        ctx.emit({ type: "text", id: "a2", text: "测试挂了 1 个" })
      },
    })
    const sessionId = await start(h)
    await h.service.invoke("message.send", { sessionId, text: "go" }, "s1")
    await waitFor(() => h.upserts().some((row) => row.backgroundOpen === 2 && row.status === "idle"))
    const paused = h.upserts().find((row) => row.backgroundOpen === 2 && row.status === "idle")!
    expect((paused.backgroundTasks as BackgroundTask[]).map((t) => t.id)).toEqual(["a1", "b2"])
    // Before the pause the count rides along while the session still runs, so old phones keep the composer busy.
    expect(h.upserts().some((row) => row.backgroundOpen === 1 && row.status === "running")).toBe(true)
    // B5: the card stays running and names the background tasks.
    await waitFor(() => h.posts.some((post) => post.event === "update" && post.contentState.backgroundOpen === 2))
    expect(h.posts.some((post) => post.event === "end")).toBe(false)
    release()
    await waitFor(() => h.events.some((event) => event.name === "agent.status" && payload(event).status === "idle" && h.posts.some((p) => p.event === "end")))
    const last = h.upserts().at(-1)!
    expect(last.backgroundOpen).toBeUndefined()
    expect((last.backgroundTasks as BackgroundTask[]).map((t) => [t.id, t.status, t.exitCode])).toEqual([
      ["a1", "done", undefined],
      ["b2", "failed", 1],
    ])
    const got = await h.service.invoke("session.get", { id: sessionId }, "g1")
    expect(((got.result as { session: Record<string, unknown> }).session.backgroundTasks as BackgroundTask[]).length).toBe(2)
    await h.service.invoke("message.send", { sessionId, text: "next" }, "s2")
    await waitFor(() => turns === 2)
    expect(h.upserts().at(-1)!.backgroundTasks).toBeUndefined()
  })

  test("a turn that closes with a task still marked running puts it down as cancelled", async () => {
    const h = harness({
      reply: async (_text, ctx) => {
        ctx.emit({ type: "background", open: 1, paused: false, tasks: [task("c1", "running")] })
      },
    })
    const sessionId = await start(h)
    await h.service.invoke("message.send", { sessionId, text: "go" }, "s1")
    await waitFor(() => (h.upserts().at(-1)?.backgroundTasks as BackgroundTask[] | undefined)?.[0]?.status === "cancelled")
  })

  test("background.stop asks the adapter, then falls back to stopping the turn", async () => {
    const stops: string[] = []
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let canStop = true
    const h = harness({
      reply: async (_text, ctx: AdapterContext) => {
        ctx.emit({ type: "background", open: 1, paused: true, tasks: [task("d1", "running")] })
        await Promise.race([held, new Promise((resolve) => ctx.signal.addEventListener("abort", resolve, { once: true }))])
      },
      stopBackground: async (sessionId) => {
        stops.push(sessionId)
        return canStop
      },
    })
    const sessionId = await start(h)
    await h.service.invoke("message.send", { sessionId, text: "go" }, "s1")
    await waitFor(() => h.upserts().some((row) => row.backgroundOpen === 1))
    const first = await h.service.invoke("background.stop", { sessionId }, "b1")
    expect(first.result).toEqual({ ok: true, stopped: 1 })
    expect(stops).toEqual([sessionId])
    canStop = false
    const second = await h.service.invoke("background.stop", { sessionId }, "b2")
    expect(second.result).toEqual({ ok: true, stopped: 1, stoppedTurn: true })
    release()
    const idle = await h.service.invoke("background.stop", { sessionId }, "b3")
    expect(idle.result).toEqual({ ok: true, stopped: 0 })
    const missing = await h.service.invoke("background.stop", { sessionId: "nope" }, "b4")
    expect(missing.type).toBe("error")
  })

  // Owner 2026-11-18: the agent had answered and was waiting for a reply; the reply sat in the queue for hours
  // because a background shell kept the turn open.
  describe("a send while only background work holds the turn", () => {
    function paused() {
      const steered: string[] = []
      let ctx!: AdapterContext
      let release!: () => void
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      let accept = true
      const h = harness({
        reply: async (_text, context) => {
          ctx = context
          ctx.emit({ type: "text", id: "a1", text: "跑起来了，你看要不要改参数" })
          ctx.emit({ type: "background", open: 1, paused: false, tasks: [task("b1", "running")] })
          await working
          ctx.emit({ type: "background", open: 1, paused: true, tasks: [task("b1", "running")] })
          await held
        },
        steer: async (_sessionId, text) => {
          if (!accept) return false
          steered.push(text)
          return true
        },
      })
      let pause!: () => void
      const working = new Promise<void>((resolve) => {
        pause = resolve
      })
      const queue = () => (h.events.filter((event) => event.name === "queue.upsert").at(-1)?.payload as { items: { text: string }[] } | undefined)?.items.map((item) => item.text) ?? []
      const statuses = () => h.events.filter((event) => event.name === "agent.status").map((event) => payload(event).status)
      return { h, steered, queue, statuses, pause, release, emit: (event: Parameters<AdapterContext["emit"]>[0]) => ctx.emit(event), refuse: () => { accept = false } }
    }

    test("reaches the agent at once, and the session idles again after the answer", async () => {
      const t = paused()
      const sessionId = await start(t.h)
      await t.h.service.invoke("message.send", { sessionId, text: "go" }, "s1")
      t.pause()
      await waitFor(() => t.statuses().at(-1) === "idle")
      await t.h.service.invoke("message.send", { sessionId, text: "参数不用改" }, "s2")
      await waitFor(() => t.steered.length === 1)
      expect(t.steered).toEqual(["参数不用改"])
      await waitFor(() => t.queue().length === 0 && t.h.store.listMessages(sessionId).some((row) => row.role === "user" && row.text === "参数不用改"))
      // Drawn as an ordinary message, not as a tapped 插话; the mark survives the row being read.
      const sent = () => t.h.events.filter((event) => event.name === "message.append").map(payload).findLast((row) => row.text === "参数不用改")?.steer
      expect(sent()).toEqual({ state: "sent", waiting: true })
      // The adapter reports the run its line started, the answer, then the pause its result brings.
      t.emit({ type: "status", status: "running" })
      t.emit({ type: "text", id: "a2", text: "好，那就等它跑完" })
      await waitFor(() => (sent() as { state?: string } | undefined)?.state === "read")
      expect(sent()).toMatchObject({ state: "read", waiting: true })
      expect(t.statuses().at(-1)).toBe("running")
      t.emit({ type: "background", open: 1, paused: true, tasks: [task("b1", "running")] })
      expect(t.statuses().at(-1)).toBe("idle")
      expect(t.h.upserts().at(-1)!.backgroundOpen).toBe(1)
      t.release()
    })

    test("stays queued when the agent does not take it", async () => {
      const t = paused()
      t.refuse()
      const sessionId = await start(t.h)
      await t.h.service.invoke("message.send", { sessionId, text: "go" }, "s1")
      t.pause()
      await waitFor(() => t.statuses().at(-1) === "idle")
      await t.h.service.invoke("message.send", { sessionId, text: "参数不用改" }, "s2")
      await Bun.sleep(30)
      expect(t.queue()).toEqual(["参数不用改"])
      t.release()
    })

    test("a send while the agent is still working queues as before", async () => {
      const t = paused()
      const sessionId = await start(t.h)
      await t.h.service.invoke("message.send", { sessionId, text: "go" }, "s1")
      await waitFor(() => t.h.upserts().some((row) => row.backgroundOpen === 1))
      await t.h.service.invoke("message.send", { sessionId, text: "等等" }, "s2")
      await Bun.sleep(30)
      expect(t.steered).toEqual([])
      expect(t.queue()).toEqual(["等等"])
      // Paused now, with that message ahead: a second send keeps its place behind it.
      t.pause()
      await waitFor(() => t.statuses().at(-1) === "idle")
      await t.h.service.invoke("message.send", { sessionId, text: "第二条" }, "s3")
      await Bun.sleep(30)
      expect(t.steered).toEqual([])
      expect(t.queue()).toEqual(["等等", "第二条"])
      t.release()
    })
  })
})
