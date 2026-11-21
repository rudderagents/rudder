import { RelayConn, type RelayConnHost } from "./conn"
import type { RelayIdentity } from "./identity"
import { closePayload, decodeMux, encodeMux, MuxType, parseOpen, RelayClose } from "./mux"

export type RelayLinkState = "connecting" | "connected" | "waiting" | "stopped"

export type RelayLinkOptions = {
  /** `wss://relay.example` (no path); `/v1/daemon?slot=` is appended. */
  base: string
  identity: RelayIdentity
  host: RelayConnHost
  minBackoffMs?: number
  maxBackoffMs?: number
  pingIntervalMs?: number
  /** Silence (no pong, no message) after which the link counts as dead. Defaults to 2 × ping interval + 5 s. */
  silenceMs?: number
  /** Opens the socket. Tests pass a fake; the default is Bun's client `WebSocket`. */
  openSocket?: (url: string, headers: Record<string, string>) => WebSocket
  /** Bytes the relay socket may have queued before a phone's data frame is refused and that phone is closed. */
  maxBufferedBytes?: number
  onState?: (state: RelayLinkState) => void
  log?: (line: string) => void
}

/**
 * The outbound connection to one relay (the relay design notes): signed with this computer's key, kept up
 * with backoff (1 s doubling to 60 s, plus up to 30 % jitter) and a protocol ping every 30 s, demultiplexing phones.
 * A link that hears nothing (no pong, no frame) for `silenceMs` is dropped and redialed with the same backoff: a
 * half-open TCP path (NAT timeout, Wi-Fi switch) never fires close on its own. Bun's client socket emits `pong`, and
 * both relays answer protocol pings (Cloudflare's runtime, `Bun.serve` on relay-node).
 */
export class RelayLink {
  private socket: WebSocket | null = null
  private readonly conns = new Map<number, RelayConn>()
  private backoffMs: number
  private retry: ReturnType<typeof setTimeout> | null = null
  private pinger: ReturnType<typeof setInterval> | null = null
  private current: RelayLinkState = "stopped"
  private readonly minBackoffMs: number
  private readonly maxBackoffMs: number
  private readonly pingIntervalMs: number
  private readonly silenceMs: number
  private lastHeard = 0
  private lastPing = 0
  private readonly maxBufferedBytes: number

  constructor(private readonly options: RelayLinkOptions) {
    this.minBackoffMs = options.minBackoffMs ?? 1000
    this.maxBackoffMs = options.maxBackoffMs ?? 60_000
    this.pingIntervalMs = options.pingIntervalMs ?? 30_000
    this.silenceMs = options.silenceMs ?? 2 * this.pingIntervalMs + 5000
    this.maxBufferedBytes = options.maxBufferedBytes ?? 8 * 1024 * 1024
    this.backoffMs = this.minBackoffMs
  }

  get state(): RelayLinkState {
    return this.current
  }

  get base(): string {
    return this.options.base
  }

  /** Phones currently connected through this relay. */
  get connections(): RelayConn[] {
    return [...this.conns.values()]
  }

  start(): void {
    if (this.current !== "stopped") return
    this.connect()
  }

  stop(): void {
    this.setState("stopped")
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    this.dropConnections()
    const socket = this.socket
    this.socket = null
    socket?.close(1000, "daemon stopping")
    this.stopPinger()
  }

  /** Revocation: every relayed connection of that device closes with 4001, as its direct sockets do. */
  closeDevice(key: string): void {
    for (const conn of this.conns.values()) if (conn.data.key === key) conn.close(RelayClose.revoked, "device revoked")
  }

  private url(): string {
    const base = this.options.base.replace(/\/+$/, "")
    return `${base}/v1/daemon?slot=${this.options.identity.slotId}`
  }

  private connect(): void {
    this.setState("connecting")
    let socket: WebSocket
    try {
      const headers = this.options.identity.sign(new URL(this.url()).host)
      socket = this.options.openSocket
        ? this.options.openSocket(this.url(), headers)
        : new WebSocket(this.url(), { headers } as never)
    } catch (error) {
      this.options.log?.(`relay ${this.options.base}: ${String(error)}`)
      this.scheduleRetry()
      return
    }
    socket.binaryType = "arraybuffer"
    this.socket = socket
    socket.addEventListener("open", () => {
      if (socket !== this.socket) return
      this.lastPing = Date.now()
      this.setState("connected")
      this.lastHeard = Date.now()
      // Check silence at least every 5 s so a dead link is noticed within a few seconds of the deadline.
      this.pinger = setInterval(() => this.tick(socket), Math.min(this.pingIntervalMs, 5000))
      this.pinger.unref?.()
    })
    socket.addEventListener("pong" as never, () => {
      if (socket === this.socket) this.heard()
    })
    socket.addEventListener("message", (event) => {
      if (socket !== this.socket) return
      this.heard()
      this.handle(event.data)
    })
    socket.addEventListener("close", (event) => {
      if (socket !== this.socket) return
      this.socket = null
      this.stopPinger()
      this.dropConnections()
      if (this.current === "stopped") return
      this.options.log?.(`relay ${this.options.base}: closed (${event.code}${event.reason ? ` ${event.reason}` : ""})`)
      this.scheduleRetry()
    })
    // A failed upgrade (401, DNS, TLS) also fires close; the error event adds nothing.
    socket.addEventListener("error", () => {})
  }

  /** The relay answered: the link works, so the next drop starts the backoff over. An open alone does not count —
   *  a relay that accepts and then stays silent would otherwise be redialed every silence window forever. */
  private heard(): void {
    this.lastHeard = Date.now()
    this.backoffMs = this.minBackoffMs
  }

  private tick(socket: WebSocket): void {
    if (socket !== this.socket) return
    const now = Date.now()
    if (now - this.lastHeard > this.silenceMs) {
      this.options.log?.(`relay ${this.options.base}: silent for ${now - this.lastHeard} ms, reconnecting`)
      // Detach first: a dead peer may never finish the close handshake, so close may not fire for minutes.
      this.socket = null
      this.stopPinger()
      this.dropConnections()
      try {
        socket.close(4000, "relay silent")
      } catch {}
      this.scheduleRetry()
      return
    }
    if (now - this.lastPing >= this.pingIntervalMs) {
      this.lastPing = now
      socket.ping()
    }
  }

  private handle(data: unknown): void {
    if (!(data instanceof ArrayBuffer)) return
    let frame: ReturnType<typeof decodeMux>
    try {
      frame = decodeMux(new Uint8Array(data))
    } catch (error) {
      this.options.log?.(`relay ${this.options.base}: ${String(error)}`)
      return
    }
    switch (frame.type) {
      case "open": {
        this.conns.get(frame.connId)?.remoteClosed()
        let info: ReturnType<typeof parseOpen>
        try {
          info = parseOpen(frame.payload)
        } catch {
          this.sendRaw(encodeMux("close", frame.connId, closePayload(RelayClose.protocol, "bad open")))
          return
        }
        const conn = new RelayConn(frame.connId, info, this.options.identity.slotId, (out) => this.sendRaw(out), this.options.host)
        if (!conn.isClosed) this.conns.set(frame.connId, conn)
        return
      }
      case "data": {
        const conn = this.conns.get(frame.connId)
        conn?.receive(frame.payload)
        if (conn?.isClosed) this.conns.delete(frame.connId)
        return
      }
      case "close": {
        this.conns.get(frame.connId)?.remoteClosed()
        this.conns.delete(frame.connId)
        return
      }
      case "busy":
        // The relay closes it next; the app reconnects with its cursor.
        this.options.log?.(`relay ${this.options.base}: connection ${frame.connId} hit its tier limit (${frame.payload.toString("utf8")})`)
        return
    }
  }

  /** False only for a data frame refused because the relay socket is too far behind; close frames always go. */
  private sendRaw(frame: Buffer): boolean {
    if (frame.byteLength === 0) return true
    const socket = this.socket
    const isClose = frame[0] === MuxType.close
    if (!isClose && socket && socket.bufferedAmount > this.maxBufferedBytes) return false
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(frame)
    // A close leaves the map here, whoever started it.
    if (isClose) this.conns.delete(frame.readUInt32BE(1))
    return true
  }

  private dropConnections(): void {
    const conns = [...this.conns.values()]
    this.conns.clear()
    for (const conn of conns) conn.remoteClosed()
  }

  private scheduleRetry(): void {
    if (this.current === "stopped") return
    this.setState("waiting")
    const delay = this.backoffMs * (1 + Math.random() * 0.3)
    this.backoffMs = Math.min(this.maxBackoffMs, this.backoffMs * 2)
    this.retry = setTimeout(() => {
      this.retry = null
      if (this.current !== "stopped") this.connect()
    }, delay)
    this.retry.unref?.()
  }

  private stopPinger(): void {
    if (this.pinger) clearInterval(this.pinger)
    this.pinger = null
  }

  private setState(state: RelayLinkState): void {
    if (this.current === state) return
    this.current = state
    this.options.onState?.(state)
  }
}
