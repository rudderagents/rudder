// Run on a real Windows 10/11 machine from a source checkout: `cd daemon && bun run scripts/windows-smoke.ts`.
// Exercises the Windows branches that the macOS unit tests only cover with recorded output (the Windows notes
// §10): .cmd quoting through cmd.exe, taskkill of a process tree, the owner-only ACL, the token channel, the perf
// worker and identity, the built-in TLS certificate, the path checks, and which agents PATH resolves. Changes nothing
// outside a temp folder; prints PASS / FAIL per check and exits 1 if any failed.
import { X509Certificate } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { createPerfSampler } from "../src/perf"
import { killTree, planSpawn, resolveWindowsCommand } from "../src/platform/spawn"
import { readChannelFile, startTokenChannel, tokenRequest } from "../src/platform/token-channel"
import { checkOwnerOnly, currentUserSid, readAcl, restrictToUser } from "../src/platform/win32-acl"
import { ensureTlsMaterial } from "../src/tls"
import { resolveSafe } from "../src/workspace"

if (process.platform !== "win32") {
  console.error("windows-smoke: run this on Windows")
  process.exit(2)
}

let failed = 0
async function check(name: string, run: () => unknown | Promise<unknown>) {
  try {
    const detail = await run()
    console.log(`PASS  ${name}${detail === undefined ? "" : `  ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`)
  } catch (error) {
    failed++
    console.log(`FAIL  ${name}  ${error instanceof Error ? error.message : String(error)}`)
  }
}
function expectEqual(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const dir = mkdtempSync(join(tmpdir(), "rudder-smoke-"))
const bin = join(dir, "bin")
mkdirSync(bin)
const env = { ...process.env, PATH: `${bin};${process.env.PATH ?? process.env.Path ?? ""}` }
// A shim like npm's: a .cmd that hands %* to a real program (bun running a script that prints its argv).
writeFileSync(join(dir, "argv.ts"), "console.log(JSON.stringify(process.argv.slice(2)))\n")
writeFileSync(join(bin, "echo-args.cmd"), `@echo off\r\n"${process.execPath}" "${join(dir, "argv.ts")}" %*\r\n`)
writeFileSync(
  join(dir, "tree.ts"),
  `const child = Bun.spawn(["${process.execPath.replace(/\\/g, "\\\\")}", "-e", "setInterval(() => {}, 1000)"]); console.log(child.pid); setInterval(() => {}, 1000)\n`,
)
writeFileSync(join(bin, "tree.cmd"), `@echo off\r\n"${process.execPath}" "${join(dir, "tree.ts")}" %*\r\n`)

await check("a .cmd shim receives every argument intact through cmd.exe", () => {
  const args = ["plain", "with space", 'quote " inside', "%PATH%", "!x!", "a & calc", "a | b", "^caret", "(x)", "C:\\dir\\", "", "ünïcødé 中文"]
  const plan = planSpawn(["echo-args", ...args], env)
  const result = Bun.spawnSync(plan.argv, { env, ...plan.options, stdout: "pipe", stderr: "pipe" })
  expectEqual(JSON.parse(result.stdout.toString()), args)
  return plan.argv.slice(0, 5).join(" ")
})

await check("killTree ends a .cmd shim and the program behind it", async () => {
  const plan = planSpawn(["tree"], env)
  const proc = Bun.spawn(plan.argv, { env, ...plan.options, stdout: "pipe" })
  const reader = proc.stdout.getReader()
  const { value } = await reader.read()
  const grandchild = Number(new TextDecoder().decode(value).trim())
  if (!alive(grandchild)) throw new Error(`grandchild ${grandchild} did not start`)
  killTree(proc.pid)
  await Promise.race([proc.exited, Bun.sleep(5000)])
  await Bun.sleep(500)
  if (alive(grandchild)) throw new Error(`grandchild ${grandchild} still running after taskkill /T`)
})

const sid = currentUserSid()
await check("this user's SID", () => sid)
await check("RUDDER_HOME ACL: tightened to user + SYSTEM and read back", () => {
  const home = join(dir, "home")
  mkdirSync(home)
  restrictToUser(home, { directory: true, userSid: sid })
  checkOwnerOnly(home, sid)
  return readAcl(home).entries.map((entry) => entry.sid)
})
await check("the default %LOCALAPPDATA% ACL passes the CLI's check", () => checkOwnerOnly(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), sid))

await check("token channel: request, proof, file ACL", async () => {
  const home = join(dir, "home")
  const path = join(home, "rudder-local.json")
  const channel = startTokenChannel({ path, handle: () => Response.json({ ok: true }), protect: (file) => restrictToUser(file, { directory: false, userSid: sid }) })
  try {
    checkOwnerOnly(path, sid)
    expectEqual(await tokenRequest(path, "GET", "/local/pair"), { status: 200, body: { ok: true } })
    return `127.0.0.1:${readChannelFile(path)?.port}`
  } finally {
    channel.stop()
  }
})

await check("perf: identity and two samples from the PowerShell worker", async () => {
  const sampler = createPerfSampler({ machineName: () => "smoke", processes: () => [] })
  const first = await sampler.sample()
  await Bun.sleep(2000)
  const second = await sampler.sample()
  if (second.errors) throw new Error(second.errors.join("; "))
  return {
    model: second.machine.model,
    osVersion: second.machine.osVersion,
    cpu: second.cpu.percent,
    usedGiB: Math.round(second.memory.usedBytes / 1024 ** 3),
    swap: second.memory.swapTotalBytes,
    interfaces: second.network.interfaces.map((entry) => `${entry.name}${entry.tunnel ? " (tunnel)" : ""}`),
    disk: second.disk,
    processes: second.processes.length,
    firstCostMs: first.sampler.cpuMs,
    costMs: second.sampler.cpuMs,
    wallMs: second.sampler.wallMs,
  }
})

await check("TLS: built-in certificate without openssl", () => {
  const material = ensureTlsMaterial(join(dir, "tls"))
  return new X509Certificate(material.cert).subjectAltName
})

await check("paths: device names, streams and other drives are refused", () => {
  const root = homedir()
  for (const input of ["NUL", "x.txt:secret", "\\\\?\\C:\\Windows", "..\\..", "C:\\Windows\\System32"]) {
    let refused = false
    try {
      resolveSafe(input, root)
    } catch {
      refused = true
    }
    if (!refused) throw new Error(`${input} was allowed`)
  }
  return resolveSafe("Documents", root)
})

await check("agents on PATH (Bun.which vs PATH + PATHEXT)", () =>
  Object.fromEntries(
    ["claude", "codex", "grok", "copilot", "cursor-agent", "opencode", "kimi", "pi", "npx", "git"].map((name) => [
      name,
      `${resolveWindowsCommand(name, process.env)?.path ?? "-"} | which: ${Bun.which(name) ?? "-"}`,
    ]),
  ),
)

rmSync(dir, { recursive: true, force: true })
console.log(failed === 0 ? "\nall checks passed" : `\n${failed} check(s) failed`)
process.exit(failed === 0 ? 0 : 1)
