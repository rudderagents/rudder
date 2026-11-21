import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "bun:test"
import { createAcpAdapter } from "./acp"
import { ACP_ASK, ACP_PLAN, capabilityModes } from "./modes"
import type { AdapterContext, AgentEvent, AgentSpec } from "./types"

// Real CLIs; opt in with RUDDER_SMOKE=1. Grok: three harmless no-tool turns. Copilot: no prompt.
const SMOKE = process.env.RUDDER_SMOKE === "1"

const CAPABILITIES: AgentSpec["capabilities"] = {
  reasoning: true,
  steer: false,
  interrupt: true,
  plan: true,
  question: true,
  usage: "tokens",
  models: "dynamic",
  efforts: true,
  ...capabilityModes([ACP_ASK, ACP_PLAN]),
}

function spec(id: string, label: string): AgentSpec {
  return { id, label, transport: "acp", experimental: false, capabilities: CAPABILITIES }
}

function context(cwd: string, overrides: Partial<AdapterContext> = {}) {
  const events: AgentEvent[] = []
  const ctx: AdapterContext = {
    sessionId: "smoke",
    emit: (event) => {
      events.push(event)
    },
    askPermission: async () => null,
    askQuestion: async () => null,
    cwd,
    permissionMode: "ask",
    signal: new AbortController().signal,
    ...overrides,
  }
  const text = () =>
    events
      .filter((event): event is Extract<AgentEvent, { type: "text" }> => event.type === "text")
      .reduce((all, event) => all.set(event.id, event.text), new Map<string, string>())
  const reply = () => [...text().values()].join("")
  const native = () => events.find((event): event is Extract<AgentEvent, { type: "native" }> => event.type === "native")?.nativeId
  return { ctx, events, reply, native }
}

function summary(events: AgentEvent[]) {
  return events.filter((event) => event.type !== "text" && event.type !== "reasoning").map((event) => JSON.stringify(event))
}

test.skipIf(!SMOKE)(
  "grok: two turns keep context, a fresh process resumes the session",
  async () => {
    const cwd = mkdtempSync(join(tmpdir(), "rudder-acp-smoke-"))
    const grok = createAcpAdapter({ spec: spec("grok", "Grok"), command: ["grok", "agent", "stdio"] })
    let nativeId: string | undefined
    try {
      expect(await grok.detect!()).toEqual({ available: true })
      const first = context(cwd)
      await grok.reply("Remember the code word PINEAPPLE for later. Do not use any tools. Reply with exactly: ok", first.ctx)
      console.log("turn1", JSON.stringify(first.reply()), summary(first.events))
      expect(first.reply().trim().toLowerCase()).toContain("ok")
      nativeId = first.native()
      expect(nativeId).toBeTruthy()

      const second = context(cwd, { nativeId })
      await grok.reply("What code word did I ask you to remember? Do not use any tools. Reply with only the word.", second.ctx)
      console.log("turn2", JSON.stringify(second.reply()), summary(second.events))
      expect(second.reply()).toMatch(/PINEAPPLE/i)
      expect(second.native()).toBe(nativeId)
      console.log("models", JSON.stringify(await grok.listModels!()))
    } finally {
      await grok.dispose!()
    }

    // A new process does not have the session live, so this goes through session/resume.
    const fresh = createAcpAdapter({ spec: spec("grok", "Grok"), command: ["grok", "agent", "stdio"] })
    try {
      const third = context(cwd, { nativeId })
      await fresh.reply("Repeat the code word from earlier in this conversation. Do not use any tools. Reply with only the word.", third.ctx)
      console.log("turn3", JSON.stringify(third.reply()), summary(third.events))
      expect(third.native()).toBe(nativeId)
      expect(third.reply()).toMatch(/PINEAPPLE/i)
    } finally {
      await fresh.dispose!()
    }
  },
  240_000,
)

test.skipIf(!SMOKE)(
  "copilot: session/new 403 marks the agent unavailable; no prompt is sent",
  async () => {
    const cwd = mkdtempSync(join(tmpdir(), "rudder-acp-smoke-"))
    const copilot = createAcpAdapter({
      spec: spec("copilot", "Copilot"),
      command: ["copilot", "--acp", "--stdio", "--no-auto-update"],
      cumulativeUsage: true,
      expectAgent: /copilot/i,
    })
    try {
      expect(await copilot.detect!()).toEqual({ available: true })
      // Abort as soon as a session exists so an authorized account would never get a prompt.
      const controller = new AbortController()
      const { ctx, events } = context(cwd, { signal: controller.signal })
      ctx.emit = (event) => {
        events.push(event)
        if (event.type === "native") controller.abort()
      }
      const outcome = await copilot.reply("unused", ctx).then(
        () => "no error",
        (error: Error) => error.message,
      )
      console.log("copilot reply:", outcome)
      const availability = await copilot.detect!()
      console.log("copilot detect:", JSON.stringify(availability))
      if (outcome === "no error") return
      expect(availability.available).toBe(false)
      expect(availability.reason).toContain("403")
    } finally {
      await copilot.dispose!()
    }
  },
  120_000,
)

test.skipIf(!SMOKE)("cursor: an `agent` binary that is not Cursor is reported unavailable", async () => {
  const cursor = createAcpAdapter({ spec: spec("cursor", "Cursor"), command: ["agent", "acp"], expectAgent: /cursor/i })
  try {
    const availability = await cursor.detect!()
    console.log("cursor detect:", JSON.stringify(availability))
    // On the owner's Mac `agent` is Grok's alias (~/.grok/bin/agent → grok).
    const agent = Bun.which("agent")
    if (agent && realpathSync(agent).includes("/.grok/")) expect(availability.available).toBe(false)
  } finally {
    await cursor.dispose!()
  }
})

// Added 2026-10-30: Gemini CLI, goose and Qwen Code over the generic ACP adapter. Each needs its own login on this Mac
// (gemini: Google sign-in; goose: ~/.config/goose provider; qwen: ~/.qwen/.env). A turn that reads a file must ask
// first in the agent's "ask" mode, and a second turn plus a fresh process keep the conversation.
const NEW_AGENTS: Array<{ id: string; label: string; command: string[]; ask: string }> = [
  { id: "gemini", label: "Gemini CLI", command: ["gemini", "--acp"], ask: "ask" },
  { id: "goose", label: "goose", command: ["goose", "acp"], ask: "ask" },
  { id: "qwen", label: "Qwen Code", command: ["qwen", "--acp"], ask: "ask" },
]
const ONLY = process.env.RUDDER_SMOKE_AGENTS?.split(",")

for (const agent of NEW_AGENTS) {
  test.skipIf(!SMOKE || (ONLY !== undefined && !ONLY.includes(agent.id)))(
    `${agent.id}: asks before a tool, keeps context, resumes in a fresh process`,
    async () => {
      const cwd = mkdtempSync(join(tmpdir(), "rudder-acp-smoke-"))
      await Bun.write(join(cwd, "note.txt"), "The code word is PINEAPPLE.\n")
      const make = () => createAcpAdapter({ spec: spec(agent.id, agent.label), command: agent.command })
      const adapter = make()
      let nativeId: string | undefined
      try {
        console.log(agent.id, "detect", JSON.stringify(await adapter.detect!()))
        const asked: string[] = []
        const first = context(cwd, {
          permissionMode: agent.ask,
          askPermission: async (request) => {
            asked.push(`${request.kind}:${request.title} [${request.options.map((option) => option.kind).join(",")}]`)
            return request.options.find((option) => option.kind === "allow_once")?.id ?? request.options[0]?.id ?? null
          },
        })
        await adapter.reply("Read the file note.txt in the current folder and tell me the code word. Reply with only the word.", first.ctx)
        console.log(agent.id, "turn1", JSON.stringify(first.reply()), "asked", JSON.stringify(asked), summary(first.events).slice(0, 12))
        expect(first.reply()).toMatch(/PINEAPPLE/i)
        nativeId = first.native()
        expect(nativeId).toBeTruthy()

        const second = context(cwd, { nativeId, permissionMode: agent.ask })
        await adapter.reply("What was the code word? Do not use any tools. Reply with only the word.", second.ctx)
        console.log(agent.id, "turn2", JSON.stringify(second.reply()))
        expect(second.reply()).toMatch(/PINEAPPLE/i)
        console.log(agent.id, "models", JSON.stringify(await adapter.listModels?.()))
      } finally {
        await adapter.dispose!()
      }
      const fresh = make()
      try {
        const third = context(cwd, { nativeId, permissionMode: agent.ask })
        await fresh.reply("Repeat the code word from earlier in this conversation. Do not use any tools. Reply with only the word.", third.ctx)
        console.log(agent.id, "turn3", JSON.stringify(third.reply()))
        expect(third.native()).toBe(nativeId)
        expect(third.reply()).toMatch(/PINEAPPLE/i)
      } finally {
        await fresh.dispose!()
      }
    },
    300_000,
  )
}
