// r66: records `codex app-server` JSON-RPC, the requests adapter/codex.ts makes. See lib.ts.
// Free: initialize, account/read, model/list, account/rateLimits/read against the owner's own login (read only).
// Paid: conversation scenarios on DeepSeek (owner-approved 2026-11-05) under a temp CODEX_HOME with a custom
// model_provider, so the owner's ChatGPT config is never read or changed.
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { type Frame, type Recording, RpcRecording, runRecorder, type Scenario } from "./lib"
import { PIZZA } from "./mcp-elicit-server"

const MODEL = process.env.DEEPSEEK_MODEL ?? "deepseek-flash"
const BASE_URL = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com"
// Same as adapter/codex.ts.
const CLIENT_INFO = { name: "rudder", title: "Rudder", version: "0.1.0" }

async function open(rec: Recording, experimentalApi = false): Promise<RpcRecording> {
  const rpc = new RpcRecording(rec)
  await rpc.request("initialize", { clientInfo: CLIENT_INFO, capabilities: { experimentalApi, requestAttestation: false } })
  rpc.notify("initialized")
  return rpc
}

type Policy = { approve?: boolean; interrupt?: boolean; model?: string; timeoutMs?: number; plan?: boolean }

// 2026-11-17 questions: request_user_input takes each question's first option (or "blue" typed); a form elicitation
// gets PIZZA (the fields of scripts/record/mcp-elicit-server.ts).

function answerApprovals(rpc: RpcRecording, approve: boolean) {
  rpc.onRequest = (method, params) => {
    if (method.endsWith("requestApproval")) return { decision: approve ? "accept" : "decline" }
    if (method === "item/tool/requestUserInput") {
      const questions = Array.isArray(params.questions) ? (params.questions as Frame[]) : []
      const answers = Object.fromEntries(
        questions.map((question) => {
          const options = Array.isArray(question.options) ? (question.options as Frame[]) : []
          return [String(question.id), { answers: [String(options[0]?.label ?? "blue")] }]
        }),
      )
      return { answers }
    }
    if (method === "mcpServer/elicitation/request") return { action: "accept", content: PIZZA, _meta: null }
    return undefined
  }
}

async function startThread(rpc: RpcRecording, cwd: string): Promise<string> {
  // untrusted: every command asks, so approval scenarios see the request.
  const started = await rpc.request("thread/start", { cwd, approvalPolicy: "untrusted", approvalsReviewer: "user", sandbox: "workspace-write", model: MODEL })
  return String((started.thread as Frame).id)
}

/** One turn/start, answered per policy, until its turn/completed. */
async function turn(rpc: RpcRecording, threadId: string, text: string, policy: Policy = {}): Promise<Frame> {
  answerApprovals(rpc, policy.approve === true)
  const plan = policy.plan ? { collaborationMode: { mode: "plan", settings: { model: MODEL, reasoning_effort: null, developer_instructions: null } } } : {}
  const started = await rpc.request("turn/start", { threadId, input: [{ type: "text", text }], ...(policy.model ? { model: policy.model } : {}), ...plan })
  const turnId = String((started.turn as Frame).id)
  if (policy.interrupt) {
    void rpc
      .notification((method) => method === "item/agentMessage/delta", 60_000, "first delta")
      .then(() => rpc.request("turn/interrupt", { threadId, turnId }))
      .catch(() => undefined)
  }
  return rpc.notification(
    (method, params) => method === "turn/completed" && (params.turn as Frame | undefined)?.id === turnId,
    policy.timeoutMs ?? 180_000,
    "turn/completed",
  )
}

const free: Scenario[] = [
  {
    name: "handshake",
    free: true,
    summary: "initialize + initialized + account/read (owner's login, read only)",
    async run({ start }) {
      const rpc = await open(start())
      await rpc.request("account/read", {})
    },
  },
  {
    name: "models",
    free: true,
    summary: "model/list",
    async run({ start }) {
      const rpc = await open(start())
      await rpc.request("model/list", {})
    },
  },
  {
    name: "rate-limits",
    free: true,
    summary: "account/rateLimits/read (the plan's windows; no model)",
    async run({ start }) {
      const rpc = await open(start())
      await rpc.request("account/rateLimits/read", { excludeResetCreditDetails: true })
    },
  },
]

const deepseek = (scenario: Omit<Scenario, "free" | "keys">): Scenario => ({ ...scenario, free: false, keys: true })

const ASK = "Before doing anything, use your request_user_input tool to ask me one question: which color, red or blue (two options). Then tell me my answer and stop."

const paid: Scenario[] = [
  deepseek({
    name: "ask-plan",
    cost: "DeepSeek <¥0.01",
    summary: "request_user_input in plan collaboration mode (experimentalApi), answered with the first option (2026-11-17)",
    async run({ start, cwd }) {
      const rpc = await open(start(), true)
      await turn(rpc, await startThread(rpc, cwd), ASK, { plan: true, approve: true })
    },
  }),
  deepseek({
    name: "ask-default",
    cost: "DeepSeek <¥0.01",
    summary: "request_user_input in default mode with features.default_mode_request_user_input (experimentalApi) (2026-11-17)",
    async run({ start, cwd }) {
      const rpc = await open(start(), true)
      await turn(rpc, await startThread(rpc, cwd), ASK, { approve: true })
    },
  }),
  deepseek({
    name: "ask-default-stable",
    cost: "DeepSeek <¥0.01",
    summary: "ask-default without experimentalApi: does request_user_input still arrive? (2026-11-17)",
    async run({ start, cwd }) {
      const rpc = await open(start())
      await turn(rpc, await startThread(rpc, cwd), ASK, { approve: true })
    },
  }),
  deepseek({
    name: "elicit-form",
    cost: "DeepSeek <¥0.01",
    summary: "an MCP tool that asks a form (multi-select, select, boolean, number, text) through elicitation, accepted (2026-11-17)",
    async run({ start, cwd }) {
      const rpc = await open(start())
      await turn(rpc, await startThread(rpc, cwd), "Call the order_pizza tool, then tell me exactly what it returned.", { approve: true })
    },
  }),
  deepseek({
    name: "turn-ok",
    cost: "DeepSeek <¥0.01",
    summary: "one plain turn",
    async run({ start, cwd }) {
      const rpc = await open(start())
      await turn(rpc, await startThread(rpc, cwd), "Reply with the single word: ok")
    },
  }),
  deepseek({
    name: "wake-child",
    cost: "DeepSeek <¥0.02",
    summary: "spawn a subagent on a 20 s shell task and end the parent turn without waiting; kept 60 s for the child's end (2026-11-17)",
    async run({ start, cwd }) {
      const rpc = await open(start())
      await turn(
        rpc,
        await startThread(rpc, cwd),
        "Use your spawn_agent tool to start one subagent that runs the shell command `sleep 20 && echo CHILD_DONE` and reports its output. Do not wait for it: say spawned and end your turn.",
        { approve: true },
      )
      await Bun.sleep(60_000)
    },
  }),
  deepseek({
    name: "tool-bash",
    cost: "DeepSeek <¥0.01",
    summary: "a shell command, approved",
    async run({ start, cwd }) {
      const rpc = await open(start())
      await turn(rpc, await startThread(rpc, cwd), "Run the shell command `echo rudder`, then say done.", { approve: true })
    },
  }),
  deepseek({
    name: "perm-deny",
    cost: "DeepSeek <¥0.01",
    summary: "a shell command, declined",
    async run({ start, cwd }) {
      const rpc = await open(start())
      await turn(rpc, await startThread(rpc, cwd), "Run the shell command `echo rudder`.", { approve: false })
    },
  }),
  deepseek({
    name: "interrupt",
    cost: "DeepSeek <¥0.01",
    summary: "turn/interrupt once the reply starts streaming",
    async run({ start, cwd }) {
      const rpc = await open(start())
      await turn(rpc, await startThread(rpc, cwd), "Count slowly from 1 to 300, one number per line.", { interrupt: true })
    },
  }),
  deepseek({
    name: "resume",
    cost: "DeepSeek <¥0.01",
    summary: "a turn, then a new app-server, thread/resume and a second turn",
    async run({ start, cwd }) {
      const first = start()
      const rpc = await open(first)
      const threadId = await startThread(rpc, cwd)
      await turn(rpc, threadId, "Remember the word lantern. Reply ok.")
      await first.close()
      const again = await open(start())
      await again.request("thread/resume", { threadId })
      await turn(again, threadId, "What word did I ask you to remember?")
    },
  }),
  deepseek({
    name: "fork",
    cost: "DeepSeek <¥0.01",
    summary: "a turn, then thread/fork and a turn on the copy",
    async run({ start, cwd }) {
      const rpc = await open(start())
      const threadId = await startThread(rpc, cwd)
      await turn(rpc, threadId, "Remember the word lantern. Reply ok.")
      const forked = await rpc.request("thread/fork", { threadId })
      await turn(rpc, String((forked.thread as Frame).id), "What word?")
    },
  }),
  deepseek({
    name: "set-model",
    cost: "DeepSeek <¥0.01",
    summary: "two turns, the second with turn/start model",
    async run({ start, cwd }) {
      const rpc = await open(start())
      const threadId = await startThread(rpc, cwd)
      await turn(rpc, threadId, "Reply ok.")
      await turn(rpc, threadId, "Reply ok again.", { model: MODEL })
    },
  }),
  deepseek({
    name: "compaction",
    cost: "DeepSeek <¥0.01",
    summary: "thread/compact/start after one turn",
    async run({ start, cwd }) {
      const rpc = await open(start())
      const threadId = await startThread(rpc, cwd)
      const first = await turn(rpc, threadId, "Reply ok.")
      const firstId = (first.params as Frame).turn as Frame
      await rpc.request("thread/compact/start", { threadId })
      // Compaction runs as its own turn; the first turn's turn/completed is already in the buffer.
      await rpc.notification(
        (method, params) => method === "thread/compacted" || (method === "turn/completed" && (params.turn as Frame).id !== firstId.id),
        120_000,
        "compaction end",
      )
    },
  }),
  deepseek({
    name: "auth-error",
    cost: "free (the key is refused)",
    summary: "a wrong key: the provider's 401",
    afterKeys: ["DEEPSEEK_API_KEY=sk-invalid-recording-key-000000", "export DEEPSEEK_API_KEY"],
    async run({ start, cwd }) {
      const rpc = await open(start())
      await turn(rpc, await startThread(rpc, cwd), "Reply ok.", { timeoutMs: 120_000 })
    },
  }),
]

await runRecorder({
  agent: "codex",
  cli: "codex",
  argv: ["codex", "app-server"],
  scenarios: [...free, ...paid],
  setup: (home, scenario): Record<string, string> => {
    if (!scenario.keys) return {}
    const config = [
      `model = "${MODEL}"`,
      `model_provider = "deepseek"`,
      "",
      "[model_providers.deepseek]",
      `name = "DeepSeek"`,
      `base_url = "${BASE_URL}/v1"`,
      `env_key = "DEEPSEEK_API_KEY"`,
      `wire_api = "responses"`,
      "",
    ].join("\n")
    const extra = [
      ...(scenario.name.startsWith("ask-default") ? ["[features]", "default_mode_request_user_input = true", ""] : []),
      ...(scenario.name === "elicit-form"
        ? ["[mcp_servers.probe]", `command = "${process.execPath}"`, `args = ["${join(import.meta.dir, "mcp-elicit-server.ts")}"]`, ""]
        : []),
    ].join("\n")
    writeFileSync(join(home, "config.toml"), config + extra)
    return { CODEX_HOME: home }
  },
})
