import { randomBytes, timingSafeEqual } from "node:crypto"
import type { Store } from "./store"

const PAIRING_TOKEN_KEY = "pairing_token"
const PAIRING_EXPIRES_KEY = "pairing_token_expires_at"
export const PAIRING_TTL_MS = 10 * 60 * 1000

export type PairingToken = { token: string; expiresAt: number }

export function mintPairingToken(store: Store, now = Date.now()): PairingToken {
  const minted = { token: randomBytes(16).toString("hex"), expiresAt: now + PAIRING_TTL_MS }
  store.transaction(() => {
    store.setMeta(PAIRING_TOKEN_KEY, minted.token)
    store.setMeta(PAIRING_EXPIRES_KEY, String(minted.expiresAt))
  })
  return minted
}

function storedToken(store: Store): PairingToken | null {
  const token = store.getMeta(PAIRING_TOKEN_KEY)
  const expiresAt = Number(store.getMeta(PAIRING_EXPIRES_KEY))
  // A token without an expiry predates the TTL and is treated as expired.
  if (!token || !Number.isFinite(expiresAt) || expiresAt <= 0) return null
  return { token, expiresAt }
}

/** The live token, minting a fresh one when there is none or it has expired. */
/** Whether `token` is still the unexpired pairing token (a relay pairing connection keyed with it may stay open). */
export function pairingTokenIsCurrent(store: Store, token: string | null, now = Date.now()): boolean {
  const stored = storedToken(store)
  return token !== null && stored !== null && now < stored.expiresAt && sameToken(token, stored.token)
}

export function currentPairingToken(store: Store, now = Date.now()): PairingToken {
  const stored = storedToken(store)
  if (stored && now < stored.expiresAt) return stored
  return mintPairingToken(store, now)
}

/**
 * `fp` is the SHA-256 of the served certificate's DER as 64 lowercase hex chars; its presence
 * tells the app to use https/wss and pin that certificate. No `fp` means plain http (RUDDER_TLS=0).
 * Each host is its own `host=`, in the order the app tries them (LAN, then MagicDNS); apps that predate
 * multi-host links read the first one only. A null token prints the link without its secret, for logs.
 * `relay` is this computer's relay slot (the relay design notes); apps that predate it ignore it.
 * `relayUrl` is set only when the daemon uses a relay other than the default one, so the phone dials that relay
 * for this computer.
 * `os` (`win32` / `darwin`) lets the phone's pairing-failure page name only that system's firewall; apps that predate
 * it ignore it, and other platforms leave it out.
 * `relayPass` (only with `relay`) is the pairing slot pass (the relay slot pass notes): the pairing connection
 * sends it so strangers cannot push it out of the relay's waiting pool. Base64url and dots, so it needs no escaping.
 */
export function pairUrl(
  hosts: string | string[],
  port: number,
  token: string | null,
  fingerprint: string | null = null,
  expiresAt: number | null = null,
  relaySlot: string | null = null,
  relayUrl: string | null = null,
  os: string | null = null,
  relayPass: string | null = null,
): string {
  const list = typeof hosts === "string" ? [hosts] : hosts
  if (list.length === 0) throw new Error("pairUrl needs at least one host")
  const host = list.map((entry) => `host=${entry}:${port}`).join("&")
  const fp = `${fingerprint ? `&fp=${fingerprint}` : ""}${relaySlot ? `&relay=${relaySlot}` : ""}${relaySlot && relayUrl ? `&relayUrl=${encodeURIComponent(relayUrl)}` : ""}`
  // Unix seconds, between fp and token. Only the app reads it; redeem still uses the stored TTL.
  const exp = expiresAt == null ? "" : `&exp=${Math.floor(expiresAt / 1000)}`
  const system = os === "win32" || os === "darwin" ? `&os=${os}` : ""
  const pass = relaySlot && relayPass ? `&pass=${relayPass}` : ""
  const secret = token ? `&token=${token}` : ""
  return `rudder://pair?${host}${fp}${exp}${system}${pass}${secret}`
}

function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given, "utf8")
  const b = Buffer.from(expected, "utf8")
  return a.byteLength === b.byteLength && timingSafeEqual(a, b)
}

/** Single use: a successful redeem rotates the token, so each printed link pairs one device. */
export function redeemPairing(store: Store, token: string, deviceName: string, now = Date.now()) {
  return store.transaction(() => {
    const stored = storedToken(store)
    if (!stored || now >= stored.expiresAt || !sameToken(token, stored.token)) {
      throw Object.assign(new Error("invalid pairing token"), { code: "pair_invalid" })
    }
    const device = {
      id: crypto.randomUUID(),
      session_key: randomBytes(32).toString("hex"),
      name: deviceName || "iPhone",
      created_at: now,
      push_token: null,
    }
    store.putDevice(device)
    mintPairingToken(store, now)
    return { deviceId: device.id, sessionKey: device.session_key }
  })
}
