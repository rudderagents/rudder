import { describe, expect, test } from "bun:test"
import type { RelayConnHost } from "./conn"
import type { RelayIdentity } from "./identity"
import { RelayLink, type RelayLinkState } from "./link"

/** A socket that opens and then hears nothing unless the test says so: the half-open path a NAT leaves behind. */
class SilentSocket extends EventTarget {
  readyState: number = WebSocket.CONNECTING
  binaryType = "arraybuffer"
  pings = 0
  closed: { code?: number; reason?: string } | null = null
  constructor(readonly answersPing: boolean) {
    super()
    queueMicrotask(() => {
      this.readyState = WebSocket.OPEN
      this.dispatchEvent(new Event("open"))
    })
  }
  ping() {
    this.pings += 1
    if (this.answersPing) queueMicrotask(() => this.dispatchEvent(new Event("pong")))
  }
  send() {}
  close(code?: number, reason?: string) {
    // A dead peer never answers the close handshake, so no close event fires.
    this.closed = { code, reason }
    this.readyState = WebSocket.CLOSING
  }
}

const identity = { slotId: "slot", sign: () => ({}) } as unknown as RelayIdentity
const host = {} as RelayConnHost

function link(answersPing: boolean, sockets: SilentSocket[], states: RelayLinkState[], maxBackoffMs = 10) {
  return new RelayLink({
    base: "wss://relay.test",
    identity,
    host,
    pingIntervalMs: 40,
    silenceMs: 400,
    minBackoffMs: 10,
    maxBackoffMs,
    openSocket: () => {
      const socket = new SilentSocket(answersPing)
      sockets.push(socket)
      return socket as unknown as WebSocket
    },
    onState: (state) => states.push(state),
  })
}

describe("relay link liveness", () => {
  test("a link that hears no pong is closed and redialed", async () => {
    const sockets: SilentSocket[] = []
    const states: RelayLinkState[] = []
    const relay = link(false, sockets, states)
    relay.start()
    await Bun.sleep(1000)
    relay.stop()
    expect(sockets.length).toBeGreaterThanOrEqual(2)
    expect(sockets[0]?.pings).toBeGreaterThan(0)
    expect(sockets[0]?.closed).toEqual({ code: 4000, reason: "relay silent" })
    expect(states.slice(0, 4)).toEqual(["connecting", "connected", "waiting", "connecting"])
  })

  test("pongs keep the link up", async () => {
    const sockets: SilentSocket[] = []
    const states: RelayLinkState[] = []
    const relay = link(true, sockets, states)
    relay.start()
    await Bun.sleep(700)
    expect(sockets.length).toBe(1)
    expect(sockets[0]?.closed).toBeNull()
    expect(relay.state).toBe("connected")
    relay.stop()
  })

  test("any inbound frame counts as heard", async () => {
    const sockets: SilentSocket[] = []
    const relay = link(false, sockets, [])
    relay.start()
    const feed = setInterval(() => {
      sockets[0]?.dispatchEvent(new MessageEvent("message", { data: "noise" }))
    }, 15)
    await Bun.sleep(700)
    clearInterval(feed)
    expect(sockets.length).toBe(1)
    expect(sockets[0]?.closed).toBeNull()
    relay.stop()
  })

  test("a relay that accepts and stays silent keeps backing off", async () => {
    const sockets: SilentSocket[] = []
    const relay = link(false, sockets, [], 10_000)
    relay.start()
    await Bun.sleep(1200)
    relay.stop()
    expect(sockets.length).toBeGreaterThanOrEqual(2)
    expect((relay as unknown as { backoffMs: number }).backoffMs).toBeGreaterThan(20)
  })

  test("an answered link starts the backoff over", async () => {
    const sockets: SilentSocket[] = []
    const relay = link(true, sockets, [], 10_000)
    relay.start()
    await Bun.sleep(200)
    relay.stop()
    expect((relay as unknown as { backoffMs: number }).backoffMs).toBe(10)
  })
})
