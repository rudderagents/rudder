import { describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { ATTACHMENT_LIMIT_BYTES } from "./attachments"
import { createFakeAdapter } from "./adapter/fake"
import { RELAY_ATTACHMENT_CHUNK_BYTES, RELAY_ATTACHMENT_SEND_BYTES, RelayUploadBoard, sliceBase64 } from "./relay-attachment"
import { SessionService } from "./session-service"
import { Store } from "./store"
import { WORKSPACE_ROOT } from "./workspace"

const UPLOAD = "11111111-1111-4111-8111-111111111111"

type Saved = { id: string; name: string; bytes: number }

function piece(bytes: Uint8Array, offset: number, total: number, extra: Record<string, unknown> = {}) {
  return {
    sessionId: "s",
    name: "shot.jpg",
    uploadId: UPLOAD,
    offset,
    total,
    data: Buffer.from(bytes).toString("base64"),
    ...extra,
  }
}

function uploadId(n: number): string {
  return `11111111-1111-4111-8111-${n.toString(16).padStart(12, "0")}`
}

async function failure(run: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await run
  } catch (error) {
    return { code: (error as { code?: string }).code, message: error instanceof Error ? error.message : String(error) }
  }
  throw new Error("expected a failure")
}

const remember = async (name: string, bytes: Uint8Array): Promise<Saved> => ({ id: "id-1", name, bytes: bytes.byteLength })

describe("relay attachment chunks", () => {
  test("two chunks assemble, and a matching retry does not grow the file", async () => {
    const board = new RelayUploadBoard()
    const raw = Buffer.from("hello!")
    const first = await board.accept("phone", piece(raw.subarray(0, 3), 0, raw.length), remember)
    expect(first).toEqual({ received: 3 })
    const again = await board.accept("phone", piece(raw.subarray(0, 3), 0, raw.length), remember)
    expect(again).toEqual({ received: 3 })
    let saved: Uint8Array | undefined
    const done = await board.accept("phone", piece(raw.subarray(3), 3, raw.length), async (name, bytes) => {
      saved = bytes
      return { id: "id-1", name, bytes: bytes.byteLength }
    })
    expect(saved).toEqual(raw)
    expect(done.attachment).toEqual({ id: "id-1", name: "shot.jpg", bytes: 6 })
    const replay = await board.accept("phone", piece(raw.subarray(3), 3, raw.length), remember)
    expect(replay.attachment?.id).toBe("id-1")
  })

  test("a gap, a mismatched retry, bad base64, and a non-integer total are refused", async () => {
    const board = new RelayUploadBoard()
    await board.accept("phone", piece(Buffer.from("abcd"), 0, 6), remember)
    const gap = await failure(board.accept("phone", piece(Buffer.from("x"), 5, 6), remember))
    expect(gap).toEqual({ code: "invalid", message: "offset does not continue the upload" })
    const earlier = await failure(board.accept("phone", piece(Buffer.from("ab"), 0, 6), remember))
    expect(earlier.code).toBe("invalid")
    const clash = await failure(board.accept("phone", piece(Buffer.from("XXXX"), 0, 6), remember))
    expect(clash).toEqual({ code: "conflict", message: "retried chunk does not match" })
    const bad = await failure(board.accept("phone", piece(Buffer.from("a"), 0, 1, { data: "!!!!" }), remember))
    expect(bad).toEqual({ code: "invalid", message: "data must be base64" })
    const fraction = await failure(board.accept("phone", piece(Buffer.from("a"), 0, 1.5), remember))
    expect(fraction).toEqual({ code: "invalid", message: "total out of range" })
  })

  test("over 50 MB is too_large, and a base64 string past one chunk is refused before decode", async () => {
    const board = new RelayUploadBoard()
    const huge = await failure(board.accept("phone", piece(Buffer.from("a"), 0, ATTACHMENT_LIMIT_BYTES + 1), remember))
    expect(huge.code).toBe("too_large")
    expect(huge.message).toBe("attachment exceeds 50 MB")
    const text = "A".repeat((RELAY_ATTACHMENT_CHUNK_BYTES / 3) * 4 + 4)
    const fat = await failure(board.accept("phone", piece(new Uint8Array(), 0, RELAY_ATTACHMENT_CHUNK_BYTES, { data: text }), remember))
    expect(fat).toEqual({ code: "invalid", message: "chunk exceeds 6 MB" })
  })

  test("the last chunk is saved once, and a failed save can be retried", async () => {
    const board = new RelayUploadBoard()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let calls = 0
    const save = async (name: string, bytes: Uint8Array): Promise<Saved> => {
      calls += 1
      await gate
      return { id: "id-1", name, bytes: bytes.byteLength }
    }
    const params = piece(Buffer.from("ab"), 0, 2)
    const pending = board.accept("phone", params, save)
    const again = board.accept("phone", params, save)
    release()
    const [left, right] = await Promise.all([pending, again])
    expect(calls).toBe(1)
    expect(left.attachment?.id).toBe("id-1")
    expect(right.attachment?.id).toBe("id-1")

    const flaky = new RelayUploadBoard()
    let tries = 0
    const retry = async (name: string, bytes: Uint8Array): Promise<Saved> => {
      tries += 1
      if (tries === 1) throw new Error("disk")
      return { id: "id-2", name, bytes: bytes.byteLength }
    }
    const once = piece(Buffer.from("a"), 0, 1, { uploadId: uploadId(2) })
    expect((await failure(flaky.accept("phone", once, retry))).message).toBe("disk")
    const recovered = await flaky.accept("phone", once, retry)
    expect(tries).toBe(2)
    expect(recovered.attachment?.id).toBe("id-2")
  })

  test("finished uploads do not hold an open slot, and two phones do not share a buffer", async () => {
    const board = new RelayUploadBoard()
    for (let n = 0; n < 5; n++) {
      const done = await board.accept("phone", piece(Buffer.from("a"), 0, 1, { uploadId: uploadId(10 + n) }), remember)
      expect(done.attachment?.bytes).toBe(1)
    }
    for (let n = 0; n < 4; n++) {
      const partial = await board.accept("phone", piece(Buffer.from("a"), 0, 2, { uploadId: uploadId(20 + n) }), remember)
      expect(partial.received).toBe(1)
      expect(partial.attachment).toBeUndefined()
    }
    const blocked = await failure(board.accept("phone", piece(Buffer.from("a"), 0, 2, { uploadId: uploadId(30) }), remember))
    expect(blocked).toEqual({ code: "invalid", message: "too many uploads in flight" })

    const split = new RelayUploadBoard()
    const files: Uint8Array[] = []
    const keep = async (name: string, bytes: Uint8Array): Promise<Saved> => {
      files.push(Uint8Array.from(bytes))
      return { id: `id-${files.length}`, name, bytes: bytes.byteLength }
    }
    await split.accept("phone-a", piece(Buffer.from("aa"), 0, 4, { uploadId: UPLOAD }), keep)
    await split.accept("phone-b", piece(Buffer.from("bb"), 0, 4, { uploadId: UPLOAD }), keep)
    await split.accept("phone-a", piece(Buffer.from("AA"), 2, 4, { uploadId: UPLOAD }), keep)
    await split.accept("phone-b", piece(Buffer.from("BB"), 2, 4, { uploadId: UPLOAD }), keep)
    expect(files.map((bytes) => Buffer.from(bytes).toString())).toEqual(["aaAA", "bbBB"])
  })

  test("a declared 50 MB upload holds only what arrived, and one phone's slots do not block another", async () => {
    const board = new RelayUploadBoard()
    for (let n = 0; n < 4; n++) {
      await board.accept("greedy", piece(Buffer.from("a"), 0, ATTACHMENT_LIMIT_BYTES, { uploadId: uploadId(40 + n) }), remember)
    }
    expect(board.heldBytes()).toBeLessThan(1024 * 1024)
    const blocked = await failure(board.accept("greedy", piece(Buffer.from("a"), 0, 2, { uploadId: uploadId(50) }), remember))
    expect(blocked).toEqual({ code: "invalid", message: "too many uploads in flight" })
    const other = await board.accept("other", piece(Buffer.from("a"), 0, 2, { uploadId: uploadId(51) }), remember)
    expect(other.received).toBe(1)
  })

  test("an upload that stops progressing frees its slot after two minutes; a finished one keeps its id longer", async () => {
    let clock = 1_000_000
    const board = new RelayUploadBoard(() => clock)
    const done = await board.accept("phone", piece(Buffer.from("a"), 0, 1, { uploadId: uploadId(60) }), remember)
    expect(done.attachment?.bytes).toBe(1)
    for (let n = 0; n < 4; n++) await board.accept("phone", piece(Buffer.from("a"), 0, 2, { uploadId: uploadId(61 + n) }), remember)
    clock += 60_000
    expect(await failure(board.accept("phone", piece(Buffer.from("a"), 0, 2, { uploadId: uploadId(70) }), remember))).toEqual({
      code: "invalid",
      message: "too many uploads in flight",
    })
    clock += 61_000
    expect((await board.accept("phone", piece(Buffer.from("a"), 0, 2, { uploadId: uploadId(70) }), remember)).received).toBe(1)
    // The stalled one is gone: its next piece is refused rather than appended.
    expect((await failure(board.accept("phone", piece(Buffer.from("b"), 1, 2, { uploadId: uploadId(61) }), remember))).code).toBe("invalid")
    // A finished upload still answers its retried last chunk with the same attachment.
    const again = await board.accept("phone", piece(Buffer.from("a"), 0, 1, { uploadId: uploadId(60) }), remember)
    expect(again.attachment?.id).toBe("id-1")
  })

  test("an empty file is one empty chunk", async () => {
    const board = new RelayUploadBoard()
    let seen = -1
    const saved = await board.accept("phone", {
      sessionId: "s", name: "empty.txt", uploadId: UPLOAD, offset: 0, total: 0, data: "",
    }, async (name, bytes) => {
      seen = bytes.byteLength
      return { id: "empty", name, bytes: 0 }
    })
    expect(seen).toBe(0)
    expect(saved).toEqual({ received: 0, attachment: { id: "empty", name: "empty.txt", bytes: 0 } })
  })

  test("sliceBase64 windows a file the phone can join", () => {
    const raw = Buffer.from("abcdef")
    const head = sliceBase64(raw, 0, 4)
    const tail = sliceBase64(raw, 4, 4)
    expect(head.bytes).toBe(6)
    expect(Buffer.concat([Buffer.from(head.data, "base64"), Buffer.from(tail.data, "base64")])).toEqual(raw)
  })
})

describe("relay attachment piece sizes", () => {
  test("512 KiB pieces in order assemble the file byte for byte", async () => {
    const board = new RelayUploadBoard()
    const raw = new Uint8Array(RELAY_ATTACHMENT_SEND_BYTES * 3 + 1234)
    for (let i = 0; i < raw.length; i++) raw[i] = (i * 31 + 7) & 0xff
    let saved: Uint8Array | undefined
    let last: Awaited<ReturnType<RelayUploadBoard["accept"]>> | undefined
    for (let offset = 0; offset < raw.length; offset += RELAY_ATTACHMENT_SEND_BYTES) {
      const end = Math.min(raw.length, offset + RELAY_ATTACHMENT_SEND_BYTES)
      last = await board.accept("phone", piece(raw.subarray(offset, end), offset, raw.length), async (name, bytes) => {
        saved = new Uint8Array(bytes)
        return { id: "big", name, bytes: bytes.byteLength }
      })
      expect(last.received).toBe(end)
    }
    expect(last?.attachment?.bytes).toBe(raw.length)
    expect(saved).toEqual(raw)
  })

  test("a 6 MB piece from a 1.0 app is still accepted", async () => {
    const board = new RelayUploadBoard()
    const raw = new Uint8Array(RELAY_ATTACHMENT_CHUNK_BYTES + 10).fill(9)
    const first = await board.accept("phone", piece(raw.subarray(0, RELAY_ATTACHMENT_CHUNK_BYTES), 0, raw.length), remember)
    expect(first).toEqual({ received: RELAY_ATTACHMENT_CHUNK_BYTES })
    const done = await board.accept("phone", piece(raw.subarray(RELAY_ATTACHMENT_CHUNK_BYTES), RELAY_ATTACHMENT_CHUNK_BYTES, raw.length), remember)
    expect(done.attachment?.bytes).toBe(raw.length)
  })

  test("reads come back in 512 KiB windows even when a 1.0 app asks for 6 MB", () => {
    const raw = new Uint8Array(RELAY_ATTACHMENT_SEND_BYTES * 2 + 5)
    for (let i = 0; i < raw.length; i++) raw[i] = i & 0xff
    const parts: Buffer[] = []
    let offset = 0
    while (offset < raw.length) {
      const window = sliceBase64(raw, offset, RELAY_ATTACHMENT_CHUNK_BYTES)
      expect(window.offset).toBe(offset)
      expect(window.bytes).toBe(raw.length)
      const chunk = Buffer.from(window.data, "base64")
      expect(chunk.byteLength).toBeLessThanOrEqual(RELAY_ATTACHMENT_SEND_BYTES)
      parts.push(chunk)
      offset += chunk.byteLength
    }
    expect(parts.length).toBe(3)
    expect(new Uint8Array(Buffer.concat(parts))).toEqual(raw)
  })
})

describe("attachment.put over the session", () => {
  test("an unknown session does not start an upload", async () => {
    const service = new SessionService(new Store(":memory:"), createFakeAdapter(), () => {})
    const missing = await service.invoke("attachment.put", piece(Buffer.from("a"), 0, 1), "p")
    expect(missing.error?.code).toBe("not_found")
  })

  test("two chunks land once, a retried last chunk does not write again, and get reads them back", async () => {
    const folder = mkdtempSync(join(WORKSPACE_ROOT, "relay-att-"))
    try {
      const service = new SessionService(new Store(":memory:"), createFakeAdapter(), () => {})
      const created = await service.invoke("session.create", { cwd: folder, title: "img" }, "c")
      const sessionId = (created.result as { session: { id: string } }).session.id
      const raw = Buffer.from("hello!")
      const first = await service.invoke("attachment.put", {
        sessionId, name: "shot.jpg", uploadId: UPLOAD, offset: 0, total: raw.length,
        data: raw.subarray(0, 3).toString("base64"),
      }, "p1", { deviceKey: "phone" })
      expect(first.result).toEqual({ received: 3 })
      const second = await service.invoke("attachment.put", {
        sessionId, name: "shot.jpg", uploadId: UPLOAD, offset: 3, total: raw.length,
        data: raw.subarray(3).toString("base64"),
      }, "p2", { deviceKey: "phone" })
      const attachment = (second.result as { attachment: { id: string; name: string; bytes: number } }).attachment
      expect(attachment.bytes).toBe(6)
      const dir = join(folder, ".rudder", "attachments", sessionId)
      expect(readdirSync(dir)).toHaveLength(1)
      const replay = await service.invoke("attachment.put", {
        sessionId, name: "shot.jpg", uploadId: UPLOAD, offset: 3, total: raw.length,
        data: raw.subarray(3).toString("base64"),
      }, "p3", { deviceKey: "phone" })
      expect((replay.result as { attachment: { id: string } }).attachment.id).toBe(attachment.id)
      expect(readdirSync(dir)).toHaveLength(1)
      const stored = readFileSync(join(dir, readdirSync(dir)[0]!))
      expect(stored).toEqual(raw)

      const head = await service.invoke("attachment.get", {
        sessionId, attachmentId: attachment.id, offset: 0, length: 4,
      }, "g1")
      const tail = await service.invoke("attachment.get", {
        sessionId, attachmentId: attachment.id, offset: 4, length: 4,
      }, "g2")
      const joined = Buffer.concat([
        Buffer.from((head.result as { data: string }).data, "base64"),
        Buffer.from((tail.result as { data: string }).data, "base64"),
      ])
      expect(joined).toEqual(raw)
      const gone = await service.invoke("attachment.get", {
        sessionId, attachmentId: "22222222-2222-4222-8222-222222222222",
      }, "g0")
      expect(gone.error).toEqual({ code: "not_found", message: "not found" })
      const preview = await service.invoke("turn.preview", {
        sessionId, turnId: "missing", path: "a.png", side: "after",
      }, "t")
      expect(preview.error?.code).toBe("not_found")
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })
})
