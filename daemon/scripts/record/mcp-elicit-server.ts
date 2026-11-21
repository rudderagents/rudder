// 2026-11-17: a stdio MCP server for recordings. Its one tool, `order_pizza`, asks the user through MCP elicitation
// (`elicitation/create`, form mode) with every field type the spec allows: multi-select, single-select, boolean,
// number and free text. The tool's result echoes the answer so the agent's follow-up shows what arrived.
// Hand-rolled JSON-RPC (newline-delimited), no SDK: recordings must not depend on a package version.

type Json = Record<string, unknown>

// What the recorders answer the form with.
export const PIZZA = { toppings: ["cheese", "olive"], size: "l", crust: "thin", extraSauce: true, count: 2, note: "no onions" }

const SCHEMA = {
  type: "object",
  properties: {
    toppings: {
      type: "array",
      title: "Toppings",
      description: "Pick any number",
      items: { type: "string", enum: ["cheese", "mushroom", "olive", "pepper"] },
    },
    size: { type: "string", title: "Size", oneOf: [{ const: "s", title: "Small" }, { const: "l", title: "Large" }] },
    crust: { type: "string", title: "Crust", enum: ["thin", "thick"] },
    extraSauce: { type: "boolean", title: "Extra sauce", default: false },
    count: { type: "number", title: "How many", minimum: 1, maximum: 5 },
    note: { type: "string", title: "Note for the kitchen", maxLength: 80 },
  },
  required: ["toppings", "size"],
}

let nextId = 1
const waiting = new Map<number, (message: Json) => void>()

function send(message: Json) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`)
}

function request(method: string, params: Json): Promise<Json> {
  const id = nextId++
  send({ id, method, params })
  return new Promise((resolve) => waiting.set(id, resolve))
}

async function handle(message: Json) {
  const { id, method } = message
  if (method === undefined) {
    waiting.get(id as number)?.(message)
    waiting.delete(id as number)
    return
  }
  const params = (message.params ?? {}) as Json
  switch (method) {
    case "initialize":
      return send({
        id,
        result: {
          protocolVersion: params.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "rudder-probe", version: "0.1.0" },
        },
      })
    case "tools/list":
      return send({
        id,
        result: {
          tools: [
            {
              name: "order_pizza",
              description: "Ask the user how they want their pizza (a form), then return their choices.",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        },
      })
    case "tools/call": {
      const answer = await request("elicitation/create", { mode: "form", message: "How do you want your pizza?", requestedSchema: SCHEMA })
      const result = (answer.result ?? answer.error ?? {}) as Json
      return send({ id, result: { content: [{ type: "text", text: `elicitation result: ${JSON.stringify(result)}` }] } })
    }
    case "ping":
      return send({ id, result: {} })
    default:
      if (id !== undefined) send({ id, error: { code: -32601, message: `Method not found: ${String(method)}` } })
  }
}

let buffer = ""
if (import.meta.main) for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk)
  let newline = buffer.indexOf("\n")
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (line) void handle(JSON.parse(line) as Json)
    newline = buffer.indexOf("\n")
  }
}
