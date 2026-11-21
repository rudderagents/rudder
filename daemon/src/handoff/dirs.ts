import { homedir } from "node:os"
import { join } from "node:path"
import type { HandoffOptions } from "."

/** Claude Code's own folders: CLAUDE_CONFIG_DIR when set (as Claude reads it), else ~/.claude. */
export function claudeHandoffDirs(env: NodeJS.ProcessEnv = process.env): HandoffOptions {
  const base = env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")
  return { registryDir: join(base, "sessions"), projectsDir: join(base, "projects") }
}
