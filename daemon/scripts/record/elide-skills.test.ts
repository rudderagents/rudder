import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import { collectUserSkillNames, elideUserSkills, isUserCommand } from "./lib"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("collectUserSkillNames", () => {
  test("reads skill folder and command-file names from a home, and ignores dot entries", () => {
    const home = mkdtempSync(join(tmpdir(), "rudder-skills-"))
    dirs.push(home)
    mkdirSync(join(home, ".claude", "skills", "pack-list"), { recursive: true })
    writeFileSync(join(home, ".claude", "skills", "pack-list", "SKILL.md"), "# pack-list")
    mkdirSync(join(home, ".claude", "commands"), { recursive: true })
    writeFileSync(join(home, ".claude", "commands", "ship.md"), "# ship")
    mkdirSync(join(home, ".codex", "skills", "review-pr"), { recursive: true })
    mkdirSync(join(home, ".claude", "skills", ".hidden"), { recursive: true })
    expect(collectUserSkillNames(home)).toEqual(new Set(["pack-list", "ship", "review-pr"]))
  })
})

describe("elideUserSkills", () => {
  const skills = new Set(["pack-list", "vault-notes"])

  test("available_commands_update keeps bundled and built-in commands, and replaces user skills with a count", () => {
    const frame = {
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: [
            { name: "compact", description: "shrink the context", input: { hint: "" } },
            { name: "pack-list", description: "a private skill that names a vault", input: { hint: "target" } },
            { name: "help", description: "help", _meta: { scope: "bundled" } },
            { name: "draft", description: "user-scoped", _meta: { scope: "user" } },
            { name: "local-cmd", description: "not built in", builtin: false },
            { name: "init", description: "start", builtin: true },
          ],
        },
      },
    }
    const out = elideUserSkills(frame, skills)
    expect(out?.note).toContain("availableCommands 3 user commands")
    expect(out?.frame.params).toEqual({
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [
          { name: "compact", description: "shrink the context", input: { hint: "" } },
          { name: "help", description: "help", _meta: { scope: "bundled" } },
          { name: "init", description: "start", builtin: true },
          { name: "<elided: 3 user commands>", description: "" },
        ],
      },
    })
    expect(JSON.stringify(out?.frame)).not.toContain("pack-list")
    expect(JSON.stringify(out?.frame)).not.toContain("private skill")
  })

  test("a personal output style name becomes a placeholder on any frame, including initialize replies", () => {
    const frame = {
      type: "control_response",
      response: { subtype: "success", response: { output_style: "personal-style", commands: [{ name: "init", builtin: true }] } },
    }
    const out = elideUserSkills(frame, skills)
    expect(out?.note).toBe("output_style")
    expect((out?.frame.response as { response: { output_style: string } }).response.output_style).toBe("<elided>")
  })

  test("availableSkillDetails drops user-level or named skills and leaves bundled ones", () => {
    const frame = {
      params: {
        update: {
          _meta: {
            availableSkillDetails: [
              { name: "help", level: "bundled", description: "bundled help", body: "…" },
              { name: "vault-notes", level: "user", description: "reads a private vault", body: "secret" },
            ],
          },
        },
      },
    }
    const out = elideUserSkills(frame, skills)
    expect(out?.note).toContain("availableSkillDetails 1 user skills")
    const details = (out?.frame.params as { update: { _meta: { availableSkillDetails: unknown[] } } }).update._meta.availableSkillDetails
    expect(details).toEqual([{ name: "help", level: "bundled", description: "bundled help", body: "…" }, "<elided: 1 user skill details>"])
  })

  test("frames with nothing to strip are left untouched", () => {
    const frame = { params: { update: { availableCommands: [{ name: "compact", description: "shrink" }] } } }
    expect(elideUserSkills(frame, skills)).toBeUndefined()
    expect(isUserCommand({ name: "compact" }, skills)).toBe(false)
  })
})
