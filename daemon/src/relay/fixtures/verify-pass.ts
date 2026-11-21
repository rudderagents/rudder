/**
 * Slot pass: a rudderd signs, with its relay key, a pass a phone sends as
 * `X-Rudder-Pass` on `/v1/phone`. A valid pass only ranks the phone with the proven ones in the waiting pool (audit
 * #20); it opens nothing by itself. Checked statelessly: the pass carries the public key, the slot is its hash.
 *
 *   v1.<base64url public key>.<base64url payload>.<base64url signature>
 *   payload   = JSON {"slot": slotId, "device": deviceId or "", "exp": unix seconds}
 *   signature = Ed25519("rudder-relay-pass/1" ‖ payload bytes)
 */
import { base64UrlDecode, concat, fromUtf8, slotIdFor, utf8 } from "./bytes"

export const PASS_SIGNATURE_TAG = "rudder-relay-pass/1"
export const PASS_HEADER = "x-rudder-pass"
/** A pass that claims to live longer than this is ignored (device passes are signed for 7 days). */
export const PASS_MAX_SECONDS = 8 * 24 * 60 * 60

/**
 * Whether `header` is a pass for `slot` and `device` (`""` = a pairing pass, for a connect without `device`) that has
 * not expired. Anything malformed is just "no pass": the connection is then treated as before.
 */
export async function verifyPass(header: string | null, slot: string, device: string, nowSec: number): Promise<boolean> {
  if (!header || header.length > 1024) return false
  const parts = header.split(".")
  if (parts.length !== 4 || parts[0] !== "v1") return false
  const key = base64UrlDecode(parts[1]!)
  const payload = base64UrlDecode(parts[2]!)
  const signature = base64UrlDecode(parts[3]!)
  if (!key || key.byteLength !== 32 || !payload || !signature || signature.byteLength !== 64) return false
  let claims: unknown
  try {
    claims = JSON.parse(fromUtf8.decode(payload))
  } catch {
    return false
  }
  if (typeof claims !== "object" || claims === null) return false
  const { slot: passSlot, device: passDevice, exp } = claims as Record<string, unknown>
  if (passSlot !== slot || passDevice !== device) return false
  if (typeof exp !== "number" || !Number.isSafeInteger(exp) || exp <= nowSec || exp - nowSec > PASS_MAX_SECONDS) return false
  if ((await slotIdFor(key)) !== slot) return false
  try {
    const publicKey = await crypto.subtle.importKey("raw", key, { name: "Ed25519" }, false, ["verify"])
    return await crypto.subtle.verify({ name: "Ed25519" }, publicKey, signature, concat(utf8.encode(PASS_SIGNATURE_TAG), payload))
  } catch {
    return false
  }
}
