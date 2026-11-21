// perf-1112 round two (R6): handoff.list stat'ed every transcript of every project folder on each call.
import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { inspectTranscript, TranscriptScanner } from "./claude-scan"

const DAY = 24 * 60 * 60 * 1000
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function transcript(path: string, at: number) {
  const line = { type: "user", uuid: crypto.randomUUID(), cwd: "/tmp", version: "2.1.0", entrypoint: "cli", message: { role: "user", content: "hello" } }
  writeFileSync(path, `${JSON.stringify(line)}\n`)
  utimesSync(path, at / 1000, at / 1000)
}

describe("transcript scan", () => {
  test("an unchanged folder's old transcripts are not looked at again until the refresh interval", async () => {
    const projects = mkdtempSync(join(tmpdir(), "rudder-scan-"))
    dirs.push(projects)
    const folder = join(projects, "-tmp-app")
    mkdirSync(folder)
    const now = Date.now()
    const old = join(folder, `${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}.jsonl`)
    const recent = join(folder, `${"1".repeat(8)}-0000-4000-8000-${"0".repeat(12)}.jsonl`)
    transcript(old, now - 30 * DAY)
    transcript(recent, now - DAY)
    // The folder's own mtime stays put while files inside are appended to.
    utimesSync(folder, (now - DAY) / 1000, (now - DAY) / 1000)
    const scanner = new TranscriptScanner(projects, 60_000)
    expect((await scanner.scan({ now })).map((entry) => entry.path)).toEqual([recent])
    // The old one is resumed in a terminal: appended, its folder unchanged.
    utimesSync(old, now / 1000, now / 1000)
    expect((await scanner.scan({ now: now + 1000 })).map((entry) => entry.path)).toEqual([recent])
    // A live session is looked at regardless.
    const live = new Set([`${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}`])
    expect((await scanner.scan({ now: now + 1000, include: live })).map((entry) => entry.path)).toEqual([old, recent])
    // Past the refresh interval the folder is listed again.
    expect((await scanner.scan({ now: now + 61_000 })).map((entry) => entry.path)).toEqual([old, recent])
  })

  test("a transcript added to a folder is seen at once", async () => {
    const projects = mkdtempSync(join(tmpdir(), "rudder-scan-"))
    dirs.push(projects)
    const folder = join(projects, "-tmp-app")
    mkdirSync(folder)
    const now = Date.now()
    const first = join(folder, `${"2".repeat(8)}-0000-4000-8000-${"0".repeat(12)}.jsonl`)
    transcript(first, now - DAY)
    utimesSync(folder, (now - DAY) / 1000, (now - DAY) / 1000)
    const scanner = new TranscriptScanner(projects, 60_000)
    expect(await scanner.scan({ now })).toHaveLength(1)
    const second = join(folder, `${"3".repeat(8)}-0000-4000-8000-${"0".repeat(12)}.jsonl`)
    transcript(second, now)
    expect((await scanner.scan({ now: now + 1000 })).map((entry) => entry.path)).toEqual([second, first])
  })

  test("concurrent inspects of one file read it once", async () => {
    const projects = mkdtempSync(join(tmpdir(), "rudder-scan-"))
    dirs.push(projects)
    const folder = join(projects, "-tmp-app")
    mkdirSync(folder)
    const recent = join(folder, `${"4".repeat(8)}-0000-4000-8000-${"0".repeat(12)}.jsonl`)
    transcript(recent, Date.now() - DAY)
    let reads = 0
    const scanner = new TranscriptScanner(projects, 60_000, async (path) => {
      reads += 1
      return inspectTranscript(path)
    })
    const [a, b] = await Promise.all([scanner.inspect(recent), scanner.inspect(recent)])
    expect(reads).toBe(1)
    expect(a).toEqual(b)
  })

  test("the scanner touches no synchronous fs call", async () => {
    const source = await Bun.file(new URL("./claude-scan.ts", import.meta.url)).text()
    const body = source.slice(source.indexOf("export async function inspectTranscript"))
    const scanner = body.slice(body.indexOf("export const SCAN_FOLDER_REFRESH_MS"))
    expect(body.slice(0, body.indexOf("export function findTranscript"))).not.toMatch(/\b(readSync|readdirSync|statSync|openSync)\b/)
    expect(scanner).not.toMatch(/\b(readSync|readdirSync|statSync|openSync)\b/)
  })
})

// 11-19: a terminal session opened with a slash command was listed under the raw command.
test("a transcript that opens with a slash command takes its first ordinary prompt as the title", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rudder-scan-"))
  dirs.push(dir)
  const record = (content: string) => ({ type: "user", uuid: crypto.randomUUID(), cwd: "/tmp", version: "2.1.0", entrypoint: "cli", message: { role: "user", content } })
  const command = "<command-message>superpowers:requesting-code-review</command-message>\n<command-name>/superpowers:requesting-code-review</command-name>"
  const both = join(dir, "both.jsonl")
  writeFileSync(both, `${[record(command), record("review the D10 ranking change")].map((line) => JSON.stringify(line)).join("\n")}\n`)
  expect((await inspectTranscript(both)).title).toBe("review the D10 ranking change")
  const alone = join(dir, "alone.jsonl")
  writeFileSync(alone, `${JSON.stringify(record(command))}\n`)
  expect((await inspectTranscript(alone)).title).toBe("requesting code review")
})
