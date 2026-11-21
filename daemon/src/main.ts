import { chmodSync, mkdirSync, statSync } from "node:fs"
import { APP_VERSION, DAEMON_HOST, DAEMON_PORT, DATA_DIR, DB_PATH, PUSH_GATEWAY, relayPlan, relaySetting, TLS_ENABLED } from "./config"
import { runCli } from "./cli"
import { currentProgram } from "./launchd"
import { DaemonAlreadyRunningError, localSocketPath, refuseIfDaemonRunning } from "./local"
import { claudeHandoffDirs } from "./handoff/dirs"
import { isWindows } from "./platform"
import { restrictToUser } from "./platform/win32-acl"
import { parseGateway, PushNotifier } from "./push"
import { pairBanner, terminalLocale } from "./qr"
import { RelayDirectory } from "./relay/directory"
import { loadRelayIdentity } from "./relay/identity"
import { readRelayMode, writeRelayMode } from "./relay/mode"
import type { RelayLinkState } from "./relay/link"
import { writeRelayState } from "./relay/state"
import { startServer } from "./server"
import { Store } from "./store"
import { TailnetName } from "./tailnet"
import { ensureTlsMaterial, hostCandidates } from "./tls"
import { freshCache, latestVersion, newerVersion, shouldCheckForUpdates, updateLogLine, updateNotice } from "./update-check"

// `rudder pair | devices | install | uninstall | status | help | --version`; with no argument this process is the daemon.
const exitCode = await runCli(process.argv.slice(2))
if (exitCode !== null) process.exit(exitCode)

// Last resort: one stray promise or callback must not end every session and the phone's link. Log and keep serving.
process.on("unhandledRejection", (reason) => {
  console.error(`rudderd: ${new Date().toISOString()} unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`)
})
process.on("uncaughtException", (error, origin) => {
  console.error(`rudderd: ${new Date().toISOString()} uncaught exception (${origin}): ${error.stack ?? error.message}`)
})

// RUDDER_HOME holds the db, TLS key and pairing token: owner only, also for installs made before this.
mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
// Windows has no mode bits: an ACL for this user and SYSTEM only (platform/win32-acl.ts).
if (isWindows()) restrictToUser(DATA_DIR, { directory: true })
else chmodSync(DATA_DIR, statSync(DATA_DIR).mode & 0o700)
// Before the db, the certificate or the port: the socket cleanup in startLocalControl would unlink a live daemon's socket.
try {
  await refuseIfDaemonRunning(DATA_DIR)
} catch (error) {
  if (!(error instanceof DaemonAlreadyRunningError)) throw error
  console.error(error.message)
  process.exit(1)
}
const store = new Store(DB_PATH)
store.recoverIncompleteCopies()
store.seedIfEmpty()
// Resolved before the certificate so a first-run certificate names it; re-read because Tailscale comes and goes.
const tailnet = new TailnetName()
if (TLS_ENABLED) {
  await tailnet.refresh()
  tailnet.watch(5 * 60 * 1000)
}
const tls = TLS_ENABLED ? ensureTlsMaterial(DATA_DIR, { sanNames: tailnet.current ? [tailnet.current] : [] }) : null
const push = PUSH_GATEWAY ? new PushNotifier(store, { gateway: parseGateway(PUSH_GATEWAY) }) : null
// RUDDER_RELAY=off: no relay key is made and nothing connects out (the relay design notes).
const plan = relayPlan(relaySetting(process.env.RUDDER_RELAY, readRelayMode(DATA_DIR)))
let relayIdentity = plan.bases.length > 0 ? loadRelayIdentity(DATA_DIR) : null
const relayStates = new Map<string, { state: RelayLinkState; since: number }>()
// `on` (or unset once the relay is on by default): the official relay list picks the bases; an
// explicit RUDDER_RELAY list is used as written. The list's onChange needs `started`, so it is wired after start.
let onRelayList: (bases: string[]) => void = () => {}
let relayDirectory =
  relayIdentity && plan.discover
    ? new RelayDirectory({ dataDir: DATA_DIR, onChange: (next) => onRelayList(next), log: (line) => console.log(`rudderd: ${line}`) })
    : null
let applyRelayMode: (mode: "on" | "off") => { mode: "on" | "off"; bases: string[] } = (mode) => ({ mode, bases: [] })
const bases = relayDirectory?.bases ?? plan.bases
const saveRelayState = () =>
  writeRelayState(DATA_DIR, {
    slotId: relayIdentity?.slotId ?? "",
    pid: process.pid,
    links: [...relayStates].map(([base, entry]) => ({ base, ...entry })),
  })
saveRelayState()
const started = startServer({
  store,
  host: DAEMON_HOST,
  port: DAEMON_PORT,
  tls,
  push,
  tailnetName: () => tailnet.current,
  onPairingRotated: () => announcePair("next"),
  relay: relayIdentity
    ? {
        bases,
        discovered: relayDirectory !== null,
        identity: relayIdentity,
        onState: (base, state) => {
          relayStates.set(base, { state, since: Date.now() })
          saveRelayState()
        },
      }
    : null,
  localSocket: localSocketPath(DATA_DIR),
  setRelayMode: (mode) => applyRelayMode(mode),
  relayStatus: () => ({ mode: relayIdentity ? "on" : "off", bases: relayDirectory?.bases ?? (relayIdentity ? bases : []) }),
  // Session handoff reads Claude's registry and transcripts (session-handoff.md); macOS and Linux only for now.
  handoff: isWindows() ? null : claudeHandoffDirs(),
})
applyRelayMode = (mode) => {
  writeRelayMode(DATA_DIR, mode)
  if (mode === "off") {
    relayDirectory?.stop()
    relayDirectory = null
    relayIdentity = null
    started.setRelay(null)
    relayStates.clear()
    saveRelayState()
    return { mode, bases: [] }
  }
  const identity = relayIdentity ?? loadRelayIdentity(DATA_DIR)
  relayIdentity = identity
  if (!relayDirectory) {
    relayDirectory = new RelayDirectory({
      dataDir: DATA_DIR,
      onChange: (next) => onRelayList(next),
      log: (line) => console.log(`rudderd: ${line}`),
    })
    relayDirectory.start()
  }
  const nextBases = relayDirectory.bases
  started.setRelay({
    bases: nextBases,
    discovered: true,
    identity,
    onState: (base, state) => {
      relayStates.set(base, { state, since: Date.now() })
      saveRelayState()
    },
  })
  saveRelayState()
  console.log(`rudderd: relay on, slot ${identity.slotId} via ${nextBases.join(", ")}`)
  return { mode, bases: nextBases }
}
onRelayList = (next) => {
  const { added, removed } = started.setRelayBases(next)
  for (const base of removed) relayStates.delete(base)
  saveRelayState()
  if (added.length || removed.length) console.log(`rudderd: relay list now ${next.join(", ")}`)
}
relayDirectory?.start()
// Probe the agents now, so the first phone's hello answers from known results instead of waiting on each probe.
void started.service.refreshAgents()
// Agent images past their byte budget or age limit go now; later ones a while after each new image.
void started.service.pruneAgentImages()

// A Homebrew install says when the tap has a newer rudder (RUDDER_UPDATE_CHECK=off turns it off).
// A fresh cached answer goes into the banner; otherwise one check runs after it and prints its own line.
const program = currentProgram()
const checksUpdates = program.kind === "binary" && shouldCheckForUpdates(program.path)
const cachedUpdate = checksUpdates ? freshCache(DATA_DIR) : null
let newer = cachedUpdate ? newerVersion(cachedUpdate.latest, APP_VERSION) : null

function printUpdate(version: string) {
  console.log(process.stdout.isTTY ? updateNotice(version, APP_VERSION, terminalLocale()) : updateLogLine(version, APP_VERSION))
}

// The token pairs a device, so it is only printed to a terminal (as a QR code); logs and pipes get the link without it.
function announcePair(label: "pair" | "next") {
  const link = started.pairLink()
  if (process.stdout.isTTY) {
    const locale = terminalLocale()
    const next =
      locale === "zh" ? "\n已配对一台设备。下一台用这个新码：" : "\nPaired a device. The next one uses this new code:"
    console.log(label === "next" ? next : "")
    const notice = newer ? updateNotice(newer, APP_VERSION, locale) : null
    for (const line of pairBanner(link, started.service.machine().name, locale, notice)) console.log(line)
  } else {
    console.log(`${label}: ${link.redacted} (token hidden: stdout is not a terminal)`)
    console.log("  full link: run `rudder pair` on this machine, as this user")
    if (newer && label === "pair") console.log(updateLogLine(newer, APP_VERSION))
  }
}

const scheme = tls ? "https" : "http"
console.log(`rudderd ${scheme}://${DAEMON_HOST}:${started.server.port}`)
if (tls) {
  console.log(`tls: ${tls.created ? "created" : "using"} ${tls.certPath}`)
  console.log(`fingerprint (sha256): ${tls.fingerprint}`)
} else {
  console.warn("rudderd: RUDDER_TLS=0, serving plain HTTP/WS with no certificate pin. Simulator/local dev only.")
}
if (DAEMON_HOST === "0.0.0.0" || DAEMON_HOST === "::") {
  const candidates = hostCandidates()
  const list = candidates.map((c) => `${c.address} (${c.iface}, ${c.kind})`).join(", ")
  console.log(`addresses: ${list || "none besides loopback"}; the pair link carries ${started.pairLink().hosts.join(", ")}`)
  if (tls && candidates.some((c) => c.kind === "tailscale")) {
    console.log(
      tailnet.current
        ? `tailnet: ${tailnet.current} (the phone falls back to it away from this network)`
        : "tailnet: Tailscale is up but MagicDNS did not name this machine; turn on MagicDNS so the phone can use the tailnet",
    )
  }
  if (!tls) console.warn("rudderd: plain HTTP on 0.0.0.0 exposes the session key to the network; unset RUDDER_TLS")
}
console.log(push ? `push: gateway ${push.gateway}` : "push: off (RUDDER_PUSH_GATEWAY=off)")
console.log(
  relayIdentity
    ? `relay: slot ${relayIdentity.slotId} via ${bases.join(", ")}${relayDirectory ? " (relay list, refreshed daily)" : ""}`
    : "relay: off (run `rudder relay on`, or set RUDDER_RELAY=on)",
)
const adapterMode = process.env.RUDDER_ADAPTER === "fake" ? "fake for every agent" : "per-agent registry"
console.log(`adapter: ${adapterMode} (set RUDDER_ADAPTER=fake for the demo adapter)`)
announcePair("pair")
if (checksUpdates && !cachedUpdate) {
  void latestVersion({ dataDir: DATA_DIR }).then((latest) => {
    newer = newerVersion(latest, APP_VERSION)
    if (newer) printUpdate(newer)
  })
}

// Long-lived agent children (Claude per session, Codex app-server, ACP agents) go down with the daemon.
async function shutdown(signal: string) {
  console.log(`rudderd: ${signal}, stopping agents`)
  started.service.stopScheduler()
  started.perf.stop()
  relayDirectory?.stop()
  started.stopRelay()
  started.hub.close()
  started.local?.stop()
  started.server.stop()
  // Abort live turns first so each writes its final rows and idle status before the agents die.
  await started.service.shutdown(2000)
  await Promise.allSettled(started.adapters.list().map((adapter) => adapter.dispose?.()))
  process.exit(0)
}
// Windows has no SIGUSR1 (`rudder pair` rotates the code over the local channel anyway). Ctrl+C arrives as SIGINT
// there too; Ctrl+Break is SIGBREAK and closing the console window SIGHUP, which leaves a few seconds to stop agents.
if (isWindows()) {
  process.once("SIGBREAK", () => void shutdown("SIGBREAK"))
  process.once("SIGHUP", () => void shutdown("SIGHUP"))
} else {
  process.on("SIGUSR1", () => {
    started.rotatePairing()
    announcePair("pair")
  })
}
process.once("SIGINT", () => void shutdown("SIGINT"))
process.once("SIGTERM", () => void shutdown("SIGTERM"))
