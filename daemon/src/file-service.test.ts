import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createHash, randomBytes } from "node:crypto"
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFakeAdapter } from "./adapter/fake"
import { FileService, openSealed, parseSipsSize, resolveInside, seal, type ToolRunner } from "./file-service"
import { SessionService } from "./session-service"
import { Store } from "./store"
import { WORKSPACE_ROOT } from "./workspace"

// 1×1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64")
const PDF = Buffer.from(
  "%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
)

const onMac = process.platform === "darwin" && Bun.which("sips") !== null
let qlWorks = false
let folder: string
let outside: string
let cacheRoot: string

beforeAll(async () => {
  folder = mkdtempSync(join(WORKSPACE_ROOT, "r75-files-"))
  outside = mkdtempSync(join(tmpdir(), "r75-outside-"))
  cacheRoot = mkdtempSync(join(tmpdir(), "r75-thumbs-"))
  writeFileSync(join(folder, "shot.png"), PNG)
  writeFileSync(join(folder, "report.pdf"), PDF)
  mkdirSync(join(folder, "sub"))
  writeFileSync(join(outside, "secret.txt"), "secret")
  symlinkSync(join(outside, "secret.txt"), join(folder, "escape.txt"))
  symlinkSync(outside, join(folder, "linked-dir"))
  if (onMac && Bun.which("qlmanage")) {
    // qlmanage needs a login session's Quick Look; a headless runner may print nothing. Then its tests skip.
    const out = mkdtempSync(join(tmpdir(), "r75-ql-"))
    const proc = Bun.spawn(["qlmanage", "-t", "-s", "64", "-o", out, join(folder, "report.pdf")], { stdout: "ignore", stderr: "ignore", timeout: 15_000 })
    await proc.exited
    qlWorks = readdirSync(out).some((name) => name.endsWith(".png"))
    rmSync(out, { recursive: true, force: true })
    if (!qlWorks) console.warn("qlmanage made no thumbnail here; the PDF thumbnail test is skipped")
  }
}, 30_000)

afterAll(() => {
  rmSync(folder, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
  rmSync(cacheRoot, { recursive: true, force: true })
})

async function failure(run: Promise<unknown>): Promise<string | undefined> {
  try {
    await run
  } catch (error) {
    return (error as { code?: string }).code
  }
  throw new Error("expected a failure")
}

/** An in-memory blob lane: PUT once per id, GET with the download token. */
function fakeBlobLane() {
  const stored = new Map<string, Uint8Array>()
  const calls: Array<{ method: string; url: string; auth: string | null }> = []
  let mode: "ok" | "down" | "quota" = "ok"
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? "GET"
    const auth = new Headers(init?.headers).get("authorization")
    calls.push({ method, url, auth })
    if (mode === "down") throw new TypeError("connection refused")
    if (mode === "quota") return new Response('{"error":"quota"}', { status: 429 })
    const id = url.split("/").pop()!
    if (method === "PUT") {
      if (auth !== "Bearer up") return new Response("bad token", { status: 403 })
      if (stored.has(id)) return new Response("used", { status: 409 })
      stored.set(id, new Uint8Array(init?.body as Uint8Array))
      return new Response(null, { status: 201 })
    }
    if (auth !== "Bearer down") return new Response("bad token", { status: 403 })
    const body = stored.get(id)
    return body ? new Response(body) : new Response("missing", { status: 404 })
  }) as typeof fetch
  return { stored, calls, impl, setMode: (next: typeof mode) => (mode = next) }
}

async function serviceWith(files: FileService) {
  const service = new SessionService(new Store(":memory:"), createFakeAdapter(), () => {}, { files })
  const created = await service.invoke("session.create", { cwd: folder, title: "files" }, "c")
  const sessionId = (created.result as { session: { id: string } }).session.id
  return { service, sessionId }
}

describe("resolveInside", () => {
  test("relative and absolute paths inside the folder resolve to the real file", async () => {
    const real = await resolveInside(folder, "shot.png")
    expect(real.endsWith("/shot.png")).toBe(true)
    expect(await resolveInside(folder, real)).toBe(real)
    expect(await resolveInside(folder, "sub/../shot.png")).toBe(real)
  })

  test("`..`, an absolute path elsewhere, and symlinks out are forbidden; missing and folders are refused", async () => {
    expect(await failure(resolveInside(folder, "../"))).toBe("forbidden")
    expect(await failure(resolveInside(folder, join(outside, "secret.txt")))).toBe("forbidden")
    expect(await failure(resolveInside(folder, "escape.txt"))).toBe("forbidden")
    expect(await failure(resolveInside(folder, "linked-dir/secret.txt"))).toBe("forbidden")
    expect(await failure(resolveInside(folder, "nope.png"))).toBe("not_found")
    expect(await failure(resolveInside(folder, "sub"))).toBe("not_file")
    expect(await failure(resolveInside(folder, "a\0b"))).toBe("invalid")
  })

  test("hidden files, hidden folders and links into them are forbidden, as fs.read refuses them", async () => {
    mkdirSync(join(folder, ".ssh"), { recursive: true })
    writeFileSync(join(folder, ".ssh", "id_ed25519"), "key")
    writeFileSync(join(folder, ".env"), "TOKEN=1")
    symlinkSync(join(folder, ".ssh"), join(folder, "keys"))
    for (const path of [".ssh/id_ed25519", ".env", "keys/id_ed25519", join(folder, ".env")]) {
      expect(await failure(resolveInside(folder, path))).toBe("forbidden")
    }
    // The daemon's own attachment paths (named by id) still resolve.
    expect(await resolveInside(folder, ".env", { allowHidden: true })).toEndWith("/.env")
  })

  test("a picture in a hidden folder resolves; anything else there, even named .png, does not", async () => {
    mkdirSync(join(folder, ".claude", "scratch"), { recursive: true })
    writeFileSync(join(folder, ".claude", "scratch", "shot.png"), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]))
    writeFileSync(join(folder, ".claude", "scratch", "photo.jpg"), new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16]))
    writeFileSync(join(folder, ".claude", "scratch", "fake.png"), "TOKEN=1")
    writeFileSync(join(folder, ".claude", "scratch", "empty.png"), "")
    symlinkSync(join(folder, ".claude"), join(folder, "agent"))
    expect(await resolveInside(folder, ".claude/scratch/shot.png")).toEndWith("/.claude/scratch/shot.png")
    expect(await resolveInside(folder, join(folder, ".claude", "scratch", "photo.jpg"))).toEndWith("/photo.jpg")
    expect(await resolveInside(folder, "agent/scratch/shot.png")).toEndWith("/.claude/scratch/shot.png")
    for (const path of [".claude/scratch/fake.png", ".claude/scratch/empty.png", ".claude/scratch"]) {
      expect(await failure(resolveInside(folder, path))).toBe("forbidden")
    }
  })
})

describe("file.stat and file.get", () => {
  test("stat names the kind; get windows assemble the file; outside paths are forbidden over the RPC", async () => {
    const files = new FileService({ cacheDir: join(cacheRoot, "a"), blobBase: "https://blob.test", platform: "linux" })
    const { service, sessionId } = await serviceWith(files)
    const stat = (await service.invoke("file.stat", { sessionId, path: "report.pdf" }, "s")).result as Record<string, unknown>
    expect(stat).toMatchObject({ name: "report.pdf", size: PDF.byteLength, mediaType: "application/pdf", kind: "pdf" })
    expect(typeof stat.mtimeMs).toBe("number")

    const first = (await service.invoke("file.get", { sessionId, path: "report.pdf", offset: 0, length: 100 }, "g1")).result as { bytes: number; offset: number; data: string }
    const rest = (await service.invoke("file.get", { sessionId, path: "report.pdf", offset: 100, length: 6_000_000 }, "g2")).result as { data: string }
    expect(first.bytes).toBe(PDF.byteLength)
    expect(Buffer.concat([Buffer.from(first.data, "base64"), Buffer.from(rest.data, "base64")])).toEqual(PDF)

    expect((await service.invoke("file.stat", { sessionId, path: "escape.txt" }, "x")).error?.code).toBe("forbidden")
    expect((await service.invoke("file.get", { sessionId, path: "../etc/passwd" }, "x")).error?.code).toBeDefined()
    expect((await service.invoke("file.stat", { sessionId: "missing", path: "shot.png" }, "x")).error?.code).toBe("not_found")
    expect((await service.invoke("file.thumb", { sessionId, path: "shot.png" }, "x")).error?.code).toBe("unsupported")
    expect((await service.invoke("file.get", { sessionId, path: "shot.png", variant: "screen" }, "x")).error?.code).toBe("unsupported")
  })

  // Audit 2026-11-10 (P3): an imported terminal session keeps the transcript's cwd, which may be `/`.
  test("a session whose cwd is outside the workspace reads no file by path", async () => {
    const files = new FileService({ cacheDir: join(cacheRoot, "imported"), blobBase: "https://blob.test", platform: "linux" })
    const store = new Store(":memory:")
    const service = new SessionService(store, createFakeAdapter(), () => {}, { files })
    const session = store.createSession({ title: "imported", agent: "claude", cwd: outside, permissionMode: "ask", origin: "terminal", nativeId: "n1" })
    expect((await service.invoke("file.get", { sessionId: session.id, path: "secret.txt" }, "x")).error?.code).toBe("forbidden")
  })

  test("a session whose cwd is outside the workspace saves no upload there", async () => {
    const files = new FileService({ cacheDir: join(cacheRoot, "imported-write"), blobBase: "https://blob.test", platform: "linux" })
    const store = new Store(":memory:")
    const service = new SessionService(store, createFakeAdapter(), () => {}, { files })
    const session = store.createSession({ title: "imported", agent: "claude", cwd: outside, permissionMode: "ask", origin: "terminal", nativeId: "n2" })
    await expect(service.uploadAttachment(session.id, "phone.png", PNG)).rejects.toMatchObject({ code: "forbidden" })
    const put = await service.invoke("attachment.put", { sessionId: session.id, uploadId: "33333333-3333-4333-8333-333333333333", name: "phone.png", offset: 0, total: PNG.byteLength, data: PNG.toString("base64") }, "x")
    expect(put.error?.code).toBe("forbidden")
    expect(existsSync(join(outside, ".rudder"))).toBe(false)
  })

  test("an attachment is addressed by id", async () => {
    const files = new FileService({ cacheDir: join(cacheRoot, "b"), blobBase: "https://blob.test", platform: "linux" })
    const { service, sessionId } = await serviceWith(files)
    const uploaded = await service.uploadAttachment(sessionId, "phone.png", PNG)
    const stat = (await service.invoke("file.stat", { sessionId, attachmentId: uploaded.id }, "s")).result as Record<string, unknown>
    expect(stat).toMatchObject({ name: "phone.png", size: PNG.byteLength, kind: "image" })
    expect((await service.invoke("file.stat", { sessionId, attachmentId: "22222222-2222-4222-8222-222222222222" }, "s")).error?.code).toBe("not_found")

    // The agent swaps the upload for a hard link to a secret: a plain file under .rudder/, refused by id.
    const outside = mkdtempSync(join(tmpdir(), "rudder-secret-"))
    try {
      writeFileSync(join(outside, "id_ed25519"), "PRIVATE KEY")
      rmSync(uploaded.path)
      linkSync(join(outside, "id_ed25519"), uploaded.path)
      expect((await service.invoke("file.get", { sessionId, attachmentId: uploaded.id }, "g")).error?.code).toBe("not_found")
      // Swapped after the lookup: the open handle is checked again.
      const located = { path: uploaded.path, name: "phone.png", singleLink: true }
      await expect(files.slice(located, "original", 0, 100)).rejects.toMatchObject({ code: "not_file" })
      await expect(files.ship(located, "original", { id: "blob-hardlink-0001", uploadToken: "t", key: Buffer.alloc(32).toString("base64"), nonce: Buffer.alloc(12).toString("base64") })).rejects.toMatchObject({ code: "not_file" })
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe("thumbnails and screen copies (macOS tools)", () => {
  test.skipIf(!onMac)("an image thumbnail is a JPEG ≤ 64 KB, long edge ≤ 360, and the second ask is a cache hit", async () => {
    let runs = 0
    const counting: ToolRunner = async (argv, timeoutMs) => {
      runs += 1
      const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore", timeout: timeoutMs })
      const stdout = await new Response(proc.stdout).text()
      return { code: await proc.exited, stdout, timedOut: false }
    }
    const big = join(folder, "big.png")
    Bun.spawnSync(["sips", "-z", "1500", "3000", join(folder, "shot.png"), "--out", big])
    const files = new FileService({ cacheDir: join(cacheRoot, "c"), blobBase: "https://blob.test", run: counting })
    const { service, sessionId } = await serviceWith(files)
    const thumb = (await service.invoke("file.thumb", { sessionId, path: "big.png" }, "t")).result as { mediaType: string; data: string; width: number; height: number }
    expect(thumb.mediaType).toBe("image/jpeg")
    expect(Buffer.from(thumb.data, "base64").byteLength).toBeLessThanOrEqual(64 * 1024)
    expect(Math.max(thumb.width, thumb.height)).toBeLessThanOrEqual(360)
    expect(thumb.width).toBe(360)
    const before = runs
    await service.invoke("file.thumb", { sessionId, path: "big.png" }, "t2")
    // A hit only reads the cached JPEG's size.
    expect(runs - before).toBe(1)

    const stat = (await service.invoke("file.stat", { sessionId, path: "big.png" }, "s")).result as { width: number; height: number }
    expect(stat).toMatchObject({ width: 3000, height: 1500 })
    const screen = (await service.invoke("file.stat", { sessionId, path: "big.png", variant: "screen" }, "s2")).result as Record<string, unknown>
    expect(screen).toMatchObject({ mediaType: "image/jpeg", width: 2048, height: 1024, name: "big.jpg" })
    const piece = (await service.invoke("file.get", { sessionId, path: "big.png", variant: "screen", offset: 0, length: 4 }, "g")).result as { bytes: number; data: string }
    expect(piece.bytes).toBe(screen.size as number)
    expect([...Buffer.from(piece.data, "base64").subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff])
  }, 30_000)

  test.skipIf(!onMac)("a PDF thumbnail comes from qlmanage (skipped where Quick Look makes none)", async () => {
    if (!qlWorks) return
    const files = new FileService({ cacheDir: join(cacheRoot, "d"), blobBase: "https://blob.test" })
    const { service, sessionId } = await serviceWith(files)
    const thumb = (await service.invoke("file.thumb", { sessionId, path: "report.pdf" }, "t")).result as { data: string; width: number }
    expect(Buffer.from(thumb.data, "base64").subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]))
    expect(thumb.width).toBeGreaterThan(0)
  }, 30_000)

  test("a tool that times out is `unsupported`, and the cache trims oldest first past its cap", async () => {
    const slow: ToolRunner = async () => ({ code: 0, stdout: "", timedOut: true })
    const files = new FileService({ cacheDir: join(cacheRoot, "e"), blobBase: "https://blob.test", platform: "darwin", run: slow, cacheLimitBytes: 10 })
    const { service, sessionId } = await serviceWith(files)
    expect((await service.invoke("file.thumb", { sessionId, path: "shot.png" }, "t")).error?.code).toBe("unsupported")
    const dir = join(cacheRoot, "e")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "old.jpg"), "123456")
    writeFileSync(join(dir, "new.jpg"), "123456")
    utimesSync(join(dir, "old.jpg"), new Date(1000), new Date(1000))
    await files.trim()
    expect(existsSync(join(dir, "old.jpg"))).toBe(false)
    expect(existsSync(join(dir, "new.jpg"))).toBe(true)
  })

  test("an upload thumb or screen copy refuses another name and a symlink before any tool", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rudder-preview-"))
    const uploaded = join(dir, "phone.png")
    const other = join(dir, "other.png")
    writeFileSync(uploaded, PNG)
    writeFileSync(other, PNG)
    linkSync(uploaded, join(dir, "alias.png"))
    let runs = 0
    const files = new FileService({
      cacheDir: join(cacheRoot, "snap-link"),
      blobBase: "https://blob.test",
      platform: "darwin",
      run: async (argv) => {
        if (argv[0] === "qlmanage" || argv.includes("--out")) runs += 1
        return { code: 0, stdout: "pixelWidth: 1\n  pixelHeight: 1\n", timedOut: false }
      },
    })
    const located = { path: uploaded, name: "phone.png", singleLink: true }
    await expect(files.thumb(located)).rejects.toMatchObject({ code: "not_file" })
    await expect(files.stat(located, "screen")).rejects.toMatchObject({ code: "not_file" })
    rmSync(uploaded)
    symlinkSync(other, uploaded)
    await expect(files.thumb(located)).rejects.toMatchObject({ code: "not_file" })
    await expect(files.stat(located, "screen")).rejects.toMatchObject({ code: "not_file" })
    expect(runs).toBe(0)
    rmSync(dir, { recursive: true, force: true })
  })

  test("a tool sees the snapshot from when the preview opened, not a later replacement", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rudder-preview-"))
    const uploaded = join(dir, "phone.png")
    const original = Buffer.from("original-png")
    writeFileSync(uploaded, original)
    const files = new FileService({
      cacheDir: join(cacheRoot, "snap-swap"),
      blobBase: "https://blob.test",
      platform: "darwin",
      run: async (argv) => {
        if (!argv.includes("--out")) return { code: 0, stdout: "pixelWidth: 1\n  pixelHeight: 1\n", timedOut: false }
        const source = argv[argv.length - 3] as string
        expect(source).not.toBe(uploaded)
        expect(readFileSync(source)).toEqual(original)
        rmSync(uploaded)
        writeFileSync(uploaded, "replaced")
        expect(readFileSync(source)).toEqual(original)
        writeFileSync(uploaded, original)
        writeFileSync(argv[argv.length - 1] as string, Buffer.from([0xff, 0xd8, 0xff, 0x00]))
        return { code: 0, stdout: "", timedOut: false }
      },
    })
    const located = { path: uploaded, name: "phone.png", singleLink: true }
    await files.thumb(located)
    await files.stat(located, "screen")
    rmSync(dir, { recursive: true, force: true })
  })

  test("a snapshot path is removed when the copy fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rudder-preview-"))
    const uploaded = join(dir, "phone.png")
    writeFileSync(uploaded, PNG)
    const cacheDir = join(cacheRoot, "snap-cleanup")
    mkdirSync(cacheDir, { recursive: true })
    const leaked = join(cacheDir, "snap.snap-fixed.tmp.png")
    writeFileSync(leaked, "secret-bytes")
    const ids = ["thumb-temp", "snap-fixed"]
    let n = 0
    const original = crypto.randomUUID.bind(crypto)
    crypto.randomUUID = () => (ids[n++] as ReturnType<typeof crypto.randomUUID> | undefined) ?? original()
    try {
      const files = new FileService({
        cacheDir,
        blobBase: "https://blob.test",
        platform: "darwin",
        run: async () => {
          throw new Error("tool should not run")
        },
      })
      await expect(files.thumb({ path: uploaded, name: "phone.png", singleLink: true })).rejects.toThrow()
      expect(existsSync(leaked)).toBe(false)
      expect(readdirSync(cacheDir).filter((name) => name.startsWith("snap."))).toEqual([])
    } finally {
      crypto.randomUUID = original
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("sips output parses", () => {
    expect(parseSipsSize("/x.png\n  pixelWidth: 3000\n  pixelHeight: 1500\n")).toEqual({ width: 3000, height: 1500 })
    expect(parseSipsSize("nothing")).toBeNull()
  })
})

describe("file.ship and attachment.fetch", () => {
  const key = randomBytes(32)
  const nonce = randomBytes(12)
  const blob = (id: string, token: "uploadToken" | "downloadToken", value: string) => ({
    id,
    [token]: value,
    key: key.toString("base64"),
    nonce: nonce.toString("base64"),
  })

  test("ship encrypts with the phone's key and PUTs once; the phone's sha256 is of the plain file", async () => {
    const lane = fakeBlobLane()
    const files = new FileService({ cacheDir: join(cacheRoot, "f"), blobBase: "https://blob.test", platform: "linux", fetch: lane.impl })
    const { service, sessionId } = await serviceWith(files)
    const id = "blob-0123456789abcdef"
    const shipped = await service.invoke("file.ship", { sessionId, path: "report.pdf", variant: "original", blob: blob(id, "uploadToken", "up") }, "s")
    expect(shipped.result).toEqual({ bytes: PDF.byteLength + 16, sha256: createHash("sha256").update(PDF).digest("hex") })
    expect(lane.calls[0]).toMatchObject({ method: "PUT", url: `https://blob.test/v1/blob/${id}`, auth: "Bearer up" })
    expect(Buffer.from(openSealed(lane.stored.get(id)!, key, nonce))).toEqual(PDF)
    expect(Buffer.from(lane.stored.get(id)!).includes(Buffer.from("%PDF"))).toBe(false)

    const again = await service.invoke("file.ship", { sessionId, path: "report.pdf", blob: blob(id, "uploadToken", "up") }, "s2")
    expect(again.error?.code).toBe("conflict")
    const expired = await service.invoke("file.ship", { sessionId, path: "report.pdf", blob: blob("blob-aaaaaaaaaaaaaaaa", "uploadToken", "old") }, "s3")
    expect(expired.error?.code).toBe("expired")
    lane.setMode("down")
    const down = await service.invoke("file.ship", { sessionId, path: "report.pdf", blob: blob("blob-bbbbbbbbbbbbbbbb", "uploadToken", "up") }, "s4")
    expect(down.error?.code).toBe("blob_unreachable")
    lane.setMode("quota")
    const quota = await service.invoke("file.ship", { sessionId, path: "report.pdf", blob: blob("blob-cccccccccccccccc", "uploadToken", "up") }, "s5")
    expect(quota.error?.code).toBe("quota")
    const bad = await service.invoke("file.ship", { sessionId, path: "report.pdf", blob: { id: "x", uploadToken: "up", key: "AA==", nonce: "AA==" } }, "s6")
    expect(bad.error?.code).toBe("invalid")
  })

  // Third review: the whole blob was buffered before the 50 MB cap was checked.
  test("fetch stops reading an oversized blob at the cap instead of buffering it", async () => {
    const chunk = new Uint8Array(1024 * 1024)
    const total = 80
    let pulled = 0
    const oversized = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (pulled >= total * chunk.byteLength) return controller.close()
            pulled += chunk.byteLength
            controller.enqueue(chunk)
          },
        }),
      )) as unknown as typeof fetch
    const files = new FileService({ cacheDir: join(cacheRoot, "oversized"), blobBase: "https://blob.test", platform: "linux", fetch: oversized })
    let saved = false
    const code = await failure(files.fetchAttachment(blob("blob-oversized-00000", "downloadToken", "down"), async () => {
      saved = true
      return { id: "x", name: "x", bytes: 0 }
    }))
    expect(code).toBe("too_large")
    expect(saved).toBe(false)
    expect(pulled).toBeLessThan(total * chunk.byteLength)

    const declared = (async () => new Response("x", { headers: { "content-length": String(60 * 1024 * 1024) } })) as unknown as typeof fetch
    const early = new FileService({ cacheDir: join(cacheRoot, "declared"), blobBase: "https://blob.test", platform: "linux", fetch: declared })
    expect(await failure(early.fetchAttachment(blob("blob-declared-000000", "downloadToken", "down"), async () => ({ id: "x", name: "x", bytes: 0 })))).toBe("too_large")
  })

  test("fetch pulls, decrypts and saves once per blob id; a tampered blob is refused", async () => {
    const lane = fakeBlobLane()
    const files = new FileService({ cacheDir: join(cacheRoot, "g"), blobBase: "https://blob.test", platform: "linux", fetch: lane.impl })
    const { service, sessionId } = await serviceWith(files)
    const id = "blob-fedcba9876543210"
    lane.stored.set(id, seal(PNG, key, nonce))
    const params = { sessionId, name: "from-phone.png", blob: blob(id, "downloadToken", "down") }
    const first = (await service.invoke("attachment.fetch", params, "f1")).result as { attachment: { id: string; name: string; bytes: number } }
    expect(first.attachment).toMatchObject({ name: "from-phone.png", bytes: PNG.byteLength })
    const retry = (await service.invoke("attachment.fetch", params, "f2")).result as { attachment: { id: string } }
    expect(retry.attachment.id).toBe(first.attachment.id)
    const dir = join(folder, ".rudder", "attachments", sessionId)
    expect(readdirSync(dir)).toHaveLength(1)
    expect(statSync(join(dir, readdirSync(dir)[0]!)).size).toBe(PNG.byteLength)

    const tampered = seal(PNG, key, nonce)
    tampered[0] = tampered[0]! ^ 1
    lane.stored.set("blob-tampered-000000", tampered)
    const refused = await service.invoke("attachment.fetch", { ...params, blob: blob("blob-tampered-000000", "downloadToken", "down") }, "f3")
    expect(refused.error?.code).toBe("invalid")
  })
})
