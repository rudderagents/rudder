import { readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DEFAULT_RELAY, DEFAULT_RELAY_LIST } from "../config"

/**
 * The relay list (the relay design notes): `GET <list>` answers `{relays: [{base, region?}], ttl}` for every
 * configured base (`?scope=computer`), not the phone's country filter. The last good answer is kept in
 * `RUDDER_HOME/relays.json`, so a restart without network still holds the same slots; with neither, DEFAULT_RELAY.
 */
export const RELAY_LIST_FILE = "relays.json"
export const MAX_RELAY_BASES = 4
const MIN_TTL_SECONDS = 60 * 60
const MAX_TTL_SECONDS = 7 * 24 * 60 * 60
const DEFAULT_TTL_SECONDS = 24 * 60 * 60
const BASE_PATTERN = /^wss:\/\/[^/?#\s]+$/

export type RelayListCache = { fetchedAt: number; ttl: number; bases: string[] }

/** The valid `wss://` origins in a relay-list answer, deduplicated, in order, at most MAX_RELAY_BASES; null if none. */
export function parseRelayList(body: unknown): { bases: string[]; ttl: number } | null {
  if (!body || typeof body !== "object") return null
  const { relays, ttl } = body as { relays?: unknown; ttl?: unknown }
  if (!Array.isArray(relays)) return null
  const bases = validBases(relays.map((entry) => (entry && typeof entry === "object" ? (entry as { base?: unknown }).base : undefined)))
  if (bases.length === 0) return null
  const seconds = typeof ttl === "number" && Number.isFinite(ttl) ? ttl : DEFAULT_TTL_SECONDS
  return { bases, ttl: Math.min(MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, Math.round(seconds))) }
}

function validBases(values: unknown[]): string[] {
  const bases: string[] = []
  for (const value of values) {
    if (typeof value !== "string") continue
    const base = value.trim().replace(/\/+$/, "")
    if (BASE_PATTERN.test(base) && !bases.includes(base)) bases.push(base)
    if (bases.length === MAX_RELAY_BASES) break
  }
  return bases
}

export function readRelayListCache(dataDir: string): RelayListCache | null {
  try {
    const value = JSON.parse(readFileSync(join(dataDir, RELAY_LIST_FILE), "utf8")) as Partial<RelayListCache>
    if (typeof value.fetchedAt !== "number" || typeof value.ttl !== "number" || !Array.isArray(value.bases)) return null
    const bases = validBases(value.bases)
    return bases.length > 0 ? { fetchedAt: value.fetchedAt, ttl: value.ttl, bases } : null
  } catch {
    return null
  }
}

export function writeRelayListCache(dataDir: string, cache: RelayListCache): void {
  const path = join(dataDir, RELAY_LIST_FILE)
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(cache), { mode: 0o600 })
  renameSync(temp, path)
}

export type RelayDirectoryOptions = {
  dataDir: string
  /** The bases changed (a node added or removed); the server reconciles its links. */
  onChange: (bases: string[]) => void
  url?: string
  fetch?: (url: string, init: RequestInit) => Promise<Response>
  now?: () => number
  log?: (line: string) => void
  timeoutMs?: number
  /** After a failed fetch, the next try; the cached list stays in use meanwhile. */
  retryMs?: number
}

/** Keeps the relay list current: fetched when the cache is missing or older than its ttl, then again every ttl. */
export class RelayDirectory {
  private current: string[]
  private cache: RelayListCache | null
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private readonly now: () => number
  private readonly fetcher: (url: string, init: RequestInit) => Promise<Response>

  constructor(private readonly options: RelayDirectoryOptions) {
    this.now = options.now ?? Date.now
    this.fetcher = options.fetch ?? fetch
    this.cache = readRelayListCache(options.dataDir)
    this.current = this.cache?.bases ?? [DEFAULT_RELAY]
  }

  /** The bases to hold a slot on now: the last good list, or DEFAULT_RELAY. */
  get bases(): string[] {
    return [...this.current]
  }

  start(): void {
    this.stopped = false
    const due = this.cache ? this.cache.fetchedAt + this.cache.ttl * 1000 - this.now() : 0
    if (due <= 0) void this.refresh()
    else this.schedule(due)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** One fetch. True when a valid list arrived (changed or not); a failure keeps the current list. */
  async refresh(): Promise<boolean> {
    const url = this.options.url ?? DEFAULT_RELAY_LIST
    let list: ReturnType<typeof parseRelayList>
    try {
      const response = await this.fetcher(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      list = parseRelayList(await response.json())
      if (!list) throw new Error("no valid wss:// relay in the answer")
    } catch (error) {
      this.options.log?.(`relay list ${url}: ${error instanceof Error ? error.message : String(error)}; keeping ${this.current.join(", ")}`)
      this.schedule(this.options.retryMs ?? 60 * 60 * 1000)
      return false
    }
    if (this.stopped) return true
    this.cache = { fetchedAt: this.now(), ttl: list.ttl, bases: list.bases }
    try {
      writeRelayListCache(this.options.dataDir, this.cache)
    } catch (error) {
      this.options.log?.(`relay list: could not write ${RELAY_LIST_FILE}: ${String(error)}`)
    }
    const changed = list.bases.length !== this.current.length || list.bases.some((base, i) => base !== this.current[i])
    this.current = list.bases
    if (changed) this.options.onChange(this.bases)
    this.schedule(list.ttl * 1000)
    return true
  }

  private schedule(ms: number): void {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.refresh()
    }, ms)
    this.timer.unref?.()
  }
}
