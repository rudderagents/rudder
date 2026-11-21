/**
 * r75 §2.1: files the agent mentions, read from the session's working directory for the phone. `file.stat`,
 * `file.thumb`, `file.get` (the `attachment.get` slice shape) and `file.ship` (encrypt and PUT to the relay Worker's
 * blob lane), plus `attachment.fetch` (the reverse: a phone's encrypted upload pulled from the blob lane and saved as
 * an attachment). A path must stay inside the session's cwd after realpath, so neither `..` nor a symlink leaves it.
 * Thumbnails and screen-size copies come from macOS `qlmanage` / `sips`; elsewhere they answer `unsupported`.
 */
import { createCipheriv, createDecipheriv, createHash } from "node:crypto"
import { constants } from "node:fs"
import { mkdir, open, readdir, realpath, rename, rm, stat, utimes } from "node:fs/promises"
import { basename, extname, isAbsolute, join, relative } from "node:path"
import { ATTACHMENT_LIMIT_BYTES, findAttachment } from "./attachments"
import { imageMagic } from "./image-bytes"
import { copyError, phoneCopy } from "./phone-copy"
import { RELAY_ATTACHMENT_CHUNK_BYTES, RELAY_ATTACHMENT_SEND_BYTES } from "./relay-attachment"
import { assertNotProtected, hasHiddenSegment } from "./workspace"

export const FILE_LIMIT_BYTES = ATTACHMENT_LIMIT_BYTES
export const THUMB_MAX_EDGE = 360
export const THUMB_MAX_BYTES = 64 * 1024
export const SCREEN_MAX_EDGE = 2048
export const THUMB_CACHE_BYTES = 200 * 1024 * 1024
const TOOL_TIMEOUT_MS = 15_000
const SHIPPED_TTL_MS = 10 * 60 * 1000
const BLOB_ID = /^[A-Za-z0-9_-]{16,64}$/

export type FileKind = "image" | "pdf" | "video" | "other"
export type FileVariant = "original" | "screen"

export type FileStat = {
  name: string
  size: number
  mediaType: string
  kind: FileKind
  mtimeMs: number
  width?: number
  height?: number
  durationMs?: number
}

/** One run of an outside tool: argv, a timeout, and what it printed. Tests swap it for a fake. */
export type ToolRunner = (argv: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; timedOut: boolean }>

export type FileServiceOptions = {
  /** `RUDDER_HOME/thumbs`: thumbnails and screen-size copies. */
  cacheDir: string
  /** Base of the blob lane, e.g. `https://api.rudderagents.com`. */
  blobBase: string
  platform?: string
  fetch?: typeof fetch
  run?: ToolRunner
  cacheLimitBytes?: number
}

const MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".bmp": "image/bmp",
  ".pdf": "application/pdf",
  ".mov": "video/quicktime",
  ".mp4": "video/mp4",
  ".m4v": "video/x-m4v",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
  ".html": "text/html",
  ".zip": "application/zip",
}

export function mediaTypeOf(name: string): string {
  return MEDIA_TYPES[extname(name).toLowerCase()] ?? "application/octet-stream"
}

export function kindOf(mediaType: string): FileKind {
  if (mediaType.startsWith("image/")) return "image"
  if (mediaType === "application/pdf") return "pdf"
  if (mediaType.startsWith("video/")) return "video"
  return "other"
}

export function fail(message: string, code: string): Error {
  return Object.assign(new Error(message), { code })
}

/**
 * `input` relative to `cwd`, or absolute; the real path must be a plain file inside the real `cwd`. Errors:
 * not_found, forbidden (outside, through a symlink or `..`, or through a hidden segment), not_file.
 * Hidden (dot) files and folders are refused on both spellings, as `resolveSafe` does: a session folder is often the
 * home folder, and `.ssh` / `.env` must not reach the phone. The one exception is a picture: a file whose first bytes
 * are PNG / JPEG / GIF / WebP may be read from a hidden folder (agents keep screenshots under `.claude/`, `.codex/`),
 * because those formats carry no keys. Protected paths stay refused either way. `allowHidden` is for the daemon's own
 * attachment paths under `.rudder/`, which the phone names by id, never by path.
 */
export async function resolveInside(cwd: string, input: string, options: { allowHidden?: boolean } = {}): Promise<string> {
  if (!input || input.includes("\0")) throw fail("path required", "invalid")
  const root = await realpath(cwd).catch(() => null)
  if (!root) throw fail("session folder not found", "not_found")
  const candidate = isAbsolute(input) ? input : join(cwd, input)
  const real = await realpath(candidate).catch((error: NodeJS.ErrnoException) => {
    throw error.code === "ENOENT" || error.code === "ENOTDIR" ? fail(`${basename(input)} not found`, "not_found") : fail(error.message, "not_found")
  })
  const rel = relative(root, real)
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw fail(`${basename(input)} is outside the session folder`, "forbidden")
  const hidden = !options.allowHidden && (hasHiddenSegment(rel) || hasHiddenSegment(relative(cwd, candidate)))
  assertNotProtected([candidate, real])
  const info = await stat(real)
  if (hidden && !(info.isFile() && (await startsAsImage(real)))) throw copyError(phoneCopy.hiddenPath(), { code: "forbidden" })
  if (!info.isFile()) throw fail(`${basename(input)} is not a plain file`, "not_file")
  return real
}

async function startsAsImage(path: string): Promise<boolean> {
  const handle = await open(path, constants.O_RDONLY).catch(() => null)
  if (!handle) return false
  try {
    const head = new Uint8Array(12)
    const { bytesRead } = await handle.read(head, 0, head.length, 0)
    return imageMagic(head.subarray(0, bytesRead)) !== null
  } finally {
    await handle.close()
  }
}

const defaultRun: ToolRunner = async (argv, timeoutMs) => {
  const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: timeoutMs, killSignal: "SIGKILL" })
  const stdout = await new Response(proc.stdout).text()
  const code = await proc.exited
  return { code, stdout, timedOut: proc.signalCode === "SIGKILL" }
}

/** `sips -g pixelWidth -g pixelHeight` output → dimensions. */
export function parseSipsSize(stdout: string): { width: number; height: number } | null {
  const width = Number(/pixelWidth:\s*(\d+)/.exec(stdout)?.[1])
  const height = Number(/pixelHeight:\s*(\d+)/.exec(stdout)?.[1])
  return width > 0 && height > 0 ? { width, height } : null
}

/** `singleLink`: an upload, which must not be a hard link to some other file (checked again on the open handle). */
type Located = { path: string; name: string; singleLink?: boolean }
type ShippedFetch = { at: number; task: Promise<{ id: string; name: string; bytes: number }> }

export class FileService {
  private readonly platform: string
  private readonly fetchImpl: typeof fetch
  private readonly run: ToolRunner
  private readonly cacheLimit: number
  private readonly building = new Map<string, Promise<string>>()
  private readonly fetched = new Map<string, ShippedFetch>()

  constructor(private readonly options: FileServiceOptions) {
    this.platform = options.platform ?? process.platform
    this.fetchImpl = options.fetch ?? fetch
    this.run = options.run ?? defaultRun
    this.cacheLimit = options.cacheLimitBytes ?? THUMB_CACHE_BYTES
  }

  /** A path the agent mentioned, or one of this session's attachments by id. */
  async locate(cwd: string, sessionId: string, params: Record<string, unknown>): Promise<Located> {
    if (typeof params.attachmentId === "string" && params.attachmentId) {
      const found = await findAttachment(cwd, sessionId, params.attachmentId)
      if (!found) throw fail("attachment not found", "not_found")
      return { path: await resolveInside(cwd, found.path, { allowHidden: true }), name: found.name, singleLink: true }
    }
    if (typeof params.path !== "string" || !params.path) throw fail("path or attachmentId required", "invalid")
    const path = await resolveInside(cwd, params.path)
    return { path, name: basename(path) }
  }

  async stat(located: Located, variant: FileVariant = "original"): Promise<FileStat> {
    const info = await stat(located.path)
    if (info.size > FILE_LIMIT_BYTES) throw fail(`file exceeds ${FILE_LIMIT_BYTES / 1024 / 1024} MB`, "too_large")
    const mediaType = mediaTypeOf(located.name)
    const kind = kindOf(mediaType)
    const out: FileStat = { name: located.name, size: info.size, mediaType, kind, mtimeMs: info.mtimeMs }
    if (this.platform !== "darwin") {
      if (variant === "screen") throw fail("screen-size copies need macOS", "unsupported")
      return out
    }
    if (kind === "image") Object.assign(out, await this.dimensions(located.path))
    if (kind === "video") {
      const seconds = await this.videoSeconds(located.path)
      if (seconds !== null) out.durationMs = Math.round(seconds * 1000)
    }
    if (variant === "screen") {
      if (kind !== "image") throw fail("only images have a screen-size copy", "unsupported")
      const screen = await this.screenCopy(located)
      const screenInfo = await stat(screen)
      const size = await this.dimensions(screen)
      return { ...out, ...size, size: screenInfo.size, mediaType: "image/jpeg", name: `${stripExt(located.name)}.jpg` }
    }
    return out
  }

  /** `file.thumb`: JPEG, long edge ≤ 360, ≤ 64 KB. */
  async thumb(located: Located): Promise<{ mediaType: "image/jpeg"; data: string; width: number; height: number }> {
    if (this.platform !== "darwin") throw fail("thumbnails need macOS", "unsupported")
    const file = await this.cached(located.path, "thumb", (out) => this.makeThumb(located, out))
    const data = await readWhole(file, THUMB_MAX_BYTES)
    const size = (await this.dimensions(file)) ?? { width: 0, height: 0 }
    return { mediaType: "image/jpeg", data: Buffer.from(data).toString("base64"), ...size }
  }

  /** `file.get`: one window, the same `{bytes, offset, data}` shape as `attachment.get`. */
  async slice(located: Located, variant: FileVariant, offset: unknown, length: unknown) {
    const path = await this.variantPath(located, variant)
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const info = await handle.stat()
      if (!info.isFile()) throw fail("not a plain file", "not_file")
      if (variant === "original" && located.singleLink && info.nlink !== 1) throw fail("attachment has other names", "not_file")
      if (info.size > FILE_LIMIT_BYTES) throw fail(`file exceeds ${FILE_LIMIT_BYTES / 1024 / 1024} MB`, "too_large")
      const start = integer(offset ?? 0, 0, info.size, "offset")
      const size = integer(length ?? RELAY_ATTACHMENT_SEND_BYTES, 1, RELAY_ATTACHMENT_CHUNK_BYTES, "length")
      const end = Math.min(info.size, start + Math.min(size, RELAY_ATTACHMENT_SEND_BYTES))
      const buffer = new Uint8Array(end - start)
      let read = 0
      while (read < buffer.byteLength) {
        const { bytesRead } = await handle.read(buffer, read, buffer.byteLength - read, start + read)
        if (bytesRead === 0) break
        read += bytesRead
      }
      return { bytes: info.size, offset: start, data: Buffer.from(buffer.subarray(0, read)).toString("base64") }
    } finally {
      await handle.close()
    }
  }

  /** `file.ship`: the whole file, AES-256-GCM with the phone's key, PUT to the blob lane. */
  async ship(located: Located, variant: FileVariant, blob: unknown): Promise<{ bytes: number; sha256: string }> {
    const { id, token, key, nonce } = blobParams(blob, "uploadToken")
    const plain = await readWhole(await this.variantPath(located, variant), FILE_LIMIT_BYTES, variant === "original" && located.singleLink)
    const sealed = seal(plain, key, nonce)
    let response: Response
    try {
      response = await this.fetchImpl(`${this.options.blobBase}/v1/blob/${id}`, {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream", "content-length": String(sealed.byteLength) },
        body: sealed,
      })
    } catch (error) {
      throw fail(`blob lane unreachable: ${error instanceof Error ? error.message : String(error)}`, "blob_unreachable")
    }
    if (!response.ok) throw blobRefusal(response.status, await response.text().catch(() => ""))
    return { bytes: sealed.byteLength, sha256: createHash("sha256").update(plain).digest("hex") }
  }

  /**
   * `attachment.fetch`: GET the phone's ciphertext, decrypt, save. A retry with the same blob id while the first
   * is running or done gets the same attachment instead of a second file.
   */
  async fetchAttachment(blob: unknown, save: (bytes: Uint8Array) => Promise<{ id: string; name: string; bytes: number }>) {
    const { id, token, key, nonce } = blobParams(blob, "downloadToken")
    this.sweepFetched()
    const known = this.fetched.get(id)
    if (known) return { attachment: await known.task }
    const task = (async () => {
      let response: Response
      try {
        response = await this.fetchImpl(`${this.options.blobBase}/v1/blob/${id}`, { headers: { authorization: `Bearer ${token}` } })
      } catch (error) {
        throw fail(`blob lane unreachable: ${error instanceof Error ? error.message : String(error)}`, "blob_unreachable")
      }
      if (!response.ok) throw blobRefusal(response.status, await response.text().catch(() => ""))
      const sealed = await readBlob(response, FILE_LIMIT_BYTES + 16)
      return save(openSealed(sealed, key, nonce))
    })()
    this.fetched.set(id, { at: Date.now(), task })
    task.catch(() => this.fetched.delete(id))
    return { attachment: await task }
  }

  private sweepFetched() {
    const cutoff = Date.now() - SHIPPED_TTL_MS
    for (const [id, entry] of this.fetched) if (entry.at < cutoff) this.fetched.delete(id)
  }

  private async variantPath(located: Located, variant: FileVariant): Promise<string> {
    if (variant === "original") return located.path
    if (this.platform !== "darwin") throw fail("screen-size copies need macOS", "unsupported")
    if (kindOf(mediaTypeOf(located.name)) !== "image") throw fail("only images have a screen-size copy", "unsupported")
    return this.screenCopy(located)
  }

  /** Bytes from one O_NOFOLLOW open, so a path swap cannot change what sips or qlmanage read. */
  private async withSnapshot(path: string, singleLink: boolean, use: (copy: string) => Promise<void>): Promise<void> {
    let handle: Awaited<ReturnType<typeof open>>
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch {
      throw fail("not a plain file", "not_file")
    }
    let copy: string | undefined
    try {
      try {
        const info = await handle.stat()
        if (!info.isFile()) throw fail("not a plain file", "not_file")
        if (singleLink && info.nlink !== 1) throw fail("attachment has other names", "not_file")
        await mkdir(this.options.cacheDir, { recursive: true, mode: 0o700 })
        copy = join(this.options.cacheDir, `snap.${crypto.randomUUID()}.tmp${extname(path)}`)
        const out = await open(copy, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
        try {
          const buffer = Buffer.alloc(64 * 1024)
          let offset = 0
          for (;;) {
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
            if (bytesRead === 0) break
            await out.write(buffer, 0, bytesRead)
            offset += bytesRead
          }
        } finally {
          await out.close()
        }
      } finally {
        await handle.close()
      }
      if (!copy) throw fail("not a plain file", "not_file")
      await use(copy)
    } finally {
      if (copy) await rm(copy, { force: true })
    }
  }

  private screenCopy(located: Located): Promise<string> {
    return this.cached(located.path, "screen", async (out) => {
      const size = await this.dimensions(located.path)
      const resize = size && Math.max(size.width, size.height) > SCREEN_MAX_EDGE ? ["-Z", String(SCREEN_MAX_EDGE)] : []
      await this.withSnapshot(located.path, located.singleLink === true, async (copy) => {
        await this.tool(["sips", "-s", "format", "jpeg", "-s", "formatOptions", "80", ...resize, copy, "--out", out])
      })
    })
  }

  private async makeThumb(located: Located, out: string) {
    const kind = kindOf(mediaTypeOf(located.name))
    await this.withSnapshot(located.path, located.singleLink === true, async (copy) => {
      let source = copy
      let scratch: string | null = null
      if (kind !== "image") {
        // qlmanage writes `<name>.png` into the folder it is given: PDF first page, video first frame, document icons.
        scratch = `${out}.ql`
        await mkdir(scratch, { recursive: true })
        await this.tool(["qlmanage", "-t", "-s", String(THUMB_MAX_EDGE), "-o", scratch, copy])
        const made = (await readdir(scratch)).find((name) => name.endsWith(".png"))
        if (!made) throw fail("no thumbnail for this file", "unsupported")
        source = join(scratch, made)
      }
      try {
        for (const [edge, quality] of [[THUMB_MAX_EDGE, 70], [THUMB_MAX_EDGE, 45], [240, 40]] as const) {
          await this.tool(["sips", "-s", "format", "jpeg", "-s", "formatOptions", String(quality), "-Z", String(edge), source, "--out", out])
          if ((await stat(out)).size <= THUMB_MAX_BYTES) return
        }
        throw fail("thumbnail stayed over 64 KB", "unsupported")
      } finally {
        if (scratch) await rm(scratch, { recursive: true, force: true })
      }
    })
  }

  private async dimensions(path: string): Promise<{ width: number; height: number } | null> {
    const result = await this.run(["sips", "-g", "pixelWidth", "-g", "pixelHeight", path], TOOL_TIMEOUT_MS).catch(() => null)
    return result && result.code === 0 ? parseSipsSize(result.stdout) : null
  }

  private async videoSeconds(path: string): Promise<number | null> {
    const result = await this.run(["mdls", "-raw", "-name", "kMDItemDurationSeconds", path], 5_000).catch(() => null)
    const seconds = Number(result?.stdout.trim())
    return result?.code === 0 && Number.isFinite(seconds) && seconds > 0 ? seconds : null
  }

  private async tool(argv: string[]) {
    const result = await this.run(argv, TOOL_TIMEOUT_MS).catch((error: unknown) => {
      throw fail(`${argv[0]} could not run: ${error instanceof Error ? error.message : String(error)}`, "unsupported")
    })
    if (result.timedOut) throw fail(`${argv[0]} timed out`, "unsupported")
    if (result.code !== 0) throw fail(`${argv[0]} failed (exit ${result.code})`, "unsupported")
  }

  /**
   * `RUDDER_HOME/thumbs/<sha256(realpath, mtime, size, variant)>.jpg`. Built once per key at a time, renamed into
   * place when done, touched on every hit; the folder is trimmed oldest-first past the cap after each build.
   */
  private async cached(path: string, variant: "thumb" | "screen", build: (out: string) => Promise<void>): Promise<string> {
    const info = await stat(path)
    const key = createHash("sha256").update(`${path}\n${info.mtimeMs}\n${info.size}\n${variant}`).digest("hex")
    const file = join(this.options.cacheDir, `${key}.jpg`)
    const hit = await stat(file).catch(() => null)
    if (hit?.isFile()) {
      const now = new Date()
      await utimes(file, now, now).catch(() => {})
      return file
    }
    const running = this.building.get(key)
    if (running) return running
    const task = (async () => {
      await mkdir(this.options.cacheDir, { recursive: true, mode: 0o700 })
      const temp = join(this.options.cacheDir, `${key}.${crypto.randomUUID()}.tmp.jpg`)
      try {
        await build(temp)
        await rename(temp, file)
      } finally {
        await rm(temp, { force: true })
      }
      await this.trim()
      return file
    })()
    this.building.set(key, task)
    try {
      return await task
    } finally {
      this.building.delete(key)
    }
  }

  async trim() {
    const dir = this.options.cacheDir
    const names = await readdir(dir).catch(() => [] as string[])
    const entries: Array<{ path: string; size: number; at: number }> = []
    for (const name of names) {
      if (!name.endsWith(".jpg") || name.includes(".tmp.")) continue
      const info = await stat(join(dir, name)).catch(() => null)
      if (info?.isFile()) entries.push({ path: join(dir, name), size: info.size, at: info.mtimeMs })
    }
    let total = entries.reduce((sum, entry) => sum + entry.size, 0)
    entries.sort((a, b) => a.at - b.at)
    for (const entry of entries) {
      if (total <= this.cacheLimit) break
      await rm(entry.path, { force: true })
      total -= entry.size
    }
  }
}

function stripExt(name: string): string {
  const ext = extname(name)
  return ext ? name.slice(0, -ext.length) : name
}

/**
 * A blob lane body of at most `limit` bytes. A declared length past it is refused before reading, and the stream is
 * cancelled as soon as it passes it, so an oversized blob never sits in memory whole.
 */
async function readBlob(response: Response, limit: number): Promise<Uint8Array> {
  const tooLarge = () => fail("blob exceeds 50 MB", "too_large")
  const declared = Number(response.headers.get("content-length") ?? "")
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => undefined)
    throw tooLarge()
  }
  if (!response.body) return new Uint8Array(0)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel().catch(() => undefined)
      throw tooLarge()
    }
    chunks.push(value)
  }
  return new Uint8Array(Buffer.concat(chunks, size))
}

async function readWhole(path: string, limit: number, singleLink = false): Promise<Uint8Array> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw fail("not a plain file", "not_file")
    if (singleLink && info.nlink !== 1) throw fail("attachment has other names", "not_file")
    if (info.size > limit) throw fail(`file exceeds ${limit} bytes`, "too_large")
    const buffer = new Uint8Array(info.size)
    let read = 0
    while (read < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, read, buffer.byteLength - read, read)
      if (bytesRead === 0) break
      read += bytesRead
    }
    return buffer.subarray(0, read)
  } finally {
    await handle.close()
  }
}

function integer(value: unknown, min: number, max: number, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw fail(`${name} out of range`, "invalid")
  return value
}

function base64Bytes(value: unknown, length: number, name: string): Uint8Array {
  if (typeof value !== "string") throw fail(`${name} required`, "invalid")
  const bytes = Buffer.from(value, "base64")
  if (bytes.byteLength !== length || bytes.toString("base64") !== value) throw fail(`${name} must be ${length} bytes of base64`, "invalid")
  return bytes
}

function blobParams(blob: unknown, tokenField: "uploadToken" | "downloadToken") {
  if (!blob || typeof blob !== "object") throw fail("blob required", "invalid")
  const fields = blob as Record<string, unknown>
  const id = typeof fields.id === "string" ? fields.id : ""
  if (!BLOB_ID.test(id)) throw fail("blob.id is malformed", "invalid")
  const token = fields[tokenField]
  if (typeof token !== "string" || !token || token.length > 2048) throw fail(`blob.${tokenField} required`, "invalid")
  return { id, token, key: base64Bytes(fields.key, 32, "blob.key"), nonce: base64Bytes(fields.nonce, 12, "blob.nonce") }
}

/** The blob lane's refusals, as codes the phone maps (BlobClient on the phone uses the same words). */
function blobRefusal(status: number, body: string): Error {
  let code = "blob_failed"
  if (status === 401 || status === 403) code = "expired"
  else if (status === 409) code = "conflict"
  else if (status === 413) code = "too_large"
  else if (status === 429) code = "quota"
  else if (status === 404) code = "not_found"
  return fail(`blob lane answered ${status}${body ? `: ${body.slice(0, 200)}` : ""}`, code)
}

/** AES-256-GCM, `ciphertext ‖ tag(16)`; the nonce travels separately (r75 §2.3). */
export function seal(plain: Uint8Array, key: Uint8Array, nonce: Uint8Array): Uint8Array {
  const cipher = createCipheriv("aes-256-gcm", key, nonce)
  return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()])
}

export function openSealed(sealed: Uint8Array, key: Uint8Array, nonce: Uint8Array): Uint8Array {
  if (sealed.byteLength < 16) throw fail("blob is too short", "invalid")
  const decipher = createDecipheriv("aes-256-gcm", key, nonce)
  decipher.setAuthTag(sealed.subarray(sealed.byteLength - 16))
  try {
    return Buffer.concat([decipher.update(sealed.subarray(0, sealed.byteLength - 16)), decipher.final()])
  } catch {
    throw fail("blob did not decrypt", "invalid")
  }
}
