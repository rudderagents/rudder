import { describe, expect, test } from "bun:test"
import { exifJpeg } from "./fixtures/exif-jpeg"
import { bytesFromImageResult, jpegOrientation, sniffImage } from "./image-bytes"

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVQI12P4z8AAAAADAAEABf4C/tzMWecAAAAASUVORK5CYII=",
  "base64",
)

describe("sniffImage", () => {
  test("reads png, jpeg, gif and webp dimensions from the bytes", () => {
    expect(sniffImage(PNG)).toEqual({ mediaType: "image/png", width: 1, height: 1 })
    // COM marker, then SOF0: height 2, width 3.
    const jpeg = Uint8Array.from([
      0xff, 0xd8, 0xff, 0xfe, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x02, 0x00, 0x03, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9,
    ])
    expect(sniffImage(jpeg)).toEqual({ mediaType: "image/jpeg", width: 3, height: 2 })
    const gif = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x02, 0x00, 0x03, 0x00])
    expect(sniffImage(gif)).toEqual({ mediaType: "image/gif", width: 2, height: 3 })
    // VP8X canvas is stored as width-1 and height-1.
    const vp8x = Uint8Array.from([
      0x52, 0x49, 0x46, 0x46, 0x16, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58, 0x0a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x0f, 0x00, 0x00, 0x08, 0x00, 0x00,
    ])
    expect(sniffImage(vp8x)).toEqual({ mediaType: "image/webp", width: 16, height: 9 })
    // VP8L: width = bits & 0x3fff + 1 = 5, height = (bits >> 14) & 0x3fff + 1 = 7.
    const vp8l = webpChunk("VP8L", Uint8Array.from([0x2f, 0x04, 0x80, 0x01, 0x00]))
    expect(sniffImage(vp8l)).toEqual({ mediaType: "image/webp", width: 5, height: 7 })
    const vp8 = webpChunk("VP8 ", Uint8Array.from([0x00, 0x00, 0x00, 0x9d, 0x01, 0x2a, 0x04, 0x00, 0x02, 0x00]))
    expect(sniffImage(vp8)).toEqual({ mediaType: "image/webp", width: 4, height: 2 })
  })

  test("rejects text, a zero dimension and a truncated header", () => {
    expect(sniffImage(new TextEncoder().encode("not-an-image"))).toBeNull()
    const zero = new Uint8Array(PNG)
    zero[22] = 0
    zero[23] = 0
    expect(sniffImage(zero)).toBeNull()
    expect(sniffImage(PNG.subarray(0, 20))).toBeNull()
  })
})

describe("jpegOrientation", () => {
  test("reads the EXIF orientation in either byte order, 1 when there is none", () => {
    expect(jpegOrientation(exifJpeg(6, 4032, 3024))).toBe(6)
    expect(jpegOrientation(exifJpeg(8, 4032, 3024, true))).toBe(8)
    expect(jpegOrientation(exifJpeg(1, 4032, 3024))).toBe(1)
    expect(jpegOrientation(PNG)).toBe(1)
    const plain = Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x02, 0x00, 0x03, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9])
    expect(jpegOrientation(plain)).toBe(1)
    expect(sniffImage(exifJpeg(6, 4032, 3024))).toEqual({ mediaType: "image/jpeg", width: 4032, height: 3024 })
  })
})

describe("bytesFromImageResult", () => {
  test("decodes a data URL and raw base64, and ignores anything else", () => {
    const raw = PNG.toString("base64")
    expect(bytesFromImageResult(`data:image/jpeg;base64,${raw}`)).toEqual(new Uint8Array(PNG))
    expect(bytesFromImageResult(raw)).toEqual(new Uint8Array(PNG))
    expect(sniffImage(bytesFromImageResult(`data:text/plain;base64,${raw}`)!)?.mediaType).toBe("image/png")
    expect(bytesFromImageResult("not-an-image")).toBeNull()
    expect(bytesFromImageResult({ content: [{ text: raw }] })).toBeNull()
    expect(bytesFromImageResult("data:image/png,not-base64")).toBeNull()
  })
})

function webpChunk(fourcc: string, payload: Uint8Array): Uint8Array {
  const body = 4 + 8 + payload.length
  const out = new Uint8Array(8 + body)
  out.set(ascii("RIFF"), 0)
  writeU32LE(out, 4, body)
  out.set(ascii("WEBP"), 8)
  out.set(ascii(fourcc), 12)
  writeU32LE(out, 16, payload.length)
  out.set(payload, 20)
  return out
}

function ascii(text: string): Uint8Array {
  return Uint8Array.from(text, (char) => char.charCodeAt(0))
}

function writeU32LE(bytes: Uint8Array, offset: number, value: number) {
  bytes[offset] = value & 0xff
  bytes[offset + 1] = (value >> 8) & 0xff
  bytes[offset + 2] = (value >> 16) & 0xff
  bytes[offset + 3] = (value >> 24) & 0xff
}
