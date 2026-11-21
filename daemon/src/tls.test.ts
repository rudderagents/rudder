import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { connect } from "node:tls"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { invokeFrame } from "./protocol"
import { startServer } from "./server"
import { Store } from "./store"
import { X509Certificate } from "node:crypto"
import { CERT_FILE, KEY_FILE, advertisedHost, certificateFingerprint, ensureTlsMaterial, hostCandidates, linkHosts } from "./tls"

// The link names the platform it was printed on (win32 / darwin only).
const OS = process.platform === "win32" || process.platform === "darwin" ? `&os=${process.platform}` : ""

function scratch() {
  return mkdtempSync(join(tmpdir(), "rudder-tls-"))
}

function peerFingerprint(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port, rejectUnauthorized: false }, () => {
      const raw = socket.getPeerCertificate().raw
      socket.end()
      resolve(createHash("sha256").update(raw).digest("hex"))
    })
    socket.on("error", reject)
  })
}

describe("self-signed certificate", () => {
  test("is created once with a 0600 key and reused", () => {
    const dir = scratch()
    try {
      const first = ensureTlsMaterial(dir, { sanIPs: [] })
      expect(first.created).toBe(true)
      expect(first.fingerprint).toMatch(/^[0-9a-f]{64}$/)
      expect(first.fingerprint).toBe(certificateFingerprint(first.cert))
      expect(statSync(join(dir, KEY_FILE)).mode & 0o777).toBe(0o600)
      const second = ensureTlsMaterial(dir, { sanIPs: [] })
      expect(second.created).toBe(false)
      expect(second.fingerprint).toBe(first.fingerprint)
      expect(second.cert).toBe(first.cert)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a deleted certificate yields a new fingerprint", () => {
    const dir = scratch()
    try {
      const first = ensureTlsMaterial(dir, { sanIPs: [] })
      rmSync(join(dir, CERT_FILE))
      const second = ensureTlsMaterial(dir, { sanIPs: [] })
      expect(second.created).toBe(true)
      expect(second.fingerprint).not.toBe(first.fingerprint)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("corrupt material fails loudly instead of rotating the pin", () => {
    const dir = scratch()
    try {
      ensureTlsMaterial(dir, { sanIPs: [] })
      writeFileSync(join(dir, CERT_FILE), "not a certificate")
      expect(() => ensureTlsMaterial(dir, { sanIPs: [] })).toThrow(/re-pair/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("certificate names", () => {
  test("a new certificate names the MagicDNS host and the given IPs", () => {
    const dir = scratch()
    try {
      const tls = ensureTlsMaterial(dir, { sanIPs: ["10.0.0.5", "100.101.7.9"], sanNames: ["mac.tail1.ts.net"] })
      expect(new X509Certificate(tls.cert).subjectAltName).toBe(
        "DNS:localhost, DNS:mac.tail1.ts.net, IP Address:127.0.0.1, IP Address:10.0.0.5, IP Address:100.101.7.9",
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("an existing certificate is never reissued to add a name: that would break every pin", () => {
    const dir = scratch()
    try {
      const first = ensureTlsMaterial(dir, { sanIPs: [] })
      const second = ensureTlsMaterial(dir, { sanIPs: [], sanNames: ["mac.tail1.ts.net"] })
      expect(second.fingerprint).toBe(first.fingerprint)
      expect(second.created).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("TLS server", () => {
  test("serves the pinned certificate for /pair and wss, link carries fp", async () => {
    const dir = scratch()
    const store = new Store(":memory:")
    store.seedIfEmpty()
    const tls = ensureTlsMaterial(dir, { sanIPs: [] })
    const started = startServer({ store, host: "127.0.0.1", port: 0, tls })
    try {
      const port = started.server.port!
      expect(await peerFingerprint(port)).toBe(tls.fingerprint)
      const link = started.pairLink()
      const exp = Math.floor(link.expiresAt / 1000)
      expect(link.url).toBe(`rudder://pair?host=127.0.0.1:${port}&fp=${tls.fingerprint}&exp=${exp}${OS}&token=${link.token}`)

      // The system trust store does not know this certificate.
      expect(fetch(`https://127.0.0.1:${port}/health`)).rejects.toThrow()

      const origin = `https://127.0.0.1:${port}`
      const trust = { tls: { ca: tls.cert } }
      const info = started.pairLink()
      expect(started.fingerprint).toBe(tls.fingerprint)
      expect(info.url).toContain(`fp=${tls.fingerprint}`)

      const paired = await (await fetch(`${origin}/v1/pair`, {
        ...trust,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: info.token, name: "tls-test" }),
      })).json() as { sessionKey: string }
      expect(paired.sessionKey.length).toBeGreaterThan(10)

      const ws = new WebSocket(`wss://127.0.0.1:${port}/v1/ws`, {
        headers: { authorization: `Bearer ${paired.sessionKey}` },
        tls: { ca: tls.cert },
      } as unknown as string[])
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve())
        ws.addEventListener("error", () => reject(new Error("wss error")))
      })
      const listed = await new Promise<Record<string, unknown>>((resolve) => {
        ws.addEventListener("message", (event) => resolve(JSON.parse(String(event.data)) as Record<string, unknown>))
        ws.send(JSON.stringify(invokeFrame("list-1", "session.list", {})))
      })
      expect(listed.type).toBe("result")
      ws.close()
    } finally {
      started.server.stop(true)
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("multi-host pair link", () => {
  test("the pair link lists LAN then MagicDNS, and the MagicDNS Host is accepted", async () => {
    const dir = scratch()
    const store = new Store(":memory:")
    const tls = ensureTlsMaterial(dir, { sanIPs: [] })
    let name: string | null = "mac.tail1.ts.net"
    const started = startServer({ store, host: "0.0.0.0", port: 0, tls, advertiseHost: "10.9.8.7", tailnetName: () => name })
    try {
      const port = started.server.port!
      const origin = `https://127.0.0.1:${port}`
      const trust = { tls: { ca: tls.cert } }
      const info = started.pairLink()
      expect(info.hosts).toEqual(["10.9.8.7", "mac.tail1.ts.net"])
      const exp = Math.floor(info.expiresAt / 1000)
      expect(info.url).toBe(
        `rudder://pair?host=10.9.8.7:${port}&host=mac.tail1.ts.net:${port}&fp=${tls.fingerprint}&exp=${exp}${OS}&token=${info.token}`,
      )

      const viaName = await fetch(`${origin}/health`, { ...trust, headers: { host: `mac.tail1.ts.net:${port}` } })
      expect(viaName.status).toBe(200)
      const otherNode = await fetch(`${origin}/health`, { ...trust, headers: { host: `printer.tail1.ts.net:${port}` } })
      expect(otherNode.status).toBe(403)

      // Tailscale went away: the next link is LAN only and the old name is no longer a valid Host.
      name = null
      expect(started.pairLink().hosts).toEqual(["10.9.8.7"])
      const stale = await fetch(`${origin}/health`, { ...trust, headers: { host: `mac.tail1.ts.net:${port}` } })
      expect(stale.status).toBe(403)
    } finally {
      started.server.stop(true)
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("advertised host", () => {
  const interfaces = {
    lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
    utun4: [{ address: "100.101.7.9", family: "IPv4", internal: false }],
    bridge0: [{ address: "192.168.64.1", family: "IPv4", internal: false }],
    en0: [
      { address: "fe80::1", family: "IPv6", internal: false },
      { address: "192.168.1.23", family: "IPv4", internal: false },
    ],
    en7: [{ address: "169.254.3.3", family: "IPv4", internal: false }],
  } as unknown as Parameters<typeof hostCandidates>[0]

  test("lists LAN first and flags Tailscale", () => {
    expect(hostCandidates(interfaces)).toEqual([
      { address: "192.168.1.23", iface: "en0", kind: "lan" },
      { address: "192.168.64.1", iface: "bridge0", kind: "lan" },
      { address: "100.101.7.9", iface: "utun4", kind: "tailscale" },
    ])
  })

  test("wildcard bind advertises the primary LAN address, explicit binds stay", () => {
    const candidates = hostCandidates(interfaces)
    expect(advertisedHost("0.0.0.0", candidates)).toBe("192.168.1.23")
    expect(advertisedHost("127.0.0.1", candidates)).toBe("127.0.0.1")
    expect(advertisedHost("100.101.7.9", candidates)).toBe("100.101.7.9")
    expect(advertisedHost("0.0.0.0", [])).toBe("127.0.0.1")
  })

  test("pair link hosts: LAN first, then MagicDNS, only over TLS on a tailnet-reachable bind", () => {
    const name = "mac.tail1.ts.net"
    expect(linkHosts("0.0.0.0", "192.168.1.23", name, true)).toEqual(["192.168.1.23", name])
    expect(linkHosts("::", "192.168.1.23", name, true)).toEqual(["192.168.1.23", name])
    expect(linkHosts("0.0.0.0", "192.168.1.23", null, true)).toEqual(["192.168.1.23"])
    expect(linkHosts("0.0.0.0", "192.168.1.23", name, false)).toEqual(["192.168.1.23"])
    // A LAN- or loopback-only bind does not listen on the tailnet address the name resolves to.
    expect(linkHosts("192.168.1.23", "192.168.1.23", name, true)).toEqual(["192.168.1.23"])
    expect(linkHosts("127.0.0.1", "127.0.0.1", name, true)).toEqual(["127.0.0.1"])
    // The tailnet IP never goes in the link: the app could not use it (ATS).
    expect(linkHosts("100.101.7.9", "100.101.7.9", name, true)).toEqual([name])
    expect(linkHosts("0.0.0.0", "100.101.7.9", name, true)).toEqual([name])
    expect(linkHosts("0.0.0.0", name, name, true)).toEqual([name])
  })
})
