import type { PhoneCopy } from "./phone-copy"

export const PROTOCOL_VERSION = 1

export type FrameType = "invoke" | "result" | "error" | "event"

export type Frame = {
  v: number
  id: string
  type: FrameType
  method?: string
  params?: unknown
  result?: unknown
  /** `copy`: the message as phone copy (phone-copy.ts), when rudderd wrote it for the phone. Older apps read `message`. */
  error?: { code: string; message: string; copy?: PhoneCopy }
  name?: string
  payload?: unknown
  /** Event frames only: position in the daemon's event log, for `hello {lastEventId}` replay. */
  eventId?: number
  /** message.* events: the previous event id of the same session (0 for its first since the daemon started). */
  prev?: number
  /** Global events naming a session: that session's last message.* event id when this one was published. */
  tip?: number
}

export function parseFrame(raw: string): Frame {
  const value = JSON.parse(raw) as Frame
  if (value.v !== PROTOCOL_VERSION) {
    throw new Error(`unsupported protocol v=${String(value.v)}`)
  }
  if (!value.id || !value.type) {
    throw new Error("frame missing id or type")
  }
  return value
}

export function invokeFrame(id: string, method: string, params?: unknown): Frame {
  return { v: PROTOCOL_VERSION, id, type: "invoke", method, params }
}

export function resultFrame(id: string, result: unknown): Frame {
  return { v: PROTOCOL_VERSION, id, type: "result", result }
}

export function errorFrame(id: string, code: string, message: string, copy?: PhoneCopy): Frame {
  return { v: PROTOCOL_VERSION, id, type: "error", error: { code, message, ...(copy ? { copy } : {}) } }
}

export function eventFrame(name: string, payload: unknown): Frame {
  return { v: PROTOCOL_VERSION, id: crypto.randomUUID(), type: "event", name, payload }
}
