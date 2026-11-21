import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { DEFAULT_RELAY, DEFAULT_RELAY_LIST } from "../config"
import { MAX_RELAY_BASES, parseRelayList, RELAY_LIST_FILE, RelayDirectory, readRelayListCache } from "./directory"

const HK = "wss://relay-hk.rudderagents.com"
const NOW = Date.UTC(2026, 9, 31, 12)

let dir: string
let directories: RelayDirectory[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rudder-relays-"))
})

afterEach(() => {
  for (const directory of directories.splice(0)) directory.stop()
  rmSync(dir, { recursive: true, force: true })
})

/** A fetch that answers from a queue and records each URL; no network. */
function fakeFetch(...answers: (unknown | Error)[]) {
  const calls: string[] = []
  const fetcher = async (url: string) => {
    calls.push(url)
    const answer = answers.length > 1 ? answers.shift() : answers[0]
    if (answer instanceof Error) throw answer
    if (answer instanceof Response) return answer
    return Response.json(answer)
  }
  return { fetcher, calls }
}

function directory(fetcher: (url: string) => Promise<Response>, changes: string[][] = [], now = () => NOW) {
  const made = new RelayDirectory({ dataDir: dir, fetch: fetcher, now, onChange: (bases) => changes.push(bases), retryMs: 60_000 })
  directories.push(made)
  return made
}

describe("relay list answer", () => {
  test("keeps valid wss:// origins in order, dedups, caps, clamps ttl", () => {
    expect(parseRelayList({ relays: [{ base: DEFAULT_RELAY }, { base: `${HK}/` }, { base: DEFAULT_RELAY }], ttl: 86400 })).toEqual({
      bases: [DEFAULT_RELAY, HK],
      ttl: 86400,
    })
    const many = { relays: Array.from({ length: 9 }, (_, i) => ({ base: `wss://r${i}.example` })), ttl: 5 }
    const parsed = parseRelayList(many)!
    expect(parsed.bases).toHaveLength(MAX_RELAY_BASES)
    expect(parsed.ttl).toBe(3600)
    expect(parseRelayList({ relays: [{ base: DEFAULT_RELAY }] })?.ttl).toBe(86400)
    expect(parseRelayList({ relays: [{ base: DEFAULT_RELAY }], ttl: 10 ** 9 })?.ttl).toBe(7 * 86400)
  })

  test("rejects anything that is not a wss:// origin", () => {
    for (const base of ["ws://relay.example", "https://relay.example", "wss://relay.example/path", "wss://relay.example?x=1", "wss://a b"]) {
      expect(parseRelayList({ relays: [{ base }] })).toBeNull()
    }
    expect(parseRelayList({ relays: [] })).toBeNull()
    expect(parseRelayList({ relays: "wss://relay.example" })).toBeNull()
    expect(parseRelayList(null)).toBeNull()
  })
})

describe("RelayDirectory", () => {
  test("starts on DEFAULT_RELAY, fetches the list, switches and caches it 0600", async () => {
    const { fetcher, calls } = fakeFetch({ relays: [{ base: DEFAULT_RELAY }, { base: HK, region: "hk" }], ttl: 86400 })
    const changes: string[][] = []
    const made = directory(fetcher, changes)
    expect(made.bases).toEqual([DEFAULT_RELAY])
    expect(await made.refresh()).toBe(true)
    expect(calls).toEqual([DEFAULT_RELAY_LIST])
    expect(made.bases).toEqual([DEFAULT_RELAY, HK])
    expect(changes).toEqual([[DEFAULT_RELAY, HK]])
    expect(readRelayListCache(dir)).toEqual({ fetchedAt: NOW, ttl: 86400, bases: [DEFAULT_RELAY, HK] })
    if (process.platform !== "win32") expect(statSync(join(dir, RELAY_LIST_FILE)).mode & 0o777).toBe(0o600)
  })

  test("an unchanged list does not reconcile", async () => {
    const changes: string[][] = []
    const made = directory(fakeFetch({ relays: [{ base: DEFAULT_RELAY }], ttl: 86400 }).fetcher, changes)
    expect(await made.refresh()).toBe(true)
    expect(changes).toEqual([])
  })

  test("a failed or malformed fetch keeps the current list and the cache", async () => {
    writeFileSync(join(dir, RELAY_LIST_FILE), JSON.stringify({ fetchedAt: NOW - 2 * 86_400_000, ttl: 86400, bases: [DEFAULT_RELAY, HK] }))
    const changes: string[][] = []
    const answers = [new Error("offline"), new Response("nope", { status: 503 }), { relays: [{ base: "ws://evil.example" }] }]
    for (const answer of answers) {
      const made = directory(fakeFetch(answer).fetcher, changes)
      expect(made.bases).toEqual([DEFAULT_RELAY, HK])
      expect(await made.refresh()).toBe(false)
      expect(made.bases).toEqual([DEFAULT_RELAY, HK])
    }
    expect(changes).toEqual([])
    expect(readRelayListCache(dir)?.bases).toEqual([DEFAULT_RELAY, HK])
  })

  test("a corrupt cache falls back to DEFAULT_RELAY", () => {
    writeFileSync(join(dir, RELAY_LIST_FILE), "{not json")
    expect(directory(fakeFetch(new Error("offline")).fetcher).bases).toEqual([DEFAULT_RELAY])
    writeFileSync(join(dir, RELAY_LIST_FILE), JSON.stringify({ fetchedAt: NOW, ttl: 86400, bases: ["https://x.example"] }))
    expect(directory(fakeFetch(new Error("offline")).fetcher).bases).toEqual([DEFAULT_RELAY])
  })

  test("start respects the cached ttl: fresh cache waits, stale cache fetches now", async () => {
    writeFileSync(join(dir, RELAY_LIST_FILE), JSON.stringify({ fetchedAt: NOW - 3_600_000, ttl: 86400, bases: [DEFAULT_RELAY] }))
    const fresh = fakeFetch({ relays: [{ base: HK }], ttl: 86400 })
    directory(fresh.fetcher).start()
    await Bun.sleep(5)
    expect(fresh.calls).toEqual([])

    writeFileSync(join(dir, RELAY_LIST_FILE), JSON.stringify({ fetchedAt: NOW - 2 * 86_400_000, ttl: 86400, bases: [DEFAULT_RELAY] }))
    const changes: string[][] = []
    const stale = fakeFetch({ relays: [{ base: HK }], ttl: 86400 })
    directory(stale.fetcher, changes).start()
    await Bun.sleep(5)
    expect(stale.calls).toHaveLength(1)
    expect(changes).toEqual([[HK]])
  })

  test("stop cancels the scheduled refetch", async () => {
    const { fetcher, calls } = fakeFetch(new Error("offline"))
    const made = new RelayDirectory({ dataDir: dir, fetch: fetcher, now: () => NOW, onChange: () => {}, retryMs: 10 })
    directories.push(made)
    made.start()
    await Bun.sleep(30)
    made.stop()
    const seen = calls.length
    expect(seen).toBeGreaterThan(1)
    await Bun.sleep(30)
    expect(calls.length).toBe(seen)
  })
})
