import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/** `rudder relay on|off` writes this in RUDDER_HOME. The environment variable overrides it. */
export const RELAY_MODE_FILE = "relay-mode"

export function readRelayMode(dataDir: string): "on" | "off" | null {
  try {
    const text = readFileSync(join(dataDir, RELAY_MODE_FILE), "utf8").trim().toLowerCase()
    return text === "on" || text === "off" ? text : null
  } catch {
    return null
  }
}

export function writeRelayMode(dataDir: string, mode: "on" | "off"): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  writeFileSync(join(dataDir, RELAY_MODE_FILE), `${mode}\n`, { mode: 0o600 })
}
