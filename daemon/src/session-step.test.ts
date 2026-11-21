import { describe, expect, test } from "bun:test"
import { FAKE_SPEC } from "./adapter/fake"
import type { AgentAdapter } from "./adapter/types"
import type { Frame } from "./protocol"
import { SessionService, stepFor } from "./session-service"
import { Store } from "./store"

async function waitFor(predicate: () => boolean, timeoutMs = 2000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out")
    await Bun.sleep(5)
  }
}

function payload(frame: Frame): Record<string, unknown> {
  return (frame.payload ?? {}) as Record<string, unknown>
}

describe("v48 H1 session step", () => {
  test("stepFor names the file for edits and the command for execute, nothing for other kinds", () => {
    expect(stepFor({ kind: "edit", detail: "/w/app/Sources/Refresh.swift" })).toEqual({ kind: "edit", text: "Refresh.swift" })
    expect(stepFor({ kind: "edit", detail: "", diffs: [{ path: "src/a.ts", newText: "x" }] })).toEqual({ kind: "edit", text: "a.ts" })
    expect(stepFor({ kind: "execute", detail: "bun install --frozen-lockfile\necho done" })).toEqual({
      kind: "execute",
      text: "bun install --frozen-lockfile",
    })
    expect(stepFor({ kind: "read", detail: "README.md" })).toBeNull()
    expect(stepFor({ kind: "execute", detail: "x".repeat(200) })?.text?.length).toBe(80)
  })

  test("session.upsert carries the running tool, the open thought, and nothing once the turn ends", async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const adapter: AgentAdapter = {
      spec: { ...FAKE_SPEC, id: "s", label: "s" },
      async reply(_text, ctx) {
        ctx.emit({ type: "reasoning", id: "r1", text: "hmm", done: false })
        ctx.emit({ type: "reasoning", id: "r1", text: "hmm", done: true })
        ctx.emit({ type: "tool", id: "t1", tool: "Bash", title: "Install", kind: "execute", status: "running", detail: "bun install" })
        ctx.emit({ type: "tool", id: "t1", tool: "Bash", title: "Install", kind: "execute", status: "completed", detail: "bun install" })
        ctx.emit({ type: "tool", id: "t2", tool: "Edit", title: "Edit", kind: "edit", status: "running", detail: "/w/a/Refresh.swift" })
        await gate
      },
    }
    const store = new Store(":memory:")
    const events: Frame[] = []
    const service = new SessionService(store, adapter, (frame) => events.push(frame))
    const id = store.createSession({ agent: "s" }).id
    const steps = () =>
      events
        .filter((event) => event.name === "session.upsert" && payload(event).id === id)
        .map((event) => payload(event).step ?? null)
    await service.invoke("message.send", { sessionId: id, text: "go" }, "1")
    await waitFor(() => steps().some((step) => JSON.stringify(step) === JSON.stringify({ kind: "edit", text: "Refresh.swift" })))
    const seen = steps().filter((step, index, all) => JSON.stringify(step) !== JSON.stringify(all[index - 1]))
    expect(seen).toContainEqual({ kind: "think" })
    expect(seen).toContainEqual({ kind: "execute", text: "bun install" })
    release()
    await waitFor(() =>
      events.some((event) => event.name === "agent.status" && payload(event).sessionId === id && payload(event).status === "idle"),
    )
    expect(steps().at(-1)).toBeNull()
  })
})
