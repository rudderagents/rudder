// r66: records `grok agent stdio` (ACP). See lib.ts / acp.ts.
// Free: initialize (models ride `_meta.modelState`) and `_x.ai/billing`, against the owner's own login. No session/new:
// Grok persists every session it opens. Conversation scenarios run on the owner's own account (approved 2026-11-05).
import { acpFreeScenarios, acpPaidScenarios, grokExtraScenarios, initialize } from "./acp"
import { type Frame, runRecorder } from "./lib"

/**
 * Grok starts the owner's own MCP servers and hooks (it has no safe mode). Their names, tool lists and hook names are
 * local config, not protocol: kept as counts. Exported so recordings made before this rule get the same treatment.
 */
export function elideLocal(frame: Frame): { frame: Frame; note: string } | undefined {
  const method = frame.method
  const params = frame.params as Frame | undefined
  if (!params) return undefined
  if (method === "_x.ai/mcp/tools_changed" && Array.isArray(params.tools)) {
    return { frame: { ...frame, params: { ...params, serverName: "<local>", tools: [`<elided: ${params.tools.length} local tools>`] } }, note: "_x.ai/mcp/tools_changed" }
  }
  if (method === "_x.ai/mcp/server_status" && typeof params.name === "string") {
    return { frame: { ...frame, params: { ...params, name: "<local>", ...(Array.isArray(params.tools) ? { tools: [`<elided: ${params.tools.length}>`] } : {}) } }, note: "_x.ai/mcp/server_status.name" }
  }
  const update = params.update as Frame | undefined
  // The command list mixes Grok's own commands with the owner's skills (`_meta.scope: "user"`): those become a count.
  // `_meta.tools` names every tool, the owner's MCP ones (`server__tool`) included: a count.
  if (update?.sessionUpdate === "available_commands_update" && Array.isArray(update.availableCommands)) {
    const all = update.availableCommands as Frame[]
    const own = all.filter((command) => (command._meta as Frame | undefined)?.scope !== "user")
    const meta = update._meta as Frame | undefined
    const tools = Array.isArray(meta?.tools) ? (meta.tools as unknown[]) : undefined
    if (own.length === all.length && !tools) return undefined
    const availableCommands = own.length === all.length ? all : [...own, { name: `<elided: ${all.length - own.length} user commands>`, description: "" }]
    const shrunk: Frame = { ...update, availableCommands, ...(tools ? { _meta: { ...meta, tools: [`<elided: ${tools.length} tools>`] } } : {}) }
    return { frame: { ...frame, params: { ...params, update: shrunk } }, note: "available_commands_update user-scope commands and _meta.tools" }
  }
  if (update?.sessionUpdate === "hook_execution" && Array.isArray(update.runs)) {
    const runs = (update.runs as Frame[]).map((run) => ({ ...run, name: "<local hook>" }))
    return { frame: { ...frame, params: { ...params, update: { ...update, runs } } }, note: "hook_execution.runs[].name" }
  }
  return undefined
}

if (import.meta.main) await runRecorder({
  agent: "grok",
  elide: (frame) => elideLocal(frame),
  cli: "grok",
  argv: ["grok", "agent", "stdio"],
  scenarios: [
    ...acpFreeScenarios({ session: false, keys: false }),
    {
      name: "billing",
      free: true,
      summary: "initialize + _x.ai/billing (credit share this period; no model)",
      async run({ start }) {
        const { rpc } = await initialize(start())
        await rpc.request("_x.ai/billing", {}, 30_000)
      },
    },
    // Owner's own account, not run without approval; the key file has no Grok key.
    ...acpPaidScenarios(new Set(["auth-error"])).map((scenario) => ({ ...scenario, keys: false, cost: "owner's Grok credits" })),
    // Background stop: Grok has no per-task stop (adapter stopBackground is absent), Rudder stops the turn instead,
    // which `interrupt` covers.
    ...grokExtraScenarios("owner's Grok credits"),
  ],
})
