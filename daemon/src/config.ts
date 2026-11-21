import { join } from "node:path"
import { defaultDataDir } from "./platform"

export const DAEMON_PORT = Number(process.env.RUDDER_PORT ?? 7749)
/** RUDDER_TLS=0 serves plain HTTP/WS without a pinned certificate (local simulator dev and tests only). */
export const TLS_ENABLED = process.env.RUDDER_TLS !== "0"
/**
 * Every interface, so the phone reaches it over the LAN or a tailnet: the pinned certificate, the one-time token (handed to
 * `rudder pair` over the owner-only socket in RUDDER_HOME, never over TCP) guard it. Plain HTTP stays on loopback.
 */
export const DAEMON_HOST = process.env.RUDDER_HOST ?? (TLS_ENABLED ? "0.0.0.0" : "127.0.0.1")
/** ~/Library/Application Support/Rudder on macOS, %LOCALAPPDATA%\\Rudder on Windows (platform/index.ts). */
export const DEFAULT_DATA_DIR = defaultDataDir()
export const DATA_DIR = process.env.RUDDER_HOME ?? DEFAULT_DATA_DIR
/**
 * The deployed gateway (the push notes), the same one the App registers with (`RUDDER_PUSH_GATEWAY` in
 * ios/Config/Base.xcconfig). The only place the daemon names a service host.
 */
export const DEFAULT_PUSH_GATEWAY = "https://push.rudderagents.com"
/** RUDDER_PUSH_GATEWAY overrides the gateway; `off` means no lock-screen pushes. */
export const PUSH_GATEWAY =
  process.env.RUDDER_PUSH_GATEWAY === "off" ? null : process.env.RUDDER_PUSH_GATEWAY || DEFAULT_PUSH_GATEWAY
export const DB_PATH = process.env.RUDDER_DB ?? join(DATA_DIR, "rudder.sqlite")
export const PROTOCOL_NAME = "rudder"
export const APP_VERSION = "1.0.0"
/** Placeholder until the own domain is named; the one place the daemon's relay address lives. */
export const DEFAULT_RELAY = "wss://relay.rudderagents.com"
/**
 * The relay list is live (global Cloudflare, plus Hong Kong for CN) and validated end to end from a phone on
 * cellular (2026-11-09). On by default: with RUDDER_RELAY unset, a daemon
 * dials DEFAULT_RELAY and then follows the relay list. `off` still opts out.
 */
export const RELAY_ON_BY_DEFAULT = true

/**
 * The unfiltered relay list (the relay design notes): every configured base, not this computer's country.
 * Only read when RUDDER_RELAY names no base of its own.
 */
export const DEFAULT_RELAY_LIST = "https://api.rudderagents.com/v1/relays?scope=computer"

/** r75 blob lane (relay Worker `/v1/blob/:id`): `file.ship` PUTs here, `attachment.fetch` GETs from here. */
export const BLOB_API = (process.env.RUDDER_BLOB_API ?? "https://api.rudderagents.com").replace(/\/+$/, "")
/** Thumbnails and screen-size copies (`file.thumb`, `file.get {variant: "screen"}`), 200 MB LRU. */
export const THUMBS_DIR = join(DATA_DIR, "thumbs")

/** What RUDDER_RELAY asks for: the bases to start with, and whether the relay list may change them later. */
export type RelayPlan = { bases: string[]; discover: boolean }

/**
 * `off` → nothing; `on`, or unset with the relay on by default → DEFAULT_RELAY to start, then the relay list; an
 * explicit list (including a self-hosted base) is used as written and never replaced.
 */
/**
 * `RUDDER_RELAY` wins when it is set. Otherwise the saved `rudder relay on|off` mode (`relay-mode` in RUDDER_HOME)
 * is that value. Neither set leaves the choice to `RELAY_ON_BY_DEFAULT`.
 */
export function relaySetting(env: string | undefined, saved: "on" | "off" | null): string | undefined {
  if (env !== undefined && env.trim() !== "") return env
  return saved ?? undefined
}

export function relayPlan(value: string | undefined = process.env.RUDDER_RELAY, onByDefault = RELAY_ON_BY_DEFAULT): RelayPlan {
  const bases = relayBases(value, onByDefault)
  const keyword = value?.trim().toLowerCase()
  const discover = bases.length > 0 && (keyword === "on" || !keyword)
  return { bases, discover }
}

/**
 * RUDDER_RELAY: `off` opens no outbound connection at all; `on` is DEFAULT_RELAY; otherwise a comma-separated list of
 * `wss://` bases (the relay design notes). Unset or empty follows RELAY_ON_BY_DEFAULT.
 */
export function relayBases(value: string | undefined = process.env.RUDDER_RELAY, onByDefault = RELAY_ON_BY_DEFAULT): string[] {
  const keyword = value?.trim().toLowerCase()
  if (keyword === "off") return []
  if (keyword === "on") return [DEFAULT_RELAY]
  if (!keyword) return onByDefault ? [DEFAULT_RELAY] : []
  const bases = (value ?? "")
    .split(",")
    .map((entry) => entry.trim().replace(/\/+$/, ""))
    .filter(Boolean)
  for (const base of bases) {
    if (!/^wss?:\/\/[^/?#]+$/.test(base)) throw new Error(`RUDDER_RELAY: ${JSON.stringify(base)} is not a ws:// or wss:// origin`)
  }
  return bases
}
