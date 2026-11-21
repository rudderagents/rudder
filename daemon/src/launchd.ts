import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir, userInfo } from "node:os"
import { dirname, join, resolve } from "node:path"
import { APP_VERSION, DAEMON_HOST, DAEMON_PORT, DEFAULT_DATA_DIR, TLS_ENABLED } from "./config"
import { terminalLocale } from "./qr"
import { describeRelayState, readRelayState } from "./relay/state"
import { CERT_FILE, KEY_FILE } from "./tls"
import { newerVersion, readUpdateCache, shouldCheckForUpdates, updateLogLine, updateNotice } from "./update-check"

/** RUDDER_LAUNCHD_LABEL overrides it, so a test install never touches the real one. */
export const DEFAULT_LABEL = "com.zysuccess.rudderd"
const LABEL_ENV = "RUDDER_LAUNCHD_LABEL"
const LAUNCHCTL = "/bin/launchctl"
const PLUTIL = "/usr/bin/plutil"
const SHELL_TIMEOUT_MS = 10_000
const START_TIMEOUT_MS = 20_000
/** Long enough for a person to answer the privacy prompt; see privacyFolder. */
const PROMPT_TIMEOUT_MS = 120_000
const STOP_TIMEOUT_MS = 10_000
const POLL_MS = 200
/** `launchctl print`: no such service in the domain. */
const NOT_FOUND = 113
/** `launchctl bootout`: EINPROGRESS, the job is still exiting; we wait for it below. */
const IN_PROGRESS = 36
const PATH_START = "__RUDDER_PATH_START__"
const PATH_END = "__RUDDER_PATH_END__"
/** What launchd gives a job when the plist sets no PATH. */
const LAUNCHD_PATH = "/usr/bin:/bin:/usr/sbin:/sbin"

export class LaunchdError extends Error {}
export class UsageError extends LaunchdError {}

export type RunResult = { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }
/** `env`, when given, replaces the environment instead of extending it. */
export type Runner = (argv: string[], options?: { timeoutMs?: number; env?: Record<string, string> }) => RunResult

export const runCommand: Runner = (argv, options = {}) => {
  let result: ReturnType<typeof Bun.spawnSync>
  try {
    // SIGKILL: an interactive shell ignores the default SIGTERM.
    result = Bun.spawnSync(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: options.timeoutMs, killSignal: "SIGKILL", env: options.env })
  } catch (error) {
    throw new LaunchdError(`could not run ${argv[0]}: ${error instanceof Error ? error.message : String(error)}`)
  }
  return {
    exitCode: result.exitCode,
    stdout: result.stdout?.toString() ?? "",
    stderr: result.stderr?.toString() ?? "",
    timedOut: result.exitedDueToTimeout === true,
  }
}

export type ServiceCommand = { kind: "install" } | { kind: "uninstall"; purge: boolean } | { kind: "status" }

export function parseServiceArgs(argv: string[]): ServiceCommand {
  const [command, ...flags] = argv
  const allow = (...allowed: string[]) => {
    const unknown = flags.filter((flag) => !allowed.includes(flag))
    if (unknown.length > 0) throw new UsageError(`unknown option for ${command}: ${unknown.join(" ")}`)
  }
  switch (command) {
    case "install":
      allow()
      return { kind: "install" }
    case "uninstall":
      allow("--purge")
      return { kind: "uninstall", purge: flags.includes("--purge") }
    case "status":
      allow()
      return { kind: "status" }
    default:
      throw new UsageError(`unknown command: ${command}`)
  }
}

/**
 * How this CLI runs: under bun from a source checkout (`bun` is the bun running it; the plist uses it only when the
 * login PATH has none), or as the compiled single-file `rudder`.
 */
export type Program = { kind: "source"; bun: string; main: string } | { kind: "binary"; path: string }

/** A bun --compile executable sees its bundled sources under a virtual root: `/$bunfs/` on macOS and Linux,
 * `B:\~BUN\` on Windows (the Windows test box, 2026-10-30: install took `B:\~BUN\root\main.ts` for a source run). */
const COMPILED_ROOTS = ["/$bunfs/", "B:\\~BUN\\", "B:/~BUN/"]

export function programFor(dir: string, execPath: string): Program {
  if (COMPILED_ROOTS.some((root) => dir.startsWith(root))) return { kind: "binary", path: execPath }
  return { kind: "source", bun: execPath, main: join(dir, "main.ts") }
}

export function currentProgram(): Program {
  return programFor(import.meta.dir, process.execPath)
}

/** How a person types this CLI, for hints. */
export function commandName(program: Program): string {
  return program.kind === "binary" ? "rudder" : "bun run src/main.ts"
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

/**
 * What the plist runs. A stable PATH entry beats the file this process runs from: the login PATH's bun symlink, and
 * Homebrew's bin/rudder link, survive upgrades; a versioned Cellar path is deleted by the next one.
 */
export function launchArguments(program: Program, which: ServiceContext["which"], path: string): string[] {
  if (program.kind === "source") return [which("bun", path) ?? program.bun, program.main]
  const linked = which("rudder", path)
  return [linked !== null && realpathOrNull(linked) === realpathOrNull(program.path) ? linked : program.path]
}

/** Resolve shell exports at service startup without persisting credentials in the plist. */
export function loginLaunchArguments(shell: string, argv: readonly string[]): string[] {
  return shell.split("/").at(-1) === "fish"
    ? [shell, "-lic", "exec $argv", ...argv]
    : [shell, "-lic", 'exec "$@"', "rudder-service", ...argv]
}

export type ServiceContext = {
  label: string
  uid: number
  home: string
  shell: string
  program: Program
  workingDirectory: string
  env: Record<string, string | undefined>
  /** Where the installed daemon will listen: the same RUDDER_* values go into its plist. */
  daemon: { host: string; port: number; tls: boolean }
  defaultDataDir: string
  run: Runner
  sleep: (ms: number) => Promise<unknown>
  probe: (url: string) => Promise<boolean>
  which: (command: string, path: string) => string | null
  log: (line: string) => void
  /** stdout is a terminal: the update line may be coloured. */
  tty?: boolean
}

export function servicePaths(home: string, label: string) {
  const logDir = join(home, "Library", "Logs", "Rudder")
  return {
    plist: join(home, "Library", "LaunchAgents", `${label}.plist`),
    logDir,
    stdout: join(logDir, `${label}.out.log`),
    stderr: join(logDir, `${label}.err.log`),
  }
}

export type AgentSpec = {
  label: string
  programArguments: string[]
  workingDirectory: string
  environment: Record<string, string>
  stdoutPath: string
  stderrPath: string
}

export function xmlEscape(value: string): string {
  // XML 1.0 has no way to write these, escaped or not.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value)) {
    throw new LaunchdError(`cannot write ${JSON.stringify(value)} into a plist: it contains a control character`)
  }
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;")
}

export function renderPlist(spec: AgentSpec): string {
  const string = (value: string) => `<string>${xmlEscape(value)}</string>`
  const env = Object.keys(spec.environment)
    .sort()
    .flatMap((key) => [`\t\t<key>${xmlEscape(key)}</key>`, `\t\t${string(spec.environment[key])}`])
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `\t<key>Label</key>`,
    `\t${string(spec.label)}`,
    `\t<key>ProgramArguments</key>`,
    `\t<array>`,
    ...spec.programArguments.map((arg) => `\t\t${string(arg)}`),
    `\t</array>`,
    `\t<key>WorkingDirectory</key>`,
    `\t${string(spec.workingDirectory)}`,
    `\t<key>EnvironmentVariables</key>`,
    `\t<dict>`,
    ...env,
    `\t</dict>`,
    `\t<key>RunAtLoad</key>`,
    `\t<true/>`,
    // Restart after a crash, kill -9 or OOM kill. SIGTERM (kill <pid>, logout) makes rudderd exit 0, and that stays down.
    `\t<key>KeepAlive</key>`,
    `\t<dict>`,
    `\t\t<key>SuccessfulExit</key>`,
    `\t\t<false/>`,
    `\t</dict>`,
    `\t<key>ThrottleInterval</key>`,
    `\t<integer>10</integer>`,
    `\t<key>StandardOutPath</key>`,
    `\t${string(spec.stdoutPath)}`,
    `\t<key>StandardErrorPath</key>`,
    `\t${string(spec.stderrPath)}`,
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n")
}

/** RUDDER_* settings set at install time go into the plist; the label override is for this CLI only. */
export function rudderEnvironment(env: Record<string, string | undefined>): Record<string, string> {
  const entries = Object.entries(env).filter(
    (entry): entry is [string, string] => entry[0].startsWith("RUDDER_") && entry[0] !== LABEL_ENV && entry[1] !== undefined,
  )
  return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)))
}

export function loginPathCommand(shell: string): string[] {
  return [shell, "-lic", `printf '%s%s%s' ${PATH_START} "$PATH" ${PATH_END}`]
}

/** The PATH between the markers; the last pair wins, so rc-file chatter and an echoed command line do not matter. */
export function parseLoginPath(stdout: string): string | null {
  const start = stdout.lastIndexOf(PATH_START)
  if (start === -1) return null
  const from = start + PATH_START.length
  const end = stdout.indexOf(PATH_END, from)
  return end === -1 ? null : stdout.slice(from, end)
}

/**
 * A fresh login's starting point: launchd's PATH plus who the user is. Inheriting this process's PATH would bake in
 * what `bun run` (every parent's node_modules/.bin) and the terminal app added, none of which a login has.
 */
export function loginEnvironment(env: Record<string, string | undefined>, shell: string): Record<string, string> {
  const identity = ["HOME", "USER", "LOGNAME", "TMPDIR", "LANG"].flatMap((key) => (env[key] === undefined ? [] : [[key, env[key]]]))
  return { ...Object.fromEntries(identity), SHELL: shell, PATH: LAUNCHD_PATH }
}

/** launchd starts jobs with PATH=/usr/bin:/bin:/usr/sbin:/sbin; agents live in ~/.local/bin, /opt/homebrew/bin, ~/.bun/bin. */
export function captureLoginPath(run: Runner, shell: string, env: Record<string, string | undefined>): string {
  const argv = loginPathCommand(shell)
  const result = run(argv, { timeoutMs: SHELL_TIMEOUT_MS, env: loginEnvironment(env, shell) })
  const path = parseLoginPath(result.stdout)
  if (path === null) {
    const how = result.timedOut ? `timed out after ${SHELL_TIMEOUT_MS / 1000}s` : `exit ${result.exitCode}`
    throw new LaunchdError(
      `could not read PATH from the login shell (${shell} -lic, ${how}): ${lastLines(result.stderr, 5) || "no output"}. ` +
        "Fix the shell startup files, then run install again.",
    )
  }
  if (path.trim() === "" || path.includes("\n")) {
    throw new LaunchdError(`the login shell ${shell} reported an unusable PATH: ${JSON.stringify(path)}`)
  }
  return path
}

export type ServiceState = { state: string; pid: number | null; lastExit: string | null; lastSignal: string | null; runs: number | null }

/** Top-level fields of `launchctl print`; nested blocks (coalitions) are indented further and skipped. */
export function parseLaunchctlPrint(text: string): ServiceState {
  const field = (name: string) => text.match(new RegExp(`^\\t${name} = (.+)$`, "m"))?.[1].trim() ?? null
  const int = (value: string | null) => (value !== null && /^\d+$/.test(value) ? Number(value) : null)
  return {
    state: field("state") ?? "unknown",
    pid: int(field("pid")),
    lastExit: field("last exit code"),
    lastSignal: field("last terminating signal"),
    runs: int(field("runs")),
  }
}

/**
 * The TCC-guarded folder holding `path`, if any. Under launchd, bun is its own "responsible app", so it does not
 * inherit the terminal's access: its first read there blocks in open() until someone answers the privacy prompt.
 */
export function privacyFolder(home: string, path: string): string | null {
  for (const folder of ["Desktop", "Documents", "Downloads", join("Library", "Mobile Documents")]) {
    const dir = join(home, folder)
    if (path === dir || path.startsWith(`${dir}/`)) return dir
  }
  return null
}

export function daemonOrigin(daemon: ServiceContext["daemon"]): string {
  const host = daemon.host === "0.0.0.0" || daemon.host === "::" ? "127.0.0.1" : daemon.host
  return `${daemon.tls ? "https" : "http"}://${host.includes(":") ? `[${host}]` : host}:${daemon.port}`
}

export async function probeHealth(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { tls: { rejectUnauthorized: false }, signal: AbortSignal.timeout(2000) })
    return response.ok && ((await response.json()) as { ok?: unknown }).ok === true
  } catch {
    // Refused, reset, timed out or not JSON: nothing healthy answers there.
    return false
  }
}

const domain = (ctx: ServiceContext) => `gui/${ctx.uid}`
const target = (ctx: ServiceContext) => `gui/${ctx.uid}/${ctx.label}`

function commandError(argv: string[], result: RunResult): LaunchdError {
  const how = result.timedOut ? "timed out" : `exit ${result.exitCode}`
  return new LaunchdError(`${argv.join(" ")} failed (${how}): ${result.stderr.trim() || result.stdout.trim() || "no output"}`)
}

function check(ctx: ServiceContext, argv: string[]): RunResult {
  const result = ctx.run(argv)
  if (result.exitCode !== 0) throw commandError(argv, result)
  return result
}

function queryService(ctx: ServiceContext): ServiceState | null {
  const argv = [LAUNCHCTL, "print", target(ctx)]
  const result = ctx.run(argv)
  if (result.exitCode === NOT_FOUND) return null
  if (result.exitCode !== 0) throw commandError(argv, result)
  return parseLaunchctlPrint(result.stdout)
}

/** Polls a bounded number of times rather than by wall clock, so tests with an instant sleep stay fast. */
async function waitFor<T>(ctx: ServiceContext, timeoutMs: number, poll: () => Promise<T | null>): Promise<T | null> {
  for (let attempt = Math.ceil(timeoutMs / POLL_MS); attempt > 0; attempt--) {
    const value = await poll()
    if (value !== null) return value
    await ctx.sleep(POLL_MS)
  }
  return null
}

async function bootout(ctx: ServiceContext): Promise<void> {
  const argv = [LAUNCHCTL, "bootout", target(ctx)]
  const result = ctx.run(argv)
  if (result.exitCode !== 0 && result.exitCode !== IN_PROGRESS) throw commandError(argv, result)
  const gone = await waitFor(ctx, STOP_TIMEOUT_MS, async () => (queryService(ctx) === null ? true : null))
  if (!gone) throw new LaunchdError(`${target(ctx)} is still loaded ${STOP_TIMEOUT_MS / 1000}s after launchctl bootout`)
}

type InstalledPlist = { programArguments: string[]; environment: Record<string, string> }

function readInstalledPlist(ctx: ServiceContext, path: string): InstalledPlist {
  const result = check(ctx, [PLUTIL, "-convert", "json", "-o", "-", path])
  let raw: unknown
  try {
    raw = JSON.parse(result.stdout)
  } catch (error) {
    throw new LaunchdError(`plutil printed unreadable JSON for ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (raw === null || typeof raw !== "object") throw new LaunchdError(`${path} is not a plist dictionary`)
  const { ProgramArguments: args, EnvironmentVariables: env } = raw as Record<string, unknown>
  return {
    programArguments: Array.isArray(args) ? args.filter((arg): arg is string => typeof arg === "string") : [],
    environment:
      env !== null && typeof env === "object"
        ? Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
        : {},
  }
}

function lastLines(text: string, count: number): string {
  return text.trimEnd().split("\n").slice(-count).join("\n").trim()
}

function logTail(file: string): string {
  if (!existsSync(file)) return ""
  const tail = lastLines(readFileSync(file, "utf8"), 15)
  return tail ? `\nlast lines of ${file}:\n${tail}` : ""
}

function requireFixedPort(port: number, shown: string | undefined) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new LaunchdError(`RUDDER_PORT must be a fixed port for a LaunchAgent (got ${shown}): a paired phone has to find the daemon again after a restart`)
  }
}

export async function install(ctx: ServiceContext): Promise<void> {
  requireFixedPort(ctx.daemon.port, ctx.env.RUDDER_PORT)
  const file = ctx.program.kind === "binary" ? ctx.program.path : ctx.program.main
  if (!existsSync(file)) throw new LaunchdError(`${file} is not on disk; run install from the rudder you want to keep running`)
  const path = captureLoginPath(ctx.run, ctx.shell, ctx.env)
  const programArguments = loginLaunchArguments(ctx.shell, launchArguments(ctx.program, ctx.which, path))
  const paths = servicePaths(ctx.home, ctx.label)
  // A reinstall keeps the previous RUDDER_* settings this shell does not set, so running install again cannot drop them.
  const previous = existsSync(paths.plist) ? rudderEnvironment(readInstalledPlist(ctx, paths.plist).environment) : {}
  const given = rudderEnvironment(ctx.env)
  const kept = Object.keys(previous).filter((key) => !(key in given))
  if (kept.length > 0) ctx.log(`keeping ${kept.join(", ")} from the previous install (set them to change; uninstall first to drop them)`)
  const environment = { ...rudderEnvironment({ ...previous, ...given }), PATH: path }
  // ctx.daemon follows this shell's settings; a kept one moves where the installed daemon listens.
  const carried: Partial<Record<string, string>> = Object.fromEntries(kept.map((key) => [key, previous[key]]))
  const daemon = {
    host: carried.RUDDER_HOST ?? ctx.daemon.host,
    port: carried.RUDDER_PORT !== undefined ? Number(carried.RUDDER_PORT) : ctx.daemon.port,
    tls: carried.RUDDER_TLS !== undefined ? carried.RUDDER_TLS !== "0" : ctx.daemon.tls,
  }
  if (carried.RUDDER_PORT !== undefined) requireFixedPort(daemon.port, carried.RUDDER_PORT)
  const xml = renderPlist({
    label: ctx.label,
    programArguments,
    workingDirectory: ctx.workingDirectory,
    environment,
    stdoutPath: paths.stdout,
    stderrPath: paths.stderr,
  })

  const existing = queryService(ctx)
  if (existing) {
    ctx.log(`${ctx.label} is loaded${existing.pid ? ` (pid ${existing.pid})` : ""}; stopping it to reinstall`)
    await bootout(ctx)
  }
  const origin = daemonOrigin(daemon)
  if (await ctx.probe(`${origin}/health`)) {
    const previous = existing ? "; the previous install is stopped, its plist loads again at next login" : ""
    throw new LaunchdError(`${origin} already answers: another rudderd (a terminal \`bun start\`?) holds port ${daemon.port}. Stop it and run install again${previous}`)
  }

  mkdirSync(paths.logDir, { recursive: true })
  mkdirSync(dirname(paths.plist), { recursive: true })
  const tmp = `${paths.plist}.tmp`
  rmSync(tmp, { force: true })
  writeFileSync(tmp, xml, { mode: 0o644 })
  renameSync(tmp, paths.plist)
  try {
    check(ctx, [PLUTIL, "-lint", paths.plist])
    check(ctx, [LAUNCHCTL, "bootstrap", domain(ctx), paths.plist])
    const guarded = privacyFolder(ctx.home, file)
    const timeoutMs = guarded ? PROMPT_TIMEOUT_MS : START_TIMEOUT_MS
    const [what, app] = ctx.program.kind === "binary" ? ["this rudder", "rudder"] : ["this checkout", "bun"]
    if (guarded) {
      ctx.log(`${what} is in ${guarded}: macOS asks once whether "${app}" may access it. Click Allow (waiting up to ${timeoutMs / 1000}s)`)
    }
    const running = await waitFor(ctx, timeoutMs, async () => {
      const state = queryService(ctx)
      return state?.state === "running" && state.pid !== null && (await ctx.probe(`${origin}/health`)) ? state : null
    })
    if (!running) {
      const state = queryService(ctx)
      const seen = state ? `state ${state.state}, last exit ${state.lastExit ?? "-"}, runs ${state.runs ?? "-"}` : "not loaded"
      const prompt = guarded
        ? `. If it hung on the privacy prompt, allow ${app} under System Settings → Privacy & Security → Files and Folders (or move it out of ${guarded}) and run install again`
        : ""
      throw new LaunchdError(`${ctx.label} did not answer on ${origin}/health within ${timeoutMs / 1000}s (launchd: ${seen})${prompt}`)
    }
    ctx.log(`installed ${ctx.label}: pid ${running.pid}, starts at login, restarts after a crash (a clean exit stays down)`)
  } catch (error) {
    throw new LaunchdError(`${error instanceof Error ? error.message : String(error)}${await rollback(ctx, paths.plist)}${logTail(paths.stderr)}`)
  }
  const names = Object.keys(environment).filter((key) => key !== "PATH")
  ctx.log(`  serving   ${origin}`)
  ctx.log(`  plist     ${paths.plist}`)
  ctx.log(`  program   ${programArguments.join(" ")}`)
  ctx.log(`  PATH      ${path}`)
  ctx.log(`            (from ${ctx.shell} -lic; run install again after changing it or moving ${ctx.program.kind === "binary" ? "rudder" : "this checkout"})`)
  ctx.log(`  env       ${names.join(", ") || "-"}`)
  ctx.log(`  logs      ${paths.stdout}`)
  ctx.log(`            ${paths.stderr}`)
  ctx.log(`pair a phone: ${commandName(ctx.program)} pair (the log hides the token; this prints a fresh QR code)`)
}

/** Leaves nothing behind after a failed install: a crash-looping job would otherwise come back at every login. */
async function rollback(ctx: ServiceContext, plist: string): Promise<string> {
  let note = ""
  try {
    if (queryService(ctx)) await bootout(ctx)
  } catch (error) {
    note = ` (rollback: ${error instanceof Error ? error.message : String(error)})`
  }
  rmSync(plist, { force: true })
  return `; rolled back, nothing is installed${note}`
}

/** Refuses anything that does not hold rudderd's own files, so a stray RUDDER_HOME=~ cannot wipe a home folder. */
function checkPurgeable(dir: string, home: string): void {
  if (!existsSync(dir)) return
  const resolved = resolve(dir)
  const ours = ["rudder.sqlite", CERT_FILE, KEY_FILE].some((file) => existsSync(join(dir, file)))
  if (resolved === "/" || resolved === resolve(home) || !ours) {
    throw new LaunchdError(`refusing to delete ${dir}: it is not a Rudder data dir (no rudder.sqlite or TLS key); nothing was changed`)
  }
}

export async function uninstall(ctx: ServiceContext, purge: boolean): Promise<void> {
  const paths = servicePaths(ctx.home, ctx.label)
  const installed = existsSync(paths.plist) ? readInstalledPlist(ctx, paths.plist) : null
  // The data dir the installed daemon used, not whatever this shell has set.
  const dataDir = (installed ? installed.environment.RUDDER_HOME : ctx.env.RUDDER_HOME) ?? ctx.defaultDataDir
  if (purge) checkPurgeable(dataDir, ctx.home)
  const state = queryService(ctx)
  if (state) {
    await bootout(ctx)
    ctx.log(`stopped ${target(ctx)}`)
  }
  if (installed) {
    rmSync(paths.plist)
    ctx.log(`removed ${paths.plist}`)
  }
  if (!state && !installed) ctx.log(`${ctx.label} is not installed`)
  if (!purge) {
    // The db keeps every device key: a reinstall lets those phones straight back in (r59 F-03).
    ctx.log("paired phones stay paired for a later reinstall; `rudder devices revoke <name>` removes one first")
    ctx.log(`kept ${dataDir} and ${paths.logDir}; uninstall --purge deletes them`)
    return
  }
  if (existsSync(dataDir)) {
    ctx.log(`deleting ${dataDir}: database, TLS key and pairing; paired phones must pair again`)
    rmSync(dataDir, { recursive: true, force: true })
  }
  for (const file of [paths.stdout, paths.stderr]) rmSync(file, { force: true })
  if (existsSync(paths.logDir) && readdirSync(paths.logDir).length === 0) rmdirSync(paths.logDir)
  ctx.log(`deleted the ${ctx.label} logs`)
}

/** Exit 0 when the job is running, 1 otherwise, so scripts can test it. */
export function status(ctx: ServiceContext): number {
  const paths = servicePaths(ctx.home, ctx.label)
  const state = queryService(ctx)
  const installed = existsSync(paths.plist) ? readInstalledPlist(ctx, paths.plist) : null
  const summary = state ? state.state : installed ? "not loaded (the plist loads at next login; install loads it now)" : "not installed"
  ctx.log(`${ctx.label}: ${summary}`)
  if (state) {
    ctx.log(`  pid       ${state.pid ?? "-"}`)
    ctx.log(`  last exit ${state.lastExit ?? "-"}${state.lastSignal ? ` (signal: ${state.lastSignal})` : ""}`)
    ctx.log(`  runs      ${state.runs ?? "-"}`)
  }
  ctx.log(`  plist     ${paths.plist}${installed ? "" : " (missing)"}`)
  if (installed) {
    ctx.log(`  program   ${installed.programArguments.join(" ")}`)
    ctx.log(`  PATH      ${installed.environment.PATH ?? `(unset: launchd's ${LAUNCHD_PATH})`}`)
    ctx.log(`  env       ${Object.keys(installed.environment).filter((key) => key !== "PATH").sort().join(", ") || "-"}`)
  }
  ctx.log(`  logs      ${paths.stdout}`)
  ctx.log(`            ${paths.stderr}`)
  const dataDir = (installed ? installed.environment.RUDDER_HOME : ctx.env.RUDDER_HOME) ?? ctx.defaultDataDir
  const relay = state?.state === "running" ? readRelayState(dataDir) : null
  for (const [index, line] of describeRelayState(relay).entries()) ctx.log(`  ${index === 0 ? "relay    " : "         "} ${line}`)
  // The same cached answer the daemon printed; status never checks the network itself.
  if (ctx.program.kind === "binary" && shouldCheckForUpdates(ctx.program.path, ctx.env)) {
    const newer = newerVersion(readUpdateCache(dataDir)?.latest ?? null, APP_VERSION)
    if (newer) ctx.log(ctx.tty ? updateNotice(newer, APP_VERSION, terminalLocale(ctx.env)) : updateLogLine(newer, APP_VERSION))
  }
  return state?.state === "running" ? 0 : 1
}

function defaultContext(): ServiceContext {
  const program = currentProgram()
  if (process.platform !== "darwin") throw new LaunchdError("LaunchAgents exist on macOS only")
  const label = process.env[LABEL_ENV] ?? DEFAULT_LABEL
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(label)) throw new LaunchdError(`${LABEL_ENV}=${JSON.stringify(label)} is not a launchd label`)
  const uid = process.getuid?.()
  if (uid === undefined) throw new LaunchdError("no user id: process.getuid is unavailable")
  const shell = process.env.SHELL || userInfo().shell
  if (!shell) throw new LaunchdError("no login shell: SHELL is unset and the user record has none")
  return {
    label,
    uid,
    home: homedir(),
    shell,
    program,
    // A source install runs in daemon/; the binary has no checkout, so it starts in the home folder.
    workingDirectory: program.kind === "source" ? dirname(dirname(program.main)) : homedir(),
    env: process.env,
    daemon: { host: DAEMON_HOST, port: DAEMON_PORT, tls: TLS_ENABLED },
    defaultDataDir: DEFAULT_DATA_DIR,
    run: runCommand,
    sleep: Bun.sleep,
    probe: probeHealth,
    which: (command, path) => Bun.which(command, { PATH: path }),
    log: console.log,
    tty: process.stdout.isTTY === true,
  }
}

export async function runService(command: ServiceCommand, makeContext: () => ServiceContext = defaultContext): Promise<number> {
  try {
    const ctx = makeContext()
    if (command.kind === "install") await install(ctx)
    else if (command.kind === "uninstall") await uninstall(ctx, command.purge)
    else return status(ctx)
    return 0
  } catch (error) {
    if (!(error instanceof LaunchdError)) throw error
    console.error(`rudder ${command.kind}: ${error.message}`)
    return 1
  }
}
