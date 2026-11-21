import { encode } from "uqr"

/** Light modules around the code; two is enough for phone scanners and keeps an 80-column terminal wide enough. */
export const QUIET_ZONE = 2

// 256-color cube entries 16 (#000000) and 231 (#ffffff) are fixed, unlike the 16 theme colors a dark scheme remaps.
const COLORS = "\x1b[38;5;16;48;5;231m"
const RESET = "\x1b[0m"
const BOLD = "\x1b[1m"
const DIM = "\x1b[2m"

/** `true` is a dark module; the quiet zone is included. */
export function qrMatrix(text: string): boolean[][] {
  return encode(text, { ecc: "L", border: QUIET_ZONE }).data
}

/** Two module rows per text line (▀ ▄ █), black on an explicit white background, so it scans in light and dark terminals. */
export function renderQr(text: string): string[] {
  const matrix = qrMatrix(text)
  const lines: string[] = []
  for (let y = 0; y < matrix.length; y += 2) {
    const top = matrix[y]
    const bottom = matrix[y + 1] ?? top.map(() => false)
    const cells = top.map((dark, x) => {
      if (dark && bottom[x]) return "█"
      if (dark) return "▀"
      if (bottom[x]) return "▄"
      return " "
    })
    lines.push(`${COLORS}${cells.join("")}${RESET}`)
  }
  return lines
}

/** Local wall-clock HH:mm, the way the phone shows times. */
export function clockTime(epochMs: number): string {
  const at = new Date(epochMs)
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`
}

export type TerminalLocale = "zh" | "en"

/**
 * First non-empty of LC_ALL, LC_MESSAGES, LANG; "zh…" → zh, anything else or unset → en. Windows sets none of them,
 * so there the user's display language (what Intl reports) decides when they are unset.
 */
export function terminalLocale(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
  systemLocale: () => string = () => Intl.DateTimeFormat().resolvedOptions().locale,
): TerminalLocale {
  const raw = [env.LC_ALL, env.LC_MESSAGES, env.LANG].find((value) => value && value.length > 0) ?? (platform === "win32" ? systemLocale() : "")
  return raw.toLowerCase().startsWith("zh") ? "zh" : "en"
}

/** "7f3a9c2e…" → "7f3a 9c2e …" (4-character groups, any length). */
export function groupPairingCode(token: string): string {
  return token.match(/.{1,4}/g)?.join(" ") ?? token
}

/** 64 hex → "3F9A 21C0 … 7E4D 9B12": first 8 and last 8, upper case. The phone shows the same. */
export function fingerprintSummary(fingerprint: string): string {
  const upper = fingerprint.toUpperCase()
  return `${groupPairingCode(upper.slice(0, 8))} … ${groupPairingCode(upper.slice(-8))}`
}

/**
 * The terminal pairing screen. The link is always the last line (the phone says "copy the last line").
 * The pairing code and fingerprint sit above it; no fingerprint line when the link has no `fp`. `notice` (the
 * update line) goes after them, still above the link.
 */
export function pairBanner(
  link: { url: string; expiresAt: number },
  machine: string,
  locale: TerminalLocale,
  notice: string | null = null,
): string[] {
  const query = new URL(link.url).searchParams
  const token = query.get("token")
  const fingerprint = query.get("fp")
  const zh = locale === "zh"
  const lines = [
    zh ? `⎈ rudder 正在运行 · ${machine}` : `⎈ rudder is running · ${machine}`,
    "",
    ...renderQr(link.url),
    "",
    zh ? `${BOLD}用 Rudder 扫这个码${RESET}` : `${BOLD}Scan this with Rudder${RESET}`,
    zh
      ? `${DIM}单次有效，有效到 ${clockTime(link.expiresAt)}${RESET}`
      : `${DIM}Single use, valid until ${clockTime(link.expiresAt)}${RESET}`,
  ]
  if (token) lines.push(zh ? `${DIM}配对码 ${groupPairingCode(token)}${RESET}` : `${DIM}Pairing code ${groupPairingCode(token)}${RESET}`)
  if (fingerprint) {
    const summary = fingerprintSummary(fingerprint)
    lines.push(zh ? `${DIM}指纹 ${summary}${RESET}` : `${DIM}Fingerprint ${summary}${RESET}`)
  }
  if (notice) lines.push("", notice)
  lines.push(`${DIM}${link.url}${RESET}`)
  return lines
}
