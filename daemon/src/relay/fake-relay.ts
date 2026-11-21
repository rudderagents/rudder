import { verify } from "node:crypto"
import type { Server, ServerWebSocket } from "bun"
import { SecureChannel } from "./frame"
import { signedMessageV2, slotIdFor } from "./identity"
import { closePayload, decodeMux, encodeMux, parseClose } from "./mux"
import { NoiseHandshake, pairingPsk, relayPrologue, relayPsk } from "./noise"

/**
 * Test support only: a Bun relay with the multiplexing and close-code rules of the relay design notes (the
 * Cloudflare one lives in relay/), and a phone that speaks Noise through it. Tokens are skipped: the phone names its
 * tier in the query. Every byte the relay forwards is kept in `seen`, so tests can prove it never held plaintext.
 */

type Peer = { role: "daemon"; slot: string } | { role: "phone"; slot: string; connId: number; deviceId: string; tier: string }

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex")

export type FakeRelay = {
  url: string
  server: Server<Peer>
  seen: Buffer[]
  daemonConnects: number
  /** Drops the daemon's connection (a relay deploy); phones go with it. */
  dropDaemon(slot: string): void
  stop(): void
}

export function startFakeRelay(): FakeRelay {
  const daemons = new Map<string, ServerWebSocket<Peer>>()
  const phones = new Map<number, ServerWebSocket<Peer>>()
  let nextConn = 1
  const relay = {
    seen: [] as Buffer[],
    daemonConnects: 0,
  }
  const server = Bun.serve<Peer, never>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, serverRef) {
      const url = new URL(request.url)
      const slot = url.searchParams.get("slot") ?? ""
      if (url.pathname === "/v1/daemon") {
        const key = Buffer.from(request.headers.get("x-rudder-key") ?? "", "base64url")
        const time = Number(request.headers.get("x-rudder-time"))
        // v2 only, as the deployed relays: the signature names this relay's host.
        const signature = Buffer.from(request.headers.get("x-rudder-signature-2") ?? "", "base64url")
        const fresh = Math.abs(time - Date.now() / 1000) <= 60
        const valid =
          key.byteLength === 32 &&
          slotIdFor(key) === slot &&
          fresh &&
          verify(null, signedMessageV2(url.host, slot, time), { key: Buffer.concat([ED25519_SPKI_PREFIX, key]), format: "der", type: "spki" }, signature)
        if (!valid) return new Response("unauthorized", { status: 401 })
        return serverRef.upgrade(request, { data: { role: "daemon", slot } }) ? undefined : new Response("no", { status: 500 })
      }
      if (url.pathname === "/v1/phone") {
        const data: Peer = {
          role: "phone",
          slot,
          connId: nextConn++,
          deviceId: url.searchParams.get("device") ?? "",
          tier: url.searchParams.get("tier") ?? "pro",
        }
        return serverRef.upgrade(request, { data }) ? undefined : new Response("no", { status: 500 })
      }
      return new Response("not found", { status: 404 })
    },
    websocket: {
      open(ws) {
        const peer = ws.data
        if (peer.role === "daemon") {
          relay.daemonConnects += 1
          const old = daemons.get(peer.slot)
          daemons.set(peer.slot, ws)
          if (old) {
            old.close(4502, "replaced")
            closePhones(peer.slot)
          }
          return
        }
        const daemon = daemons.get(peer.slot)
        if (!daemon) {
          ws.close(4404, "computer offline")
          return
        }
        phones.set(peer.connId, ws)
        const limits = peer.tier === "free" ? { bytes: 262_144, seconds: 600 } : { bytes: null, seconds: null }
        daemon.send(encodeMux("open", peer.connId, Buffer.from(JSON.stringify({ deviceId: peer.deviceId, tier: peer.tier, limits }))))
      },
      message(ws, message) {
        const bytes = typeof message === "string" ? Buffer.from(message) : Buffer.from(message)
        relay.seen.push(bytes)
        const peer = ws.data
        if (peer.role === "phone") {
          daemons.get(peer.slot)?.send(encodeMux("data", peer.connId, bytes))
          return
        }
        const frame = decodeMux(bytes)
        const phone = phones.get(frame.connId)
        if (!phone) return
        if (frame.type === "data") phone.send(frame.payload)
        if (frame.type === "close") {
          const { code, reason } = parseClose(frame.payload)
          phones.delete(frame.connId)
          phone.close(code, reason)
        }
      },
      close(ws) {
        const peer = ws.data
        if (peer.role === "phone") {
          if (phones.delete(peer.connId)) daemons.get(peer.slot)?.send(encodeMux("close", peer.connId, closePayload(1000)))
          return
        }
        if (daemons.get(peer.slot) === ws) {
          daemons.delete(peer.slot)
          closePhones(peer.slot)
        }
      },
    },
  })

  function closePhones(slot: string) {
    for (const [connId, phone] of phones) {
      if (phone.data.slot !== slot) continue
      phones.delete(connId)
      phone.close(4502, "computer disconnected")
    }
  }

  return {
    get seen() {
      return relay.seen
    },
    get daemonConnects() {
      return relay.daemonConnects
    },
    url: `ws://127.0.0.1:${server.port}`,
    server,
    dropDaemon(slot: string) {
      const daemon = daemons.get(slot)
      daemons.delete(slot)
      closePhones(slot)
      daemon?.close(4502, "relay restarting")
    },
    stop() {
      server.stop(true)
    },
  }
}

export type RelayPhone = {
  /** Resolves when the handshake is done. */
  ready: Promise<void>
  closed: Promise<{ code: number; reason: string }>
  events: Record<string, unknown>[]
  call(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>
  nextEvent(predicate: (frame: Record<string, unknown>) => boolean): Promise<Record<string, unknown>>
  /** Raw Noise message, for tampering tests. */
  sendRaw(bytes: Buffer): void
  close(): void
}

/** Under bun's 5 s test limit, so a hung wait fails with the step it hung on instead of a bare timeout. */
const PHONE_WAIT_MS = 4000

function deadline<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`relay phone: no ${label} within ${PHONE_WAIT_MS} ms`)), PHONE_WAIT_MS)
  })
  return Promise.race([promise, late]).finally(() => clearTimeout(timer))
}

/** A phone behind the relay. `sessionKey` null pairs with `pairingToken`; `deviceId` "" is a pairing connection. */
export function relayPhone(options: {
  relayUrl: string
  slotId: string
  deviceId: string
  sessionKey?: string
  pairingToken?: string
  tier?: "pro" | "free"
}): RelayPhone {
  const query = new URLSearchParams({ slot: options.slotId, device: options.deviceId, tier: options.tier ?? "pro" })
  const ws = new WebSocket(`${options.relayUrl}/v1/phone?${query}`)
  ws.binaryType = "arraybuffer"
  const psk = options.sessionKey ? relayPsk(options.sessionKey) : pairingPsk(options.pairingToken ?? "")
  const handshake = new NoiseHandshake("initiator", { psk, prologue: relayPrologue(options.slotId, options.deviceId) })
  let channel: SecureChannel | null = null
  const events: Record<string, unknown>[] = []
  const waiting = new Map<string, (frame: Record<string, unknown>) => void>()
  const watchers: { predicate: (frame: Record<string, unknown>) => boolean; resolve: (frame: Record<string, unknown>) => void }[] = []
  let markReady: () => void = () => {}
  let failReady: (error: Error) => void = () => {}
  const ready = deadline(
    new Promise<void>((resolve, reject) => {
      markReady = resolve
      failReady = reject
    }),
    "handshake",
  )
  const closing = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.addEventListener("close", (event) => {
      failReady(new Error(`closed ${event.code} before the handshake`))
      resolve({ code: event.code, reason: event.reason })
    })
  })
  ready.catch(() => {})
  ws.addEventListener("open", () => ws.send(handshake.writeMessage()))
  ws.addEventListener("message", (event) => {
    const bytes = Buffer.from(event.data as ArrayBuffer)
    if (!channel) {
      handshake.readMessage(bytes)
      const split = handshake.split()
      channel = new SecureChannel(split.send, split.receive)
      markReady()
      return
    }
    const frame = channel.open(bytes)
    if (!frame) return
    const parsed = JSON.parse(frame.toString("utf8")) as Record<string, unknown>
    const id = String(parsed.id ?? "")
    const resolve = waiting.get(id)
    if (resolve && (parsed.type === "result" || parsed.type === "error")) {
      waiting.delete(id)
      resolve(parsed)
      return
    }
    events.push(parsed)
    for (const [index, watcher] of watchers.entries()) {
      if (!watcher.predicate(parsed)) continue
      watchers.splice(index, 1)
      watcher.resolve(parsed)
      break
    }
  })
  let counter = 0
  return {
    ready,
    // Read lazily: the deadline starts when a test waits for the close, not when the phone connects.
    get closed() {
      return deadline(closing, "close")
    },
    events,
    call(method, params = {}) {
      const id = `r${++counter}`
      return deadline(
        new Promise((resolve) => {
          waiting.set(id, resolve)
          for (const message of channel!.seal(JSON.stringify({ v: 1, id, type: "invoke", method, params }))) ws.send(message)
        }),
        `reply to ${method}`,
      )
    },
    nextEvent(predicate) {
      const found = events.find(predicate)
      if (found) return Promise.resolve(found)
      return deadline(new Promise((resolve) => watchers.push({ predicate, resolve })), "matching event")
    },
    sendRaw(bytes) {
      ws.send(bytes)
    },
    close() {
      ws.close(1000)
    },
  }
}
