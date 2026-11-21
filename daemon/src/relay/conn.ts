import { randomBytes } from "node:crypto"
import { SecureChannel } from "./frame"
import { closePayload, encodeMux, type OpenInfo, RelayClose } from "./mux"
import { NoiseHandshake, pairingPsk, relayPrologue, relayPsk } from "./noise"

/**
 * After msg2 the phone must show it holds the session keys (a transport message that decrypts) within this long.
 * msg1 carries no timestamp, so a recorded one replays to a valid msg2; only the real phone can follow it up.
 */
export const CONFIRM_MS = 15_000

/** Fields the server reads from any client socket, direct or relayed. */
export type ClientData = {
  /** The device's session key; empty on a relay pairing connection. */
  key: string
  via: "direct" | "relay"
  /** Relay tier from the access token; null on a direct socket. */
  tier: "pro" | "free" | null
  /** A relay connection keyed with the pairing token: only `pair.redeem` is allowed. */
  pairing: boolean
  /** A direct socket whose phone sent `X-Rudder-Chunks: 1`: large frames go as binary chunks (`ws-send.ts`). */
  chunked?: boolean
}

/** What a relay connection needs from the server. */
export type RelayConnHost = {
  /** The session key of a paired device, or null when it is unknown or revoked. */
  deviceKey(deviceId: string): string | null
  /** The pairing token the QR code carries right now, or null. */
  pairingToken(): string | null
  /** The phone proved its keys (its first transport message decrypted): the connection now sends and receives app frames. */
  ready(conn: RelayConn): void
  text(conn: RelayConn, raw: string): void
  /** Called once, only for a connection that reached `ready`. */
  closed(conn: RelayConn): void
  log?(line: string): void
}

/**
 * One phone behind the relay: a virtual socket with the same `send` / `close` / `data` a Bun WebSocket has, so the
 * event and perf hubs treat it like any other. Everything it sends leaves as Noise ciphertext.
 */
export class RelayConn {
  readonly data: ClientData
  private handshake: NoiseHandshake | null = null
  private channel: SecureChannel | null = null
  /** The phone's first transport message decrypted; until then this is a handshake anyone could have replayed. */
  private confirmed = false
  private confirmTimer: ReturnType<typeof setTimeout> | null = null
  private finished = false
  /** No paired device has this id: the handshake runs on a throwaway key and always fails. */
  private readonly unknownDevice: boolean
  /** The pairing token a pairing connection's handshake was keyed with; null for a device connection. */
  readonly pairingToken: string | null

  constructor(
    readonly connId: number,
    readonly info: OpenInfo,
    slotId: string,
    /** False when the link refused a data frame because its send buffer is full. */
    private readonly out: (frame: Buffer) => boolean,
    private readonly host: RelayConnHost,
  ) {
    const pairing = info.deviceId === ""
    const key = pairing ? "" : (host.deviceKey(info.deviceId) ?? "")
    this.data = { key, via: "relay", tier: info.tier, pairing }
    // An unknown or revoked device id must look exactly like a wrong key (same 4003, after the phone's first message),
    // or any relay token holder could ask the slot which device ids are paired. A device revoked while connected still
    // gets 4001: that phone has already proved its key.
    this.unknownDevice = !pairing && !key
    const token = pairing ? host.pairingToken() : null
    this.pairingToken = token
    if (pairing && !token) {
      this.close(RelayClose.handshake, "no pairing token")
      return
    }
    try {
      this.handshake = new NoiseHandshake("responder", {
        psk: pairing ? pairingPsk(token!) : relayPsk(this.unknownDevice ? randomBytes(32).toString("hex") : key),
        prologue: relayPrologue(slotId, info.deviceId),
      })
    } catch (error) {
      this.close(RelayClose.handshake, String(error))
    }
  }

  get isReady(): boolean {
    return this.channel !== null && this.confirmed && !this.finished
  }

  get isClosed(): boolean {
    return this.finished
  }

  /** One DATA payload from the relay: the handshake's first message, then transport messages. */
  receive(message: Buffer): void {
    if (this.finished) return
    if (!this.channel) {
      const handshake = this.handshake
      if (!handshake) return
      try {
        handshake.readMessage(message)
        if (this.unknownDevice) throw new Error("unknown device")
        const reply = handshake.writeMessage()
        const { send, receive } = handshake.split()
        this.handshake = null
        if (this.out(encodeMux("data", this.connId, reply)) === false) throw new Error("send buffer full")
        this.channel = new SecureChannel(send, receive)
      } catch {
        this.close(RelayClose.handshake, "handshake failed")
        return
      }
      // A replayed msg1 gets this far too (audit P3). The phone always speaks first (hello / pair.redeem), so the
      // connection is attached only once that first message proves the phone holds the keys.
      this.confirmTimer = setTimeout(() => this.close(RelayClose.handshake, "handshake not confirmed"), CONFIRM_MS)
      return
    }
    let frame: Buffer | null
    try {
      frame = this.channel.open(message)
    } catch {
      this.close(RelayClose.protocol, "bad message")
      return
    }
    if (!this.confirmed) {
      this.confirmed = true
      if (this.confirmTimer) clearTimeout(this.confirmTimer)
      this.confirmTimer = null
      this.host.ready(this)
    }
    if (frame) this.host.text(this, frame.toString("utf8"))
  }

  send(raw: string): number {
    if (!this.isReady) return 0
    let sent = 0
    for (const message of this.channel!.seal(raw)) {
      // A skipped message breaks the Noise nonce sequence and the event order, so this phone starts over instead.
      if (this.out(encodeMux("data", this.connId, message)) === false) {
        this.close(RelayClose.backpressure, "send buffer full")
        return 0
      }
      sent += message.byteLength
    }
    return sent
  }

  /** Closes this phone's connection; the relay closes the phone's socket with `code`. */
  close(code: number = RelayClose.normal, reason = ""): void {
    if (this.finished) return
    this.out(encodeMux("close", this.connId, closePayload(code, reason)))
    this.end()
  }

  /** The relay closed it (the phone left, a limit, or the daemon link dropped). */
  remoteClosed(): void {
    if (this.finished) return
    this.end()
  }

  private end(): void {
    const wasReady = this.confirmed
    if (this.confirmTimer) clearTimeout(this.confirmTimer)
    this.confirmTimer = null
    this.finished = true
    this.channel = null
    this.handshake = null
    if (wasReady) this.host.closed(this)
  }
}
