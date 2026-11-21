import { expect, test } from "bun:test"
import { mkdtemp, writeFile, readFile, rm, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { arr, obj } from "../src/adapter/json"
import { spawnRpc } from "../src/adapter/jsonrpc"

// Opt-in metadata-only native integration: no turn/start, tool call or model request.
test.skipIf(process.env.RUDDER_NATIVE_HOOK_TEST !== "1")("isolated native discovery and fixture hook transport keep acceptance boundaries", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "rudder-native-memory-")))
  const home = join(root, "codex"), log = join(root, "events.jsonl")
  const { mkdir } = await import("node:fs/promises")
  await mkdir(home)
  const hook = join(root, "hook.ts")
  await writeFile(hook, `const input=JSON.parse(await Bun.stdin.text()); await Bun.write(Bun.file(${JSON.stringify(log)}), JSON.stringify(input)+"\\n"); console.log(JSON.stringify({hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:"fixture-only-project-context"}}));`)
  await writeFile(join(home, "config.toml"), '[features]\nhooks = true\n')
  await writeFile(join(home, "hooks.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: `${JSON.stringify(process.execPath)} ${JSON.stringify(hook)}` }] }] } }))
  const wire: string[] = []
  const notifications: { method: string; params: unknown }[] = []
  const rpc = spawnRpc(["env", `CODEX_HOME=${home}`, "codex", "app-server"], { onNotification: (method, params) => notifications.push({ method, params }), onRequest: async () => ({}), onClose() {} }, { defaultTimeoutMs: 15_000 })
  const request = async (method: string, params: unknown) => { wire.push(method); return rpc.request<Record<string, unknown>>(method, params) }
  try {
    const init = await request("initialize", { clientInfo: { name: "rudder-memory-fixture", version: "1" }, capabilities: { experimentalApi: true } })
    expect(init.codexHome).toBe(home)
    rpc.notify("initialized")
    const inventory = await request("hooks/list", { cwds: [root] })
    const handler = obj(arr(obj(arr(inventory.data)[0]).hooks)[0])
    expect(handler.sourcePath).toBe(join(home, "hooks.json"))
    // Only this temporary fixture is trusted; owner configuration is never written.
    await request("config/value/write", { keyPath: `hooks.state.${JSON.stringify(handler.key)}.trusted_hash`, value: handler.currentHash, mergeStrategy: "replace", filePath: join(home, "config.toml") })
    const trustedInventory = await request("hooks/list", { cwds: [root] })
    expect(obj(arr(obj(arr(trustedInventory.data)[0]).hooks)[0]).trustStatus).toBe("trusted")
    const started = await request("thread/start", { cwd: root, sessionStartSource: "startup" })
    // Metadata creation is not evidence that a model consumed hook context.
    const input = { session_id: obj(started.thread).id, cwd: root, hook_event_name: "SessionStart", source: "startup" }
    const child = Bun.spawn([process.execPath, hook], { cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
    child.stdin.write(JSON.stringify(input))
    child.stdin.end()
    const output = JSON.parse(await new Response(child.stdout).text())
    expect(await child.exited).toBe(0)
    const events = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line))
    expect(events).toEqual([input])
    expect(output.hookSpecificOutput.additionalContext).toBe("fixture-only-project-context")
    expect(wire).not.toContain("turn/start")

  } finally { await rpc.close(); await rm(root, { recursive: true, force: true }) }
}, 30_000)
