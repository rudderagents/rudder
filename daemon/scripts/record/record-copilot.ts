// 2026-11-17: records `copilot --acp --stdio` (GitHub Copilot CLI) on the owner's own GitHub login (owner-approved
// 2026-11-17). Copilot starts the owner's MCP servers like Grok does: their names are kept as counts. See lib.ts / acp.ts.
import { COPILOT_CAPABILITIES_META } from "../../src/adapter/acp"
import { acpFreeScenarios, acpPaidScenarios, newSession, prompt, setCapabilitiesMeta } from "./acp"
import { type Frame, runRecorder, type Scenario } from "./lib"
import { elideLocal } from "./record-grok"

// 2026-11-17: the same subagent event opt-in rudderd sends (adapter/acp.ts).
setCapabilitiesMeta(COPILOT_CAPABILITIES_META)

const COST = "owner's Copilot premium requests"
const IDLE_EVENTS = ["session.idle", "assistant.idle", "assistant.turn_start", "assistant.turn_end", "session.background_tasks_changed"]
const sessionEvent = (type: string) => (method: string, params: Frame) => method === "github.com/copilot/sessionEvent" && params.type === type

// 2026-11-17: what a continuation turn meets on Copilot: work that outlives the turn, and a question to the user.
const extraScenarios: Scenario[] = [
  {
    name: "wake-subagent",
    free: false,
    cost: COST,
    summary: "a background task subagent (sleep 20, reply DONE), the turn ended at once; kept 40 s after subagent.completed",
    async run({ start, cwd }) {
      const session = await newSession(start(), cwd)
      await prompt(
        session,
        "Use your task tool with agent_type general-purpose in background mode to start one subagent that runs `sleep 20` and then replies exactly DONE. Do not wait for it: say launched and end your turn.",
        { approve: true, timeoutMs: 180_000 },
      )
      await session.rpc.notification(sessionEvent("subagent.completed"), 120_000, "subagent.completed").catch(() => undefined)
      await Bun.sleep(40_000)
    },
  },
  {
    name: "background-done",
    free: false,
    cost: COST,
    summary: "a shell command left running in the background (sleep 5 && echo finished), the turn ended at once; kept 40 s",
    async run({ start, cwd }) {
      const session = await newSession(start(), cwd)
      await prompt(
        session,
        "Start `sleep 5 && echo finished` as a background (async / detached) shell command. Do not wait for it: say started and end your turn.",
        { approve: true, timeoutMs: 180_000 },
      )
      await Bun.sleep(40_000)
    },
  },
  {
    // 2026-11-18 (plan turn-end-authoritative step 4): does Copilot say when its own run after end_turn is over? The
    // candidates from its session-events schema (1.0.112) are opted in beside the subagent ones.
    name: "idle-background",
    free: false,
    cost: COST,
    summary: "a detached background `sleep 15` with the idle / turn / background-task session events opted in; kept until the session.idle after Copilot's own run (≤ 150 s)",
    async run({ start, cwd }) {
      setCapabilitiesMeta({ "github.com/copilot": { events: [...COPILOT_CAPABILITIES_META["github.com/copilot"].events, ...IDLE_EVENTS] } })
      try {
        const session = await newSession(start(), cwd)
        await prompt(
          session,
          "Start `sleep 15 && echo finished` as a background (async / detached) shell command. Do not wait for it: say started and end your turn.",
          { approve: true, timeoutMs: 180_000 },
        )
        // Copilot's own run after end_turn (it reads the command's output and speaks), then whatever ends it. Fresh
        // frames only: the prompt's own session.idle comes before its answer.
        const event = (type: string) => (frame: Frame) => frame.method === "github.com/copilot/sessionEvent" && (frame.params as Frame | undefined)?.type === type
        await session.rpc.rec.waitFor(event("assistant.turn_start"), 60_000, "assistant.turn_start after end_turn", true)
        await session.rpc.rec.waitFor(event("session.idle"), 120_000, "session.idle after the self-started run", true).catch(() => undefined)
        await Bun.sleep(5_000)
      } finally {
        setCapabilitiesMeta(COPILOT_CAPABILITIES_META)
      }
    },
  },
  {
    name: "ask",
    free: false,
    cost: COST,
    summary: "the agent's ask-the-user tool (red or blue); whatever request it sends is answered as the recorder can",
    async run({ start, cwd }) {
      await prompt(await newSession(start(), cwd), "Use your ask-user tool to ask me to pick red or blue, then tell me my pick.", { approve: true, timeoutMs: 180_000 })
    },
  },
]

await runRecorder({
  agent: "copilot",
  elide: (frame) => elideLocal(frame),
  cli: "copilot",
  argv: ["copilot", "--acp", "--stdio", "--no-auto-update"],
  scenarios: [
    ...acpFreeScenarios({ session: true, keys: false }),
    // auth-error needs a separate login to break; Copilot's comes from the owner's GitHub account.
    ...acpPaidScenarios(new Set(["auth-error"])).map((scenario) => ({ ...scenario, keys: false, cost: COST })),
    ...extraScenarios,
  ],
})
