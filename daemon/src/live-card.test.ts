import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { APP_LOCALES } from "./app-locale"
import { FAKE_SPEC } from "./adapter/fake"
import type { AgentAdapter, PermissionRequest } from "./adapter/types"
import {
  CARD_HEARTBEAT_MS,
  CARD_RETRY_MS,
  CARD_STALE_SECONDS,
  CARD_SURE_MS,
  continueNotice,
  FOLLOW_HOLD_MS,
  type FocusCandidate,
  LINGER_MS,
  LiveCardNotifier,
  type LiveCardOptions,
  othersOf,
  parseLiveStart,
  pickFocus,
  planProgress,
  positionOf,
  YIELD_APPROVAL_MS,
  YIELD_QUESTION_MS,
} from "./live-card"
import { type LiveField, openBytes, openLive } from "./push"
import type { Frame } from "./protocol"
import { SessionService } from "./session-service"
import { Store } from "./store"

const SESSION_KEY = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
const TICKET = "ticket-one-aaaaaaaaaaaa"
const TOKEN = "ab".repeat(32)
const RUN_OPTIONS: PermissionRequest["options"] = [{ id: "yes", label: "Yes", kind: "allow_once" }]

type Posted = {
  priority: number
  event: string
  contentState: Record<string, unknown>
  alert?: { title?: string; body?: string; titleKey?: string; bodyKey?: string }
  dismissalDate?: number
  staleDate?: number
  token?: string
  attributesType?: string
  attributes?: Record<string, unknown>
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out")
    await Bun.sleep(5)
  }
}

const open = (sealed: unknown, field: LiveField, sessionId: unknown, requestId = "") =>
  openLive(SESSION_KEY, String(sealed), { field, sessionId: String(sessionId), requestId })

function harness(
  reply: (body: Posted, signal?: AbortSignal) => Response | Promise<Response> = () => new Response(JSON.stringify({ ok: true })),
  extra: Partial<LiveCardOptions> = {},
) {
  const store = new Store(":memory:")
  const posts: Posted[] = []
  let clock = 1_800_000_000_000
  const card = new LiveCardNotifier(store, {
    gateway: "https://push.example",
    coalesceMs: 10,
    minStepIntervalMs: 10,
    reassertMs: 60,
    now: () => clock,
    agentLabel: (id) => (id === "claude" ? "Claude Code" : id),
    log: () => {},
    machineName: () => "test-mac",
    random: () => 0,
    startDelayMs: 20,
    ...extra,
    fetch: (async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Posted
      posts.push(body)
      return reply(body, init?.signal ?? undefined)
    }) as typeof fetch,
  })
  store.putDevice({ id: "phone", session_key: SESSION_KEY, name: "Phone", created_at: 1, push_token: TICKET })
  const session = (title: string) => store.createSession({ title, agent: "claude" }).id
  const register = () => card.register({ activityId: "act-1", pushToken: TOKEN, keepSeconds: 300, locale: "zh", deviceKey: SESSION_KEY })
  return {
    store,
    posts,
    card,
    session,
    register,
    advance: (ms: number) => {
      clock += ms
    },
    now: () => clock,
  }
}

const candidate = (sessionId: string, phase: FocusCandidate["phase"], lastEventAt: number, extra: Partial<FocusCandidate> = {}): FocusCandidate => ({
  sessionId,
  phase,
  lastEventAt,
  ...extra,
})

describe("pickFocus", () => {
  test("approval beats question beats failed beats running beats done", () => {
    const all = [
      candidate("done", "done", 9, { endedAt: 9 }),
      candidate("run", "running", 8),
      candidate("fail", "failed", 1, { endedAt: 1 }),
      candidate("ask", "waiting", 2, { waitingOn: "question" }),
      candidate("approve", "waiting", 3, { waitingOn: "approval" }),
    ]
    expect(pickFocus(all, undefined, 10)).toBe("approve")
    expect(pickFocus(all.slice(0, 4), undefined, 10)).toBe("ask")
    expect(pickFocus(all.slice(0, 3), undefined, 10)).toBe("fail")
    expect(pickFocus(all.slice(0, 2), undefined, 10)).toBe("run")
    expect(pickFocus(all.slice(0, 1), undefined, 10)).toBe("done")
    expect(pickFocus([candidate("stop", "interrupted", 1)], undefined, 10)).toBeUndefined()
  })

  test("v103: the card follows the session last sent to; other running sessions never take it", () => {
    const a = candidate("a", "running", 100)
    const b = candidate("b", "running", 900)
    expect(pickFocus([a, b], { sessionId: "a", since: 0 }, 10 * 60_000, "a")).toBe("a")
    expect(pickFocus([a, b], undefined, 10 * 60_000, "a")).toBe("a")
    expect(pickFocus([a, b], { sessionId: "a", since: 0 }, 1, "b")).toBe("b")
    // Nothing followed (a restart): the shown one stays, no rotation; with none shown, the latest.
    expect(pickFocus([a, b], { sessionId: "a", since: 0 }, 10 * 60_000)).toBe("a")
    expect(pickFocus([a, b], undefined, 1)).toBe("b")
  })

  test("v103: a wait or a failure elsewhere takes the card at once; handled, the card goes back to the followed one", () => {
    const a = candidate("a", "running", 100)
    const ask = candidate("q", "waiting", 50, { waitingOn: "question", waitingSince: 50 })
    const approve = candidate("p", "waiting", 40, { waitingOn: "approval", waitingSince: 40 })
    const fail = candidate("f", "failed", 60, { endedAt: 60 })
    expect(pickFocus([a, ask], { sessionId: "a", since: 0 }, 100, "a")).toBe("q")
    expect(pickFocus([a, ask, approve], { sessionId: "q", since: 0 }, 100, "a")).toBe("p")
    expect(pickFocus([a, candidate("q", "running", 120)], { sessionId: "q", since: 100 }, 130, "a")).toBe("a")
    expect(pickFocus([a, fail], { sessionId: "a", since: 0 }, 100, "a")).toBe("f")
    // A failure keeps the card for 5 minutes, then the followed session has it back.
    expect(pickFocus([a, fail], { sessionId: "f", since: 60 }, 60 + FOLLOW_HOLD_MS - 1, "a")).toBe("f")
    expect(pickFocus([a, fail], { sessionId: "f", since: 60 }, 60 + FOLLOW_HOLD_MS, "a")).toBe("a")
  })

  test("v103: the followed session's 做完 holds 5 minutes while another runs, then the latest running one is followed", () => {
    const done = candidate("a", "done", 1_000, { endedAt: 1_000 })
    const b = candidate("b", "running", 900)
    const c = candidate("c", "running", 1_200)
    expect(pickFocus([done, b, c], { sessionId: "a", since: 0 }, 1_000 + FOLLOW_HOLD_MS - 1, "a")).toBe("a")
    expect(pickFocus([done, b, c], { sessionId: "a", since: 0 }, 1_000 + FOLLOW_HOLD_MS, "a")).toBe("c")
    // From there it stays: a later event on b does not rotate the card.
    expect(pickFocus([done, candidate("b", "running", 5_000_000), c], { sessionId: "c", since: 0 }, 2 * FOLLOW_HOLD_MS, "a")).toBe("c")
  })

  test("v103: all done, the followed result stays; waits of one rank go first come, first served", () => {
    const a = candidate("a", "done", 100, { endedAt: 100 })
    const b = candidate("b", "done", 200, { endedAt: 200 })
    expect(pickFocus([a, b], undefined, 300, "a")).toBe("a")
    expect(pickFocus([a, b], undefined, 300)).toBe("b")
    const early = candidate("e", "waiting", 900, { waitingOn: "approval", waitingSince: 10 })
    const late = candidate("l", "waiting", 100, { waitingOn: "approval", waitingSince: 20 })
    expect(pickFocus([late, early], undefined, 30)).toBe("e")
  })

  test("v103: 1/3 counts the card's sessions in the order they first showed up", () => {
    const all = [
      candidate("b", "running", 9, { seenAt: 2 }),
      candidate("a", "done", 9, { endedAt: 9, seenAt: 1 }),
      candidate("c", "waiting", 9, { waitingOn: "question", seenAt: 3 }),
    ]
    expect(positionOf(all, "b")).toEqual({ position: 2, total: 3 })
    expect(positionOf(all, "c")).toEqual({ position: 3, total: 3 })
    expect(positionOf(all, "zz")).toBeUndefined()
    expect(positionOf([all[0]!], "b")).toEqual({ position: 1, total: 1 })
  })

  test("v103: plan progress is the item in progress (or the next one) out of all, with its text", () => {
    expect(planProgress([])).toBeUndefined()
    const entries = [
      { content: "读代码", status: "completed" as const },
      { content: "改 pickFocus", status: "completed" as const },
      { content: "补测试", status: "in_progress" as const },
      { content: "跑全部测试", status: "pending" as const },
    ]
    expect(planProgress(entries)).toEqual({ index: 3, total: 4, item: "补测试" })
    expect(planProgress(entries.map((entry) => ({ ...entry, status: entry.status === "in_progress" ? ("pending" as const) : entry.status })))).toEqual({
      index: 3,
      total: 4,
      item: "补测试",
    })
    expect(planProgress(entries.map((entry) => ({ ...entry, status: "completed" as const })))).toEqual({ index: 4, total: 4 })
  })

  test("a waiting session takes the card at once; a second one does not take it back", () => {
    const one = [candidate("a", "running", 300), candidate("b", "waiting", 100, { waitingOn: "approval" })]
    expect(pickFocus(one, { sessionId: "a", since: 0 }, 1)).toBe("b")
    const two = [candidate("a", "waiting", 300, { waitingOn: "approval" }), candidate("b", "waiting", 100, { waitingOn: "approval" })]
    expect(pickFocus(two, { sessionId: "b", since: 0 }, 1)).toBe("b")
  })

  test("v79: a told waiting session gives the main area to running work after 5 min (question) or 15 min (approval)", () => {
    const ask = candidate("ask", "waiting", 100, { waitingOn: "question", waitingSince: 0 })
    const approve = candidate("approve", "waiting", 100, { waitingOn: "approval", waitingSince: 0 })
    const run = candidate("run", "running", 200)
    const shownAsk = { sessionId: "ask", since: 0 }
    expect(pickFocus([ask, run], shownAsk, YIELD_QUESTION_MS - 1)).toBe("ask")
    expect(pickFocus([ask, run], shownAsk, YIELD_QUESTION_MS)).toBe("run")
    expect(pickFocus([approve, run], { sessionId: "approve", since: 0 }, YIELD_QUESTION_MS)).toBe("approve")
    expect(pickFocus([approve, run], { sessionId: "approve", since: 0 }, YIELD_APPROVAL_MS)).toBe("run")
    // Alone it keeps the card, and it still outranks a finished turn.
    expect(pickFocus([ask, candidate("done", "done", 300, { endedAt: 300 })], shownAsk, YIELD_APPROVAL_MS)).toBe("ask")
    // A new wait elsewhere takes the card from a yielded one.
    const fresh = candidate("fresh", "waiting", 400, { waitingOn: "question", waitingSince: YIELD_QUESTION_MS })
    expect(pickFocus([ask, run, fresh], { sessionId: "run", since: 0 }, YIELD_QUESTION_MS + 1)).toBe("fresh")
    // Yielded, it is still counted as waiting in the bottom line.
    expect(othersOf([ask, run], "run").waiting).toBe(1)
  })

  test("others counts running and waiting sessions, latest first", () => {
    const all = [
      candidate("focus", "running", 50),
      candidate("old", "running", 10),
      candidate("new", "waiting", 40, { waitingOn: "approval" }),
      candidate("mid", "running", 20),
      candidate("done", "done", 90, { endedAt: 90 }),
    ]
    // The waiting one is named on its own line, so the running line names only running sessions.
    expect(othersOf(all, "focus")).toEqual({ count: 3, waiting: 1, sessionIds: ["mid", "old"], wait: { sessionId: "new", kind: "approval" } })
    // Without the line (a gateway that predates it) every other session is named, latest first.
    expect(othersOf(all, "focus", false)).toEqual({ count: 3, waiting: 1, sessionIds: ["new", "mid"] })
  })

  test("v79: others.wait names the session that has waited longest, even when the main area is itself waiting", () => {
    const focus = candidate("focus", "waiting", 90, { waitingOn: "approval", waitingSince: 1 })
    const late = candidate("late", "waiting", 10, { waitingOn: "approval", waitingSince: 50 })
    const early = candidate("early", "waiting", 80, { waitingOn: "question", waitingSince: 20 })
    const run = candidate("run", "running", 99)
    expect(othersOf([focus, late, early, run], "focus").wait).toEqual({ sessionId: "early", kind: "question" })
    expect(othersOf([focus, late, run], "focus").wait).toEqual({ sessionId: "late", kind: "approval" })
    expect(othersOf([focus, run], "focus").wait).toBeUndefined()
  })

  test("v80: under a waiting or failed main area, waiting excludes the main area and running = count - waiting", () => {
    // The widget derives 「另外 N 个在跑」 as count − waiting and 「还有 N 个在等你」 / the 在等你 row from waiting + wait.
    for (const focus of [
      candidate("focus", "waiting", 90, { waitingOn: "question", waitingSince: 80 }),
      candidate("focus", "failed", 90, { endedAt: 90 }),
    ]) {
      const other = candidate("other", "waiting", 40, { waitingOn: "approval", waitingSince: 30 })
      const run = candidate("run", "running", 60)
      const others = othersOf([focus, other, run], "focus")
      expect(others.count - others.waiting).toBe(1)
      expect(others.waiting).toBe(1)
      expect(others.wait).toEqual({ sessionId: "other", kind: "approval" })
      expect(others.sessionIds).toEqual(["run"])
    }
  })
})

describe("live card", () => {
  test("a continuation's prompt line is the notice in each phone's language", async () => {
    for (const [locale, notice] of [["en", "Background work done, agent reports back"], ["ja", "バックグラウンドの作業が完了、エージェントが報告します"], ["zh", "后台任务做完，Agent 会主动汇报"]]) {
      const h = harness()
      const id = h.session("迁移")
      h.card.turnStarted(id, "Subagent finished:\nAll 3 files", { continuation: true })
      h.card.register({ activityId: "act-1", pushToken: TOKEN, keepSeconds: 300, locale: locale!, deviceKey: SESSION_KEY })
      await waitFor(() => h.posts.length >= 1)
      expect(open(h.posts.at(-1)!.contentState.promptSealed, "prompt", id)).toBe(notice)
    }
  })

  test("the continuation notice matches the app's catalog in every language", () => {
    const catalog = JSON.parse(readFileSync(join(import.meta.dir, "./fixtures/app-catalog-alerts.json"), "utf8")) as {
      strings: Record<string, Record<string, string>>
    }
    const entry = catalog.strings["后台任务做完，Agent 会主动汇报"]
    for (const locale of APP_LOCALES) expect(continueNotice(locale)).toBe(entry[locale])
  })

  test("one card follows the computer: others line, stale date, sealed title and prompt", async () => {
    const h = harness()
    const first = h.session("修复登录跳转")
    const second = h.session("迁移脚本")
    h.card.turnStarted(first, "把登录跳转修好\n再补测试")
    h.advance(1000)
    h.card.turnStarted(second, "迁移")
    h.register()
    await waitFor(() => h.posts.length >= 1)
    const frame = h.posts.at(-1)!
    expect(frame.event).toBe("update")
    expect(frame.staleDate).toBe(Math.floor(h.now() / 1000) + CARD_STALE_SECONDS)
    expect(frame.contentState.sessionId).toBe(second)
    expect(open(frame.contentState.agentSealed, "agent", second)).toBe("Claude Code")
    expect(open(frame.contentState.titleSealed, "title", second)).toBe("迁移脚本")
    expect(open(frame.contentState.promptSealed, "prompt", second)).toBe("迁移")
    expect(frame.contentState.others).toMatchObject({ count: 1, waiting: 0 })
    expect(open((frame.contentState.others as { titleSealed: string }).titleSealed, "others.title", second)).toBe("修复登录跳转")
  })

  test("an approval takes the card with one alert; later frames do not alert again", async () => {
    const h = harness()
    const a = h.session("A")
    const b = h.session("B")
    h.card.turnStarted(a, "a")
    h.card.turnStarted(b, "b")
    h.register()
    await waitFor(() => h.posts.length >= 1)
    let notified = 0
    const carried = h.card.armPermission(a, { id: "req-1", tool: "Bash", detail: "rm -rf build", kind: "execute" }, () => notified++)
    expect(carried).toBe(true)
    h.card.status(a, "waiting")
    await waitFor(() => h.posts.some((post) => post.contentState.phase === "waiting"))
    h.card.tool(b, { id: "t1", title: "bun test", kind: "execute", status: "running" })
    await Bun.sleep(40)
    const waiting = h.posts.filter((post) => post.contentState.phase === "waiting")
    expect(waiting.length).toBeGreaterThanOrEqual(2)
    expect(waiting.filter((post) => post.alert).length).toBe(1)
    expect(waiting.find((post) => post.alert)!.alert).toEqual({ titleKey: "需批准", bodyKey: "有一项操作等你批准" })
    expect(waiting[0]!.priority).toBe(10)
    expect(open((waiting[0]!.contentState.approval as { summarySealed: string }).summarySealed, "approval.summary", a, "req-1")).toBe("rm -rf build")
    expect(notified).toBe(0)
    // A second approval while the card shows the first: no card for it, the caller notifies.
    expect(h.card.armPermission(b, { id: "req-2", tool: "Bash", detail: "ls", kind: "execute" }, () => {})).toBe(false)
  })

  // Security review 11-11: the requestId rides in the clear, so a gateway could pair an old sealed `ls` with the id of a
  // current `rm -rf ~`; the phone would show `ls` and 批准 would release the other command.
  test("a sealed command opens only beside the requestId, session and field it was sealed for", async () => {
    const h = harness()
    const a = h.session("A")
    h.card.turnStarted(a, "a")
    h.register()
    await waitFor(() => h.posts.length >= 1)
    h.card.armPermission(a, { id: "req-old", tool: "Bash", detail: "ls", kind: "execute" }, () => {})
    h.card.status(a, "waiting")
    await waitFor(() => h.posts.some((post) => (post.contentState.approval as { requestId?: string } | undefined)?.requestId === "req-old"))
    h.card.settle(a, "req-old")
    h.card.status(a, "running")
    h.card.armPermission(a, { id: "req-new", tool: "", detail: "rm -rf ~", kind: "execute" }, () => {})
    h.card.status(a, "waiting")
    await waitFor(() => h.posts.some((post) => (post.contentState.approval as { requestId?: string } | undefined)?.requestId === "req-new"))
    type Approval = { requestId: string; toolSealed: string; summarySealed: string }
    const approval = (id: string) => h.posts.map((post) => post.contentState.approval as Approval | undefined).find((it) => it?.requestId === id)!
    const old = approval("req-old")
    const current = approval("req-new")
    expect(open(current.summarySealed, "approval.summary", a, "req-new")).toBe("rm -rf ~")
    // An empty tool name is still sealed: the phone needs one bound field to open before it offers 批准.
    expect(open(current.toolSealed, "approval.tool", a, "req-new")).toBe("")
    // The swap: old ciphertext, current id. It does not open, so the phone shows no command and no 批准.
    expect(() => open(old.summarySealed, "approval.summary", a, "req-new")).toThrow()
    expect(() => open(old.toolSealed, "approval.tool", a, "req-new")).toThrow()
    // Nor under another session, as another field, or with no binding at all (the v1 box).
    expect(() => open(current.summarySealed, "approval.summary", "other-session", "req-new")).toThrow()
    expect(() => open(current.summarySealed, "step", a, "req-new")).toThrow()
    expect(() => openBytes(SESSION_KEY, current.summarySealed)).toThrow()
  })

  test("identical running and completed tool updates do not add progress pushes", async () => {
    const h = harness()
    const id = h.session("build")
    h.card.turnStarted(id, "build the app")
    h.register()
    await waitFor(() => h.posts.length === 1)
    const tool = { id: "build", title: "Build", kind: "execute", status: "running" } as const
    h.card.tool(id, tool)
    await waitFor(() => h.posts.length >= 2)
    const initial = h.posts.length
    const originalStep = h.posts.at(-1)!.contentState.stepStartedAt
    for (let i = 0; i < 5; i++) {
      h.advance(2_000)
      h.card.tool(id, tool)
      await Bun.sleep(15)
    }
    expect(h.posts).toHaveLength(initial)
    h.card.tool(id, { ...tool, status: "completed" })
    await waitFor(() => h.posts.length > initial)
    expect(h.posts.at(-1)!.contentState.stepStartedAt).toBe(originalStep)
    const completed = h.posts.length
    h.advance(2_000)
    h.card.tool(id, { ...tool, status: "completed" })
    await Bun.sleep(25)
    expect(h.posts).toHaveLength(completed)
    expect(h.card.armPermission(id, { id: "next", tool: "Bash", detail: "next step", kind: "execute" }, () => {})).toBe(true)
    await waitFor(() => h.posts.at(-1)?.contentState.phase === "waiting")
    h.card.settle(id, "next")
    h.card.status(id, "idle", { phase: "done" })
    await waitFor(() => h.posts.at(-1)?.contentState.phase === "done")
    await h.card.abandonAll()
  })

  test("done stays on the card, a new turn reuses the token, and the stay's end ends the card", async () => {
    const h = harness()
    const a = h.session("A")
    h.card.turnStarted(a, "go")
    h.register()
    await waitFor(() => h.posts.length >= 1)
    h.card.status(a, "idle", { phase: "done", result: "登录后回跳改成读 next 参数。后面", changes: { added: 26, removed: 2, files: 3 } })
    let notified = 0
    expect(h.card.takeResult(a, () => notified++)).toBe(true)
    await waitFor(() => h.posts.some((post) => post.contentState.phase === "done"))
    const done = h.posts.find((post) => post.contentState.phase === "done")!
    expect(done.event).toBe("update")
    expect(done.alert).toEqual({ titleKey: "完成", bodyKey: "这一轮结束了" })
    expect(open(done.contentState.resultSealed, "result", a)).toBe("登录后回跳改成读 next 参数。")
    expect(done.contentState.changes).toEqual({ added: 26, removed: 2, files: 3 })
    expect(Number(done.contentState.dismissAt) - Number(done.contentState.endedAt)).toBeCloseTo(300, 3)
    // Within the stay a new turn: same card, back to running, no end.
    h.advance(60_000)
    h.card.turnStarted(a, "again")
    await waitFor(() => h.posts.at(-1)!.contentState.phase === "running")
    expect(h.posts.some((post) => post.event === "end")).toBe(false)
    h.card.status(a, "idle", { phase: "done" })
    await waitFor(() => h.posts.filter((post) => post.contentState.phase === "done").length === 2)
    // Past the stay with nothing running, the next look ends it.
    h.advance(301_000)
    h.card.forget("nobody")
    await waitFor(() => h.posts.some((post) => post.event === "end"))
    expect(h.store.listLiveCards()).toHaveLength(0)
    expect(notified).toBe(0)
  })

  test("a failed turn beats a running one and carries its reason", async () => {
    const h = harness()
    const a = h.session("A")
    const b = h.session("B")
    h.card.turnStarted(a, "a")
    h.card.turnStarted(b, "b")
    h.register()
    await waitFor(() => h.posts.length >= 1)
    h.card.status(a, "idle", { phase: "failed", result: "Error: usage", reason: { code: "usage_limit", resetsAt: 1_800_000_900_000 } })
    expect(h.card.takeResult(a, () => {})).toBe(true)
    await waitFor(() => h.posts.some((post) => post.contentState.phase === "failed"))
    const failed = h.posts.find((post) => post.contentState.phase === "failed")!
    expect(failed.contentState.sessionId).toBe(a)
    expect(failed.alert?.titleKey).toBe("失败")
    expect(JSON.parse(open(failed.contentState.reasonSealed, "reason", a))).toEqual({ code: "usage_limit", resetsAt: 1_800_000_900_000 })
    expect(failed.contentState.others).toMatchObject({ count: 1 })
  })

  // Second review #41: the card showed rudderd's Chinese failure text in every language.
  test("a failed turn's copy rides sealed beside its text, and an oversized one is left out", async () => {
    const h = harness()
    const a = h.session("A")
    h.card.turnStarted(a, "a")
    h.register()
    await waitFor(() => h.posts.length >= 1)
    const copy = { code: "agent_unavailable", args: { agent: "Kimi", reason: "未找到命令 kimi" }, text: "Kimi 不可用：未找到命令 kimi" }
    h.card.status(a, "idle", { phase: "failed", result: copy.text, copy })
    await waitFor(() => h.posts.some((post) => post.contentState.phase === "failed"))
    const failed = h.posts.find((post) => post.contentState.phase === "failed")!
    expect(open(failed.contentState.resultSealed, "result", a)).toBe("Kimi 不可用：未找到命令 kimi")
    expect(JSON.parse(open(failed.contentState.resultCopySealed, "resultCopy", a))).toEqual(copy)


    const g = harness()
    const b = g.session("B")
    g.card.turnStarted(b, "b")
    g.register()
    await waitFor(() => g.posts.length >= 1)
    const long = { code: "agent_failed", args: { detail: "x".repeat(800) }, text: "失败" }
    g.card.status(b, "idle", { phase: "failed", result: "失败", copy: long })
    await waitFor(() => g.posts.some((post) => post.contentState.phase === "failed"))
    const cut = g.posts.find((post) => post.contentState.phase === "failed")!
    expect(open(cut.contentState.resultSealed, "result", b)).toBe("失败")
    expect(cut.contentState.resultCopySealed).toBeUndefined()
  })

  test("an answered question gives the card back at once", async () => {
    const h = harness()
    const a = h.session("A")
    h.card.turnStarted(a, "a")
    h.register()
    await waitFor(() => h.posts.length >= 1)
    h.card.armQuestion(a, { id: "q-1", questions: [{ question: "哪个？" }] }, () => {})
    h.card.status(a, "waiting")
    await waitFor(() => h.posts.some((post) => post.contentState.phase === "waiting"))
    const before = h.posts.length
    h.card.settle(a, "q-1")
    await waitFor(() => h.posts.slice(before).some((post) => post.contentState.phase === "running"))
    // 2026-11-20 (device): the frame that leaves 等你回答 goes at priority 10; at 5 the phone held it back and the island
    // kept the question until the agent's next reply.
    const back = h.posts.slice(before).find((post) => post.contentState.phase === "running")!
    expect(back.priority).toBe(10)
    expect(back.contentState.question).toBeUndefined()
  })

  test("2026-11-20: an answered approval leaves 等你批准 at priority 10, even when a newer plain frame replaces it", async () => {
    let release: () => void = () => {}
    let hold = false
    const h = harness(async () => {
      if (hold) await new Promise<void>((resolve) => (release = resolve))
      return new Response(JSON.stringify({ ok: true }))
    })
    const a = h.session("A")
    h.card.turnStarted(a, "a")
    h.register()
    await waitFor(() => h.posts.length >= 1)
    // The approval's post hangs, so the answered frame waits behind it and a step frame replaces it.
    hold = true
    h.card.armPermission(a, { id: "req-1", tool: "Bash", detail: "rm", kind: "execute" }, () => {})
    h.card.status(a, "waiting")
    await waitFor(() => h.posts.some((post) => post.contentState.phase === "waiting"))
    const before = h.posts.length
    h.card.settle(a, "req-1")
    h.card.tool(a, { id: "t1", title: "bun test", kind: "execute", status: "running" })
    await Bun.sleep(30)
    hold = false
    release()
    await waitFor(() => h.posts.slice(before).some((post) => post.contentState.phase === "running"))
    const back = h.posts.slice(before).find((post) => post.contentState.phase === "running")!
    expect(back.priority).toBe(10)
    expect(back.contentState.approval).toBeUndefined()
    // Once out of the wait, steps go back to priority 5.
    const after = h.posts.length
    h.card.tool(a, { id: "t2", title: "git status", kind: "execute", status: "running" })
    await waitFor(() => h.posts.length > after)
    expect(h.posts.at(-1)!.priority).toBe(5)
  })

  test("a done turn while another runs goes to the notification", async () => {
    const h = harness()
    const a = h.session("A")
    const b = h.session("B")
    h.card.turnStarted(a, "a")
    h.card.turnStarted(b, "b")
    h.register()
    await waitFor(() => h.posts.length >= 1)
    h.card.status(a, "idle", { phase: "done" })
    expect(h.card.takeResult(a, () => {})).toBe(false)
  })

  test("a question alerts with 等你回答, and without an alert on a gateway that predates it", async () => {
    // Older than B-4, so older than keyed alerts too: the keyed alert, then the plain one, are refused.
    const h = harness((body) =>
      (body.alert?.titleKey ?? body.alert?.title) === "等你回答"
        ? new Response(JSON.stringify({ error: "bad_request", message: "alert must be one of the fixed Live Activity texts" }), { status: 400 })
        : new Response(JSON.stringify({ ok: true })),
    )
    const a = h.session("A")
    h.card.turnStarted(a, "a")
    h.register()
    await waitFor(() => h.posts.length >= 1)
    expect(h.card.armQuestion(a, { id: "q-1", questions: [{ question: "内存还是 Redis？" }] }, () => {})).toBe(true)
    h.card.status(a, "waiting")
    await waitFor(() => h.posts.filter((post) => post.contentState.question).length >= 3)
    const asked = h.posts.filter((post) => post.contentState.question)
    expect(asked[0]!.alert?.titleKey).toBe("等你回答")
    expect(asked[1]!.alert?.title).toBe("等你回答")
    expect(asked[2]!.alert).toBeUndefined()
    expect(open((asked[2]!.contentState.question as { titleSealed: string }).titleSealed, "question.title", a, "q-1")).toBe("内存还是 Redis？")
  })

  test("alerts go as keys the phone translates; a gateway that predates keys gets the paired language's text", async () => {
    const h = harness((body) =>
      body.alert?.titleKey !== undefined
        ? new Response(JSON.stringify({ error: "bad_request", message: "alert must be one of the fixed Live Activity texts" }), { status: 400 })
        : new Response(JSON.stringify({ ok: true })),
    )
    const id = h.session("Ask")
    h.card.turnStarted(id, "go")
    h.card.register({ activityId: "act-1", pushToken: TOKEN, keepSeconds: 300, locale: "en", deviceKey: SESSION_KEY })
    await waitFor(() => h.posts.length >= 1)
    h.card.armPermission(id, { id: "req-1", tool: "Bash", detail: "rm -rf build", kind: "execute" }, () => {})
    h.card.status(id, "waiting")
    await waitFor(() => h.posts.filter((post) => post.alert).length >= 2)
    const alerted = h.posts.filter((post) => post.alert)
    expect(alerted[0]!.alert).toEqual({ titleKey: "需批准", bodyKey: "有一项操作等你批准" })
    expect(alerted[1]!.alert).toEqual({ title: "Needs approval", body: "An action is waiting for your approval" })
    // Remembered: the next alert goes plain at once.
    h.card.settle(id, "req-1")
    h.card.status(id, "idle", { phase: "done" })
    await waitFor(() => h.posts.some((post) => post.contentState.phase === "done" && post.alert))
    expect(h.posts.find((post) => post.contentState.phase === "done" && post.alert)!.alert).toEqual({ title: "Done", body: "This turn finished" })
    expect(h.posts.filter((post) => post.alert?.titleKey !== undefined)).toHaveLength(1)
  })

  test("v79: the card names the earliest other wait, and drops it on a gateway that predates it", async () => {
    let refused = 0
    const h = harness((body) => {
      if ((body.contentState.others as { wait?: unknown } | undefined)?.wait === undefined) return new Response(JSON.stringify({ ok: true }))
      refused++
      return new Response(JSON.stringify({ error: "bad_request", message: "contentState.others carries only count, waiting and titleSealed" }), { status: 400 })
    })
    const a = h.session("修复登录跳转")
    const b = h.session("迁移脚本")
    h.card.turnStarted(a, "a")
    h.card.turnStarted(b, "b")
    h.register()
    await waitFor(() => h.posts.length >= 1)
    h.card.armQuestion(a, { id: "q-a", questions: [{ question: "哪个？" }] }, () => {})
    h.card.status(a, "waiting")
    await waitFor(() => h.posts.some((post) => post.contentState.phase === "waiting"))
    h.advance(1000)
    h.card.armPermission(b, { id: "req-b", tool: "Bash", detail: "ls", kind: "execute" }, () => {})
    h.card.status(b, "waiting")
    await waitFor(() => refused === 1 && h.posts.at(-1)!.contentState.others !== undefined)
    await Bun.sleep(40)
    const at = h.posts.findIndex((post) => (post.contentState.others as { wait?: unknown } | undefined)?.wait !== undefined)
    const [sent, retried] = h.posts.slice(at, at + 2)
    // The approval takes the main area; the question beside it is named, then the retry goes without the line.
    expect(sent!.contentState.sessionId).toBe(b)
    const wait = (sent!.contentState.others as { wait: { sessionId: string; kind: string; titleSealed: string } }).wait
    expect(wait).toMatchObject({ sessionId: a, kind: "question" })
    expect(open(wait.titleSealed, "others.wait.title", a)).toBe("修复登录跳转")
    expect(retried!.contentState.others).toMatchObject({ count: 1, waiting: 1 })
    expect((retried!.contentState.others as { wait?: unknown }).wait).toBeUndefined()
    // Not offered again in this process.
    h.card.tool(b, { id: "t1", title: "x", kind: "execute", status: "running" })
    h.advance(1000)
    h.card.status(a, "waiting")
    await Bun.sleep(40)
    expect(refused).toBe(1)
  })

  test("2026-11-20: a quiet turn keeps the card fresh: heartbeats well inside the stale window, priority 10 before it can lapse", async () => {
    // The island said 「电脑没回应」 during a quiet command: a 150 s priority-5 beat held back by the phone outlived 180 s.
    expect(CARD_HEARTBEAT_MS * 4).toBeLessThanOrEqual(CARD_STALE_SECONDS * 1000)
    expect(CARD_SURE_MS + 2 * CARD_HEARTBEAT_MS).toBeLessThanOrEqual(CARD_STALE_SECONDS * 1000)
    // Fake clock: one heartbeat interval of real time stands for 60 s.
    const h = harness(undefined, { heartbeatMs: 40 })
    const a = h.session("A")
    h.card.turnStarted(a, "a")
    h.register()
    await waitFor(() => h.posts.length >= 1)
    expect(h.posts[0]!.priority).toBe(5)
    const beat = async () => {
      const before = h.posts.length
      h.advance(CARD_HEARTBEAT_MS)
      await waitFor(() => h.posts.length > before)
      return h.posts.at(-1)!
    }
    // 60 s, 120 s: plain beats, each pushing the stale date out again.
    for (let i = 0; i < 2; i++) {
      const frame = await beat()
      expect(frame.priority).toBe(5)
      expect(frame.staleDate).toBe(Math.floor(h.now() / 1000) + CARD_STALE_SECONDS)
      expect(frame.alert).toBeUndefined()
    }
    // 180 s since the card was made: this beat goes at 10, silently, so a held priority-5 beat cannot make it lapse.
    const sure = await beat()
    expect(sure.priority).toBe(10)
    expect(sure.alert).toBeUndefined()
    // The next ones are plain again until another 180 s pass.
    expect((await beat()).priority).toBe(5)
    expect((await beat()).priority).toBe(5)
    expect((await beat()).priority).toBe(10)
  })

  test("2026-11-20: an alert frame counts as the priority-10 frame; the next sure one is 180 s after it", async () => {
    const h = harness(undefined, { heartbeatMs: 40 })
    const a = h.session("A")
    h.card.turnStarted(a, "a")
    h.register()
    await waitFor(() => h.posts.length >= 1)
    h.advance(CARD_HEARTBEAT_MS)
    h.card.armPermission(a, { id: "r1", tool: "Bash", detail: "rm", kind: "execute" }, () => {})
    h.card.status(a, "waiting")
    await waitFor(() => h.posts.some((post) => post.priority === 10))
    h.card.settle(a, "r1")
    h.card.status(a, "running")
    await waitFor(() => h.posts.at(-1)!.contentState.phase === "running")
    const alerted = h.posts.length
    for (let i = 0; i < 2; i++) {
      const before = h.posts.length
      h.advance(CARD_HEARTBEAT_MS)
      await waitFor(() => h.posts.length > before)
    }
    expect(h.posts.slice(alerted).every((post) => post.priority === 5)).toBe(true)
    const before = h.posts.length
    h.advance(CARD_HEARTBEAT_MS)
    await waitFor(() => h.posts.length > before)
    expect(h.posts.at(-1)!.priority).toBe(10)
  })

  test("2026-11-20: a heartbeat lost to ECONNRESET is sent again soon, not left to lapse", async () => {
    let failures = 2
    const h = harness(
      () => {
        if (failures > 0) {
          failures--
          throw new Error("ECONNRESET: The socket connection was closed unexpectedly")
        }
        return new Response(JSON.stringify({ ok: true }))
      },
      { heartbeatMs: 10_000, retryMs: 30 },
    )
    const a = h.session("A")
    h.card.turnStarted(a, "a")
    h.register()
    // Each failed attempt waits for the next backoff slot.
    await waitFor(() => h.posts.length >= 2)
    h.advance(CARD_RETRY_MS)
    await waitFor(() => h.posts.length >= 3)
    expect(h.posts.at(-1)!.staleDate).toBe(Math.floor(h.now() / 1000) + CARD_STALE_SECONDS)
    expect(CARD_RETRY_MS).toBeLessThan(CARD_HEARTBEAT_MS)
  })

  test("2026-11-20: a gateway 5xx is retried soon; a 4xx is not", async () => {
    let status = 502
    const h = harness(() => new Response(JSON.stringify({ error: "x" }), { status }), { retryMs: 30 })
    const a = h.session("A")
    h.card.turnStarted(a, "a")
    h.register()
    await waitFor(() => h.posts.length >= 1)
    status = 200
    await waitFor(() => h.posts.length >= 2)
    const other = harness(() => new Response(JSON.stringify({ error: "bad" }), { status: 400 }), { retryMs: 30 })
    const b = other.session("B")
    other.card.turnStarted(b, "b")
    other.register()
    await waitFor(() => other.posts.length >= 1)
    await Bun.sleep(120)
    expect(other.posts.length).toBe(1)
  })

  test("a failing push sends the notification the card stood in for", async () => {
    const h = harness(() => new Response(JSON.stringify({ error: "upstream" }), { status: 502 }))
    const a = h.session("A")
    h.card.turnStarted(a, "a")
    h.register()
    await Bun.sleep(30)
    let notified = 0
    // The register frame already failed: the card is not a channel, the caller notifies.
    expect(h.card.armPermission(a, { id: "r", tool: "Bash", detail: "x", kind: "execute" }, () => notified++)).toBe(false)
  })

  test("superseded frames are not sent: after a slow post only the latest state goes", async () => {
    let release: (() => void) | undefined
    const h = harness((body) => {
      if (body.contentState.stepSealed === undefined || release) return new Response(JSON.stringify({ ok: true }))
      return new Promise((resolve) => {
        release = () => resolve(new Response(JSON.stringify({ ok: true })))
      })
    })
    const a = h.session("A")
    h.card.turnStarted(a, "a")
    h.register()
    await waitFor(() => h.posts.length >= 1)
    h.card.tool(a, { id: "t1", title: "step one", kind: "execute", status: "running" })
    await waitFor(() => release !== undefined)
    h.card.tool(a, { id: "t2", title: "step two", kind: "execute", status: "running" })
    await Bun.sleep(30)
    h.card.tool(a, { id: "t3", title: "step three", kind: "execute", status: "running" })
    await Bun.sleep(30)
    release!()
    const step = (post: Posted) => (post.contentState.stepSealed ? open(post.contentState.stepSealed, "step", a) : undefined)
    await waitFor(() => h.posts.some((post) => step(post) === "step three"))
    expect(h.posts.map(step).filter((text) => text !== undefined)).toEqual(["step one", "step three"])
  })

  test("an approval does not wait behind a hung post; the hung one is aborted, not retried", async () => {
    let hung = 0
    const h = harness((body, signal) => {
      if (body.contentState.stepSealed === undefined || body.contentState.phase !== "running") return new Response(JSON.stringify({ ok: true }))
      hung++
      // A gateway that never answers: only the caller's abort (or its 10 s timeout) ends the request.
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason))
      })
    })
    const a = h.session("A")
    h.card.turnStarted(a, "a")
    h.register()
    await waitFor(() => h.posts.length >= 1)
    h.card.tool(a, { id: "t1", title: "step one", kind: "execute", status: "running" })
    await waitFor(() => hung === 1)
    let notified = 0
    expect(h.card.armPermission(a, { id: "req-1", tool: "Bash", detail: "rm -rf build", kind: "execute" }, () => notified++)).toBe(true)
    const asked = Date.now()
    h.card.status(a, "waiting")
    await waitFor(() => h.posts.some((post) => post.contentState.phase === "waiting"), 500)
    expect(Date.now() - asked).toBeLessThan(500)
    const approval = h.posts.find((post) => post.contentState.phase === "waiting")!
    expect(approval.priority).toBe(10)
    expect(approval.alert).toEqual({ titleKey: "需批准", bodyKey: "有一项操作等你批准" })
    await Bun.sleep(30)
    // The aborted frame is not retried after the approval, and the approval's own fallback stays unsent.
    expect(hung).toBe(1)
    expect(h.posts.at(-1)!.contentState.phase).toBe("waiting")
    expect(notified).toBe(0)
    // The aborted post may still land after the approval: the waiting state goes once more, silently.
    await waitFor(() => h.posts.filter((post) => post.contentState.phase === "waiting").length === 2, 500)
    const again = h.posts.at(-1)!
    expect((again.contentState.approval as { requestId: string }).requestId).toBe("req-1")
    expect(again.alert).toBeUndefined()
    await Bun.sleep(150)
    expect(h.posts.filter((post) => post.contentState.phase === "waiting")).toHaveLength(2)
    expect(hung).toBe(1)
  })

  test("the approval is not sent again once something newer went out", async () => {
    let hung = 0
    const h = harness((body, signal) => {
      if (hung > 0 || body.contentState.stepSealed === undefined || body.contentState.phase !== "running") return new Response(JSON.stringify({ ok: true }))
      hung++
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason))
      })
    })
    const a = h.session("A")
    h.card.turnStarted(a, "a")
    h.register()
    await waitFor(() => h.posts.length >= 1)
    h.card.tool(a, { id: "t1", title: "step one", kind: "execute", status: "running" })
    await waitFor(() => hung === 1)
    h.card.armPermission(a, { id: "req-1", tool: "Bash", detail: "rm -rf build", kind: "execute" }, () => {})
    h.card.status(a, "waiting")
    await waitFor(() => h.posts.some((post) => post.contentState.phase === "waiting"), 500)
    // Answered before the re-send is due: the running frame is the last word.
    h.card.settle(a, "req-1")
    h.card.status(a, "running")
    await waitFor(() => h.posts.at(-1)!.contentState.phase === "running", 500)
    await Bun.sleep(150)
    expect(h.posts.filter((post) => post.contentState.phase === "waiting")).toHaveLength(1)
    expect(h.posts.at(-1)!.contentState.phase).toBe("running")
  })

  test("v103: the card follows the session last sent to; a continuation or another session's steps do not move it", async () => {
    const h = harness()
    const a = h.session("迁移脚本")
    const b = h.session("拆会话层")
    h.card.turnStarted(a, "迁移")
    h.advance(1000)
    h.card.turnStarted(b, "拆")
    h.register()
    await waitFor(() => h.posts.length >= 1)
    expect(h.posts.at(-1)!.contentState.sessionId).toBe(b)
    h.advance(1000)
    h.card.turnStarted(a, "再迁一次")
    await waitFor(() => h.posts.at(-1)!.contentState.sessionId === a)
    h.advance(60_000)
    h.card.tool(b, { id: "t1", title: "bun test", kind: "execute", status: "running" })
    h.card.turnStarted(b, "Subagent finished", { continuation: true })
    h.advance(10 * 60_000)
    h.card.tool(b, { id: "t2", title: "bun test", kind: "execute", status: "running" })
    await Bun.sleep(40)
    expect(h.posts.at(-1)!.contentState.sessionId).toBe(a)
    await h.card.abandonAll()
  })

  test("v103: the card carries 1/3, the project, and plan progress; the gateway sees only numbers and sealed text", async () => {
    const h = harness()
    const a = h.store.createSession({ title: "迁移脚本", agent: "claude", cwd: "/Users/tester/Projects/rudder" }).id
    const b = h.session("拆会话层")
    h.card.turnStarted(b, "拆")
    h.advance(1000)
    h.card.turnStarted(a, "迁移")
    h.card.plan(a, [
      { content: "读代码", status: "completed" },
      { content: "改 pickFocus", status: "completed" },
      { content: "补测试", status: "in_progress" },
      { content: "跑全部测试", status: "pending" },
      { content: "a", status: "pending" },
      { content: "b", status: "pending" },
      { content: "c", status: "pending" },
    ])
    h.register()
    await waitFor(() => h.posts.length >= 1)
    const state = h.posts.at(-1)!.contentState
    expect(state.sessionId).toBe(a)
    expect(state.position).toBe(2)
    expect(state.total).toBe(2)
    expect(open(state.projectSealed, "project", a)).toBe("rudder")
    expect(state.planIndex).toBe(3)
    expect(state.planTotal).toBe(7)
    expect(open(state.planSealed, "plan", a)).toBe("补测试")
    // A new turn starts without the old plan.
    h.card.turnStarted(a, "下一轮")
    await waitFor(() => h.posts.at(-1)!.contentState.planTotal === undefined)
    await h.card.abandonAll()
  })

  test("v103: all done, the island lingers 5 minutes; the lock screen keeps the card for the phone's setting", async () => {
    const h = harness()
    const a = h.session("A")
    h.card.turnStarted(a, "a")
    h.card.register({ activityId: "act-1", pushToken: TOKEN, keepSeconds: 900, locale: "zh", deviceKey: SESSION_KEY })
    await waitFor(() => h.posts.length >= 1)
    h.card.status(a, "idle", { phase: "done" })
    const endedAt = h.now()
    await waitFor(() => h.posts.some((post) => post.contentState.phase === "done"))
    const done = h.posts.find((post) => post.contentState.phase === "done")!
    expect(Number(done.contentState.dismissAt) - Number(done.contentState.endedAt)).toBeCloseTo(900, 3)
    h.advance(LINGER_MS - 1)
    h.card.forget("nobody")
    await Bun.sleep(40)
    expect(h.posts.some((post) => post.event === "end")).toBe(false)
    h.advance(1)
    h.card.forget("nobody")
    await waitFor(() => h.posts.some((post) => post.event === "end"))
    expect(h.posts.at(-1)!.dismissalDate).toBe(Math.floor((endedAt + 900_000) / 1000))
    expect(h.store.listLiveCards()).toHaveLength(0)
  })

  test("v103: a maxed-out card still fits APNs' 4 KB with room for the gateway's envelope", async () => {
    const h = harness()
    const long = (n: number) => "迁".repeat(n)
    const a = h.store.createSession({ title: long(80), agent: "claude", cwd: `/x/${long(80)}` }).id
    for (let i = 0; i < 3; i++) {
      const other = h.session(long(40))
      h.card.turnStarted(other, long(80))
    }
    h.card.turnStarted(a, long(80))
    h.card.tool(a, { id: "t", title: long(120), kind: "execute", status: "running" })
    h.card.plan(a, [{ content: long(200), status: "in_progress" }])
    h.register()
    await waitFor(() => h.posts.length >= 1)
    h.card.armPermission(a, { id: "req", tool: long(40), detail: long(200), kind: "execute" }, () => {})
    h.card.armQuestion(a, { id: "q", questions: [{ question: long(200) }] }, () => {})
    await waitFor(() => h.posts.at(-1)!.contentState.phase === "waiting")
    for (const post of h.posts) expect(new TextEncoder().encode(JSON.stringify(post)).length).toBeLessThan(3600)
    await h.card.abandonAll()
  })

  test("410 drops the card row", async () => {
    const h = harness(() => new Response(JSON.stringify({ error: "gone", reason: "Unregistered" }), { status: 410 }))
    const a = h.session("A")
    h.card.turnStarted(a, "a")
    h.register()
    await waitFor(() => h.store.listLiveCards().length === 0)
  })

  test("v112 ③: a command-named session's title is worded in the card's language", async () => {
    const h = harness()
    const a = h.session("新会话")
    h.store.setAutoTitle(a, "运行命令", 2, "deploy-preview")
    h.card.turnStarted(a, "/deploy-preview")
    h.card.register({ activityId: "act-1", pushToken: TOKEN, keepSeconds: 300, locale: "en", deviceKey: SESSION_KEY })
    await waitFor(() => h.posts.some((post) => post.contentState.titleSealed !== undefined))
    const post = h.posts.find((p) => p.contentState.titleSealed !== undefined)!
    expect(open(post.contentState.titleSealed, "title", post.contentState.sessionId)).toBe("Deploy preview")
  })

  test("v115: a stopped turn stays on the card as 已中断, without an alert, and clears like a finished one", async () => {
    const h = harness()
    const a = h.session("A")
    h.card.turnStarted(a, "a")
    h.register()
    await waitFor(() => h.posts.length >= 1)
    h.card.status(a, "idle", { phase: "interrupted" })
    await waitFor(() => h.posts.some((post) => post.contentState.phase === "interrupted"))
    const stopped = h.posts.find((post) => post.contentState.phase === "interrupted")!
    expect(stopped.event).toBe("update")
    expect(stopped.alert).toBeUndefined()
    expect(stopped.contentState.endedAt).toBeDefined()
    expect(stopped.contentState.dismissAt).toBeDefined()
    expect(stopped.contentState.resultSealed).toBeUndefined()
    expect(stopped.contentState.reasonSealed).toBeUndefined()
    expect(h.posts.some((post) => post.event === "end")).toBe(false)
  })
})

function scripted(id: string, reply: AgentAdapter["reply"]): AgentAdapter {
  return { spec: { id, label: id, transport: "fake", experimental: false, capabilities: FAKE_SPEC.capabilities }, reply }
}

describe("one channel per thing (B-3)", () => {
  test("an approval rides the card instead of a notification; the result too", async () => {
    const store = new Store(":memory:")
    const posts: Posted[] = []
    const pushes: string[] = []
    const card = new LiveCardNotifier(store, {
      gateway: "https://push.example",
      coalesceMs: 10,
      minStepIntervalMs: 10,
      log: () => {},
      fetch: (async (_url, init) => {
        posts.push(JSON.parse(String(init?.body)) as Posted)
        return new Response(JSON.stringify({ ok: true }))
      }) as typeof fetch,
    })
    store.putDevice({ id: "phone", session_key: SESSION_KEY, name: "Phone", created_at: 1, push_token: TICKET })
    const adapter = scripted("claude", async (_text, ctx) => {
      await ctx.askPermission({ tool: "Bash", title: "Run", detail: "bun test", kind: "execute", options: RUN_OPTIONS })
      ctx.emit({ type: "text", id: "a1", text: "全部通过。" })
    })
    const events: Frame[] = []
    const service = new SessionService(store, adapter, (frame) => events.push(frame), { push: (item) => pushes.push(item.kind), card })
    const created = await service.invoke("session.create", { title: "修复", agent: "claude" }, "c1")
    const sessionId = (created.result as { session: { id: string } }).session.id
    const registered = await service.invoke(
      "liveActivity.register",
      { scope: "computer", activityId: "act-1", pushToken: TOKEN, keepSeconds: 900, locale: "zh" },
      "r1",
      { deviceKey: SESSION_KEY },
    )
    expect(registered.type).toBe("result")
    // A newer phone also names its app language, which wins over the zh / en pair.
    await service.invoke("liveActivity.register", { scope: "computer", activityId: "act-1", pushToken: TOKEN, keepSeconds: 900, locale: "en", language: "ja" }, "r2", { deviceKey: SESSION_KEY })
    expect(store.liveCard(SESSION_KEY)?.locale).toBe("ja")
    await service.invoke("liveActivity.register", { scope: "computer", activityId: "act-1", pushToken: TOKEN, keepSeconds: 900, locale: "zh" }, "r3", { deviceKey: SESSION_KEY })
    expect(store.liveCard(SESSION_KEY)?.locale).toBe("zh-Hans")
    await service.invoke("message.send", { sessionId, text: "go" }, "s1")
    await waitFor(() => events.some((event) => event.name === "permission.asked"))
    const asked = events.find((event) => event.name === "permission.asked")!
    await service.invoke("permission.respond", { id: (asked.payload as { id: string }).id, optionId: "yes" }, "p1")
    await waitFor(() => posts.some((post) => post.contentState.phase === "done"))
    expect(pushes).toEqual([])
    const hello = await service.invoke("hello", {}, "h1", { deviceKey: SESSION_KEY })
    expect((hello.result as { liveCard?: boolean }).liveCard).toBe(true)
  })
})

describe("v103 plan progress", () => {
  test("an agent's plan event reaches the card as 第 x/y 项", async () => {
    const store = new Store(":memory:")
    const posts: Posted[] = []
    const card = new LiveCardNotifier(store, {
      gateway: "https://push.example",
      coalesceMs: 10,
      minStepIntervalMs: 10,
      log: () => {},
      fetch: (async (_url, init) => {
        posts.push(JSON.parse(String(init?.body)) as Posted)
        return new Response(JSON.stringify({ ok: true }))
      }) as typeof fetch,
    })
    store.putDevice({ id: "phone", session_key: SESSION_KEY, name: "Phone", created_at: 1, push_token: TICKET })
    let release = () => {}
    const adapter = scripted("claude", async (_text, ctx) => {
      ctx.emit({ type: "plan", id: "p1", entries: [{ content: "读代码", status: "completed" }, { content: "补测试", status: "in_progress" }, { content: "跑测试", status: "pending" }] })
      await new Promise<void>((resolve) => {
        release = resolve
      })
    })
    const service = new SessionService(store, adapter, () => {}, { push: () => {}, card })
    const created = await service.invoke("session.create", { title: "修复", agent: "claude" }, "c1")
    const sessionId = (created.result as { session: { id: string } }).session.id
    // Sent first: the phone registers its card once the turn is on its way.
    await service.invoke("message.send", { sessionId, text: "go" }, "s1")
    await service.invoke("liveActivity.register", { scope: "computer", activityId: "act-1", pushToken: TOKEN, keepSeconds: 900, locale: "zh" }, "r1", { deviceKey: SESSION_KEY })
    await waitFor(() => posts.some((post) => post.contentState.planTotal === 3))
    const state = posts.find((post) => post.contentState.planTotal === 3)!.contentState
    expect(state.planIndex).toBe(2)
    expect(open(state.planSealed, "plan", sessionId)).toBe("补测试")
    release()
    await card.abandonAll()
  })
})

const START_TOKEN = "cd".repeat(40)

describe("push-to-start (r70 1.2a)", () => {
  const allow = (h: ReturnType<typeof harness>, extra: Record<string, unknown> = {}) =>
    h.store.setDeviceLiveStart(SESSION_KEY, parseLiveStart({ token: START_TOKEN, accountId: "acct-1", hue: 210, locale: "zh", keepSeconds: 300, ...extra }))

  test("a turn with no card on the phone starts one by push, once per busy stretch", async () => {
    const h = harness()
    allow(h)
    const id = h.session("Terminal turn")
    h.card.turnStarted(id, "fix the build")
    await waitFor(() => h.posts.length === 1)
    const start = h.posts[0]!
    expect(start.event).toBe("start")
    expect(start.token).toBe(START_TOKEN)
    expect(start.attributesType).toBe("RudderComputerAttributes")
    expect(start.attributes?.accountId).toBe("acct-1")
    expect(start.attributes?.machineHue).toBe(210)
    expect(start.attributes?.machineName).toBeUndefined()
    expect(open(start.attributes?.machineNameSealed, "machineName", "")).toBe("test-mac")
    expect(start.contentState.sessionId).toBe(id)
    expect(start.contentState.phase).toBe("running")
    expect(open(start.contentState.titleSealed, "title", id)).toBe("Terminal turn")
    expect(start.alert).toEqual({ titleKey: "在跑", bodyKey: "电脑上有一轮开始了" })
    // A second session in the same stretch does not start a second card.
    h.card.turnStarted(h.session("Another"), "more")
    await Bun.sleep(60)
    expect(h.posts.filter((post) => post.event === "start")).toHaveLength(1)
  })

  test("a phone that registers its own card in time gets no start", async () => {
    const h = harness()
    allow(h)
    const id = h.session("Phone turn")
    h.card.turnStarted(id, "hi")
    h.register()
    await waitFor(() => h.posts.length >= 1)
    await Bun.sleep(60)
    expect(h.posts.every((post) => post.event === "update")).toBe(true)
  })

  test("an approval-first start alerts as one; after the stretch ends the next turn may start again", async () => {
    const h = harness()
    allow(h, { locale: "en" })
    const id = h.session("Ask")
    h.card.turnStarted(id, "go")
    h.card.armPermission(id, { id: "req-1", tool: "Bash", detail: "rm -rf build", kind: "execute" }, () => {})
    await waitFor(() => h.posts.length === 1)
    expect(h.posts[0]!.contentState.phase).toBe("waiting")
    expect(h.posts[0]!.alert).toEqual({ titleKey: "需批准", bodyKey: "有一项操作等你批准" })
    h.card.settle(id, "req-1")
    h.card.status(id, "idle", { phase: "done" })
    h.card.turnStarted(id, "again")
    await waitFor(() => h.posts.length === 2)
    expect(h.posts[1]!.event).toBe("start")
  })

  test("a gateway that predates start is asked once; a gone token is dropped", async () => {
    const old = harness(() => new Response(JSON.stringify({ error: "bad_request", message: 'event must be "update" or "end"' }), { status: 400 }))
    allow(old)
    old.card.turnStarted(old.session("A"), "x")
    await waitFor(() => old.posts.length === 1)
    old.card.status(old.store.listSessions()[0]!.id, "idle", { phase: "done" })
    old.card.turnStarted(old.session("B"), "y")
    await Bun.sleep(60)
    expect(old.posts).toHaveLength(1)

    const gone = harness(() => new Response(JSON.stringify({ error: "gone" }), { status: 410 }))
    allow(gone)
    gone.card.turnStarted(gone.session("A"), "x")
    await waitFor(() => gone.posts.length === 1)
    await waitFor(() => gone.store.deviceByKey(SESSION_KEY)?.live_start === null)
  })

  test("no liveStart, no start", async () => {
    const h = harness()
    h.card.turnStarted(h.session("A"), "x")
    await Bun.sleep(60)
    expect(h.posts).toHaveLength(0)
  })

  test("parseLiveStart checks its fields", () => {
    expect(() => parseLiveStart({ token: "zz", accountId: "a" })).toThrow()
    expect(() => parseLiveStart({ token: START_TOKEN, accountId: "" })).toThrow()
    expect(() => parseLiveStart({ token: START_TOKEN, accountId: "a", hue: 400 })).toThrow()
    expect(parseLiveStart({ token: START_TOKEN, accountId: "a", keepSeconds: 7 })).toEqual({ token: START_TOKEN, accountId: "a", locale: "zh-Hans", keepSeconds: 900 })
    // A newer phone names its app language; the zh / en pair is for older rudderd.
    expect(parseLiveStart({ token: START_TOKEN, accountId: "a", language: "de", locale: "en" }).locale).toBe("de")
    expect(parseLiveStart({ token: START_TOKEN, accountId: "a", locale: "en" }).locale).toBe("en")
  })
})

// 11-19 on device: 「/superpowers:requesting-code-rev…」 as the title, and 「正在使用 Implement D10: command rank…」 for a
// turn that was waiting on its sub-agent.
describe("island text: command titles and sub-agent steps", () => {
  test("a sub-agent step goes as stepTool agent with a short description, an ordinary tool without", async () => {
    const h = harness()
    const a = h.session("A")
    h.card.turnStarted(a, "a")
    h.register()
    await waitFor(() => h.posts.length >= 1)
    h.card.tool(a, { id: "t1", tool: "Agent", title: "Implement D10: command ranking for the palette", kind: "other", status: "running" })
    await waitFor(() => h.posts.some((post) => post.contentState.stepTool === "agent"))
    const agent = h.posts.find((post) => post.contentState.stepTool === "agent")!.contentState
    expect(agent.stepKind).toBe("other")
    expect(open(agent.stepSealed, "step", a)).toBe("Implement D10")
    h.card.tool(a, { id: "t2", tool: "wait", title: "wait", kind: "other", status: "running" })
    await waitFor(() => h.posts.some((post) => post.contentState.stepTool === "agent" && post.contentState.stepSealed === undefined))
    h.card.tool(a, { id: "t3", tool: "Bash", title: "bun test", kind: "execute", status: "running" })
    await waitFor(() => h.posts.some((post) => post.contentState.stepKind === "bash"))
    const bash = h.posts.find((post) => post.contentState.stepKind === "bash")!.contentState
    expect(bash.stepTool).toBeUndefined()
    expect(open(bash.stepSealed, "step", a)).toBe("bun test")
    await h.card.abandonAll()
  })

  test("the service hands the card the tool's name, so a Claude Task reads as a sub-agent", async () => {
    const store = new Store(":memory:")
    const posts: Posted[] = []
    const card = new LiveCardNotifier(store, {
      gateway: "https://push.example",
      coalesceMs: 10,
      minStepIntervalMs: 10,
      log: () => {},
      fetch: (async (_url, init) => {
        posts.push(JSON.parse(String(init?.body)) as Posted)
        return new Response(JSON.stringify({ ok: true }))
      }) as typeof fetch,
    })
    store.putDevice({ id: "phone", session_key: SESSION_KEY, name: "Phone", created_at: 1, push_token: TICKET })
    let release = () => {}
    const adapter = scripted("claude", async (_text, ctx) => {
      ctx.emit({ type: "tool", id: "t1", tool: "Task", title: "Implement D10: command ranking", kind: "other", status: "running", detail: "{}" })
      await new Promise<void>((resolve) => {
        release = resolve
      })
    })
    const service = new SessionService(store, adapter, () => {}, { push: () => {}, card })
    const created = await service.invoke("session.create", { title: "修复", agent: "claude" }, "c1")
    const sessionId = (created.result as { session: { id: string } }).session.id
    await service.invoke("message.send", { sessionId, text: "go" }, "s1")
    await service.invoke("liveActivity.register", { scope: "computer", activityId: "act-1", pushToken: TOKEN, keepSeconds: 900, locale: "zh" }, "r1", { deviceKey: SESSION_KEY })
    await waitFor(() => posts.some((post) => post.contentState.stepTool === "agent"))
    expect(open(posts.find((post) => post.contentState.stepTool === "agent")!.contentState.stepSealed, "step", sessionId)).toBe("Implement D10")
    release()
    await card.abandonAll()
  })
})

test("slow sure posts do not promote the next silent frame", async () => {
  const held = Promise.withResolvers<Response>()
  const h = harness((body) => body.priority === 10 && body.event === "update" && h.posts.length === 2
    ? held.promise : new Response("{}"), { heartbeatMs: 35 })
  const id = h.session("quiet turn")
  h.card.turnStarted(id, "go")
  h.register()
  await waitFor(() => h.posts.length === 1)
  h.advance(CARD_SURE_MS)
  await waitFor(() => h.posts.length === 2)
  h.advance(30)
  h.card.tool(id, { id: "step", title: "ordinary change", kind: "execute", status: "running" })
  await Bun.sleep(30)
  expect(h.posts).toHaveLength(2)
  held.resolve(new Response("{}"))
  try {
    await waitFor(() => h.posts.length >= 3)
    expect(h.posts.slice(0, 3).map((post) => post.priority)).toEqual([5, 10, 5])
  } finally {
    await h.card.abandonAll()
  }
})

test("a quiet card recovers after rate limiting and honors Retry-After", async () => {
  let status = 429
  const h = harness(() => new Response("{}", { status, headers: { "Retry-After": "1" } }), { retryMs: 20, heartbeatMs: 10_000 })
  const id = h.session("rate-limited")
  h.card.turnStarted(id, "go")
  h.register()
  try {
    await waitFor(() => h.posts.length === 1)
    status = 200
    await Bun.sleep(150)
    expect(h.posts).toHaveLength(1)
    await waitFor(() => h.posts.length === 2, 1_400)
    expect(h.posts[1]?.contentState.sessionId).toBe(id)
  } finally {
    await h.card.abandonAll()
  }
})

test("transient failures coalesce changes without two immediate requests", async () => {
  let status = 503
  const h = harness(() => new Response("{}", { status }), { retryMs: 180, heartbeatMs: 10_000 })
  const id = h.session("temporarily unavailable")
  h.card.turnStarted(id, "go")
  h.register()
  try {
    await waitFor(() => h.posts.length > 0)
    h.card.tool(id, { id: "t1", title: "old", kind: "execute", status: "running" })
    h.card.tool(id, { id: "t2", title: "latest", kind: "execute", status: "running" })
    await Bun.sleep(55)
    expect(h.posts).toHaveLength(1)
    status = 200
    await waitFor(() => h.posts.length >= 2)
    expect(open(h.posts[1]?.contentState.stepSealed, "step", id)).toBe("latest")
  } finally {
    await h.card.abandonAll()
  }
})

test("a progress batch reuses its card list and per-card candidates", async () => {
  const h = harness(undefined, { heartbeatMs: 10_000 })
  const ids = Array.from({ length: 50 }, (_, index) => h.session(`session ${index}`))
  for (const id of ids) h.card.turnStarted(id, "go")
  const register = (deviceKey: string, index: number) => {
    h.card.register({ activityId: `act-${index}`, pushToken: TOKEN, keepSeconds: 300, locale: "zh", deviceKey })
  }
  register(SESSION_KEY, 0)
  for (let index = 1; index < 8; index++) {
    const key = index.toString(16).repeat(64)
    h.store.putDevice({ id: `phone-${index}`, session_key: key, name: "Phone", created_at: 1, push_token: TICKET })
    register(key, index)
  }
  await waitFor(() => h.posts.length === 8)
  await Bun.sleep(30)
  const listRows = h.store.listLiveCards.bind(h.store)
  let reads = 0
  h.store.listLiveCards = () => { reads++; return listRows() }
  const instrumented = h.card as unknown as { candidates: (row: NonNullable<ReturnType<Store["liveCard"]>>) => unknown[] }
  const candidates = instrumented.candidates.bind(h.card)
  let walks = 0
  instrumented.candidates = (row) => { walks++; return candidates(row) }
  for (const [index, id] of ids.entries()) {
    h.card.tool(id, { id: `tool-${index}`, title: "running", kind: "execute", status: "running" })
  }
  try {
    await waitFor(() => h.posts.length === 16)
    expect(reads).toBe(50)
    expect(walks).toBe(8)
  } finally {
    await h.card.abandonAll()
  }
})

test("ended tracks expire while no phone has a card", async () => {
  const h = harness(undefined, { trackKeepMs: 20 })
  const ended = h.session("ended")
  const running = h.session("running")
  h.card.turnStarted(ended, "go")
  h.card.turnStarted(running, "still running")
  h.card.status(ended, "idle", { phase: "done" })
  h.advance(30)
  const tracks = (h.card as unknown as { tracks: Map<string, unknown> }).tracks
  await waitFor(() => !tracks.has(ended), 300)
  expect(tracks.has(running)).toBe(true)
  await h.card.abandonAll()
})

test("a retiring token cannot send a replacement card's approval fallback", async () => {
  const oldEnd = Promise.withResolvers<Response>()
  const newWaiting = Promise.withResolvers<Response>()
  const replacement = "cd".repeat(32)
  const h = harness((post) => {
    if (post.event === "end" && post.token === TOKEN) return oldEnd.promise
    if (post.token === replacement && post.contentState.phase === "waiting") return newWaiting.promise
    return new Response("{}")
  })
  const id = h.session("replacement")
  h.card.turnStarted(id, "go")
  h.register()
  await waitFor(() => h.posts.length > 0)
  h.card.register({ activityId: "replacement", pushToken: replacement, keepSeconds: 300, locale: "zh", deviceKey: SESSION_KEY })
  let fallbacks = 0
  try {
    expect(h.card.armPermission(id, { id: "p2", tool: "Bash", detail: "step", kind: "execute" }, () => fallbacks++)).toBe(true)
    await waitFor(() => h.posts.some((post) => post.token === replacement && post.contentState.phase === "waiting"))
    oldEnd.resolve(new Response("{}", { status: 503 }))
    await waitFor(() => h.posts.filter((post) => post.event === "end" && post.token === TOKEN).length === 2)
    await Bun.sleep(20)
    expect(fallbacks).toBe(0)
  } finally {
    oldEnd.resolve(new Response("{}"))
    newWaiting.resolve(new Response("{}"))
    await h.card.abandonAll()
  }
})
