// v83: the command that upgrades an agent CLI the way it was installed, read from the binary's resolved path
// (realpath: the npm, Homebrew and native installers all put a link in a bin folder). Unknown → undefined, and the
// phone words a plain "upgrade to x or later" instead of guessing a command.

const RULES: Record<string, Array<[marker: string, command: string]>> = {
  claude: [
    ["/Caskroom/claude-code/", "brew upgrade --cask claude-code"],
    ["/node_modules/@anthropic-ai/claude-code", "npm install -g @anthropic-ai/claude-code@latest"],
    // The native installer (~/.local/bin/claude → ~/.local/share/claude/versions/<v>).
    ["/.local/share/claude/versions/", "claude update"],
  ],
  codex: [
    ["/Caskroom/codex/", "brew upgrade codex"],
    ["/node_modules/@openai/codex", "npm install -g @openai/codex@latest"],
    // The standalone installer (~/.codex/packages/standalone/releases/<v>-<target>/bin/codex).
    ["/.codex/packages/standalone/", "codex update"],
  ],
}

export function upgradeCommandFor(agent: string, resolvedPath: string | undefined): string | undefined {
  if (!resolvedPath) return undefined
  return RULES[agent]?.find(([marker]) => resolvedPath.includes(marker))?.[1]
}
