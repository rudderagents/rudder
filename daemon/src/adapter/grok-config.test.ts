import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { grokPermissionLock, readUiLock } from "./grok-config"

describe("Grok permission lock (v71)", () => {
  test("[ui] permission_mode always-approve locks; other modes and other tables do not", () => {
    expect(readUiLock('[ui]\npermission_mode = "always-approve"\n')).toBe(true)
    expect(readUiLock('[ui]\npermission_mode = "auto"\n')).toBe(false)
    expect(readUiLock('[other]\npermission_mode = "always-approve"\n[ui]\ntheme = "dark"\n')).toBe(false)
    expect(readUiLock('[ui]\n# permission_mode = "always-approve"\n')).toBe(false)
  })

  test("legacy yolo = true locks unless an explicit mode says otherwise", () => {
    expect(readUiLock("[ui]\nyolo = true\n")).toBe(true)
    expect(readUiLock('[ui]\nyolo = true\npermission_mode = "auto"\n')).toBe(false)
    // The owner's file: legacy yolo off, the new key on.
    expect(readUiLock('[ui]\nyolo = false\npermission_mode = "always-approve"\n')).toBe(true)
  })

  test("reads $GROK_HOME/config.toml; a missing file is no lock", () => {
    const home = mkdtempSync(join(tmpdir(), "grok-home-"))
    expect(grokPermissionLock(home)).toBeUndefined()
    writeFileSync(join(home, "config.toml"), '[ui]\npermission_mode = "always-approve"\n')
    expect(grokPermissionLock(home)).toEqual({ mode: "always-approve", source: join(home, "config.toml") })
  })
})
