import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveInside } from "./file-service"
import { gitDiff, gitStatus, isProtectedPath, listDir, openRegular, protectedRoots, parseNumstat, parseStatusV2, readWorkspaceFile, resolveSafe, searchFiles, spawnCapped } from "./workspace"

function run(cwd: string, ...args: string[]) {
  const proc = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" })
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`)
  return proc.stdout.toString()
}

describe("git parsing", () => {
  test("porcelain v2 branch headers, renames, conflicts, untracked", () => {
    const out = [
      "# branch.oid 1234567890abcdef",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +2 -1",
      "1 .M N... 100644 100644 100644 aaa bbb src/a file.ts",
      "1 A. N... 000000 100644 100644 000 ccc new.ts",
      "1 D. N... 100644 000000 000000 ddd 000 gone.ts",
      "2 R. N... 100644 100644 100644 eee eee R100 renamed.ts",
      "old.ts",
      "u UU N... 100644 100644 100644 100644 f1 f2 f3 both.ts",
      "? scratch/",
      "",
    ].join("\0")
    const parsed = parseStatusV2(out)
    expect(parsed).toMatchObject({ branch: "main", oid: "1234567890abcdef", upstream: "origin/main", ahead: 2, behind: 1 })
    expect(parsed.files.map((f) => [f.path, f.status])).toEqual([
      ["src/a file.ts", "M"],
      ["new.ts", "A"],
      ["gone.ts", "D"],
      ["renamed.ts", "R"],
      ["both.ts", "U"],
      ["scratch/", "?"],
    ])
    expect(parsed.files[3]?.origPath).toBe("old.ts")
    expect(parsed.files[0]).toMatchObject({ index: ".", worktree: "M" })
  })

  test("detached head and initial commit", () => {
    const parsed = parseStatusV2("# branch.oid (initial)\0# branch.head (detached)\0")
    expect(parsed).toMatchObject({ branch: null, oid: null, upstream: null, ahead: 0, behind: 0, files: [] })
  })

  test("numstat counts and binary files", () => {
    const counts = parseNumstat("24\t6\tios/a.swift\0-\t-\tlogo.png\0")
    expect(counts.get("ios/a.swift")).toEqual({ added: 24, removed: 6 })
    expect(counts.get("logo.png")).toEqual({ binary: true })
  })
})

describe("git against a real repository", () => {
  let root = ""

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "rudder-git-")))
    run(root, "init", "-q", "-b", "main")
    run(root, "config", "user.email", "t@example.com")
    run(root, "config", "user.name", "t")
    mkdirSync(join(root, "src"))
    writeFileSync(join(root, "src", "keep.ts"), "one\ntwo\nthree\n")
    writeFileSync(join(root, "gone.md"), "bye\n")
    run(root, "add", ".")
    run(root, "commit", "-q", "-m", "init")
    writeFileSync(join(root, "src", "keep.ts"), "one\n2\nthree\nfour\n")
    rmSync(join(root, "gone.md"))
    writeFileSync(join(root, "added.ts"), "a\nb\n")
    run(root, "add", "added.ts")
    writeFileSync(join(root, "note.txt"), "x\ny\nz\n")
  })

  afterAll(() => rmSync(root, { recursive: true, force: true }))

  test("status keeps text and adds branch plus per-file counts", async () => {
    const status = await gitStatus("src", root)
    expect(status.text).toContain("## main")
    expect(status.root).toBe(root)
    expect(status.branch).toBe("main")
    expect(status.upstream).toBeNull()
    const byPath = Object.fromEntries(status.files.map((f) => [f.path, f]))
    expect(byPath["src/keep.ts"]).toMatchObject({ status: "M", added: 2, removed: 1 })
    expect(byPath["gone.md"]).toMatchObject({ status: "D", added: 0, removed: 1 })
    expect(byPath["added.ts"]).toMatchObject({ status: "A", added: 2, removed: 0 })
    expect(byPath["note.txt"]?.status).toBe("?")
    expect(byPath["note.txt"]?.added).toBeUndefined()
  })

  test("diff keeps the stat text and returns one file's patch", async () => {
    const stat = await gitDiff(".", undefined, root)
    expect(stat.text).toContain("keep.ts")
    const tracked = await gitDiff("src", "src/keep.ts", root)
    expect(tracked.patch).toContain("@@")
    expect(tracked.patch).toContain("+four")
    expect(tracked.truncated).toBe(false)
    const untracked = await gitDiff(".", "note.txt", root)
    expect(untracked.untracked).toBe(true)
    expect(untracked.patch).toContain("+z")
  })

  test("output past the cap stops the process instead of being read whole", async () => {
    // `yes` never ends on its own: an uncapped read would never return.
    const out = await spawnCapped(["yes", "line"], 10_000)
    expect(out.truncated).toBe(true)
    expect(Buffer.byteLength(out.stdout)).toBeLessThanOrEqual(10_000)
    const small = await spawnCapped(["printf", "ok"], 10_000)
    expect(small).toEqual({ stdout: "ok", stderr: "", code: 0, truncated: false })
  })

  test("a patch over 64 KB comes back cut at the limit with truncated", async () => {
    writeFileSync(join(root, "big.txt"), "z\n".repeat(200_000))
    const big = await gitDiff(".", "big.txt", root)
    expect(big.truncated).toBe(true)
    expect(Buffer.byteLength(big.patch ?? "")).toBeLessThanOrEqual(64_000)
    expect(big.patch?.startsWith("diff --git")).toBe(true)
    rmSync(join(root, "big.txt"))
  })

  test("diff refuses a file outside the workspace", async () => {
    await expect(gitDiff(".", "../etc/passwd", root)).rejects.toMatchObject({ code: "forbidden" })
  })

  test("outside a repository the error says so", async () => {
    const plain = realpathSync(mkdtempSync(join(tmpdir(), "rudder-plain-")))
    await expect(gitStatus(".", plain)).rejects.toMatchObject({ code: "git" })
    rmSync(plain, { recursive: true, force: true })
  })

  test("read flags binary files", async () => {
    writeFileSync(join(root, "blob.bin"), Buffer.from([0x50, 0x00, 0x01]))
    const read = await readWorkspaceFile(join(root, "blob.bin"), 32_000, root)
    expect(read.binary).toBe(true)
    expect(read.text).toBe("")
  })
})

// Audit 2026-11-10 (P3): a cloned repository's own config ran commands on every fs.git status / diff.
describe("git in a repository with hostile config", () => {
  let root = ""

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "rudder-git-hostile-")))
    run(root, "init", "-q", "-b", "main")
    run(root, "config", "user.email", "t@example.com")
    run(root, "config", "user.name", "t")
    writeFileSync(join(root, "f.txt"), "a\n")
    run(root, "add", ".")
    run(root, "commit", "-q", "-m", "init")
    writeFileSync(join(root, "f.txt"), "b\n")
    writeFileSync(join(root, ".gitattributes"), "f.txt diff=evil\n")
    run(root, "config", "core.fsmonitor", `touch ${join(root, "FSMONITOR")}; false`)
    run(root, "config", "diff.external", `touch ${join(root, "EXTERNAL")}`)
    run(root, "config", "diff.evil.textconv", `touch ${join(root, "TEXTCONV")}; cat`)
    writeFileSync(join(root, ".git", "info", "attributes"), "f.txt filter=evil\n")
    run(root, "config", "filter.evil.clean", `touch ${join(root, "CLEAN")}; cat`)
    run(root, "config", "filter.evil.smudge", `touch ${join(root, "SMUDGE")}; cat`)
    run(root, "config", "filter.evil.process", `touch ${join(root, "PROCESS")}; cat`)
    run(root, "config", "filter.evil.required", "true")
  })

  afterAll(() => rmSync(root, { recursive: true, force: true }))

  test("status and diff run none of the repository's fsmonitor, external diff, textconv or filter commands", async () => {
    await gitStatus(".", root)
    expect((await gitDiff(".", "f.txt", root)).patch).toContain("+b")
    await gitDiff(".", undefined, root)
    for (const marker of ["FSMONITOR", "EXTERNAL", "TEXTCONV", "CLEAN", "SMUDGE", "PROCESS"]) expect(existsSync(join(root, marker))).toBe(false)
  })

  test("a filter driver with an empty name is overridden too", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "rudder-git-empty-filter-")))
    try {
      run(dir, "init", "-q", "-b", "main")
      run(dir, "config", "user.email", "t@example.com")
      run(dir, "config", "user.name", "t")
      writeFileSync(join(dir, "f.txt"), "a\n")
      run(dir, "add", ".")
      run(dir, "commit", "-q", "-m", "init")
      writeFileSync(join(dir, "f.txt"), "b\n")
      writeFileSync(join(dir, ".git", "info", "attributes"), "f.txt filter=\n")
      run(dir, "config", "filter..clean", `touch ${join(dir, "CLEAN")}; cat`)
      await gitStatus(".", dir)
      await gitDiff(".", "f.txt", dir)
      expect(existsSync(join(dir, "CLEAN"))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a repository claiming to be a partial clone does not lazily fetch a missing object", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "rudder-git-promisor-")))
    try {
      run(dir, "init", "-q", "-b", "main")
      run(dir, "config", "user.email", "t@example.com")
      run(dir, "config", "user.name", "t")
      writeFileSync(join(dir, "f.txt"), "a\n")
      run(dir, "add", ".")
      run(dir, "commit", "-q", "-m", "init")
      writeFileSync(join(dir, "f.txt"), "b\n")
      const blob = run(dir, "rev-parse", "HEAD:f.txt").trim()
      rmSync(join(dir, ".git", "objects", blob.slice(0, 2), blob.slice(2)))
      run(dir, "config", "core.repositoryformatversion", "1")
      run(dir, "config", "extensions.partialClone", "origin")
      run(dir, "config", "remote.origin.url", "ssh://example.invalid/x")
      run(dir, "config", "remote.origin.promisor", "true")
      run(dir, "config", "core.sshCommand", `touch ${join(dir, "SSH")}; false`)
      await gitStatus(".", dir).catch(() => {})
      await gitDiff(".", "f.txt", dir).catch(() => {})
      await gitDiff(".", undefined, dir).catch(() => {})
      expect(existsSync(join(dir, "SSH"))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("status and diff do not look inside submodules, whose own config would run", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "rudder-git-submodule-")))
    try {
      const sub = join(dir, "sub")
      const top = join(dir, "top")
      mkdirSync(sub)
      mkdirSync(top)
      for (const repo of [sub, top]) {
        run(repo, "init", "-q", "-b", "main")
        run(repo, "config", "user.email", "t@example.com")
        run(repo, "config", "user.name", "t")
      }
      writeFileSync(join(sub, "g.txt"), "a\n")
      run(sub, "add", ".")
      run(sub, "commit", "-q", "-m", "init")
      writeFileSync(join(top, "f.txt"), "a\n")
      run(top, "-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "m")
      run(top, "add", ".")
      run(top, "commit", "-q", "-m", "init")
      writeFileSync(join(top, "f.txt"), "b\n")
      writeFileSync(join(top, "m", "g.txt"), "z\n")
      mkdirSync(join(top, ".git", "modules", "m", "info"), { recursive: true })
      writeFileSync(join(top, ".git", "modules", "m", "info", "attributes"), "g.txt filter=evil\n")
      run(join(top, "m"), "config", "filter.evil.clean", `touch ${join(dir, "SUBCLEAN")}; cat`)
      await gitStatus(".", top)
      await gitDiff(".", "f.txt", top)
      await gitDiff(".", undefined, top)
      expect(existsSync(join(dir, "SUBCLEAN"))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("git with the workspace inside a larger repository", () => {
  let repo = ""
  let workspace = ""
  const outsideNames = ["vault", "outside-secret", "outside-gone", "outside-fresh", "outside-moved"]

  beforeAll(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), "rudder-git-sub-")))
    workspace = join(repo, "apps", "ws")
    run(repo, "init", "-q", "-b", "main")
    run(repo, "config", "user.email", "t@example.com")
    run(repo, "config", "user.name", "t")
    mkdirSync(join(workspace, "src"), { recursive: true })
    mkdirSync(join(repo, "vault"))
    writeFileSync(join(workspace, "src", "in.ts"), "one\n")
    writeFileSync(join(repo, "vault", "outside-secret.ts"), "one\n")
    writeFileSync(join(repo, "outside-gone.md"), "bye\n")
    writeFileSync(join(repo, "outside-moved.md"), "moved\n")
    run(repo, "add", ".")
    run(repo, "commit", "-q", "-m", "init")
    writeFileSync(join(workspace, "src", "in.ts"), "one\ntwo\n")
    writeFileSync(join(workspace, "fresh.txt"), "x\n")
    writeFileSync(join(repo, "vault", "outside-secret.ts"), "one\ntwo\n")
    writeFileSync(join(repo, "outside-fresh.txt"), "x\n")
    rmSync(join(repo, "outside-gone.md"))
    // Moved in from outside: must not say where it came from.
    run(repo, "mv", "outside-moved.md", "apps/ws/moved.md")
  })

  afterAll(() => rmSync(repo, { recursive: true, force: true }))

  test("status lists only workspace files, relative to the workspace, and hides the repository root", async () => {
    const status = await gitStatus("src", workspace)
    expect(status.root).toBe(workspace)
    expect(status.branch).toBe("main")
    const byPath = Object.fromEntries(status.files.map((f) => [f.path, f]))
    expect(Object.keys(byPath).sort()).toEqual(["fresh.txt", "moved.md", "src/in.ts"])
    expect(byPath["src/in.ts"]).toMatchObject({ status: "M", added: 1, removed: 0 })
    expect(byPath["moved.md"]).toMatchObject({ status: "A", added: 1, removed: 0 })
    expect(byPath["moved.md"]?.origPath).toBeUndefined()
    expect(byPath["fresh.txt"]?.status).toBe("?")
    const sent = JSON.stringify(status)
    for (const name of outsideNames) expect(sent).not.toContain(name)
    expect(sent).not.toContain(JSON.stringify(repo))
  })

  test("diff stat and per-file diffs stay inside the workspace", async () => {
    const stat = await gitDiff(".", undefined, workspace)
    expect(stat.text).toContain("src/in.ts")
    for (const name of outsideNames) expect(stat.text).not.toContain(name)
    const tracked = await gitDiff("src", "src/in.ts", workspace)
    expect(tracked).toMatchObject({ path: "src/in.ts", root: workspace, untracked: false, truncated: false })
    expect(tracked.patch).toContain("+two")
    expect(tracked.patch).not.toContain("apps/ws")
    const fresh = await gitDiff(".", "fresh.txt", workspace)
    expect(fresh).toMatchObject({ path: "fresh.txt", untracked: true })
    expect(fresh.patch).toContain("+x")
    await expect(gitDiff(".", "../../vault/outside-secret.ts", workspace)).rejects.toMatchObject({ code: "forbidden" })
  })
})

// Third review: a workspace reached through a symlink made every single-file diff fail as outside the workspace.
describe("git with the workspace path through a symlink", () => {
  test("a single-file diff works, at the top of the repository and inside it", async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "rudder-git-link-")))
    try {
      const repo = join(base, "repo")
      mkdirSync(join(repo, "apps", "ws"), { recursive: true })
      run(repo, "init", "-q", "-b", "main")
      run(repo, "config", "user.email", "t@example.com")
      run(repo, "config", "user.name", "t")
      writeFileSync(join(repo, "f.txt"), "a\n")
      writeFileSync(join(repo, "apps", "ws", "g.txt"), "a\n")
      run(repo, "add", ".")
      run(repo, "commit", "-q", "-m", "init")
      writeFileSync(join(repo, "f.txt"), "b\n")
      writeFileSync(join(repo, "apps", "ws", "g.txt"), "b\n")
      symlinkSync(repo, join(base, "link"))
      symlinkSync(join(repo, "apps", "ws"), join(base, "wslink"))
      const top = await gitDiff(".", "f.txt", join(base, "link"))
      expect(top).toMatchObject({ path: "f.txt", untracked: false })
      expect(top.patch).toContain("+b")
      const inner = await gitDiff(".", "g.txt", join(base, "wslink"))
      expect(inner).toMatchObject({ path: "g.txt", untracked: false })
      expect(inner.patch).toContain("+b")
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})

describe("workspace confinement", () => {
  let base = ""
  let root = ""
  let outside = ""

  beforeAll(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "rudder-ws-")))
    root = join(base, "root")
    outside = join(base, "outside")
    mkdirSync(join(root, "inner"), { recursive: true })
    mkdirSync(outside)
    writeFileSync(join(outside, "secret.txt"), "secret")
    writeFileSync(join(root, "inner", "ok.txt"), "ok")
    symlinkSync(outside, join(root, "escape"))
    symlinkSync(join(outside, "secret.txt"), join(root, "secret-link.txt"))
    symlinkSync(join(outside, "missing.txt"), join(root, "dangling.txt"))
    symlinkSync(join(root, "inner"), join(root, "inner-link"))
  })

  afterAll(() => rmSync(base, { recursive: true, force: true }))

  test("symlinks that leave the root are refused, even for paths that do not exist yet", () => {
    for (const path of ["escape", "escape/secret.txt", "escape/new/dir", "secret-link.txt", "dangling.txt", "../outside"]) {
      expect(() => resolveSafe(path, root)).toThrow("path outside workspace")
    }
  })

  test("in-root symlinks and not-yet-created paths are allowed and keep the requested spelling", () => {
    expect(resolveSafe("inner-link/ok.txt", root)).toBe(join(root, "inner-link", "ok.txt"))
    expect(resolveSafe("inner/new/file.txt", root)).toBe(join(root, "inner", "new", "file.txt"))
    expect(resolveSafe(".", root)).toBe(root)
  })

  test("read stops at the limit and reports the real size", async () => {
    writeFileSync(join(root, "big.txt"), "a".repeat(1_000_000))
    const read = await readWorkspaceFile("big.txt", 10, root)
    expect(read).toMatchObject({ text: "a".repeat(10), truncated: true, bytes: 1_000_000, binary: false })
    const small = await readWorkspaceFile("inner/ok.txt", 10, root)
    expect(small).toMatchObject({ text: "ok", truncated: false, bytes: 2 })
  })

  test("read refuses files that are not regular", async () => {
    const fifo = join(root, "pipe")
    expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0)
    await expect(readWorkspaceFile("pipe", 10, root)).rejects.toMatchObject({ code: "invalid" })
    await expect(readWorkspaceFile("inner", 10, root)).rejects.toMatchObject({ code: "invalid" })
  })

  test("a FIFO swapped in after the stat is refused without blocking the open", async () => {
    const fifo = join(root, "swapped")
    expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0)
    const before = statSync(join(root, "inner", "ok.txt"))
    const started = Date.now()
    await expect(openRegular(fifo, before)).rejects.toMatchObject({ code: "invalid", message: "file changed while opening" })
    expect(Date.now() - started).toBeLessThan(1000)
  })

  test("a regular file replaced after the stat is refused", async () => {
    const file = join(root, "replaced.txt")
    writeFileSync(file, "one")
    const before = statSync(file)
    rmSync(file)
    writeFileSync(join(root, "other.txt"), "x")
    writeFileSync(file, "two")
    await expect(openRegular(file, before)).rejects.toMatchObject({ code: "invalid" })
    const handle = await openRegular(file, statSync(file))
    await handle.close()
  })

  test("a long listing keeps folders first and sorts before cutting to the limit", async () => {
    const dir = join(root, "many")
    mkdirSync(dir)
    for (let i = 0; i < 250; i++) writeFileSync(join(dir, `f${String(i).padStart(3, "0")}.txt`), "")
    mkdirSync(join(dir, "zz-last-folder"))
    const listed = await listDir("many", root)
    expect(listed.truncated).toBe(true)
    expect(listed.entries).toHaveLength(200)
    expect(listed.entries[0]).toMatchObject({ name: "zz-last-folder", directory: true })
    expect(listed.entries.slice(1).map((entry) => entry.name)).toEqual(Array.from({ length: 199 }, (_, i) => `f${String(i).padStart(3, "0")}.txt`))
  })

  test("a symlink to an in-root file still reads", async () => {
    symlinkSync(join(root, "inner", "ok.txt"), join(root, "ok-link.txt"))
    const read = await readWorkspaceFile("ok-link.txt", 10, root)
    expect(read).toMatchObject({ path: join(root, "ok-link.txt"), text: "ok" })
  })
})

describe("hidden (dot) paths", () => {
  const hidden = { code: "forbidden", message: "隐藏文件（以 . 开头）不对手机开放" }
  let root = ""

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "rudder-dot-")))
    mkdirSync(join(root, ".ssh"))
    mkdirSync(join(root, "proj", ".git"), { recursive: true })
    mkdirSync(join(root, "proj", "src"))
    writeFileSync(join(root, ".ssh", "id_ed25519"), "key")
    writeFileSync(join(root, "proj", ".env"), "TOKEN=1")
    writeFileSync(join(root, "proj", ".git", "config"), "[core]")
    writeFileSync(join(root, "proj", "env.md"), "docs")
    writeFileSync(join(root, "proj", "src", "env.ts"), "code")
    symlinkSync(join(root, ".ssh"), join(root, "keys"))
  })

  afterAll(() => rmSync(root, { recursive: true, force: true }))

  test("resolveSafe refuses any segment starting with a dot, spelled or behind a symlink", () => {
    for (const path of [".ssh/id_ed25519", "proj/.env", "proj/.git/config", "proj/.git", ".ssh", "keys", "keys/id_ed25519"]) {
      expect(() => resolveSafe(path, root)).toThrow(hidden.message)
    }
    expect(resolveSafe("proj/env.md", root)).toBe(join(root, "proj", "env.md"))
  })

  test("read and list refuse dot paths; listing hides dot entries", async () => {
    await expect(readWorkspaceFile(".ssh/id_ed25519", 100, root)).rejects.toMatchObject(hidden)
    await expect(readWorkspaceFile(join(root, "proj", ".env"), 100, root)).rejects.toMatchObject(hidden)
    await expect(readWorkspaceFile("keys/id_ed25519", 100, root)).rejects.toMatchObject(hidden)
    await expect(listDir("proj/.git", root)).rejects.toMatchObject(hidden)
    const listed = await listDir("proj", root)
    expect(listed.entries.map((entry) => entry.name)).toEqual(["src", "env.md"])
  })

  test("search neither starts in, descends into nor returns dot paths", async () => {
    const found = await searchFiles("env", root, 50, root)
    expect(found.entries.map((entry) => entry.path).sort()).toEqual([join(root, "proj", "env.md"), join(root, "proj", "src", "env.ts")])
    expect((await searchFiles("config", root, 50, root)).entries).toEqual([])
    await expect(searchFiles("id", ".ssh", 50, root)).rejects.toMatchObject(hidden)
  })
})

describe("search limits", () => {
  let root = ""

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "rudder-search-")))
    for (const dir of ["a", "a/b", "c"]) mkdirSync(join(root, dir), { recursive: true })
    for (const name of ["note1.md", "a/note2.md", "a/b/note3.md", "c/note4.md", "c/other.txt"]) writeFileSync(join(root, name), "x")
  })

  afterAll(() => rmSync(root, { recursive: true, force: true }))

  test("a complete search is not truncated", async () => {
    const found = await searchFiles("note", root, 50, root)
    expect(found.entries).toHaveLength(4)
    expect(found.truncated).toBe(false)
    expect(await searchFiles("  ", root, 50, root)).toMatchObject({ entries: [], truncated: false })
  })

  test("exactly `limit` matches is complete; one more is truncated", async () => {
    expect(await searchFiles("note", root, 4, root)).toMatchObject({ truncated: false })
    const cut = await searchFiles("note", root, 3, root)
    expect(cut.entries).toHaveLength(3)
    expect(cut.truncated).toBe(true)
  })

  test("running out of time returns what was found so far, marked truncated", async () => {
    // Each look at the clock costs 1 ms of a 6 ms budget: the walk stops part-way.
    let tick = 0
    const partial = await searchFiles("note", root, 50, root, 6, () => tick++)
    expect(partial.truncated).toBe(true)
    expect(partial.entries.length).toBeLessThan(4)
    for (const entry of partial.entries) expect(entry.name.startsWith("note")).toBe(true)

    // A spent budget still answers (empty), instead of hanging or throwing.
    expect(await searchFiles("note", root, 50, root, 0)).toMatchObject({ entries: [], truncated: true })
  })
})

describe("git with tracked dot files", () => {
  let root = ""

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "rudder-git-dot-")))
    run(root, "init", "-q", "-b", "main")
    run(root, "config", "user.email", "t@example.com")
    run(root, "config", "user.name", "t")
    mkdirSync(join(root, "cfg"))
    writeFileSync(join(root, ".gitignore"), "dist/\n")
    writeFileSync(join(root, "cfg", ".env"), "TOKEN=old\n")
    writeFileSync(join(root, "cfg", "app.json"), "{}\n")
    run(root, "add", ".")
    run(root, "commit", "-q", "-m", "init")
    writeFileSync(join(root, ".gitignore"), "dist/\nbuild/\n")
    writeFileSync(join(root, "cfg", ".env"), "TOKEN=new-secret\n")
    writeFileSync(join(root, "cfg", "app.json"), "{ \"a\": 1 }\n")
  })

  afterAll(() => rmSync(root, { recursive: true, force: true }))

  test("status names a changed dot file, but its diff content is refused", async () => {
    const status = await gitStatus(".", root)
    expect(status.files.map((file) => file.path).sort()).toEqual([".gitignore", "cfg/.env", "cfg/app.json"])
    await expect(gitDiff(".", ".gitignore", root)).rejects.toMatchObject({ code: "forbidden" })
    await expect(gitDiff(".", "cfg/.env", root)).rejects.toMatchObject({ code: "forbidden" })
    expect((await gitDiff(".", "cfg/app.json", root)).patch).toContain("+{ \"a\": 1 }")
  })

  test("a directory diff, which would carry the dot files inside it, is refused", async () => {
    await expect(gitDiff(".", "cfg", root)).rejects.toMatchObject({ code: "invalid" })
    await expect(gitDiff(".", ".", root)).rejects.toMatchObject({ code: "invalid" })
    expect(JSON.stringify(await gitDiff(".", undefined, root))).not.toContain("secret")
  })

  test("a .git directory cannot be the git cwd", async () => {
    await expect(gitStatus(".git", root)).rejects.toMatchObject({ code: "forbidden" })
  })
})

// Audit 2026-11-10 #4: Rudder's data dir is not a dot path, so the hidden-segment rule alone let the phone read the
// device store and keys whenever the workspace held it (the home folder is the default workspace).
describe("Rudder's own data", () => {
  let root = ""
  let home = ""
  const saved = process.env.RUDDER_HOME

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "rudder-protected-")))
    home = join(root, "Library", "Application Support", "RudderTest")
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, "rudder.sqlite"), "devices")
    writeFileSync(join(home, "relay-identity.key"), "secret")
    mkdirSync(join(root, "proj"))
    writeFileSync(join(root, "proj", "ok.txt"), "fine")
    symlinkSync(home, join(root, "proj", "shortcut"))
    process.env.RUDDER_HOME = home
  })

  afterAll(() => {
    if (saved === undefined) delete process.env.RUDDER_HOME
    else process.env.RUDDER_HOME = saved
    rmSync(root, { recursive: true, force: true })
  })

  test("every spelling of RUDDER_HOME is refused: direct, through .., through a symlink, other letter case", async () => {
    await expect(readWorkspaceFile("Library/Application Support/RudderTest/relay-identity.key", 100, root)).rejects.toMatchObject({ code: "forbidden" })
    expect(() => resolveSafe("proj/../Library/Application Support/RudderTest", root)).toThrow()
    await expect(readWorkspaceFile("proj/shortcut/rudder.sqlite", 100, root)).rejects.toMatchObject({ code: "forbidden" })
    await expect(listDir("proj/shortcut", root)).rejects.toMatchObject({ code: "forbidden" })
    if (process.platform === "darwin") {
      await expect(readWorkspaceFile("library/application support/ruddertest/rudder.sqlite", 100, root)).rejects.toMatchObject({ code: "forbidden" })
    }
    expect((await readWorkspaceFile("proj/ok.txt", 100, root)).text).toBe("fine")
  })

  test("the session-folder guard used by file.* refuses it too", async () => {
    await expect(resolveInside(root, "proj/shortcut/relay-identity.key")).rejects.toMatchObject({ code: "forbidden" })
    await expect(resolveInside(root, join(home, "rudder.sqlite"))).rejects.toMatchObject({ code: "forbidden" })
    expect(await resolveInside(root, "proj/ok.txt")).toBe(join(root, "proj", "ok.txt"))
  })

  test("listings and search leave it out", async () => {
    const listing = await listDir("Library/Application Support", root)
    expect(listing.entries.map((entry) => entry.name)).toEqual([])
    const found = await searchFiles("rudder", join(root, "Library"), 50, root)
    expect(found.entries).toEqual([])
  })

  test("the default roots cover the data dir, LaunchAgents, logs and keychains", () => {
    const roots = protectedRoots({}, "/Users/u", "darwin")
    expect(roots).toEqual(
      expect.arrayContaining([
        "/Users/u/Library/Application Support/Rudder",
        "/Users/u/Library/LaunchAgents",
        "/Users/u/Library/Logs/Rudder",
        "/Users/u/Library/Keychains",
      ]),
    )
    expect(isProtectedPath(join(home, "x"))).toBe(true)
    expect(isProtectedPath(`${home}-other`)).toBe(false)
  })
})
