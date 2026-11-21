import { describe, expect, test } from "bun:test"
import type { AgentAdapter } from "./adapter/types"
import { FAKE_SPEC } from "./adapter/fake"
import { copyError, phoneCopy } from "./phone-copy"
import {
  firstPromptLine,
  firstSentence,
  liveAad,
  openBytes,
  openLive,
  openPush,
  parseGateway,
  PushNotifier,
  pushKey,
  retryAfterMs,
  sealPush,
  type PushPayload,
} from "./push"
import { SessionService } from "./session-service"
import { Store } from "./store"

// Shared with RudderPushTests.swift: the app must open what the daemon seals.
const VECTOR_KEY = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
const VECTOR_PUSH_KEY = "0f1e279fcc7d6fcadb829ca04042b0c0a897d000b82d1e4c717cb2c22cecc0aa"
const VECTOR_SEALED =
  "BWAzrsBujgd/lfJ72+uyoxl1HRansoirwopQJ+elZqw098RxDwb+J6rS7+Oqcjd1js5iH8BPpZGILgqo4cOvtpKUhg99dwCXRYIVvAq0lT+1Uelr90FyJYwTpebRNh4kDGr4AY4djRpKZmSVx9S3RS7ybcBztrgxYP2+32y36Eas0GKc98xcrFIffaNgXQ=="
const VECTOR_PAYLOAD: PushPayload = { v: 1, kind: "permission", sessionId: "s-1", title: "修复登录", body: "Bash: 运行 ls", permissionId: "p-1" }

// a done and a doneBatch, also opened by RudderPushTests.swift.
const VECTOR_DONE_SEALED =
  "2I6uZUHIrTO3csULMbxSKAc580Uy7mY5z3W4AVe1e45KYf00R5X3FyJW3nbXwGUrqLdrnyIOsJ5HTEhxE3Y01Ddul6VvaHDwXTx2077AtRDHfg4JlfT9KEFIwd4rPEO4UUcgWkUlwX1Qr0eSUxItB/1wiy2t1qKvj6kN2JSUVK3RIMlKurEeXMM+hFcMlqwkU+R14a7t7HZGW77ctKIOQvwSa3QM7g46zQHyWgWpvYMu0PQQYMkS2wzAEhtPQSobYzFy8cHTx9uVOTwr8vRpx6uuI8GNtpxSnf2ykn1/JCKFijRHTcdHUcfE7q1q2VxCvMlbMXlCshUprngv8IXGyS6Hm5UX3KXQzOEIUtdQJ4Sm/dPsd/GrVR+PYx9GfQ/n5YlGQ8G62RZoD6ghRGfw9lKzJjx8aFyHsPJDsc4LZEYj53nR6+roBF8="
const VECTOR_DONE: PushPayload = {
  v: 1,
  kind: "done",
  sessionId: "s-1",
  title: "修复登录跳转",
  body: "登录后回跳改成读 next 参数，补了 3 条测试，全部通过。",
  machine: "mac-studio",
  agent: "Claude Code",
  outcome: "done",
  firstPrompt: "登录后跳回首页了",
  changes: { added: 26, removed: 2, files: 3 },
}
const VECTOR_BATCH_SEALED =
  "L35cwTY6M8+K+gwIrJvNrxwMMdcCTGXHkUJq3c7EnxMZ+nDQfI3COAXacsMQHGlS3mPw20I3BzbE8P5+xHRAMl8E0N4zOAM77yvySIve8jOxlpRBpK85nYkMfzQNTiG2gmYGP54nHsNNoVuv9RW9E3tB+smHs6MCti/RIcBHEk9NxqC1G/SWuotcN/dBXhNMsg3RZToqN7U7cRaUSVV1yLbIHT2cYM5wVSFbJcqT4wekptm0tsR2zb1hoIJhQfV7sF2lKC9FSu084drKf5PKE66TkEEUcwm4HWHuAX5pvIoyYLchWZgNiAJAx3YqmbdyJD6KjIx+UNZXKtCt3YEwOmtcGF/SL44xguFkMcGh9x0Jgvv+keJseVen29nkohKxklj/R25tryS+50skb/Z/W2I/d1HigImeosHTr6kGdKKrdl844WNetjbbDVlZf4fyNFUoL8xYg0A1OG8d76eMq8jIQSsw0ZnLCQqp6BNijiS9TADcqal5"
const VECTOR_BATCH: PushPayload = {
  v: 1,
  kind: "doneBatch",
  sessionId: "",
  title: "3 个会话做完了",
  body: "修复登录跳转 · 迁移脚本 · 拆会话层",
  machine: "mac-studio",
  sessions: [
    { sessionId: "s-1", title: "修复登录跳转" },
    { sessionId: "s-2", title: "迁移脚本" },
    { sessionId: "s-3", title: "拆会话层" },
  ],
  count: 3,
  added: 71,
  removed: 18,
  files: 9,
}

const TICKET = "dGlja2V0LWZvci1waG9uZS1vbmU"

async function waitFor(predicate: () => boolean, timeoutMs = 2000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out")
    await Bun.sleep(5)
  }
}

type Call = { url: string; body: { ticket: string; ciphertext: string; collapseId?: string } }

function gateway(...replies: Array<Response | Error>) {
  const calls: Call[] = []
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) })
    const next = replies.shift() ?? new Response(JSON.stringify({ ok: true }))
    if (next instanceof Error) throw next
    return next
  }) as typeof globalThis.fetch
  return { calls, fetch }
}

function reply(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function pairedStore(...tickets: Array<string | null>) {
  const store = new Store(":memory:")
  for (const [index, ticket] of tickets.entries()) {
    store.putDevice({ id: `d${index}`, session_key: index.toString(16).padStart(64, "a"), name: "phone", created_at: index, push_token: ticket })
  }
  return store
}

// A Live Activity field bound to its place; RudderPushTests opens the same bytes.
const VECTOR_LIVE_SEALED = "H8gXQYtu9o1so8CrxEmpV4fruHA2xleGNvTE1VXru7xwY3U1m12dlQ=="
const VECTOR_LIVE_BINDING = { field: "approval.summary", sessionId: "s-1", requestId: "req-1" } as const
const VECTOR_LIVE_AAD =
  "0000000e727564646572206c69766520763200000010617070726f76616c2e73756d6d61727900000003732d31000000057265712d31"

describe("push sealing", () => {
  test("a live field opens only under the binding it was sealed with", () => {
    expect(liveAad(VECTOR_LIVE_BINDING).toString("hex")).toBe(VECTOR_LIVE_AAD)
    expect(openLive(VECTOR_KEY, VECTOR_LIVE_SEALED, VECTOR_LIVE_BINDING)).toBe("rm -rf build")
    expect(() => openLive(VECTOR_KEY, VECTOR_LIVE_SEALED, { ...VECTOR_LIVE_BINDING, requestId: "req-2" })).toThrow()
    expect(() => openLive(VECTOR_KEY, VECTOR_LIVE_SEALED, { ...VECTOR_LIVE_BINDING, field: "approval.tool" })).toThrow()
    expect(() => openBytes(VECTOR_KEY, VECTOR_LIVE_SEALED)).toThrow()
  })

  test("the fixed vector opens to the same payload and key on both sides", () => {
    expect(pushKey(VECTOR_KEY).toString("hex")).toBe(VECTOR_PUSH_KEY)
    expect(openPush(VECTOR_KEY, VECTOR_SEALED)).toEqual(VECTOR_PAYLOAD)
  })

  test("the done and doneBatch vectors open on both sides (v67 A-1)", () => {
    expect(openPush(VECTOR_KEY, VECTOR_DONE_SEALED)).toEqual(VECTOR_DONE)
    expect(openPush(VECTOR_KEY, VECTOR_BATCH_SEALED)).toEqual(VECTOR_BATCH)
  })

  // Audit 2026-11-10 (P3, reproduced): five long titles in a doneBatch threw, and the merged notice was lost.
  test("a doneBatch of long session titles is cut to fit instead of dropped", () => {
    const sessions = Array.from({ length: 5 }, (_, index) => ({ sessionId: `s${index}`, title: "标".repeat(400) }))
    const payload: PushPayload = { ...VECTOR_BATCH, body: sessions.map((entry) => entry.title).join(" · "), sessions }
    const opened = openPush(VECTOR_KEY, sealPush(VECTOR_KEY, payload))
    expect(opened.sessions).toHaveLength(5)
    expect(opened.sessions!.every((entry) => entry.title.startsWith("标") && entry.title.endsWith("…"))).toBe(true)
  })

  test("an oversized done gives up the body, then the first prompt, then the stderr line, and fits 1800 bytes", () => {
    const payload: PushPayload = {
      ...VECTOR_DONE,
      outcome: "failed",
      title: "标".repeat(150),
      body: "体".repeat(200),
      firstPrompt: "问".repeat(60),
      reason: { code: "agent_exited", exitCode: 1, detail: "错".repeat(600) },
    }
    const opened = openPush(VECTOR_KEY, sealPush(VECTOR_KEY, payload))
    expect(Buffer.byteLength(JSON.stringify(opened), "utf8")).toBeLessThanOrEqual(1800)
    expect([...opened.body].length).toBeLessThanOrEqual(1)
    expect(opened.firstPrompt).toBeUndefined()
    expect(opened.reason).toEqual({ code: "agent_exited", exitCode: 1 })
    expect(opened.changes).toEqual(VECTOR_DONE.changes)
    // Room left: the prompt and the detail stay.
    const roomy = openPush(VECTOR_KEY, sealPush(VECTOR_KEY, { ...payload, title: "t", body: "好", reason: { code: "agent_exited", exitCode: 1, detail: "error: --fast" } }))
    expect(roomy.firstPrompt).toBe("问".repeat(60))
    expect(roomy.reason).toEqual({ code: "agent_exited", exitCode: 1, detail: "error: --fast" })
  })

  test("a failed done's copy goes first when the notice is too big; one that fits stays", () => {
    const detail = "错".repeat(700)
    const copy = phoneCopy.agentStartFailed("Codex", detail)
    const failed: PushPayload = { ...VECTOR_DONE, outcome: "failed", body: copy.text, copy }
    const opened = openPush(VECTOR_KEY, sealPush(VECTOR_KEY, failed))
    expect(Buffer.byteLength(JSON.stringify(opened), "utf8")).toBeLessThanOrEqual(1800)
    expect(opened.copy).toBeUndefined()
    expect(opened.body.startsWith("Codex 启动失败：错")).toBe(true)
    const small = phoneCopy.agentStartFailed("Codex", "boom")
    expect(openPush(VECTOR_KEY, sealPush(VECTOR_KEY, { ...failed, body: small.text, copy: small })).copy).toEqual(small)
  })

  test("the first sentence skips a heading, strips Markdown and stops at the first sentence end", () => {
    expect(firstSentence("## 结果\n\n登录后回跳改成读 **next** 参数，补了 3 条测试。接着我又看了一下。")).toBe("登录后回跳改成读 next 参数，补了 3 条测试。")
    expect(firstSentence("Updated `next.js` config. Then ran the tests.")).toBe("Updated next.js config.")
    expect(firstSentence("## Done")).toBe("Done")
    // v115: a line break ends it; dots inside names and paths do not.
    expect(firstSentence("Fixed the redirect\nThen ran the tests.")).toBe("Fixed the redirect")
    expect(firstSentence("TypeError: cannot read src/auth/redirect.ts. Stack follows")).toBe("TypeError: cannot read src/auth/redirect.ts.")
    expect(firstSentence("改好了 v1.2.3 的配置。然后跑了测试")).toBe("改好了 v1.2.3 的配置。")
    expect([...firstSentence("长".repeat(200))]).toHaveLength(90)
    expect(firstPromptLine("\n  把迁移脚本改成增量的\n旧表先别删")).toBe("把迁移脚本改成增量的")
    expect([...(firstPromptLine("问".repeat(100)) ?? "")]).toHaveLength(60)
  })

  test("seal → open round-trips with a fresh nonce each time", () => {
    const a = sealPush(VECTOR_KEY, VECTOR_PAYLOAD)
    const b = sealPush(VECTOR_KEY, VECTOR_PAYLOAD)
    expect(a).not.toBe(b)
    expect(openPush(VECTOR_KEY, a)).toEqual(VECTOR_PAYLOAD)
  })

  test("another device's key cannot open it", () => {
    const sealed = sealPush(VECTOR_KEY, VECTOR_PAYLOAD)
    expect(() => openPush("ff".repeat(32), sealed)).toThrow()
  })

  test("a long body is cut to fit the APNs budget and still opens", () => {
    const sealed = sealPush(VECTOR_KEY, { ...VECTOR_PAYLOAD, title: "标".repeat(500), body: "长".repeat(5000) })
    const opened = openPush(VECTOR_KEY, sealed)
    expect([...opened.title].length).toBe(200)
    expect(opened.body.endsWith("…")).toBe(true)
    expect(new TextEncoder().encode(JSON.stringify(opened)).byteLength).toBeLessThanOrEqual(1800)
    expect(sealed.length).toBeLessThanOrEqual(3000)
  })

  test("session keys that are not 32 bytes of hex are refused", () => {
    expect(() => pushKey("abcd")).toThrow("32 bytes")
  })
})

describe("gateway URL", () => {
  test("https anywhere, plain http only to this machine", () => {
    expect(parseGateway("https://push.example.com/")).toBe("https://push.example.com")
    expect(parseGateway("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787")
    expect(parseGateway("http://localhost:8787/")).toBe("http://localhost:8787")
    expect(() => parseGateway("http://push.example.com")).toThrow("must be https")
    expect(() => parseGateway("push.example.com")).toThrow("not a URL")
  })
})

describe("PushNotifier", () => {
  test("seals per device and posts ticket, ciphertext and collapse id; skips devices without a ticket", async () => {
    const store = pairedStore(TICKET, null)
    const { calls, fetch } = gateway()
    await new PushNotifier(store, { gateway: "https://push.example.com", fetch }).notify(VECTOR_PAYLOAD)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe("https://push.example.com/v1/push")
    expect(calls[0]!.body.ticket).toBe(TICKET)
    expect(calls[0]!.body.collapseId).toBe("p-1")
    expect(openPush(store.listDevices()[0]!.session_key, calls[0]!.body.ciphertext)).toEqual({ ...VECTOR_PAYLOAD, sentAt: expect.any(Number) })
  })

  test("the sealed notice carries when it was first sent, and a retry resends the same ciphertext", async () => {
    const store = pairedStore(TICKET)
    const before = Date.now()
    const { calls, fetch } = gateway(reply(502, { error: "upstream" }), reply(200, { ok: true }))
    await new PushNotifier(store, { gateway: "https://g", fetch, retryDelayMs: 5, log: () => {} }).notify(VECTOR_PAYLOAD)
    expect(calls).toHaveLength(2)
    expect(calls[1]!.body.ciphertext).toBe(calls[0]!.body.ciphertext)
    const opened = openPush(store.listDevices()[0]!.session_key, calls[1]!.body.ciphertext)
    expect(opened.sentAt).toBeGreaterThanOrEqual(before)
    expect(opened.sentAt).toBeLessThanOrEqual(Date.now())
  })

  test("gone and bad_ticket drop the ticket so the app registers again", async () => {
    const store = pairedStore(TICKET, `${TICKET}2`)
    const logs: string[] = []
    const { fetch } = gateway(reply(410, { error: "gone" }), reply(400, { error: "bad_ticket" }))
    await new PushNotifier(store, { gateway: "https://g", fetch, log: (line) => logs.push(line) }).notify(VECTOR_PAYLOAD)
    expect(store.listDevices().map((device) => device.push_token)).toEqual([null, null])
    expect(logs).toHaveLength(2)
  })

  test("a dropped ticket is reported with the gateway's reason, or its error on an older gateway (r68 0-2)", async () => {
    const store = pairedStore(TICKET, `${TICKET}2`)
    const { fetch } = gateway(reply(410, { error: "gone", reason: "BadDeviceToken" }), reply(410, { error: "gone" }))
    const notifier = new PushNotifier(store, { gateway: "https://g", fetch, log: () => {} })
    const dropped: string[] = []
    notifier.onTicketDropped = (_device, reason) => dropped.push(reason)
    await notifier.notify(VECTOR_PAYLOAD)
    expect(dropped.sort()).toEqual(["BadDeviceToken", "gone"])
    // A second drop of an already cleared ticket is not reported again.
    await notifier.notify(VECTOR_PAYLOAD)
    expect(dropped).toHaveLength(2)
  })

  test("a ticket registered while the push was in flight survives the drop", async () => {
    const store = pairedStore(TICKET)
    const fresh = `${TICKET}-fresh`
    const fetch = (async () => {
      store.setDevicePushToken(store.listDevices()[0]!.session_key, fresh)
      return reply(410, { error: "gone" })
    }) as unknown as typeof globalThis.fetch
    await new PushNotifier(store, { gateway: "https://g", fetch, log: () => {} }).notify(VECTOR_PAYLOAD)
    expect(store.listDevices()[0]!.push_token).toBe(fresh)
  })

  test("5xx and network errors are retried once, then logged", async () => {
    const store = pairedStore(TICKET)
    const logs: string[] = []
    const retried = gateway(reply(502, { error: "upstream" }), reply(200, { ok: true }))
    await new PushNotifier(store, { gateway: "https://g", fetch: retried.fetch, retryDelayMs: 1, log: (line) => logs.push(line) }).notify(VECTOR_PAYLOAD)
    expect(retried.calls).toHaveLength(2)
    expect(logs).toEqual([])

    const down = gateway(new Error("ECONNREFUSED"), new Error("ECONNREFUSED"))
    await new PushNotifier(store, { gateway: "https://g", fetch: down.fetch, retryDelayMs: 1, log: (line) => logs.push(line) }).notify(VECTOR_PAYLOAD)
    expect(down.calls).toHaveLength(2)
    expect(logs[0]).toContain("ECONNREFUSED")
    expect(store.listDevices()[0]!.push_token).toBe(TICKET)
  })

  // Audit 2026-11-10 (P3): an approval notice lost to a gateway outage was never sent again.
  test("an approval notice the gateway could not take goes again later while it still waits, and stops once answered", async () => {
    const store = pairedStore(TICKET)
    const { calls, fetch } = gateway(new Error("ECONNREFUSED"), new Error("ECONNREFUSED"), reply(200, { ok: true }))
    const notifier = new PushNotifier(store, { gateway: "https://g", fetch, retryDelayMs: 1, laterDelayMs: 20, log: () => {} })
    let waiting = true
    notifier.stillWaiting = () => waiting
    await notifier.notify(VECTOR_PAYLOAD)
    expect(calls).toHaveLength(2)
    const deadline = Date.now() + 2000
    while (calls.length < 3 && Date.now() < deadline) await Bun.sleep(5)
    expect(calls).toHaveLength(3)
    expect(openPush(store.listDevices()[0]!.session_key, calls[2]!.body.ciphertext).permissionId).toBe(VECTOR_PAYLOAD.permissionId)

    const answered = gateway(new Error("down"), new Error("down"), reply(200, { ok: true }))
    const later = new PushNotifier(store, { gateway: "https://g", fetch: answered.fetch, retryDelayMs: 1, laterDelayMs: 20, log: () => {} })
    later.stillWaiting = () => waiting
    await later.notify(VECTOR_PAYLOAD)
    waiting = false
    await Bun.sleep(100)
    expect(answered.calls).toHaveLength(2)
  })

  // Review 2026-11-11 (P3): a rate-limited approval notice was dropped.
  test("a rate-limited approval notice goes again after a backoff, no sooner than Retry-After", async () => {
    const store = pairedStore(TICKET)
    const limited = new Response(JSON.stringify({ error: "rate_limited" }), { status: 429, headers: { "retry-after": "1" } })
    const { calls, fetch } = gateway(limited, reply(200, { ok: true }))
    const notifier = new PushNotifier(store, { gateway: "https://g", fetch, retryDelayMs: 1, laterDelayMs: 5, log: () => {} })
    notifier.stillWaiting = () => true
    const sent = Date.now()
    await notifier.notify(VECTOR_PAYLOAD)
    expect(calls).toHaveLength(1)
    await Bun.sleep(300)
    expect(calls).toHaveLength(1)
    await waitFor(() => calls.length === 2, 3000)
    expect(Date.now() - sent).toBeGreaterThanOrEqual(990)
    expect(openPush(store.listDevices()[0]!.session_key, calls[1]!.body.ciphertext).permissionId).toBe(VECTOR_PAYLOAD.permissionId)

    // Without Retry-After the wait doubles per try.
    const again = gateway(reply(429, { error: "rate_limited" }), reply(429, { error: "rate_limited" }), reply(200, { ok: true }))
    const backoff = new PushNotifier(store, { gateway: "https://g", fetch: again.fetch, retryDelayMs: 1, laterDelayMs: 20, log: () => {} })
    backoff.stillWaiting = () => true
    await backoff.notify(VECTOR_PAYLOAD)
    await waitFor(() => again.calls.length === 3, 2000)
    expect(again.calls).toHaveLength(3)
  })

  test("Retry-After is read as seconds or as a date", () => {
    expect(retryAfterMs(null)).toBeUndefined()
    expect(retryAfterMs("2")).toBe(2000)
    expect(retryAfterMs("soon")).toBeUndefined()
    expect(retryAfterMs(new Date(10_000).toUTCString(), 4_000)).toBe(6_000)
  })

  test("4xx other than gone is logged once and not retried", async () => {
    const store = pairedStore(TICKET)
    const logs: string[] = []
    const { calls, fetch } = gateway(reply(429, { error: "rate_limited" }))
    await new PushNotifier(store, { gateway: "https://g", fetch, retryDelayMs: 1, log: (line) => logs.push(line) }).notify(VECTOR_PAYLOAD)
    expect(calls).toHaveLength(1)
    expect(logs[0]).toContain("429 rate_limited")
    expect(store.listDevices()[0]!.push_token).toBe(TICKET)
  })
})

describe("session service push hook", () => {
  const OPTIONS = [{ id: "yes", label: "Yes", kind: "allow_once" as const }]

  function service(reply: AgentAdapter["reply"], push?: (payload: PushPayload) => void) {
    const store = new Store(":memory:")
    const adapter: AgentAdapter = { spec: { ...FAKE_SPEC, id: "s", label: "s" }, reply }
    return { store, service: new SessionService(store, adapter, () => {}, push ? { push } : {}) }
  }

  test("a permission and a question each push the session title and what is waiting", async () => {
    const pushed: PushPayload[] = []
    const { service: svc } = service(async (_text, ctx) => {
      await ctx.askPermission({ tool: "Bash", title: "Run ls", detail: "ls", kind: "execute", options: OPTIONS })
      await ctx.askQuestion({ questions: [{ question: "Continue?", options: [{ label: "Yes" }], multiSelect: false, allowsOther: true }] })
    }, (payload) => pushed.push(payload))
    const created = await svc.invoke("session.create", { title: "修复登录", agent: "s" }, "c")
    const sessionId = (created.result as { session: { id: string } }).session.id
    await svc.invoke("message.send", { sessionId, text: "go" }, "m")
    await waitFor(() => pushed.length === 1)
    expect(pushed[0]).toMatchObject({ v: 1, kind: "permission", sessionId, title: "修复登录", body: "Bash: Run ls", tool: "Bash", command: "Run ls", agent: "s" })
    expect(pushed[0]!.machine).toBeString()
    await svc.invoke("permission.respond", { id: pushed[0]!.permissionId, optionId: "yes" }, "p")
    await waitFor(() => pushed.length === 2)
    expect(pushed[1]).toMatchObject({ v: 1, kind: "question", sessionId, title: "修复登录", body: "Continue?" })
    expect(pushed[1]!.questionId).toBeString()
    await svc.invoke("question.respond", { id: pushed[1]!.questionId, answers: { "Continue?": "Yes" } }, "q")
  })

  test("a question push carries q, machine and agent; buttons only for one single choice with at most 3 options", async () => {
    const pushed: PushPayload[] = []
    const asks = [
      [{ question: "会话缓存放在哪里？", header: "存储", options: [{ label: "SQLite", description: "单文件" }, { label: "内存" }], multiSelect: false, allowsOther: true }],
      [{ question: "旧快照怎么处理？", options: [{ label: "a" }, { label: "b" }, { label: "c" }, { label: "d" }], multiSelect: false, allowsOther: false }],
      [{ question: "这次要补哪些测试？", options: [{ label: "单元测试" }], multiSelect: true, allowsOther: true }],
      [
        { question: "Q1", header: "存储", options: [{ label: "a" }], multiSelect: false, allowsOther: true },
        { question: "Q2", options: [{ label: "b" }], multiSelect: false, allowsOther: true },
      ],
    ]
    const { service: svc } = service(async (_text, ctx) => {
      for (const questions of asks) await ctx.askQuestion({ questions })
    }, (payload) => pushed.push(payload))
    const created = await svc.invoke("session.create", { title: "加会话缓存", agent: "s" }, "c")
    const sessionId = (created.result as { session: { id: string } }).session.id
    await svc.invoke("message.send", { sessionId, text: "go" }, "m")
    for (let index = 0; index < asks.length; index++) {
      await waitFor(() => pushed.length === index + 1)
      const asked = asks[index]!
      const first = asked[0]!
      await svc.invoke("question.respond", { id: pushed[index]!.questionId, answers: { [first.question]: first.options[0]!.label } }, `q${index}`)
    }
    expect(pushed[0]).toMatchObject({ machine: expect.any(String), agent: "s" })
    expect(pushed[0]!.q).toEqual({
      count: 1,
      question: "会话缓存放在哪里？",
      headers: ["存储"],
      multiSelect: false,
      optionCount: 2,
      options: [{ label: "SQLite", description: "单文件" }, { label: "内存" }],
      allowsOther: true,
    })
    expect(pushed[1]!.q).toMatchObject({ count: 1, optionCount: 4, allowsOther: false, headers: [""] })
    expect(pushed[1]!.q!.options).toBeUndefined()
    expect(pushed[2]!.q).toMatchObject({ count: 1, multiSelect: true })
    expect(pushed[2]!.q!.options).toBeUndefined()
    expect(pushed[3]!.q).toMatchObject({ count: 2, headers: ["存储", ""], question: "Q1" })
    expect(pushed[3]!.q!.options).toBeUndefined()
  })

  test("an oversized question notice gives up the body, descriptions, question and headers, in that order", () => {
    const long = (char: string, count: number) => char.repeat(count)
    const payload: PushPayload = {
      v: 1,
      kind: "question",
      sessionId: "s",
      title: "t",
      body: long("体", 400),
      questionId: "q",
      machine: "mac-studio",
      agent: "Claude Code",
      q: {
        count: 1,
        question: long("问", 300),
        headers: [long("头", 30)],
        multiSelect: false,
        optionCount: 3,
        options: [0, 1, 2].map((index) => ({ label: `${index}${long("选", 60)}`, description: long("说", 60) })),
        allowsOther: true,
      },
    }
    const opened = openPush(VECTOR_KEY, sealPush(VECTOR_KEY, payload))
    expect(Buffer.byteLength(JSON.stringify(opened), "utf8")).toBeLessThanOrEqual(1800)
    // Caps first: label 40, description 44, question 200, header 24.
    expect([...opened.q!.options![0]!.label]).toHaveLength(40)
    expect([...opened.q!.headers[0]!].length).toBeLessThanOrEqual(24)
    expect([...opened.body].length).toBeLessThan(400)
    expect(opened.machine).toBe("mac-studio")

    const huge = { ...payload, q: { ...payload.q!, headers: [long("头", 30), long("头", 30), long("头", 30), long("头", 30)] } }
    const shrunk = openPush(VECTOR_KEY, sealPush(VECTOR_KEY, huge))
    expect(Buffer.byteLength(JSON.stringify(shrunk), "utf8")).toBeLessThanOrEqual(1800)
    expect([...shrunk.body].length).toBeLessThanOrEqual(1)
    expect(shrunk.q!.options!.every((option) => option.description === undefined || [...option.description].length <= 24)).toBe(true)
  })

  test("a finished turn pushes done with the reply's first sentence and changes, a failed one with its reason", async () => {
    const pushed: PushPayload[] = []
    const collapse: Array<string | undefined> = []
    let fail: Error | undefined
    const store = new Store(":memory:")
    const adapter: AgentAdapter = {
      spec: { ...FAKE_SPEC, id: "s", label: "Claude Code" },
      async reply(_text, ctx) {
        if (fail) throw fail
        ctx.emit({ type: "text", id: "r1", text: "## Done\n\nAll **tests** pass. Then I tidied up." })
      },
    }
    const svc = new SessionService(store, adapter, () => {}, {
      push: (payload, options) => {
        pushed.push(payload)
        collapse.push(options?.collapseId)
      },
    })
    const created = await svc.invoke("session.create", { title: "修复登录", agent: "s" }, "c")
    const sessionId = (created.result as { session: { id: string } }).session.id
    await svc.invoke("message.send", { sessionId, text: "登录后跳回首页了\n帮我看看" }, "m")
    await waitFor(() => pushed.length === 1)
    expect(pushed[0]).toMatchObject({
      v: 1,
      kind: "done",
      sessionId,
      title: "修复登录",
      body: "All tests pass.",
      agent: "Claude Code",
      outcome: "done",
      firstPrompt: "登录后跳回首页了",
      changes: { added: 0, removed: 0, files: 0 },
    })
    expect(pushed[0]!.machine).toBeString()
    expect(collapse[0]).toStartWith("done-w-")

    fail = new Error("agent crashed")
    await svc.invoke("message.send", { sessionId, text: "again" }, "m2")
    await waitFor(() => pushed.length === 2)
    expect(pushed[1]).toMatchObject({ kind: "done", outcome: "failed", body: "agent crashed" })
    expect(pushed[1]!.reason).toBeUndefined()
    expect(collapse[1]).toBe(`done-${sessionId}`)

    fail = new Error("Claude AI usage limit reached|1761944400")
    await svc.invoke("message.send", { sessionId, text: "third" }, "m3")
    await waitFor(() => pushed.length === 3)
    expect(pushed[2]).toMatchObject({ outcome: "failed", reason: { code: "usage_limit", resetsAt: 1761944400000 } })
    expect(pushed[2]!.copy).toBeUndefined()

    // Copy rudderd wrote for the phone rides along; `body` stays its text for an older extension.
    const copy = phoneCopy.agentStartFailed("Claude Code", phoneCopy.agentMismatch("agent", "Claude Code", "grok"))
    fail = copyError(copy)
    await svc.invoke("message.send", { sessionId, text: "fourth" }, "m4")
    await waitFor(() => pushed.length === 4)
    expect(pushed[3]).toMatchObject({ outcome: "failed", body: copy.text, copy })
  })

  test("a turn without a reply pushes done with an empty body; a stopped turn pushes nothing", async () => {
    const pushed: PushPayload[] = []
    let hold = false
    const { service: svc } = service(async (_text, ctx) => {
      if (hold) await new Promise((resolve) => ctx.signal.addEventListener("abort", resolve, { once: true }))
    }, (payload) => pushed.push(payload))
    const created = await svc.invoke("session.create", { title: "t", agent: "s" }, "c")
    const sessionId = (created.result as { session: { id: string } }).session.id
    await svc.invoke("message.send", { sessionId, text: "go" }, "m")
    await waitFor(() => pushed.length === 1)
    expect(pushed[0]).toMatchObject({ kind: "done", body: "", outcome: "done" })

    hold = true
    await svc.invoke("message.send", { sessionId, text: "long" }, "m2")
    await svc.invoke("message.steer", { sessionId, action: "cancel" }, "s")
    await Bun.sleep(50)
    expect(pushed).toHaveLength(1)
  })

  test("done pushes collapse per session", async () => {
    const store = pairedStore(TICKET)
    const { calls, fetch } = gateway()
    await new PushNotifier(store, { gateway: "https://g", fetch }).notify({ v: 1, kind: "done", sessionId: "s-9", title: "t", body: "b" })
    expect(calls[0]!.body.collapseId).toBe("done-s-9")
  })

  test("device.registerPush stores a gateway ticket and says whether this machine pushes", async () => {
    const { store, service: withPush } = service(async () => {}, () => {})
    store.putDevice({ id: "d", session_key: "k", name: "phone", created_at: 0, push_token: null })
    const ok = await withPush.invoke("device.registerPush", { ticket: TICKET }, "r", { deviceKey: "k" })
    expect(ok.result).toEqual({ ok: true, remote: true })
    expect(store.listDevices()[0]!.push_token).toBe(TICKET)

    const { store: plain, service: withoutPush } = service(async () => {})
    plain.putDevice({ id: "d", session_key: "k", name: "phone", created_at: 0, push_token: null })
    expect((await withoutPush.invoke("device.registerPush", { ticket: TICKET }, "r", { deviceKey: "k" })).result).toEqual({ ok: true, remote: false })

    for (const ticket of ["", "short", "has spaces in it, not base64url", "x".repeat(600)]) {
      const refused = await withPush.invoke("device.registerPush", { ticket }, "r", { deviceKey: "k" })
      expect(refused.error?.code).toBe("invalid")
    }
    expect((await withPush.invoke("device.registerPush", { ticket: TICKET }, "r", { deviceKey: "nope" })).error?.code).toBe("unauthorized")
  })
})

describe("push gateway timeout", () => {
  test("a gateway that never answers times out, retries once, and is logged", async () => {
    const store = pairedStore(TICKET)
    const logs: string[] = []
    let calls = 0
    const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls++
      const signal = init?.signal
      return new Promise<Response>((_resolve, reject) => {
        if (!signal) return
        signal.addEventListener("abort", () => reject(signal.reason))
      })
    }) as typeof globalThis.fetch
    const started = Date.now()
    await new PushNotifier(store, { gateway: "https://g", fetch, retryDelayMs: 1, requestTimeoutMs: 40, log: (line) => logs.push(line) }).notify(VECTOR_PAYLOAD)
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(calls).toBe(2)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain("unreachable gateway")
  })
})
