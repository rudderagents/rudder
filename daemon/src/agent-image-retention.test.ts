import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFakeAdapter } from "./adapter/fake"
import { AGENT_IMAGE_RETENTION, type AgentImageRetention, pickEvictions } from "./agent-image-retention"
import { findAttachment, saveAttachment } from "./attachments"
import { SessionService } from "./session-service"
import { Store } from "./store"

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
const NOW = 1_800_000_000_000
const RETENTION: AgentImageRetention = { budgetBytes: 1000, maxAgeMs: 30 * DAY, keepRecentMs: 30 * MINUTE, afterWriteDelayMs: 60_000 }

describe("pickEvictions", () => {
  const at = (id: string, ageMs: number, bytes: number) => ({ id, createdAt: NOW - ageMs, bytes })
  const ids = (images: { id: string }[]) => images.map((image) => image.id)

  test("under the budget and the age limit nothing goes", () => {
    expect(pickEvictions([at("a", 2 * DAY, 400), at("b", DAY, 400)], NOW, RETENTION)).toEqual([])
  })

  test("over the byte budget the oldest go first until it fits", () => {
    const images = [at("new", 1 * DAY, 400), at("old", 3 * DAY, 400), at("mid", 2 * DAY, 400), at("newest", 2 * 60 * MINUTE, 400)]
    expect(ids(pickEvictions(images, NOW, RETENTION))).toEqual(["old", "mid"])
  })

  test("past the age limit an image goes even under the budget", () => {
    const images = [at("stale", 31 * DAY, 10), at("older", 40 * DAY, 10), at("fresh", 29 * DAY, 10)]
    expect(ids(pickEvictions(images, NOW, RETENTION))).toEqual(["older", "stale"])
  })

  test("an image inside the replay window stays, over budget or not", () => {
    const images = [at("old", 2 * DAY, 400), at("recent", 10 * MINUTE, 5000)]
    expect(ids(pickEvictions(images, NOW, RETENTION))).toEqual(["old"])
  })

  test("defaults: 500 MB, 30 days, the 30-minute replay window", () => {
    expect(AGENT_IMAGE_RETENTION.budgetBytes).toBe(500 * 1024 * 1024)
    expect(AGENT_IMAGE_RETENTION.maxAgeMs).toBe(30 * DAY)
    expect(AGENT_IMAGE_RETENTION.keepRecentMs).toBe(30 * MINUTE)
  })
})

describe("SessionService.pruneAgentImages", () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  async function setup(retention: Partial<AgentImageRetention>) {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "rudder-image-retention-")))
    dirs.push(cwd)
    const store = new Store(":memory:")
    const sessionId = store.createSession({ title: "t", agent: "fake", cwd }).id
    const service = new SessionService(store, createFakeAdapter(), () => {}, { workspaceRoot: cwd, imageRetention: retention })
    const image = async (rowId: string, ageMs: number, bytes: number, role = "assistant") => {
      const saved = await saveAttachment(cwd, sessionId, `${rowId}.png`, new Uint8Array(bytes))
      store.insertMessage({
        id: rowId,
        session_id: sessionId,
        kind: "image",
        role,
        text: "",
        payload: JSON.stringify({ id: saved.id, name: saved.name, bytes }),
        created_at: NOW - ageMs,
      })
      return saved
    }
    return { cwd, sessionId, service, store, image }
  }

  test("evicts by size, oldest first, from the session folder", async () => {
    const { cwd, sessionId, service, image } = await setup({ budgetBytes: 1000 })
    const oldest = await image("m1", 3 * DAY, 400)
    const middle = await image("m2", 2 * DAY, 400)
    const newer = await image("m3", DAY, 400)
    const recent = await image("m4", 5 * MINUTE, 400)
    const result = await service.pruneAgentImages(NOW)
    expect(result).toEqual({ removed: 2, freedBytes: 800, keptBytes: 800 })
    expect(existsSync(oldest.path)).toBe(false)
    expect(existsSync(middle.path)).toBe(false)
    expect(existsSync(newer.path)).toBe(true)
    expect(existsSync(recent.path)).toBe(true)
    // The row stays; asking for the removed file is a plain not-found, which the phone shows as v65 A5.
    expect(await findAttachment(cwd, sessionId, oldest.id)).toBeNull()
    expect(await service.readAttachment(sessionId, oldest.id)).toBeNull()
    // A second pass has nothing left to do.
    expect(await service.pruneAgentImages(NOW)).toEqual({ removed: 0, freedBytes: 0, keptBytes: 800 })
  })

  test("evicts by age under the budget, and never touches the phone's own uploads", async () => {
    const { cwd, sessionId, service, image } = await setup({})
    const stale = await image("m1", 31 * DAY, 10)
    const fresh = await image("m2", 29 * DAY, 10)
    const upload = await saveAttachment(cwd, sessionId, "photo.jpg", new Uint8Array(10))
    const result = await service.pruneAgentImages(NOW)
    expect(result?.removed).toBe(1)
    expect(existsSync(stale.path)).toBe(false)
    expect(existsSync(fresh.path)).toBe(true)
    expect(existsSync(upload.path)).toBe(true)
  })

  test("pruning looks up only files still in the attachment directory", async () => {
    const { sessionId, service, store, image } = await setup({})
    const history = store.db.transaction(() => {
      for (let n = 0; n < 10_000; n++) {
        store.insertMessage({
          id: `historic-${n}`, session_id: sessionId, kind: "image", role: "assistant", text: "",
          payload: n === 0 ? "{" : JSON.stringify({ id: `historic-${n}` }), created_at: NOW - 40 * DAY,
        })
      }
    })
    history()
    const live = await image("live", DAY, 100)
    const lookup = spyOn(store, "findAgentImageCreatedAt")
    try {
      expect(await service.pruneAgentImages(NOW)).toEqual({ removed: 0, freedBytes: 0, keptBytes: 100 })
      expect(lookup.mock.calls).toEqual([[sessionId, live.id]])
      expect(store.getMessage("historic-9999")).not.toBeNull()
      expect(existsSync(live.path)).toBe(true)
    } finally {
      lookup.mockRestore()
    }
  })

  test("a file already gone is skipped", async () => {
    const { service, image } = await setup({})
    const stale = await image("m1", 31 * DAY, 10)
    rmSync(stale.path)
    expect(await service.pruneAgentImages(NOW)).toEqual({ removed: 0, freedBytes: 0, keptBytes: 0 })
  })
})
