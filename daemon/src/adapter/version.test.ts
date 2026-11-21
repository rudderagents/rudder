import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { cachedCliVersion, compareVersions, firstSemver, probeCliVersion, versionArgv } from "./version"

describe("agent CLI version", () => {
  test("the first semver wins; a line without one is a miss", () => {
    expect(firstSemver("claude 2.1.4 (abc)")).toBe("2.1.4")
    expect(firstSemver("v1.2\nbuild 99")).toBe("1.2")
    expect(firstSemver("no version")).toBeUndefined()
    expect(firstSemver("1.2.3.4")).toBe("1.2.3")
  })

  test("version asks the binary, not the launch subcommand; npx keeps its package", () => {
    expect(versionArgv(["codex", "app-server"])).toEqual(["codex", "--version"])
    expect(versionArgv(["grok", "agent", "stdio"])).toEqual(["grok", "--version"])
    expect(versionArgv(["copilot", "--acp", "--stdio", "--no-auto-update"])).toEqual(["copilot", "--version"])
    expect(versionArgv(["npx", "-y", "pi-acp@0.0.34"])).toEqual(["npx", "-y", "pi-acp@0.0.34", "--version"])
    expect(versionArgv([])).toEqual([])
  })

  test("bun --version returns a semver and is cached", async () => {
    const version = cachedCliVersion(["bun", "--version"])
    const first = await version()
    const second = await version()
    expect(first).toMatch(/^\d+\.\d+\.\d+$/)
    expect(second).toBe(first)
  })

  test("versions compare by number, missing parts as zero", () => {
    expect(compareVersions("0.40.0", "0.52.0")).toBeLessThan(0)
    expect(compareVersions("0.100.0", "0.52.0")).toBeGreaterThan(0)
    expect(compareVersions("0.52", "0.52.0")).toBe(0)
    expect(compareVersions("2.1.312", "2.1.31")).toBeGreaterThan(0)
  })

  test("a replaced binary is probed again; an unchanged one is not", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rudder-version-"))
    try {
      const bin = join(dir, "agent")
      const write = (version: string, at: number) => {
        writeFileSync(bin, `#!/bin/sh\necho "agent ${version}"\n`, { mode: 0o755 })
        utimesSync(bin, at, at)
      }
      write("0.40.0", 1_000)
      const version = cachedCliVersion([bin, "--version"])
      const first = version()
      expect(await first).toBe("0.40.0")
      expect(version()).toBe(first)
      write("0.52.1", 2_000)
      expect(await version()).toBe("0.52.1")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a command that outlives the timeout is a miss", async () => {
    const started = Date.now()
    const version = await probeCliVersion(["bun", "-e", "await Bun.sleep(5000)"], 200)
    expect(version).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(2000)
  })
})
