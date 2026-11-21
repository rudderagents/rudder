import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { localRequest, refuseIfDaemonRunning, socketIsLive, startLocalControl } from "./local"
import { Store } from "./store"

let cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.reverse()) cleanup()
  cleanups = []
})

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "rudder-live-"))
}

function startChannel(dir: string) {
  const store = new Store(join(dir, "test.db"))
  const local = startLocalControl({
    path: join(dir, "rudder.sock"),
    store,
    machine: () => "mac-test",
    pairLink: () => ({ url: "", expiresAt: 0 }),
    rotatePairing: () => ({ url: "", expiresAt: 0 }),
    isConnected: () => false,
    revoke: () => null,
  })
  cleanups.push(() => local.stop())
  return local
}

test("a socket with a daemon behind it is live", async () => {
  const local = startChannel(tmpDir())
  expect(await socketIsLive(local.path)).toBe(true)
})

test("a missing socket is not live", async () => {
  expect(await socketIsLive(join(tmpDir(), "none.sock"))).toBe(false)
})

test("a socket left by a killed process is not live", async () => {
  const path = join(tmpDir(), "dead.sock")
  const child = Bun.spawn([process.execPath, "-e", "require('net').createServer().listen(process.argv[1]); console.log('up'); setInterval(() => {}, 1000)", path], {
    stdout: "pipe",
    stderr: "inherit",
  })
  const reader = child.stdout.getReader()
  await reader.read()
  child.kill("SIGKILL")
  await child.exited
  expect(existsSync(path)).toBe(true)
  expect(await socketIsLive(path)).toBe(false)
})

test("a second start on a live data dir is refused and the first channel keeps answering", async () => {
  const dir = tmpDir()
  const local = startChannel(dir)
  await expect(refuseIfDaemonRunning(dir)).rejects.toThrow(/^rudder is already running for /)
  expect((await localRequest(local.path, "GET", "/local/pair"))?.status).toBe(200)
})

test("a data dir with no daemon is not refused", async () => {
  await refuseIfDaemonRunning(tmpDir())
})
