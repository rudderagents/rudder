import { arr, isObject, obj, str } from "./json"

export type DiagnosticState = "configured" | "ready" | "failed" | "unsupported"
export type AgentDiagnostics = {
  agent: string
  cwd: string
  configRoot: string
  nativeId?: string
  runtimeScope?: "session" | "configuration"
  permissionSource: "native" | "override" | "unknown"
  mcp: { state: DiagnosticState; servers: { name: string; state: DiagnosticState; enabled: boolean }[]; error?: string }
  hooks: { state: DiagnosticState; events: string[]; enabled: number; errors: number; pendingTrust?: number }
}
type Request = (method: string, params?: Record<string, unknown>) => Promise<unknown>
type Probe = { state: "ready"; value: unknown } | { state: "failed" | "unsupported" }

async function probe(request: Request, method: string, params?: Record<string, unknown>): Promise<Probe> {
  try {
    return { state: "ready", value: await request(method, params) }
  } catch (error) {
    const code = obj(error).code
    const unsupported = code === -32601 || (error instanceof Error && /method not found|unsupported control request|unknown variant/i.test(error.message))
    return { state: unsupported ? "unsupported" : "failed" }
  }
}

function serverState(status: unknown): DiagnosticState {
  if (status === "connected") return "ready"
  if (status === "failed" || status === "authenticationRequired" || status === "needs-auth") return "failed"
  return "configured"
}

export async function readCodexDiagnostics(request: Request, cwd: string, configRoot: string, nativeId?: string): Promise<AgentDiagnostics> {
  const [config, hooks, firstPage] = await Promise.all([
    probe(request, "config/read", { cwd, includeLayers: false }),
    probe(request, "hooks/list", { cwds: [cwd] }),
    probe(request, "mcpServerStatus/list", { limit: 100, detail: "toolsAndAuthOnly", ...(nativeId ? { threadId: nativeId } : {}) }),
  ])
  const definitions = config.state === "ready" ? obj(obj(config.value).config).mcp_servers : undefined
  const servers = new Map<string, { name: string; state: DiagnosticState; enabled: boolean }>()
  for (const [name, raw] of Object.entries(obj(definitions))) servers.set(name, { name, state: "configured", enabled: obj(raw).enabled !== false })
  let page = firstPage
  let inventoryState: DiagnosticState = firstPage.state === "ready" ? "configured" : firstPage.state
  const seen = new Set<string>()
  for (let index = 0; page.state === "ready"; index++) {
    const value = obj(page.value)
    if (!Array.isArray(value.data)) { inventoryState = "failed"; break }
    for (const raw of value.data) {
      const server = obj(raw)
      const name = str(server.name)
      if (!name) { inventoryState = "failed"; continue }
      const enabled = server.runtimeStatus !== "disabled" && servers.get(name)?.enabled !== false
      servers.set(name, { name, enabled, state: server.toolsError ? "failed" : serverState(server.runtimeStatus) })
    }
    const cursor = str(value.nextCursor)
    if (!cursor) break
    if (index >= 15 || seen.has(cursor)) { inventoryState = "failed"; break }
    seen.add(cursor)
    page = await probe(request, "mcpServerStatus/list", { limit: 100, cursor, detail: "toolsAndAuthOnly", ...(nativeId ? { threadId: nativeId } : {}) })
    if (page.state !== "ready") inventoryState = page.state
  }
  const list = [...servers.values()]
  if (inventoryState === "configured") {
    const active = list.filter(server => server.enabled)
    if (active.some(server => server.state === "failed")) inventoryState = "failed"
    else if (active.length && active.every(server => server.state === "ready")) inventoryState = "ready"
  }
  const entries = hooks.state === "ready" ? obj(hooks.value).data : undefined
  let hookState: DiagnosticState = hooks.state === "ready" ? "configured" : hooks.state
  if (hooks.state === "ready" && !Array.isArray(entries)) hookState = "failed"
  let errors = 0
  let enabled = 0
  let pendingTrust = 0
  const events = new Set<string>()
  for (const entry of arr(entries)) {
    const data = obj(entry)
    errors += arr(data.errors).length
    for (const raw of arr(data.hooks)) {
      const hook = obj(raw)
      if (hook.enabled === false) continue
      enabled++
      if (hook.trustStatus === "untrusted" || hook.trustStatus === "modified") pendingTrust++
      if (typeof hook.eventName === "string") events.add(hook.eventName)
    }
  }
  if (errors) hookState = "failed"
  return {
    agent: "codex", cwd, configRoot, runtimeScope: nativeId ? "session" : "configuration", ...(nativeId ? { nativeId } : {}),
    permissionSource: config.state === "ready" && isObject(obj(config.value).config) ? "native" : "unknown",
    mcp: { state: inventoryState, servers: list, ...(inventoryState === "failed" ? { error: "Native MCP inventory is incomplete or failed; inspect MCP status in the native CLI" } : {}) },
    hooks: { state: hookState, events: [...events].sort(), enabled, errors, pendingTrust },
  }
}

export async function readClaudeDiagnostics(request: Request, cwd: string, configRoot: string, nativeId?: string): Promise<AgentDiagnostics> {
  const response = await probe(request, "mcp_status")
  const raw = response.state === "ready" ? obj(response.value).mcpServers : undefined
  const servers = arr(raw).map(item => {
    const server = obj(item)
    return { name: str(server.name), state: serverState(server.status), enabled: server.status !== "disabled" }
  })
  let state: DiagnosticState = response.state === "ready" ? "configured" : response.state
  if (response.state === "ready" && !Array.isArray(raw)) state = "failed"
  if (servers.some(server => server.state === "failed")) state = "failed"
  else if (state === "configured" && servers.some(server => server.enabled) && servers.filter(server => server.enabled).every(server => server.state === "ready")) state = "ready"
  return {
    agent: "claude", cwd, configRoot, runtimeScope: nativeId ? "session" : "configuration", ...(nativeId ? { nativeId } : {}), permissionSource: "native",
    mcp: { state, servers }, hooks: { state: "unsupported", events: [], enabled: 0, errors: 0 },
  }
}

export async function collectAgentDiagnostics(adapters: readonly { spec: { id: string }; diagnostics?: (cwd: string) => Promise<unknown> }[], cwd: string): Promise<{ agent: string; [key: string]: unknown }[]> {
  return Promise.all(adapters.map(async adapter => {
    const base = { agent: adapter.spec.id, cwd }
    if (!adapter.diagnostics) return { ...base, state: "unsupported" }
    try { return { ...obj(await adapter.diagnostics(cwd)), ...base } }
    catch (error) {
      return { ...base, state: obj(error).code === "ENOENT" ? "unsupported" : "failed", error: "Native diagnostics unavailable; verify CLI installation and configuration" }
    }
  }))
}
