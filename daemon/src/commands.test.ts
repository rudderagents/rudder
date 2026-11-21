import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { COMMAND_LIMITS, claudeCommands, codexCommands, frontmatter, nativeClaudeCommands } from "./commands"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "rudder-commands-"))
  roots.push(root)
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}

const skill = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`

describe("frontmatter", () => {
  test("plain, quoted and block values", () => {
    expect(frontmatter(skill("graphify", "Turns input into a graph"))).toEqual({ name: "graphify", description: "Turns input into a graph" })
    expect(frontmatter('---\nname: x\ndescription: "Use for \\"any\\" question: really"\n---\n')).toEqual({
      name: "x",
      description: 'Use for "any" question: really',
    })
    expect(frontmatter("---\ndescription: 'it''s fine'\n---\n").description).toBe("it's fine")
    expect(frontmatter("---\ndescription: >\n  Two folded\n  lines\nother: 1\n---\n").description).toBe("Two folded lines")
    expect(frontmatter("# no frontmatter\n")).toEqual({})
  })
})

describe("claudeCommands", () => {
  test("project, user and enabled plugin skills and commands, with descriptions", async () => {
    const on = tree({ "skills/review/SKILL.md": skill("caveman-review", "Terse review"), "commands/stats.md": "no frontmatter" })
    const off = tree({ "skills/hidden/SKILL.md": skill("hidden", "never listed") })
    const home = tree({
      ".claude/skills/graphify/SKILL.md": skill("graphify", "Knowledge graph"),
      ".claude/skills/shared/SKILL.md": skill("shared", "user copy"),
      ".claude/commands/git/commit.md": "---\ndescription: Commit staged changes\n---\nbody",
      ".claude/plugins/installed_plugins.json": JSON.stringify({
        plugins: {
          "caveman@caveman": [{ scope: "user", installPath: on }],
          "off@market": [{ scope: "user", installPath: off }],
        },
      }),
      ".claude/settings.json": JSON.stringify({ enabledPlugins: { "caveman@caveman": true, "off@market": false } }),
    })
    const cwd = tree({ ".claude/skills/shared/SKILL.md": skill("shared", "project copy") })

    const list = await claudeCommands(cwd, [], home)
    expect(list.map((c) => c.name)).toEqual(["caveman:caveman-review", "caveman:stats", "git:commit", "graphify", "shared"])
    expect(list.find((c) => c.name === "graphify")).toEqual({
      name: "graphify",
      insert: "/graphify",
      kind: "skill",
      description: "Knowledge graph",
      source: "user",
    })
    expect(list.find((c) => c.name === "shared")?.description).toBe("project copy")
    expect(list.find((c) => c.name === "git:commit")).toMatchObject({ kind: "command", insert: "/git:commit", description: "Commit staged changes" })
    expect(list.find((c) => c.name === "caveman:caveman-review")?.source).toBe("plugin:caveman")
    expect(list.find((c) => c.name === "caveman:stats")?.description).toBeUndefined()
  })

  test("a symlinked skill folder counts; names only init reported are added without a description", async () => {
    const real = tree({ "SKILL.md": skill("linked", "Lives elsewhere") })
    const home = tree({})
    mkdirSync(join(home, ".claude/skills"), { recursive: true })
    symlinkSync(real, join(home, ".claude/skills/linked"))
    const list = await claudeCommands(tree({}), ["linked", "compact"], home)
    expect(list).toEqual([
      { name: "compact", insert: "/compact", kind: "command", source: "agent" },
      { name: "linked", insert: "/linked", kind: "skill", description: "Lives elsewhere", source: "user" },
    ])
  })

  test("nothing installed is an empty list, not an error", async () => {
    expect(await claudeCommands(tree({}), [], tree({}))).toEqual([])
  })

  test("device files, FIFOs and directory loops are skipped instead of blocking the daemon", async () => {
    const cwd = tree({ ".claude/commands/ok.md": "---\ndescription: fine\n---\n" })
    symlinkSync("/dev/zero", join(cwd, ".claude/commands/zero.md"))
    execFileSync("mkfifo", [join(cwd, ".claude/commands/pipe.md")])
    symlinkSync(join(cwd, ".claude/commands"), join(cwd, ".claude/commands/loop"))
    mkdirSync(join(cwd, ".claude/skills/dev"), { recursive: true })
    symlinkSync("/dev/zero", join(cwd, ".claude/skills/dev/SKILL.md"))
    const list = await claudeCommands(cwd, [], tree({}))
    expect(list.map((c) => c.name)).toEqual(["ok"])
  })

  test("a huge file is read only up to the per-file cap; the walk stops at the entry cap", async () => {
    const big = `---\ndescription: big one\n---\n${"x".repeat(COMMAND_LIMITS.fileBytes * 4)}`
    const files: Record<string, string> = { ".claude/commands/big.md": big }
    for (let i = 0; i < COMMAND_LIMITS.entries + 50; i++) files[`.claude/commands/many/c${i}.md`] = "body"
    const list = await claudeCommands(tree(files), [], tree({}))
    expect(list.length).toBeLessThanOrEqual(COMMAND_LIMITS.entries)
    const cwd = tree({ ".claude/commands/big.md": big })
    expect((await claudeCommands(cwd, [], tree({}))).find((c) => c.name === "big")?.description).toBe("big one")
  })
})

describe("codexCommands", () => {
  test("Codex skills are inserted as $name", async () => {
    const home = tree({ ".codex/skills/graphify/SKILL.md": skill("graphify", "Knowledge graph") })
    expect(await codexCommands(home)).toEqual([{ name: "graphify", insert: "$graphify", kind: "skill", description: "Knowledge graph", source: "user" }])
  })
})


describe("native Claude catalogue", () => {
  test("native names control eligibility; local metadata cannot add hidden skills", () => {
    const result = nativeClaudeCommands([{ name: "parent-skill", description: "Native description" }], [
      { name: "hidden-skill", insert: "/hidden-skill", kind: "skill", source: "project" },
      { name: "parent-skill", insert: "/parent-skill", kind: "skill", source: "project" },
    ])
    expect(result).toEqual([{ name: "parent-skill", insert: "/parent-skill", kind: "skill", source: "project", description: "Native description" }])
  })
  test("preserves plugin namespaces and unique native aliases", () => {
    expect(nativeClaudeCommands([{ name: "plugin:skill", description: "x" }, { name: "plugin:skill", description: "x" }])).toEqual([
      { name: "plugin:skill", insert: "/plugin:skill", kind: "command", source: "plugin:plugin", description: "x" },
    ])
  })
})
