import { constants } from "node:fs"
import { lstat, mkdir, open, readdir, realpath, rm, writeFile } from "node:fs/promises"
import { basename, isAbsolute, join, relative } from "node:path"
import { jpegOrientation, sniffImage } from "./image-bytes"

/** One upload; the same cap HAPI uses. */
export const ATTACHMENT_LIMIT_BYTES = 50 * 1024 * 1024
const NAME_MAX_CHARS = 120
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export type Attachment = {
  id: string
  name: string
  /** Absolute path on this computer: what the agent is told to read. */
  path: string
  bytes: number
  /** An image's pixel size from its header (PNG / JPEG / GIF / WebP), so the phone lays a photo out before its bytes arrive. */
  width?: number
  height?: number
}

/** Enough of a file's head for any JPEG's SOF: EXIF (APP1) alone may take 64 KB. */
const IMAGE_HEAD_BYTES = 256 * 1024

function sized(bytes: Uint8Array): { width: number; height: number } | Record<string, never> {
  const image = sniffImage(bytes)
  if (!image) return {}
  // The phone draws a photo upright, so a quarter-turned one (EXIF 5–8) is laid out height × width.
  return jpegOrientation(bytes) >= 5 ? { width: image.height, height: image.width } : { width: image.width, height: image.height }
}

/** The fields a message carries for one attachment: never the path. */
export function attachmentPublic({ id, name, bytes, width, height }: Attachment) {
  return { id, name, bytes, ...(width && height ? { width, height } : {}) }
}

/**
 * `<cwd>/.rudder/attachments/<sessionId>/`: inside the session's working directory so every agent may read it, under a
 * dot directory so the phone's file browser and search never list it, and ignored by git (`.rudder/.gitignore`).
 */
export function attachmentDir(cwd: string, sessionId: string): string {
  return join(cwd, ".rudder", "attachments", sessionId)
}

/** The file name as uploaded, reduced to a safe single path segment. */
export function safeName(raw: string): string {
  const cleaned = basename(raw.replaceAll("\\", "/"))
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this strips
    .replace(/[\u0000-\u001f\u007f/:]/g, "")
    .trim()
  const name = cleaned === "." || cleaned === ".." ? "" : cleaned.replace(/^\.+/, "")
  const chars = [...(name || "file")]
  return chars.length <= NAME_MAX_CHARS ? chars.join("") : chars.slice(chars.length - NAME_MAX_CHARS).join("")
}

export function tooLarge(): Error {
  return Object.assign(new Error(`attachment exceeds ${ATTACHMENT_LIMIT_BYTES / 1024 / 1024} MB`), { code: "too_large" })
}

/**
 * Whether `attachmentDir` is that very folder inside `cwd`'s real path. An agent can write the session folder: with
 * `.rudder`, `attachments` or the session's own folder a symlink, uploads would land, and be served from, elsewhere.
 */
async function attachmentDirConfined(cwd: string, sessionId: string): Promise<boolean> {
  const [realCwd, realDir] = await Promise.all([realpath(cwd).catch(() => null), realpath(attachmentDir(cwd, sessionId)).catch(() => null)])
  return realCwd !== null && realDir === attachmentDir(realCwd, sessionId)
}

export async function saveAttachment(cwd: string, sessionId: string, name: string, data: Uint8Array): Promise<Attachment> {
  if (data.byteLength > ATTACHMENT_LIMIT_BYTES) throw tooLarge()
  const root = join(cwd, ".rudder")
  // One level at a time, so a symlinked level is refused before any folder is made through it.
  let dir = cwd
  for (const part of [".rudder", "attachments", sessionId]) {
    dir = join(dir, part)
    await mkdir(dir, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error
    })
    if (!(await lstat(dir)).isDirectory()) throw fileError("the attachments folder leads outside the session folder", "forbidden")
  }
  if (!(await attachmentDirConfined(cwd, sessionId))) throw fileError("the attachments folder leads outside the session folder", "forbidden")
  // `*` ignores the whole directory, this file included, so attachments never show up as untracked changes.
  await writeFile(join(root, ".gitignore"), "*\n", { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error
  })
  const id = crypto.randomUUID()
  const file = safeName(name)
  const path = join(attachmentDir(cwd, sessionId), `${id}-${file}`)
  // `wx`: a fresh name, never through a link planted there.
  await writeFile(path, data, { mode: 0o600, flag: "wx" })
  return { id, name: file, path, bytes: data.byteLength, ...sized(data.subarray(0, IMAGE_HEAD_BYTES)) }
}

/** An earlier upload of this session by id; null for an unknown or malformed id. */
export async function findAttachment(cwd: string, sessionId: string, id: string): Promise<Attachment | null> {
  if (!UUID.test(id) || !(await attachmentDirConfined(cwd, sessionId))) return null
  const dir = attachmentDir(cwd, sessionId)
  const entries = await readdir(dir).catch(() => [] as string[])
  const entry = entries.find((name) => name.startsWith(`${id}-`))
  if (!entry) return null
  const path = join(dir, entry)
  // A running agent can write this directory: a symlink or anything but a plain file is not an upload. A hard link
  // is a plain file too, so an upload, written once here, must also have no other name.
  const info = await lstat(path).catch(() => null)
  if (!info?.isFile() || info.nlink !== 1) return null
  return { id, name: entry.slice(id.length + 1), path, bytes: info.size, ...(await headSize(path)) }
}

/**
 * The plain files among this session's saved attachments whose id has metadata: path, size and metadata by id. Empty when the
 * folder is missing or leads outside the session folder, so nothing is ever looked up (or removed) through a link.
 */
export async function attachmentFiles<T>(
  cwd: string,
  sessionId: string,
  getMetadata: (id: string) => T | null,
): Promise<Map<string, { path: string; bytes: number; metadata: T }>> {
  const found = new Map<string, { path: string; bytes: number; metadata: T }>()
  if (!(await attachmentDirConfined(cwd, sessionId))) return found
  const dir = attachmentDir(cwd, sessionId)
  for (const entry of await readdir(dir).catch(() => [] as string[])) {
    const id = entry.slice(0, 36)
    if (entry[36] !== "-" || found.has(id)) continue
    const metadata = getMetadata(id)
    if (metadata === null) continue
    const path = join(dir, entry)
    const info = await lstat(path).catch(() => null)
    if (info?.isFile()) found.set(id, { path, bytes: info.size, metadata })
  }
  return found
}

/** The pixel size from the first bytes of a saved upload; nothing for other files or when it cannot be read. */
async function headSize(path: string): Promise<{ width: number; height: number } | Record<string, never>> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null)
  if (!handle) return {}
  try {
    const buffer = new Uint8Array(IMAGE_HEAD_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0)
    return sized(buffer.subarray(0, bytesRead))
  } catch {
    return {}
  } finally {
    await handle.close()
  }
}

function fileError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code })
}

/**
 * Reads a plain file of at most `limit` bytes. Symlinks are refused (the last segment by lstat and O_NOFOLLOW; the
 * rest by requiring the real path to stay inside one of `roots`, when given). The size is enforced on the bytes read,
 * not on an earlier stat, so a file that grows after the check still fails. `singleLink` also refuses a hard link,
 * whose real path is inside while the same file is reachable from anywhere. Error codes: not_found, not_file,
 * outside, too_large.
 */
export async function readPlainFile(path: string, limit: number, roots?: string[], singleLink = false): Promise<Uint8Array> {
  const handle = await openPlainFile(path, roots, singleLink)
  try {
    const opened = await handle.stat()
    if (opened.size > limit) throw tooLargeFor(limit)
    // One byte over the cap is enough to know it is too large.
    const buffer = new Uint8Array(Math.min(opened.size, limit) + 1)
    let length = 0
    while (length < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, length, buffer.byteLength - length, null)
      if (bytesRead === 0) break
      length += bytesRead
    }
    if (length > limit) throw tooLargeFor(limit)
    if (length > opened.size) throw fileError(`${basename(path)} grew while reading`, "not_file")
    return buffer.subarray(0, length)
  } finally {
    await handle.close()
  }
}

/**
 * One window of a plain file, under the same checks as `readPlainFile`: only `length` bytes from `offset` are read, so
 * a phone pulling a 50 MB attachment in 512 KB windows does not make every window read the whole file. `bytes` is the
 * file's size. The offset is clamped by the caller's validation against `bytes` (see `sliceWindow`).
 */
export async function readPlainWindow(
  path: string,
  limit: number,
  window: (bytes: number) => { start: number; end: number },
  roots?: string[],
  singleLink = false,
): Promise<{ bytes: number; offset: number; data: Uint8Array }> {
  const handle = await openPlainFile(path, roots, singleLink)
  try {
    const opened = await handle.stat()
    if (opened.size > limit) throw tooLargeFor(limit)
    const { start, end } = window(opened.size)
    const buffer = new Uint8Array(end - start)
    let length = 0
    while (length < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, length, buffer.byteLength - length, start + length)
      if (bytesRead === 0) break
      length += bytesRead
    }
    return { bytes: opened.size, offset: start, data: buffer.subarray(0, length) }
  } finally {
    await handle.close()
  }
}

async function openPlainFile(path: string, roots: string[] | undefined, singleLink: boolean) {
  const info = await lstat(path).catch(() => null)
  if (!info) throw fileError(`${basename(path)} not found`, "not_found")
  if (!info.isFile()) throw fileError(`${basename(path)} is not a plain file`, "not_file")
  if (roots) {
    const real = await realpath(path)
    const realRoots = await Promise.all(roots.map((root) => realpath(root).catch(() => null)))
    const inside = realRoots.some((root) => {
      if (!root) return false
      const rel = relative(root, real)
      return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)
    })
    if (!inside) throw fileError(`${basename(path)} is outside the allowed folders`, "outside")
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: NodeJS.ErrnoException) => {
    throw fileError(`${basename(path)} could not be opened: ${error.code ?? error.message}`, error.code === "ELOOP" ? "not_file" : "not_found")
  })
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev) throw fileError(`${basename(path)} changed while opening`, "not_file")
    if (singleLink && opened.nlink !== 1) throw fileError(`${basename(path)} has other names`, "not_file")
    return handle
  } catch (error) {
    await handle.close()
    throw error
  }
}

function tooLargeFor(limit: number): Error {
  return limit === ATTACHMENT_LIMIT_BYTES ? tooLarge() : fileError(`file exceeds ${limit} bytes`, "too_large")
}

export async function removeAttachments(cwd: string, sessionId: string) {
  await rm(attachmentDir(cwd, sessionId), { recursive: true, force: true })
}

/** What the agent receives: the user's text, then the attached files' paths for its own tools to open. */
export function withAttachments(text: string, attachments: Attachment[]): string {
  if (attachments.length === 0) return text
  const lines = attachments.map((attachment) => `- ${attachment.path}`)
  const note = `Attached files (on this computer):\n${lines.join("\n")}`
  return text.trim() ? `${text}\n\n${note}` : note
}
