import { existsSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import type { AgentAdapter, PermissionRequest } from "./adapter/types"
import { FAKE_SPEC } from "./adapter/fake"
import { LiveActivityNotifier, SWIFT_REFERENCE_UNIX } from "./live-activity"
import { LIVE_ALERT_KEYS, LIVE_ALERT_TEXT } from "./live-alerts"
import { copyError, phoneCopy } from "./phone-copy"
import { type LiveField, openBytes, openLive, sealBytes, type PushPayload } from "./push"
import { SessionService } from "./session-service"
import { Store } from "./store"
import type { Frame } from "./protocol"

const SESSION_KEY = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
const TICKET = "ticket-one-aaaaaaaaaaaa"
const ACTIVITY = "ab".repeat(32)
const RUN_OPTIONS: PermissionRequest["options"] = [{ id: "yes", label: "Yes", kind: "allow_once" }]

function scripted(id: string, reply: AgentAdapter["reply"]): AgentAdapter {
  return { spec: { id, label: id, transport: "fake", experimental: false, capabilities: FAKE_SPEC.capabilities }, reply }
}

type Posted = {
  priority: number
  event: string
  contentState: Record<string, unknown>
  alert?: { title?: string; body?: string; titleKey?: string; bodyKey?: string }
  dismissalDate?: number
  relevanceScore?: number
}

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

function harness() {
  const store = new Store(":memory:")
  const posts: Posted[] = []
  const pushes: string[] = []
  const live = new LiveActivityNotifier(store, {
    gateway: "https://push.example",
    coalesceMs: 30,
    minStepIntervalMs: 40,
    endAfterAlertMs: 0,
    fetch: (async (_url, init) => {
      posts.push(JSON.parse(String(init?.body)) as Posted)
      return new Response(JSON.stringify({ ok: true }))
    }) as typeof fetch,
  })
  const events: Frame[] = []
  const service = new SessionService(store, scripted("claude", async () => {}), (frame) => events.push(frame), {
    push: (item) => pushes.push(item.kind),
    live,
  })
  store.putDevice({ id: "phone", session_key: SESSION_KEY, name: "Phone", created_at: 1, push_token: TICKET })
  return { store, posts, pushes, live, events, service }
}

const open = (sealed: unknown, field: LiveField, sessionId: string, requestId = "") =>
  openLive(SESSION_KEY, String(sealed), { field, sessionId, requestId })

describe("live activity", () => {
  test("sealBytes round-trips raw utf-8", () => {
    const sealed = sealBytes(SESSION_KEY, Buffer.from("refresh.ts", "utf8"))
    expect(openBytes(SESSION_KEY, sealed).toString("utf8")).toBe("refresh.ts")
  })

  // Third review: the per-session card showed rudderd's Chinese failure text in every language; the per-computer card
  // already carried the copy.
  test.each([
    ["a failure rudderd words carries its copy sealed", true],
    ["an oversized copy is left out", false],
  ] as const)("%s", async (_name, fits) => {
    const h = harness()
    const copy = fits ? phoneCopy.claudeSignedOut() : { code: "agent_failed", args: { detail: "x".repeat(800) }, text: "失败" }
    const service = new SessionService(h.store, scripted("claude", async () => {
      throw copyError(copy)
    }), () => {}, { push: (item) => h.pushes.push(item.kind), live: h.live })
    const created = await service.invoke("session.create", { title: "修复", agent: "claude" }, "c1")
    const sessionId = (created.result as { session: { id: string } }).session.id
    await service.invoke(
      "liveActivity.register",
      { sessionId, activityId: "act-1", pushToken: ACTIVITY, keepSeconds: 900, locale: "en" },
      "r1",
      { deviceKey: SESSION_KEY },
    )
    await service.invoke("message.send", { sessionId, text: "go" }, "s1")
    await waitFor(() => h.posts.some((post) => post.event === "end"))
    const failed = h.posts.filter((post) => post.contentState.phase === "failed")
    expect(failed.map((post) => post.event)).toEqual(["update", "end"])
    for (const post of failed) {
      if (fits) expect(JSON.parse(open(post.contentState.resultCopySealed, "resultCopy", sessionId))).toEqual(copy)
      else expect(post.contentState.resultCopySealed).toBeUndefined()
      expect(post.contentState.resultSealed).toBeDefined()
    }
  })

  test("a turn runs, waits without a second notification, resumes, and ends done", async () => {
    const h = harness()
    const adapter = scripted("claude", async (_text, ctx) => {
      ctx.emit({ type: "tool", id: "t1", tool: "Edit", title: "refresh.ts", kind: "edit", status: "running", detail: "" })
      ctx.emit({ type: "tool", id: "t1", tool: "Edit", title: "refresh.ts", kind: "edit", status: "completed", detail: "" })
      ctx.emit({ type: "tool", id: "t2", tool: "Edit", title: "other.ts", kind: "edit", status: "running", detail: "" })
      ctx.emit({ type: "tool", id: "t2", tool: "Edit", title: "other.ts", kind: "edit", status: "completed", detail: "" })
      await Bun.sleep(80)
      await ctx.askPermission({ tool: "Bash", title: "Run", detail: "bun test", kind: "execute", options: RUN_OPTIONS })
      ctx.emit({ type: "text", id: "a1", text: "测试全部通过。后面还有。" })
      ctx.emit({ type: "usage", usage: { inputTokens: 1000, outputTokens: 50 } })
    })
    const events: Frame[] = []
    const service = new SessionService(h.store, adapter, (frame) => events.push(frame), {
      push: (item) => h.pushes.push(item.kind),
      live: h.live,
    })
    const created = await service.invoke("session.create", { title: "修复", agent: "claude" }, "c1")
    const sessionId = (created.result as { session: { id: string } }).session.id
    const registered = await service.invoke(
      "liveActivity.register",
      { sessionId, activityId: "act-1", pushToken: ACTIVITY, keepSeconds: 900, locale: "zh" },
      "r1",
      { deviceKey: SESSION_KEY },
    )
    expect(registered.type).toBe("result")
    const sent = await service.invoke("message.send", { sessionId, text: "go" }, "s1")
    expect(sent.type).toBe("result")
    await waitFor(() => events.some((event) => event.name === "permission.asked"))
    const asked = events.find((event) => event.name === "permission.asked")!
    await service.invoke("permission.respond", { id: payload(asked).id, optionId: "yes" }, "p1")
    await waitFor(() => events.some((event) => event.name === "agent.status" && payload(event).status === "idle"))
    await waitFor(() => h.posts.some((post) => post.event === "end"))

    expect(h.posts.every((post) => typeof post.contentState.updatedAt === "number")).toBe(true)
    expect(h.posts.every((post) => typeof post.relevanceScore === "number")).toBe(true)
    expect(open(h.posts[0]!.contentState.titleSealed, "title", sessionId)).toBe("修复")

    const steps = h.posts.filter((post) => post.event === "update" && post.contentState.phase === "running" && post.priority === 5)
    expect(steps).toHaveLength(1)
    expect(steps[0]!.contentState.toolCount).toBe(2)
    expect(steps[0]!.contentState.stepKind).toBe("edit")
    expect(open(steps[0]!.contentState.stepSealed, "step", sessionId)).toBe("other.ts")
    // The island replaces the permission banner. The turn-end reply notice still goes out.
    expect(h.pushes).toEqual(["done"])

    const waiting = h.posts.find((post) => post.contentState.phase === "waiting")!
    expect(waiting.priority).toBe(10)
    // r59 F-10: a fixed text, and the tool name only sealed.
    expect(waiting.alert).toEqual({ titleKey: "需批准", bodyKey: "有一项操作等你批准" })
    expect((waiting.contentState.approval as { toolName: string }).toolName).toBe("")
    expect(JSON.stringify(waiting)).not.toContain("Bash")
    expect(open((waiting.contentState.approval as { toolSealed: string }).toolSealed, "approval.tool", sessionId, String(payload(asked).id))).toBe("Bash")
    expect(waiting.contentState.stepKind).toBe("bash")
    expect(open((waiting.contentState.approval as { summarySealed: string }).summarySealed, "approval.summary", sessionId, String(payload(asked).id))).toBe("bun test")

    const resumed = h.posts.filter((post) => post.event === "update" && post.contentState.phase === "running" && post.priority === 10)
    expect(resumed).toHaveLength(1)
    expect(resumed[0]!.contentState.approval).toBeUndefined()

    const doneUpdate = h.posts.find((post) => post.event === "update" && post.contentState.phase === "done")!
    expect(doneUpdate.priority).toBe(10)
    expect(doneUpdate.relevanceScore).toBe(20)
    expect(doneUpdate.alert).toEqual({ titleKey: "完成", bodyKey: "这一轮结束了" })
    expect(open(doneUpdate.contentState.resultSealed, "result", sessionId)).toBe("测试全部通过")

    const ended = h.posts.find((post) => post.event === "end")!
    expect(ended.contentState.phase).toBe("done")
    expect(ended.alert).toBeUndefined()
    expect(ended.contentState.dismissAt).toBe(ended.dismissalDate! - SWIFT_REFERENCE_UNIX)
    expect(open(ended.contentState.resultSealed, "result", sessionId)).toBe("测试全部通过")
    expect(ended.contentState.tokens).toBe(1050)
    const endedAt = ended.contentState.endedAt as number
    expect(Math.abs(endedAt + SWIFT_REFERENCE_UNIX - Date.now() / 1000)).toBeLessThan(5)
    expect(ended.dismissalDate! - Math.floor(Date.now() / 1000)).toBeGreaterThan(800)
    expect(h.store.liveActivity(sessionId)).toBeNull()
  })

  // 11-19 on device: a sub-agent's task description stood where a tool name goes (「正在使用 Implement D10: …」).
  test("a sub-agent step goes as stepTool agent with its description cut short", async () => {
    const h = harness()
    let release = () => {}
    const adapter = scripted("claude", async (_text, ctx) => {
      ctx.emit({ type: "tool", id: "t1", tool: "Task", title: "Implement D10: command ranking for the palette", kind: "other", status: "running", detail: "{}" })
      await new Promise<void>((resolve) => {
        release = resolve
      })
    })
    const service = new SessionService(h.store, adapter, () => {}, { push: () => {}, live: h.live })
    const created = await service.invoke("session.create", { title: "修复", agent: "claude" }, "c1")
    const sessionId = (created.result as { session: { id: string } }).session.id
    await service.invoke("liveActivity.register", { sessionId, activityId: "act-1", pushToken: ACTIVITY, keepSeconds: 900, locale: "zh" }, "r1", { deviceKey: SESSION_KEY })
    await service.invoke("message.send", { sessionId, text: "go" }, "s1")
    await waitFor(() => h.posts.some((post) => post.contentState.stepTool === "agent"))
    const state = h.posts.find((post) => post.contentState.stepTool === "agent")!.contentState
    expect(state.stepKind).toBe("other")
    expect(open(state.stepSealed, "step", sessionId)).toBe("Implement D10")
    release()
  })

  test("a speech pause idles the phone without ending the island", async () => {
    const h = harness()
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const adapter = scripted("claude", async (_text, ctx) => {
      ctx.emit({ type: "text", id: "a1", text: "已经在后台开始" })
      const task = { id: "t1", kind: "command" as const, title: "sleep 20", startedAt: Date.now(), status: "running" as const }
      ctx.emit({ type: "background", open: 1, paused: false, tasks: [task] })
      ctx.emit({ type: "background", open: 1, paused: true, tasks: [task] })
      await held
      ctx.emit({ type: "status", status: "running" })
      ctx.emit({ type: "text", id: "a2", text: "输出是 BG_DONE" })
    })
    const events: Frame[] = []
    const service = new SessionService(h.store, adapter, (frame) => events.push(frame), {
      push: (item) => h.pushes.push(item.kind),
      live: h.live,
    })
    const created = await service.invoke("session.create", { title: "后台", agent: "claude" }, "c1")
    const sessionId = (created.result as { session: { id: string } }).session.id
    await service.invoke(
      "liveActivity.register",
      { sessionId, activityId: "act-bg", pushToken: ACTIVITY, keepSeconds: 900, locale: "zh" },
      "r1",
      { deviceKey: SESSION_KEY },
    )
    const sent = await service.invoke("message.send", { sessionId, text: "go" }, "s1")
    expect(sent.type).toBe("result")
    try {
      await waitFor(() => events.some((event) => event.name === "agent.status" && payload(event).status === "idle"))
      expect(events.some((event) => event.name === "session.upsert" && payload(event).backgroundOpen === 1 && payload(event).status === "idle")).toBe(true)
      expect(h.pushes).not.toContain("done")
      expect(h.posts.some((post) => post.event === "end")).toBe(false)
      const phases = events
        .filter((event) => event.name === "turn.state")
        .map((event) => (payload(event).turn as { phase?: string }).phase)
      expect(phases.at(-1)).toBe("running")
    } finally {
      release()
    }
    await waitFor(() => h.pushes.includes("done"))
    await waitFor(() => h.posts.some((post) => post.event === "end"))
    const phases = events
      .filter((event) => event.name === "turn.state")
      .map((event) => (payload(event).turn as { phase?: string }).phase)
    expect(phases.at(-1)).toBe("done")
    const texts = events.filter((event) => event.name === "message.append").map((event) => payload(event).text)
    expect(texts).toContain("已经在后台开始")
    expect(texts).toContain("输出是 BG_DONE")
    expect(payload(events.filter((event) => event.name === "session.upsert").at(-1)!).backgroundOpen).toBeUndefined()
  })

  test("a question puts the island in waiting without an alert, and answering resumes running", async () => {
    const h = harness()
    const adapter = scripted("claude", async (_text, ctx) => {
      await ctx.askQuestion({
        questions: [
          { question: "会话缓存放在哪里？", options: [{ label: "SQLite" }], multiSelect: false, allowsOther: true },
          { question: "这次要补哪些测试？", options: [{ label: "单元测试" }], multiSelect: true, allowsOther: true },
        ],
      })
    })
    const pushed: PushPayload[] = []
    const events: Frame[] = []
    const service = new SessionService(h.store, adapter, (frame) => events.push(frame), { live: h.live, push: (item) => pushed.push(item) })
    const created = await service.invoke("session.create", { title: "问", agent: "claude" }, "c1")
    const sessionId = (created.result as { session: { id: string } }).session.id
    await service.invoke(
      "liveActivity.register",
      { sessionId, activityId: "act-2", pushToken: ACTIVITY, keepSeconds: 300, locale: "en" },
      "r1",
      { deviceKey: SESSION_KEY },
    )
    void service.invoke("message.send", { sessionId, text: "go" }, "s1")
    await waitFor(() => h.posts.some((post) => post.contentState.phase === "waiting"))
    const waiting = h.posts.find((post) => post.contentState.phase === "waiting")!
    expect(waiting.priority).toBe(10)
    expect(waiting.alert).toBeUndefined()
    expect(waiting.contentState.approval).toBeUndefined()
    const question = waiting.contentState.question as { requestId: string; count: number; titleSealed: string }
    const asked = events.find((event) => event.name === "question.asked")!
    expect(question.requestId).toBe(String(payload(asked).id))
    expect(question.count).toBe(2)
    expect(open(question.titleSealed, "question.title", sessionId, question.requestId)).toBe("会话缓存放在哪里？")
    // The notification still goes out: it is the only way to answer from the lock screen.
    expect(pushed.map((item) => item.kind)).toEqual(["question"])

    await service.invoke("question.respond", { id: question.requestId, answers: { "会话缓存放在哪里？": "SQLite" } }, "q1")
    await waitFor(() => h.posts.some((post) => post.contentState.phase === "running" && h.posts.indexOf(post) > h.posts.indexOf(waiting)))
    const resumed = h.posts.slice(h.posts.indexOf(waiting) + 1).find((post) => post.contentState.phase === "running")!
    expect(resumed.contentState.question).toBeUndefined()
    await waitFor(() => events.some((event) => event.name === "agent.status" && payload(event).status === "idle"))
  })

  test("an approval and a question wait together; answering the approval leaves the question", async () => {
    const h = harness()
    const adapter = scripted("claude", async (_text, ctx) => {
      const answer = ctx.askQuestion({ questions: [{ question: "Continue?", options: [{ label: "Yes" }], multiSelect: false, allowsOther: true }] })
      const choice = ctx.askPermission({ tool: "Bash", title: "Run", detail: "bun test", kind: "execute", options: RUN_OPTIONS })
      await Promise.all([answer, choice])
    })
    const events: Frame[] = []
    const service = new SessionService(h.store, adapter, (frame) => events.push(frame), { live: h.live })
    const created = await service.invoke("session.create", { title: "两件", agent: "claude" }, "c1")
    const sessionId = (created.result as { session: { id: string } }).session.id
    await service.invoke(
      "liveActivity.register",
      { sessionId, activityId: "act-3", pushToken: ACTIVITY, keepSeconds: 300, locale: "zh" },
      "r1",
      { deviceKey: SESSION_KEY },
    )
    void service.invoke("message.send", { sessionId, text: "go" }, "s1")
    await waitFor(() => h.posts.some((post) => post.contentState.approval && post.contentState.question))
    const both = h.posts.find((post) => post.contentState.approval && post.contentState.question)!
    expect(both.alert).toEqual({ titleKey: LIVE_ALERT_KEYS.waiting.title, bodyKey: LIVE_ALERT_KEYS.waiting.body })
    const permission = events.find((event) => event.name === "permission.asked")!
    await service.invoke("permission.respond", { id: payload(permission).id, optionId: "yes" }, "p1")
    await waitFor(() => h.posts.indexOf(both) < h.posts.length - 1)
    const left = h.posts.at(-1)!
    expect(left.contentState.phase).toBe("waiting")
    expect(left.contentState.approval).toBeUndefined()
    expect((left.contentState.question as { count: number }).count).toBe(1)
    const asked = events.find((event) => event.name === "question.asked")!
    await service.invoke("question.respond", { id: payload(asked).id, answer: "Yes" }, "q1")
    await waitFor(() => events.some((event) => event.name === "agent.status" && payload(event).status === "idle"))
  })

  test("armQuestion without a stored activity posts nothing", () => {
    const h = harness()
    h.live.armQuestion("no-such-session", { id: "q", questions: [{ question: "Continue?" }] })
    h.live.status("no-such-session", "waiting")
    expect(h.posts).toEqual([])
  })

  test("a bad activity token is rejected", async () => {
    const h = harness()
    const service = new SessionService(h.store, scripted("claude", async () => {}), () => {}, { live: h.live })
    const created = await service.invoke("session.create", { agent: "claude" }, "c1")
    const sessionId = (created.result as { session: { id: string } }).session.id
    const rejected = await service.invoke(
      "liveActivity.register",
      { sessionId, activityId: "act", pushToken: "zz", keepSeconds: 900, locale: "zh" },
      "r1",
      { deviceKey: SESSION_KEY },
    )
    expect(rejected.type).toBe("error")
    expect(rejected.error?.code).toBe("invalid")
  })

  test("a gateway that predates keyed alerts gets the paired language's text", async () => {
    const posts: Posted[] = []
    const store = new Store(":memory:")
    const live = new LiveActivityNotifier(store, {
      gateway: "https://push.example",
      coalesceMs: 5,
      minStepIntervalMs: 10,
      endAfterAlertMs: 0,
      fetch: (async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as Posted
        posts.push(body)
        return body.alert?.titleKey !== undefined
          ? new Response(JSON.stringify({ error: "bad_request", message: "alert must be one of the fixed Live Activity texts" }), { status: 400 })
          : new Response(JSON.stringify({ ok: true }))
      }) as typeof fetch,
    })
    store.putDevice({ id: "phone", session_key: SESSION_KEY, name: "Phone", created_at: 1, push_token: TICKET })
    const service = new SessionService(store, scripted("claude", async () => {}), () => {}, { live })
    const created = await service.invoke("session.create", { title: "fix", agent: "claude" }, "c1")
    const sessionId = (created.result as { session: { id: string } }).session.id
    await service.invoke(
      "liveActivity.register",
      { sessionId, activityId: "act-en", pushToken: ACTIVITY, keepSeconds: 900, locale: "en" },
      "r1",
      { deviceKey: SESSION_KEY },
    )
    live.status(sessionId, "idle", { phase: "done", result: "ok" })
    await waitFor(() => posts.some((post) => post.event === "end"))
    const alerted = posts.filter((post) => post.alert)
    expect(alerted.map((post) => post.alert)).toEqual([
      { titleKey: "完成", bodyKey: "这一轮结束了" },
      { title: "Done", body: "This turn finished" },
    ])
  })

  test("a running turn heartbeats, and done alerts before an end without one", async () => {
    const posts: Posted[] = []
    const store = new Store(":memory:")
    const live = new LiveActivityNotifier(store, {
      gateway: "https://push.example",
      coalesceMs: 5,
      minStepIntervalMs: 10,
      heartbeatMs: 40,
      endAfterAlertMs: 0,
      fetch: (async (_url, init) => {
        posts.push(JSON.parse(String(init?.body)) as Posted)
        return new Response(JSON.stringify({ ok: true }))
      }) as typeof fetch,
    })
    store.putDevice({ id: "phone", session_key: SESSION_KEY, name: "Phone", created_at: 1, push_token: TICKET })
    const service = new SessionService(store, scripted("claude", async () => {}), () => {}, { live })
    const created = await service.invoke("session.create", { title: "修复标题", agent: "claude" }, "c1")
    const sessionId = (created.result as { session: { id: string } }).session.id
    await service.invoke(
      "liveActivity.register",
      { sessionId, activityId: "act-beat", pushToken: ACTIVITY, keepSeconds: 900, locale: "zh" },
      "r1",
      { deviceKey: SESSION_KEY },
    )
    live.tool(sessionId, { id: "t1", title: "refresh.ts", kind: "edit", status: "completed" })
    await waitFor(() => posts.filter((post) => post.priority === 5 && post.contentState.phase === "running").length >= 2)
    const beats = posts.filter((post) => post.priority === 5 && post.contentState.phase === "running")
    expect(beats[1]!.relevanceScore).toBe(50)
    expect(beats[1]!.alert).toBeUndefined()
    expect(open(beats[0]!.contentState.titleSealed, "title", sessionId)).toBe("修复标题")
    const firstAt = beats[0]!.contentState.updatedAt as number
    const secondAt = beats[1]!.contentState.updatedAt as number
    expect(secondAt).toBeGreaterThanOrEqual(firstAt)

    live.status(sessionId, "idle", { phase: "done", result: "好了。" })
    await waitFor(() => posts.some((post) => post.event === "end"))
    const done = posts.filter((post) => post.contentState.phase === "done")
    expect(done.map((post) => post.event)).toEqual(["update", "end"])
    expect(done[0]!.alert).toEqual({ titleKey: "完成", bodyKey: "这一轮结束了" })
    expect(done[1]!.alert).toBeUndefined()
    expect(done[1]!.contentState.dismissAt).toBe(done[1]!.dismissalDate! - SWIFT_REFERENCE_UNIX)
    const count = posts.length
    await Bun.sleep(80)
    expect(posts).toHaveLength(count)
  })

  test("the beat starts at register, before any step has been pushed", async () => {
    const posts: Posted[] = []
    const store = new Store(":memory:")
    const live = new LiveActivityNotifier(store, {
      gateway: "https://push.example",
      heartbeatMs: 30,
      endAfterAlertMs: 0,
      fetch: (async (_url, init) => {
        posts.push(JSON.parse(String(init?.body)) as Posted)
        return new Response(JSON.stringify({ ok: true }))
      }) as typeof fetch,
    })
    store.putDevice({ id: "phone", session_key: SESSION_KEY, name: "Phone", created_at: 1, push_token: TICKET })
    const service = new SessionService(store, scripted("claude", async () => {}), () => {}, { live })
    const created = await service.invoke("session.create", { title: "长命令", agent: "claude" }, "c1")
    const sessionId = (created.result as { session: { id: string } }).session.id
    await service.invoke(
      "liveActivity.register",
      { sessionId, activityId: "act-long", pushToken: ACTIVITY, keepSeconds: 900, locale: "zh" },
      "r1",
      { deviceKey: SESSION_KEY },
    )
    expect(posts).toHaveLength(0)
    await waitFor(() => posts.length >= 2)
    expect(posts.every((post) => post.event === "update" && post.priority === 5)).toBe(true)
    expect(posts[0]!.contentState.phase).toBe("running")
    await live.end("act-long")
  })

  test("an interrupt ends once and does not alert", async () => {
    const h = harness()
    const created = await h.service.invoke("session.create", { title: "停", agent: "claude" }, "c1")
    const sessionId = (created.result as { session: { id: string } }).session.id
    await h.service.invoke(
      "liveActivity.register",
      { sessionId, activityId: "act-stop", pushToken: ACTIVITY, keepSeconds: 300, locale: "en" },
      "r1",
      { deviceKey: SESSION_KEY },
    )
    await h.live.end("act-stop")
    expect(h.posts).toHaveLength(1)
    expect(h.posts[0]!.event).toBe("end")
    expect(h.posts[0]!.contentState.phase).toBe("interrupted")
    expect(h.posts[0]!.alert).toBeUndefined()
    expect(h.posts[0]!.relevanceScore).toBe(20)
    expect(h.posts[0]!.contentState.dismissAt).toBe(h.posts[0]!.dismissalDate! - SWIFT_REFERENCE_UNIX)
  })

  test("deleting a session ends its card, drops the row and the timers", async () => {
    const h = harness()
    const created = await h.service.invoke("session.create", { title: "删", agent: "claude" }, "c1")
    const sessionId = (created.result as { session: { id: string } }).session.id
    await h.service.invoke(
      "liveActivity.register",
      { sessionId, activityId: "act-del", pushToken: ACTIVITY, keepSeconds: 300, locale: "zh" },
      "r1",
      { deviceKey: SESSION_KEY },
    )
    const volatile = (h.live as unknown as { volatile: Map<string, unknown> }).volatile
    expect(volatile.has(sessionId)).toBe(true)
    const deleted = await h.service.invoke("session.delete", { id: sessionId }, "d1")
    expect(deleted.type).toBe("result")
    expect(h.store.liveActivity(sessionId)).toBeNull()
    expect(volatile.has(sessionId)).toBe(false)
    await waitFor(() => h.posts.length === 1)
    expect(h.posts[0]!.event).toBe("end")
    expect(h.posts[0]!.contentState.titleSealed).toBeDefined()
  })

  test("store.deleteSession removes the live activity row with the session", async () => {
    const h = harness()
    const created = await h.service.invoke("session.create", { agent: "claude" }, "c1")
    const sessionId = (created.result as { session: { id: string } }).session.id
    h.store.putLiveActivity({
      session_id: sessionId,
      activity_id: "a",
      push_token: ACTIVITY,
      device_key: SESSION_KEY,
      keep_seconds: 300,
      locale: "zh",
      started_at: 1,
    })
    expect(h.store.deleteSession(sessionId)).toBe(true)
    expect(h.store.liveActivity(sessionId)).toBeNull()
  })
})

test("the push gateway allowlist fixture accepts exactly the alert texts rudderd sends (r59 F-10)", async () => {
  const listed = (await Bun.file(new URL("./fixtures/live-activity-alerts.json", import.meta.url)).json()) as { title: string; body: string }[]
  const ours = Object.values(LIVE_ALERT_TEXT).flatMap((byKind) => Object.values(byKind))
  expect(listed).toEqual(ours)
})

const MONOREPO_GATEWAY = join(import.meta.dir, "../../push-gateway/src/index.ts")
test.skipIf(!existsSync(MONOREPO_GATEWAY))("the allowlist fixture stays in parity with push-gateway LIVE_ACTIVITY_ALERTS", async () => {
  const gateway = await Bun.file(MONOREPO_GATEWAY).text()
  const start = gateway.indexOf("= [", gateway.indexOf("const LIVE_ACTIVITY_ALERTS"))
  const listed = gateway.slice(start, gateway.indexOf("]", start))
  const fixture = (await Bun.file(new URL("./fixtures/live-activity-alerts.json", import.meta.url)).json()) as { title: string; body: string }[]
  for (const alert of fixture) expect(listed).toContain(`{ title: "${alert.title}", body: "${alert.body}" }`)
  expect(listed.match(/\{ title:/g)?.length).toBe(fixture.length)
})

describe("live activity gateway timeout", () => {
  test("a gateway that never answers times out and is logged instead of hanging", async () => {
    const store = new Store(":memory:")
    const logs: string[] = []
    let calls = 0
    const live = new LiveActivityNotifier(store, {
      gateway: "https://push.example",
      coalesceMs: 5,
      minStepIntervalMs: 10,
      endAfterAlertMs: 0,
      requestTimeoutMs: 40,
      log: (line) => logs.push(line),
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        calls++
        const signal = init?.signal
        return new Promise<Response>((_resolve, reject) => {
          if (!signal) return
          signal.addEventListener("abort", () => reject(signal.reason))
        })
      }) as typeof fetch,
    })
    store.putDevice({ id: "phone", session_key: SESSION_KEY, name: "Phone", created_at: 1, push_token: TICKET })
    const service = new SessionService(store, scripted("claude", async () => {}), () => {}, { live })
    const created = await service.invoke("session.create", { title: "t", agent: "claude" }, "c1")
    const sessionId = (created.result as { session: { id: string } }).session.id
    await service.invoke(
      "liveActivity.register",
      { sessionId, activityId: "act-hang", pushToken: ACTIVITY, keepSeconds: 900, locale: "zh" },
      "r1",
      { deviceKey: SESSION_KEY },
    )
    live.tool(sessionId, { id: "t1", title: "refresh.ts", kind: "edit", status: "completed" })
    await waitFor(() => logs.some((line) => line.includes("gateway unreachable")))
    expect(calls).toBeGreaterThanOrEqual(2)
    live.forget(sessionId)
  })
})

describe("keyed alerts", () => {
  test("every fixed alert is a key the app's catalog translates into each of its languages", async () => {
    const catalog = (await Bun.file(new URL("./fixtures/app-catalog-alerts.json", import.meta.url)).json()) as {
      strings: Record<string, Record<string, string>>
    }
    const languages = new Set(Object.values(catalog.strings).flatMap((entry) => Object.keys(entry)))
    languages.delete("zh-Hans")
    for (const { title, body } of Object.values(LIVE_ALERT_KEYS)) {
      for (const key of [title, body]) {
        const translated = catalog.strings[key] ?? {}
        for (const language of languages) expect([key, language, translated[language]]).toEqual([key, language, expect.any(String)])
      }
    }
  })

  const MONOREPO_STRINGS = join(import.meta.dir, "../../ios/App/Localizable.xcstrings")
  test.skipIf(!existsSync(MONOREPO_STRINGS))("the catalog fixture stays in parity with the app string catalog", async () => {
    const fixture = (await Bun.file(new URL("./fixtures/app-catalog-alerts.json", import.meta.url)).json()) as {
      strings: Record<string, Record<string, string>>
    }
    const catalog = (await Bun.file(MONOREPO_STRINGS).json()) as {
      strings: Record<string, { localizations?: Record<string, { stringUnit?: { value?: string } }> }>
    }
    for (const [key, locales] of Object.entries(fixture.strings)) {
      for (const [language, value] of Object.entries(locales)) {
        const listed = catalog.strings[key]?.localizations?.[language]?.stringUnit?.value
        expect(listed ?? (language === "zh-Hans" ? key : undefined)).toBe(value)
      }
    }
  })
})
