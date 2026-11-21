import { afterEach, describe, expect, test } from "bun:test"
import { FAKE_SPEC } from "./adapter/fake"
import type { AgentAdapter } from "./adapter/types"
import { currentPairingToken, redeemPairing } from "./pair"
import type { PerfSample } from "./perf"
import { PerfHub, type PerfSource } from "./perf-hub"
import { invokeFrame, type Frame } from "./protocol"
import { startServer, type ServerOptions } from "./server"
import { Store } from "./store"

async function waitFor(predicate: () => boolean, timeoutMs = 3000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out")
    await Bun.sleep(5)
  }
}

/** Counts readings; each sample carries its sequence number in `at`. */
function countingSource(): PerfSource & { readings: number } {
  const source = {
    readings: 0,
    async sample() {
      source.readings += 1
      return { at: source.readings } as PerfSample
    },
  }
  return source
}

function fakeSocket() {
  const sent: Frame[] = []
  return { sent, send: (raw: string) => sent.push(JSON.parse(raw) as Frame) }
}

describe("PerfHub", () => {
  const hubs: PerfHub<ReturnType<typeof fakeSocket>>[] = []
  afterEach(() => {
    for (const hub of hubs.splice(0)) hub.stop()
  })
  const make = (source: PerfSource, minIntervalMs = 20) => {
    const hub = new PerfHub<ReturnType<typeof fakeSocket>>(source, { minIntervalMs })
    hubs.push(hub)
    return hub
  }

  test("samples only while someone is subscribed, and only that socket gets them", async () => {
    const source = countingSource()
    const hub = make(source)
    const a = fakeSocket()
    const b = fakeSocket()
    expect(hub.active).toBe(false)
    expect(hub.subscribe(a, 20)).toEqual({ intervalMs: 20 })
    expect(hub.active).toBe(true)
    await waitFor(() => a.sent.length >= 3)
    expect(b.sent).toEqual([])
    expect(a.sent.every((frame) => frame.type === "event" && frame.name === "perf.sample" && frame.eventId === undefined)).toBe(true)
    // Strictly increasing: one reading per tick, nothing sent twice.
    const seq = a.sent.map((frame) => (frame.payload as PerfSample).at)
    expect(seq).toEqual([...seq].sort((x, y) => x - y))
    expect(new Set(seq).size).toBe(seq.length)

    expect(hub.unsubscribe(a)).toEqual({ subscribed: false })
    expect(hub.active).toBe(false)
    const readings = source.readings
    const count = a.sent.length
    await Bun.sleep(80)
    expect(source.readings).toBe(readings)
    expect(a.sent.length).toBe(count)
    // Unsubscribing again is harmless.
    expect(hub.unsubscribe(a)).toEqual({ subscribed: false })
  })

  test("two subscribers share one reading per tick; a slower one gets every other sample", async () => {
    const source = countingSource()
    const hub = make(source)
    const fast = fakeSocket()
    const slow = fakeSocket()
    hub.subscribe(fast, 20)
    hub.subscribe(slow, 40)
    await waitFor(() => fast.sent.length >= 6)
    hub.stop()
    expect(source.readings).toBeLessThanOrEqual(fast.sent.length + 1)
    expect(slow.sent.length).toBeGreaterThanOrEqual(2)
    expect(slow.sent.length).toBeLessThanOrEqual(Math.ceil(fast.sent.length / 2) + 1)
  })

  test("detach (socket closed) stops the sampler when it was the last subscriber", async () => {
    const hub = make(countingSource())
    const a = fakeSocket()
    const b = fakeSocket()
    hub.subscribe(a)
    hub.subscribe(b)
    expect(hub.subscribers).toBe(2)
    hub.detach(a)
    expect(hub.active).toBe(true)
    hub.detach(b)
    expect(hub.subscribers).toBe(0)
    expect(hub.active).toBe(false)
  })

  test("interval: defaults to 2000, clamps to the minimum and to 60 s, rejects non-numbers", () => {
    const hub = new PerfHub<ReturnType<typeof fakeSocket>>(countingSource())
    hubs.push(hub)
    const socket = fakeSocket()
    expect(hub.subscribe(socket, undefined)).toEqual({ intervalMs: 2000 })
    expect(hub.subscribe(socket, 10)).toEqual({ intervalMs: 1000 })
    expect(hub.subscribe(socket, 3_600_000)).toEqual({ intervalMs: 60_000 })
    expect(hub.subscribe(socket, 2500.7)).toEqual({ intervalMs: 2501 })
    expect(() => hub.subscribe(socket, "fast")).toThrow(/intervalMs/)
    expect(hub.subscribers).toBe(1)
  })

  test("a sample that fails is skipped and sampling goes on", async () => {
    let calls = 0
    const hub = make({
      async sample() {
        calls += 1
        if (calls === 1) throw new Error("ps went away")
        return { at: calls } as PerfSample
      },
    })
    const socket = fakeSocket()
    hub.subscribe(socket, 20)
    await waitFor(() => socket.sent.length >= 1)
    expect((socket.sent[0]!.payload as PerfSample).at).toBe(2)
  })
})

describe("perf.* over the websocket", () => {
  let stops: (() => void)[] = []
  afterEach(() => {
    for (const stop of stops) stop()
    stops = []
  })

  function boot(options: Partial<ServerOptions> = {}) {
    const store = options.store ?? new Store(":memory:")
    const started = startServer({ host: "127.0.0.1", port: 0, adapter: idle, ...options, store })
    stops.push(() => started.server.stop(true))
    const key = () => redeemPairing(store, currentPairingToken(store).token, "phone").sessionKey
    return { started, store, port: started.server.port as number, key }
  }

  const idle: AgentAdapter = { spec: FAKE_SPEC, async reply() {} }

  async function connect(port: number, key: string) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`, { headers: { authorization: `Bearer ${key}` } } as never)
    const closed = new Promise<void>((resolve) => ws.addEventListener("close", () => resolve()))
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve())
      ws.addEventListener("error", () => reject(new Error("ws error")))
    })
    const frames: Frame[] = []
    const waiting = new Map<string, (frame: Frame) => void>()
    ws.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as Frame
      frames.push(frame)
      if (frame.type !== "event") waiting.get(frame.id)?.(frame)
    })
    return {
      samples: () => frames.filter((frame) => frame.name === "perf.sample"),
      call(method: string, params: Record<string, unknown> = {}) {
        const id = crypto.randomUUID()
        return new Promise<Frame>((resolve) => {
          waiting.set(id, resolve)
          ws.send(JSON.stringify(invokeFrame(id, method, params)))
        })
      },
      async close() {
        ws.close()
        await closed
      },
    }
  }

  test("subscribe pushes to that socket only; unsubscribe and close stop the sampler", async () => {
    const source = countingSource()
    const { started, port, key } = boot({ perf: { source, minIntervalMs: 20 } })
    const phone = await connect(port, key())
    const other = await connect(port, key())
    await other.call("hello")

    expect((await phone.call("perf.subscribe", { intervalMs: 20 })).result).toEqual({ intervalMs: 20 })
    await waitFor(() => phone.samples().length >= 2)
    expect(other.samples()).toEqual([])
    expect((await phone.call("perf.unsubscribe")).result).toEqual({ subscribed: false })
    expect(started.perf.active).toBe(false)

    await phone.call("perf.subscribe", { intervalMs: 20 })
    expect(started.perf.active).toBe(true)
    await phone.close()
    await waitFor(() => !started.perf.active)
    expect(started.perf.subscribers).toBe(0)

    const bad = await other.call("perf.subscribe", { intervalMs: "soon" })
    expect(bad.type).toBe("error")
    expect(bad.error?.code).toBe("invalid")
    await other.close()
  })

  test("snapshot: one real sample with machine name, rudderd and the agents' processes", async () => {
    // A child of this process stands in for an agent.
    const child = Bun.spawn(["sleep", "30"])
    stops.push(() => child.kill())
    const agent: AgentAdapter = {
      spec: { ...FAKE_SPEC, id: "busy", label: "Busy" },
      async reply() {},
      processes: () => [{ agent: "busy", pid: child.pid, sessionIds: ["s1"], shared: false }],
    }
    const store = new Store(":memory:")
    store.setMeta("machine_name", "Studio")
    const { port, key } = boot({ store, adapter: agent })
    const phone = await connect(port, key())
    const frame = await phone.call("perf.snapshot")
    expect(frame.type).toBe("result")
    const sample = frame.result as PerfSample
    expect(sample.machine.name).toBe("Studio")
    expect(typeof sample.at).toBe("number")
    expect(sample.processes.find((entry) => entry.agent === "busy")).toMatchObject({ label: "Busy", pid: child.pid, sessionIds: ["s1"], processCount: 1 })
    // The agent's process is not counted again under rudderd.
    const self = sample.processes.find((entry) => entry.agent === "rudderd")!
    expect(self.pid).toBe(process.pid)
    expect(phone.samples()).toEqual([])
    await phone.close()
  }, 20_000)
})
