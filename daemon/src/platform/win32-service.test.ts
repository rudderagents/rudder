import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, posix } from "node:path"
import { usageFor, USAGE } from "../cli"
import type { SyncResult, SyncRunner } from "./run"
import {
  describeResult,
  installTask,
  launcherFromArguments,
  parseLauncher,
  parseTaskQuery,
  renderLauncher,
  renderTaskXml,
  type TaskContext,
  taskArguments,
  taskNameFrom,
  taskStatus,
  uninstallTask,
  utf16le,
} from "./win32-service"

const SID = "S-1-5-21-1004336348-1177238915-682003330-1001"
const ok = (stdout = ""): SyncResult => ({ exitCode: 0, stdout, stderr: "", timedOut: false })
const fail = (exitCode: number, stderr: string): SyncResult => ({ exitCode, stdout: "", stderr, timedOut: false })

describe("launcher script", () => {
  const spec = {
    programArguments: ["C:\\Users\\tester\\scoop\\apps\\rudder\\current\\rudder.exe"],
    environment: { RUDDER_PORT: "7749", RUDDER_PUSH_GATEWAY: "https://push.example/?a=1&b=%TEMP%" },
    stdout: "C:\\Users\\tester\\AppData\\Local\\Rudder\\logs\\rudder.out.log",
    stderr: "C:\\Users\\tester\\AppData\\Local\\Rudder\\logs\\rudder.err.log",
  }

  test("quotes paths, doubles percent signs, loops on a crash and stops on a clean exit, with CRLF", () => {
    const text = renderLauncher(spec)
    expect(text).toContain('set "RUDDER_PUSH_GATEWAY=https://push.example/?a=1&b=%%TEMP%%"')
    expect(text).toContain(
      '"C:\\Users\\tester\\scoop\\apps\\rudder\\current\\rudder.exe" 1>>"C:\\Users\\tester\\AppData\\Local\\Rudder\\logs\\rudder.out.log" 2>>',
    )
    expect(text).toContain("if %errorlevel% equ 0 exit /b 0\r\nping -n 11 127.0.0.1 >nul\r\ngoto run")
    expect(text.split("\r\n").every((line) => !line.includes("\n"))).toBe(true)
  })

  test("reads back what it wrote", () => {
    expect(parseLauncher(renderLauncher(spec))).toEqual({ environment: spec.environment, programArguments: spec.programArguments })
  })

  test("a quote or a line break in a value is refused, not escaped", () => {
    expect(() => renderLauncher({ ...spec, environment: { RUDDER_HOST: 'x" & calc & "' } })).toThrow("quote or control character")
    expect(() => renderLauncher({ ...spec, environment: { RUDDER_HOST: "x\r\ncalc" } })).toThrow("quote or control character")
    expect(() => renderLauncher({ ...spec, environment: { "RUDDER_X&calc": "1" } })).toThrow("refusing environment name")
  })
})

describe("task XML", () => {
  const xml = renderTaskXml({
    taskName: "Rudder",
    userSid: SID,
    launcher: "C:\\Users\\R&D\\AppData\\Local\\Rudder\\rudder-task.cmd",
    workingDirectory: "C:\\Users\\R&D",
  })

  test("runs at this user's logon, unelevated, with no time limit and on battery", () => {
    expect(xml).toContain(`<LogonTrigger>\r\n      <Enabled>true</Enabled>\r\n      <UserId>${SID}</UserId>`)
    expect(xml).toContain("<LogonType>InteractiveToken</LogonType>")
    expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>")
    expect(xml).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>")
    expect(xml).toContain("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>")
    expect(xml).toContain("<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>")
    expect(xml).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>")
  })

  test("starts the launcher in a headless console and escapes XML", () => {
    expect(xml).toContain("<Command>conhost.exe</Command>")
    expect(xml).toContain('<Arguments>--headless cmd.exe /d /s /c &quot;&quot;C:\\Users\\R&amp;D\\AppData\\Local\\Rudder\\rudder-task.cmd&quot;&quot;</Arguments>')
    expect(xml).toContain("<WorkingDirectory>C:\\Users\\R&amp;D</WorkingDirectory>")
  })

  test("is written as UTF-16 LE with a byte order mark", () => {
    const bytes = utf16le("<a/>")
    expect([...bytes.subarray(0, 4)]).toEqual([0xff, 0xfe, 0x3c, 0x00])
  })

  test("the task arguments give the launcher back", () => {
    const launcher = "C:\\Users\\tester\\AppData\\Local\\Rudder\\rudder-task.cmd"
    expect(launcherFromArguments(taskArguments(launcher))).toBe(launcher)
  })

  test("a launcher path with cmd's special characters stays one quoted path", () => {
    // Without /s, cmd /c drops the outer quotes once the line holds & < > ( ) @ ^ | and splits the path at "&".
    const launcher = "C:\\Users\\R&D (Lab)\\AppData\\Local\\Rudder\\rudder-task.cmd"
    expect(taskArguments(launcher)).toBe(`--headless cmd.exe /d /s /c ""${launcher}""`)
    expect(launcherFromArguments(taskArguments(launcher))).toBe(launcher)
  })

  test("a task registered before /s still gives its launcher back", () => {
    expect(launcherFromArguments('--headless cmd.exe /d /c "C:\\x\\rudder-task.cmd"')).toBe("C:\\x\\rudder-task.cmd")
  })
})

describe("Get-ScheduledTask output", () => {
  test("a missing task, and a running one", () => {
    expect(parseTaskQuery("missing\r\n")).toBeNull()
    expect(
      parseTaskQuery(
        '{"state":"Running","lastRun":"2026-10-30T09:12:41.0000000+08:00","lastResult":267009,"execute":"conhost.exe","arguments":"--headless cmd.exe /d /c \\"C:\\\\x\\\\rudder-task.cmd\\""}\r\n',
      ),
    ).toEqual({
      state: "Running",
      lastRun: "2026-10-30T09:12:41.0000000+08:00",
      lastResult: 267009,
      execute: "conhost.exe",
      arguments: '--headless cmd.exe /d /c "C:\\x\\rudder-task.cmd"',
    })
  })

  test("result codes", () => {
    expect(describeResult(267009)).toBe("0x41301 (running)")
    expect(describeResult(1)).toBe("0x1")
    expect(describeResult(null)).toBe("-")
  })

  test("task name override is checked", () => {
    expect(taskNameFrom({})).toBe("Rudder")
    expect(taskNameFrom({ RUDDER_TASK_NAME: "Rudder Test" })).toBe("Rudder Test")
    expect(() => taskNameFrom({ RUDDER_TASK_NAME: "x\\..\\y" })).toThrow("not a task name")
  })
})

test("Windows usage names the task, macOS usage is unchanged", () => {
  expect(usageFor("darwin")).toBe(USAGE)
  const text = usageFor("win32")
  expect(text).toContain('Scheduled Task "Rudder"')
  expect(text).toContain("rudder-local.json")
  expect(text).not.toContain("LaunchAgent")
  expect(text).not.toContain("plist")
})

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

/** schtasks and Get-ScheduledTask scripted over one task; `probe` answers from a list, repeating the last. */
function harness(script: { existing?: boolean; probe?: boolean[]; create?: SyncResult } = {}) {
  const home = mkdtempSync(join(tmpdir(), "rudder-task-"))
  homes.push(home)
  const dataDir = join(home, "AppData", "Local", "Rudder")
  const calls: string[][] = []
  const lines: string[] = []
  const probes = [...(script.probe ?? [false])]
  let task: { state: string } | null = script.existing ? { state: "Running" } : null
  const protectedDirs: string[] = []
  const run: SyncRunner = (argv, options) => {
    calls.push(argv)
    if (argv[0] === "powershell.exe") {
      expect(options?.env?.RUDDER_TASK_NAME).toBe("Rudder")
      if (!task) return ok("missing")
      const args = taskArguments(join(dataDir, "rudder-task.cmd"))
      return ok(JSON.stringify({ state: task.state, lastRun: "", lastResult: 0x41301, execute: "conhost.exe", arguments: args }))
    }
    if (argv[0] === "schtasks.exe" && argv[1] === "/Create") {
      if (script.create) return script.create
      // What schtasks would read: UTF-16 with a BOM.
      expect([...readFileSync(argv[5]!).subarray(0, 2)]).toEqual([0xff, 0xfe])
      task = { state: "Ready" }
      return ok()
    }
    if (argv[0] === "schtasks.exe" && argv[1] === "/Run") {
      task = { state: "Running" }
      return ok()
    }
    if (argv[0] === "schtasks.exe" && argv[1] === "/End") {
      if (task) task.state = "Ready"
      return task ? ok() : fail(1, "ERROR: The system cannot find the file specified.")
    }
    if (argv[0] === "schtasks.exe" && argv[1] === "/Delete") {
      task = null
      return ok()
    }
    if (argv[0] === "taskkill.exe") return ok()
    throw new Error(`unexpected ${argv.join(" ")}`)
  }
  const program = join(home, "rudder.exe")
  writeFileSync(program, "MZ")
  const ctx: TaskContext = {
    taskName: "Rudder",
    userSid: SID,
    home,
    program: { kind: "binary", path: program },
    env: { RUDDER_PORT: "17793", GITHUB_TOKEN: "secret" },
    daemon: { host: "0.0.0.0", port: 17793, tls: true },
    defaultDataDir: dataDir,
    path: posix,
    run,
    sleep: async () => {},
    probe: async () => (probes.length > 1 ? probes.shift()! : probes[0]!),
    daemonPid: () => 4242,
    protect: (dir) => protectedDirs.push(dir),
    protectFile: (file) => protectedDirs.push(file),
    log: (line) => lines.push(line),
  }
  const verbs = () => calls.map((argv) => (argv[0] === "powershell.exe" ? "query" : `${argv[0]} ${argv[1]}`))
  return { ctx, calls, lines, dataDir, verbs, protectedDirs }
}

describe("install", () => {
  test("writes the launcher into an owner-only RUDDER_HOME, registers from XML, runs it and waits for /health", async () => {
    const h = harness({ probe: [false, false, true] })
    await installTask(h.ctx)
    expect(h.verbs()).toEqual(["query", "schtasks.exe /Create", "schtasks.exe /Run"])
    // logs\ is protected on its own too: a logs folder left from before may carry explicit ACEs inheritance does not replace.
    expect(h.protectedDirs).toEqual([h.dataDir, join(h.dataDir, "logs")])
    const launcher = readFileSync(join(h.dataDir, "rudder-task.cmd"), "utf8")
    expect(launcher).toContain('set "RUDDER_PORT=17793"')
    expect(launcher).not.toContain("GITHUB_TOKEN")
    expect(existsSync(join(h.dataDir, "rudder-task.xml"))).toBe(false)
    expect(h.lines.join("\n")).toContain("serving   https://127.0.0.1:17793")
  })

  test("logs already in logs\\ are made owner-only one by one", async () => {
    const h = harness({ probe: [false, false, true] })
    mkdirSync(join(h.dataDir, "logs", "old"), { recursive: true })
    writeFileSync(join(h.dataDir, "logs", "rudder.out.log"), "before\n")
    await installTask(h.ctx)
    expect(h.protectedDirs).toEqual([h.dataDir, join(h.dataDir, "logs"), join(h.dataDir, "logs", "rudder.out.log")])
  })

  test("a running task is ended first and its settings are kept", async () => {
    const h = harness({ existing: true, probe: [true, false, false, true] })
    mkdirSync(h.dataDir, { recursive: true })
    writeFileSync(
      join(h.dataDir, "rudder-task.cmd"),
      renderLauncher({ programArguments: ["x"], environment: { RUDDER_PUSH_GATEWAY: "off", RUDDER_PORT: "17793" }, stdout: "o", stderr: "e" }),
    )
    await installTask(h.ctx)
    expect(h.verbs()).toEqual(["query", "schtasks.exe /End", "taskkill.exe /PID", "schtasks.exe /Create", "schtasks.exe /Run"])
    expect(h.calls.find((argv) => argv[0] === "taskkill.exe")).toEqual(["taskkill.exe", "/PID", "4242", "/T", "/F"])
    expect(readFileSync(join(h.dataDir, "rudder-task.cmd"), "utf8")).toContain('set "RUDDER_PUSH_GATEWAY=off"')
    expect(h.lines[0]).toContain("keeping RUDDER_PUSH_GATEWAY")
  })

  test("a port that already answers stops the install before anything is written", async () => {
    const h = harness({ probe: [true] })
    await expect(installTask(h.ctx)).rejects.toThrow("already answers")
    expect(existsSync(join(h.dataDir, "rudder-task.cmd"))).toBe(false)
  })

  test("a daemon that never answers is rolled back with its stderr", async () => {
    const h = harness({ probe: [false] })
    mkdirSync(join(h.dataDir, "logs"), { recursive: true })
    writeFileSync(join(h.dataDir, "logs", "rudder.err.log"), "error: EADDRINUSE\n")
    await expect(installTask(h.ctx)).rejects.toThrow(/did not answer.*rolled back, nothing is installed\nlast lines of .*\nerror: EADDRINUSE/s)
    expect(h.verbs().slice(-2)).toEqual(["schtasks.exe /End", "schtasks.exe /Delete"])
    expect(existsSync(join(h.dataDir, "rudder-task.cmd"))).toBe(false)
  })

  test("a failed /Create names schtasks and its message", async () => {
    const h = harness({ create: fail(1, "ERROR: Access is denied.") })
    await expect(installTask(h.ctx)).rejects.toThrow("schtasks.exe /Create failed (exit 1): ERROR: Access is denied.")
  })
})

describe("uninstall and status", () => {
  test("status reports the running task with the pid from the channel file", async () => {
    const h = harness({ existing: true, probe: [true] })
    expect(await taskStatus(h.ctx)).toBe(0)
    expect(h.lines[0]).toBe("Rudder task: running")
    expect(h.lines.join("\n")).toContain("pid       4242")
  })

  test("status without a task is 1", async () => {
    const h = harness()
    expect(await taskStatus(h.ctx)).toBe(1)
    expect(h.lines[0]).toBe("Rudder task: not installed")
  })

  test("uninstall ends and deletes the task, keeps the data dir", async () => {
    const h = harness({ existing: true, probe: [true, false] })
    mkdirSync(h.dataDir, { recursive: true })
    writeFileSync(join(h.dataDir, "rudder.sqlite"), "")
    writeFileSync(join(h.dataDir, "rudder-task.cmd"), "@echo off\r\n")
    await uninstallTask(h.ctx, false)
    expect(h.verbs()).toEqual(["query", "schtasks.exe /End", "taskkill.exe /PID", "schtasks.exe /Delete"])
    expect(existsSync(join(h.dataDir, "rudder.sqlite"))).toBe(true)
    expect(existsSync(join(h.dataDir, "rudder-task.cmd"))).toBe(false)
  })

  test("--purge deletes a Rudder data dir but refuses the home folder", async () => {
    const h = harness({ probe: [false] })
    mkdirSync(h.dataDir, { recursive: true })
    writeFileSync(join(h.dataDir, "rudder.sqlite"), "")
    await uninstallTask(h.ctx, true)
    expect(existsSync(h.dataDir)).toBe(false)
    const other = harness({ probe: [false] })
    writeFileSync(join(other.ctx.home, "rudder.sqlite"), "")
    await expect(uninstallTask({ ...other.ctx, env: { RUDDER_HOME: other.ctx.home } }, true)).rejects.toThrow("refusing to delete")
  })
})
