import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { FAKE_SPEC } from "./adapter/fake"
import type { AdapterImage, AgentAdapter } from "./adapter/types"
import { exifJpeg } from "./fixtures/exif-jpeg"
import { ATTACHMENT_LIMIT_BYTES, attachmentDir, findAttachment, readPlainFile, safeName, saveAttachment, withAttachments } from "./attachments"
import { invokeFrame } from "./protocol"
import { startServer } from "./server"
import { Store } from "./store"

describe("attachment names", () => {
  test("keep one safe path segment", () => {
    expect(safeName("../../etc/passwd")).toBe("passwd")
    expect(safeName("C:\\Users\\me\\截图 1.png")).toBe("截图 1.png")
    expect(safeName(".env")).toBe("env")
    expect(safeName("..")).toBe("file")
    expect(safeName("a\u0000b\nc.txt")).toBe("abc.txt")
    expect([...safeName(`${"长".repeat(200)}.md`)].length).toBe(120)
    expect(safeName(`${"长".repeat(200)}.md`).endsWith(".md")).toBe(true)
  })

  test("the agent gets the paths after the text", () => {
    const one = { id: "i", name: "a.png", path: "/w/.rudder/attachments/s/i-a.png", bytes: 1 }
    expect(withAttachments("look", [one])).toBe("look\n\nAttached files (on this computer):\n- /w/.rudder/attachments/s/i-a.png")
    expect(withAttachments("", [one])).toBe("Attached files (on this computer):\n- /w/.rudder/attachments/s/i-a.png")
    expect(withAttachments("plain", [])).toBe("plain")
  })
})

describe("reading an attachment back", () => {
  test("refuses symlinks, files outside the roots, and files over the cap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rudder-read-"))
    const outside = mkdtempSync(join(tmpdir(), "rudder-outside-"))
    try {
      const sessionId = "s1"
      const folder = attachmentDir(dir, sessionId)
      mkdirSync(folder, { recursive: true })
      const id = crypto.randomUUID()
      const linkId = crypto.randomUUID()
      writeFileSync(join(folder, `${id}-a.png`), "12345")
      writeFileSync(join(outside, "secret"), "top secret")
      symlinkSync(join(outside, "secret"), join(folder, `${linkId}-b.png`))
      expect(await findAttachment(dir, sessionId, linkId)).toBeNull()
      const found = await findAttachment(dir, sessionId, id)
      expect(found?.bytes).toBe(5)
      expect(new TextDecoder().decode(await readPlainFile(found!.path, 5, [folder]))).toBe("12345")
      await expect(readPlainFile(found!.path, 4, [folder])).rejects.toMatchObject({ code: "too_large" })
      await expect(readPlainFile(join(folder, `${linkId}-b.png`), 100, [folder])).rejects.toMatchObject({ code: "not_file" })
      await expect(readPlainFile(join(outside, "secret"), 100, [folder])).rejects.toMatchObject({ code: "outside" })
      // A directory swapped for a symlink to elsewhere: the real path leaves the root.
      const swapped = join(dir, "swapped")
      symlinkSync(outside, swapped)
      await expect(readPlainFile(join(swapped, "secret"), 100, [dir])).rejects.toMatchObject({ code: "outside" })
      await expect(readPlainFile(join(folder, "missing"), 100, [folder])).rejects.toMatchObject({ code: "not_found" })
      // An upload swapped for a hard link to a file outside: a plain file whose real path is inside the folder.
      const hardId = crypto.randomUUID()
      const hard = join(folder, `${hardId}-c.png`)
      linkSync(join(outside, "secret"), hard)
      expect(await findAttachment(dir, sessionId, hardId)).toBeNull()
      await expect(readPlainFile(hard, 100, [folder], true)).rejects.toMatchObject({ code: "not_file" })
      expect(new TextDecoder().decode(await readPlainFile(hard, 100, [folder]))).toBe("top secret")
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

// Third review: with the attachments folder (or a folder above it) a symlink, uploads were written outside the
// session's folder.
describe("attachment folder confinement", () => {
  test.each([".rudder", ".rudder/attachments", ".rudder/attachments/s1"])("a symlinked %s is neither written nor read", async (linked) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "rudder-confine-")))
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "rudder-confine-out-")))
    try {
      const parent = join(dir, linked, "..")
      mkdirSync(parent, { recursive: true })
      symlinkSync(outside, join(dir, linked))
      await expect(saveAttachment(dir, "s1", "a.txt", new TextEncoder().encode("hi"))).rejects.toMatchObject({ code: "forbidden" })
      expect(readdirSync(outside)).toEqual([])
      const id = crypto.randomUUID()
      const target = join(dir, ".rudder", "attachments", "s1")
      mkdirSync(join(outside, ...relative(join(dir, linked), target).split("/").filter(Boolean)), { recursive: true })
      writeFileSync(join(target, `${id}-planted.txt`), "outside")
      expect(await findAttachment(dir, "s1", id)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test("a plain folder still takes uploads", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rudder-confine-ok-"))
    try {
      const saved = await saveAttachment(dir, "s1", "a.txt", new TextEncoder().encode("hi"))
      expect((await findAttachment(dir, "s1", saved.id))?.bytes).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("upload, send, delete", () => {
  let cwd = ""
  let store: Store
  let started: ReturnType<typeof startServer>
  let origin = ""
  let key = ""
  let sessionId = ""
  const heard: string[] = []
  const seen: AdapterImage[][] = []
  const adapter: AgentAdapter = {
    spec: { ...FAKE_SPEC, id: "claude", label: "Claude" },
    async reply(text, ctx) {
      heard.push(text)
      seen.push(ctx.images ?? [])
    },
  }

  beforeAll(async () => {
    cwd = realpathSync(mkdtempSync(join(tmpdir(), "rudder-attach-")))
    store = new Store(":memory:")
    sessionId = store.createSession({ title: "t", agent: "claude", cwd }).id
    started = startServer({ store, host: "127.0.0.1", port: 0, adapter, workspaceRoot: cwd })
    origin = `http://127.0.0.1:${started.server.port}`
    const info = started.pairLink()
    const paired = (await (
      await fetch(`${origin}/v1/pair`, { method: "POST", body: JSON.stringify({ token: info.token, name: "t" }) })
    ).json()) as { sessionKey: string }
    key = paired.sessionKey
  })

  afterAll(() => {
    started.server.stop(true)
    rmSync(cwd, { recursive: true, force: true })
  })

  const upload = (name: string, body: string | Uint8Array, auth = key, session = sessionId) =>
    fetch(`${origin}/v1/sessions/${session}/attachments?name=${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${auth}` },
      body,
    })

  async function call(method: string, params: Record<string, unknown>) {
    const ws = new WebSocket(`ws://127.0.0.1:${started.server.port}/v1/ws`, { headers: { authorization: `Bearer ${key}` } } as never)
    await new Promise((resolve) => ws.addEventListener("open", resolve))
    const frame = await new Promise<Record<string, unknown>>((resolve) => {
      ws.addEventListener("message", (event) => {
        const parsed = JSON.parse(String(event.data)) as Record<string, unknown>
        if (parsed.id === "x") resolve(parsed)
      })
      ws.send(JSON.stringify(invokeFrame("x", method, params)))
    })
    ws.close()
    return frame
  }

  test("an upload lands in the session's working directory, git-ignored, and the agent is told its path", async () => {
    const response = await upload("截图 1.png", new Uint8Array([1, 2, 3]))
    expect(response.status).toBe(201)
    const { attachment } = (await response.json()) as { attachment: { id: string; name: string; bytes: number } }
    expect(attachment).toMatchObject({ name: "截图 1.png", bytes: 3 })
    const path = join(attachmentDir(cwd, sessionId), `${attachment.id}-截图 1.png`)
    expect([...readFileSync(path)]).toEqual([1, 2, 3])
    expect(readFileSync(join(cwd, ".rudder", ".gitignore"), "utf8")).toBe("*\n")

    const sent = await call("message.send", { sessionId, text: "what is this?", attachments: [attachment.id] })
    expect(sent.type).toBe("result")
    await Bun.sleep(50)
    expect(heard.at(-1)).toBe(`what is this?\n\nAttached files (on this computer):\n- ${path}`)
    expect(seen.at(-1)).toEqual([{ path, mediaType: "image/png", bytes: 3 }])

    // The user's message keeps its own text; the attachment rides along by name and size, never by path.
    const page = await call("session.get", { id: sessionId })
    const messages = (page.result as { messages: Array<{ role: string; text: string; attachments?: unknown }> }).messages
    const mine = messages.find((message) => message.role === "user")
    expect(mine?.text).toBe("what is this?")
    expect(mine?.attachments).toEqual([{ id: attachment.id, name: "截图 1.png", bytes: 3 }])
  })

  test("a photo's message carries its pixel size from the header (r75), other files do not", async () => {
    // PNG signature + IHDR (length 13) with width 1170, height 2532.
    const png = new Uint8Array(33)
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
    new DataView(png.buffer).setUint32(16, 1170)
    new DataView(png.buffer).setUint32(20, 2532)
    const photo = ((await (await upload("shot.png", png)).json()) as { attachment: { id: string } }).attachment
    const note = ((await (await upload("notes.txt", "hello")).json()) as { attachment: { id: string } }).attachment
    const sent = await call("message.send", { sessionId, text: "sized", attachments: [photo.id, note.id] })
    expect(sent.type).toBe("result")
    const page = await call("session.get", { id: sessionId })
    const messages = (page.result as { messages: Array<{ role: string; text: string; attachments?: unknown }> }).messages
    expect(messages.find((message) => message.text === "sized")?.attachments).toEqual([
      { id: photo.id, name: "shot.png", bytes: 33, width: 1170, height: 2532 },
      { id: note.id, name: "notes.txt", bytes: 5 },
    ])
  })

  test("a portrait photo's size follows its EXIF orientation, as the phone draws it", async () => {
    const photo = ((await (await upload("IMG_1.jpg", exifJpeg(6, 4032, 3024))).json()) as { attachment: { id: string } }).attachment
    const sent = await call("message.send", { sessionId, text: "portrait", attachments: [photo.id] })
    expect(sent.type).toBe("result")
    const page = await call("session.get", { id: sessionId })
    const messages = (page.result as { messages: Array<{ text: string; attachments?: Array<{ width?: number; height?: number }> }> }).messages
    const sized = messages.find((message) => message.text === "portrait")?.attachments?.[0]
    expect([sized?.width, sized?.height]).toEqual([3024, 4032])
  })

  test("refusals: no key, unknown session, over the limit, unknown id", async () => {
    expect((await upload("a.txt", "x", "wrong-key")).status).toBe(401)
    expect((await upload("a.txt", "x", key, "no-such-session")).status).toBe(404)
    const big = await upload("big.bin", new Uint8Array(ATTACHMENT_LIMIT_BYTES + 1))
    expect(big.status).toBe(413)
    const unknown = await call("message.send", { sessionId, text: "hi", attachments: ["00000000-0000-4000-8000-000000000000"] })
    expect((unknown.error as { code: string }).code).toBe("not_found")
    const traversal = await call("message.send", { sessionId, text: "hi", attachments: ["../../x"] })
    expect((traversal.error as { code: string }).code).toBe("not_found")
    const malformed = await call("message.send", { sessionId, text: "hi", attachments: "nope" })
    expect((malformed.error as { code: string }).code).toBe("invalid")
  })

  test("deleting the session removes its attachments", async () => {
    expect(existsSync(attachmentDir(cwd, sessionId))).toBe(true)
    const deleted = await call("session.delete", { id: sessionId })
    expect(deleted.type).toBe("result")
    expect(existsSync(attachmentDir(cwd, sessionId))).toBe(false)
  })
})
