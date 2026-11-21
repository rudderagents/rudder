import { CHUNK_BYTES, chunkFrame, MAX_FRAME_BYTES } from "./relay/frame"

/** Close code for a phone socket that cannot keep up: the phone reconnects and catches up by replay. */
export const BACKPRESSURE_CLOSE = 1013
/** A socket whose unsent bytes pass this is closed instead of being fed more. */
export const MAX_BUFFERED_BYTES = 8 * 1024 * 1024

/** Bun's `ServerWebSocket` (and the relay's per-phone connection) as far as sending goes. */
export type GuardedSocket = {
  send(raw: string): unknown
  /** Bun's `ServerWebSocket`; a relayed connection has none (Noise already chunks its frames). */
  sendBinary?(data: Uint8Array): unknown
  close?(code?: number, reason?: string): void
  getBufferedAmount?(): number
  /** `chunked`: the phone sent `X-Rudder-Chunks: 1` when it opened the socket. */
  readonly data?: { readonly chunked?: boolean }
}

const backlogged = new WeakMap<object, number>()
const closing = new WeakSet<object>()

/**
 * Sends one frame to a phone and checks Bun's answer: 0 means the frame was dropped, so the socket is closed and the
 * phone reconnects and replays from its last event; -1 means it was queued under backpressure, which is counted, and
 * past `MAX_BUFFERED_BYTES` buffered the socket is closed too. Returns false when the socket was closed.
 *
 * A frame past `CHUNK_BYTES` to a direct socket that asked for chunks leaves as binary messages in the relay's inner
 * framing (flag byte, FIN on the last), unencrypted. The phone's URLSession hands over only whole messages, so one
 * large frame on a slow link would otherwise show no progress for longer than its pong timeout: the pong is queued
 * behind it, and the phone drops a live link mid-transfer.
 */
export function sendGuarded(socket: GuardedSocket, raw: string): boolean {
  if (closing.has(socket)) return false
  let queued = false
  for (const message of messagesFor(socket, raw)) {
    const status = typeof message === "string" ? socket.send(message) : socket.sendBinary?.(message)
    if (status === 0) return shut(socket, "a frame was dropped")
    if (status === -1) {
      if (!queued) backlogged.set(socket, (backlogged.get(socket) ?? 0) + 1)
      queued = true
      const buffered = socket.getBufferedAmount?.() ?? 0
      if (buffered > MAX_BUFFERED_BYTES) return shut(socket, `${buffered} bytes waiting to be sent`)
    }
  }
  return true
}

function messagesFor(socket: GuardedSocket, raw: string): Array<string | Uint8Array> {
  // UTF-8 is at most 3 bytes per UTF-16 unit: a string this short fits one chunk without measuring it.
  if (!socket.data?.chunked || !socket.sendBinary || raw.length * 3 <= CHUNK_BYTES) return [raw]
  const bytes = Buffer.from(raw, "utf8")
  if (bytes.byteLength <= CHUNK_BYTES || bytes.byteLength > MAX_FRAME_BYTES) return [raw]
  return chunkFrame(bytes)
}

/** How many sends to this socket were queued under backpressure. */
export function backlogCount(socket: object): number {
  return backlogged.get(socket) ?? 0
}

function shut(socket: GuardedSocket, why: string): false {
  closing.add(socket)
  console.warn(`rudderd: closing a phone socket for backpressure (${why}; ${backlogCount(socket)} sends queued under backpressure)`)
  socket.close?.(BACKPRESSURE_CLOSE, "backpressure")
  return false
}
