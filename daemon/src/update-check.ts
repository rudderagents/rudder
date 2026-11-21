import { readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { TerminalLocale } from "./qr"

/**
 * The tap's formula on GitHub (the distribution notes): its `version "x.y.z"` is what
 * `brew upgrade rudder` would install. The one place the update check names a host.
 */
export const FORMULA_URL = "https://raw.githubusercontent.com/rudderagents/homebrew-tap/main/Formula/rudder.rb"
/**
 * The Windows release manifest on our own domain (the Windows notes): `{"version": "x.y.z"}`, the version
 * `scoop update rudder` / `winget upgrade rudder` would install. Reserved before 1.0 so every shipped rudderd already
 * asks the right place; until a Windows release exists the site serves `{"version": null}`, and a 404, a timeout or a
 * malformed file all read as "no update" without a word.
 */
export const WINDOWS_UPDATE_MANIFEST_URL: string | null = "https://rudderagents.com/windows/latest.json"
/** At most one network check per day; `rudder status` and later starts read the cached answer. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
export const CHECK_TIMEOUT_MS = 3000
export const CACHE_FILE = "update-check.json"

export type UpdateCache = { checkedAt: number; latest: string | null }

const AMBER = "\x1b[38;2;245;196;107m"
const BOLD_WHITE = "\x1b[1;97m"
const RESET = "\x1b[0m"

/** `RUDDER_UPDATE_CHECK=off` (or 0 / false / no) turns the notice and its network check off. */
export function updateCheckEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const value = env.RUDDER_UPDATE_CHECK?.trim().toLowerCase()
  return !(value === "off" || value === "0" || value === "false" || value === "no")
}

/** Homebrew keeps every keg under `…/Cellar/rudder/<version>/`; anything else (a source checkout, a copied binary) is not brew's to upgrade. */
export function isHomebrewInstall(executable: string, resolve: (path: string) => string = realpathSync): boolean {
  let real = executable
  try {
    real = resolve(executable)
  } catch {
    // A path that no longer resolves is judged as written.
  }
  return /\/Cellar\/rudder\/[^/]+\//.test(real)
}

export type InstallChannel = "homebrew" | "scoop" | "winget"

/**
 * Which package manager put this executable here: Homebrew's Cellar; Scoop's `…\scoop\apps\rudder\…`; winget's
 * portable `…\Microsoft\WinGet\Packages\…` (or its `Links` alias). Null for a source checkout or a copied file.
 */
export function installChannel(
  executable: string,
  resolve: (path: string) => string = realpathSync,
  platform: NodeJS.Platform = process.platform,
): InstallChannel | null {
  if (platform !== "win32") return isHomebrewInstall(executable, resolve) ? "homebrew" : null
  const path = executable.replace(/\//g, "\\").toLowerCase()
  if (/\\scoop\\apps\\rudder\\/.test(path)) return "scoop"
  if (/\\microsoft\\winget\\(packages|links)\\/.test(path)) return "winget"
  return null
}

/** What the notice tells the person to run. */
export function upgradeCommand(channel: InstallChannel | null): string {
  if (channel === "scoop") return "scoop update rudder"
  if (channel === "winget") return "winget upgrade rudder"
  return "brew upgrade rudder"
}

function defaultUpgradeCommand(): string {
  return process.platform === "win32" ? upgradeCommand(installChannel(process.execPath)) : upgradeCommand("homebrew")
}

/** The `"version"` of the Windows manifest (Scoop's shape); null when there is none, it is `null`, or the file is not JSON. */
export function manifestVersion(manifest: string): string | null {
  try {
    const version = (JSON.parse(manifest) as { version?: unknown }).version
    return typeof version === "string" && /^[0-9][0-9A-Za-z.+-]*$/.test(version) ? version : null
  } catch {
    return null
  }
}

/** The `version "…"` line of a formula; null when there is none. */
export function formulaVersion(formula: string): string | null {
  const match = formula.match(/^\s*version\s+"([0-9][0-9A-Za-z.+-]*)"/m)
  return match ? match[1] : null
}

/** Numeric dot parts, like the app's `DaemonVersion.compare`: anything after "-" or "+" is ignored, a missing part is 0. */
export function compareVersions(left: string, right: string): number {
  const parts = (version: string) =>
    (version.split(/[-+]/)[0] ?? "").split(".").map((part) => {
      const value = Number.parseInt(part, 10)
      return Number.isFinite(value) ? value : 0
    })
  const a = parts(left)
  const b = parts(right)
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return difference < 0 ? -1 : 1
  }
  return 0
}

export function readUpdateCache(dataDir: string): UpdateCache | null {
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, CACHE_FILE), "utf8")) as Partial<UpdateCache>
    if (typeof raw.checkedAt !== "number") return null
    return { checkedAt: raw.checkedAt, latest: typeof raw.latest === "string" ? raw.latest : null }
  } catch {
    return null
  }
}

function writeUpdateCache(dataDir: string, cache: UpdateCache) {
  const path = join(dataDir, CACHE_FILE)
  const temporary = `${path}.tmp`
  writeFileSync(temporary, `${JSON.stringify(cache)}\n`, { mode: 0o600 })
  renameSync(temporary, path)
}

export type UpdateCheckOptions = {
  dataDir: string
  now?: number
  url?: string
  timeoutMs?: number
  fetch?: typeof fetch
  platform?: NodeJS.Platform
}

/** The cached answer when it is under a day old; null when there is none or it is stale. */
export function freshCache(dataDir: string, now: number = Date.now()): UpdateCache | null {
  const cached = readUpdateCache(dataDir)
  if (!cached || now - cached.checkedAt < 0 || now - cached.checkedAt >= CHECK_INTERVAL_MS) return null
  return cached
}

/**
 * The newest version on the tap: the cached answer when it is under a day old, else one GET of the formula
 * (`timeoutMs`, default 3 s). A failed check is cached too, so a computer without network asks once a day, not every
 * start. Never throws: the notice is a courtesy.
 */
export async function latestVersion(options: UpdateCheckOptions): Promise<string | null> {
  const now = options.now ?? Date.now()
  const cached = freshCache(options.dataDir, now)
  if (cached) return cached.latest
  const windows = (options.platform ?? process.platform) === "win32"
  const url = options.url ?? (windows ? WINDOWS_UPDATE_MANIFEST_URL : FORMULA_URL)
  // A build with no manifest URL: nothing to ask.
  if (url === null) return null
  let latest: string | null = null
  try {
    const answer = await (options.fetch ?? fetch)(url, {
      signal: AbortSignal.timeout(options.timeoutMs ?? CHECK_TIMEOUT_MS),
      headers: { "user-agent": "rudderd update check" },
    })
    if (answer.ok) latest = windows ? manifestVersion(await answer.text()) : formulaVersion(await answer.text())
  } catch {
    latest = null
  }
  try {
    writeUpdateCache(options.dataDir, { checkedAt: now, latest })
  } catch {
    // A read-only data dir only means asking again next start.
  }
  return latest
}

/** The newer version, or null when `latest` is missing or not newer than `current`. */
export function newerVersion(latest: string | null, current: string): string | null {
  return latest && compareVersions(latest, current) > 0 ? latest : null
}

/** The amber terminal line, after the pairing code. */
export function updateNotice(latest: string, current: string, locale: TerminalLocale, command = defaultUpgradeCommand()): string {
  const text =
    locale === "zh"
      ? `⬆ 有新版本：rudder ${latest}（现在 ${current}）· 运行 ${BOLD_WHITE}${command}${RESET}${AMBER}`
      : `⬆ rudder ${latest} is available (you have ${current}) · run ${BOLD_WHITE}${command}${RESET}${AMBER}`
  return `${AMBER}${text}${RESET}`
}

/** The LaunchAgent log's line: English, no colour. */
export function updateLogLine(latest: string, current: string, command = defaultUpgradeCommand()): string {
  return `rudderd: rudder ${latest} is available (running ${current}); run ${command}`
}

/** Whether this process should look at all: brew-installed and not turned off. */
export function shouldCheckForUpdates(
  executable: string,
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
  manifestUrl: string | null = WINDOWS_UPDATE_MANIFEST_URL,
): boolean {
  if (platform === "win32") return updateCheckEnabled(env) && manifestUrl !== null && installChannel(executable, (path) => path, platform) !== null
  return updateCheckEnabled(env) && isHomebrewInstall(executable)
}
