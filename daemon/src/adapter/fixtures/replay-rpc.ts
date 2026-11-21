// r66: replays a recorded JSON-RPC agent (Codex app-server, ACP) for the adapter that recorded it.
// Usage: bun replay-rpc.ts <replay spec> <counter file> [bank recordings...]
// The spec is recorded.ts's: `path#spawn`, `a.jsonl+b.jsonl` (b's turns after a's, with b's thread / session id
// rewritten to a's). The counter file numbers launches, so a restart (resume) plays the next spawn.
//
// The recording runs in order. A recorded client request waits until the adapter sends one with that method, and the
// recorded answer goes back under the adapter's id; a recorded client notification or answer to a server request waits
// for the adapter's (notifications give up after 2 s). Everything the agent wrote is written back as recorded.
// Requests the recording does not expect are answered from the bank (the first recorded answer to that method in any
// bank file), else with -32601 like a server without that method.
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { type Frame, parseReplay, type RecordedLine, recordedSpawn, separateIds } from "./recorded"

const [spec, counterPath, ...bankPaths] = Bun.argv.slice(2)
if (!spec || !counterPath) throw new Error("usage: replay-rpc.ts <replay spec> <counter file> [bank recordings...]")
const launch = (existsSync(counterPath) ? Number(readFileSync(counterPath, "utf8")) : 0) + 1
writeFileSync(counterPath, String(launch))

type Wire = { id?: number | string; method?: string; params?: Frame; result?: unknown; error?: unknown }
const frameOf = (line: RecordedLine): Wire | undefined => ("frame" in line ? (line.frame as Wire) : undefined)

/** The id a recording keys its conversation by: Codex thread id, ACP session id. */
function conversationId(lines: RecordedLine[]): string | undefined {
  for (const line of lines) {
    const result = line.dir === "out" ? (frameOf(line)?.result as Frame | undefined) : undefined
    const id = result?.thread?.id ?? result?.sessionId
    if (typeof id === "string") return id
  }
  return undefined
}

function script(): RecordedLine[] {
  const parts = parseReplay(spec!)
  const first = recordedSpawn(parts[0]!.path, parts.length > 1 ? parts[0]!.spawn : launch)
  if (parts.length === 1) return first
  const base = conversationId(first)
  const out = [...first]
  for (const [index, part] of parts.slice(1).entries()) {
    const lines = recordedSpawn(part.path, part.spawn).map((line) => JSON.parse(separateIds(JSON.stringify(line), index + 1)) as RecordedLine)
    const own = conversationId(lines)
    // Only the turns: from the first prompt on.
    const start = lines.findIndex((line) => line.dir === "in" && ["turn/start", "session/prompt"].includes(String(frameOf(line)?.method)))
    for (const line of lines.slice(Math.max(0, start))) {
      out.push(own && base ? (JSON.parse(JSON.stringify(line).replaceAll(own, base)) as RecordedLine) : line)
    }
  }
  return out
}

function bank(): Map<string, Wire> {
  const answers = new Map<string, Wire>()
  for (const path of bankPaths) {
    for (let spawn = 1; spawn < 5; spawn += 1) {
      const lines = recordedSpawn(path, spawn)
      if (lines.length === 0) break
      const methods = new Map<string, string>()
      for (const line of lines) {
        const frame = frameOf(line)
        if (!frame || frame.id === undefined) continue
        if (line.dir === "in" && frame.method) methods.set(String(frame.id), frame.method)
        if (line.dir === "out" && !frame.method) {
          const method = methods.get(String(frame.id))
          if (method && !answers.has(method)) answers.set(method, frame)
        }
      }
    }
  }
  return answers
}

const lines = script()
const answers = bank()
const ids = new Map<string, number | string>()
const requests: Wire[] = []
const notifications: Wire[] = []
const replies = new Map<string, Wire>()
let wake: (() => void) | undefined

const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`)

function answerFromBank(request: Wire) {
  const known = answers.get(String(request.method))
  if (known) send({ jsonrpc: "2.0", id: request.id, ...(known.error ? { error: known.error } : { result: known.result }) })
  else send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } })
}

// Methods the rest of the recording still waits for; others are answered at once.
function expectedLater(method: string, from: number) {
  return lines.slice(from).some((line) => line.dir === "in" && frameOf(line)?.method === method && frameOf(line)?.id !== undefined)
}

let cursor = 0
void (async () => {
  const decoder = new TextDecoder()
  let buffer = ""
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true })
    for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
      const text = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!text) continue
      const message = JSON.parse(text) as Wire
      if (message.method && message.id !== undefined) {
        if (expectedLater(message.method, cursor)) requests.push(message)
        else answerFromBank(message)
      } else if (message.method) notifications.push(message)
      else if (message.id !== undefined) replies.set(String(message.id), message)
      wake?.()
    }
  }
  process.exit(0)
})()

function changed(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    wake = () => {
      clearTimeout(timer)
      resolve()
    }
  })
}

async function take<T>(find: () => T | undefined, giveUpMs?: number): Promise<T | undefined> {
  const started = Date.now()
  for (;;) {
    const found = find()
    if (found !== undefined) return found
    if (giveUpMs !== undefined && Date.now() - started > giveUpMs) return undefined
    // A request the adapter sent early (it waits on the answer before sending what the recording expects next) is
    // answered from the bank rather than deadlocking.
    if (Date.now() - started > 300 && requests.length > 0) answerFromBank(requests.shift()!)
    await changed(100)
  }
}

for (; cursor < lines.length; cursor += 1) {
  const line = lines[cursor]!
  const frame = frameOf(line)
  if (!frame) continue
  if (line.dir === "in") {
    if (frame.method && frame.id !== undefined) {
      const request = await take(() => {
        const index = requests.findIndex((entry) => entry.method === frame.method)
        return index >= 0 ? requests.splice(index, 1)[0] : undefined
      })
      if (request) ids.set(String(frame.id), request.id!)
    } else if (frame.method) {
      await take(() => {
        const index = notifications.findIndex((entry) => entry.method === frame.method)
        return index >= 0 ? notifications.splice(index, 1)[0] : undefined
      }, 2000)
    } else if (frame.id !== undefined) {
      await take(() => replies.get(String(frame.id)), 5000)
    }
    continue
  }
  if (!frame.method && frame.id !== undefined) {
    const id = ids.get(String(frame.id))
    if (id !== undefined) send({ ...frame, id })
    continue
  }
  send(frame)
}
// The recording is over: anything else is answered from the bank until stdin closes.
for (;;) {
  await changed(1000)
  while (requests.length > 0) answerFromBank(requests.shift()!)
}
