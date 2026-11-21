import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, test } from "bun:test"
import { createClaudeAdapter } from "./claude"
import { BUILTIN_AGENTS } from "./index"
import type { AdapterContext, AgentEvent, PermissionRequest } from "./types"

// Real Claude Code CLI, three cheap turns: RUDDER_SMOKE=1 bun test src/adapter/claude.smoke.test.ts
const SMOKE = process.env.RUDDER_SMOKE === "1"
const SPEC = BUILTIN_AGENTS.find((entry) => entry.spec.id === "claude")!.spec
const MODEL = process.env.RUDDER_SMOKE_CLAUDE_MODEL ?? "haiku"

const cwd = mkdtempSync(join(tmpdir(), "rudder-claude-smoke-"))
const spawns: string[][] = []
const adapter = createClaudeAdapter({
  spec: SPEC,
  args: (base) => {
    spawns.push(base)
    return base
  },
})

afterAll(async () => {
  await adapter.dispose?.()
  rmSync(cwd, { recursive: true, force: true })
})

async function turn(text: string, overrides: Partial<AdapterContext>, choose?: (request: PermissionRequest) => string) {
  const events: AgentEvent[] = []
  const permissions: PermissionRequest[] = []
  await adapter.reply(text, {
    sessionId: "smoke-1",
    cwd,
    model: MODEL,
    permissionMode: "ask",
    signal: new AbortController().signal,
    emit: (event) => {
      events.push(event)
    },
    askPermission: async (request) => {
      permissions.push(request)
      return choose ? choose(request) : null
    },
    askQuestion: async () => null,
    ...overrides,
  })
  const texts = new Map<string, string>()
  for (const event of events) if (event.type === "text") texts.set(event.id, event.text)
  const tools = new Map<string, Extract<AgentEvent, { type: "tool" }>>()
  for (const event of events) if (event.type === "tool") tools.set(event.id, event)
  console.log(
    JSON.stringify({
      text: [...texts.values()],
      tools: [...tools.values()].map((tool) => [tool.tool, tool.status, tool.detail]),
      permissions: permissions.map((request) => [request.tool, request.detail]),
      native: events.find((event) => event.type === "native"),
      usage: events.find((event) => event.type === "usage"),
    }),
  )
  return { events, permissions, text: [...texts.values()].join("\n"), tools: [...tools.values()] }
}

describe.skipIf(!SMOKE)("Claude CLI smoke", () => {
  test(
    "two turns share one process and one conversation",
    async () => {
      const first = await turn("Reply with exactly: ok", {})
      expect(first.text.trim().toLowerCase()).toContain("ok")
      const native = first.events.find((event) => event.type === "native")
      expect(native?.type).toBe("native")
      const nativeId = native?.type === "native" ? native.nativeId : undefined
      const second = await turn("What exactly did you reply in your previous message? Answer with only that reply.", { nativeId })
      expect(second.text.toLowerCase()).toContain("ok")
      expect(spawns).toHaveLength(1)
      expect(second.events.some((event) => event.type === "usage")).toBe(true)
    },
    180_000,
  )

  test(
    "ask mode: rejecting a command declines the tool",
    async () => {
      // `echo` is auto-approved as read-only, so touch a file inside the temp cwd instead.
      const { tools, permissions } = await turn(
        "Run exactly this bash command: touch rudder-smoke.txt  (then say in one line whether it worked).",
        { sessionId: "smoke-2" },
        () => "reject",
      )
      expect(permissions.length).toBeGreaterThan(0)
      expect(permissions[0]!.tool).toBe("Bash")
      expect(tools.some((tool) => tool.tool === "Bash" && tool.status === "declined")).toBe(true)
      expect(existsSync(join(cwd, "rudder-smoke.txt"))).toBe(false)
    },
    180_000,
  )
})
