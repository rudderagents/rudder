import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, test } from "bun:test"
import { CodexConnection, createCodexAdapter } from "./codex"
import { BUILTIN_AGENTS } from "./index"
import type { AdapterContext, AgentEvent, PermissionRequest, RudderPermissionMode } from "./types"

// Real `codex app-server`, harmless prompts, every approval declined. Run: RUDDER_SMOKE=1 bun test src/adapter/codex.smoke.test.ts
const SMOKE = process.env.RUDDER_SMOKE === "1"
const TIMEOUT_MS = 240_000
const SPEC = BUILTIN_AGENTS.find((entry) => entry.spec.id === "codex")!.spec

const of = <T extends AgentEvent["type"]>(events: AgentEvent[], type: T) => events.filter((event) => event.type === type) as Extract<AgentEvent, { type: T }>[]

describe("codex app-server smoke (real CLI)", () => {
  const adapter = createCodexAdapter({ spec: SPEC })
  const cwd = SMOKE ? realpathSync(mkdtempSync(join(tmpdir(), "rudder-codex-smoke-"))) : ""
  const threads: string[] = []
  let model: string | undefined
  let effort: string | undefined

  function context(sessionId: string, permissionMode: RudderPermissionMode, nativeId?: string) {
    const events: AgentEvent[] = []
    const asked: PermissionRequest[] = []
    const ctx: AdapterContext = {
      sessionId,
      emit: (event) => {
        events.push(event)
        if (event.type === "native") threads.push(event.nativeId)
      },
      askPermission: async (request) => {
        asked.push(request)
        return "decline"
      },
      askQuestion: async () => null,
      cwd,
      model,
      effort,
      permissionMode,
      nativeId,
      signal: new AbortController().signal,
    }
    return { ctx, events, asked }
  }

  afterAll(async () => {
    if (!SMOKE) return
    await adapter.dispose?.()
    // Keep the owner's Codex history clean: archive the threads this run created.
    const conn = new CodexConnection(["codex", "app-server"], {
      notification() {},
      async request(_conn, method) {
        throw new Error(`unexpected ${method}`)
      },
      exit() {},
    })
    await conn.initialize()
    for (const threadId of threads) {
      await conn.request("thread/archive", { threadId }).then(
        () => console.log(`archived ${threadId}`),
        (error: unknown) => console.warn(`archive ${threadId} failed`, error),
      )
    }
    await conn.dispose()
    rmSync(cwd, { recursive: true, force: true })
  })

  test.skipIf(!SMOKE)(
    "detect and model/list",
    async () => {
      expect(await adapter.detect!()).toEqual({ available: true })
      const models = await adapter.listModels!()
      expect(models.length).toBeGreaterThan(0)
      const pick = models.find((entry) => /luna/i.test(entry.id)) ?? models[0]!
      model = pick.id
      effort = pick.efforts.includes("low") ? "low" : pick.defaultEffort
      console.log(`models: ${models.map((entry) => entry.id).join(", ")} → using ${model} / ${effort}`)
    },
    TIMEOUT_MS,
  )

  test.skipIf(!SMOKE)(
    "two turns on one thread remember context",
    async () => {
      const first = context("smoke-a", "plan")
      await adapter.reply("Remember the code word pelican-42. Do not use any tools. Reply with exactly: ok", first.ctx)
      const nativeId = of(first.events, "native")[0]?.nativeId
      expect(nativeId).toBeString()
      const firstText = of(first.events, "text").at(-1)?.text ?? ""
      console.log(`turn 1 → ${JSON.stringify(firstText)} usage ${JSON.stringify(of(first.events, "usage")[0]?.usage)}`)
      expect(firstText).toMatch(/\bok\b/i)

      const second = context("smoke-a", "plan", nativeId)
      await adapter.reply("Without using any tools: what was the code word I gave you? Reply with just the code word.", second.ctx)
      const secondText = of(second.events, "text").at(-1)?.text ?? ""
      console.log(`turn 2 → ${JSON.stringify(secondText)} usage ${JSON.stringify(of(second.events, "usage")[0]?.usage)}`)
      expect(of(second.events, "native")).toEqual([])
      expect(secondText).toContain("pelican-42")
    },
    TIMEOUT_MS,
  )

  test.skipIf(!SMOKE)(
    "ask mode asks before running echo hi and honors decline",
    async () => {
      const run = context("smoke-b", "ask")
      await adapter.reply(
        "Run exactly this shell command once in the current directory: `echo hi` and then report its output. Do not run any other commands.",
        run.ctx,
      )
      for (const request of run.asked) console.log(`asked: ${request.kind} ${JSON.stringify(request.detail)} [${request.options.map((option) => option.id).join(", ")}]`)
      const tools = of(run.events, "tool")
      const finals = new Map(tools.map((event) => [event.id, event]))
      for (const tool of finals.values()) console.log(`tool: ${tool.detail} → ${tool.status}`)
      console.log(`reply → ${JSON.stringify(of(run.events, "text").at(-1)?.text)}`)
      const echo = run.asked.find((request) => request.kind === "execute" && request.detail.includes("echo hi"))
      expect(echo).toBeDefined()
      expect([...finals.values()].some((tool) => tool.detail.includes("echo hi") && tool.status === "declined")).toBe(true)
    },
    TIMEOUT_MS,
  )
})
