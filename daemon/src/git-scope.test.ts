import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import { currentStates, diffSnapshots, restoreWorktree, snapshotTree, type TurnChanges } from "./turn-changes"
import { gitStatus } from "./workspace"

// review2-1117: every hardened git command first ran its own `git config --get-regexp ^filter\.` (~11.7 ms), so a
// turn snapshot paid for 5-6 of them. The overrides are now read once per operation and directory; a new operation
// reads them again, so a driver configured between two operations is still neutralized.

const dirs: string[] = []
const savedPath = process.env.PATH
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
  const dir = tempDir("rudder-scope-")
  sh(dir, "git", "init", "-q")
  sh(dir, "git", "config", "user.email", "t@example.com")
  sh(dir, "git", "config", "user.name", "t")
  writeFileSync(join(dir, "a.txt"), "one\n")
  sh(dir, "git", "add", "-A")
  sh(dir, "git", "commit", "-qm", "init")
  return dir
}

/**
 * Runs `call` (an expression over `snapshotTree` / `restoreWorktree` / `gitStatus`, with `dir` and `tree` bound) in a
 * child bun whose PATH starts with a `git` that logs each argv to a file, then execs the real git; returns how many of
 * those calls read the filter config. When `hook` is given, the first git call whose argv contains `hook.when` runs
 * `hook.script` (sh) first: the config can change in the middle of an operation. A child process because Bun resolves
 * a bare `git` against the PATH it started with.
 */
function configReadsDuring(dir: string, call: string, options: { tree?: string; hook?: { when: string; script: string } } = {}): number {
  const real = Bun.which("git")!
  const bin = tempDir("rudder-gitlog-")
  const log = join(bin, "calls.log")
  writeFileSync(log, "")
  const hook = options.hook
    ? `case "$*" in *'${options.hook.when}'*) if [ ! -e '${bin}/hooked' ]; then touch '${bin}/hooked'; sh '${bin}/hook.sh'; fi;; esac\n`
    : ""
  if (options.hook) writeFileSync(join(bin, "hook.sh"), options.hook.script)
  writeFileSync(join(bin, "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n${hook}exec '${real}' "$@"\n`)
  chmodSync(join(bin, "git"), 0o755)
  const script = join(bin, "run.ts")
  const src = join(import.meta.dir)
  writeFileSync(
    script,
    `import { restoreWorktree, snapshotTree } from "${src}/turn-changes"\nimport { gitStatus } from "${src}/workspace"\nconst dir = ${JSON.stringify(dir)}\nconst tree = ${JSON.stringify(options.tree ?? "")}\nconst out = await ${call}\nif (!out) process.exit(2)\n`,
  )
  const proc = Bun.spawnSync([process.execPath, "run", script], { env: { ...process.env, PATH: `${bin}:${savedPath}` }, stdout: "pipe", stderr: "pipe" })
  if (proc.exitCode !== 0) throw new Error(`child failed: ${proc.stderr.toString()}`)
  if (options.hook && !existsSync(join(bin, "hooked"))) throw new Error(`hook never ran: no git call matched ${options.hook.when}`)
  return readFileSync(log, "utf8").split("\n").filter((line) => line.includes("config --show-scope")).length
}

/** sh that gives `dir` a hostile `evil` filter driver (attributes + config) whose commands leave markers in `markers`. */
function hostileDriverScript(dir: string, markers: string) {
  const git = Bun.which("git")!
  const lines = [`printf '*.txt filter=evil\\n' > '${join(dir, ".git", "info", "attributes")}'`]
  for (const key of ["clean", "smudge", "process"]) lines.push(`'${git}' -C '${dir}' config filter.evil.${key} 'touch ${join(markers, key.toUpperCase())}; cat'`)
  lines.push(`'${git}' -C '${dir}' config filter.evil.required true`)
  return `${lines.join("\n")}\n`
}

function expectNoMarkers(markers: string) {
  for (const marker of ["CLEAN", "SMUDGE", "PROCESS"]) expect(existsSync(join(markers, marker))).toBe(false)
}

describe("filter overrides are read once per git operation", () => {
  // review3-1117: commands that can run a filter driver (add, restore, status and diff, which hash a stat-dirty file
  // through its clean filter) read the config right before they run; only the filter-free ones (rev-parse, ls-files,
  // write-tree, cat-file, clean) share the operation's read. Commands started together share one read.
  test("a turn snapshot reads the filter config once, plus once before each add", async () => {
    const dir = repo()
    writeFileSync(join(dir, "b.txt"), "new\n")
    expect(configReadsDuring(dir, "snapshotTree(dir, dir)")).toBe(3)
  })

  test("git.status reads it once, once for its two concurrent statuses and once for its diff", async () => {
    const dir = repo()
    expect(configReadsDuring(dir, "gitStatus(dir, dir)")).toBe(3)
  })

  test("a filter driver configured after one snapshot is neutralized in the next operation", async () => {
    const dir = repo()
    const markers = tempDir("rudder-scope-markers-")
    const first = await snapshotTree(dir, dir)
    expect(first).not.toBeNull()
    writeFileSync(join(dir, ".git", "info", "attributes"), "*.txt filter=evil\n")
    for (const key of ["clean", "smudge", "process"]) sh(dir, "git", "config", `filter.evil.${key}`, `touch ${join(markers, key.toUpperCase())}; cat`)
    sh(dir, "git", "config", "filter.evil.required", "true")
    writeFileSync(join(dir, "a.txt"), "changed\n")
    const second = await snapshotTree(dir, dir)
    expect(second).not.toBeNull()
    expect(await restoreWorktree(dir, first!.tree, dir)).toBe(true)
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("one\n")
    await gitStatus(dir, dir)
    for (const marker of ["CLEAN", "SMUDGE", "PROCESS"]) expect(existsSync(join(markers, marker))).toBe(false)
  })

  test("a filter driver configured in the middle of a snapshot is neutralized for its adds", async () => {
    const dir = repo()
    const markers = tempDir("rudder-scope-markers-")
    writeFileSync(join(dir, "a.txt"), "changed\n")
    writeFileSync(join(dir, "b.txt"), "new\n")
    // ls-files runs after the snapshot's first config read and before either add.
    configReadsDuring(dir, "snapshotTree(dir, dir)", { hook: { when: "ls-files", script: hostileDriverScript(dir, markers) } })
    expectNoMarkers(markers)
  })

  test("a filter driver configured in the middle of a restore is neutralized for the restore", async () => {
    const dir = repo()
    const markers = tempDir("rudder-scope-markers-")
    const first = await snapshotTree(dir, dir)
    expect(first).not.toBeNull()
    writeFileSync(join(dir, "a.txt"), "changed\n")
    // ls-files (the untracked listing) runs after the restore's first config read and before `git restore`.
    configReadsDuring(dir, "restoreWorktree(dir, tree, dir)", { tree: first!.tree, hook: { when: "ls-files", script: hostileDriverScript(dir, markers) } })
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("one\n")
    expectNoMarkers(markers)
  })

  test("a filter driver configured in the middle of git.status is neutralized for its status and diff", async () => {
    const dir = repo()
    const markers = tempDir("rudder-scope-markers-")
    // Same size, new mtime: status and diff must hash it, through its clean filter if one is configured.
    writeFileSync(join(dir, "a.txt"), "two\n")
    utimesSync(join(dir, "a.txt"), new Date(Date.now() + 5_000), new Date(Date.now() + 5_000))
    configReadsDuring(dir, "gitStatus(dir, dir)", { hook: { when: "rev-parse --show-toplevel", script: hostileDriverScript(dir, markers) } })
    expectNoMarkers(markers)
  })
})

// review3-1117: currentStates hashed the turn's files with `git hash-object --stdin-paths` run in the daemon's own cwd
// (launchd starts rudderd in its checkout's daemon/, inside the rudder repository), without -C or the filter overrides.
// That repository's attributes and filter drivers applied to the workspace's files: its clean filter ran, and the hashes
// no longer matched the snapshot's, so an untouched file read as changed.
describe("currentStates hashes in the workspace's repository", () => {
  async function turnOnA() {
    const dir = repo()
    const start = await snapshotTree(dir, dir)
    writeFileSync(join(dir, "a.txt"), "two\n")
    const end = await snapshotTree(dir, dir)
    expect(start && end).toBeTruthy()
    const files = await diffSnapshots(start!, end!)
    expect(files.map((file) => file.path)).toEqual(["a.txt"])
    const changes: TurnChanges = {
      turnId: "t", sessionId: "s", source: "git", root: dir, base: start!.tree, head: end!.tree,
      startedAt: 0, endedAt: 0, files, approx: false,
    }
    return { dir, changes }
  }

  test("a daemon cwd inside another repository does not lend it its attributes or filters", async () => {
    const { changes } = await turnOnA()
    const markers = tempDir("rudder-cwd-markers-")
    const cwdRepo = tempDir("rudder-cwd-repo-")
    sh(cwdRepo, "git", "init", "-q")
    writeFileSync(join(cwdRepo, ".gitattributes"), "* filter=evil\n")
    sh(cwdRepo, "git", "config", "filter.evil.clean", `touch ${join(markers, "CLEAN")}; tr a-z A-Z`)
    const daemonDir = join(cwdRepo, "daemon")
    sh(cwdRepo, "mkdir", "daemon")
    const script = join(tempDir("rudder-cwd-run-"), "run.ts")
    writeFileSync(
      script,
      `import { currentStates } from "${import.meta.dir}/turn-changes"\nconst states = await currentStates(${JSON.stringify(changes)})\nconsole.log(JSON.stringify([...states]))\n`,
    )
    const proc = Bun.spawnSync([process.execPath, "run", script], { cwd: daemonDir, stdout: "pipe", stderr: "pipe" })
    if (proc.exitCode !== 0) throw new Error(`child failed: ${proc.stderr.toString()}`)
    const states = new Map(JSON.parse(proc.stdout.toString()) as [string, { current: string }][])
    expect(existsSync(join(markers, "CLEAN"))).toBe(false)
    expect(states.get("a.txt")?.current).toBe("same")
  })

  test("the workspace's own filter drivers are neutralized, read right before the hash", async () => {
    const { dir, changes } = await turnOnA()
    const markers = tempDir("rudder-ws-markers-")
    writeFileSync(join(dir, ".git", "info", "attributes"), "*.txt filter=evil\n")
    for (const key of ["clean", "process"]) sh(dir, "git", "config", `filter.evil.${key}`, `touch ${join(markers, key.toUpperCase())}; cat`)
    sh(dir, "git", "config", "filter.evil.required", "true")
    const states = await currentStates(changes)
    expect(existsSync(join(markers, "CLEAN"))).toBe(false)
    expect(existsSync(join(markers, "PROCESS"))).toBe(false)
    expect(states.get("a.txt")?.current).toBe("same")
  })
})

// review3-1117: snapshotTree copies the real index into a throwaway so git only rehashes files whose stat changed.
// copyFile gives that throwaway a new mtime. A same-size rewrite in the index entry's timestamp tick then looks
// unchanged once the snapshot runs in a later second (git trusts the stat cache when the file is older than the
// index file). The copy must keep the real index's stamps so the racy-git check still hashes it.
describe("snapshotTree does not miss a same-size rewrite git's stat cache would skip", () => {
  test("a same-size rewrite in the index's timestamp tick is still in a later snapshot", async () => {
    const dir = repo()
    const start = await snapshotTree(dir, dir)
    expect(start).not.toBeNull()
    writeFileSync(join(dir, "a.txt"), "two\n")
    const fileMtimeMs = statSync(join(dir, "a.txt")).mtimeMs
    const delay = Math.floor(fileMtimeMs / 1000) * 1000 + 1000 - Date.now() + 20
    if (delay > 0) await Bun.sleep(delay)
    const end = await snapshotTree(dir, dir)
    expect(end).not.toBeNull()
    expect((await diffSnapshots(start!, end!)).map((file) => file.path)).toEqual(["a.txt"])
  })
})
