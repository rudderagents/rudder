import { afterEach, describe, expect, test } from "bun:test"
import { createPrivateKey, generateKeyPairSync, X509Certificate } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { connect } from "node:tls"
import { terminalLocale } from "../qr"
import { certificateFingerprint, ensureTlsMaterial, hostCandidates } from "../tls"
import { selfSignedCertificate } from "./x509"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function key(): string {
  return generateKeyPairSync("ec", { namedCurve: "prime256v1", privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } })
    .privateKey
}

describe("built-in self-signed certificate", () => {
  test("has what openssl writes for rudderd: CN, SANs, CA:FALSE, P-256 + SHA-256, ten years, self-signed", () => {
    const privateKeyPem = key()
    const now = new Date("2026-10-30T01:00:00Z")
    const pem = selfSignedCertificate({
      privateKeyPem,
      commonName: "rudderd",
      dnsNames: ["localhost", "pc.example.ts.net"],
      ipAddresses: ["127.0.0.1", "192.168.1.23"],
      days: 3650,
      now,
    })
    const cert = new X509Certificate(pem)
    expect(cert.subject).toBe("CN=rudderd")
    expect(cert.issuer).toBe("CN=rudderd")
    expect(cert.subjectAltName).toBe("DNS:localhost, DNS:pc.example.ts.net, IP Address:127.0.0.1, IP Address:192.168.1.23")
    expect(cert.ca).toBe(false)
    expect(cert.checkPrivateKey(createPrivateKey(privateKeyPem))).toBe(true)
    expect(cert.verify(cert.publicKey)).toBe(true)
    expect(cert.publicKey.asymmetricKeyDetails?.namedCurve).toBe("prime256v1")
    expect(new Date(cert.validFrom).toISOString()).toBe("2026-10-30T00:59:00.000Z")
    expect(new Date(cert.validTo).getTime() - new Date(cert.validFrom).getTime()).toBe(3650 * 86_400_000)
    expect(cert.serialNumber).toMatch(/^[0-7][0-9A-F]{31}$/)
  })

  test("a validity past 2049 is written as GeneralizedTime and still parses", () => {
    const cert = new X509Certificate(
      selfSignedCertificate({ privateKeyPem: key(), commonName: "rudderd", dnsNames: ["localhost"], ipAddresses: [], days: 40 * 365, now: new Date("2026-01-01T00:00:00Z") }),
    )
    expect(new Date(cert.validTo).getUTCFullYear()).toBe(2065)
  })

  test("refuses an address that is not IPv4", () => {
    expect(() => selfSignedCertificate({ privateKeyPem: key(), commonName: "rudderd", dnsNames: [], ipAddresses: ["::1"], days: 1 })).toThrow("not an IPv4")
  })

  test.skipIf(!existsSync("/usr/bin/openssl"))("openssl reads it back with the same extensions", () => {
    const dir = mkdtempSync(join(tmpdir(), "rudder-x509-"))
    dirs.push(dir)
    const file = join(dir, "cert.pem")
    writeFileSync(file, selfSignedCertificate({ privateKeyPem: key(), commonName: "rudderd", dnsNames: ["localhost"], ipAddresses: ["127.0.0.1"], days: 10 }))
    const result = Bun.spawnSync(["/usr/bin/openssl", "x509", "-in", file, "-noout", "-text"])
    expect(result.exitCode).toBe(0)
    const text = result.stdout.toString()
    expect(text).toContain("X509v3 Basic Constraints: critical")
    expect(text).toContain("CA:FALSE")
    expect(text).toContain("DNS:localhost, IP Address:127.0.0.1")
    expect(text).toContain("ecdsa-with-SHA256")
    expect(text).toContain("X509v3 Subject Key Identifier")
  })

  test("ensureTlsMaterial with the builtin generator serves TLS whose peer certificate has the pinned fingerprint", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rudder-x509-"))
    dirs.push(dir)
    const material = ensureTlsMaterial(dir, { generator: "builtin", sanIPs: ["10.0.0.2"], sanNames: ["pc.example.ts.net"] })
    expect(material.created).toBe(true)
    expect(material.fingerprint).toBe(certificateFingerprint(readFileSync(material.certPath, "utf8")))
    expect(new X509Certificate(material.cert).subjectAltName).toBe("DNS:localhost, DNS:pc.example.ts.net, IP Address:127.0.0.1, IP Address:10.0.0.2")
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { cert: material.cert, key: material.key }, fetch: () => new Response("ok") })
    try {
      const fingerprint = await new Promise<string>((resolve, reject) => {
        const socket = connect({ host: "127.0.0.1", port: server.port!, rejectUnauthorized: false }, () => {
          const cert = socket.getPeerX509Certificate()
          socket.end()
          resolve(cert ? certificateFingerprint(cert.toString()) : "")
        })
        socket.on("error", reject)
      })
      expect(fingerprint).toBe(material.fingerprint)
    } finally {
      server.stop(true)
    }
    // Reused, not regenerated, on the next start.
    expect(ensureTlsMaterial(dir, { generator: "builtin" }).created).toBe(false)
  })
})

describe("Windows terminal and network details", () => {
  test("with no LANG, Windows follows the display language; macOS stays English", () => {
    expect(terminalLocale({}, "win32", () => "zh-CN")).toBe("zh")
    expect(terminalLocale({}, "win32", () => "en-US")).toBe("en")
    expect(terminalLocale({ LANG: "en_US.UTF-8" }, "win32", () => "zh-CN")).toBe("en")
    expect(terminalLocale({}, "darwin", () => "zh-CN")).toBe("en")
  })

  const entry = (address: string) => ({ address, family: "IPv4" as const, internal: false, netmask: "255.255.255.0", mac: "00:00:00:00:00:00", cidr: null })
  const windowsInterfaces = {
    "vEthernet (WSL (Hyper-V firewall))": [entry("172.29.160.1")],
    "以太网": [entry("192.168.1.23")],
    Tailscale: [entry("100.101.102.103")],
  }

  test("Windows puts the Hyper-V / WSL adapter after the real one, so the pair link leads with the LAN", () => {
    expect(hostCandidates(windowsInterfaces, "win32").map((candidate) => candidate.iface)).toEqual([
      "以太网",
      "vEthernet (WSL (Hyper-V firewall))",
      "Tailscale",
    ])
    // macOS order is untouched.
    expect(hostCandidates(windowsInterfaces, "darwin").map((candidate) => candidate.iface)).toEqual([
      "vEthernet (WSL (Hyper-V firewall))",
      "以太网",
      "Tailscale",
    ])
  })
})
