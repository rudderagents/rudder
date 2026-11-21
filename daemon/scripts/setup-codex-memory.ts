import { lstat, mkdir, readFile, readdir, rename, writeFile, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

type Handler = Record<string, unknown> & { type: string; command?: string }
type Group = Record<string, unknown> & { hooks: Handler[] }
type HookFile = Record<string, unknown> & { hooks: Record<string, Group[]> }
const events = new Set(["SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "PostCompact", "SubagentStart", "SubagentStop"])
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
const owned = (h: Handler) => h.type === "command" && typeof h.command === "string" && h.command.includes("CLAUDE_MEM_CODEX_HOOK=1") && h.command.includes("worker-service.cjs")
function validate(value: unknown, vendor = false): HookFile {
  if (!object(value) || (value.hooks !== undefined && !object(value.hooks))) throw new Error("Invalid hooks document: expected a hooks object")
  const hooks = (value.hooks ?? {}) as Record<string, unknown>
  for (const [event, groups] of Object.entries(hooks)) {
    if (vendor && !events.has(event)) throw new Error(`Unsupported memory hook event: ${event}`)
    if (!Array.isArray(groups)) throw new Error(`Invalid hook groups for ${event}`)
    for (const group of groups) {
      if (!object(group) || !Array.isArray(group.hooks) || (group.matcher !== undefined && typeof group.matcher !== "string")) throw new Error(`Invalid hook group for ${event}`)
      for (const handler of group.hooks) {
        if (!object(handler) || typeof handler.type !== "string") throw new Error(`Invalid hook handler for ${event}`)
        if (vendor && (!owned(handler as Handler) || !String(handler.command).trim())) throw new Error(`Not an official claude-mem Codex handler: ${event}`)
      }
    }
  }
  if (vendor && !Object.keys(hooks).length) throw new Error("Empty memory hook bundle")
  return { ...value, hooks } as HookFile
}
export function mergeCodexMemoryHooks(existing: unknown, bundle: unknown): HookFile {
  const current = validate(existing), vendor = validate(bundle, true)
  const knownCommands = new Set(Object.values(vendor.hooks).flatMap(groups => groups.flatMap(group => group.hooks.map(handler => handler.command))))
  const hooks: Record<string, Group[]> = {}
  for (const [event, groups] of Object.entries(current.hooks)) {
    for (const group of groups) for (const handler of group.hooks) {
      if (owned(handler) && !knownCommands.has(handler.command)) throw new Error(`ambiguous claude-mem wrapper in ${event}; preserve and review it before setup`)
    }
    hooks[event] = groups.flatMap(group => {
      const remaining = group.hooks.filter(handler => !owned(handler))
      return remaining.length || !group.hooks.length ? [{ ...group, hooks: remaining }] : []
    })
  }
  for (const [event, groups] of Object.entries(vendor.hooks)) {
    hooks[event] ??= []
    for (const group of groups) {
      const copy = structuredClone(group)
      copy.hooks = copy.hooks.filter((handler, index, all) => all.findIndex(h => JSON.stringify(h) === JSON.stringify(handler)) === index)
      if (!hooks[event].some(g => JSON.stringify(g) === JSON.stringify(copy))) hooks[event].push(copy)
    }
  }
  return { ...current, hooks }
}
export type SetupReport = { state: "absent" | "configured"; target: string; version?: string; changed: boolean; applied: boolean; backup?: string }
export async function setupCodexMemory(options: { codexHome: string; claudeHome: string; apply?: boolean }): Promise<SetupReport> {
  const target = join(resolve(options.codexHome), "hooks.json")
  const cache = join(options.claudeHome, "plugins/cache/thedotmack/claude-mem")
  let versions: string[]
  try { versions = (await readdir(cache)).filter(v => /^\d+\.\d+\.\d+$/.test(v)).sort((a,b) => b.localeCompare(a, undefined, { numeric: true })) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent", target, changed: false, applied: false }; throw error }
  let bundle: unknown, version: string | undefined
  for (const candidate of versions) {
    try { bundle = validate(JSON.parse(await readFile(join(cache, candidate, "hooks/codex-hooks.json"), "utf8")), true); version = candidate; break }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
  }
  if (!version) return { state: "absent", target, changed: false, applied: false }
  let original: string | undefined
  try { original = await readFile(target, "utf8") } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
  const existing: unknown = original === undefined ? {} : JSON.parse(original)
  const merged = mergeCodexMemoryHooks(existing, bundle)
  const changed = JSON.stringify(validate(existing)) !== JSON.stringify(merged)
  const report: SetupReport = { state: "configured", target, version, changed, applied: false }
  if (!options.apply || !changed) return report
  try {
    if ((await lstat(target)).isSymbolicLink()) throw new Error("hooks.json is a symlink; review --check and update the resolved target explicitly to preserve shared dotfiles")
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
  await mkdir(options.codexHome, { recursive: true })
  const temp = `${target}.tmp-${crypto.randomUUID()}`
  try {
    await writeFile(temp, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600, flag: "wx" })
    let latest: string | undefined
    try { latest = await readFile(target, "utf8") } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
    if (latest !== original) throw new Error("Hooks changed during setup; rerun --check before applying")
    if (original !== undefined) {
      report.backup = `${target}.backup-${Date.now()}-${crypto.randomUUID()}`
      await writeFile(report.backup, original, { mode: 0o600, flag: "wx" })
    }
    await rename(temp, target); report.applied = true
  } finally { await rm(temp, { force: true }) }
  return report
}
if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args.length !== 1 || !["--check", "--apply"].includes(args[0]!)) throw new Error("Usage: bun scripts/setup-codex-memory.ts --check|--apply")
  console.log(JSON.stringify(await setupCodexMemory({ codexHome: process.env.CODEX_HOME || join(homedir(), ".codex"), claudeHome: process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), apply: args[0] === "--apply" }), null, 2))
}
