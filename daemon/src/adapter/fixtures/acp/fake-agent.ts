// Scripted ACP agent for offline tests: bun fake-agent.ts <scenario.json> <log.jsonl>
// Replays hand-trimmed, sanitized shapes from the Grok / Copilot research captures.
// Every message received from the client is appended to the log so tests can assert replies.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"

type Json = Record<string, unknown>
type Step =
  | { update: Json }
  | { request: { method: string; params?: Json } }
  | { notify: { method: string; params?: unknown; _meta?: unknown } }
  | { respond: { id: unknown; result: unknown } }
  | { waitCancel: true }
  | { sleep: number }
  | { exit: number }
  | { result: Json; continue?: boolean }
  | { error: Json }
  // Answers the prompt with this error in the first process only (a marker beside the log); later processes skip it.
  | { errorFirstSpawn: Json }

type Scenario = {
  exitOnStart?: { code: number; stderr: string }
  initialize: Json
  newSession?: Json
  // session/update notifications sent right after session/new answers (Grok and Copilot advertise commands then).
  newSessionUpdates?: Json[]
  newError?: Json
  loadAfter?: { delay: number; update: Json; meta: Json }
  loadReplay?: Json[]
  // session/load replays sent before the answer, each on its own method with its own _meta (Grok's _x.ai/session/update).
  loadReplayFrames?: { method: string; update: Json; _meta?: Json }[]
  // session/list pages: the first answers a call without a cursor, page n+1 the cursor "page-n".
  listPages?: Json[][]
  loadResult?: Json
  resumeResult?: Json
  // Model ids whose reasoning_effort option set fails the way Copilot's does (claude-sonnet-5.5).
  refuseEffortFor?: string[]
  turns: Record<string, Step[]>
}

const [scenarioPath, logPath] = process.argv.slice(2)
// Sidecar, not the JSON-RPC log: tests assert received() === [] and answers() by method === undefined.
if (logPath) appendFileSync(`${logPath}.argv`, `${JSON.stringify(process.argv)}\n`)
const scenario = JSON.parse(readFileSync(scenarioPath!, "utf8")) as Scenario

if (scenario.exitOnStart) {
  process.stderr.write(`${scenario.exitOnStart.stderr}\n`)
  process.exit(scenario.exitOnStart.code)
}

let sessions = 0
let agentRequestId = 0
const waiting = new Map<number, (message: Json) => void>()
const cancelWaiters = new Map<string, () => void>()
const cancelled = new Set<string>()
const config = new Map<string, Json[]>()

function send(message: Json) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`)
}

function update(sessionId: string, body: Json) {
  send({ method: "session/update", params: { sessionId, update: body } })
}

function ask(method: string, params: Json): Promise<Json> {
  const id = agentRequestId++
  send({ id, method, params })
  return new Promise((resolve) => waiting.set(id, resolve))
}

function waitCancel(sessionId: string): Promise<void> {
  if (cancelled.has(sessionId)) return Promise.resolve()
  return new Promise((resolve) => cancelWaiters.set(sessionId, resolve))
}

async function prompt(id: unknown, sessionId: string, text: string) {
  cancelled.delete(sessionId)
  const steps = scenario.turns[text] ?? [{ update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } }, { result: { stopReason: "end_turn" } }]
  for (const step of steps) {
    if ("update" in step) update(sessionId, step.update)
    else if ("request" in step) await ask(step.request.method, { sessionId, ...step.request.params })
    else if ("notify" in step) send({ method: step.notify.method, params: step.notify.params, _meta: step.notify._meta })
    else if ("respond" in step) send({ id: step.respond.id, result: step.respond.result })
    else if ("waitCancel" in step) await waitCancel(sessionId)
    else if ("sleep" in step) await Bun.sleep(step.sleep)
    else if ("exit" in step) process.exit(step.exit)
    else if ("result" in step) {
      send({ id, result: step.result })
      if (step.continue) continue
      return
    }
    else if ("error" in step) return send({ id, error: step.error })
    else if ("errorFirstSpawn" in step) {
      const marker = `${logPath}.${text}.errored`
      if (existsSync(marker)) continue
      writeFileSync(marker, "")
      return send({ id, error: step.errorFirstSpawn })
    }
  }
}

function handle(message: Json) {
  appendFileSync(logPath!, `${JSON.stringify(message)}\n`)
  const { id, method } = message
  const params = (message.params ?? {}) as Json
  const sessionId = String(params.sessionId ?? "")
  if (method === undefined) {
    waiting.get(id as number)?.(message)
    waiting.delete(id as number)
    return
  }
  switch (method) {
    case "initialize":
      return send({ id, result: scenario.initialize })
    case "session/new": {
      if (scenario.newError) return send({ id, error: scenario.newError })
      sessions += 1
      const created = `sess-${sessions}`
      config.set(created, structuredClone((scenario.newSession?.configOptions as Json[]) ?? []))
      send({ id, result: { ...scenario.newSession, sessionId: created } })
      for (const item of scenario.newSessionUpdates ?? []) update(created, item)
      return
    }
    // Grok answers -32602 "unknown session id" for sessions it no longer has.
    case "session/resume":
    case "session/load":
      if (sessionId.startsWith("missing")) return send({ id, error: { code: -32602, message: "Invalid params", data: "unknown session id" } })
      // A slow agent that never answers the reopen (the adapter's request timeout fires).
      if (sessionId.startsWith("slow")) return
      if (method === "session/resume") return send({ id, result: scenario.resumeResult ?? {} })
      for (const replayed of scenario.loadReplay ?? []) update(sessionId, replayed)
      for (const frame of scenario.loadReplayFrames ?? []) {
        send({ method: frame.method, params: { sessionId, update: frame.update, ...(frame._meta ? { _meta: frame._meta } : {}) } })
      }
      send({ id, result: scenario.loadResult ?? {} })
      if (scenario.loadAfter) {
        const after = scenario.loadAfter
        setTimeout(() => send({ method: "session/update", params: { sessionId, update: after.update, _meta: after.meta } }), after.delay)
      }
      return
    case "session/set_mode":
      update(sessionId, { sessionUpdate: "current_mode_update", currentModeId: params.modeId })
      return send({ id, result: {} })
    case "session/set_config_option": {
      const options = config.get(sessionId) ?? []
      const option = options.find((entry) => entry.id === params.configId)
      if (!option) return send({ id, error: { code: -32602, message: "unknown config option" } })
      const model = options.find((entry) => entry.category === "model")?.currentValue
      if (option.category === "thought_level" && typeof model === "string" && scenario.refuseEffortFor?.includes(model)) {
        return send({ id, error: { code: -32603, message: "This model does not support reasoning_effort configuration" } })
      }
      option.currentValue = params.value
      return send({ id, result: { configOptions: options } })
    }
    case "session/set_model": {
      const meta = (params._meta ?? {}) as Json
      const value = meta.contextWindow
      if (typeof value === "number") {
        send({
          method: "_x.ai/session_notification",
          params: { sessionId, update: { sessionUpdate: "model_changed", model_id: params.modelId, context_window_selection: value } },
        })
      }
      return send({ id, result: { _meta: { model: { Ok: String(params.modelId ?? "") } } } })
    }
    case "session/prompt": {
      const text = ((params.prompt as Json[])[0]?.text as string) ?? ""
      void prompt(id, sessionId, text)
      return
    }
    case "session/list": {
      const pages = scenario.listPages ?? [[]]
      const cursor = typeof params.cursor === "string" ? params.cursor : undefined
      const index = cursor ? Number(cursor.slice("page-".length)) : 0
      const sessions = pages[index] ?? []
      return send({ id, result: { sessions, nextCursor: index + 1 < pages.length ? `page-${index + 1}` : null } })
    }
    // Copilot advertises sessionCapabilities.close; the detect probe uses it.
    case "session/close":
      return send({ id, result: {} })
    case "session/cancel":
      cancelled.add(sessionId)
      cancelWaiters.get(sessionId)?.()
      cancelWaiters.delete(sessionId)
      return
    default:
      if (id !== undefined) send({ id, error: { code: -32601, message: "Method not found" } })
  }
}

const decoder = new TextDecoder()
let buffer = ""
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true })
  let index = buffer.indexOf("\n")
  while (index >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line) handle(JSON.parse(line) as Json)
    index = buffer.indexOf("\n")
  }
}
