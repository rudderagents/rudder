import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { PermissionLock } from "./types"

/**
 * r70 0.6 / v71: Grok's own settings can approve everything, and nothing Rudder sends at launch or over ACP turns that
 * off (real test, Grok 1.0.77: `--permission-mode`, a `GROK_CONFIG` overlay and `_meta` all lose to it). The phone
 * must say so instead of showing 自动判断. Reads `[ui] permission_mode = "always-approve"` (or the legacy
 * `yolo = true`) from `$GROK_HOME/config.toml`.
 */
export function grokPermissionLock(home = process.env.GROK_HOME ?? join(homedir(), ".grok")): PermissionLock | undefined {
  const path = join(home, "config.toml")
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch {
    return undefined
  }
  return readUiLock(text) ? { mode: "always-approve", source: path } : undefined
}

/** The `[ui]` table's permission_mode / yolo. A minimal TOML read: keys of that one table, comments dropped. */
export function readUiLock(text: string): boolean {
  let inUi = false
  let mode: string | undefined
  let yolo = false
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim()
    if (!line) continue
    const table = line.match(/^\[([^\]]+)\]$/)
    if (table) {
      inUi = table[1]!.trim() === "ui"
      continue
    }
    if (!inUi) continue
    const pair = line.match(/^([A-Za-z_][\w-]*)\s*=\s*(.+)$/)
    if (!pair) continue
    const value = pair[2]!.trim().replace(/^["']|["']$/g, "")
    if (pair[1] === "permission_mode") mode = value
    if (pair[1] === "yolo") yolo = value === "true"
  }
  // An explicit mode wins over the legacy key.
  return mode !== undefined ? mode === "always-approve" : yolo
}
