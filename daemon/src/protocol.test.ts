import { describe, expect, test } from "bun:test"
import { eventFrame, invokeFrame, parseFrame, resultFrame } from "./protocol"

describe("protocol", () => {
  test("round-trips invoke", () => {
    const frame = invokeFrame("1", "session.list", {})
    expect(parseFrame(JSON.stringify(frame))).toEqual(frame)
  })

  test("rejects other versions", () => {
    expect(() => parseFrame(JSON.stringify({ v: 2, id: "1", type: "invoke" }))).toThrow(/unsupported/)
  })

  test("result and event shapes", () => {
    expect(resultFrame("1", { ok: true }).type).toBe("result")
    expect(eventFrame("session.upsert", { id: "s" }).name).toBe("session.upsert")
  })
})
