import { type CipherState, NoiseError } from "./noise"

/**
 * Inner framing (the relay design notes): one app frame (the JSON text of /v1/ws) becomes one or more Noise
 * transport messages. Each plaintext is a flag byte (bit 0 = FIN, last chunk) followed by at most CHUNK_BYTES of the
 * frame's UTF-8. 1 + 65,000 + 16-byte tag stays under Noise's 65,535-byte message cap.
 */
export const CHUNK_BYTES = 65_000
export const MAX_FRAME_BYTES = 16 * 1024 * 1024
const FIN = 0x01
const EMPTY = Buffer.alloc(0)

/** Plaintext chunks for one frame, before encryption. */
export function chunkFrame(frame: Buffer, chunkBytes = CHUNK_BYTES): Buffer[] {
  if (frame.byteLength > MAX_FRAME_BYTES) throw new NoiseError(`frame is ${frame.byteLength} bytes, over ${MAX_FRAME_BYTES}`)
  const chunks: Buffer[] = []
  let offset = 0
  do {
    const end = Math.min(frame.byteLength, offset + chunkBytes)
    chunks.push(Buffer.concat([Buffer.from([end === frame.byteLength ? FIN : 0]), frame.subarray(offset, end)]))
    offset = end
  } while (offset < frame.byteLength)
  return chunks
}

/** Rejoins chunks into frames; refuses a frame that grows past MAX_FRAME_BYTES or a chunk without its flag byte. */
export class Reassembler {
  private parts: Buffer[] = []
  private size = 0

  push(chunk: Buffer): Buffer | null {
    if (chunk.byteLength < 1) throw new NoiseError("chunk without its flag byte")
    const flags = chunk[0]!
    if ((flags & ~FIN) !== 0) throw new NoiseError(`unknown chunk flags ${flags}`)
    const body = chunk.subarray(1)
    this.size += body.byteLength
    if (this.size > MAX_FRAME_BYTES) throw new NoiseError(`frame over ${MAX_FRAME_BYTES} bytes`)
    this.parts.push(Buffer.from(body))
    if ((flags & FIN) === 0) return null
    const frame = Buffer.concat(this.parts)
    this.parts = []
    this.size = 0
    return frame
  }
}

/** An established channel: seals frames into Noise messages and opens messages back into frames. */
export class SecureChannel {
  private readonly reassembler = new Reassembler()

  constructor(
    private readonly sendCipher: CipherState,
    private readonly receiveCipher: CipherState,
  ) {}

  seal(frame: string | Buffer): Buffer[] {
    const bytes = typeof frame === "string" ? Buffer.from(frame, "utf8") : frame
    return chunkFrame(bytes).map((chunk) => this.sendCipher.encrypt(EMPTY, chunk))
  }

  /** The whole frame once its FIN chunk arrives, else null. Throws on a message that does not authenticate. */
  open(message: Buffer): Buffer | null {
    return this.reassembler.push(this.receiveCipher.decrypt(EMPTY, message))
  }
}
