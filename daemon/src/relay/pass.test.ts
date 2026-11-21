import { existsSync, readFileSync } from "node:fs"
import { createPrivateKey, generateKeyPairSync } from "node:crypto"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import vector from "./fixtures/pass-vector.json"
import { pairUrl } from "../pair"
import { identityFrom } from "./identity"

const MONOREPO_PASS = join(import.meta.dir, "../../../relay/src/pass.ts")
const LOCAL_PASS = join(import.meta.dir, "fixtures/verify-pass.ts")
// Local copy of relay/src/pass.ts, so this suite passes in the public daemon-only repo. Imported by path so tsc
// does not typecheck the relay's copy against this package's lib.
const { verifyPass } = (await import(LOCAL_PASS)) as { verifyPass: (pass: string, slot: string, device: string, nowSec: number) => Promise<boolean> }

// the relay slot pass notes: rudderd signs, the relay checks. The vector is a test-only key, also copied here.
describe("slot pass", () => {
  const key = createPrivateKey({ key: Buffer.from(vector.privateKeyPkcs8, "base64"), format: "der", type: "pkcs8" })
  const id = identityFrom(key)

  test("rudderd signs the shared vector byte for byte", () => {
    expect(id.slotId).toBe(vector.slot)
    expect(id.signPass(vector.slot, vector.device, vector.exp)).toBe(vector.devicePass)
    expect(id.signPass(vector.slot, "", vector.exp)).toBe(vector.pairingPass)
  })

  test("a fresh key's passes pass the relay's own check, only for the slot and device they name", async () => {
    const fresh = identityFrom(generateKeyPairSync("ed25519").privateKey)
    const now = Math.floor(Date.now() / 1000)
    const pass = fresh.signPass(fresh.slotId, "dev-1", now + 7 * 86_400)
    expect(await verifyPass(pass, fresh.slotId, "dev-1", now)).toBe(true)
    expect(await verifyPass(pass, fresh.slotId, "dev-2", now)).toBe(false)
    expect(await verifyPass(pass, id.slotId, "dev-1", now)).toBe(false)
  })

  test("the pair link carries the pass before the token, only with a relay slot", () => {
    expect(pairUrl("10.0.0.5", 7749, "tok", "ab", null, "slot", null, null, "v1.k.p.s")).toBe(
      "rudder://pair?host=10.0.0.5:7749&fp=ab&relay=slot&pass=v1.k.p.s&token=tok",
    )
    expect(pairUrl("10.0.0.5", 7749, "tok", "ab", null, null, null, null, "v1.k.p.s")).toBe("rudder://pair?host=10.0.0.5:7749&fp=ab&token=tok")
  })

  const hasRelay = existsSync(MONOREPO_PASS)
  test.skipIf(!hasRelay)("the local verifyPass fixture matches the monorepo relay/src/pass.ts", () => {
    expect(readFileSync(LOCAL_PASS, "utf8")).toBe(readFileSync(MONOREPO_PASS, "utf8"))
    expect(readFileSync(join(import.meta.dir, "fixtures/bytes.ts"), "utf8")).toBe(
      readFileSync(join(import.meta.dir, "../../../relay/src/bytes.ts"), "utf8"),
    )
  })
})
