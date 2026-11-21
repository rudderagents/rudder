import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import {
  captureLoginPath,
  install,
  launchArguments,
  loginLaunchArguments,
  parseLaunchctlPrint,
  parseLoginPath,
  parseServiceArgs,
  privacyFolder,
  renderPlist,
  rudderEnvironment,
  status,
  uninstall,
  type AgentSpec,
  type RunResult,
  type Runner,
  type ServiceContext,
  programFor,
} from "./launchd"

const ok = (stdout = ""): RunResult => ({ exitCode: 0, stdout, stderr: "", timedOut: false })
const fail = (exitCode: number, stderr: string): RunResult => ({ exitCode, stdout: "", stderr, timedOut: false })
const NOT_LOADED = fail(113, 'Bad request.\nCould not find service "com.example.rudderd.test" in domain for user gui: 501')
const running = (pid: number) =>
  ok(`gui/501/com.example.rudderd.test = {\n\tstate = running\n\tpid = ${pid}\n\truns = 1\n\tlast exit code = (never exited)\n}\n`)
const LOGIN_PATH = "/Users/me/.local/bin:/opt/homebrew/bin:/usr/bin:/bin"

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

/** A context whose shell, plutil and launchctl are scripted; launchctl keeps one job's loaded state, `probe` repeats its last answer. */
function harness(script: { loaded?: RunResult; startsAs?: RunResult; bootstrap?: RunResult; probe?: boolean[]; plist?: object; loginPath?: string } = {}) {
  const home = mkdtempSync(join(tmpdir(), "rudder-launchd-"))
  homes.push(home)
  const calls: string[][] = []
  const lines: string[] = []
  const probes = [...(script.probe ?? [false])]
  const loginPath = script.loginPath ?? LOGIN_PATH
  let loaded = script.loaded ?? null
  const run: Runner = (argv) => {
    calls.push(argv)
    if (argv[0] === "/bin/zsh") return ok(`Last login: today\n__RUDDER_PATH_START__${loginPath}__RUDDER_PATH_END__`)
    if (argv[0] === "/usr/bin/plutil" && argv[1] === "-lint") return ok(`${argv[2]}: OK`)
    if (argv[0] === "/usr/bin/plutil" && argv[1] === "-convert") return ok(JSON.stringify(h.plistJson))
    if (argv[0] !== "/bin/launchctl") throw new Error(`unexpected command ${argv.join(" ")}`)
    if (argv[1] === "print") return loaded ?? NOT_LOADED
    if (argv[1] === "bootout") {
      loaded = null
      return ok()
    }
    if (argv[1] === "bootstrap") {
      if (script.bootstrap) return script.bootstrap
      loaded = script.startsAs ?? running(4242)
      return ok()
    }
    throw new Error(`unexpected command ${argv.join(" ")}`)
  }
  const ctx: ServiceContext = {
    label: "com.example.rudderd.test",
    uid: 501,
    home,
    shell: "/bin/zsh",
    program: { kind: "source", bun: "/opt/homebrew/Cellar/bun/1.4.3/bin/bun", main: join(import.meta.dir, "main.ts") },
    workingDirectory: dirname(import.meta.dir),
    env: { RUDDER_PORT: "17791", RUDDER_ADAPTER: "fake", RUDDER_LAUNCHD_LABEL: "com.example.rudderd.test", GITHUB_TOKEN: "secret" },
    daemon: { host: "127.0.0.1", port: 17791, tls: false },
    defaultDataDir: join(home, "Library", "Application Support", "Rudder"),
    run,
    sleep: async () => {},
    probe: async () => (probes.length > 1 ? probes.shift()! : probes[0]),
    which: (command, path) => (command === "bun" && path === loginPath ? "/opt/homebrew/bin/bun" : null),
    log: (line) => lines.push(line),
  }
  const plist = join(home, "Library", "LaunchAgents", "com.example.rudderd.test.plist")
  const logs = join(home, "Library", "Logs", "Rudder")
  const verbs = () => calls.map((argv) => (argv[0] === "/bin/zsh" ? "shell" : `${basename(argv[0])} ${argv[1]}`))
  const h = { ctx, calls, lines, home, plist, logs, verbs, plistJson: script.plist ?? {} }
  return h
}

describe("plist", () => {
  const spec: AgentSpec = {
    label: "com.example.rudderd.test",
    programArguments: ["/opt/homebrew/bin/bun", "/Users/me/R&D <x>/rudder/daemon/src/main.ts"],
    workingDirectory: `/Users/me/it's "here"`,
    environment: { RUDDER_PUSH_GATEWAY: "https://push.example?a=1&b=2", PATH: "/a:/b" },
    stdoutPath: "/Users/me/Library/Logs/Rudder/out.log",
    stderrPath: "/Users/me/Library/Logs/Rudder/err.log",
  }

  test("escapes XML special characters in paths and env values", () => {
    const xml = renderPlist(spec)
    expect(xml).toContain("<string>/Users/me/R&amp;D &lt;x&gt;/rudder/daemon/src/main.ts</string>")
    expect(xml).toContain("<string>/Users/me/it&apos;s &quot;here&quot;</string>")
    expect(xml).toContain("<string>https://push.example?a=1&amp;b=2</string>")
    expect(xml).not.toContain("R&D")
    // Env keys are sorted, so a reinstall with the same inputs writes the same file.
    expect(xml.indexOf("<key>PATH</key>")).toBeLessThan(xml.indexOf("<key>RUDDER_PUSH_GATEWAY</key>"))
  })

  test("restarts on a crash but not on a clean exit, and runs at load", () => {
    const xml = renderPlist(spec)
    expect(xml).toContain("<key>RunAtLoad</key>\n\t<true/>")
    expect(xml).toContain("<key>KeepAlive</key>\n\t<dict>\n\t\t<key>SuccessfulExit</key>\n\t\t<false/>\n\t</dict>")
  })

  test("refuses control characters XML cannot carry", () => {
    expect(() => renderPlist({ ...spec, environment: { PATH: "/a\u0001" } })).toThrow("control character")
  })

  test.skipIf(process.platform !== "darwin")("plutil reads back exactly what was rendered", () => {
    const dir = mkdtempSync(join(tmpdir(), "rudder-plist-"))
    homes.push(dir)
    const file = join(dir, "agent.plist")
    writeFileSync(file, renderPlist(spec))
    const result = Bun.spawnSync(["/usr/bin/plutil", "-convert", "json", "-o", "-", file])
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout.toString())).toEqual({
      Label: spec.label,
      ProgramArguments: spec.programArguments,
      WorkingDirectory: spec.workingDirectory,
      EnvironmentVariables: spec.environment,
      RunAtLoad: true,
      KeepAlive: { SuccessfulExit: false },
      ThrottleInterval: 10,
      StandardOutPath: spec.stdoutPath,
      StandardErrorPath: spec.stderrPath,
    })
  })

  test("only RUDDER_* settings pass through, never the label override or other variables", () => {
    const env = { RUDDER_PORT: "1", RUDDER_HOST: "0.0.0.0", RUDDER_LAUNCHD_LABEL: "x", GITHUB_TOKEN: "s", HOME: "/h", RUDDER_TLS: undefined }
    expect(rudderEnvironment(env)).toEqual({ RUDDER_HOST: "0.0.0.0", RUDDER_PORT: "1" })
    expect(Object.keys(rudderEnvironment(env))).toEqual(["RUDDER_HOST", "RUDDER_PORT"])
  })
})

describe("login shell PATH", () => {
  const shellReturning = (result: RunResult) => {
    const seen: string[][] = []
    const envs: (Record<string, string> | undefined)[] = []
    const run: Runner = (argv, options) => {
      seen.push([...argv, `timeout=${options?.timeoutMs}`])
      envs.push(options?.env)
      return result
    }
    return { run, seen, envs }
  }

  test("reads the PATH between the markers despite rc-file chatter and an echoed command line", () => {
    const echoed = `printf '%s%s%s' __RUDDER_PATH_START__ "$PATH" __RUDDER_PATH_END__`
    expect(parseLoginPath(`welcome\n${echoed}\n__RUDDER_PATH_START__/a:/b__RUDDER_PATH_END__\nbye`)).toBe("/a:/b")
    expect(parseLoginPath("no markers")).toBeNull()
    expect(parseLoginPath("__RUDDER_PATH_START__/a")).toBeNull()
  })

  test("asks the user's shell as a fresh login, interactive shell with a timeout", () => {
    const { run, seen, envs } = shellReturning(ok(`__RUDDER_PATH_START__${LOGIN_PATH}__RUDDER_PATH_END__`))
    const parent = {
      HOME: "/Users/me",
      USER: "me",
      PATH: "/repo/daemon/node_modules/.bin:/Applications/iTerm.app/Contents/Resources/utilities:/usr/bin",
      GITHUB_TOKEN: "secret",
    }
    expect(captureLoginPath(run, "/opt/homebrew/bin/fish", parent)).toBe(LOGIN_PATH)
    expect(seen[0].slice(0, 2)).toEqual(["/opt/homebrew/bin/fish", "-lic"])
    expect(seen[0][2]).toContain('"$PATH"')
    expect(seen[0][3]).toBe("timeout=10000")
    // Starts from launchd's PATH, so bun run's node_modules/.bin and the terminal's additions never reach the plist.
    expect(envs[0]).toEqual({ HOME: "/Users/me", USER: "me", SHELL: "/opt/homebrew/bin/fish", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" })
  })

  test("a shell that hangs or prints nothing is an error naming the shell, not a silent default PATH", () => {
    const hung = shellReturning({ exitCode: null, stdout: "", stderr: "", timedOut: true })
    expect(() => captureLoginPath(hung.run, "/bin/zsh", {})).toThrow("/bin/zsh -lic, timed out after 10s")
    const broken = shellReturning(fail(1, "zsh: command not found: compinit"))
    expect(() => captureLoginPath(broken.run, "/bin/zsh", {})).toThrow("exit 1): zsh: command not found: compinit")
    const empty = shellReturning(ok("__RUDDER_PATH_START____RUDDER_PATH_END__"))
    expect(() => captureLoginPath(empty.run, "/bin/zsh", {})).toThrow("unusable PATH")
  })
})

describe("arguments", () => {
  test("commands and their flags", () => {
    expect(parseServiceArgs(["install"])).toEqual({ kind: "install" })
    expect(parseServiceArgs(["uninstall"])).toEqual({ kind: "uninstall", purge: false })
    expect(parseServiceArgs(["uninstall", "--purge"])).toEqual({ kind: "uninstall", purge: true })
    expect(parseServiceArgs(["status"])).toEqual({ kind: "status" })
  })

  test("unknown commands and flags are refused", () => {
    expect(() => parseServiceArgs(["start"])).toThrow("unknown command: start")
    expect(() => parseServiceArgs(["install", "--purge"])).toThrow("unknown option for install: --purge")
    expect(() => parseServiceArgs(["uninstall", "--force"])).toThrow("unknown option for uninstall: --force")
  })
})

describe("launchctl print", () => {
  test("reads the top-level fields, not the nested coalition blocks", () => {
    const text = [
      "gui/501/com.zysuccess.rudderd = {",
      "\tactive count = 1",
      "\tstate = running",
      "\tresource coalition = {",
      "\t\tstate = active",
      "\t}",
      "\truns = 3",
      "\tpid = 50205",
      "\tlast exit code = 0",
      "\tlast terminating signal = Killed: 9",
      "}",
    ].join("\n")
    expect(parseLaunchctlPrint(text)).toEqual({ state: "running", pid: 50205, lastExit: "0", lastSignal: "Killed: 9", runs: 3 })
    expect(parseLaunchctlPrint("gui/501/x = {\n\tstate = not running\n\tlast exit code = (never exited)\n}")).toMatchObject({
      state: "not running",
      pid: null,
      lastExit: "(never exited)",
    })
  })
})

describe("install", () => {
  test("writes the plist, bootstraps it and waits for /health", async () => {
    const h = harness({ probe: [false, true] })
    await install(h.ctx)
    expect(h.verbs()).toEqual(["shell", "launchctl print", "plutil -lint", "launchctl bootstrap", "launchctl print"])
    expect(h.calls[3]).toEqual(["/bin/launchctl", "bootstrap", "gui/501", h.plist])
    const xml = readFileSync(h.plist, "utf8")
    expect(statSync(h.plist).mode & 0o777).toBe(0o644)
    // The login PATH's bun, not the versioned Cellar path this process happens to run from.
    expect(xml).toContain(`<string>/opt/homebrew/bin/bun</string>\n\t\t<string>${join(import.meta.dir, "main.ts")}</string>`)
    expect(xml).toContain(`<key>PATH</key>\n\t\t<string>${LOGIN_PATH}</string>`)
    expect(xml).toContain("<key>RUDDER_ADAPTER</key>")
    expect(xml).not.toContain("RUDDER_LAUNCHD_LABEL")
    expect(xml).not.toContain("GITHUB_TOKEN")
    expect(xml).toContain(join(h.logs, "com.example.rudderd.test.err.log"))
    expect(existsSync(h.logs)).toBe(true)
    const out = h.lines.join("\n")
    expect(out).toContain("installed com.example.rudderd.test: pid 4242")
    expect(out).toContain("pair a phone: bun run src/main.ts pair")
    expect(out).toContain("env       RUDDER_ADAPTER, RUDDER_PORT")
  })

  test("the compiled rudder runs itself, through the PATH link that survives brew upgrade", async () => {
    const h = harness({ probe: [false, true] })
    const cellar = join(h.home, "Cellar", "rudder", "0.1.0", "bin", "rudder")
    const linked = join(h.home, "bin", "rudder")
    mkdirSync(dirname(cellar), { recursive: true })
    mkdirSync(dirname(linked), { recursive: true })
    writeFileSync(cellar, "")
    symlinkSync(cellar, linked)
    h.ctx.program = { kind: "binary", path: cellar }
    h.ctx.which = (command, path) => (command === "rudder" && path === LOGIN_PATH ? linked : null)
    await install(h.ctx)
    const xml = readFileSync(h.plist, "utf8")
    expect(xml).toContain(`<string>rudder-service</string>\n\t\t<string>${linked}</string>\n\t</array>`)
    expect(xml).not.toContain("main.ts")
    expect(h.lines.join("\n")).toContain("pair a phone: rudder pair")
  })

  /** A fake Homebrew prefix under a temp root: Cellar keg + bin/rudder symlink, like /opt/homebrew or /usr/local. */
  function brewPrefix(root: string, kind: "opt/homebrew" | "usr/local", version: string) {
    const cellar = join(root, kind, "Cellar", "rudder", version, "bin", "rudder")
    const linked = join(root, kind, "bin", "rudder")
    mkdirSync(dirname(cellar), { recursive: true })
    mkdirSync(dirname(linked), { recursive: true })
    writeFileSync(cellar, "")
    try {
      rmSync(linked)
    } catch {}
    symlinkSync(cellar, linked)
    return { cellar, linked, binDir: dirname(linked), path: `${dirname(linked)}:/usr/bin:/bin` }
  }

  test("Apple Silicon Homebrew puts /opt/homebrew/bin/rudder in the plist, not the versioned Cellar path", async () => {
    const h = harness({ probe: [false, true] })
    const brew = brewPrefix(h.home, "opt/homebrew", "1.0.0")
    h.ctx.program = { kind: "binary", path: brew.cellar }
    h.ctx.which = (command, path) => (command === "rudder" && path === LOGIN_PATH ? brew.linked : null)
    await install(h.ctx)
    const xml = readFileSync(h.plist, "utf8")
    expect(xml).toContain(`<string>${brew.linked}</string>`)
    expect(xml).toContain(`<key>PATH</key>\n\t\t<string>${LOGIN_PATH}</string>`)
    expect(xml).not.toContain(brew.cellar)
  })

  test("Intel Homebrew puts /usr/local/bin/rudder in the plist, not the versioned Cellar path", async () => {
    const loginPath = "/usr/local/bin:/usr/bin:/bin"
    const h = harness({ probe: [false, true], loginPath })
    const brew = brewPrefix(h.home, "usr/local", "1.0.0")
    h.ctx.program = { kind: "binary", path: brew.cellar }
    h.ctx.which = (command, path) => (command === "rudder" && path === loginPath ? brew.linked : null)
    await install(h.ctx)
    const xml = readFileSync(h.plist, "utf8")
    expect(xml).toContain(`<string>${brew.linked}</string>`)
    expect(xml).toContain(`<key>PATH</key>\n\t\t<string>${loginPath}</string>`)
    expect(xml).not.toContain(brew.cellar)
  })

  test("a brew upgrade retargets the bin symlink; reinstall keeps that path and restarts into the new keg", async () => {
    const h = harness({ loaded: running(7), startsAs: running(8), probe: [false, true] })
    const old = brewPrefix(h.home, "opt/homebrew", "0.1.0")
    const next = brewPrefix(h.home, "opt/homebrew", "1.0.0")
    // Same bin/rudder link now points at the new keg, as `brew upgrade` does.
    rmSync(old.linked)
    symlinkSync(next.cellar, old.linked)
    h.ctx.program = { kind: "binary", path: next.cellar }
    h.ctx.which = (command, path) => (command === "rudder" && path === LOGIN_PATH ? old.linked : null)
    await install(h.ctx)
    const xml = readFileSync(h.plist, "utf8")
    expect(xml).toContain(`<string>${old.linked}</string>`)
    expect(xml).not.toContain("0.1.0")
    expect(xml).not.toContain(next.cellar)
    expect(h.verbs()).toContain("launchctl bootout")
    expect(h.verbs()).toContain("launchctl bootstrap")
    expect(h.lines[0]).toContain("is loaded (pid 7); stopping it to reinstall")
    expect(h.lines.join("\n")).toContain("installed com.example.rudderd.test: pid 8")
  })

  test("uninstall of a brew-style install removes the plist and leaves the prefix binary alone", async () => {
    const h = harness({ loaded: running(5) })
    const brew = brewPrefix(h.home, "opt/homebrew", "1.0.0")
    mkdirSync(dirname(h.plist), { recursive: true })
    writeFileSync(h.plist, `<plist><dict><key>ProgramArguments</key><array><string>${brew.linked}</string></array></dict></plist>`)
    await uninstall(h.ctx, false)
    expect(existsSync(h.plist)).toBe(false)
    expect(existsSync(brew.linked)).toBe(true)
    expect(existsSync(brew.cellar)).toBe(true)
    expect(h.calls).toContainEqual(["/bin/launchctl", "bootout", "gui/501/com.example.rudderd.test"])
  })

  test("a rudder on the PATH that is another file does not replace the running binary", () => {
    const dir = mkdtempSync(join(tmpdir(), "rudder-bin-"))
    homes.push(dir)
    const mine = join(dir, "mine")
    const other = join(dir, "other")
    writeFileSync(mine, "")
    writeFileSync(other, "")
    const binary = { kind: "binary", path: mine } as const
    expect(launchArguments(binary, () => other, LOGIN_PATH)).toEqual([mine])
    expect(launchArguments(binary, () => null, LOGIN_PATH)).toEqual([mine])
    expect(launchArguments({ kind: "source", bun: "/b/bun", main: "/r/main.ts" }, () => null, LOGIN_PATH)).toEqual(["/b/bun", "/r/main.ts"])
  })

  test("a loaded job is booted out, and gone, before the new one is bootstrapped", async () => {
    const h = harness({ loaded: running(7), startsAs: running(8), probe: [false, true] })
    await install(h.ctx)
    expect(h.verbs()).toEqual([
      "shell",
      "launchctl print",
      "launchctl bootout",
      "launchctl print",
      "plutil -lint",
      "launchctl bootstrap",
      "launchctl print",
    ])
    expect(h.lines[0]).toBe("com.example.rudderd.test is loaded (pid 7); stopping it to reinstall")
    expect(h.lines[1]).toBe("installed com.example.rudderd.test: pid 8, starts at login, restarts after a crash (a clean exit stays down)")
  })

  test("TLS changes the probe to https", async () => {
    const h = harness({ probe: [false, true] })
    const probed: string[] = []
    h.ctx.daemon = { host: "0.0.0.0", port: 7749, tls: true }
    const probe = h.ctx.probe
    h.ctx.probe = (url) => {
      probed.push(url)
      return probe(url)
    }
    await install(h.ctx)
    expect(probed).toEqual(["https://127.0.0.1:7749/health", "https://127.0.0.1:7749/health"])
  })

  test("a failed bootstrap names the call, its exit code and stderr, and leaves no plist", async () => {
    const h = harness({ bootstrap: fail(5, "Bootstrap failed: 5: Input/output error") })
    const error = (await install(h.ctx).catch((e: Error) => e)) as Error
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain(`/bin/launchctl bootstrap gui/501 ${h.plist} failed (exit 5): Bootstrap failed: 5: Input/output error`)
    expect(error.message).toContain("rolled back, nothing is installed")
    expect(existsSync(h.plist)).toBe(false)
  })

  test("a port that already answers stops the install before anything is written", async () => {
    const h = harness({ probe: [true] })
    await expect(install(h.ctx)).rejects.toThrow("http://127.0.0.1:17791 already answers")
    expect(h.verbs()).not.toContain("launchctl bootstrap")
    expect(existsSync(h.plist)).toBe(false)
  })

  test("a daemon that never answers is booted out again, with its stderr in the error", async () => {
    const h = harness({ startsAs: running(9), probe: [false] })
    mkdirSync(h.logs, { recursive: true })
    writeFileSync(join(h.logs, "com.example.rudderd.test.err.log"), "error: Failed to start server. Is port 17791 in use?\n")
    const error = (await install(h.ctx).catch((e: Error) => e)) as Error
    expect(error.message).toContain("did not answer on http://127.0.0.1:17791/health within 20s (launchd: state running")
    expect(error.message).toContain("rolled back, nothing is installed")
    expect(error.message).toContain("Is port 17791 in use?")
    expect(h.verbs().slice(-3)).toEqual(["launchctl print", "launchctl bootout", "launchctl print"])
    expect(existsSync(h.plist)).toBe(false)
  })

  test("a checkout in ~/Documents warns about the privacy prompt and waits longer for it", async () => {
    expect(privacyFolder("/Users/me", "/Users/me/Documents/Project/rudder/daemon/src/main.ts")).toBe("/Users/me/Documents")
    expect(privacyFolder("/Users/me", "/Users/me/DocumentsOld/main.ts")).toBeNull()
    expect(privacyFolder("/Users/me", "/Users/me/src/rudder/daemon/src/main.ts")).toBeNull()
    const h = harness({ startsAs: running(3), probe: [false] })
    const main = join(h.home, "Documents", "rudder", "daemon", "src", "main.ts")
    h.ctx.program = { kind: "source", bun: "/opt/homebrew/bin/bun", main }
    mkdirSync(dirname(main), { recursive: true })
    writeFileSync(main, "")
    const error = (await install(h.ctx).catch((e: Error) => e)) as Error
    expect(h.lines[0]).toBe(`this checkout is in ${join(h.home, "Documents")}: macOS asks once whether "bun" may access it. Click Allow (waiting up to 120s)`)
    expect(error.message).toContain("within 120s")
    expect(error.message).toContain("System Settings → Privacy & Security → Files and Folders")
    expect(existsSync(h.plist)).toBe(false)
  })

  test("a reinstall keeps the RUDDER_* settings this shell does not set", async () => {
    const previous = { RUDDER_HOST: "0.0.0.0", RUDDER_PUSH_GATEWAY: "https://gw.example", RUDDER_ADAPTER: "real", PATH: "/old/bin" }
    const h = harness({ probe: [false, true], plist: { EnvironmentVariables: previous } })
    mkdirSync(dirname(h.plist), { recursive: true })
    writeFileSync(h.plist, "")
    await install(h.ctx)
    const xml = readFileSync(h.plist, "utf8")
    expect(xml).toContain("<key>RUDDER_HOST</key>\n\t\t<string>0.0.0.0</string>")
    expect(xml).toContain("<key>RUDDER_PUSH_GATEWAY</key>\n\t\t<string>https://gw.example</string>")
    // This shell's value wins; PATH is captured fresh.
    expect(xml).toContain("<key>RUDDER_ADAPTER</key>\n\t\t<string>fake</string>")
    expect(xml).not.toContain("/old/bin")
    expect(h.lines.join("\n")).toContain("keeping RUDDER_HOST, RUDDER_PUSH_GATEWAY from the previous install")
  })

  test("a kept RUDDER_PORT is where install looks for the daemon", async () => {
    const h = harness({ plist: { EnvironmentVariables: { RUDDER_PORT: "17800" } } })
    mkdirSync(dirname(h.plist), { recursive: true })
    writeFileSync(h.plist, "")
    h.ctx.env = { ...h.ctx.env, RUDDER_PORT: undefined }
    const probed: string[] = []
    const answers = [false, true]
    h.ctx.probe = async (url) => {
      probed.push(url)
      return answers.length > 1 ? answers.shift()! : answers[0]
    }
    await install(h.ctx)
    expect(probed.every((url) => url === "http://127.0.0.1:17800/health")).toBe(true)
    expect(readFileSync(h.plist, "utf8")).toContain("<key>RUDDER_PORT</key>\n\t\t<string>17800</string>")
  })

  test("a random port cannot be installed", async () => {
    const h = harness()
    h.ctx.daemon = { ...h.ctx.daemon, port: 0 }
    await expect(install(h.ctx)).rejects.toThrow("RUDDER_PORT must be a fixed port")
    expect(h.calls).toHaveLength(0)
  })
})

describe("uninstall and status", () => {
  function installedPlist(h: ReturnType<typeof harness>) {
    mkdirSync(dirname(h.plist), { recursive: true })
    writeFileSync(h.plist, "<plist/>")
  }

  test("--purge removes the job, the plist, the data dir the plist named and the logs", async () => {
    const data = mkdtempSync(join(tmpdir(), "rudder-data-"))
    homes.push(data)
    writeFileSync(join(data, "rudder.sqlite"), "")
    const h = harness({ loaded: running(5), plist: { EnvironmentVariables: { RUDDER_HOME: data, PATH: "/bin" } } })
    installedPlist(h)
    mkdirSync(h.logs, { recursive: true })
    writeFileSync(join(h.logs, "com.example.rudderd.test.out.log"), "pair: rudder://pair?host=127.0.0.1:17791")
    await uninstall(h.ctx, true)
    expect(h.calls).toContainEqual(["/bin/launchctl", "bootout", "gui/501/com.example.rudderd.test"])
    expect(existsSync(h.plist)).toBe(false)
    expect(existsSync(data)).toBe(false)
    expect(existsSync(h.logs)).toBe(false)
    expect(h.lines).toContain(`deleting ${data}: database, TLS key and pairing; paired phones must pair again`)
  })

  test("--purge refuses a folder that holds no Rudder files, before changing anything", async () => {
    const h = harness({ loaded: running(5) })
    h.plistJson = { EnvironmentVariables: { RUDDER_HOME: h.home } }
    installedPlist(h)
    await expect(uninstall(h.ctx, true)).rejects.toThrow(`refusing to delete ${h.home}`)
    expect(h.verbs()).not.toContain("launchctl bootout")
    expect(existsSync(h.plist)).toBe(true)
  })

  test("without --purge the data stays", async () => {
    const h = harness()
    installedPlist(h)
    mkdirSync(h.ctx.defaultDataDir, { recursive: true })
    await uninstall(h.ctx, false)
    expect(existsSync(h.plist)).toBe(false)
    expect(existsSync(h.ctx.defaultDataDir)).toBe(true)
    expect(h.lines.at(-1)).toContain("uninstall --purge deletes them")
  })

  test("status shows pid, last exit and the plist's PATH, and exits 0 only while running", () => {
    const h = harness({
      loaded: ok("x = {\n\tstate = running\n\tpid = 77\n\truns = 2\n\tlast exit code = (never exited)\n\tlast terminating signal = Killed: 9\n}"),
      plist: { ProgramArguments: ["/opt/homebrew/bin/bun", "/r/main.ts"], EnvironmentVariables: { RUDDER_PORT: "17791", PATH: LOGIN_PATH, RUDDER_ADAPTER: "fake" } },
    })
    installedPlist(h)
    expect(status(h.ctx)).toBe(0)
    const out = h.lines.join("\n")
    expect(out).toContain("com.example.rudderd.test: running")
    expect(out).toContain("pid       77")
    expect(out).toContain("last exit (never exited) (signal: Killed: 9)")
    expect(out).toContain(`PATH      ${LOGIN_PATH}`)
    expect(out).toContain("env       RUDDER_ADAPTER, RUDDER_PORT")
    const missing = harness()
    expect(status(missing.ctx)).toBe(1)
    expect(missing.lines[0]).toBe("com.example.rudderd.test: not installed")
  })

  test("any other launchctl failure is reported with its exit code", () => {
    const h = harness({ loaded: fail(125, "Domain does not support specified action") })
    expect(() => status(h.ctx)).toThrow("/bin/launchctl print gui/501/com.example.rudderd.test failed (exit 125): Domain does not support specified action")
  })
})

describe("programFor", () => {
  test("a compiled rudder is the binary on every platform, a checkout runs main.ts", () => {
    expect(programFor("/$bunfs/root", "/opt/homebrew/bin/rudder")).toEqual({ kind: "binary", path: "/opt/homebrew/bin/rudder" })
    expect(programFor("B:\\~BUN\\root", "C:\\Users\\tester\\rudder-bin\\rudder.exe")).toEqual({
      kind: "binary",
      path: "C:\\Users\\tester\\rudder-bin\\rudder.exe",
    })
    expect(programFor("/Users/x/rudder/daemon/src", "/Users/x/.bun/bin/bun")).toMatchObject({ kind: "source", bun: "/Users/x/.bun/bin/bun" })
  })
})



describe("login service launch", () => {
  test("keeps executable arguments literal", () => {
    expect(loginLaunchArguments("/bin/zsh", ["/a path/bun", "/repo/main.ts", "$(literal)"]))
      .toEqual(["/bin/zsh", "-lic", 'exec "$@"', "rudder-service", "/a path/bun", "/repo/main.ts", "$(literal)"])
  })

  test("loads runtime exports without embedding them in the installed plist", async () => {
    const h = harness({ probe: [false, true] })
    h.ctx.env = { ...h.ctx.env, CODEX_HOME: "/fixture/private-codex", HTTPS_PROXY: "http://fixture-secret-value" }
    await install(h.ctx)
    const xml = readFileSync(h.plist, "utf8")
    expect(xml).toContain("<string>-lic</string>")
    expect(xml).toContain("rudder-service")
    expect(xml).not.toContain("fixture-secret-value")
    expect(xml).not.toContain("private-codex")
    const shellHome = mkdtempSync(join(tmpdir(), "rudder-login-env-"))
    homes.push(shellHome)
    writeFileSync(join(shellHome, ".zshrc"), 'export CODEX_HOME="/fixture/codex-root"\nexport CLAUDE_CONFIG_DIR="/fixture/claude-root"\nexport HTTPS_PROXY="http://fixture-proxy"\n')
    const probe = 'process.stdout.write(JSON.stringify([process.env.CODEX_HOME, process.env.CLAUDE_CONFIG_DIR, process.env.HTTPS_PROXY, process.argv.at(-1)]))'
    const child = Bun.spawnSync(loginLaunchArguments("/bin/zsh", [process.execPath, "-e", probe, "$(literal)"]), {
      env: { HOME: shellHome, ZDOTDIR: shellHome, PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe",
    })
    expect(child.exitCode).toBe(0)
    expect(JSON.parse(child.stdout.toString())).toEqual(["/fixture/codex-root", "/fixture/claude-root", "http://fixture-proxy", "$(literal)"])
  })
})

test("fish login launch forwards literal arguments using its own argv array", () => {
  expect(loginLaunchArguments("/opt/homebrew/bin/fish", ["/a path/bun", "$(literal)"])).toEqual(["/opt/homebrew/bin/fish", "-lic", "exec $argv", "/a path/bun", "$(literal)"])
})
