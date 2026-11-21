import { constants, type Dirent, type Stats } from "node:fs"
import { AsyncLocalStorage } from "node:async_hooks"
import { homedir } from "node:os"
import { type FileHandle, open, readdir, realpath, stat } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import { copyError, phoneCopy } from "./phone-copy"
import { defaultDataDir, isWindows, NATIVE_PATH_HOST, type PathHost, pathFor, windowsPathProblem } from "./platform"

export const WORKSPACE_ROOT = process.env.RUDDER_WORKSPACE ?? homedir()

function outsideWorkspace(): Error {
  return Object.assign(new Error("path outside workspace"), { code: "forbidden" })
}

function hiddenPath(): Error {
  return copyError(phoneCopy.hiddenPath(), { code: "forbidden" })
}

function protectedPath(): Error {
  return Object.assign(new Error("Rudder's own data is not open to the phone"), { code: "forbidden" })
}

/**
 * Folders and files that hold the daemon's own state and the computer's secrets, refused to the phone wherever the
 * workspace is: RUDDER_HOME (device store, TLS and relay keys, the CLI socket), the default data dir, a RUDDER_DB kept
 * elsewhere, the LaunchAgent plists and logs, and the login keychains. None of them is a dot path, so the hidden
 * segment rule alone lets them through (the home folder is the default workspace).
 */
export function protectedRoots(env: NodeJS.ProcessEnv = process.env, home: string = homedir(), platform: NodeJS.Platform = process.platform): string[] {
  const path = pathFor(platform)
  const roots = [defaultDataDir(platform, env, home)]
  if (env.RUDDER_HOME) roots.push(path.resolve(env.RUDDER_HOME))
  if (env.RUDDER_DB) {
    const db = path.resolve(env.RUDDER_DB)
    roots.push(db, `${db}-wal`, `${db}-shm`, `${db}-journal`)
  }
  if (!isWindows(platform)) {
    roots.push(path.join(home, "Library", "Logs", "Rudder"), path.join(home, "Library", "LaunchAgents"), path.join(home, "Library", "Keychains"))
  }
  return roots
}

const rootsCache = new WeakMap<PathHost, { key: string; roots: string[] }>()

// Both spellings of every root: as configured and symlink-resolved. Recomputed when the inputs change (tests set
// RUDDER_HOME per case); realpath only runs then, not on every check.
function protectedSpellings(host: PathHost): string[] {
  const key = [process.env.HOME, process.env.USERPROFILE, process.env.LOCALAPPDATA, process.env.RUDDER_HOME, process.env.RUDDER_DB].join("\0")
  const cached = rootsCache.get(host)
  if (cached?.key === key) return cached.roots
  const roots = new Set<string>()
  for (const root of protectedRoots(process.env, homedir(), host.windows ? "win32" : process.platform)) {
    roots.add(root)
    try {
      roots.add(realpathDeep(root, host))
    } catch {
      // A dangling link at a root: the spelled form still guards it.
    }
  }
  const spelled = [...roots]
  rootsCache.set(host, { key, roots: spelled })
  return spelled
}

/**
 * Whether `path` is, or lies under, one of `protectedRoots`. Compared case-insensitively on macOS and Windows, whose
 * default file systems (APFS, NTFS) treat `~/library/application support/rudder` as the same folder.
 */
export function isProtectedPath(path: string, host: PathHost = NATIVE_PATH_HOST): boolean {
  const fold = host.windows || process.platform === "darwin" ? (value: string) => value.toLowerCase() : (value: string) => value
  const target = fold(host.path.resolve(path))
  return protectedSpellings(host).some((root) => {
    const folded = fold(root)
    return target === folded || target.startsWith(folded.endsWith(host.path.sep) ? folded : `${folded}${host.path.sep}`)
  })
}

/** Throws `forbidden` when either spelling of a path lands in `protectedRoots`. */
export function assertNotProtected(paths: string[], host: PathHost = NATIVE_PATH_HOST): void {
  if (paths.some((path) => isProtectedPath(path, host))) throw protectedPath()
}

/** Any segment of a root-relative path starting with `.`: `.ssh/id_ed25519`, `proj/.env`, `.git/config`. */
export function hasHiddenSegment(rel: string, host: PathHost = NATIVE_PATH_HOST): boolean {
  return rel.split(host.path.sep).some((segment) => segment.startsWith("."))
}

// On Windows `relative` answers with an absolute path for another drive or UNC share; that is outside too.
// (path.win32.relative already compares case-insensitively, as NTFS does.)
function escapes(root: string, candidate: string, host: PathHost = NATIVE_PATH_HOST): boolean {
  const rel = host.path.relative(root, candidate)
  return rel.startsWith(`..${host.path.sep}`) || rel === ".." || host.path.isAbsolute(rel)
}

// Resolves symlinks in the deepest existing ancestor, so a path that does not exist yet is judged by
// where it would land. A dangling symlink cannot be judged and is refused.
function realpathDeep(path: string, host: PathHost = NATIVE_PATH_HOST): string {
  const missing: string[] = []
  let current = path
  for (;;) {
    try {
      return host.path.join(host.realpath(current), ...missing)
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error
      let isLink = false
      try {
        isLink = host.isSymbolicLink(current)
      } catch {
        isLink = false
      }
      if (isLink) throw outsideWorkspace()
      const parent = host.path.dirname(current)
      if (parent === current) return path
      missing.unshift(host.path.basename(current))
      current = parent
    }
  }
}

// Returns the requested spelling; both it and its symlink-resolved target must stay under root, and neither may
// pass through a hidden (dot) file or directory: those hold keys, tokens and repository internals.
// On Windows, device paths, alternate data streams and reserved names are refused first (platform/index.ts).
export function resolveSafe(input: string | undefined, root = WORKSPACE_ROOT, host: PathHost = NATIVE_PATH_HOST): string {
  if (host.windows && input && windowsPathProblem(input)) throw outsideWorkspace()
  const candidate = host.path.resolve(root, input?.trim() ? input : ".")
  if (escapes(root, candidate, host)) throw outsideWorkspace()
  const realRoot = realpathDeep(host.path.resolve(root), host)
  const real = realpathDeep(candidate, host)
  if (escapes(realRoot, real, host)) throw outsideWorkspace()
  if (hasHiddenSegment(host.path.relative(root, candidate), host) || hasHiddenSegment(host.path.relative(realRoot, real), host)) {
    throw hiddenPath()
  }
  assertNotProtected([candidate, real], host)
  return candidate
}

const LIST_LIMIT = 200

export async function listDir(path: string, root = WORKSPACE_ROOT) {
  const abs = resolveSafe(path, root)
  const entries = await readdir(abs, { withFileTypes: true })
  const visible = entries.filter((entry) => !entry.name.startsWith(".") && !isProtectedPath(join(abs, entry.name)))
  // Sort before the cut so the first page is the same folders-first order the phone shows, not readdir order.
  visible.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
  const items = await Promise.all(
    visible
      .slice(0, LIST_LIMIT)
      .map(async (entry) => {
        const full = join(abs, entry.name)
        let size = 0
        try {
          const info = await stat(full)
          size = info.size
        } catch {
          size = 0
        }
        return {
          name: entry.name,
          path: full,
          directory: entry.isDirectory(),
          size,
        }
      }),
  )
  return {
    path: abs,
    parent: abs === resolve(root) ? null : dirname(abs),
    entries: items,
    truncated: visible.length > LIST_LIMIT,
  }
}

// Reads at most limit + 1 bytes; `bytes` is the size on disk. FIFOs and devices are refused before open.
export async function readWorkspaceFile(path: string, limit = 32_000, root = WORKSPACE_ROOT) {
  const abs = resolveSafe(path, root)
  // In-root symlinks stay readable: the real path is opened, and O_NOFOLLOW refuses it if it turns into a link.
  const real = await realpath(abs)
  const info = await stat(real)
  if (info.isDirectory()) throw Object.assign(new Error("is a directory"), { code: "invalid" })
  if (!info.isFile()) throw Object.assign(new Error("not a regular file"), { code: "invalid" })
  const handle = await openRegular(real, info)
  let buf: Buffer
  try {
    const chunk = Buffer.alloc(limit + 1)
    const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, 0)
    buf = chunk.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
  const truncated = buf.byteLength > limit || info.size > limit
  // Same heuristic as git: a NUL byte in the first 8000 bytes means binary.
  const binary = buf.subarray(0, 8000).includes(0)
  return { path: abs, text: binary ? "" : buf.subarray(0, limit).toString("utf8"), truncated, bytes: Math.max(info.size, buf.byteLength), binary }
}

/**
 * Opens `path` only if it is still the regular file `expected` described. O_NONBLOCK keeps a FIFO swapped in after the
 * stat from blocking the open forever; the fstat then rejects it, or anything else with a different dev/ino.
 */
export async function openRegular(path: string, expected: Stats): Promise<FileHandle> {
  const changed = () => Object.assign(new Error("file changed while opening"), { code: "invalid" })
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ELOOP") throw changed()
    throw error
  })
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.dev !== expected.dev || opened.ino !== expected.ino) throw changed()
    return handle
  } catch (error) {
    await handle.close()
    throw error
  }
}

/** Up to `limit` bytes of a stream; past it the rest is not read and `over` is set. Cut back to a whole UTF-8 character. */
async function readUpTo(stream: ReadableStream<Uint8Array>, limit: number): Promise<{ text: string; over: boolean }> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let over = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (size + value.byteLength > limit) {
      chunks.push(value.subarray(0, limit - size))
      over = true
      await reader.cancel().catch(() => {})
      break
    }
    chunks.push(value)
    size += value.byteLength
  }
  let bytes = Buffer.concat(chunks)
  if (over) {
    // Drop a trailing partial character: back up over continuation bytes to the lead byte and drop it if incomplete.
    let start = bytes.length - 1
    while (start > 0 && (bytes[start]! & 0xc0) === 0x80) start--
    const lead = bytes[start] ?? 0
    const width = lead < 0x80 ? 1 : lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : 2
    if (start + width > bytes.length) bytes = bytes.subarray(0, start)
  }
  return { text: bytes.toString("utf8"), over }
}

/**
 * Runs `argv` reading at most `limit` bytes of stdout: past that the process is killed rather than read to the end,
 * and `truncated` is set (its exit code is then whatever the kill left).
 */
export async function spawnCapped(argv: string[], limit: number) {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" })
  const [out, err] = await Promise.all([readUpTo(proc.stdout, limit), readUpTo(proc.stderr, GIT_STDERR_LIMIT)])
  if (out.over || err.over) proc.kill()
  const code = await proc.exited
  return { stdout: out.text, stderr: err.text, code, truncated: out.over }
}

/** Git output past this is not something the phone can use; the cap only guards against a runaway repository. */
const GIT_OUTPUT_LIMIT = 16 * 1024 * 1024
const GIT_STDERR_LIMIT = 64 * 1024

/**
 * argv for a git command run on the phone's behalf in a repository Rudder did not vet (a cloned one may carry a hostile
 * `.git/config` or `.gitattributes`). The fsmonitor hook would run on every status, an external diff or textconv
 * driver on every diff, and a filter driver on every status, add or restore of a file its attributes name; none is
 * needed to read a status, a patch or a snapshot. `--no-optional-locks` keeps a status from rewriting the index under
 * the agent. `--no-lazy-fetch`: a repository that calls itself a partial clone would otherwise fetch a missing object
 * from its promisor remote, running the transport (`core.sshCommand`) its config names. Status and diff skip
 * submodules (`--ignore-submodules=all`): checking one runs git inside it under its own config, whose filter drivers
 * the overrides below don't cover. `args` starts `-C <dir> <subcommand>`.
 */
export async function hardenedGit(args: string[]): Promise<string[]> {
  const [flag, dir, subcommand, ...rest] = args
  const submodules = subcommand === "diff" || subcommand === "status" ? ["--ignore-submodules=all"] : []
  const diffFlags = subcommand === "diff" ? ["--no-ext-diff", "--no-textconv"] : []
  const command = flag === "-C" && subcommand !== undefined ? [flag, dir!, subcommand, ...diffFlags, ...submodules, ...rest] : args
  const filters = flag === "-C" && dir !== undefined ? await scopedFilterOverrides(dir, subcommand) : []
  return ["git", "--no-optional-locks", "--no-lazy-fetch", "--literal-pathspecs", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...filters, ...command]
}

/**
 * Subcommands that never run a filter driver: they read refs, the index or objects, or (`clean`) only delete. Every
 * other one may: add and restore run clean / smudge, and status and a working-tree diff hash a stat-dirty file through
 * its clean filter (review3-1117).
 */
const FILTER_FREE_SUBCOMMANDS = new Set(["rev-parse", "write-tree", "ls-files", "cat-file", "clean"])

/** Per operation and directory: the latest read of the filter overrides, and the read still running, if any. */
type OperationReads = Map<string, { latest: Promise<string[]>; pending: Promise<string[]> | undefined }>
const gitOperationScope = new AsyncLocalStorage<OperationReads>()

/**
 * Runs `fn` as one git operation, so its commands spawn fewer `git config` reads (review2-1117: each is ~11.7 ms). A
 * command that may run a filter driver still gets overrides read right before it (commands started together share
 * that read), so a driver configured while the operation runs, say by a turn's background task between a snapshot's
 * listing and its `git add`, is neutralized too; only filter-free commands reuse the operation's latest read. Nothing
 * is kept past the operation. Nested calls join the outer operation.
 */
export function gitOperation<T>(fn: () => Promise<T>): Promise<T> {
  return gitOperationScope.getStore() ? fn() : gitOperationScope.run(new Map(), fn)
}

/** `fn` with each call run as one `gitOperation`. */
export function asGitOperation<A extends unknown[], R>(fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return (...args) => gitOperation(() => fn(...args))
}

function scopedFilterOverrides(dir: string, subcommand: string | undefined): Promise<string[]> {
  const reads = gitOperationScope.getStore()
  if (!reads) return repoFilterOverrides(dir)
  const entry = reads.get(dir)
  if (entry && subcommand !== undefined && FILTER_FREE_SUBCOMMANDS.has(subcommand)) return entry.latest
  // Join a read that is still running: it started no earlier than this command was asked for, give or take its own
  // few milliseconds, which is the window every hardened command has had.
  if (entry?.pending) return entry.pending
  const read = repoFilterOverrides(dir)
  const next: { latest: Promise<string[]>; pending: Promise<string[]> | undefined } = { latest: read, pending: read }
  reads.set(dir, next)
  const settle = () => {
    if (next.pending === read) next.pending = undefined
  }
  read.then(settle, settle)
  return read
}

/**
 * `-c` pairs that turn every filter driver the repository's own config defines (`.git/config`, its includes, the
 * worktree config) into a pass-through. The owner's global and system drivers (git-lfs) are theirs and stay. Reading
 * config runs nothing. A driver name git's `-c` can't spell (it holds `=`) is refused rather than left to run.
 */
async function repoFilterOverrides(dir: string): Promise<string[]> {
  const proc = Bun.spawn(["git", "-C", dir, "config", "--show-scope", "-z", "--name-only", "--get-regexp", "^filter\\."], {
    stdout: "pipe",
    stderr: "ignore",
    stdin: "ignore",
  })
  const fields = (await new Response(proc.stdout).text()).split("\0")
  await proc.exited
  const names = new Set<string>()
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const scope = fields[i]
    const key = fields[i + 1] ?? ""
    if (scope === "global" || scope === "system") continue
    // An empty name (`filter..clean`) is a driver too: `filter=` in an attributes file selects it.
    names.add(key.slice("filter.".length, key.lastIndexOf(".")))
  }
  const overrides: string[] = []
  for (const name of names) {
    if (name.includes("=")) throw Object.assign(new Error(`git refused: filter driver "${name}" in ${dir}`), { code: "git" })
    for (const [key, value] of [["clean", "cat"], ["smudge", "cat"], ["process", ""], ["required", "false"]]) {
      overrides.push("-c", `filter.${name}.${key}=${value}`)
    }
  }
  return overrides
}

/** Git's stdout, at most `limit` bytes; `truncated` output counts as success, since the kill decided the exit code. */
async function gitCapped(args: string[], okCodes: number[], limit: number) {
  const { stdout, stderr, code, truncated } = await spawnCapped(await hardenedGit(args), limit)
  if (!truncated && !okCodes.includes(code)) throw Object.assign(new Error(stderr.trim() || `git ${args[2] ?? ""} failed`), { code: "git" })
  return { stdout, truncated }
}

async function git(args: string[], okCodes = [0]) {
  return (await gitCapped(args, okCodes, GIT_OUTPUT_LIMIT)).stdout
}

/** `git hash-object -t tree /dev/null`: diff base for a repository with no commits yet. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
const GIT_FILE_LIMIT = 500
const GIT_PATCH_LIMIT = 64_000

export type GitFileStatus = "M" | "A" | "D" | "R" | "C" | "U" | "?"

export interface GitFile {
  /** Relative to `root` (see `repoView`). */
  path: string
  origPath?: string
  status: GitFileStatus
  /** Porcelain v2 XY: index and worktree codes, `.` for unchanged. */
  index: string
  worktree: string
  /** `git diff --numstat HEAD`; absent for untracked files, both absent for binary files. */
  added?: number
  removed?: number
  binary?: boolean
}

function fileStatus(xy: string): GitFileStatus {
  const [x = ".", y = "."] = xy
  if (x === "R") return "R"
  if (x === "C") return "C"
  if (x === "A") return "A"
  if (x === "D" || y === "D") return "D"
  return "M"
}

/** Parses `git status --porcelain=v2 --branch -z`. */
export function parseStatusV2(out: string) {
  const tokens = out.split("\0")
  let branch: string | null = null
  let oid: string | null = null
  let upstream: string | null = null
  let ahead = 0
  let behind = 0
  const files: GitFile[] = []
  const fields = (line: string, count: number) => {
    const parts = line.split(" ")
    return { head: parts.slice(0, count), path: parts.slice(count).join(" ") }
  }
  for (let i = 0; i < tokens.length; i++) {
    const line = tokens[i]!
    if (!line) continue
    if (line.startsWith("# branch.oid ")) {
      const value = line.slice(13)
      oid = value === "(initial)" ? null : value
    } else if (line.startsWith("# branch.head ")) {
      const value = line.slice(14)
      branch = value === "(detached)" ? null : value
    } else if (line.startsWith("# branch.upstream ")) {
      upstream = line.slice(18)
    } else if (line.startsWith("# branch.ab ")) {
      const [a = "+0", b = "-0"] = line.slice(12).split(" ")
      ahead = Math.abs(Number(a)) || 0
      behind = Math.abs(Number(b)) || 0
    } else if (line.startsWith("1 ")) {
      const { head, path } = fields(line, 8)
      const xy = head[1] ?? ".."
      files.push({ path, status: fileStatus(xy), index: xy[0]!, worktree: xy[1]! })
    } else if (line.startsWith("2 ")) {
      const { head, path } = fields(line, 9)
      const xy = head[1] ?? ".."
      files.push({ path, origPath: tokens[++i], status: fileStatus(xy), index: xy[0]!, worktree: xy[1]! })
    } else if (line.startsWith("u ")) {
      const { head, path } = fields(line, 10)
      const xy = head[1] ?? "UU"
      files.push({ path, status: "U", index: xy[0]!, worktree: xy[1]! })
    } else if (line.startsWith("? ")) {
      files.push({ path: line.slice(2), status: "?", index: "?", worktree: "?" })
    }
  }
  return { branch, oid, upstream, ahead, behind, files }
}

/** Parses `git diff --numstat -z --no-renames`: `added\tremoved\tpath\0`, `-\t-\t` for binary. */
export function parseNumstat(out: string) {
  const counts = new Map<string, { added?: number; removed?: number; binary?: boolean }>()
  for (const record of out.split("\0")) {
    const [added, removed, ...rest] = record.split("\t")
    if (added === undefined || removed === undefined || rest.length === 0) continue
    const path = rest.join("\t")
    counts.set(path, added === "-" ? { binary: true } : { added: Number(added), removed: Number(removed) })
  }
  return counts
}

async function repoRoot(abs: string) {
  return (await git(["-C", abs, "rev-parse", "--show-toplevel"])).trim()
}

/**
 * `dir` spelled under `root`. Git reports a repository's real path, while `root` may reach it through a symlink;
 * `resolveSafe` judges a path as spelled under `root`, so a file in `dir` is named this way before it is checked.
 */
export function spelledUnder(dir: string, root: string): string {
  return resolve(root, relative(realpathDeep(resolve(root)), realpathDeep(dir)))
}

/**
 * The repository holding `abs`, as far as the phone may see it. `top` is git's root. When the workspace is a
 * subdirectory of the repository, `root` is the workspace instead and `scope` (the workspace relative to `top`)
 * is the pathspec that keeps every listing inside it, so no name or path outside the workspace is sent.
 * Paths sent to the phone are relative to `root`.
 */
export async function repoView(abs: string, workspace: string) {
  const top = await repoRoot(abs)
  const real = realpathDeep(resolve(workspace))
  if (!escapes(real, top)) return { top, root: top, scope: "" }
  if (escapes(top, real)) throw outsideWorkspace()
  return { top, root: resolve(workspace), scope: relative(top, real) }
}

/** Rebases `top`-relative paths onto the workspace (`scope`), dropping any that lie outside it. */
function rebaseFiles(files: GitFile[], scope: string): GitFile[] {
  if (!scope) return files
  const prefix = `${scope}/`
  // The workspace itself untracked as a whole shows as `scope/`; `git status --short` spells that `./`.
  const inside = (path: string) => (path.startsWith(prefix) ? path.slice(prefix.length) || "./" : undefined)
  return files.flatMap(({ origPath, ...file }) => {
    const path = inside(file.path)
    if (path === undefined) return []
    const orig = origPath === undefined ? undefined : inside(origPath)
    return [{ ...file, path, ...(orig === undefined ? {} : { origPath: orig }) }]
  })
}

async function diffBase(abs: string) {
  const head = await git(["-C", abs, "rev-parse", "--verify", "--quiet", "HEAD"], [0, 1])
  return head.trim() ? "HEAD" : EMPTY_TREE
}

/**
 * `text` is the original `git status --porcelain -b` output; the structured fields (`root`, `branch`, `upstream`,
 * `ahead` / `behind`, `files[]` with per-file counts against HEAD) are additive. Everything is limited to the
 * workspace (`repoView`); `text` keeps git's repository-relative spelling.
 */
async function gitStatusOnce(cwd: string, root = WORKSPACE_ROOT) {
  const abs = resolveSafe(cwd, root)
  const view = await repoView(abs, root)
  const scope = view.scope ? ["--", view.scope] : []
  const [text, v2, base] = await Promise.all([
    git(["-C", view.top, "status", "--porcelain", "-b", ...scope]),
    git(["-C", view.top, "status", "--porcelain=v2", "--branch", "-z", ...scope]),
    diffBase(abs),
  ])
  const parsed = parseStatusV2(v2)
  const all = rebaseFiles(parsed.files, view.scope)
  // `--relative` from `root`: paths relative to it, nothing outside it.
  const counts = parseNumstat(await git(["-C", view.root, "diff", "--numstat", "-z", "--no-renames", "--relative", base]))
  const files = all.slice(0, GIT_FILE_LIMIT).map((file) => ({ ...file, ...(counts.get(file.path) ?? {}) }))
  return { cwd: abs, text, root: view.root, ...parsed, files, filesTruncated: all.length > GIT_FILE_LIMIT }
}
export const gitStatus = asGitOperation(gitStatusOnce)

/**
 * Without `path`: the original `git diff --stat` text, limited to the workspace. With `path` (relative to `root`,
 * as `git.status` reports it): that file's unified diff against HEAD in `patch` (also `text`), untracked files as
 * all-added, capped at 64 KB with `truncated`. Dot files are refused (`resolveSafe`): `git.status` and the stat text
 * still name a changed `.gitignore`, since that is the repository's own change, but its content is not sent. A
 * directory is refused too, because its diff would carry the dot files inside it.
 */
async function gitDiffOnce(cwd: string, path?: string, root = WORKSPACE_ROOT) {
  const abs = resolveSafe(cwd, root)
  const view = await repoView(abs, root)
  if (!path) {
    const { stdout, truncated } = await gitCapped(["-C", view.root, "diff", "--stat", "--relative"], [0], GIT_PATCH_LIMIT)
    return { cwd: abs, text: stdout || "(clean)", truncated }
  }
  const base = spelledUnder(view.root, root)
  const target = resolveSafe(resolve(base, path), root)
  if ((await stat(target).catch(() => null))?.isDirectory()) throw Object.assign(new Error("is a directory"), { code: "invalid" })
  const rel = relative(base, target)
  const untracked = (await git(["-C", view.root, "status", "--porcelain=v1", "-z", "--", rel])).startsWith("?? ")
  // Read only up to the limit: git is stopped there instead of producing a huge patch nobody reads.
  const { stdout: text, truncated } = untracked
    ? await gitCapped(["-C", view.root, "diff", "--no-index", "--", "/dev/null", rel], [0, 1], GIT_PATCH_LIMIT)
    : await gitCapped(["-C", view.root, "diff", "--relative", "--no-renames", await diffBase(abs), "--", rel], [0], GIT_PATCH_LIMIT)
  const binary = /^Binary files .* differ$/m.test(text) && !text.includes("\n@@")
  return { cwd: abs, path: rel, root: view.root, text, patch: text, truncated, binary, untracked }
}
export const gitDiff = asGitOperation(gitDiffOnce)

const SEARCH_SKIP = new Set(["Library", "node_modules", ".git", "Movies", "Pictures", "Applications"])

/** Wall-clock budget for one `fs.search`: a huge tree (or a slow network mount) answers with what it found so far. */
export const SEARCH_BUDGET_MS = 1500

type SearchEntry = { name: string; path: string; directory: boolean; size: number }

/**
 * Names containing `query` (case-insensitive) in `root` and three levels below, at most `limit`. `truncated` (as on
 * `fs.list`) says the list is not complete: there were more than `limit` matches, or `budgetMs` ran out first.
 */
export async function searchFiles(
  query: string,
  root = WORKSPACE_ROOT,
  limit = 50,
  workspace = WORKSPACE_ROOT,
  budgetMs = SEARCH_BUDGET_MS,
  now: () => number = Date.now,
) {
  const needle = query.trim().toLowerCase()
  const start = resolveSafe(root, workspace)
  if (!needle) return { query: needle, path: start, entries: [] as SearchEntry[], truncated: false }
  const entries: SearchEntry[] = []
  const deadline = now() + budgetMs
  let outOfTime = false
  // One match past `limit` proves there are more without walking the rest.
  const full = () => entries.length > limit
  const expired = () => {
    if (!outOfTime && now() >= deadline) outOfTime = true
    return outOfTime
  }

  async function walk(dir: string, depth: number) {
    if (full() || depth > 3 || expired()) return
    let items: Dirent[]
    try {
      items = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of items) {
      if (full() || expired()) return
      if (entry.name.startsWith(".") || SEARCH_SKIP.has(entry.name)) continue
      const path = join(dir, entry.name)
      if (isProtectedPath(path)) continue
      if (entry.name.toLowerCase().includes(needle)) {
        let size = 0
        try {
          size = (await stat(path)).size
        } catch {
          size = 0
        }
        entries.push({ name: entry.name, path, directory: entry.isDirectory(), size })
      }
      if (entry.isDirectory()) await walk(path, depth + 1)
    }
  }

  await walk(start, 0)
  return { query: needle, path: start, entries: entries.slice(0, limit), truncated: full() || outOfTime }
}

export const MODELS = [
  // CLI aliases stay valid across releases; the live list comes from the adapter's list_models.
  { id: "sonnet", label: "Sonnet" },
  { id: "opus", label: "Opus" },
  { id: "haiku", label: "Haiku" },
]

export const SKILLS = [
  { id: "explain", trigger: "$explain", title: "Explain", detail: "Explain the following" },
  { id: "review", trigger: "$review", title: "Review", detail: "Review the following change" },
  { id: "test", trigger: "$test", title: "Test plan", detail: "Write a test plan" },
]
