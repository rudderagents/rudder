import { expect, test } from "bun:test"
import { checkCliParity } from "./check-cli-parity"
import { createFakeAdapter } from "../src/adapter/fake"
import { BUILTIN_AGENTS } from "../src/adapter"
import type { AgentAdapter } from "../src/adapter/types"

function fixture(overrides: Partial<AgentAdapter> = {}): AgentAdapter {
  return { ...createFakeAdapter(BUILTIN_AGENTS[0]!.spec), ...overrides }
}

test("discovery never submits a model task and disposes its owned adapters", async () => {
  let tasks = 0
  let disposed = 0
  let requestedCwd = ""
  const report = await checkCliParity([fixture({
    reply: async () => { tasks++ },
    listCommands: async cwd => { requestedCwd = cwd; return [{ name: "graphify", insert: "/graphify", kind: "skill", source: "agent" }] },
    dispose: async () => { disposed++ },
  })], "/fixture/project")
  expect(tasks).toBe(0)
  expect(disposed).toBe(1)
  expect(requestedCwd).toBe("/fixture/project")
  expect(report.agents[0]?.skills).toEqual({ state: "discovered", count: 1, graphify: true })
  expect(report.behavioralVerification).toBe("not-run")
})

test("discovery errors and unsupported APIs are explicit, not partial success", async () => {
  let disposed = 0
  const report = await checkCliParity([
    fixture({ listCommands: async () => { throw new Error("catalogue unavailable") }, dispose: async () => { disposed++ } }),
    fixture({ listCommands: undefined, dispose: async () => { disposed++ } }),
  ], "/fixture/project")
  expect(report.agents.map(agent => agent.skills.state)).toEqual(["failed", "unsupported"])
  expect(disposed).toBe(2)
  expect(report.behavioralVerification).toBe("not-run")
})
