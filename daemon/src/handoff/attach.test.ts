// `rudder attach` end to end over the real local socket, with a fake `claude` binary (fixtures/fake-terminal-claude.ts)
// that is a child of this test. The only real signal sent anywhere is to such a child.
import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, realpathSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { localRequest, startLocalControl } from "../local"
import { attach, type AttachDeps, shownCommand } from "./attach-cli"
import { systemProbe } from "./claude-registry"
import { harness, linearChain, waitFor } from "./test-kit"

type Kit = ReturnType<typeof harness>
let cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups = []
})

const SCRIPT = join(import.meta.dir, "fixtures", "fake-terminal-claude.ts")

function setup() {
  const root = mkdtempSync(join(tmpdir(), "rudder-attach-"))
  const bin = join(root, "fake-claude")
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${SCRIPT}" "$@"\n`)
  chmodSync(bin, 0o755)
  const kit = harness({ root, probe: systemProbe(), claudeCommand: bin })
  const socket = join(kit.root, "rudder.sock")
  const local = startLocalControl({
    path: socket,
    store: kit.store,
    machine: () => "mac-test",
    pairLink: () => ({ url: "", expiresAt: 0 }),
    rotatePairing: () => ({ url: "", expiresAt: 0 }),
    isConnected: () => false,
    revoke: () => null,
    attach: (body) => kit.service.attachLocal(body),
    attachDone: (body) => kit.service.attachLocalDone(body),
  })
  cleanups.push(() => kit.cleanup(), () => local.stop())
  const go = join(kit.root, "go")
  const argsFile = join(kit.root, "args.json")
  const env = { FAKE_CLAUDE_REGISTRY: kit.registryDir, FAKE_CLAUDE_PROJECT: kit.project, FAKE_CLAUDE_GO: go, FAKE_CLAUDE_ARGS: argsFile }
  const out: string[] = []
  const deps = (locale: "zh" | "en" = "zh"): AttachDeps => ({
    request: (method, route, body) => localRequest(socket, method, route, body),
    run: (argv, cwd) => Bun.spawn(argv, { cwd, env: { ...process.env, ...env }, stdout: "ignore", stderr: "inherit" }).exited,
    which: (name) => (name === bin || name === "claude" ? name : null),
    out: (line) => void out.push(line),
    err: (line) => void out.push(line),
    locale,
    tty: false,
    pid: process.pid,
    sleep: (ms) => Bun.sleep(Math.min(ms, 50)),
    onInterrupt: () => () => {},
    claude: "claude",
  })
  return { kit, bin, go, argsFile, out, deps, env }
}

async function phoneSession(kit: Kit) {
  const nativeId = crypto.randomUUID()
  // session.create keeps folders inside the home workspace; the test's folder is in the temp dir.
  const id = kit.store.createSession({ agent: "claude", cwd: kit.cwd, title: "README install steps", nativeId }).id
  // One phone turn first, so the session has a Claude process behind it.
  await kit.ok("message.send", { sessionId: id, text: "switch the README to Homebrew" })
  await waitFor(() => kit.store.listMessages(id).length >= 2)
  return { id, nativeId }
}

describe("rudder attach (step 7)", () => {
  test("hand over, phone refused while the terminal runs, terminal lines come back, phone writes again", async () => {
    const { kit, go, argsFile, out, deps } = setup()
    const { id, nativeId } = await phoneSession(kit)
    expect(kit.daemonProcs.size).toBe(1)
    const running = attach(deps(), id.slice(0, 4), false)
    await waitFor(() => existsSync(argsFile), 5000)
    // The daemon let its own process go before the terminal Claude started.
    expect(kit.daemonProcs.size).toBe(0)
    const { args, cwd } = JSON.parse(readFileSync(argsFile, "utf8")) as { args: string[]; cwd: string }
    expect(args).toEqual(["--resume", nativeId, "--permission-mode", "default"])
    expect(cwd.endsWith("/work/demo")).toBe(true)
    await waitFor(() => kit.handoff.holder(kit.store.getSession(id)!, true).kind === "terminal", 5000)
    const refused = await kit.call("message.send", { sessionId: id, text: "sent at the handover" })
    expect(refused.error?.code).toBe("held_elsewhere")
    writeFileSync(go, "")
    expect(await running).toBe(0)
    expect(out[0]).toBe(`⎈ Rudder · 「README install steps」 · claude · ${kit.cwd.replace(process.env.HOME ?? "", "~")}`)
    expect(out).toContain("  已交给终端，手机上这个会话变为只能看。")
    expect(out).toContain(`  → fake-claude --resume ${nativeId.slice(0, 14)}… --permission-mode default`)
    expect(out.at(-1)).toBe("⎈ 已交还手机：终端里新增 2 条消息已同步。")
    expect(kit.handoff.holder(kit.store.getSession(id)!, true).kind).toBe("none")
    const texts = kit.store.listMessages(id).map((row) => row.text)
    expect(texts.slice(-3)).toEqual(["以下在电脑终端里", "typed in the terminal", "answered in the terminal"])
    expect((await kit.call("message.send", { sessionId: id, text: "back on the phone" })).type).toBe("result")
    await kit.service.shutdown(500)
    expect(linearChain(kit.transcriptPath(nativeId)).forks).toEqual([])
  })

  test("native permission handoff preserves native ID and omits CLI policy overrides", async () => {
    const { kit, go, argsFile, deps } = setup()
    const nativeId = crypto.randomUUID()
    const row = kit.store.createSession({ agent: "claude", cwd: kit.cwd, title: "Native policy", nativeId, permissionMode: "native" })
    const running = attach(deps(), row.id, false)
    await waitFor(() => existsSync(argsFile), 5000)
    const { args, cwd } = JSON.parse(readFileSync(argsFile, "utf8")) as { args: string[]; cwd: string }
    writeFileSync(go, "")
    expect(await running).toBe(0)
    expect(args).toEqual(["--resume", nativeId])
    expect(cwd).toBe(realpathSync(kit.cwd))
    expect(kit.store.getSession(row.id)?.native_id).toBe(nativeId)
    expect(kit.store.getSession(row.id)?.permission_mode).toBe("native")
  })

  test("a running phone turn is waited for; English copy", async () => {
    const { kit, go, out, deps } = setup()
    const { id } = await phoneSession(kit)
    kit.holdNextTurn()
    await kit.ok("message.send", { sessionId: id, text: "a long one" })
    const running = attach(deps("en"), id.slice(0, 4), false)
    await waitFor(() => out.some((line) => line.includes("Waiting for it")), 5000)
    expect(out).toContain("  A turn is still running on the phone. Waiting for it… (Ctrl-C cancels; the phone is unaffected)")
    kit.releaseTurn()
    writeFileSync(go, "")
    expect(await running).toBe(0)
    expect(out.at(-1)).toBe("⎈ Back on the phone: 2 new messages from the terminal are synced.")
  })

  test("errors: no such session, no daemon, no claude", async () => {
    const { deps, out, kit } = setup()
    expect(await attach(deps(), "9z9z", false)).toBe(1)
    expect(out.at(-1)).toBe("✗ 找不到会话 9z9z。在手机上打开会话 → … → 回电脑继续，看它的短号。")
    expect(await attach({ ...deps(), request: async () => null }, "abcd", false)).toBe(1)
    expect(out.at(-1)).toBe("✗ Rudder 没在运行。先执行 rudder，或 rudder install 让它常驻。")
    expect(await attach({ ...deps(), which: () => null }, "abcd", false)).toBe(1)
    expect(out.at(-1)).toBe("✗ 这台电脑上找不到 claude 命令。装好 Claude Code 后再试。")
    void kit
  })

  test("a killed CLI: the registry fallback gives the session back", async () => {
    const { kit } = setup()
    const { id } = await phoneSession(kit)
    const lease = await kit.handoff.attach({ target: id, pid: 2_147_000_000 })
    expect(lease.state).toBe("ready")
    expect(kit.handoff.holder(kit.store.getSession(id)!, true).kind).toBe("terminal")
    await kit.handoff.tick()
    expect(kit.handoff.holder(kit.store.getSession(id)!, true).kind).toBe("none")
  })

  test("takeover sends a real SIGTERM to the registered child, which quits", async () => {
    const { kit, bin, env } = setup()
    const nativeId = crypto.randomUUID()
    const child = Bun.spawn([bin, "--resume", nativeId], { cwd: kit.cwd, env: { ...process.env, ...env, FAKE_CLAUDE_HANG: "1" }, stdout: "ignore" })
    cleanups.push(() => child.kill())
    await waitFor(() => existsSync(join(kit.registryDir, `${child.pid}.json`)), 5000)
    // A transcript to import.
    const { TranscriptWriter } = await import("./test-kit")
    new TranscriptWriter(kit.transcriptPath(nativeId), nativeId, "cli", kit.cwd).turn("hello", "hi")
    const { entries } = await kit.ok<{ entries: { ref: string; live: unknown }[] }>("handoff.list")
    expect(entries[0]?.live).not.toBeNull()
    const { session } = await kit.ok<{ session: { id: string } }>("handoff.import", { ref: entries[0]!.ref })
    await kit.ok("handoff.takeover", { id: session.id, when: "now" })
    expect(await child.exited).toBe(143)
    expect(kit.handoff.holder(kit.store.getSession(session.id)!, true).kind).toBe("none")
  })

  test("the printed command cuts the native id like the design", () => {
    expect(shownCommand(["/usr/local/bin/claude", "--resume", "7c1e9b2a-41d0-4f5e-9a3c-2b8d6e1f0a77", "--permission-mode", "default"])).toBe(
      "claude --resume 7c1e9b2a-41d0-… --permission-mode default",
    )
  })
})
