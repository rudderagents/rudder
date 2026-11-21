import { describe, expect, test } from "bun:test"
import { createFakeAdapter } from "./adapter/fake"
import type { Frame } from "./protocol"
import { SessionService } from "./session-service"
import { Store } from "./store"

type Page = { messages: { id: string; text: string }[]; nextOffset?: number }
const PAGE_BYTES = 4_194_304
const FRAME_BYTES = 16_777_216
const frameBytes = (frame: Frame) => Buffer.byteLength(JSON.stringify(frame), "utf8")

function harness() {
  const store = new Store(":memory:")
  store.seedIfEmpty()
  const sessionId = store.listSessions()[0]!.id
  const service = new SessionService(store, createFakeAdapter(), () => {})
  const insert = (id: string, text: string, session = sessionId) => store.insertMessage({
    id, session_id: session, kind: "text", role: "assistant", text, created_at: 1,
  })
  return { store, sessionId, service, insert }
}

describe("byte-budgeted message bodies", () => {
  test("pagedBodiesStayUnderTheEncodedFrameBudget", async () => {
    const h = harness()
    try {
      const text = "x".repeat(512 * 1024)
      const ids = Array.from({ length: 40 }, (_, index) => `body-${index}`)
      for (const id of ids) h.insert(id, text)
      const found: string[] = []
      let offset = 0
      let pages = 0
      while (offset < ids.length) {
        const frame = await h.service.invoke("message.bodies", { sessionId: h.sessionId, ids, paged: true, offset }, `page-${pages}`)
        expect(frame.type).toBe("result")
        expect(frameBytes(frame)).toBeLessThanOrEqual(PAGE_BYTES)
        const page = frame.result as Page
        found.push(...page.messages.map((row) => row.id))
        pages += 1
        if (page.nextOffset === undefined) break
        expect(page.nextOffset).toBeGreaterThan(offset)
        expect(page.nextOffset).toBeLessThanOrEqual(ids.length)
        offset = page.nextOffset
        if (pages > ids.length) throw new Error("body cursor did not terminate")
      }
      expect(found).toEqual(ids)
      expect(pages).toBeGreaterThan(1)
      console.log(`BODY_PAGES rows=${found.length} pages=${pages}`)
    } finally { h.service.shutdown() }
  })

  test("escapedAndUnicodeBodiesCountTheCompleteResultFrame", async () => {
    const h = harness()
    try {
      const ids = Array.from({ length: 12 }, (_, index) => `escaped-${index}`)
      const text = '"\\\n雪'.repeat(80_000)
      for (const id of ids) h.insert(id, text)
      let offset = 0
      const seen: string[] = []
      for (let pageNumber = 0; pageNumber < ids.length; pageNumber++) {
        const frame = await h.service.invoke("message.bodies", { sessionId: h.sessionId, ids, paged: true, offset }, '"雪\\\n'.repeat(64))
        expect(frame.type).toBe("result")
        expect(frameBytes(frame)).toBeLessThanOrEqual(PAGE_BYTES)
        const page = frame.result as Page
        expect(page.messages.every((row) => row.text === text)).toBe(true)
        seen.push(...page.messages.map((row) => row.id))
        if (page.nextOffset === undefined) break
        expect(page.nextOffset).toBeGreaterThan(offset)
        offset = page.nextOffset
      }
      expect(seen).toEqual(ids)
    } finally { h.service.shutdown() }
  })

  test("requestMetadataAtThePageBoundaryCannotOverflowAnOrdinaryPage", async () => {
    const h = harness()
    try {
      for (const id of ["left", "right"]) h.insert(id, "x".repeat(PAGE_BYTES / 2 - 1024))
      const frame = await h.service.invoke("message.bodies", { sessionId: h.sessionId, ids: ["left", "right"], paged: true }, '雪"\\\n'.repeat(2048))
      expect(frame.type).toBe("result")
      expect(frameBytes(frame)).toBeLessThanOrEqual(PAGE_BYTES)
      expect((frame.result as Page).messages.map((row) => row.id)).toEqual(["left"])
      expect((frame.result as Page).nextOffset).toBe(1)
    } finally { h.service.shutdown() }
  })

  test("singleLargeBodyUsesOneTransportSafePage", async () => {
    const h = harness()
    try {
      h.insert("large", "x".repeat(6 * 1024 * 1024))
      h.insert("small", "next")
      const frame = await h.service.invoke("message.bodies", { sessionId: h.sessionId, ids: ["large", "small"], paged: true }, "large-page")
      expect(frame.type).toBe("result")
      expect(frameBytes(frame)).toBeGreaterThan(PAGE_BYTES)
      expect(frameBytes(frame)).toBeLessThanOrEqual(FRAME_BYTES)
      const page = frame.result as Page
      expect(page.messages.map((row) => row.id)).toEqual(["large"])
      expect(page.nextOffset).toBe(1)
      const next = await h.service.invoke("message.bodies", { sessionId: h.sessionId, ids: ["large", "small"], paged: true, offset: 1 }, "next")
      expect((next.result as Page).messages.map((row) => row.id)).toEqual(["small"])
      expect((next.result as Page).nextOffset).toBeUndefined()
    } finally { h.service.shutdown() }
  })

  test("oversizedSingletonReturnsExplicitError", async () => {
    const h = harness()
    try {
      h.insert("oversized-body", "x".repeat(17 * 1024 * 1024))
      for (const paged of [true, false]) {
        const frame = await h.service.invoke("message.bodies", { sessionId: h.sessionId, ids: ["oversized-body"], paged }, "oversized")
        expect(frame.type).toBe("error")
        expect(frame.error?.code).toBe("body_too_large")
        expect(frame.error?.message).toContain("oversized-body")
        expect(frame.error?.message).toContain("bytes")
        expect(frameBytes(frame)).toBeLessThanOrEqual(FRAME_BYTES)
      }
    } finally { h.service.shutdown() }
  })

  test("unknownIDsAdvanceTheCursor", async () => {
    const h = harness()
    try {
      h.insert("foreign", "not this session", "another-session")
      h.insert("one", "x".repeat(3 * 1024 * 1024))
      h.insert("two", "y".repeat(3 * 1024 * 1024))
      const ids = ["missing", "foreign", "one", "absent", "two", "missing-tail"]
      const first = await h.service.invoke("message.bodies", { sessionId: h.sessionId, ids, paged: true }, "unknown")
      expect((first.result as Page).messages.map((row) => row.id)).toEqual(["one"])
      expect((first.result as Page).nextOffset).toBe(4)
      const second = await h.service.invoke("message.bodies", { sessionId: h.sessionId, ids, paged: true, offset: 4 }, "tail")
      expect((second.result as Page).messages.map((row) => row.id)).toEqual(["two"])
      expect((second.result as Page).nextOffset).toBeUndefined()
      for (const empty of [[], ["missing", "foreign"]]) {
        const frame = await h.service.invoke("message.bodies", { sessionId: h.sessionId, ids: empty, paged: true }, "empty")
        expect((frame.result as Page).messages).toEqual([])
        expect((frame.result as Page).nextOffset).toBeUndefined()
      }
    } finally { h.service.shutdown() }
  })

  test("legacyBodiesNeverSilentlyOmitRows", async () => {
    const h = harness()
    try {
      const ids = Array.from({ length: 40 }, (_, index) => `legacy-${index}`)
      for (const id of ids) h.insert(id, "x".repeat(512 * 1024))
      const frame = await h.service.invoke("message.bodies", { sessionId: h.sessionId, ids }, "legacy")
      expect(frame.type).toBe("error")
      expect(frame.error?.code).toBe("body_too_large")
      expect(frameBytes(frame)).toBeLessThanOrEqual(FRAME_BYTES)
      const small = await h.service.invoke("message.bodies", { sessionId: h.sessionId, ids: ids.slice(0, 3) }, "small-legacy")
      expect((small.result as Page).messages.map((row) => row.id)).toEqual(ids.slice(0, 3))
      expect((small.result as Page).nextOffset).toBeUndefined()
    } finally { h.service.shutdown() }
  })

  test("pagedOffsetsAreValidatedAndTwoHundredIDsKeepTheirOrder", async () => {
    const h = harness()
    try {
      const ids = Array.from({ length: 200 }, (_, index) => `ordered-${index}`)
      for (const id of ids) h.insert(id, id)
      const ordered = ids.toReversed()
      const frame = await h.service.invoke("message.bodies", { sessionId: h.sessionId, ids: ordered, paged: true }, "ordered")
      expect((frame.result as Page).messages.map((row) => row.id)).toEqual(ordered)
      for (const offset of [-1, 0.5, "1", 201, null]) {
        const bad = await h.service.invoke("message.bodies", { sessionId: h.sessionId, ids, paged: true, offset }, "bad-offset")
        expect(bad.error?.code).toBe("invalid")
      }
      const tooMany = await h.service.invoke("message.bodies", { sessionId: h.sessionId, ids: [...ids, "extra"], paged: true }, "too-many")
      expect(tooMany.error?.code).toBe("invalid")
    } finally { h.service.shutdown() }
  })
})
