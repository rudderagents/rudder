import { describe, expect, test } from "bun:test"
import { resolveTailnetName, TailnetName } from "./tailnet"
import type { HostCandidate } from "./tls"

const LAN: HostCandidate = { address: "192.168.1.23", iface: "en0", kind: "lan" }
const TAILNET: HostCandidate = { address: "100.101.7.9", iface: "utun4", kind: "tailscale" }

describe("MagicDNS name", () => {
  test("reverse-resolves the Tailscale address and keeps the ts.net name without its dot", async () => {
    const asked: string[] = []
    const name = await resolveTailnetName([LAN, TAILNET], async (address) => {
      asked.push(address)
      return ["Mac-Studio.tail1234ab.ts.net."]
    })
    expect(asked).toEqual(["100.101.7.9"])
    expect(name).toBe("mac-studio.tail1234ab.ts.net")
  })

  test("no Tailscale address, no ts.net answer, or no answer at all means no name", async () => {
    expect(await resolveTailnetName([LAN], async () => ["x.ts.net"])).toBeNull()
    expect(await resolveTailnetName([TAILNET], async () => ["mac.example.com"])).toBeNull()
    expect(await resolveTailnetName([TAILNET], async () => Promise.reject(new Error("ETIMEOUT")))).toBeNull()
  })

  test("the cache holds the last answer until the next refresh", async () => {
    let answer: string | null = "a.tail1.ts.net"
    const tailnet = new TailnetName(async () => answer)
    expect(tailnet.current).toBeNull()
    await tailnet.refresh()
    expect(tailnet.current).toBe("a.tail1.ts.net")
    answer = null
    await tailnet.refresh()
    expect(tailnet.current).toBeNull()
  })
})
