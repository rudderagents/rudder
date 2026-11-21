import { describe, expect, test } from "bun:test"
import type { AdapterRegistry } from "./adapter"
import { createFakeAdapter, FAKE_SPEC } from "./adapter/fake"
import type { AdapterContext, AgentAdapter } from "./adapter/types"
import type { Frame } from "./protocol"
import { SessionService } from "./session-service"
import { Store } from "./store"

async function waitFor(predicate: () => boolean, timeoutMs = 2000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out")
    await Bun.sleep(5)
  }
}

type Seen = { agent: string; text: string; nativeId?: string }

// Two fake agents that record what each turn was sent; `hold` keeps a turn open until released.
function harness(options: { codexAvailable?: boolean; detectCodex?: AgentAdapter["detect"] } = {}) {
  const seen: Seen[] = []
  const releases: Array<() => void> = []
  let hold = false
  const agent = (id: string, extra: Partial<AgentAdapter> = {}): AgentAdapter => {
    const fake = createFakeAdapter({ ...FAKE_SPEC, id, label: id === "claude" ? "Claude" : "Codex" })
    return {
      ...fake,
      ...extra,
      reply: async (text: string, ctx: AdapterContext) => {
        seen.push({ agent: id, text, nativeId: ctx.nativeId })
        if (hold) await new Promise<void>((resolve) => releases.push(resolve))
        return fake.reply("ok", ctx)
      },
    }
  }
  const claude = agent("claude")
  const codex = agent("codex", {
    detect: options.detectCodex ?? (async () => (options.codexAvailable === false ? { available: false, reason: "not installed" } : { available: true })),
    listModels: async () => [{ id: "gpt-5.5", label: "GPT-5.5" }] as never,
  })
  const registry: AdapterRegistry = { get: (id) => (id === "claude" ? claude : id === "codex" ? codex : undefined), list: () => [claude, codex] }
  const store = new Store(":memory:")
  const events: Frame[] = []
  const service = new SessionService(store, registry, (frame) => events.push(frame))
  const idle = (id: string) =>
    events.filter((event) => {
      const payload = (event.payload ?? {}) as Record<string, unknown>
      return event.name === "agent.status" && payload.sessionId === id && payload.status === "idle"
    }).length
  const turn = async (id: string, text: string) => {
    const before = idle(id)
    const sent = await service.invoke("message.send", { sessionId: id, text }, crypto.randomUUID())
    expect(sent.error).toBeUndefined()
    if (!hold) await waitFor(() => idle(id) > before)
  }
  const switchTo = (id: string, agentId: string, model = "") => service.invoke("session.switchAgent", { id, agent: agentId, model }, crypto.randomUUID())
  return {
    store,
    events,
    service,
    seen,
    turn,
    switchTo,
    holdTurns: (on: boolean) => {
      hold = on
    },
    release: () => releases.shift()?.(),
    idle,
  }
}

describe("switching agents mid-session (r72)", () => {
  test("a suspended switch fences a send without delaying stop", async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const h = harness({ detectCodex: async () => {
      entered.resolve()
      await release.promise
      return { available: true }
    } })
    const id = h.store.createSession({ agent: "claude" }).id
    const switching = h.switchTo(id, "codex")
    await entered.promise
    const send = await h.service.invoke("message.send", { sessionId: id, text: "racing" }, "send")
    const stop = await h.service.invoke("background.stop", { sessionId: id }, "stop")
    release.resolve()
    expect((await switching).type).toBe("result")
    expect(stop.type).toBe("result")
    expect(send.error?.code).toBe("busy")
    await h.turn(id, "after the switch")
    expect(h.seen.map((turn) => turn.agent)).toEqual(["codex"])
  })

  test("the next turn on the new agent carries the whole conversation, once, without the notice", async () => {
    const h = harness()
    const id = h.store.createSession({ agent: "claude" }).id
    await h.turn(id, "remember PINEAPPLE")
    await h.turn(id, "second")
    expect(h.store.getSession(id)?.native_id).not.toBeNull()

    const switched = await h.switchTo(id, "codex", "gpt-5.5")
    expect(switched.error).toBeUndefined()
    const row = h.store.getSession(id)!
    expect(row.agent).toBe("codex")
    expect(row.model).toBe("gpt-5.5")
    expect(row.native_id).toBeNull()
    const notice = h.store.listMessages(id).at(-1)!
    expect(JSON.parse(notice.payload ?? "{}")).toEqual({
      notice: true,
      agentSwitch: { from: { agent: "claude", model: "" }, to: { agent: "codex", model: "gpt-5.5" } },
    })
    expect(h.events.some((event) => event.name === "message.append")).toBe(true)

    await h.turn(id, "what did I ask you to remember?")
    const first = h.seen.at(-1)!
    expect(first.agent).toBe("codex")
    expect(first.nativeId).toBeUndefined()
    expect(first.text).toContain("<earlier-conversation>")
    expect(first.text).toContain("User: remember PINEAPPLE")
    expect(first.text).toContain("User: second")
    expect(first.text).not.toContain("Switched to")
    expect(first.text.endsWith("what did I ask you to remember?")).toBe(true)
    expect(h.store.getSession(id)?.carry_seq ?? 0).toBe(0)

    await h.turn(id, "plain")
    expect(h.seen.at(-1)!.text).toBe("plain")
  })

  test("switching back carries the other agent's turns too", async () => {
    const h = harness()
    const id = h.store.createSession({ agent: "claude" }).id
    await h.turn(id, "one on claude")
    await h.switchTo(id, "codex")
    await h.turn(id, "two on codex")
    expect((await h.switchTo(id, "claude")).error).toBeUndefined()
    await h.turn(id, "three")
    const sent = h.seen.at(-1)!
    expect(sent.agent).toBe("claude")
    expect(sent.text).toContain("User: one on claude")
    expect(sent.text).toContain("User: two on codex")
  })

  test("a switch right after a rewind still carries what the rewind kept", async () => {
    const h = harness()
    const id = h.store.createSession({ agent: "claude" }).id
    await h.turn(id, "keep me")
    await h.turn(id, "drop me")
    const kept = h.store.listMessages(id).filter((row) => row.role === "user")[1]!.seq - 1
    await h.service.invoke("session.rewind", { id, seq: kept }, "r1")
    await h.switchTo(id, "codex")
    await h.turn(id, "next")
    const sent = h.seen.at(-1)!.text
    expect(sent).toContain("User: keep me")
    expect(sent).not.toContain("User: drop me")
  })

  test("refuses while a turn runs, for the same agent, an unknown or unavailable agent, or an unknown model", async () => {
    const h = harness({ codexAvailable: false })
    const id = h.store.createSession({ agent: "claude" }).id
    expect((await h.switchTo(id, "claude")).error?.code).toBe("invalid")
    expect((await h.switchTo(id, "gemini")).error?.code).toBe("invalid")
    expect((await h.switchTo(id, "codex")).error?.code).toBe("unavailable")
    expect((await h.switchTo("missing", "codex")).error?.code).toBe("not_found")

    const ok = harness()
    const busy = ok.store.createSession({ agent: "claude" }).id
    expect((await ok.switchTo(busy, "codex", "gpt-9")).error?.code).toBe("invalid")
    ok.holdTurns(true)
    await ok.turn(busy, "long")
    await waitFor(() => ok.seen.length === 1)
    expect((await ok.switchTo(busy, "codex")).error?.code).toBe("busy")
    expect(ok.store.getSession(busy)?.agent).toBe("claude")
    ok.release()
    await waitFor(() => ok.idle(busy) >= 1)
  })
})
