import { describe, expect, spyOn, test } from "bun:test"
import { chmodSync, existsSync, lstatSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { daemonAnswers, type DevicesDeps, listDevices, pair, parseCli, revokeDevice, runCli, setRelay } from "./cli"
import { checkLocalSocket, type LocalAnswer, localRequest, localSocketPath, matchDevice } from "./local"
import { startServer } from "./server"
import { Store } from "./store"

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes is the point
const stripAnsi = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "")

describe("arguments", () => {
  test("diagnose accepts only an optional project directory", () => {
    expect(parseCli(["diagnose"])).toEqual({ kind: "diagnose", cwd: undefined })
    expect(parseCli(["diagnose", "/fixture/project"])).toEqual({ kind: "diagnose", cwd: "/fixture/project" })
    expect(() => parseCli(["diagnose", "--unknown"])).toThrow()
    expect(() => parseCli(["diagnose", "/one", "/two"])).toThrow()
  })
  test("no argument runs the daemon; the rest are commands", () => {
    expect(parseCli([])).toEqual({ kind: "run" })
    expect(parseCli(["pair"])).toEqual({ kind: "pair", json: false })
    expect(parseCli(["pair", "--json"])).toEqual({ kind: "pair", json: true })
    expect(() => parseCli(["pair", "--now"])).toThrow("unknown option for pair: --now")
    expect(parseCli(["--version"])).toEqual({ kind: "version" })
    expect(parseCli(["-v"])).toEqual({ kind: "version" })
    expect(parseCli(["help"])).toEqual({ kind: "help" })
    expect(parseCli(["--help"])).toEqual({ kind: "help" })
    expect(parseCli(["install"])).toEqual({ kind: "install" })
    expect(parseCli(["uninstall", "--purge"])).toEqual({ kind: "uninstall", purge: true })
    expect(parseCli(["status"])).toEqual({ kind: "status" })
    expect(parseCli(["relay"])).toEqual({ kind: "relay", mode: "status" })
    expect(parseCli(["relay", "on"])).toEqual({ kind: "relay", mode: "on" })
    expect(parseCli(["relay", "off"])).toEqual({ kind: "relay", mode: "off" })
  })

  test("relay on saves the mode and tells a stopped daemon to use it next start", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rudder-relay-mode-"))
    try {
      const { deps, out } = harness([null])
      deps.dataDir = dir
      expect(await setRelay(deps, "on")).toBe(0)
      expect(out.join("\n")).toContain("next time rudder starts")
      const { readRelayMode } = await import("./relay/mode")
      expect(readRelayMode(dir)).toBe("on")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("unknown commands and flags are refused", () => {
    expect(() => parseCli(["start"])).toThrow("unknown command: start")
    expect(() => parseCli(["pair", "--now"])).toThrow("unknown option for pair: --now")
  })

  test("a usage error exits 2 without running anything", async () => {
    const quiet = spyOn(console, "error").mockImplementation(() => {})
    try {
      expect(await runCli(["bogus"])).toBe(2)
    } finally {
      quiet.mockRestore()
    }
  })

  test("main.ts with an argument runs the CLI instead of the daemon", () => {
    const main = join(import.meta.dir, "main.ts")
    const help = Bun.spawnSync(["bun", "run", main, "help"], { env: { ...process.env, RUDDER_PORT: "1" } })
    expect(help.exitCode).toBe(0)
    expect(help.stdout.toString()).toContain("usage: rudder [command]")
    expect(help.stdout.toString()).not.toContain("rudderd http")
    const version = Bun.spawnSync(["bun", "run", main, "--version"])
    expect(version.stdout.toString()).toMatch(/^rudder \d+\.\d+\.\d+\n$/)
  })
})

type Answer = LocalAnswer | null

function harness(answers: Answer[], tty = true, port: string | null = null) {
  const out: string[] = []
  const err: string[] = []
  const requested: string[] = []
  const deps: DevicesDeps = {
    socket: "/Users/me/Library/Application Support/Rudder/rudder.sock",
    request: async (method, route) => {
      requested.push(`${method} ${route}`)
      return answers.length > 1 ? answers.shift()! : answers[0]!
    },
    portAnswers: async () => port,
    openStore: () => null,
    tty,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    command: "rudder",
    locale: "zh",
  }
  return { deps, out, err, requested }
}

const info = (token: string) => ({
  status: 200,
  body: { url: `rudder://pair?host=127.0.0.1:7749&token=${token}`, expiresAt: Date.now() + 600_000, machine: "Mac Studio" },
})

/** A real daemon with its local socket in a fresh RUDDER_HOME-like dir (0700, as main.ts makes it). */
function bootLocal(machine = "Test Mac") {
  const home = mkdtempSync(join(tmpdir(), "rudder-cli-"))
  chmodSync(home, 0o700)
  const store = new Store(":memory:")
  store.seedIfEmpty()
  store.setMeta("machine_name", machine)
  const socket = localSocketPath(home)
  const started = startServer({ store, host: "127.0.0.1", port: 0, localSocket: socket })
  const out: string[] = []
  const err: string[] = []
  const deps: DevicesDeps = {
    socket,
    request: (method, route, body) => localRequest(socket, method, route, body),
    portAnswers: async () => null,
    openStore: () => null,
    tty: false,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    command: "rudder",
    locale: "en",
  }
  const stop = () => {
    started.service.stopScheduler()
    started.perf.stop()
    started.local?.stop()
    started.server.stop(true)
    rmSync(home, { recursive: true, force: true })
  }
  return { home, store, socket, started, deps, out, err, stop }
}

async function pairPhone(origin: string, token: string, name: string) {
  const response = await fetch(`${origin}/v1/pair`, { method: "POST", body: JSON.stringify({ token, name }) })
  return (await response.json()) as { deviceId: string; sessionKey: string }
}

describe("rudder with no command", () => {
  test("a daemon answering on this RUDDER_HOME's socket counts as running, so no second one starts", async () => {
    expect(await daemonAnswers(harness([info("a")]).deps)).toBe(true)
    expect(await daemonAnswers(harness([{ status: 404, body: null }]).deps)).toBe(true)
    expect(await daemonAnswers(harness([null]).deps)).toBe(false)
  })
})

describe("rudder pair", () => {
  test("asks the daemon on its socket for a fresh code and shows its QR code", async () => {
    const h = harness([info("new")])
    expect(await pair(h.deps, { json: false })).toBe(0)
    expect(h.requested).toEqual(["POST /local/pair"])
    const lines = h.out.map(stripAnsi)
    expect(lines[0]).toBe("⎈ rudder 正在运行 · Mac Studio")
    expect(lines).toContain("用 Rudder 扫这个码")
    expect(lines).toContain("配对码 new")
    expect(lines.at(-1)).toBe("rudder://pair?host=127.0.0.1:7749&token=new")
  })

  test("an English locale prints the English banner", async () => {
    const h = harness([info("new")])
    h.deps.locale = "en"
    expect(await pair(h.deps, { json: false })).toBe(0)
    const lines = h.out.map(stripAnsi)
    expect(lines[0]).toBe("⎈ rudder is running · Mac Studio")
    expect(lines).toContain("Scan this with Rudder")
    expect(lines).toContain("Pairing code new")
    expect(lines.some((line) => line.startsWith("Fingerprint"))).toBe(false)
    expect(lines.at(-1)).toBe("rudder://pair?host=127.0.0.1:7749&token=new")
  })

  test("piped output gets the plain link: the person asked for it", async () => {
    const h = harness([info("new")], false)
    expect(await pair(h.deps, { json: false })).toBe(0)
    expect(h.out[0]).toBe("rudder://pair?host=127.0.0.1:7749&token=new")
    expect(h.out[1]).toMatch(/^single use, valid until \d\d:\d\d$/)
  })

  test("--json prints one JSON line with url, expiresAt and machine, even on a tty", async () => {
    const h = harness([info("new")])
    expect(await pair(h.deps, { json: true })).toBe(0)
    expect(h.out).toHaveLength(1)
    expect(JSON.parse(h.out[0]!)).toEqual({ url: "rudder://pair?host=127.0.0.1:7749&token=new", expiresAt: expect.any(Number), machine: expect.any(String) })
  })

  test("--json with no daemon exits 1, reason on stderr, nothing on stdout", async () => {
    const h = harness([null])
    expect(await pair(h.deps, { json: true })).toBe(1)
    expect(h.out).toEqual([])
    expect(h.err).toHaveLength(1)
  })

  test("with nothing running it says how to start one", async () => {
    const h = harness([null])
    expect(await pair(h.deps, { json: false })).toBe(1)
    expect(h.err[0]).toBe(
      "rudder pair: no rudder is running for /Users/me/Library/Application Support/Rudder/rudder.sock. Start one with `rudder` (in a terminal) or `rudder install` (in the background), or set RUDDER_HOME to the data dir it runs with",
    )
  })

  test("a daemon on the port without the socket is an older one (or another RUDDER_HOME), not trusted for a code", async () => {
    const h = harness([null], true, "https://127.0.0.1:7749")
    expect(await pair(h.deps, { json: false })).toBe(1)
    expect(h.err[0]).toContain("a rudder answers on https://127.0.0.1:7749 but not on")
    expect(h.out).toEqual([])
  })

  test("an answer that is not a pair link is an error", async () => {
    const h = harness([{ status: 200, body: { hello: "world" } }])
    expect(await pair(h.deps, { json: false })).toBe(1)
    expect(h.err[0]).toBe("rudder pair: the daemon did not return a pair link")
  })

  test("against a real daemon: rotates over the socket and shows the new link", async () => {
    const d = bootLocal()
    try {
      const before = d.started.pairLink().url
      d.deps.tty = true
      d.deps.locale = "zh"
      expect(await pair(d.deps, { json: false })).toBe(0)
      const lines = d.out.map(stripAnsi)
      expect(lines[0]).toBe("⎈ rudder 正在运行 · Test Mac")
      expect(lines.at(-1)).toBe(d.started.pairLink().url)
      expect(lines.at(-1)).not.toBe(before)
    } finally {
      d.stop()
    }
  })
})

describe("the local socket", () => {
  test("is a 0600 socket in RUDDER_HOME, and the pairing token is no longer served over TCP", async () => {
    const d = bootLocal()
    try {
      const stat = lstatSync(d.socket)
      expect(stat.isSocket()).toBe(true)
      expect(stat.mode & 0o777).toBe(0o600)
      const origin = `http://127.0.0.1:${d.started.server.port}`
      expect((await fetch(`${origin}/v1/pair-info`)).status).toBe(404)
      expect((await fetch(`${origin}/local/pair`)).status).toBe(404)
    } finally {
      d.stop()
    }
    expect(existsSync(d.socket)).toBe(false)
  })

  test("a stale socket from a crashed daemon is replaced; a regular file there is refused", () => {
    const home = mkdtempSync(join(tmpdir(), "rudder-cli-"))
    try {
      const path = localSocketPath(home)
      const dead = Bun.serve({ unix: path, fetch: () => new Response("") })
      dead.stop(true)
      // Bun removes its socket on stop; recreate the leftover a crash leaves behind.
      const leftover = Bun.listen({ unix: path, socket: { data() {} } })
      leftover.stop(true)
      const store = new Store(":memory:")
      const started = startServer({ store, host: "127.0.0.1", port: 0, localSocket: path })
      started.local?.stop()
      started.server.stop(true)
      started.service.stopScheduler()
      started.perf.stop()
      writeFileSync(path, "not a socket")
      expect(() => startServer({ store, host: "127.0.0.1", port: 0, localSocket: path })).toThrow("is not a socket")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("the client refuses a socket in a directory others can write to (F-07: nobody else answers rudder pair)", () => {
    const home = mkdtempSync(join(tmpdir(), "rudder-cli-"))
    try {
      chmodSync(home, 0o777)
      expect(() => checkLocalSocket(localSocketPath(home))).toThrow("not be writable by others")
      chmodSync(home, 0o700)
      expect(checkLocalSocket(localSocketPath(home))).toBe(false)
      writeFileSync(localSocketPath(home), "x")
      expect(() => checkLocalSocket(localSocketPath(home))).toThrow("is not a socket owned by you")
      expect(() => checkLocalSocket(localSocketPath(home), 4242)).toThrow("must belong to you (uid 4242)")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe("rudder devices", () => {
  test("arguments: list, revoke one, and nothing else", () => {
    expect(parseCli(["devices"])).toEqual({ kind: "devices" })
    expect(parseCli(["devices", "revoke", "iPhone"])).toEqual({ kind: "revoke", target: "iPhone" })
    expect(() => parseCli(["devices", "revoke"])).toThrow("devices revoke takes one name or id")
    expect(() => parseCli(["devices", "rm", "x"])).toThrow("unknown devices command: rm")
  })

  test("matches a full id, a unique id prefix or a unique name; refuses ambiguity", () => {
    const row = (id: string, name: string) => ({ id, name, session_key: id, created_at: 0, push_token: null })
    const rows = [row("aaaa1111-0000", "iPhone"), row("aaaa2222-0000", "iPhone"), row("bbbb3333-0000", "iPad")]
    expect(matchDevice(rows, "bbbb3333-0000").name).toBe("iPad")
    expect(matchDevice(rows, "ipad").id).toBe("bbbb3333-0000")
    expect(matchDevice(rows, "aaaa2").id).toBe("aaaa2222-0000")
    expect(() => matchDevice(rows, "iPhone")).toThrow('"iPhone" matches 2 phones')
    expect(() => matchDevice(rows, "aaa")).toThrow("no paired phone")
  })

  test("against a real daemon: lists phones with last seen, revoke closes its socket with 4001 and deletes its key", async () => {
    const d = bootLocal()
    try {
      const origin = `http://127.0.0.1:${d.started.server.port}`
      const lost = await pairPhone(origin, d.started.pairLink().token, "Lost iPhone")
      const kept = await pairPhone(origin, d.started.pairLink().token, "iPad")
      const ws = new WebSocket(`ws://127.0.0.1:${d.started.server.port}/v1/ws`, {
        headers: { authorization: `Bearer ${lost.sessionKey}` },
      } as never)
      await new Promise((resolve) => ws.addEventListener("open", resolve))
      const closed = new Promise<number>((resolve) => ws.addEventListener("close", (event) => resolve(event.code)))

      expect(await listDevices(d.deps)).toBe(0)
      expect(d.out[0]).toBe("2 paired phones (the running rudder):")
      expect(d.out[1]).toMatch(new RegExp(`^  ${lost.deviceId.slice(0, 8)}  Lost iPhone  paired \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d  connected now$`))
      expect(d.out[2]).toContain("iPad")
      expect(d.out[2]).toEndWith("last seen unknown")

      d.out.length = 0
      expect(await revokeDevice(d.deps, "lost iphone")).toBe(0)
      expect(d.out[0]).toBe(`revoked Lost iPhone (${lost.deviceId.slice(0, 8)}): its key is deleted and it must pair again`)
      expect(await closed).toBe(4001)
      expect(d.store.deviceByKey(lost.sessionKey)).toBeNull()
      expect(d.store.deviceByKey(kept.sessionKey)).not.toBeNull()
      const refused = await fetch(`${origin}/v1/sessions/x/attachments/y`, { headers: { authorization: `Bearer ${lost.sessionKey}` } })
      expect(refused.status).toBe(401)
      // The closed socket left a last-seen time behind for the next listing.
      d.out.length = 0
      await listDevices(d.deps)
      expect(d.out[0]).toBe("1 paired phone (the running rudder):")

      expect(await revokeDevice(d.deps, "nobody")).toBe(1)
      expect(d.err[0]).toBe('rudder devices revoke: no paired phone is named or has the id "nobody"')
    } finally {
      d.stop()
    }
  })

  test("with no daemon running, lists and revokes straight from the database", async () => {
    const home = mkdtempSync(join(tmpdir(), "rudder-cli-"))
    chmodSync(home, 0o700)
    const dbPath = join(home, "rudder.sqlite")
    const seed = new Store(dbPath)
    seed.putDevice({ id: "cafe0000-1111", session_key: "k1", name: "Old iPhone", created_at: Date.now(), push_token: null })
    seed.db.close()
    const out: string[] = []
    const deps: DevicesDeps = {
      ...harness([null]).deps,
      socket: localSocketPath(home),
      request: (method, route, body) => localRequest(localSocketPath(home), method, route, body),
      openStore: () => new Store(dbPath),
      out: (line) => out.push(line),
    }
    try {
      expect(await listDevices(deps)).toBe(0)
      expect(out[0]).toBe("1 paired phone (rudder is not running; read from its database):")
      expect(await revokeDevice(deps, "cafe0000")).toBe(0)
      const check = new Store(dbPath)
      expect(check.listDevices()).toEqual([])
      check.db.close()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
