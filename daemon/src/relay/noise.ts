import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
} from "node:crypto"

/**
 * Noise NNpsk0 (the relay design notes). Bun's node:crypto has no chacha20-poly1305 (spike S3), so the cipher is AES-256-GCM, which CryptoKit has as well.
 *
 *   -> psk, e
 *   <- e, ee
 */
export const NOISE_PROTOCOL = "Noise_NNpsk0_25519_AESGCM_SHA256"
const DH_LEN = 32
const HASH_LEN = 32
const TAG_LEN = 16
/** Noise caps a message at 65,535 bytes, tag included. */
export const NOISE_MAX_MESSAGE = 65_535

const PSK_INFO = "rudder relay v1"
const PAIR_PSK_INFO = "rudder relay pair v1"
const PROLOGUE_TAG = "rudder-relay/1"

/** PSK for a paired device: HKDF-SHA256 over its 32-byte session key, separate from the push key. */
export function relayPsk(sessionKeyHex: string): Buffer {
  const ikm = Buffer.from(sessionKeyHex, "hex")
  if (ikm.byteLength !== 32) throw new Error(`session key must be 32 bytes of hex, got ${ikm.byteLength} bytes`)
  return Buffer.from(hkdfSync("sha256", ikm, Buffer.alloc(0), PSK_INFO, 32))
}

/** PSK for pairing over the relay: HKDF-SHA256 over the 16-byte pairing token that only the QR code carries. */
export function pairingPsk(tokenHex: string): Buffer {
  const ikm = Buffer.from(tokenHex, "hex")
  if (ikm.byteLength !== 16) throw new Error(`pairing token must be 16 bytes of hex, got ${ikm.byteLength} bytes`)
  return Buffer.from(hkdfSync("sha256", ikm, Buffer.alloc(0), PAIR_PSK_INFO, 32))
}

/** `"rudder-relay/1" ‖ slotId ‖ deviceId`, deviceId empty while pairing: binds a handshake to one slot and device. */
export function relayPrologue(slotId: string, deviceId: string): Buffer {
  return Buffer.from(`${PROLOGUE_TAG}${slotId}${deviceId}`, "utf8")
}

const X25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex")
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex")

type KeyPair = { privateKey: KeyObject; publicKey: Buffer }

function keyPairFrom(secret?: Buffer): KeyPair {
  const privateKey = secret
    ? createPrivateKey({ key: Buffer.concat([X25519_PKCS8_PREFIX, secret]), format: "der", type: "pkcs8" })
    : generateKeyPairSync("x25519").privateKey
  const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" })
  return { privateKey, publicKey: Buffer.from(spki.subarray(spki.byteLength - DH_LEN)) }
}

function dh(own: KeyPair, remotePublic: Buffer): Buffer {
  const publicKey = createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, remotePublic]), format: "der", type: "spki" })
  return diffieHellman({ privateKey: own.privateKey, publicKey })
}

function sha256(...parts: Buffer[]): Buffer {
  const hash = createHash("sha256")
  for (const part of parts) hash.update(part)
  return hash.digest()
}

function hmac(key: Buffer, ...parts: Buffer[]): Buffer {
  const mac = createHmac("sha256", key)
  for (const part of parts) mac.update(part)
  return mac.digest()
}

/** Noise HKDF: two or three 32-byte outputs chained from HMAC-SHA256. */
function noiseHkdf(chainingKey: Buffer, ikm: Buffer, outputs: 2 | 3): Buffer[] {
  const temp = hmac(chainingKey, ikm)
  const out1 = hmac(temp, Buffer.from([1]))
  const out2 = hmac(temp, out1, Buffer.from([2]))
  if (outputs === 2) return [out1, out2]
  return [out1, out2, hmac(temp, out2, Buffer.from([3]))]
}

/** AESGCM nonce: 32 zero bits, then the counter as a 64-bit big-endian integer. */
function gcmNonce(n: bigint): Buffer {
  const nonce = Buffer.alloc(12)
  nonce.writeBigUInt64BE(n, 4)
  return nonce
}

export class NoiseError extends Error {}

/** One direction of an established channel, or the handshake's key: a key and a strictly increasing nonce. */
export class CipherState {
  private key: Buffer | null = null
  private nonce = 0n

  get hasKey(): boolean {
    return this.key !== null
  }

  initializeKey(key: Buffer | null): void {
    this.key = key
    this.nonce = 0n
  }

  encrypt(ad: Buffer, plaintext: Buffer): Buffer {
    if (!this.key) return plaintext
    if (this.nonce === 0xffff_ffff_ffff_ffffn) throw new NoiseError("nonce exhausted")
    const cipher = createCipheriv("aes-256-gcm", this.key, gcmNonce(this.nonce))
    cipher.setAAD(ad)
    const sealed = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
    this.nonce += 1n
    return sealed
  }

  /** A message that fails to open leaves the nonce where it was; the caller drops the connection. */
  decrypt(ad: Buffer, ciphertext: Buffer): Buffer {
    if (!this.key) return ciphertext
    if (ciphertext.byteLength < TAG_LEN) throw new NoiseError("message shorter than its tag")
    const decipher = createDecipheriv("aes-256-gcm", this.key, gcmNonce(this.nonce))
    decipher.setAAD(ad)
    decipher.setAuthTag(ciphertext.subarray(ciphertext.byteLength - TAG_LEN))
    let opened: Buffer
    try {
      opened = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.byteLength - TAG_LEN)), decipher.final()])
    } catch {
      throw new NoiseError("message did not authenticate")
    }
    this.nonce += 1n
    return opened
  }
}

export type HandshakeRole = "initiator" | "responder"

export type HandshakeOptions = {
  psk: Buffer
  prologue: Buffer
  /** Fixed ephemeral secret, for test vectors only. */
  ephemeral?: Buffer
}

export type Channel = { send: CipherState; receive: CipherState; handshakeHash: Buffer }

/** The two-message NNpsk0 handshake. The phone is the initiator, rudderd the responder. */
export class NoiseHandshake {
  private readonly cipher = new CipherState()
  private chainingKey: Buffer
  private hash: Buffer
  private readonly psk: Buffer
  private readonly ephemeral: KeyPair
  private remoteEphemeral: Buffer | null = null
  private step = 0

  constructor(
    readonly role: HandshakeRole,
    options: HandshakeOptions,
  ) {
    if (options.psk.byteLength !== 32) throw new NoiseError("psk must be 32 bytes")
    const name = Buffer.from(NOISE_PROTOCOL, "ascii")
    this.hash = name.byteLength <= HASH_LEN ? Buffer.concat([name, Buffer.alloc(HASH_LEN - name.byteLength)]) : sha256(name)
    this.chainingKey = this.hash
    this.psk = options.psk
    this.ephemeral = keyPairFrom(options.ephemeral)
    this.mixHash(options.prologue)
  }

  get complete(): boolean {
    return this.step === 2
  }

  /** Message 1 for the initiator, message 2 for the responder. */
  writeMessage(payload: Buffer = Buffer.alloc(0)): Buffer {
    const parts: Buffer[] = []
    if (this.step === 0 && this.role === "initiator") {
      this.mixKeyAndHash(this.psk)
      parts.push(this.writeEphemeral())
    } else if (this.step === 1 && this.role === "responder") {
      parts.push(this.writeEphemeral())
      this.mixKey(dh(this.ephemeral, this.remoteEphemeral!))
    } else {
      throw new NoiseError(`${this.role} cannot write handshake message ${this.step + 1}`)
    }
    parts.push(this.encryptAndHash(payload))
    this.step += 1
    return Buffer.concat(parts)
  }

  readMessage(message: Buffer): Buffer {
    if (message.byteLength < DH_LEN + TAG_LEN) throw new NoiseError("handshake message too short")
    if (this.step === 0 && this.role === "responder") {
      this.mixKeyAndHash(this.psk)
      this.readEphemeral(message)
    } else if (this.step === 1 && this.role === "initiator") {
      this.readEphemeral(message)
      this.mixKey(dh(this.ephemeral, this.remoteEphemeral!))
    } else {
      throw new NoiseError(`${this.role} cannot read handshake message ${this.step + 1}`)
    }
    const payload = this.decryptAndHash(message.subarray(DH_LEN))
    this.step += 1
    return payload
  }

  /** After message 2: the initiator sends with the first key, the responder with the second. */
  split(): Channel {
    if (!this.complete) throw new NoiseError("handshake not complete")
    const [first, second] = noiseHkdf(this.chainingKey, Buffer.alloc(0), 2)
    const a = new CipherState()
    const b = new CipherState()
    a.initializeKey(first!)
    b.initializeKey(second!)
    return this.role === "initiator"
      ? { send: a, receive: b, handshakeHash: this.hash }
      : { send: b, receive: a, handshakeHash: this.hash }
  }

  private writeEphemeral(): Buffer {
    const publicKey = this.ephemeral.publicKey
    this.mixHash(publicKey)
    // psk modes mix the ephemeral into the key as well.
    this.mixKey(publicKey)
    return publicKey
  }

  private readEphemeral(message: Buffer): void {
    const publicKey = Buffer.from(message.subarray(0, DH_LEN))
    this.remoteEphemeral = publicKey
    this.mixHash(publicKey)
    this.mixKey(publicKey)
  }

  private mixHash(data: Buffer): void {
    this.hash = sha256(this.hash, data)
  }

  private mixKey(ikm: Buffer): void {
    const [chainingKey, key] = noiseHkdf(this.chainingKey, ikm, 2)
    this.chainingKey = chainingKey!
    this.cipher.initializeKey(key!)
  }

  private mixKeyAndHash(ikm: Buffer): void {
    const [chainingKey, hashInput, key] = noiseHkdf(this.chainingKey, ikm, 3)
    this.chainingKey = chainingKey!
    this.mixHash(hashInput!)
    this.cipher.initializeKey(key!)
  }

  private encryptAndHash(plaintext: Buffer): Buffer {
    const sealed = this.cipher.encrypt(this.hash, plaintext)
    this.mixHash(sealed)
    return sealed
  }

  private decryptAndHash(ciphertext: Buffer): Buffer {
    const opened = this.cipher.decrypt(this.hash, ciphertext)
    this.mixHash(ciphertext)
    return opened
  }
}
