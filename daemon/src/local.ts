// The CLI's channel to the running daemon (r59 F-02 / F-03 / F-07): HTTP over a unix socket in RUDDER_HOME.
// RUDDER_HOME is 0700 and the socket 0600, so the kernel only lets this user connect; nothing about pairing or
// paired devices is reachable over TCP. Bun does not expose the peer's credentials (getpeereid), so the file
// modes are the check, and the client verifies the socket and its directory belong to it before trusting the answer.
// Windows has no owner-only unix socket: there the channel is 127.0.0.1 plus a token in an owner-only file
// (platform/token-channel.ts, the Windows notes), with the same handler and the same promise.
import type { Server } from "bun"
import { chmodSync, lstatSync, unlinkSync } from "node:fs"
import { dirname, join } from "node:path"
import { readBodyCapped } from "./body"
import { isWindows } from "./platform"
import { ChannelProofError, startTokenChannel, TOKEN_FILE, tokenRequest } from "./platform/token-channel"
import { AclError, checkOwnerOnly, currentUserSid, restrictToUser } from "./platform/win32-acl"
import type { DeviceRow, Store } from "./store"

export const LOCAL_SOCKET_FILE = "rudder.sock"

/** The unix socket, or on Windows the token channel's file; both in RUDDER_HOME. */
export function localSocketPath(dataDir: string, platform: NodeJS.Platform = process.platform): string {
  return join(dataDir, isWindows(platform) ? TOKEN_FILE : LOCAL_SOCKET_FILE)
}

export type LocalPairLink = { url: string; expiresAt: number; machine: string }
export type LocalDevice = { id: string; name: string; createdAt: number; lastSeenAt: number | null; connected: boolean }

export type LocalControlOptions = {
  path: string
  store: Store
  machine: () => string
  pairLink: () => { url: string; expiresAt: number }
  rotatePairing: () => { url: string; expiresAt: number }
  /** True while the device with this session key has an open socket. */
  isConnected: (sessionKey: string) => boolean
  /** Deletes the device and closes its sockets with 4001; null when there is no such id. */
  revoke: (id: string) => DeviceRow | null
  /** `rudder attach` (session handoff): claim a session for a terminal Claude, and give it back. */
  attach?: (body: Record<string, unknown>) => Promise<unknown>
  attachDone?: (body: Record<string, unknown>) => unknown
  /** `rudder relay on|off` while this daemon is running. Absent in tests that never toggle the relay. */
  setRelayMode?: (mode: "on" | "off") => { mode: "on" | "off"; bases: string[] }
  relayStatus?: () => { mode: "on" | "off"; bases: string[] }
}

const ATTACH_STATUS: Record<string, number> = { not_found: 404, ambiguous: 409, held_elsewhere: 409, unsupported: 400, unknown_method: 501 }

export class DeviceMatchError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "ambiguous",
  ) {
    super(message)
  }
}

/** Accepts the full id, a unique id prefix of at least 4 characters (as `rudder devices` prints 8), or a unique name. */
export function matchDevice(devices: DeviceRow[], target: string): DeviceRow {
  const wanted = target.trim()
  if (!wanted) throw new DeviceMatchError("name or id of the phone to revoke is missing", "not_found")
  const exact = devices.find((device) => device.id === wanted)
  if (exact) return exact
  const lower = wanted.toLowerCase()
  const byName = devices.filter((device) => device.name.toLowerCase() === lower)
  const byPrefix = wanted.length >= 4 ? devices.filter((device) => device.id.startsWith(lower)) : []
  const hits = [...new Set([...byName, ...byPrefix])]
  if (hits.length === 1) return hits[0]!
  if (hits.length === 0) throw new DeviceMatchError(`no paired phone is named or has the id "${wanted}"`, "not_found")
  const list = hits.map((device) => `${device.id.slice(0, 8)} (${device.name})`).join(", ")
  throw new DeviceMatchError(`"${wanted}" matches ${hits.length} phones: ${list}; use the id`, "ambiguous")
}

export function describeDevices(store: Store, isConnected: (key: string) => boolean = () => false): LocalDevice[] {
  return store.listDevices().map((row) => ({
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at ?? null,
    connected: isConnected(row.session_key),
  }))
}

/**
 * True when a daemon is accepting on this unix socket. A missing file, a refused connection (a socket left by a
 * killed daemon) or no answer within 300 ms is false. Windows has no unix socket to probe: the port bind is the guard.
 */
export async function socketIsLive(path: string): Promise<boolean> {
  if (isWindows()) return false
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const connect = Bun.connect({ unix: path, socket: { data() {}, open() {}, error() {} } }).then((socket) => {
      socket.end()
      return true
    })
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), 300)
    })
    return await Promise.race([connect, timeout])
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

export class DaemonAlreadyRunningError extends Error {}

/** Startup guard: a second daemon on one RUDDER_HOME would delete the first one's socket as "stale". */
export async function refuseIfDaemonRunning(dataDir: string): Promise<void> {
  const path = localSocketPath(dataDir)
  if (await socketIsLive(path)) {
    throw new DaemonAlreadyRunningError(`rudder is already running for ${dataDir} (socket ${path}). Stop it first, or use \`rudder status\`.`)
  }
}

/** Removes a dead socket left by a crashed daemon; anything else at the path is an error, never deleted. */
function clearStaleSocket(path: string) {
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(path)
  } catch {
    return
  }
  if (!stat.isSocket()) throw new Error(`${path} exists and is not a socket; move it away so rudder can listen there`)
  unlinkSync(path)
}

function localHandler(options: LocalControlOptions): (request: Request) => Promise<Response> {
  const { store } = options
  return async (request) => {
    const url = new URL(request.url)
    const link = (made: { url: string; expiresAt: number }): LocalPairLink => ({ ...made, machine: options.machine() })
    if (url.pathname === "/local/pair" && request.method === "GET") return Response.json(link(options.pairLink()))
    // `rudder pair`: invalidate the current code and hand back the new one.
    if (url.pathname === "/local/pair" && request.method === "POST") return Response.json(link(options.rotatePairing()))
    if (url.pathname === "/local/relay" && request.method === "GET") {
      return Response.json(options.relayStatus?.() ?? { mode: "off", bases: [] })
    }
    if (url.pathname === "/local/relay" && request.method === "POST") {
      const text = await readBodyCapped(request, 4096).catch(() => undefined)
      if (text === undefined) return Response.json({ error: "request too large" }, { status: 413 })
      const body = (() => {
        try {
          return JSON.parse(text) as { mode?: unknown }
        } catch {
          return {}
        }
      })()
      if (body.mode !== "on" && body.mode !== "off") return Response.json({ error: "mode must be on or off" }, { status: 400 })
      if (!options.setRelayMode) return Response.json({ error: "relay control is not available" }, { status: 501 })
      return Response.json(options.setRelayMode(body.mode))
    }
    if (url.pathname === "/local/devices" && request.method === "GET") {
      return Response.json({ machine: options.machine(), devices: describeDevices(store, options.isConnected) })
    }
    if (url.pathname === "/local/devices/revoke" && request.method === "POST") {
      const text = await readBodyCapped(request, 4096).catch(() => undefined)
      if (text === undefined) return Response.json({ error: "request too large" }, { status: 413 })
      const body = (() => {
        try {
          return JSON.parse(text) as { target?: unknown }
        } catch {
          return {}
        }
      })()
      try {
        const device = matchDevice(store.listDevices(), String(body.target ?? ""))
        options.revoke(device.id)
        console.log(`rudderd: device "${device.name}" revoked from this computer (rudder devices revoke)`)
        return Response.json({ device: { id: device.id, name: device.name } })
      } catch (error) {
        if (!(error instanceof DeviceMatchError)) throw error
        return Response.json({ error: error.message, code: error.code }, { status: error.code === "ambiguous" ? 409 : 404 })
      }
    }
    if ((url.pathname === "/local/attach" || url.pathname === "/local/attach/done") && request.method === "POST") {
      const text = await readBodyCapped(request, 4096).catch(() => undefined)
      if (text === undefined) return Response.json({ error: "request too large" }, { status: 413 })
      let body: Record<string, unknown> = {}
      try {
        const parsed: unknown = JSON.parse(text)
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>
      } catch {
        // An empty body is the same as {}.
      }
      const run = url.pathname === "/local/attach" ? options.attach : options.attachDone
      if (!run) return Response.json({ error: "session handoff is not available", code: "unknown_method" }, { status: 501 })
      try {
        return Response.json(await run(body))
      } catch (error) {
        const code = (error as { code?: string }).code ?? "failed"
        const message = error instanceof Error ? error.message : String(error)
        return Response.json({ error: message, code }, { status: ATTACH_STATUS[code] ?? 500 })
      }
    }
    return new Response("not found", { status: 404 })
  }
}

export function startLocalControl(options: LocalControlOptions): { path: string; server: Server<undefined>; stop: () => void } {
  const { path } = options
  if (isWindows()) {
    const userSid = currentUserSid()
    return startTokenChannel({ path, handle: localHandler(options), protect: (file) => restrictToUser(file, { directory: false, userSid }) })
  }
  clearStaleSocket(path)
  // Created owner-only from the start (no window at the default umask), then pinned to 0600 in case the umask is odd.
  const umask = process.umask(0o077)
  let server: Server<undefined>
  try {
    server = Bun.serve<undefined, never>({ unix: path, fetch: localHandler(options) })
  } finally {
    process.umask(umask)
  }
  chmodSync(path, 0o600)
  return {
    path,
    server,
    stop: () => {
      server.stop(true)
      try {
        unlinkSync(path)
      } catch {
        // Already gone.
      }
    },
  }
}

export class LocalChannelError extends Error {}

/**
 * Refuses a socket (or its directory) that another user owns or could have replaced: with `rudder` down, nobody else
 * gets to answer `rudder pair` with their own QR code. Returns false when there is no socket.
 */
export function checkLocalSocket(path: string, uid = process.getuid?.() ?? 0): boolean {
  const dir = dirname(path)
  let dirStat: ReturnType<typeof lstatSync>
  try {
    dirStat = lstatSync(dir)
  } catch {
    return false
  }
  if (dirStat.uid !== uid || (dirStat.mode & 0o022) !== 0) {
    throw new LocalChannelError(`refusing ${dir}: it must belong to you (uid ${uid}) and not be writable by others`)
  }
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(path)
  } catch {
    return false
  }
  if (!stat.isSocket() || stat.uid !== uid) {
    throw new LocalChannelError(`refusing ${path}: it is not a socket owned by you (uid ${uid})`)
  }
  return true
}

export type LocalAnswer = { status: number; body: unknown }

/** One request to the daemon on `path`; null when no daemon listens there (no socket, or a dead one). */
export async function localRequest(path: string, method: "GET" | "POST", route: string, body?: unknown): Promise<LocalAnswer | null> {
  if (isWindows()) return windowsRequest(path, method, route, body)
  if (!checkLocalSocket(path)) return null
  let response: Response
  try {
    response = await fetch(`http://rudder${route}`, {
      unix: path,
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    })
  } catch {
    // Refused or reset: the socket file outlived its daemon.
    return null
  }
  return { status: response.status, body: await response.json().catch(() => null) }
}

/**
 * Windows: the file and RUDDER_HOME must be readable and writable by this user only (the counterpart of the socket's
 * uid check), then the token channel's own proof tells this user's daemon from anything else on the port.
 */
async function windowsRequest(path: string, method: "GET" | "POST", route: string, body?: unknown): Promise<LocalAnswer | null> {
  try {
    lstatSync(path)
  } catch {
    return null
  }
  try {
    const userSid = currentUserSid()
    checkOwnerOnly(dirname(path), userSid)
    checkOwnerOnly(path, userSid)
    return await tokenRequest(path, method, route, body)
  } catch (error) {
    if (error instanceof AclError || error instanceof ChannelProofError) throw new LocalChannelError(error.message)
    throw error
  }
}
