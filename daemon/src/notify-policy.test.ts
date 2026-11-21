import { describe, expect, test } from "bun:test"
import type { AgentAdapter } from "./adapter/types"
import { FAKE_SPEC } from "./adapter/fake"
import { DONE_WINDOW_MS, NotifyPolicy } from "./notify-policy"
import { openPush, PushNotifier, type PushPayload } from "./push"
import { SessionService } from "./session-service"
import { Store } from "./store"

const TICKET = "dGlja2V0LWZvci1waG9uZS1vbmU"

function done(sessionId: string, title: string, changes = { added: 1, removed: 0, files: 1 }, outcome: PushPayload["outcome"] = "done"): PushPayload {
  return { v: 1, kind: "done", sessionId, title, body: "好了。", agent: "Claude Code", machine: "mac-studio", outcome, changes }
}

function policy(start = 1_000) {
  const clock = { now: start }
  let ids = 0
  return { clock, policy: new NotifyPolicy({ now: () => clock.now, newId: () => `w${++ids}` }) }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out")
    await Bun.sleep(5)
  }
}

describe("NotifyPolicy: the done window (v67 A4)", () => {
  test("one, two, three finished sessions in a window: done, then doneBatch under the same collapse id, ringing once", () => {
    const { clock, policy: p } = policy()
    const first = p.turnEnded(done("a", "修复登录跳转", { added: 26, removed: 2, files: 3 }), { stoppedByUser: false })
    expect(first?.payload.kind).toBe("done")
    expect(first?.collapseId).toBe("done-w-w1")
    expect(first?.sound).toBe(true)

    clock.now += 30_000
    const second = p.turnEnded(done("b", "迁移脚本", { added: 40, removed: 10, files: 4 }), { stoppedByUser: false })
    expect(second?.payload).toMatchObject({ kind: "doneBatch", count: 2, added: 66, removed: 12, files: 7, sessionId: "" })
    expect(second?.collapseId).toBe("done-w-w1")
    expect(second?.sound).toBe(false)

    clock.now += 60_000
    const third = p.turnEnded(done("c", "拆会话层", { added: 5, removed: 6, files: 2 }), { stoppedByUser: false })
    expect(third?.payload).toMatchObject({ kind: "doneBatch", count: 3, added: 71, removed: 18, files: 9 })
    expect(third?.payload.sessions?.map((entry) => entry.title)).toEqual(["修复登录跳转", "迁移脚本", "拆会话层"])
    expect(third?.collapseId).toBe("done-w-w1")
    expect(third?.sound).toBe(false)
    // An extension older than v67 still reads something.
    expect(third?.payload.title).toBe("3 个会话做完了")
  })

  test("the window starts at the first and does not slide", () => {
    const { clock, policy: p } = policy()
    p.turnEnded(done("a", "A"), { stoppedByUser: false })
    clock.now += DONE_WINDOW_MS - 1
    expect(p.turnEnded(done("b", "B"), { stoppedByUser: false })?.payload.kind).toBe("doneBatch")
    clock.now += 1
    const fresh = p.turnEnded(done("c", "C"), { stoppedByUser: false })
    expect(fresh?.payload.kind).toBe("done")
    expect(fresh?.collapseId).toBe("done-w-w2")
    expect(fresh?.sound).toBe(true)
  })

  test("the same session finishing twice is still one session: a done that replaces the first", () => {
    const { policy: p } = policy()
    p.turnEnded(done("a", "A"), { stoppedByUser: false })
    const again = p.turnEnded(done("a", "A", { added: 2, removed: 0, files: 1 }), { stoppedByUser: false })
    expect(again?.payload.kind).toBe("done")
    expect(again?.collapseId).toBe("done-w-w1")
    const other = p.turnEnded(done("b", "B"), { stoppedByUser: false })
    expect(other?.payload).toMatchObject({ kind: "doneBatch", count: 2, added: 3 })
  })

  test("a failure is never folded in and rings on its own", () => {
    const { policy: p } = policy()
    p.turnEnded(done("a", "A"), { stoppedByUser: false })
    const failed = p.turnEnded(done("b", "B", undefined, "failed"), { stoppedByUser: false })
    expect(failed?.payload.kind).toBe("done")
    expect(failed?.payload.outcome).toBe("failed")
    expect(failed?.collapseId).toBe("done-b")
    expect(failed?.sound).toBe(true)
    // The window still holds only A: the next done makes a batch of two, not three.
    expect(p.turnEnded(done("c", "C"), { stoppedByUser: false })?.payload.count).toBe(2)
  })

  test("a turn the user stopped is not told", () => {
    const { policy: p } = policy()
    expect(p.turnEnded(done("a", "A", undefined, "interrupted"), { stoppedByUser: true })).toBeNull()
  })

  test("a batch lists at most five sessions but counts them all", () => {
    const { policy: p } = policy()
    let last: ReturnType<NotifyPolicy["turnEnded"]> = null
    for (let index = 0; index < 7; index++) last = p.turnEnded(done(`s${index}`, `T${index}`), { stoppedByUser: false })
    expect(last?.payload.count).toBe(7)
    expect(last?.payload.sessions).toHaveLength(5)
  })
})

describe("device prefs (v67 A5)", () => {
  function store(...prefs: Array<string | null>) {
    const made = new Store(":memory:")
    for (const [index, pref] of prefs.entries()) {
      made.putDevice({ id: `d${index}`, session_key: index.toString(16).padStart(64, "b"), name: "phone", created_at: index, push_token: TICKET })
      made.setDevicePushPrefs(index.toString(16).padStart(64, "b"), pref)
    }
    return made
  }

  function gateway() {
    const calls: { ticket: string; ciphertext: string; collapseId?: string }[] = []
    const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({ ok: true }))
    }) as typeof globalThis.fetch
    return { calls, fetch }
  }

  test("done: false gets no done or doneBatch, but still every permission", async () => {
    const devices = store(JSON.stringify({ done: false }), null)
    const { calls, fetch } = gateway()
    const notifier = new PushNotifier(devices, { gateway: "https://g", fetch })
    await notifier.notify(done("a", "A"), { collapseId: "done-w-x" })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.collapseId).toBe("done-w-x")
    expect(openPush(devices.listDevices()[1]!.session_key, calls[0]!.ciphertext).kind).toBe("done")
    await notifier.notify({ v: 1, kind: "doneBatch", sessionId: "", title: "2", body: "", count: 2 })
    expect(calls).toHaveLength(2)
    await notifier.notify({ v: 1, kind: "permission", sessionId: "a", title: "A", body: "Bash: ls", permissionId: "p" })
    expect(calls).toHaveLength(4)
  })

  test("device.registerPush stores prefs; an app that sends none keeps them", async () => {
    const devices = new Store(":memory:")
    devices.putDevice({ id: "d", session_key: "k", name: "phone", created_at: 0, push_token: null })
    const adapter: AgentAdapter = { spec: { ...FAKE_SPEC, id: "s", label: "s" }, reply: async () => {} }
    const svc = new SessionService(devices, adapter, () => {}, { push: () => {} })
    await svc.invoke("device.registerPush", { ticket: TICKET, prefs: { done: false } }, "r", { deviceKey: "k" })
    expect(devices.listDevices()[0]!.push_prefs).toBe('{"done":false}')
    await svc.invoke("device.registerPush", { ticket: TICKET }, "r", { deviceKey: "k" })
    expect(devices.listDevices()[0]!.push_prefs).toBe('{"done":false}')
    await svc.invoke("device.registerPush", { ticket: TICKET, prefs: { done: true } }, "r", { deviceKey: "k" })
    expect(devices.listDevices()[0]!.push_prefs).toBe('{"done":true}')
    const refused = await svc.invoke("device.registerPush", { ticket: TICKET, prefs: { done: "no" } }, "r", { deviceKey: "k" })
    expect(refused.error?.code).toBe("invalid")
  })

  test("device.registerPush keeps liveStart until null withdraws it (r70 1.2a)", async () => {
    const devices = new Store(":memory:")
    devices.putDevice({ id: "d", session_key: "k", name: "phone", created_at: 0, push_token: null })
    const adapter: AgentAdapter = { spec: { ...FAKE_SPEC, id: "s", label: "s" }, reply: async () => {} }
    const svc = new SessionService(devices, adapter, () => {}, { push: () => {} })
    const liveStart = { token: "ef".repeat(40), accountId: "acct", hue: 12, locale: "en", keepSeconds: 3600 }
    await svc.invoke("device.registerPush", { ticket: TICKET, liveStart }, "r", { deviceKey: "k" })
    expect(JSON.parse(devices.listDevices()[0]!.live_start!)).toEqual(liveStart)
    await svc.invoke("device.registerPush", { ticket: TICKET }, "r", { deviceKey: "k" })
    expect(devices.listDevices()[0]!.live_start).not.toBeNull()
    await svc.invoke("device.registerPush", { ticket: TICKET, liveStart: null }, "r", { deviceKey: "k" })
    expect(devices.listDevices()[0]!.live_start).toBeNull()
    const refused = await svc.invoke("device.registerPush", { ticket: TICKET, liveStart: { token: "x" } }, "r", { deviceKey: "k" })
    expect(refused.error?.code).toBe("invalid")
  })
})

describe("what rudderd does not push (v67 A3)", () => {
  test("background tasks finishing one by one, steps and a stopped turn push nothing; the turn's end pushes once", async () => {
    const pushed: PushPayload[] = []
    let hold = false
    const adapter: AgentAdapter = {
      spec: { ...FAKE_SPEC, id: "s", label: "s" },
      async reply(_text, ctx) {
        if (hold) {
          await new Promise((resolve) => ctx.signal.addEventListener("abort", resolve, { once: true }))
          return
        }
        const task = { id: "b1", kind: "command" as const, title: "watch", startedAt: Date.now() }
        ctx.emit({ type: "tool", id: "t1", tool: "Bash", title: "bun test", kind: "execute", status: "running", detail: "bun test" })
        ctx.emit({ type: "background", open: 1, paused: false, tasks: [{ ...task, status: "running" }] })
        ctx.emit({ type: "background", open: 0, paused: false, tasks: [{ ...task, status: "done", endedAt: Date.now() }] })
        ctx.emit({ type: "tool", id: "t1", tool: "Bash", title: "bun test", kind: "execute", status: "completed", detail: "bun test" })
        ctx.emit({ type: "text", id: "r1", text: "全部通过。" })
      },
    }
    const svc = new SessionService(new Store(":memory:"), adapter, () => {}, { push: (payload) => pushed.push(payload) })
    const created = await svc.invoke("session.create", { title: "t", agent: "s" }, "c")
    const sessionId = (created.result as { session: { id: string } }).session.id
    await svc.invoke("message.send", { sessionId, text: "go" }, "m")
    await waitFor(() => pushed.length === 1)
    await Bun.sleep(30)
    expect(pushed.map((payload) => payload.kind)).toEqual(["done"])

    hold = true
    await svc.invoke("message.send", { sessionId, text: "long" }, "m2")
    await svc.invoke("message.steer", { sessionId, action: "cancel" }, "s")
    await Bun.sleep(50)
    expect(pushed).toHaveLength(1)
  })
})
