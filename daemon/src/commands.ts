// Native command eligibility and bounded legacy filesystem metadata for the composer.
// Field sources: the agent protocol notes (commands.list).
import { constants } from "node:fs"
import { type FileHandle, open, readdir, realpath, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join, relative, sep } from "node:path"
import type { AgentCommand } from "./adapter/types"

/**
 * A checked-out repo controls `.claude/commands` and `.claude/skills`, so a symlink to /dev/zero, a FIFO or a huge file
 * must not stall the daemon: only regular files are read (opened non-blocking, checked with fstat), each up to
 * `fileBytes` (frontmatter sits at the top); one listing reads at most `entries` files, walks at most `depth` folders
 * deep, and walks a folder reached twice through symlinks once. Symlinked skill folders still count — that is how most
 * are installed.
 */
export const COMMAND_LIMITS = { fileBytes: 16 * 1024, entries: 2000, depth: 8, settingsBytes: 8 * 1024 * 1024 }

type Frontmatter = { name?: string; description?: string }

/** `name` and `description` from YAML frontmatter: plain, quoted, or a `|` / `>` block folded into one line. */
export function frontmatter(text: string): Frontmatter {
  if (!text.startsWith("---")) return {}
  const end = text.indexOf("\n---", 3)
  if (end === -1) return {}
  const lines = text.slice(text.indexOf("\n") + 1, end).split("\n")
  const out: Frontmatter = {}
  for (let i = 0; i < lines.length; i++) {
    const match = /^(name|description):\s*(.*)$/.exec(lines[i])
    if (!match) continue
    const key = match[1] as keyof Frontmatter
    let value = match[2].trim()
    if (/^[|>][+-]?$/.test(value)) {
      const block: string[] = []
      while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]) || lines[i + 1] === "")) block.push(lines[++i].trim())
      value = block.filter(Boolean).join(" ")
    } else if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value[0] === '"' ? value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\") : value.slice(1, -1).replace(/''/g, "'")
    }
    if (value) out[key] = value
  }
  return out
}

/** Files read so far in one listing, shared by every root it walks. */
type Budget = { entries: number }

async function entries(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort()
  } catch {
    return []
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/** Up to `limit` bytes of a regular file (`whole` refuses one larger than `limit`); device, FIFO, socket or missing is undefined. */
async function readRegular(path: string, limit: number, whole = false): Promise<string | undefined> {
  let handle: FileHandle | undefined
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
    const info = await handle.stat()
    if (!info.isFile() || (whole && info.size > limit)) return undefined
    const buffer = Buffer.alloc(Math.min(limit, info.size))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead).toString("utf8")
  } catch {
    return undefined
  } finally {
    await handle?.close().catch(() => {})
  }
}

/** `<dir>/<skill>/SKILL.md`; symlinked skill folders count. */
export async function skillsIn(dir: string, source: string, prefix: string, sigil: string, budget: Budget = { entries: 0 }): Promise<AgentCommand[]> {
  const out: AgentCommand[] = []
  for (const entry of await entries(dir)) {
    if (budget.entries >= COMMAND_LIMITS.entries) break
    if (entry.startsWith(".")) continue
    const text = await readRegular(join(dir, entry, "SKILL.md"), COMMAND_LIMITS.fileBytes)
    if (text === undefined) continue
    budget.entries++
    const meta = frontmatter(text)
    const name = prefix + (meta.name ?? entry)
    out.push({ name, insert: sigil + name, kind: "skill", description: meta.description, source })
  }
  return out
}

/** Every `.md` file under `dir`; a subfolder becomes a `folder:` namespace, as Claude Code names them. */
export async function commandsIn(dir: string, source: string, prefix: string, budget: Budget = { entries: 0 }): Promise<AgentCommand[]> {
  const out: AgentCommand[] = []
  const walked = new Set<string>()
  const walk = async (folder: string, depth: number) => {
    const real = await realpath(folder).catch(() => undefined)
    if (real === undefined || walked.has(real) || depth > COMMAND_LIMITS.depth) return
    walked.add(real)
    for (const entry of await entries(folder)) {
      if (budget.entries >= COMMAND_LIMITS.entries) return
      if (entry.startsWith(".")) continue
      const path = join(folder, entry)
      if (await isDirectory(path)) await walk(path, depth + 1)
      else if (entry.endsWith(".md")) {
        const text = await readRegular(path, COMMAND_LIMITS.fileBytes)
        if (text === undefined) continue
        budget.entries++
        const name = prefix + relative(dir, path).slice(0, -3).split(sep).join(":")
        out.push({ name, insert: `/${name}`, kind: "command", description: frontmatter(text).description, source })
      }
    }
  }
  await walk(dir, 0)
  return out
}

type InstallRecord = { installPath?: unknown; scope?: unknown; projectPath?: unknown }

/** Enabled plugins (`~/.claude/settings.json` enabledPlugins) from `~/.claude/plugins/installed_plugins.json`. */
async function pluginCommands(cwd: string, home: string, budget: Budget): Promise<AgentCommand[]> {
  const json = async (path: string) => (await readRegular(path, COMMAND_LIMITS.settingsBytes, true)) || "{}"
  let installed: Record<string, InstallRecord[]> = {}
  let enabled: Record<string, unknown> = {}
  try {
    installed = JSON.parse(await json(join(home, ".claude", "plugins", "installed_plugins.json"))).plugins ?? {}
    enabled = JSON.parse(await json(join(home, ".claude", "settings.json"))).enabledPlugins ?? {}
  } catch {
    return []
  }
  const out: AgentCommand[] = []
  for (const [key, records] of Object.entries(installed)) {
    if (enabled[key] !== true || !Array.isArray(records)) continue
    const record = records.find((r) => r.scope !== "project" || (typeof r.projectPath === "string" && cwd.startsWith(r.projectPath)))
    if (typeof record?.installPath !== "string") continue
    const plugin = key.split("@")[0]
    const source = `plugin:${plugin}`
    out.push(...(await skillsIn(join(record.installPath, "skills"), source, `${plugin}:`, "/", budget)))
    out.push(...(await commandsIn(join(record.installPath, "commands"), source, `${plugin}:`, budget)))
  }
  return out
}

/** First one wins (project over user over plugin), sorted by name. */
function unique(list: AgentCommand[]): AgentCommand[] {
  const seen = new Map<string, AgentCommand>()
  for (const command of list) if (!seen.has(command.name)) seen.set(command.name, command)
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Claude Code's skills and custom commands for a session in `cwd`. `reported` is the last `system/init` slash_commands:
 * names in it that no file describes (built-ins such as compact) are added without a description.
 */
export async function claudeCommands(cwd: string, reported: string[] = [], home = homedir()): Promise<AgentCommand[]> {
  const budget: Budget = { entries: 0 }
  const found = unique([
    ...(await skillsIn(join(cwd, ".claude", "skills"), "project", "", "/", budget)),
    ...(await commandsIn(join(cwd, ".claude", "commands"), "project", "", budget)),
    ...(await skillsIn(join(home, ".claude", "skills"), "user", "", "/", budget)),
    ...(await commandsIn(join(home, ".claude", "commands"), "user", "", budget)),
    ...(await pluginCommands(cwd, home, budget)),
  ])
  const known = new Set(found.map((command) => command.name))
  const builtIn = reported
    .filter((name) => !known.has(name))
    .map((name) => ({ name, insert: `/${name}`, kind: "command" as const, source: "agent" }))
  return unique([...found, ...builtIn])
}

/** Codex invokes a skill as `$name`. */
export async function codexCommands(home = homedir()): Promise<AgentCommand[]> {
  return unique(await skillsIn(join(home, ".codex", "skills"), "user", "", "$"))
}


export type ClaudeNativeCommand = { name: string; description?: string }

/** Native eligibility is authoritative; filesystem metadata never adds commands. */
export function nativeClaudeCommands(commands: readonly ClaudeNativeCommand[], metadata: readonly AgentCommand[] = []): AgentCommand[] {
  const local = new Map(metadata.map(command => [command.name, command]))
  const result = new Map<string, AgentCommand>()
  for (const command of commands) {
    if (result.has(command.name)) continue
    const meta = local.get(command.name)
    const description = command.description || meta?.description
    const plugin = command.name.includes(":") ? command.name.split(":")[0] : undefined
    result.set(command.name, {
      name: command.name, insert: `/${command.name}`, kind: meta?.kind ?? "command",
      source: meta?.source ?? (plugin ? `plugin:${plugin}` : "agent"),
      ...(description ? { description } : {}),
    })
  }
  return [...result.values()]
}
