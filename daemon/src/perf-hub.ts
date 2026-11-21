import type { HubSocket } from "./event-hub"
import type { PerfSample } from "./perf"
import { errorFrame, eventFrame, resultFrame, type Frame } from "./protocol"
import { sendGuarded } from "./ws-send"

export type PerfSource = { sample(): Promise<PerfSample> }

export type PerfHubOptions = {
  /** Shortest interval a subscriber may ask for (tests lower it). */
  minIntervalMs?: number
}

export const PERF_DEFAULT_INTERVAL_MS = 2000
export const PERF_MIN_INTERVAL_MS = 1000
export const PERF_MAX_INTERVAL_MS = 60_000

const PERF_METHODS = new Set(["perf.subscribe", "perf.unsubscribe", "perf.snapshot"])

type Subscription = { intervalMs: number; lastSent: number }

/**
 * perf.* for the phone's performance panel. `perf.sample` events go only to the sockets that subscribed, outside the
 * numbered event log (a sample is never replayed). One reading per tick serves every subscriber; nothing is sampled
 * while nobody is subscribed.
 */
export class PerfHub<S extends HubSocket = HubSocket> {
  private readonly subs = new Map<S, Subscription>()
  private readonly minIntervalMs: number
  private timer: ReturnType<typeof setTimeout> | null = null
  private timerInterval = 0
  private ticking = false

  constructor(
    private readonly source: PerfSource,
    options: PerfHubOptions = {},
  ) {
    this.minIntervalMs = options.minIntervalMs ?? PERF_MIN_INTERVAL_MS
  }

  /** A timer is pending or a reading is in flight. */
  get active(): boolean {
    return this.timer !== null || this.ticking
  }

  get subscribers(): number {
    return this.subs.size
  }

  /** Subscribes `socket`, or changes its interval. The first sample follows one interval later (use snapshot first). */
  subscribe(socket: S, intervalMs?: unknown): { intervalMs: number } {
    const interval = this.interval(intervalMs)
    this.subs.set(socket, { intervalMs: interval, lastSent: Date.now() })
    if (this.timer && interval < this.timerInterval) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.schedule(interval)
    return { intervalMs: interval }
  }

  unsubscribe(socket: S): { subscribed: false } {
    this.detach(socket)
    return { subscribed: false }
  }

  /** The socket closed. */
  detach(socket: S) {
    this.subs.delete(socket)
    if (this.subs.size === 0) this.stop()
  }

  snapshot(): Promise<PerfSample> {
    return this.source.sample()
  }

  static handles(method: string): boolean {
    return PERF_METHODS.has(method)
  }

  /** Answers one of PERF_METHODS for `socket`. */
  async invoke(socket: S, method: string, params: Record<string, unknown>, id: string): Promise<Frame> {
    try {
      if (method === "perf.subscribe") return resultFrame(id, this.subscribe(socket, params.intervalMs))
      if (method === "perf.unsubscribe") return resultFrame(id, this.unsubscribe(socket))
      if (method === "perf.snapshot") return resultFrame(id, await this.snapshot())
      throw Object.assign(new Error(`unknown method ${method}`), { code: "unknown_method" })
    } catch (error) {
      const code = (error as { code?: string }).code ?? "failed"
      return errorFrame(id, code, error instanceof Error ? error.message : String(error))
    }
  }

  stop() {
    this.subs.clear()
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private interval(value: unknown): number {
    if (value === undefined || value === null) return Math.max(PERF_DEFAULT_INTERVAL_MS, this.minIntervalMs)
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw Object.assign(new Error("intervalMs must be a number of milliseconds"), { code: "invalid" })
    }
    return Math.min(PERF_MAX_INTERVAL_MS, Math.max(this.minIntervalMs, Math.round(value)))
  }

  private schedule(delay: number) {
    if (this.timer || this.ticking || this.subs.size === 0) return
    this.timerInterval = this.shortest()
    this.timer = setTimeout(() => void this.tick(), Math.max(0, delay))
    this.timer.unref?.()
  }

  private shortest(): number {
    let shortest = PERF_MAX_INTERVAL_MS
    for (const sub of this.subs.values()) shortest = Math.min(shortest, sub.intervalMs)
    return shortest
  }

  private async tick() {
    this.timer = null
    if (this.subs.size === 0) return
    const started = Date.now()
    this.ticking = true
    let raw: string | undefined
    try {
      raw = JSON.stringify(eventFrame("perf.sample", await this.source.sample()))
    } catch (error) {
      console.warn("rudderd: perf sample failed:", error instanceof Error ? error.message : error)
    } finally {
      this.ticking = false
    }
    const now = Date.now()
    if (raw) {
      for (const [socket, sub] of this.subs) {
        // A tenth of slack, so a 4 s subscriber on a 2 s tick gets every other sample rather than every third.
        if (now - sub.lastSent < sub.intervalMs * 0.9) continue
        sub.lastSent = now
        try {
          sendGuarded(socket, raw)
        } catch {
          // closing; detach follows
        }
      }
    }
    // The next tick is one interval after this one started, so sampling time does not stretch the period.
    this.schedule(this.shortest() - (Date.now() - started))
  }
}
