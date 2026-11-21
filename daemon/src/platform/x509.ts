// A self-signed X.509 v3 certificate built with node:crypto alone, for Windows, which ships no openssl
// (the Windows notes). The same content `openssl req -x509` writes for rudderd (tls.ts): CN=rudderd,
// the given SANs, basicConstraints critical CA:FALSE, no keyUsage, ECDSA P-256 with SHA-256. The phone pins the
// certificate's SHA-256, so nothing about its fields has to match openssl byte for byte.
import { createHash, createPrivateKey, createPublicKey, randomBytes, sign } from "node:crypto"
import { isIPv4 } from "node:net"

function length(size: number): Buffer {
  if (size < 0x80) return Buffer.from([size])
  const bytes: number[] = []
  for (let rest = size; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest & 0xff)
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

function tlv(tag: number, ...content: Buffer[]): Buffer {
  const body = Buffer.concat(content)
  return Buffer.concat([Buffer.from([tag]), length(body.length), body])
}

const sequence = (...items: Buffer[]) => tlv(0x30, ...items)
const set = (...items: Buffer[]) => tlv(0x31, ...items)
const octets = (bytes: Buffer) => tlv(0x04, bytes)
const explicit = (index: number, item: Buffer) => tlv(0xa0 + index, item)

function integer(bytes: Buffer): Buffer {
  let start = 0
  while (start < bytes.length - 1 && bytes[start] === 0) start++
  const trimmed = bytes.subarray(start)
  // A leading 1 bit would make it negative.
  return tlv(0x02, (trimmed[0]! & 0x80) !== 0 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed)
}

function oid(dotted: string): Buffer {
  const parts = dotted.split(".").map(Number)
  const bytes = [parts[0]! * 40 + parts[1]!]
  for (const part of parts.slice(2)) {
    const chunk: number[] = [part & 0x7f]
    for (let rest = Math.floor(part / 128); rest > 0; rest = Math.floor(rest / 128)) chunk.unshift((rest & 0x7f) | 0x80)
    bytes.push(...chunk)
  }
  return tlv(0x06, Buffer.from(bytes))
}

/** UTCTime until 2049, GeneralizedTime from 2050 (RFC 5280 §4.1.2.5). */
function time(at: Date): Buffer {
  const iso = at.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:T]/g, "")
  return at.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(iso.slice(2), "ascii")) : tlv(0x18, Buffer.from(iso, "ascii"))
}

const ECDSA_WITH_SHA256 = sequence(oid("1.2.840.10045.4.3.2"))

export type SelfSignedOptions = {
  /** PKCS#8 PEM of an EC P-256 key. */
  privateKeyPem: string
  commonName: string
  dnsNames: string[]
  ipAddresses: string[]
  days: number
  now?: Date
  serial?: Buffer
}

export function selfSignedCertificate(options: SelfSignedOptions): string {
  const key = createPrivateKey(options.privateKeyPem)
  const spki = createPublicKey(key).export({ type: "spki", format: "der" })
  const now = options.now ?? new Date()
  // Backdated a minute so a phone whose clock is a little behind does not see it as not yet valid.
  const notBefore = new Date(Math.floor(now.getTime() / 1000) * 1000 - 60_000)
  const notAfter = new Date(notBefore.getTime() + options.days * 86_400_000)
  const name = sequence(set(sequence(oid("2.5.4.3"), tlv(0x0c, Buffer.from(options.commonName, "utf8")))))
  const names = [
    ...options.dnsNames.map((dns) => tlv(0x82, Buffer.from(dns, "ascii"))),
    ...options.ipAddresses.map((ip) => {
      if (!isIPv4(ip)) throw new Error(`not an IPv4 address: ${ip}`)
      return tlv(0x87, Buffer.from(ip.split(".").map(Number)))
    }),
  ]
  const extensions = explicit(
    3,
    sequence(
      sequence(oid("2.5.29.17"), octets(sequence(...names))),
      sequence(oid("2.5.29.19"), tlv(0x01, Buffer.from([0xff])), octets(sequence())),
      // subjectKeyIdentifier, as openssl adds: SHA-1 of the public key bits.
      sequence(oid("2.5.29.14"), octets(octets(createHash("sha1").update(spki.subarray(spki.length - 65)).digest()))),
    ),
  )
  const serial = options.serial ?? randomBytes(16)
  serial[0]! &= 0x7f
  const tbs = sequence(
    explicit(0, integer(Buffer.from([2]))),
    integer(serial),
    ECDSA_WITH_SHA256,
    name,
    sequence(time(notBefore), time(notAfter)),
    name,
    spki,
    extensions,
  )
  const signature = sign("sha256", tbs, key)
  const der = sequence(tbs, ECDSA_WITH_SHA256, tlv(0x03, Buffer.from([0]), signature))
  const base64 = der.toString("base64").match(/.{1,64}/g)!.join("\n")
  return `-----BEGIN CERTIFICATE-----\n${base64}\n-----END CERTIFICATE-----\n`
}
