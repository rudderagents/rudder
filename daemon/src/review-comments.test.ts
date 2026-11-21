import { describe, expect, test } from "bun:test"
import { FAKE_SPEC } from "./adapter/fake"
import type { AdapterContext, AgentAdapter, AgentSpec, PermissionRequest } from "./adapter/types"
import type { Frame } from "./protocol"
import { SessionService } from "./session-service"
import { Store } from "./store"

async function waitFor(predicate: () => boolean, timeoutMs = 3000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out")
    await Bun.sleep(5)
  }
}

function payload(frame: Frame): Record<string, unknown> {
  return (frame.payload ?? {}) as Record<string, unknown>
}

const EDIT: PermissionRequest = {
  tool: "Edit",
  title: "Edit refresh.ts",
  detail: "src/refresh.ts",
  kind: "edit",
  toolId: "tool-1",
  options: [
    { id: "allow", label: "Allow", kind: "allow_once" },
    { id: "reject", label: "Deny", kind: "reject_once" },
  ],
}

const COMMENTS = [{ path: "src/refresh.ts", line: 40, text: "Keep 60s, just add the skew" }]
const NOTE = "Revise this turn's changes per the 1 comment below:\n1. src/refresh.ts:40 …\n   Keep 60s, just add the skew"

function harness(transport: AgentSpec["transport"], reply: AgentAdapter["reply"], steer?: AgentAdapter["steer"]) {
  const events: Frame[] = []
  const store = new Store(":memory:")
  const spec: AgentSpec = { ...FAKE_SPEC, id: "a", label: "A", transport, capabilities: { ...FAKE_SPEC.capabilities, steer: steer !== undefined } }
  const adapter: AgentAdapter = { spec, reply, ...(steer ? { steer } : {}) }
  const service = new SessionService(store, adapter, (frame) => events.push(frame))
  const named = (name: string) => events.filter((event) => event.name === name)
  async function call(method: string, params: Record<string, unknown>) {
    const frame = await service.invoke(method, params, method)
    if (frame.type !== "result") throw new Error(`${method}: ${JSON.stringify(frame.error)}`)
    return (frame.result ?? {}) as Record<string, unknown>
  }
  const asked = () => named("message.append").map(payload).find((message) => message.kind === "permission")
  return { store, events, service, named, call, asked }
}


describe("permission.respond comments", () => {
  test("Claude: the comments become the deny message of the same request", async () => {
    let note: string | undefined
    let choice = null as string | null
    const h = harness("claude", async (_text, ctx: AdapterContext) => {
      choice = await ctx.askPermission(EDIT)
      note = ctx.reviewNote?.("tool-1")
    })
    const id = h.store.createSession({ agent: "a" }).id
    await h.call("message.send", { sessionId: id, text: "go" })
    await waitFor(() => h.asked() !== undefined)
    const permission = h.asked()!.permission as { id: string }
    await h.call("permission.respond", { id: permission.id, optionId: "reject", comments: COMMENTS, note: NOTE })
    await waitFor(() => choice !== null)
    expect(choice).toBe("reject")
    expect(note).toBe(NOTE)
    expect(h.named("queue.upsert").length).toBe(0)
  })

  test("ACP: Rudder sends the comments as the next message, marked relay", async () => {
    let turns = 0
    const texts: string[] = []
    const h = harness("acp", async (text, ctx) => {
      turns++
      texts.push(text)
      if (turns === 1) await ctx.askPermission(EDIT)
    })
    const id = h.store.createSession({ agent: "a" }).id
    await h.call("message.send", { sessionId: id, text: "go" })
    await waitFor(() => h.asked() !== undefined)
    const permission = h.asked()!.permission as { id: string }
    await h.call("permission.respond", { id: permission.id, optionId: "reject", comments: COMMENTS, note: NOTE })
    await waitFor(() => turns === 2)
    expect(texts[1]).toBe(NOTE)
    const relayed = h.named("message.append").map(payload).find((message) => message.role === "user" && message.text === NOTE)
    expect(relayed?.origin).toBe("relay")
  })

  test("Codex: steered into the running turn", async () => {
    const steered: string[] = []
    let release: () => void = () => {}
    const h = harness(
      "codex",
      async (_text, ctx) => {
        await ctx.askPermission(EDIT)
        await new Promise<void>((resolve) => {
          release = resolve
        })
      },
      async (_sessionId, text) => {
        steered.push(text)
        return true
      },
    )
    const id = h.store.createSession({ agent: "a" }).id
    await h.call("message.send", { sessionId: id, text: "go" })
    await waitFor(() => h.asked() !== undefined)
    const permission = h.asked()!.permission as { id: string }
    await h.call("permission.respond", { id: permission.id, optionId: "reject", comments: COMMENTS, note: NOTE })
    await waitFor(() => steered.length === 1)
    expect(steered[0]).toBe(NOTE)
    await waitFor(() => h.named("message.append").map(payload).some((message) => message.origin === "relay"))
    release()
  })

  test("approving keeps the comments on the phone; bad comments are refused", async () => {
    const h = harness("acp", async (_text, ctx) => {
      await ctx.askPermission(EDIT)
      await ctx.askPermission({ ...EDIT, toolId: "tool-2" })
    })
    const id = h.store.createSession({ agent: "a" }).id
    await h.call("message.send", { sessionId: id, text: "go" })
    await waitFor(() => h.asked() !== undefined)
    const first = h.asked()!.permission as { id: string }
    const bad = await h.service.invoke("permission.respond", { id: first.id, optionId: "reject", comments: [{ path: "x" }], note: NOTE }, "x")
    expect(bad.type).toBe("error")
    await h.call("permission.respond", { id: first.id, optionId: "allow", comments: COMMENTS, note: NOTE })
    expect(h.named("queue.upsert").length).toBe(0)
  })

  test("message.send origin review is kept on the user message", async () => {
    const h = harness("acp", async () => {})
    const id = h.store.createSession({ agent: "a" }).id
    await h.call("message.send", { sessionId: id, text: NOTE, origin: "review" })
    const sent = h.named("message.append").map(payload).find((message) => message.role === "user")
    expect(sent?.origin).toBe("review")
  })
})
