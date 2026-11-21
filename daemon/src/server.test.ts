import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { createFakeAdapter } from "./adapter/fake"
import { Reassembler } from "./relay/frame"
import { eventFrame, invokeFrame, type Frame } from "./protocol"
import { startServer } from "./server"
import { Store } from "./store"
import { WORKSPACE_ROOT } from "./workspace"

// The link names the platform it was printed on (win32 / darwin only).
const OS = process.platform === "win32" || process.platform === "darwin" ? `&os=${process.platform}` : ""

describe("HTTP pairing and websocket", () => {
  test("health, pair, list sessions over ws", async () => {
    const store = new Store(":memory:")
    store.seedIfEmpty()
    const started = startServer({ store, host: "127.0.0.1", port: 0 })
    const port = started.server.port
    const origin = `http://127.0.0.1:${port}`

    const health = await (await fetch(`${origin}/health`)).json() as { ok: boolean }
    expect(health.ok).toBe(true)

    const info = started.pairLink()
    // Plain HTTP (RUDDER_TLS=0 path): the link has no fp, which the app reads as http/ws.
    expect(started.fingerprint).toBeNull()
    expect(info.url).toBe(`rudder://pair?host=127.0.0.1:${port}&exp=${Math.floor(info.expiresAt / 1000)}${OS}&token=${info.token}`)
    // The token is not served over TCP any more (r59 F-02).
    expect((await fetch(`${origin}/v1/pair-info`)).status).toBe(404)
    const paired = await (await fetch(`${origin}/v1/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: info.token, name: "test" }),
    })).json() as { sessionKey: string }
    expect(paired.sessionKey.length).toBeGreaterThan(10)

    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`, {
      headers: { authorization: `Bearer ${paired.sessionKey}` },
    })
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve())
      ws.addEventListener("error", () => reject(new Error("ws error")))
    })

    const listed = await new Promise<Record<string, unknown>>((resolve) => {
      ws.addEventListener("message", (event) => {
        resolve(JSON.parse(String(event.data)) as Record<string, unknown>)
      })
      ws.send(JSON.stringify(invokeFrame("list-1", "session.list", {})))
    })
    expect(listed.type).toBe("result")
    ws.close()
    started.server.stop(true)
  })
})

describe("chunked frames on a direct socket", () => {
  test("a phone that sends X-Rudder-Chunks gets a large frame as binary chunks; one that does not gets it whole", async () => {
    const store = new Store(":memory:")
    const started = startServer({ store, host: "127.0.0.1", port: 0 })
    const port = started.server.port as number
    const info = started.pairLink()
    const paired = await (await pair(`http://127.0.0.1:${port}`, info.token, "test")).json() as { sessionKey: string }
    const open = async (headers: Record<string, string>) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`, { headers: { authorization: `Bearer ${paired.sessionKey}`, ...headers } } as never)
      ws.binaryType = "arraybuffer"
      const messages: Array<string | ArrayBuffer> = []
      ws.addEventListener("message", (event) => messages.push(event.data as string | ArrayBuffer))
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve())
        ws.addEventListener("error", () => reject(new Error("ws error")))
      })
      ws.send(JSON.stringify(invokeFrame("l", "session.list", {})))
      while (messages.length === 0) await Bun.sleep(5)
      messages.length = 0
      return { ws, messages }
    }
    const chunked = await open({ "x-rudder-chunks": "1" })
    const plain = await open({})
    started.broadcast(eventFrame("machine.upsert", { name: "m".repeat(150_000) }))
    while (plain.messages.length === 0 || !chunked.messages.some((m) => m instanceof ArrayBuffer && new Uint8Array(m)[0] === 1)) {
      await Bun.sleep(5)
    }
    expect(plain.messages.length).toBe(1)
    expect(typeof plain.messages[0]).toBe("string")
    const chunks = chunked.messages.map((m) => new Uint8Array(m as ArrayBuffer))
    expect(chunks.map((c) => c[0])).toEqual([0, 0, 1])
    const joined = Buffer.concat(chunks.map((c) => c.subarray(1))).toString("utf8")
    expect(joined).toBe(plain.messages[0] as string)
    chunked.ws.close()
    plain.ws.close()
    started.server.stop(true)
  })
})

type Started = ReturnType<typeof startServer>

async function pair(origin: string, token: string, name: string) {
  return fetch(`${origin}/v1/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, name }),
  })
}

// The token reaches the CLI over the local socket only (cli.test.ts); here the test reads it in-process.
async function pairInfo(source: Started) {
  return source.pairLink()
}

type Client = {
  ws: WebSocket
  closed: Promise<{ code: number }>
  call(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>
}

async function connect(port: number, sessionKey: string): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`, { headers: { authorization: `Bearer ${sessionKey}` } } as never)
  const closed = new Promise<{ code: number }>((resolve) => ws.addEventListener("close", (event) => resolve({ code: event.code })))
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve())
    ws.addEventListener("error", () => reject(new Error("ws error")))
  })
  const waiting = new Map<string, (frame: Record<string, unknown>) => void>()
  ws.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data)) as Record<string, unknown>
    waiting.get(String(frame.id))?.(frame)
  })
  return {
    ws,
    closed,
    call(method, params = {}) {
      const id = crypto.randomUUID()
      return new Promise((resolve) => {
        waiting.set(id, resolve)
        ws.send(JSON.stringify(invokeFrame(id, method, params)))
      })
    },
  }
}

describe("pairing lifecycle and devices", () => {
  let started: Started
  const boot = (options: Partial<Parameters<typeof startServer>[0]> = {}) => {
    const store = new Store(":memory:")
    started = startServer({ store, host: "127.0.0.1", port: 0, ...options })
    return { store, port: started.server.port as number, origin: `http://127.0.0.1:${started.server.port}` }
  }

  test("a pair link is single use and the daemon announces the next one", async () => {
    let rotated = 0
    const { origin } = boot({
      onPairingRotated: () => {
        rotated += 1
      },
    })
    const info = await pairInfo(started)
    expect(info.expiresAt).toBeGreaterThan(Date.now())
    expect(started.pairLink().url).toBe(info.url)
    expect((await pair(origin, info.token, "one")).status).toBe(200)
    expect(rotated).toBe(1)
    expect((await pair(origin, info.token, "two")).status).toBe(401)
    const next = await pairInfo(started)
    expect(next.token).not.toBe(info.token)
    expect(started.pairLink().url).toBe(next.url)
    expect((await pair(origin, next.token, "two")).status).toBe(200)
    started.server.stop(true)
  })

  test("the link printed without a token has no token in it", () => {
    boot()
    const link = started.pairLink()
    expect(link.url).toContain(`token=${link.token}`)
    expect(link.redacted).not.toContain("token")
    expect(link.redacted).not.toContain(link.token)
    started.server.stop(true)
  })

  test("device.list marks the caller; device.revoke deletes the device and closes its sockets", async () => {
    const { origin, port, store } = boot()
    const a = (await (await pair(origin, (await pairInfo(started)).token, "A")).json()) as { deviceId: string; sessionKey: string }
    const b = (await (await pair(origin, (await pairInfo(started)).token, "B")).json()) as { deviceId: string; sessionKey: string }
    const clientA = await connect(port, a.sessionKey)
    const clientB = await connect(port, b.sessionKey)

    const listed = await clientA.call("device.list")
    const devices = (listed.result as { devices: Array<{ id: string; name: string; createdAt: number; current: boolean }> }).devices
    expect(devices.map((device) => [device.name, device.current])).toEqual([
      ["A", true],
      ["B", false],
    ])
    expect(Object.keys(devices[0]!).sort()).toEqual(["createdAt", "current", "id", "name"])

    const revoked = await clientA.call("device.revoke", { id: b.deviceId })
    expect(revoked.type).toBe("result")
    expect((await clientB.closed).code).toBe(4001)
    expect(store.deviceByKey(b.sessionKey)).toBeNull()
    const retry = await fetch(`${origin}/v1/ws`, { headers: { authorization: `Bearer ${b.sessionKey}`, upgrade: "websocket" } })
    expect(retry.status).toBe(401)

    const missing = await clientA.call("device.revoke", { id: "nope" })
    expect((missing.error as { code: string }).code).toBe("not_found")

    const self = await clientA.call("device.revoke", { id: a.deviceId })
    expect(self.type).toBe("result")
    expect((await clientA.closed).code).toBe(4001)
    started.server.stop(true)
  })

  test("a throw outside the service answers that request and keeps the socket", async () => {
    const { origin, port, store } = boot()
    const a = (await (await pair(origin, (await pairInfo(started)).token, "A")).json()) as { sessionKey: string }
    const client = await connect(port, a.sessionKey)
    const lookup = store.deviceByKey.bind(store)
    let calls = 0
    // The first lookup passes the revoked check; the next one fails like a busy database would.
    store.deviceByKey = (key: string) => {
      calls += 1
      if (calls === 2) throw new Error("SQLITE_BUSY: database is locked")
      return lookup(key)
    }
    const failed = await client.call("session.list")
    expect(failed.type).toBe("error")
    expect((failed.error as { code: string; message: string }).message).toContain("SQLITE_BUSY")
    store.deviceByKey = lookup
    expect((await client.call("session.list")).type).toBe("result")
    client.ws.close()
    started.server.stop(true)
  })

  test("requests for a foreign Host are refused (DNS rebinding)", async () => {
    const { origin, port } = boot()
    const evil = await fetch(`${origin}/v1/pair`, { method: "POST", body: "{}", headers: { host: `evil.example:${port}` } })
    expect(evil.status).toBe(403)
    const health = await fetch(`${origin}/health`, { headers: { host: "rebind.attacker.test" } })
    expect(health.status).toBe(403)
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, "127.0.0.1"]) {
      const ok = await fetch(`${origin}/health`, { headers: { host } })
      expect(ok.status).toBe(200)
    }
    started.server.stop(true)
  })

  test("the advertised host is accepted", async () => {
    const { origin, port } = boot({ advertiseHost: "10.9.8.7" })
    const ok = await fetch(`${origin}/health`, { headers: { host: `10.9.8.7:${port}` } })
    expect(ok.status).toBe(200)
    started.server.stop(true)
  })

  test("a malformed session path answers 401 before pairing and a plain 400 after, never an error page", async () => {
    const { origin } = boot()
    // Off, so an uncaught throw answers the error() handler's bare 500, not Bun's ~50 KB page with source.
    expect(started.server.development).toBe(false)
    const routes: [string, string][] = [
      ["POST", "/v1/sessions/%E0%A4%A/attachments?name=a.png"],
      ["GET", "/v1/sessions/%E0%A4%A/attachments/x"],
      ["GET", "/v1/sessions/s/attachments/%"],
      ["GET", "/v1/sessions/%/turns/t/preview"],
      ["GET", "/v1/sessions/s/turns/%ZZ/preview"],
    ]
    for (const [method, path] of routes) {
      const stranger = await fetch(`${origin}${path}`, { method, ...(method === "POST" ? { body: "x" } : {}) })
      expect(stranger.status).toBe(401)
      expect((await stranger.text()).length).toBeLessThan(100)
    }
    const paired = (await (await pair(origin, (await pairInfo(started)).token, "phone")).json()) as { sessionKey: string }
    for (const [method, path] of routes) {
      const bad = await fetch(`${origin}${path}`, {
        method,
        headers: { authorization: `Bearer ${paired.sessionKey}` },
        ...(method === "POST" ? { body: "x" } : {}),
      })
      expect(bad.status).toBe(400)
      expect((await bad.text()).length).toBeLessThan(100)
    }
    started.server.stop(true)
  })

  test("GET returns attachment bytes to a paired device", async () => {
    // Inside the workspace: uploads to a session whose folder is outside it are refused.
    const dir = mkdtempSync(join(WORKSPACE_ROOT, "rudder-att-"))
    const { origin, port, store } = boot()
    try {
      const paired = (await (await pair(origin, (await pairInfo(started)).token, "phone")).json()) as { sessionKey: string }
      const client = await connect(port, paired.sessionKey)
      const created = await client.call("session.create", { title: "img" })
      const sessionId = (created.result as { session: { id: string } }).session.id
      store.patchSession(sessionId, { cwd: dir })
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVQI12P4z8AAAAADAAEABf4C/tzMWecAAAAASUVORK5CYII=",
        "base64",
      )
      const posted = await fetch(`${origin}/v1/sessions/${sessionId}/attachments?name=launch-poster.png`, {
        method: "POST",
        headers: { authorization: `Bearer ${paired.sessionKey}` },
        body: png,
      })
      expect(posted.status).toBe(201)
      const uploaded = (await posted.json()) as { attachment: { id: string } }
      const got = await fetch(`${origin}/v1/sessions/${sessionId}/attachments/${uploaded.attachment.id}`, {
        headers: { authorization: `Bearer ${paired.sessionKey}` },
      })
      expect(got.status).toBe(200)
      expect(got.headers.get("content-type")).toBe("image/png")
      expect(Buffer.from(await got.arrayBuffer())).toEqual(png)
      expect((await fetch(`${origin}/v1/sessions/${sessionId}/attachments/${uploaded.attachment.id}`)).status).toBe(401)
      const missing = await fetch(`${origin}/v1/sessions/${sessionId}/attachments/not-an-id`, {
        headers: { authorization: `Bearer ${paired.sessionKey}` },
      })
      expect(missing.status).toBe(404)
      const other = await client.call("session.create", { title: "other" })
      const otherId = (other.result as { session: { id: string } }).session.id
      const wrong = await fetch(`${origin}/v1/sessions/${otherId}/attachments/${uploaded.attachment.id}`, {
        headers: { authorization: `Bearer ${paired.sessionKey}` },
      })
      expect(wrong.status).toBe(404)
      client.ws.close()
    } finally {
      started.server.stop(true)
      rmSync(dir, { recursive: true, force: true })
    }
  })
})


describe("message body pages over direct transport", () => {
  test("sendGuarded chunks each bounded page and leaves legacy errors explicit", async () => {
    const store = new Store(":memory:")
    store.seedIfEmpty()
    const sessionId = store.listSessions()[0]!.id
    const ids = Array.from({ length: 40 }, (_, index) => `direct-body-${index}`)
    for (const id of ids) store.insertMessage({ id, session_id: sessionId, kind: "text", role: "assistant", text: "x".repeat(512 * 1024), created_at: 1 })
    const started = startServer({ store, adapter: createFakeAdapter(), host: "127.0.0.1", port: 0 })
    let ws: WebSocket | undefined
    try {
      const origin = `http://127.0.0.1:${started.server.port}`
      const paired = await (await pair(origin, started.pairLink().token, "body-test")).json() as { sessionKey: string }
      ws = new WebSocket(`ws://127.0.0.1:${started.server.port}/v1/ws`, {
        headers: { authorization: `Bearer ${paired.sessionKey}`, "x-rudder-chunks": "1" },
      })
      ws.binaryType = "arraybuffer"
      const socket = ws
      const pending = new Map<string, (frame: Frame) => void>()
      const reassembler = new Reassembler()
      let chunks = 0
      socket.addEventListener("message", (event) => {
        let raw: string
        if (typeof event.data === "string") raw = event.data
        else {
          chunks += 1
          const frame = reassembler.push(Buffer.from(event.data as ArrayBuffer))
          if (!frame) return
          raw = frame.toString("utf8")
        }
        const frame = JSON.parse(raw) as Frame
        if (frame.id) { pending.get(frame.id)?.(frame); pending.delete(frame.id) }
      })
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve())
        socket.addEventListener("error", () => reject(new Error("body socket failed to open")))
      })
      let serial = 0
      const call = (method: string, params: Record<string, unknown>) => new Promise<Frame>((resolve, reject) => {
        const id = `body-wire-${serial++}`
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} did not answer`)) }, 5000)
        pending.set(id, (frame) => { clearTimeout(timer); resolve(frame) })
        socket.send(JSON.stringify(invokeFrame(id, method, params)))
      })
      const legacy = await call("message.bodies", { sessionId, ids: ids.slice(0, 3) })
      expect((legacy.result as { messages: { id: string }[] }).messages.map((row) => row.id)).toEqual(ids.slice(0, 3))
      const oversized = await call("message.bodies", { sessionId, ids })
      expect(oversized.error?.code).toBe("body_too_large")
      const hello = await call("hello", { features: ["outline", "bodyPages"] })
      expect((hello.result as { features: string[] }).features).toContain("bodyPages")
      const found: string[] = []
      let offset = 0
      let pages = 0
      do {
        const frame = await call("message.bodies", { sessionId, ids, paged: true, offset })
        expect(frame.type).toBe("result")
        expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThanOrEqual(4_194_304)
        const page = frame.result as { messages: { id: string }[]; nextOffset?: number }
        found.push(...page.messages.map((row) => row.id))
        pages += 1
        if (page.nextOffset === undefined) break
        expect(page.nextOffset).toBeGreaterThan(offset)
        offset = page.nextOffset
        if (pages > ids.length) throw new Error("direct body cursor did not terminate")
      } while (offset < ids.length)
      expect(found).toEqual(ids)
      expect(chunks).toBeGreaterThan(pages)
      expect(socket.readyState).toBe(WebSocket.OPEN)
    } finally { ws?.close(); started.server.stop(true) }
  })
})
