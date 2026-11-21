import { MAX_BATCH_SESSIONS, type PushChanges, type PushPayload } from "./push"

/** v67 A4: a computer's finished sessions within this long of the first share one notice. */
export const DONE_WINDOW_MS = 120_000

/** What to hand the push gateway for one event. `sound` is what the phone does with it (the extension mutes a batch). */
export type PlannedPush = { payload: PushPayload; collapseId?: string; sound: boolean }

type Finished = { sessionId: string; title: string; changes?: PushChanges }

/**
 * When rudderd notifies and how many. Permission and question
 * notices are not planned here: they always go out, or go to a Live Activity that can carry them.
 *
 * Finished turns: the first `done` of a window goes out as it is, with sound, under `done-w-<window>`. Every later
 * one in the same window becomes a `doneBatch` under the same collapse id, replacing the notice, so the phone rings
 * once. The window starts at the first and does not slide. A failure is never folded in: it needs its reason.
 */
export class NotifyPolicy {
  private window: { id: string; startedAt: number; finished: Finished[] } | undefined
  private readonly windowMs: number
  private readonly now: () => number
  private readonly newId: () => string

  constructor(options: { windowMs?: number; now?: () => number; newId?: () => string } = {}) {
    this.windowMs = options.windowMs ?? DONE_WINDOW_MS
    this.now = options.now ?? Date.now
    this.newId = options.newId ?? (() => crypto.randomUUID().slice(0, 8))
  }

  /**
   * A turn ended with `payload` (kind `done`). Null: no notice — the user stopped it on the phone. An agent that
   * exited or went silent is not the user's stop and arrives here as `failed`.
   */
  turnEnded(payload: PushPayload, how: { stoppedByUser: boolean }): PlannedPush | null {
    if (how.stoppedByUser) return null
    if (payload.outcome !== undefined && payload.outcome !== "done") {
      return { payload, collapseId: `done-${payload.sessionId}`, sound: true }
    }
    const now = this.now()
    if (!this.window || now - this.window.startedAt >= this.windowMs) {
      this.window = { id: this.newId(), startedAt: now, finished: [] }
    }
    const window = this.window
    const finished: Finished = { sessionId: payload.sessionId, title: payload.title, ...(payload.changes ? { changes: payload.changes } : {}) }
    // A session finishing twice keeps its place and takes its latest result.
    const index = window.finished.findIndex((entry) => entry.sessionId === payload.sessionId)
    if (index >= 0) window.finished[index] = finished
    else window.finished.push(finished)
    const collapseId = `done-w-${window.id}`
    if (window.finished.length === 1) return { payload, collapseId, sound: true }
    // In the order they finished, like the design's list.
    const sessions = window.finished
    const totals = sessions.reduce(
      (sum, entry) => ({
        added: sum.added + (entry.changes?.added ?? 0),
        removed: sum.removed + (entry.changes?.removed ?? 0),
        files: sum.files + (entry.changes?.files ?? 0),
      }),
      { added: 0, removed: 0, files: 0 },
    )
    const listed = sessions.slice(0, MAX_BATCH_SESSIONS).map((entry) => ({ sessionId: entry.sessionId, title: entry.title }))
    return {
      payload: {
        v: 1,
        kind: "doneBatch",
        sessionId: "",
        // What an extension older than v67 shows: it knows neither the kind nor these fields.
        title: `${sessions.length} 个会话做完了`,
        body: listed.map((entry) => entry.title).join(" · "),
        ...(payload.machine ? { machine: payload.machine } : {}),
        sessions: listed,
        count: sessions.length,
        ...totals,
      },
      collapseId,
      sound: false,
    }
  }
}
