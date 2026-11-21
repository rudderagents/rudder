// Scripted stand-in for `claude -p --input-format stream-json`, driven by claude.test.ts.
// argv: <scenario.jsonl | -> <stdin log> ...claude flags
// Scenario lines go to stdout in order, except the steps {"await": "user" | "control_response" | "interrupt" | "stop_task" | "set_model"},
// {"sleep": ms}, {"stderr": text} and {"exit": code}. A {"get_usage": response} line is not written: it is the answer to
// the get_usage control request (without one, get_usage is answered as unsupported, like an older CLI). Likewise an
// {"account": {...}} line is the account in the answer to initialize, and an {"initialize": {...}} line the rest of that
// answer (without either, initialize is unsupported, like a CLI with no session_state: the adapter's older path). "$SID" becomes the --resume / --session-id value, and a
// "permissionMode": "$MODE" the current mode (the launch flag, then each set_permission_mode; "manual" reads "default").
// Control requests the host sends are logged and answered the way the real CLI answers them.
import { appendFileSync, readFileSync } from "node:fs"
import { claudeSteps, isRecording } from "../recorded"

// biome-ignore lint/suspicious/noExplicitAny: test double reading arbitrary JSON-RPC frames loosely
type Frame = Record<string, any>

const [scenarioPath = "-", logPath = "", ...flags] = process.argv.slice(2)
const flag = (name: string) => {
  const index = flags.indexOf(name)
  return index >= 0 ? flags[index + 1] : undefined
}
// --fork-session runs under the new --session-id, like the real CLI.
const sid = (flags.includes("--fork-session") ? flag("--session-id") : undefined) ?? flag("--resume") ?? flag("--session-id") ?? "00000000-0000-4000-8000-000000000000"
let mode = flag("--permission-mode") === "manual" ? "default" : (flag("--permission-mode") ?? "default")
// A recording (scripts/record, r66) replays through the same steps; see recorded.ts for the mapping.
const steps: Frame[] =
  scenarioPath === "-"
    ? []
    : isRecording(scenarioPath)
      ? claudeSteps(scenarioPath).map((step) => JSON.parse(JSON.stringify(step).replaceAll("$SID", sid)))
      : readFileSync(scenarioPath, "utf8")
          .split("\n")
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line.replaceAll("$SID", sid)))
const usage = steps.find((step) => "get_usage" in step)?.get_usage
if (usage) steps.splice(steps.findIndex((step) => "get_usage" in step), 1)
const account = steps.find((step) => "account" in step)?.account
if (account) steps.splice(steps.findIndex((step) => "account" in step), 1)
// {"initialize": {...}}: the rest of the answer to initialize (session_state, capabilities), as a 2.1.312 CLI gives it.
const initialize = steps.find((step) => "initialize" in step)?.initialize
if (initialize) steps.splice(steps.findIndex((step) => "initialize" in step), 1)
// {"refuse": "<subtype>"}: that control request is answered as unsupported, like an older CLI.
const refused = new Set(steps.filter((step) => "refuse" in step).map((step) => String(step.refuse)))
for (let index = steps.length - 1; index >= 0; index--) if ("refuse" in steps[index]!) steps.splice(index, 1)

const MODELS = [
  { value: "default", displayName: "Default (recommended)", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
  { value: "haiku", displayName: "Haiku 5.5", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
  { value: "opus", displayName: "Opus 5.5", supportsEffort: true, supportedEffortLevels: ["low", "high"], supportsFastMode: true },
  { value: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5", supportsThinkingOff: true },
]

// The session-state switch the host launched this process with, for the tests that check it.
if (logPath) appendFileSync(`${logPath}.env`, `${JSON.stringify({ CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: process.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS ?? null })}\n`)

const inbox: Frame[] = []
let wake: (() => void) | undefined
let ended = false

function write(frame: Frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`)
}

function success(requestId: string, response?: Frame) {
  write({ type: "control_response", response: { subtype: "success", request_id: requestId, ...(response ? { response } : {}) } })
}

function receive(frame: Frame) {
  if (logPath) appendFileSync(logPath, `${JSON.stringify(frame)}\n`)
  if (frame.type === "control_request") {
    const request = frame.request ?? {}
    if (request.subtype === "get_context_usage") return success(frame.request_id, { totalTokens: 17582, maxTokens: 1000000, percentage: 2 })
    if (request.subtype === "list_models") return success(frame.request_id, { models: MODELS })
    // A recording awaits set_model: what the CLI writes in answer (its local-command echo) follows the request.
    if (request.subtype === "set_model") {
      success(frame.request_id)
      inbox.push(frame)
      wake?.()
      return
    }
    if (request.subtype === "get_usage" && usage) return success(frame.request_id, usage)
    if (request.subtype === "initialize" && (account || initialize)) return success(frame.request_id, { ...initialize, ...(account ? { account } : {}) })
    if (request.subtype === "apply_flag_settings" && !refused.has("apply_flag_settings")) return success(frame.request_id)
    if (request.subtype === "set_permission_mode") {
      mode = request.mode
      success(frame.request_id, { mode: request.mode })
      return write({ type: "system", subtype: "status", status: null, permissionMode: request.mode, session_id: sid })
    }
    // Claude Code 2.1.312 answers stop_task with an empty success; the scenario awaits it to write the stopped task.
    if (request.subtype === "stop_task") {
      success(frame.request_id, {})
      inbox.push(frame)
      wake?.()
      return
    }
    if (request.subtype !== "interrupt") {
      return write({
        type: "control_response",
        response: { subtype: "error", request_id: frame.request_id, error: `Unsupported control request subtype: ${request.subtype}` },
      })
    }
    success(frame.request_id, { still_queued: [] })
  }
  inbox.push(frame)
  wake?.()
}

function matches(frame: Frame, want: string) {
  if (want === "interrupt" || want === "stop_task" || want === "set_model") return frame.type === "control_request" && frame.request?.subtype === want
  return frame.type === want
}

async function next(want: string): Promise<Frame | undefined> {
  for (;;) {
    const index = inbox.findIndex((frame) => matches(frame, want))
    if (index >= 0) return inbox.splice(index, 1)[0]
    if (ended) return undefined
    await new Promise<void>((resolve) => {
      wake = resolve
    })
  }
}

async function readStdin() {
  const decoder = new TextDecoder()
  let buffer = ""
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true })
    let newline = buffer.indexOf("\n")
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line) receive(JSON.parse(line))
      newline = buffer.indexOf("\n")
    }
  }
  ended = true
  wake?.()
}

async function exit(code: number): Promise<never> {
  await new Promise<void>((resolve) => process.stdout.write("", () => resolve()))
  process.exit(code)
}

const reading = readStdin()
for (const step of steps) {
  if ("await" in step) {
    if (!(await next(step.await))) await exit(0)
  } else if ("sleep" in step) await Bun.sleep(step.sleep)
  else if ("stderr" in step) process.stderr.write(step.stderr)
  else if ("exit" in step) await exit(step.exit)
  else write(step.permissionMode === "$MODE" ? { ...step, permissionMode: mode } : step)
}
await reading
await exit(0)
