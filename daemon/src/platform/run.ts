// Short synchronous commands the Windows layer runs (whoami, icacls, schtasks, powershell). Tests replace the runner
// with recorded output, so nothing here needs a Windows machine to be checked.
import type { Env } from "./index"

export type SyncResult = { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }
export type SyncRunner = (argv: string[], options?: { timeoutMs?: number; env?: Env }) => SyncResult

const DEFAULT_TIMEOUT_MS = 15_000

export const runSync: SyncRunner = (argv, options = {}) => {
  const result = Bun.spawnSync(argv, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    killSignal: "SIGKILL",
    env: options.env,
    // No console window flashes up when the daemon runs from the logon task.
    windowsHide: true,
  })
  return {
    exitCode: result.exitCode,
    stdout: result.stdout?.toString() ?? "",
    stderr: result.stderr?.toString() ?? "",
    timedOut: result.exitedDueToTimeout === true,
  }
}

/** `powershell -NoProfile -NonInteractive -Command <script>`; values reach the script through env, never the text. */
export function powershellArgv(script: string): string[] {
  return ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script]
}

export function describeFailure(argv: string[], result: SyncResult): string {
  const how = result.timedOut ? "timed out" : `exit ${result.exitCode}`
  return `${argv[0]} ${argv[1] ?? ""} failed (${how}): ${result.stderr.trim() || result.stdout.trim() || "no output"}`
}
