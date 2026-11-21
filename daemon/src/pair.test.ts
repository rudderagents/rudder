import { describe, expect, test } from "bun:test"
import { currentPairingToken, mintPairingToken, PAIRING_TTL_MS, pairUrl, redeemPairing } from "./pair"
import { Store } from "./store"

describe("pairing token", () => {
  test("a token lives for the TTL, then a fresh one is minted on demand", () => {
    const store = new Store(":memory:")
    const first = mintPairingToken(store, 1000)
    expect(first.expiresAt).toBe(1000 + PAIRING_TTL_MS)
    expect(currentPairingToken(store, 2000)).toEqual(first)
    const later = currentPairingToken(store, first.expiresAt)
    expect(later.token).not.toBe(first.token)
    expect(later.expiresAt).toBe(first.expiresAt + PAIRING_TTL_MS)
  })

  test("a token from before TTLs existed counts as expired", () => {
    const store = new Store(":memory:")
    store.setMeta("pairing_token", "legacy")
    expect(currentPairingToken(store).token).not.toBe("legacy")
    expect(() => redeemPairing(store, "legacy", "phone")).toThrow()
  })

  test("redeeming is single use: the token rotates on success", () => {
    const store = new Store(":memory:")
    const { token } = mintPairingToken(store)
    const device = redeemPairing(store, token, "phone")
    expect(device.sessionKey.length).toBe(64)
    expect(store.deviceByKey(device.sessionKey)?.name).toBe("phone")
    expect(currentPairingToken(store).token).not.toBe(token)
    expect(() => redeemPairing(store, token, "again")).toThrow("invalid pairing token")
  })

  test("wrong, short and expired tokens are refused with pair_invalid", () => {
    const store = new Store(":memory:")
    const { token, expiresAt } = mintPairingToken(store, 1000)
    for (const attempt of ["", "x", token.slice(0, -1), `${token}0`, token.toUpperCase() === token ? "0".repeat(32) : token.toUpperCase()]) {
      expect(() => redeemPairing(store, attempt, "phone", 2000)).toThrow(expect.objectContaining({ code: "pair_invalid" }))
    }
    expect(() => redeemPairing(store, token, "phone", expiresAt)).toThrow(expect.objectContaining({ code: "pair_invalid" }))
    expect(store.listDevices()).toHaveLength(0)
  })

  test("each host is its own host=, and a reader of the first host only still gets the primary", () => {
    const link = pairUrl(["10.0.0.5", "mac.tail1.ts.net"], 7749, "tok", "ab")
    expect(link).toBe("rudder://pair?host=10.0.0.5:7749&host=mac.tail1.ts.net:7749&fp=ab&token=tok")
    const query = new URL(link.replace("rudder://pair", "https://x/")).searchParams
    // What apps before multi-host links do: one value per name, the first one wins.
    expect(query.get("host")).toBe("10.0.0.5:7749")
    expect(query.getAll("host")).toEqual(["10.0.0.5:7749", "mac.tail1.ts.net:7749"])
    expect(query.get("fp")).toBe("ab")
    expect(query.get("token")).toBe("tok")
    expect(() => pairUrl([], 7749, "tok")).toThrow()
  })

  test("os names win32 or darwin before the token; other platforms leave it out", () => {
    expect(pairUrl("10.0.0.5", 7749, "tok", null, null, null, null, "win32")).toBe("rudder://pair?host=10.0.0.5:7749&os=win32&token=tok")
    expect(pairUrl("10.0.0.5", 7749, null, "ab", null, null, null, "darwin")).toBe("rudder://pair?host=10.0.0.5:7749&fp=ab&os=darwin")
    expect(pairUrl("10.0.0.5", 7749, "tok", null, null, null, null, "linux")).toBe("rudder://pair?host=10.0.0.5:7749&token=tok")
  })

  test("a link can be printed without its token", () => {
    expect(pairUrl("10.0.0.5", 7749, null, "ab")).toBe("rudder://pair?host=10.0.0.5:7749&fp=ab")
    expect(pairUrl("10.0.0.5", 7749, "tok")).toBe("rudder://pair?host=10.0.0.5:7749&token=tok")
  })

  test("exp is unix seconds, redacted keeps it, and a first-host reader still gets the primary", () => {
    const expiresAt = 1_700_000_123_456
    const link = pairUrl(["10.0.0.5", "mac.tail1.ts.net"], 7749, "tok", "ab", expiresAt)
    const redacted = pairUrl(["10.0.0.5", "mac.tail1.ts.net"], 7749, null, "ab", expiresAt)
    expect(link).toBe("rudder://pair?host=10.0.0.5:7749&host=mac.tail1.ts.net:7749&fp=ab&exp=1700000123&token=tok")
    expect(redacted).toBe("rudder://pair?host=10.0.0.5:7749&host=mac.tail1.ts.net:7749&fp=ab&exp=1700000123")
    const query = new URL(link.replace("rudder://pair", "https://x/")).searchParams
    expect(query.get("host")).toBe("10.0.0.5:7749")
    expect(query.getAll("host")).toEqual(["10.0.0.5:7749", "mac.tail1.ts.net:7749"])
    expect(query.get("exp")).toBe("1700000123")
    expect(query.get("token")).toBe("tok")
  })
})
