import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  installChannel,
  latestVersion,
  manifestVersion,
  shouldCheckForUpdates,
  updateLogLine,
  updateNotice,
  upgradeCommand,
  WINDOWS_UPDATE_MANIFEST_URL,
} from "../update-check"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("Windows install channels", () => {
  test.each([
    ["C:\\Users\\tester\\scoop\\apps\\rudder\\current\\rudder.exe", "scoop"],
    ["C:\\Users\\tester\\scoop\\apps\\rudder\\1.0.0\\rudder.exe", "scoop"],
    ["C:\\Users\\tester\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Zysuccess.Rudder_Microsoft.Winget.Source_8wekyb3d8bbwe\\rudder.exe", "winget"],
    ["C:\\Users\\tester\\AppData\\Local\\Microsoft\\WinGet\\Links\\rudder.exe", "winget"],
    ["C:\\Users\\tester\\Downloads\\rudder.exe", null],
  ])("%s → %s", (path, channel) => {
    expect(installChannel(path, (value) => value, "win32")).toBe(channel as ReturnType<typeof installChannel>)
  })

  test("the notice names the channel's upgrade command; macOS keeps brew", () => {
    expect(upgradeCommand("scoop")).toBe("scoop update rudder")
    expect(upgradeCommand("winget")).toBe("winget upgrade rudder")
    expect(updateLogLine("1.1.0", "1.0.0", upgradeCommand("winget"))).toBe("rudderd: rudder 1.1.0 is available (running 1.0.0); run winget upgrade rudder")
    expect(updateNotice("1.1.0", "1.0.0", "en", upgradeCommand("scoop"))).toContain("scoop update rudder")
    if (process.platform === "darwin") expect(updateLogLine("1.1.0", "1.0.0")).toContain("run brew upgrade rudder")
  })

  test("the manifest URL is reserved on our own domain: scoop / winget installs check, others do not", () => {
    expect(WINDOWS_UPDATE_MANIFEST_URL).toBe("https://rudderagents.com/windows/latest.json")
    expect(shouldCheckForUpdates("C:\\Users\\tester\\scoop\\apps\\rudder\\current\\rudder.exe", {}, "win32")).toBe(true)
    expect(shouldCheckForUpdates("C:\\Users\\tester\\Downloads\\rudder.exe", {}, "win32")).toBe(false)
    expect(shouldCheckForUpdates("C:\\Users\\tester\\scoop\\apps\\rudder\\current\\rudder.exe", { RUDDER_UPDATE_CHECK: "off" }, "win32")).toBe(false)
    // A build without a URL never checks.
    expect(shouldCheckForUpdates("C:\\Users\\tester\\scoop\\apps\\rudder\\current\\rudder.exe", {}, "win32", null)).toBe(false)
  })

  test("latestVersion on Windows asks the reserved URL", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "rudder-update-"))
    dirs.push(dataDir)
    const asked: string[] = []
    const fetchSpy = (async (url: string) => {
      asked.push(url)
      return new Response(JSON.stringify({ version: "1.1.0" }))
    }) as unknown as typeof fetch
    expect(await latestVersion({ dataDir, platform: "win32", fetch: fetchSpy })).toBe("1.1.0")
    expect(asked).toEqual(["https://rudderagents.com/windows/latest.json"])
  })

  test.each([
    ["the placeholder before a release", () => Promise.resolve(new Response('{"version":null}'))],
    ["a 404", () => Promise.resolve(new Response("Not Found", { status: 404 }))],
    ["a missing version", () => Promise.resolve(new Response("{}"))],
    ["malformed JSON", () => Promise.resolve(new Response("<html>"))],
    ["a network failure", () => Promise.reject(new TypeError("fetch failed"))],
  ])("%s reads as no update, quietly", async (_name, answer) => {
    const dataDir = mkdtempSync(join(tmpdir(), "rudder-update-"))
    dirs.push(dataDir)
    const fetchSpy = (() => answer()) as unknown as typeof fetch
    expect(await latestVersion({ dataDir, platform: "win32", fetch: fetchSpy })).toBeNull()
  })

  test("the site's placeholder manifest is the no-release shape", async () => {
    const placeholder = await Bun.file(join(import.meta.dir, "../fixtures/windows-latest.json")).text()
    expect(JSON.parse(placeholder)).toEqual({ version: null })
    expect(manifestVersion(placeholder)).toBeNull()
  })

  const MONOREPO_MANIFEST = join(import.meta.dir, "../../../site/public/windows/latest.json")
  test.skipIf(!existsSync(MONOREPO_MANIFEST))("the Windows manifest fixture stays in parity with the site placeholder", async () => {
    expect(JSON.parse(await Bun.file(MONOREPO_MANIFEST).text())).toEqual(JSON.parse(await Bun.file(join(import.meta.dir, "../fixtures/windows-latest.json")).text()))
  })

  test("latestVersion reads a Scoop manifest's version on Windows", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "rudder-update-"))
    dirs.push(dataDir)
    const fetchSpy = (async () => new Response(JSON.stringify({ version: "1.2.0", architecture: {} }))) as unknown as typeof fetch
    expect(await latestVersion({ dataDir, platform: "win32", url: "https://example.invalid/rudder.json", fetch: fetchSpy })).toBe("1.2.0")
    expect(manifestVersion('{"version":"1.0.0; calc"}')).toBeNull()
    expect(manifestVersion("not json")).toBeNull()
  })
})
