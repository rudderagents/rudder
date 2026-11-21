/** v32 decisions the session service and the adapters share. Pure: no process, no socket. */

export type SteerProbeResult = "ok" | "missing" | "unavailable"

export type SteerControl = "steer" | "stop-and-send" | "queue"

const TEXT_ONLY = new Set(["grok:grok-code-fast-1"])
const IMAGE_CAPS: Record<string, number> = { claude: 20, codex: 10, grok: 10 }

/** The agent×model table wins over `agentReported`. `grok-code-fast-1` stays text-only. */
export function modelAcceptsImages(agent: string, model: string, agentReported: boolean): { accepts: boolean; cap: number } {
  if (TEXT_ONLY.has(`${agent}:${model}`)) return { accepts: false, cap: 0 }
  const cap = IMAGE_CAPS[agent]
  if (cap !== undefined) return { accepts: true, cap }
  return { accepts: agentReported, cap: agentReported ? 10 : 0 }
}

/**
 * Grok's interject probe is the authority when it has answered: `ok` is steer. Until then, and on
 * `missing`, Grok is stop-and-send: today's Grok has no `x.ai/interject`, and the phone shows the
 * chip from the first turn instead of waiting for the process to start. Stop-and-send is
 * phone-side (cancel, then send), so it never depends on the probe. Every other agent steers only
 * when `steer()` exists and either the probe succeeded or the published capability says so. An
 * `"ok"` with no `steer()` does not win, so Copilot, Cursor, opencode, Kimi and pi stay on the queue.
 */
export function steerControl(
  agentId: string,
  capabilitySteer: boolean,
  hasSteerMethod: boolean,
  probe: SteerProbeResult | null,
): SteerControl {
  if (agentId === "grok") {
    return probe === "ok" ? "steer" : "stop-and-send"
  }
  if (hasSteerMethod && (probe === "ok" || capabilitySteer)) return "steer"
  return "queue"
}

export type SessionRule = {
  id: string
  sessionId: string
  tool: string
  command: string
  enabled: boolean
  /** When it was allowed, ms since 1970. Kept in the store's permission_rules table across restarts (§627). */
  createdAt: number
  /** The allowed call's `PermissionRequest.match`; absent on rules from before it. Never sent to the phone. */
  match?: string
}

/**
 * An enabled rule for exactly this call, and this tool when one is named. A rule recorded with the call's `match`
 * needs the same `match`; one from before matches (or from an adapter that sends none) compares the shown command,
 * and only for a request that carries no `match` either.
 */
export function ruleMatches(rules: SessionRule[], sessionId: string, command: string, tool?: string, match?: string): boolean {
  return rules.some(
    (rule) =>
      rule.sessionId === sessionId &&
      rule.enabled &&
      (tool === undefined || rule.tool === tool) &&
      (rule.match !== undefined ? rule.match === match : match === undefined && rule.command === command),
  )
}

/**
 * Input fields that only describe a call to the reader and never change what runs. Claude writes a fresh free-text
 * `description` for every Bash or Task call, so hashing it made an allowed `npm test` ask again once reworded.
 * `timeout` stays: it decides how long the command may run.
 */
const DISPLAY_ONLY_FIELDS = new Set(["description"])

/** `input` without its display-only top-level fields (`DISPLAY_ONLY_FIELDS`); anything but a plain object as is. */
export function withoutDisplayFields(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input
  return Object.fromEntries(Object.entries(input).filter(([key]) => !DISPLAY_ONLY_FIELDS.has(key)))
}

/**
 * `PermissionRequest.match` for a tool call: a SHA-256 of its name and full input with keys sorted, leaving out the
 * top-level display-only fields.
 */
export function callMatch(tool: string, input: unknown): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical)
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]))
    }
    return value
  }
  return new Bun.CryptoHasher("sha256").update(JSON.stringify([tool, canonical(withoutDisplayFields(input) ?? null)])).digest("hex")
}

export type DaemonQueueItem = {
  id: string
  sessionId: string
  text: string
  attachmentIds: string[]
  clientMessageId?: string
  clientDeviceId?: string
  hasImages?: boolean
  // r47: "relay" = line comments Rudder sends for the user after a declined approval. r73: rudderd's own
  // continuations start only on an idle session, so they do not reach a queue.
  origin?: "review" | "relay" | "auto_resume" | "restart_resume" | "fallback_resume" | "agent_continue"
}

/** A busy session holds at most this many queued sends, and this much queued text (UTF-8). */
export const QUEUE_MAX_ITEMS = 20
export const QUEUE_MAX_BYTES = 256 * 1024

/** A busy send joins the queue. It is not adapter input until flush or an explicit steer. Throws `queue_full` past the caps. */
export function enqueueItem(queue: DaemonQueueItem[], item: DaemonQueueItem): DaemonQueueItem[] {
  if (queue.length >= QUEUE_MAX_ITEMS) {
    throw Object.assign(new Error(`queue is full: at most ${QUEUE_MAX_ITEMS} messages wait while the agent works`), { code: "queue_full" })
  }
  const bytes = [...queue, item].reduce((sum, entry) => sum + Buffer.byteLength(entry.text, "utf8"), 0)
  if (bytes > QUEUE_MAX_BYTES) {
    throw Object.assign(new Error(`queue is full: queued text would be ${bytes} bytes, over ${QUEUE_MAX_BYTES}`), { code: "queue_full" })
  }
  return [...queue, item]
}

export function takeNext(queue: DaemonQueueItem[]): { next?: DaemonQueueItem; rest: DaemonQueueItem[] } {
  const [next, ...rest] = queue
  return { next, rest }
}
