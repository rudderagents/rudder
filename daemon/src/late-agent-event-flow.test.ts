import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAcpAdapter } from "./adapter/acp"
import { ACP_ASK, ACP_PLAN, capabilityModes } from "./adapter/modes"
import type { AgentSpec } from "./adapter/types"
import type { Frame } from "./protocol"
import { SessionService } from "./session-service"
import { Store } from "./store"

const spec: AgentSpec = { id: "grok", label: "Grok", transport: "acp", experimental: false,
  capabilities: { reasoning: true, steer: false, interrupt: true, plan: true, question: true, usage: "tokens",
    models: "dynamic", efforts: true, ...capabilityModes([ACP_ASK, ACP_PLAN]) } }

async function until(check: () => boolean) {
  const deadline = Date.now() + 5000
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for late ACP projection")
    await Bun.sleep(5)
  }
}

test("late ACP chunks patch the original task once after a newer turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "rudder-late-flow-"))
  const scenario = JSON.parse(readFileSync(join(import.meta.dir, "adapter/fixtures/acp/grok-late.json"), "utf8")) as { turns: Record<string, unknown[]> }
  const task = "a2eb8f22-bb85-4674-991f-d877982ceb46"
  const chunk = (eventId: string, chunkId: number, text: string) => ({ notify: { method: "session/update", params: {
    sessionId: "sess-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    _meta: { eventId, promptId: `task-completed-${task}`, chunkId },
  } } })
  scenario.turns.late = [...scenario.turns.late!.slice(0, -2), { sleep: 300 },
    chunk("b", 2, "B"), chunk("a", 1, "A"), chunk("c", 3, "C"), chunk("a", 1, "replacement")]
  const scenarioPath = join(root, "scenario.json")
  writeFileSync(scenarioPath, JSON.stringify(scenario))
  const adapter = createAcpAdapter({ spec, command: [process.execPath, join(import.meta.dir, "adapter/fixtures/acp/fake-agent.ts"), scenarioPath, join(root, "rpc.jsonl")] })
  const store = new Store(":memory:")
  const frames: Frame[] = []
  const service = new SessionService(store, adapter, frame => frames.push(frame), { workspaceRoot: root })
  try {
    const session = store.createSession({ agent: "grok", cwd: root })
    const sent = await service.invoke("message.send", { sessionId: session.id, text: "late" }, "first")
    expect(sent.type).toBe("result")
    await until(() => store.getSession(session.id)?.status === "idle" && store.db.query("SELECT anchor_id FROM turn_background_links").get() !== null)
    const link = store.db.query("SELECT anchor_id, identity FROM turn_background_links").get() as { anchor_id: string; identity: string }
    const oldTurn = JSON.parse(link.identity) as { turnId: string }
    await service.invoke("message.send", { sessionId: session.id, text: "new prompt" }, "second")
    await until(() => store.getSession(session.id)?.status === "idle" && store.listMessages(session.id).some(row => row.text === "ok"))
    expect(store.getMessage(link.anchor_id)!.text).toBe("")
    const beforeNewReply = store.listMessages(session.id).find(row => row.text === "ok")!
    await until(() => store.getMessage(link.anchor_id)?.text === "ABC")
    expect(store.getMessage(beforeNewReply.id)).toEqual(beforeNewReply)
    expect(JSON.parse(store.getMessage(link.anchor_id)!.payload!).turnId).toBe(oldTurn.turnId)
    expect(store.db.query("SELECT projected_count FROM turn_background_links").get()).toEqual({ projected_count: 3 })
    expect(store.db.query("SELECT event_id FROM late_agent_events WHERE status = 'patched'").all()).toHaveLength(3)
    expect(frames.some(frame => frame.name === "message.append" && (frame.payload as { id?: string })?.id === link.anchor_id)).toBe(true)
  } finally {
    await service.shutdown()
    await adapter.dispose?.()
    store.db.close()
    rmSync(root, { recursive: true, force: true })
  }
})
