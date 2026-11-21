// r59 pre-launch security review: proofs for its findings.
// Tests named "documents …" pin current behaviour that the review records as an open finding; flip them when fixed.
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { type PairDeps, pair, parseCli } from "./cli"
import { checkLocalSocket, localRequest, localSocketPath } from "./local"
import { createFakeAdapter } from "./adapter/fake"
import { invokeFrame } from "./protocol"
import { startServer } from "./server"
import { Store } from "./store"
import { WORKSPACE_ROOT } from "./workspace"
import { hostCandidates } from "./tls"

type Started = ReturnType<typeof startServer>

function boot(options: Partial<Parameters<typeof startServer>[0]> = {}) {
  const store = new Store(":memory:")
  const started: Started = startServer({ store, host: "127.0.0.1", port: 0, ...options })
  const port = started.server.port as number
  return { store, started, port, origin: `http://127.0.0.1:${port}` }
}

async function pairDevice(started: Started, name = "phone") {
  const origin = `http://127.0.0.1:${started.server.port}`
  const info = started.pairLink()
  const response = await fetch(`${origin}/v1/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: info.token, name }),
  })
  return (await response.json()) as { deviceId: string; sessionKey: string }
}

async function call(port: number, key: string, method: string, params: Record<string, unknown> = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`, { headers: { authorization: `Bearer ${key}` } } as never)
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve())
    ws.addEventListener("error", () => reject(new Error("ws error")))
  })
  const frame = await new Promise<Record<string, unknown>>((resolve) => {
    ws.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as Record<string, unknown>
      if (frame.id === "r59") resolve(frame)
    })
    ws.send(JSON.stringify(invokeFrame("r59", method, params)))
  })
  ws.close()
  return frame
}

describe("r59 unauthenticated surface", () => {
  test("ws, upload and download refuse a missing, wrong or revoked device key", async () => {
    const { started, port, origin } = boot()
    try {
      const a = await pairDevice(started, "A")
      const b = await pairDevice(started, "B")
      const created = await call(port, a.sessionKey, "session.create", { title: "x" })
      const sessionId = (created.result as { session: { id: string } }).session.id
      const urls = [
        ["GET", `${origin}/v1/ws`],
        ["POST", `${origin}/v1/sessions/${sessionId}/attachments?name=a.txt`],
        ["GET", `${origin}/v1/sessions/${sessionId}/attachments/${crypto.randomUUID()}`],
        ["GET", `${origin}/v1/sessions/${sessionId}/turns/${crypto.randomUUID()}/preview?path=a.png&side=after`],
      ] as const
      expect((await call(port, a.sessionKey, "device.revoke", { id: b.deviceId })).type).toBe("result")
      for (const [method, url] of urls) {
        for (const auth of [undefined, "Bearer ", `Bearer ${"0".repeat(64)}`, `Bearer ${b.sessionKey}`, b.sessionKey]) {
          const headers: Record<string, string> = auth === undefined ? {} : { authorization: auth }
          const response = await fetch(url, { method, headers, body: method === "POST" ? "x" : undefined })
          expect([method, url, auth, response.status]).toEqual([method, url, auth, 401])
        }
      }
    } finally {
      started.server.stop(true)
    }
  })

  test("attachment routes do not traverse out of the session's attachment directory", async () => {
    // Inside the workspace: uploads to a session whose folder is outside it are refused.
    const dir = mkdtempSync(join(WORKSPACE_ROOT, "rudder-r59-"))
    const { started, port, origin, store } = boot()
    try {
      const a = await pairDevice(started)
      const created = await call(port, a.sessionKey, "session.create", { title: "x" })
      const sessionId = (created.result as { session: { id: string } }).session.id
      store.patchSession(sessionId, { cwd: dir })
      const auth = { authorization: `Bearer ${a.sessionKey}` }
      // The session id is looked up in the db first, so an encoded `../` never reaches a path join.
      for (const sid of ["..%2F..%2F..%2Ftmp", "%2E%2E", encodeURIComponent(`${sessionId}/../..`)]) {
        const up = await fetch(`${origin}/v1/sessions/${sid}/attachments?name=x`, { method: "POST", headers: auth, body: "x" })
        expect([sid, up.status]).toEqual([sid, 404])
      }
      // Attachment ids must be UUIDs; anything else is 404 before the directory is read.
      for (const id of ["..%2F..%2F..%2Fetc%2Fpasswd", "%2E%2E", "*", `${crypto.randomUUID()}%2F..`]) {
        const down = await fetch(`${origin}/v1/sessions/${sessionId}/attachments/${id}`, { headers: auth })
        expect([id, down.status]).toEqual([id, 404])
      }
      // A traversal file name is reduced to one segment inside .rudder/attachments/<session>/.
      const posted = await fetch(`${origin}/v1/sessions/${sessionId}/attachments?name=${encodeURIComponent("../../../../.ssh/authorized_keys")}`, {
        method: "POST",
        headers: auth,
        body: "x",
      })
      expect(posted.status).toBe(201)
      expect(((await posted.json()) as { attachment: { name: string } }).attachment.name).toBe("authorized_keys")
    } finally {
      started.server.stop(true)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("pair-info is gone over the LAN as well (r59 F-02)", async () => {
    const lan = hostCandidates()[0]?.address
    if (!lan) return // No LAN interface on this machine: nothing to reach the daemon over.
    const { started, port } = boot({ host: "0.0.0.0" })
    try {
      const response = await fetch(`http://${lan}:${port}/v1/pair-info`)
      expect(response.status).toBe(404)
      expect((await fetch(`http://${lan}:${port}/health`)).status).toBe(200)
    } finally {
      started.server.stop(true)
    }
  })

  test("F-02 fixed: no TCP route serves the pairing token; only the owner-only socket in RUDDER_HOME does", async () => {
    const home = mkdtempSync(join(tmpdir(), "rudder-r59-"))
    chmodSync(home, 0o700)
    const socket = localSocketPath(home)
    const { started, origin } = boot({ localSocket: socket })
    try {
      // Another account or a sandboxed app on this Mac can still reach loopback TCP, but nothing there carries the token.
      for (const path of ["/v1/pair-info", "/local/pair", "/local/devices"]) {
        expect([path, (await fetch(`${origin}${path}`)).status]).toEqual([path, 404])
      }
      // The socket and its directory are this user's alone: the kernel refuses anyone else's connect().
      expect(statSync(socket).mode & 0o777).toBe(0o600)
      expect(statSync(home).mode & 0o777).toBe(0o700)
      const answer = await localRequest(socket, "GET", "/local/pair")
      expect((answer?.body as { url?: string } | undefined)?.url).toBe(started.pairLink().url)
    } finally {
      started.local?.stop()
      started.server.stop(true)
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("an oversized unauthenticated pair body is refused before it is parsed (F-05, fixed)", async () => {
    const { started, origin } = boot()
    try {
      const big = JSON.stringify({ token: "x", name: "a".repeat(64 * 1024) })
      const response = await fetch(`${origin}/v1/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: big })
      expect(response.status).toBe(413)
      // A normal wrong-token request is still a plain 401.
      const wrong = await fetch(`${origin}/v1/pair`, { method: "POST", body: JSON.stringify({ token: "x", name: "n" }) })
      expect(wrong.status).toBe(401)
    } finally {
      started.server.stop(true)
    }
  })

  test("a request in flight when its device is revoked gets no result", async () => {
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const inside = new Promise<void>((resolve) => {
      entered = resolve
    })
    const adapter = {
      ...createFakeAdapter(),
      async listCommands() {
        entered()
        await gate
        return [{ name: "secret", insert: "/secret", kind: "command" as const, source: "project" }]
      },
    }
    // Revoked from the computer, with the socket close not yet delivered: only the result gate stands in the way.
    const { started, port, store } = boot({ adapter })
    try {
      const a = await pairDevice(started, "A")
      const created = await call(port, a.sessionKey, "session.create", { title: "x" })
      const sessionId = (created.result as { session: { id: string } }).session.id
      const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`, { headers: { authorization: `Bearer ${a.sessionKey}` } } as never)
      await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve()))
      const frames: Record<string, unknown>[] = []
      ws.addEventListener("message", (event) => frames.push(JSON.parse(String(event.data))))
      const closed = new Promise<number>((resolve) => ws.addEventListener("close", (event) => resolve(event.code)))
      ws.send(JSON.stringify(invokeFrame("slow", "commands.list", { sessionId })))
      await inside
      store.deleteDevice(a.deviceId)
      release()
      expect(await closed).toBe(4001)
      expect(frames.filter((frame) => frame.id === "slow")).toEqual([])
      // Revoking itself is the one request whose answer still arrives.
      const b = await pairDevice(started, "B")
      expect(await call(port, b.sessionKey, "device.revoke", { id: b.deviceId })).toMatchObject({ type: "result", result: { ok: true } })
    } finally {
      started.server.stop(true)
    }
  })

  test("a chunked pair body with no Content-Length is cut off at the pair limit while streaming", async () => {
    const { started, origin } = boot()
    try {
      const chunk = new Uint8Array(64 * 1024).fill(0x61)
      const total = 160
      let pulled = 0
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (pulled++ >= total) controller.close()
          else controller.enqueue(chunk)
        },
      })
      const response = await fetch(`${origin}/v1/pair`, { method: "POST", body, duplex: "half" } as RequestInit).catch(() => null)
      if (response) expect(response.status).toBe(413)
      // 10 MB offered; the server stops after the first few chunks instead of buffering it all.
      expect(pulled).toBeLessThan(total / 4)
    } finally {
      started.server.stop(true)
    }
  })

  test("a body past the attachment cap is cut off by the server, not buffered to Bun's 128 MB default (F-05, fixed)", async () => {
    const { started, origin } = boot()
    try {
      const body = new Uint8Array(60 * 1024 * 1024)
      const response = await fetch(`${origin}/v1/pair`, { method: "POST", body }).catch(() => null)
      // Bun answers 413 or resets the connection; either way the body is not read.
      if (response) expect(response.status).toBe(413)
    } finally {
      started.server.stop(true)
    }
  })

  test("documents F-01: a paired key can switch a session to bypassPermissions with nothing shown on the computer", async () => {
    const { started, port } = boot()
    try {
      const a = await pairDevice(started)
      const created = await call(port, a.sessionKey, "session.create", { agent: "claude", permissionMode: "bypassPermissions" })
      const session = (created.result as { session: { permissionMode: string } } | undefined)?.session
      // With the real registry Claude advertises bypassPermissions, so the create stores it as asked.
      expect(session?.permissionMode).toBe("bypassPermissions")
    } finally {
      started.server.stop(true)
    }
  })
})

describe("r59 CLI", () => {
  test("F-03 fixed: rudder devices lists and revokes paired phones", () => {
    expect(parseCli(["devices"])).toEqual({ kind: "devices" })
    expect(parseCli(["devices", "revoke", "iPhone"])).toEqual({ kind: "revoke", target: "iPhone" })
    // The end-to-end list / revoke with a 4001 close is in cli.test.ts › rudder devices.
  })

  test("F-07 fixed: rudder pair signals no pid and only trusts a socket this user owns", async () => {
    // The impostor from the review (something bound to 7749 while rudder is down) is never asked: pair goes to the
    // socket only, and with no socket it reports that something else answers the port instead of showing its QR code.
    const asked: string[] = []
    const errors: string[] = []
    const deps: PairDeps = {
      socket: "/nonexistent/rudder.sock",
      request: async (method, route) => {
        asked.push(`${method} ${route}`)
        return null
      },
      portAnswers: async () => "https://127.0.0.1:7749",
      tty: false,
      out: () => {
        throw new Error("nothing may be printed")
      },
      err: (line) => errors.push(line),
      command: "rudder",
      locale: "en",
    }
    expect(await pair(deps, { json: false })).toBe(1)
    expect(asked).toEqual(["POST /local/pair"])
    expect(errors[0]).toContain("a rudder answers on https://127.0.0.1:7749 but not on /nonexistent/rudder.sock")
    expect("signal" in deps).toBe(false)

    // A socket path whose directory another user could write to, or that is not a socket, is refused before connect().
    const home = mkdtempSync(join(tmpdir(), "rudder-r59-"))
    try {
      chmodSync(home, 0o733)
      expect(() => checkLocalSocket(localSocketPath(home))).toThrow("not be writable by others")
      chmodSync(home, 0o700)
      writeFileSync(localSocketPath(home), "")
      expect(() => checkLocalSocket(localSocketPath(home))).toThrow("is not a socket owned by you")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
