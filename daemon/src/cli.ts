import { resolve } from "node:path"
import { collectAgentDiagnostics } from "./adapter/diagnostics"
import { createAdapterRegistry } from "./adapter"
import { existsSync } from "node:fs"
import { APP_VERSION, DAEMON_HOST, DAEMON_PORT, DATA_DIR, DB_PATH, TLS_ENABLED } from "./config"
import { readRelayMode, writeRelayMode } from "./relay/mode"
import {
  commandName,
  currentProgram,
  DEFAULT_LABEL,
  daemonOrigin,
  parseServiceArgs,
  probeHealth,
  runService,
  type ServiceCommand,
  UsageError,
} from "./launchd"
import {
  DeviceMatchError,
  describeDevices,
  type LocalAnswer,
  LocalChannelError,
  type LocalDevice,
  localRequest,
  localSocketPath,
  matchDevice,
} from "./local"
import { isWindows } from "./platform"
import { defaultTaskContext, runTaskCommand } from "./platform/win32-service"
import { attach, terminalRun } from "./handoff/attach-cli"
import { clockTime, pairBanner, type TerminalLocale, terminalLocale } from "./qr"
import { Store } from "./store"

export const USAGE = `usage: rudder [command]
  (none)              run the daemon in this terminal and show a pairing QR code (if one already runs: its code)
  pair [--json]       show a fresh pairing QR code and link for the running daemon; --json prints
                      one line {url, expiresAt, machine} for scripts
  devices             list paired phones: id, name, when paired, last seen
  devices revoke X    revoke the phone named X (or with id X): it is disconnected and must pair again
  attach ID [--now]   continue the phone session ID (its short id) in this terminal with claude; the phone
                      watches until you quit, then gets it back. --now stops a running phone turn first
  relay on|off        save the official relay in RUDDER_HOME and apply it to the running daemon.
                      With no daemon running, the next \`rudder\` or \`rudder install\` uses it.
                      RUDDER_RELAY, when set, still overrides the saved mode. The default is on.
  install             run it as a LaunchAgent: starts at login, restarts after a crash
  uninstall           stop it and remove the plist; --purge also deletes the data dir and logs
  diagnose [DIR]      inspect native agent MCP and hook configuration without a model task
  status              loaded or not, pid, last exit, PATH and log files
  --version           print the version
  help                this text
From a source checkout, run bun run src/main.ts [command] in daemon/.
RUDDER_PORT, RUDDER_HOST, RUDDER_HOME and RUDDER_TLS=0 configure the daemon; pair and devices reach it over the
owner-only socket RUDDER_HOME/rudder.sock, so run them as the same user with the same RUDDER_HOME;
RUDDER_PUSH_GATEWAY=off turns lock-screen pushes off;
RUDDER_UPDATE_CHECK=off stops the daily look for a newer Homebrew release;
RUDDER_LAUNCHD_LABEL overrides the label ${DEFAULT_LABEL}.`

/** The same commands on Windows, where install means a logon Scheduled Task and the channel is a token file. */
export function usageFor(platform: NodeJS.Platform = process.platform): string {
  if (!isWindows(platform)) return USAGE
  return USAGE.replace(
    "install             run it as a LaunchAgent: starts at login, restarts after a crash",
    "install             run it as the Scheduled Task \"Rudder\": starts at logon (no window), restarts after a crash",
  )
    .replace("stop it and remove the plist; --purge also deletes the data dir and logs", "stop it and remove the task; --purge also deletes the data dir and logs")
    .replace("loaded or not, pid, last exit, PATH and log files", "task state, pid, last result and log files")
    .replace("owner-only socket RUDDER_HOME/rudder.sock", "owner-only channel RUDDER_HOME\\rudder-local.json")
    .replace("look for a newer Homebrew release", "look for a newer release")
    .replace(`RUDDER_LAUNCHD_LABEL overrides the label ${DEFAULT_LABEL}.`, "RUDDER_TASK_NAME overrides the task name Rudder.")
}

export type CliCommand =
  | ServiceCommand
  | { kind: "run" }
  | { kind: "diagnose"; cwd?: string }
  | { kind: "pair"; json: boolean }
  | { kind: "devices" }
  | { kind: "revoke"; target: string }
  | { kind: "attach"; target: string; now: boolean }
  | { kind: "relay"; mode: "on" | "off" | "status" }
  | { kind: "version" }
  | { kind: "help" }

export function parseCli(argv: string[]): CliCommand {
  const [command, ...rest] = argv
  const bare = (parsed: CliCommand): CliCommand => {
    if (rest.length > 0) throw new UsageError(`unknown option for ${command}: ${rest.join(" ")}`)
    return parsed
  }
  switch (command) {
    case undefined:
      return { kind: "run" }
    case "diagnose":
      if (rest.length > 1 || rest[0]?.startsWith("-")) throw new UsageError("diagnose takes one optional project directory")
      return { kind: "diagnose", cwd: rest[0] }
    case "pair": {
      const json = rest.includes("--json")
      const extra = rest.filter((arg) => arg !== "--json")
      if (extra.length > 0) throw new UsageError(`unknown option for pair: ${extra.join(" ")}`)
      return { kind: "pair", json }
    }
    case "devices": {
      if (rest.length === 0) return { kind: "devices" }
      const [sub, target, ...extra] = rest
      if (sub !== "revoke") throw new UsageError(`unknown devices command: ${sub}`)
      if (!target || extra.length > 0) throw new UsageError("devices revoke takes one name or id")
      return { kind: "revoke", target }
    }
    case "attach": {
      const now = rest.includes("--now")
      const ids = rest.filter((arg) => arg !== "--now")
      if (ids.length !== 1 || ids[0]!.startsWith("-")) throw new UsageError("attach takes one session id (the short id from the phone)")
      return { kind: "attach", target: ids[0]!, now }
    }
    case "relay": {
      const [sub, ...extra] = rest
      if (extra.length > 0) throw new UsageError("relay takes only on or off")
      if (sub === undefined || sub === "status") return { kind: "relay", mode: "status" }
      if (sub === "on" || sub === "off") return { kind: "relay", mode: sub }
      throw new UsageError(`unknown relay command: ${sub}`)
    }
    case "--version":
    case "-v":
    case "version":
      return bare({ kind: "version" })
    case "help":
    case "--help":
    case "-h":
      return { kind: "help" }
    default:
      return parseServiceArgs(argv)
  }
}

export type PairInfo = { url: string; expiresAt: number; machine: string }

export type LocalDeps = {
  /** The daemon's unix socket in RUDDER_HOME (`local.ts`). */
  socket: string
  /** null when no daemon listens on the socket. */
  request: (method: "GET" | "POST", route: string, body?: unknown) => Promise<LocalAnswer | null>
  /** An origin where something answers /health on the configured port although the socket is silent, else null. */
  portAnswers: () => Promise<string | null>
  tty: boolean
  out: (line: string) => void
  err: (line: string) => void
  command: string
  locale: TerminalLocale
}

export type PairDeps = LocalDeps

export type DevicesDeps = LocalDeps & {
  /** The db at RUDDER_HOME for when no daemon runs; null when there is none yet. */
  openStore: () => Store | null
  /** Where `rudder relay on|off` writes. Defaults to RUDDER_HOME. */
  dataDir?: string
  /** This process's RUDDER_RELAY, which overrides the saved mode for a daemon started from it. */
  envRelay?: string
}

class CliError extends Error {}

function readPairInfo(body: unknown): PairInfo {
  const info = (body ?? {}) as Record<string, unknown>
  if (typeof info.url !== "string" || typeof info.expiresAt !== "number") throw new CliError("the daemon did not return a pair link")
  return { url: info.url, expiresAt: info.expiresAt, machine: typeof info.machine === "string" ? info.machine : "" }
}

async function notRunning(deps: LocalDeps): Promise<CliError> {
  const port = await deps.portAnswers()
  if (port) {
    return new CliError(
      `a rudder answers on ${port} but not on ${deps.socket}: it is older than this command or uses another RUDDER_HOME. ` +
        `Restart it (\`${deps.command} install\` again, or quit the one in a terminal and run \`${deps.command}\`)`,
    )
  }
  return new CliError(
    `no rudder is running for ${deps.socket}. Start one with \`${deps.command}\` (in a terminal) or \`${deps.command} install\` ` +
      "(in the background), or set RUDDER_HOME to the data dir it runs with",
  )
}

/** Something already listens on this RUDDER_HOME's socket. */
export async function daemonAnswers(deps: LocalDeps): Promise<boolean> {
  return (await deps.request("GET", "/local/pair")) !== null
}

function failed(deps: LocalDeps, name: string, error: unknown): number {
  if (!(error instanceof CliError || error instanceof LocalChannelError)) throw error
  deps.err(`rudder ${name}: ${error.message}`)
  return 1
}

type RelayReport = { mode?: unknown; bases?: unknown }

/** Saves `on` or `off` and asks the running daemon to apply it. A stopped daemon picks the file up next start. */
export async function setRelay(deps: LocalDeps & { dataDir?: string; envRelay?: string }, mode: "on" | "off" | "status"): Promise<number> {
  const dataDir = deps.dataDir ?? DATA_DIR
  try {
    if (mode === "status") {
      const saved = readRelayMode(dataDir)
      const answer = await deps.request("GET", "/local/relay")
      const live = answer?.status === 200 ? (answer.body as RelayReport) : null
      const liveMode = live?.mode === "on" || live?.mode === "off" ? live.mode : null
      const bases = Array.isArray(live?.bases) ? live.bases.filter((base): base is string => typeof base === "string") : []
      deps.out(`relay: ${liveMode ?? saved ?? "off"}${bases.length > 0 ? ` via ${bases.join(", ")}` : ""}`)
      if (deps.envRelay !== undefined && deps.envRelay.trim() !== "") deps.out(`RUDDER_RELAY=${deps.envRelay} overrides the saved mode when a daemon starts from this environment`)
      return 0
    }
    writeRelayMode(dataDir, mode)
    if (deps.envRelay !== undefined && deps.envRelay.trim() !== "") {
      deps.out(`saved relay ${mode}. RUDDER_RELAY=${deps.envRelay} still overrides it for a daemon started from this environment`)
    }
    const answer = await deps.request("POST", "/local/relay", { mode })
    if (answer === null) {
      deps.out(`relay ${mode}: saved. It takes effect the next time rudder starts.`)
      return 0
    }
    if (answer.status !== 200) throw new CliError(`the daemon answered ${answer.status} for relay ${mode}`)
    const body = answer.body as RelayReport
    const bases = Array.isArray(body.bases) ? body.bases.filter((base): base is string => typeof base === "string") : []
    deps.out(mode === "on" ? `relay on${bases.length > 0 ? `: ${bases.join(", ")}` : ""}` : "relay off")
    return 0
  } catch (error) {
    return failed(deps, "relay", error)
  }
}

/** Asks the running daemon, over its own socket, to invalidate the current code, then shows the new one. */
export async function pair(deps: PairDeps, options: { json: boolean }): Promise<number> {
  try {
    const answer = await deps.request("POST", "/local/pair")
    if (answer === null) throw await notRunning(deps)
    if (answer.status !== 200) throw new CliError(`the daemon answered ${answer.status} for a fresh code`)
    const fresh = readPairInfo(answer.body)
    if (options.json) {
      deps.out(JSON.stringify({ url: fresh.url, expiresAt: fresh.expiresAt, machine: fresh.machine }))
    } else if (deps.tty) {
      for (const line of pairBanner(fresh, fresh.machine, deps.locale)) deps.out(line)
    } else {
      deps.out(fresh.url)
      deps.out(`single use, valid until ${clockTime(fresh.expiresAt)}`)
    }
    return 0
  } catch (error) {
    return failed(deps, "pair", error)
  }
}

function dateTime(epochMs: number): string {
  const at = new Date(epochMs)
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}

/** One line per phone: short id, name, paired at, last seen. */
export function deviceLines(devices: LocalDevice[]): string[] {
  const width = Math.max(4, ...devices.map((device) => device.name.length))
  return devices.map((device) => {
    const seen = device.connected ? "connected now" : device.lastSeenAt ? `last seen ${dateTime(device.lastSeenAt)}` : "last seen unknown"
    return `  ${device.id.slice(0, 8)}  ${device.name.padEnd(width)}  paired ${dateTime(device.createdAt)}  ${seen}`
  })
}

function readDevices(body: unknown): LocalDevice[] {
  const devices = (body as { devices?: unknown } | null)?.devices
  if (!Array.isArray(devices)) throw new CliError("the daemon did not return a device list")
  return devices as LocalDevice[]
}

/** `rudder devices`: from the running daemon, or straight from the db when none runs. */
export async function listDevices(deps: DevicesDeps): Promise<number> {
  try {
    const answer = await deps.request("GET", "/local/devices")
    let devices: LocalDevice[]
    let where: string
    if (answer !== null) {
      if (answer.status !== 200) throw new CliError(`the daemon answered ${answer.status}`)
      devices = readDevices(answer.body)
      where = "the running rudder"
    } else {
      // Something on the port but not on the socket may be an old daemon with this db open: do not guess.
      if (await deps.portAnswers()) throw await notRunning(deps)
      const store = deps.openStore()
      devices = store ? describeDevices(store) : []
      store?.db.close()
      where = "rudder is not running; read from its database"
    }
    if (devices.length === 0) {
      deps.out(`no paired phones (${where}); pair one with \`${deps.command} pair\``)
      return 0
    }
    deps.out(`${devices.length} paired ${devices.length === 1 ? "phone" : "phones"} (${where}):`)
    for (const line of deviceLines(devices)) deps.out(line)
    deps.out(`revoke one with \`${deps.command} devices revoke <name or id>\``)
    return 0
  } catch (error) {
    return failed(deps, "devices", error)
  }
}

/** `rudder devices revoke <name|id>`: the daemon closes its sockets with 4001 and deletes its key. */
export async function revokeDevice(deps: DevicesDeps, target: string): Promise<number> {
  try {
    const answer = await deps.request("POST", "/local/devices/revoke", { target })
    let revoked: { id: string; name: string }
    if (answer !== null) {
      const body = (answer.body ?? {}) as { device?: { id: string; name: string }; error?: string }
      if (answer.status !== 200 || !body.device) throw new CliError(body.error ?? `the daemon answered ${answer.status}`)
      revoked = body.device
    } else {
      if (await deps.portAnswers()) throw await notRunning(deps)
      const store = deps.openStore()
      if (!store) throw new CliError("no paired phones: rudder has not run with this RUDDER_HOME")
      try {
        const device = matchDevice(store.listDevices(), target)
        store.deleteDevice(device.id)
        revoked = device
      } catch (error) {
        if (error instanceof DeviceMatchError) throw new CliError(error.message)
        throw error
      } finally {
        store.db.close()
      }
    }
    deps.out(`revoked ${revoked.name} (${revoked.id.slice(0, 8)}): its key is deleted and it must pair again`)
    return 0
  } catch (error) {
    return failed(deps, "devices revoke", error)
  }
}

function defaultDevicesDeps(): DevicesDeps {
  const socket = localSocketPath(DATA_DIR)
  const daemon = { host: DAEMON_HOST, port: DAEMON_PORT }
  const origins = [daemonOrigin({ ...daemon, tls: TLS_ENABLED }), daemonOrigin({ ...daemon, tls: !TLS_ENABLED })]
  return {
    socket,
    request: (method, route, body) => localRequest(socket, method, route, body),
    portAnswers: async () => {
      for (const origin of origins) if (await probeHealth(`${origin}/health`)) return origin
      return null
    },
    openStore: () => (existsSync(DB_PATH) ? new Store(DB_PATH) : null),
    tty: process.stdout.isTTY === true,
    out: console.log,
    err: console.error,
    command: commandName(currentProgram()),
    locale: terminalLocale(),
    dataDir: DATA_DIR,
    envRelay: process.env.RUDDER_RELAY,
  }
}

/** Every command except running the daemon; null means run it. */
export async function runCli(argv: string[]): Promise<number | null> {
  let command: CliCommand
  try {
    command = parseCli(argv)
  } catch (error) {
    if (!(error instanceof UsageError)) throw error
    console.error(`rudder: ${error.message}\n${usageFor()}`)
    return 2
  }
  switch (command.kind) {
    case "run": {
      // A second daemon would only fail on the taken port: show the running one's pairing code instead.
      const deps = defaultDevicesDeps()
      if (!(await daemonAnswers(deps))) return null
      deps.out("rudder is already running (installed, or in another terminal); here is a fresh pairing code.")
      return pair(deps, { json: false })
    }
    case "help":
      console.log(usageFor())
      return 0
    case "version":
      console.log(`rudder ${APP_VERSION}`)
      return 0
    case "diagnose": {
      const cwd = resolve(command.cwd || process.cwd())
      const registry = createAdapterRegistry("real")
      try {
        const agents = await collectAgentDiagnostics(["claude", "codex"].map(id => registry.get(id)!), cwd)
        console.log(JSON.stringify({ cwd, behavioralVerification: "not-run", agents }, null, 2))
        return agents.some(agent => agent.state === "failed") ? 1 : 0
      } finally {
        const cleanup = await Promise.allSettled(registry.list().map(adapter => adapter.dispose?.()))
        if (cleanup.some(result => result.status === "rejected")) console.error("Native diagnostic cleanup failed; inspect the native CLI processes")
      }
    }
    case "pair":
      return pair(defaultDevicesDeps(), { json: command.json })
    case "devices":
      return listDevices(defaultDevicesDeps())
    case "revoke":
      return revokeDevice(defaultDevicesDeps(), command.target)
    case "relay":
      return setRelay(defaultDevicesDeps(), command.mode)
    case "attach": {
      const deps = defaultDevicesDeps()
      return attach(
        {
          request: deps.request,
          run: terminalRun,
          which: (name) => Bun.which(name),
          out: deps.out,
          err: deps.err,
          locale: deps.locale,
          tty: deps.tty,
          pid: process.pid,
          sleep: (ms) => Bun.sleep(ms),
          onInterrupt: (handler) => {
            process.on("SIGINT", handler)
            return () => process.off("SIGINT", handler)
          },
          claude: process.env.RUDDER_CLAUDE_BIN ?? "claude",
        },
        command.target,
        command.now,
      )
    }
    default:
      // Windows: a logon Scheduled Task instead of a LaunchAgent (platform/win32-service.ts).
      return isWindows() ? runTaskCommand(command, defaultTaskContext) : runService(command)
  }
}
