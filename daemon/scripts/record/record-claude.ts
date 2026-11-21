// r66: records `claude -p` stream-json, the same flags adapter/claude.ts launches with. See lib.ts.
// Free: initialize, list_models, get_usage (control requests answered before any user message; no model call).
// Paid scenarios use haiku and are not run without the owner's approval (--run --paid).
// --safe-mode keeps the owner's hooks, CLAUDE.md, skills and MCP servers out of the recording (their SessionStart
// hook output is private); auth, models and built-in tools behave as in the daemon's launch.
import { join } from "node:path"
import { type Frame, type Recording, runRecorder, type Scenario } from "./lib"
import { PIZZA } from "./mcp-elicit-server"

const MODEL = "haiku"
const STREAM_FLAGS = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"]
const SESSION_FLAGS = [...STREAM_FLAGS, "--include-partial-messages", "--replay-user-messages", "--thinking-display", "summarized", "--permission-prompt-tool", "stdio"]
// 2026-11-18: the daemon launches sessions with this, so the CLI reports system/session_state_changed (turn end).
const SESSION_ENV = { CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1" }
// Rudder's ask mode (claudePermissionFlag("ask")); without it the owner's default (auto) approves Bash itself.
const ASK_FLAGS = ["--permission-mode", "manual"]

// system/init still names the owner's plugins, skills and commands under --safe-mode: kept as counts.
const LOCAL_LISTS = ["plugins", "skills", "slash_commands", "mcp_servers", "agents"]

export function elideLocal(frame: Frame, scenario?: Scenario): { frame: Frame; note: string } | undefined {
  // The state-* scenarios send initialize first, as the daemon does; only what the adapter reads from its answer stays.
  const answer = frame.type === "control_response" ? ((frame.response as Frame | undefined)?.response as Frame | undefined) : undefined
  if (scenario?.name.startsWith("state-") && answer && "session_state" in answer) {
    const kept = { session_state: answer.session_state, capabilities: answer.capabilities }
    return { frame: { ...frame, response: { ...(frame.response as Frame), response: kept } }, note: "initialize response (all but session_state, capabilities)" }
  }
  if (frame.type !== "system" || frame.subtype !== "init") return undefined
  const out: Frame = { ...frame }
  for (const key of LOCAL_LISTS) if (Array.isArray(out[key])) out[key] = [`<elided: ${(out[key] as unknown[]).length}>`]
  // The owner's own output style (seen without --safe-mode).
  if (typeof out.output_style === "string" && out.output_style !== "default") out.output_style = "<elided>"
  return { frame: out, note: `system/init ${LOCAL_LISTS.join(" ")}` }
}

let nextRequest = 0

async function control(rec: Recording, request: Frame, timeoutMs = 30_000): Promise<Frame> {
  const id = `rec_${++nextRequest}`
  rec.send({ type: "control_request", request_id: id, request })
  const reply = await rec.waitFor(
    (frame) => frame.type === "control_response" && (frame.response as Frame | undefined)?.request_id === id,
    timeoutMs,
    `${String(request.subtype)} reply`,
  )
  return reply.response as Frame
}

type Policy = {
  /** Answer to can_use_tool: allow, deny, or answer an AskUserQuestion with its first option. */
  tools?: "allow" | "deny"
  /** Called on every frame; may send (interrupt, stop_task). */
  onFrame?: (frame: Frame, rec: Recording) => void
  timeoutMs?: number
}

/** One user message, answered per policy, until `result` (and, with background tasks, until they settle). */
// The policy of the turn in progress, per process: one frame listener each, set up on its first turn.
const policies = new WeakMap<Recording, Policy>()

async function turn(rec: Recording, text: string, policy: Policy = {}): Promise<Frame> {
  const listening = policies.has(rec)
  policies.set(rec, policy)
  if (!listening) listen(rec)
  rec.send({ type: "user", message: { role: "user", content: [{ type: "text", text }] }, parent_tool_use_id: null, session_id: "" })
  return rec.waitFor((frame) => frame.type === "result", policy.timeoutMs ?? 120_000, "result", true)
}

function listen(rec: Recording) {
  rec.onFrame((frame) => {
    const policy = policies.get(rec) ?? {}
    policy.onFrame?.(frame, rec)
    if (frame.type !== "control_request") return
    const request = frame.request as Frame
    const id = frame.request_id
    // 2026-11-17: an MCP server's form (elicitation), if the CLI forwards one, gets PIZZA.
    if (request.subtype === "elicitation") {
      rec.send({ type: "control_response", response: { subtype: "success", request_id: id, response: { action: "accept", content: PIZZA } } })
      return
    }
    if (request.subtype !== "can_use_tool") return
    const input = (request.input ?? {}) as Frame
    let response: Frame
    if (request.tool_name === "AskUserQuestion") {
      const questions = Array.isArray(input.questions) ? (input.questions as Frame[]) : []
      const answers = Object.fromEntries(
        // A multi-select question gets its first two options, comma-joined the way adapter/json.ts flattens them.
        questions.map((question) => {
          const labels = ((question.options as Frame[] | undefined) ?? []).map((option) => String(option.label ?? ""))
          return [String(question.question), question.multiSelect === true ? labels.slice(0, 2).join(", ") : (labels[0] ?? "")]
        }),
      )
      response = { behavior: "allow", updatedInput: { ...input, answers } }
    } else if (policy.tools === "allow") response = { behavior: "allow", updatedInput: input }
    else response = { behavior: "deny", message: "The user declined this tool use." }
    rec.send({ type: "control_response", response: { subtype: "success", request_id: id, response } })
  })
}

// session_state_changed idle frames seen per process (state-* scenarios).
const idles = new WeakMap<Recording, number>()

function watchIdle(rec: Recording) {
  if (idles.has(rec)) return
  idles.set(rec, 0)
  rec.onFrame((frame) => {
    if (frame.type === "system" && frame.subtype === "session_state_changed" && frame.state === "idle") idles.set(rec, (idles.get(rec) ?? 0) + 1)
  })
}

async function untilIdle(rec: Recording, count: number, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while ((idles.get(rec) ?? 0) < count) {
    if (Date.now() > deadline) throw new Error(`no idle #${count} within ${timeoutMs} ms`)
    await Bun.sleep(50)
  }
}

function say(rec: Recording, text: string) {
  rec.send({ type: "user", message: { role: "user", content: [{ type: "text", text }] }, parent_tool_use_id: null, session_id: "" })
}

/** A state-* process: started like the daemon's, initialize answered, idle frames counted. */
async function stateProcess(start: (extraArgs?: string[]) => Recording): Promise<Recording> {
  const rec = start(["--model", MODEL])
  watchIdle(rec)
  await control(rec, { subtype: "initialize" })
  return rec
}

const isTextDelta = (frame: Frame) =>
  frame.type === "stream_event" && (frame.event as Frame | undefined)?.type === "content_block_delta" && ((frame.event as Frame).delta as Frame | undefined)?.type === "text_delta"

// After the first result, keep listening this long for what the CLI says by itself (the 2.1.312 stop_task case).
const TAIL_MS = 15_000

const free: Scenario[] = [
  {
    name: "handshake",
    free: true,
    summary: "control_request initialize (commands, models, account); no user message",
    async run({ start }) {
      await control(start(), { subtype: "initialize" })
    },
  },
  {
    name: "models",
    free: true,
    summary: "control_request list_models",
    async run({ start }) {
      await control(start(), { subtype: "list_models" })
    },
  },
  {
    name: "usage",
    free: true,
    summary: "control_request get_usage (the plan's windows; reads the account, no model)",
    async run({ start }) {
      await control(start(["--no-session-persistence"]), { subtype: "get_usage", skip_behaviors: true })
    },
  },
]

const paid: Scenario[] = [
  {
    name: "turn-ok",
    free: false,
    cost: "~$0.002",
    summary: "one plain turn on haiku",
    async run({ start }) {
      await turn(start(["--model", MODEL]), "Reply with the single word: ok")
    },
  },
  {
    name: "tool-bash",
    free: false,
    cost: "~$0.004",
    summary: "Bash tool, approved through can_use_tool",
    async run({ start }) {
      await turn(start(["--model", MODEL]), "Run `touch rudder.txt` with the Bash tool, then say done.", { tools: "allow" })
    },
  },
  {
    name: "perm-deny",
    free: false,
    cost: "~$0.004",
    summary: "Bash tool, declined",
    async run({ start }) {
      await turn(start(["--model", MODEL]), "Run `touch rudder.txt` with the Bash tool.", { tools: "deny" })
    },
  },
  {
    name: "ask-multi",
    free: false,
    cost: "~$0.004",
    summary: "AskUserQuestion with multiSelect, answered with the first two options comma-joined (2026-11-17)",
    async run({ start }) {
      await turn(
        start(["--model", MODEL]),
        "Use the AskUserQuestion tool with multiSelect true to ask which toppings I want (cheese, mushroom, olive), then tell me exactly what I picked.",
        { tools: "deny" },
      )
    },
  },
  {
    name: "elicit-form",
    free: false,
    cost: "~$0.004",
    summary: "an MCP tool asking a form through elicitation (scripts/record/mcp-elicit-server.ts), tool allowed (2026-11-17)",
    // --safe-mode turns MCP servers off; instead only this server (--strict-mcp-config) and no hooks (disableAllHooks).
    dropArgs: ["--safe-mode"],
    async run({ start }) {
      const config = JSON.stringify({ mcpServers: { probe: { command: process.execPath, args: [join(import.meta.dir, "mcp-elicit-server.ts")] } } })
      const flags = ["--model", MODEL, "--strict-mcp-config", "--mcp-config", config, "--settings", JSON.stringify({ disableAllHooks: true })]
      await turn(start(flags), "Call the mcp__probe__order_pizza tool, then tell me exactly what it returned.", { tools: "allow" })
    },
  },
  {
    name: "ask",
    free: false,
    cost: "~$0.004",
    summary: "AskUserQuestion, answered with the first option",
    async run({ start }) {
      await turn(start(["--model", MODEL]), "Use the AskUserQuestion tool to ask me to pick red or blue, then tell me my pick.", { tools: "deny" })
    },
  },
  {
    name: "interrupt",
    free: false,
    cost: "~$0.003",
    summary: "interrupt control request once text starts streaming",
    async run({ start }) {
      let sent = false
      await turn(start(["--model", MODEL]), "Count slowly from 1 to 200, one number per line.", {
        onFrame: (frame, rec) => {
          if (sent || frame.type !== "stream_event") return
          sent = true
          void control(rec, { subtype: "interrupt" }).catch(() => undefined)
        },
      })
    },
  },
  {
    name: "background-done",
    free: false,
    cost: "~$0.006",
    summary: "background Bash (sleep 5) left to finish on its own; tail kept",
    async run({ start }) {
      const rec = start(["--model", MODEL])
      await turn(rec, "Start `sleep 5 && echo finished` with the Bash tool in the background (run_in_background), then say started.", { tools: "allow" })
      await Bun.sleep(TAIL_MS)
    },
  },
  {
    name: "background-stop",
    free: false,
    cost: "~$0.006",
    summary: "background Bash (sleep 60); after the first result, stop_task; tail kept (checks the 2.1.312 silence)",
    async run({ start }) {
      const rec = start(["--model", MODEL])
      let taskId: unknown
      await turn(rec, "Start `sleep 60` with the Bash tool in the background (run_in_background), then say started.", {
        tools: "allow",
        onFrame: (frame) => {
          if (frame.type === "system" && frame.subtype === "task_started") taskId ??= frame.task_id
        },
      })
      // The speech has ended on a running task, as when the phone shows 全部停止.
      if (taskId === undefined) throw new Error("no task_started before the result")
      await control(rec, { subtype: "stop_task", task_id: taskId })
      await Bun.sleep(TAIL_MS)
    },
  },
  {
    name: "wake-after-result",
    free: false,
    cost: "~$0.01",
    summary: "two background sleeps (4 s, 20 s); kept 45 s after the first result for output after the turn (2026-11-17)",
    async run({ start }) {
      const rec = start(["--model", MODEL])
      await turn(
        rec,
        "Start `sleep 4 && echo A` and `sleep 20 && echo B` with the Bash tool, each in the background (run_in_background), then say started and stop.",
        { tools: "allow" },
      )
      await Bun.sleep(45_000)
    },
  },
  {
    name: "wake-agent",
    free: false,
    cost: "~$0.02",
    summary: "a background (async) Agent subagent; kept 60 s after the first result for its notification and the follow-up (2026-11-17)",
    async run({ start }) {
      const rec = start(["--model", MODEL])
      await turn(
        rec,
        "Use the Agent tool to launch one subagent in the background that runs `sleep 12` with Bash and then replies exactly DONE. Say launched and stop; do not wait for it.",
        { tools: "allow" },
      )
      await Bun.sleep(60_000)
    },
  },
  {
    name: "resume",
    free: false,
    cost: "~$0.004",
    summary: "a turn, then a new process with --resume and a second turn",
    async run({ start }) {
      const first = start(["--model", MODEL])
      const result = await turn(first, "Remember the word lantern. Reply ok.")
      await first.close()
      await turn(start(["--model", MODEL, "--resume", String(result.session_id)]), "What word did I ask you to remember?")
    },
  },
  {
    name: "fork",
    free: false,
    cost: "~$0.004",
    summary: "a turn, then --resume --fork-session and a second turn",
    async run({ start }) {
      const first = start(["--model", MODEL])
      const result = await turn(first, "Remember the word lantern. Reply ok.")
      await first.close()
      const id = crypto.randomUUID()
      await turn(start(["--model", MODEL, "--resume", String(result.session_id), "--fork-session", "--session-id", id]), "What word?")
    },
  },
  {
    name: "set-model",
    free: false,
    cost: "~$0.004",
    summary: "set_model control request between two turns",
    async run({ start }) {
      const rec = start(["--model", MODEL])
      await turn(rec, "Reply ok.")
      await control(rec, { subtype: "set_model", model: MODEL })
      await turn(rec, "Reply ok again.")
    },
  },
  {
    name: "compaction",
    free: false,
    cost: "~$0.01",
    summary: "/compact after one turn",
    async run({ start }) {
      const rec = start(["--model", MODEL])
      await turn(rec, "Reply ok.")
      await turn(rec, "/compact")
    },
  },
  // 2026-11-18 turn end on the CLI's idle signal (plan 2026-11-18-turn-end-authoritative, probes A–G).
  {
    name: "state-turn",
    free: false,
    cost: "~$0.002",
    summary: "A: one turn with session state events: running, result, idle",
    async run({ start }) {
      const rec = await stateProcess(start)
      say(rec, "Reply with the single word: ok")
      await untilIdle(rec, 1)
      await Bun.sleep(1_000)
    },
  },
  {
    name: "state-steer-folded",
    free: false,
    cost: "~$0.004",
    summary: "B: a line written during a foreground `sleep 6` is folded into that run: one result, then idle",
    async run({ start }) {
      const rec = await stateProcess(start)
      let steered = false
      policies.set(rec, {
        tools: "allow",
        onFrame: (frame) => {
          const content = frame.type === "assistant" ? (((frame.message as Frame | undefined)?.content as Frame[] | undefined) ?? []) : []
          if (steered || !content.some((block) => block.type === "tool_use" && block.name === "Bash")) return
          steered = true
          setTimeout(() => say(rec, "Also add the word lantern to your final answer."), 2_000)
        },
      })
      listen(rec)
      say(rec, "Run `sleep 6` with the Bash tool (not in the background), then say done.")
      await untilIdle(rec, 1)
      await Bun.sleep(3_000)
    },
  },
  {
    name: "state-steer-queued",
    free: false,
    cost: "~$0.004",
    summary: "C: a line written while the final text streams runs after it: result, init, result, then one idle",
    async run({ start }) {
      const rec = await stateProcess(start)
      let steered = false
      policies.set(rec, {
        onFrame: (frame) => {
          if (steered || !isTextDelta(frame)) return
          steered = true
          say(rec, "Then reply with the single word: done")
        },
      })
      listen(rec)
      say(rec, "Write one paragraph of about 120 words about lighthouses.")
      await untilIdle(rec, 1)
      await Bun.sleep(3_000)
    },
  },
  {
    name: "state-background",
    free: false,
    cost: "~$0.006",
    summary: "D: background Bash (sleep 5): result, idle with the task listed, notification, running, result, idle",
    async run({ start }) {
      const rec = await stateProcess(start)
      policies.set(rec, { tools: "allow" })
      listen(rec)
      say(rec, "Start `sleep 5 && echo finished` with the Bash tool in the background (run_in_background), then say started.")
      await untilIdle(rec, 2, 90_000)
      await Bun.sleep(2_000)
    },
  },
  {
    name: "state-background-stop",
    free: false,
    cost: "~$0.006",
    summary: "background Bash (sleep 60): result, idle with the task listed, stop_task; tail kept (what follows the stop)",
    async run({ start }) {
      const rec = await stateProcess(start)
      let taskId: unknown
      policies.set(rec, {
        tools: "allow",
        onFrame: (frame) => {
          if (frame.type === "system" && frame.subtype === "task_started") taskId ??= frame.task_id
        },
      })
      listen(rec)
      say(rec, "Start `sleep 60` with the Bash tool in the background (run_in_background), then say started.")
      await untilIdle(rec, 1)
      if (taskId === undefined) throw new Error("no task_started before the idle")
      await control(rec, { subtype: "stop_task", task_id: taskId })
      await Bun.sleep(TAIL_MS)
    },
  },
  {
    name: "state-background-agent",
    free: false,
    cost: "~$0.02",
    summary: "F: a background subagent (sleep 8): no idle until it finished and the follow-up result",
    async run({ start }) {
      const rec = await stateProcess(start)
      policies.set(rec, { tools: "allow" })
      listen(rec)
      say(
        rec,
        "Use the Agent tool to launch one subagent in the background that runs `sleep 8` with Bash and then replies exactly DONE. Say launched and stop; do not wait for it.",
      )
      await untilIdle(rec, 1, 120_000)
      await Bun.sleep(3_000)
    },
  },
  {
    name: "state-interrupt-queued",
    free: false,
    cost: "~$0.003",
    summary: "G: a queued line, then interrupt {cancel_queued: true} while text streams: the queued line does not run",
    async run({ start }) {
      const rec = await stateProcess(start)
      let sent = false
      policies.set(rec, {
        onFrame: (frame) => {
          if (sent || !isTextDelta(frame)) return
          sent = true
          say(rec, "Reply with the single word: queued")
          setTimeout(() => void control(rec, { subtype: "interrupt", cancel_queued: true }).catch(() => undefined), 300)
        },
      })
      listen(rec)
      say(rec, "Count slowly from 1 to 200, one number per line.")
      await untilIdle(rec, 1)
      await Bun.sleep(4_000)
    },
  },
  {
    name: "state-set-model",
    free: false,
    cost: "~$0.004",
    summary: "E: a turn, set_model on the warm process (its isReplay local-command echo), then a second turn",
    async run({ start }) {
      const rec = await stateProcess(start)
      say(rec, "Reply with the single word: ok")
      await untilIdle(rec, 1)
      await control(rec, { subtype: "set_model", model: "sonnet" })
      await control(rec, { subtype: "set_permission_mode", mode: "acceptEdits" })
      await Bun.sleep(1_000)
      say(rec, "Reply with the single word: again")
      await untilIdle(rec, 2)
      await Bun.sleep(1_000)
    },
  },
  // No logged-out scenario: an empty CLAUDE_CONFIG_DIR may still sign in from the keychain and call the model for
  // real (owner, 2026-11-05). The matrix lists it as not covered.
]

if (import.meta.main) await runRecorder({
  agent: "claude",
  cli: "claude",
  argv: ["claude", ...SESSION_FLAGS, ...ASK_FLAGS, "--safe-mode"],
  setup: () => SESSION_ENV,
  elide: (frame, scenario) => elideLocal(frame, scenario),
  scenarios: [...free, ...paid],
})
