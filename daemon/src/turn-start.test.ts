import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import { FAKE_SPEC } from "./adapter/fake"
import type { AgentAdapter, Availability } from "./adapter/types"
import { phoneCopy } from "./phone-copy"
import type { Frame } from "./protocol"
import { SessionService, type ServiceHooks } from "./session-service"
import { Store } from "./store"
import { snapshotTree } from "./turn-changes"

// What happens between `message.send` and the agent adapter's reply(): the agent probe and the working-tree
// snapshot. A slow probe (a cache past its TTL) and a slow snapshot (a big checkout) must not hold the turn back.

const DETECT_MS = 800
const SNAPSHOT_MS = 1000

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  dirs.push(dir)
  return dir
}

function sh(cwd: string, ...argv: string[]) {
  const proc = Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "pipe" })
  if (proc.exitCode !== 0) throw new Error(`${argv.join(" ")}: ${proc.stderr.toString()}`)
}

function repo() {
  const dir = tempDir("rudder-start-")
  sh(dir, "git", "init", "-q")
  sh(dir, "git", "config", "user.email", "t@example.com")
  sh(dir, "git", "config", "user.name", "t")
  writeFileSync(join(dir, "a.txt"), "one\n")
  sh(dir, "git", "add", "-A")
  sh(dir, "git", "commit", "-qm", "init")
  return dir
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out")
    await Bun.sleep(2)
  }
}

function harness(adapter: AgentAdapter, workspace: string, hooks: ServiceHooks = {}) {
  const events: Frame[] = []
  const store = new Store(":memory:")
  const service = new SessionService(store, adapter, (frame) => events.push(frame), { workspaceRoot: workspace, ...hooks })
  const idle = (id: string) =>
    events.filter((event) => {
      const payload = (event.payload ?? {}) as Record<string, unknown>
      return event.name === "agent.status" && payload.sessionId === id && payload.status === "idle"
    }).length
  async function send(sessionId: string, text = "go") {
    const frame = await service.invoke("message.send", { sessionId, text }, "message.send")
    if (frame.type !== "result") throw new Error(`message.send: ${JSON.stringify(frame.error)}`)
  }
  async function turn(sessionId: string) {
    const before = idle(sessionId)
    await send(sessionId)
    await waitFor(() => idle(sessionId) > before)
    // The changes are counted after idle (perf-1112 round two).
    await service.turnSettled(sessionId)
  }
  return { store, service, send, turn }
}

const slowDetect = (answer: () => Availability) => async () => {
  await Bun.sleep(DETECT_MS)
  return answer()
}

describe("turn start latency", () => {
  test("a probed agent and a slow snapshot do not delay reply()", async () => {
    const dir = tempDir("rudder-start-")
    mkdirSync(join(dir, ".git"))
    let repliedAt: number | undefined
    const adapter: AgentAdapter = {
      spec: { ...FAKE_SPEC, id: "s", label: "S" },
      // Every call waits, as a cache past its TTL does.
      detect: slowDetect(() => ({ available: true })),
      reply: async () => {
        repliedAt = Date.now()
      },
    }
    const slowSnapshot = async () => {
      await Bun.sleep(SNAPSHOT_MS)
      return null
    }
    const h = harness(adapter, dir, { snapshotTree: slowSnapshot })
    // Launch probes every agent once; turns then start from that answer.
    await h.service.refreshAgents()
    const id = h.store.createSession({ agent: "s", cwd: dir }).id
    const sentAt = Date.now()
    await h.send(id)
    await waitFor(() => repliedAt !== undefined)
    const latency = (repliedAt ?? 0) - sentAt
    console.log(`turn start latency: ${latency} ms (detect ${DETECT_MS} ms, snapshot ${SNAPSHOT_MS} ms)`)
    expect(latency).toBeLessThan(250)
  })

  test("an agent never probed is still awaited, and a missing one never starts", async () => {
    const dir = tempDir("rudder-start-")
    let replied = false
    const adapter: AgentAdapter = {
      spec: { ...FAKE_SPEC, id: "s", label: "S" },
      detect: slowDetect(() => ({ available: false, reason: "s not found" })),
      reply: async () => {
        replied = true
      },
    }
    const h = harness(adapter, dir)
    const id = h.store.createSession({ agent: "s", cwd: dir }).id
    await h.turn(id)
    expect(replied).toBe(false)
    const error = h.store.listMessages(id).find((row) => row.kind === "error")
    expect(error?.text).toBe(phoneCopy.agentUnavailable("S", "s not found").text)
  })

  test("an agent gone since its last probe fails with the same error as before", async () => {
    const dir = tempDir("rudder-start-")
    let installed = true
    const adapter: AgentAdapter = {
      spec: { ...FAKE_SPEC, id: "s", label: "S" },
      detect: slowDetect(() => (installed ? { available: true } : { available: false, reason: "s not found" })),
      reply: async () => {
        throw new Error("spawn s ENOENT")
      },
    }
    const h = harness(adapter, dir)
    await h.service.refreshAgents()
    installed = false
    const id = h.store.createSession({ agent: "s", cwd: dir }).id
    await h.turn(id)
    const errors = h.store.listMessages(id).filter((row) => row.kind === "error")
    expect(errors.map((row) => row.text)).toEqual([phoneCopy.agentUnavailable("S", "s not found").text])
  })
})

describe("the snapshot runs beside the agent", () => {
  const delayed = (ms: number): typeof snapshotTree => async (cwd, workspace) => {
    await Bun.sleep(ms)
    return snapshotTree(cwd, workspace)
  }
  const sourceOf = (h: ReturnType<typeof harness>, id: string) => {
    const turnId = (h.service as unknown as { publicSession(id: string): { turn: { id: string } } }).publicSession(id).turn.id
    return h.store.getTurnChanges(turnId)?.source
  }
  const editing = (waitMs: number): AgentAdapter => ({
    spec: { ...FAKE_SPEC, id: "s", label: "S" },
    reply: async (_text, ctx) => {
      await Bun.sleep(waitMs)
      const path = join(ctx.cwd, "a.txt")
      await ctx.emit({ type: "tool", id: "e", tool: "Edit", title: "Edit", kind: "edit", status: "running", detail: path })
      writeFileSync(path, "one\ntwo\n")
      await ctx.emit({
        type: "tool",
        id: "e",
        tool: "Edit",
        title: "Edit",
        kind: "edit",
        status: "completed",
        detail: path,
        diffs: [{ path, oldText: "one", newText: "one\ntwo" }],
      })
    },
  })

  test("a snapshot done before the first tool diffs the trees", async () => {
    const dir = repo()
    const h = harness(editing(400), dir, { snapshotTree: delayed(100) })
    const id = h.store.createSession({ agent: "s", cwd: dir }).id
    await h.turn(id)
    expect(sourceOf(h, id)).toBe("git")
  })

  test("a snapshot still running when the first tool arrives is dropped for the tools' own diffs", async () => {
    const dir = repo()
    const h = harness(editing(0), dir, { snapshotTree: delayed(400) })
    const id = h.store.createSession({ agent: "s", cwd: dir }).id
    await h.turn(id)
    expect(sourceOf(h, id)).toBe("tools")
  })
})

// perf-1112 round two: the turn's git work (end snapshot, diff, counts) ran before the phone heard idle and before a
// queued message could start. Now only the end snapshot keeps its place in the folder's queue.
describe("turn end before its git work", () => {
  function endHarness(dir: string, secondTurn: boolean) {
    let gate!: () => void
    const held = new Promise<void>((resolve) => {
      gate = resolve
    })
    const calls: { index: number; ran: number; done?: number }[] = []
    let tick = 0
    const snapshot: typeof snapshotTree = async (cwd, root) => {
      const call: { index: number; ran: number; done?: number } = { index: calls.length, ran: ++tick }
      calls.push(call)
      // The first turn's end snapshot is slow (a big checkout).
      if (call.index === 1) await held
      const taken = await snapshotTree(cwd, root)
      call.done = ++tick
      return taken
    }
    let replies = 0
    const adapter: AgentAdapter = {
      spec: { ...FAKE_SPEC, id: "s", label: "S" },
      reply: async (_text, ctx) => {
        replies += 1
        if (replies > 1) return
        // A real agent's first tool comes a model response after the start snapshot.
        await waitFor(() => calls[0]?.done !== undefined)
        await ctx.emit({ type: "tool", id: "sh", tool: "Bash", title: "sh", kind: "execute", status: "running", detail: "" })
        writeFileSync(join(ctx.cwd, "a.txt"), "one\ntwo\n")
        await ctx.emit({ type: "tool", id: "sh", tool: "Bash", title: "sh", kind: "execute", status: "completed", detail: "" })
        await ctx.emit({ type: "text", id: "r", text: "Done." })
      },
    }
    const pushes: { changes?: { files: number } }[] = []
    const events: Frame[] = []
    const store = new Store(":memory:")
    const service = new SessionService(store, adapter, (frame) => events.push(frame), {
      workspaceRoot: dir,
      snapshotTree: snapshot,
      push: (payload) => pushes.push(payload as { changes?: { files: number } }),
    })
    const id = store.createSession({ agent: "s", cwd: dir }).id
    const of = (name: string) => events.filter((event) => event.name === name).map((event) => event.payload as Record<string, unknown>)
    const run = async () => {
      await service.invoke("message.send", { sessionId: id, text: "go" }, "1")
      await waitFor(() => calls.length === 2)
      // Idle went out while the end snapshot is still held.
      await waitFor(() => of("agent.status").some((event) => event.sessionId === id && event.status === "idle"))
      expect(store.getSession(id)?.status).toBe("idle")
      if (secondTurn) {
        // A next message starts its turn at once.
        await service.invoke("message.send", { sessionId: id, text: "again" }, "2")
        await waitFor(() => replies === 2)
      }
      expect(pushes).toHaveLength(0)
      const before = events.length
      gate()
      await waitFor(() => pushes.length >= 1)
      await service.turnSettled(id)
      return events.slice(before)
    }
    const firstTurn = () => String((of("turn.state")[0]?.turn as { id?: string } | undefined)?.id)
    return { store, service, id, calls, pushes, of, run, firstTurn }
  }

  test("idle does not wait for the changes; the session and the notice carry them after", async () => {
    const h = endHarness(repo(), false)
    const after = await h.run()
    const upsert = after.find((event) => event.name === "session.upsert")?.payload as { lastTurn?: { changes?: { files: number } } }
    expect(upsert?.lastTurn?.changes?.files).toBe(1)
    expect(h.pushes[0]?.changes?.files).toBe(1)
  })

  test("a queued turn starts before the changes are counted; its start snapshot still runs after the end snapshot", async () => {
    const h = endHarness(repo(), true)
    await h.run()
    expect(h.calls[2]!.ran).toBeGreaterThan(h.calls[1]!.done!)
    expect(h.store.getTurnChanges(h.firstTurn())?.files.map((file) => file.path)).toEqual(["a.txt"])
    expect(h.pushes[0]?.changes?.files).toBe(1)
  })
})
