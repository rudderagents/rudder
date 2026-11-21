import { readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { RelayLinkState } from "./link"

/** `RUDDER_HOME/relay-state.json`: what the running daemon's relay links are doing, for `rudder status`. */
export type RelayStateFile = { slotId: string; links: { base: string; state: RelayLinkState; since: number }[]; pid: number }

const FILE = "relay-state.json"

export function writeRelayState(dataDir: string, state: RelayStateFile): void {
  const path = join(dataDir, FILE)
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(state), { mode: 0o600 })
  renameSync(temp, path)
}

export function readRelayState(dataDir: string): RelayStateFile | null {
  try {
    const value = JSON.parse(readFileSync(join(dataDir, FILE), "utf8")) as RelayStateFile
    return typeof value.slotId === "string" && Array.isArray(value.links) ? value : null
  } catch {
    return null
  }
}

/** One line per link, e.g. `wss://relay.example connected (slot k5q3…)`. */
export function describeRelayState(state: RelayStateFile | null): string[] {
  if (!state) return ["unknown (the daemon has not written relay-state.json)"]
  if (state.links.length === 0) return ["off (RUDDER_RELAY unset or off)"]
  return state.links.map((link) => `${link.base} ${link.state} (slot ${state.slotId})`)
}
