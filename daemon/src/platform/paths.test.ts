import { describe, expect, test } from "bun:test"
import { win32 } from "node:path"
import { resolveSafe } from "../workspace"
import { defaultDataDir, envValue, type PathHost, windowsPathProblem } from "./index"

describe("defaultDataDir", () => {
  test("macOS keeps Application Support", () => {
    expect(defaultDataDir("darwin", {}, "/Users/me")).toBe("/Users/me/Library/Application Support/Rudder")
  })

  test("Windows uses %LOCALAPPDATA%, whatever case the variable is spelled in", () => {
    expect(defaultDataDir("win32", { LocalAppData: "C:\\Users\\Me\\AppData\\Local" }, "C:\\Users\\Me")).toBe(
      "C:\\Users\\Me\\AppData\\Local\\Rudder",
    )
  })

  test("Windows without LOCALAPPDATA (or a relative one) falls back to the profile", () => {
    expect(defaultDataDir("win32", {}, "C:\\Users\\Me")).toBe("C:\\Users\\Me\\AppData\\Local\\Rudder")
    expect(defaultDataDir("win32", { LOCALAPPDATA: "relative" }, "C:\\Users\\Me")).toBe("C:\\Users\\Me\\AppData\\Local\\Rudder")
  })
})

test("envValue is case-insensitive on Windows only", () => {
  expect(envValue({ Path: "C:\\bin" }, "PATH", "win32")).toBe("C:\\bin")
  expect(envValue({ Path: "/bin" }, "PATH", "darwin")).toBeUndefined()
})

describe("windowsPathProblem", () => {
  test.each([
    ["\\\\?\\C:\\Users\\me\\x", "device or verbatim path"],
    ["\\\\.\\PhysicalDrive0", "device or verbatim path"],
    ["//?/C:/x", "device or verbatim path"],
    ["notes.txt:secret", "alternate data stream"],
    ["C:\\Users\\me\\a.txt::$DATA", "alternate data stream"],
    ["proj\\NUL", "reserved device name NUL"],
    ["proj\\con.txt", "reserved device name con.txt"],
    ["proj\\COM1 .", "reserved device name COM1 ."],
    ["a\0b", "NUL character"],
  ])("refuses %s", (input, reason) => {
    expect(windowsPathProblem(input)).toBe(reason)
  })

  test.each(["C:\\Users\\me\\proj\\file.txt", "proj/console.log", "D:/work", "\\\\nas\\share\\proj", "comma,1.txt"])("allows %s", (input) => {
    expect(windowsPathProblem(input)).toBeNull()
  })
})

/**
 * A Windows file system in a map: keys are lower-case canonical paths (NTFS is case-insensitive), values the real
 * path the native realpath returns (long names, junction targets resolved).
 */
function windowsHost(entries: Record<string, string>, links: string[] = []): PathHost {
  const real = new Map(Object.entries(entries).map(([key, value]) => [key.toLowerCase(), value]))
  const linkSet = new Set(links.map((link) => link.toLowerCase()))
  return {
    path: win32,
    windows: true,
    realpath: (path) => {
      const hit = real.get(win32.normalize(path).toLowerCase())
      if (hit === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" })
      return hit
    },
    isSymbolicLink: (path) => {
      if (!linkSet.has(win32.normalize(path).toLowerCase())) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
      return true
    },
  }
}

describe("resolveSafe on Windows", () => {
  const root = "C:\\Users\\Me"
  const host = windowsHost({
    "C:\\": "C:\\",
    "C:\\Users": "C:\\Users",
    "C:\\Users\\Me": "C:\\Users\\Me",
    "C:\\Users\\Me\\proj": "C:\\Users\\Me\\proj",
    "C:\\Users\\Me\\proj\\a.txt": "C:\\Users\\Me\\proj\\a.txt",
    // An 8.3 short name of .ssh: the native realpath answers with the long name.
    "C:\\Users\\Me\\SSH~1": "C:\\Users\\Me\\.ssh",
    "C:\\Users\\Me\\SSH~1\\id_ed25519": "C:\\Users\\Me\\.ssh\\id_ed25519",
    // A junction to another drive.
    "C:\\Users\\Me\\elsewhere": "D:\\data",
    "C:\\Users\\Me\\elsewhere\\x.txt": "D:\\data\\x.txt",
  }, ["C:\\Users\\Me\\dangling"])

  test("a path inside, in any case and with forward slashes, comes back as asked", () => {
    expect(resolveSafe("proj\\a.txt", root, host)).toBe("C:\\Users\\Me\\proj\\a.txt")
    expect(resolveSafe("c:/users/me/PROJ/a.txt", root, host)).toBe("c:\\users\\me\\PROJ\\a.txt")
    expect(resolveSafe("proj/new/file.txt", root, host)).toBe("C:\\Users\\Me\\proj\\new\\file.txt")
    expect(resolveSafe(".", root, host)).toBe(root)
  })

  test.each([
    "..\\Other",
    "D:\\data\\x.txt",
    "\\\\nas\\share\\x",
    "C:\\Users\\Other\\x",
    "elsewhere\\x.txt",
    "dangling\\x",
    "\\\\?\\C:\\Users\\Me\\proj\\a.txt",
    "proj\\a.txt:hidden",
    "proj\\NUL",
  ])("refuses %s", (input) => {
    expect(() => resolveSafe(input, root, host)).toThrow("path outside workspace")
  })

  test("a short name cannot reach a hidden folder", () => {
    expect(() => resolveSafe("SSH~1\\id_ed25519", root, host)).toThrow("隐藏文件")
    expect(() => resolveSafe(".ssh\\id_ed25519", root, host)).toThrow("隐藏文件")
  })
})
