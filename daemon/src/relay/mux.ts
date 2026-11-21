/** The daemon ↔ relay multiplexing frame (the relay design notes): `type(1) ‖ connId(4, BE) ‖ payload`. */
export const MuxType = { open: 0x01, data: 0x02, close: 0x03, busy: 0x04 } as const
export type MuxTypeName = keyof typeof MuxType

export type MuxFrame = { type: MuxTypeName; connId: number; payload: Buffer }

export type OpenInfo = { deviceId: string; tier: "pro" | "free"; limits: { bytes: number | null; seconds: number | null } }

/** Close codes on the inner channel and the phone's socket. */
export const RelayClose = {
  normal: 1000,
  protocol: 4000,
  revoked: 4001,
  handshake: 4003,
  freeLimit: 4402,
  offline: 4404,
  full: 4429,
  daemonGone: 4502,
  /** The daemon's outgoing buffer is full; the phone reconnects and resumes from its cursor; direct sockets use ws-send.ts BACKPRESSURE_CLOSE. */
  backpressure: 4013,
} as const

const HEADER = 5
const NAMES = new Map<number, MuxTypeName>(Object.entries(MuxType).map(([name, value]) => [value, name as MuxTypeName]))

export function encodeMux(type: MuxTypeName, connId: number, payload: Uint8Array = new Uint8Array()): Buffer {
  const frame = Buffer.alloc(HEADER + payload.byteLength)
  frame[0] = MuxType[type]
  frame.writeUInt32BE(connId >>> 0, 1)
  frame.set(payload, HEADER)
  return frame
}

export function decodeMux(raw: Uint8Array): MuxFrame {
  if (raw.byteLength < HEADER) throw new Error(`mux frame of ${raw.byteLength} bytes is shorter than its header`)
  const bytes = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
  const type = NAMES.get(bytes[0]!)
  if (!type) throw new Error(`unknown mux type ${bytes[0]}`)
  return { type, connId: bytes.readUInt32BE(1), payload: bytes.subarray(HEADER) }
}

export function closePayload(code: number, reason = ""): Buffer {
  const text = Buffer.from(reason, "utf8").subarray(0, 123)
  const payload = Buffer.alloc(2 + text.byteLength)
  payload.writeUInt16BE(code, 0)
  payload.set(text, 2)
  return payload
}

export function parseClose(payload: Buffer): { code: number; reason: string } {
  if (payload.byteLength < 2) return { code: RelayClose.protocol, reason: "" }
  return { code: payload.readUInt16BE(0), reason: payload.subarray(2).toString("utf8") }
}

export function parseOpen(payload: Buffer): OpenInfo {
  const value = JSON.parse(payload.toString("utf8")) as Partial<OpenInfo>
  if (typeof value.deviceId !== "string") throw new Error("OPEN without deviceId")
  const tier = value.tier === "pro" ? "pro" : "free"
  const limits = value.limits ?? { bytes: null, seconds: null }
  return { deviceId: value.deviceId, tier, limits: { bytes: limits.bytes ?? null, seconds: limits.seconds ?? null } }
}
