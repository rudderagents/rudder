import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFakeAdapter, FAKE_SPEC } from "./adapter/fake"
import { CLAUDE_MODES } from "./adapter/modes"
import { APP_VERSION } from "./config"
import type { AgentAdapter, PermissionOption } from "./adapter/types"
import type { Frame } from "./protocol"
import { pickPermissionOption, SessionService } from "./session-service"
import { Store } from "./store"

async function waitFor(predicate: () => boolean, timeoutMs = 2000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out")
    await Bun.sleep(10)
  }
}

function payload(frame: Frame): Record<string, unknown> {
  return (frame.payload ?? {}) as Record<string, unknown>
}

describe("Store upsert", () => {
  test("same message id patches text", () => {
    const store = new Store(":memory:")
    const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    store.insertMessage({
      id,
      session_id: "s",
      kind: "text",
      role: "assistant",
      text: "Fake",
      created_at: 1,
    })
    store.insertMessage({
      id,
      session_id: "s",
      kind: "text",
      role: "assistant",
      text: "Fake Claude heard",
      created_at: 2,
    })
    const rows = store.listMessages("s")
    expect(rows).toHaveLength(1)
    expect(rows[0]?.text).toBe("Fake Claude heard")
  })
})

describe("SessionService", () => {
  test("native diagnostics is scoped to the session and keeps explicit policy provenance", async () => {
    const store = new Store(":memory:")
    store.seedIfEmpty()
    const adapter = createFakeAdapter()
    let called: unknown[] = []
    adapter.diagnostics = async (cwd, nativeId) => {
      called = [cwd, nativeId]
      return { agent: adapter.spec.id, cwd, configRoot: "/fixture/config", permissionSource: "native", mcp: { state: "configured", servers: [] }, hooks: { state: "unsupported", enabled: 0, events: [], errors: 0 } }
    }
    const service = new SessionService(store, adapter, () => {})
    const session = store.listSessions()[0]!
    store.patchSession(session.id, { nativeId: "fixture-native", permissionMode: "ask", cwd: "/fixture/project" })
    const result = (await service.invoke("agent.diagnostics", { sessionId: session.id }, "fixture-client")).result as { diagnostics: { permissionSource: string; nativeId: string } }
    expect(called).toEqual(["/fixture/project", "fixture-native"])
    expect(result.diagnostics.permissionSource).toBe("override")
    expect(result.diagnostics.nativeId).toBe("fixture-native")
    await service.shutdown(10)
    store.db.close()
  })
  test("opening a chat warms its agent, and a background refresh does not", async () => {
    const store = new Store(":memory:")
    store.seedIfEmpty()
    const adapter = createFakeAdapter()
    const warmed: { sessionId: string; permissionMode: string; nativeId?: string }[] = []
    adapter.warm = (ctx) => void warmed.push(ctx)
    const service = new SessionService(store, adapter, () => {}, { warmDelayMs: 20 })
    const sessionId = store.listSessions()[0]!.id
    await service.invoke("session.get", { id: sessionId, markRead: false }, "refresh")
    await Bun.sleep(60)
    expect(warmed).toHaveLength(0)
    await service.invoke("session.get", { id: sessionId }, "open")
    expect(warmed).toHaveLength(0)
    await Bun.sleep(60)
    expect(warmed.map((ctx) => ctx.sessionId)).toEqual([sessionId])
  })

  // 2026-11-12 (perf-1112 R6): every session.get broadcast a session.upsert and moved the list version, read or not.
  test("opening or acking a chat already read broadcasts nothing and leaves the list version alone", async () => {
    const store = new Store(":memory:")
    const events: Frame[] = []
    const service = new SessionService(store, createFakeAdapter(), (frame) => events.push(frame), { warmDelayMs: 60_000 })
    const id = store.createSession({ agent: "fake" }).id
    store.patchSession(id, { unread: true })
    await service.invoke("session.get", { id }, "first")
    expect(events.filter((frame) => frame.name === "session.upsert")).toHaveLength(1)
    const version = store.sessionVersion()
    for (let i = 0; i < 5; i++) await service.invoke("session.get", { id }, `again-${i}`)
    // perf-1112 round two: session.ack (the list's swipe, a notification read) follows the same rule.
    for (let i = 0; i < 5; i++) await service.invoke("session.ack", { id }, `ack-${i}`)
    expect(events.filter((frame) => frame.name === "session.upsert")).toHaveLength(1)
    expect(store.sessionVersion()).toBe(version)
    store.patchSession(id, { unread: true })
    await service.invoke("session.ack", { id }, "ack-unread")
    expect(events.filter((frame) => frame.name === "session.upsert")).toHaveLength(2)
    await service.shutdown(10)
  })

  // 2026-11-12 (perf-1112 R6): flicking through five chats started five agents. Only the chat a phone stays on is
  // warmed; another phone's open chat is its own.
  test("a chat left within the warm delay starts no agent", async () => {
    const store = new Store(":memory:")
    const adapter = createFakeAdapter()
    const warmed: string[] = []
    adapter.warm = (ctx) => void warmed.push(ctx.sessionId)
    const service = new SessionService(store, adapter, () => {}, { warmDelayMs: 40 })
    const ids = Array.from({ length: 5 }, () => store.createSession({ agent: "fake" }).id)
    for (const id of ids) await service.invoke("session.get", { id }, `open-${id}`, { deviceKey: "phone-a" })
    await service.invoke("session.get", { id: ids[0]! }, "other", { deviceKey: "phone-b" })
    await Bun.sleep(120)
    expect(warmed.sort()).toEqual([ids[0]!, ids[4]!].sort())
    await service.shutdown(10)
  })

  test("queued send promotion and edits preserve idempotent request identities", async () => {
    const store = new Store(":memory:")
    store.seedIfEmpty()
    const service = new SessionService(store, createFakeAdapter(), () => {})
    const sessionId = store.listSessions()[0]!.id
    await service.invoke("message.send", { sessionId, text: "first" }, "first")
    const request = { sessionId, text: "queued", clientMessageId: "77777777-7777-4777-8777-777777777777" }
    const accepted = await service.invoke("message.send", request, "queued")
    const id = (accepted.result as { queued: { id: string } }).queued.id
    const edit = { sessionId, id, text: "edited", clientMessageId: "88888888-8888-4888-8888-888888888888" }
    const edited = await service.invoke("queue.edit", edit, "edit")
    expect(edited.type).toBe("result")
    const repeatedEdit = await service.invoke("queue.edit", edit, "edit-retry")
    expect((repeatedEdit.result as { queued: { id: string } }).queued.id).toBe(id)
    const restored = { sessionId, text: "restored", index: 0, clientMessageId: "99999999-9999-4999-8999-999999999999" }
    const inserted = await service.invoke("queue.insert", restored, "restore")
    const duplicateInsert = await service.invoke("queue.insert", restored, "restore-retry")
    expect((duplicateInsert.result as { queued: { id: string } }).queued.id).toBe((inserted.result as { queued: { id: string } }).queued.id)
    const listed = await service.invoke("queue.list", { sessionId }, "list")
    expect((listed.result as { items: { text: string }[] }).items.map((item) => item.text)).toEqual(["restored", "edited"])
    const cancelled = await service.invoke("message.send", request, "old-retry")
    expect((cancelled.result as { cancelled?: boolean }).cancelled).toBe(true)
    const sent = await service.invoke("queue.send", { sessionId, id }, "promote")
    expect(sent.type).toBe("result")
    const retried = await service.invoke("queue.send", { sessionId, id }, "promote-retry")
    expect((retried.result as { message: { id: string } }).message.id).toBe((sent.result as { message: { id: string } }).message.id)
    expect(store.listMessages(sessionId).filter((row) => row.role === "user" && row.text === "edited")).toHaveLength(1)
    await service.shutdown()
  })

  test("two overlapping queue.send calls for one item send it once", async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "rudder-promote-")))
    const store = new Store(":memory:")
    const adapter = createFakeAdapter()
    adapter.reply = async (_text, context) => {
      await new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve(), { once: true }))
    }
    const service = new SessionService(store, adapter, () => {}, { workspaceRoot: cwd })
    const sessionId = store.createSession({ title: "t", agent: "claude", cwd }).id
    try {
      await service.invoke("message.send", { sessionId, text: "long" }, "first")
      const note = await service.uploadAttachment(sessionId, "note.txt", new TextEncoder().encode("hi"))
      const queued = await service.invoke("message.send", { sessionId, text: "queued", attachments: [note.id], clientMessageId: "44444444-4444-4444-8444-444444444441" }, "q")
      const id = (queued.result as { queued: { id: string } }).queued.id
      const [a, b] = await Promise.all([
        service.invoke("queue.send", { sessionId, id }, "a"),
        service.invoke("queue.send", { sessionId, id }, "b"),
      ])
      expect(a.type).toBe("result")
      expect(b.error?.code).toBe("busy")
      // The loser must not put the item back in the queue under a new id either: it would be sent again later.
      const listed = await service.invoke("queue.list", { sessionId }, "list")
      expect((listed.result as { items: unknown[] }).items).toEqual([])
      expect(store.listMessages(sessionId).filter((row) => row.role === "user" && row.text.startsWith("queued"))).toHaveLength(1)
    } finally {
      await service.shutdown()
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test("client ids are scoped to the authenticated device and status reads do not resend", async () => {
    const store = new Store(":memory:")
    store.seedIfEmpty()
    const service = new SessionService(store, createFakeAdapter(), () => {})
    const sessionId = store.listSessions()[0]!.id
    const request = { sessionId, text: "same text", clientMessageId: "66666666-6666-4666-8666-666666666666" }
    const first = await service.invoke("message.send", request, "a", { deviceKey: "device-a" })
    await waitFor(() => store.getSession(sessionId)?.status === "idle")
    const second = await service.invoke("message.send", request, "b", { deviceKey: "device-b" })
    const firstMessage = (first.result as { message: { id: string; clientDeviceId: string } }).message
    const secondMessage = (second.result as { message: { id: string; clientDeviceId: string } }).message
    expect(firstMessage.id).not.toBe(secondMessage.id)
    expect(firstMessage.clientDeviceId).not.toBe(secondMessage.clientDeviceId)
    const status = await service.invoke("message.status", request, "status", { deviceKey: "device-a" })
    expect((status.result as { message: { id: string } }).message.id).toBe(firstMessage.id)
    expect(store.listMessages(sessionId).filter((row) => row.role === "user")).toHaveLength(2)
    const hello = await service.invoke("hello", {}, "hello", { deviceKey: "device-a" })
    expect((hello.result as { sendEpoch: string }).sendEpoch).toBe(store.getMeta("send_epoch")!)
    await service.shutdown()
  })

  test("turn state stays preparing until real agent activity and advances monotonically", async () => {
    const store = new Store(":memory:")
    store.seedIfEmpty()
    const events: Frame[] = []
    const adapter = createFakeAdapter()
    let release: (() => void) | undefined
    adapter.reply = async (_text, context) => {
      context.emit({ type: "status", status: "running" })
      await new Promise<void>((resolve) => {
        release = resolve
        context.signal.addEventListener("abort", () => resolve(), { once: true })
      })
      if (!context.signal.aborted) context.emit({ type: "text", id: crypto.randomUUID(), text: "response" })
    }
    const service = new SessionService(store, adapter, (frame) => events.push(frame))
    const sessionId = store.listSessions()[0]!.id
    try {
      const sent = await service.invoke("message.send", { sessionId, text: "go", clientMessageId: "55555555-5555-4555-8555-555555555555" }, "send")
      await waitFor(() => release !== undefined)
      expect((sent.result as { turn?: { phase: string } }).turn?.phase).toBe("preparing")
      const snapshot = await service.invoke("session.get", { id: sessionId }, "snapshot")
      expect((snapshot.result as { session: { turn?: { phase: string } } }).session.turn?.phase).toBe("preparing")
      release?.()
      await waitFor(() => store.getSession(sessionId)?.status === "idle")
      const turns = events.filter((frame) => frame.name === "turn.state").map((frame) => payload(frame).turn as { phase: string; revision: number })
      expect(turns.map((turn) => turn.phase)).toEqual(["preparing", "running", "done"])
      expect(turns.map((turn) => turn.revision)).toEqual([1, 2, 3])
    } finally {
      release?.()
      await service.shutdown()
    }
  })

  test("client message ids reject content conflicts and concurrent duplicates", async () => {
    const store = new Store(":memory:")
    store.seedIfEmpty()
    const service = new SessionService(store, createFakeAdapter(), () => {})
    const sessionId = store.listSessions()[0]!.id
    const request = { sessionId, text: "once", clientMessageId: "22222222-2222-4222-8222-222222222222" }
    const [first, duplicate] = await Promise.all([service.invoke("message.send", request, "a"), service.invoke("message.send", request, "b")])
    expect((duplicate.result as { message: unknown }).message).toEqual((first.result as { message: unknown }).message)
    const conflict = await service.invoke("message.send", { ...request, text: "changed" }, "c")
    expect(conflict.error?.code).toBe("conflict")
    expect(store.listMessages(sessionId).filter((row) => row.role === "user")).toHaveLength(1)
    await service.shutdown()
  })

  test("a stored send survives service recreation and cleared history does not resurrect", async () => {
    const store = new Store(":memory:")
    store.seedIfEmpty()
    const sessionId = store.listSessions()[0]!.id
    const request = { sessionId, text: "once", clientMessageId: "33333333-3333-4333-8333-333333333333" }
    const service = new SessionService(store, createFakeAdapter(), () => {})
    const first = await service.invoke("message.send", request, "a")
    await service.shutdown()
    const restarted = new SessionService(store, createFakeAdapter(), () => {})
    const duplicate = await restarted.invoke("message.send", request, "b")
    expect((duplicate.result as { message: unknown }).message).toEqual((first.result as { message: unknown }).message)
    const snapshot = await restarted.invoke("session.get", { id: sessionId }, "snapshot")
    const messages = (snapshot.result as { messages: { clientMessageId?: string }[] }).messages
    expect(messages.some((row) => row.clientMessageId === request.clientMessageId)).toBe(true)
    await restarted.invoke("session.clear", { id: sessionId }, "clear")
    const removed = await restarted.invoke("message.send", request, "retry")
    expect((removed.result as { removed?: boolean }).removed).toBe(true)
    expect(store.listMessages(sessionId)).toHaveLength(0)
  })

  test("cancelled queued client sends never execute on retry", async () => {
    const store = new Store(":memory:")
    store.seedIfEmpty()
    const service = new SessionService(store, createFakeAdapter(), () => {})
    const sessionId = store.listSessions()[0]!.id
    await service.invoke("message.send", { sessionId, text: "first" }, "first")
    const request = { sessionId, text: "queued", clientMessageId: "44444444-4444-4444-8444-444444444444" }
    const accepted = await service.invoke("message.send", request, "queued")
    const queued = (accepted.result as { queued: { id: string } }).queued
    await service.invoke("queue.remove", { sessionId, id: queued.id }, "remove")
    const retried = await service.invoke("message.send", request, "retry")
    expect((retried.result as { cancelled?: boolean }).cancelled).toBe(true)
    expect(store.listMessages(sessionId).filter((row) => row.role === "user")).toHaveLength(1)
    await service.shutdown()
  })

  test("deduplicates a client message after its first turn finishes", async () => {
    const store = new Store(":memory:")
    store.seedIfEmpty()
    const service = new SessionService(store, createFakeAdapter(), () => {})
    const sessionId = store.listSessions()[0]!.id
    const request = { sessionId, text: "same request", clientMessageId: "11111111-1111-4111-8111-111111111111" }
    const first = await service.invoke("message.send", request, "first")
    await waitFor(() => store.getSession(sessionId)?.status === "idle")
    const retry = await service.invoke("message.send", request, "retry")
    expect(first.type).toBe("result")
    expect((retry.result as { message: unknown }).message).toEqual((first.result as { message: unknown }).message)
    expect(store.listMessages(sessionId).filter((row) => row.role === "user")).toHaveLength(1)
  })

  test("hello answers from the last probe and pushes agents.upsert when a fresh one differs", async () => {
    const store = new Store(":memory:")
    const frames: Frame[] = []
    let answer = { available: true }
    let release: (() => void) | undefined
    let detects = 0
    const adapter = createFakeAdapter()
    adapter.detect = async () => {
      detects += 1
      // Every probe after the first hangs until released: a hello must not wait on it.
      if (detects > 1) await new Promise<void>((resolve) => (release = resolve))
      return answer
    }
    const service = new SessionService(store, adapter, (frame) => frames.push(frame))
    await service.refreshAgents()
    const first = (await service.invoke("hello", {}, "h1")).result as { agents: { available: boolean }[] }
    expect(first.agents[0]?.available).toBe(true)
    answer = { available: false, reason: "signed out" } as never
    const started = Date.now()
    const second = (await service.invoke("hello", {}, "h2")).result as { agents: { available: boolean }[] }
    expect(Date.now() - started).toBeLessThan(500)
    expect(second.agents[0]?.available).toBe(true)
    await waitFor(() => release !== undefined)
    release?.()
    await waitFor(() => frames.some((frame) => frame.name === "agents.upsert"))
    const upsert = frames.find((frame) => frame.name === "agents.upsert")
    expect((payload(upsert as Frame).agents as { available: boolean }[])[0]?.available).toBe(false)
  })

  test("an unchanged probe after hello pushes nothing", async () => {
    const store = new Store(":memory:")
    const frames: Frame[] = []
    const adapter = createFakeAdapter()
    adapter.detect = async () => ({ available: true })
    const service = new SessionService(store, adapter, (frame) => frames.push(frame))
    await service.invoke("hello", {}, "h1")
    await service.refreshAgents()
    expect(frames.some((frame) => frame.name === "agents.upsert")).toBe(false)
  })

  test("hello.machine names the platform, and the model and OS version once a sample has read them", async () => {
    const store = new Store(":memory:")
    let identity: { model?: string; osVersion?: string } | undefined
    const service = new SessionService(store, createFakeAdapter(), () => {}, { platform: "win32", machineIdentity: () => identity })
    const before = (await service.invoke("hello", {}, "h1")).result as { machine: Record<string, unknown> }
    expect(before.machine.platform).toBe("win32")
    expect(before.machine.model).toBeUndefined()
    identity = { model: "Dell XPS 15 9530", osVersion: "11 24H2" }
    const after = (await service.invoke("hello", {}, "h2")).result as { machine: Record<string, unknown> }
    expect(after.machine).toMatchObject({ platform: "win32", model: "Dell XPS 15 9530", osVersion: "11 24H2" })
  })

  test("lists seeded session and replies through fake adapter", async () => {
    const store = new Store(":memory:")
    store.seedIfEmpty()
    const events: Frame[] = []
    const service = new SessionService(store, createFakeAdapter(), (frame) => events.push(frame))

    const listed = await service.invoke("session.list", {}, "a")
    expect(listed.type).toBe("result")
    const sessions = (listed.result as { sessions: Array<{ id: string }> }).sessions
    expect(sessions).toHaveLength(1)

    const started = Date.now()
    const sent = await service.invoke("message.send", { sessionId: sessions[0].id, text: "hello" }, "b")
    expect(sent.type).toBe("result")
    expect(Date.now() - started).toBeLessThan(80)
    expect(events.some((e) => e.name === "message.append")).toBe(true)
    expect(events.some((e) => e.name === "agent.status")).toBe(true)

    await waitFor(() =>
      events.some((e) => e.name === "agent.status" && payload(e).status === "idle"),
    )

    const got = await service.invoke("session.get", { id: sessions[0].id }, "c")
    const messages = (got.result as { messages: Array<{ role: string; text: string }> }).messages
    expect(messages.some((m) => m.role === "user" && m.text === "hello")).toBe(true)
    expect(messages.some((m) => m.role === "assistant" && m.text.includes("hello"))).toBe(true)
    const last = messages.at(-1)
    expect(last?.role).toBe("assistant")
    expect(last?.text).toContain("hello")
  })

  test("creates, clears, and deletes a session", async () => {
    const store = new Store(":memory:")
    const events: Frame[] = []
    const service = new SessionService(store, createFakeAdapter(), (frame) => events.push(frame))

    const created = await service.invoke("session.create", { title: "新会话" }, "c1")
    const session = (created.result as { session: { id: string; title: string } }).session
    expect(session.title).toBe("新会话")

    await service.invoke("message.send", { sessionId: session.id, text: "rename me please" }, "c2")
    await waitFor(() =>
      events.some((e) => e.name === "agent.status" && payload(e).sessionId === session.id && payload(e).status === "idle"),
    )
    const afterSend = store.getSession(session.id)
    expect(afterSend?.title).toBe("Rename me please")

    const cleared = await service.invoke("session.clear", { id: session.id }, "c3")
    expect(cleared.type).toBe("result")
    expect(store.listMessages(session.id)).toHaveLength(0)
    expect(events.some((e) => e.name === "message.invalidate")).toBe(true)

    const deleted = await service.invoke("session.delete", { id: session.id }, "c4")
    expect(deleted.type).toBe("result")
    expect(store.getSession(session.id)).toBeNull()
    expect(events.some((e) => e.name === "session.removed")).toBe(true)
  })

  test("names a session the phone created under its own-language placeholder; a rename keeps the user's title", async () => {
    const store = new Store(":memory:")
    const events: Frame[] = []
    const service = new SessionService(store, createFakeAdapter(), (frame) => events.push(frame))
    const idle = (id: string) =>
      waitFor(() => events.some((e) => e.name === "agent.status" && payload(e).sessionId === id && payload(e).status === "idle"))

    const created = await service.invoke("session.create", { title: "Neue Sitzung", autoTitle: true }, "a1")
    const id = (created.result as { session: { id: string; title: string } }).session.id
    expect(store.getSession(id)?.title).toBe("Neue Sitzung")
    await service.invoke("message.send", { sessionId: id, text: "name me after this" }, "a2")
    await idle(id)
    expect(store.getSession(id)?.title).toBe("Name me after this")

    const renamed = await service.invoke("session.create", { title: "Nouvelle session", autoTitle: true }, "a3")
    const kept = (renamed.result as { session: { id: string } }).session.id
    await service.invoke("session.patch", { id: kept, title: "Mon titre" }, "a4")
    await service.invoke("message.send", { sessionId: kept, text: "do not rename" }, "a5")
    await idle(kept)
    expect(store.getSession(kept)?.title).toBe("Mon titre")

    // Without the flag (an older app, or a title the user typed) only the zh / en placeholders are named.
    const typed = await service.invoke("session.create", { title: "Neue Sitzung" }, "a6")
    const plain = (typed.result as { session: { id: string } }).session.id
    await service.invoke("message.send", { sessionId: plain, text: "stays as typed" }, "a7")
    await idle(plain)
    expect(store.getSession(plain)?.title).toBe("Neue Sitzung")
  })

  // 11-19 on device: a session opened with `/superpowers:requesting-code-review` was titled with the raw command.
  test("the agent's own title (v112 ①) replaces automatic titles, never the user's", async () => {
    const store = new Store(":memory:")
    const titles: string[] = []
    const adapter: AgentAdapter = {
      spec: { id: "fake", label: "fake", transport: "fake", experimental: false, capabilities: FAKE_SPEC.capabilities },
      reply: async (_text, ctx) => {
        const next = titles.shift()
        if (next !== undefined) ctx.emit({ type: "title", title: next })
      },
    }
    const service = new SessionService(store, adapter, () => {})
    const created = (await service.invoke("session.create", { title: "新会话", autoTitle: true }, "t1")).result as { session: { id: string } }
    const id = created.session.id
    titles.push("Fix the login redirect loop after OAuth sign-in")
    await service.invoke("message.send", { sessionId: id, text: "帮我修复登录跳转，顺便看看注册页" }, "t2")
    await waitFor(() => store.getSession(id)?.title === "Fix the login redirect…")
    expect(store.getSession(id)?.auto_title).toBe(4)
    // The user's name stays whatever the agent says next.
    await service.invoke("session.patch", { id, title: "我的标题" }, "t3")
    titles.push("Another agent title")
    await service.invoke("message.send", { sessionId: id, text: "go on" }, "t4")
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(store.getSession(id)?.title).toBe("我的标题")
  })

  test("a session opened with a slash command is named after it (v112 ③), then after the first message that is not one", async () => {
    const store = new Store(":memory:")
    const events: Frame[] = []
    const service = new SessionService(store, createFakeAdapter(), (frame) => events.push(frame))
    const idleCount = (id: string) => events.filter((e) => e.name === "agent.status" && payload(e).sessionId === id && payload(e).status === "idle").length
    const send = async (id: string, text: string, rid: string) => {
      const before = idleCount(id)
      await service.invoke("message.send", { sessionId: id, text }, rid)
      await waitFor(() => idleCount(id) > before)
    }

    const created = await service.invoke("session.create", { title: "新会话", autoTitle: true }, "b1")
    const id = (created.result as { session: { id: string } }).session.id
    await send(id, "/superpowers:requesting-code-review", "b2")
    expect(store.getSession(id)?.title).toBe("请求代码审查")
    // Each phone words the command's name in its own language.
    const listed = (await service.invoke("session.list", {}, "b2l")).result as { sessions: Array<{ id: string; titleCopy?: unknown }> }
    expect(listed.sessions.find((row) => row.id === id)?.titleCopy).toEqual({
      code: "command_title",
      args: { command: "requesting-code-review", words: "Code review request" },
      text: "请求代码审查",
    })
    // A second command does not rename it; the first ordinary message does, once (first clause, 26 characters).
    await send(id, "/compact", "b3")
    expect(store.getSession(id)?.title).toBe("请求代码审查")
    await send(id, "please review the D10 ranking change, then the tests", "b4")
    expect(store.getSession(id)?.title).toBe("Review the D10 ranking…")
    await send(id, "and the tests", "b5")
    expect(store.getSession(id)?.title).toBe("Review the D10 ranking…")

    // A rename the user made is kept, command or not.
    const kept = (await service.invoke("session.create", { title: "新会话", autoTitle: true }, "b6")).result as { session: { id: string } }
    await send(kept.session.id, "/review", "b7")
    await service.invoke("session.patch", { id: kept.session.id, title: "我的标题" }, "b8")
    await send(kept.session.id, "go on", "b9")
    expect(store.getSession(kept.session.id)?.title).toBe("我的标题")
  })

  test("queues a second send while generating", async () => {
    const store = new Store(":memory:")
    store.seedIfEmpty()
    const service = new SessionService(store, createFakeAdapter(), () => {})
    const id = store.listSessions()[0]!.id
    const first = await service.invoke("message.send", { sessionId: id, text: "one" }, "s1")
    expect(first.type).toBe("result")
    const second = await service.invoke("message.send", { sessionId: id, text: "two" }, "s2")
    expect(second.type).toBe("result")
    expect((second.result as { queued?: { text: string } }).queued?.text).toBe("two")
  })

  test("commands.list returns the session agent's `/` list; an unknown session is not_found", async () => {
    const store = new Store(":memory:")
    store.seedIfEmpty()
    const service = new SessionService(store, createFakeAdapter(), () => {})
    const id = store.listSessions()[0]!.id
    const listed = await service.invoke("commands.list", { sessionId: id }, "c1")
    expect(listed.type).toBe("result")
    const commands = (listed.result as { commands: Array<{ name: string; insert: string }> }).commands
    expect(commands.map((command) => command.insert)).toEqual(["$explain", "$review", "$test"])
    const missing = await service.invoke("commands.list", { sessionId: "nope" }, "c2")
    expect(missing.error?.code).toBe("not_found")
  })

  test("unknown method errors", async () => {
    const store = new Store(":memory:")
    const service = new SessionService(store, createFakeAdapter(), () => {})
    const frame = await service.invoke("nope", {}, "x")
    expect(frame.type).toBe("error")
    expect(frame.error?.code).toBe("unknown_method")
  })

  test("asks permission then continues after allow", async () => {
    const store = new Store(":memory:")
    const events: Frame[] = []
    const service = new SessionService(store, createFakeAdapter(), (frame) => events.push(frame))
    const created = await service.invoke("session.create", { title: "新会话" }, "p0")
    const sessionId = (created.result as { session: { id: string } }).session.id

    await service.invoke("message.send", { sessionId, text: "run ls" }, "p1")
    await waitFor(() => events.some((e) => e.name === "permission.asked"))
    const asked = events.find((e) => e.name === "permission.asked")
    const permission = payload(asked!)
    expect(permission.kind).toBe("permission")
    const permissionId = permission.id as string

    const responded = await service.invoke("permission.respond", { id: permissionId, allow: true }, "p2")
    expect(responded.type).toBe("result")
    await waitFor(() =>
      events.some((e) => e.name === "agent.status" && payload(e).sessionId === sessionId && payload(e).status === "idle"),
    )
    const messages = store.listMessages(sessionId)
    const last = messages.at(-1)
    expect(last?.text).toContain("ls -la")
    expect(last?.text).toContain("run ls")
  })

  test("switching to bypassPermissions mid-turn lets the waiting ask and later asks through", async () => {
    const store = new Store(":memory:")
    const events: Frame[] = []
    const adapter = createFakeAdapter()
    const bypass = CLAUDE_MODES.find((mode) => mode.id === "bypassPermissions")!
    adapter.spec.capabilities.permissionModes = [...(adapter.spec.capabilities.permissionModes ?? []), "bypassPermissions"]
    adapter.spec.capabilities.modes = [...(adapter.spec.capabilities.modes ?? []), bypass]
    const service = new SessionService(store, adapter, (frame) => events.push(frame))
    const created = await service.invoke("session.create", { title: "新会话" }, "b0")
    const sessionId = (created.result as { session: { id: string } }).session.id

    await service.invoke("message.send", { sessionId, text: "run ls" }, "b1")
    await waitFor(() => events.some((e) => e.name === "permission.asked"))
    const updated = await service.invoke("session.patch", { id: sessionId, permissionMode: "bypassPermissions" }, "b2")
    expect(updated.error).toBeUndefined()
    await waitFor(() =>
      events.some((e) => e.name === "agent.status" && payload(e).sessionId === sessionId && payload(e).status === "idle"),
    )
    const resolved = events.filter((e) => e.name === "permission.resolved").map(payload)
    expect(resolved.map((entry) => entry.status)).toEqual(["allowed"])
    expect(store.listMessages(sessionId).at(-1)?.text).toContain("ls -la")

    // The fake still asks on the next turn (it only skips in acceptEdits); the daemon answers without a card.
    const asked = events.filter((e) => e.name === "permission.asked").length
    await service.invoke("message.send", { sessionId, text: "run ls" }, "b3")
    await waitFor(() => events.filter((e) => e.name === "permission.resolved").length === 2)
    expect(events.filter((e) => e.name === "permission.asked").length).toBe(asked)
  })

  test("an agent locked to approve everything gets its asks answered outside plan", async () => {
    const store = new Store(":memory:")
    const events: Frame[] = []
    const adapter = createFakeAdapter()
    adapter.detect = async () => ({ available: true, permissionLock: { mode: "always-approve", source: "/tmp/config.toml" } })
    const service = new SessionService(store, adapter, (frame) => events.push(frame))
    const created = await service.invoke("session.create", { title: "新会话" }, "l0")
    const sessionId = (created.result as { session: { id: string } }).session.id

    await service.invoke("message.send", { sessionId, text: "run ls" }, "l1")
    await waitFor(() =>
      events.some((e) => e.name === "agent.status" && payload(e).sessionId === sessionId && payload(e).status === "idle"),
    )
    expect(events.some((e) => e.name === "permission.asked")).toBe(false)
    expect(events.filter((e) => e.name === "permission.resolved").map((e) => payload(e).status)).toEqual(["allowed"])
    expect(store.listMessages(sessionId).at(-1)?.text).toContain("ls -la")
  })

  test("denied permission stops the command", async () => {
    const store = new Store(":memory:")
    const events: Frame[] = []
    const service = new SessionService(store, createFakeAdapter(), (frame) => events.push(frame))
    const created = await service.invoke("session.create", { title: "新会话" }, "d0")
    const sessionId = (created.result as { session: { id: string } }).session.id
    await service.invoke("message.send", { sessionId, text: "run ls" }, "d1")
    await waitFor(() => events.some((e) => e.name === "permission.asked"))
    const permissionId = payload(events.find((e) => e.name === "permission.asked")!).id as string
    await service.invoke("permission.respond", { id: permissionId, allow: false }, "d2")
    await waitFor(() =>
      events.some((e) => e.name === "agent.status" && payload(e).sessionId === sessionId && payload(e).status === "idle"),
    )
    const last = store.listMessages(sessionId).at(-1)
    expect(last?.text).toContain("Permission denied")
  })

  test("allow mode defaults new sessions to acceptEdits, which the agent runs without asking", async () => {
    const store = new Store(":memory:")
    const events: Frame[] = []
    const service = new SessionService(store, createFakeAdapter(), (frame) => events.push(frame))
    await service.invoke("config.set", { permissionMode: "allow" }, "m0")
    const created = await service.invoke("session.create", { title: "新会话" }, "m1")
    const session = (created.result as { session: { id: string; permissionMode: string } }).session
    expect(session.permissionMode).toBe("acceptEdits")
    const sessionId = session.id
    await service.invoke("message.send", { sessionId, text: "run ls" }, "m2")
    await waitFor(() =>
      events.some((e) => e.name === "agent.status" && payload(e).sessionId === sessionId && payload(e).status === "idle"),
    )
    expect(events.some((e) => e.name === "permission.asked")).toBe(false)
    expect(events.some((e) => e.name === "permission.resolved")).toBe(false)
    const last = store.listMessages(sessionId).at(-1)
    expect(last?.text).toContain("ls -la")
  })

  test("pins, archives, and tracks unread until get", async () => {
    const store = new Store(":memory:")
    const events: Frame[] = []
    const service = new SessionService(store, createFakeAdapter(), (frame) => events.push(frame))
    const created = await service.invoke("session.create", { title: "新会话" }, "u0")
    const sessionId = (created.result as { session: { id: string } }).session.id

    await service.invoke("message.send", { sessionId, text: "hello unread" }, "u1")
    await waitFor(() =>
      events.some((e) => e.name === "agent.status" && payload(e).sessionId === sessionId && payload(e).status === "idle"),
    )
    const listed = await service.invoke("session.list", {}, "u2")
    const row = (listed.result as { sessions: Array<{ id: string; unreadCount: number; title: string }> }).sessions.find(
      (session) => session.id === sessionId,
    )
    expect(row?.unreadCount).toBeGreaterThan(0)
    expect(row?.title).toBe("Hello unread")

    const pinned = await service.invoke("session.patch", { id: sessionId, pinned: true }, "u3")
    expect((pinned.result as { session: { pinned: boolean } }).session.pinned).toBe(true)
    const archived = await service.invoke("session.patch", { id: sessionId, archived: true }, "u4")
    expect((archived.result as { session: { archived: boolean } }).session.archived).toBe(true)
    const renamed = await service.invoke("session.patch", { id: sessionId, title: "Renamed" }, "u5")
    expect((renamed.result as { session: { title: string } }).session.title).toBe("Renamed")

    await service.invoke("session.get", { id: sessionId }, "u6")
    const afterGet = store.getSession(sessionId)
    expect(afterGet?.last_read_seq).toBe(afterGet?.last_seq)
    const listedAgain = await service.invoke("session.list", {}, "u7")
    const next = (listedAgain.result as { sessions: Array<{ id: string; unreadCount: number }> }).sessions.find(
      (session) => session.id === sessionId,
    )
    expect(next?.unreadCount).toBe(0)
    expect(next).not.toHaveProperty("markedUnread")
  })

  test("session.get with markRead false keeps the unread cursor", async () => {
    const store = new Store(":memory:")
    const service = new SessionService(store, createFakeAdapter(), () => {})
    const created = await service.invoke("session.create", { title: "新会话" }, "r0")
    const sessionId = (created.result as { session: { id: string } }).session.id
    await service.invoke("message.send", { sessionId, text: "hello unread" }, "r1")
    await waitFor(() => (store.getSession(sessionId)?.last_seq ?? 0) > 1)
    const before = store.getSession(sessionId)
    await service.invoke("session.get", { id: sessionId, markRead: false }, "r2")
    const after = store.getSession(sessionId)
    expect(after?.last_read_seq).toBe(before?.last_read_seq)
    expect(after?.last_seq).toBeGreaterThan(after?.last_read_seq ?? 0)
  })

  test("marks a caught-up session unread without moving last_read_seq or updated_at", async () => {
    const store = new Store(":memory:")
    const service = new SessionService(store, createFakeAdapter(), () => {})
    const created = await service.invoke("session.create", { title: "新会话" }, "m0")
    const sessionId = (created.result as { session: { id: string } }).session.id
    await service.invoke("message.send", { sessionId, text: "read me" }, "m1")
    await waitFor(() => (store.getSession(sessionId)?.last_seq ?? 0) > 0)
    await service.invoke("session.ack", { id: sessionId }, "m2")
    const before = store.getSession(sessionId)!
    expect(before.last_read_seq).toBe(before.last_seq)
    expect(before.marked_unread).toBe(0)

    const marked = await service.invoke("session.patch", { id: sessionId, unread: true }, "m3")
    const body = (marked.result as { session: { unreadCount: number; markedUnread?: boolean; updatedAt: number } }).session
    expect(body.unreadCount).toBe(0)
    expect(body.markedUnread).toBe(true)
    const row = store.getSession(sessionId)!
    expect(row.last_read_seq).toBe(before.last_read_seq)
    expect(row.updated_at).toBe(before.updated_at)

    await service.invoke("message.send", { sessionId, text: "still marked" }, "m4")
    await waitFor(() => (store.getSession(sessionId)?.last_seq ?? 0) > before.last_seq)
    expect(store.getSession(sessionId)?.marked_unread).toBe(1)

    const cleared = await service.invoke("session.patch", { id: sessionId, unread: false }, "m5")
    expect((cleared.result as { session: { markedUnread?: boolean } }).session).not.toHaveProperty("markedUnread")
    expect(store.getSession(sessionId)?.marked_unread).toBe(0)

    await service.invoke("session.patch", { id: sessionId, unread: true }, "m6")
    await service.invoke("session.get", { id: sessionId }, "m7")
    expect(store.getSession(sessionId)?.marked_unread).toBe(0)

    await service.invoke("session.patch", { id: sessionId, unread: true }, "m8")
    await service.invoke("session.ackAll", {}, "m9")
    expect(store.listSessions().every((session) => session.marked_unread === 0)).toBe(true)

    const orderBefore = store.listSessions().map((session) => session.id)
    const stamp = store.getSession(sessionId)!.updated_at
    await service.invoke("session.patch", { id: sessionId, unread: true }, "m10")
    expect(store.getSession(sessionId)?.updated_at).toBe(stamp)
    expect(store.listSessions().map((session) => session.id)).toEqual(orderBefore)
  })

  test("forks, rewinds, exports, and pages history", async () => {
    const store = new Store(":memory:")
    const events: Frame[] = []
    const service = new SessionService(store, createFakeAdapter(), (frame) => events.push(frame))
    const created = await service.invoke("session.create", { title: "新会话", cwd: ".", model: "claude-haiku-4-5" }, "h0")
    const sessionId = (created.result as { session: { id: string; cwd: string; model: string } }).session.id
    expect((created.result as { session: { model: string } }).session.model).toBe("claude-haiku-4-5")

    await service.invoke("message.send", { sessionId, text: "first" }, "h1")
    await waitFor(() =>
      events.some((e) => e.name === "agent.status" && payload(e).sessionId === sessionId && payload(e).status === "idle"),
    )
    await service.invoke("message.send", { sessionId, text: "second" }, "h2")
    await waitFor(() =>
      store.getSession(sessionId)?.status === "idle" &&
      store.listMessages(sessionId).filter((row) => row.role === "assistant").length >= 2,
    )

    const forked = await service.invoke("session.fork", { id: sessionId }, "h3")
    const forkId = (forked.result as { session: { id: string; title: string } }).session.id
    expect(forkId).not.toBe(sessionId)
    expect(store.listMessages(forkId).length).toBe(store.listMessages(sessionId).length)

    const before = store.listMessages(sessionId)[0]!.seq
    const rewound = await service.invoke("session.rewind", { id: sessionId, seq: before }, "h4")
    expect(rewound.type).toBe("result")
    expect(store.listMessages(sessionId).every((row) => row.seq <= before)).toBe(true)

    const exported = await service.invoke("session.export", { id: forkId }, "h5")
    expect((exported.result as { markdown: string }).markdown).toContain("#")
    expect((exported.result as { markdown: string }).markdown).toContain("first")

    const page = await service.invoke("history.page", { sessionId: forkId, beforeSeq: 99, limit: 2 }, "h6")
    expect((page.result as { messages: unknown[] }).messages.length).toBeGreaterThan(0)
  })

  test("schedules a message, ticks it, and supports skills plus questions", async () => {
    const store = new Store(":memory:")
    const events: Frame[] = []
    const service = new SessionService(store, createFakeAdapter(), (frame) => events.push(frame))
    const created = await service.invoke("session.create", { title: "新会话" }, "q0")
    const sessionId = (created.result as { session: { id: string } }).session.id

    const fireAt = Date.now() + 60_000
    const scheduled = await service.invoke("message.send", { sessionId, text: "later please", fireAt }, "q1")
    expect((scheduled.result as { scheduled: { text: string } }).scheduled.text).toBe("later please")
    expect(store.listMessages(sessionId)).toHaveLength(0)

    store.db.query("UPDATE scheduled SET fire_at = 1").run()
    await service.tickScheduled()
    await waitFor(() =>
      store.getSession(sessionId)?.status === "idle" &&
      store.listMessages(sessionId).some((row) => row.role === "assistant"),
    )
    expect(store.listMessages(sessionId).some((row) => row.text === "later please")).toBe(true)

    const skills = await service.invoke("skills.list", {}, "q2")
    expect((skills.result as { skills: Array<{ trigger: string }> }).skills.some((s) => s.trigger === "$explain")).toBe(true)

    const explained = await service.invoke("message.send", { sessionId, text: "$explain sockets" }, "q3")
    expect(explained.type).toBe("result")
    await waitFor(() =>
      store.getSession(sessionId)?.status === "idle" &&
      store.listMessages(sessionId).some((row) => row.text.includes("Explain the following")),
    )
    expect(store.listMessages(sessionId).some((row) => row.text.includes("Explain the following"))).toBe(true)

    const asked = await service.invoke("message.send", { sessionId, text: "ask: continue?" }, "q4")
    expect(asked.type).toBe("result")
    await waitFor(() => events.some((e) => e.name === "question.asked"))
    const questionId = payload(events.find((e) => e.name === "question.asked")!).id as string
    await service.invoke("question.respond", { id: questionId, answer: "是" }, "q5")
    await waitFor(() =>
      store.getSession(sessionId)?.status === "idle" &&
      store.listMessages(sessionId).some((row) => row.text.includes("You answered: 是")),
    )
    expect(store.listMessages(sessionId).some((row) => row.text.includes("You answered: 是"))).toBe(true)
  })

  test("ackAll, drafts, machine, and workspace fs", async () => {
    const store = new Store(":memory:")
    const service = new SessionService(store, createFakeAdapter(), () => {})
    const created = await service.invoke("session.create", { title: "新会话" }, "a0")
    const sessionId = (created.result as { session: { id: string } }).session.id
    await service.invoke("message.send", { sessionId, text: "unread me" }, "a1")
    await waitFor(() => (store.getSession(sessionId)?.last_seq ?? 0) > 0)
    const before = await service.invoke("session.list", {}, "a2")
    expect((before.result as { sessions: Array<{ unreadCount: number }> }).sessions[0]?.unreadCount).toBeGreaterThan(0)
    await service.invoke("session.ackAll", {}, "a3")
    const after = await service.invoke("session.list", {}, "a4")
    expect((after.result as { sessions: Array<{ unreadCount: number }> }).sessions.every((s) => s.unreadCount === 0)).toBe(true)

    const draft = await service.invoke("draft.set", { sessionId, text: "scratch" }, "a5")
    expect((draft.result as { draft: { text: string } }).draft.text).toBe("scratch")
    const loaded = await service.invoke("draft.get", { sessionId }, "a6")
    expect((loaded.result as { draft: { text: string } }).draft.text).toBe("scratch")

    // A clear after a send names what it saw; a draft saved meanwhile is kept, an unchanged one is cleared.
    await service.invoke("draft.set", { sessionId, text: "newer" }, "a6b")
    const kept = await service.invoke("draft.set", { sessionId, text: "", ifText: "scratch" }, "a6c")
    expect(kept.result).toMatchObject({ applied: false, draft: { text: "newer" } })
    expect(((await service.invoke("draft.get", { sessionId }, "a6d")).result as { draft: { text: string } }).draft.text).toBe("newer")
    const cleared = await service.invoke("draft.set", { sessionId, text: "", ifText: "newer" }, "a6e")
    expect(cleared.result).toMatchObject({ applied: true, draft: { text: "" } })

    const machine = await service.invoke("machine.patch", { name: "studio-mac" }, "a7")
    expect((machine.result as { machine: { name: string } }).machine.name).toBe("studio-mac")

    const listed = await service.invoke("fs.list", { path: "." }, "a8")
    expect(listed.type).toBe("result")
    const forbidden = await service.invoke("fs.list", { path: ".." }, "a9")
    expect(forbidden.type).toBe("error")
    expect(forbidden.error?.code).toBe("forbidden")
    // Copy rudderd wrote for the phone rides on the error; `message` stays its text for an older app.
    expect(forbidden.error?.copy).toBeUndefined()
    const hidden = await service.invoke("fs.list", { path: ".config" }, "a9b")
    expect(hidden.error).toEqual({
      code: "forbidden",
      message: "隐藏文件（以 . 开头）不对手机开放",
      copy: { code: "hidden_path", text: "隐藏文件（以 . 开头）不对手机开放" },
    })

    const hello = await service.invoke("hello", {}, "a10")
    expect((hello.result as { models: unknown[] }).models.length).toBeGreaterThan(0)
    expect((hello.result as { machine: { name: string } }).machine.name).toBe("studio-mac")
    expect((hello.result as { version: string }).version).toBe(APP_VERSION)

    await service.invoke("session.patch", { id: sessionId, archived: true }, "a11")
    const statusBeforeReopen = store.getSession(sessionId)?.status
    const reopened = await service.invoke("session.reopen", { id: sessionId }, "a12")
    expect(reopened.result).toMatchObject({ session: { archived: false, status: statusBeforeReopen } })

    const firstName = (listed.result as { entries: Array<{ name: string }> }).entries[0]?.name ?? "Documents"
    const found = await service.invoke("fs.search", { query: firstName.slice(0, Math.min(4, firstName.length)), path: "." }, "a13")
    expect(found.type).toBe("result")
    expect((found.result as { entries: unknown[] }).entries.length).toBeGreaterThan(0)

    const usage = await service.invoke("usage.get", {}, "a14")
    expect((usage.result as { usage: { sessions: number; bytes: number } }).usage.sessions).toBeGreaterThan(0)
  })

  test("emits a tool card after an allowed command", async () => {
    const store = new Store(":memory:")
    const events: Frame[] = []
    const service = new SessionService(store, createFakeAdapter(), (frame) => events.push(frame))
    await service.invoke("config.set", { permissionMode: "allow" }, "t1")
    const created = await service.invoke("session.create", { title: "新会话" }, "t0")
    const sessionId = (created.result as { session: { id: string } }).session.id
    await service.invoke("message.send", { sessionId, text: "run ls" }, "t2")
    await waitFor(() =>
      events.some((e) => e.name === "agent.status" && payload(e).sessionId === sessionId && payload(e).status === "idle"),
    )
    expect(store.listMessages(sessionId).some((row) => row.kind === "tool")).toBe(true)
  })
})

describe("pickPermissionOption", () => {
  // Grok's real order (fixtures/acp/grok.json): allow_always first.
  const grok: PermissionOption[] = [
    { id: "always-allow", label: "Yes, and don't ask again", kind: "allow_always" },
    { id: "allow-once", label: "Yes, proceed", kind: "allow_once" },
    { id: "reject-once", label: "No", kind: "reject_once" },
    { id: "reject-always", label: "No, never", kind: "reject_always" },
  ]

  test("a bare allow or reject is this time only", () => {
    expect(pickPermissionOption(grok, { allow: true })?.id).toBe("allow-once")
    expect(pickPermissionOption(grok, { allow: false })?.id).toBe("reject-once")
  })

  test("no once option means no answer, never a standing rule", () => {
    const always = grok.filter((o) => !o.kind.endsWith("_once"))
    expect(pickPermissionOption(always, { allow: true })).toBeUndefined()
    expect(pickPermissionOption(always, { allow: false })).toBeUndefined()
  })

  test("an explicit option id still picks that option", () => {
    expect(pickPermissionOption(grok, { optionId: "always-allow" })?.id).toBe("always-allow")
  })
})
