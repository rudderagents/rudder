import { X509Certificate, createHash, createPrivateKey, generateKeyPairSync } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { networkInterfaces } from "node:os"
import { join } from "node:path"
import { isWindows } from "./platform"
import { selfSignedCertificate } from "./platform/x509"

export const CERT_FILE = "rudderd-cert.pem"
export const KEY_FILE = "rudderd-key.pem"
const VALID_DAYS = 3650

export type TlsMaterial = {
  cert: string
  key: string
  /** SHA-256 of the certificate DER, 64 lowercase hex chars. This is the `fp=` value of the pair link. */
  fingerprint: string
  certPath: string
  keyPath: string
  created: boolean
}

export function certificateFingerprint(certPem: string): string {
  return createHash("sha256").update(new X509Certificate(certPem).raw).digest("hex")
}

export type CertificateOptions = {
  /**
   * `openssl` (macOS, Linux: the system's openssl, as before) or `builtin` (node:crypto only, platform/x509.ts).
   * Windows ships no openssl, so it defaults to builtin there.
   */
  generator?: "openssl" | "builtin"
  openssl?: string
  /** IP SANs besides 127.0.0.1; defaults to this machine's current LAN and Tailscale IPv4s. */
  sanIPs?: string[]
  /** DNS SANs besides localhost, such as the MagicDNS name. */
  sanNames?: string[]
}

/**
 * Loads the daemon's self-signed certificate from `dir`, creating an EC P-256 key and a 10-year
 * certificate on first use. The key file is kept at 0600. The phone pins the certificate itself,
 * so validity, SAN and hostname never matter to it (verified for LAN IPs and `*.ts.net` names);
 * the SAN only helps desktop tools, and an existing certificate is never reissued to add one.
 */
export function ensureTlsMaterial(dir: string, options: CertificateOptions = {}): TlsMaterial {
  const certPath = join(dir, CERT_FILE)
  const keyPath = join(dir, KEY_FILE)
  let created = false
  if (!existsSync(certPath) || !existsSync(keyPath)) {
    generateCertificate(dir, certPath, keyPath, options)
    created = true
  }
  if ((statSync(keyPath).mode & 0o077) !== 0) chmodSync(keyPath, 0o600)
  const cert = readFileSync(certPath, "utf8")
  const key = readFileSync(keyPath, "utf8")
  let x509: X509Certificate
  try {
    x509 = new X509Certificate(cert)
    if (!x509.checkPrivateKey(createPrivateKey(key))) throw new Error("private key does not match certificate")
  } catch (error) {
    throw new Error(
      `rudderd TLS material in ${dir} is unusable (${error instanceof Error ? error.message : String(error)}). ` +
        `Delete ${CERT_FILE} and ${KEY_FILE} to generate a new certificate; paired phones must then re-pair.`,
    )
  }
  const fingerprint = createHash("sha256").update(x509.raw).digest("hex")
  return { cert, key, fingerprint, certPath, keyPath, created }
}

function generateCertificate(dir: string, certPath: string, keyPath: string, options: CertificateOptions) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const openssl = options.openssl ?? (existsSync("/usr/bin/openssl") ? "/usr/bin/openssl" : "openssl")
  const { privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  })
  const keyTmp = `${keyPath}.tmp`
  const certTmp = `${certPath}.tmp`
  rmSync(keyTmp, { force: true })
  writeFileSync(keyTmp, privateKey, { mode: 0o600 })
  const ips = ["127.0.0.1", ...(options.sanIPs ?? hostCandidates().map((c) => c.address))]
  const names = ["localhost", ...(options.sanNames ?? [])]
  if ((options.generator ?? (isWindows() ? "builtin" : "openssl")) === "builtin") {
    const pem = selfSignedCertificate({
      privateKeyPem: privateKey,
      commonName: "rudderd",
      dnsNames: [...new Set(names)],
      ipAddresses: [...new Set(ips)],
      days: VALID_DAYS,
    })
    writeFileSync(certTmp, pem, { mode: 0o644 })
    renameSync(keyTmp, keyPath)
    renameSync(certTmp, certPath)
    return
  }
  const san = [...[...new Set(names)].map((name) => `DNS:${name}`), ...[...new Set(ips)].map((ip) => `IP:${ip}`)].join(",")
  const result = Bun.spawnSync([
    openssl, "req", "-new", "-x509", "-sha256",
    "-key", keyTmp, "-out", certTmp, "-days", String(VALID_DAYS),
    "-subj", "/CN=rudderd",
    "-addext", `subjectAltName=${san}`,
    // No keyUsage: without keyCertSign, desktop TLS stacks refuse the cert as its own trust anchor (curl --cacert).
    "-addext", "basicConstraints=critical,CA:FALSE",
  ], { stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0 || !existsSync(certTmp)) {
    rmSync(keyTmp, { force: true })
    rmSync(certTmp, { force: true })
    throw new Error(
      `rudderd could not create its TLS certificate with ${openssl} (exit ${result.exitCode}): ` +
        `${result.stderr.toString().trim() || "no output"}. Install openssl or set RUDDER_TLS=0 for local-only dev.`,
    )
  }
  renameSync(keyTmp, keyPath)
  renameSync(certTmp, certPath)
}

export type HostCandidate = { address: string; iface: string; kind: "lan" | "tailscale" }

type InterfaceMap = ReturnType<typeof networkInterfaces>

/** Non-loopback IPv4 addresses a phone could use to reach this machine, LAN (en*) first. */
export function hostCandidates(interfaces: InterfaceMap = networkInterfaces(), platform: NodeJS.Platform = process.platform): HostCandidate[] {
  const out: HostCandidate[] = []
  for (const [iface, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal || entry.address.startsWith("169.254.")) continue
      out.push({ address: entry.address, iface, kind: isTailscale(entry.address) ? "tailscale" : "lan" })
    }
  }
  // Windows names adapters "Wi-Fi", "Ethernet", "以太网"; its Hyper-V / WSL / VM host adapters carry private
  // addresses the phone cannot reach, so they go last among the LAN ones instead of first by chance.
  const virtual = (c: HostCandidate) => isWindows(platform) && /vethernet|hyper-v|wsl|virtualbox|vmware|vmnet|docker|loopback/i.test(c.iface)
  const rank = (c: HostCandidate) => (c.kind === "tailscale" ? 2 : c.iface.startsWith("en") ? 0 : virtual(c) ? 1.5 : 1)
  return out.sort((a, b) => rank(a) - rank(b))
}

/** The host to put in the pair link: the bind address, or for a wildcard bind the primary LAN IPv4. */
export function advertisedHost(bindHost: string, candidates: HostCandidate[] = hostCandidates()): string {
  if (bindHost !== "0.0.0.0" && bindHost !== "::") return bindHost
  return candidates[0]?.address ?? "127.0.0.1"
}

/**
 * The hosts written into the pair link, in the order the phone tries them: the advertised host (primary LAN
 * address, or the explicit bind), then the MagicDNS name when the daemon serves TLS on its tailnet address
 * (a wildcard or Tailscale bind). The first stays the link's first `host=`, which older apps read alone.
 * The tailnet IP itself is left out (iOS ATS refuses pinned self-signed TLS to it), also when it is the only address.
 */
export function linkHosts(bindHost: string, advertised: string, tailnetName: string | null, tls: boolean): string[] {
  const reachesTailnet = bindHost === "0.0.0.0" || bindHost === "::" || isTailscale(bindHost)
  if (!tls || !tailnetName || !reachesTailnet || tailnetName === advertised.toLowerCase()) return [advertised]
  return isTailscale(advertised) ? [tailnetName] : [advertised, tailnetName]
}

function isTailscale(address: string): boolean {
  const [a, b] = address.split(".").map(Number)
  return a === 100 && b >= 64 && b <= 127
}
