import { describe, expect, test } from "bun:test"
import { escapeBatchArgument, escapeBatchCommand, killTree, planSpawn, resolveWindowsCommand, UnsafeArgumentError } from "./spawn"

// A Windows PATH as a typical npm + native-installer machine has it (Path, not PATH: Windows spells it that way).
const ENV = {
  Path: "C:\\Users\\tester\\.local\\bin;C:\\Program Files\\nodejs\\;C:\\Users\\tester\\AppData\\Roaming\\npm;\"C:\\Tools\\quoted\";relative\\bin",
  PATHEXT: ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC",
  ComSpec: "C:\\Windows\\system32\\cmd.exe",
}
const FILES = new Set(
  [
    "C:\\Users\\tester\\.local\\bin\\claude.exe",
    "C:\\Users\\tester\\AppData\\Roaming\\npm\\codex.cmd",
    "C:\\Users\\tester\\AppData\\Roaming\\npm\\codex.ps1",
    "C:\\Users\\tester\\AppData\\Roaming\\npm\\codex",
    "C:\\Program Files\\nodejs\\npx.cmd",
    "C:\\Tools\\quoted\\grok.exe",
    "C:\\Users\\tester\\AppData\\Roaming\\npm\\pi.ps1",
    "C:\\Users\\tester\\AppData\\Roaming\\npm\\opencode.js",
    "relative\\bin\\kimi.cmd",
  ].map((path) => path.toLowerCase()),
)
const exists = (path: string) => FILES.has(path.toLowerCase())

describe("resolveWindowsCommand", () => {
  test("PATH + PATHEXT, in order; quoted PATH entries; never a relative entry (the cwd)", () => {
    expect(resolveWindowsCommand("claude", ENV, exists)).toEqual({ path: "C:\\Users\\tester\\.local\\bin\\claude.exe", kind: "exe" })
    expect(resolveWindowsCommand("codex", ENV, exists)).toEqual({ path: "C:\\Users\\tester\\AppData\\Roaming\\npm\\codex.cmd", kind: "batch" })
    expect(resolveWindowsCommand("npx", ENV, exists)).toEqual({ path: "C:\\Program Files\\nodejs\\npx.cmd", kind: "batch" })
    expect(resolveWindowsCommand("grok", ENV, exists)).toEqual({ path: "C:\\Tools\\quoted\\grok.exe", kind: "exe" })
    expect(resolveWindowsCommand("kimi", ENV, exists)).toBeNull()
  })

  test("a .ps1 shim only when nothing else exists; .js and extension-less files never run", () => {
    expect(resolveWindowsCommand("pi", ENV, exists)).toEqual({ path: "C:\\Users\\tester\\AppData\\Roaming\\npm\\pi.ps1", kind: "powershell" })
    expect(resolveWindowsCommand("opencode", ENV, exists)).toBeNull()
  })

  test("a path with an extension is taken as is", () => {
    expect(resolveWindowsCommand("C:\\Tools\\quoted\\grok.exe", ENV, exists)?.kind).toBe("exe")
    expect(resolveWindowsCommand("C:\\Users\\tester\\AppData\\Roaming\\npm\\codex", ENV, exists)?.kind).toBe("batch")
  })
})

describe("cmd.exe escaping", () => {
  // The same strings cross-spawn produces for an npm shim (double escaping), which survive both of cmd's passes.
  test.each([
    ["app-server", '^^^"app-server^^^"'],
    ["a b", '^^^"a^^^ b^^^"'],
    ['say "hi" & calc', '^^^"say^^^ \\^^^"hi\\^^^"^^^ ^^^&^^^ calc^^^"'],
    ["%PATH%", '^^^"^^^%PATH^^^%^^^"'],
    ["C:\\dir with space\\", '^^^"C:\\dir^^^ with^^^ space\\\\^^^"'],
    ["!x! ^ | > <", '^^^"^^^!x^^^!^^^ ^^^^^^^ ^^^|^^^ ^^^>^^^ ^^^<^^^"'],
    ["", '^^^"^^^"'],
  ])("%j", (arg, escaped) => {
    expect(escapeBatchArgument(arg)).toBe(escaped)
  })

  test("line breaks and NUL are refused: cmd.exe would run what follows them", () => {
    expect(() => escapeBatchArgument("a\r\ncalc")).toThrow(UnsafeArgumentError)
    expect(() => escapeBatchArgument("a\0")).toThrow(UnsafeArgumentError)
  })

  test("the command path gets single carets", () => {
    expect(escapeBatchCommand("C:\\Program Files (x86)\\npm\\codex.cmd")).toBe("C:\\Program^ Files^ ^(x86^)\\npm\\codex.cmd")
  })
})

describe("planSpawn", () => {
  test("macOS: argv and options untouched", () => {
    const argv = ["codex", "app-server"]
    expect(planSpawn(argv, ENV, "darwin", exists)).toEqual({ argv, options: {} })
  })

  test("Windows .exe: the full path, no shell, hidden window", () => {
    expect(planSpawn(["claude", "--model", "opus"], ENV, "win32", exists)).toEqual({
      argv: ["C:\\Users\\tester\\.local\\bin\\claude.exe", "--model", "opus"],
      options: { windowsHide: true },
    })
  })

  test("Windows .cmd: one verbatim cmd /d /s /v:off /c line", () => {
    expect(planSpawn(["codex", "app-server"], ENV, "win32", exists)).toEqual({
      argv: ["C:\\Windows\\system32\\cmd.exe", "/d", "/s", "/v:off", "/c", '"C:\\Users\\tester\\AppData\\Roaming\\npm\\codex.cmd ^^^"app-server^^^""'],
      options: { windowsVerbatimArguments: true, windowsHide: true },
    })
  })

  test("Windows .ps1: powershell -File, arguments as separate argv", () => {
    expect(planSpawn(["pi", "--mode", "rpc"], ENV, "win32", exists).argv).toEqual([
      "powershell.exe",
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "C:\\Users\\tester\\AppData\\Roaming\\npm\\pi.ps1",
      "--mode",
      "rpc",
    ])
  })

  test("Windows, not on PATH: the bare name, so Bun's own not-found error surfaces", () => {
    expect(planSpawn(["kimi", "acp"], ENV, "win32", exists).argv).toEqual(["kimi", "acp"])
  })
})

describe("killTree", () => {
  test("Windows: taskkill the tree, forcefully", () => {
    const calls: string[][] = []
    expect(killTree(4242, "win32", (argv) => calls.push(argv))).toBe(true)
    expect(calls).toEqual([["taskkill.exe", "/PID", "4242", "/T", "/F"]])
  })

  test("elsewhere: false, nothing run, so the caller signals the child as before", () => {
    const calls: string[][] = []
    expect(killTree(4242, "darwin", (argv) => calls.push(argv))).toBe(false)
    expect(calls).toEqual([])
  })
})
