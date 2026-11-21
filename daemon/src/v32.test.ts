import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFakeAdapter, FAKE_SPEC } from "./adapter/fake"
import { AgentError } from "./adapter/agent-error"
import type { AgentAdapter } from "./adapter/types"
import type { Frame } from "./protocol"
import { SessionService } from "./session-service"
import { messagePublic, Store } from "./store"
import { callMatch, enqueueItem, modelAcceptsImages, QUEUE_MAX_BYTES, QUEUE_MAX_ITEMS, ruleMatches, type SessionRule, steerControl } from "./v32"

function payload(frame: Frame): Record<string, unknown> {
  return (frame.payload ?? {}) as Record<string, unknown>
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out")
    await Bun.sleep(10)
  }
}

function harness(adapter: AgentAdapter = createFakeAdapter()) {
  const dir = mkdtempSync(join(tmpdir(), "rudder-v32-"))
  const store = new Store(":memory:")
  const events: Frame[] = []
  const service = new SessionService(store, adapter, (frame) => events.push(frame), { workspaceRoot: "/" })
  return { dir, store, events, service }
}

describe("v32 image capability", () => {
  test("the table wins over a contradictory agent image flag", () => {
    expect(modelAcceptsImages("grok", "grok-code-fast-1", true).accepts).toBe(false)
    expect(modelAcceptsImages("claude", "claude-sonnet", false).accepts).toBe(true)
    expect(modelAcceptsImages("codex", "gpt-5", false).accepts).toBe(true)
    expect(modelAcceptsImages("grok", "grok-4", false).accepts).toBe(true)
  })

  test("a text-only model refuses an image even when the agent reports images", async () => {
    const h = harness()
    const session = h.store.createSession({ agent: "grok", model: "grok-code-fast-1", cwd: h.dir })
    const uploaded = await h.service.uploadAttachment(session.id, "shot.jpg", new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))
    const sent = await h.service.invoke(
      "message.send",
      { sessionId: session.id, text: "look", attachments: [uploaded.id], agentReportsImages: true },
      "img",
    )
    expect(sent.error?.code).toBe("invalid")
    expect(h.store.listMessages(session.id).some((row) => row.role === "user")).toBe(false)
  })

  test("an upload returns an id and the following message lists it only after the upload", async () => {
    const seen: string[] = []
    const adapter: AgentAdapter = {
      spec: FAKE_SPEC,
      reply: async (text) => {
        seen.push(text)
      },
    }
    const h = harness(adapter)
    const session = h.store.createSession({ agent: "claude", model: "claude-sonnet", cwd: h.dir })
    const early = await h.service.invoke("message.send", { sessionId: session.id, text: "before", attachments: ["missing"] }, "early")
    expect(early.error?.code).toBe("not_found")
    const uploaded = await h.service.uploadAttachment(session.id, "shot.jpg", new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]))
    const sent = await h.service.invoke(
      "message.send",
      { sessionId: session.id, text: "see this", attachments: [uploaded.id], agentReportsImages: false },
      "send",
    )
    expect(sent.type).toBe("result")
    await waitFor(() => seen.length === 1)
    const stored = h.store.listMessages(session.id).find((row) => row.role === "user")
    expect(stored?.payload).toContain(uploaded.id)
    expect(seen[0]).toContain(uploaded.id)
  })
})

describe("v32 queue", () => {
  test("a busy session queues at most QUEUE_MAX_ITEMS messages and QUEUE_MAX_BYTES of text", async () => {
    const item = (text: string) => ({ id: crypto.randomUUID(), sessionId: "s", text, attachmentIds: [] })
    let queue = Array.from({ length: QUEUE_MAX_ITEMS }, () => item("x"))
    expect(() => enqueueItem(queue, item("one more"))).toThrow(expect.objectContaining({ code: "queue_full" }))
    // 3 UTF-8 bytes each: one byte under the cap when QUEUE_MAX_BYTES % 3 == 1.
    queue = [item("长".repeat(Math.floor(QUEUE_MAX_BYTES / 3)))]
    expect(QUEUE_MAX_BYTES % 3).toBe(1)
    expect(() => enqueueItem(queue, item("长"))).toThrow(expect.objectContaining({ code: "queue_full" }))
    expect(enqueueItem(queue, item("a"))).toHaveLength(2)

    let hold = true
    const adapter: AgentAdapter = {
      spec: FAKE_SPEC,
      reply: async () => {
        while (hold) await Bun.sleep(5)
      },
    }
    const h = harness(adapter)
    const id = h.store.createSession({ agent: "fake", cwd: h.dir }).id
    await h.service.invoke("message.send", { sessionId: id, text: "first" }, "0")
    for (let index = 0; index < QUEUE_MAX_ITEMS; index++) {
      const queued = await h.service.invoke("message.send", { sessionId: id, text: `q${index}` }, `q${index}`)
      expect(queued.type).toBe("result")
    }
    const refused = await h.service.invoke("message.send", { sessionId: id, text: "too many" }, "over")
    expect(refused.error?.code).toBe("queue_full")
    hold = false
  })

  test("a queued message stays out of adapter input until the turn ends", async () => {
    const seen: string[] = []
    let hold = true
    const adapter: AgentAdapter = {
      spec: FAKE_SPEC,
      reply: async (text) => {
        seen.push(text)
        while (hold) await Bun.sleep(5)
      },
    }
    const h = harness(adapter)
    const id = h.store.createSession({ agent: "fake", cwd: h.dir }).id
    await h.service.invoke("message.send", { sessionId: id, text: "first" }, "1")
    await waitFor(() => seen.includes("first"))
    const queued = await h.service.invoke("message.send", { sessionId: id, text: "second" }, "2")
    expect((queued.result as { queued?: { text: string } }).queued?.text).toBe("second")
    expect(seen).toEqual(["first"])
    hold = false
    await waitFor(() => seen.includes("second"))
    expect(seen).toEqual(["first", "second"])
  })

  test("a queued message that starts the next turn leaves the session running, not idle", async () => {
    const seen: string[] = []
    let hold = true
    const adapter: AgentAdapter = {
      spec: FAKE_SPEC,
      reply: async (text) => {
        seen.push(text)
        while (hold && text === "first") await Bun.sleep(5)
        if (text === "second") await new Promise(() => {})
      },
    }
    const h = harness(adapter)
    const id = h.store.createSession({ agent: "fake", cwd: h.dir }).id
    await h.service.invoke("message.send", { sessionId: id, text: "first" }, "1")
    await waitFor(() => seen.includes("first"))
    await h.service.invoke("message.send", { sessionId: id, text: "second" }, "2")
    hold = false
    await waitFor(() => seen.includes("second"))
    await Bun.sleep(20)
    const statuses = h.events.filter((frame) => frame.name === "agent.status").map((frame) => payload(frame).status)
    expect(statuses.at(-1)).toBe("running")
    expect(h.store.getSession(id)?.status).toBe("running")
  })

  test("steer writes the queued line and a rejected steer puts it back", async () => {
    const steered: string[] = []
    let release: (() => void) | undefined
    const adapter: AgentAdapter = {
      spec: { ...FAKE_SPEC, capabilities: { ...FAKE_SPEC.capabilities, steer: true } },
      reply: () => new Promise<void>((resolve) => { release = resolve }),
      steer: async (_session, text) => {
        steered.push(text)
        return text !== "nope"
      },
    }
    const h = harness(adapter)
    const id = h.store.createSession({ agent: "fake", cwd: h.dir }).id
    await h.service.invoke("message.send", { sessionId: id, text: "live" }, "1")
    const queued = await h.service.invoke("message.send", { sessionId: id, text: "aside" }, "2")
    const item = (queued.result as { queued: { id: string } }).queued
    const sent = await h.service.invoke("queue.steer", { sessionId: id, id: item.id }, "3")
    expect(sent.type).toBe("result")
    expect(steered).toEqual(["aside"])
    const aside = h.store.listMessages(id).find((row) => row.text === "aside")
    expect(JSON.parse(aside?.payload ?? "{}")).toMatchObject({ steer: "sent" })
    const again = await h.service.invoke("message.send", { sessionId: id, text: "nope" }, "4")
    const back = (again.result as { queued: { id: string } }).queued
    const failed = await h.service.invoke("queue.steer", { sessionId: id, id: back.id }, "5")
    expect(failed.error?.code).toBe("idle")
    const listed = await h.service.invoke("queue.list", { sessionId: id }, "6")
    expect((listed.result as { items: Array<{ text: string }> }).items.map((entry) => entry.text)).toEqual(["nope"])
    release?.()
  })

  test("a steer that waits on the probe while the queue moves neither revives the flushed head nor drops a new send", async () => {
    const seen: string[] = []
    const steered: string[] = []
    const releases = new Map<string, () => void>()
    let answerProbe: ((result: "ok") => void) | undefined
    const adapter: AgentAdapter = {
      spec: { ...FAKE_SPEC, capabilities: { ...FAKE_SPEC.capabilities, steer: true } },
      reply: (text) => {
        seen.push(text)
        return new Promise<void>((resolve) => { releases.set(text, resolve) })
      },
      probeSteer: () => new Promise((resolve) => { answerProbe = resolve }),
      steer: async (_session, text) => {
        steered.push(text)
        return true
      },
    }
    const h = harness(adapter)
    const id = h.store.createSession({ agent: "fake", cwd: h.dir }).id
    await h.service.invoke("message.send", { sessionId: id, text: "live" }, "1")
    await waitFor(() => seen.includes("live"))
    await h.service.invoke("message.send", { sessionId: id, text: "a" }, "2")
    const queuedB = await h.service.invoke("message.send", { sessionId: id, text: "b" }, "3")
    const b = (queuedB.result as { queued: { id: string } }).queued
    const steering = h.service.invoke("queue.steer", { sessionId: id, id: b.id }, "4")
    await waitFor(() => answerProbe !== undefined)
    // While the probe is out: the turn ends, the head "a" starts the next turn, and "c" queues behind it.
    releases.get("live")?.()
    await waitFor(() => seen.includes("a"))
    await h.service.invoke("message.send", { sessionId: id, text: "c" }, "5")
    answerProbe?.("ok")
    const result = await steering
    expect(result.type).toBe("result")
    expect(steered).toEqual(["b"])
    const listed = await h.service.invoke("queue.list", { sessionId: id }, "6")
    expect((listed.result as { items: Array<{ text: string }> }).items.map((entry) => entry.text)).toEqual(["c"])
    releases.get("a")?.()
    await waitFor(() => seen.includes("c"))
    expect(seen).toEqual(["live", "a", "c"])
    releases.get("c")?.()
  })

  test("a rejected steer puts the item back where it was", async () => {
    let release: (() => void) | undefined
    const adapter: AgentAdapter = {
      spec: { ...FAKE_SPEC, capabilities: { ...FAKE_SPEC.capabilities, steer: true } },
      reply: () => new Promise<void>((resolve) => { release = resolve }),
      steer: async () => false,
    }
    const h = harness(adapter)
    const id = h.store.createSession({ agent: "fake", cwd: h.dir }).id
    await h.service.invoke("message.send", { sessionId: id, text: "live" }, "1")
    const ids: string[] = []
    for (const text of ["x", "y", "z"]) {
      const queued = await h.service.invoke("message.send", { sessionId: id, text }, text)
      ids.push((queued.result as { queued: { id: string } }).queued.id)
    }
    const failed = await h.service.invoke("queue.steer", { sessionId: id, id: ids[1] }, "s")
    expect(failed.error?.code).toBe("idle")
    const listed = await h.service.invoke("queue.list", { sessionId: id }, "l")
    expect((listed.result as { items: Array<{ text: string }> }).items.map((entry) => entry.text)).toEqual(["x", "y", "z"])
    release?.()
  })

  test("a steered row publishes sent, then read once the turn answers", () => {
    const row = {
      id: "m",
      session_id: "s",
      seq: 1,
      kind: "text",
      role: "user",
      text: "aside",
      payload: JSON.stringify({ steer: "sent" }),
      created_at: 1,
    }
    expect(messagePublic(row).steer).toEqual({ state: "sent" })
    expect(messagePublic({ ...row, payload: JSON.stringify({ attachments: [] }) }).steer).toBeUndefined()
    expect(messagePublic({ ...row, payload: JSON.stringify({ steer: "read", readAt: 15 }) }).steer).toEqual({
      state: "read",
      readAt: 15,
    })
  })
})

describe("r64 queue pause", () => {
  function failing(fail: (text: string) => Error | undefined) {
    const seen: string[] = []
    let release: (() => void) | undefined
    const adapter: AgentAdapter = {
      spec: FAKE_SPEC,
      reply: async (text) => {
        seen.push(text)
        await new Promise<void>((resolve) => { release = resolve })
        const error = fail(text)
        if (error) throw error
      },
    }
    return { seen, adapter, release: () => release?.() }
  }

  test("queue.resume lets a paused queue go without a new message, from any phone", async () => {
    const agent = failing((text) => (text === "first" ? new AgentError("limit", { code: "usage_limit", resetsAt: Date.now() + 60_000 }) : undefined))
    const h = harness(agent.adapter)
    const id = h.store.createSession({ agent: "fake", cwd: h.dir }).id
    await h.service.invoke("message.send", { sessionId: id, text: "first" }, "1")
    await waitFor(() => agent.seen.includes("first"))
    await h.service.invoke("message.send", { sessionId: id, text: "queued" }, "2")
    agent.release()
    await waitFor(() => h.store.getSession(id)?.status === "idle")
    const before = await h.service.invoke("queue.list", { sessionId: id }, "3")
    expect(before.result).toMatchObject({ paused: "usage_limit" })
    const resumed = await h.service.invoke("queue.resume", { sessionId: id }, "4")
    expect(resumed.result).toMatchObject({ ok: true })
    await waitFor(() => agent.seen.includes("queued"))
    expect(agent.seen).toEqual(["first", "queued"])
    expect(h.events.filter((frame) => frame.name === "queue.upsert").map(payload).some((frame) => frame.paused === undefined)).toBe(true)
    agent.release()
    const empty = await h.service.invoke("queue.resume", { sessionId: id }, "5")
    expect(empty.error?.code).toBe("idle")
    const missing = await h.service.invoke("queue.resume", { sessionId: "nope" }, "6")
    expect(missing.error?.code).toBe("not_found")
  })

  for (const [code, error] of [
    ["usage_limit", new AgentError("limit", { code: "usage_limit", resetsAt: Date.now() + 60_000 })],
    ["auth_required", new AgentError("login", { code: "auth_required" })],
  ] as const) {
    test(`a turn that ends on ${code} keeps the queue and marks it paused until the next turn starts`, async () => {
      const agent = failing((text) => (text === "first" ? error : undefined))
      const h = harness(agent.adapter)
      const id = h.store.createSession({ agent: "fake", cwd: h.dir }).id
      await h.service.invoke("message.send", { sessionId: id, text: "first" }, "1")
      await waitFor(() => agent.seen.includes("first"))
      await h.service.invoke("message.send", { sessionId: id, text: "queued" }, "2")
      agent.release()
      await waitFor(() => h.store.getSession(id)?.status === "idle")
      await Bun.sleep(20)
      expect(agent.seen).toEqual(["first"])
      const listed = await h.service.invoke("queue.list", { sessionId: id }, "3")
      expect(listed.result).toMatchObject({ items: [{ text: "queued" }], paused: code })
      const upserts = h.events.filter((frame) => frame.name === "queue.upsert").map(payload)
      expect(upserts.at(-1)).toMatchObject({ paused: code })
      // The user sends again: that turn starts, the pause clears, and the queue follows it.
      await h.service.invoke("message.send", { sessionId: id, text: "retry" }, "4")
      expect(h.events.filter((frame) => frame.name === "queue.upsert").map(payload).at(-1)?.paused).toBeUndefined()
      await waitFor(() => agent.seen.includes("retry"))
      agent.release()
      await waitFor(() => agent.seen.includes("queued"))
      expect(agent.seen).toEqual(["first", "retry", "queued"])
      agent.release()
    })
  }

  test("another failure still lets the queue go", async () => {
    const agent = failing((text) => (text === "first" ? new AgentError("exit", { code: "agent_exited", exitCode: 1 }) : undefined))
    const h = harness(agent.adapter)
    const id = h.store.createSession({ agent: "fake", cwd: h.dir }).id
    await h.service.invoke("message.send", { sessionId: id, text: "first" }, "1")
    await waitFor(() => agent.seen.includes("first"))
    await h.service.invoke("message.send", { sessionId: id, text: "queued" }, "2")
    agent.release()
    await waitFor(() => agent.seen.includes("queued"))
    expect(h.events.filter((frame) => frame.name === "queue.upsert").some((frame) => payload(frame).paused !== undefined)).toBe(false)
    agent.release()
  })

  test("a queue left behind a turn a restart cut short waits for the session's next turn", async () => {
    const store = new Store(":memory:")
    const dir = mkdtempSync(join(tmpdir(), "rudder-r64-"))
    const before = failing(() => undefined)
    const first = new SessionService(store, before.adapter, () => {}, { workspaceRoot: "/" })
    const id = store.createSession({ agent: "fake", cwd: dir }).id
    await first.invoke("message.send", { sessionId: id, text: "first" }, "1")
    await waitFor(() => before.seen.includes("first"))
    const queued = await first.invoke("message.send", { sessionId: id, text: "queued", clientMessageId: "66666666-6666-4666-8666-666666666666" }, "2")
    expect((queued.result as { queued?: unknown }).queued).toBeDefined()

    const after = failing(() => undefined)
    const events: Frame[] = []
    const restarted = new SessionService(store, after.adapter, (frame) => events.push(frame), { workspaceRoot: "/" })
    await Bun.sleep(30)
    expect(after.seen).toEqual([])
    const listed = await restarted.invoke("queue.list", { sessionId: id }, "3")
    expect(listed.result).toMatchObject({ items: [{ text: "queued" }], paused: "restart" })
    await restarted.invoke("message.send", { sessionId: id, text: "again" }, "4")
    await waitFor(() => after.seen.includes("again"))
    after.release()
    await waitFor(() => after.seen.includes("queued"))
    expect(after.seen).toEqual(["again", "queued"])
    after.release()
    before.release()
  })
})

describe("v32 steer probe", () => {
  test("method-not-found selects stop-and-send and a successful probe selects steer", async () => {
    expect(steerControl("grok", false, false, "missing")).toBe("stop-and-send")
    expect(steerControl("grok", false, false, "ok")).toBe("steer")
    expect(steerControl("grok", false, false, null)).toBe("stop-and-send")
    expect(steerControl("claude", true, true, null)).toBe("steer")
    expect(steerControl("codex", true, true, null)).toBe("steer")
    expect(steerControl("copilot", false, false, "ok")).toBe("queue")
    expect(steerControl("cursor", false, false, "ok")).toBe("queue")
    expect(steerControl("opencode", false, false, "ok")).toBe("queue")
    expect(steerControl("kimi", false, false, "ok")).toBe("queue")
    expect(steerControl("pi", false, false, "ok")).toBe("queue")
    const missing: AgentAdapter = {
      spec: { ...FAKE_SPEC, id: "grok", capabilities: { ...FAKE_SPEC.capabilities, steer: true } },
      reply: async () => {},
      probeSteer: async () => "missing",
    }
    const ok: AgentAdapter = {
      spec: { ...FAKE_SPEC, id: "grok", capabilities: { ...FAKE_SPEC.capabilities, steer: false } },
      reply: async () => {},
      probeSteer: async () => "ok",
    }
    const stopped = harness(missing)
    const stopSession = await stopped.service.invoke("session.create", { agent: "grok" }, "a")
    expect((stopSession.result as { steerControl: string }).steerControl).toBe("stop-and-send")
    const steered = harness(ok)
    const go = await steered.service.invoke("session.create", { agent: "grok" }, "b")
    expect((go.result as { steerControl: string }).steerControl).toBe("steer")
    const opened = await steered.service.invoke(
      "session.get",
      { id: (go.result as { session: { id: string } }).session.id },
      "c",
    )
    expect((opened.result as { steerControl: string }).steerControl).toBe("steer")
    const stoppedOpen = await stopped.service.invoke(
      "session.get",
      { id: (stopSession.result as { session: { id: string } }).session.id },
      "d",
    )
    expect((stoppedOpen.result as { steerControl: string }).steerControl).toBe("stop-and-send")
  })

  test("grok reports stop-and-send before its process answers the probe, and the probe confirms it", async () => {
    const adapter: AgentAdapter = {
      spec: { ...FAKE_SPEC, id: "grok", capabilities: { ...FAKE_SPEC.capabilities, steer: false } },
      probeSteer: async () => "unavailable",
      reply: async (_text, ctx) => {
        ctx.emit({ type: "steer", result: "missing" })
      },
    }
    const h = harness(adapter)
    const created = await h.service.invoke("session.create", { agent: "grok" }, "1")
    const id = (created.result as { session: { id: string } }).session.id
    expect((created.result as { steerControl: string }).steerControl).toBe("stop-and-send")
    await h.service.invoke("message.send", { sessionId: id, text: "hi" }, "2")
    const pushed = h.events.find((event) => event.name === "steer.control")
    expect(pushed?.payload).toMatchObject({ sessionId: id, steerControl: "stop-and-send" })
    const opened = await h.service.invoke("session.get", { id }, "3")
    expect((opened.result as { steerControl: string }).steerControl).toBe("stop-and-send")
  })
})

describe("v32 always allow", () => {
  test("allow_always approves this request and revoking the rule asks again", async () => {
    const h = harness()
    const id = h.store.createSession({ agent: "fake", cwd: h.dir }).id
    const asked = () => h.events.filter((event) => event.name === "permission.asked")
    void h.service.invoke("message.send", { sessionId: id, text: "run ls" }, "1")
    await waitFor(() => asked().length === 1)
    const permissionId = String(payload(asked()[0]!).id)
    const responded = await h.service.invoke("permission.respond", { id: permissionId, optionId: "allow_always" }, "p1")
    expect((responded.result as { allow: boolean }).allow).toBe(true)
    await waitFor(() => h.events.some((event) => event.name === "agent.status" && payload(event).status === "idle"))
    const before = asked().length
    void h.service.invoke("message.send", { sessionId: id, text: "run ls" }, "2")
    await waitFor(() => h.events.filter((event) => event.name === "agent.status" && payload(event).status === "idle").length >= 2)
    expect(asked().length).toBe(before)
    const rules = await h.service.invoke("permission.rules", { sessionId: id }, "r")
    const rule = (rules.result as { rules: Array<{ id: string }> }).rules[0]!
    await h.service.invoke("permission.revoke", { id: rule.id }, "rev")
    void h.service.invoke("message.send", { sessionId: id, text: "run ls" }, "3")
    await waitFor(() => asked().length === before + 1)
  })

  // Audit 2026-11-10 #5: a real adapter asks on every use and never consults allowsCommand. The rule must cover
  // exactly the tool and command it was granted for, and the agent must not be told allow-always (Claude's CLI
  // then allowed the whole tool and outlived a revoke).
  test("the daemon's rule answers only the same tool and command, the agent only hears allow-once", async () => {
    const options = [
      { id: "once", label: "Allow", kind: "allow_once" },
      { id: "session", label: "Always", kind: "allow_always" },
      { id: "no", label: "Reject", kind: "reject_once" },
    ] as const
    const answers: Array<string | null> = []
    const adapter: AgentAdapter = {
      spec: FAKE_SPEC,
      reply: async (text, ctx) => {
        const [tool = "", ...rest] = text.split(" ")
        answers.push(await ctx.askPermission({ tool, title: text, detail: rest.join(" "), kind: "execute", options: [...options] }))
      },
    }
    const h = harness(adapter)
    const id = h.store.createSession({ agent: "fake", cwd: h.dir }).id
    const asked = () => h.events.filter((event) => event.name === "permission.asked")
    const idles = () => h.events.filter((event) => event.name === "agent.status" && payload(event).status === "idle").length
    // Sends one turn and, when the phone is asked, answers with `optionId`; resolves once the turn is idle.
    const turn = async (text: string, optionId?: string) => {
      const [askedBefore, idleBefore] = [asked().length, idles()]
      void h.service.invoke("message.send", { sessionId: id, text }, crypto.randomUUID())
      if (optionId) {
        await waitFor(() => asked().length > askedBefore)
        await h.service.invoke("permission.respond", { id: String(payload(asked().at(-1)!).id), optionId }, crypto.randomUUID())
      }
      await waitFor(() => idles() > idleBefore)
    }

    await turn("Bash ls", "session")
    expect(answers).toEqual(["once"])
    await turn("Bash ls")
    expect(answers).toEqual(["once", "once"])
    expect(asked().length).toBe(1)
    await turn("Bash rm -rf build", "no")
    expect(asked().length).toBe(2)
    await turn("Write ls", "once")
    expect(asked().length).toBe(3)

    const rules = await h.service.invoke("permission.rules", { sessionId: id }, "r")
    const rule = (rules.result as { rules: Array<{ id: string }> }).rules[0]!
    await h.service.invoke("permission.revoke", { id: rule.id }, "rev")
    await turn("Bash ls", "no")
    expect(asked().length).toBe(4)
  })
})

// Third review: an agent that offers no allow-once option heard its own allow-always, which outlives a revoke on the
// phone. That approval is not listed as a rule the phone could pretend to revoke.
describe("always allow without an allow-once option", () => {
  test("the agent hears its allow-always and no revocable rule is listed", async () => {
    const options = [
      { id: "always", label: "Always allow", kind: "allow_always" },
      { id: "no", label: "Reject", kind: "reject_once" },
    ] as const
    const answers: Array<string | null> = []
    const adapter: AgentAdapter = {
      spec: FAKE_SPEC,
      reply: async (text, ctx) => {
        answers.push(await ctx.askPermission({ tool: "Bash", title: text, detail: text, kind: "execute", options: [...options] }))
      },
    }
    const h = harness(adapter)
    const id = h.store.createSession({ agent: "fake", cwd: h.dir }).id
    const asked = () => h.events.filter((event) => event.name === "permission.asked")
    void h.service.invoke("message.send", { sessionId: id, text: "ls" }, "1")
    await waitFor(() => asked().length === 1)
    await h.service.invoke("permission.respond", { id: String(payload(asked()[0]!).id), optionId: "always" }, "p1")
    await waitFor(() => answers.length === 1)
    expect(answers).toEqual(["always"])
    const rules = await h.service.invoke("permission.rules", { sessionId: id }, "r")
    expect((rules.result as { rules: unknown[] }).rules).toEqual([])
  })
})

// Third review: the revoke and restore answers carried the rule's internal hash to the phone.
describe("rule answers", () => {
  test("revoke and restore send the rule without its match", async () => {
    const options = [
      { id: "once", label: "Allow", kind: "allow_once" },
      { id: "session", label: "Always", kind: "allow_always" },
    ] as const
    const adapter: AgentAdapter = {
      spec: FAKE_SPEC,
      reply: async (text, ctx) => {
        await ctx.askPermission({ tool: "Bash", title: text, detail: text, kind: "execute", options: [...options], match: callMatch("Bash", { command: text }) })
      },
    }
    const h = harness(adapter)
    const id = h.store.createSession({ agent: "fake", cwd: h.dir }).id
    const asked = () => h.events.filter((event) => event.name === "permission.asked")
    void h.service.invoke("message.send", { sessionId: id, text: "ls" }, "1")
    await waitFor(() => asked().length === 1)
    await h.service.invoke("permission.respond", { id: String(payload(asked()[0]!).id), optionId: "session" }, "p1")
    const rules = await h.service.invoke("permission.rules", { sessionId: id }, "r")
    const rule = (rules.result as { rules: Array<{ id: string }> }).rules[0]!
    const revoked = await h.service.invoke("permission.revoke", { id: rule.id }, "rev")
    expect((revoked.result as { rule: Record<string, unknown> }).rule).not.toHaveProperty("match")
    expect((revoked.result as { rule: Record<string, unknown> }).rule).toMatchObject({ id: rule.id, enabled: false })
    const restored = await h.service.invoke("permission.restore", { id: rule.id }, "res")
    expect((restored.result as { rule: Record<string, unknown> }).rule).not.toHaveProperty("match")
  })
})

// Second review: 本会话总是允许 compared the shown summary, which is cut at 400 characters, leaves out Bash's
// dangerouslyDisableSandbox, and is empty for some ACP tools; one approval then let a whole class of calls through.
describe("session rules match the whole call", () => {
  const rule = (fields: Partial<SessionRule>): SessionRule => ({
    id: "r", sessionId: "s", tool: "Bash", command: "npm test", enabled: true, createdAt: 0, ...fields,
  })

  test("a call with other arguments behind the same summary is not covered", () => {
    const allowed = callMatch("Bash", { command: "npm test" })
    const unsandboxed = callMatch("Bash", { command: "npm test", dangerouslyDisableSandbox: true })
    expect(unsandboxed).not.toBe(allowed)
    const rules = [rule({ match: allowed })]
    expect(ruleMatches(rules, "s", "npm test", "Bash", allowed)).toBe(true)
    expect(ruleMatches(rules, "s", "npm test", "Bash", unsandboxed)).toBe(false)
    expect(ruleMatches(rules, "s", "npm test", "Bash")).toBe(false)
  })

  // Third review: the hash took in Claude's per-call free-text description, so the same `npm test` with reworded
  // prose asked again.
  test("a reworded description is the same call; what runs is not", () => {
    const allowed = callMatch("Bash", { command: "npm test", description: "Run the tests", timeout: 60_000 })
    expect(callMatch("Bash", { command: "npm test", description: "Run the test suite", timeout: 60_000 })).toBe(allowed)
    expect(callMatch("Bash", { command: "npm test", timeout: 60_000 })).toBe(allowed)
    expect(callMatch("Bash", { command: "npm test", description: "Run the tests", timeout: 600_000 })).not.toBe(allowed)
    expect(callMatch("Bash", { command: "npm test -- --watch", description: "Run the tests", timeout: 60_000 })).not.toBe(allowed)
  })

  test("key order does not change the match", () => {
    expect(callMatch("Edit", { a: 1, b: { y: 2, x: [1, { q: 1, p: 2 }] } })).toBe(callMatch("Edit", { b: { x: [1, { p: 2, q: 1 }], y: 2 }, a: 1 }))
  })

  test("a rule from before matches covers only requests that carry none", () => {
    const rules = [rule({})]
    expect(ruleMatches(rules, "s", "npm test", "Bash")).toBe(true)
    expect(ruleMatches(rules, "s", "npm test", "Bash", callMatch("Bash", { command: "npm test" }))).toBe(false)
  })
})
