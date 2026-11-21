import { Database } from "bun:sqlite"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { BUILTIN_AGENTS, CLAUDE_DETECT_TTL_MS, cachedDetect, createAdapterRegistry, type AdapterRegistry } from "./adapter"
import { APP_VERSION } from "./config"
import { describeTool } from "./adapter/claude"
import { createFakeAdapter, FAKE_NATIVE_PREFIX, FAKE_SPEC } from "./adapter/fake"
import { ACP_ASK, ACP_PLAN, GROK_BYPASS_MODE, capabilityModes, modesForAutoApproval } from "./adapter/modes"
import { unavailable } from "./adapter/types"
import { phoneCopy } from "./phone-copy"
import type { AdapterContext, AgentAdapter, AgentCapabilities, NativeCut, PermissionModeInfo, PermissionRequest } from "./adapter/types"
import type { Frame } from "./protocol"
import { SessionService } from "./session-service"
import { attachmentDir, findAttachment } from "./attachments"
import { messagePublic, previewText, sessionPublic, Store, TOOL_DIFF_LIMIT, TOOL_OUTPUT_LIMIT } from "./store"

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

function bytes(text: string) {
  return new TextEncoder().encode(text).byteLength
}

type Overrides = Partial<Pick<AgentAdapter, "detect" | "steer" | "listModels" | "listPermissionModes" | "version" | "rewind" | "upgradeCommand">> & {
  capabilities?: Partial<AgentCapabilities>
}

function scripted(id: string, reply: AgentAdapter["reply"], overrides: Overrides = {}): AgentAdapter {
  const { capabilities, ...rest } = overrides
  return {
    spec: { id, label: id, transport: "fake", experimental: false, capabilities: { ...FAKE_SPEC.capabilities, ...capabilities } },
    reply,
    ...rest,
  }
}

function registryOf(...adapters: AgentAdapter[]): AdapterRegistry {
  return { get: (id) => adapters.find((adapter) => adapter.spec.id === id), list: () => adapters }
}

function harness(adapters: AdapterRegistry | AgentAdapter, hooks: ConstructorParameters<typeof SessionService>[3] = {}) {
  const store = new Store(":memory:")
  const events: Frame[] = []
  const service = new SessionService(store, adapters, (frame) => events.push(frame), hooks)
  const named = (name: string) => events.filter((event) => event.name === name)
  return {
    store,
    events,
    service,
    named,
    async create(params: Record<string, unknown> = {}) {
      const created = await service.invoke("session.create", { title: "新会话", ...params }, crypto.randomUUID())
      if (created.type !== "result") throw new Error(created.error?.message)
      return (created.result as { session: { id: string } }).session.id
    },
    async turn(sessionId: string, text: string) {
      const before = this.idleCount(sessionId)
      const sent = await service.invoke("message.send", { sessionId, text }, crypto.randomUUID())
      if (sent.type !== "result") throw new Error(sent.error?.message)
      return before
    },
    idleCount(sessionId: string) {
      return named("agent.status").filter((event) => payload(event).sessionId === sessionId && payload(event).status === "idle").length
    },
    async waitIdle(sessionId: string, count: number) {
      await waitFor(() => this.idleCount(sessionId) >= count)
    },
    rows(sessionId: string, kind?: string) {
      return store.listMessages(sessionId).filter((row) => !kind || row.kind === kind)
    },
  }
}

const RUN_OPTIONS: PermissionRequest["options"] = [{ id: "yes", label: "Yes", kind: "allow_once" }]

describe("reasoning blocks", () => {
  test("fake reasoning is stored with startedAt and endedAt", async () => {
    const h = harness(createFakeAdapter())
    const id = await h.create()
    await h.turn(id, "hello")
    await h.waitIdle(id, 1)
    const rows = h.rows(id, "reasoning")
    expect(rows).toHaveLength(1)
    const reasoning = messagePublic(rows[0]!).reasoning!
    expect(typeof reasoning.startedAt).toBe("number")
    expect(reasoning.endedAt!).toBeGreaterThanOrEqual(reasoning.startedAt)
    expect(rows[0]!.text).toContain("Working out a reply")
  })

  test("empty reasoning makes no block; open blocks keep startedAt and close at turn end", async () => {
    const h = harness(
      scripted("s", async (_text, ctx) => {
        ctx.emit({ type: "reasoning", id: "r0", text: "", done: false })
        ctx.emit({ type: "reasoning", id: "r1", text: "a", done: false })
        await Bun.sleep(5)
        ctx.emit({ type: "reasoning", id: "r1", text: "ab", done: false })
      }),
    )
    const id = await h.create()
    await h.turn(id, "go")
    await h.waitIdle(id, 1)
    expect(h.store.getMessage("r0")).toBeNull()
    const appends = h.named("message.append").map(payload).filter((message) => message.id === "r1")
    const first = appends[0]!.reasoning as { startedAt: number; endedAt?: number }
    const last = appends.at(-1)!.reasoning as { startedAt: number; endedAt?: number }
    expect(first.endedAt).toBeUndefined()
    expect(last.startedAt).toBe(first.startedAt)
    expect(last.endedAt).toBeGreaterThanOrEqual(first.startedAt)
    expect(appends.at(-1)!.text).toBe("ab")
  })
})

describe("structured reply choices", () => {
  test("a completed async question updates a streamed row without changing its text", async () => {
    const text = "Which one?\n- Keep both\n- Keep one"
    const h = harness(scripted("s", async (_prompt, ctx) => {
      ctx.emit({ type: "text", id: "ask", text })
      await Bun.sleep(160)
      ctx.emit({ type: "text", id: "ask", text, replyChoices: ["Keep both", "Keep one"] })
    }))
    const id = await h.create()
    await h.turn(id, "choose")
    await h.waitIdle(id, 1)
    const appends = h.named("message.append").map(payload).filter((message) => message.id === "ask")
    expect(appends.length).toBeGreaterThanOrEqual(2)
    expect(appends[0]!.replyChoices).toBeUndefined()
    expect(appends.at(-1)!.replyChoices).toEqual(["Keep both", "Keep one"])
    expect(messagePublic(h.store.getMessage("ask")!).replyChoices).toEqual(["Keep both", "Keep one"])
  })
})

describe("reasoning start signal", () => {
  test("the adapter's startedAt wins over the first text; one ahead of the clock is clamped to now", async () => {
    const early = Date.now() - 5000
    const h = harness(
      scripted("s", async (_text, ctx) => {
        ctx.emit({ type: "reasoning", id: "early", text: "a", done: false, startedAt: early })
        ctx.emit({ type: "reasoning", id: "early", text: "ab", done: true, startedAt: early })
        ctx.emit({ type: "reasoning", id: "future", text: "b", done: true, startedAt: Date.now() + 60_000 })
      }),
    )
    const id = await h.create()
    const before = Date.now()
    await h.turn(id, "go")
    await h.waitIdle(id, 1)
    expect(messagePublic(h.store.getMessage("early")!).reasoning!.startedAt).toBe(early)
    const future = messagePublic(h.store.getMessage("future")!).reasoning!.startedAt
    expect(future).toBeGreaterThanOrEqual(before)
    expect(future).toBeLessThanOrEqual(Date.now())
  })
})

describe("questions that take options only", () => {
  const STRICT = { question: "旧快照怎么处理？", options: [{ label: "保留 30 天" }, { label: "全部保留" }], multiSelect: false, allowsOther: false }

  test("question.respond rejects typed text for allowsOther false and accepts a listed label", async () => {
    const h = harness(
      scripted("s", async (_text, ctx) => {
        await ctx.askQuestion({ questions: [STRICT, { question: "备注？", options: [{ label: "无" }], multiSelect: false, allowsOther: true }] })
      }),
    )
    const id = await h.create()
    await h.turn(id, "go")
    await waitFor(() => h.named("question.asked").length > 0)
    const asked = payload(h.named("question.asked")[0]!)
    expect((asked.question as { questions: Array<{ allowsOther: boolean }> }).questions.map((item) => item.allowsOther)).toEqual([false, true])
    const typed = await h.service.invoke("question.respond", { id: asked.id, answers: { [STRICT.question]: "删光" } }, "q1")
    expect(typed.type).toBe("error")
    expect(typed.error).toMatchObject({ code: "invalid", message: "answer must be one of the options" })
    const listed = await h.service.invoke("question.respond", { id: asked.id, answers: { [STRICT.question]: "全部保留", "备注？": "随便写" } }, "q2")
    expect(listed.type).toBe("result")
    await h.waitIdle(id, 1)
  })

  test("the fake agent asks the design's three kinds by prefix", async () => {
    const h = harness(createFakeAdapter())
    const id = await h.create()
    const kinds: Array<[string, number, boolean[], boolean[]]> = [
      ["ask: go", 1, [true], [false]],
      ["多题：go", 3, [true, true, true], [false, true, false]],
      ["限选：go", 1, [false], [false]],
    ]
    for (const [index, [text, count, others, multi]] of kinds.entries()) {
      await h.turn(id, text)
      await waitFor(() => h.named("question.asked").length > index)
      const asked = payload(h.named("question.asked")[index]!)
      const questions = (asked.question as { questions: Array<{ question: string; allowsOther: boolean; multiSelect: boolean; options: Array<{ label: string }> }> }).questions
      expect(questions).toHaveLength(count)
      expect(questions.map((item) => item.allowsOther)).toEqual(others)
      expect(questions.map((item) => item.multiSelect)).toEqual(multi)
      const answers = Object.fromEntries(questions.map((item) => [item.question, item.options[0]!.label]))
      await h.service.invoke("question.respond", { id: asked.id, answers }, `q${index}`)
      await h.waitIdle(id, index + 1)
    }
  })
})

describe("tool cards", () => {
  test("unchanged visible tool output does not send another update", async () => {
    const prefix = "x".repeat(TOOL_OUTPUT_LIMIT)
    const h = harness(
      scripted("s", async (_text, ctx) => {
        const tool = { type: "tool", id: "same-tool", tool: "Bash", title: "Run", kind: "execute", detail: "printf result" } as const
        ctx.emit({ ...tool, status: "running", output: prefix })
        for (let update = 0; update < 100; update += 1) {
          ctx.emit({ ...tool, status: "running", output: `${prefix}${update}` })
        }
        ctx.emit({ ...tool, status: "completed", output: `${prefix}done`, exitCode: 0 })
      }),
    )
    const id = await h.create()
    await h.turn(id, "run")
    await h.waitIdle(id, 1)
    const updates = h.named("message.append").map(payload).filter((frame) => frame.kind === "tool")
      .map((frame) => frame.tool as { status: string; outputTruncated?: boolean; exitCode?: number })
    expect(updates.map((tool) => [tool.status, tool.outputTruncated, tool.exitCode])).toEqual([
      ["running", undefined, undefined],
      ["running", true, undefined],
      ["completed", true, 0],
    ])
  })

  test("status moves pending → running → completed with output", async () => {
    const h = harness(createFakeAdapter())
    const id = await h.create({ permissionMode: "acceptEdits" })
    await h.turn(id, "run ls")
    await h.waitIdle(id, 1)
    const statuses = h
      .named("message.append")
      .map(payload)
      .filter((message) => message.kind === "tool")
      .map((message) => (message.tool as { status: string }).status)
    expect(statuses).toEqual(["pending", "running", "completed"])
    const tool = messagePublic(h.rows(id, "tool")[0]!).tool!
    expect(tool.kind).toBe("execute")
    expect(tool.exitCode).toBe(0)
    expect(tool.output).toContain("README.md")
    expect(h.named("permission.asked")).toHaveLength(0)
  })

  test("output is cut to 4 KB and each diff to 8 KB", async () => {
    const h = harness(
      scripted("s", async (_text, ctx) => {
        ctx.emit({
          type: "tool",
          id: "t1",
          tool: "Edit",
          title: "Edit file",
          kind: "edit",
          status: "completed",
          detail: "a.txt",
          output: "界".repeat(5000),
          diffs: [{ path: "a.txt", oldText: "o".repeat(20_000), newText: "n".repeat(20_000) }],
        })
      }),
    )
    const id = await h.create()
    await h.turn(id, "edit")
    await h.waitIdle(id, 1)
    const tool = messagePublic(h.store.getMessage("t1")!).tool!
    expect(bytes(tool.output!)).toBeLessThanOrEqual(TOOL_OUTPUT_LIMIT)
    expect(tool.output!.endsWith("…")).toBe(true)
    expect(tool.output!).not.toContain("�")
    const diff = tool.diffs![0]!
    expect(bytes(diff.oldText!) + bytes(diff.newText!)).toBeLessThanOrEqual(TOOL_DIFF_LIMIT)
    expect(diff.newText!.startsWith("nnn")).toBe(true)
    expect(tool.outputTruncated).toBe(true)
    expect(diff.truncated).toBe(true)
  })

  test("untouched output and diffs carry no truncation flags; permission diffs are flagged too", async () => {
    const h = harness(
      scripted("s", async (_text, ctx) => {
        ctx.emit({
          type: "tool",
          id: "t1",
          tool: "Edit",
          title: "Edit file",
          kind: "edit",
          status: "completed",
          detail: "a.txt",
          output: "ok",
          diffs: [{ path: "a.txt", oldText: "a", newText: "b" }],
        })
        await ctx.askPermission({
          tool: "Edit",
          title: "Edit",
          detail: "a.txt",
          kind: "edit",
          options: RUN_OPTIONS,
          diffs: [{ path: "a.txt", newText: "x".repeat(20_000) }, { path: "b.txt", newText: "small" }],
        })
      }),
    )
    const id = await h.create()
    await h.turn(id, "edit")
    await waitFor(() => h.named("permission.asked").length > 0)
    const tool = messagePublic(h.store.getMessage("t1")!).tool!
    expect(tool.outputTruncated).toBeUndefined()
    expect(tool.diffs![0]!.truncated).toBeUndefined()
    const asked = payload(h.named("permission.asked")[0]!)
    const diffs = (asked.permission as { diffs: Array<{ truncated?: boolean }> }).diffs
    expect(diffs.map((diff) => diff.truncated)).toEqual([true, undefined])
    await h.service.invoke("permission.respond", { id: asked.id, optionId: "yes" }, "p1")
    await h.waitIdle(id, 1)
  })
})

describe("permissions · links, pending kind, cancel reasons", () => {
  test("toolId is stored on the permission payload", async () => {
    const h = harness(
      scripted("s", async (_text, ctx) => {
        ctx.emit({ type: "tool", id: "card-1", tool: "Bash", title: "Run", kind: "execute", status: "pending", detail: "ls" })
        await ctx.askPermission({ tool: "Bash", title: "Run", detail: "ls", kind: "execute", options: RUN_OPTIONS, toolId: "card-1" })
      }),
    )
    const id = await h.create()
    await h.turn(id, "go")
    await waitFor(() => h.named("permission.asked").length > 0)
    const asked = payload(h.named("permission.asked")[0]!)
    expect((asked.permission as { toolId?: string }).toolId).toBe("card-1")
    await h.service.invoke("permission.respond", { id: asked.id, optionId: "yes" }, "p1")
    await h.waitIdle(id, 1)
    expect(messagePublic(h.store.getMessage(asked.id as string)!).permission?.toolId).toBe("card-1")
  })

  test("session.pending follows open requests and is broadcast on every change", async () => {
    let answerQuestion: Promise<unknown> | undefined
    const h = harness(
      scripted("s", async (_text, ctx) => {
        await ctx.askPermission({ tool: "Bash", title: "Run", detail: "ls", kind: "execute", options: RUN_OPTIONS })
        answerQuestion = ctx.askQuestion({ questions: [{ question: "Continue?", options: [{ label: "Yes" }], multiSelect: false, allowsOther: true }] })
        await answerQuestion
      }),
    )
    const id = await h.create()
    const pendingSeen = () =>
      h
        .named("session.upsert")
        .map(payload)
        .filter((session) => session.id === id)
        .map((session) => session.pending)
    expect(pendingSeen().at(-1)).toBeNull()
    await h.turn(id, "go")
    await waitFor(() => h.named("permission.asked").length > 0)
    expect(pendingSeen().at(-1)).toBe("permission")
    const listed = await h.service.invoke("session.list", {}, "l1")
    expect((listed.result as { sessions: Array<{ id: string; pending: unknown }> }).sessions.find((session) => session.id === id)?.pending).toBe(
      "permission",
    )
    const permissionId = payload(h.named("permission.asked")[0]!).id
    await h.service.invoke("permission.respond", { id: permissionId, optionId: "yes" }, "p1")
    await waitFor(() => h.named("question.asked").length > 0)
    expect(pendingSeen().at(-1)).toBe("question")
    const questionId = payload(h.named("question.asked")[0]!).id
    await h.service.invoke("question.respond", { id: questionId, answer: "Yes" }, "q1")
    await h.waitIdle(id, 1)
    expect(pendingSeen().at(-1)).toBeNull()
    expect(pendingSeen()).toContain("permission")
    expect(pendingSeen()).toContain("question")
  })

  test("session.list ranks a pending permission over a pending question for the same session", async () => {
    const h = harness(
      scripted("s", async (_text, ctx) => {
        void ctx.askQuestion({ questions: [{ question: "Continue?", options: [{ label: "Yes" }], multiSelect: false, allowsOther: true }] })
        await ctx.askPermission({ tool: "Bash", title: "Run", detail: "ls", kind: "execute", options: RUN_OPTIONS })
      }),
    )
    const id = await h.create()
    await h.turn(id, "go")
    await waitFor(() => h.named("permission.asked").length > 0 && h.named("question.asked").length > 0)
    const service = h.service as unknown as { pendingKind: (sessionId: string) => unknown }
    const original = service.pendingKind.bind(service)
    let calls = 0
    service.pendingKind = (sessionId) => {
      calls += 1
      return original(sessionId)
    }
    const listed = await h.service.invoke("session.list", {}, "l1")
    service.pendingKind = original
    const rows = (listed.result as { sessions: Array<{ id: string; pending: unknown }> }).sessions
    expect(rows.find((session) => session.id === id)?.pending).toBe("permission")
    expect(calls).toBe(0)
    const permissionId = payload(h.named("permission.asked")[0]!).id
    await h.service.invoke("permission.respond", { id: permissionId, optionId: "yes" }, "p1")
    const questionId = payload(h.named("question.asked")[0]!).id
    await h.service.invoke("question.respond", { id: questionId, answer: "Yes" }, "q1")
    await h.waitIdle(id, 1)
  })

  test("a request left open when the turn ends is cancelled as interrupted and pending clears", async () => {
    const h = harness(
      scripted("s", async (_text, ctx) => {
        void ctx.askQuestion({ questions: [{ question: "Continue?", options: [{ label: "Yes" }], multiSelect: false, allowsOther: true }] })
        await Bun.sleep(5)
      }),
    )
    const id = await h.create()
    await h.turn(id, "go")
    await waitFor(() => h.named("question.resolved").length > 0)
    expect(payload(h.named("question.resolved")[0]!)).toMatchObject({ status: "cancelled", cancelReason: "interrupted" })
    const last = h.named("session.upsert").map(payload).filter((session) => session.id === id).at(-1)!
    expect(last.pending).toBeNull()
    expect(last.status).toBe("idle")
  })

  test("withdrawn vs interrupted cancel reasons", async () => {
    const h = harness(
      scripted("s", async (_text, ctx) => {
        const withdraw = new AbortController()
        const asked = ctx.askPermission({ tool: "Bash", title: "Run", detail: "ls", kind: "execute", options: RUN_OPTIONS }, withdraw.signal)
        await Bun.sleep(5)
        withdraw.abort()
        await asked
        const withdrawQuestion = new AbortController()
        const question = ctx.askQuestion(
          { questions: [{ question: "Continue?", options: [{ label: "Yes" }], multiSelect: false, allowsOther: true }] },
          withdrawQuestion.signal,
        )
        await Bun.sleep(5)
        withdrawQuestion.abort()
        await question
        await ctx.askPermission({ tool: "Bash", title: "Run", detail: "rm", kind: "execute", options: RUN_OPTIONS })
      }),
    )
    const id = await h.create()
    await h.turn(id, "go")
    await waitFor(() => h.named("permission.asked").length > 1)
    await h.service.invoke("message.steer", { sessionId: id, action: "cancel" }, "c1")
    await h.waitIdle(id, 1)
    const permissions = h.rows(id, "permission").map((row) => messagePublic(row).permission!)
    expect(permissions.map((permission) => [permission.status, permission.cancelReason])).toEqual([
      ["cancelled", "withdrawn"],
      ["cancelled", "interrupted"],
    ])
    expect(messagePublic(h.rows(id, "question")[0]!).question).toMatchObject({ status: "cancelled", cancelReason: "withdrawn" })
    expect(h.named("permission.resolved").map((event) => payload(event).cancelReason)).toEqual(["withdrawn", "interrupted"])
  })
})

describe("permissions", () => {
  test("offers the agent's options and records the chosen optionId", async () => {
    const h = harness(createFakeAdapter())
    const id = await h.create()
    await h.turn(id, "run ls")
    await waitFor(() => h.named("permission.asked").length > 0)
    const asked = payload(h.named("permission.asked")[0]!)
    const permission = asked.permission as { options: Array<{ id: string }>; kind: string; status: string }
    expect(permission.options.map((option) => option.id)).toEqual(["allow_once", "allow_always", "reject_once"])
    expect(permission.kind).toBe("execute")
    expect(permission.status).toBe("pending")
    expect(h.store.getSession(id)?.status).toBe("waiting")

    const bogus = await h.service.invoke("permission.respond", { id: asked.id, optionId: "nope" }, "p0")
    expect(bogus.error?.code).toBe("invalid")
    const responded = await h.service.invoke("permission.respond", { id: asked.id, optionId: "allow_always" }, "p1")
    expect(responded.result).toEqual({ ok: true, optionId: "allow_always", allow: true })
    await h.waitIdle(id, 1)
    const stored = messagePublic(h.store.getMessage(asked.id as string)!).permission!
    expect(stored.status).toBe("allowed")
    expect(stored.decision).toBe("allow_always")
    expect(h.named("permission.resolved").map((event) => payload(event).decision)).toEqual(["allow_always"])

    // "Always allow" is remembered by the agent for the rest of the session.
    await h.turn(id, "run ls")
    await h.waitIdle(id, 2)
    expect(h.named("permission.asked")).toHaveLength(1)
  })

  test("legacy allow:false maps to the first reject option", async () => {
    const h = harness(createFakeAdapter())
    const id = await h.create()
    await h.turn(id, "run ls")
    await waitFor(() => h.named("permission.asked").length > 0)
    const permissionId = payload(h.named("permission.asked")[0]!).id as string
    const responded = await h.service.invoke("permission.respond", { id: permissionId, allow: false }, "p1")
    expect(responded.result).toEqual({ ok: true, optionId: "reject_once", allow: false })
    await h.waitIdle(id, 1)
    const stored = messagePublic(h.store.getMessage(permissionId)!).permission!
    expect(stored.status).toBe("denied")
    expect(stored.decision).toBe("reject_once")
    expect(messagePublic(h.rows(id, "tool")[0]!).tool?.status).toBe("declined")
  })

  test("withdrawn permission and question resolve null and are marked cancelled", async () => {
    const results: unknown[] = []
    const h = harness(
      scripted("s", async (_text, ctx) => {
        const withdrawPermission = new AbortController()
        const permission = ctx.askPermission(
          { tool: "Bash", title: "Run", detail: "ls", kind: "execute", options: RUN_OPTIONS },
          withdrawPermission.signal,
        )
        await Bun.sleep(5)
        withdrawPermission.abort()
        results.push(await permission)
        const withdrawQuestion = new AbortController()
        const question = ctx.askQuestion(
          { questions: [{ question: "Continue?", options: [{ label: "Yes" }], multiSelect: false, allowsOther: true }] },
          withdrawQuestion.signal,
        )
        await Bun.sleep(5)
        withdrawQuestion.abort()
        results.push(await question)
      }),
    )
    const id = await h.create()
    await h.turn(id, "go")
    await h.waitIdle(id, 1)
    expect(results).toEqual([null, null])
    expect(messagePublic(h.rows(id, "permission")[0]!).permission?.status).toBe("cancelled")
    expect(messagePublic(h.rows(id, "question")[0]!).question?.status).toBe("cancelled")
    expect(payload(h.named("permission.resolved")[0]!).status).toBe("cancelled")
    expect(payload(h.named("question.resolved")[0]!).status).toBe("cancelled")
  })

  test("interrupting the turn cancels a pending permission", async () => {
    const h = harness(createFakeAdapter())
    const id = await h.create()
    await h.turn(id, "run ls")
    await waitFor(() => h.named("permission.asked").length > 0)
    const cancelled = await h.service.invoke("message.steer", { sessionId: id, action: "cancel" }, "c1")
    expect(cancelled.type).toBe("result")
    await h.waitIdle(id, 1)
    expect(messagePublic(h.rows(id, "permission")[0]!).permission?.status).toBe("cancelled")
    expect(h.rows(id).at(-1)?.text).toBe("Cancelled.")
  })

  test("a request still open when the turn ends is cancelled", async () => {
    const h = harness(
      scripted("s", async (_text, ctx) => {
        void ctx.askPermission({ tool: "Bash", title: "Run", detail: "ls", kind: "execute", options: RUN_OPTIONS })
      }),
    )
    const id = await h.create()
    await h.turn(id, "go")
    await waitFor(() => h.named("permission.resolved").length > 0)
    expect(payload(h.named("permission.resolved")[0]!).status).toBe("cancelled")
    expect(h.store.getSession(id)?.status).toBe("idle")
  })
})

describe("questions", () => {
  test("several questions with multi-select answers", async () => {
    let received: unknown
    const h = harness(
      scripted("s", async (_text, ctx) => {
        received = await ctx.askQuestion({
          questions: [
            { question: "Pick one", header: "One", options: [{ label: "A" }, { label: "B", description: "bee" }], multiSelect: false, allowsOther: true },
            { question: "Pick many", options: [{ label: "x" }, { label: "y" }], multiSelect: true, allowsOther: true },
          ],
        })
      }),
    )
    const id = await h.create()
    await h.turn(id, "ask")
    await waitFor(() => h.named("question.asked").length > 0)
    const asked = payload(h.named("question.asked")[0]!)
    const question = asked.question as { prompt: string; options: string[]; questions: unknown[] }
    expect(question.prompt).toBe("Pick one")
    expect(question.options).toEqual(["A", "B"])
    expect(question.questions).toHaveLength(2)

    const bad = await h.service.invoke("question.respond", { id: asked.id, answers: { "Pick one": 3 } }, "q0")
    expect(bad.error?.code).toBe("invalid")
    const answers = { "Pick one": "A", "Pick many": ["x", "y"] }
    const responded = await h.service.invoke("question.respond", { id: asked.id, answers }, "q1")
    expect(responded.result).toEqual({ ok: true, answers, answer: "A" })
    await h.waitIdle(id, 1)
    expect(received).toEqual(answers)
    const row = h.store.getMessage(asked.id as string)!
    const stored = messagePublic(row).question!
    expect(stored.status).toBe("answered")
    expect(stored.answers).toEqual(answers)
    expect(stored.answer).toBe("A")
    expect(row.text).toBe("Pick one\n→ A\nPick many\n→ x, y")
  })
})

describe("usage and native session", () => {
  test("usage counters add up across turns; context fields keep the latest", async () => {
    let turnNo = 0
    const h = harness(
      scripted("s", async (_text, ctx) => {
        turnNo += 1
        ctx.emit({ type: "usage", usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.25, contextUsed: 100 * turnNo, contextSize: 1000 } })
      }),
    )
    const id = await h.create()
    expect(sessionPublic(h.store.getSession(id)!).usage).toEqual({})
    await h.turn(id, "one")
    await h.waitIdle(id, 1)
    await h.turn(id, "two")
    await h.waitIdle(id, 2)
    const expected = { inputTokens: 20, outputTokens: 10, costUsd: 0.5, contextUsed: 200, contextSize: 1000 }
    const got = await h.service.invoke("session.get", { id }, "g1")
    expect((got.result as { session: { usage: unknown } }).session.usage).toEqual(expected)
    expect(h.named("session.upsert").some((event) => JSON.stringify(payload(event).usage) === JSON.stringify(expected))).toBe(true)
  })

  test("native id is stored, handed to the next turn, dropped on fork, rewind and clear", async () => {
    const fake = createFakeAdapter()
    const seen: Array<string | undefined> = []
    const spy: AgentAdapter = {
      ...fake,
      reply: (text: string, ctx: AdapterContext) => {
        seen.push(ctx.nativeId)
        return fake.reply(text, ctx)
      },
    }
    const h = harness(spy)
    const id = await h.create()
    await h.turn(id, "one")
    await h.waitIdle(id, 1)
    const nativeId = `${FAKE_NATIVE_PREFIX}${id}`
    expect(h.store.getSession(id)?.native_id).toBe(nativeId)
    const pub = sessionPublic(h.store.getSession(id)!) as Record<string, unknown>
    expect(Object.keys(pub).some((key) => key.toLowerCase().includes("native"))).toBe(false)

    await h.turn(id, "two")
    await h.waitIdle(id, 2)
    expect(seen).toEqual([undefined, nativeId])

    const forked = await h.service.invoke("session.fork", { id }, "f1")
    const forkId = (forked.result as { session: { id: string } }).session.id
    expect(h.store.getSession(forkId)?.native_id).toBeNull()
    expect(h.store.getSession(id)?.native_id).toBe(nativeId)
    await h.service.invoke("session.rewind", { id, seq: 1 }, "r1")
    expect(h.store.getSession(id)?.native_id).toBeNull()
    await h.turn(id, "three")
    await h.waitIdle(id, 3)
    expect(seen.at(-1)).toBeUndefined()
    await h.service.invoke("session.clear", { id }, "c1")
    expect(h.store.getSession(id)?.native_id).toBeNull()
  })

  // T3-style native rewind: the agent cuts its own session at a turn boundary and keeps its id.
  function nativeRewinder(answer: () => boolean | Promise<boolean>) {
    const seen: Array<{ text: string; nativeId?: string }> = []
    const cuts: Array<{ sessionId: string; cut: NativeCut }> = []
    let n = 0
    const adapter = scripted("native", async (text, ctx) => {
      n += 1
      seen.push({ text, nativeId: ctx.nativeId })
      if (!ctx.nativeId) ctx.emit({ type: "native", nativeId: "N1" })
      ctx.emit({ type: "nativeTurn", nativeId: "N1", turnId: `t-${n}` })
      ctx.emit({ type: "text", id: crypto.randomUUID(), text: `reply ${n}` })
      // A second agent turn inside the same Rudder turn: its id must not replace the first.
      ctx.emit({ type: "nativeTurn", nativeId: "N1", turnId: `t-${n}b`, lastMessageId: `m-${n}` })
    }, { rewind: async (sessionId, cut) => {
      cuts.push({ sessionId, cut })
      return answer()
    } })
    return { adapter, seen, cuts }
  }

  async function threeTurns(h: ReturnType<typeof harness>, id: string) {
    for (const [index, text] of ["one", "two", "three"].entries()) {
      await h.turn(id, text)
      await h.waitIdle(id, index + 1)
    }
    return h.rows(id).filter((row) => row.role === "user").map((row) => row.seq)
  }

  test("a rewind at a turn boundary cuts the agent's own session and keeps it", async () => {
    const r = nativeRewinder(() => true)
    const h = harness(r.adapter)
    const id = await h.create({ agent: "native" })
    const prompts = await threeTurns(h, id)
    const rewound = await h.service.invoke("session.rewind", { id, seq: prompts[2]! - 1 }, "r1")
    expect(rewound.type).toBe("result")
    expect(r.cuts).toEqual([{ sessionId: id, cut: { nativeId: "N1", keepThrough: "m-2", beforeTurnId: "t-3" } }])
    const row = h.store.getSession(id)!
    expect(row.native_id).toBe("N1")
    expect(row.carry_seq).toBe(0)
    await h.turn(id, "again")
    await h.waitIdle(id, 4)
    expect(r.seen.at(-1)).toEqual({ text: "again", nativeId: "N1" })
  })

  test("a rewind inside a turn, or one the agent refuses, carries the transcript over instead", async () => {
    for (const [answer, inside] of [[true, true], [false, false]] as const) {
      const r = nativeRewinder(() => answer)
      const h = harness(r.adapter)
      const id = await h.create({ agent: "native" })
      const prompts = await threeTurns(h, id)
      // Keeping the third prompt but not its reply cuts inside that turn.
      await h.service.invoke("session.rewind", { id, seq: inside ? prompts[2]! : prompts[2]! - 1 }, "r1")
      expect(r.cuts.length).toBe(inside ? 0 : 1)
      const row = h.store.getSession(id)!
      expect(row.native_id).toBeNull()
      expect(row.carry_seq).toBeGreaterThan(0)
      await h.turn(id, "again")
      await h.waitIdle(id, 4)
      expect(r.seen.at(-1)?.nativeId).toBeUndefined()
      expect(r.seen.at(-1)?.text).toContain("reply 2")
    }
  })

  test("a rewound session carries the turns it kept into the next one, once (v48 C)", async () => {
    const fake = createFakeAdapter()
    const sent: string[] = []
    const h = harness({
      ...fake,
      reply: (text: string, ctx: AdapterContext) => {
        sent.push(text)
        return fake.reply("ok", ctx)
      },
    })
    const id = await h.create()
    await h.turn(id, "remember PINEAPPLE")
    await h.waitIdle(id, 1)
    await h.turn(id, "second")
    await h.waitIdle(id, 2)
    const kept = h.rows(id).filter((row) => row.role === "user")[1]!.seq - 1
    await h.service.invoke("session.rewind", { id, seq: kept }, "r1")
    await h.turn(id, "again")
    await h.waitIdle(id, 3)
    expect(sent.at(-1)).toContain("<earlier-conversation>")
    expect(sent.at(-1)).toContain("User: remember PINEAPPLE")
    expect(sent.at(-1)).not.toContain("User: second")
    expect(sent.at(-1)?.endsWith("again")).toBe(true)
    await h.turn(id, "plain")
    await h.waitIdle(id, 4)
    expect(sent.at(-1)).toBe("plain")
    await h.service.invoke("session.clear", { id }, "c1")
    await h.turn(id, "fresh")
    await h.waitIdle(id, 5)
    expect(sent.at(-1)).toBe("fresh")
  })

  test("a copy forks the source's agent session where the adapter can, else carries the transcript (v48 B)", async () => {
    const fake = createFakeAdapter()
    const seen: Array<{ text: string; forkFrom?: string; carryOver?: string; nativeId?: string }> = []
    const reply = (text: string, ctx: AdapterContext) => {
      seen.push({ text, forkFrom: ctx.forkFrom, carryOver: ctx.carryOver, nativeId: ctx.nativeId })
      return fake.reply("ok", ctx)
    }
    const h = harness({ ...fake, forks: true, reply })
    const id = await h.create({ title: "加会话缓存" })
    await h.turn(id, "remember PINEAPPLE")
    await h.waitIdle(id, 1)
    const nativeId = `${FAKE_NATIVE_PREFIX}${id}`

    const named = await h.service.invoke("session.fork", { id, title: "Add cache copy" }, "f0")
    expect((named.result as { session: { title: string } }).session.title).toBe("Add cache copy")
    const forked = await h.service.invoke("session.fork", { id }, "f1")
    const copy = (forked.result as { session: { id: string; title: string } }).session
    expect(copy.title).toBe("加会话缓存 副本")
    await h.turn(copy.id, "which word")
    await h.waitIdle(copy.id, 1)
    expect(seen.at(-1)).toMatchObject({ text: "which word", forkFrom: nativeId, nativeId: undefined })
    expect(seen.at(-1)?.carryOver).toContain("User: remember PINEAPPLE")
    await h.turn(copy.id, "next")
    await h.waitIdle(copy.id, 2)
    expect(seen.at(-1)).toMatchObject({ text: "next", forkFrom: undefined, nativeId: `${FAKE_NATIVE_PREFIX}${copy.id}` })

    // The source moves on before the second copy runs: forking now would hand the copy that turn too.
    const later = await h.service.invoke("session.fork", { id }, "f2")
    const late = (later.result as { session: { id: string } }).session.id
    await h.turn(id, "source moves on")
    await h.waitIdle(id, 2)
    await h.turn(late, "and you")
    await h.waitIdle(late, 1)
    expect(seen.at(-1)?.forkFrom).toBeUndefined()
    expect(seen.at(-1)?.text).toContain("User: remember PINEAPPLE")
    expect(seen.at(-1)?.text).not.toContain("source moves on")
  })
})

describe("agent selection", () => {
  const speaker = (id: string) =>
    scripted(id, async (_text, ctx) => {
      ctx.emit({ type: "text", id: crypto.randomUUID(), text: `from ${id}` })
    })

  test("picks the adapter by session.agent and rejects unknown agents", async () => {
    const h = harness(registryOf(speaker("alpha"), speaker("beta")))
    const id = await h.create({ agent: "beta" })
    await h.turn(id, "hi")
    await h.waitIdle(id, 1)
    expect(h.rows(id).at(-1)?.text).toBe("from beta")
    const unknown = await h.service.invoke("session.create", { agent: "nope" }, "u1")
    expect(unknown.error?.code).toBe("invalid")
    const hello = await h.service.invoke("hello", {}, "h1")
    const agents = (hello.result as { agents: Array<{ id: string; available: boolean }> }).agents
    expect(agents.map((agent) => agent.id)).toEqual(["alpha", "beta"])
  })

  test("an unavailable agent writes an error message instead of replying", async () => {
    let replied = false
    const ghost = scripted(
      "ghost",
      async () => {
        replied = true
      },
      { detect: async () => ({ available: false, reason: "not installed" }) },
    )
    const h = harness(registryOf(ghost))
    const id = await h.create({ agent: "ghost" })
    await h.turn(id, "hi")
    await h.waitIdle(id, 1)
    expect(replied).toBe(false)
    const last = h.rows(id).at(-1)!
    expect(last.kind).toBe("error")
    expect(last.text).toContain("not installed")
    expect(h.store.getSession(id)?.status).toBe("idle")
    const hello = await h.service.invoke("hello", {}, "h1")
    const agent = (hello.result as { agents: Array<Record<string, unknown>> }).agents[0]!
    expect(agent.available).toBe(false)
    expect(agent.unavailableReason).toBe("not installed")
    expect(agent.capabilities).toEqual(ghost.spec.capabilities)
  })

  test("an unavailable agent's reason and error row carry copy the phone words in its own language", async () => {
    const ghost = scripted("ghost", async () => {}, { detect: async () => unavailable(phoneCopy.commandMissing("ghost-cli")) })
    const h = harness(registryOf(ghost))
    const id = await h.create({ agent: "ghost" })
    await h.turn(id, "hi")
    await h.waitIdle(id, 1)
    const row = messagePublic(h.rows(id).at(-1)!)
    // Older phones keep the Chinese text; the copy names the code and its arguments, the reason nested in it.
    expect(row.text).toBe("ghost 不可用：未找到命令 ghost-cli")
    expect((row as { copy?: unknown }).copy).toEqual({
      code: "agent_unavailable",
      args: { agent: "ghost", reason: { code: "command_missing", args: { command: "ghost-cli" }, text: "未找到命令 ghost-cli" } },
      text: "ghost 不可用：未找到命令 ghost-cli",
    })
    const hello = await h.service.invoke("hello", {}, "h1")
    const agent = (hello.result as { agents: Array<Record<string, unknown>> }).agents[0]!
    expect(agent.unavailableReason).toBe("未找到命令 ghost-cli")
    expect(agent.unavailableCode).toBe("not_installed")
    expect(agent.unavailableCopy).toEqual({ code: "command_missing", args: { command: "ghost-cli" }, text: "未找到命令 ghost-cli" })
  })

  test("hello includes the daemon version and waits to attach an agent version", async () => {
    let resolveVersion: (value: string | undefined) => void = () => {}
    const pending = new Promise<string | undefined>((resolve) => {
      resolveVersion = resolve
    })
    const slow = scripted("slow", async () => {}, { version: () => pending })
    const h = harness(registryOf(slow))
    const started = Date.now()
    const first = await h.service.invoke("hello", {}, "h1")
    expect(Date.now() - started).toBeLessThan(500)
    const firstAgents = (first.result as { version: string; agents: Array<Record<string, unknown>> }).agents
    expect((first.result as { version: string }).version).toBe(APP_VERSION)
    expect(firstAgents[0]).not.toHaveProperty("version")
    resolveVersion("2.1.4")
    await Bun.sleep(0)
    const second = await h.service.invoke("hello", {}, "h2")
    expect((second.result as { agents: Array<{ version?: string }> }).agents[0]?.version).toBe("2.1.4")
  })

  test("an agent older than its minimum version is unavailable as outdated, and its turns do not start", async () => {
    let replies = 0
    let installed = "0.40.0"
    const old = scripted("old", async () => {
      replies += 1
    }, { version: async () => installed, upgradeCommand: () => "npm install -g @openai/codex@latest" })
    old.spec.minimumVersion = "0.52.0"
    const h = harness(registryOf(old))
    await h.service.invoke("hello", {}, "h1")
    await Bun.sleep(0)
    const hello = await h.service.invoke("hello", {}, "h2")
    expect((hello.result as { agents: Array<Record<string, unknown>> }).agents[0]).toMatchObject({
      available: false,
      unavailableCode: "outdated",
      unavailableReason: "old 版本太旧：电脑上是 0.40.0，需要 0.52.0 或更新",
      minimumVersion: "0.52.0",
      upgradeCommand: "npm install -g @openai/codex@latest",
      version: "0.40.0",
    })
    const id = await h.create({ agent: "old" })
    await h.turn(id, "hi")
    await h.waitIdle(id, 1)
    expect(replies).toBe(0)
    expect(h.rows(id, "error").at(-1)?.text).toContain("版本太旧")

    // Upgraded: the next probe answers the new version and the agent is available again, without the command.
    installed = "0.52.1"
    await h.service.invoke("hello", {}, "h3")
    await Bun.sleep(0)
    const after = (await h.service.invoke("hello", {}, "h4")).result as { agents: Array<Record<string, unknown>> }
    expect(after.agents[0]).toMatchObject({ available: true, minimumVersion: "0.52.0", version: "0.52.1" })
    expect(after.agents[0]).not.toHaveProperty("upgradeCommand")
    await h.turn(id, "again")
    await h.waitIdle(id, 2)
    expect(replies).toBe(1)
  })

  test("an empty or failed agent version stays off the hello payload", async () => {
    const blank = scripted("blank", async () => {}, { version: async () => "" })
    const broken = scripted("broken", async () => {}, {
      version: async () => {
        throw new Error("no cli")
      },
    })
    const h = harness(registryOf(blank, broken))
    await h.service.invoke("hello", {}, "h1")
    await Bun.sleep(0)
    const hello = await h.service.invoke("hello", {}, "h2")
    for (const agent of (hello.result as { agents: Array<Record<string, unknown>> }).agents) {
      expect(agent).not.toHaveProperty("version")
    }
  })

  test("per-session permission mode and effort follow the agent's capabilities", async () => {
    const seen: Array<{ mode: string; effort?: string }> = []
    const acpish = scripted(
      "acpish",
      async (_text, ctx) => {
        seen.push({ mode: ctx.permissionMode, effort: ctx.effort })
      },
      { capabilities: { permissionModes: ["ask", "plan"] } },
    )
    const h = harness(registryOf(acpish))
    const created = await h.service.invoke("session.create", { agent: "acpish", permissionMode: "acceptEdits" }, "c1")
    const session = (created.result as { session: { id: string; permissionMode: string } }).session
    expect(session.permissionMode).toBe("ask")
    const rejected = await h.service.invoke("session.patch", { id: session.id, permissionMode: "acceptEdits" }, "p1")
    expect(rejected.error?.code).toBe("invalid")
    const patched = await h.service.invoke("session.patch", { id: session.id, permissionMode: "plan", effort: "high" }, "p2")
    expect((patched.result as { session: { permissionMode: string; effort: string } }).session).toMatchObject({
      permissionMode: "plan",
      effort: "high",
    })
    await h.turn(session.id, "go")
    await h.waitIdle(session.id, 1)
    expect(seen).toEqual([{ mode: "plan", effort: "high" }])

    await h.service.invoke("config.set", { permissionMode: "deny" }, "s1")
    const second = await h.service.invoke("session.create", { agent: "acpish" }, "c2")
    expect((second.result as { session: { permissionMode: string } }).session.permissionMode).toBe("plan")
  })

  test("models.list uses the agent's own list when it has one", async () => {
    const models = [{ id: "m1", label: "M1", efforts: ["low", "high"], defaultEffort: "low" }]
    const h = harness(
      registryOf(
        scripted("dyn", async () => {}, { listModels: async () => models }),
        scripted("plain", async () => {}),
      ),
    )
    const dynamic = await h.service.invoke("models.list", { agent: "dyn" }, "m1")
    expect((dynamic.result as { models: unknown }).models).toEqual(models)
    const fallback = await h.service.invoke("models.list", { agent: "plain" }, "m2")
    expect((fallback.result as { models: Array<{ id: string }> }).models[0]?.id).toBe("sonnet")
    const unknown = await h.service.invoke("models.list", { agent: "nope" }, "m3")
    expect(unknown.error?.code).toBe("invalid")
  })

  test("a model that refused an effort publishes none and runs without it, across a restart (v57 A)", async () => {
    const models = [
      { id: "sonnet", label: "Sonnet", efforts: ["low", "high"], defaultEffort: "low" },
      { id: "gpt", label: "GPT", efforts: ["low", "high"], defaultEffort: "low" },
    ]
    const efforts: Array<string | undefined> = []
    const adapter = scripted(
      "cp",
      async (_text, ctx) => {
        efforts.push(ctx.effort)
        if (ctx.effort && ctx.model === "sonnet") await ctx.emit({ type: "effortRefused", model: "sonnet" })
      },
      { listModels: async () => models },
    )
    const h = harness(registryOf(adapter))
    const id = await h.create({ agent: "cp", model: "sonnet", effort: "high" })
    await h.turn(id, "one")
    await h.waitIdle(id, 1)
    await h.turn(id, "two")
    await h.waitIdle(id, 2)
    expect(efforts).toEqual(["high", undefined])
    const restarted = new SessionService(h.store, registryOf(adapter), () => {})
    const listed = await restarted.invoke("models.list", { agent: "cp" }, "m1")
    expect((listed.result as { models: unknown }).models).toEqual([
      { id: "sonnet", label: "Sonnet", efforts: [] },
      { id: "gpt", label: "GPT", efforts: ["low", "high"], defaultEffort: "low" },
    ])
    // The session keeps its choice: another model takes it again.
    expect((h.store.getSession(id) as { effort: string }).effort).toBe("high")
  })

  test("compaction upserts by id, counts automatic compactions, and drops Grok context usage", async () => {
    const seen: Array<{ model?: string; contextWindow?: number }> = []
    const grok = scripted(
      "grok",
      async (_text, ctx) => {
        seen.push({ model: ctx.model, contextWindow: ctx.contextWindow })
        ctx.emit({ type: "compaction", id: "compact-1", state: "running", trigger: "auto", startedAt: 1000, contextSize: 256000 })
        ctx.emit({ type: "compaction", id: "compact-1", state: "done", trigger: "auto", tokensBefore: 206000, tokensAfter: 69000, contextSize: 256000 })
      },
      { listModels: async () => [{ id: "grok-4.7", label: "Grok 4.7", efforts: [], contextWindows: [256000, 500000] }] },
    )
    const h = harness(registryOf(grok))
    const id = await h.create({ agent: "grok", model: "grok-4.7", contextWindow: 500000 })
    expect(h.store.getSession(id)).toMatchObject({ context_window: 500000, compaction_count: 0 })
    await h.turn(id, "hello")
    await h.waitIdle(id, 1)
    const rows = h.rows(id, "compaction")
    expect(rows).toHaveLength(1)
    expect(messagePublic(rows[0]!)).toMatchObject({
      compaction: { state: "done", trigger: "auto", count: 1, startedAt: 1000, tokensBefore: 206000, tokensAfter: 69000 },
    })
    expect(h.store.getSession(id)).toMatchObject({ context_window: 500000, compaction_count: 1 })
    expect(JSON.parse(h.store.getSession(id)!.usage!)).toMatchObject({ contextUsed: 69000, contextSize: 256000 })
    expect(seen).toEqual([{ model: "grok-4.7", contextWindow: 500000 }])
  })

  test("only advertised model context windows are accepted", async () => {
    const grok = scripted("grok", async () => {}, {
      listModels: async () => [{ id: "grok-4.7", label: "Grok 4.7", efforts: [], contextWindows: [256000, 500000] }],
    })
    const h = harness(registryOf(grok))
    const created = await h.service.invoke("session.create", { agent: "grok", model: "grok-4.7", contextWindow: 500000 }, "c1")
    expect(created.type).toBe("result")
    const id = (created.result as { session: { id: string } }).session.id
    expect((await h.service.invoke("session.patch", { id, contextWindow: 64000 }, "p1")).error?.code).toBe("invalid")
    expect((await h.service.invoke("session.patch", { id, contextWindow: 256000 }, "p2")).type).toBe("result")
    const hello = await h.service.invoke("hello", {}, "h1")
    expect((hello.result as { features: string[] }).features).toContain("compaction")
    expect((hello.result as { features: string[] }).features).toContain("contextWindow")
  })

  test("models.list carries the permission modes; a live session's own modes can be chosen", async () => {
    const AUTOPILOT = "https://agentclientprotocol.com/protocol/session-modes#autopilot"
    let live: PermissionModeInfo[] | undefined
    const seen: string[] = []
    const acpish = scripted(
      "acpish",
      async (_text, ctx) => {
        seen.push(ctx.permissionMode)
      },
      { capabilities: capabilityModes([ACP_ASK, ACP_PLAN]), listPermissionModes: () => live },
    )
    const h = harness(registryOf(acpish))
    const before = await h.service.invoke("models.list", { agent: "acpish" }, "m1")
    expect((before.result as { modes: PermissionModeInfo[] }).modes).toEqual([ACP_ASK, ACP_PLAN])
    const id = await h.create({ agent: "acpish" })
    expect((await h.service.invoke("session.patch", { id, permissionMode: AUTOPILOT }, "p1")).error?.code).toBe("invalid")

    live = [
      { id: "ask", native: "#agent", label: "Agent", risk: "normal", fromAgent: true },
      { id: AUTOPILOT, native: "#autopilot", label: "Autopilot", risk: "caution", fromAgent: true },
    ]
    const after = await h.service.invoke("models.list", { agent: "acpish" }, "m2")
    expect((after.result as { modes: PermissionModeInfo[] }).modes).toEqual(live)
    const patched = await h.service.invoke("session.patch", { id, permissionMode: AUTOPILOT }, "p2")
    expect((patched.result as { session: { permissionMode: string } }).session.permissionMode).toBe(AUTOPILOT)
    await h.turn(id, "go")
    await h.waitIdle(id, 1)
    expect(seen).toEqual([AUTOPILOT])
  })

  test("Claude advertises native and its six explicit modes; risky ones are marked", async () => {
    const claude = BUILTIN_AGENTS.find((entry) => entry.spec.id === "claude")!.spec.capabilities
    expect(claude.permissionModes).toEqual(["native", "ask", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"])
    expect(claude.modes.filter((mode) => mode.risk !== "normal").map((mode) => [mode.id, mode.risk, mode.restart ?? false])).toEqual([
      ["native", "danger", true],
      ["auto", "caution", false],
      ["dontAsk", "caution", false],
      ["bypassPermissions", "danger", true],
    ])
    const codex = BUILTIN_AGENTS.find((entry) => entry.spec.id === "codex")!.spec.capabilities
    expect(codex.permissionModes).toEqual(["native", "ask", "acceptEdits", "plan", "fullAccess"])
  })

  test("Grok advertises auto approval instead of ask; an old ask is stored and shown as auto approval", async () => {
    const grok = BUILTIN_AGENTS.find((entry) => entry.spec.id === "grok")!.spec.capabilities
    expect(grok.autoApproval).toBe(true)
    expect(grok.permissionModes).toEqual(["autoApproval", "plan", "bypassPermissions"])
    expect(grok.modes.map((mode) => mode.id)).toEqual(["autoApproval", "plan", "bypassPermissions"])
    expect(grok.modes[0]).toMatchObject({ label: "Auto", risk: "caution", native: "auto" })
    expect(grok.modes[2]).toMatchObject({ risk: "danger", restart: true, native: "bypassPermissions" })

    const live: PermissionModeInfo[] = [
      { id: "ask", native: "default", label: "Always ask", risk: "normal", fromAgent: true },
      { id: "plan", native: "plan", label: "Plan only", risk: "normal" },
    ]
    const adapter = scripted("grok", async () => {}, {
      capabilities: { autoApproval: true, ...capabilityModes([ACP_ASK, ACP_PLAN]) },
      listPermissionModes: () => live,
    })
    const h = harness(registryOf(adapter))
    const listed = await h.service.invoke("models.list", { agent: "grok" }, "m1")
    const modes = (listed.result as { modes: PermissionModeInfo[] }).modes
    expect(modes.map((mode) => mode.id)).toEqual(["autoApproval", "plan"])
    expect(modes[0]).toMatchObject({ label: "Auto", risk: "caution" })
    const hello = await h.service.invoke("hello", {}, "h1")
    const agents = (hello.result as { agents: Array<{ id: string; capabilities: { permissionModes: string[] } }> }).agents
    expect(agents.find((entry) => entry.id === "grok")?.capabilities.permissionModes).toEqual(["autoApproval", "plan"])

    const bare = await h.create({ agent: "grok" })
    expect(h.store.getSession(bare)?.permission_mode).toBe("autoApproval")
    const id = await h.create({ agent: "grok", permissionMode: "ask" })
    expect(h.store.getSession(id)?.permission_mode).toBe("autoApproval")
    const got = await h.service.invoke("session.get", { id }, "g1")
    expect((got.result as { session: { permissionMode: string } }).session.permissionMode).toBe("autoApproval")

    h.store.db.query("UPDATE sessions SET permission_mode = 'ask' WHERE id = ?").run(id)
    const legacy = await h.service.invoke("session.get", { id }, "g2")
    expect((legacy.result as { session: { permissionMode: string } }).session.permissionMode).toBe("autoApproval")
    expect(h.store.getSession(id)?.permission_mode).toBe("ask")

    const patched = await h.service.invoke("session.patch", { id, permissionMode: "ask" }, "p1")
    expect((patched.result as { session: { permissionMode: string } }).session.permissionMode).toBe("autoApproval")
    expect(h.store.getSession(id)?.permission_mode).toBe("autoApproval")
    const plan = await h.service.invoke("session.patch", { id, permissionMode: "plan" }, "p2")
    expect((plan.result as { session: { permissionMode: string } }).session.permissionMode).toBe("plan")
    const rejected = await h.service.invoke("session.patch", { id, permissionMode: "bypassPermissions" }, "p3")
    expect(rejected.error?.code).toBe("invalid")
  })

  test("launch keeps a stored mode until a live list drops it", async () => {
    const AUTOPILOT = "https://agentclientprotocol.com/protocol/session-modes#autopilot"
    let live: PermissionModeInfo[] | undefined
    const seen: string[] = []
    const acpish = scripted(
      "acpish",
      async (_text, ctx) => {
        seen.push(ctx.permissionMode)
      },
      { capabilities: capabilityModes([ACP_ASK, ACP_PLAN]), listPermissionModes: () => live },
    )
    const h = harness(registryOf(acpish))
    const id = await h.create({ agent: "acpish", model: "kept-model" })
    h.store.db.query("UPDATE sessions SET permission_mode = ? WHERE id = ?").run(AUTOPILOT, id)

    await h.turn(id, "before")
    await h.waitIdle(id, 1)
    expect(seen).toEqual([AUTOPILOT])
    expect(h.store.getSession(id)?.permission_mode).toBe(AUTOPILOT)

    live = [{ id: "ask", native: "#agent", label: "Agent", risk: "normal", fromAgent: true }]
    await h.turn(id, "after")
    await h.waitIdle(id, 2)
    expect(seen).toEqual([AUTOPILOT, "ask"])
    expect(h.store.getSession(id)).toMatchObject({ permission_mode: "ask", model: "kept-model" })
    const upserts = h.named("session.upsert").map(payload).filter((session) => session.id === id)
    expect(upserts.at(-1)?.permissionMode).toBe("ask")
  })

  test("a legacy ask on an auto-approval agent launches as auto approval without rewriting the row", async () => {
    const seen: string[] = []
    const grok = scripted(
      "grok",
      async (_text, ctx) => {
        seen.push(ctx.permissionMode)
      },
      { capabilities: { autoApproval: true, ...capabilityModes([ACP_ASK, ACP_PLAN]) } },
    )
    const h = harness(registryOf(grok))
    const id = await h.create({ agent: "grok", model: "grok-4.7" })
    h.store.db.query("UPDATE sessions SET permission_mode = 'ask' WHERE id = ?").run(id)
    await h.turn(id, "go")
    await h.waitIdle(id, 1)
    expect(seen).toEqual(["autoApproval"])
    expect(h.store.getSession(id)).toMatchObject({ permission_mode: "ask", model: "grok-4.7" })
  })

  test("a live mode list keeps a static restart mode, and a patch during a turn is stored", async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const live: PermissionModeInfo[] = [
      { id: "ask", native: "default", label: "Always ask", risk: "normal", fromAgent: true },
      { id: "plan", native: "plan", label: "Plan only", risk: "normal" },
    ]
    const adapter = scripted(
      "grok",
      async () => {
        await gate
      },
      {
        capabilities: { autoApproval: true, ...capabilityModes(modesForAutoApproval([ACP_PLAN, GROK_BYPASS_MODE])) },
        listPermissionModes: () => live,
      },
    )
    const h = harness(registryOf(adapter))
    const listed = await h.service.invoke("models.list", { agent: "grok" }, "m1")
    const modes = (listed.result as { modes: PermissionModeInfo[] }).modes
    expect(modes.map((mode) => mode.id)).toEqual(["autoApproval", "plan", "bypassPermissions"])
    const id = await h.create({ agent: "grok", permissionMode: "plan" })
    await h.turn(id, "go")
    const patched = await h.service.invoke("session.patch", { id, permissionMode: "bypassPermissions" }, "p1")
    expect(patched.error).toBeUndefined()
    expect((patched.result as { session: { permissionMode: string } }).session.permissionMode).toBe("bypassPermissions")
    expect(h.store.getSession(id)?.permission_mode).toBe("bypassPermissions")
    release()
    await h.waitIdle(id, 1)
  })

  test("an agent leaving a mode by itself is saved and broadcast, and the next turn keeps it (r29)", async () => {
    const seen: string[] = []
    const planner = scripted("planner", async (_text, ctx) => {
      seen.push(ctx.permissionMode)
      // An approved plan: the agent is now in its asking mode.
      if (ctx.permissionMode === "plan") ctx.emit({ type: "mode", mode: "ask" })
    })
    const h = harness(registryOf(planner))
    const id = await h.create({ agent: "planner", permissionMode: "plan" })
    await h.turn(id, "plan it")
    await h.waitIdle(id, 1)
    expect(h.store.getSession(id)?.permission_mode).toBe("ask")
    const upserts = h.named("session.upsert").map(payload).filter((session) => session.id === id)
    expect(upserts.at(-1)?.permissionMode).toBe("ask")
    await h.turn(id, "do it")
    await h.waitIdle(id, 2)
    expect(seen).toEqual(["plan", "ask"])
  })

  test("an agent-reported danger, restart, or unpublished mode is ignored; only session.patch enters it", async () => {
    const reported = ["bypassPermissions", "fullAccess", "yolo", "acceptEdits"]
    const seen: string[] = []
    const agent = scripted(
      "drifter",
      async (_text, ctx) => {
        seen.push(ctx.permissionMode)
        const next = reported.shift()
        if (next) ctx.emit({ type: "mode", mode: next })
      },
      {
        capabilities: {
          ...capabilityModes([
            ...["ask", "acceptEdits", "plan"].map((id) => ({ id, native: id, label: id, risk: "normal" as const })),
            { id: "fullAccess", native: "full", label: "Full", risk: "danger" },
            GROK_BYPASS_MODE,
          ]),
        },
      },
    )
    const h = harness(registryOf(agent))
    const id = await h.create({ agent: "drifter", permissionMode: "ask" })
    for (let turn = 1; turn <= 3; turn++) {
      await h.turn(id, `t${turn}`)
      await h.waitIdle(id, turn)
      expect(h.store.getSession(id)?.permission_mode).toBe("ask")
    }
    // A published, normal, in-session mode still follows the agent.
    await h.turn(id, "t4")
    await h.waitIdle(id, 4)
    expect(h.store.getSession(id)?.permission_mode).toBe("acceptEdits")
    await h.turn(id, "t5")
    await h.waitIdle(id, 5)
    expect(seen).toEqual(["ask", "ask", "ask", "ask", "acceptEdits"])
    const patched = await h.service.invoke("session.patch", { id, permissionMode: "fullAccess" }, "p1")
    expect(patched.error).toBeUndefined()
    expect(h.store.getSession(id)?.permission_mode).toBe("fullAccess")
  })
})

describe("session folder at turn start", () => {
  test("a folder swapped for a symlink out of the workspace fails the turn before the agent starts", async () => {
    const root = mkdtempSync(join(tmpdir(), "rudder-root-"))
    const outside = mkdtempSync(join(tmpdir(), "rudder-elsewhere-"))
    try {
      const project = join(root, "project")
      mkdirSync(project)
      const started: string[] = []
      const h = harness(
        scripted("probe", async (_text, ctx) => {
          started.push(ctx.cwd)
        }),
        { workspaceRoot: root },
      )
      const id = await h.create({ agent: "probe" })
      h.store.patchSession(id, { cwd: project })
      await h.turn(id, "one")
      await h.waitIdle(id, 1)
      expect(started).toEqual([project])
      rmSync(project, { recursive: true })
      symlinkSync(outside, project)
      await h.turn(id, "two")
      await h.waitIdle(id, 2)
      expect(started).toEqual([project])
      expect(h.rows(id).at(-1)?.text).toContain("工作目录不可用")
      expect((messagePublic(h.rows(id).at(-1)!) as { copy?: { code: string } }).copy?.code).toBe("cwd_unavailable")
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe("steer and plan", () => {
  test("steer is unsupported for agents without it and forwarded for agents with it", async () => {
    const fakeHarness = harness(createFakeAdapter())
    const fakeId = await fakeHarness.create()
    const refused = await fakeHarness.service.invoke("message.steer", { sessionId: fakeId, action: "steer", text: "more" }, "s0")
    expect(refused.error?.code).toBe("unsupported")

    let release: () => void = () => {}
    const steered: string[] = []
    const steerable = scripted(
      "steerable",
      () =>
        new Promise<void>((resolve) => {
          release = () => resolve()
        }),
      {
        capabilities: { steer: true },
        steer: async (_sessionId, text) => {
          steered.push(text)
          return true
        },
      },
    )
    const h = harness(registryOf(steerable))
    const id = await h.create({ agent: "steerable" })
    const idle = await h.service.invoke("message.steer", { sessionId: id, action: "steer", text: "x" }, "s1")
    expect(idle.error?.code).toBe("idle")
    await h.turn(id, "start")
    const ok = await h.service.invoke("message.steer", { sessionId: id, action: "steer", text: "also this" }, "s2")
    expect(ok.type).toBe("result")
    expect(steered).toEqual(["also this"])
    expect(h.rows(id).at(-1)).toMatchObject({ role: "user", text: "also this" })
    release()
    await h.waitIdle(id, 1)
  })

  test("plan events upsert one plan block", async () => {
    const h = harness(
      scripted("s", async (_text, ctx) => {
        ctx.emit({ type: "plan", id: "p1", entries: [{ content: "read", status: "in_progress" }] })
        ctx.emit({
          type: "plan",
          id: "p1",
          entries: [
            { content: "read", status: "completed" },
            { content: "write", status: "pending" },
          ],
        })
      }),
    )
    const id = await h.create()
    await h.turn(id, "plan")
    await h.waitIdle(id, 1)
    const rows = h.rows(id, "plan")
    expect(rows).toHaveLength(1)
    expect(messagePublic(rows[0]!).plan?.entries).toHaveLength(2)
    expect(rows[0]!.text).toBe("[x] read\n[ ] write")
  })
})

describe("adapter registry", () => {
  test("fake mode maps every built-in agent to the fake adapter", () => {
    const registry = createAdapterRegistry("fake")
    expect(registry.list().map((adapter) => adapter.spec.id)).toEqual(BUILTIN_AGENTS.map((entry) => entry.spec.id))
    expect(registry.list().every((adapter) => adapter.spec.transport === "fake")).toBe(true)
    expect(registry.get("codex")?.spec.capabilities.steer).toBe(true)
    expect(registry.get("unknown")).toBeUndefined()
  })

  test("live mode lists all agents", () => {
    const registry = createAdapterRegistry("live")
    expect(registry.list().map((adapter) => adapter.spec.id)).toEqual([
      "claude",
      "codex",
      "grok",
      "copilot",
      "cursor",
      "opencode",
      "kimi",
      "gemini",
      "goose",
      "qwen",
      "pi",
    ])
    const experimental = registry.list().filter((adapter) => adapter.spec.experimental).map((adapter) => adapter.spec.id)
    expect(experimental).toEqual(["cursor", "opencode", "kimi", "gemini", "goose", "qwen", "pi"])
    expect(registry.get("grok")?.spec.transport).toBe("acp")
    // npx runs pi-acp at an exact version, never whatever is latest on the registry at launch.
    expect(BUILTIN_AGENTS.find((entry) => entry.spec.id === "pi")?.command.at(-1)).toMatch(/^pi-acp@\d+\.\d+\.\d+$/)
    // Every agent gets a detect. Calling it here would spawn whichever CLIs this machine has installed
    // (claude initialize, copilot's probe session: seconds each); the adapter tests cover detect offline.
    expect(registry.list().every((adapter) => typeof adapter.detect === "function")).toBe(true)
  })

  test("detect results are cached for the TTL", async () => {
    let calls = 0
    const detect = async () => {
      calls += 1
      return { available: true }
    }
    const cached = cachedDetect(detect)
    await cached()
    await cached()
    expect(calls).toBe(1)
    const uncached = cachedDetect(detect, { ttlMs: 0 })
    await uncached()
    await uncached()
    expect(calls).toBe(3)
  })

  // 2026-11-12 (perf-1112 R6): ten hellos in a row started one Claude probe, not ten, and only a changed binary or
  // credentials file, a sign-in failure or the long TTL asks again. A "no" still expires on the short TTL.
  test("a long-lived yes is probed once across hellos, and ends on a new stamp, forget or its own TTL", async () => {
    let calls = 0
    let answer = { available: true } as { available: boolean; reason?: string }
    const detect = async () => {
      calls += 1
      return answer
    }
    let stamp = "a"
    let now = 1_000_000
    const realNow = Date.now
    Date.now = () => now
    try {
      const cached = cachedDetect(detect, { ttlMs: 60_000, availableTtlMs: 30 * 60_000, stamp: () => stamp })
      for (let i = 0; i < 10; i++) {
        await cached()
        now += 30_000
      }
      expect(calls).toBe(1)
      stamp = "b"
      await cached()
      expect(calls).toBe(2)
      cached.forget()
      await cached()
      expect(calls).toBe(3)
      now += 30 * 60_000
      answer = { available: false, reason: "signed out" }
      await cached()
      expect(calls).toBe(4)
      now += 60_000
      await cached()
      expect(calls).toBe(5)
    } finally {
      Date.now = realNow
    }
    // Claude, whose probe is a cold CLI start, is the agent on the long TTL.
    const claude = BUILTIN_AGENTS.find((entry) => entry.spec.id === "claude")
    expect(claude?.detectCache?.availableTtlMs).toBe(CLAUDE_DETECT_TTL_MS)
  })
})

describe("store compatibility", () => {
  test("legacy payloads still parse", () => {
    const store = new Store(":memory:")
    const legacy = [
      { kind: "tool", payload: { id: "t", tool: "Bash", title: "Run", detail: "ls", status: "done" } },
      { kind: "permission", payload: { id: "p", tool: "Bash", title: "Run", detail: "ls", status: "allowed" } },
      { kind: "question", payload: { id: "q", prompt: "Go?", options: ["是"], status: "answered", answer: "是" } },
    ]
    for (const [index, entry] of legacy.entries()) {
      store.insertMessage({
        id: entry.payload.id,
        session_id: "s",
        kind: entry.kind,
        role: "assistant",
        text: "x",
        payload: JSON.stringify(entry.payload),
        created_at: index,
      })
    }
    const [tool, permission, question] = store.listMessages("s").map(messagePublic)
    expect(tool?.tool?.status).toBe("done")
    expect(permission?.permission?.status).toBe("allowed")
    expect(permission?.permission?.options).toBeUndefined()
    expect(question?.question?.answer).toBe("是")
  })

  test("an old sessions table gains the new columns with defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "rudder-store-"))
    try {
      const path = join(dir, "old.sqlite")
      const old = new Database(path)
      old.exec(
        "CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, agent TEXT NOT NULL, status TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)",
      )
      old.query("INSERT INTO sessions VALUES ('s1', 'Old', 'claude', 'idle', 0, 1)").run()
      old.close()
      const store = new Store(path)
      const row = store.getSession("s1")!
      expect(row.native_id).toBeNull()
      expect(row.permission_mode).toBe("ask")
      expect(row.effort).toBe("")
      expect(row.speed).toBe("")
      expect(sessionPublic(row).usage).toEqual({})
      store.db.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("list preview", () => {
  type Preview = { role: string; text: string } | null
  const previews = (h: ReturnType<typeof harness>, sessionId: string) =>
    h
      .named("session.upsert")
      .filter((event) => payload(event).id === sessionId)
      .map((event) => payload(event).preview as Preview)

  test("a streamed reply announces its preview until it outgrows the cap, then stays quiet", async () => {
    const long = `**Done.** ${"word ".repeat(40)}`
    const h = harness(
      scripted("s", async (_text, ctx) => {
        for (const text of ["**Hi**", "**Hi** there", long, `${long} and more`]) {
          ctx.emit({ type: "text", id: "t1", text })
          await Bun.sleep(130)
        }
      }),
    )
    const id = await h.create()
    await h.turn(id, "say `hi`")
    await h.waitIdle(id, 1)
    const seen = previews(h, id)
    expect(seen).toContainEqual(expect.objectContaining({ role: "user", text: "say hi" }))
    const assistant = seen.filter((preview) => preview?.role === "assistant").map((preview) => preview?.text)
    const capped = previewText(long)
    expect(capped.endsWith("…")).toBe(true)
    expect([...new Set(assistant)]).toEqual(["Hi", "Hi there", capped])
    // One upsert per change while streaming, plus the turn-end idle upsert carrying the final preview.
    expect(assistant).toEqual(["Hi", "Hi there", capped, capped])
    const listed = await h.service.invoke("session.list", {}, "l")
    const session = (listed.result as { sessions: Array<{ id: string; preview: Preview }> }).sessions.find((row) => row.id === id)
    expect(session?.preview).toMatchObject({ role: "assistant", text: capped })
  })

  test("a cancelled turn keeps the user's message as the preview", async () => {
    const quiet = scripted(
      "quiet",
      (_text, ctx) =>
        new Promise<void>((resolve) => {
          ctx.signal.addEventListener("abort", () => {
            ctx.emit({ type: "text", id: "c1", text: "Cancelled.", notice: true })
            resolve()
          })
        }),
    )
    const throwing = scripted(
      "throwing",
      (_text, ctx) =>
        new Promise<void>((_resolve, reject) => {
          ctx.signal.addEventListener("abort", () => reject(new Error("aborted")))
        }),
    )
    const h = harness(registryOf(quiet, throwing))
    for (const agent of ["quiet", "throwing"]) {
      const id = await h.create({ agent })
      const before = await h.turn(id, "run ls")
      await h.service.invoke("message.steer", { sessionId: id, action: "cancel" }, crypto.randomUUID())
      await h.waitIdle(id, before + 1)
      expect(h.rows(id).at(-1)).toMatchObject({ kind: "text", text: "Cancelled." })
      expect(previews(h, id).at(-1)).toMatchObject({ role: "user", text: "run ls" })
    }
  })

  test("a steered message moves the preview at once and a clear empties it", async () => {
    let release: () => void = () => {}
    const steerable = scripted(
      "steerable",
      () =>
        new Promise<void>((resolve) => {
          release = () => resolve()
        }),
      { capabilities: { steer: true }, steer: async () => true },
    )
    const h = harness(registryOf(steerable))
    const id = await h.create({ agent: "steerable" })
    await h.turn(id, "start")
    await h.service.invoke("message.steer", { sessionId: id, action: "steer", text: "also *this*" }, "s1")
    expect(previews(h, id).at(-1)).toMatchObject({ role: "user", text: "also this" })
    release()
    await h.waitIdle(id, 1)
    await h.service.invoke("session.clear", { id }, "c1")
    expect(previews(h, id).at(-1)).toBeNull()
  })
})

describe("agent images", () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVQI12P4z8AAAAADAAEABf4C/tzMWecAAAAASUVORK5CYII=",
    "base64",
  )

  test("v65 A: pictures the turn wrote or named are attached after the reply, once each, with their file names", async () => {
    const root = mkdtempSync(join(tmpdir(), "rudder-turnimg-"))
    const dir = join(root, "work")
    mkdirSync(join(dir, "shots"), { recursive: true })
    try {
      writeFileSync(join(dir, "shots", "home-se.png"), png)
      writeFileSync(join(dir, "shots", "home-pro-max.png"), png)
      writeFileSync(join(root, "outside.png"), png)
      writeFileSync(join(dir, "notes.png"), "text, not a picture")
      // What claude.ts emits for a Write tool_use (describeTool), here of a picture file.
      const write = describeTool("Write", { file_path: join(dir, "shots", "home-se.png"), content: "…" })
      const h = harness(
        scripted("claude", async (_text, ctx) => {
          ctx.emit({ type: "tool", id: "w1", tool: "Write", status: "completed", ...write })
          ctx.emit({ type: "text", id: "t1", text: "SE 和 Pro Max 各截了一张：" })
          ctx.emit({
            type: "text",
            id: "t1",
            text: "SE 和 Pro Max 各截了一张：shots/home-se.png、`shots/home-pro-max.png`，旧图 ../outside.png，notes.png 和 gone.png。",
          })
        }),
        { workspaceRoot: root },
      )
      const id = await h.create({ agent: "claude" })
      h.store.patchSession(id, { cwd: dir })
      await h.turn(id, "截图")
      await h.waitIdle(id, 1)
      const rows = h.store.listMessages(id)
      const images = rows.filter((row) => row.kind === "image").map((row) => messagePublic(row).image)
      expect(images.map((image) => [image?.name, image?.fileName, image?.sourcePath])).toEqual([
        ["home-se.png", "home-se.png", join("shots", "home-se.png")],
        ["home-pro-max.png", "home-pro-max.png", join("shots", "home-pro-max.png")],
      ])
      // After the reply, before the turn's idle.
      const lastText = rows.findLastIndex((row) => row.kind === "text")
      expect(rows.findIndex((row) => row.kind === "image")).toBeGreaterThan(lastText)
      expect(readdirSync(attachmentDir(dir, id))).toHaveLength(2)
      const stored = await h.service.readAttachment(id, images[0]!.id)
      expect(Buffer.from(stored!.data)).toEqual(png)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("an image is stored with its dimensions, replayed once, and kept out of the preview", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rudder-img-"))
    try {
      const image = { type: "image" as const, id: "img1", name: "launch-poster.png", mediaType: "image/png", width: 1, height: 1, bytes: new Uint8Array(png) }
      const h = harness(
        scripted("codex", async (_text, ctx) => {
          await ctx.emit(image)
          ctx.emit({ type: "text", id: "t1", text: "做好了。" })
          await ctx.emit(image)
        }),
        { workspaceRoot: dir },
      )
      const id = await h.create({ agent: "codex" })
      h.store.patchSession(id, { cwd: dir })
      await h.turn(id, "poster")
      await h.waitIdle(id, 1)
      const stored = messagePublic(h.store.getMessage("img1")!)
      expect(stored).toMatchObject({ kind: "image", role: "assistant", text: "" })
      expect(stored.image).toMatchObject({ name: "launch-poster.png", mediaType: "image/png", width: 1, height: 1, bytes: png.byteLength })
      expect(JSON.stringify(stored)).not.toContain(dir)
      expect(h.store.getSession(id)?.preview_text).toBe("做好了。")
      const found = await findAttachment(dir, id, stored.image!.id)
      expect(readFileSync(found!.path)).toEqual(png)
      expect(readdirSync(attachmentDir(dir, id))).toHaveLength(1)
      const history = await h.service.invoke("history.page", { sessionId: id, beforeSeq: 1_000_000, limit: 40 }, "hist")
      if (history.type !== "result") throw new Error(history.error?.message)
      const messages = (history.result as { messages: { kind: string; image?: { id: string } }[] }).messages
      expect(messages.filter((message) => message.kind === "image").map((message) => message.image?.id)).toEqual([stored.image!.id])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
