import type { LateAgentEvent } from "./adapter/types"
import type { MessageRow, Store } from "./store"
import type { TurnExecutionIdentity } from "./turn-termination"

type Receipt = { body: string; status: string; rowid: number }
type Link = { identity: string; anchor_id: string; projected_count: number; sequence_ordered: number; last_sequence: number | null; last_rowid: number }

export class LateAgentEvents {
  constructor(private readonly store: Store, private readonly publish: (row: MessageRow) => void) {}

  register(identity: TurnExecutionIdentity, taskId: string): MessageRow | null {
    const native = identity.nativeSessionId ?? ""
    return this.store.transaction(() => {
      const existing = this.store.db.query("SELECT * FROM turn_background_links WHERE agent_id = ? AND native_session_id = ? AND task_id = ?")
        .get(identity.agentId, native, taskId) as Link | null
      if (existing) {
        const anchor = this.store.getMessage(existing.anchor_id)
        return anchor
      }
      const anchor = this.store.insertMessage({ id: crypto.randomUUID(), session_id: identity.sessionId,
        role: "assistant", kind: "text", text: "", created_at: Date.now(),
        payload: JSON.stringify({ turnId: identity.turnId, nativeTaskId: taskId }) })
      this.store.db.query("INSERT INTO turn_background_links(agent_id, native_session_id, task_id, identity, anchor_id) VALUES (?, ?, ?, ?, ?)")
        .run(identity.agentId, native, taskId, JSON.stringify(identity), anchor.id)
      return anchor
    })
  }

  /** An earlier turn registered this task: its late output patches that turn's anchor. */
  knows(agentId: string, nativeSessionId: string, taskId: string): boolean {
    return this.store.db.query("SELECT 1 FROM turn_background_links WHERE agent_id = ? AND native_session_id = ? AND task_id = ?")
      .get(agentId, nativeSessionId, taskId) !== null
  }

  stage(event: LateAgentEvent): string {
    const key = event.eventId || `unidentified:${crypto.randomUUID()}`
    this.store.db.query("INSERT OR IGNORE INTO late_agent_events(agent_id, native_session_id, event_id, body, task_id) VALUES (?, ?, ?, ?, ?)")
      .run(event.identity.agentId, event.identity.nativeSessionId ?? "", key, JSON.stringify(event), event.nativeTaskId ?? null)
    return key
  }

  async accept(event: LateAgentEvent): Promise<"patched" | "duplicate" | "quarantined"> {
    return this.apply(event, this.stage(event))
  }

  private apply(event: LateAgentEvent, eventKey: string): "patched" | "duplicate" | "quarantined" {
    let patched: MessageRow | undefined
    const result = this.store.transaction(() => {
      const key = [event.identity.agentId, event.identity.nativeSessionId ?? "", eventKey] as const
      const receipt = this.store.db.query("SELECT body, status, rowid FROM late_agent_events WHERE agent_id = ? AND native_session_id = ? AND event_id = ?").get(...key) as Receipt
      if (receipt.status !== "pending") return "duplicate" as const
      // Use the durable original body if a producer retries the event with changed data.
      event = JSON.parse(receipt.body) as LateAgentEvent
      const link = this.store.db.query("SELECT * FROM turn_background_links WHERE agent_id = ? AND native_session_id = ? AND task_id = ?")
        .get(key[0], key[1], event.nativeTaskId ?? "") as Link | null
      const owner = link ? JSON.parse(link.identity) as TurnExecutionIdentity : undefined
      const session = owner && this.store.getSession(owner.sessionId)
      const turn = owner && this.store.getTurn(owner.turnId)
      const anchor = link && this.store.getMessage(link.anchor_id)
      const reason = !event.eventId || !key[1] ? "missing_native_identity"
        : !owner ? "unmapped_task"
        : owner.sessionId !== event.identity.sessionId || (event.identity.turnId && owner.turnId !== event.identity.turnId) ? "identity_mismatch"
        : !session || !turn || !anchor ? "removed_owner"
        : (session.generation ?? 0) !== owner.generation || event.identity.generation !== owner.generation ? "obsolete_generation"
        : undefined
      if (reason) {
        this.store.db.query("UPDATE late_agent_events SET status = 'quarantined', reason = ? WHERE agent_id = ? AND native_session_id = ? AND event_id = ?").run(reason, ...key)
        return "quarantined" as const
      }
      const sequenced = Number.isSafeInteger(event.sequence)
      const ordered = link!.sequence_ordered === 1
      const incremental = link!.projected_count > 0 && (ordered
        ? sequenced && link!.last_sequence !== null && event.sequence! > link!.last_sequence
        : receipt.rowid > link!.last_rowid)
      let text: string
      let count = link!.projected_count + 1
      let sequenceOrdered = ordered
      let lastSequence = sequenced ? event.sequence! : null
      let lastRowid = Math.max(link!.last_rowid, receipt.rowid)
      if (incremental) {
        text = event.mode === "delta" ? anchor!.text + event.text : event.text
      } else {
        // Only this task's receipts can affect its anchor. Rebuild on disorder or when switching ordering modes.
        const receipts = this.store.db.query(`SELECT body, rowid FROM late_agent_events WHERE agent_id = ? AND native_session_id = ?
          AND task_id IS ? AND (status = 'patched' OR event_id = ?) ORDER BY rowid`)
          .all(key[0], key[1], event.nativeTaskId ?? null, eventKey) as Array<{ body: string; rowid: number }>
        const chunks = receipts.map(row => JSON.parse(row.body) as LateAgentEvent)
        sequenceOrdered = chunks.every(chunk => Number.isSafeInteger(chunk.sequence))
        if (sequenceOrdered) chunks.sort((a, b) => a.sequence! - b.sequence!)
        text = chunks.reduce((body, chunk) => chunk.mode === "delta" ? body + chunk.text : chunk.text, "")
        count = chunks.length
        lastSequence = sequenceOrdered ? chunks.at(-1)!.sequence! : null
        lastRowid = receipts.at(-1)!.rowid
      }
      patched = this.store.insertMessage({ ...anchor!, text })
      this.store.db.query(`UPDATE turn_background_links SET projected_count = ?, sequence_ordered = ?, last_sequence = ?, last_rowid = ?
        WHERE agent_id = ? AND native_session_id = ? AND task_id = ?`)
        .run(count, sequenceOrdered ? 1 : 0, lastSequence, lastRowid, key[0], key[1], event.nativeTaskId ?? "")
      this.store.db.query("UPDATE late_agent_events SET status = 'patched' WHERE agent_id = ? AND native_session_id = ? AND event_id = ?").run(...key)
      return "patched" as const
    })
    if (patched) this.publish(patched)
    return result
  }

  async recover() {
    const pending = this.store.db.query("SELECT body, event_id FROM late_agent_events WHERE status = 'pending' ORDER BY rowid").all() as Array<{ body: string; event_id: string }>
    for (const row of pending) this.apply(JSON.parse(row.body) as LateAgentEvent, row.event_id)
  }
}
