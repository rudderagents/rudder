import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { Store } from "./store"

const mode = (path: string) => statSync(path).mode & 0o777
const dbFiles = (db: string) => [db, `${db}-wal`, `${db}-shm`].filter((path) => existsSync(path))

function daemonEnv() {
  const env = { ...process.env }
  delete env.RUDDER_DB
  return env
}

async function runDaemon(home: string) {
  const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "main.ts")], {
    env: { ...daemonEnv(), RUDDER_HOME: home, RUDDER_PORT: "0", RUDDER_TLS: "0", RUDDER_ADAPTER: "fake" },
    stdout: "pipe",
    stderr: "pipe",
  })
  const reader = proc.stdout.getReader()
  let out = ""
  const deadline = Date.now() + 10_000
  while (!out.includes("pair:") && Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    out += new TextDecoder().decode(value)
  }
  return { proc, out }
}

describe("data file permissions", () => {
  test("a new store creates its directory 0700 and the db, -wal and -shm 0600", () => {
    const base = mkdtempSync(join(tmpdir(), "rudder-modes-"))
    try {
      const dir = join(base, "home")
      const db = join(dir, "rudder.sqlite")
      const store = new Store(db)
      store.setMeta("k", "v")
      expect(mode(dir)).toBe(0o700)
      expect(dbFiles(db)).toHaveLength(3)
      for (const path of dbFiles(db)) expect([path, mode(path)]).toEqual([path, 0o600])
      store.db.close()
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  test("rudderd tightens an existing RUDDER_HOME and its world-readable db on startup", async () => {
    const home = mkdtempSync(join(tmpdir(), "rudder-home-"))
    try {
      chmodSync(home, 0o755)
      const db = join(home, "rudder.sqlite")
      new Store(db).db.close()
      for (const path of dbFiles(db)) chmodSync(path, 0o644)
      writeFileSync(`${db}-wal`, "")
      chmodSync(`${db}-wal`, 0o644)
      const { proc, out } = await runDaemon(home)
      try {
        expect(out).toContain("pair:")
        expect(mode(home)).toBe(0o700)
        for (const path of dbFiles(db)) expect([path, mode(path)]).toEqual([path, 0o600])
      } finally {
        proc.kill("SIGTERM")
        await proc.exited
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("a nested data directory that already exists is not chmod'ed by the store", () => {
    const base = mkdtempSync(join(tmpdir(), "rudder-shared-"))
    try {
      mkdirSync(join(base, "shared"), { mode: 0o755 })
      chmodSync(join(base, "shared"), 0o755)
      const store = new Store(join(base, "shared", "x.sqlite"))
      expect(mode(join(base, "shared"))).toBe(0o755)
      expect(mode(join(base, "shared", "x.sqlite"))).toBe(0o600)
      store.db.close()
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
