import { describe, expect, test } from "bun:test"
import { createFakeAdapter } from "./adapter/fake"
import { SessionService } from "./session-service"
import {
  messageOutline,
  messagePublic,
  OUTLINE_MAX_BYTES,
  OUTLINE_MAX_MESSAGES,
  outlineTranscript,
  readOutlineMessages,
  Store,
  type MessageRow,
} from "./store"

function row(overrides: Partial<MessageRow> & Pick<MessageRow, "seq" | "kind" | "text">): MessageRow {
  return {
    id: `m${overrides.seq}`,
    session_id: "s",
    role: "assistant",
    payload: null,
    created_at: overrides.seq,
    ...overrides,
  }
}

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value))
}

describe("messageOutline", () => {
  test("keeps the fields a fold summary reads and drops the heavy ones", () => {
    const tool = row({
      seq: 1,
      kind: "tool",
      role: "assistant",
      text: "bash: run",
      payload: JSON.stringify({
        id: "t1",
        tool: "bash",
        title: "run",
        detail: `d${"😀".repeat(200)}`,
        status: "failed",
        kind: "edit",
        output: "no such file\nrest",
        outputTruncated: true,
        exitCode: 1,
        diffs: [{ path: "src/a.ts", patch: "+line", oldText: "a", newText: "b", truncated: true }],
      }),
    })
    const outlined = messageOutline(tool, 99)
    expect(outlined.trimmed).toBe(true)
    expect(outlined.fullBytes).toBe(bytes(messagePublic(tool)))
    expect(outlined.tool).toMatchObject({
      id: "t1",
      tool: "bash",
      title: "run",
      status: "failed",
      kind: "edit",
      exitCode: 1,
      error: "no such file",
      diffs: [{ path: "src/a.ts" }],
    })
    expect(Array.from(outlined.tool?.detail ?? "")).toHaveLength(200)
    expect(outlined.tool).not.toHaveProperty("output")
    expect(outlined.tool).not.toHaveProperty("outputTruncated")
    expect(outlined.tool?.diffs?.[0]).not.toHaveProperty("patch")

    const thought = row({
      seq: 2,
      kind: "reasoning",
      text: "想".repeat(100),
      payload: JSON.stringify({ startedAt: 1_000, endedAt: 11_500 }),
    })
    const lightThought = messageOutline(thought, 99)
    expect(lightThought.reasoning).toEqual({ startedAt: 1_000, endedAt: 11_500 })
    expect(lightThought.text).toBe("想".repeat(80))
    expect(lightThought.trimmed).toBe(true)

    const short = row({ seq: 3, kind: "reasoning", text: "短", payload: JSON.stringify({ startedAt: 1, endedAt: 2 }) })
    expect(messageOutline(short, 99)).toEqual(messagePublic(short))

    const live = row({
      seq: 100,
      kind: "tool",
      text: "bash: run",
      payload: JSON.stringify({ id: "t100", tool: "bash", title: "run", detail: "now", status: "running", output: "x".repeat(3000) }),
    })
    expect(messageOutline(live, 99)).toEqual(messagePublic(live))
  })

  test("a reply, an approval, a question, a plan, an error and an image stay whole", () => {
    const samples = [
      row({ seq: 1, kind: "text", role: "user", text: "hello" }),
      row({ seq: 2, kind: "text", text: "y".repeat(30_000) }),
      row({
        seq: 3,
        kind: "permission",
        text: "Bash: Run",
        payload: JSON.stringify({ id: "p", tool: "Bash", title: "Run", detail: "ls", status: "allowed" }),
      }),
      row({
        seq: 4,
        kind: "question",
        text: "Go?",
        payload: JSON.stringify({ id: "q", prompt: "Go?", options: ["是"], status: "answered", answer: "是" }),
      }),
      row({
        seq: 5,
        kind: "plan",
        text: "[x] step",
        payload: JSON.stringify({ entries: [{ status: "completed", content: "step" }] }),
      }),
      row({ seq: 6, kind: "error", text: "Error: boom" }),
      row({
        seq: 7,
        kind: "image",
        text: "",
        payload: JSON.stringify({ id: "img", name: "a.png", bytes: 10, mediaType: "image/png", width: 1, height: 1 }),
      }),
    ]
    for (const sample of samples) expect(messageOutline(sample, 99)).toEqual(messagePublic(sample))
  })

  test("the byte cap keeps the newest segment and the live turn", () => {
    const history = Array.from({ length: 80 }, (_, index) => row({ seq: index + 1, kind: "text", text: "y".repeat(30_000) }))
    const prompt = row({ seq: 81, kind: "text", role: "user", text: "hi" })
    const fitted = outlineTranscript([...history, prompt], 81)
    expect(bytes(fitted)).toBeLessThanOrEqual(OUTLINE_MAX_BYTES)
    expect(fitted.at(-1)?.id).toBe("m81")
    expect(fitted.length).toBeLessThan(81)
    expect(fitted[0]!.seq).toBeGreaterThan(1)
    const all = [...history, prompt].map((item) => messageOutline(item, 81))
    const dropped = all.slice(all.length - fitted.length - 1)
    expect(bytes(dropped)).toBeGreaterThan(OUTLINE_MAX_BYTES)
    expect(bytes(fitted)).toBe(bytes(all.slice(all.length - fitted.length)))

    const livePrompt = row({ seq: 2, kind: "text", role: "user", text: "hi" })
    const huge = row({ seq: 3, kind: "text", text: "z".repeat(OUTLINE_MAX_BYTES) })
    const tail = outlineTranscript([row({ seq: 1, kind: "text", text: "old" }), livePrompt, huge], 2)
    expect(tail.map((item) => item.seq)).toEqual([2, 3])
    expect(bytes(tail)).toBeGreaterThan(OUTLINE_MAX_BYTES)
    expect(tail[1]?.text.length).toBe(OUTLINE_MAX_BYTES)
  })

  test("the message cap keeps the newest rows", () => {
    const rows = Array.from({ length: OUTLINE_MAX_MESSAGES + 1 }, (_, index) =>
      row({ seq: index + 1, kind: "text", role: "user", text: "n" }),
    )
    const fitted = outlineTranscript(rows, rows.at(-1)!.seq)
    expect(fitted).toHaveLength(OUTLINE_MAX_MESSAGES)
    expect(fitted[0]?.seq).toBe(2)
    expect(fitted.at(-1)?.seq).toBe(OUTLINE_MAX_MESSAGES + 1)
  })
})

describe("outline session window", () => {
  test("an outline session.get with limit returns only the newest page, older pages through history.page", async () => {
    const store = new Store(":memory:")
    const service = new SessionService(store, createFakeAdapter(), () => {})
    const session = store.createSession()
    for (let seq = 1; seq <= 500; seq++) {
      store.insertMessage({ id: `m${seq}`, session_id: session.id, kind: "text", role: seq % 2 ? "user" : "assistant", text: `t ${seq}`, created_at: seq })
    }
    const page = (await service.invoke("session.get", { id: session.id, outline: true, limit: 120 }, "p")).result as {
      messages: { seq: number }[]
      hasMore: boolean
    }
    expect(page.messages).toHaveLength(120)
    expect(page.messages[0]?.seq).toBe(381)
    expect(page.messages.at(-1)?.seq).toBe(500)
    expect(page.hasMore).toBe(true)
    const older = (await service.invoke("history.page", { sessionId: session.id, beforeSeq: 381, limit: 120, outline: true }, "p"))
      .result as { messages: { seq: number }[]; hasMore: boolean }
    expect(older.messages[0]?.seq).toBe(261)
    expect(older.messages.at(-1)?.seq).toBe(380)
    // An older phone sends no limit and still gets the whole light history.
    const whole = (await service.invoke("session.get", { id: session.id, outline: true }, "p")).result as { messages: unknown[] }
    expect(whole.messages).toHaveLength(500)
  })

  test("session.get without outline still pages 80, and outline returns the light transcript", async () => {
    const store = new Store(":memory:")
    const service = new SessionService(store, createFakeAdapter(), () => {})
    const session = store.createSession()
    const patch = "+".repeat(400)
    for (let seq = 1; seq <= 2000; seq++) {
      const id = `m${seq}`
      if (seq % 60 === 1) {
        store.insertMessage({ id, session_id: session.id, kind: "text", role: "user", text: `ask ${seq}`, created_at: seq })
      } else if (seq % 60 === 2) {
        store.insertMessage({
          id,
          session_id: session.id,
          kind: "reasoning",
          role: "assistant",
          text: "想".repeat(120),
          payload: JSON.stringify({ startedAt: 1_000, endedAt: 11_500 }),
          created_at: seq,
        })
      } else if (seq % 60 === 0) {
        store.insertMessage({ id, session_id: session.id, kind: "text", role: "assistant", text: `reply ${seq}`, created_at: seq })
      } else if (seq === 3) {
        store.insertMessage({
          id,
          session_id: session.id,
          kind: "permission",
          role: "assistant",
          text: "Bash: Run",
          payload: JSON.stringify({ id: "p", tool: "Bash", title: "Run", detail: "ls", status: "allowed" }),
          created_at: seq,
        })
      } else if (seq === 4) {
        store.insertMessage({
          id,
          session_id: session.id,
          kind: "question",
          role: "assistant",
          text: "Go?",
          payload: JSON.stringify({ id: "q", prompt: "Go?", options: ["是"], status: "answered", answer: "是" }),
          created_at: seq,
        })
      } else if (seq === 5) {
        store.insertMessage({
          id,
          session_id: session.id,
          kind: "plan",
          role: "assistant",
          text: "[x] step",
          payload: JSON.stringify({ entries: [{ status: "completed", content: "step" }] }),
          created_at: seq,
        })
      } else if (seq === 6) {
        store.insertMessage({ id, session_id: session.id, kind: "error", role: "assistant", text: "Error: boom", created_at: seq })
      } else if (seq === 7) {
        store.insertMessage({
          id,
          session_id: session.id,
          kind: "image",
          role: "assistant",
          text: "",
          payload: JSON.stringify({ id: "img", name: "a.png", bytes: 10, mediaType: "image/png", width: 1, height: 1 }),
          created_at: seq,
        })
      } else {
        store.insertMessage({
          id,
          session_id: session.id,
          kind: "tool",
          role: "assistant",
          text: "bash: run",
          payload: JSON.stringify({
            id: `t${seq}`,
            tool: "bash",
            title: "run",
            detail: "d".repeat(240),
            status: seq === 9 ? "failed" : "completed",
            kind: "execute",
            output: seq === 9 ? `no such file\n${"e".repeat(2000)}` : "o".repeat(2048),
            exitCode: seq === 9 ? 1 : 0,
            diffs: [{ path: `src/${seq}.ts`, patch }],
          }),
          created_at: seq,
        })
      }
    }

    const list = store.listMessages.bind(store)
    let unbounded = 0
    store.listMessages = (id, options = {}) => {
      if (options.limit === undefined) unbounded += 1
      return list(id, options)
    }

    const paged = (await service.invoke("session.get", { id: session.id }, "old")).result as { messages: MessageRow[]; hasMore: boolean }
    expect(paged.messages).toHaveLength(80)
    expect(paged.hasMore).toBe(true)

    const opened = (await service.invoke("session.get", { id: session.id, outline: true }, "new")).result as {
      messages: Array<{ id: string; seq: number; kind: string; text: string; trimmed?: boolean; tool?: { output?: string; error?: string; diffs?: Array<{ path: string; patch?: string }> } }>
      hasMore: boolean
    }
    expect(unbounded).toBe(0)
    expect(opened.hasMore).toBe(false)
    expect(opened.messages).toHaveLength(2000)
    const full = list(session.id).map(messagePublic)
    const fullBytes = bytes(full)
    const lightBytes = bytes(opened.messages)
    expect(lightBytes).toBeLessThanOrEqual(fullBytes / 5)

    const historyTool = opened.messages.find((item) => item.id === "m9")
    expect(historyTool?.trimmed).toBe(true)
    expect(historyTool?.tool?.output).toBeUndefined()
    expect(historyTool?.tool?.error).toBe("no such file")
    expect(historyTool?.tool?.diffs).toEqual([{ path: "src/9.ts" }])
    expect(Array.from(historyTool?.tool && "detail" in historyTool.tool ? String((historyTool.tool as { detail: string }).detail) : "")).toHaveLength(200)

    const thought = opened.messages.find((item) => item.id === "m2")
    expect(thought?.text).toBe("想".repeat(80))
    expect(thought?.trimmed).toBe(true)

    const liveTool = opened.messages.find((item) => item.id === "m2000")
    expect(liveTool?.trimmed).toBeUndefined()
    expect(liveTool?.tool?.output).toHaveLength(2048)
    expect(liveTool?.tool?.diffs?.[0]?.patch).toBe(patch)

    for (const id of ["m3", "m4", "m5", "m6", "m7"]) {
      const wire = opened.messages.find((item) => item.id === id)
      const stored = list(session.id).find((item) => item.id === id)!
      expect(wire).toEqual(messagePublic(stored))
    }

    const bodies = (await service.invoke("message.bodies", { sessionId: session.id, ids: ["m9", "missing", "m2"] }, "b")).result as {
      messages: Array<{ id: string; tool?: { output?: string; diffs?: Array<{ patch?: string }> }; text: string }>
    }
    expect(bodies.messages.map((item) => item.id)).toEqual(["m9", "m2"])
    expect(bodies.messages[0]).toEqual(messagePublic(list(session.id).find((item) => item.id === "m9")!))
    expect(bodies.messages[0]?.tool?.output?.startsWith("no such file")).toBe(true)
    expect(bodies.messages[0]?.tool?.diffs?.[0]?.patch).toBe(patch)

    const empty = (await service.invoke("message.bodies", { sessionId: session.id, ids: [] }, "empty")).result as { messages: unknown[] }
    expect(empty.messages).toEqual([])
    expect((await service.invoke("message.bodies", { sessionId: session.id, ids: Array.from({ length: 201 }, (_, i) => `m${i}`) }, "over")).error?.code).toBe(
      "invalid",
    )
    expect((await service.invoke("message.bodies", { sessionId: session.id, ids: "m9" }, "bad")).error?.code).toBe("invalid")

    const other = store.createSession()
    const foreign = (await service.invoke("message.bodies", { sessionId: other.id, ids: ["m9"] }, "foreign")).result as { messages: unknown[] }
    expect(foreign.messages).toEqual([])
  })

  test("outline history pages are large and the old page stays capped at 100", async () => {
    const store = new Store(":memory:")
    const service = new SessionService(store, createFakeAdapter(), () => {})
    const session = store.createSession()
    for (let seq = 1; seq <= 2500; seq++) {
      store.insertMessage({ id: `p${seq}`, session_id: session.id, kind: "text", role: "user", text: "n", created_at: seq })
    }
    const outlined = (await service.invoke("history.page", { sessionId: session.id, beforeSeq: 2400, outline: true }, "o")).result as {
      messages: Array<{ seq: number }>
      hasMore: boolean
    }
    expect(outlined.messages).toHaveLength(2000)
    expect(outlined.messages[0]?.seq).toBe(400)
    expect(outlined.messages.at(-1)?.seq).toBe(2399)
    expect(outlined.hasMore).toBe(true)

    const capped = (await service.invoke("history.page", { sessionId: session.id, beforeSeq: 2400, outline: true, limit: 5000 }, "cap")).result as {
      messages: unknown[]
    }
    expect(capped.messages).toHaveLength(2000)

    const legacy = (await service.invoke("history.page", { sessionId: session.id, beforeSeq: 2400, limit: 500 }, "old")).result as {
      messages: unknown[]
    }
    expect(legacy.messages).toHaveLength(100)
  })

  test("a session past 5000 opens the newest window with hasMore", async () => {
    const store = new Store(":memory:")
    const service = new SessionService(store, createFakeAdapter(), () => {})
    const session = store.createSession()
    const total = OUTLINE_MAX_MESSAGES + 1
    for (let seq = 1; seq <= total; seq++) {
      store.insertMessage({ id: `n${seq}`, session_id: session.id, kind: "text", role: "user", text: "n", created_at: seq })
    }
    const list = store.listMessages.bind(store)
    let unbounded = 0
    store.listMessages = (id, options = {}) => {
      if (options.limit === undefined) unbounded += 1
      return list(id, options)
    }
    const opened = (await service.invoke("session.get", { id: session.id, outline: true }, "wide")).result as {
      messages: Array<{ seq: number; trimmed?: boolean }>
      hasMore: boolean
    }
    expect(unbounded).toBe(0)
    expect(opened.messages).toHaveLength(OUTLINE_MAX_MESSAGES)
    expect(opened.messages[0]?.seq).toBe(2)
    expect(opened.messages.at(-1)?.seq).toBe(total)
    expect(opened.messages.every((item) => item.trimmed === undefined)).toBe(true)
    expect(opened.hasMore).toBe(true)
  })

  test("rewind with outline returns the whole remaining transcript", async () => {
    const store = new Store(":memory:")
    const service = new SessionService(store, createFakeAdapter(), () => {})
    const session = store.createSession()
    for (let seq = 1; seq <= 100; seq++) {
      store.insertMessage({ id: `r${seq}`, session_id: session.id, kind: "text", role: "user", text: "n", created_at: seq })
    }
    const outlined = (await service.invoke("session.rewind", { id: session.id, seq: 100, outline: true }, "rw")).result as {
      messages: unknown[]
      hasMore: boolean
    }
    expect(outlined.messages).toHaveLength(100)
    expect(outlined.hasMore).toBe(false)
    const legacy = (await service.invoke("session.rewind", { id: session.id, seq: 100 }, "old")).result as { messages: unknown[]; hasMore?: boolean }
    expect(legacy.messages).toHaveLength(80)
    expect(legacy.hasMore).toBeUndefined()
  })
})

describe("batched outline reader", () => {
  function page(rows: MessageRow[]) {
    return (before: number | undefined, limit: number) => {
      const pool = before === undefined ? rows : rows.filter((item) => item.seq < before)
      return pool.slice(Math.max(0, pool.length - limit))
    }
  }

  function expectSame(rows: MessageRow[], lastPromptSeq: number | null, options: { maxMessages?: number; maxBytes?: number } = {}) {
    const limits: number[] = []
    const actual = readOutlineMessages(
      (before, limit) => {
        limits.push(limit)
        return page(rows)(before, limit)
      },
      lastPromptSeq,
      options,
    )
    expect(limits.every((limit) => limit > 0 && limit <= 128)).toBe(true)
    expect(actual).toEqual(outlineTranscript(rows, lastPromptSeq, options))
  }

  test("estimated-fit and exact-fit pages match with escaped characters and Unicode", () => {
    const rows = Array.from({ length: 260 }, (_, n) => row({
      seq: n + 1, kind: "text", text: `part ${n} ${"字😀\u0000\n\t\"".repeat(n % 31)}`,
    }))
    for (const maxBytes of [0, 10_000, 25_000, 80_000, 2_000_000]) {
      expectSame(rows, null, { maxBytes })
      expectSame(rows, 201, { maxBytes })
    }
  })

  test("heavy tool output, an over-budget live turn, emoji, and an exact byte boundary match", () => {
    const heavy = row({
      seq: 1,
      kind: "tool",
      role: "assistant",
      text: "bash: run",
      payload: JSON.stringify({
        id: "t1",
        tool: "bash",
        title: "run",
        detail: "d".repeat(400),
        status: "failed",
        output: `${"out".repeat(800)}\nboom`,
        diffs: [{ path: "src/a.ts", patch: "+".repeat(500), oldText: "a", newText: "b" }],
      }),
    })
    const prompt = row({ seq: 2, kind: "text", role: "user", text: "go" })
    const reply = row({ seq: 3, kind: "text", text: "done" })
    expectSame([heavy, prompt, reply], 2)

    const huge = row({ seq: 4, kind: "text", text: "字".repeat(900_000) })
    expectSame([heavy, prompt, reply, huge], 2)

    const thought = row({
      seq: 5,
      kind: "reasoning",
      text: `思路 ${"😀".repeat(40)} 结束`,
      payload: JSON.stringify({ startedAt: 1, endedAt: 2 }),
    })
    expectSame([thought, prompt, reply], 2)

    const plain = [1, 2, 3, 4].map((seq) => row({ seq, kind: "text", text: `item-${seq}-😀` }))
    const fitted = outlineTranscript(plain, null)
    const size = Buffer.byteLength(JSON.stringify(fitted))
    expectSame(plain, null, { maxBytes: size })
    const tighter = outlineTranscript(plain, null, { maxBytes: size - 1 })
    expect(tighter.length).toBeLessThan(fitted.length)
    expectSame(plain, null, { maxBytes: size - 1 })
  })
})
