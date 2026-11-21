import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject, sign } from "node:crypto"
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/** This computer's relay identity (the relay design notes): an Ed25519 key and the slot id it names. */
export type RelayIdentity = {
  slotId: string
  /** 32 raw public key bytes. */
  publicKey: Buffer
  /**
   * Headers for `GET /v1/daemon?slot=` on `host` (the relay's `host[:port]`): the key, the time, a v1 signature over
   * both with the slot, and a v2 one that also names the relay, so a signature taken from one relay cannot be replayed
   * on another (review S4). v1 stays for relays deployed before v2.
   */
  sign(host: string, nowSeconds?: number): Record<string, string>
  /**
   * A slot pass (the relay slot pass notes) the phone sends as `X-Rudder-Pass`: the relay ranks it with the
   * proven phones while it waits on its handshake. `device` "" is a pairing pass; `exp` is Unix seconds.
   */
  signPass(slot: string, device: string, exp: number): string
}

const KEY_FILE = "relay-key.pem"
const SIGN_TAG = "rudder-relay-daemon/1"
const SIGN_TAG_V2 = "rudder-relay-daemon/2"
const PASS_TAG = "rudder-relay-pass/1"
/** A device pass lives this long and is renewed on every hello (the relay ignores passes past 8 days). */
export const DEVICE_PASS_TTL_SECONDS = 7 * 24 * 60 * 60
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567"
export const SLOT_ID_LENGTH = 26

/** Lowercase RFC 4648 base32 without padding. */
export function base32(bytes: Uint8Array): string {
  let out = ""
  let buffer = 0
  let bits = 0
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(buffer >>> (bits - 5)) & 31]
      bits -= 5
    }
    buffer &= (1 << bits) - 1
  }
  if (bits > 0) out += BASE32[(buffer << (5 - bits)) & 31]
  return out
}

export function slotIdFor(publicKey: Uint8Array): string {
  return base32(createHash("sha256").update(publicKey).digest()).slice(0, SLOT_ID_LENGTH)
}

export function signedMessage(slotId: string, time: number): Buffer {
  return Buffer.from(`${SIGN_TAG}${slotId}${time}`, "utf8")
}

/** v2: `tag ‖ host ‖ "\n" ‖ slot ‖ time`, host lowercased as the relay sees it in its URL. */
export function signedMessageV2(host: string, slotId: string, time: number): Buffer {
  return Buffer.from(`${SIGN_TAG_V2}${host.toLowerCase()}\n${slotId}${time}`, "utf8")
}

export function identityFrom(privateKey: KeyObject): RelayIdentity {
  const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" })
  const publicKey = Buffer.from(spki.subarray(spki.byteLength - 32))
  const slotId = slotIdFor(publicKey)
  return {
    slotId,
    publicKey,
    sign(host, nowSeconds = Math.floor(Date.now() / 1000)) {
      const signature = sign(null, signedMessage(slotId, nowSeconds), privateKey)
      const signatureV2 = sign(null, signedMessageV2(host, slotId, nowSeconds), privateKey)
      return {
        "x-rudder-key": publicKey.toString("base64url"),
        "x-rudder-time": String(nowSeconds),
        "x-rudder-signature": signature.toString("base64url"),
        "x-rudder-signature-2": signatureV2.toString("base64url"),
      }
    },
    signPass(slot, device, exp) {
      const payload = Buffer.from(JSON.stringify({ slot, device, exp }), "utf8")
      const signature = sign(null, Buffer.concat([Buffer.from(PASS_TAG, "utf8"), payload]), privateKey)
      return `v1.${publicKey.toString("base64url")}.${payload.toString("base64url")}.${signature.toString("base64url")}`
    },
  }
}

/** Reads `RUDDER_HOME/relay-key.pem`, creating it (0600) on first use. The slot id follows the key for good. */
export function loadRelayIdentity(dataDir: string): RelayIdentity {
  const path = join(dataDir, KEY_FILE)
  if (existsSync(path)) {
    const key = createPrivateKey(readFileSync(path, "utf8"))
    if (key.asymmetricKeyType !== "ed25519") throw new Error(`${path} is not an Ed25519 key (${key.asymmetricKeyType})`)
    chmodSync(path, 0o600)
    return identityFrom(key)
  }
  const { privateKey } = generateKeyPairSync("ed25519")
  writeFileSync(path, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 })
  return identityFrom(privateKey)
}
