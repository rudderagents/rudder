import { describe, expect, test } from "bun:test"
import jsQR from "jsqr"
import { pairUrl } from "./pair"
import { clockTime, fingerprintSummary, groupPairingCode, pairBanner, QUIET_ZONE, qrMatrix, renderQr, terminalLocale } from "./qr"

const FINGERPRINT = "a".repeat(64)
const EXPIRES = new Date(2026, 9, 22, 9, 5).getTime()
const TOKEN = "0123456789abcdef0123456789abcdef"
const LINK = pairUrl("192.168.31.20", 7749, TOKEN, FINGERPRINT, EXPIRES)

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes is the point
const stripAnsi = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "")

/** Reads the half-block text back into module rows: what a camera sees on screen. */
function modulesFromText(lines: string[]): boolean[][] {
  const rows: boolean[][] = []
  for (const line of lines) {
    const cells = [...stripAnsi(line)]
    rows.push(cells.map((cell) => cell === "█" || cell === "▀"))
    rows.push(cells.map((cell) => cell === "█" || cell === "▄"))
  }
  return rows
}

/** Paints modules as `scale`-pixel squares (dark = 0, light = 255) for the decoder. */
function decode(modules: boolean[][], scale = 6): string | null {
  const height = modules.length * scale
  const width = modules[0].length * scale
  const pixels = new Uint8ClampedArray(width * height * 4).fill(255)
  for (const [y, row] of modules.entries()) {
    for (const [x, dark] of row.entries()) {
      if (!dark) continue
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const at = ((y * scale + dy) * width + x * scale + dx) * 4
          pixels[at] = pixels[at + 1] = pixels[at + 2] = 0
        }
      }
    }
  }
  return jsQR(pixels, width, height, { inversionAttempts: "dontInvert" })?.data ?? null
}

describe("terminal QR", () => {
  test("the rendered half blocks decode back to the pair link", () => {
    const lines = renderQr(LINK)
    const modules = modulesFromText(lines)
    const matrix = qrMatrix(LINK)
    // An odd module count leaves one light padding row under the code.
    expect(modules.slice(0, matrix.length)).toEqual(matrix)
    expect(modules.slice(matrix.length).flat().every((dark) => !dark)).toBe(true)
    expect(decode(modules)).toBe(LINK)
  })

  test("keeps a two-module quiet zone on every side", () => {
    const matrix = qrMatrix(LINK)
    const edge = [...matrix.slice(0, QUIET_ZONE), ...matrix.slice(-QUIET_ZONE)].flat()
    const sides = matrix.flatMap((row) => [...row.slice(0, QUIET_ZONE), ...row.slice(-QUIET_ZONE)])
    expect(QUIET_ZONE).toBe(2)
    expect([...edge, ...sides].every((dark) => !dark)).toBe(true)
    // The finder pattern's dark corner sits right inside the zone.
    expect(matrix[QUIET_ZONE][QUIET_ZONE]).toBe(true)
  })

  test("every line sets black on white explicitly and resets, so the terminal theme cannot invert it", () => {
    for (const line of renderQr(LINK)) {
      expect(line.startsWith("\x1b[38;5;16;48;5;231m")).toBe(true)
      expect(line.endsWith("\x1b[0m")).toBe(true)
    }
  })

  test("a typical link fits an 80-column terminal", () => {
    const width = [...stripAnsi(renderQr(LINK)[0])].length
    expect(width).toBeLessThanOrEqual(80)
  })

  test("a LAN + MagicDNS link still fits 80 columns and scans back whole", () => {
    const hosts = ["192.168.31.20", "mac-studio-of-someone.tail1234ab.ts.net"]
    const link = pairUrl(hosts, 7749, TOKEN, FINGERPRINT, EXPIRES, null, null, "darwin")
    const lines = renderQr(link)
    expect([...stripAnsi(lines[0])].length).toBeLessThanOrEqual(80)
    expect(decode(modulesFromText(lines))).toBe(link)
  })

  test("the banner follows the onboarding layout in Chinese and English", () => {
    const grouped = groupPairingCode(TOKEN)
    const summary = fingerprintSummary(FINGERPRINT)
    const zh = pairBanner({ url: LINK, expiresAt: EXPIRES }, "Mac Studio", "zh").map(stripAnsi)
    expect(zh[0]).toBe("⎈ rudder 正在运行 · Mac Studio")
    expect(zh).toContain("用 Rudder 扫这个码")
    expect(zh).toContain("单次有效，有效到 09:05")
    expect(zh).toContain(`配对码 ${grouped}`)
    expect(zh).toContain(`指纹 ${summary}`)
    expect(zh.at(-1)).toBe(LINK)

    const en = pairBanner({ url: LINK, expiresAt: EXPIRES }, "Mac Studio", "en").map(stripAnsi)
    expect(en[0]).toBe("⎈ rudder is running · Mac Studio")
    expect(en).toContain("Scan this with Rudder")
    expect(en).toContain("Single use, valid until 09:05")
    expect(en).toContain(`Pairing code ${grouped}`)
    expect(en).toContain(`Fingerprint ${summary}`)
    expect(en.at(-1)).toBe(LINK)
    expect(clockTime(new Date(2026, 9, 22, 23, 59).getTime())).toBe("23:59")
  })

  test("without a fingerprint the banner omits that line and the link stays last", () => {
    const url = pairUrl("192.168.31.20", 7749, TOKEN, null, EXPIRES)
    const lines = pairBanner({ url, expiresAt: EXPIRES }, "Mac Studio", "en").map(stripAnsi)
    expect(lines.some((line) => line.startsWith("Fingerprint") || line.startsWith("指纹"))).toBe(false)
    expect(lines).toContain(`Pairing code ${groupPairingCode(TOKEN)}`)
    expect(lines.at(-1)).toBe(url)
  })

  test("terminalLocale prefers LC_ALL, then LC_MESSAGES, then LANG", () => {
    expect(terminalLocale({ LANG: "zh_CN.UTF-8" })).toBe("zh")
    expect(terminalLocale({ LANG: "en_US.UTF-8" })).toBe("en")
    expect(terminalLocale({ LC_ALL: "zh_TW", LANG: "en_US" })).toBe("zh")
    expect(terminalLocale({ LANG: "C" })).toBe("en")
    expect(terminalLocale({})).toBe("en")
  })
})
