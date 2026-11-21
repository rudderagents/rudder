import type { Server } from "bun"
import { hostname } from "node:os"
import { ATTACHMENT_LIMIT_BYTES, tooLarge } from "./attachments"
import { readBodyCapped } from "./body"
import { createAdapterRegistry, singleAdapterRegistry, type AdapterRegistry, type AgentAdapter } from "./adapter"
import { APP_VERSION, DAEMON_HOST, DAEMON_PORT, DEFAULT_RELAY } from "./config"
import { copyOf, type PhoneCopy } from "./phone-copy"
import { PROTOCOL_VERSION, errorFrame, eventFrame, parseFrame, resultFrame, type Frame } from "./protocol"
import { currentPairingToken, mintPairingToken, pairingTokenIsCurrent, pairUrl, redeemPairing } from "./pair"
import type { ClientData, RelayConn } from "./relay/conn"
import { DEVICE_PASS_TTL_SECONDS, type RelayIdentity } from "./relay/identity"
import { RelayLink, type RelayLinkState } from "./relay/link"
import { EventHub, type HubOptions } from "./event-hub"
import { createPerfSampler, type MachineIdentity } from "./perf"
import { PerfHub, type PerfSource } from "./perf-hub"
import { LiveActivityNotifier } from "./live-activity"
import { LiveCardNotifier } from "./live-card"
import { startLocalControl } from "./local"
import type { PushNotifier } from "./push"
import { SessionService } from "./session-service"
import type { HandoffOptions } from "./handoff"
import type { DeviceRow, Store } from "./store"
import { sendGuarded } from "./ws-send"
import { advertisedHost, hostCandidates, linkHosts, type TlsMaterial } from "./tls"

export type ServerOptions = {
  store: Store
  host?: string
  port?: number
  adapter?: AgentAdapter | AdapterRegistry
  /** Serve HTTPS/WSS with this certificate; omitted or null serves plain HTTP/WS. */
  tls?: TlsMaterial | null
  /** First host of the pair link; defaults to the bind host, or the primary LAN IPv4 for 0.0.0.0. */
  advertiseHost?: string
  /** This machine's MagicDNS name right now (`TailnetName`); added to TLS pair links and accepted as a Host. */
  tailnetName?: () => string | null
  /** Called after a device pairs and the single-use token has rotated, so the new link can be shown. */
  onPairingRotated?: () => void
  /** Replay ring and hold settings (tests shrink them). */
  events?: HubOptions
  /** Performance panel: the sample source (default: this machine) and the shortest interval (tests lower it). */
  perf?: { source?: PerfSource; minIntervalMs?: number }
  /** Lock-screen pushes through the gateway; omitted or null leaves the app on local notifications. */
  push?: PushNotifier | null
  /** Outbound relay links (the relay design notes); omitted or null opens no outbound connection. */
  relay?: RelayOptions | null
  /**
   * The CLI's unix socket (`local.ts`): `rudder pair` and `rudder devices` use it. The pairing token is never served
   * over TCP. Omitted or null: no local channel (tests read `pairLink()` directly).
   */
  localSocket?: string | null
  /** `rudder relay on|off` over the local socket. Wired after start, same as the relay list callback. */
  setRelayMode?: (mode: "on" | "off") => { mode: "on" | "off"; bases: string[] }
  relayStatus?: () => { mode: "on" | "off"; bases: string[] }
  /** Passed to SessionService (tests point it at their temp dir). */
  workspaceRoot?: string
  /** Session handoff with terminal Claude; main.ts passes Claude's folders. Omitted: off (tests never read ~/.claude). */
  handoff?: HandoffOptions | null
}

export type RelayOptions = {
  /** `wss://…` bases, one link each; `setRelayBases` changes them later. */
  bases: string[]
  /**
   * The bases came from the official relay list (relay/directory.ts), not from RUDDER_RELAY: none of them is a
   * self-hosted relay, so none rides in the pair link as `relayUrl=` or in hello `relay.base`.
   */
  discovered?: boolean
  identity: RelayIdentity
  onState?: (base: string, state: RelayLinkState) => void
  /** Test hooks for the reconnect timing. */
  minBackoffMs?: number
  maxBackoffMs?: number
}

export type PairLink = {
  /** In the link's order: the phone tries them one after another. */
  hosts: string[]
  token: string
  expiresAt: number
  url: string
  /** The same link without its token, safe for logs. */
  redacted: string
}

type SocketData = ClientData

/** A phone's connection: a Bun WebSocket on /v1/ws, or a `RelayConn` behind the relay. Both carry `ClientData`. */
type Client = { readonly data: ClientData; send(raw: string): unknown; close(code?: number, reason?: string): void }

/**
 * What a free-tier relay connection may call (§9.4); everything else answers `relay_upgrade`. Stopping a turn is free
 * too, so `message.steer` passes with `action: "cancel"` only (`freeTierAllows`).
 */
const FREE_TIER_METHODS = new Set(["hello", "permission.respond", "question.respond", "device.registerPush"])

/**
 * What a free-tier relay connection hears: approvals, questions and session status, never a transcript or a stream
 * (the free line is for answering, Pro is for reading).
 */
export const FREE_TIER_EVENTS: ReadonlySet<string> = new Set([
  "permission.asked",
  "permission.resolved",
  "question.asked",
  "question.resolved",
  "session.upsert",
  "session.removed",
  "turn.state",
  "agent.status",
  "device.push",
])

export function freeTierAllows(method: string, params: Record<string, unknown>): boolean {
  return FREE_TIER_METHODS.has(method) || method === "background.stop" || (method === "message.steer" && params.action === "cancel")
}

// Closes a revoked device's sockets; 4001 tells the app it must pair again.
const REVOKED_CLOSE = 4001
// `POST /v1/pair` is unauthenticated: a token and a device name never need more.
const PAIR_BODY_LIMIT = 4096

export function startServer(options: ServerOptions) {
  const host = options.host ?? DAEMON_HOST
  const port = options.port ?? DAEMON_PORT
  const store = options.store
  // Every start gets a fresh token, so a link printed by an earlier run is dead.
  mintPairingToken(store)
  const tls = options.tls ?? null
  const fingerprint = tls?.fingerprint ?? null
  const publicHost = options.advertiseHost ?? advertisedHost(host)
  const tailnetName = options.tailnetName ?? (() => null)
  const sockets = new Set<Client>()
  const socketsByKey = new Map<string, Set<Client>>()
  // Keyed by base; reconciled in place by setRelayBases, so an unchanged base keeps its link and its phones.
  const relayLinks = new Map<string, RelayLink>()

  const hub = new EventHub<Client>(store, options.events)
  const broadcast = (frame: Frame, delta?: Frame) => hub.publish(frame, delta)

  const closeDevice = (key: string) => {
    for (const socket of [...(socketsByKey.get(key) ?? [])]) socket.close(REVOKED_CLOSE, "device revoked")
    // Relayed connections still in their handshake are not in socketsByKey yet.
    for (const link of relayLinks.values()) link.closeDevice(key)
  }

  const adapters: AdapterRegistry = !options.adapter
    ? createAdapterRegistry()
    : "reply" in options.adapter
      ? singleAdapterRegistry(options.adapter)
      : options.adapter
  // r68 0-2: the phone whose ticket the gateway refused hears it and registers again without a cold start. Other
  // phones ignore a `deviceId` that is not theirs (hello `senderId`).
  const ticketDropped = (device: DeviceRow, reason: string) =>
    broadcast(eventFrame("device.push", { deviceId: device.id, registered: false, reason }))
  if (options.push) {
    options.push.onTicketDropped = ticketDropped
    // An approval or question notice the gateway could not take goes again while it still waits for an answer.
    options.push.stillWaiting = (payload) => service.awaitsAnswer(payload.permissionId ?? payload.questionId ?? "")
  }
  const live = new LiveActivityNotifier(store, {
    gateway: options.push?.gateway ?? null,
    onRotate: (sessionId) => broadcast(eventFrame("liveActivity.rotate", { sessionId })),
    onTicketDropped: ticketDropped,
  })
  const card = new LiveCardNotifier(store, {
    gateway: options.push?.gateway ?? null,
    agentLabel: (agentId) => adapters.get(agentId)?.spec.label,
    machineName: () => store.getMeta("machine_name") || hostname(),
    // The phone that owns the card hears it (hello `senderId`) and starts a new one; ActivityKit caps a card at 8 hours.
    onRotate: (deviceKey) => {
      const device = store.deviceByKey(deviceKey)
      if (device) broadcast(eventFrame("liveActivity.rotate", { scope: "computer", deviceId: device.id }))
    },
    onTicketDropped: ticketDropped,
  })
  // Rows left by a crash belong to a turn this process already marks idle.
  void live.abandonAll()
  void card.abandonAll()
  const service = new SessionService(store, adapters, broadcast, {
    // Deferred so the revoke result still reaches the device that revoked itself.
    deviceRevoked: (key) => setTimeout(() => closeDevice(key), 0),
    eventCursor: () => hub.lastEventId,
    push: options.push ? (payload, pushOptions) => void options.push?.notify(payload, pushOptions) : undefined,
    live,
    card,
    workspaceRoot: options.workspaceRoot,
    machineIdentity: () => knownIdentity,
    handoff: options.handoff ?? undefined,
  })
  void service.warmQuota()
  // hello.machine carries the model and OS version once a perf sample has read them (no extra spawn for hello).
  let knownIdentity: MachineIdentity | undefined
  const sampler =
    options.perf?.source ??
    createPerfSampler({
      machineName: () => service.machine().name,
      processes: () =>
        adapters.list().flatMap((adapter) => (adapter.processes?.() ?? []).map((entry) => ({ ...entry, label: adapter.spec.label }))),
    })
  const perfSource = {
    async sample() {
      const sample = await sampler.sample()
      const model = sample.machine?.model
      const osVersion = sample.machine?.osVersion
      if (model || osVersion) knownIdentity = { ...(model ? { model } : {}), ...(osVersion ? { osVersion } : {}) }
      return sample
    },
  }
  const perf = new PerfHub<Client>(perfSource, { minIntervalMs: options.perf?.minIntervalMs })
  service.startScheduler()

  const deviceLabel = (data: ClientData | undefined) => {
    const key = data?.key
    let name: string | undefined
    try {
      name = key ? store.deviceByKey(key)?.name : undefined
    } catch {
      // Only a log label: a busy database must not turn logging an error into another one.
    }
    return `device "${name || "unknown"}"`
  }

  const allowedHost = hostGuard(host, publicHost, tailnetName)

  const server: Server<SocketData> = Bun.serve<SocketData, never>({
    hostname: host,
    port,
    tls: tls ? { cert: tls.cert, key: tls.key } : undefined,
    // The largest legitimate body is one attachment; Bun's default would buffer 128 MB from anyone on the network.
    maxRequestBodySize: ATTACHMENT_LIMIT_BYTES + 64 * 1024,
    // Bun's development error page carries source and stack to whoever sent the request; anything that escapes a
    // route answers a bare 500 instead.
    development: false,
    error(error) {
      console.error(`rudderd: ${new Date().toISOString()} an HTTP request failed: ${error instanceof Error ? error.message : String(error)}`)
      return new Response("internal error", { status: 500 })
    },
    fetch(request, serverRef): Response | undefined | Promise<Response> {
      // DNS rebinding: a browser page on a hostile name that resolves here would otherwise pass the loopback check.
      if (!allowedHost(request.headers.get("host"))) return new Response("forbidden host", { status: 403 })
      const url = new URL(request.url)
      if (url.pathname === "/health") {
        return Response.json({ ok: true, version: APP_VERSION, protocol: PROTOCOL_VERSION })
      }
      if (url.pathname === "/v1/pair" && request.method === "POST") {
        return handlePair(request, store, pairingRotated)
      }
      const upload = /^\/v1\/sessions\/([^/]+)\/attachments$/.exec(url.pathname)
      if (upload && request.method === "POST") {
        return handleUpload(request, upload[1]!, url.searchParams.get("name") ?? "", store, service)
      }
      const download = /^\/v1\/sessions\/([^/]+)\/attachments\/([^/]+)$/.exec(url.pathname)
      if (download && request.method === "GET") {
        return handleDownload(request, download[1]!, download[2]!, store, service)
      }
      const preview = /^\/v1\/sessions\/([^/]+)\/turns\/([^/]+)\/preview$/.exec(url.pathname)
      if (preview && request.method === "GET") {
        return handleTurnPreview(request, preview[1]!, preview[2]!, url.searchParams, store, service)
      }
      if (url.pathname === "/v1/ws") {
        const key = bearer(request)
        if (!key || !store.deviceByKey(key)) {
          return new Response("unauthorized", { status: 401 })
        }
        const upgraded = serverRef.upgrade(request, {
          data: { key, via: "direct", tier: null, pairing: false, chunked: request.headers.get("x-rudder-chunks") === "1" },
        })
        if (!upgraded) return new Response("upgrade failed", { status: 500 })
        return undefined
      }
      return new Response("not found", { status: 404 })
    },
    websocket: {
      open(ws) {
        attach(ws)
      },
      close(ws, code, reason) {
        detach(ws, code, reason)
      },
      async message(ws, message) {
        await handleText(ws, typeof message === "string" ? message : new TextDecoder().decode(message))
      },
    },
  })

  const openedAt = new WeakMap<Client, number>()
  // Relay connections keyed with the pairing token. They may only call pair.redeem, so they never join the event hub
  // or the device sockets (a stranger holding a pairing QR must not hear session events), and they are cut as soon as
  // that token stops being the current one (redeemed, rotated or expired).
  const pairingConns = new Set<RelayConn>()

  function relayReady(conn: RelayConn) {
    if (conn.data.pairing) {
      pairingConns.add(conn)
      return
    }
    // The key was looked up when the relay opened the connection; a revoke during the handshake must still cut it.
    // Never attached, so its close is not logged as a device disconnecting.
    if (!store.deviceByKey(conn.data.key)) {
      console.log(`rudderd: ${new Date().toISOString()} a relay connection for a revoked device was closed before it attached`)
      conn.close(REVOKED_CLOSE, "device revoked")
      return
    }
    attach(conn)
  }

  function relayClosed(conn: RelayConn) {
    if (conn.data.pairing) pairingConns.delete(conn)
    else if (sockets.has(conn)) detach(conn)
  }

  function cutStalePairing() {
    // Pairing connections still waiting for the phone's first message are not in `pairingConns` yet; cut them too.
    const relayed = [...relayLinks.values()].flatMap((link) => link.connections).filter((conn) => conn.data.pairing)
    for (const conn of new Set([...pairingConns, ...relayed])) {
      if (!conn.isClosed && !pairingTokenIsCurrent(store, conn.pairingToken)) conn.close(REVOKED_CLOSE, "pairing token replaced")
    }
  }

  const pairingRotated = () => {
    cutStalePairing()
    options.onPairingRotated?.()
  }

  function attach(conn: Client) {
    sockets.add(conn)
    hub.attach(conn, conn.data.via === "relay" && conn.data.tier !== "pro" ? { only: FREE_TIER_EVENTS } : {})
    let own = socketsByKey.get(conn.data.key)
    if (!own) {
      own = new Set()
      socketsByKey.set(conn.data.key, own)
    }
    own.add(conn)
    store.touchDevice(conn.data.key)
    const via = conn.data.via === "relay" ? `the relay (${conn.data.tier})` : tls ? "wss" : "ws"
    openedAt.set(conn, Date.now())
    console.log(`rudderd: ${new Date().toISOString()} ${deviceLabel(conn.data)} connected over ${via}`)
  }

  function detach(conn: Client, code?: number, reason?: string) {
    sockets.delete(conn)
    hub.detach(conn)
    perf.detach(conn)
    const own = socketsByKey.get(conn.data.key)
    own?.delete(conn)
    if (own?.size === 0) socketsByKey.delete(conn.data.key)
    store.touchDevice(conn.data.key)
    // Time, close code and socket age, so drops can be told apart (background, network switch, timeout).
    const age = Math.round((Date.now() - (openedAt.get(conn) ?? Date.now())) / 1000)
    console.log(`rudderd: ${new Date().toISOString()} ${deviceLabel(conn.data)} disconnected (code ${code ?? "?"}${reason ? ` ${reason}` : ""}, after ${age} s)`)
  }

  function reply(conn: Client, id: string, code: string, message: string, copy?: PhoneCopy) {
    sendGuarded(conn, JSON.stringify(errorFrame(id, code, message, copy)))
  }

  /**
   * One text frame from a phone, the same for /v1/ws and the relay. Never rejects: the relay calls it without awaiting,
   * and a throw here (a busy database, a send on a closing socket) must not take other sessions down with it.
   */
  async function handleText(conn: Client, raw: string) {
    const request: { id?: string; method?: string } = {}
    try {
      await handleFrame(conn, raw, request)
    } catch (error) {
      console.error(`rudderd: ${deviceLabel(conn.data)} ${request.method ?? "frame"} failed outside the service: ${String(error)}`)
      if (request.id === undefined) return
      try {
        reply(conn, request.id, "failed", error instanceof Error ? error.message : "unknown error", copyOf(error))
      } catch (sendError) {
        console.error(`rudderd: ${deviceLabel(conn.data)} could not answer ${request.method ?? "frame"}: ${String(sendError)}`)
      }
    }
  }

  async function handleFrame(conn: Client, raw: string, request: { id?: string; method?: string }) {
    // A device revoked while connected gets no further answers, even if its close is still in flight.
    if (!conn.data.pairing && !store.deviceByKey(conn.data.key)) {
      conn.close(REVOKED_CLOSE, "device revoked")
      return
    }
    let frame: Frame
    try {
      frame = parseFrame(raw)
    } catch (error) {
      reply(conn, "parse", "bad_frame", String(error))
      return
    }
    if (frame.type !== "invoke" || !frame.method) {
      reply(conn, frame.id, "bad_frame", "expected invoke")
      return
    }
    request.id = frame.id
    request.method = frame.method
    const params = (frame.params ?? {}) as Record<string, unknown>
    // Revoked while this request awaited: drop the result and close. Only a device revoking itself still hears back.
    const ownId = conn.data.pairing ? null : (store.deviceByKey(conn.data.key)?.id ?? null)
    const stillPaired = () => {
      if (store.deviceByKey(conn.data.key)) return true
      if (frame.method === "device.revoke" && params.id === ownId) return true
      conn.close(REVOKED_CLOSE, "device revoked")
      return false
    }
    if (conn.data.pairing) {
      // Only a relay connection is ever a pairing one.
      if (!pairingTokenIsCurrent(store, (conn as RelayConn).pairingToken)) {
        conn.close(REVOKED_CLOSE, "pairing token replaced")
        return
      }
      handlePairInvoke(conn, frame.id, frame.method, params)
      return
    }
    if (conn.data.via === "relay" && conn.data.tier !== "pro") {
      if (!freeTierAllows(frame.method, params)) {
        reply(conn, frame.id, "relay_upgrade", `${frame.method} needs Rudder Pro over the relay`)
        return
      }
      // A decline's review note reaches the agent as a user message; on the free line it would be a free prompt.
      // The decline itself still goes through.
      if (frame.method === "permission.respond") {
        delete params.note
        delete params.comments
      }
    }
    if (frame.method === "hello") {
      hub.helloStarted(conn)
      const result = await service.invoke(frame.method, params, frame.id, { deviceKey: conn.data.key })
      // From here to flush() nothing awaits: the replay lands right after the result and before live events.
      const resume = hub.resume(conn, params)
      if (typeof params.lastEventId === "number") {
        const how = resume.result.resync ? "resync" : `replay to event ${resume.result.eventId}`
        console.log(`rudderd: ${deviceLabel(conn.data)} resumed after event ${params.lastEventId}: ${how}`)
      }
      if (!stillPaired()) return
      if (result.type === "result") {
        result.result = { ...(result.result as object), hosts: currentHosts(), relay: relayInfo(ownId), ...resume.result }
      }
      sendGuarded(conn, JSON.stringify(result))
      resume.flush()
      return
    }
    hub.invoked(conn)
    if (frame.method === "events.replay") {
      // Sent synchronously, so the replayed frames reach this socket before any newer live frame.
      const replay = hub.replayScope(conn, String(params.sessionId ?? ""), params.after)
      sendGuarded(conn, JSON.stringify(resultFrame(frame.id, { replayed: replay.replayed })))
      return
    }
    if (PerfHub.handles(frame.method)) {
      const result = await perf.invoke(conn, frame.method, params, frame.id)
      if (stillPaired()) sendGuarded(conn, JSON.stringify(result))
      return
    }
    // Set before the snapshot is read, so every message.* event after it reaches this socket.
    if (frame.method === "session.get" && typeof params.id === "string") hub.focus(conn, params.id)
    const result = await service.invoke(frame.method, params, frame.id, { deviceKey: conn.data.key })
    if (stillPaired()) sendGuarded(conn, JSON.stringify(result))
  }

  /** `pair.redeem {token, name}` on a relay connection keyed with the pairing token: `POST /v1/pair` over the relay. */
  function handlePairInvoke(conn: Client, id: string, method: string, params: Record<string, unknown>) {
    if (method !== "pair.redeem") {
      reply(conn, id, "pair_only", "this connection can only pair")
      return
    }
    const name = String(params.name ?? "iPhone")
    try {
      const result = redeemPairing(store, String(params.token ?? ""), name)
      sendGuarded(conn, JSON.stringify({ v: PROTOCOL_VERSION, id, type: "result", result }))
      console.log(`rudderd: paired device "${name}" over the relay`)
      conn.close(1000, "paired")
      pairingRotated()
    } catch (error) {
      const code = (error as { code?: string }).code === "pair_invalid" ? "pair_invalid" : "pair_failed"
      reply(conn, id, code, error instanceof Error ? error.message : "pair failed")
    }
  }

  function makeLink(relay: RelayOptions, base: string): RelayLink {
    return new RelayLink({
          base,
          identity: relay.identity,
          minBackoffMs: relay.minBackoffMs,
          maxBackoffMs: relay.maxBackoffMs,
          onState: (state) => relay.onState?.(base, state),
          log: (line) => console.log(`rudderd: ${line}`),
          host: {
            deviceKey: (deviceId) => store.deviceById(deviceId)?.session_key ?? null,
            pairingToken: () => currentPairingToken(store).token,
            ready: (conn: RelayConn) => relayReady(conn),
            text: (conn: RelayConn, raw: string) => void handleText(conn, raw),
            closed: (conn: RelayConn) => relayClosed(conn),
          },
        })
  }

  /**
   * The relay list changed: links to new bases start, links to removed bases stop (their phones
   * reconnect through another route), unchanged ones are left alone. Same slot and key on every base.
   */
  // Assigned before the first call. `rudder relay on` replaces it after startup, when the process began with the relay off.
  let relay: RelayOptions | null = options.relay ?? null

  function setRelayBases(bases: string[]): { added: string[]; removed: string[] } {
    if (!relay) return { added: [], removed: [] }
    const wanted = new Set(bases)
    const removed = [...relayLinks.keys()].filter((base) => !wanted.has(base))
    for (const base of removed) {
      relayLinks.get(base)?.stop()
      relayLinks.delete(base)
    }
    const added = [...wanted].filter((base) => !relayLinks.has(base))
    for (const base of added) {
      const link = makeLink(relay, base)
      relayLinks.set(base, link)
      link.start()
    }
    return { added, removed }
  }

  if (relay) setRelayBases(relay.bases)

  function stopRelay() {
    for (const link of relayLinks.values()) link.stop()
  }

  function relaySlotNow(): string | null {
    return relay?.identity.slotId ?? null
  }

  // The phone already knows the default relay; any other one rides in the link (first non-default base).
  // A discovered list (official relays) is not a self-hosted base.
  function relayUrlNow(): string | null {
    if (!relay || relay.discovered) return null
    return relay.bases.find((base) => base !== DEFAULT_RELAY) ?? null
  }

  /** `rudder relay on|off` while this process is already running. Off drops every link; on installs the identity. */
  function setRelay(next: RelayOptions | null) {
    if (!next) {
      setRelayBases([])
      relay = null
      return
    }
    relay = next
    setRelayBases(next.bases)
  }

  /**
   * hello `relay`: where this computer waits on the relay and this phone's device id there, so a phone paired before
   * the relay was on learns it without scanning again. `base` only for a self-hosted relay.
   * `bases`: every relay this computer holds its slot on right now, for phones that race them.
   * `pass`: a fresh 7-day slot pass for this device (the relay slot pass notes), renewed on every hello.
   * Null with the relay off: the app tells 「没开」 from 「太旧」 by hello `version`.
   */
  function relayInfo(deviceId: string | null): { slot: string; deviceId: string; base?: string; bases: string[]; pass: string } | null {
    const relaySlot = relaySlotNow()
    const relayUrl = relayUrlNow()
    if (!relay || !relaySlot || !deviceId) return null
    const pass = relay.identity.signPass(relaySlot, deviceId, Math.floor(Date.now() / 1000) + DEVICE_PASS_TTL_SECONDS)
    return { slot: relaySlot, deviceId, ...(relayUrl ? { base: relayUrl } : {}), bases: [...relayLinks.keys()], pass }
  }

  /** The pairing slot pass: it expires with the pairing token it rides beside in the link. */
  function pairingPass(expiresAt: number): string | null {
    const relaySlot = relaySlotNow()
    return relay && relaySlot ? relay.identity.signPass(relaySlot, "", Math.floor(expiresAt / 1000)) : null
  }

  /**
   * The pair link's addresses as `host:port`, now. hello carries them so a phone paired before Tailscale was set up
   * (or on an older LAN address) learns the computer's current ones.
   */
  function currentHosts(): string[] {
    const linkPort = server.port ?? port
    return linkHosts(host, publicHost, tailnetName(), tls !== null).map((entry) => `${entry}:${linkPort}`)
  }

  function pairLink(): PairLink {
    const { token, expiresAt } = currentPairingToken(store)
    const linkPort = server.port ?? port
    const hosts = linkHosts(host, publicHost, tailnetName(), tls !== null)
    return {
      hosts,
      token,
      expiresAt,
      url: pairUrl(hosts, linkPort, token, fingerprint, expiresAt, relaySlotNow(), relayUrlNow(), process.platform, pairingPass(expiresAt)),
      redacted: pairUrl(hosts, linkPort, null, fingerprint, expiresAt, relaySlotNow(), relayUrlNow(), process.platform),
    }
  }

  // Invalidates the current link and returns a new one (`rudder pair` over the local socket, or SIGUSR1 in main.ts).
  function rotatePairing(): PairLink {
    mintPairingToken(store)
    cutStalePairing()
    return pairLink()
  }

  const local = options.localSocket
    ? startLocalControl({
        path: options.localSocket,
        store,
        machine: () => service.machine().name,
        pairLink,
        rotatePairing,
        isConnected: (key) => (socketsByKey.get(key)?.size ?? 0) > 0,
        revoke: (id) => {
          const removed = store.deleteDevice(id)
          if (removed) closeDevice(removed.session_key)
          return removed
        },
        attach: service.handoff ? (body) => service.attachLocal(body) : undefined,
        attachDone: service.handoff ? (body) => service.attachLocalDone(body) : undefined,
        setRelayMode: options.setRelayMode,
        relayStatus: options.relayStatus,
      })
    : null

  return {
    server,
    service,
    adapters,
    fingerprint,
    pairLink,
    rotatePairing,
    broadcast,
    hub,
    perf,
    get relaySlot() {
      return relaySlotNow()
    },
    setRelay,
    relayLinks: () => [...relayLinks.values()],
    setRelayBases,
    stopRelay,
    local,
  }
}

async function handlePair(request: Request, store: Store, onRotated: (() => void) | undefined) {
  const tooBig = () => Response.json({ error: "pair request too large" }, { status: 413 })
  if (Number(request.headers.get("content-length") ?? 0) > PAIR_BODY_LIMIT) return tooBig()
  try {
    const text = await readBodyCapped(request, PAIR_BODY_LIMIT)
    if (text === undefined) return tooBig()
    const body = JSON.parse(text) as { token?: string; name?: string }
    const result = redeemPairing(store, String(body.token ?? ""), String(body.name ?? "iPhone"))
    onRotated?.()
    return Response.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : "pair failed"
    const status = (error as { code?: string }).code === "pair_invalid" ? 401 : 400
    return Response.json({ error: message }, { status })
  }
}

/**
 * `POST /v1/sessions/:id/attachments?name=<file name>`, raw bytes as the body, the device key as bearer: a separate
 * short request, never a WebSocket frame. 201 with the attachment's `id` for `message.send {attachments}`.
 */
/** Path segments as the router matched them (still percent-encoded); null when one is not valid encoding. */
function decodeSegments(...raw: string[]): string[] | null {
  try {
    return raw.map((segment) => decodeURIComponent(segment))
  } catch {
    return null
  }
}

const badPath = () => Response.json({ error: "malformed path" }, { status: 400 })

// The session routes take their ids still encoded and decode only after the device key checks out, so a stranger's
// malformed path gets the same 401 as any other.
async function handleUpload(request: Request, rawSessionId: string, name: string, store: Store, service: SessionService) {
  const key = bearer(request)
  if (!key || !store.deviceByKey(key)) return Response.json({ error: "unauthorized" }, { status: 401 })
  const [sessionId] = decodeSegments(rawSessionId) ?? []
  if (sessionId === undefined) return badPath()
  const declared = Number(request.headers.get("content-length") ?? 0)
  if (declared > ATTACHMENT_LIMIT_BYTES) return Response.json({ error: tooLarge().message, code: "too_large" }, { status: 413 })
  try {
    const data = new Uint8Array(await request.arrayBuffer())
    const attachment = await service.uploadAttachment(sessionId, name, data)
    return Response.json({ attachment: { id: attachment.id, name: attachment.name, bytes: attachment.bytes } }, { status: 201 })
  } catch (error) {
    const code = (error as { code?: string }).code
    const status = code === "not_found" ? 404 : code === "too_large" ? 413 : code === "forbidden" ? 403 : 500
    const message = error instanceof Error ? error.message : "upload failed"
    if (status === 500) console.error(`rudderd: attachment upload to ${sessionId} failed: ${message}`)
    return Response.json({ error: message, code: code ?? "internal" }, { status })
  }
}

/** `GET /v1/sessions/:id/attachments/:attachmentId` with the device key. The body is the file; the path stays on this computer. */
async function handleDownload(request: Request, rawSessionId: string, rawAttachmentId: string, store: Store, service: SessionService) {
  const key = bearer(request)
  if (!key || !store.deviceByKey(key)) return Response.json({ error: "unauthorized" }, { status: 401 })
  const [sessionId, attachmentId] = decodeSegments(rawSessionId, rawAttachmentId) ?? []
  if (sessionId === undefined || attachmentId === undefined) return badPath()
  const file = await service.readAttachment(sessionId, attachmentId).catch(() => null)
  if (!file) return Response.json({ error: "not found" }, { status: 404 })
  return new Response(file.data, { headers: { "content-type": file.mediaType, "content-length": String(file.data.byteLength) } })
}

/**
 * `GET /v1/sessions/:id/turns/:turnId/preview?path=<file>&side=before|after` with the device key: one side of a binary
 * image in the turn's changes, from the turn's start / end snapshot. 404 when there is no such picture.
 */
async function handleTurnPreview(request: Request, rawSessionId: string, rawTurnId: string, query: URLSearchParams, store: Store, service: SessionService) {
  const key = bearer(request)
  if (!key || !store.deviceByKey(key)) return Response.json({ error: "unauthorized" }, { status: 401 })
  const [sessionId, turnId] = decodeSegments(rawSessionId, rawTurnId) ?? []
  if (sessionId === undefined || turnId === undefined) return badPath()
  const file = await service.readTurnPreview(sessionId, turnId, query.get("path") ?? "", query.get("side") ?? "").catch(() => null)
  if (!file) return Response.json({ error: "not found" }, { status: 404 })
  return new Response(file.data, { headers: { "content-type": file.mediaType, "content-length": String(file.data.byteLength) } })
}

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1"]

/**
 * Accepts loopback names, the bind and advertised hosts, this machine's name and MagicDNS name, and any current
 * LAN or Tailscale IPv4 (re-read on a miss, since interfaces come and go).
 */
function hostGuard(bindHost: string, publicHost: string, tailnetName: () => string | null) {
  const name = hostname().toLowerCase()
  const fixed = new Set([...LOOPBACK_HOSTS, bindHost, publicHost, name, `${name.replace(/\.local$/, "")}.local`].map((h) => h.toLowerCase()))
  return (header: string | null): boolean => {
    if (!header) return false
    const requested = hostOnly(header)
    if (fixed.has(requested) || requested === tailnetName()) return true
    return hostCandidates().some((candidate) => candidate.address === requested)
  }
}

function hostOnly(header: string): string {
  const value = header.trim().toLowerCase()
  if (value.startsWith("[")) return value.slice(1, value.indexOf("]") === -1 ? undefined : value.indexOf("]"))
  const colon = value.lastIndexOf(":")
  // One colon is host:port; more is a bare IPv6 address.
  return colon !== -1 && value.indexOf(":") === colon ? value.slice(0, colon) : value
}

function bearer(request: Request): string | null {
  const header = request.headers.get("authorization") ?? ""
  const prefix = "Bearer "
  if (!header.startsWith(prefix)) return null
  return header.slice(prefix.length)
}
