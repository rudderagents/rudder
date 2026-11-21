import { describe, expect, test } from "bun:test"
import { redactSecrets } from "./redact"
import { spawnLines } from "./stdio"

describe("redactSecrets", () => {
  test("credential shapes are replaced; labels and ordinary text stay", () => {
    const cases: [string, string][] = [
      ["Authorization: Bearer abcdef1234567890xyz", "Authorization: [redacted]"],
      ["using bearer abcdefgh12345678", "using bearer [redacted]"],
      ["OPENAI_API_KEY=sk-proj-AAAAAAAAAAAAAAAAAAAA1234", "OPENAI_API_KEY=[redacted]"],
      ['{"api_key": "abc123secretvalue"}', '{"api_key": "[redacted]"}'],
      ["GET https://api.x.ai/v1?key=AIzaSomething&q=1", "GET https://api.x.ai/v1?key=[redacted]&q=1"],
      ["key sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV leaked", "key [redacted] leaked"],
      ["token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345", "token [redacted]"],
      ["aws AKIAABCDEFGHIJKLMNOP done", "aws [redacted] done"],
      ["jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijk", "jwt [redacted]"],
      ["Your api key: ****0000 is invalid", "Your api key: ****0000 is invalid"],
      ["fatal: stream broke", "fatal: stream broke"],
      ["error: model not found (code 404)", "error: model not found (code 404)"],
    ]
    for (const [input, expected] of cases) expect(redactSecrets(input)).toBe(expected)
  })

  test("a process's stderr tail is redacted before anyone reads it", async () => {
    const proc = spawnLines(["sh", "-c", "echo 'Authorization: Bearer abcdef1234567890xyz' >&2; exit 3"], { onLine: () => {} })
    await proc.exited
    expect(proc.stderrTail()).toBe("Authorization: [redacted]")
  })
})
