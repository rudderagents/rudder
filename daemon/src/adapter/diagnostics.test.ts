import { expect, test } from "bun:test"
import { collectAgentDiagnostics, readClaudeDiagnostics, readCodexDiagnostics } from "./diagnostics"
import { RpcError } from "./jsonrpc"

test("diagnostics separates configured, connected, failed and disabled MCP servers", async () => {
  const snapshot = await readCodexDiagnostics(async method => {
    if (method === "config/read") return { config: { mcp_servers: { configured: {}, ready: {}, failed: {}, disabled: { enabled: false } } } }
    if (method === "hooks/list") return { data: [{ cwd: "/fixture", hooks: [{ eventName: "sessionStart", enabled: true, command: "TOKEN=fixture-secret-value" }], errors: [] }] }
    return { data: [
      { name: "configured", runtimeStatus: null }, { name: "ready", runtimeStatus: "connected" },
      { name: "failed", runtimeStatus: "failed", toolsError: "fixture-secret-value" },
      { name: "disabled", runtimeStatus: "disabled" },
    ], nextCursor: null }
  }, "/fixture", "/fixture/codex", "fixture-native-id")
  expect(snapshot.nativeId).toBe("fixture-native-id")
  expect(snapshot.mcp.servers.map(server => server.state)).toEqual(["configured", "ready", "failed", "configured"])
  expect(snapshot.hooks.events).toEqual(["sessionStart"])
  expect(snapshot.mcp.state).toBe("failed")
  expect(JSON.stringify(snapshot)).not.toContain("fixture-secret-value")
})

test("missing native inventory APIs are explicitly unsupported", async () => {
  const snapshot = await readCodexDiagnostics(async () => { throw new RpcError("fixture", -32601, "method not found") }, "/fixture", "/fixture/codex")
  expect(snapshot.hooks.state).toBe("unsupported")
  expect(snapshot.mcp.state).toBe("unsupported")
  expect(snapshot.permissionSource).toBe("unknown")
})

test("hook parse errors are reported without exposing command contents", async () => {
  const snapshot = await readCodexDiagnostics(async method => {
    if (method === "config/read") return { config: {} }
    if (method === "hooks/list") return { data: [{ hooks: [], errors: [{ message: "fixture-secret-value" }] }] }
    return { data: [], nextCursor: null }
  }, "/fixture", "/fixture/codex")
  expect(snapshot.hooks.state).toBe("failed")
  expect(JSON.stringify(snapshot)).not.toContain("fixture-secret-value")
})

test("disabled Claude MCP servers are not reported as ready", async () => {
  const snapshot = await readClaudeDiagnostics(async () => ({ mcpServers: [{ name: "disabled", status: "disabled" }] }), "/fixture", "/fixture/claude")
  expect(snapshot.mcp.state).toBe("configured")
  expect(snapshot.hooks.state).toBe("unsupported")
})

test("configured hooks disclose untrusted definitions without claiming execution", async () => {
  const snapshot = await readCodexDiagnostics(async method => method === "hooks/list" ? { data: [{ hooks: [{ eventName: "sessionStart", enabled: true, trustStatus: "untrusted" }], errors: [] }] } : method === "config/read" ? { config: {} } : { data: [] }, "/fixture", "/fixture/codex")
  expect(snapshot.hooks.pendingTrust).toBe(1)
  expect(snapshot.hooks.state).toBe("configured")
})

test("one missing or credential-bearing diagnostic failure does not suppress a healthy peer", async () => {
  const report = await collectAgentDiagnostics([
    {spec:{id:"missing"}, diagnostics: async () => {throw Object.assign(new Error("fixture-secret"),{code:"ENOENT"})}},
    {spec:{id:"broken"}, diagnostics: async () => {throw new Error("TOKEN=fixture-secret")}},
    {spec:{id:"healthy"}, diagnostics: async () => ({agent:"healthy",cwd:"/fixture",configRoot:"/fixture/home",permissionSource:"native",mcp:{state:"configured",servers:[]},hooks:{state:"unsupported",events:[],enabled:0,errors:0}})},
  ], "/fixture")
  expect(report.map(r => r.agent)).toEqual(["missing","broken","healthy"])
  expect(report[0]).toMatchObject({state:"unsupported"})
  expect(report[1]).toMatchObject({state:"failed"})
  expect(JSON.stringify(report)).not.toContain("fixture-secret")
})
