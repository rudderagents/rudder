// r66: shared ACP scenarios (Grok, Qwen Code, goose, pi), the requests adapter/acp.ts makes. See lib.ts.
import { join } from "node:path"
import { type Frame, type Recording, RpcRecording, type Scenario } from "./lib"
import { PIZZA } from "./mcp-elicit-server"

// Same as adapter/acp.ts CLIENT_INFO: fs / terminal off.
const CLIENT_INFO = {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  clientInfo: { name: "rudderd", version: "0.1.0" },
}

export type AcpSession = { rpc: RpcRecording; init: Frame; sessionId: string; created: Frame }

// Agent-specific `clientCapabilities._meta` (Copilot's event opt-in), set by the recorder before it runs.
let capabilitiesMeta: Frame | undefined
export function setCapabilitiesMeta(meta: Frame) {
  capabilitiesMeta = meta
}

export async function initialize(rec: Recording): Promise<{ rpc: RpcRecording; init: Frame }> {
  const rpc = new RpcRecording(rec)
  const params = capabilitiesMeta ? { ...CLIENT_INFO, clientCapabilities: { ...CLIENT_INFO.clientCapabilities, _meta: capabilitiesMeta } } : CLIENT_INFO
  const init = await rpc.request("initialize", params, 60_000)
  return { rpc, init }
}

export async function newSession(rec: Recording, cwd: string, mcpServers: Frame[] = []): Promise<AcpSession> {
  const { rpc, init } = await initialize(rec)
  const created = await rpc.request("session/new", { cwd, mcpServers }, 60_000)
  return { rpc, init, created, sessionId: String(created.sessionId) }
}

type Policy = { approve?: boolean; cancel?: boolean; timeoutMs?: number }

/** One session/prompt, permissions answered per policy, until its response. */
export async function prompt(session: AcpSession, text: string, policy: Policy = {}): Promise<Frame> {
  const { rpc, sessionId } = session
  rpc.onRequest = (method, params) => {
    // Grok's structured question: the first option of each, joined the way adapter/acp.ts answers.
    if (method === "_x.ai/ask_user_question") {
      const questions = Array.isArray(params.questions) ? (params.questions as Frame[]) : []
      // A multi-select question gets its first two labels, comma-joined like adapter/json.ts flattenAnswers.
      const answers = Object.fromEntries(
        questions.map((item) => {
          const labels = ((item.options as Frame[] | undefined) ?? []).map((option) => String(option.label ?? ""))
          return [String(item.question), item.multiSelect === true ? labels.slice(0, 2).join(", ") : (labels[0] ?? "")]
        }),
      )
      return { outcome: "accepted", answers }
    }
    // 2026-11-17: an MCP form forwarded by the agent gets PIZZA. Grok's `_x.ai/mcp/elicit` answer is tagged by `outcome`
    // like its ask_user_question (an MCP-style `action` was refused as malformed and the call cancelled).
    if (method === "_x.ai/mcp/elicit") return { outcome: "accept", content: PIZZA }
    if (method.toLowerCase().includes("elicit")) return { action: "accept", content: PIZZA }
    if (method !== "session/request_permission") return undefined
    const options = Array.isArray(params.options) ? (params.options as Frame[]) : []
    const want = policy.approve ? "allow_once" : "reject_once"
    const option = options.find((entry) => entry.kind === want) ?? options.find((entry) => String(entry.kind).startsWith(policy.approve ? "allow" : "reject"))
    return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } }
  }
  if (policy.cancel) {
    void rpc
      .notification((method, params) => method === "session/update" && (params.update as Frame | undefined)?.sessionUpdate === "agent_message_chunk", 60_000, "first chunk")
      .then(() => rpc.notify("session/cancel", { sessionId }))
      .catch(() => undefined)
  }
  return rpc.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] }, policy.timeoutMs ?? 180_000)
}

/**
 * Approval scenarios need the agent's ask-every-time mode (Qwen Code starts in `auto`, a classifier that runs
 * `touch` without asking). Switched with session/set_mode, as the daemon does for Rudder's ask mode.
 */
async function askMode(session: AcpSession) {
  const modes = session.created.modes as Frame | undefined
  const list = Array.isArray(modes?.availableModes) ? (modes.availableModes as Frame[]).map((mode) => String(mode.id)) : []
  const ask = ["default", "agent", "approve", "ask", "manual"].find((id) => list.includes(id))
  if (ask && ask !== modes?.currentModeId) await session.rpc.request("session/set_mode", { sessionId: session.sessionId, modeId: ask }, 30_000)
}

/** A model id other than the current one, from session/new `models`, for set-model. */
function otherModel(created: Frame): string | undefined {
  const models = created.models as Frame | undefined
  const list = Array.isArray(models?.availableModels) ? (models.availableModels as Frame[]) : []
  const current = models?.currentModelId
  return String(list.find((entry) => entry.modelId !== current)?.modelId ?? current ?? "") || undefined
}

const COST = "DeepSeek <¥0.01"

/** The conversation scenarios every ACP agent with a test key runs. `skip` drops ones the agent cannot do. */
export function acpPaidScenarios(skip: Set<string> = new Set()): Scenario[] {
  const all: Scenario[] = [
    {
      name: "turn-ok",
      free: false,
      keys: true,
      cost: COST,
      summary: "one plain turn",
      async run({ start, cwd }) {
        await prompt(await newSession(start(), cwd), "Reply with the single word: ok")
      },
    },
    {
      name: "tool-bash",
      free: false,
      keys: true,
      cost: COST,
      summary: "a shell command, approved through session/request_permission",
      async run({ start, cwd }) {
        const session = await newSession(start(), cwd)
        await askMode(session)
        await prompt(session, "Run the shell command `touch rudder.txt` (a write, so it needs approval), then say done.", { approve: true })
      },
    },
    {
      name: "perm-deny",
      free: false,
      keys: true,
      cost: COST,
      summary: "a shell command, declined",
      async run({ start, cwd }) {
        const session = await newSession(start(), cwd)
        await askMode(session)
        await prompt(session, "Run the shell command `touch rudder.txt`.", { approve: false })
      },
    },
    {
      name: "interrupt",
      free: false,
      keys: true,
      cost: COST,
      summary: "session/cancel once the reply starts streaming",
      async run({ start, cwd }) {
        await prompt(await newSession(start(), cwd), "Count slowly from 1 to 300, one number per line.", { cancel: true })
      },
    },
    {
      name: "resume",
      free: false,
      keys: true,
      cost: COST,
      summary: "a turn, then a new process, session/load (or session/resume) and a second turn",
      async run({ start, cwd }) {
        const first = start()
        const session = await newSession(first, cwd)
        await prompt(session, "Remember the word lantern. Reply ok.")
        await first.close()
        const { rpc, init } = await initialize(start())
        const caps = (init.agentCapabilities ?? {}) as Frame
        const method = caps.loadSession ? "session/load" : "session/resume"
        await rpc.request(method, { sessionId: session.sessionId, cwd, mcpServers: [] }, 60_000)
        await prompt({ rpc, init, created: {}, sessionId: session.sessionId }, "What word did I ask you to remember?")
      },
    },
    {
      name: "fork",
      free: false,
      keys: true,
      cost: COST,
      summary: "a turn, then session/fork and a turn on the copy",
      async run({ start, cwd }) {
        const session = await newSession(start(), cwd)
        await prompt(session, "Remember the word lantern. Reply ok.")
        const forked = await session.rpc.request("session/fork", { sessionId: session.sessionId, cwd, mcpServers: [] }, 60_000)
        await prompt({ ...session, sessionId: String(forked.sessionId) }, "What word?")
      },
    },
    {
      name: "set-model",
      free: false,
      keys: true,
      cost: COST,
      summary: "session/set_model between two turns",
      async run({ start, cwd }) {
        const session = await newSession(start(), cwd)
        await prompt(session, "Reply ok.")
        const modelId = otherModel(session.created)
        if (!modelId) throw new Error("session/new listed no models")
        await session.rpc.request("session/set_model", { sessionId: session.sessionId, modelId }, 30_000)
        await prompt(session, "Reply ok again.")
      },
    },
    {
      name: "auth-error",
      free: false,
      keys: true,
      cost: "free (the key is refused)",
      summary: "a wrong key: how the agent reports it",
      afterKeys: ["DEEPSEEK_API_KEY=sk-invalid-recording-key-000000", "OPENAI_API_KEY=$DEEPSEEK_API_KEY", "export DEEPSEEK_API_KEY OPENAI_API_KEY"],
      async run({ start, cwd }) {
        await prompt(await newSession(start(), cwd), "Reply ok.", { timeoutMs: 120_000 })
      },
    },
    {
      name: "subagent",
      free: false,
      keys: true,
      cost: COST,
      summary: "delegate to the agent's own subagent / task tool, then report its answer (2026-11-17)",
      async run({ start, cwd }) {
        for (const [name, body] of [["alpha.txt", "one"], ["beta.txt", "two"], ["gamma.md", "three"]]) await Bun.write(`${cwd}/${name}`, body)
        const session = await newSession(start(), cwd)
        await prompt(
          session,
          "Use your subagent / task / delegate tool (not your own shell) to have a subagent count the files in the current directory and name them. When it reports back, tell me its exact answer.",
          { approve: true, timeoutMs: 300_000 },
        )
        // A subagent or its follow-up may still talk after session/prompt answers.
        await Bun.sleep(15_000)
      },
    },
    {
      name: "edit-file",
      free: false,
      keys: true,
      cost: COST,
      summary: "create, read back and edit a file: tool content (diff / text) and locations (2026-11-17)",
      async run({ start, cwd }) {
        const session = await newSession(start(), cwd)
        await prompt(
          session,
          "Create notes.txt containing the line `hello`, read it back, then change `hello` to `hello world` with your edit tool, and reply done.",
          { approve: true, timeoutMs: 240_000 },
        )
      },
    },
    {
      name: "plan",
      free: false,
      keys: true,
      cost: COST,
      summary: "a three-step task with a todo / plan list (2026-11-17)",
      async run({ start, cwd }) {
        const session = await newSession(start(), cwd)
        await prompt(
          session,
          "Make a todo list with three steps, then do them one by one, updating the list as you go: 1) create a.txt with `1`, 2) create b.txt with `2`, 3) list the directory. Reply done.",
          { approve: true, timeoutMs: 300_000 },
        )
      },
    },
    {
      name: "think",
      free: false,
      keys: true,
      cost: COST,
      summary: "a question that makes the model reason, then a multi-paragraph answer (2026-11-17)",
      async run({ start, cwd }) {
        await prompt(
          await newSession(start(), cwd),
          "Think step by step: which is larger, 2^100 or 10^30? Explain in three short paragraphs with a markdown list at the end.",
          { timeoutMs: 180_000 },
        )
      },
    },
  ]
  return all.filter((scenario) => !skip.has(scenario.name))
}

/** initialize alone, and session/new (no prompt) for the model list. */
export function acpFreeScenarios(options: { session: boolean; keys: boolean }): Scenario[] {
  const list: Scenario[] = [
    {
      name: "handshake",
      free: true,
      keys: options.keys,
      summary: "initialize (agent info, auth methods, capabilities)",
      async run({ start }) {
        await initialize(start())
      },
    },
  ]
  if (options.session) {
    list.push({
      name: "models",
      free: true,
      keys: options.keys,
      summary: "initialize + session/new: models, modes, commands (no prompt)",
      async run({ start, cwd }) {
        await newSession(start(), cwd)
        // available_commands_update and friends arrive just after session/new.
        await Bun.sleep(2000)
      },
    })
  }
  return list
}

/** The recording MCP server (scripts/record/mcp-elicit-server.ts) as an ACP stdio entry. */
export const PROBE_MCP = { name: "probe", command: process.execPath, args: [join(import.meta.dir, "mcp-elicit-server.ts")], env: [] }

/** Grok's own extensions: `_x.ai/ask_user_question` and background commands (`_x.ai/task_backgrounded`). */
export function grokExtraScenarios(cost: string): Scenario[] {
  return [
    {
      name: "ask-multi",
      free: false,
      cost,
      summary: "_x.ai/ask_user_question with a multi-select question, first two labels comma-joined (2026-11-17)",
      async run({ start, cwd }) {
        await prompt(
          await newSession(start(), cwd),
          "Use your ask-user-question tool with multiSelect true to ask which toppings I want (cheese, mushroom, olive), then tell me exactly what I picked.",
          { approve: true },
        )
      },
    },
    {
      name: "elicit-form",
      free: false,
      cost,
      summary: "an MCP tool (session/new mcpServers) asking a form through elicitation, accepted (2026-11-17)",
      async run({ start, cwd }) {
        await prompt(await newSession(start(), cwd, [PROBE_MCP]), "Call the order_pizza tool from the probe MCP server, then tell me exactly what it returned.", {
          approve: true,
          timeoutMs: 180_000,
        })
      },
    },
    {
      name: "ask",
      free: false,
      cost,
      summary: "_x.ai/ask_user_question, answered with the first option",
      async run({ start, cwd }) {
        await prompt(await newSession(start(), cwd), "Use your ask-user-question tool to ask me to pick red or blue, then tell me my pick.")
      },
    },
    {
      name: "wake-subagent",
      free: false,
      cost,
      summary: "spawn_subagent on a 20 s task and end the turn; kept until the wake prompt's turn_completed (2026-11-17)",
      async run({ start, cwd }) {
        const session = await newSession(start(), cwd)
        await prompt(
          session,
          "Use spawn_subagent to start one background subagent that runs `sleep 20` and then replies exactly DONE. Do not wait for it: say launched and end your turn.",
          { approve: true, timeoutMs: 180_000 },
        )
        await session.rpc
          .notification((method, params) => method === "_x.ai/session/update" && (params.update as Frame | undefined)?.sessionUpdate === "subagent_finished", 120_000, "subagent_finished")
          .catch(() => undefined)
        await Bun.sleep(30_000)
      },
    },
    {
      name: "background-done",
      free: false,
      cost,
      summary: "a background command (sleep 5) left to finish; the tail after the prompt answer is kept",
      async run({ start, cwd }) {
        const session = await newSession(start(), cwd)
        await askMode(session)
        await prompt(session, "Run `sleep 5 && echo finished` as a background terminal command (is_background true), then say started.", {
          approve: true,
        })
        await session.rpc
          .notification((method) => method === "_x.ai/task_completed", 30_000, "task_completed")
          .catch(() => undefined)
        await Bun.sleep(10_000)
      },
    },
  ]
}
