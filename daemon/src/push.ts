import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto"
import type { PhoneCopy } from "./phone-copy"
import { type DeviceRow, previewText, type Store } from "./store"

/**
 * What the phone's notification service extension shows; see the push notes. `done`: a turn ended
 * (body = the reply's first sentence, or the error), answerable with a reply from the notification. `doneBatch`
 * (v67 A4): several sessions on this computer finished within one window and replace each other's notice.
 * Every field after `body` is optional so an older extension still shows title and body.
 */
export type PushPayload = {
  v: 1
  kind: "permission" | "question" | "done" | "doneBatch" | "resumed"
  sessionId: string
  title: string
  body: string
  permissionId?: string
  questionId?: string
  // The notification title is "session title · agent"; the machine goes in the subtitle with 2+ computers paired.
  machine?: string
  agent?: string
  q?: PushQuestion
  // permission: the tool and what it runs (「等你批准 运行 Bash：…」).
  tool?: string
  command?: string
  // done
  outcome?: PushOutcome
  /** The turn's first prompt, at most FIRST_PROMPT_CHARS: the title when the session has none. */
  firstPrompt?: string
  changes?: PushChanges
  reason?: PushReason
  /** A failed turn's `body` as phone copy (phone-copy.ts), worded in the phone's language by the extension. */
  copy?: PhoneCopy
  // resumed (r73 A): rudderd continued a turn on its own; `limit` after a usage limit reset.
  resume?: "limit"
  // doneBatch
  sessions?: { sessionId: string; title: string }[]
  count?: number
  added?: number
  removed?: number
  files?: number
  /**
   * When rudderd first sealed this notice (ms since the epoch). A gateway retry resends the identical ciphertext, so the
   * stamp stays; the phone can refuse a replayed ciphertext by it. Older apps ignore it.
   */
  sentAt?: number
}

export type PushOutcome = "done" | "failed" | "interrupted"
export type PushChanges = { added: number; removed: number; files: number }
/** r48's structured failure, plus the r66 guard's silent agent. Times are ms since the epoch. */
export type PushReason =
  | { code: "usage_limit"; resetsAt?: number }
  | { code: "auth_required"; command?: string }
  | { code: "agent_exited"; exitCode?: number; detail?: string }
  | { code: "agent_silent" }

/** How a question notice lays out on the lock screen; `options` only when they become buttons. */
export type PushQuestion = {
  count: number
  question: string
  headers: string[]
  multiSelect: boolean
  optionCount: number
  options?: { label: string; description?: string }[]
  allowsOther: boolean
}

const PUSH_INFO = "rudder push v1"
const NONCE_BYTES = 12
const TAG_BYTES = 16
// APNs allows 4 KB per payload; base64 and the gateway's fixed fields must fit next to the sealed JSON.
const MAX_PLAINTEXT_BYTES = 1800
const MAX_TITLE_CHARS = 200
export const FIRST_PROMPT_CHARS = 60
export const FIRST_SENTENCE_CHARS = 90
export const MAX_BATCH_SESSIONS = 5
const TICKET_PATTERN = /^[A-Za-z0-9_-]{16,512}$/

/** Push key for one paired device: HKDF-SHA256 over its 32-byte session key. */
export function pushKey(sessionKeyHex: string): Buffer {
  const ikm = Buffer.from(sessionKeyHex, "hex")
  if (ikm.byteLength !== 32) throw new Error(`session key must be 32 bytes of hex, got ${ikm.byteLength} bytes`)
  return Buffer.from(hkdfSync("sha256", ikm, Buffer.alloc(0), PUSH_INFO, 32))
}

/** base64(nonce ‖ AES-256-GCM ciphertext ‖ tag): the layout of CryptoKit's `AES.GCM.SealedBox.combined`. */
export function sealPush(sessionKeyHex: string, payload: PushPayload): string {
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv("aes-256-gcm", pushKey(sessionKeyHex), nonce)
  const sealed = Buffer.concat([cipher.update(fitted(payload)), cipher.final()])
  return Buffer.concat([nonce, sealed, cipher.getAuthTag()]).toString("base64")
}

export function openPush(sessionKeyHex: string, ciphertext: string): PushPayload {
  return JSON.parse(openBytes(sessionKeyHex, ciphertext).toString("utf8")) as PushPayload
}

/** Same box as `sealPush`, but the plaintext is raw UTF-8. Live Activity fields seal through `sealLive`. */
export function sealBytes(sessionKeyHex: string, plaintext: Buffer, aad?: Buffer): string {
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv("aes-256-gcm", pushKey(sessionKeyHex), nonce)
  if (aad) cipher.setAAD(aad)
  const sealed = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([nonce, sealed, cipher.getAuthTag()]).toString("base64")
}

export function openBytes(sessionKeyHex: string, ciphertext: string, aad?: Buffer): Buffer {
  const combined = Buffer.from(ciphertext, "base64")
  if (combined.byteLength < NONCE_BYTES + TAG_BYTES) throw new Error("sealed bytes are shorter than a nonce and a tag")
  const nonce = combined.subarray(0, NONCE_BYTES)
  const tag = combined.subarray(combined.byteLength - TAG_BYTES)
  const decipher = createDecipheriv("aes-256-gcm", pushKey(sessionKeyHex), nonce)
  if (aad) decipher.setAAD(aad)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(combined.subarray(NONCE_BYTES, combined.byteLength - TAG_BYTES)), decipher.final()])
}

/**
 * Where a Live Activity field sits: its name in the content-state (or attributes), the session it describes, and the
 * request it belongs to ("" when none). The ids travel in the clear beside the ciphertext, so the push gateway could
 * pair an old sealed `ls` with a current request's id; bound as AAD, such a pair does not open.
 */
export type LiveBinding = { field: LiveField; sessionId: string; requestId?: string }

export type LiveField =
  | "title"
  | "prompt"
  | "agent"
  | "step"
  | "result"
  | "resultCopy"
  | "reason"
  | "approval.tool"
  | "approval.summary"
  | "question.title"
  | "others.title"
  | "others.wait.title"
  | "machineName"
  // v103: line 2's project, and the task list item in progress.
  | "project"
  | "plan"

/** Bumped with any change to what the AAD covers; the phone opens only this version. */
export const LIVE_SEAL_VERSION = "rudder live v2"

/** Each part as a 4-byte big-endian length and its UTF-8 bytes, so no id can run into the next. */
export function liveAad(binding: LiveBinding): Buffer {
  const parts = [LIVE_SEAL_VERSION, binding.field, binding.sessionId, binding.requestId ?? ""].map((part) => Buffer.from(part, "utf8"))
  return Buffer.concat(
    parts.flatMap((part) => {
      const length = Buffer.alloc(4)
      length.writeUInt32BE(part.byteLength)
      return [length, part]
    }),
  )
}

export function sealLive(sessionKeyHex: string, text: string, binding: LiveBinding): string {
  return sealBytes(sessionKeyHex, Buffer.from(text, "utf8"), liveAad(binding))
}

export function openLive(sessionKeyHex: string, ciphertext: string, binding: LiveBinding): string {
  return openBytes(sessionKeyHex, ciphertext, liveAad(binding)).toString("utf8")
}

// Long tool titles or questions are cut, never dropped: the notification still says what is waiting.
// A question notice gives up, in order: the old-style body, option descriptions, the question, the headers.
function fitted(payload: PushPayload): Buffer {
  let current: PushPayload = { ...payload, title: clip(payload.title, MAX_TITLE_CHARS) }
  if (current.q) current.q = cappedQuestion(current.q)
  if (current.command !== undefined) current.command = clip(current.command, MAX_TITLE_CHARS)
  if (current.sessions) current.sessions = current.sessions.map((entry) => ({ ...entry, title: clip(entry.title, MAX_TITLE_CHARS) }))
  const size = () => Buffer.byteLength(JSON.stringify(current), "utf8")
  // The copy repeats the body in parts; past the limit the body alone says it.
  if (size() > MAX_PLAINTEXT_BYTES && current.copy !== undefined) {
    const { copy: _dropped, ...rest } = current
    current = rest
  }
  while (size() > MAX_PLAINTEXT_BYTES) {
    const chars = [...current.body]
    if (chars.length <= 1) break
    current = { ...current, body: clip(current.body, Math.floor(chars.length * 0.8)) }
  }
  // A done notice then gives up the title fallback and the stderr line (the reason itself stays).
  if (size() > MAX_PLAINTEXT_BYTES && current.firstPrompt !== undefined) {
    const { firstPrompt: _dropped, ...rest } = current
    current = rest
  }
  if (size() > MAX_PLAINTEXT_BYTES && current.reason?.code === "agent_exited" && current.reason.detail !== undefined) {
    const { detail: _dropped, ...reason } = current.reason
    current = { ...current, reason }
  }
  const q = current.q
  const steps: ((q: PushQuestion) => PushQuestion)[] = [
    (q) => ({ ...q, options: q.options?.map((option) => withDescription(option, (text) => clip(text, 24))) }),
    (q) => ({ ...q, options: q.options?.map((option) => withDescription(option, () => undefined)) }),
    (q) => ({ ...q, question: clip(q.question, 120) }),
    (q) => ({ ...q, headers: q.headers.map((header) => clip(header, 12)) }),
  ]
  if (q) {
    for (const step of steps) {
      if (size() <= MAX_PLAINTEXT_BYTES) break
      current = { ...current, q: step(current.q as PushQuestion) }
    }
  }
  // A doneBatch lists up to five session titles: long ones are cut further rather than the whole notice lost.
  for (let chars = 60; current.sessions && size() > MAX_PLAINTEXT_BYTES && chars >= 8; chars = Math.floor(chars / 2)) {
    current = { ...current, sessions: current.sessions.map((entry) => ({ ...entry, title: clip(entry.title, chars) })) }
  }
  if (current.command !== undefined && size() > MAX_PLAINTEXT_BYTES) current = { ...current, command: clip(current.command, 60) }
  const encoded = Buffer.from(JSON.stringify(current), "utf8")
  if (encoded.byteLength > MAX_PLAINTEXT_BYTES) throw new Error(`push payload is ${encoded.byteLength} bytes even without a body`)
  return encoded
}

function cappedQuestion(q: PushQuestion): PushQuestion {
  return {
    ...q,
    question: clip(q.question, 200),
    headers: q.headers.map((header) => clip(header, 24)),
    ...(q.options
      ? { options: q.options.map((option) => withDescription({ ...option, label: clip(option.label, 40) }, (text) => clip(text, 44))) }
      : {}),
  }
}

function withDescription(
  option: { label: string; description?: string },
  change: (text: string) => string | undefined,
): { label: string; description?: string } {
  const description = option.description === undefined ? undefined : change(option.description)
  return description === undefined ? { label: option.label } : { label: option.label, description }
}

/**
 * The first sentence of a reply for its done notice: a leading heading gives way to the prose under it, Markdown is
 * stripped like the list preview, and the cut falls after the first 。！？!? or a period before a space.
 */
export function firstSentence(text: string, maxChars = FIRST_SENTENCE_CHARS): string {
  const lines = text.split("\n")
  const prose = lines.findIndex((line) => line.trim() !== "" && !/^\s{0,3}#{1,6}\s/.test(line) && !/^\s*(```|~~~)/.test(line))
  // v115: a line break ends the sentence; a dot ends it only before a blank or the end, so names and paths
  // (`next.js`, `src/auth/redirect.ts`) stay whole. Twin of `CardSentence.first` on the phone.
  const flat = previewText(prose >= 0 ? lines[prose]! : text).replace(/…$/, "")
  const end = flat.search(/[。！？]|[.!?](?=\s|$)/)
  return clip(end >= 0 ? flat.slice(0, end + 1) : flat, maxChars)
}

/** The prompt's first line, for the title fallback. */
export function firstPromptLine(text: string): string | undefined {
  const line = text.split("\n").map((part) => part.trim()).find((part) => part !== "")
  return line ? clip(line, FIRST_PROMPT_CHARS) : undefined
}

function clip(text: string, maxChars: number): string {
  const chars = [...text]
  return chars.length <= maxChars ? text : `${chars.slice(0, Math.max(0, maxChars - 1)).join("")}…`
}

export function isPushTicket(value: string): boolean {
  return TICKET_PATTERN.test(value)
}

/** RUDDER_PUSH_GATEWAY: https, or plain http to this machine for the local gateway (`wrangler dev`). */
export function parseGateway(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`RUDDER_PUSH_GATEWAY is not a URL: ${raw}`)
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]"
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(`RUDDER_PUSH_GATEWAY must be https (plain http only to localhost): ${raw}`)
  }
  return url.origin + url.pathname.replace(/\/+$/, "")
}

// A gateway that accepts the connection and never answers would otherwise hold notify() forever.
export const GATEWAY_TIMEOUT_MS = 10_000

export type PushOptions = {
  gateway: string
  fetch?: typeof fetch
  retryDelayMs?: number
  requestTimeoutMs?: number
  log?: (line: string) => void
  /** How long an approval or question notice the gateway could not take waits before it is tried again. */
  laterDelayMs?: number
}

/** An approval or question notice waits at most this many later tries (30 s apart by default: about 10 minutes). */
const LATER_TRIES = 20

/** A rate-limited (429) notice waits `laterDelayMs` doubled per try, up to this, or longer when `Retry-After` says so. */
const RATE_LIMITED_MAX_DELAY_MS = 5 * 60_000

/** `Retry-After` in ms: delta-seconds or an HTTP date; undefined when absent or unreadable. */
export function retryAfterMs(header: string | null, now = Date.now()): number | undefined {
  if (!header?.trim()) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : undefined
  const at = Date.parse(header)
  return Number.isNaN(at) ? undefined : Math.max(0, at - now)
}

/**
 * APNs reasons (forwarded by the gateway on a 410, push-gateway `GONE_400_REASONS`) that mean the ticket itself is
 * wrong: the device token belongs to another environment or app. Any other 410 on a Live Activity push is that one
 * card ending. A gateway older than r68 sends no reason.
 */
export const BAD_TICKET_REASONS: ReadonlySet<string> = new Set(["BadDeviceToken", "DeviceTokenNotForTopic"])

/** What a phone asked to be told (v67 A5); absent keys are on. */
export type PushPrefs = { done?: boolean }

export function devicePushPrefs(device: Pick<DeviceRow, "push_prefs">): PushPrefs {
  if (!device.push_prefs) return {}
  try {
    const parsed = JSON.parse(device.push_prefs) as unknown
    if (typeof parsed !== "object" || parsed === null) return {}
    const done = (parsed as { done?: unknown }).done
    return typeof done === "boolean" ? { done } : {}
  } catch {
    return {}
  }
}

/** Hands sealed payloads to the push gateway for every device that registered a ticket. */
export class PushNotifier {
  private readonly fetch: typeof fetch
  private readonly retryDelayMs: number
  private readonly requestTimeoutMs: number
  private readonly log: (line: string) => void
  /** The gateway refused this device's ticket and it was cleared; the server tells that phone to register again. */
  onTicketDropped?: (device: DeviceRow, reason: string) => void
  /**
   * Whether an approval or question is still waiting for an answer. A notice for one the gateway could not take (it was
   * down) is sent again later while this says yes; without it nothing is sent again.
   */
  stillWaiting?: (payload: PushPayload) => boolean
  private readonly laterDelayMs: number
  /** Per device and collapse id: the newest notice that failed for a gateway reason, and how often it was tried later. */
  private readonly later = new Map<string, { deviceId: string; payload: PushPayload; collapse: string | undefined; tries: number; due: number }>()
  private laterTimer: ReturnType<typeof setTimeout> | null = null
  private laterTimerAt = 0

  constructor(
    private readonly store: Store,
    private readonly options: PushOptions,
  ) {
    this.fetch = options.fetch ?? fetch
    this.retryDelayMs = options.retryDelayMs ?? 1000
    this.requestTimeoutMs = options.requestTimeoutMs ?? GATEWAY_TIMEOUT_MS
    this.log = options.log ?? ((line) => console.warn(line))
    this.laterDelayMs = options.laterDelayMs ?? 30_000
  }

  /**
   * The gateway was unreachable, failed (5xx) twice, or rate-limited the push (429): an answerable notice is kept to
   * send again after `delayMs`.
   */
  private keepForLater(device: DeviceRow, payload: PushPayload, collapse: string | undefined, tries: number, delayMs = this.laterDelayMs) {
    if ((payload.kind !== "permission" && payload.kind !== "question") || !this.stillWaiting || tries >= LATER_TRIES) return
    const key = `${device.id}\0${collapse ?? payload.permissionId ?? payload.questionId ?? ""}`
    const due = Date.now() + delayMs
    this.later.set(key, { deviceId: device.id, payload, collapse, tries: tries + 1, due })
    this.scheduleLater(due)
  }

  private scheduleLater(due: number) {
    if (this.laterTimer && this.laterTimerAt <= due) return
    if (this.laterTimer) clearTimeout(this.laterTimer)
    this.laterTimerAt = due
    this.laterTimer = setTimeout(() => void this.sendLater(), Math.max(0, due - Date.now()))
    this.laterTimer.unref?.()
  }

  private async sendLater() {
    this.laterTimer = null
    const now = Date.now()
    const due = [...this.later.entries()].filter(([, entry]) => entry.due <= now)
    for (const [key] of due) this.later.delete(key)
    const next = Math.min(...[...this.later.values()].map((entry) => entry.due))
    if (Number.isFinite(next)) this.scheduleLater(next)
    const devices = new Map(this.store.listDevices().map((device) => [device.id, device]))
    await Promise.all(
      due.map(async ([, entry]) => {
        const device = devices.get(entry.deviceId)
        if (!device?.push_token || !this.stillWaiting?.(entry.payload)) return
        await this.send(device, entry.payload, entry.collapse, entry.tries)
      }),
    )
  }

  get gateway(): string {
    return this.options.gateway
  }

  /**
   * Never throws: a push that cannot be delivered is logged, the agent turn goes on. A phone that turned off
   * 「做完或失败」 (`push_prefs.done: false`) gets no done or doneBatch.
   */
  async notify(payload: PushPayload, options: { collapseId?: string } = {}): Promise<void> {
    const finished = payload.kind === "done" || payload.kind === "doneBatch" || payload.kind === "resumed"
    const devices = this.store.listDevices().filter((device) => device.push_token && !(finished && devicePushPrefs(device).done === false))
    const stamped = { ...payload, sentAt: payload.sentAt ?? Date.now() }
    await Promise.all(devices.map((device) => this.send(device, stamped, options.collapseId)))
  }

  /** `laterTries`: how many times this notice was already tried again after a gateway failure. */
  private async send(device: DeviceRow, payload: PushPayload, collapse: string | undefined, laterTries = 0) {
    const ticket = device.push_token as string
    // A session's turn-end notices replace each other: only the latest reply matters.
    const collapseId =
      collapse ?? payload.permissionId ?? payload.questionId ?? (payload.kind === "done" ? `done-${payload.sessionId}` : undefined)
    let ciphertext: string
    try {
      ciphertext = sealPush(device.session_key, payload)
    } catch (error) {
      return this.log(`push: device ${device.id} ${payload.kind} could not be sealed: ${error instanceof Error ? error.message : String(error)}`)
    }
    const body = JSON.stringify({ ticket, ciphertext, collapseId })
    for (let attempt = 1; attempt <= 2; attempt++) {
      const last = attempt === 2
      let response: Response
      try {
        response = await this.fetch(`${this.options.gateway}/v1/push`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        })
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        if (!last) {
          await Bun.sleep(this.retryDelayMs)
          continue
        }
        this.keepForLater(device, payload, collapse, laterTries)
        return this.log(`push: device ${device.id} unreachable gateway ${this.options.gateway}: ${reason}`)
      }
      if (response.ok) return
      const reply = (await response.json().catch(() => ({}))) as { error?: string; status?: number; reason?: string }
      if (response.status === 410 || (response.status === 400 && reply.error === "bad_ticket")) {
        const reason = reply.reason ?? reply.error ?? String(response.status)
        if (this.store.clearDevicePushToken(device.id, ticket)) this.onTicketDropped?.(device, reason)
        return this.log(`push: device ${device.id} ticket dropped (${reason}); the app is told to register again`)
      }
      if (response.status === 429) {
        // Backing off, not the immediate second try: that one would be rate-limited too.
        const backoff = Math.min(this.laterDelayMs * 2 ** laterTries, RATE_LIMITED_MAX_DELAY_MS)
        this.keepForLater(device, payload, collapse, laterTries, Math.max(backoff, retryAfterMs(response.headers.get("retry-after")) ?? 0))
      }
      if (response.status >= 500 && !last) {
        await Bun.sleep(this.retryDelayMs)
        continue
      }
      if (response.status >= 500) this.keepForLater(device, payload, collapse, laterTries)
      return this.log(
        `push: device ${device.id} failed with ${response.status} ${reply.error ?? ""} ${reply.status ?? ""} ${reply.reason ?? ""}`.trimEnd(),
      )
    }
  }
}
