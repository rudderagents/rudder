import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { localSocketPath } from "../local"
import type { SyncResult, SyncRunner } from "./run"
import { answerProof, ChannelProofError, readChannelFile, requestAuth, startTokenChannel, tokenRequest } from "./token-channel"
import { aclProblem, checkOwnerOnly, parseAcl, parseWhoamiSid, restrictArgv, restrictToUser } from "./win32-acl"

const USER = "S-1-5-21-1004336348-1177238915-682003330-1001"
const ok = (stdout = ""): SyncResult => ({ exitCode: 0, stdout, stderr: "", timedOut: false })

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "rudder-channel-"))
  dirs.push(dir)
  return dir
}

test("the channel file sits in RUDDER_HOME on Windows, the socket elsewhere", () => {
  expect(localSocketPath("/data", "darwin")).toBe("/data/rudder.sock")
  expect(localSocketPath("/data", "win32")).toBe("/data/rudder-local.json")
})

describe("token channel", () => {
  test("a request with the token's HMAC is answered and proven; the file is 0600 and removed on stop", async () => {
    const path = join(scratch(), "rudder-local.json")
    const protectedPaths: string[] = []
    const channel = startTokenChannel({
      path,
      handle: (request) => Response.json({ route: new URL(request.url).pathname, method: request.method }),
      protect: (file) => protectedPaths.push(file),
    })
    try {
      expect(protectedPaths).toEqual([`${path}.tmp`])
      expect(statSync(path).mode & 0o777).toBe(0o600)
      const file = readChannelFile(path)!
      expect(file.port).toBe(channel.server.port!)
      expect(file.pid).toBe(process.pid)
      expect(await tokenRequest(path, "POST", "/local/pair")).toEqual({ status: 200, body: { route: "/local/pair", method: "POST" } })
    } finally {
      channel.stop()
    }
    expect(() => statSync(path)).toThrow()
    // Nothing listens any more and the file is gone: "not running", not an error.
    expect(await tokenRequest(path, "GET", "/local/pair")).toBeNull()
  })

  test("without the token: no nonce, a wrong HMAC, a replay, another route are all refused", async () => {
    const path = join(scratch(), "rudder-local.json")
    const channel = startTokenChannel({ path, handle: () => Response.json({ ok: true }) })
    try {
      const { port, token } = readChannelFile(path)!
      const url = `http://127.0.0.1:${port}/local/pair`
      expect((await fetch(url)).status).toBe(403)
      const nonce = "ab".repeat(16)
      const time = String(Date.now())
      const signed = (auth: string) => ({ "x-rudder-nonce": nonce, "x-rudder-time": time, "x-rudder-auth": auth })
      const wrong = requestAuth("cd".repeat(32), nonce, time, "GET", "/local/pair")
      expect((await fetch(url, { headers: signed(wrong) })).status).toBe(403)
      const right = requestAuth(token, nonce, time, "GET", "/local/pair")
      // Signed for GET /local/pair, sent as POST: refused.
      expect((await fetch(url, { method: "POST", headers: signed(right) })).status).toBe(403)
      // Signed at one time, sent with another: refused.
      expect((await fetch(url, { headers: { ...signed(right), "x-rudder-time": String(Number(time) + 1) } })).status).toBe(403)
      const first = await fetch(url, { headers: signed(right) })
      expect(first.status).toBe(200)
      expect(first.headers.get("x-rudder-proof")).toBe(answerProof(token, nonce, 200))
      // The same nonce again: a captured request does not replay.
      expect((await fetch(url, { headers: signed(right) })).status).toBe(403)
    } finally {
      channel.stop()
    }
  })

  test("a request signed outside the time window is refused, so forgetting old nonces cannot reopen a replay", async () => {
    const path = join(scratch(), "rudder-local.json")
    let now = 1_800_000_000_000
    const channel = startTokenChannel({ path, handle: () => Response.json({ ok: true }), now: () => now })
    try {
      const { port, token } = readChannelFile(path)!
      const url = `http://127.0.0.1:${port}/local/pair`
      const send = (nonce: string, at: number) => {
        const time = String(at)
        return fetch(url, { headers: { "x-rudder-nonce": nonce, "x-rudder-time": time, "x-rudder-auth": requestAuth(token, nonce, time, "GET", "/local/pair") } })
      }
      expect((await send("01".repeat(16), now - 61_000)).status).toBe(403)
      expect((await send("02".repeat(16), now + 61_000)).status).toBe(403)
      const captured = "03".repeat(16)
      expect((await send(captured, now)).status).toBe(200)
      now += 30_000
      // Still inside the window: the nonce is remembered, even after other requests came and went.
      expect((await send("04".repeat(16), now)).status).toBe(200)
      expect((await send(captured, now - 30_000)).status).toBe(403)
      now += 31_000
      // Past the window the nonce may be forgotten, and its signed time no longer passes.
      expect((await send("05".repeat(16), now)).status).toBe(200)
      expect((await send(captured, now - 61_000)).status).toBe(403)
      expect((await send("06".repeat(16), Number.NaN)).status).toBe(403)
    } finally {
      channel.stop()
    }
  })

  test("something else on the port that cannot prove the token is refused, and the token never leaves", async () => {
    const path = join(scratch(), "rudder-local.json")
    const token = "ef".repeat(32)
    const heard: string[] = []
    const impostor = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        heard.push([...request.headers.entries()].map(([key, value]) => `${key}=${value}`).join(";"))
        return Response.json({ url: "rudder://pair?token=attacker", expiresAt: 1 })
      },
    })
    try {
      writeFileSync(path, JSON.stringify({ port: impostor.port, pid: 1, token }))
      await expect(tokenRequest(path, "POST", "/local/pair")).rejects.toBeInstanceOf(ChannelProofError)
      expect(heard.join("\n")).not.toContain(token)
    } finally {
      impostor.stop(true)
    }
  })

  test("a malformed file reads as no daemon", () => {
    const path = join(scratch(), "rudder-local.json")
    writeFileSync(path, JSON.stringify({ port: 1, pid: 1, token: "short" }))
    expect(readChannelFile(path)).toBeNull()
  })

  test("stop leaves a newer daemon's file alone", () => {
    const path = join(scratch(), "rudder-local.json")
    const channel = startTokenChannel({ path, handle: () => new Response("") })
    writeFileSync(path, JSON.stringify({ port: 2, pid: 2, token: "12".repeat(32) }))
    channel.stop()
    expect(readFileSync(path, "utf8")).toContain("1212")
  })

  test("a failing protect step stops the channel and leaves no file", () => {
    const path = join(scratch(), "rudder-local.json")
    expect(() =>
      startTokenChannel({
        path,
        handle: () => new Response(""),
        protect: () => {
          throw new Error("icacls failed")
        },
      }),
    ).toThrow("icacls failed")
    expect(() => statSync(path)).toThrow()
    expect(() => statSync(`${path}.tmp`)).toThrow()
  })
})

describe("Windows ACL", () => {
  test("whoami's CSV gives the SID", () => {
    expect(parseWhoamiSid(`"desktop-7k2\\tester","${USER}"\r\n`)).toBe(USER)
    expect(parseWhoamiSid("ERROR: Access denied")).toBeNull()
  })

  test("icacls drops inheritance and grants only the user and SYSTEM", () => {
    expect(restrictArgv("C:\\Users\\tester\\AppData\\Local\\Rudder", USER, true)).toEqual([
      "icacls.exe",
      "C:\\Users\\tester\\AppData\\Local\\Rudder",
      "/inheritance:r",
      "/grant:r",
      `*${USER}:(OI)(CI)F`,
      "*S-1-5-18:(OI)(CI)F",
      "/q",
    ])
    expect(restrictArgv("x.json", USER, false)[4]).toBe(`*${USER}:F`)
  })

  // Recorded from Get-Acl on a fresh %LOCALAPPDATA%\Rudder (Windows 11 23H2): SYSTEM, Administrators, the user.
  const LOCALAPPDATA_DEFAULT = `owner|${USER}\r\nS-1-5-18|2032127|Allow\r\nS-1-5-32-544|2032127|Allow\r\n${USER}|2032127|Allow\r\n`

  test("the profile default and the tightened ACL pass", () => {
    expect(aclProblem(parseAcl(LOCALAPPDATA_DEFAULT), USER)).toBeNull()
    expect(aclProblem(parseAcl(`owner|${USER}\nS-1-5-18|2032127|Allow\n${USER}|2032127|Allow\n`), USER)).toBeNull()
  })

  test("Everyone or Users with read or write, or another owner, fail", () => {
    expect(aclProblem(parseAcl(`${LOCALAPPDATA_DEFAULT}S-1-1-0|1179817|Allow\r\n`), USER)).toContain("S-1-1-0 has access")
    expect(aclProblem(parseAcl(`${LOCALAPPDATA_DEFAULT}S-1-5-32-545|278|Allow\r\n`), USER)).toContain("S-1-5-32-545")
    expect(aclProblem(parseAcl(`owner|S-1-5-21-1-2-3-1002\r\n${USER}|2032127|Allow\r\n`), USER)).toContain("owned by")
    // A deny entry for others, or Synchronize alone, is harmless.
    expect(aclProblem(parseAcl(`${LOCALAPPDATA_DEFAULT}S-1-1-0|2032127|Deny\r\nS-1-5-11|1048576|Allow\r\n`), USER)).toBeNull()
  })

  test("restrictToUser runs icacls, then reads the ACL back; the path reaches PowerShell through env only", () => {
    const calls: { argv: string[]; env?: Record<string, string | undefined> }[] = []
    const run: SyncRunner = (argv, options) => {
      calls.push({ argv, env: options?.env })
      if (argv[0] === "icacls.exe") return ok("Successfully processed 1 files")
      return ok(LOCALAPPDATA_DEFAULT)
    }
    const dir = "C:\\Users\\tester\\AppData\\Local\\Rudder'; Remove-Item -Recurse C:\\ #"
    restrictToUser(dir, { directory: true, userSid: USER, run })
    expect(calls[0]!.argv[0]).toBe("icacls.exe")
    expect(calls[1]!.argv[0]).toBe("powershell.exe")
    expect(calls[1]!.argv.join(" ")).not.toContain("Remove-Item")
    expect(calls[1]!.env?.RUDDER_ACL_PATH).toBe(dir)
  })

  test("an ACL that is still open after icacls is an error", () => {
    const run: SyncRunner = (argv) => (argv[0] === "icacls.exe" ? ok() : ok(`${LOCALAPPDATA_DEFAULT}S-1-1-0|1179817|Allow\r\n`))
    expect(() => checkOwnerOnly("C:\\x", USER, run)).toThrow("refusing C:\\x: S-1-1-0 has access")
    expect(() => restrictToUser("C:\\x", { directory: true, userSid: USER, run })).toThrow("S-1-1-0")
  })
})
