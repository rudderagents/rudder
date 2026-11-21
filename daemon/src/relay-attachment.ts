import { ATTACHMENT_LIMIT_BYTES, tooLarge } from "./attachments"

/** Largest raw piece the daemon accepts or a phone may ask for. Base64 stays under the 16 MB relay frame. 1.0 apps send 6 MB. */
export const RELAY_ATTACHMENT_CHUNK_BYTES = 6 * 1024 * 1024

/**
 * Raw bytes per piece the daemon sends back (`attachment.get`, `turn.preview`), whatever `length` the phone asks for.
 * The phone awaits each reply before the next, so a small window lets approvals and stops interleave between pieces.
 */
export const RELAY_ATTACHMENT_SEND_BYTES = 512 * 1024

/** How long a finished upload keeps its id, so a retried last chunk gets the same attachment back. */
const UPLOAD_TTL_MS = 10 * 60 * 1000
/** An unfinished upload with no new piece for this long is dropped. A 6 MB piece at ~50 KB/s still lands in time. */
const STALL_MS = 2 * 60 * 1000
/** Open uploads per device, so one phone cannot hold the slots every other phone needs. */
const MAX_OPEN_UPLOADS = 4
const MAX_CHUNK_TEXT = (RELAY_ATTACHMENT_CHUNK_BYTES / 3) * 4
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type SavedAttachment = { id: string; name: string; bytes: number }

type StagedUpload = {
  deviceKey: string
  sessionId: string
  name: string
  total: number
  /** Grows with what arrived (doubling, capped at `total`), never sized from `total` up front. */
  buf: Uint8Array
  received: number
  touched: number
  saved?: SavedAttachment
  /** One save for this upload. A retried last chunk awaits it instead of writing a second file. */
  save?: Promise<SavedAttachment>
}

/**
 * Holds an in-flight `attachment.put`. Keyed by device plus the phone's upload id, so one phone retrying a chunk
 * cannot append onto another phone's file. `save` runs once, when the last byte lands. A finished upload keeps only
 * its id until the TTL, and does not occupy one of its device's four open slots.
 */
export class RelayUploadBoard {
  private readonly uploads = new Map<string, StagedUpload>()

  constructor(private readonly now: () => number = Date.now) {}

  /** Bytes the open uploads hold in memory. */
  heldBytes(): number {
    let bytes = 0
    for (const state of this.uploads.values()) bytes += state.buf.byteLength
    return bytes
  }

  async accept(
    deviceKey: string,
    params: Record<string, unknown>,
    save: (name: string, bytes: Uint8Array) => Promise<SavedAttachment>,
  ): Promise<{ received: number; attachment?: SavedAttachment }> {
    this.sweep()
    const uploadId = stringField(params.uploadId, "uploadId")
    if (!UUID.test(uploadId)) throw fail("uploadId must be a UUID", "invalid")
    const sessionId = stringField(params.sessionId, "sessionId")
    const name = stringField(params.name, "name")
    const total = declaredTotal(params.total)
    const offset = integer(params.offset, 0, total, "offset")
    const chunk = decodeChunk(params.data, total === 0)
    if (offset + chunk.byteLength > total) throw fail("chunk passes the end of the file", "invalid")
    if (chunk.byteLength > RELAY_ATTACHMENT_CHUNK_BYTES) throw fail("chunk exceeds 6 MB", "invalid")
    const key = `${deviceKey}\n${uploadId}`
    let state = this.uploads.get(key)
    if (!state) {
      if (offset !== 0) throw fail("upload must start at offset 0", "invalid")
      if (this.openUploads(deviceKey) >= MAX_OPEN_UPLOADS) throw fail("too many uploads in flight", "invalid")
      state = { deviceKey, sessionId, name, total, buf: new Uint8Array(0), received: 0, touched: this.now() }
      this.uploads.set(key, state)
    } else if (state.sessionId !== sessionId || state.name !== name || state.total !== total) {
      throw fail("uploadId already used with different content", "conflict")
    }
    const current = state
    current.touched = this.now()
    if (current.saved) return { received: current.received, attachment: current.saved }
    // A retry of the chunk just written overlaps the end. Anything with a hole, or a different earlier slice, is refused.
    if (offset > current.received || (offset < current.received && offset + chunk.byteLength < current.received)) {
      throw fail("offset does not continue the upload", "invalid")
    }
    if (offset < current.received) {
      if (!sameBytes(current.buf.subarray(offset, offset + chunk.byteLength), chunk)) {
        throw fail("retried chunk does not match", "conflict")
      }
    } else {
      current.buf = grown(current.buf, offset + chunk.byteLength, current.total)
      current.buf.set(chunk, offset)
      current.received += chunk.byteLength
    }
    if (current.received < current.total) return { received: current.received }
    if (!current.save) {
      const bytes = current.buf.subarray(0, current.total)
      const fileName = current.name
      current.save = save(fileName, bytes)
        .then((attachment) => {
          current.saved = attachment
          current.buf = new Uint8Array(0)
          return attachment
        })
        .catch((error: unknown) => {
          current.save = undefined
          throw error
        })
    }
    const attachment = await current.save
    return { received: current.received, attachment }
  }

  private openUploads(deviceKey: string): number {
    let count = 0
    for (const state of this.uploads.values()) if (!state.saved && state.deviceKey === deviceKey) count += 1
    return count
  }

  private sweep() {
    const now = this.now()
    for (const [key, state] of this.uploads) {
      if (state.save && !state.saved) continue
      if (state.touched < now - (state.saved ? UPLOAD_TTL_MS : STALL_MS)) this.uploads.delete(key)
    }
  }
}

/** `buf` with room for `needed` bytes: doubled so a file in many pieces copies O(size) in all, never past `total`. */
function grown(buf: Uint8Array, needed: number, total: number): Uint8Array {
  if (needed <= buf.byteLength) return buf
  const next = new Uint8Array(Math.min(total, Math.max(needed, buf.byteLength * 2)))
  next.set(buf)
  return next
}

/** One window of a file the phone asked to read back, at most `RELAY_ATTACHMENT_SEND_BYTES`. `bytes` is the whole file. */
export function sliceBase64(data: Uint8Array, offset: unknown, length: unknown): { bytes: number; offset: number; data: string } {
  const { start, end } = sliceWindow(data.byteLength, offset, length)
  return { bytes: data.byteLength, offset: start, data: Buffer.from(data.subarray(start, end)).toString("base64") }
}

/** The byte range `sliceBase64` answers for a file of `bytes`, validated the same way. */
export function sliceWindow(bytes: number, offset: unknown, length: unknown): { start: number; end: number } {
  const start = integer(offset ?? 0, 0, bytes, "offset")
  const size = integer(length ?? RELAY_ATTACHMENT_CHUNK_BYTES, 1, RELAY_ATTACHMENT_CHUNK_BYTES, "length")
  return { start, end: Math.min(bytes, start + Math.min(size, RELAY_ATTACHMENT_SEND_BYTES)) }
}

function declaredTotal(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw fail("total out of range", "invalid")
  if (value > ATTACHMENT_LIMIT_BYTES) throw tooLarge()
  return value
}

function decodeChunk(value: unknown, emptyAllowed: boolean): Uint8Array {
  if (typeof value === "string" && value.length > MAX_CHUNK_TEXT) throw fail("chunk exceeds 6 MB", "invalid")
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw fail("data must be base64", "invalid")
  }
  if (value.length === 0) {
    if (!emptyAllowed) throw fail("data must be base64", "invalid")
    return new Uint8Array()
  }
  const buf = Buffer.from(value, "base64")
  if (buf.toString("base64") !== value) throw fail("data must be base64", "invalid")
  return buf
}

function stringField(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw fail(`${name} required`, "invalid")
  return value
}

function integer(value: unknown, min: number, max: number, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw fail(`${name} out of range`, "invalid")
  }
  return value
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let i = 0; i < left.byteLength; i++) if (left[i] !== right[i]) return false
  return true
}

function fail(message: string, code: string): Error {
  return Object.assign(new Error(message), { code })
}
