import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import { FAKE_SPEC } from "./adapter/fake"
import type { AdapterContext, AgentAdapter } from "./adapter/types"
import { copyError, phoneCopy } from "./phone-copy"
import type { Frame } from "./protocol"
import { SessionService } from "./session-service"
import { Store } from "./store"
import {
  countToolDiff,
  countTreeEdits,
  diffSnapshots,
  editsInTurn,
  parseRaw,
  restoreWorktree,
  SNAPSHOT_UNTRACKED_LIMIT,
  snapshotPatch,
  snapshotToRestore,
  snapshotTree,
} from "./turn-changes"

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
  return proc.stdout.toString()
}

function repo() {
  const dir = tempDir("rudder-turn-")
  sh(dir, "git", "init", "-q")
  sh(dir, "git", "config", "user.email", "t@example.com")
  sh(dir, "git", "config", "user.name", "t")
  writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\n")
  writeFileSync(join(dir, "c.txt"), "gone\n")
  writeFileSync(join(dir, ".gitignore"), "ignored/\n")
  sh(dir, "git", "add", "-A")
  sh(dir, "git", "commit", "-qm", "init")
  return dir
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out")
    await Bun.sleep(5)
  }
}

function payload(frame: Frame): Record<string, unknown> {
  return (frame.payload ?? {}) as Record<string, unknown>
}

// The service's own session view (what session.list / session.upsert carry).
function peek(service: SessionService, id: string): unknown {
  return (service as unknown as { publicSession(id: string): unknown }).publicSession(id)
}

// The writes run inside a shell tool of the turn, as an agent's do; only those count as the turn's changes.
async function shell(ctx: AdapterContext, write: () => void) {
  const id = crypto.randomUUID()
  await ctx.emit({ type: "tool", id, tool: "Bash", title: "sh", kind: "execute", status: "running", detail: "" })
  write()
  await ctx.emit({ type: "tool", id, tool: "Bash", title: "sh", kind: "execute", status: "completed", detail: "" })
}

// The turn's start snapshot runs beside the agent; a real agent's first tool comes a model response later. The fake
// reply waits for the snapshot instead, so these tests diff trees (turn-start.test.ts covers a late snapshot).
function harness(reply: AgentAdapter["reply"], workspace: string) {
  const events: Frame[] = []
  const store = new Store(":memory:")
  let taking: Promise<unknown> = Promise.resolve()
  const adapter: AgentAdapter = {
    spec: { ...FAKE_SPEC, id: "s", label: "s" },
    reply: async (text, ctx) => {
      await taking
      return reply(text, ctx)
    },
  }
  const service = new SessionService(store, adapter, (frame) => events.push(frame), {
    workspaceRoot: workspace,
    snapshotTree: (cwd, root) => {
      const taken = snapshotTree(cwd, root)
      taking = taken
      return taken
    },
  })
  const idle = (id: string) =>
    events.filter((event) => event.name === "agent.status" && payload(event).sessionId === id && payload(event).status === "idle").length
  async function call(method: string, params: Record<string, unknown>) {
    const frame = await service.invoke(method, params, method)
    if (frame.type !== "result") throw new Error(`${method}: ${JSON.stringify(frame.error)}`)
    return (frame.result ?? {}) as Record<string, unknown>
  }
  async function turn(sessionId: string, text = "go") {
    const before = idle(sessionId)
    await call("message.send", { sessionId, text })
    await waitFor(() => idle(sessionId) > before)
    // The changes are counted after idle (perf-1112 round two).
    await service.turnSettled(sessionId)
  }
  const pub = (id: string) => peek(service, id)
  return { store, events, service, call, turn, pub }
}

describe("edit count from the two recorded trees", () => {
  test("hunks between the snapshots, plus one for a binary file", async () => {
    const dir = repo()
    const before = await snapshotTree(dir, dir)
    writeFileSync(join(dir, "a.txt"), "one\nTWO\nthree\nfour\n")
    unlinkSync(join(dir, "c.txt"))
    writeFileSync(join(dir, "new.txt"), "fresh\n")
    writeFileSync(join(dir, "blob.bin"), Buffer.from([0, 1, 2, 3]))
    const after = await snapshotTree(dir, dir)
    if (!before || !after) throw new Error("snapshot")
    const files = await diffSnapshots(before, after)
    const edits = await countTreeEdits(before.top, before.tree, after.tree, files)
    const diff = sh(dir, "git", "diff", "--no-color", "--no-ext-diff", before.tree, after.tree)
    expect(edits).toBe(editsInTurn(diff, files))
    expect(edits).toBe(4)
  })
})

describe("turn.changes over git snapshots", () => {
  test("modified, deleted, new untracked and binary files; patch, current state", async () => {
    const dir = repo()
    const h = harness(async (_text, ctx) => {
      await shell(ctx, () => {
        writeFileSync(join(ctx.cwd, "a.txt"), "one\nTWO\nthree\nfour\n")
        unlinkSync(join(ctx.cwd, "c.txt"))
        writeFileSync(join(ctx.cwd, "new.txt"), "fresh\n")
        writeFileSync(join(ctx.cwd, "blob.bin"), Buffer.from([0, 1, 2, 3, 0, 255]))
        mkdirSync(join(ctx.cwd, "ignored"))
        writeFileSync(join(ctx.cwd, "ignored", "x.txt"), "skip\n")
      })
      await ctx.emit({ type: "text", id: "r", text: "done" })
    }, dir)
    // Something the user had changed before the turn is not counted.
    writeFileSync(join(dir, "c.txt"), "edited before\n")
    const id = h.store.createSession({ agent: "s", cwd: dir }).id
    await h.turn(id)

    const list = await h.call("session.list", {})
    const pub = (list.sessions as Record<string, unknown>[]).find((entry) => entry.id === id)!
    const lastTurn = pub.lastTurn as Record<string, unknown>
    expect(lastTurn.phase).toBe("done")
    expect(lastTurn.changes).toEqual({ files: 4, added: 3, removed: 2 })
    const turnId = (pub.turn as { id: string }).id

    const changes = await h.call("turn.changes", { sessionId: id, turnId })
    const files = changes.files as Record<string, unknown>[]
    const byPath = Object.fromEntries(files.map((file) => [file.path, file]))
    expect(Object.keys(byPath).sort()).toEqual(["a.txt", "blob.bin", "c.txt", "new.txt"])
    expect(byPath["a.txt"]).toMatchObject({ status: "M", added: 2, removed: 1, binary: false, current: "same" })
    expect(byPath["c.txt"]).toMatchObject({ status: "D", added: 0, removed: 1, current: "same" })
    expect(byPath["new.txt"]).toMatchObject({ status: "A", added: 1, removed: 0, bytes: 6 })
    expect(byPath["blob.bin"]).toMatchObject({ status: "A", binary: true, bytes: 6 })
    expect(byPath["a.txt"]).not.toHaveProperty("after")
    expect(changes.totals).toEqual({ files: 4, added: 3, removed: 2 })

    const summary = await h.call("turn.changes", { sessionId: id, turnId, summaryOnly: true })
    expect(summary.totals).toEqual(changes.totals)
    const summaryFiles = summary.files as Record<string, unknown>[]
    expect(summaryFiles.map((file) => file.path)).toEqual(files.map((file) => file.path))
    expect(summaryFiles.every((file) => file.current === undefined && file.changedAt === undefined)).toBe(true)

    const diff = await h.call("turn.diff", { sessionId: id, turnId, path: "a.txt" })
    expect(diff.truncated).toBe(false)
    expect(String(diff.patch)).toContain("-two\n+TWO")
    expect((await h.call("turn.diff", { sessionId: id, turnId, path: "blob.bin" })).binary).toBe(true)

    // Edited on the computer after the turn, then put back to how it was before.
    writeFileSync(join(dir, "a.txt"), "later\n")
    writeFileSync(join(dir, "new.txt"), "fresh\n")
    let again = Object.fromEntries(((await h.call("turn.changes", { sessionId: id, turnId })).files as Record<string, unknown>[]).map((file) => [file.path, file]))
    expect(again["a.txt"]?.current).toBe("changed")
    expect(typeof again["a.txt"]?.changedAt).toBe("number")
    expect(again["new.txt"]?.current).toBe("same")
    writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\n")
    unlinkSync(join(dir, "new.txt"))
    again = Object.fromEntries(((await h.call("turn.changes", { sessionId: id, turnId })).files as Record<string, unknown>[]).map((file) => [file.path, file]))
    expect(again["a.txt"]?.current).toBe("reverted")
    expect(again["new.txt"]?.current).toBe("reverted")
    // The patch is the turn's, not the file's present state. The snapshot is the turn-end blob, not the mutated worktree.
    const stayed = await h.call("turn.diff", { sessionId: id, turnId, path: "a.txt" })
    expect(String(stayed.patch)).toContain("+four")
    expect(String(stayed.snapshot)).toContain("TWO")
    expect(String(stayed.snapshot)).not.toContain("later")
    // The user's index is untouched.
    expect(sh(dir, "git", "diff", "--cached", "--name-only")).toBe("")
  })

  test("binary images carry both sizes and before / after previews from the snapshots (v57 B)", async () => {
    // Enough of a PNG for the magic check: signature, IHDR with the size, then filler.
    const png = (width: number, height: number, filler: number) => {
      const head = Buffer.alloc(24)
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head)
      head.writeUInt32BE(13, 8)
      head.write("IHDR", 12, "ascii")
      head.writeUInt32BE(width, 16)
      head.writeUInt32BE(height, 20)
      return Buffer.concat([head, Buffer.alloc(filler, 7)])
    }
    const dir = repo()
    writeFileSync(join(dir, "login.png"), png(390, 844, 100))
    writeFileSync(join(dir, "old.png"), png(10, 10, 20))
    writeFileSync(join(dir, "font.woff2"), Buffer.from([0, 1, 2, 3]))
    sh(dir, "git", "add", "-A")
    sh(dir, "git", "commit", "-qm", "images")
    const h = harness(async (_text, ctx) => {
      await shell(ctx, () => {
        writeFileSync(join(ctx.cwd, "login.png"), png(390, 844, 200))
        unlinkSync(join(ctx.cwd, "old.png"))
        writeFileSync(join(ctx.cwd, "new.png"), png(20, 20, 10))
        writeFileSync(join(ctx.cwd, "huge.png"), png(4000, 4000, 2 * 1024 * 1024))
        writeFileSync(join(ctx.cwd, "font.woff2"), Buffer.from([0, 1, 2, 3, 4, 5]))
      })
    }, dir)
    const id = h.store.createSession({ agent: "s", cwd: dir }).id
    await h.turn(id)
    const turnId = (h.pub(id) as { turn: { id: string } }).turn.id
    const files = (await h.call("turn.changes", { sessionId: id, turnId })).files as Record<string, unknown>[]
    const byPath = Object.fromEntries(files.map((file) => [file.path, file]))
    expect(byPath["login.png"]).toMatchObject({ status: "M", binary: true, oldBytes: 124, newBytes: 224, bytes: 224, preview: { before: true, after: true } })
    expect(byPath["new.png"]).toMatchObject({ status: "A", newBytes: 34, preview: { after: true } })
    expect(byPath["new.png"]).not.toHaveProperty("oldBytes")
    expect(byPath["old.png"]).toMatchObject({ status: "D", oldBytes: 44, preview: { before: true } })
    // Past 2 MB: sizes only. Not an image: no preview at all.
    expect(byPath["huge.png"]).not.toHaveProperty("preview")
    expect(byPath["font.woff2"]).toMatchObject({ oldBytes: 4, newBytes: 6 })
    expect(byPath["font.woff2"]).not.toHaveProperty("preview")

    const before = await h.service.readTurnPreview(id, turnId, "login.png", "before")
    const after = await h.service.readTurnPreview(id, turnId, "login.png", "after")
    expect(before?.mediaType).toBe("image/png")
    expect(before?.data.byteLength).toBe(124)
    expect(after?.data.byteLength).toBe(224)
    // The turn's picture, not the file's present state.
    writeFileSync(join(dir, "login.png"), png(1, 1, 1))
    expect((await h.service.readTurnPreview(id, turnId, "login.png", "after"))?.data.byteLength).toBe(224)
    expect(await h.service.readTurnPreview(id, turnId, "new.png", "before")).toBeNull()
    expect(await h.service.readTurnPreview(id, turnId, "huge.png", "after")).toBeNull()
    expect(await h.service.readTurnPreview(id, turnId, "login.png", "middle")).toBeNull()
    expect(await h.service.readTurnPreview("other", turnId, "login.png", "after")).toBeNull()
  })

  test("a diff over 64 KB is cut and marked; dot files are listed but not opened; unknown paths refused", async () => {
    const dir = repo()
    const h = harness(async (_text, ctx) => {
      await shell(ctx, () => {
        writeFileSync(join(ctx.cwd, "big.txt"), Array.from({ length: 20_000 }, (_, i) => `line ${i}`).join("\n"))
        writeFileSync(join(ctx.cwd, ".gitignore"), "ignored/\nmore/\n")
      })
    }, dir)
    const id = h.store.createSession({ agent: "s", cwd: dir }).id
    await h.turn(id)
    const turnId = (h.pub(id) as { turn: { id: string } }).turn.id
    const diff = await h.call("turn.diff", { sessionId: id, turnId, path: "big.txt" })
    expect(diff.truncated).toBe(true)
    expect(String(diff.patch).length).toBeLessThanOrEqual(64_000)
    expect(diff.bytes).toBeGreaterThan(64_000)
    const files = (await h.call("turn.changes", { sessionId: id, turnId })).files as { path: string }[]
    expect(files.map((file) => file.path).sort()).toEqual([".gitignore", "big.txt"])
    expect((await h.service.invoke("turn.diff", { sessionId: id, turnId, path: ".gitignore" }, "x")).type).toBe("error")
    expect((await h.service.invoke("turn.diff", { sessionId: id, turnId, path: "nope.txt" }, "x")).type).toBe("error")
  })

  test("a turn that changed nothing has no changes and no prefix", async () => {
    const dir = repo()
    const h = harness(async (_text, ctx) => ctx.emit({ type: "text", id: "r", text: "just talk" }), dir)
    const id = h.store.createSession({ agent: "s", cwd: dir }).id
    await h.turn(id)
    const pub = h.pub(id) as { lastTurn: Record<string, unknown>; turn: { id: string } }
    expect(pub.lastTurn.phase).toBe("done")
    expect(pub.lastTurn.changes).toBeUndefined()
    expect((await h.call("turn.changes", { sessionId: id, turnId: pub.turn.id })).files).toEqual([])
  })
})

// Only what this turn's tools did counts: another session, another agent outside Rudder, the editor or a git merge
// can write in the same checkout while the turn runs.
describe("turn.changes keeps only this turn's own files", () => {
  // Written while none of this turn's tools ran: the mtime is put a minute back, outside every tool window.
  const outside = (path: string, text: string) => {
    writeFileSync(path, text)
    const then = new Date(Date.now() - 60_000)
    utimesSync(path, then, then)
  }
  const files = async (h: ReturnType<typeof harness>, id: string) => {
    const pub = h.pub(id) as { lastTurn: Record<string, unknown>; turn: { id: string } }
    if (!pub.lastTurn.changes) return []
    const changes = await h.call("turn.changes", { sessionId: id, turnId: pub.turn.id })
    return (changes.files as { path: string }[]).map((file) => file.path).sort()
  }

  test("a file written while no tool of the turn ran is left out", async () => {
    const dir = repo()
    const h = harness(async (_text, ctx) => {
      outside(join(ctx.cwd, "merged.txt"), "from another session\n")
      await ctx.emit({ type: "tool", id: "ls", tool: "Bash", title: "ls", kind: "execute", status: "running", detail: "" })
      await ctx.emit({ type: "tool", id: "ls", tool: "Bash", title: "ls", kind: "execute", status: "completed", detail: "" })
      await ctx.emit({ type: "text", id: "r", text: "done" })
    }, dir)
    const id = h.store.createSession({ agent: "s", cwd: dir }).id
    await h.turn(id)
    expect((h.pub(id) as { lastTurn: Record<string, unknown> }).lastTurn.changes).toBeUndefined()
  })

  test("a file this turn's edit tool named is kept, whatever its mtime; an outside delete is not", async () => {
    const dir = repo()
    const h = harness(async (_text, ctx) => {
      const path = join(ctx.cwd, "a.txt")
      await ctx.emit({ type: "tool", id: "e", tool: "Edit", title: "Edit", kind: "edit", status: "running", detail: path })
      outside(path, "one\nTWO\nthree\n")
      outside(join(ctx.cwd, "other.txt"), "x\n")
      unlinkSync(join(ctx.cwd, "c.txt"))
      await ctx.emit({ type: "tool", id: "e", tool: "Edit", title: "Edit", kind: "edit", status: "completed", detail: path, diffs: [{ path, oldText: "two", newText: "TWO" }] })
    }, dir)
    const id = h.store.createSession({ agent: "s", cwd: dir }).id
    await h.turn(id)
    expect(await files(h, id)).toEqual(["a.txt"])
    expect((h.pub(id) as { lastTurn: Record<string, unknown> }).lastTurn.changes).toEqual({ files: 1, added: 1, removed: 1 })
    const turnId = (h.pub(id) as { turn: { id: string } }).turn.id
    expect(h.store.getTurnChanges(turnId)?.edits).toBe(1)
  })

  test("a file the turn's shell command wrote is kept without being named", async () => {
    const dir = repo()
    const h = harness(async (_text, ctx) => {
      outside(join(ctx.cwd, "editor.txt"), "saved in the editor\n")
      await ctx.emit({ type: "tool", id: "b", tool: "Bash", title: "bun run build", kind: "execute", status: "running", detail: "" })
      writeFileSync(join(ctx.cwd, "built.txt"), "out\n")
      await ctx.emit({ type: "tool", id: "b", tool: "Bash", title: "bun run build", kind: "execute", status: "completed", detail: "" })
    }, dir)
    const id = h.store.createSession({ agent: "s", cwd: dir }).id
    await h.turn(id)
    expect(await files(h, id)).toEqual(["built.txt"])
  })

  test("two sessions in one repository each get only their own file", async () => {
    const dir = repo()
    const written = new Set<string>()
    const done = new Set<string>()
    const h = harness(async (_text, ctx) => {
      const name = ctx.sessionId === first ? "a.txt" : "b.txt"
      const path = join(ctx.cwd, name)
      await ctx.emit({ type: "tool", id: `e-${name}`, tool: "Edit", title: "Edit", kind: "edit", status: "running", detail: "" })
      writeFileSync(path, `${name}\n`)
      written.add(name)
      // Both tools are open while both files are written, so the mtimes cannot tell them apart.
      await waitFor(() => written.size === 2)
      await ctx.emit({ type: "tool", id: `e-${name}`, tool: "Edit", title: "Edit", kind: "edit", status: "completed", detail: "", diffs: [{ path, newText: `${name}\n` }] })
      done.add(name)
      await waitFor(() => done.size === 2)
    }, dir)
    const first = h.store.createSession({ agent: "s", cwd: dir }).id
    const second = h.store.createSession({ agent: "s", cwd: dir }).id
    await Promise.all([h.turn(first), h.turn(second)])
    expect(await files(h, first)).toEqual(["a.txt"])
    expect(await files(h, second)).toEqual(["b.txt"])
  })
})

describe("rewind restores the folder", () => {
  test("a removed turn's files go back to its start, and ignored files stay", async () => {
    const dir = repo()
    const h = harness(async (_text, ctx) => {
      await shell(ctx, () => {
        writeFileSync(join(ctx.cwd, "a.txt"), "changed\n")
        writeFileSync(join(ctx.cwd, "new.txt"), "fresh\n")
        unlinkSync(join(ctx.cwd, "c.txt"))
        mkdirSync(join(ctx.cwd, "ignored"))
        writeFileSync(join(ctx.cwd, "ignored", "x.txt"), "skip\n")
      })
      await ctx.emit({ type: "text", id: crypto.randomUUID(), text: "done" })
    }, dir)
    const id = h.store.createSession({ agent: "s", cwd: dir }).id
    await h.turn(id)
    writeFileSync(join(dir, "later.txt"), "after\n")
    const result = await h.call("session.rewind", { id, seq: 1 })
    expect(result.files).toBe("restored")
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("one\ntwo\nthree\n")
    expect(existsSync(join(dir, "c.txt"))).toBe(true)
    expect(existsSync(join(dir, "new.txt"))).toBe(false)
    expect(existsSync(join(dir, "later.txt"))).toBe(false)
    expect(readFileSync(join(dir, "ignored", "x.txt"), "utf8")).toBe("skip\n")
  })

  test("an earlier turn's files stay when a later turn is the one removed", async () => {
    const dir = repo()
    let n = 0
    const h = harness(async (_text, ctx) => {
      n += 1
      await shell(ctx, () => writeFileSync(join(ctx.cwd, "a.txt"), n === 1 ? "first\n" : "second\n"))
      await ctx.emit({ type: "text", id: crypto.randomUUID(), text: "done" })
    }, dir)
    const id = h.store.createSession({ agent: "s", cwd: dir }).id
    await h.turn(id, "one")
    await h.turn(id, "two")
    const firstReply = h.store.listMessages(id).find((message) => message.role === "assistant")
    const result = await h.call("session.rewind", { id, seq: firstReply!.seq })
    expect(result.files).toBe("restored")
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("first\n")
  })

  test("snapshot and rewind run none of the repository's own filter commands", async () => {
    const dir = repo()
    writeFileSync(join(dir, ".git", "info", "attributes"), "*.txt filter=evil\n")
    for (const key of ["clean", "smudge", "process"]) {
      Bun.spawnSync(["git", "-C", dir, "config", `filter.evil.${key}`, `touch ${join(dir, key.toUpperCase())}; cat`])
    }
    const h = harness(async (_text, ctx) => {
      await shell(ctx, () => writeFileSync(join(ctx.cwd, "a.txt"), "changed\n"))
      await ctx.emit({ type: "text", id: crypto.randomUUID(), text: "done" })
    }, dir)
    const id = h.store.createSession({ agent: "s", cwd: dir }).id
    await h.turn(id)
    expect((await h.call("session.rewind", { id, seq: 1 })).files).toBe("restored")
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("one\ntwo\nthree\n")
    for (const marker of ["CLEAN", "SMUDGE", "PROCESS"]) expect(existsSync(join(dir, marker))).toBe(false)
  })

  test("snapshot and restore run no filter driver with an empty name", async () => {
    const dir = repo()
    // Outside the repository: the restore's `git clean` would remove markers left inside it.
    const markers = tempDir("rudder-markers-")
    writeFileSync(join(dir, ".git", "info", "attributes"), "*.txt filter=\n")
    for (const key of ["clean", "smudge"]) sh(dir, "git", "config", `filter..${key}`, `touch ${join(markers, key.toUpperCase())}; cat`)
    writeFileSync(join(dir, "a.txt"), "changed\n")
    const snapshot = await snapshotTree(dir, dir)
    expect(snapshot).not.toBeNull()
    writeFileSync(join(dir, "a.txt"), "again\n")
    expect(await restoreWorktree(dir, snapshot!.tree, dir)).toBe(true)
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("changed\n")
    for (const marker of ["CLEAN", "SMUDGE"]) expect(existsSync(join(markers, marker))).toBe(false)
  })

  // perf-1112 round two: a 300 MB untracked file took 4.9 s to hash into each snapshot and grew .git by 288 MB.
  test("an untracked file over 2 MB stays out of the snapshots: the turn is approx, a rewind keeps the file", async () => {
    const dir = repo()
    const big = join(dir, "data", "dump*.bin")
    mkdirSync(join(dir, "data"))
    const h = harness(async (_text, ctx) => {
      await shell(ctx, () => {
        writeFileSync(join(ctx.cwd, "a.txt"), "changed\n")
        writeFileSync(big, Buffer.alloc(SNAPSHOT_UNTRACKED_LIMIT + 1))
      })
      await ctx.emit({ type: "text", id: crypto.randomUUID(), text: "done" })
    }, dir)
    const objects = () => {
      const counted = Bun.spawnSync(["git", "-C", dir, "count-objects", "-v"]).stdout.toString()
      return Number(/^size: (\d+)/m.exec(counted)?.[1] ?? 0) + Number(/^size-pack: (\d+)/m.exec(counted)?.[1] ?? 0)
    }
    const before = objects()
    const id = h.store.createSession({ agent: "s", cwd: dir }).id
    await h.turn(id)
    const turnId = (h.pub(id) as { turn: { id: string } }).turn.id
    const changes = await h.call("turn.changes", { sessionId: id, turnId })
    // Listed by size only (no blob to diff), and the turn's counts are marked estimated.
    const files = Object.fromEntries((changes.files as { path: string }[]).map((file) => [file.path, file]))
    expect(Object.keys(files).sort()).toEqual(["a.txt", "data/dump*.bin"])
    expect(files["data/dump*.bin"]).toMatchObject({ status: "A", binary: true, bytes: SNAPSHOT_UNTRACKED_LIMIT + 1 })
    expect(changes.approx).toBe(true)
    // In KiB: well under the file's 2 MB.
    expect(objects() - before).toBeLessThan(64)
    expect((await h.call("session.rewind", { id, seq: 1 })).files).toBe("restored")
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("one\ntwo\nthree\n")
    expect(existsSync(big)).toBe(true)
  })

  test("a turn without a snapshot leaves the files where they are", () => {
    expect(snapshotToRestore([{ source: "tools", files: [{}] } as never])).toBeNull()
    expect(snapshotToRestore([])).toBeNull()
  })
})

// Third review: with the workspace reached through a symlink, the recorded root is git's real path and every
// single-file turn diff failed as outside the workspace.
describe("turn diffs with the workspace path through a symlink", () => {
  test("a file's patch is sent", async () => {
    const dir = repo()
    const base = tempDir("rudder-turn-link-")
    const link = join(base, "link")
    symlinkSync(dir, link)
    const before = await snapshotTree(link, link)
    writeFileSync(join(dir, "a.txt"), "one\nTWO\nthree\n")
    const after = await snapshotTree(link, link)
    const files = await diffSnapshots(before!, after!)
    const changes = {
      turnId: "t", sessionId: "s", source: "git" as const, root: before!.root, base: before!.tree, head: after!.tree,
      startedAt: 0, endedAt: 1, files, approx: false, edits: 1,
    }
    const patch = await snapshotPatch(changes, "a.txt", link)
    expect((patch as { patch?: string }).patch).toContain("+TWO")
  })
})

describe("turn.changes outside git", () => {
  test("sums the turn's completed edit tool diffs", async () => {
    const dir = tempDir("rudder-plain-")
    const h = harness(async (_text, ctx) => {
      const edit = (id: string, status: "completed" | "declined", diffs: { path: string; oldText?: string; newText?: string; patch?: string }[]) =>
        ctx.emit({ type: "tool", id, tool: "Edit", title: "Edit", kind: "edit", status, detail: "", diffs })
      await edit("t1", "completed", [{ path: join(ctx.cwd, "x.ts"), oldText: "a\nb\nc", newText: "a\nB\nc\nd" }])
      await edit("t2", "completed", [{ path: join(ctx.cwd, "y.ts"), patch: "@@ -1 +1,2 @@\n-old\n+new\n+more" }])
      await edit("t3", "declined", [{ path: join(ctx.cwd, "z.ts"), oldText: "", newText: "no" }])
    }, dir)
    const id = h.store.createSession({ agent: "s", cwd: dir }).id
    await h.turn(id)
    const pub = h.pub(id) as { lastTurn: Record<string, unknown>; turn: { id: string } }
    expect(pub.lastTurn.changes).toEqual({ files: 2, added: 4, removed: 2 })
    const changes = await h.call("turn.changes", { sessionId: id, turnId: pub.turn.id })
    expect((changes.files as { path: string }[]).map((file) => file.path)).toEqual(["x.ts", "y.ts"])
    const diff = await h.call("turn.diff", { sessionId: id, turnId: pub.turn.id, path: "x.ts" })
    expect((diff.diffs as { newText: string }[])[0]?.newText).toBe("a\nB\nc\nd")
  })
})

describe("session.lastTurn", () => {
  test("the last tool failing fails the turn with its title and exit code", async () => {
    const dir = tempDir("rudder-last-")
    const h = harness(async (_text, ctx: AdapterContext) => {
      await ctx.emit({ type: "tool", id: "ok", tool: "Bash", title: "bun install", kind: "execute", status: "completed", detail: "" })
      await ctx.emit({ type: "tool", id: "bad", tool: "Bash", title: "bun test\nmore", kind: "execute", status: "running", detail: "" })
      await ctx.emit({ type: "tool", id: "bad", tool: "Bash", title: "bun test\nmore", kind: "execute", status: "failed", detail: "", exitCode: 2 })
      await ctx.emit({ type: "text", id: "r", text: "tests fail" })
    }, dir)
    const id = h.store.createSession({ agent: "s", cwd: dir }).id
    await h.turn(id)
    const pub = h.pub(id) as { lastTurn: Record<string, unknown> }
    expect(pub.lastTurn).toMatchObject({ phase: "failed", reason: "bun test", exitCode: 2, toolId: "bad" })
    expect(typeof pub.lastTurn.endedAt).toBe("number")
    // Persisted: a fresh service over the same store reads it back.
    const again = new SessionService(h.store, { spec: FAKE_SPEC, reply: async () => {} }, () => {})
    expect((peek(again, id) as { lastTurn: Record<string, unknown> }).lastTurn.phase).toBe("failed")
  })

  // Third review: a failure rudderd words (agent signed out, …) reached the session list only as its Chinese text.
  test("a failure rudderd words carries its copy as lastResultCopy, kept across a restart", async () => {
    const dir = tempDir("rudder-last-copy-")
    const copy = phoneCopy.claudeSignedOut()
    const h = harness(async () => {
      throw copyError(copy)
    }, dir)
    const id = h.store.createSession({ agent: "s", cwd: dir }).id
    await h.turn(id)
    const pub = h.pub(id) as { lastTurn: Record<string, unknown>; lastResultCopy?: unknown }
    expect(pub.lastTurn).toMatchObject({ phase: "failed", reason: copy.text })
    expect(pub.lastTurn).not.toHaveProperty("reasonCopy")
    expect(pub.lastResultCopy).toEqual(copy)
    const again = new SessionService(h.store, { spec: FAKE_SPEC, reply: async () => {} }, () => {})
    expect((peek(again, id) as { lastResultCopy?: unknown }).lastResultCopy).toEqual(copy)
  })

  test("a failure in the agent's own words sends no lastResultCopy", async () => {
    const dir = tempDir("rudder-last-plain-")
    const h = harness(async () => {
      throw new Error("quota exhausted")
    }, dir)
    const id = h.store.createSession({ agent: "s", cwd: dir }).id
    await h.turn(id)
    expect(h.pub(id) as Record<string, unknown>).not.toHaveProperty("lastResultCopy")
  })

  test("an agent error fails with the error's first line; a stop is interrupted; a new turn hides the old result", async () => {
    const dir = tempDir("rudder-last-")
    let mode: "throw" | "hang" | "ok" = "throw"
    const h = harness(async (_text, ctx) => {
      if (mode === "throw") throw new Error("quota exhausted\nretry later")
      if (mode === "hang") {
        await new Promise<void>((resolve) => {
          if (ctx.signal.aborted) resolve()
          ctx.signal.addEventListener("abort", () => resolve())
        })
        throw new Error("aborted")
      }
      await ctx.emit({ type: "text", id: "r", text: "fine" })
    }, dir)
    const id = h.store.createSession({ agent: "s", cwd: dir }).id
    await h.turn(id)
    expect((h.pub(id) as { lastTurn: Record<string, unknown> }).lastTurn).toMatchObject({ phase: "failed", reason: "quota exhausted" })
    expect((h.pub(id) as { lastTurn: { toolId?: string } }).lastTurn.toolId).toBeUndefined()

    mode = "hang"
    await h.call("message.send", { sessionId: id, text: "again" })
    await waitFor(() => (h.pub(id) as { status: string }).status === "running")
    expect((h.pub(id) as { lastTurn?: unknown }).lastTurn).toBeUndefined()
    await h.call("message.steer", { sessionId: id, action: "cancel" })
    await waitFor(() => (h.pub(id) as { lastTurn?: { phase: string } }).lastTurn?.phase === "interrupted")
  })
})

describe("helpers", () => {
  test("parseRaw reads statuses and blob ids", () => {
    const zero = "0".repeat(40)
    const a = "a".repeat(40)
    const b = "b".repeat(40)
    const out = `:100644 100644 ${a} ${b} M\0x.ts\0:000000 100644 ${zero} ${b} A\0new\tname\0:100644 000000 ${a} ${zero} D\0old\0`
    expect(parseRaw(out)).toEqual([
      { path: "x.ts", status: "M", before: a, after: b },
      { path: "new\tname", status: "A", after: b },
      { path: "old", status: "D", before: a },
    ])
  })

  test("countToolDiff counts patches and line changes", async () => {
    expect(await countToolDiff({ path: "p", patch: "--- a\n+++ b\n@@\n-x\n+y\n+z" })).toEqual({ added: 2, removed: 1 })
    expect(await countToolDiff({ path: "p", oldText: "a\nb", newText: "a\nc\nb" })).toEqual({ added: 1, removed: 0 })
    expect(await countToolDiff({ path: "p", newText: "a\nb" })).toEqual({ added: 2, removed: 0 })
  })
  test("a large fallback diff yields while preserving repeated-line counts", async () => {
    const before = Array.from({ length: 2_000 }, (_, n) => n % 2 ? "B" : "A").join("\n")
    const after = Array.from({ length: 2_000 }, (_, n) => n % 2 ? "A" : "B").join("\n")
    let timerRan = false
    const tick = new Promise<void>((resolve) => setImmediate(() => { timerRan = true; resolve() }))
    const count = await countToolDiff({ path: "p", oldText: before, newText: after })
    const yielded = timerRan
    await tick
    expect(yielded).toBe(true)
    expect(count).toEqual({ added: 1, removed: 1 })
  })

})
