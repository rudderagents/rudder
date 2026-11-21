import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { FAKE_SPEC } from "./adapter/fake"
import type { AdapterContext, AgentAdapter, PermissionRequest } from "./adapter/types"
import type { Frame } from "./protocol"
import { persistInterval, SessionService } from "./session-service"
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

function scripted(reply: AgentAdapter["reply"]): AgentAdapter {
  return { spec: { ...FAKE_SPEC, id: "s", label: "s" }, reply }
}

const RUN: PermissionRequest = {
  tool: "Bash",
  title: "Run",
  detail: "ls",
  kind: "execute",
  options: [{ id: "yes", label: "Yes", kind: "allow_once" }],
}

function harness(adapter: AgentAdapter, store = new Store(":memory:")) {
  const events: Frame[] = []
  const service = new SessionService(store, adapter, (frame) => events.push(frame))
  const named = (name: string) => events.filter((event) => event.name === name)
  const idle = (id: string) =>
    named("agent.status").filter((event) => payload(event).sessionId === id && payload(event).status === "idle").length
  return { store, events, service, named, idle }
}

describe("busy state survives restarts", () => {
  test("a session left running or waiting by a crash comes back idle", () => {
    const dir = mkdtempSync(join(tmpdir(), "rudder-busy-"))
    try {
      const path = join(dir, "db.sqlite")
      const first = new Store(path)
      const running = first.createSession({ agent: "s" })
      const waiting = first.createSession({ agent: "s" })
      first.patchSession(running.id, { status: "running" })
      first.patchSession(waiting.id, { status: "waiting" })
      first.db.close()
      const second = new Store(path)
      expect(second.getSession(running.id)?.status).toBe("idle")
      expect(second.getSession(waiting.id)?.status).toBe("idle")
      second.db.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a streamed row written quietly before a crash takes its rev at the next start", () => {
    const dir = mkdtempSync(join(tmpdir(), "rudder-quiet-"))
    try {
      const path = join(dir, "db.sqlite")
      const first = new Store(path)
      const id = first.createSession({ agent: "s" }).id
      const row = { id: "t1", session_id: id, kind: "text", role: "assistant", text: "p".repeat(300), created_at: 1 }
      const inserted = first.insertMessage(row)
      const version = first.sessionVersion()
      const quiet = first.insertMessage({ ...row, text: `${row.text} and more` }, { quiet: true })
      expect(quiet.rev).toBe(inserted.rev)
      expect(first.sessionVersion()).toBe(version)
      first.db.close()
      const second = new Store(path)
      const stored = second.getMessage("t1")!
      expect(stored.text).toBe(`${row.text} and more`)
      expect(stored.rev!).toBeGreaterThan(inserted.rev!)
      expect(second.messageChanges(id, inserted.rev!, 10).rows.map((message) => message.id)).toEqual(["t1"])
      expect(second.settleMessage("t1")).toBeNull()
      second.db.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a plain write after quiet ones takes a rev even when the text did not change", () => {
    const store = new Store(":memory:")
    const id = store.createSession({ agent: "s" }).id
    const row = { id: "t1", session_id: id, kind: "text", role: "assistant", text: "a", created_at: 1 }
    const inserted = store.insertMessage(row)
    store.insertMessage({ ...row, text: "ab" }, { quiet: true })
    const plain = store.insertMessage({ ...row, text: "ab" })
    expect(plain.rev!).toBeGreaterThan(inserted.rev!)
    expect(store.getMessage("t1")!.rev).toBe(plain.rev)
    // Settled: the next identical write is a no-op again.
    expect(store.insertMessage({ ...row, text: "ab" }).rev).toBe(plain.rev)
  })

  test("a stale running row does not block send, delete, clear or rewind", async () => {
    const h = harness(scripted(async (_text, ctx) => ctx.emit({ type: "text", id: crypto.randomUUID(), text: "ok" })))
    const id = h.store.createSession({ agent: "s" }).id
    h.store.patchSession(id, { status: "running" })
    const sent = await h.service.invoke("message.send", { sessionId: id, text: "hi" }, "1")
    expect(sent.type).toBe("result")
    await waitFor(() => h.idle(id) >= 1)
    for (const method of ["session.rewind", "session.clear", "session.delete"]) {
      h.store.patchSession(id, { status: "running" })
      const frame = await h.service.invoke(method, { id, seq: 1 }, method)
      expect(frame.type).toBe("result")
    }
  })

  test("deleting a running session stops its turn first, then deletes", async () => {
    let aborted = false
    const h = harness(
      scripted(
        (_text, ctx) =>
          new Promise<void>((resolve) => {
            ctx.signal.addEventListener("abort", () => {
              aborted = true
              resolve()
            })
          }),
      ),
    )
    const id = h.store.createSession({ agent: "s" }).id
    await h.service.invoke("message.send", { sessionId: id, text: "long" }, "1")
    const frame = await h.service.invoke("session.delete", { id }, "d")
    expect(frame.type).toBe("result")
    expect(aborted).toBe(true)
    expect(h.store.getSession(id)).toBeNull()
  })

  test("shutdown aborts running turns and lets them settle", async () => {
    let aborted = false
    const h = harness(
      scripted(
        (_text, ctx) =>
          new Promise<void>((_resolve, reject) => {
            ctx.signal.addEventListener("abort", () => {
              aborted = true
              reject(new Error("aborted"))
            })
          }),
      ),
    )
    const id = h.store.createSession({ agent: "s" }).id
    await h.service.invoke("message.send", { sessionId: id, text: "long" }, "1")
    await h.service.shutdown(1000)
    expect(aborted).toBe(true)
    expect(h.idle(id)).toBe(1)
    expect(h.store.getSession(id)?.status).toBe("idle")
  })
})

describe("adapter callbacks after the turn ends", () => {
  test("late emit, askPermission and askQuestion are ignored", async () => {
    let captured: AdapterContext | undefined
    const h = harness(
      scripted(async (_text, ctx) => {
        captured = ctx
        ctx.emit({ type: "text", id: "t1", text: "hi" })
      }),
    )
    const id = h.store.createSession({ agent: "s" }).id
    await h.service.invoke("message.send", { sessionId: id, text: "go" }, "1")
    await waitFor(() => h.idle(id) >= 1)
    const rows = h.store.listMessages(id).length
    const frames = h.events.length
    captured!.emit({ type: "text", id: "t2", text: "late" })
    captured!.emit({ type: "status", status: "running" })
    const permission = await captured!.askPermission(RUN)
    const question = await captured!.askQuestion({ questions: [{ question: "Go?", options: [{ label: "Y" }], multiSelect: false, allowsOther: true }] })
    expect(permission).toBeNull()
    expect(question).toBeNull()
    expect(h.store.listMessages(id)).toHaveLength(rows)
    expect(h.events.length).toBe(frames)
    expect(h.store.getSession(id)?.status).toBe("idle")
  })

  test("an adapter status running does not overwrite waiting while a request is open", async () => {
    let release: () => void = () => {}
    const h = harness(
      scripted(async (_text, ctx) => {
        void ctx.askPermission(RUN)
        await Bun.sleep(5)
        ctx.emit({ type: "status", status: "running" })
        await new Promise<void>((resolve) => (release = resolve))
      }),
    )
    const id = h.store.createSession({ agent: "s" }).id
    await h.service.invoke("message.send", { sessionId: id, text: "go" }, "1")
    await waitFor(() => h.named("permission.asked").length > 0)
    await Bun.sleep(20)
    expect(h.store.getSession(id)?.status).toBe("waiting")
    const statuses = h.named("agent.status").map((event) => payload(event).status)
    expect(statuses.at(-1)).toBe("waiting")
    release()
    await waitFor(() => h.idle(id) >= 1)
  })

  test("an open request is settled before idle, so no upsert says idle with pending", async () => {
    const h = harness(
      scripted(async (_text, ctx) => {
        void ctx.askPermission(RUN)
        await Bun.sleep(5)
      }),
    )
    const id = h.store.createSession({ agent: "s" }).id
    await h.service.invoke("message.send", { sessionId: id, text: "go" }, "1")
    await waitFor(() => h.idle(id) >= 1)
    await Bun.sleep(10)
    const upserts = h.named("session.upsert").map(payload).filter((session) => session.id === id)
    expect(upserts.some((session) => session.status === "idle" && session.pending !== null)).toBe(false)
    expect(upserts.at(-1)).toMatchObject({ status: "idle", pending: null })
    expect(h.named("permission.resolved").map((event) => payload(event).cancelReason)).toEqual(["interrupted"])
  })
})

describe("streamed deltas are coalesced", () => {
  const appendsFor = (events: Frame[], id: string) =>
    events.filter((event) => event.name === "message.append" && payload(event).id === id).map(payload)

  test("a burst of text deltas is broadcast and stored a few times, ending with the full text", async () => {
    let full = ""
    const h = harness(
      scripted(async (_text, ctx) => {
        for (let i = 0; i < 2000; i++) {
          full += " word"
          ctx.emit({ type: "text", id: "t1", text: full })
        }
      }),
    )
    let writes = 0
    const insert = h.store.insertMessage.bind(h.store)
    h.store.insertMessage = (row) => {
      if (row.id === "t1") writes += 1
      return insert(row)
    }
    const id = h.store.createSession({ agent: "s" }).id
    await h.service.invoke("message.send", { sessionId: id, text: "go" }, "1")
    await waitFor(() => h.idle(id) >= 1)
    const appends = appendsFor(h.events, "t1")
    expect(appends.length).toBeLessThanOrEqual(3)
    expect(appends.at(-1)!.text).toBe(full)
    expect(writes).toBeLessThanOrEqual(3)
    expect(h.store.getMessage("t1")!.text).toBe(full)
  })

  test("slow deltas still stream mid-turn at no more than 10 Hz", async () => {
    const h = harness(
      scripted(async (_text, ctx) => {
        let text = ""
        for (let i = 0; i < 40; i++) {
          text += "x"
          ctx.emit({ type: "text", id: "t1", text })
          await Bun.sleep(10)
        }
      }),
    )
    const id = h.store.createSession({ agent: "s" }).id
    const started = Date.now()
    await h.service.invoke("message.send", { sessionId: id, text: "go" }, "1")
    await waitFor(() => h.idle(id) >= 1)
    const elapsed = Date.now() - started
    const appends = appendsFor(h.events, "t1")
    expect(appends.length).toBeGreaterThanOrEqual(3)
    expect(appends.length).toBeLessThanOrEqual(Math.ceil(elapsed / 100) + 2)
    expect(appends.at(-1)!.text).toBe("x".repeat(40))
  })

  test("a long reply is broadcast at 10 Hz but written back about every 2 s, and in full at the end", async () => {
    // Past the list preview from the first delta, so only the clock and the turn's end write it back.
    const opening = "y".repeat(400)
    const h = harness(
      scripted(async (_text, ctx) => {
        let text = opening
        for (let i = 0; i < 50; i++) {
          text += " word"
          ctx.emit({ type: "text", id: "t1", text })
          await Bun.sleep(30)
        }
      }),
    )
    let writes = 0
    const insert = h.store.insertMessage.bind(h.store)
    h.store.insertMessage = (row) => {
      if (row.id === "t1") writes += 1
      return insert(row)
    }
    const id = h.store.createSession({ agent: "s" }).id
    const started = Date.now()
    await h.service.invoke("message.send", { sessionId: id, text: "go" }, "1")
    await waitFor(() => h.idle(id) >= 1)
    const elapsed = Date.now() - started
    const sent = appendsFor(h.events, "t1").length + h.named("message.delta").length
    expect(sent).toBeGreaterThanOrEqual(10)
    // The first write (seq), one every 2 s, and the end.
    expect(writes).toBeLessThanOrEqual(Math.ceil(elapsed / 2000) + 2)
    expect(h.store.getMessage("t1")!.text).toBe(opening + " word".repeat(50))
    const seqs = new Set(appendsFor(h.events, "t1").map((message) => message.seq))
    expect(seqs).toEqual(new Set([h.store.getMessage("t1")!.seq]))
  })

  test("every rev a turn writes reaches the sockets in some message frame", async () => {
    // r64 sync: the phone moves its stored cursor only over revs it saw. A write-back with no frame (the persist
    // timer saving a block whose text already went out) left a hole the cursor could never pass.
    const h = harness(
      scripted(async (_text, ctx) => {
        let text = "w".repeat(400)
        for (let i = 0; i < 6; i++) {
          text += " word"
          ctx.emit({ type: "text", id: "t1", text })
          await Bun.sleep(30)
        }
        // Quiet past the write-back interval: the timer saves what the sockets already have.
        await Bun.sleep(2300)
        ctx.emit({ type: "text", id: "t2", text: "done" })
      }),
    )
    const id = h.store.createSession({ agent: "s" }).id
    await h.service.invoke("message.send", { sessionId: id, text: "go" }, "1")
    await waitFor(() => h.idle(id) >= 1, 5000)
    const seen = new Set(
      h.events
        .filter((event) => event.name?.startsWith("message.") && payload(event).sessionId === id)
        .map((event) => payload(event).rev as number),
    )
    const last = h.store.getSession(id)!.rev_counter ?? 0
    const missing = Array.from({ length: last }, (_, i) => i + 1).filter((rev) => !seen.has(rev))
    expect(missing).toEqual([])
  })

  test("in-flight write-backs take no rev and no session version; the block's end takes one, sent in a frame", async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const h = harness(
      scripted(async (_text, ctx) => {
        let text = "q".repeat(400)
        for (let i = 0; i < 45; i++) {
          text += " word"
          ctx.emit({ type: "text", id: "t1", text })
          await Bun.sleep(40)
        }
        await held
      }),
    )
    const id = h.store.createSession({ agent: "s" }).id
    await h.service.invoke("message.send", { sessionId: id, text: "go" }, "1")
    await waitFor(() => h.store.getMessage("t1") !== null)
    await Bun.sleep(20)
    const first = h.store.getMessage("t1")!
    const version = h.store.sessionVersion()
    const counter = h.store.getSession(id)!.rev_counter
    // Past the write-back interval while text keeps coming: the timer writes it back, quietly.
    await Bun.sleep(2400)
    const mid = h.store.getMessage("t1")!
    expect(mid.text.length).toBeGreaterThan(first.text.length)
    expect(mid.rev).toBe(first.rev)
    expect(h.store.getSession(id)!.rev_counter).toBe(counter)
    expect(h.store.sessionVersion()).toBe(version)
    release()
    await waitFor(() => h.idle(id) >= 1)
    const end = h.store.getMessage("t1")!
    expect(end.text).toBe("q".repeat(400) + " word".repeat(45))
    expect(end.rev!).toBeGreaterThan(first.rev!)
    expect(h.store.sessionVersion()).toBeGreaterThan(version)
    const revs = h.events.filter((event) => payload(event).id === "t1").map((event) => payload(event).rev)
    expect(revs).toContain(end.rev)
  })

  test("the write-back interval grows with the block past 16 K and stops at 30 s", () => {
    const block = (length: number) => ({ text: "x".repeat(length), dirty: true })
    expect(persistInterval([])).toBe(2000)
    expect(persistInterval([block(10_000)])).toBe(2000)
    expect(persistInterval([block(64 * 1024), block(10)])).toBe(8000)
    expect(persistInterval([{ ...block(64 * 1024), dirty: false }])).toBe(2000)
    expect(persistInterval([block(4 * 1024 * 1024)])).toBe(30_000)
  })

  test("a request in the middle of a reply reads what the sockets were already sent", async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const h = harness(
      scripted(async (_text, ctx) => {
        let text = "z".repeat(400)
        for (let i = 0; i < 5; i++) {
          text += " more"
          ctx.emit({ type: "text", id: "t1", text })
          await Bun.sleep(120)
        }
        await held
      }),
    )
    const id = h.store.createSession({ agent: "s" }).id
    await h.service.invoke("message.send", { sessionId: id, text: "go" }, "1")
    await waitFor(() => appendsFor(h.events, "t1").length + h.named("message.delta").length >= 5)
    await Bun.sleep(130)
    const stored = h.store.getMessage("t1")!.text
    expect(stored.length).toBeLessThan(400 + 5 * 5)
    const listed = await h.service.invoke("history.page", { sessionId: id, beforeSeq: 1_000_000 }, "2")
    const messages = (listed.result as { messages: { id: string; text: string }[] }).messages
    expect(messages.find((message) => message.id === "t1")?.text).toBe("z".repeat(400) + " more".repeat(5))
    release()
    await waitFor(() => h.idle(id) >= 1)
  })

  test("pending text is flushed before a tool card, keeping order", async () => {
    const h = harness(
      scripted(async (_text, ctx) => {
        ctx.emit({ type: "text", id: "t1", text: "a" })
        ctx.emit({ type: "text", id: "t1", text: "ab" })
        ctx.emit({ type: "tool", id: "tool1", tool: "Bash", title: "Run", kind: "execute", status: "pending", detail: "ls" })
        await Bun.sleep(150)
      }),
    )
    const id = h.store.createSession({ agent: "s" }).id
    await h.service.invoke("message.send", { sessionId: id, text: "go" }, "1")
    await waitFor(() => h.idle(id) >= 1)
    const appends = h.named("message.append").map(payload).filter((message) => message.id === "t1" || message.id === "tool1")
    const toolAt = appends.findIndex((message) => message.id === "tool1")
    expect(appends[toolAt - 1]).toMatchObject({ id: "t1", text: "ab" })
    expect(h.store.getMessage("t1")!.seq).toBeLessThan(h.store.getMessage("tool1")!.seq)
  })

  test("reasoning deltas keep timing in memory and close on done", async () => {
    const h = harness(
      scripted(async (_text, ctx) => {
        let text = ""
        for (let i = 0; i < 500; i++) {
          text += "r"
          ctx.emit({ type: "reasoning", id: "r1", text, done: false })
        }
        ctx.emit({ type: "reasoning", id: "r1", text, done: true })
        ctx.emit({ type: "text", id: "t1", text: "done" })
      }),
    )
    let lookups = 0
    const get = h.store.getMessage.bind(h.store)
    h.store.getMessage = (messageId) => {
      if (messageId === "r1") lookups += 1
      return get(messageId)
    }
    const id = h.store.createSession({ agent: "s" }).id
    await h.service.invoke("message.send", { sessionId: id, text: "go" }, "1")
    await waitFor(() => h.idle(id) >= 1)
    expect(lookups).toBeLessThanOrEqual(1)
    const appends = appendsFor(h.events, "r1")
    expect(appends.length).toBeLessThanOrEqual(3)
    const last = appends.at(-1)!
    expect(last.text).toBe("r".repeat(500))
    const reasoning = last.reasoning as { startedAt: number; endedAt?: number }
    expect(reasoning.endedAt).toBeGreaterThanOrEqual(reasoning.startedAt)
    expect((appends[0]!.reasoning as { startedAt: number }).startedAt).toBe(reasoning.startedAt)
  })
})

describe("message ids that belong to another session", () => {
  test("a streamed block reusing a foreign id is dropped without touching the other session", async () => {
    const h = harness(
      scripted(async (_text, ctx) => {
        ctx.emit({ type: "text", id: "shared", text: "hijack" })
        await Bun.sleep(5)
        ctx.emit({ type: "text", id: "shared", text: "hijack more" })
        await Bun.sleep(150)
        ctx.emit({ type: "text", id: "own", text: "fine" })
      }),
    )
    const victim = h.store.createSession({ agent: "s" }).id
    h.store.insertMessage({ id: "shared", session_id: victim, kind: "text", role: "assistant", text: "original", created_at: 1 })
    const id = h.store.createSession({ agent: "s" }).id
    await h.service.invoke("message.send", { sessionId: id, text: "go" }, "1")
    await waitFor(() => h.idle(id) >= 1)
    expect(h.store.getMessage("shared")).toMatchObject({ session_id: victim, text: "original" })
    expect(h.store.getMessage("own")?.text).toBe("fine")
  })
})

// Audit 2026-11-10 (P3): a db write that failed while the turn ended skipped the rest of the cleanup, and the session
// stayed generating (every send answered busy) until rudderd restarted.
describe("a failing db write at the end of a turn", () => {
  test("still ends the turn: the phone hears idle and the next send starts", async () => {
    let release = () => {}
    let runs = 0
    const h = harness(
      scripted(async (_text, ctx: AdapterContext) => {
        runs += 1
        if (runs > 1) return
        ctx.emit({ type: "text", id: crypto.randomUUID(), text: "partial reply" })
        await new Promise<void>((resolve) => {
          release = resolve
        })
      }),
    )
    const session = h.store.createSession({ agent: "s" })
    await h.service.invoke("message.send", { sessionId: session.id, text: "one" }, "1")
    await waitFor(() => runs === 1)
    const store = h.store as unknown as Record<string, unknown>
    const saved = { patchSession: store.patchSession, advanceTurn: store.advanceTurn }
    const broken = () => {
      throw new Error("SQLITE_FULL: database or disk is full")
    }
    Object.assign(store, { patchSession: broken, advanceTurn: broken })
    release()
    await waitFor(() => h.idle(session.id) > 0)
    Object.assign(store, saved)
    const second = await h.service.invoke("message.send", { sessionId: session.id, text: "two" }, "2")
    expect(second.error).toBeUndefined()
    await waitFor(() => runs === 2)
  })
})

// Review 2026-11-11 (P3): reading the reply for the done outcome threw out of the turn's cleanup, so the phone never
// heard idle and the queue never moved on.
describe("a failing read of the reply at the end of a turn", () => {
  test("still ends the turn: the phone hears idle and the next send starts", async () => {
    let release = () => {}
    let runs = 0
    const h = harness(
      scripted(async (_text, ctx: AdapterContext) => {
        runs += 1
        if (runs > 1) return
        ctx.emit({ type: "text", id: crypto.randomUUID(), text: "partial reply" })
        await new Promise<void>((resolve) => {
          release = resolve
        })
      }),
    )
    const session = h.store.createSession({ agent: "s" })
    await h.service.invoke("message.send", { sessionId: session.id, text: "one" }, "1")
    await waitFor(() => runs === 1)
    const store = h.store as unknown as Record<string, unknown>
    const saved = store.assistantTexts
    store.assistantTexts = () => {
      throw new Error("SQLITE_IOERR: disk I/O error")
    }
    release()
    await waitFor(() => h.idle(session.id) > 0)
    store.assistantTexts = saved
    const second = await h.service.invoke("message.send", { sessionId: session.id, text: "two" }, "2")
    expect(second.error).toBeUndefined()
    await waitFor(() => runs === 2)
  })
})
