import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pairBanner } from "./qr"
import {
  CACHE_FILE,
  CHECK_INTERVAL_MS,
  compareVersions,
  formulaVersion,
  freshCache,
  isHomebrewInstall,
  latestVersion,
  readUpdateCache,
  newerVersion,
  shouldCheckForUpdates,
  updateCheckEnabled,
  updateLogLine,
  updateNotice,
} from "./update-check"

const FORMULA = `class Rudder < Formula
  desc "Pair your iPhone with the coding agents on this Mac"
  version "1.1.0"
  url "https://example.invalid/rudder-#{version}.tar.gz"
end
`

// A local stand-in for raw.githubusercontent.com: tests never reach the network.
function fakeTap(handler: (request: Request) => Response | Promise<Response>) {
  let hits = 0
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => {
      hits++
      return handler(request)
    },
  })
  return { url: `http://127.0.0.1:${server.port}/Formula/rudder.rb`, hits: () => hits, stop: () => server.stop(true) }
}

let dataDir = ""
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "rudder-update-"))
})
afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

describe("versions", () => {
  test("formulaVersion reads the version line", () => {
    expect(formulaVersion(FORMULA)).toBe("1.1.0")
    expect(formulaVersion("class Rudder < Formula\nend\n")).toBeNull()
  })

  test("compareVersions is numeric per part, a missing part is 0, suffixes ignored", () => {
    expect(compareVersions("1.10.0", "1.9.9")).toBe(1)
    expect(compareVersions("1.0", "1.0.0")).toBe(0)
    expect(compareVersions("1.0.0-beta", "1.0.0")).toBe(0)
    expect(compareVersions("0.9.2", "1.0.0")).toBe(-1)
    expect(newerVersion("1.1.0", "1.0.0")).toBe("1.1.0")
    expect(newerVersion("1.0.0", "1.0.0")).toBeNull()
    expect(newerVersion(null, "1.0.0")).toBeNull()
  })
})

describe("who checks", () => {
  test("only a Homebrew keg, and RUDDER_UPDATE_CHECK=off turns it off", () => {
    const same = (path: string) => path
    expect(isHomebrewInstall("/opt/homebrew/Cellar/rudder/1.0.0/bin/rudder", same)).toBe(true)
    expect(isHomebrewInstall("/usr/local/Cellar/rudder/1.0.0/bin/rudder", same)).toBe(true)
    expect(isHomebrewInstall("/Users/me/rudder/daemon/dist/rudder", same)).toBe(false)
    expect(isHomebrewInstall("/opt/homebrew/Cellar/bun/1.4.3/bin/bun", same)).toBe(false)
    // The bin/rudder link resolves into the Cellar.
    expect(isHomebrewInstall("/opt/homebrew/bin/rudder", () => "/opt/homebrew/Cellar/rudder/1.0.0/bin/rudder")).toBe(true)
    expect(updateCheckEnabled({})).toBe(true)
    expect(updateCheckEnabled({ RUDDER_UPDATE_CHECK: "off" })).toBe(false)
    expect(updateCheckEnabled({ RUDDER_UPDATE_CHECK: "OFF" })).toBe(false)
    expect(shouldCheckForUpdates("/opt/homebrew/Cellar/rudder/1.0.0/bin/rudder", { RUDDER_UPDATE_CHECK: "off" })).toBe(false)
  })
})

describe("latestVersion", () => {
  test("reads the formula once, then answers from the cache for a day", async () => {
    const tap = fakeTap(() => new Response(FORMULA))
    try {
      const now = 1_000_000
      expect(await latestVersion({ dataDir, now, url: tap.url })).toBe("1.1.0")
      expect(await latestVersion({ dataDir, now: now + CHECK_INTERVAL_MS - 1, url: tap.url })).toBe("1.1.0")
      expect(tap.hits()).toBe(1)
      expect(JSON.parse(readFileSync(join(dataDir, CACHE_FILE), "utf8"))).toEqual({ checkedAt: now, latest: "1.1.0" })
      expect(freshCache(dataDir, now + 10)?.latest).toBe("1.1.0")
      expect(freshCache(dataDir, now + CHECK_INTERVAL_MS)).toBeNull()
      await latestVersion({ dataDir, now: now + CHECK_INTERVAL_MS, url: tap.url })
      expect(tap.hits()).toBe(2)
    } finally {
      tap.stop()
    }
  })

  test("a slow tap gives up at the timeout and the miss is cached", async () => {
    const tap = fakeTap(async () => {
      await Bun.sleep(500)
      return new Response(FORMULA)
    })
    try {
      const started = Date.now()
      expect(await latestVersion({ dataDir, now: 5, url: tap.url, timeoutMs: 100 })).toBeNull()
      expect(Date.now() - started).toBeLessThan(450)
      expect(freshCache(dataDir, 6)).toEqual({ checkedAt: 5, latest: null })
      expect(await latestVersion({ dataDir, now: 7, url: tap.url, timeoutMs: 100 })).toBeNull()
      expect(tap.hits()).toBe(1)
    } finally {
      tap.stop()
    }
  })

  test("a 404 or a formula without a version is no answer", async () => {
    const tap = fakeTap(() => new Response("missing", { status: 404 }))
    try {
      expect(await latestVersion({ dataDir, now: 1, url: tap.url })).toBeNull()
    } finally {
      tap.stop()
    }
  })

  test("a 404 is cached as no version, so it never becomes an update notice or log line", async () => {
    const tap = fakeTap(() => new Response("Not Found", { status: 404 }))
    try {
      const latest = await latestVersion({ dataDir, now: 1, url: tap.url })
      expect(latest).toBeNull()
      expect(newerVersion(latest, "1.0.0")).toBeNull()
      expect(readUpdateCache(dataDir)).toEqual({ checkedAt: 1, latest: null })
      expect(newerVersion(readUpdateCache(dataDir)?.latest ?? null, "1.0.0")).toBeNull()
    } finally {
      tap.stop()
    }
  })

  test("a broken cache file is ignored", async () => {
    writeFileSync(join(dataDir, CACHE_FILE), "{not json")
    const tap = fakeTap(() => new Response(FORMULA))
    try {
      expect(await latestVersion({ dataDir, now: 1, url: tap.url })).toBe("1.1.0")
    } finally {
      tap.stop()
    }
  })
})

describe("the lines", () => {
  test("terminal line in both locales, log line plain English", () => {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strips the ANSI colours under test
    const strip = (line: string) => line.replaceAll(/\x1b\[[0-9;]*m/g, "")
    expect(strip(updateNotice("1.1.0", "1.0.0", "zh"))).toBe("⬆ 有新版本：rudder 1.1.0（现在 1.0.0）· 运行 brew upgrade rudder")
    expect(strip(updateNotice("1.1.0", "1.0.0", "en"))).toBe("⬆ rudder 1.1.0 is available (you have 1.0.0) · run brew upgrade rudder")
    expect(updateLogLine("1.1.0", "1.0.0")).toBe("rudderd: rudder 1.1.0 is available (running 1.0.0); run brew upgrade rudder")
    expect(updateLogLine("1.1.0", "1.0.0")).not.toContain("\x1b")
  })

  test("the banner puts the notice after the code and keeps the link last", () => {
    const link = { url: `https://192.168.1.2:7749/pair?token=abcd&fp=${"a".repeat(64)}`, expiresAt: 0 }
    const lines = pairBanner(link, "mac-studio", "en", "NOTICE")
    expect(lines.at(-1)).toContain(link.url)
    expect(lines.at(-2)).toBe("NOTICE")
    expect(pairBanner(link, "mac-studio", "en")).not.toContain("NOTICE")
  })
})
