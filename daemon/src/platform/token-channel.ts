// The CLI's channel to the daemon where there are no owner-only unix sockets (Windows; the Windows notes).
// The daemon listens on 127.0.0.1 at a port the OS picks and writes {port, pid, token} to RUDDER_HOME, which only
// this user can read (win32-acl.ts). Each request carries an HMAC of a fresh nonce and the time under the token, and
// each answer an HMAC proving the daemon holds it too: whoever cannot read the file can neither ask nor answer, and the token itself
// never crosses the socket, so a process that grabs the port after the daemon died learns nothing from a CLI call.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import type { Server } from "bun"

export const TOKEN_FILE = "rudder-local.json"

export type ChannelFile = { port: number; pid: number; token: string }

const NONCE_HEADER = "x-rudder-nonce"
const TIME_HEADER = "x-rudder-time"
const AUTH_HEADER = "x-rudder-auth"
const PROOF_HEADER = "x-rudder-proof"
/** How far a request's signed time may be from the daemon's clock; a nonce is remembered for this long. */
const WINDOW_MS = 60_000

function mac(token: string, ...parts: string[]): string {
  return createHmac("sha256", Buffer.from(token, "hex")).update(parts.join("\n")).digest("hex")
}

function sameHex(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(left) || left.length !== right.length) return false
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"))
}

/** `time` is the request's milliseconds since the epoch, as the decimal string sent in x-rudder-time. */
export function requestAuth(token: string, nonce: string, time: string, method: string, route: string): string {
  return mac(token, "client", nonce, time, method, route)
}

export function answerProof(token: string, nonce: string, status: number): string {
  return mac(token, "server", nonce, String(status))
}

export function readChannelFile(path: string): ChannelFile | null {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return null
  }
  const file = raw as Partial<ChannelFile>
  if (!Number.isInteger(file.port) || !Number.isInteger(file.pid) || typeof file.token !== "string" || !/^[0-9a-f]{64}$/.test(file.token)) {
    return null
  }
  return { port: file.port!, pid: file.pid!, token: file.token }
}

export type TokenChannelOptions = {
  /** RUDDER_HOME/rudder-local.json. */
  path: string
  handle: (request: Request) => Response | Promise<Response>
  /** Run on the written file before anyone may read it (Windows: the owner-only ACL). Throwing stops the channel. */
  protect?: (path: string) => void
  /** The clock the time window is checked against (tests). */
  now?: () => number
}

export function startTokenChannel(options: TokenChannelOptions): { path: string; server: Server<undefined>; stop: () => void } {
  const token = randomBytes(32).toString("hex")
  const now = options.now ?? Date.now
  // Nonce -> its signed time. One older than the window can go: its time no longer passes the check.
  const seen = new Map<string, number>()
  const server = Bun.serve<undefined, never>({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const nonce = request.headers.get(NONCE_HEADER) ?? ""
      const time = request.headers.get(TIME_HEADER) ?? ""
      const auth = request.headers.get(AUTH_HEADER) ?? ""
      const clock = now()
      for (const [old, at] of seen) if (at < clock - WINDOW_MS) seen.delete(old)
      // A browser page cannot set these headers cross-origin without a preflight, and cannot compute the HMAC anyway.
      if (
        !/^[0-9a-f]{32,64}$/.test(nonce) ||
        !/^[0-9]{1,16}$/.test(time) ||
        Math.abs(Number(time) - clock) > WINDOW_MS ||
        seen.has(nonce) ||
        !sameHex(auth, requestAuth(token, nonce, time, request.method, url.pathname))
      ) {
        return new Response("forbidden", { status: 403 })
      }
      // Replays of a captured request are refused: inside the window by the nonce, after it by the signed time.
      seen.set(nonce, Number(time))
      const answer = await options.handle(request)
      const headers = new Headers(answer.headers)
      headers.set(PROOF_HEADER, answerProof(token, nonce, answer.status))
      return new Response(answer.body, { status: answer.status, headers })
    },
  })
  const tmp = `${options.path}.tmp`
  try {
    rmSync(tmp, { force: true })
    writeFileSync(tmp, `${JSON.stringify({ port: server.port ?? 0, pid: process.pid, token } satisfies ChannelFile)}\n`, { mode: 0o600 })
    options.protect?.(tmp)
    renameSync(tmp, options.path)
  } catch (error) {
    rmSync(tmp, { force: true })
    server.stop(true)
    throw error
  }
  return {
    path: options.path,
    server,
    stop: () => {
      server.stop(true)
      // Only our own file: a newer daemon may already have written its own.
      if (readChannelFile(options.path)?.token === token) rmSync(options.path, { force: true })
    },
  }
}

export class ChannelProofError extends Error {}

/**
 * One request over the token channel; null when there is no file or nothing listens on its port. An answer without
 * a valid proof throws: something that is not this user's daemon holds the port.
 */
export async function tokenRequest(
  path: string,
  method: "GET" | "POST",
  route: string,
  body?: unknown,
): Promise<{ status: number; body: unknown } | null> {
  const file = readChannelFile(path)
  if (!file) return null
  const nonce = randomBytes(16).toString("hex")
  const time = String(Date.now())
  let response: Response
  try {
    response = await fetch(`http://127.0.0.1:${file.port}${route}`, {
      method,
      headers: {
        [NONCE_HEADER]: nonce,
        [TIME_HEADER]: time,
        [AUTH_HEADER]: requestAuth(file.token, nonce, time, method, route.split("?")[0]!),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    })
  } catch {
    // Refused or reset: the file outlived its daemon.
    return null
  }
  const proof = response.headers.get(PROOF_HEADER) ?? ""
  if (!sameHex(proof, answerProof(file.token, nonce, response.status))) {
    throw new ChannelProofError(`127.0.0.1:${file.port} answered without proof that it is your rudder; something else holds that port`)
  }
  return { status: response.status, body: await response.json().catch(() => null) }
}
