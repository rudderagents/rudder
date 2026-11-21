// Image bytes are recognized by magic, never by a file extension or a data-URL MIME type.
// Dimensions stay as stored: EXIF orientation is not applied (`jpegOrientation` reads it for callers that need it).

export type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp"

export type SniffedImage = { mediaType: ImageMediaType; width: number; height: number }

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

export function sniffImage(bytes: Uint8Array): SniffedImage | null {
  const png = sniffPng(bytes)
  if (png) return { mediaType: "image/png", ...png }
  const jpeg = sniffJpeg(bytes)
  if (jpeg) return { mediaType: "image/jpeg", ...jpeg }
  const gif = sniffGif(bytes)
  if (gif) return { mediaType: "image/gif", ...gif }
  const webp = sniffWebp(bytes)
  if (webp) return { mediaType: "image/webp", ...webp }
  return null
}

/** The format named by the first 12 bytes alone, without dimensions: enough to tell an image from any other file. */
export function imageMagic(bytes: Uint8Array): ImageMediaType | null {
  if (bytes.length >= PNG.length && PNG.every((byte, i) => bytes[i] === byte)) return "image/png"
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg"
  if (bytes.length >= 6 && (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a")) return "image/gif"
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "image/webp"
  return null
}

/** `result` on a completed imageGeneration item: a base64 string or a base64 data URL. Anything else is not pixels. */
export function bytesFromImageResult(result: unknown): Uint8Array | null {
  if (typeof result !== "string") return null
  const trimmed = result.trim()
  if (!trimmed) return null
  let payload = trimmed
  if (/^data:/i.test(trimmed)) {
    const marker = /^data:[^,]*,/i.exec(trimmed)
    if (!marker || !/^data:[^,]*;base64,/i.test(trimmed)) return null
    payload = trimmed.slice(marker[0].length)
  }
  const compact = payload.replace(/\s+/g, "")
  if (compact.length < 8 || compact.length % 4 !== 0) return null
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return null
  const decoded = Buffer.from(compact, "base64")
  return decoded.length > 0 ? new Uint8Array(decoded) : null
}

function sniffPng(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null
  for (let i = 0; i < PNG.length; i++) if (bytes[i] !== PNG[i]) return null
  // IHDR length is 13 and the type sits immediately after the signature.
  if (readU32BE(bytes, 8) !== 13) return null
  if (ascii(bytes, 12, 4) !== "IHDR") return null
  return positive(readU32BE(bytes, 16), readU32BE(bytes, 20))
}

const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

function sniffJpeg(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let i = 2
  while (i + 1 < bytes.length) {
    if (bytes[i] !== 0xff) return null
    while (i < bytes.length && bytes[i] === 0xff) i++
    if (i >= bytes.length) return null
    const marker = bytes[i]!
    i++
    // Standalone markers (SOI, RST, EOI, TEM) carry no length.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (marker === 0xd9) return null
    if (i + 1 >= bytes.length) return null
    const length = (bytes[i]! << 8) | bytes[i + 1]!
    if (length < 2 || i + length > bytes.length) return null
    if (SOF.has(marker)) {
      if (length < 7) return null
      return positive((bytes[i + 5]! << 8) | bytes[i + 6]!, (bytes[i + 3]! << 8) | bytes[i + 4]!)
    }
    // Start of scan: pixel data follows and a SOF would already have been seen.
    if (marker === 0xda) return null
    i += length
  }
  return null
}

/** A JPEG's EXIF orientation (1–8): 5–8 are turned a quarter, so the photo shows height × width. 1 when absent. */
export function jpegOrientation(bytes: Uint8Array): number {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return 1
  let i = 2
  while (i + 3 < bytes.length && bytes[i] === 0xff) {
    const marker = bytes[i + 1]!
    const length = (bytes[i + 2]! << 8) | bytes[i + 3]!
    if (marker === 0xda || marker === 0xd9 || length < 2) return 1
    if (marker === 0xe1 && ascii(bytes, i + 4, 6) === "Exif\0\0") return tiffOrientation(bytes, i + 10, i + 2 + length)
    i += 2 + length
  }
  return 1
}

function tiffOrientation(bytes: Uint8Array, start: number, end: number): number {
  if (end > bytes.length || start + 8 > end) return 1
  const little = ascii(bytes, start, 2) === "II"
  if (!little && ascii(bytes, start, 2) !== "MM") return 1
  const u16 = (at: number) => (little ? bytes[at]! | (bytes[at + 1]! << 8) : (bytes[at]! << 8) | bytes[at + 1]!)
  const u32 = (at: number) => (little ? (u16(at) | (u16(at + 2) << 16)) >>> 0 : ((u16(at) << 16) | u16(at + 2)) >>> 0)
  const ifd = start + u32(start + 4)
  if (ifd + 2 > end) return 1
  const count = u16(ifd)
  for (let n = 0; n < count; n++) {
    const entry = ifd + 2 + n * 12
    if (entry + 12 > end) return 1
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8)
      return value >= 1 && value <= 8 ? value : 1
    }
  }
  return 1
}

function sniffGif(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 10) return null
  const head = ascii(bytes, 0, 6)
  if (head !== "GIF87a" && head !== "GIF89a") return null
  return positive(bytes[6]! | (bytes[7]! << 8), bytes[8]! | (bytes[9]! << 8))
}

function sniffWebp(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 16 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") return null
  const chunk = ascii(bytes, 12, 4)
  if (chunk === "VP8X") {
    if (bytes.length < 30) return null
    const width = 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16))
    const height = 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16))
    return positive(width, height)
  }
  if (chunk === "VP8L") {
    if (bytes.length < 25 || bytes[20] !== 0x2f) return null
    const bits = bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! * 0x1000000)
    return positive((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1)
  }
  if (chunk === "VP8 ") {
    const start = indexOf(bytes, [0x9d, 0x01, 0x2a], 20)
    if (start < 0 || start + 7 > bytes.length) return null
    const at = start + 3
    const width = (bytes[at]! | (bytes[at + 1]! << 8)) & 0x3fff
    const height = (bytes[at + 2]! | (bytes[at + 3]! << 8)) & 0x3fff
    return positive(width, height)
  }
  return null
}

function positive(width: number, height: number): { width: number; height: number } | null {
  if (width <= 0 || height <= 0) return null
  return { width, height }
}

function readU32BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = ""
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i]!)
  return out
}

function indexOf(bytes: Uint8Array, needle: number[], from: number): number {
  for (let i = from; i + needle.length <= bytes.length; i++) {
    let found = true
    for (let j = 0; j < needle.length; j++) {
      if (bytes[i + j] !== needle[j]) {
        found = false
        break
      }
    }
    if (found) return i
  }
  return -1
}
