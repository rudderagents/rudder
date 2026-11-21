// Starting and stopping agent CLIs on every platform (the Windows notes).
//
// macOS and Linux: argv goes to Bun.spawn unchanged and stop signals the child, as before.
// Windows: npm installs agents as `claude.cmd` / `codex.cmd` shims, which CreateProcess cannot run, and
// TerminateProcess on the shim leaves its node.exe running. So the command is resolved on PATH with PATHEXT
// (never the current directory, where a repository could plant `claude.cmd`), a batch shim runs through
// `cmd.exe /d /s /v:off /c` with every argument escaped for both passes cmd makes over it, and stop kills the tree.
import { statSync } from "node:fs"
import { win32 } from "node:path"
import { type Env, envValue, isWindows } from "./index"

export type CommandKind = "exe" | "batch" | "powershell"
export type ResolvedCommand = { path: string; kind: CommandKind }

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD"
const RUNNABLE: Record<string, CommandKind> = { ".exe": "exe", ".com": "exe", ".bat": "batch", ".cmd": "batch" }

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * The file Windows would run for `name`: a path as given, else each PATH entry with each PATHEXT extension
 * (only .exe, .com, .bat, .cmd count), and a PowerShell `.ps1` shim last, since PATHEXT does not list it.
 */
export function resolveWindowsCommand(name: string, env: Env, exists: (path: string) => boolean = isFile): ResolvedCommand | null {
  const ext = win32.extname(name).toLowerCase()
  const candidatesFor = (base: string): string[] => {
    if (RUNNABLE[ext] || ext === ".ps1") return [base]
    const pathext = (envValue(env, "PATHEXT", "win32") || DEFAULT_PATHEXT)
      .split(";")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => RUNNABLE[entry])
    return [...pathext.map((entry) => base + entry), `${base}.ps1`]
  }
  const pick = (path: string): ResolvedCommand | null => {
    const kind = RUNNABLE[win32.extname(path).toLowerCase()] ?? (win32.extname(path).toLowerCase() === ".ps1" ? "powershell" : null)
    return kind && exists(path) ? { path, kind } : null
  }
  if (name.includes("\\") || name.includes("/")) {
    for (const candidate of candidatesFor(name)) {
      const hit = pick(candidate)
      if (hit) return hit
    }
    return null
  }
  const dirs = (envValue(env, "PATH", "win32") ?? "")
    .split(";")
    .map((dir) => dir.trim().replace(/^"(.*)"$/, "$1"))
    .filter((dir) => dir && win32.isAbsolute(dir))
  // PowerShell shims lose to any real program anywhere on PATH.
  for (const dir of dirs) {
    for (const candidate of candidatesFor(win32.join(dir, name)).filter((path) => !path.endsWith(".ps1") || ext === ".ps1")) {
      const hit = pick(candidate)
      if (hit) return hit
    }
  }
  for (const dir of dirs) {
    const hit = pick(win32.join(dir, ext === ".ps1" ? name : `${name}.ps1`))
    if (hit) return hit
  }
  return null
}

// cmd.exe metacharacters; each gets a caret, twice for arguments, because a shim's `%*` line is parsed again.
const CMD_META = /([()\][%!^"`<>&|;, *?])/g

export class UnsafeArgumentError extends Error {}

/** One argument for a `cmd /s /c "…"` line that runs a batch file (the escaping cross-spawn uses for npm shims). */
export function escapeBatchArgument(arg: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
  if (/[\r\n\u0000]/.test(arg)) throw new UnsafeArgumentError("an argument with a line break or NUL cannot be passed through cmd.exe")
  // MSVCRT rules for the program behind the shim: backslashes before a quote are doubled, the quote escaped.
  let quoted = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")
  quoted = `"${quoted}"`
  return quoted.replace(CMD_META, "^$1").replace(CMD_META, "^$1")
}

export function escapeBatchCommand(path: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
  if (/["\r\n\u0000]/.test(path)) throw new UnsafeArgumentError(`refusing to run ${path} through cmd.exe`)
  return path.replace(CMD_META, "^$1")
}

export type SpawnPlan = { argv: string[]; options: { windowsVerbatimArguments?: boolean; windowsHide?: boolean } }

/** How to start `argv` on `platform`; null when the command is not on PATH (Windows only: elsewhere Bun reports it). */
export function planSpawn(
  argv: string[],
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform,
  exists?: (path: string) => boolean,
): SpawnPlan {
  if (!isWindows(platform) || argv.length === 0) return { argv, options: {} }
  const [name, ...args] = argv
  const resolved = resolveWindowsCommand(name!, env, exists)
  // Not found: hand Bun the name so its own error ("ENOENT … claude") reaches the phone as before.
  if (!resolved) return { argv, options: { windowsHide: true } }
  if (resolved.kind === "exe") return { argv: [resolved.path, ...args], options: { windowsHide: true } }
  if (resolved.kind === "powershell") {
    return {
      argv: ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", resolved.path, ...args],
      options: { windowsHide: true },
    }
  }
  const line = [escapeBatchCommand(resolved.path), ...args.map(escapeBatchArgument)].join(" ")
  const comspec = envValue(env, "ComSpec", "win32") || "cmd.exe"
  return { argv: [comspec, "/d", "/s", "/v:off", "/c", `"${line}"`], options: { windowsVerbatimArguments: true, windowsHide: true } }
}

/**
 * Windows: ends `pid` and every process it started (`taskkill /T /F`), because killing a `.cmd` shim's cmd.exe leaves
 * the agent's node.exe behind. Returns false elsewhere, where the caller signals the child itself as before.
 */
export function killTree(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  spawn: (argv: string[]) => void = (argv) => {
    Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: true })
  },
): boolean {
  if (!isWindows(platform)) return false
  try {
    spawn(["taskkill.exe", "/PID", String(pid), "/T", "/F"])
  } catch {
    // taskkill missing or the process already gone: `exited` still settles the stop.
  }
  return true
}
