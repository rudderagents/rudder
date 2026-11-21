import { describe, expect, test } from "bun:test"
import { upgradeCommandFor } from "./upgrade"

describe("upgrade command by install", () => {
  test("each known install of Claude Code and Codex; anything else gets none", () => {
    expect(upgradeCommandFor("claude", "/Users/a/.local/share/claude/versions/2.1.312")).toBe("claude update")
    expect(upgradeCommandFor("claude", "/opt/homebrew/Caskroom/claude-code/2.1.311/claude")).toBe("brew upgrade --cask claude-code")
    // The desktop app's cask is not the CLI.
    expect(upgradeCommandFor("claude", "/opt/homebrew/Caskroom/claude/1.0/Claude.app/x")).toBeUndefined()
    expect(upgradeCommandFor("claude", "/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js")).toBe(
      "npm install -g @anthropic-ai/claude-code@latest",
    )
    expect(upgradeCommandFor("codex", "/Users/a/.codex/packages/standalone/releases/0.165.0-aarch64-apple-darwin/bin/codex")).toBe("codex update")
    expect(upgradeCommandFor("codex", "/opt/homebrew/Caskroom/codex/0.167.0/codex")).toBe("brew upgrade codex")
    expect(upgradeCommandFor("codex", "/usr/local/lib/node_modules/@openai/codex/bin/codex.js")).toBe("npm install -g @openai/codex@latest")
    expect(upgradeCommandFor("codex", "/usr/bin/codex")).toBeUndefined()
    expect(upgradeCommandFor("grok", "/x/node_modules/grok")).toBeUndefined()
    expect(upgradeCommandFor("claude", undefined)).toBeUndefined()
  })
})
