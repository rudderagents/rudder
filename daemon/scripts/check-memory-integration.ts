import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { CodexConnection } from "../src/adapter/codex"
import { arr, obj, str } from "../src/adapter/json"
import { setupCodexMemory, type SetupReport } from "./setup-codex-memory"

type Request = (method: string, params: Record<string, unknown>) => Promise<unknown>
export async function checkMemoryIntegration(options: {
  cwd: string; configRoot: string; setup: SetupReport; request: Request;
  health: () => Promise<unknown>;
}) {
  let worker: "ready" | "failed" = "failed"
  try { if (obj(await options.health()).status === "ok") worker = "ready" } catch { /* Report an unavailable worker without exposing response data. */ }
  let hooks: { state: "configured" | "needs-trust" | "unsupported" | "failed"; count: number; trusted: number; disabled: number; events: string[] } = { state: "unsupported", count: 0, trusted: 0, disabled: 0, events: [] }
  try {
    const response = obj(await options.request("hooks/list", { cwds: [options.cwd] }))
    if (!Array.isArray(response.data)) throw new Error("Invalid hooks inventory")
    const entries = arr(response.data)
    const memory = entries.flatMap(entry => arr(obj(entry).hooks)).map(obj).filter(hook => hook.sourcePath === options.setup.target && str(hook.command).includes("CLAUDE_MEM_CODEX_HOOK=1") && str(hook.command).includes("worker-service.cjs"))
    const trusted = memory.filter(hook => hook.trustStatus === "trusted" || hook.trustStatus === "managed").length
    hooks = { state: entries.some(entry => arr(obj(entry).errors).length) ? "failed" : memory.length > trusted ? "needs-trust" : "configured", count: memory.length, trusted, disabled: memory.filter(h => h.enabled === false).length, events: [...new Set(memory.map(h => str(h.eventName)))].sort() }
    if (options.setup.state === "configured" && !memory.length) hooks.state = "failed"
  } catch { hooks.state = "failed" }
  return {
    cwd: options.cwd, configRoot: options.configRoot, setup: options.setup, worker: { state: worker }, hooks,
    startupInjection: { state: "unverified" }, capture: { state: "unverified" }, retrieval: { state: "unverified" },
    nextAction: hooks.state === "needs-trust" ? "Review exact claude-mem definitions with native /hooks before a new session" : "Verify startup, capture and retrieval in an authorized native session",
  }
}
if (import.meta.main) {
  const setup = await setupCodexMemory({ codexHome: process.env.CODEX_HOME || join(homedir(), ".codex"), claudeHome: process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude") })
  const conn = await new CodexConnection(["codex", "app-server"], { notification() {}, request: async () => ({}), exit() {} }).initialize()
  try {
    const workerUrl = process.env.CLAUDE_MEM_WORKER_URL || "http://127.0.0.1:37702"
    const url = new URL(workerUrl)
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || !["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Memory health checks require a loopback worker URL")
    console.log(JSON.stringify(await checkMemoryIntegration({ cwd: resolve(process.argv[2] || process.cwd()), configRoot: conn.configRoot || "unknown", setup,
      request: (method, params) => conn.request(method, params, 10_000),
      health: async () => { const response = await fetch(new URL("/api/health", url), { signal: AbortSignal.timeout(5_000) }); if (!response.ok) throw new Error("Worker health failed"); return response.json() },
    }), null, 2))
  } finally { await conn.dispose() }
}
