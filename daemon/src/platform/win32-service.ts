// `rudder install | uninstall | status` on Windows: a per-user Scheduled Task that starts rudder at logon, the
// counterpart of the macOS LaunchAgent (launchd.ts). See the Windows notes.
//
// The task runs `conhost.exe --headless cmd.exe /d /s /c ""<RUDDER_HOME>\rudder-task.cmd""`: no console window, and the
// launcher script carries what Task Scheduler cannot (RUDDER_* variables, log files, restart after a crash with a 10 s
// pause, a clean exit stays down, like KeepAlive SuccessfulExit=false). The task is registered from XML because the
// /SC ONLOGON flags leave Windows' defaults in place: a 72-hour run limit and "stop when on battery".
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs"
import { type posix, win32 } from "node:path"
import { homedir } from "node:os"
import { DAEMON_HOST, DAEMON_PORT, DEFAULT_DATA_DIR, TLS_ENABLED } from "../config"
import { currentProgram, type Program, probeHealth, type ServiceCommand } from "../launchd"
import type { Env } from "./index"
import { describeFailure, powershellArgv, runSync, type SyncRunner } from "./run"
import { readChannelFile, TOKEN_FILE } from "./token-channel"
import { AclError, currentUserSid, restrictToUser } from "./win32-acl"

export const DEFAULT_TASK_NAME = "Rudder"
const TASK_ENV = "RUDDER_TASK_NAME"
export const LAUNCHER_FILE = "rudder-task.cmd"
const START_TIMEOUT_MS = 20_000
const STOP_TIMEOUT_MS = 10_000
const POLL_MS = 200

export class TaskError extends Error {}

export type TaskContext = {
  taskName: string
  userSid: string
  home: string
  program: Program
  env: Env
  daemon: { host: string; port: number; tls: boolean }
  defaultDataDir: string
  /** path.win32 on Windows; tests use posix so the launcher lands in a real temp dir. */
  path: typeof posix
  run: SyncRunner
  sleep: (ms: number) => Promise<unknown>
  probe: (url: string) => Promise<boolean>
  /** The pid in RUDDER_HOME's channel file, if any (platform/token-channel.ts). */
  daemonPid: (dataDir: string) => number | null
  /** Makes a directory owner-only: RUDDER_HOME before the launcher (which the task runs) is written into it, and its logs. */
  protect: (dir: string) => void
  /** Makes one file owner-only: a log already in logs\ keeps its own ACL when only the folder is protected. */
  protectFile: (file: string) => void
  log: (line: string) => void
}

export function taskPaths(dataDir: string, path: typeof posix = win32) {
  const logDir = path.join(dataDir, "logs")
  return {
    launcher: path.join(dataDir, LAUNCHER_FILE),
    xml: path.join(dataDir, "rudder-task.xml"),
    logDir,
    stdout: path.join(logDir, "rudder.out.log"),
    stderr: path.join(logDir, "rudder.err.log"),
  }
}

/** The task name, checked: it reaches schtasks as an argument and the XML as text. */
export function taskNameFrom(env: Env): string {
  const name = env[TASK_ENV] ?? DEFAULT_TASK_NAME
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/.test(name)) throw new TaskError(`${TASK_ENV}=${JSON.stringify(name)} is not a task name`)
  return name
}

// cmd.exe reads a .cmd file with percent expansion: `%` is written `%%`. A quote or a line break would end the
// value early and turn the rest into commands, so those are refused, never escaped.
function cmdValue(what: string, value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
  if (/["\r\n\u0000-\u001f]/.test(value)) throw new TaskError(`cannot write ${what} into the launcher: it contains a quote or control character`)
  return value.replace(/%/g, "%%")
}

export type LauncherSpec = { programArguments: string[]; environment: Record<string, string>; stdout: string; stderr: string }

export function renderLauncher(spec: LauncherSpec): string {
  const quoted = (what: string, value: string) => `"${cmdValue(what, value)}"`
  const env = Object.keys(spec.environment)
    .sort()
    .map((key) => {
      if (!/^RUDDER_[A-Z0-9_]+$/.test(key)) throw new TaskError(`refusing environment name ${key}`)
      return `set "${key}=${cmdValue(key, spec.environment[key]!)}"`
    })
  const command = spec.programArguments.map((arg) => quoted("the program path", arg)).join(" ")
  return [
    "@echo off",
    "rem Written by `rudder install`; `rudder install` again rewrites it, `rudder uninstall` removes it.",
    "setlocal",
    ...env,
    ":run",
    `${command} 1>>${quoted("the log path", spec.stdout)} 2>>${quoted("the log path", spec.stderr)}`,
    // A clean exit (Ctrl+C, `rudder uninstall`) stays down; a crash comes back after 10 s.
    "if %errorlevel% equ 0 exit /b 0",
    "ping -n 11 127.0.0.1 >nul",
    "goto run",
    "",
  ].join("\r\n")
}

/** The `set "RUDDER_…=…"` lines of an installed launcher, so a reinstall keeps them. */
export function parseLauncher(text: string): { environment: Record<string, string>; programArguments: string[] } {
  const environment: Record<string, string> = {}
  let programArguments: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const set = /^set "(RUDDER_[A-Z0-9_]+)=(.*)"$/.exec(line)
    if (set) environment[set[1]!] = set[2]!.replace(/%%/g, "%")
    else if (line.startsWith('"') && line.includes(" 1>>")) {
      programArguments = [...line.slice(0, line.indexOf(" 1>>")).matchAll(/"([^"]*)"/g)].map((match) => match[1]!.replace(/%%/g, "%"))
    }
  }
  return { environment, programArguments }
}

export function xmlText(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: XML 1.0 cannot carry these at all
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value)) throw new TaskError(`cannot write ${JSON.stringify(value)} into the task XML`)
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

export type TaskSpec = { taskName: string; userSid: string; launcher: string; workingDirectory: string }

/**
 * The cmd.exe arguments. Plain `/c "<path>"` loses its quotes when the line holds & < > ( ) @ ^ |, which splits a
 * path like `C:\Users\R&D\…`; with /s, cmd strips exactly the outer pair and keeps the inner quoted path.
 */
export function taskArguments(launcher: string): string {
  return `--headless cmd.exe /d /s /c ""${cmdValue("the launcher path", launcher)}""`
}

export function renderTaskXml(spec: TaskSpec): string {
  return [
    `<?xml version="1.0" encoding="UTF-16"?>`,
    `<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">`,
    `  <RegistrationInfo>`,
    `    <Description>Rudder: lets your iPhone drive the coding agents on this computer. Remove with rudder uninstall.</Description>`,
    `    <URI>\\${xmlText(spec.taskName)}</URI>`,
    `  </RegistrationInfo>`,
    `  <Triggers>`,
    `    <LogonTrigger>`,
    `      <Enabled>true</Enabled>`,
    `      <UserId>${xmlText(spec.userSid)}</UserId>`,
    `    </LogonTrigger>`,
    `  </Triggers>`,
    `  <Principals>`,
    `    <Principal id="Author">`,
    `      <UserId>${xmlText(spec.userSid)}</UserId>`,
    `      <LogonType>InteractiveToken</LogonType>`,
    `      <RunLevel>LeastPrivilege</RunLevel>`,
    `    </Principal>`,
    `  </Principals>`,
    `  <Settings>`,
    `    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>`,
    `    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>`,
    `    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>`,
    `    <AllowHardTerminate>true</AllowHardTerminate>`,
    `    <StartWhenAvailable>true</StartWhenAvailable>`,
    `    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>`,
    `    <IdleSettings>`,
    `      <StopOnIdleEnd>false</StopOnIdleEnd>`,
    `      <RestartOnIdle>false</RestartOnIdle>`,
    `    </IdleSettings>`,
    `    <AllowStartOnDemand>true</AllowStartOnDemand>`,
    `    <Enabled>true</Enabled>`,
    `    <Hidden>false</Hidden>`,
    `    <RunOnlyIfIdle>false</RunOnlyIfIdle>`,
    `    <WakeToRun>false</WakeToRun>`,
    `    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>`,
    `    <Priority>7</Priority>`,
    `  </Settings>`,
    `  <Actions Context="Author">`,
    `    <Exec>`,
    `      <Command>conhost.exe</Command>`,
    `      <Arguments>${xmlText(taskArguments(spec.launcher))}</Arguments>`,
    `      <WorkingDirectory>${xmlText(spec.workingDirectory)}</WorkingDirectory>`,
    `    </Exec>`,
    `  </Actions>`,
    `</Task>`,
    ``,
  ].join("\r\n")
}

/** schtasks reads task XML as UTF-16 LE with a byte order mark. */
export function utf16le(text: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")])
}

// Get-ScheduledTask speaks the same in every display language; schtasks /Query's columns are translated.
const QUERY_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$task = Get-ScheduledTask -TaskName $env:RUDDER_TASK_NAME -ErrorAction SilentlyContinue",
  "if (-not $task) { 'missing'; exit 0 }",
  "$info = $task | Get-ScheduledTaskInfo",
  "$last = if ($info.LastRunTime) { $info.LastRunTime.ToString('o') } else { '' }",
  "[pscustomobject]@{ state = [string]$task.State; lastRun = $last; lastResult = [int64]$info.LastTaskResult; " +
    "execute = [string]$task.Actions[0].Execute; arguments = [string]$task.Actions[0].Arguments } | ConvertTo-Json -Compress",
].join("; ")

export type TaskState = { state: string; lastRun: string | null; lastResult: number | null; execute: string; arguments: string }

export function parseTaskQuery(stdout: string): TaskState | null {
  const text = stdout.trim()
  if (text === "missing") return null
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new TaskError(`Get-ScheduledTask printed something unreadable: ${text.slice(0, 200) || "nothing"}`)
  }
  return {
    state: typeof raw.state === "string" ? raw.state : "Unknown",
    lastRun: typeof raw.lastRun === "string" && raw.lastRun ? raw.lastRun : null,
    lastResult: typeof raw.lastResult === "number" ? raw.lastResult : null,
    execute: typeof raw.execute === "string" ? raw.execute : "",
    arguments: typeof raw.arguments === "string" ? raw.arguments : "",
  }
}

/** The launcher named in the task's arguments: `… /c "C:\…\rudder-task.cmd"`. */
export function launcherFromArguments(args: string): string | null {
  // Tasks registered before /s carry `/c "<path>"`; newer ones `/s /c ""<path>""`.
  return /\/c ""?([^"]+)""?\s*$/.exec(args)?.[1] ?? null
}

/** Task Scheduler's result codes worth a word; anything else is printed in hex. */
export function describeResult(code: number | null): string {
  if (code === null) return "-"
  const known = new Map<number, string>([
    [0, "0 (exited cleanly)"],
    [0x41300, "0x41300 (ready)"],
    [0x41301, "0x41301 (running)"],
    [0x41303, "0x41303 (has not run yet)"],
    [0x8004131f, "0x8004131F (an instance is already running)"],
    [0xc000013a, "0xC000013A (stopped with Ctrl+C or at logoff)"],
  ])
  return known.get(code) ?? `0x${(code >>> 0).toString(16).toUpperCase()}`
}

function check(ctx: TaskContext, argv: string[]) {
  const result = ctx.run(argv)
  if (result.exitCode !== 0) throw new TaskError(describeFailure(argv, result))
  return result
}

export function queryTask(ctx: TaskContext): TaskState | null {
  const argv = powershellArgv(QUERY_SCRIPT)
  const result = ctx.run(argv, { env: { ...ctx.env, RUDDER_TASK_NAME: ctx.taskName } })
  if (result.exitCode !== 0) throw new TaskError(`could not read the scheduled task: ${describeFailure(argv, result)}`)
  return parseTaskQuery(result.stdout)
}

function origin(daemon: TaskContext["daemon"]): string {
  const host = daemon.host === "0.0.0.0" || daemon.host === "::" ? "127.0.0.1" : daemon.host
  return `${daemon.tls ? "https" : "http"}://${host.includes(":") ? `[${host}]` : host}:${daemon.port}`
}

async function waitFor(ctx: TaskContext, timeoutMs: number, poll: () => Promise<boolean>): Promise<boolean> {
  for (let attempt = Math.ceil(timeoutMs / POLL_MS); attempt > 0; attempt--) {
    if (await poll()) return true
    await ctx.sleep(POLL_MS)
  }
  return false
}

/** Ends the task (its cmd.exe loop first, so nothing restarts rudder), then the daemon's own process tree. */
async function stopTask(ctx: TaskContext, dataDir: string): Promise<void> {
  const ended = ctx.run(["schtasks.exe", "/End", "/TN", ctx.taskName])
  // 1: "not running" in any language; anything else is reported with the rest.
  if (ended.exitCode !== 0 && ended.exitCode !== 1) throw new TaskError(describeFailure(["schtasks.exe", "/End"], ended))
  const pid = ctx.daemonPid(dataDir)
  const url = `${origin(ctx.daemon)}/health`
  if (pid !== null && (await ctx.probe(url))) ctx.run(["taskkill.exe", "/PID", String(pid), "/T", "/F"])
  if (!(await waitFor(ctx, STOP_TIMEOUT_MS, async () => !(await ctx.probe(url))))) {
    throw new TaskError(`${url} still answers ${STOP_TIMEOUT_MS / 1000}s after ending the task`)
  }
}

function rudderEnvironment(env: Env): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env)
      .filter((entry): entry is [string, string] => entry[0].startsWith("RUDDER_") && entry[0] !== TASK_ENV && entry[1] !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)),
  )
}

function installedLauncher(ctx: TaskContext, state: TaskState | null): { path: string; parsed: ReturnType<typeof parseLauncher> } | null {
  const path = state ? launcherFromArguments(state.arguments) : null
  const fallback = taskPaths(ctx.env.RUDDER_HOME ?? ctx.defaultDataDir, ctx.path).launcher
  for (const candidate of [path, fallback]) {
    if (candidate && existsSync(candidate)) return { path: candidate, parsed: parseLauncher(readFileSync(candidate, "utf8")) }
  }
  return null
}

function requireFixedPort(port: number, shown: string | undefined) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new TaskError(`RUDDER_PORT must be a fixed port for the logon task (got ${shown}): a paired phone has to find the daemon again`)
  }
}

export async function installTask(ctx: TaskContext): Promise<void> {
  requireFixedPort(ctx.daemon.port, ctx.env.RUDDER_PORT)
  const file = ctx.program.kind === "binary" ? ctx.program.path : ctx.program.main
  if (!existsSync(file)) throw new TaskError(`${file} is not on disk; run install from the rudder you want to keep running`)
  const existing = queryTask(ctx)
  const previous = installedLauncher(ctx, existing)?.parsed.environment ?? {}
  const given = rudderEnvironment(ctx.env)
  const kept = Object.keys(previous).filter((key) => !(key in given))
  if (kept.length > 0) ctx.log(`keeping ${kept.join(", ")} from the previous install (set them to change; uninstall first to drop them)`)
  const environment = { ...previous, ...given }
  const dataDir = environment.RUDDER_HOME ?? ctx.defaultDataDir
  const daemon = {
    host: environment.RUDDER_HOST ?? ctx.daemon.host,
    port: environment.RUDDER_PORT !== undefined ? Number(environment.RUDDER_PORT) : ctx.daemon.port,
    tls: environment.RUDDER_TLS !== undefined ? environment.RUDDER_TLS !== "0" : ctx.daemon.tls,
  }
  requireFixedPort(daemon.port, environment.RUDDER_PORT)
  const paths = taskPaths(dataDir, ctx.path)
  const programArguments = ctx.program.kind === "binary" ? [ctx.program.path] : [ctx.program.bun, ctx.program.main]
  const launcher = renderLauncher({ programArguments, environment, stdout: paths.stdout, stderr: paths.stderr })
  const xml = renderTaskXml({ taskName: ctx.taskName, userSid: ctx.userSid, launcher: paths.launcher, workingDirectory: ctx.home })

  const stopCtx = { ...ctx, daemon }
  if (existing) {
    ctx.log(`the ${ctx.taskName} task is ${existing.state.toLowerCase()}; stopping it to reinstall`)
    await stopTask(stopCtx, dataDir)
  }
  const url = `${origin(daemon)}/health`
  if (await ctx.probe(url)) {
    throw new TaskError(`${origin(daemon)} already answers: another rudder (one in a terminal?) holds port ${daemon.port}. Stop it and run install again`)
  }

  mkdirSync(paths.logDir, { recursive: true })
  ctx.protect(dataDir)
  // icacls runs without /T: a logs folder left from before keeps explicit ACEs that inheritance does not replace,
  // and so does each log already in it.
  ctx.protect(paths.logDir)
  for (const entry of readdirSync(paths.logDir, { withFileTypes: true })) {
    if (entry.isFile()) ctx.protectFile(ctx.path.join(paths.logDir, entry.name))
  }
  writeFileSync(`${paths.launcher}.tmp`, launcher)
  renameSync(`${paths.launcher}.tmp`, paths.launcher)
  writeFileSync(paths.xml, utf16le(xml))
  try {
    check(ctx, ["schtasks.exe", "/Create", "/TN", ctx.taskName, "/XML", paths.xml, "/F"])
    check(ctx, ["schtasks.exe", "/Run", "/TN", ctx.taskName])
    if (!(await waitFor(ctx, START_TIMEOUT_MS, () => ctx.probe(url)))) {
      const state = queryTask(ctx)
      throw new TaskError(
        `the ${ctx.taskName} task did not answer on ${url} within ${START_TIMEOUT_MS / 1000}s ` +
          `(task: ${state ? `${state.state}, last result ${describeResult(state.lastResult)}` : "missing"})`,
      )
    }
  } catch (error) {
    ctx.run(["schtasks.exe", "/End", "/TN", ctx.taskName])
    ctx.run(["schtasks.exe", "/Delete", "/TN", ctx.taskName, "/F"])
    rmSync(paths.launcher, { force: true })
    const tail = existsSync(paths.stderr) ? readFileSync(paths.stderr, "utf8").trimEnd().split(/\r?\n/).slice(-15).join("\n") : ""
    throw new TaskError(
      `${error instanceof Error ? error.message : String(error)}; rolled back, nothing is installed${tail ? `\nlast lines of ${paths.stderr}:\n${tail}` : ""}`,
    )
  } finally {
    rmSync(paths.xml, { force: true })
  }
  ctx.log(`installed the ${ctx.taskName} task: starts at logon (no window), restarts 10 s after a crash (a clean exit stays down)`)
  ctx.log(`  serving   ${origin(daemon)}`)
  ctx.log(`  program   ${programArguments.join(" ")}`)
  ctx.log(`  launcher  ${paths.launcher}`)
  ctx.log(`  env       ${Object.keys(environment).join(", ") || "-"}`)
  ctx.log(`  logs      ${paths.stdout}`)
  ctx.log(`            ${paths.stderr}`)
  ctx.log("pair a phone: rudder pair (the log hides the token; this prints a fresh QR code)")
}

function checkPurgeable(dir: string, ctx: TaskContext): void {
  if (!existsSync(dir)) return
  const resolved = ctx.path.resolve(dir).toLowerCase()
  const ours = ["rudder.sqlite", "rudderd-cert.pem", "rudderd-key.pem"].some((file) => existsSync(ctx.path.join(dir, file)))
  if (resolved === ctx.path.resolve(ctx.home).toLowerCase() || ctx.path.dirname(resolved) === resolved || !ours) {
    throw new TaskError(`refusing to delete ${dir}: it is not a Rudder data dir (no rudder.sqlite or TLS key); nothing was changed`)
  }
}

export async function uninstallTask(ctx: TaskContext, purge: boolean): Promise<void> {
  const state = queryTask(ctx)
  const installed = installedLauncher(ctx, state)
  const dataDir = installed?.parsed.environment.RUDDER_HOME ?? ctx.env.RUDDER_HOME ?? ctx.defaultDataDir
  if (purge) checkPurgeable(dataDir, ctx)
  if (state) {
    const env = installed?.parsed.environment ?? {}
    const daemon = {
      host: env.RUDDER_HOST ?? ctx.daemon.host,
      port: env.RUDDER_PORT !== undefined ? Number(env.RUDDER_PORT) : ctx.daemon.port,
      tls: env.RUDDER_TLS !== undefined ? env.RUDDER_TLS !== "0" : ctx.daemon.tls,
    }
    await stopTask({ ...ctx, daemon }, dataDir)
    check(ctx, ["schtasks.exe", "/Delete", "/TN", ctx.taskName, "/F"])
    ctx.log(`stopped and removed the ${ctx.taskName} task`)
  } else {
    ctx.log(`the ${ctx.taskName} task is not installed`)
  }
  if (installed) rmSync(installed.path, { force: true })
  const paths = taskPaths(dataDir, ctx.path)
  if (!purge) {
    ctx.log("paired phones stay paired for a later reinstall; `rudder devices revoke <name>` removes one first")
    ctx.log(`kept ${dataDir} (database, TLS key, logs); uninstall --purge deletes it`)
    return
  }
  if (existsSync(dataDir)) {
    ctx.log(`deleting ${dataDir}: database, TLS key, pairing and logs; paired phones must pair again`)
    rmSync(dataDir, { recursive: true, force: true })
  } else if (existsSync(paths.logDir) && readdirSync(paths.logDir).length === 0) {
    rmdirSync(paths.logDir)
  }
}

/** Exit 0 when the task is running and the daemon answers, 1 otherwise. */
export async function taskStatus(ctx: TaskContext): Promise<number> {
  const state = queryTask(ctx)
  const installed = installedLauncher(ctx, state)
  const env = installed?.parsed.environment ?? {}
  const dataDir = env.RUDDER_HOME ?? ctx.env.RUDDER_HOME ?? ctx.defaultDataDir
  const daemon = {
    host: env.RUDDER_HOST ?? ctx.daemon.host,
    port: env.RUDDER_PORT !== undefined ? Number(env.RUDDER_PORT) : ctx.daemon.port,
    tls: env.RUDDER_TLS !== undefined ? env.RUDDER_TLS !== "0" : ctx.daemon.tls,
  }
  const answers = state ? await ctx.probe(`${origin(daemon)}/health`) : false
  const running = state?.state === "Running" && answers
  ctx.log(`${ctx.taskName} task: ${state ? (running ? "running" : state.state.toLowerCase()) : "not installed"}`)
  if (state) {
    const pid = ctx.daemonPid(dataDir)
    ctx.log(`  pid       ${running && pid !== null ? pid : "-"}`)
    ctx.log(`  last run  ${state.lastRun ?? "never"}`)
    ctx.log(`  result    ${describeResult(state.lastResult)}`)
    ctx.log(`  serving   ${origin(daemon)}${answers ? "" : " (not answering)"}`)
    ctx.log(`  action    ${state.execute} ${state.arguments}`)
  }
  if (installed) {
    ctx.log(`  program   ${installed.parsed.programArguments.join(" ") || "-"}`)
    ctx.log(`  env       ${Object.keys(installed.parsed.environment).join(", ") || "-"}`)
  }
  const paths = taskPaths(dataDir, ctx.path)
  ctx.log(`  logs      ${paths.stdout}`)
  ctx.log(`            ${paths.stderr}`)
  return running ? 0 : 1
}

export async function runTaskCommand(command: ServiceCommand, makeContext: () => TaskContext): Promise<number> {
  try {
    const ctx = makeContext()
    if (command.kind === "install") await installTask(ctx)
    else if (command.kind === "uninstall") await uninstallTask(ctx, command.purge)
    else return await taskStatus(ctx)
    return 0
  } catch (error) {
    if (!(error instanceof TaskError || error instanceof AclError)) throw error
    console.error(`rudder ${command.kind}: ${error.message}`)
    return 1
  }
}

export function defaultTaskContext(): TaskContext {
  const run = runSync
  return {
    taskName: taskNameFrom(process.env),
    userSid: currentUserSid(run),
    home: homedir(),
    program: currentProgram(),
    env: process.env,
    daemon: { host: DAEMON_HOST, port: DAEMON_PORT, tls: TLS_ENABLED },
    defaultDataDir: DEFAULT_DATA_DIR,
    path: win32,
    run,
    sleep: Bun.sleep,
    probe: probeHealth,
    daemonPid: (dataDir) => readChannelFile(win32.join(dataDir, TOKEN_FILE))?.pid ?? null,
    protect: (dir) => restrictToUser(dir, { directory: true, run }),
    protectFile: (file) => restrictToUser(file, { directory: false, run }),
    log: console.log,
  }
}
