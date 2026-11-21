import { describe, expect, test } from "bun:test"
import { FAKE_SPEC } from "./adapter/fake"
import type { AgentAdapter, PermissionRequest } from "./adapter/types"
import { LiveActivityNotifier } from "./live-activity"
import type { Frame } from "./protocol"
import type { PushPayload } from "./push"
import { SessionService } from "./session-service"
import { type DeviceRow, Store } from "./store"

// r68 0-3: a card that cannot be pushed must not swallow the permission notification, and a 410 says whether the
// ticket or only the card is gone.

const SESSION_KEY = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
const TICKET = "ticket-one-aaaaaaaaaaaa"
const ACTIVITY = "ab".repeat(32)
const RUN_OPTIONS: PermissionRequest["options"] = [{ id: "yes", label: "Yes", kind: "allow_once" }]

type Reply = { status: number; body?: Record<string, unknown> }

async function waitFor(predicate: () => boolean, timeoutMs = 2000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out")
    await Bun.sleep(5)
  }
}

/** One session whose turn asks a permission and then holds until answered; the gateway answers with `respond`. */
async function scenario(respond: (body: Record<string, unknown>) => Reply, options: { ticket?: string | null } = {}) {
  const store = new Store(":memory:")
  const posts: Record<string, unknown>[] = []
  const logs: string[] = []
  const dropped: { device: DeviceRow; reason: string }[] = []
  const live = new LiveActivityNotifier(store, {
    gateway: "https://push.example",
    coalesceMs: 10,
    minStepIntervalMs: 10,
    endAfterAlertMs: 0,
    log: (line) => logs.push(line),
    onTicketDropped: (device, reason) => dropped.push({ device, reason }),
    fetch: (async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      posts.push(body)
      const reply = respond(body)
      return new Response(JSON.stringify(reply.body ?? { ok: true }), { status: reply.status })
    }) as typeof fetch,
  })
  const pushes: PushPayload[] = []
  const adapter: AgentAdapter = {
    spec: { id: "claude", label: "claude", transport: "fake", experimental: false, capabilities: FAKE_SPEC.capabilities },
    reply: async (_text, ctx) => {
      ctx.emit({ type: "tool", id: "t1", tool: "Edit", title: "a.ts", kind: "edit", status: "running", detail: "" })
      await Bun.sleep(40)
      await ctx.askPermission({ tool: "Bash", title: "Run", detail: "bun test", kind: "execute", options: RUN_OPTIONS })
    },
  }
  const events: Frame[] = []
  const service = new SessionService(store, adapter, (frame) => events.push(frame), { push: (item) => pushes.push(item), live })
  store.putDevice({ id: "phone", session_key: SESSION_KEY, name: "Phone", created_at: 1, push_token: options.ticket === undefined ? TICKET : options.ticket })
  const created = await service.invoke("session.create", { title: "修复", agent: "claude" }, "c1")
  const sessionId = (created.result as { session: { id: string } }).session.id
  await service.invoke(
    "liveActivity.register",
    { sessionId, activityId: "act-1", pushToken: ACTIVITY, keepSeconds: 900, locale: "zh" },
    "r1",
    { deviceKey: SESSION_KEY },
  )
  await service.invoke("message.send", { sessionId, text: "go" }, "s1")
  await waitFor(() => events.some((event) => event.name === "permission.asked"))
  return { store, posts, logs, dropped, pushes, live, sessionId, events, service }
}

describe("live activity fallback (r68 0-3)", () => {
  test("a reachable card carries the approval and no notification is sent", async () => {
    const h = await scenario(() => ({ status: 200 }))
    await waitFor(() => h.posts.some((post) => (post.contentState as { phase?: string }).phase === "waiting"))
    await Bun.sleep(20)
    expect(h.pushes.filter((push) => push.kind === "permission")).toHaveLength(0)
  })

  test("without a ticket the card is no channel: the permission notification goes out and the log says so once", async () => {
    const h = await scenario(() => ({ status: 200 }), { ticket: null })
    expect(h.live.deliverable(h.sessionId)).toBe(false)
    expect(h.pushes.map((push) => push.kind)).toEqual(["permission"])
    expect(h.posts).toHaveLength(0)
    expect(h.logs.filter((line) => line.includes("no gateway ticket"))).toHaveLength(1)
  })

  test("a card push that fails after the approval was armed sends the notification once", async () => {
    // The step push succeeds; every push from the waiting frame on fails with a 5xx.
    const h = await scenario((body) => ((body.contentState as { phase?: string }).phase === "waiting" ? { status: 503 } : { status: 200 }))
    await waitFor(() => h.pushes.some((push) => push.kind === "permission"))
    await Bun.sleep(20)
    const notices = h.pushes.filter((push) => push.kind === "permission")
    expect(notices).toHaveLength(1)
    expect(notices[0]!.permissionId).toBeString()
    expect(h.live.deliverable(h.sessionId)).toBe(false)
    expect(h.store.liveActivity(h.sessionId)).not.toBeNull()
  })

  test("410 with a bad-token reason drops the ticket, tells the phone, and falls back", async () => {
    const h = await scenario((body) =>
      (body.contentState as { phase?: string }).phase === "waiting" ? { status: 410, body: { error: "gone", reason: "BadDeviceToken" } } : { status: 200 },
    )
    await waitFor(() => h.pushes.some((push) => push.kind === "permission"))
    expect(h.store.deviceByKey(SESSION_KEY)?.push_token).toBeNull()
    expect(h.dropped.map((entry) => [entry.device.id, entry.reason])).toEqual([["phone", "BadDeviceToken"]])
    // The card row stays: a new ticket can still reach it.
    expect(h.store.liveActivity(h.sessionId)).not.toBeNull()
  })

  test("400 bad_ticket drops the ticket too", async () => {
    const h = await scenario((body) =>
      (body.contentState as { phase?: string }).phase === "waiting" ? { status: 400, body: { error: "bad_ticket" } } : { status: 200 },
    )
    await waitFor(() => h.dropped.length === 1)
    expect(h.dropped[0]!.reason).toBe("bad_ticket")
    expect(h.store.deviceByKey(SESSION_KEY)?.push_token).toBeNull()
  })

  test("410 Unregistered ends only the card: the row goes, the ticket stays, nothing more is posted", async () => {
    const h = await scenario((body) =>
      (body.contentState as { phase?: string }).phase === "waiting" ? { status: 410, body: { error: "gone", reason: "Unregistered" } } : { status: 200 },
    )
    await waitFor(() => h.store.liveActivity(h.sessionId) === null)
    await waitFor(() => h.pushes.some((push) => push.kind === "permission"))
    expect(h.store.deviceByKey(SESSION_KEY)?.push_token).toBe(TICKET)
    expect(h.dropped).toHaveLength(0)
    const count = h.posts.length
    await Bun.sleep(40)
    expect(h.posts).toHaveLength(count)
  })

  test("a 410 without a reason (gateway older than r68) is read as the card gone", async () => {
    const h = await scenario((body) => ((body.contentState as { phase?: string }).phase === "waiting" ? { status: 410, body: { error: "gone" } } : { status: 200 }))
    await waitFor(() => h.store.liveActivity(h.sessionId) === null)
    expect(h.store.deviceByKey(SESSION_KEY)?.push_token).toBe(TICKET)
    expect(h.pushes.filter((push) => push.kind === "permission")).toHaveLength(1)
    expect(h.logs.filter((line) => line.includes("card gone"))).toHaveLength(1)
  })

  test("hello says whether this machine holds the phone's ticket", async () => {
    const h = await scenario(() => ({ status: 200 }))
    const hello = async () =>
      ((await h.service.invoke("hello", {}, "h", { deviceKey: SESSION_KEY })).result as { push: { registered: boolean } }).push
    expect(await hello()).toEqual({ registered: true })
    h.store.clearDevicePushToken("phone", TICKET)
    expect(await hello()).toEqual({ registered: false })
  })
})
