import { describe, expect, test } from "bun:test"
import { createFakeAdapter, FAKE_NATIVE_PREFIX, FAKE_SPEC } from "./adapter/fake"
import type { AdapterContext, AgentAdapter } from "./adapter/types"
import type { Frame } from "./protocol"
import { EXPORT_LIMIT_BYTES, SessionService } from "./session-service"
import { Store } from "./store"

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

// Holds every turn open until release() is called.
function gated() {
  const releases: Array<() => void> = []
  const adapter: AgentAdapter = {
    spec: { ...FAKE_SPEC, id: "s", label: "s" },
    reply: (_text, ctx) =>
      new Promise<void>((resolve) => {
        ctx.emit({ type: "text", id: crypto.randomUUID(), text: "working" })
        releases.push(resolve)
      }),
  }
  return { adapter, release: () => releases.shift()?.() }
}

function harness(adapter: AgentAdapter = createFakeAdapter()) {
  const store = new Store(":memory:")
  const events: Frame[] = []
  const service = new SessionService(store, adapter, (frame) => events.push(frame))
  const idle = (id: string) =>
    events.filter((event) => event.name === "agent.status" && payload(event).sessionId === id && payload(event).status === "idle").length
  return { store, events, service, idle }
}

describe("session metadata", () => {
  test("snapshot rereads session metadata after a suspended steer probe", async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<"ok">()
    const h = harness({
      spec: { ...FAKE_SPEC, id: "grok" },
      reply: async () => {},
      probeSteer: async () => {
        entered.resolve()
        return release.promise
      },
    })
    const id = h.store.createSession({ agent: "grok" }).id
    const reading = h.service.invoke("session.get", { id, markRead: false }, "reading")
    await entered.promise
    const pin = await h.service.invoke("session.patch", { id, pinned: true }, "pin")
    release.resolve("ok")
    const read = await reading
    expect(pin.type).toBe("result")
    expect(read.result).toMatchObject({ session: { pinned: true, version: h.store.getSession(id)?.version } })
  })

  test("reopen preserves the status of an archived live session", async () => {
    const h = harness()
    for (const status of ["idle", "running", "waiting"] as const) {
      const id = h.store.createSession({ agent: "s" }).id
      h.store.patchSession(id, { archived: true, status })
      const reopened = await h.service.invoke("session.reopen", { id }, "reopen")
      expect(reopened.result).toMatchObject({ session: { status, archived: false } })
    }
  })
})

describe("scheduled sends", () => {
  test("a job due while the session is busy stays pending and fires on a later tick", async () => {
    const gate = gated()
    const h = harness(gate.adapter)
    const id = h.store.createSession({ agent: "s" }).id
    await h.service.invoke("message.send", { sessionId: id, text: "first" }, "1")
    const job = h.store.insertScheduled({ id: crypto.randomUUID(), session_id: id, text: "later", fire_at: 1 })
    await h.service.tickScheduled()
    expect(h.store.listScheduled(id)[0]?.status).toBe("pending")
    expect(h.store.listMessages(id).some((row) => row.text === "later")).toBe(false)
    gate.release()
    await waitFor(() => h.idle(id) >= 1)
    await h.service.tickScheduled()
    expect(h.store.listScheduled(id).find((row) => row.id === job.id)?.status).toBe("sent")
    expect(h.store.listMessages(id).some((row) => row.text === "later")).toBe(true)
    gate.release()
    await waitFor(() => h.idle(id) >= 2)
  })

  test("cancel and claim only move a pending job", async () => {
    const h = harness()
    const id = h.store.createSession({ agent: "s" }).id
    const job = h.store.insertScheduled({ id: crypto.randomUUID(), session_id: id, text: "later", fire_at: Date.now() + 60_000 })
    expect(h.store.claimScheduled(job.id, "sent")?.status).toBe("sent")
    expect(h.store.claimScheduled(job.id, "cancelled")).toBeNull()
    const cancel = await h.service.invoke("scheduled.cancel", { id: job.id }, "c1")
    expect(cancel.error?.code).toBe("conflict")
    expect(h.store.listScheduled(id)[0]?.status).toBe("sent")
    const missing = await h.service.invoke("scheduled.cancel", { id: "nope" }, "c2")
    expect(missing.error?.code).toBe("not_found")
  })
})

describe("session mutation ownership", () => {
  for (const method of ["session.clear", "session.rewind"]) {
    test(`${method} fences sends while waiting for the old turn to settle`, async () => {
      const h = harness({ spec: { ...FAKE_SPEC, id: "s" }, reply: async () => {} })
      const id = h.store.createSession({ agent: "s" }).id
      const other = h.store.createSession({ agent: "s" }).id
      h.store.insertMessage({ id: crypto.randomUUID(), session_id: id, kind: "text", role: "user", text: "keep", created_at: 1 })
      const settled = h.service.turnSettled.bind(h.service)
      const barrier = Promise.withResolvers<void>()
      const entered = Promise.withResolvers<void>()
      h.service.turnSettled = async (sessionId) => {
        if (sessionId === id) {
          entered.resolve()
          await barrier.promise
        }
        await settled(sessionId)
      }

      const mutation = h.service.invoke(method, { id, seq: 1 }, "mutation")
      await entered.promise
      const due = h.store.insertScheduled({ id: crypto.randomUUID(), session_id: id, text: "scheduled", fire_at: 1 })
      await h.service.tickScheduled()
      expect(h.store.listScheduled(id).find((row) => row.id === due.id)?.status).toBe("pending")
      const [send, independent] = await Promise.all([
        h.service.invoke("message.send", { sessionId: id, text: "new prompt" }, "send"),
        h.service.invoke("message.send", { sessionId: other, text: "independent" }, "other"),
      ])
      barrier.resolve()
      expect((await mutation).type).toBe("result")
      expect(independent.type).toBe("result")
      expect(send.error?.code).toBe("busy")
      expect(h.store.listMessages(id).map((row) => row.text)).toEqual(method === "session.clear" ? [] : ["keep"])
      const retry = { sessionId: id, text: "new prompt", clientMessageId: crypto.randomUUID() }
      for (const request of ["retry", "duplicate"]) {
        expect((await h.service.invoke("message.send", retry, request)).type).toBe("result")
      }
      await waitFor(() => h.idle(id) > 0 && h.idle(other) > 0)
      expect(h.store.listMessages(id).filter((row) => row.text === "new prompt")).toHaveLength(1)
    })
  }

  test("an accepted prompt survives a subsequent destructive request", async () => {
    const gate = gated()
    const h = harness(gate.adapter)
    const id = h.store.createSession({ agent: "s" }).id
    const accepted = await h.service.invoke("message.send", { sessionId: id, text: "accepted" }, "send")
    expect(accepted.type).toBe("result")
    expect((await h.service.invoke("session.clear", { id }, "clear")).error?.code).toBe("busy")
    expect((await h.service.invoke("session.rewind", { id, seq: 1 }, "rewind")).error?.code).toBe("busy")
    expect(h.store.listMessages(id)[0]?.text).toBe("accepted")
    await waitFor(() => h.store.listMessages(id).some((row) => row.text === "working"))
    gate.release()
    await waitFor(() => h.idle(id) > 0)
  })

  test("an old execution cannot publish into a replaced transcript generation", async () => {
    const entered = Promise.withResolvers<AdapterContext>()
    const release = Promise.withResolvers<void>()
    const h = harness({
      spec: { ...FAKE_SPEC, id: "s", label: "s" },
      reply: async (_text, ctx) => {
        entered.resolve(ctx)
        await release.promise
      },
    })
    const id = h.store.createSession({ agent: "s" }).id
    expect((await h.service.invoke("message.send", { sessionId: id, text: "old" }, "send")).type).toBe("result")
    const ctx = await entered.promise
    h.store.clearMessages(id)
    try {
      await ctx.emit({ type: "native", nativeId: "obsolete-native" })
      await ctx.emit({ type: "text", id: crypto.randomUUID(), text: "obsolete text" })
      expect(h.store.getSession(id)?.native_id).toBeNull()
      expect(h.store.listMessages(id)).toHaveLength(0)
      expect(h.events.some((frame) => frame.name === "message.append" && payload(frame).text === "obsolete text")).toBe(false)
    } finally {
      release.resolve()
    }
    await waitFor(() => h.idle(id) > 0)
  })

  test("an in-flight queue steer owns the session after the turn stops", async () => {
    const replyStarted = Promise.withResolvers<void>()
    const replyDone = Promise.withResolvers<void>()
    const steering = Promise.withResolvers<void>()
    const answered = Promise.withResolvers<boolean>()
    const h = harness({
      spec: { ...FAKE_SPEC, id: "codex", capabilities: { ...FAKE_SPEC.capabilities, steer: true } },
      reply: async () => {
        replyStarted.resolve()
        await replyDone.promise
      },
      steer: async () => {
        steering.resolve()
        return answered.promise
      },
    })
    const id = h.store.createSession({ agent: "codex" }).id
    await h.service.invoke("message.send", { sessionId: id, text: "first" }, "send")
    await replyStarted.promise
    const queued = await h.service.invoke("message.send", { sessionId: id, text: "queued" }, "queue")
    const item = (queued.result as { queued: { id: string } }).queued
    const pending = h.service.invoke("queue.steer", { sessionId: id, id: item.id }, "steer")
    await steering.promise
    try {
      const stop = await h.service.invoke("message.steer", { sessionId: id, action: "cancel" }, "stop")
      expect(stop.type).toBe("result")
      replyDone.resolve()
      await waitFor(() => h.idle(id) > 0)
      const clear = await h.service.invoke("session.clear", { id }, "clear")
      expect(clear.error?.code).toBe("busy")
    } finally {
      replyDone.resolve()
      answered.resolve(true)
      await pending
    }
    expect((await h.service.invoke("session.clear", { id }, "retry")).type).toBe("result")
    expect(h.store.listMessages(id)).toHaveLength(0)
  })

  test("a due usage-limit resume stays pending until the running mutation settles", async () => {
    const h = harness()
    const id = h.store.createSession({ agent: "s" }).id
    const held = Promise.withResolvers<void>()
    h.service.turnSettled = () => held.promise
    const clear = h.service.invoke("session.clear", { id }, "clear")
    h.store.setLimitResume(id, "earlier-turn", Date.now())
    try {
      h.service["fireLimitResume"](id, "earlier-turn")
      expect(h.store.getLimitResume(id)?.turn_id).toBe("earlier-turn")
    } finally {
      held.resolve()
      await clear
    }
    expect(h.store.getLimitResume(id)).toBeNull()
  })

  test("a failed mutation releases the session for the next send", async () => {
    const h = harness()
    const id = h.store.createSession({ agent: "s" }).id
    h.service.turnSettled = async () => { throw new Error("settlement failed") }
    expect((await h.service.invoke("session.clear", { id }, "clear")).type).toBe("error")
    expect((await h.service.invoke("message.send", { sessionId: id, text: "not blocked" }, "send")).type).toBe("result")
    await waitFor(() => h.idle(id) > 0)
  })
})

describe("rewind", () => {
  test("clear and rewind broadcast their committed transcript generation", async () => {
    const h = harness()
    const id = h.store.createSession({ agent: "s" }).id
    h.store.insertMessage({ id: crypto.randomUUID(), session_id: id, kind: "text", role: "user", text: "keep", created_at: 1 })
    expect((await h.service.invoke("session.rewind", { id, seq: 1 }, "rewind")).type).toBe("result")
    expect((await h.service.invoke("session.clear", { id }, "clear")).type).toBe("result")
    const invalidations = h.events.filter((event) => event.name === "message.invalidate").map(payload)
    expect(invalidations).toEqual([
      { sessionId: id, reason: "rewind", generation: 1 },
      { sessionId: id, reason: "clear", generation: 2 },
    ])
  })

  test("seq must be a finite integer of at least 1", async () => {
    const h = harness()
    const id = h.store.createSession({ agent: "s" }).id
    h.store.insertMessage({ id: crypto.randomUUID(), session_id: id, kind: "text", role: "user", text: "keep", created_at: 1 })
    for (const seq of [undefined, 0, -1, 1.5, "x", null, Number.POSITIVE_INFINITY]) {
      const frame = await h.service.invoke("session.rewind", { id, seq }, "r")
      expect(frame.error?.code).toBe("invalid")
    }
    expect(h.store.listMessages(id)).toHaveLength(1)
  })

  test("rewind drops the agent-native session so the agent context matches the transcript", async () => {
    const h = harness()
    const id = h.store.createSession({ agent: "s" }).id
    await h.service.invoke("message.send", { sessionId: id, text: "one" }, "1")
    await waitFor(() => h.idle(id) >= 1)
    expect(h.store.getSession(id)?.native_id).toBe(`${FAKE_NATIVE_PREFIX}${id}`)
    const rewound = await h.service.invoke("session.rewind", { id, seq: 1 }, "r1")
    expect(rewound.type).toBe("result")
    expect(h.store.getSession(id)?.native_id).toBeNull()
  })
})

describe("fork", () => {
  test("refuses while a turn is running", async () => {
    const gate = gated()
    const h = harness(gate.adapter)
    const id = h.store.createSession({ agent: "s" }).id
    await h.service.invoke("message.send", { sessionId: id, text: "go" }, "1")
    const forked = await h.service.invoke("session.fork", { id }, "f1")
    expect(forked.error?.code).toBe("busy")
    gate.release()
    await waitFor(() => h.idle(id) >= 1)
    const later = await h.service.invoke("session.fork", { id }, "f2")
    expect(later.type).toBe("result")
  })
})

describe("adapter forget", () => {
  test("clear, rewind and delete tell the adapter to drop its per-session state", async () => {
    const forgotten: string[] = []
    const adapter = Object.assign(
      { spec: { ...FAKE_SPEC, id: "s", label: "s" }, reply: async () => {} } satisfies AgentAdapter,
      { forget: (sessionId: string) => void forgotten.push(sessionId) },
    )
    const h = harness(adapter)
    const id = h.store.createSession({ agent: "s" }).id
    h.store.insertMessage({ id: crypto.randomUUID(), session_id: id, kind: "text", role: "user", text: "a", created_at: 1 })
    await h.service.invoke("session.rewind", { id, seq: 1 }, "r")
    await h.service.invoke("session.clear", { id }, "c")
    await h.service.invoke("session.delete", { id }, "d")
    expect(forgotten).toEqual([id, id, id])
  })
})

describe("export and fork read the transcript in pages", () => {
  const fill = (store: Store, id: string, count: number, text = (i: number) => `line ${i}`) => {
    for (let i = 0; i < count; i++) {
      store.insertMessage({ id: crypto.randomUUID(), session_id: id, kind: "text", role: i % 2 ? "assistant" : "user", text: text(i), created_at: i })
    }
  }
  // listMessages(id) with no bound loads the whole session at once.
  const forbidUnbounded = (store: Store) => {
    const list = store.listMessages.bind(store)
    store.listMessages = (sessionId, options = {}) => {
      if (options.limit === undefined && options.beforeSeq === undefined) throw new Error("unbounded listMessages")
      return list(sessionId, options)
    }
  }

  test("a long session exports and forks whole and in order without loading it at once", async () => {
    const h = harness()
    const id = h.store.createSession({ title: "long" }).id
    fill(h.store, id, 1205)
    forbidUnbounded(h.store)
    const exported = await h.service.invoke("session.export", { id }, "e")
    expect(exported.type).toBe("result")
    const result = exported.result as { markdown: string; truncated?: boolean }
    expect(result.truncated).toBe(false)
    expect(result.markdown.match(/^## /gm)?.length).toBe(1205)
    expect(result.markdown.indexOf("line 0\n")).toBeLessThan(result.markdown.indexOf("line 1204\n"))
    const forked = await h.service.invoke("session.fork", { id }, "f")
    expect(forked.type).toBe("result")
    const copy = (forked.result as { session: { id: string } }).session.id
    expect(h.store.listMessages(copy, { limit: 5000 }).map((row) => row.text)).toEqual(Array.from({ length: 1205 }, (_, i) => `line ${i}`))
  })

  test("an export past the frame budget stops at a whole message and says so", async () => {
    const h = harness()
    const id = h.store.createSession({ title: "huge" }).id
    fill(h.store, id, 40, () => "y".repeat(256 * 1024))
    const exported = await h.service.invoke("session.export", { id }, "e")
    const result = exported.result as { markdown: string; truncated: boolean }
    expect(result.truncated).toBe(true)
    expect(Buffer.byteLength(result.markdown)).toBeLessThanOrEqual(EXPORT_LIMIT_BYTES)
    expect(result.markdown.endsWith("y\n")).toBe(false)
  })
})

// 2026-11-12 (perf-1112 R6): server.ts ran tickScheduled every second whether or not anything was scheduled.
describe("scheduler timer", () => {
  test("no pending job arms no timer; a job is fired once, when due, and leaves none behind", async () => {
    const h = harness()
    let ticks = 0
    const tick = h.service.tickScheduled.bind(h.service)
    h.service.tickScheduled = () => {
      ticks += 1
      return tick()
    }
    const armed = () => (h.service as unknown as { scheduler: { timer: unknown } | null }).scheduler?.timer ?? null
    h.service.startScheduler()
    expect(armed()).toBeNull()
    await Bun.sleep(1200)
    expect(ticks).toBe(0)
    const id = h.store.createSession({ agent: "fake" }).id
    await h.service.invoke("message.send", { sessionId: id, text: "later", fireAt: Date.now() + 600 }, "1")
    expect(armed()).not.toBeNull()
    await waitFor(() => h.store.listMessages(id).some((row) => row.text === "later"), 3000)
    expect(ticks).toBe(1)
    expect(armed()).toBeNull()
    h.service.stopScheduler()
  })
})
