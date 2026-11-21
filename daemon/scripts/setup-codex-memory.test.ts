import { expect, test } from "bun:test"
import { mkdtemp, readFile, writeFile, mkdir, rm, symlink, lstat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mergeCodexMemoryHooks, setupCodexMemory } from "./setup-codex-memory"

const memory = { type: "command", command: "CLAUDE_MEM_CODEX_HOOK=1 node worker-service.cjs hook codex context" }
const bundle = { hooks: { SessionStart: [{ matcher: "startup|resume", hooks: [memory] }] } }
test("setup is idempotent, replaces owned handlers and preserves adjacent hooks", () => {
  const serena = { type: "command", command: "serena activate" }
  const existing = { extra: true, hooks: { SessionStart: [{ matcher: "startup|resume", hooks: [serena, memory] }] } }
  const merged = mergeCodexMemoryHooks(existing, bundle)
  expect(merged.extra).toBe(true)
  expect(merged.hooks.SessionStart?.flatMap(g => g.hooks)).toEqual([serena, memory])
  expect(mergeCodexMemoryHooks(merged, bundle)).toEqual(merged)
  expect(() => mergeCodexMemoryHooks({ hooks: [] }, bundle)).toThrow()
  expect(() => mergeCodexMemoryHooks({}, { hooks: { SessionStart: [{ hooks: [{ type: "command", command: "arbitrary" }] }] } })).toThrow()
})
test("custom roots, numeric versions, dry run and atomic apply preserve original invalid bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-setup-"))
  try {
    const codexHome = join(root, "codex"), claudeHome = join(root, "claude")
    await mkdir(codexHome, { recursive: true })
    expect((await setupCodexMemory({ codexHome, claudeHome })).state).toBe("absent")
    for (const version of ["9.0.0", "16.0.1"]) {
      const dir = join(claudeHome, "plugins/cache/thedotmack/claude-mem", version, "hooks")
      await mkdir(dir, { recursive: true }); await writeFile(join(dir, "codex-hooks.json"), JSON.stringify(bundle))
    }
    const target = join(codexHome, "hooks.json")
    await writeFile(target, "{invalid")
    await expect(setupCodexMemory({ codexHome, claudeHome, apply: true })).rejects.toThrow()
    expect(await readFile(target, "utf8")).toBe("{invalid")
    await writeFile(target, '{"other":1,"hooks":{}}')
    const check = await setupCodexMemory({ codexHome, claudeHome })
    expect(check.version).toBe("16.0.1"); expect(check.target).toBe(target); expect(check.changed).toBe(true)
    expect(await readFile(target, "utf8")).toBe('{"other":1,"hooks":{}}')
    const applied = await setupCodexMemory({ codexHome, claudeHome, apply: true })
    expect(applied.backup).toBeTruthy()
    expect((await setupCodexMemory({ codexHome, claudeHome, apply: true })).changed).toBe(false)
    expect(JSON.parse(await readFile(target, "utf8")).other).toBe(1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("ambiguous owner wrappers and empty unrelated groups are preserved", () => {
  const wrapper = { ...memory, command: memory.command + "; owner-backup" }
  const original = {hooks:{SessionStart:[{hooks:[wrapper]}],SessionEnd:[{hooks:[]}]}}
  expect(() => mergeCodexMemoryHooks(original,bundle)).toThrow("ambiguous")
  expect(original.hooks.SessionStart[0]!.hooks).toEqual([wrapper])
  expect(mergeCodexMemoryHooks({hooks:{SessionEnd:[{hooks:[]}]}},bundle).hooks.SessionEnd).toEqual([{hooks:[]}])
})

test("apply rejects symlink targets before mutation and preserves shared dotfiles", async () => {
  const root=await mkdtemp(join(tmpdir(),"memory-link-"))
  try {
    const home=join(root,"codex"),claudeHome=join(root,"claude"),shared=join(root,"shared.json")
    await mkdir(home); await writeFile(shared,'{"hooks":{}}'); await symlink(shared,join(home,"hooks.json"))
    const dir=join(claudeHome,"plugins/cache/thedotmack/claude-mem/16.0.1/hooks")
    await mkdir(dir,{recursive:true}); await writeFile(join(dir,"codex-hooks.json"),JSON.stringify(bundle))
    await expect(setupCodexMemory({codexHome:home,claudeHome,apply:true})).rejects.toThrow("symlink")
    expect((await lstat(join(home,"hooks.json"))).isSymbolicLink()).toBe(true)
    expect(await readFile(shared,"utf8")).toBe('{"hooks":{}}')
  } finally {await rm(root,{recursive:true,force:true})}
})
