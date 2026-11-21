import { describe, expect, test } from "bun:test"
import { FAKE_SPEC } from "./adapter/fake"
import type { AgentAdapter } from "./adapter/types"
import { SessionService } from "./session-service"
import { NOTICE_PAYLOAD, parseSteer, Store } from "./store"

// The fake adapter never starts a real agent.

function harness() {
  let turn = 0
  const adapter: AgentAdapter = {
    spec: { ...FAKE_SPEC, id: "s", label: "s" },
    async reply(_text, ctx) {
      turn += 1
      ctx.emit({ type: "text", id: `reply-${turn}`, text: `ok ${turn}` })
    },
  }
  const store = new Store(":memory:")
  let unbounded = 0
  const list = store.listMessages.bind(store)
  store.listMessages = (id, options = {}) => {
    if (options.limit === undefined) unbounded += 1
    return list(id, options)
  }
  const service = new SessionService(store, adapter, () => {})
  return {
    store,
    service,
    unbounded: () => unbounded,
    async session() {
      const created = await service.invoke("session.create", { agent: "s", title: "s" }, crypto.randomUUID())
      if (created.type !== "result") throw new Error(created.error?.message ?? "create failed")
      return (created.result as { session: { id: string } }).session.id
    },
    async answer(sessionId: string) {
      const sent = await service.invoke("message.send", { sessionId, text: "go" }, crypto.randomUUID())
      if (sent.type !== "result") throw new Error(sent.error?.message ?? "send failed")
      const started = Date.now()
      while (store.getSession(sessionId)?.status !== "idle") {
        if (Date.now() - started > 3000) throw new Error("turn did not settle")
        await Bun.sleep(5)
      }
    },
  }
}

function steerState(store: Store, id: string) {
  return parseSteer(store.getMessage(id)?.payload ?? null)?.state
}

describe("steer and assistant history reads", () => {
  test("no pending steer reads no unbounded transcript, and each assistant row marks one sent line", async () => {
    const h = harness()
    const id = await h.session()
    await h.answer(id)
    await h.answer(id)
    expect(h.unbounded()).toBe(0)
    expect(h.store.latestSentSteer(id)).toBeNull()

    const second = await h.session()
    const older = h.store.insertMessage({
      id: "steer-old",
      session_id: second,
      kind: "text",
      role: "user",
      text: "older aside",
      payload: JSON.stringify({ steer: "sent" }),
      created_at: 1,
    })
    const newer = h.store.insertMessage({
      id: "steer-new",
      session_id: second,
      kind: "text",
      role: "user",
      text: "newer aside",
      payload: JSON.stringify({ steer: "sent" }),
      created_at: 2,
    })
    await h.answer(second)
    expect(steerState(h.store, newer.id)).toBe("read")
    expect(steerState(h.store, older.id)).toBe("sent")
    await h.answer(second)
    expect(steerState(h.store, older.id)).toBe("read")
    expect(h.unbounded()).toBe(0)
    expect(h.store.assistantTexts(id, undefined, 32).some((row) => row.text.includes("ok"))).toBe(true)
  })

  test("clear and rewind forget a known-empty steer cache and the next row is found again", async () => {
    const h = harness()
    const id = await h.session()
    await h.answer(id)
    const cleared = await h.service.invoke("session.clear", { id }, "clear")
    expect(cleared.type).toBe("result")
    const afterClear = h.store.insertMessage({
      id: "steer-clear",
      session_id: id,
      kind: "text",
      role: "user",
      text: "after clear",
      payload: JSON.stringify({ steer: "sent" }),
      created_at: 3,
    })
    await h.answer(id)
    expect(steerState(h.store, afterClear.id)).toBe("read")

    const kept = h.store.insertMessage({
      id: "steer-keep",
      session_id: id,
      kind: "text",
      role: "user",
      text: "keep",
      payload: JSON.stringify({ steer: "sent" }),
      created_at: 4,
    })
    const rewound = await h.service.invoke("session.rewind", { id, seq: kept.seq }, "rw")
    expect(rewound.type).toBe("result")
    const afterRewind = h.store.insertMessage({
      id: "steer-rewind",
      session_id: id,
      kind: "text",
      role: "user",
      text: "after rewind",
      payload: JSON.stringify({ steer: "sent" }),
      created_at: 5,
    })
    await h.answer(id)
    expect(steerState(h.store, afterRewind.id)).toBe("read")
    expect(h.unbounded()).toBe(0)
    const notice = h.store.insertMessage({
      id: "notice",
      session_id: id,
      kind: "text",
      role: "assistant",
      text: "   ",
      payload: NOTICE_PAYLOAD,
      created_at: 6,
    })
    expect(h.store.assistantTexts(id, undefined, 32).some((row) => row.seq === notice.seq)).toBe(false)
  })
})
