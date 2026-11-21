// Scripted stand-in for `codex app-server` (offline tests). Usage: bun fake-app-server.ts <script.jsonl> <log.jsonl>
// Every client message is appended to the log as {"dir":"c2s","msg":…}; each launch first logs {"spawn":n}.
// Script directives, one JSON object per line, run in order:
//   {"expect":"<method>","result"?:…,"error"?:…,"before"?:[…]}  wait for the next client message with this method,
//                                                  send `before`, then answer it if it is a request
//   {"send":{…}}                                   write one message to the client
//   {"reply":<id>}                                 wait for the client's answer to server request <id>
//   {"when":{…},…}                                 run only if the last reply's result matches (array value = any of)
//   {"sleep":<ms>} · {"exit":<code>} (logged as {"exit":code}) · {"spawn":<n>} (lines after it run on the n-th launch)
import { appendFileSync, existsSync, readFileSync } from "node:fs"

type Message = { params?: Record<string, unknown>; id?: number | string; method?: string; result?: unknown; error?: unknown }
type Directive = {
  expect?: string
  result?: unknown
  error?: unknown
  before?: unknown[]
  send?: unknown
  reply?: number | string
  when?: Record<string, unknown>
  sleep?: number
  exit?: number
  spawn?: number
}

const [scriptPath, logPath] = Bun.argv.slice(2)
if (!scriptPath || !logPath) throw new Error("usage: fake-app-server.ts <script.jsonl> <log.jsonl>")

const log = (entry: unknown) => appendFileSync(logPath, `${JSON.stringify(entry)}\n`)
const priorLaunches = existsSync(logPath) ? readFileSync(logPath, "utf8").split("\n").filter((line) => line.startsWith('{"spawn"')).length : 0
const launch = priorLaunches + 1
log({ spawn: launch })

const directives: Directive[] = []
let section = 1
for (const line of readFileSync(scriptPath, "utf8").split("\n")) {
  if (!line.trim()) continue
  const directive = JSON.parse(line) as Directive
  if (directive.spawn !== undefined) section = directive.spawn
  else if (section === launch) directives.push(directive)
}

const savedItems = new Map<string, Map<string, unknown>>()
const inbox: Message[] = []
const replies = new Map<string, Message>()
let wake: (() => void) | undefined

void (async () => {
  const decoder = new TextDecoder()
  let buffer = ""
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true })
    for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      const message = JSON.parse(line) as Message
      log({ dir: "c2s", msg: message })
      if (message.method === "thread/items/list" && !directives.some(step => step.expect === "thread/items/list")) {
        const params = message.params ?? {}
        const items = savedItems.get(`${params.threadId}:${params.turnId}`)
        send({ id: message.id, result: { data: [...(items?.values() ?? [])].map(item => ({ turnId: params.turnId, item })), nextCursor: null } })
        continue
      }
      if (message.method === undefined && message.id !== undefined) replies.set(String(message.id), message)
      else inbox.push(message)
      wake?.()
    }
  }
  process.exit(0)
})()

function next() {
  return new Promise<void>((resolve) => {
    wake = resolve
  })
}

function send(message: unknown) {
  const frame = message as { method?: string; params?: { threadId?: string; turnId?: string; item?: { id: string }; turn?: { id: string; items?: Array<{ id: string }> } } }
  const params = frame.params
  const turnId = params?.turnId ?? params?.turn?.id
  if (params?.threadId && turnId) {
    const key = `${params.threadId}:${turnId}`
    const items = savedItems.get(key) ?? new Map<string, unknown>()
    if (frame.method === "item/completed" && params.item) items.set(params.item.id, params.item)
    for (const item of params.turn?.items ?? []) items.set(item.id, item)
    savedItems.set(key, items)
  }
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function matches(when: Record<string, unknown> | undefined, last: Message | undefined) {
  if (!when) return true
  const result = (last?.result ?? {}) as Record<string, unknown>
  return Object.entries(when).every(([key, value]) =>
    (Array.isArray(value) ? value : [value]).some((option) => JSON.stringify(result[key]) === JSON.stringify(option)),
  )
}

let lastReply: Message | undefined
for (const directive of directives) {
  if (!matches(directive.when, lastReply)) continue
  if (directive.expect !== undefined) {
    const waiting = (message: Message) => message.method === directive.expect
    while (inbox.findIndex(waiting) < 0) await next()
    const index = inbox.findIndex(waiting)
    const [message] = inbox.splice(index, 1)
    for (const early of directive.before ?? []) send(early)
    if (message?.id !== undefined) {
      send(directive.error !== undefined ? { id: message.id, error: directive.error } : { id: message.id, result: directive.result ?? {} })
    }
  } else if (directive.send !== undefined) {
    send(directive.send)
  } else if (directive.reply !== undefined) {
    const key = String(directive.reply)
    while (!replies.has(key)) await next()
    lastReply = replies.get(key)
  } else if (directive.sleep !== undefined) {
    await Bun.sleep(directive.sleep)
  } else if (directive.exit !== undefined) {
    log({ exit: directive.exit })
    process.exit(directive.exit)
  }
}
