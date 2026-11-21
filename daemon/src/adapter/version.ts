// Optional agent CLI version for hello.agents[].version. Probed again when the binary on PATH changes (an upgrade).
// `--version` is appended to the binary only: launch subcommands (`agent stdio`, `app-server`) would
// start a session instead of printing a version. npx keeps its package spec so the pinned package is asked.

import { realpathSync, statSync } from "node:fs"
import { planSpawn } from "../platform/spawn"

const SEMVER = /\d+\.\d+(?:\.\d+)?/

export function firstSemver(text: string): string | undefined {
  return SEMVER.exec(text)?.[0]
}

export function versionArgv(command: string[]): string[] {
  const bin = command[0]
  if (!bin) return []
  // Launch subcommands stay off this argv; only npx needs the package spec that follows the binary.
  if (bin === "npx") return [...command, "--version"]
  return [bin, "--version"]
}

// Resolves to the first semver on stdout, or undefined when the command is missing, fails, or exceeds `timeoutMs`.
export async function probeCliVersion(argv: string[], timeoutMs = 2_000): Promise<string | undefined> {
  if (argv.length === 0) return undefined
  const plan = planSpawn(argv)
  const child = Bun.spawn(plan.argv, {
    ...plan.options,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    signal: AbortSignal.timeout(timeoutMs),
  })
  try {
    const stdout = await new Response(child.stdout).text()
    await child.exited
    return firstSemver(stdout)
  } catch {
    child.kill()
    return undefined
  }
}

/** Numeric compare of dotted versions ("0.52" < "0.52.1" < "0.100.0"); missing parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map((part) => Number.parseInt(part, 10) || 0)
  const right = b.split(".").map((part) => Number.parseInt(part, 10) || 0)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** Where `bin` resolves on PATH, symlinks followed (a native installer swaps the link target on update). */
export function resolvedBinary(bin: string): string | undefined {
  const found = Bun.which(bin)
  if (!found) return undefined
  try {
    return realpathSync(found)
  } catch {
    return found
  }
}

// Changes when the binary is replaced: an upgrade moves the link target or rewrites the file.
export function binaryStamp(bin: string): string {
  const path = resolvedBinary(bin)
  if (!path) return ""
  try {
    return `${path}:${statSync(path).mtimeMs}`
  } catch {
    return path
  }
}

// One probe per binary: callers share the promise until the binary changes; a failure stays undefined.
export function cachedCliVersion(argv: string[], timeoutMs = 2_000): () => Promise<string | undefined> {
  let cached: { stamp: string; value: Promise<string | undefined> } | undefined
  return () => {
    const stamp = argv[0] === "npx" ? "npx" : binaryStamp(argv[0] ?? "")
    if (cached?.stamp !== stamp) cached = { stamp, value: probeCliVersion(argv, timeoutMs).catch(() => undefined) }
    return cached.value
  }
}
