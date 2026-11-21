import { describe, expect, test } from "bun:test"
import { KNOWN_MESSAGE_KINDS, type MessageRow, messagePublic, withSummary } from "./store"

function row(overrides: Partial<MessageRow>): MessageRow {
  return { id: "m1", session_id: "s", seq: 1, kind: "text", role: "assistant", text: "", payload: null, created_at: 1, ...overrides }
}

describe("message kinds and the summary rule", () => {
  test("a kind the 1.0 app does not know carries its summary on the wire", () => {
    const message = messagePublic(row({ kind: "checkpoint", payload: withSummary({ files: 3 }, "Saved a checkpoint of 3 files") }))
    expect(message.kind).toBe("checkpoint")
    expect(message.summary).toBe("Saved a checkpoint of 3 files")
  })

  test("known kinds never grow a summary, even if a payload happens to have one", () => {
    for (const kind of KNOWN_MESSAGE_KINDS) {
      const message = messagePublic(row({ kind, payload: JSON.stringify({ summary: "x" }) }))
      expect("summary" in message).toBe(false)
    }
  })

  test("a newer kind without a usable summary sends none", () => {
    for (const payload of [null, "{}", '{"summary":"  "}', '{"summary":3}', "not json \"summary\""]) {
      expect("summary" in messagePublic(row({ kind: "checkpoint", payload }))).toBe(false)
    }
  })
})
