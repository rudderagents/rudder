// The one place that knows which OS the daemon runs on (the Windows notes). Every function takes the
// platform (and env / home) as parameters with the live values as defaults, so the Windows branches are unit-tested
// on a Mac with recorded command output, the way perf.ts injects `platform`.
import { lstatSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import nodePath, { posix, win32 } from "node:path"

export type Env = Record<string, string | undefined>

export function isWindows(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32"
}

/** The path module for `platform`: path.win32 on Windows, so a test on macOS builds the same strings Windows would. */
export function pathFor(platform: NodeJS.Platform = process.platform): typeof posix {
  if (platform === process.platform) return nodePath
  return isWindows(platform) ? win32 : posix
}

/** Reads an environment variable the way Windows does: names are case-insensitive there (`Path`, `PATH`). */
export function envValue(env: Env, name: string, platform: NodeJS.Platform = process.platform): string | undefined {
  if (env[name] !== undefined || !isWindows(platform)) return env[name]
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(env)) if (key.toLowerCase() === wanted && value !== undefined) return value
  return undefined
}

/**
 * Where RUDDER_HOME lives when it is not set: the db, TLS key, pairing state and the CLI channel.
 * macOS (and, until 1.1 gives Linux its own, Linux): ~/Library/Application Support/Rudder.
 * Windows: %LOCALAPPDATA%\Rudder, the per-user, non-roaming profile folder whose ACL already admits only the user,
 * SYSTEM and Administrators; the daemon tightens it further at start (win32-acl.ts).
 */
export function defaultDataDir(platform: NodeJS.Platform = process.platform, env: Env = process.env, home: string = homedir()): string {
  if (!isWindows(platform)) return posix.join(home, "Library", "Application Support", "Rudder")
  const local = envValue(env, "LOCALAPPDATA", platform)
  return win32.join(local && win32.isAbsolute(local) ? local : win32.join(home, "AppData", "Local"), "Rudder")
}

/** The resolve / realpath / lstat a path check runs with; tests pass path.win32 and an in-memory file system. */
export type PathHost = {
  path: typeof posix
  windows: boolean
  realpath: (path: string) => string
  isSymbolicLink: (path: string) => boolean
}

export const NATIVE_PATH_HOST: PathHost = {
  path: nodePath,
  windows: isWindows(),
  // On Windows the native call (GetFinalPathNameByHandle) also expands 8.3 short names (`SSH~1` → `.ssh`) and
  // follows junctions, so a hidden or outside folder cannot hide behind another spelling of itself.
  realpath: isWindows() ? realpathSync.native : realpathSync,
  // Node and Bun report junctions as symbolic links on Windows.
  isSymbolicLink: (path) => lstatSync(path).isSymbolicLink(),
}

// CON, PRN, AUX, NUL, COM1–9, LPT1–9 (with any extension, and the superscript digits Windows also reserves) open a
// device, not a file: reading `NUL` or `CON` blocks or returns nothing.
const RESERVED_DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$/i

/**
 * Why a Windows path must not be opened for the phone, or null. Device and verbatim namespaces (`\\?\`, `\\.\`) skip
 * the normalisation the other checks rely on; a `:` after the drive names an alternate data stream (`notes.txt:secret`);
 * reserved device names open a device.
 */
export function windowsPathProblem(input: string): string | null {
  if (input.includes("\0")) return "NUL character"
  const unified = input.replace(/\//g, "\\")
  if (/^\\\\[?.]\\/.test(unified) || unified.startsWith("\\??\\")) return "device or verbatim path"
  const withoutDrive = unified.replace(/^[A-Za-z]:/, "")
  if (withoutDrive.includes(":")) return "alternate data stream"
  for (const segment of withoutDrive.split("\\")) {
    // Windows ignores trailing dots and spaces: `nul.txt .` is still NUL.
    if (RESERVED_DEVICE.test(segment.replace(/[. ]+$/, ""))) return `reserved device name ${segment}`
  }
  return null
}
