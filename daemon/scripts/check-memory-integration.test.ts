import { expect, test } from "bun:test"
import { checkMemoryIntegration } from "./check-memory-integration"

test("memory verification separates trust, health, injection, capture and retrieval", async () => {
  const wire: string[] = []
  const report = await checkMemoryIntegration({ cwd: "/fixture/project", configRoot: "/fixture/codex", setup: { state: "configured", target: "/fixture/codex/hooks.json", changed: false, applied: false, version: "16.0.1" },
    request: async (method, params) => { wire.push(method); expect(params).toEqual({ cwds: ["/fixture/project"] }); return { data: [{ hooks: [
      { sourcePath: "/fixture/codex/hooks.json", command: "CLAUDE_MEM_CODEX_HOOK=1 worker-service.cjs", enabled: true, trustStatus: "untrusted", eventName: "sessionStart" },
      { sourcePath: "/other/project/hooks.json", command: "CLAUDE_MEM_CODEX_HOOK=1 worker-service.cjs", trustStatus: "trusted", eventName: "stop" },
    ], errors: [] }] } }, health: async () => ({ status: "ok", secret: "fixture-secret" }),
  })
  expect(report.hooks).toMatchObject({ state: "needs-trust", count: 1, trusted: 0 })
  expect(report.worker.state).toBe("ready")
  expect(report.startupInjection.state).toBe("unverified")
  expect(report.capture.state).toBe("unverified")
  expect(report.retrieval.state).toBe("unverified")
  expect(wire).toEqual(["hooks/list"])
  expect(JSON.stringify(report)).not.toContain("fixture-secret")
})
test("absent plugin and failed worker are legitimate reported states", async () => {
  const report = await checkMemoryIntegration({ cwd: "/fixture", configRoot: "/fixture/home", setup: { state: "absent", target: "/fixture/home/hooks.json", changed: false, applied: false }, request: async () => ({ data: [{ hooks: [], errors: [] }] }), health: async () => { throw new Error("fixture-secret") } })
  expect(report.setup.state).toBe("absent"); expect(report.hooks.count).toBe(0); expect(report.worker.state).toBe("failed")
  expect(JSON.stringify(report)).not.toContain("fixture-secret")
})
