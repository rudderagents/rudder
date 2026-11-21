// Newline-delimited JSON-RPC 2.0 over a child's stdio, as ACP agents and `codex app-server` speak it.
import { errorMessage, isObject, type Json } from "./json"
import { spawnLines, type LineProcess } from "./stdio"

export type RpcId = number | string

export class RpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message)
  }
}

// Returned by onRequest to leave a server request unanswered (the server already resolved it).
export const NO_REPLY = Symbol("no reply")

export type RpcHandlers = {
  onNotification(method: string, params: unknown, meta?: unknown): void
  // Resolve to answer; throw RpcError (or anything) to send a JSON-RPC error.
  onRequest(method: string, params: unknown, id: RpcId): Promise<unknown>
  onClose(error: Error): void
}

export type RpcOptions = {
  cwd?: string
  // Used in error messages; defaults to command[0].
  name?: string
  // Timeout for request() calls that pass none; unset means none.
  defaultTimeoutMs?: number
  formatStderr?: (tail: string) => string
  // Defaults to spawnLines' cap.
  maxLineLength?: number
}

export type Rpc = {
  // timeoutMs 0 waits forever.
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>
  notify(method: string, params?: unknown): void
  readonly pid: number
  readonly closed: boolean
  close(): Promise<void>
}

type Pending = { method: string; resolve: (value: unknown) => void; reject: (error: Error) => void; timer?: Timer }

function lastLines(tail: string) {
  return tail.trim().split("\n").slice(-3).join("\n")
}

export function spawnRpc(command: string[], handlers: RpcHandlers, options: RpcOptions = {}): Rpc {
  const name = options.name ?? command[0] ?? "agent"
  const pending = new Map<number, Pending>()
  let nextId = 1
  let closedError: Error | undefined

  const send = (message: Json) => {
    if (!closedError) proc.write(JSON.stringify({ jsonrpc: "2.0", ...message }))
  }

  const answer = async (id: RpcId, method: string, params: unknown) => {
    try {
      const result = await handlers.onRequest(method, params, id)
      if (result !== NO_REPLY) send({ id, result: result ?? null })
    } catch (error) {
      send({ id, error: { code: error instanceof RpcError ? error.code : -32603, message: errorMessage(error) } })
    }
  }

  const onLine = (line: string) => {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (!isObject(message)) return
    const id = message.id
    const method = typeof message.method === "string" ? message.method : undefined
    if (method && (typeof id === "number" || typeof id === "string")) return void answer(id, method, message.params)
    if (method) return handlers.onNotification(method, message.params, message._meta)
    // Responses to ids we never sent (Grok's "skills-reload") are dropped.
    const entry = typeof id === "number" ? pending.get(id) : undefined
    if (!entry) return
    pending.delete(id as number)
    clearTimeout(entry.timer)
    if (isObject(message.error)) {
      const error = message.error
      const code = typeof error.code === "number" ? error.code : -32603
      const text = typeof error.message === "string" ? error.message : `${entry.method} failed`
      entry.reject(new RpcError(entry.method, code, text, error.data))
    } else {
      entry.resolve(message.result)
    }
  }

  const proc: LineProcess = spawnLines(command, {
    cwd: options.cwd,
    onLine,
    formatStderr: options.formatStderr ?? lastLines,
    maxLineLength: options.maxLineLength,
  })

  const shutdown = (error: Error) => {
    if (closedError) return
    closedError = error
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    pending.clear()
    handlers.onClose(error)
  }

  void proc.exited.then((code) => {
    const tail = proc.stderrTail()
    shutdown(new Error(`${name} exited (code ${code})${tail ? `: ${tail}` : ""}`))
  })

  return {
    pid: proc.pid,
    get closed() {
      return closedError !== undefined
    },
    request<T>(method: string, params?: unknown, timeoutMs = options.defaultTimeoutMs) {
      if (closedError) return Promise.reject(new Error(closedError.message))
      const id = nextId++
      return new Promise<T>((resolve, reject) => {
        const entry: Pending = { method, resolve: resolve as (value: unknown) => void, reject }
        if (timeoutMs) {
          entry.timer = setTimeout(() => {
            pending.delete(id)
            reject(new Error(`${name} did not answer ${method} within ${timeoutMs} ms`))
          }, timeoutMs)
        }
        pending.set(id, entry)
        send({ id, method, params })
      })
    },
    notify(method: string, params?: unknown) {
      send({ method, params })
    },
    // Resolves once the process is gone (SIGTERM, then SIGKILL), so its files are free for other writers.
    async close() {
      await proc.stop()
      shutdown(new Error(`${name} stopped`))
    },
  }
}
