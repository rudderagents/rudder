// r47: what one turn changed in the workspace. A turn starts and ends with a snapshot of the working tree written
// as a git tree object through a throwaway index, so neither the user's index nor the work tree is touched and new
// untracked files are included (`git stash create` would miss them). `turn.changes` and `turn.diff` compare the two
// trees, which stay fixed after the turn even when the files move on. Outside a git repository the turn's tool diffs
// are summed instead (counts marked `approx`, since agents send truncated texts).
//
// The two trees hold everything written in the folder during the turn, also by another Rudder session, an agent
// outside Rudder, the editor or a git merge. A changed file stays only when this turn's tools account for it
// (`ownFiles`): a tool named it, or its mtime falls in a window when one of the turn's tools was running (agents
// change files only through their tools). A file another session's tool named in an overlapping window is that
// session's. A deleted file has no mtime: it stays when named, or when the turn ran a shell command at all.
import { existsSync } from "node:fs"
import { lstat, realpath, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import type { ToolDiff } from "./adapter/types"
import { sniffImage } from "./image-bytes"
import { asGitOperation, hardenedGit, repoView, resolveSafe, spelledUnder, WORKSPACE_ROOT } from "./workspace"

export type TurnFileStatus = "M" | "A" | "D"

export type TurnFile = {
  /** Relative to the workspace view's root (as `git.status` spells it). */
  path: string
  status: TurnFileStatus
  added: number
  removed: number
  binary: boolean
  /** Size at the end of the turn (at the start for a deleted file). */
  bytes: number
  /** Sizes at the start / end of the turn; absent for an added / deleted side, outside git and before v57. */
  oldBytes?: number
  newBytes?: number
  /** Blob ids at the start / end of the turn; absent for an added / deleted file and outside git. */
  before?: string
  after?: string
}

export type TurnChanges = {
  turnId: string
  sessionId: string
  /** "git": two snapshots. "tools": summed from the turn's tool diffs (no snapshot was possible). */
  source: "git" | "tools"
  root: string
  base?: string
  head?: string
  startedAt: number
  endedAt: number
  files: TurnFile[]
  /** Counts estimated from truncated tool diffs. */
  approx: boolean
  /** Hunks between the two trees, plus one for each binary file (no hunk). */
  edits?: number
  /** Only for `source: "tools"`: the diffs per path, so `turn.diff` can answer without a repository. */
  diffs?: Record<string, ToolDiff[]>
}

/** `skipped`: the untracked files left out as too big (`SNAPSHOT_UNTRACKED_LIMIT`), each as path, size and mtime. */
export type TurnSnapshot = { top: string; root: string; scope: string; tree: string; skipped?: string[] }

/** A file list past this is cut; the totals still count every file. */
export const TURN_FILE_LIMIT = 200
/** `turn.diff` patch cap, the same as `git.diff`. */
export const TURN_PATCH_LIMIT = 64_000
/** An image side bigger than this gets its size only, no preview. */
export const TURN_PREVIEW_LIMIT = 2 * 1024 * 1024
/** Image files the binary page shows as before / after pictures; the bytes are still checked by magic when sent. */
const PREVIEW_EXTENSIONS = /\.(png|jpe?g|gif|webp)$/i
/** A snapshot slower than this is given up; the turn then falls back to tool diffs. */
const SNAPSHOT_TIMEOUT_MS = 5000
/**
 * perf-1112 round two (R6): an untracked file bigger than this stays out of the snapshots (a 300 MB file took 4.9 s
 * to hash and grew `.git` by 288 MB per turn). A turn whose skipped files changed is marked `approx`; a rewind keeps
 * them in place. More than `SNAPSHOT_SKIP_MAX` of them and the snapshot is given up (tool diffs instead).
 */
export const SNAPSHOT_UNTRACKED_LIMIT = 2 * 1024 * 1024
const SNAPSHOT_SKIP_MAX = 200

type Run = { stdout: string; stderr: string; code: number; truncated: boolean }

async function run(argv: string[], options: { env?: Record<string, string>; stdin?: string; limit?: number; timeoutMs?: number } = {}): Promise<Run> {
  const limit = options.limit ?? 16 * 1024 * 1024
  const proc = Bun.spawn(argv, {
    stdout: "pipe",
    stderr: "pipe",
    stdin: options.stdin === undefined ? "ignore" : new Blob([options.stdin]),
    env: options.env ? { ...process.env, ...options.env } : undefined,
  })
  const timer = options.timeoutMs ? setTimeout(() => proc.kill(), options.timeoutMs) : undefined
  try {
    const [out, err] = await Promise.all([readCapped(proc.stdout, limit, () => proc.kill()), new Response(proc.stderr).text()])
    const code = await proc.exited
    return { stdout: out.text, stderr: err, code, truncated: out.over }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function readCapped(stream: ReadableStream<Uint8Array>, limit: number, stop: () => void) {
  const chunks: Uint8Array[] = []
  let size = 0
  let over = false
  for await (const chunk of stream) {
    if (size + chunk.length > limit) {
      chunks.push(chunk.subarray(0, limit - size))
      size = limit
      over = true
      stop()
      break
    }
    chunks.push(chunk)
    size += chunk.length
  }
  let bytes = Buffer.concat(chunks)
  // Never split a UTF-8 sequence at the cut.
  if (over) {
    let end = bytes.length
    while (end > 0 && ((bytes[end - 1] ?? 0) & 0xc0) === 0x80) end--
    if (end > 0 && (bytes[end - 1] ?? 0) >= 0xc0) bytes = bytes.subarray(0, end - 1)
  }
  return { text: bytes.toString("utf8"), over }
}

async function git(args: string[], options: Parameters<typeof run>[1] = {}, okCodes = [0]) {
  const result = await run(await hardenedGit(args), options)
  if (!result.truncated && !okCodes.includes(result.code)) {
    throw Object.assign(new Error(result.stderr.trim() || `git ${args[2] ?? ""} failed`), { code: "git" })
  }
  return result
}

/** Whether `dir` or a parent holds `.git`: checked without spawning git, so a turn outside a repository starts at once. */
export function insideGitRepo(dir: string): boolean {
  let current = resolve(dir)
  for (;;) {
    if (existsSync(join(current, ".git"))) return true
    const parent = dirname(current)
    if (parent === current) return false
    current = parent
  }
}

/**
 * The working tree under the workspace view as a tree object, or null when `cwd` is not in a git repository (or the
 * snapshot failed or took too long; the turn then counts tool diffs). Starts from a copy of the real index so git
 * only rehashes files whose stat changed. The copy keeps the real index's mtime: `copyFile` would stamp the throwaway
 * "now", and `git add -u` would then trust the stat cache for a same-size rewrite whose mtime still matches the index
 * entry once this snapshot runs in a later second (racy-git).
 */
async function snapshotTreeOnce(cwd: string, workspace = WORKSPACE_ROOT): Promise<TurnSnapshot | null> {
  let view: Awaited<ReturnType<typeof repoView>>
  try {
    view = await repoView(resolveSafe(cwd, workspace), workspace)
  } catch {
    return null
  }
  const index = join(tmpdir(), `rudder-turn-${crypto.randomUUID()}.index`)
  try {
    const real = resolve(view.top, (await git(["-C", view.top, "rev-parse", "--git-path", "index"])).stdout.trim())
    const hasIndex = await stat(real).then(() => true, () => false)
    if (hasIndex) {
      // `cp -p` keeps the real index's stamps; `copyFile` would make the throwaway newer than a racy rewrite.
      const copied = await run(["cp", "-p", real, index])
      if (copied.code !== 0) throw Object.assign(new Error(copied.stderr.trim() || "cp index failed"), { code: "git" })
    }
    const env = { GIT_INDEX_FILE: index }
    const timeoutMs = SNAPSHOT_TIMEOUT_MS
    const untracked = await untrackedFiles(view.top, view.scope)
    if (!untracked) return null
    const { big, small } = untracked
    // `add -A` without the big ones: pathspecs are literal (hardenedGit), so the small untracked files are named.
    await git(["-C", view.top, "add", "-u", "--", view.scope || "."], { env, timeoutMs })
    if (small.length > 0) {
      await git(["-C", view.top, "add", "--pathspec-from-file=-", "--pathspec-file-nul"], { env, timeoutMs, stdin: small.join("\0") })
    }
    const tree = (await git(["-C", view.top, "write-tree"], { env, timeoutMs })).stdout.trim()
    if (!/^[0-9a-f]{40,64}$/.test(tree)) return null
    return { ...view, tree, ...(big.length > 0 ? { skipped: big.map((file) => file.sign) } : {}) }
  } catch (error) {
    console.warn(`rudderd: turn snapshot in ${cwd} failed:`, error instanceof Error ? error.message : error)
    return null
  } finally {
    await rm(index, { force: true }).catch(() => undefined)
  }
}
export const snapshotTree = asGitOperation(snapshotTreeOnce)

/**
 * The untracked, not ignored files under `scope`, relative to `top`: `big` ones (over `SNAPSHOT_UNTRACKED_LIMIT`, with
 * a path / size / mtime signature) and the `small` rest. Null when more than `SNAPSHOT_SKIP_MAX` are big or the list
 * is cut.
 */
async function untrackedFiles(top: string, scope: string): Promise<{ big: { path: string; sign: string }[]; small: string[] } | null> {
  const listed = await git(["-C", top, "ls-files", "-o", "--exclude-standard", "-z", "--", scope || "."], { timeoutMs: SNAPSHOT_TIMEOUT_MS })
  if (listed.truncated) return null
  const paths = listed.stdout.split("\0").filter(Boolean)
  const big: { path: string; sign: string }[] = []
  const small: string[] = []
  for (let start = 0; start < paths.length; start += 64) {
    const batch = paths.slice(start, start + 64)
    const infos = await Promise.all(batch.map((path) => lstat(join(top, path)).catch(() => undefined)))
    for (const [offset, info] of infos.entries()) {
      const path = batch[offset]!
      if (info?.isFile() && info.size > SNAPSHOT_UNTRACKED_LIMIT) big.push({ path, sign: `${path}\0${info.size}\0${info.mtimeMs}` })
      else small.push(path)
    }
    if (big.length > SNAPSHOT_SKIP_MAX) return null
  }
  return { big, small }
}

/** Whether a file left out of the end snapshot was new or changed since the start one: its line counts are unknown. */
export function skippedChanged(start: TurnSnapshot, end: TurnSnapshot): boolean {
  const before = new Set(start.skipped ?? [])
  return (end.skipped ?? []).some((sign) => !before.has(sign))
}

/** The files left out of either snapshot that the turn added, changed or removed, listed by size only. */
function skippedFiles(start: TurnSnapshot, end: TurnSnapshot): TurnFile[] {
  const parse = (signs: string[] | undefined) =>
    new Map((signs ?? []).map((sign) => {
      const [path = "", size = "0"] = sign.split("\0")
      return [path, { sign, size: Number(size) }] as const
    }))
  const before = parse(start.skipped)
  const after = parse(end.skipped)
  const prefix = start.scope ? `${start.scope}/` : ""
  const files: TurnFile[] = []
  const file = (path: string, status: TurnFileStatus, bytes: number, sides: { oldBytes?: number; newBytes?: number }): TurnFile => ({
    path: prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path,
    status,
    added: 0,
    removed: 0,
    binary: true,
    bytes,
    ...sides,
  })
  for (const [path, now] of after) {
    const was = before.get(path)
    if (was?.sign === now.sign) continue
    files.push(file(path, was ? "M" : "A", now.size, was ? { oldBytes: was.size, newBytes: now.size } : { newBytes: now.size }))
  }
  // Gone at the end, and not because it shrank into the snapshot.
  for (const [path, was] of before) {
    if (!after.has(path) && !existsSync(join(start.top, path))) files.push(file(path, "D", was.size, { oldBytes: was.size }))
  }
  return files
}

/** A gitignore pattern matching exactly `path` (relative to the repository top). */
function exactPattern(path: string): string {
  return `/${path.replace(/[\\*?[\]!# ]/g, (char) => `\\${char}`)}`
}

/** Parses `git diff --raw -z --no-abbrev`: `:old new oldsha newsha S\0path\0`. */
export function parseRaw(out: string) {
  const entries: { path: string; status: TurnFileStatus; before?: string; after?: string }[] = []
  const tokens = out.split("\0")
  const zero = /^0+$/
  for (let i = 0; i < tokens.length; i++) {
    const head = tokens[i]
    if (!head?.startsWith(":")) continue
    const path = tokens[++i]
    if (path === undefined) break
    const [, , oldSha = "", newSha = "", code = "M"] = head.slice(1).split(" ")
    const status: TurnFileStatus = code.startsWith("A") ? "A" : code.startsWith("D") ? "D" : "M"
    entries.push({
      path,
      status,
      ...(zero.test(oldSha) ? {} : { before: oldSha }),
      ...(zero.test(newSha) ? {} : { after: newSha }),
    })
  }
  return entries
}

async function blobSizes(top: string, ids: string[]): Promise<Map<string, number>> {
  const sizes = new Map<string, number>()
  if (ids.length === 0) return sizes
  const { stdout } = await git(["-C", top, "cat-file", "--batch-check"], { stdin: `${ids.join("\n")}\n` })
  for (const line of stdout.split("\n")) {
    const [id, type, size] = line.split(" ")
    if (id && type === "blob" && size) sizes.set(id, Number(size))
  }
  return sizes
}

/**
 * The tree a rewind should put the folder back to: the start of the first removed turn that has a git snapshot.
 * A removed turn that changed files without a snapshot blocks the restore. Putting the folder back would leave
 * that turn's edits in place and look like a full undo.
 */
export function snapshotToRestore(changes: TurnChanges[]): string | null {
  for (const change of changes) {
    if (change.source === "tools") return null
    if (change.source === "git" && change.base) return change.base
  }
  return null
}

/**
 * Makes the workspace match `tree` (a snapshot from `snapshotTree`). Ignored files and untracked files too big for a
 * snapshot stay. Anything else that appeared under the workspace after that snapshot is removed. Returns false when
 * the tree is gone (or there are too many big untracked files to keep).
 */
async function restoreWorktreeOnce(cwd: string, tree: string, workspace = WORKSPACE_ROOT): Promise<boolean> {
  let view: Awaited<ReturnType<typeof repoView>>
  try {
    view = await repoView(resolveSafe(cwd, workspace), workspace)
  } catch {
    return false
  }
  const exists = await git(["-C", view.top, "cat-file", "-e", `${tree}^{tree}`], {}, [0, 1])
  if (exists.code !== 0) return false
  const spec = view.scope || "."
  // Read before the restore: a big untracked file was never in a snapshot, so the clean below must not remove it.
  const untracked = await untrackedFiles(view.top, view.scope)
  if (!untracked) return false
  await git(["-C", view.top, "restore", "--source", tree, "--worktree", "--staged", "--", spec])
  await git(["-C", view.top, "clean", "-fd", ...untracked.big.flatMap((file) => ["-e", exactPattern(file.path)]), "--", spec])
  return true
}
export const restoreWorktree = asGitOperation(restoreWorktreeOnce)

/** Files changed between the two snapshots, relative to the workspace view's root. */
async function diffSnapshotsOnce(start: TurnSnapshot, end: TurnSnapshot): Promise<TurnFile[]> {
  const scope = start.scope ? ["--", start.scope] : []
  const [raw, numstat] = await Promise.all([
    git(["-C", start.top, "diff", "--raw", "-z", "--no-abbrev", "--no-renames", start.tree, end.tree, ...scope]),
    git(["-C", start.top, "diff", "--numstat", "-z", "--no-renames", start.tree, end.tree, ...scope]),
  ])
  const counts = new Map<string, { added: number; removed: number; binary: boolean }>()
  for (const record of numstat.stdout.split("\0")) {
    const [added, removed, ...rest] = record.split("\t")
    if (added === undefined || removed === undefined || rest.length === 0) continue
    counts.set(rest.join("\t"), added === "-" ? { added: 0, removed: 0, binary: true } : { added: Number(added), removed: Number(removed), binary: false })
  }
  const entries = parseRaw(raw.stdout)
  const sizes = await blobSizes(start.top, entries.flatMap((entry) => [entry.before, entry.after]).filter((id): id is string => !!id))
  const prefix = start.scope ? `${start.scope}/` : ""
  const files: TurnFile[] = entries.map((entry) => {
    const count = counts.get(entry.path) ?? { added: 0, removed: 0, binary: false }
    return {
      ...entry,
      path: prefix && entry.path.startsWith(prefix) ? entry.path.slice(prefix.length) : entry.path,
      ...count,
      bytes: sizes.get(entry.after ?? entry.before ?? "") ?? 0,
      ...(entry.before && sizes.has(entry.before) ? { oldBytes: sizes.get(entry.before) } : {}),
      ...(entry.after && sizes.has(entry.after) ? { newBytes: sizes.get(entry.after) } : {}),
    }
  })
  // A file that crossed the size limit is in one tree only: git sees it added or deleted, the skipped list the rest.
  const byPath = new Map(files.map((file) => [file.path, file]))
  const sizeOnly = new Map((start.skipped ?? []).map((sign) => [sign.split("\0")[0] ?? "", Number(sign.split("\0")[1])]))
  for (const file of files) {
    const was = sizeOnly.get(prefix + file.path)
    if (file.status === "A" && was !== undefined) Object.assign(file, { status: "M", oldBytes: was, before: undefined })
  }
  for (const skipped of skippedFiles(start, end)) {
    const tracked = byPath.get(skipped.path)
    if (!tracked) files.push(skipped)
    else if (tracked.status === "D" && skipped.status === "A") Object.assign(tracked, { status: "M", bytes: skipped.bytes, newBytes: skipped.bytes, binary: true, added: 0, removed: 0 })
  }
  return files
}
export const diffSnapshots = asGitOperation(diffSnapshotsOnce)

/** Line counts of one tool diff: a patch's +/- lines, or old / new texts compared line by line. */
export async function countToolDiff(diff: ToolDiff): Promise<{ added: number; removed: number }> {
  if (diff.patch !== undefined) {
    let added = 0
    let removed = 0
    for (const line of diff.patch.split("\n")) {
      if (line.startsWith("+++") || line.startsWith("---")) continue
      if (line.startsWith("+")) added++
      else if (line.startsWith("-")) removed++
    }
    return { added, removed }
  }
  const before = diff.oldText ? diff.oldText.split("\n") : []
  const after = diff.newText ? diff.newText.split("\n") : []
  const common = await commonLines(before, after)
  return { added: after.length - common, removed: before.length - common }
}

// The common ends are already in the LCS. Long changed interiors use one row and give the socket loop time.
async function commonLines(a: string[], b: string[]): Promise<number> {
  let start = 0
  let aEnd = a.length
  let bEnd = b.length
  while (start < aEnd && start < bEnd && a[start] === b[start]) start++
  let fixed = start
  while (aEnd > start && bEnd > start && a[aEnd - 1] === b[bEnd - 1]) {
    aEnd--
    bEnd--
    fixed++
  }
  if (aEnd === start || bEnd === start) return fixed

  const width = bEnd - start
  const row = new Uint32Array(width + 1)
  let remaining = 32_768
  for (let i = start; i < aEnd; i++) {
    let diagonal = 0
    for (let j = 1; j <= width; j++) {
      const above = row[j]!
      row[j] = a[i] === b[start + j - 1] ? diagonal + 1 : Math.max(above, row[j - 1]!)
      diagonal = above
      if (--remaining === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve))
        remaining = 32_768
      }
    }
  }
  return fixed + row[width]!
}

/** The fallback outside git: one entry per path the turn's edit tools touched. */
export async function summarizeToolDiffs(diffs: Map<string, ToolDiff[]>, root: string): Promise<{ files: TurnFile[]; approx: boolean }> {
  const files: TurnFile[] = []
  let approx = false
  for (const [path, list] of diffs) {
    let added = 0
    let removed = 0
    for (const diff of list) {
      const count = await countToolDiff(diff)
      added += count.added
      removed += count.removed
      if (diff.truncated) approx = true
    }
    const first = list[0]
    const last = list[list.length - 1]
    const status: TurnFileStatus = first && !first.oldText && first.patch === undefined ? "A" : last && last.newText === "" && last.patch === undefined ? "D" : "M"
    const rel = path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path
    files.push({ path: rel, status, added, removed, binary: false, bytes: Buffer.byteLength(last?.newText ?? "") })
  }
  return { files, approx }
}

/** Hunks in a unified diff (`@@`), plus one edit for each binary file the two trees disagree on. */
export function editsInTurn(diff: string, files: { binary: boolean }[]) {
  const hunks = diff.split("\n").filter((line) => line.startsWith("@@ ")).length
  return hunks + files.filter((file) => file.binary).length
}

/** `paths` (repository-relative) limits the count to those files; absent counts the whole difference. */
export async function countTreeEdits(top: string, base: string, head: string, files: TurnFile[], paths?: string[]) {
  const spec = paths ? ["--", ...paths] : []
  const { stdout } = await git(["-C", top, "diff", "--no-color", "--no-ext-diff", base, head, ...spec])
  return editsInTurn(stdout, files)
}

/** A span when one of a turn's tools ran; `end` is absent while it still runs. */
export type ToolWindow = { start: number; end?: number }
/** Slack either side of a tool window for an mtime: events reach rudderd a little after the write. */
export const TOOL_WINDOW_SLACK_MS = 2000

/** The real path, or the real parent plus the name for a file that is gone. */
export async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    try {
      return join(await realpath(dirname(path)), basename(path))
    } catch {
      return resolve(path)
    }
  }
}

/**
 * The files of `diffSnapshots` this turn's tools account for (see the header). `named` and `others` are canonical
 * absolute paths: named by this turn's tools / by another session's tools while this turn ran.
 */
export async function ownFiles(
  files: TurnFile[],
  snapshot: TurnSnapshot,
  turn: { windows: ToolWindow[]; named: Set<string>; others: Set<string>; shell: boolean; endedAt: number },
): Promise<TurnFile[]> {
  const kept: TurnFile[] = []
  for (const file of files) {
    const path = join(snapshot.top, snapshot.scope, file.path)
    if (turn.named.has(path)) {
      kept.push(file)
      continue
    }
    if (turn.others.has(path)) continue
    if (file.status === "D") {
      if (turn.shell) kept.push(file)
      continue
    }
    const mtime = await lstat(path).then((info) => info.mtimeMs, () => undefined)
    if (mtime === undefined) continue
    const inside = turn.windows.some(
      (window) => mtime >= window.start - TOOL_WINDOW_SLACK_MS && mtime <= (window.end ?? turn.endedAt) + TOOL_WINDOW_SLACK_MS,
    )
    if (inside) kept.push(file)
  }
  return kept
}

export function changesTotals(files: TurnFile[]) {
  return files.reduce((sum, file) => ({ files: sum.files + 1, added: sum.added + file.added, removed: sum.removed + file.removed }), { files: 0, added: 0, removed: 0 })
}

/** The turn-end file, from the recorded blob. The worktree is not read: it may have moved on. */
async function headBlob(root: string, id: string | undefined): Promise<string | undefined> {
  if (!id) return undefined
  try {
    const { stdout } = await git(["-C", root, "cat-file", "blob", id], { limit: 256_000 })
    return stdout
  } catch {
    return undefined
  }
}

/** One file's patch between the two snapshots, capped at 64 KB. `snapshot` is the file at the end of the turn. */
async function snapshotPatchOnce(changes: TurnChanges, path: string, workspace = WORKSPACE_ROOT) {
  const file = changes.files.find((entry) => entry.path === path)
  if (!file) throw Object.assign(new Error("file not changed in this turn"), { code: "not_found" })
  // Same rule as git.diff: a dot file's name may be listed, its content is not sent.
  resolveSafe(resolve(spelledUnder(changes.root, workspace), path), workspace)
  if (changes.source === "tools") {
    const diffs = changes.diffs?.[path] ?? []
    const bytes = diffs.reduce((sum, diff) => sum + Buffer.byteLength(diff.patch ?? "") + Buffer.byteLength(diff.newText ?? "") + Buffer.byteLength(diff.oldText ?? ""), 0)
    const snapshot = [...diffs].reverse().find((diff) => typeof diff.newText === "string")?.newText
    return { turnId: changes.turnId, path, diffs, patch: undefined, truncated: diffs.some((diff) => diff.truncated === true), binary: false, bytes: file.bytes || bytes, ...(snapshot !== undefined ? { snapshot } : {}) }
  }
  if (file.binary) return { turnId: changes.turnId, path, diffs: [], truncated: false, binary: true, bytes: file.bytes }
  const { stdout, truncated } = await git(
    ["-C", changes.root, "diff", "--relative", "--no-renames", changes.base ?? "", changes.head ?? "", "--", path],
    { limit: TURN_PATCH_LIMIT },
  )
  const snapshot = await headBlob(changes.root, file.after)
  return {
    turnId: changes.turnId, path, diffs: [{ path, patch: stdout, ...(truncated ? { truncated: true } : {}) }],
    patch: stdout, truncated, binary: false, bytes: file.bytes, ...(snapshot !== undefined ? { snapshot } : {}),
  }
}
export const snapshotPatch = asGitOperation(snapshotPatchOnce)

/**
 * Whether each file still looks the way the turn left it: `same`, `changed` (edited since, with the time), or
 * `reverted` (back to how it was before the turn). Only for git turns; tool-diff turns have no blob ids.
 */
async function currentStatesOnce(changes: TurnChanges): Promise<Map<string, { current: "same" | "changed" | "reverted"; changedAt?: number }>> {
  const states = new Map<string, { current: "same" | "changed" | "reverted"; changedAt?: number }>()
  if (changes.source !== "git") return states
  const files = changes.files.slice(0, TURN_FILE_LIMIT)
  const present: { file: TurnFile; abs: string; mtime: number }[] = []
  for (const file of files) {
    const abs = resolve(changes.root, file.path)
    const info = await stat(abs).catch(() => null)
    if (!info?.isFile()) {
      states.set(file.path, file.status === "D" ? { current: "same" } : file.before ? { current: "changed" } : { current: "reverted" })
      continue
    }
    present.push({ file, abs, mtime: info.mtimeMs })
  }
  if (present.length === 0) return states
  // In the workspace's repository (review3-1117): without -C, git took the daemon's cwd, which launchd puts inside the
  // rudder checkout, so that repository's attributes and filter drivers hashed (and ran on) the workspace's files.
  // With -C it is a `hardenedGit` command like the snapshot's `git add`: the same attributes and eol rules apply, and
  // the workspace's own filter drivers are neutralized with overrides read right before it.
  const { stdout } = await git(["-C", changes.root, "hash-object", "--stdin-paths"], { stdin: `${present.map((entry) => entry.abs).join("\n")}\n` }, [0, 128])
  const ids = stdout.split("\n")
  present.forEach((entry, index) => {
    const id = ids[index]?.trim()
    if (!id) return
    if (id === entry.file.after) states.set(entry.file.path, { current: "same" })
    else if (id === entry.file.before) states.set(entry.file.path, { current: "reverted", changedAt: Math.round(entry.mtime) })
    else states.set(entry.file.path, { current: "changed", changedAt: Math.round(entry.mtime) })
  })
  return states
}
export const currentStates = asGitOperation(currentStatesOnce)

/** Which sides of a binary image the phone may fetch (`preview` on a `turn.changes` file); sides past 2 MB only show a size. */
export function previewSides(file: TurnFile): { before?: true; after?: true } | undefined {
  if (!file.binary || !PREVIEW_EXTENSIONS.test(file.path)) return undefined
  const fits = (id: string | undefined, bytes: number | undefined) => !!id && bytes !== undefined && bytes <= TURN_PREVIEW_LIMIT
  const sides = {
    ...(fits(file.before, file.oldBytes) ? { before: true as const } : {}),
    ...(fits(file.after, file.newBytes) ? { after: true as const } : {}),
  }
  return sides.before || sides.after ? sides : undefined
}

/**
 * One side of a binary image as the turn left it: the blob from the start / end snapshot, ≤ 2 MB and PNG / JPEG / GIF /
 * WebP by magic. Null when the turn, file or side is not there (the phone then shows 「没存下」).
 */
export async function snapshotImage(changes: TurnChanges, path: string, side: "before" | "after", workspace = WORKSPACE_ROOT): Promise<{ data: Uint8Array; mediaType: string } | null> {
  const file = changes.files.find((entry) => entry.path === path)
  if (!file || changes.source !== "git" || !previewSides(file)?.[side]) return null
  // Same rule as turn.diff: a dot file's content is not sent.
  resolveSafe(resolve(spelledUnder(changes.root, workspace), path), workspace)
  const id = side === "before" ? file.before : file.after
  if (!id) return null
  const proc = Bun.spawn(await hardenedGit(["-C", changes.root, "cat-file", "blob", id]), { stdout: "pipe", stderr: "ignore", stdin: "ignore" })
  // Read one byte past the cap at most: a multi-gigabyte blob is refused without being held in memory.
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of proc.stdout) {
    chunks.push(chunk)
    size += chunk.byteLength
    if (size > TURN_PREVIEW_LIMIT) {
      proc.kill()
      await proc.exited
      return null
    }
  }
  const data = new Uint8Array(Buffer.concat(chunks))
  if ((await proc.exited) !== 0) return null
  const sniffed = sniffImage(data)
  return sniffed ? { data, mediaType: sniffed.mediaType } : null
}

/** What the phone gets for `turn.changes`; blob ids and the snapshot trees stay on the computer. */
export function changesPublic(changes: TurnChanges, states?: Map<string, { current: string; changedAt?: number }>) {
  return {
    turnId: changes.turnId,
    sessionId: changes.sessionId,
    // Paths are relative to it; the phone opens a file's current version with it (⑭ 看电脑上现在的版本).
    root: changes.root,
    startedAt: changes.startedAt,
    endedAt: changes.endedAt,
    approx: changes.approx,
    edits: changes.edits ?? 0,
    totals: changesTotals(changes.files),
    files: changes.files.slice(0, TURN_FILE_LIMIT).map(({ before, after, ...file }) => {
      const preview = previewSides({ ...file, before, after })
      return { ...file, ...(preview ? { preview } : {}), ...(states?.get(file.path) ?? {}) }
    }),
    filesTruncated: changes.files.length > TURN_FILE_LIMIT,
  }
}
