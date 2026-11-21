import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, spyOn, test } from "bun:test"
import { fileContains, streamContains } from "./file-search"

// review2-1117: a Claude rewind read the whole transcript (tens of MB for a long session) into one string to look
// for one uuid. The search now streams it.

async function* chunks(...parts: string[]) {
  for (const part of parts) yield new TextEncoder().encode(part)
}

describe("streamContains", () => {
  test("finds a needle inside one chunk", async () => {
    expect(await streamContains(chunks("abc", `x"uuid":"u1"y`, "z"), `"uuid":"u1"`)).toBe(true)
  })

  test("finds a needle split across chunks", async () => {
    expect(await streamContains(chunks(`aaa"uu`, `id":`, `"u1`, `"bbb`), `"uuid":"u1"`)).toBe(true)
  })

  test("a needle that is only near the boundary is not found", async () => {
    expect(await streamContains(chunks(`"uuid":"u`, `2"`, `"uuid":"u1`), `"uuid":"u1"`)).toBe(false)
  })

  test("multi-byte text around the needle", async () => {
    const text = `前文${"字".repeat(5000)}"uuid":"ü1"后文`
    const bytes = new TextEncoder().encode(text)
    async function* split() {
      for (let at = 0; at < bytes.length; at += 7) yield bytes.subarray(at, at + 7)
    }
    expect(await streamContains(split(), `"uuid":"ü1"`)).toBe(true)
  })
})

describe("fileContains", () => {
  test("reads a file larger than a stream chunk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rudder-search-"))
    try {
      const path = join(dir, "t.jsonl")
      writeFileSync(path, `${"x".repeat(3_000_000)}"uuid":"end"\n`)
      expect(await fileContains(path, `"uuid":"end"`)).toBe(true)
      expect(await fileContains(path, `"uuid":"nope"`)).toBe(false)
      expect(await fileContains(join(dir, "missing"), "x")).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// review3-1117: a read error answered false with its cause dropped, so a rewind that could not read its transcript
// looked like one whose cut was not there.
describe("fileContains read errors", () => {
  test("an unreadable file answers false and says why", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rudder-search-"))
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      const path = join(dir, "t.jsonl")
      writeFileSync(path, `{"uuid":"u1"}\n`)
      chmodSync(path, 0o000)
      expect(await fileContains(path, `"uuid":"u1"`)).toBe(false)
      expect(warn).toHaveBeenCalled()
      expect(String(warn.mock.calls[0]?.join(" "))).toContain(path)
    } finally {
      warn.mockRestore()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
