import { AUTO_TITLE_COMMAND, AUTO_TITLE_MESSAGE, commandName, commandTitle, commandTitleCopy, isSlashCommand, titleFromMessage } from "./session-title"
import { recordTermination, restartMessageId, type TurnExecutionIdentity, type TurnTermination } from "./turn-termination"
import { Database } from "bun:sqlite"
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, statSync } from "node:fs"
import { dirname } from "node:path"
import type {
  PermissionOption,
  PlanEntry,
  QuestionAnswers,
  QuestionItem,
  RudderPermissionMode,
  ToolDiff,
  ToolKind,
  ToolStatus,
  TurnUsage,
} from "./adapter/types"
import { isPhoneCopy, type PhoneCopy, phoneCopy } from "./phone-copy"
import type { TurnChanges } from "./turn-changes"
import type { SessionRule } from "./v32"

export type SessionRow = {
  id: string
  title: string
  agent: string
  status: "idle" | "running" | "waiting"
  pinned: number
  archived: number
  last_read_seq: number
  last_seq: number
  cwd: string
  model: string
  updated_at: number
  // Product decision (2026-11-19): the home list's order key. Moves when a turn starts, when the owner is needed and
  // when the turn ends; streamed rows move only updated_at. NULL on rows written before it existed (reads updated_at).
  active_at?: number | null
  // Agent-native session id for resuming; never sent to clients.
  native_id: string | null
  // Accumulated TurnUsage as JSON.
  usage: string | null
  permission_mode: RudderPermissionMode
  effort: string
  // Speed id from the model's published list. Empty leaves the agent's own default.
  speed: string
  context_window: number | null
  compaction_count: number
  // The newest user / assistant text row as the list shows it (previewText); seq 0 and NULLs when there is none.
  preview_role: string | null
  preview_text: string | null
  preview_at: number | null
  preview_seq: number
  // Manual unread dot. Independent of last_read_seq so an empty or caught-up session can still show unread.
  marked_unread: number
  // A copy that has not run yet: the agent-native session it continues as a fork (agents that can fork).
  fork_native?: string | null
  // 1 while the title is the phone's placeholder in its own language ("Neue Sitzung"): the first message names the
  // session. Any title change clears it.
  auto_title?: number
  // v112: the slash command a session is named after (`auto_title` 2), so each phone words the title in its language.
  title_command?: string | null
  // Messages up to this seq were never seen by the current agent-native session (copy or rewind);
  // the next turn carries them over (carry-over.ts). 0 = nothing to carry.
  carry_seq?: number
  // Where the session started: "terminal" for one brought over from a terminal Claude session.
  origin?: "rudder" | "terminal"
  // JSON `{path, offset, earlier}`: how far the transcript on disk has been read in, and how many of its oldest rows
  // still wait in reserved seqs 2…earlier+1 (「更早的 N 条留在电脑上」). NULL for sessions never imported or attached.
  import_cursor?: string | null
  // r64 sync: global change counter (`session.list {sinceVersion}`), +1 on rewind / clear, and the per-session
  // message rev counter (`message.changes`). Maintained by SQLite triggers (installSyncTriggers).
  version?: number
  generation?: number
  rev_counter?: number
}

export type SessionPatch = {
  title?: string
  pinned?: boolean
  archived?: boolean
  status?: SessionRow["status"]
  lastReadSeq?: number
  cwd?: string
  model?: string
  agent?: string
  // null clears the stored id.
  nativeId?: string | null
  usage?: TurnUsage
  permissionMode?: RudderPermissionMode
  effort?: string
  speed?: string
  contextWindow?: number | null
  compactionCount?: number
  // true sets the manual unread dot; false clears it. Does not move last_read_seq.
  unread?: boolean
  // `auto_title` with the title (session-title.ts); a title without it is a name and clears it.
  autoTitle?: number
}

export type MessageRow = {
  id: string
  session_id: string
  seq: number
  kind: string
  role: string
  text: string
  payload: string | null
  created_at: number
  // r64 sync: the session's rev_counter when this row last changed; assigned by trigger, never written by callers.
  rev?: number
}

export type SendIdentity = {
  sessionId: string
  deviceId: string
  clientMessageId: string
  requestHash: string
  queueId?: string
}

export type SendRequestRow = {
  session_id: string
  device_id: string
  client_message_id: string
  request_hash: string
  result: string
}

export type TurnPhase = "preparing" | "running" | "waiting" | "done" | "failed" | "interrupted"
export type LimitResumeRow = {
  session_id: string
  turn_id: string
  resets_at: number
  created_at: number
}

export type TurnRow = {
  execution?: string | null
  termination?: string | null
  id: string
  session_id: string
  user_message_id: string
  client_message_id: string | null
  sequence: number
  revision: number
  phase: TurnPhase
  updated_at: number
  /** JSON `TurnOutcome`, written once when the turn ends (r47 lastTurn). */
  outcome?: string | null
  /** JSON `TurnNative`: where the turn sits in the agent-native session, for a native rewind. */
  native?: string | null
}

export type TurnNative = { session: string; turnId?: string; lastMessageId?: string }

/** The turns on either side of a rewind cut that lands exactly where a turn's prompt starts. */
export type RewindBoundary = { kept: TurnNative; removed: TurnNative; compacted: boolean }

/** How a turn ended, for the session list (r47 `session.lastTurn`). */
export type TurnOutcome = {
  replyDisposition?: import("./adapter/types").ReplyDisposition
  finalMessageIds?: string[]
  termination?: TurnTermination
  phase: "done" | "failed" | "interrupted"
  /** failed: the failed tool's title, or the error's first line when no tool failed (no toolId then). */
  reason?: string
  /** `reason` as phone copy when rudderd wrote it; sent as the session's `lastResultCopy`, not inside `lastTurn`. */
  reasonCopy?: PhoneCopy
  exitCode?: number
  toolId?: string
  changes?: { files: number; added: number; removed: number }
  endedAt: number
}

/** What a daemon restart needs to end a Live Activity. Step text and seq stay in memory. */
export type LiveActivityRow = {
  session_id: string
  activity_id: string
  push_token: string
  device_key: string
  keep_seconds: number
  locale: string
  started_at: number
}

/**
 * one Live Activity per phone for this whole computer (`scope: "computer"`). rudderd picks the session it
 * shows (`focus_session`); `state` is the last content-state sent, kept so a restart can end the card readably.
 */
export type LiveCardRow = {
  device_key: string
  activity_id: string
  push_token: string
  keep_seconds: number
  locale: string
  started_at: number
  focus_session: string | null
  state: string | null
}

export type DeviceRow = {
  id: string
  session_key: string
  name: string
  created_at: number
  /** The push gateway's ticket for this phone (the push notes), never the raw APNs token. */
  push_token: string | null
  /** Last WebSocket open or close of this device; null until it first connects after r59. */
  last_seen_at?: number | null
  /** v67 A5: JSON `{done: boolean}` from `device.registerPush`; null means everything on. */
  push_prefs?: string | null
  /** r70 1.2a: JSON `LiveStart` from `device.registerPush`; null when this phone does not let rudderd start its card. */
  live_start?: string | null
}

/** r70 1.2a: what rudderd needs to start this phone's per-computer card by push (ActivityKit push-to-start). */
export type LiveStart = {
  /** The phone's push-to-start token for `RudderComputerAttributes` (hex). */
  token: string
  /** The phone's own id for this pairing: the card's `attributes.accountId`. */
  accountId: string
  hue?: number
  /** The app language the phone reads in (`AppLocale`); older phones sent "zh" / "en". */
  locale: string
  keepSeconds: number
}

export type ScheduledRow = {
  id: string
  session_id: string
  text: string
  fire_at: number
  status: "pending" | "sent" | "cancelled"
  created_at: number
}

// One row per agent turn that reported usage; kept after its session is deleted.
export type UsageEventRow = {
  id: string
  session_id: string
  session_title: string
  agent: string
  model: string
  // The daemon's id for one generate() turn, or "backfill" for totals carried over from sessions.usage.
  turn_id: string
  created_at: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  reasoning_tokens: number
  // NULL: the agent reported no cost (distinct from a reported 0).
  cost_usd: number | null
  context_used: number | null
  context_size: number | null
}

export type UsageTurn = { turnId: string; agent: string; model: string }

export type UsageQuery = { from?: number; to?: number; bucket: "day" | "none"; tz: number }
// usageSummary keeps this many ranges (the stats page's tabs: today, 7 days, 30 days, all, and a custom one).
const USAGE_CACHE_RANGES = 6

export type UsageTotals = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  // Sum of the reported costs only; null when no row in the group reported one.
  costUsd: number | null
  // Some rows in the group reported a cost and some did not.
  costPartial: boolean
  // Recorded turns; backfilled rows carry totals without a turn count.
  turns: number
  sessions: number
}

export type UsageSummary = {
  totals: UsageTotals
  byDay: Array<{ day: string } & UsageTotals>
  byAgent: Array<{ agent: string } & UsageTotals>
  byModel: Array<{ agent: string; model: string } & UsageTotals>
}

export type DraftRow = {
  session_id: string
  text: string
  updated_at: number
}

const COPY_BATCH_ROWS = 200
const COPY_BATCH_MS = 8
const VISIBLE_SESSION = "NOT EXISTS (SELECT 1 FROM session_copy_jobs WHERE destination_id = sessions.id)"
const VISIBLE_MESSAGE = "NOT EXISTS (SELECT 1 FROM session_copy_jobs WHERE destination_id = messages.session_id)"

export class Store {
  readonly db: Database
  readonly path: string
  // usageSummary answers by range, until the next usage event.
  private readonly usageCache = new Map<string, UsageSummary>()

  constructor(path: string) {
    this.path = path
    if (path !== ":memory:") {
      // The db holds device session keys and the pairing token. Only directories created here get 0700;
      // an existing parent may be shared and is left alone.
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      // Created 0600 before SQLite opens it; SQLite gives -wal and -shm the db file's mode.
      if (!existsSync(path)) closeSync(openSync(path, "a", 0o600))
    }
    this.db = new Database(path)
    this.db.exec("PRAGMA journal_mode=WAL")
    if (path !== ":memory:") restrictToOwner(path)
    // NORMAL is durable under WAL except for the last commits on power loss; FULL fsyncs every write.
    this.db.exec("PRAGMA synchronous=NORMAL")
    this.db.exec("PRAGMA busy_timeout=2000")
    this.migrate()
    this.readCommandTitles()
  }

  /**
   * 11-19: sessions named before then kept a raw slash command as their title. Each is named after its first
   * ordinary message (v112 ②), else after the command (③, `auto_title` 2 with `title_command`, still open for one).
   * updated_at stays: a rename must not reorder the list.
   */
  private readCommandTitles() {
    const rows = this.db.query("SELECT id, title FROM sessions WHERE title LIKE '/%'").all() as { id: string; title: string }[]
    const commands = rows.filter((row) => isSlashCommand(row.title))
    if (commands.length === 0) return
    const texts = this.db.query("SELECT text FROM messages WHERE session_id = ? AND role = 'user' AND kind = 'text' ORDER BY seq LIMIT 50")
    this.transaction(() => {
      for (const row of commands) {
        const prompt = (texts.all(row.id) as { text: string }[]).map((message) => message.text).find((text) => text.trim() !== "" && !isSlashCommand(text))
        const name = commandName(row.title)!
        if (prompt) this.setAutoTitle(row.id, titleFromMessage(prompt), AUTO_TITLE_MESSAGE)
        else this.setAutoTitle(row.id, commandTitle(name), AUTO_TITLE_COMMAND, name)
      }
    })
  }

  /**
   * A title rudderd chose (session-title.ts `auto_title`), with the command it was read off. A rename by rudderd is
   * not new content: updated_at stays and the list does not reorder.
   */
  setAutoTitle(id: string, title: string, autoTitle: number, titleCommand: string | null = null): SessionRow | null {
    this.db.query("UPDATE sessions SET title = ?, auto_title = ?, title_command = ? WHERE id = ?").run(title, autoTitle, titleCommand, id)
    return this.getSession(id)
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        agent TEXT NOT NULL,
        status TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        kind TEXT NOT NULL,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        payload TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_copy_jobs (
        destination_id TEXT PRIMARY KEY NOT NULL,
        source_id TEXT NOT NULL,
        source_generation INTEGER NOT NULL,
        source_rev INTEGER NOT NULL,
        source_last_seq INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS message_sends (
        session_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        client_message_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        result TEXT NOT NULL,
        PRIMARY KEY (session_id, device_id, client_message_id)
      );
      CREATE TABLE IF NOT EXISTS session_turns (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        user_message_id TEXT NOT NULL,
        client_message_id TEXT,
        sequence INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        phase TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (session_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS turn_changes (
        turn_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        body TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        session_key TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS scheduled (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        text TEXT NOT NULL,
        fire_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS drafts (
        session_id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_session_seq ON messages(session_id, seq);
      CREATE INDEX IF NOT EXISTS messages_user_prompt_seq ON messages(session_id, seq) WHERE role = 'user' AND kind != 'error';
      CREATE INDEX IF NOT EXISTS messages_image_created ON messages(created_at) WHERE kind = 'image';
      CREATE INDEX IF NOT EXISTS messages_agent_image_attachment
        ON messages(session_id, ${AGENT_IMAGE_ID}, created_at) WHERE ${AGENT_IMAGE_ROW};
      CREATE INDEX IF NOT EXISTS messages_pending_kind ON messages(kind) WHERE kind IN ('permission', 'question');
      CREATE INDEX IF NOT EXISTS turn_changes_session ON turn_changes(session_id);
      CREATE INDEX IF NOT EXISTS scheduled_due ON scheduled(status, fire_at);
      CREATE INDEX IF NOT EXISTS scheduled_session_status ON scheduled(session_id, status);
      CREATE TABLE IF NOT EXISTS live_activities (
        session_id TEXT PRIMARY KEY,
        activity_id TEXT NOT NULL,
        push_token TEXT NOT NULL,
        device_key TEXT NOT NULL,
        keep_seconds INTEGER NOT NULL,
        locale TEXT NOT NULL,
        started_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS live_activities_activity ON live_activities(activity_id);
      CREATE TABLE IF NOT EXISTS live_cards (
        device_key TEXT PRIMARY KEY,
        activity_id TEXT NOT NULL,
        push_token TEXT NOT NULL,
        keep_seconds INTEGER NOT NULL,
        locale TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        focus_session TEXT,
        state TEXT
      );
      CREATE TABLE IF NOT EXISTS permission_rules (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        command TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS limit_resumes (
        session_id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL,
        resets_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
    `)
    this.ensureColumn("messages", "payload", "payload TEXT")
    this.ensureColumn("sessions", "archived", "archived INTEGER NOT NULL DEFAULT 0")
    this.ensureColumn("sessions", "last_read_seq", "last_read_seq INTEGER NOT NULL DEFAULT 0")
    this.ensureColumn("sessions", "last_seq", "last_seq INTEGER NOT NULL DEFAULT 0")
    this.ensureColumn("sessions", "cwd", "cwd TEXT NOT NULL DEFAULT ''")
    this.ensureColumn("sessions", "model", "model TEXT NOT NULL DEFAULT ''")
    this.ensureColumn("sessions", "native_id", "native_id TEXT")
    this.ensureColumn("sessions", "usage", "usage TEXT")
    this.ensureColumn("sessions", "permission_mode", "permission_mode TEXT NOT NULL DEFAULT 'ask'")
    this.ensureColumn("sessions", "effort", "effort TEXT NOT NULL DEFAULT ''")
    this.ensureColumn("sessions", "speed", "speed TEXT NOT NULL DEFAULT ''")
    this.ensureColumn("sessions", "context_window", "context_window INTEGER")
    this.ensureColumn("sessions", "compaction_count", "compaction_count INTEGER NOT NULL DEFAULT 0")
    this.ensureColumn("devices", "push_token", "push_token TEXT")
    this.ensureColumn("devices", "last_seen_at", "last_seen_at INTEGER")
    this.ensureColumn("devices", "push_prefs", "push_prefs TEXT")
    this.ensureColumn("devices", "live_start", "live_start TEXT")
    this.ensureColumn("sessions", "preview_role", "preview_role TEXT")
    this.ensureColumn("sessions", "preview_text", "preview_text TEXT")
    this.ensureColumn("sessions", "preview_at", "preview_at INTEGER")
    const previewAdded = this.ensureColumn("sessions", "preview_seq", "preview_seq INTEGER NOT NULL DEFAULT 0")
    this.ensureColumn("sessions", "marked_unread", "marked_unread INTEGER NOT NULL DEFAULT 0")
    this.ensureColumn("sessions", "fork_native", "fork_native TEXT")
    this.ensureColumn("sessions", "auto_title", "auto_title INTEGER NOT NULL DEFAULT 0")
    this.ensureColumn("sessions", "title_command", "title_command TEXT")
    this.ensureColumn("sessions", "carry_seq", "carry_seq INTEGER NOT NULL DEFAULT 0")
    this.ensureColumn("session_turns", "outcome", "outcome TEXT")
    this.ensureColumn("session_turns", "native", "native TEXT")
    this.db.exec(`CREATE TABLE IF NOT EXISTS late_agent_events (
        agent_id TEXT NOT NULL, native_session_id TEXT NOT NULL, event_id TEXT NOT NULL,
        body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', reason TEXT,
        PRIMARY KEY (agent_id, native_session_id, event_id)
      );
      CREATE TABLE IF NOT EXISTS turn_background_links (
        agent_id TEXT NOT NULL, native_session_id TEXT NOT NULL, task_id TEXT NOT NULL,
        identity TEXT NOT NULL, anchor_id TEXT NOT NULL,
        PRIMARY KEY (agent_id, native_session_id, task_id)
      );
      CREATE TABLE IF NOT EXISTS restart_resumes (
      turn_id TEXT NOT NULL, generation INTEGER NOT NULL, status TEXT NOT NULL,
      PRIMARY KEY(turn_id, generation))`)
    try {
      this.transaction(() => {
        const tasksAdded = this.ensureColumn("late_agent_events", "task_id", "task_id TEXT")
        this.ensureColumn("turn_background_links", "projected_count", "projected_count INTEGER NOT NULL DEFAULT 0")
        this.ensureColumn("turn_background_links", "sequence_ordered", "sequence_ordered INTEGER NOT NULL DEFAULT 1")
        this.ensureColumn("turn_background_links", "last_sequence", "last_sequence INTEGER")
        this.ensureColumn("turn_background_links", "last_rowid", "last_rowid INTEGER NOT NULL DEFAULT 0")
        if (tasksAdded) this.db.exec("UPDATE late_agent_events SET task_id = json_extract(body, '$.nativeTaskId')")
        this.db.exec(`CREATE INDEX IF NOT EXISTS late_agent_events_task
          ON late_agent_events(agent_id, native_session_id, task_id, status)`)
      })
    } catch (error) {
      throw new Error(`late inbox projection migration failed for ${this.path}`, { cause: error })
    }
    this.ensureColumn("session_turns", "execution", "execution TEXT")
    this.ensureColumn("session_turns", "termination", "termination TEXT")
    this.ensureColumn("sessions", "origin", "origin TEXT NOT NULL DEFAULT 'rudder'")
    this.ensureColumn("sessions", "import_cursor", "import_cursor TEXT")
    // No backfill: an UPDATE of every row would move every session's list version. NULL reads as updated_at.
    this.ensureColumn("sessions", "active_at", "active_at INTEGER")
    this.ensureColumn("permission_rules", "match", "match TEXT")
    this.migrateSendRecords()
    this.uniqueNativeIds()
    this.migrateUsageEvents()
    this.migrateSync()
    // A streamed row written quietly by a process that died before the block ended: give it the rev it never took.
    this.transaction(() => {
      for (const row of this.db.query("SELECT id FROM stream_quiet").all() as Array<{ id: string }>) this.settleMessage(row.id)
    })
    this.db.exec("UPDATE sessions SET archived = 1, status = 'idle' WHERE status = 'archived'")
    // No turn survives a restart: a row still running or waiting was left by a crash or kill.
    this.db.exec("UPDATE sessions SET status = 'idle' WHERE status IN ('running', 'waiting')")
    this.db.exec(`
      UPDATE sessions SET last_seq = COALESCE(
        (SELECT MAX(seq) FROM messages WHERE messages.session_id = sessions.id),
        0
      )
    `)
    this.backfillTurnOutcomes()
    this.expirePendingPermissions()
    // Once, when the preview columns arrive; from then on every message write keeps them current.
    if (previewAdded) {
      this.transaction(() => {
        for (const row of this.db.query("SELECT id FROM sessions").all() as Array<{ id: string }>) this.resetPreview(row.id)
      })
    }
  }

  /**
   * r64 incremental sync. `messages.rev` takes the session's next `rev_counter` on every insert and every change of a
   * row; `sessions.version` takes the next global `session_version` on every change of a session row; a deleted
   * session leaves a tombstone. Triggers keep all three, so no write path can forget them. Backfill: rev in seq order,
   * version in updated_at order.
   */
  private migrateSync() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sync_counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS session_tombstones (id TEXT PRIMARY KEY, version INTEGER NOT NULL, deleted_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS session_tombstones_version ON session_tombstones(version);
    `)
    this.transaction(() => {
      // Triggers are rebuilt below from the current columns; none may fire during the backfill.
      for (const name of SYNC_TRIGGERS) this.db.exec(`DROP TRIGGER IF EXISTS ${name}`)
      const revAdded = this.ensureColumn("messages", "rev", "rev INTEGER NOT NULL DEFAULT 0")
      const counterAdded = this.ensureColumn("sessions", "rev_counter", "rev_counter INTEGER NOT NULL DEFAULT 0")
      this.ensureColumn("sessions", "generation", "generation INTEGER NOT NULL DEFAULT 0")
      const versionAdded = this.ensureColumn("sessions", "version", "version INTEGER NOT NULL DEFAULT 0")
      if (revAdded || counterAdded) {
        this.db.exec(`
          UPDATE messages SET rev = (
            SELECT ranked.n FROM (
              SELECT id, ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY seq, rowid) AS n FROM messages
            ) AS ranked WHERE ranked.id = messages.id
          );
          UPDATE sessions SET rev_counter = COALESCE((SELECT MAX(rev) FROM messages WHERE messages.session_id = sessions.id), 0);
        `)
      }
      if (versionAdded) {
        this.db.exec(`
          UPDATE sessions SET version = (
            SELECT ranked.n FROM (
              SELECT id, ROW_NUMBER() OVER (ORDER BY updated_at, rowid) AS n FROM sessions
            ) AS ranked WHERE ranked.id = sessions.id
          );
        `)
      }
      this.db.exec(`
        INSERT INTO sync_counters(name, value)
          SELECT 'session_version', COALESCE((SELECT MAX(version) FROM sessions), 0)
          WHERE NOT EXISTS (SELECT 1 FROM sync_counters WHERE name = 'session_version');
        INSERT OR IGNORE INTO sync_counters(name, value) VALUES ('tombstone_horizon', 0);
      `)
      this.db.exec("CREATE INDEX IF NOT EXISTS messages_session_rev ON messages(session_id, rev)")
      // Streamed rows written since their last rev (`insertMessage` quiet); the update trigger leaves them alone.
      this.db.exec("CREATE TABLE IF NOT EXISTS stream_quiet (id TEXT PRIMARY KEY)")
      this.db.exec("CREATE INDEX IF NOT EXISTS sessions_version ON sessions(version)")
      this.installSyncTriggers()
      this.pruneTombstones()
    })
  }

  // A column that differs between OLD and NEW; built from the live table, so a column added later still counts.
  private changedClause(table: string, skip: string): string {
    const columns = (this.db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .map((entry) => entry.name)
      .filter((name) => name !== skip)
    return columns.map((name) => `NEW.${name} IS NOT OLD.${name}`).join(" OR ")
  }

  private installSyncTriggers() {
    const bumpVersion = `
      UPDATE sync_counters SET value = value + 1 WHERE name = 'session_version';
      UPDATE sessions SET version = (SELECT value FROM sync_counters WHERE name = 'session_version') WHERE id = NEW.id;`
    const takeRev = `
      UPDATE sessions SET rev_counter = rev_counter + 1 WHERE id = NEW.session_id;
      UPDATE messages SET rev = COALESCE((SELECT rev_counter FROM sessions WHERE id = NEW.session_id), 0) WHERE id = NEW.id;`
    this.db.exec(`
      CREATE TRIGGER sync_session_insert AFTER INSERT ON sessions BEGIN ${bumpVersion}
      END;
      CREATE TRIGGER sync_session_update AFTER UPDATE ON sessions
        WHEN NEW.version IS OLD.version AND (${this.changedClause("sessions", "version")}) BEGIN ${bumpVersion}
      END;
      CREATE TRIGGER sync_session_delete AFTER DELETE ON sessions BEGIN
        UPDATE sync_counters SET value = value + 1 WHERE name = 'session_version';
        INSERT OR REPLACE INTO session_tombstones(id, version, deleted_at)
          VALUES (OLD.id, (SELECT value FROM sync_counters WHERE name = 'session_version'), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
      END;
      CREATE TRIGGER sync_message_insert AFTER INSERT ON messages BEGIN ${takeRev}
      END;
      CREATE TRIGGER sync_message_update AFTER UPDATE ON messages
        WHEN NEW.rev IS OLD.rev AND NOT EXISTS (SELECT 1 FROM stream_quiet WHERE id = NEW.id)
          AND (${this.changedClause("messages", "rev")}) BEGIN ${takeRev}
      END;
    `)
  }

  // Tombstones older than TOMBSTONE_DAYS go; a phone whose cursor predates the newest one dropped must list again.
  private pruneTombstones() {
    const cutoff = Date.now() - TOMBSTONE_DAYS * 86_400_000
    const dropped = this.db.query("SELECT MAX(version) AS v FROM session_tombstones WHERE deleted_at < ?").get(cutoff) as { v: number | null }
    if (dropped.v === null) return
    this.db.query("UPDATE sync_counters SET value = MAX(value, ?) WHERE name = 'tombstone_horizon'").run(dropped.v)
    this.db.query("DELETE FROM session_tombstones WHERE deleted_at < ?").run(cutoff)
  }

  /**
   * `queued` marks the records whose result is still a queued item, so a start reads only those; `updated_at` dates
   * the last write. Settled records older than SEND_RECORD_DAYS are dropped at start: no phone retries one that old.
   */
  private migrateSendRecords() {
    const queuedAdded = this.ensureColumn("message_sends", "queued", "queued INTEGER NOT NULL DEFAULT 0")
    const datedAdded = this.ensureColumn("message_sends", "updated_at", "updated_at INTEGER NOT NULL DEFAULT 0")
    if (queuedAdded) this.db.exec("UPDATE message_sends SET queued = 1 WHERE json_type(result, '$.queued') = 'object'")
    // Rows from before the column have no date; they count from this upgrade.
    if (datedAdded) this.db.query("UPDATE message_sends SET updated_at = ?").run(Date.now())
    this.db.exec("CREATE INDEX IF NOT EXISTS message_sends_queued ON message_sends(queued) WHERE queued = 1")
    this.db.query("DELETE FROM message_sends WHERE queued = 0 AND updated_at < ?").run(Date.now() - SEND_RECORD_DAYS * 86_400_000)
  }

  // One Rudder session per agent-native session, so an import finds the session it made before. Duplicates from
  // before the index keep the newest binding; the others lose theirs (logged) and resume as new agent sessions.
  private uniqueNativeIds() {
    if (this.db.query("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'sessions_agent_native'").get()) return
    this.transaction(() => {
      const dupes = this.db.query(
        `SELECT id, agent, native_id FROM sessions s WHERE native_id IS NOT NULL AND EXISTS (
           SELECT 1 FROM sessions t WHERE t.agent = s.agent AND t.native_id = s.native_id
             AND (t.updated_at > s.updated_at OR (t.updated_at = s.updated_at AND t.id > s.id)))`,
      ).all() as Array<{ id: string; agent: string; native_id: string }>
      for (const row of dupes) {
        console.warn(`rudderd: session ${row.id} shared ${row.agent} session ${row.native_id} with a newer one; its binding is dropped`)
        this.db.query("UPDATE sessions SET native_id = NULL WHERE id = ?").run(row.id)
      }
      this.db.exec("CREATE UNIQUE INDEX sessions_agent_native ON sessions(agent, native_id) WHERE native_id IS NOT NULL")
    })
  }

  // An install upgrading to this table only has per-session totals: each becomes one synthetic row dated
  // at the session's updated_at, so its day attribution is approximate.
  private migrateUsageEvents() {
    if (this.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'usage_events'").get()) return
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE usage_events (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          session_title TEXT NOT NULL,
          agent TEXT NOT NULL,
          model TEXT NOT NULL DEFAULT '',
          turn_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          cache_read_tokens INTEGER NOT NULL DEFAULT 0,
          cache_write_tokens INTEGER NOT NULL DEFAULT 0,
          reasoning_tokens INTEGER NOT NULL DEFAULT 0,
          cost_usd REAL,
          context_used INTEGER,
          context_size INTEGER
        );
        CREATE UNIQUE INDEX usage_events_turn ON usage_events(session_id, turn_id);
        CREATE INDEX usage_events_created ON usage_events(created_at);
        CREATE INDEX usage_events_agent_created ON usage_events(agent, created_at);
      `)
      const sessions = this.db.query("SELECT * FROM sessions WHERE usage IS NOT NULL").all() as SessionRow[]
      for (const session of sessions) {
        const usage = parseUsage(session.usage)
        if (Object.keys(usage).length === 0) continue
        this.upsertUsageEvent(session, { turnId: "backfill", agent: session.agent, model: session.model }, usage, session.updated_at)
      }
    })
  }

  // True when the column was missing and has just been added.
  private ensureColumn(table: string, column: string, ddl: string): boolean {
    const columns = this.db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    if (columns.some((entry) => entry.name === column)) return false
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)
    return true
  }

  private expirePendingPermissions() {
    const rows = this.db.query("SELECT * FROM messages WHERE kind IN ('permission', 'question')").all() as MessageRow[]
    for (const row of rows) {
      if (row.kind === "permission") {
        const permission = parsePermission(row.payload)
        if (permission?.status !== "pending") continue
        permission.status = "expired"
        this.db.query("UPDATE messages SET payload = ? WHERE id = ?").run(JSON.stringify(permission), row.id)
      }
      if (row.kind === "question") {
        const question = parseQuestion(row.payload)
        if (question?.status !== "pending") continue
        question.status = "expired"
        this.db.query("UPDATE messages SET payload = ? WHERE id = ?").run(JSON.stringify(question), row.id)
      }
    }
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)()
  }

  getMeta(key: string): string | null {
    const row = this.db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null
    return row?.value ?? null
  }

  setMeta(key: string, value: string) {
    this.db.query("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value)
  }

  seedIfEmpty() {
    const count = (this.db.query("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n
    if (count > 0) return
    const now = Date.now()
    const demoId = DEMO_SESSION_ID
    // auto_title: the first message names it, so the placeholder title does not stay in one language.
    this.db.query(
      "INSERT INTO sessions(id, title, agent, status, pinned, archived, last_read_seq, last_seq, cwd, model, updated_at, auto_title, active_at) VALUES (?, ?, ?, ?, 0, 0, 1, 1, '', '', ?, 1, ?)",
    ).run(demoId, phoneCopy.demoTitle().text, "claude", "idle", now, now)
    const welcome = phoneCopy.welcome()
    this.db.query(
      "INSERT INTO messages(id, session_id, seq, kind, role, text, payload, created_at) VALUES (?, ?, 1, 'text', 'assistant', ?, ?, ?)",
    ).run(crypto.randomUUID(), demoId, welcome.text, JSON.stringify({ notice: true, copy: welcome }), now)
    this.resetPreview(demoId)
  }

  listSessions(): SessionRow[] {
    return this.db.query(`SELECT * FROM sessions WHERE ${VISIBLE_SESSION} ORDER BY pinned DESC, updated_at DESC`).all() as SessionRow[]
  }

  getSession(id: string): SessionRow | null {
    return (this.db.query(`SELECT * FROM sessions WHERE id = ? AND ${VISIBLE_SESSION}`).get(id) as SessionRow | null) ?? null
  }

  createSession(
    input: {
      title?: string
      agent?: string
      cwd?: string
      model?: string
      permissionMode?: RudderPermissionMode
      effort?: string
      speed?: string
      contextWindow?: number
      origin?: "rudder" | "terminal"
      nativeId?: string
      autoTitle?: boolean
    } = {},
  ): SessionRow {
    const row: SessionRow = {
      id: crypto.randomUUID(),
      title: input.title?.trim() || "新会话",
      agent: input.agent ?? "claude",
      status: "idle",
      pinned: 0,
      archived: 0,
      last_read_seq: 0,
      last_seq: 0,
      cwd: input.cwd ?? "",
      model: input.model ?? "",
      updated_at: Date.now(),
      native_id: input.nativeId ?? null,
      usage: null,
      permission_mode: input.permissionMode ?? "ask",
      effort: input.effort ?? "",
      speed: input.speed ?? "",
      context_window: input.contextWindow ?? null,
      compaction_count: 0,
      preview_role: null,
      preview_text: null,
      preview_at: null,
      preview_seq: 0,
      marked_unread: 0,
      origin: input.origin ?? "rudder",
      import_cursor: null,
      auto_title: input.autoTitle ? 1 : 0,
    }
    this.db.query(
      "INSERT INTO sessions(id, title, agent, status, pinned, archived, last_read_seq, last_seq, cwd, model, updated_at, native_id, usage, permission_mode, effort, speed, context_window, compaction_count, origin, auto_title, active_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      row.id,
      row.title,
      row.agent,
      row.status,
      row.pinned,
      row.archived,
      row.last_read_seq,
      row.last_seq,
      row.cwd,
      row.model,
      row.updated_at,
      row.native_id,
      row.usage,
      row.permission_mode,
      row.effort,
      row.speed,
      row.context_window,
      row.compaction_count,
      row.origin ?? "rudder",
      row.auto_title ?? 0,
      row.updated_at,
    )
    return this.getSession(row.id) ?? row
  }

  /**
   * Published sessions of `agent` bound to an agent-native id. Include archived sessions only on request.
   */
  listByAgentWithNative(agent: string, options: { archived?: boolean } = {}): SessionRow[] {
    const archived = options.archived === true ? "" : " AND archived = 0"
    return this.db.query(`SELECT * FROM sessions WHERE agent = ? AND native_id IS NOT NULL AND native_id != '' AND ${VISIBLE_SESSION}${archived}`).all(agent) as SessionRow[]
  }

  findByNative(agent: string, nativeId: string): SessionRow | null {
    return (this.db.query(`SELECT * FROM sessions WHERE agent = ? AND native_id = ? AND ${VISIBLE_SESSION}`).get(agent, nativeId) as SessionRow | null) ?? null
  }

  /**
   * Product decision (2026-11-19): an order event the sessions row does not see, e.g. a terminal holding the session
   * starting or ending a turn (its status column stays put). Moves only the list order key.
   */
  touchActive(id: string) {
    this.db.query("UPDATE sessions SET active_at = ? WHERE id = ?").run(Date.now(), id)
  }

  setImportCursor(id: string, cursor: string | null) {
    this.db.query("UPDATE sessions SET import_cursor = ? WHERE id = ?").run(cursor, id)
  }

  /** The newest row, or null for an empty session. */
  lastMessage(sessionId: string): MessageRow | null {
    return (this.db.query("SELECT * FROM messages WHERE session_id = ? ORDER BY seq DESC LIMIT 1").get(sessionId) as MessageRow | null) ?? null
  }

  /** Lowest seq in use, or null for an empty session. */
  firstSeq(sessionId: string): number | null {
    const row = this.db.query("SELECT MIN(seq) AS seq FROM messages WHERE session_id = ?").get(sessionId) as { seq: number | null } | null
    return row?.seq ?? null
  }

  patchSession(id: string, patch: SessionPatch = {}): SessionRow | null {
    const current = this.getSession(id)
    if (!current) return null
    const nextTitle = patch.title ?? current.title
    const nextPinned = patch.pinned === undefined ? current.pinned : patch.pinned ? 1 : 0
    const nextArchived = patch.archived === undefined ? current.archived : patch.archived ? 1 : 0
    const nextStatus = patch.status ?? current.status
    const nextRead = patch.lastReadSeq === undefined ? current.last_read_seq : patch.lastReadSeq
    const nextCwd = patch.cwd ?? current.cwd
    const nextModel = patch.model ?? current.model
    const nextAgent = patch.agent ?? current.agent
    const nextNative = patch.nativeId === undefined ? current.native_id : patch.nativeId
    const nextUsage = patch.usage === undefined ? current.usage : JSON.stringify(patch.usage)
    const nextMode = patch.permissionMode ?? current.permission_mode
    const nextEffort = patch.effort ?? current.effort
    const nextSpeed = patch.speed ?? current.speed
    const nextContextWindow = patch.contextWindow === undefined ? current.context_window : patch.contextWindow
    const nextCompactionCount = patch.compactionCount ?? current.compaction_count
    const nextUnread = patch.unread === undefined ? current.marked_unread : patch.unread ? 1 : 0
    const nextAutoTitle = patch.autoTitle ?? (patch.title === undefined ? (current.auto_title ?? 0) : 0)
    // Read cursors, the manual unread dot, pin and archive are markers. Moving them must not reorder the list.
    // A content field in the same patch still refreshes updated_at. An empty patch still does.
    const contentChange =
      patch.title !== undefined ||
      patch.status !== undefined ||
      patch.cwd !== undefined ||
      patch.model !== undefined ||
      patch.agent !== undefined ||
      patch.nativeId !== undefined ||
      patch.usage !== undefined ||
      patch.permissionMode !== undefined ||
      patch.effort !== undefined ||
      patch.speed !== undefined ||
      patch.contextWindow !== undefined ||
      patch.compactionCount !== undefined
    const markerChange =
      patch.lastReadSeq !== undefined ||
      patch.unread !== undefined ||
      patch.pinned !== undefined ||
      patch.archived !== undefined
    const updatedAt = markerChange && !contentChange ? current.updated_at : Date.now()
    const activeAt = orderMoves(current.status, nextStatus) ? updatedAt : (current.active_at ?? current.updated_at)
    this.db.query(
      "UPDATE sessions SET title = ?, pinned = ?, archived = ?, status = ?, last_read_seq = ?, cwd = ?, model = ?, agent = ?, native_id = ?, usage = ?, permission_mode = ?, effort = ?, speed = ?, context_window = ?, compaction_count = ?, marked_unread = ?, auto_title = ?, updated_at = ?, active_at = ? WHERE id = ?",
    ).run(
      nextTitle,
      nextPinned,
      nextArchived,
      nextStatus,
      nextRead,
      nextCwd,
      nextModel,
      nextAgent,
      nextNative,
      nextUsage,
      nextMode,
      nextEffort,
      nextSpeed,
      nextContextWindow,
      nextCompactionCount,
      nextUnread,
      nextAutoTitle,
      updatedAt,
      activeAt,
      id,
    )
    return this.getSession(id)
  }

  patchContextUsage(id: string, used: number, size?: number): SessionRow | null {
    const session = this.getSession(id)
    if (!session) return null
    const usage = parseUsage(session.usage)
    usage.contextUsed = used
    if (size !== undefined) usage.contextSize = size
    return this.patchSession(id, { usage })
  }

  markRead(id: string): SessionRow | null {
    const current = this.getSession(id)
    if (!current) return null
    return this.patchSession(id, { lastReadSeq: current.last_seq, unread: false })
  }

  markAllRead(): SessionRow[] {
    this.db.query("UPDATE sessions SET last_read_seq = last_seq, marked_unread = 0").run()
    return this.listSessions()
  }

  deleteSession(id: string): boolean {
    return this.transaction(() => {
      if (!this.getSession(id)) return false
      this.db.query("DELETE FROM messages WHERE session_id = ?").run(id)
      this.db.query("DELETE FROM scheduled WHERE session_id = ?").run(id)
      this.db.query("DELETE FROM drafts WHERE session_id = ?").run(id)
      this.db.query("DELETE FROM limit_resumes WHERE session_id = ?").run(id)
      this.db.query("DELETE FROM permission_rules WHERE session_id = ?").run(id)
      this.db.query("DELETE FROM message_sends WHERE session_id = ?").run(id)
      this.db.query("DELETE FROM session_turns WHERE session_id = ?").run(id)
      this.db.query("DELETE FROM turn_changes WHERE session_id = ?").run(id)
      this.db.query("DELETE FROM live_activities WHERE session_id = ?").run(id)
      this.db.query("DELETE FROM sessions WHERE id = ?").run(id)
      return true
    })
  }

  // Also drops the agent-native session: the next turn starts a fresh agent conversation.
  clearMessages(sessionId: string) {
    this.transaction(() => {
      this.db.query("DELETE FROM messages WHERE session_id = ?").run(sessionId)
      this.db.query(
        "UPDATE sessions SET last_seq = 0, last_read_seq = 0, native_id = NULL, fork_native = NULL, carry_seq = 0, generation = generation + 1, updated_at = ? WHERE id = ?",
      ).run(Date.now(), sessionId)
      this.resetPreview(sessionId)
    })
  }

  // Like clearMessages, drops the agent-native session: the agent would otherwise still remember
  // the turns removed from the transcript. The turns that stay are carried over to the next one.
  // `native`: the agent already cut its own session at the same place, so it stays and nothing is carried.
  rewindSession(sessionId: string, seq: number, native = false): SessionRow | null {
    return this.transaction(() => {
      this.db.query("DELETE FROM messages WHERE session_id = ? AND seq > ?").run(sessionId, seq)
      const last = this.db.query("SELECT MAX(seq) AS seq FROM messages WHERE session_id = ?").get(sessionId) as { seq: number | null }
      const lastSeq = last.seq ?? 0
      if (native) {
        this.db.query(
          "UPDATE sessions SET last_seq = ?, last_read_seq = MIN(last_read_seq, ?), generation = generation + 1, updated_at = ? WHERE id = ?",
        ).run(lastSeq, lastSeq, Date.now(), sessionId)
      } else {
        this.db.query(
          "UPDATE sessions SET last_seq = ?, last_read_seq = MIN(last_read_seq, ?), native_id = NULL, fork_native = NULL, carry_seq = ?, generation = generation + 1, updated_at = ? WHERE id = ?",
        ).run(lastSeq, lastSeq, lastSeq, Date.now(), sessionId)
      }
      this.resetPreview(sessionId)
      return this.getSession(sessionId)
    })
  }

  async forkSession(id: string, title?: string, options: { signal?: AbortSignal; yieldControl?: () => Promise<void> } = {}): Promise<SessionRow | null> {
    options.signal?.throwIfAborted()
    const source = this.getSession(id)
    if (!source) return null
    // The copy starts without a native id: the agent cannot share one native session between two.
    // Its first turn forks the source's native session where the agent can, else carries the transcript over.
    const copy = this.transaction(() => {
      const pending = this.createSession({
      title: title?.trim() || `${source.title} 副本`,
      agent: source.agent,
      cwd: source.cwd,
      model: source.model,
      permissionMode: source.permission_mode,
      effort: source.effort,
      speed: source.speed,
      contextWindow: source.context_window ?? undefined,
      })
      this.db.query("INSERT INTO session_copy_jobs VALUES (?, ?, ?, ?, ?)")
        .run(pending.id, id, source.generation ?? 0, source.rev_counter ?? 0, source.last_seq)
      return pending
    })
    const validate = () => {
      options.signal?.throwIfAborted()
      const current = this.getSession(id)
      if (!current || current.generation !== source.generation || current.rev_counter !== source.rev_counter || current.last_seq !== source.last_seq
        || current.status !== source.status || current.native_id !== source.native_id || current.fork_native !== source.fork_native) {
        throw Object.assign(new Error(`source session ${id} changed during copy`), { code: "source_changed" })
      }
    }
    const yieldControl = options.yieldControl ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
    let after = 0
    let batchRows = COPY_BATCH_ROWS
    try {
      for (;;) {
        const started = performance.now()
        const usedBatchRows = batchRows
        const count = this.transaction(() => {
          validate()
          const rows = this.db.query("SELECT * FROM messages WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?")
            .all(id, after, usedBatchRows) as MessageRow[]
          for (const message of rows) {
            this.insertMessage({ ...message, id: crypto.randomUUID(), session_id: copy.id, rev: undefined })
            after = message.seq
          }
          return rows.length
        })
        const elapsed = performance.now() - started
        if (elapsed > COPY_BATCH_MS) batchRows = Math.max(1, Math.floor(batchRows * COPY_BATCH_MS / elapsed))
        if (count < usedBatchRows) break
        await yieldControl()
      }
      return this.transaction(() => {
        validate()
        // An unrun copy continues from the same original native parent.
        this.db.query("UPDATE sessions SET fork_native = ?, carry_seq = ? WHERE id = ?")
          .run(source.native_id ?? source.fork_native ?? null, after, copy.id)
        this.db.query("DELETE FROM session_copy_jobs WHERE destination_id = ?").run(copy.id)
        this.touchSession(copy.id)
        return this.getSession(copy.id)
      })
    } catch (error) {
      try {
        this.discardIncompleteCopy(copy.id)
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], `copy ${copy.id} failed and staging cleanup could not complete`)
      }
      throw error
    }
  }

  /** Only the daemon owner recovers jobs; a CLI opening the same live database must not delete active copies. */
  recoverIncompleteCopies(): void {
    const jobs = this.db.query("SELECT destination_id FROM session_copy_jobs").all() as Array<{ destination_id: string }>
    for (const job of jobs) this.discardIncompleteCopy(job.destination_id)
  }

  private discardIncompleteCopy(id: string): void {
    this.transaction(() => {
      if (!this.db.query("SELECT 1 FROM session_copy_jobs WHERE destination_id = ?").get(id)) return
      this.db.query("DELETE FROM session_copy_jobs WHERE destination_id = ?").run(id)
      this.deleteSession(id)
      // This identity was never published, so an aborted copy needs no public tombstone.
      this.db.query("DELETE FROM session_tombstones WHERE id = ?").run(id)
    })
  }

  // The source's agent-native session is about to take another turn: copies that have not forked it yet
  // would otherwise inherit that turn too, so they carry the transcript over instead.
  dropForksOf(nativeId: string) {
    this.db.query("UPDATE sessions SET fork_native = NULL WHERE fork_native = ?").run(nativeId)
  }

  // The agent-native session took over (its first turn ran): nothing is left to fork or carry over.
  settleCarryOver(sessionId: string) {
    this.db
      .query("UPDATE sessions SET fork_native = NULL, carry_seq = 0 WHERE id = ? AND (fork_native IS NOT NULL OR carry_seq > 0)")
      .run(sessionId)
  }

  // r72: the session goes on with another agent. The old agent-native session cannot follow, so the whole
  // transcript so far is carried in front of the next message, and a notice row marks the switch.
  switchSessionAgent(
    sessionId: string,
    to: { agent: string; model: string; permissionMode: RudderPermissionMode },
    notice: { id: string; text: string; payload: string },
  ): { session: SessionRow; notice: MessageRow } | null {
    return this.transaction(() => {
      const session = this.getSession(sessionId)
      if (!session) return null
      const carry = Math.max(session.carry_seq ?? 0, session.last_seq)
      this.db
        .query(
          "UPDATE sessions SET agent = ?, model = ?, effort = '', speed = '', context_window = NULL, permission_mode = ?, native_id = NULL, fork_native = NULL, carry_seq = ? WHERE id = ?",
        )
        .run(to.agent, to.model, to.permissionMode, carry, sessionId)
      const row = this.insertMessage({ ...notice, session_id: sessionId, kind: "text", role: "assistant", created_at: Date.now() })
      const updated = this.getSession(sessionId)
      return updated ? { session: updated, notice: row } : null
    })
  }

  listMessages(sessionId: string, options: { beforeSeq?: number; limit?: number } = {}): MessageRow[] {
    if (this.db.query("SELECT 1 FROM session_copy_jobs WHERE destination_id = ?").get(sessionId)) return []
    if (options.beforeSeq !== undefined) {
      const limit = options.limit ?? 40
      const rows = this.db.query(
        "SELECT * FROM messages WHERE session_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?",
      ).all(sessionId, options.beforeSeq, limit) as MessageRow[]
      return rows.reverse()
    }
    if (options.limit !== undefined) {
      const rows = this.db.query(
        "SELECT * FROM messages WHERE session_id = ? ORDER BY seq DESC LIMIT ?",
      ).all(sessionId, options.limit) as MessageRow[]
      return rows.reverse()
    }
    return this.db.query("SELECT * FROM messages WHERE session_id = ? ORDER BY seq ASC").all(sessionId) as MessageRow[]
  }

  hasMessageBefore(sessionId: string, beforeSeq: number): boolean {
    return this.db.query(
      `SELECT 1 FROM messages WHERE session_id = ? AND seq < ?
       AND NOT EXISTS (SELECT 1 FROM session_copy_jobs WHERE destination_id = ?) LIMIT 1`,
    ).get(sessionId, beforeSeq, sessionId) !== null
  }

  /** Every message of a session oldest first, read `page` rows at a time so a long session is never in memory whole. */
  *messagesInPages(sessionId: string, page = 500): Generator<MessageRow> {
    if (this.db.query("SELECT 1 FROM session_copy_jobs WHERE destination_id = ?").get(sessionId)) return
    let after = 0
    for (;;) {
      const rows = this.db
        .query("SELECT * FROM messages WHERE session_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?")
        .all(sessionId, after, page) as MessageRow[]
      yield* rows
      if (rows.length < page) return
      after = rows.at(-1)!.seq
    }
  }

  /**
   * One page of what `message.search` reads, oldest first, strictly between `afterSeq` and `beforeSeq`: user and
   * assistant bodies (never Rudder's notices) and tool cards. Only what is searched leaves SQLite: a tool row's
   * payload comes back as its id, tool, title and the first line of its detail.
   */
  searchPage(sessionId: string, afterSeq: number, beforeSeq: number, limit: number): MessageRow[] {
    const detail = "json_extract(payload, '$.detail')"
    return this.db
      .query(
        `SELECT id, session_id, seq, kind, role, created_at,
           CASE WHEN kind = 'text' THEN text ELSE '' END AS text,
           CASE WHEN kind = 'tool' AND json_valid(payload) THEN json_object(
             'id', json_extract(payload, '$.id'),
             'tool', json_extract(payload, '$.tool'),
             'title', json_extract(payload, '$.title'),
             'detail', CASE WHEN instr(${detail}, char(10)) > 0 THEN substr(${detail}, 1, instr(${detail}, char(10)) - 1) ELSE ${detail} END
           ) END AS payload
         FROM messages
         WHERE session_id = ? AND seq > ? AND seq < ?
           AND ${VISIBLE_MESSAGE}
           AND (kind = 'tool' OR (kind = 'text' AND role IN ('user', 'assistant') AND ${NOT_NOTICE_SQL}))
         ORDER BY seq ASC LIMIT ?`,
      )
      .all(sessionId, afterSeq, beforeSeq, limit) as MessageRow[]
  }

  nextSeq(sessionId: string): number {
    const row = this.db.query("SELECT MAX(seq) AS seq FROM messages WHERE session_id = ?").get(sessionId) as { seq: number | null }
    return (row.seq ?? 0) + 1
  }

  listAgentImageScopes(): { sessionId: string; cwd: string }[] {
    return this.db.query(
      `SELECT s.id AS sessionId, s.cwd AS cwd FROM sessions s
       WHERE EXISTS (SELECT 1 FROM messages WHERE session_id = s.id AND ${AGENT_IMAGE_ROW})
         AND NOT EXISTS (SELECT 1 FROM session_copy_jobs WHERE destination_id = s.id)`,
    ).all() as { sessionId: string; cwd: string }[]
  }

  findAgentImageCreatedAt(sessionId: string, attachmentId: string): number | null {
    const row = this.db.query(
      `SELECT created_at AS createdAt FROM messages
       WHERE session_id = ? AND ${AGENT_IMAGE_ROW} AND (${AGENT_IMAGE_ID}) = ?
         AND NOT EXISTS (SELECT 1 FROM session_copy_jobs WHERE destination_id = ?)
       ORDER BY created_at ASC LIMIT 1`,
    ).get(sessionId, attachmentId, sessionId) as { createdAt: number } | null
    return row?.createdAt ?? null
  }

  getMessage(id: string): MessageRow | null {
    return (this.db.query(`SELECT * FROM messages WHERE id = ? AND ${VISIBLE_MESSAGE}`).get(id) as MessageRow | null) ?? null
  }

  /** Latest user prompt. Messages after it are the live turn and stay full when outlined. */
  lastPromptSeq(sessionId: string): number | null {
    const row = this.db.query(
      "SELECT MAX(seq) AS seq FROM messages WHERE session_id = ? AND role = 'user' AND kind != 'error'",
    ).get(sessionId) as { seq: number | null }
    return row.seq
  }

  /** Newest user row still waiting to be marked read. One indexed row, not the transcript. */
  latestSentSteer(sessionId: string): string | null {
    const row = this.db.query(
      `SELECT id FROM messages
       WHERE session_id = ? AND role = 'user' AND json_extract(payload, '$.steer') = 'sent'
       ORDER BY seq DESC LIMIT 1`,
    ).get(sessionId) as { id: string } | null
    return row?.id ?? null
  }

  /** Newest assistant prose, excluding Rudder's own notice rows. `beforeSeq` walks older batches. */
  assistantTexts(sessionId: string, beforeSeq: number | undefined, limit: number): { seq: number; text: string }[] {
    if (beforeSeq !== undefined) {
      return this.db.query(
        `SELECT seq, text FROM messages
         WHERE session_id = ? AND seq < ? AND kind = 'text' AND role = 'assistant'
           AND ${NOT_NOTICE_SQL}
         ORDER BY seq DESC LIMIT ?`,
      ).all(sessionId, beforeSeq, limit) as { seq: number; text: string }[]
    }
    return this.db.query(
      `SELECT seq, text FROM messages
       WHERE session_id = ? AND kind = 'text' AND role = 'assistant'
         AND ${NOT_NOTICE_SQL}
       ORDER BY seq DESC LIMIT ?`,
    ).all(sessionId, limit) as { seq: number; text: string }[]
  }

  getSend(identity: SendIdentity): SendRequestRow | null {
    return this.db.query(
      "SELECT * FROM message_sends WHERE session_id = ? AND device_id = ? AND client_message_id = ?",
    ).get(identity.sessionId, identity.deviceId, identity.clientMessageId) as SendRequestRow | null
  }

  listQueuedSends(): SendRequestRow[] {
    return this.db.query("SELECT * FROM message_sends WHERE queued = 1 ORDER BY rowid").all() as SendRequestRow[]
  }

  findSendByQueue(sessionId: string, deviceId: string, queueId: string): SendRequestRow | null {
    return this.db.query("SELECT * FROM message_sends WHERE session_id = ? AND device_id = ? AND json_extract(result, '$.queueId') = ? ORDER BY rowid DESC LIMIT 1")
      .get(sessionId, deviceId, queueId) as SendRequestRow | null
  }

  createTurn(sessionId: string, userMessageId: string, clientMessageId?: string): TurnRow {
    const last = this.db.query("SELECT MAX(sequence) AS sequence FROM session_turns WHERE session_id = ?").get(sessionId) as { sequence: number | null }
    const row: TurnRow = {
      id: crypto.randomUUID(), session_id: sessionId, user_message_id: userMessageId,
      client_message_id: clientMessageId ?? null, sequence: (last.sequence ?? 0) + 1,
      revision: 1, phase: "preparing", updated_at: Date.now(),
    }
    this.db.query("INSERT INTO session_turns(id, session_id, user_message_id, client_message_id, sequence, revision, phase, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(row.id, row.session_id, row.user_message_id, row.client_message_id, row.sequence, row.revision, row.phase, row.updated_at)
    return row
  }

  getTurn(id: string): TurnRow | null {
    return this.db.query("SELECT * FROM session_turns WHERE id = ?").get(id) as TurnRow | null
  }

  listLatestTurns(): TurnRow[] {
    return this.db.query("SELECT * FROM session_turns AS current WHERE NOT EXISTS (SELECT 1 FROM session_copy_jobs WHERE destination_id = current.session_id) AND sequence = (SELECT MAX(sequence) FROM session_turns WHERE session_id = current.session_id)").all() as TurnRow[]
  }

  advanceTurn(id: string, phase: TurnPhase): TurnRow | null {
    const current = this.getTurn(id)
    if (!current || current.phase === phase || ["done", "failed", "interrupted"].includes(current.phase)) return current
    const next = { ...current, phase, revision: current.revision + 1, updated_at: Date.now() }
    this.db.query("UPDATE session_turns SET phase = ?, revision = ?, updated_at = ? WHERE id = ?")
      .run(next.phase, next.revision, next.updated_at, id)
    return next
  }

  setTurnOutcome(id: string, outcome: TurnOutcome): MessageRow | null {
    return this.transaction(() => {
      const turn = this.getTurn(id)
      if (!turn) return null
      this.db.query("UPDATE session_turns SET outcome = ? WHERE id = ?").run(JSON.stringify(outcome), id)
      const prompt = this.getMessage(turn.user_message_id)
      if (!prompt || prompt.session_id !== turn.session_id) return null
      const payload: unknown = prompt.payload ? JSON.parse(prompt.payload) : {}
      if (!isObject(payload)) throw new Error(`Prompt ${prompt.id} has invalid turn payload`)
      const previous = isObject(payload.turnEnd) ? payload.turnEnd : undefined
      if (previous?.id === id && JSON.stringify(previous.outcome) === JSON.stringify(outcome)) return null
      const revision = typeof previous?.revision === "number" ? previous.revision + 1 : 1
      return this.insertMessage({ ...prompt, payload: JSON.stringify({ ...payload, turnEnd: { id, revision, outcome } }) })
    })
  }

  private backfillTurnOutcomes() {
    let cursor = 0
    for (;;) {
      const rows = this.db.query(`SELECT t.*, t.rowid AS cursor FROM session_turns t JOIN messages m ON m.id = t.user_message_id
        WHERE t.rowid > ? AND t.phase IN ('done', 'failed', 'interrupted')
          AND (m.payload IS NULL OR (json_valid(m.payload) AND json_extract(m.payload, '$.turnEnd') IS NULL))
        ORDER BY t.rowid LIMIT 128`).all(cursor) as Array<TurnRow & { cursor: number }>
      if (!rows.length) return
      for (const row of rows) {
        cursor = row.cursor
        const decoded = decodePayload(row.outcome ?? null)
        const prior = decoded.ok && isObject(decoded.value) ? decoded.value : {}
        const phase = ["done", "failed", "interrupted"].includes(String(prior.phase)) ? prior.phase : row.phase
        const outcome = { ...prior, phase, endedAt: typeof prior.endedAt === "number" ? prior.endedAt : row.updated_at,
          ...(!prior.termination && phase !== "done" ? { termination: { cause: "unknown", requestedAt: row.updated_at } } : {}) } as TurnOutcome
        this.setTurnOutcome(row.id, outcome)
      }
    }
  }

  claimRestartResume(turnId: string, generation: number): "new" | "pending" | "accepted" | "obsolete" {
    return this.transaction(() => {
      const turn = this.getTurn(turnId)
      if (!turn || (this.getSession(turn.session_id)?.generation ?? -1) !== generation) return "obsolete"
      const accepted = this.db.query("SELECT 1 FROM message_sends WHERE session_id = ? AND device_id = ? AND client_message_id = ?")
        .get(turn.session_id, "daemon:restart", restartMessageId(turnId, generation))
      if (accepted) {
        this.completeRestartResume(turnId, generation)
        return "accepted"
      }
      const row = this.db.query("SELECT status FROM restart_resumes WHERE turn_id = ? AND generation = ?").get(turnId, generation) as { status: "pending" | "accepted" } | null
      if (row) return row.status
      this.db.query("INSERT INTO restart_resumes(turn_id, generation, status) VALUES (?, ?, 'pending')").run(turnId, generation)
      return "new"
    })
  }

  completeRestartResume(turnId: string, generation: number) {
    this.db.query("INSERT OR REPLACE INTO restart_resumes(turn_id, generation, status) VALUES (?, ?, 'accepted')").run(turnId, generation)
  }

  setTurnExecution(id: string, execution: TurnExecutionIdentity) {
    this.db.query("UPDATE session_turns SET execution = ? WHERE id = ?").run(JSON.stringify(execution), id)
  }

  setTurnTermination(id: string, incoming: TurnTermination): TurnTermination {
    return this.transaction(() => {
      const row = this.getTurn(id)
      const current = row?.termination ? JSON.parse(row.termination) as TurnTermination : undefined
      const next = recordTermination(current, incoming)
      this.db.query("UPDATE session_turns SET termination = ? WHERE id = ?").run(JSON.stringify(next), id)
      return next
    })
  }

  setTurnNative(id: string, native: TurnNative) {
    this.db.query("UPDATE session_turns SET native = ? WHERE id = ?").run(JSON.stringify(native), id)
  }

  /**
   * The native positions around a rewind that keeps messages up to `seq`, when the first removed message is a
   * turn's prompt and both that turn and the last kept one recorded where they sit. Null otherwise: a cut inside
   * a turn, or turns from before native positions were recorded.
   */
  rewindBoundary(sessionId: string, seq: number): RewindBoundary | null {
    const first = this.db
      .query("SELECT id FROM messages WHERE session_id = ? AND seq > ? ORDER BY seq ASC LIMIT 1")
      .get(sessionId, seq) as { id: string } | null
    if (!first) return null
    const removed = this.db
      .query("SELECT native FROM session_turns WHERE session_id = ? AND user_message_id = ?")
      .get(sessionId, first.id) as { native: string | null } | null
    const kept = this.db
      .query(
        `SELECT st.native AS native FROM session_turns st
         JOIN messages m ON m.id = st.user_message_id AND m.session_id = st.session_id
         WHERE st.session_id = ? AND m.seq <= ?
         ORDER BY m.seq DESC LIMIT 1`,
      )
      .get(sessionId, seq) as { native: string | null } | null
    if (!removed?.native || !kept?.native) return null
    const compacted = this.db
      .query("SELECT 1 AS hit FROM messages WHERE session_id = ? AND seq > ? AND kind = 'compaction' LIMIT 1")
      .get(sessionId, seq) !== null
    return { kept: JSON.parse(kept.native) as TurnNative, removed: JSON.parse(removed.native) as TurnNative, compacted }
  }

  /** Turns whose user message is at or after `seq`, oldest first. The message must still be stored. */
  turnIdsFromSeq(sessionId: string, seq: number): string[] {
    const rows = this.db
      .query(
        `SELECT st.id AS id FROM session_turns st
         JOIN messages m ON m.id = st.user_message_id AND m.session_id = st.session_id
         WHERE st.session_id = ? AND m.seq >= ?
         ORDER BY m.seq ASC`,
      )
      .all(sessionId, seq) as { id: string }[]
    return rows.map((row) => row.id)
  }

  putTurnChanges(changes: TurnChanges) {
    this.db.query("INSERT OR REPLACE INTO turn_changes(turn_id, session_id, body) VALUES (?, ?, ?)")
      .run(changes.turnId, changes.sessionId, JSON.stringify(changes))
  }

  getTurnChanges(turnId: string): TurnChanges | null {
    const row = this.db.query("SELECT body FROM turn_changes WHERE turn_id = ?").get(turnId) as { body: string } | null
    return row ? (JSON.parse(row.body) as TurnChanges) : null
  }

  putSend(identity: SendIdentity, result: unknown) {
    const item = (result as { queued?: unknown } | null)?.queued
    const queued = typeof item === "object" && item !== null
    this.db.query(
      `INSERT INTO message_sends(session_id, device_id, client_message_id, request_hash, result, queued, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, device_id, client_message_id) DO UPDATE SET
         result = excluded.result, queued = excluded.queued, updated_at = excluded.updated_at
       WHERE message_sends.request_hash = excluded.request_hash`,
    ).run(identity.sessionId, identity.deviceId, identity.clientMessageId, identity.requestHash,
      JSON.stringify(identity.queueId ? { ...(result as Record<string, unknown>), queueId: identity.queueId } : result),
      queued ? 1 : 0, Date.now())
  }

  // Upsert by id. An existing row keeps its session, seq and first created_at; only a new row
  // touches the session's last_seq / updated_at. `quiet` is a streaming block's in-flight write: the row keeps its rev
  // and the session row its version until the next plain write of the same id (or `settleMessage`) takes one rev for
  // everything written meanwhile. A daemon that dies in between settles at the next start.
  insertMessage(
    row: Omit<MessageRow, "seq" | "payload"> & { seq?: number; payload?: string | null },
    options: { quiet?: boolean } = {},
  ): MessageRow {
    return this.transaction(() => {
      const existing = this.db.query("SELECT session_id, seq, created_at, rev FROM messages WHERE id = ?").get(row.id) as
        | { session_id: string; seq: number; created_at: number; rev: number }
        | null
      if (existing && existing.session_id !== row.session_id) {
        throw Object.assign(new Error(`message ${row.id} belongs to another session`), { code: "conflict" })
      }
      let settling = false
      if (options.quiet) this.db.query("INSERT OR IGNORE INTO stream_quiet(id) VALUES (?)").run(row.id)
      else settling = this.db.query("DELETE FROM stream_quiet WHERE id = ?").run(row.id).changes > 0
      const seq = existing?.seq ?? row.seq ?? this.nextSeq(row.session_id)
      const full: MessageRow = { ...row, seq, payload: row.payload ?? null, created_at: existing?.created_at ?? row.created_at }
      this.db.query(
        `INSERT INTO messages(id, session_id, seq, kind, role, text, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET text = excluded.text, kind = excluded.kind, payload = excluded.payload
         WHERE messages.session_id = excluded.session_id`,
      ).run(full.id, full.session_id, full.seq, full.kind, full.role, full.text, full.payload, full.created_at)
      if (!existing) {
        this.db.query(
          "UPDATE sessions SET updated_at = ?, last_seq = CASE WHEN last_seq > ? THEN last_seq ELSE ? END WHERE id = ?",
        ).run(full.created_at, full.seq, full.seq, full.session_id)
      }
      if (isPreviewRow(full)) this.movePreview(full)
      let stored = this.db.query("SELECT rev FROM messages WHERE id = ?").get(full.id) as { rev: number } | null
      // The text matched the last quiet write, so the trigger saw no change; the block still owes its rev.
      if (settling && existing && stored?.rev === existing.rev) stored = { rev: this.takeRev(full.session_id, full.id) }
      return { ...full, rev: stored?.rev ?? 0 }
    })
  }

  /** Ends a streamed block's quiet writes without rewriting its text: one new rev when it had any, else null. */
  settleMessage(id: string): number | null {
    return this.transaction(() => {
      if (this.db.query("DELETE FROM stream_quiet WHERE id = ?").run(id).changes === 0) return null
      const row = this.db.query("SELECT session_id FROM messages WHERE id = ?").get(id) as { session_id: string } | null
      return row ? this.takeRev(row.session_id, id) : null
    })
  }

  // What the sync_message_update trigger does, for a row whose columns did not change.
  private takeRev(sessionId: string, id: string): number {
    this.db.query("UPDATE sessions SET rev_counter = rev_counter + 1 WHERE id = ?").run(sessionId)
    this.db
      .query("UPDATE messages SET rev = COALESCE((SELECT rev_counter FROM sessions WHERE id = ?), 0) WHERE id = ?")
      .run(sessionId, id)
    return (this.db.query("SELECT rev FROM messages WHERE id = ?").get(id) as { rev: number }).rev
  }

  /** `message.changes`: rows of this session changed after `sinceRev`, rev ascending; one extra row tells hasMore. */
  messageChanges(sessionId: string, sinceRev: number, limit: number): { rows: MessageRow[]; hasMore: boolean } {
    const rows = this.db
      .query("SELECT * FROM messages WHERE session_id = ? AND rev > ? ORDER BY rev ASC LIMIT ?")
      .all(sessionId, sinceRev, limit + 1) as MessageRow[]
    return { rows: rows.slice(0, limit), hasMore: rows.length > limit }
  }

  /** Current global session version: the cursor `session.list` hands out. */
  sessionVersion(): number {
    return (this.db.query("SELECT value FROM sync_counters WHERE name = 'session_version'").get() as { value: number }).value
  }

  /**
   * Bumps a session's version for a change that lives outside its row (holder, lastTurn, pending, step).
   * Null when the session is gone.
   */
  touchSession(id: string): number | null {
    return this.transaction(() => {
      if (!this.db.query("SELECT 1 FROM sessions WHERE id = ?").get(id)) return null
      this.db.query("UPDATE sync_counters SET value = value + 1 WHERE name = 'session_version'").run()
      const version = this.sessionVersion()
      this.db.query("UPDATE sessions SET version = ? WHERE id = ?").run(version, id)
      return version
    })
  }

  /**
   * `session.list {sinceVersion}`: sessions changed after the cursor and ids deleted after it. `reset` when the
   * cursor is ahead of this store (another database) or behind a pruned tombstone.
   */
  sessionChanges(sinceVersion: number): { reset: true; version: number } | { reset: false; sessions: SessionRow[]; deleted: string[]; version: number } {
    return this.transaction(() => {
      const version = this.sessionVersion()
      const horizon = (this.db.query("SELECT value FROM sync_counters WHERE name = 'tombstone_horizon'").get() as { value: number }).value
      if (sinceVersion > version || sinceVersion < horizon) return { reset: true as const, version }
      const sessions = this.db
        .query(`SELECT * FROM sessions WHERE version > ? AND ${VISIBLE_SESSION} ORDER BY pinned DESC, updated_at DESC`)
        .all(sinceVersion) as SessionRow[]
      const deleted = (this.db.query("SELECT id FROM session_tombstones WHERE version > ? ORDER BY version").all(sinceVersion) as Array<{ id: string }>)
        .map((row) => row.id)
      return { reset: false as const, sessions, deleted, version }
    })
  }

  // A text row at or after the current preview takes it over; an older row (an earlier block still streaming) or
  // one that strips to nothing leaves it alone, and an unchanged preview is not written again.
  private movePreview(row: MessageRow) {
    const text = previewText(row.text)
    if (!text) return
    this.db.query(
      `UPDATE sessions SET preview_role = ?1, preview_text = ?2, preview_at = ?3, preview_seq = ?4
       WHERE id = ?5 AND preview_seq <= ?4 AND NOT (preview_seq = ?4 AND preview_text IS ?2 AND preview_role IS ?1)`,
    ).run(row.role, text, row.created_at, row.seq, row.session_id)
  }

  // Recomputes the preview from the stored rows: after a rewind or clear, and for rows written before it existed.
  private resetPreview(sessionId: string) {
    this.db.query("UPDATE sessions SET preview_role = NULL, preview_text = NULL, preview_at = NULL, preview_seq = 0 WHERE id = ?").run(sessionId)
    // Newest first; the first row with visible text wins.
    const rows = this.db.query(
      `SELECT * FROM messages WHERE session_id = ? AND kind = 'text' AND role IN ('user', 'assistant')
       ORDER BY seq DESC LIMIT ${PREVIEW_LOOKBACK}`,
    ).all(sessionId) as MessageRow[]
    const row = rows.find((candidate) => isPreviewRow(candidate) && previewText(candidate.text))
    if (row) this.movePreview(row)
  }

  putDevice(row: DeviceRow) {
    this.db.query(
      "INSERT INTO devices(id, session_key, name, created_at, push_token) VALUES (?, ?, ?, ?, ?)",
    ).run(row.id, row.session_key, row.name, row.created_at, row.push_token ?? null)
  }

  listDevices(): DeviceRow[] {
    return this.db.query("SELECT * FROM devices ORDER BY created_at ASC, rowid ASC").all() as DeviceRow[]
  }

  // Returns the removed row so the caller can close that device's sockets.
  deleteDevice(id: string): DeviceRow | null {
    return this.transaction(() => {
      const row = (this.db.query("SELECT * FROM devices WHERE id = ?").get(id) as DeviceRow | null) ?? null
      if (row) {
        this.db.query("DELETE FROM devices WHERE id = ?").run(id)
        // Live Activity rows keep the device's session key to seal lock-screen text; nothing on disk keeps it after revoke.
        this.db.query("DELETE FROM live_activities WHERE device_key = ?").run(row.session_key)
        this.db.query("DELETE FROM live_cards WHERE device_key = ?").run(row.session_key)
      }
      return row
    })
  }

  deviceById(id: string): DeviceRow | null {
    return (this.db.query("SELECT * FROM devices WHERE id = ?").get(id) as DeviceRow | null) ?? null
  }

  deviceByKey(sessionKey: string): DeviceRow | null {
    return (this.db.query("SELECT * FROM devices WHERE session_key = ?").get(sessionKey) as DeviceRow | null) ?? null
  }

  setDevicePushToken(sessionKey: string, token: string): DeviceRow | null {
    this.db.query("UPDATE devices SET push_token = ? WHERE session_key = ?").run(token, sessionKey)
    return this.deviceByKey(sessionKey)
  }

  setDevicePushPrefs(sessionKey: string, prefs: string | null) {
    this.db.query("UPDATE devices SET push_prefs = ? WHERE session_key = ?").run(prefs, sessionKey)
  }

  setDeviceLiveStart(sessionKey: string, start: LiveStart | null) {
    this.db.query("UPDATE devices SET live_start = ? WHERE session_key = ?").run(start ? JSON.stringify(start) : null, sessionKey)
  }

  touchDevice(sessionKey: string, at = Date.now()) {
    this.db.query("UPDATE devices SET last_seen_at = ? WHERE session_key = ?").run(at, sessionKey)
  }

  /** Only while the row still holds `ticket`: a ticket the app registered meanwhile stays. */
  clearDevicePushToken(id: string, ticket: string): boolean {
    return this.db.query("UPDATE devices SET push_token = NULL WHERE id = ? AND push_token = ?").run(id, ticket).changes > 0
  }

  putLiveActivity(row: LiveActivityRow) {
    this.db.query(
      `INSERT INTO live_activities(session_id, activity_id, push_token, device_key, keep_seconds, locale, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         activity_id = excluded.activity_id,
         push_token = excluded.push_token,
         device_key = excluded.device_key,
         keep_seconds = excluded.keep_seconds,
         locale = excluded.locale,
         started_at = excluded.started_at`,
    ).run(row.session_id, row.activity_id, row.push_token, row.device_key, row.keep_seconds, row.locale, row.started_at)
  }

  liveActivity(sessionId: string): LiveActivityRow | null {
    return (this.db.query("SELECT * FROM live_activities WHERE session_id = ?").get(sessionId) as LiveActivityRow | null) ?? null
  }

  liveActivityByActivity(activityId: string): LiveActivityRow | null {
    return (this.db.query("SELECT * FROM live_activities WHERE activity_id = ?").get(activityId) as LiveActivityRow | null) ?? null
  }

  deleteLiveActivity(sessionId: string) {
    this.db.query("DELETE FROM live_activities WHERE session_id = ?").run(sessionId)
  }

  listLiveActivities(): LiveActivityRow[] {
    return this.db.query("SELECT * FROM live_activities").all() as LiveActivityRow[]
  }

  putLiveCard(row: LiveCardRow) {
    this.db.query(
      `INSERT INTO live_cards(device_key, activity_id, push_token, keep_seconds, locale, started_at, focus_session, state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(device_key) DO UPDATE SET
         activity_id = excluded.activity_id,
         push_token = excluded.push_token,
         keep_seconds = excluded.keep_seconds,
         locale = excluded.locale,
         started_at = excluded.started_at,
         focus_session = excluded.focus_session,
         state = excluded.state`,
    ).run(row.device_key, row.activity_id, row.push_token, row.keep_seconds, row.locale, row.started_at, row.focus_session, row.state)
  }

  liveCard(deviceKey: string): LiveCardRow | null {
    return (this.db.query("SELECT * FROM live_cards WHERE device_key = ?").get(deviceKey) as LiveCardRow | null) ?? null
  }

  liveCardByActivity(activityId: string): LiveCardRow | null {
    return (this.db.query("SELECT * FROM live_cards WHERE activity_id = ?").get(activityId) as LiveCardRow | null) ?? null
  }

  /** Only while the row still holds `token`: a card the phone registered meanwhile stays. */
  noteLiveCard(deviceKey: string, token: string, focus: string | null, state: string | null) {
    this.db.query("UPDATE live_cards SET focus_session = ?, state = ? WHERE device_key = ? AND push_token = ?").run(focus, state, deviceKey, token)
  }

  deleteLiveCard(deviceKey: string, token?: string) {
    if (token === undefined) this.db.query("DELETE FROM live_cards WHERE device_key = ?").run(deviceKey)
    else this.db.query("DELETE FROM live_cards WHERE device_key = ? AND push_token = ?").run(deviceKey, token)
  }

  listLiveCards(): LiveCardRow[] {
    return this.db.query("SELECT * FROM live_cards").all() as LiveCardRow[]
  }

  pendingScheduledCounts(): Map<string, number> {
    const rows = this.db.query(
      "SELECT session_id, COUNT(*) AS n FROM scheduled WHERE status = 'pending' GROUP BY session_id",
    ).all() as Array<{ session_id: string; n: number }>
    return new Map(rows.map((row) => [row.session_id, row.n]))
  }

  scheduledCount(sessionId: string): number {
    const row = this.db.query(
      "SELECT COUNT(*) AS n FROM scheduled WHERE session_id = ? AND status = 'pending'",
    ).get(sessionId) as { n: number }
    return row.n
  }

  /** v48 E 本会话总是允许, kept across restarts (§627), oldest first. */
  listRules(): SessionRule[] {
    const rows = this.db
      .query("SELECT id, session_id, tool, command, enabled, created_at, match FROM permission_rules ORDER BY created_at, id")
      .all() as Array<{ id: string; session_id: string; tool: string; command: string; enabled: number; created_at: number; match: string | null }>
    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      tool: row.tool,
      command: row.command,
      enabled: row.enabled !== 0,
      createdAt: row.created_at,
      ...(row.match ? { match: row.match } : {}),
    }))
  }

  saveRule(rule: SessionRule) {
    this.db
      .query(
        `INSERT INTO permission_rules (id, session_id, tool, command, enabled, created_at, match) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, created_at = excluded.created_at, match = excluded.match`,
      )
      .run(rule.id, rule.sessionId, rule.tool, rule.command, rule.enabled ? 1 : 0, rule.createdAt, rule.match ?? null)
  }

  deleteRule(id: string) {
    this.db.query("DELETE FROM permission_rules WHERE id = ?").run(id)
  }

  listScheduled(sessionId?: string): ScheduledRow[] {
    if (sessionId) {
      return this.db.query(
        "SELECT * FROM scheduled WHERE session_id = ? ORDER BY fire_at ASC",
      ).all(sessionId) as ScheduledRow[]
    }
    return this.db.query("SELECT * FROM scheduled ORDER BY fire_at ASC").all() as ScheduledRow[]
  }

  insertScheduled(row: Omit<ScheduledRow, "status" | "created_at"> & { status?: ScheduledRow["status"]; created_at?: number }): ScheduledRow {
    const full: ScheduledRow = {
      ...row,
      status: row.status ?? "pending",
      created_at: row.created_at ?? Date.now(),
    }
    this.db.query(
      "INSERT INTO scheduled(id, session_id, text, fire_at, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(full.id, full.session_id, full.text, full.fire_at, full.status, full.created_at)
    this.db.query("UPDATE sessions SET updated_at = ? WHERE id = ?").run(Date.now(), full.session_id)
    return full
  }

  /** The earliest fire_at of a pending job, or null when none is pending. */
  nextScheduledAt(): number | null {
    const row = this.db.query("SELECT MIN(fire_at) AS at FROM scheduled WHERE status = 'pending'").get() as { at: number | null } | null
    return row?.at ?? null
  }

  dueScheduled(now = Date.now()): ScheduledRow[] {
    return this.db.query(
      "SELECT * FROM scheduled WHERE status = 'pending' AND fire_at <= ? ORDER BY fire_at ASC",
    ).all(now) as ScheduledRow[]
  }

  getScheduled(id: string): ScheduledRow | null {
    return (this.db.query("SELECT * FROM scheduled WHERE id = ?").get(id) as ScheduledRow | null) ?? null
  }

  // Compare-and-set: only a pending job moves, so a fire and a cancel cannot both win.
  claimScheduled(id: string, status: "sent" | "cancelled"): ScheduledRow | null {
    const result = this.db.query("UPDATE scheduled SET status = ? WHERE id = ? AND status = 'pending'").run(status, id)
    return result.changes === 1 ? this.getScheduled(id) : null
  }

  getDraft(sessionId: string): DraftRow | null {
    return (this.db.query("SELECT * FROM drafts WHERE session_id = ?").get(sessionId) as DraftRow | null) ?? null
  }

  listDrafts(): DraftRow[] {
    return this.db.query("SELECT * FROM drafts WHERE text != '' ORDER BY updated_at DESC").all() as DraftRow[]
  }

  setDraft(sessionId: string, text: string): DraftRow {
    const row: DraftRow = { session_id: sessionId, text, updated_at: Date.now() }
    this.db.query(
      "INSERT INTO drafts(session_id, text, updated_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at",
    ).run(row.session_id, row.text, row.updated_at)
    return row
  }

  /** r73 A: a turn a usage limit stopped, to be continued once the limit resets. One per session; a new one replaces it. */
  setLimitResume(sessionId: string, turnId: string, resetsAt: number): LimitResumeRow {
    const row: LimitResumeRow = { session_id: sessionId, turn_id: turnId, resets_at: resetsAt, created_at: Date.now() }
    this.db.query(
      "INSERT INTO limit_resumes(session_id, turn_id, resets_at, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET turn_id = excluded.turn_id, resets_at = excluded.resets_at, created_at = excluded.created_at",
    ).run(row.session_id, row.turn_id, row.resets_at, row.created_at)
    return row
  }

  getLimitResume(sessionId: string): LimitResumeRow | null {
    return (this.db.query("SELECT * FROM limit_resumes WHERE session_id = ?").get(sessionId) as LimitResumeRow | null) ?? null
  }

  listLimitResumes(): LimitResumeRow[] {
    return this.db.query("SELECT * FROM limit_resumes").all() as LimitResumeRow[]
  }

  deleteLimitResume(sessionId: string): boolean {
    return this.db.query("DELETE FROM limit_resumes WHERE session_id = ?").run(sessionId).changes > 0
  }

  // Adds one usage event to the session total and to its turn's row, atomically.
  recordUsage(sessionId: string, turn: UsageTurn, usage: TurnUsage, now = Date.now()): SessionRow | null {
    return this.transaction(() => {
      const session = this.getSession(sessionId)
      if (!session) return null
      this.upsertUsageEvent(session, turn, usage, now)
      return this.patchSession(sessionId, { usage: accumulateUsage(parseUsage(session.usage), usage) })
    })
  }

  // A second event for the same turn adds its counters; context fields keep the latest reported value.
  private upsertUsageEvent(session: SessionRow, turn: UsageTurn, usage: TurnUsage, createdAt: number) {
    this.usageCache.clear()
    this.db.query(
      `INSERT INTO usage_events(id, session_id, session_title, agent, model, turn_id, created_at, input_tokens, output_tokens,
         cache_read_tokens, cache_write_tokens, reasoning_tokens, cost_usd, context_used, context_size)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, turn_id) DO UPDATE SET
         session_title = excluded.session_title,
         input_tokens = input_tokens + excluded.input_tokens,
         output_tokens = output_tokens + excluded.output_tokens,
         cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
         cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
         reasoning_tokens = reasoning_tokens + excluded.reasoning_tokens,
         cost_usd = CASE WHEN cost_usd IS NULL AND excluded.cost_usd IS NULL THEN NULL
                         ELSE COALESCE(cost_usd, 0) + COALESCE(excluded.cost_usd, 0) END,
         context_used = COALESCE(excluded.context_used, context_used),
         context_size = COALESCE(excluded.context_size, context_size)`,
    ).run(
      crypto.randomUUID(),
      session.id,
      session.title,
      turn.agent,
      turn.model,
      turn.turnId,
      createdAt,
      tokenCount(usage.inputTokens) ?? 0,
      tokenCount(usage.outputTokens) ?? 0,
      tokenCount(usage.cacheReadTokens) ?? 0,
      tokenCount(usage.cacheWriteTokens) ?? 0,
      tokenCount(usage.reasoningTokens) ?? 0,
      typeof usage.costUsd === "number" && Number.isFinite(usage.costUsd) ? usage.costUsd : null,
      tokenCount(usage.contextUsed),
      tokenCount(usage.contextSize),
    )
  }

  // One statement. Rows first collapse to one per (local day, agent, model, session), which keeps distinct
  // session counts exact; that much smaller set is then rolled up four ways (total, day, agent, agent+model).
  usageSummary(query: UsageQuery): UsageSummary {
    // perf-1112 round two (R6): the stats page asks for the same ranges on every visit; the answer only changes when
    // a usage event is written (upsertUsageEvent clears this). A few ranges are kept, the oldest dropped first.
    const key = JSON.stringify([query.bucket, query.tz, query.from ?? null, query.to ?? null])
    const cached = this.usageCache.get(key)
    if (cached) return cached
    const summary = this.readUsageSummary(query)
    this.usageCache.set(key, summary)
    if (this.usageCache.size > USAGE_CACHE_RANGES) this.usageCache.delete(this.usageCache.keys().next().value!)
    return summary
  }

  private readUsageSummary(query: UsageQuery): UsageSummary {
    const where: string[] = []
    const bounds: number[] = []
    if (query.from !== undefined) {
      where.push("created_at >= ?")
      bounds.push(query.from)
    }
    if (query.to !== undefined) {
      where.push("created_at < ?")
      bounds.push(query.to)
    }
    const totals = `COALESCE(SUM(input), 0) AS inputTokens, COALESCE(SUM(output), 0) AS outputTokens,
      COALESCE(SUM(cache_read), 0) AS cacheReadTokens, COALESCE(SUM(cache_write), 0) AS cacheWriteTokens,
      COALESCE(SUM(reasoning), 0) AS reasoningTokens, SUM(cost) AS costUsd,
      COALESCE(SUM(costed) > 0 AND SUM(costed) < SUM(rows), 0) AS costPartial,
      COALESCE(SUM(turns), 0) AS turns, COUNT(DISTINCT session_id) AS sessions,
      COALESCE(SUM(input + output + cache_read + cache_write), 0) AS weight
      FROM fine`
    const branches = [
      `SELECT 0 AS grp, NULL AS day, NULL AS agent, NULL AS model, ${totals}`,
      ...(query.bucket === "day" ? [`SELECT 1, date(day * 86400, 'unixepoch'), NULL, NULL, ${totals} GROUP BY day`] : []),
      `SELECT 2, NULL, agent, NULL, ${totals} GROUP BY agent`,
      `SELECT 3, NULL, agent, model, ${totals} GROUP BY agent, model`,
    ]
    const rows = this.db.query(
      `WITH fine AS (
         SELECT (created_at + ?) / 86400000 AS day, agent, model, session_id,
           SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cache_read_tokens) AS cache_read,
           SUM(cache_write_tokens) AS cache_write, SUM(reasoning_tokens) AS reasoning, SUM(cost_usd) AS cost,
           COUNT(cost_usd) AS costed, COUNT(*) AS rows, SUM(turn_id != 'backfill') AS turns
         FROM usage_events
         ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
         GROUP BY day, agent, model, session_id
       )
       ${branches.join("\n UNION ALL ")}
       ORDER BY grp, day, weight DESC, agent, model`,
    ).all(query.tz * 60_000, ...bounds) as Array<UsageGroupRow>
    const summary: UsageSummary = { totals: usageTotals(rows[0]!), byDay: [], byAgent: [], byModel: [] }
    for (const row of rows) {
      if (row.grp === 1) summary.byDay.push({ day: row.day!, ...usageTotals(row) })
      if (row.grp === 2) summary.byAgent.push({ agent: row.agent!, ...usageTotals(row) })
      if (row.grp === 3) summary.byModel.push({ agent: row.agent!, model: row.model!, ...usageTotals(row) })
    }
    return summary
  }

  usage() {
    const sessions = (this.db.query(`SELECT COUNT(*) AS n FROM sessions WHERE ${VISIBLE_SESSION}`).get() as { n: number }).n
    const messages = (this.db.query(`SELECT COUNT(*) AS n FROM messages WHERE ${VISIBLE_MESSAGE}`).get() as { n: number }).n
    const scheduled = (this.db.query("SELECT COUNT(*) AS n FROM scheduled WHERE status = 'pending'").get() as { n: number }).n
    let bytes = 0
    if (this.path !== ":memory:") {
      try {
        bytes = statSync(this.path).size
      } catch {
        bytes = 0
      }
    }
    return { sessions, messages, scheduled, bytes }
  }
}

type UsageGroupRow = Omit<UsageTotals, "costPartial"> & {
  grp: number
  day: string | null
  agent: string | null
  model: string | null
  costPartial: number
  weight: number
}

function usageTotals(row: UsageGroupRow): UsageTotals {
  return {
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    reasoningTokens: row.reasoningTokens,
    costUsd: row.costUsd,
    costPartial: row.costPartial === 1,
    turns: row.turns,
    sessions: row.sessions,
  }
}

function tokenCount(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null
}

// Existing installs may have world-readable files from before the db was created 0600.
function restrictToOwner(dbPath: string) {
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (existsSync(path) && (statSync(path).mode & 0o777) !== 0o600) chmodSync(path, 0o600)
  }
}

export type PendingKind = "permission" | "question"

/** v48 H1: what a running turn is doing now, for the list's second line. Only the live daemon knows it. */
export type SessionStep = { kind: "edit" | "execute" | "think"; text?: string }

export type CancelReason = "withdrawn" | "interrupted"

const DEMO_SESSION_ID = "11111111-1111-4111-8111-111111111111"

export function sessionPublic(
  row: SessionRow,
  extras: { scheduledCount?: number; pending?: PendingKind | null; step?: SessionStep } = {},
) {
  const demoTitle = phoneCopy.demoTitle()
  return {
    id: row.id,
    title: row.title,
    // The sample session's placeholder title, until the first message renames it: the phone words it in its language.
    ...(row.id === DEMO_SESSION_ID && row.auto_title === 1 && row.title === demoTitle.text ? { titleCopy: demoTitle } : {}),
    // v112 ③: a session named after a slash command; each phone words the command's name in its own language.
    ...(row.auto_title === AUTO_TITLE_COMMAND && row.title_command ? { titleCopy: commandTitleCopy(row.title_command) } : {}),
    agent: row.agent,
    status: row.status,
    pinned: row.pinned === 1,
    archived: row.archived === 1,
    unreadCount: Math.max(0, row.last_seq - row.last_read_seq),
    // Omitted when clear so older snapshots and clients stay stable. New messages do not clear it.
    ...(row.marked_unread ? { markedUnread: true } : {}),
    cwd: row.cwd,
    model: row.model,
    effort: row.effort,
    ...(row.speed ? { speed: row.speed } : {}),
    permissionMode: row.permission_mode,
    usage: parseUsage(row.usage),
    ...(row.context_window !== null ? { contextWindow: row.context_window } : {}),
    compactionCount: row.compaction_count,
    scheduledCount: extras.scheduledCount ?? 0,
    // What the session is waiting on; only the live daemon knows, so a bare row says null.
    pending: extras.pending ?? null,
    // Omitted unless a turn is running a tool or thinking (v48 H1).
    ...(extras.step && row.status !== "idle" ? { step: extras.step } : {}),
    // The newest user / assistant text, one line (previewText); null before the first one.
    preview: row.preview_text ? { role: row.preview_role, text: row.preview_text, createdAt: row.preview_at } : null,
    updatedAt: row.updated_at,
    // Product decision (2026-11-19): the list's order key; older phones ignore it and keep sorting by updatedAt.
    activeAt: row.active_at ?? row.updated_at,
    // r64 sync: list cursor, transcript generation (+1 on rewind / clear) and the newest message rev.
    version: row.version ?? 0,
    generation: row.generation ?? 0,
    lastRev: row.rev_counter ?? 0,
    // Omitted for sessions started in Rudder, so older snapshots stay stable.
    ...(row.origin === "terminal" ? { origin: "terminal" } : {}),
  }
}

/**
 * Product decision (2026-11-19): a status change that moves the session in the home list. A turn starts (idle → running),
 * the owner is needed (→ waiting) or the turn ends (→ idle). An answer resumes the same turn (waiting → running): no move.
 */
export function orderMoves(from: SessionRow["status"], to: SessionRow["status"]): boolean {
  if (from === to) return false
  return !(from === "waiting" && to === "running")
}

/** Payload of a text row Rudder wrote itself (Cancelled.): shown in the chat, never the list preview. */
export const NOTICE_PAYLOAD = JSON.stringify({ notice: true })
/**
 * SQL for "not a row Rudder wrote itself": `isNoticePayload` in SQL. Any `notice: true` payload counts, so a notice
 * with a phone copy (v88 `stale_resume`, `welcome`), an agent switch or an imported one is neither a reply nor searched.
 */
const AGENT_IMAGE_ROW = "kind = 'image' AND role = 'assistant'"
const AGENT_IMAGE_ID = "CASE WHEN json_valid(payload) THEN json_extract(payload, '$.id') END"
const NOT_NOTICE_SQL = "(payload IS NULL OR NOT (json_valid(payload) AND json_extract(payload, '$.notice') IS 1))"
/** A settled send record is kept this long, for a phone retrying the same clientMessageId. */
export const SEND_RECORD_DAYS = 30
/** A deleted session's tombstone is kept this long for `session.list {sinceVersion}`. */
export const TOMBSTONE_DAYS = 30
const SYNC_TRIGGERS = ["sync_session_insert", "sync_session_update", "sync_session_delete", "sync_message_insert", "sync_message_update"]

// User and assistant prose; tool, reasoning, plan, permission, question, error, image and notice rows never become the preview.
export function isPreviewRow(row: Pick<MessageRow, "kind" | "role" | "payload">): boolean {
  return row.kind === "text" && (row.role === "user" || row.role === "assistant") && !isNoticePayload(row.payload)
}

// NOTICE_PAYLOAD, or any other payload that says `notice: true` (a copy, an agent switch, an import).
export function isNoticePayload(payload: string | null): boolean {
  if (payload === NOTICE_PAYLOAD) return true
  if (!payload?.includes('"notice":true')) return false
  try {
    return (JSON.parse(payload) as { notice?: unknown }).notice === true
  } catch {
    return false
  }
}

export const PREVIEW_CHARS = 120
// Only the head of a long reply is stripped: the preview never shows more than its first PREVIEW_CHARS characters.
const PREVIEW_SOURCE_CHARS = 2000
const PREVIEW_LOOKBACK = 20

/** One line for the session list: Markdown marks stripped, whitespace collapsed, at most PREVIEW_CHARS code points. */
export function previewText(text: string): string {
  const lines = text
    .slice(0, PREVIEW_SOURCE_CHARS)
    .split("\n")
    .filter((line) => !/^\s*(```|~~~)/.test(line) && !/^\s*([-*_])(\s*\1){2,}\s*$/.test(line) && !isTableRule(line))
    .map((line) => {
      let out = line
        .replace(/^\s{0,3}#{1,6}\s+/, "")
        .replace(/^\s*(>\s?)+/, "")
        .replace(/^\s*(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?/, "")
      if (/^\s*\|.*\|\s*$/.test(out)) out = out.trim().slice(1, -1).split("|").map((cell) => cell.trim()).join(" ")
      return out
    })
    .join(" ")
  const flat = lines
    .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, "$1")
    // `**` and `~~` only: `__` and single `_` also sit inside identifiers (`__init__`, snake_case).
    .replace(/\*\*|~~|`+/g, "")
    .replace(/(^|[\s(])\*(?=\S)([^*\n]*?\S)\*(?=$|[\s).,!?:;，。！？：；])/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim()
  const chars = Array.from(flat)
  return chars.length <= PREVIEW_CHARS ? flat : `${chars.slice(0, PREVIEW_CHARS).join("").trimEnd()}…`
}

function isTableRule(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line) && line.includes("-") && line.includes("|")
}

/** The latest turn's ending, or undefined while it runs (the list hides the old result until the new one lands). */
export function lastTurnPublic(row: TurnRow | undefined): TurnOutcome | undefined {
  if (!row?.outcome || !["done", "failed", "interrupted"].includes(row.phase)) return undefined
  try {
    return JSON.parse(row.outcome) as TurnOutcome
  } catch (error) {
    throw new Error(`turn ${row.id} has an invalid outcome`, { cause: error })
  }
}

export function turnPublic(row: TurnRow) {
  return {
    id: row.id, sessionId: row.session_id, userMessageId: row.user_message_id,
    clientMessageId: row.client_message_id ?? undefined, sequence: row.sequence,
    revision: row.revision, phase: row.phase, updatedAt: row.updated_at,
  }
}

/**
 * The message kinds the 1.0 app draws. Rule for every kind added later: its payload carries a plain-text `summary`
 * (write it with `withSummary`), which older apps show in place of the row they cannot draw.
 */
export const KNOWN_MESSAGE_KINDS = ["text", "tool", "permission", "question", "reasoning", "plan", "image", "compaction", "error", "handoff"] as const

/** A row payload for a kind outside `KNOWN_MESSAGE_KINDS`: the kind's own fields plus the fallback line. */
export function withSummary(payload: Record<string, unknown>, summary: string): string {
  return JSON.stringify({ ...payload, summary })
}

const knownKinds = new Set<string>(KNOWN_MESSAGE_KINDS)

/** A newer kind's `summary`, sent on the wire so an app that does not know the kind can still say something. */
function summaryField(row: Pick<MessageRow, "kind">, raw: unknown): { summary?: string } {
  if (knownKinds.has(row.kind) || !isObject(raw)) return {}
  const summary = raw.summary
  return typeof summary === "string" && summary.trim() ? { summary } : {}
}

type AgentPick = { agent: string; model: string }

/** r72 `session.switchAgent`'s notice row: which agent and model the session left and took. */
// `resume`: the switch was the usage-limit card's 「换成 X 接着做」; the continuation message follows it.
function agentSwitchField(row: Pick<MessageRow, "kind" | "role">, raw: unknown): { agentSwitch?: { from: AgentPick; to: AgentPick; resume?: true } } {
  if (row.kind !== "text" || row.role !== "assistant" || !isObject(raw) || raw.notice !== true || !isObject(raw.agentSwitch)) return {}
  const pick = (value: unknown): AgentPick | undefined =>
    isObject(value) && typeof value.agent === "string" ? { agent: value.agent, model: typeof value.model === "string" ? value.model : "" } : undefined
  const from = pick(raw.agentSwitch.from)
  const to = pick(raw.agentSwitch.to)
  if (!from || !to) return {}
  return { agentSwitch: { from, to, ...(raw.agentSwitch.resume === true ? { resume: true as const } : {}) } }
}

export function messagePublic(row: MessageRow) {
  // One JSON.parse per row: history pages and every streaming flush come through here.
  const payload = decodePayload(row.payload)
  const value = payload.ok ? payload.value : undefined
  const correlation = sendFieldsFrom(value)
  return {
    id: row.id,
    sessionId: row.session_id,
    seq: row.seq,
    // r64 sync: `message.changes` cursor within the session's generation.
    rev: row.rev ?? 0,
    kind: row.kind,
    role: row.role,
    text: row.text,
    replyChoices: row.kind === "text" && isObject(value) && Array.isArray(value.replyChoices) && value.replyChoices.every((choice) => typeof choice === "string") ? value.replyChoices as string[] : undefined,
    clientMessageId: correlation.clientMessageId,
    clientDeviceId: correlation.clientDeviceId,
    turnId: correlation.turnId,
    turnEnd: row.role === "user" && isObject(value) && isObject(value.turnEnd) ? value.turnEnd : undefined,
    // r47: "review" = line comments sent from an approval or 本轮改动, shown as 「Rudder 代发」 when Rudder sent them.
    ...(correlation.origin ? { origin: correlation.origin } : {}),
    createdAt: row.created_at,
    permission: row.kind === "permission" ? permissionFrom(value) : undefined,
    question: row.kind === "question" ? questionFrom(value) : undefined,
    tool: row.kind === "tool" ? toolFrom(value) : undefined,
    reasoning: row.kind === "reasoning" ? reasoningFrom(value) : undefined,
    plan: row.kind === "plan" ? planFrom(value) : undefined,
    attachments: row.kind === "text" && row.role === "user" ? attachmentsFrom(value) : undefined,
    image: row.kind === "image" ? imageFrom(value) : undefined,
    compaction: row.kind === "compaction" ? compactionFrom(strictPayload(payload, "compaction")) : undefined,
    // r48: usage_limit · auth_required · agent_exited (adapter/agent-error.ts). Absent on a plain error.
    error: row.kind === "error" ? agentErrorFrom(strictPayload(payload, "error")) : undefined,
    steer: steerFrom(value),
    // Session handoff: rows brought over from a terminal transcript are read-only history; `handoff` rows are the
    // 「以下在电脑终端里 / 以下在手机上」 dividers.
    ...handoffFields(row, value),
    ...summaryField(row, value),
    ...agentSwitchField(row, value),
    // Rudder's own text as a code the phone words in its own language (phone-copy.ts); `text` stays the fallback.
    ...(isObject(value) && isPhoneCopy(value.copy) ? { copy: value.copy } : {}),
  }
}

function handoffFields(row: MessageRow, raw: unknown): { imported?: true; handoff?: "terminal" | "phone" | "earlier"; earlier?: number } {
  if (!isObject(raw)) return {}
  const value = raw as { imported?: unknown; handoff?: unknown; count?: unknown }
  if (value.imported !== true && row.kind !== "handoff") return {}
  return {
    ...(value.imported === true ? { imported: true as const } : {}),
    ...(value.handoff === "terminal" || value.handoff === "phone" || value.handoff === "earlier" ? { handoff: value.handoff } : {}),
    ...(value.handoff === "earlier" && typeof value.count === "number" ? { earlier: value.count } : {}),
  }
}

type DecodedPayload = { ok: true; value: unknown } | { ok: false; error: unknown }

/** `value` is undefined for a null or empty payload, which every parser below treats as absent. */
function decodePayload(raw: string | null): DecodedPayload {
  if (!raw) return { ok: true, value: undefined }
  try {
    return { ok: true, value: JSON.parse(raw) }
  } catch (error) {
    return { ok: false, error }
  }
}

/** Compaction and error rows are written by rudderd itself, so a payload that is not JSON is a bug worth surfacing. */
function strictPayload(payload: DecodedPayload, kind: string): unknown {
  if (!payload.ok) throw new Error(`invalid ${kind} message payload`, { cause: payload.error })
  return payload.value
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function parsedOrUndefined<T>(raw: string | null, from: (value: unknown) => T | undefined): T | undefined {
  const payload = decodePayload(raw)
  return payload.ok ? from(payload.value) : undefined
}

// r47 review / relay; r73 continuations the timeline draws as notice rows instead of user bubbles.
const PUBLIC_ORIGINS = new Set(["review", "relay", "auto_resume", "restart_resume", "fallback_resume", "agent_continue"])

function sendFieldsFrom(value: unknown): { clientMessageId?: string; clientDeviceId?: string; turnId?: string; origin?: string } {
  if (!isObject(value)) return {}
  return {
    clientMessageId: typeof value.clientMessageId === "string" ? value.clientMessageId : undefined,
    clientDeviceId: typeof value.clientDeviceId === "string" ? value.clientDeviceId : undefined,
    turnId: typeof value.turnId === "string" ? value.turnId : undefined,
    origin: typeof value.origin === "string" && PUBLIC_ORIGINS.has(value.origin) ? value.origin : undefined,
  }
}

/** A steered user row. Absent on every other payload, including attachment lists. */
export function parseSteer(payload: string | null): SteerPublic | undefined {
  return parsedOrUndefined(payload, steerFrom)
}

/** `waiting`: sent while the agent had finished speaking and only background work held the turn; the phone draws it as an ordinary message. */
type SteerPublic = { state: "sent" | "read"; readAt?: number; waiting?: true }

function steerFrom(value: unknown): SteerPublic | undefined {
  if (!isObject(value) || (value.steer !== "sent" && value.steer !== "read")) return undefined
  return { state: value.steer, ...(typeof value.readAt === "number" ? { readAt: value.readAt } : {}), ...(value.steerWaiting === true ? { waiting: true as const } : {}) }
}

function compactionFrom(value: unknown): Record<string, unknown> | undefined {
  return isObject(value) && !Array.isArray(value) ? value : undefined
}

function agentErrorFrom(value: unknown): Record<string, unknown> | undefined {
  if (!isObject(value)) return undefined
  const error = value.error
  return isObject(error) && !Array.isArray(error) ? error : undefined
}

/** Light history: the newest slice that stays under both caps. The live turn is exempt from the byte cap. */
export const OUTLINE_MAX_MESSAGES = 5000
export const OUTLINE_MAX_BYTES = 2 * 1024 * 1024
/** Newest-first pages while building an outline. Each page is a limited `listMessages`. */
export const OUTLINE_BATCH = 128
/** Default and cap for `history.page` when `outline: true`. */
export const OUTLINE_PAGE = 2000
const OUTLINE_DETAIL_CHARS = 200
const OUTLINE_REASONING_CHARS = 80

export type PublicMessage = ReturnType<typeof messagePublic>
export type OutlineTool = ToolPayload & { error?: string }
export type OutlineMessage = Omit<PublicMessage, "tool"> & {
  tool?: OutlineTool
  trimmed?: true
  fullBytes?: number
}

/** Code points, so a surrogate pair is not cut in half. */
export function clipChars(text: string, max: number): string {
  const chars = Array.from(text)
  return chars.length <= max ? text : chars.slice(0, max).join("")
}

/**
 * Presentation only. Fold math stays in TurnFold.swift: a finished thought still needs a non-empty
 * text prefix plus startedAt/endedAt, and an edit still needs its path. Patch text and tool output
 * come back through `message.bodies`.
 */
export function messageOutline(row: MessageRow, lastPromptSeq: number | null): OutlineMessage {
  const full = messagePublic(row)
  if (lastPromptSeq !== null && row.seq > lastPromptSeq) return full
  if (row.kind === "tool" && full.tool) return outlineTool(full)
  if (row.kind === "reasoning") return outlineReasoning(full)
  return full
}

function outlineTool(full: PublicMessage): OutlineMessage {
  const tool = full.tool
  if (!tool) return full
  const detailSource = typeof tool.detail === "string" ? tool.detail : ""
  const detail = clipChars(detailSource, OUTLINE_DETAIL_CHARS)
  const diffs = tool.diffs ?? []
  const heavy =
    (typeof tool.output === "string" && tool.output.length > 0) ||
    tool.outputTruncated === true ||
    detail !== detailSource ||
    diffs.some((diff) => Boolean(diff.patch || diff.oldText || diff.newText || diff.truncated))
  if (!heavy) return full
  const light: OutlineTool = { id: tool.id, tool: tool.tool, title: tool.title, detail, status: tool.status }
  if (tool.kind) light.kind = tool.kind
  if (typeof tool.exitCode === "number") light.exitCode = tool.exitCode
  if (diffs.length > 0) light.diffs = diffs.map((diff) => ({ path: diff.path }))
  if ((tool.status === "failed" || tool.status === "cancelled") && typeof tool.output === "string") {
    const line = tool.output
      .split("\n")
      .map((item) => item.trim())
      .find((item) => item.length > 0)
    if (line) light.error = clipChars(line, OUTLINE_DETAIL_CHARS)
  }
  return { ...full, tool: light, trimmed: true, fullBytes: Buffer.byteLength(JSON.stringify(full)) }
}

function outlineReasoning(full: PublicMessage): OutlineMessage {
  const text = clipChars(full.text, OUTLINE_REASONING_CHARS)
  if (text === full.text) return full
  return { ...full, text, trimmed: true, fullBytes: Buffer.byteLength(JSON.stringify(full)) }
}

/** Newest segment that fits. Messages from the last user prompt on are kept even when they alone exceed the byte cap. */
export function outlineTranscript(
  rows: MessageRow[],
  lastPromptSeq: number | null,
  options: { maxMessages?: number; maxBytes?: number } = {},
): OutlineMessage[] {
  const maxMessages = options.maxMessages ?? OUTLINE_MAX_MESSAGES
  const maxBytes = options.maxBytes ?? OUTLINE_MAX_BYTES
  const capped = rows.length > maxMessages ? rows.slice(rows.length - maxMessages) : rows
  if (capped.length === 0) return []
  const messages = capped.map((row) => messageOutline(row, lastPromptSeq))
  const sizes = messages.map((message) => Buffer.byteLength(JSON.stringify(message)))
  const bytesFrom = (start: number) => {
    const count = sizes.length - start
    if (count <= 0) return 2
    let total = 1 + count
    for (let i = start; i < sizes.length; i++) total += sizes[i] ?? 0
    return total
  }
  const protectedAt = protectedIndex(capped, lastPromptSeq)
  const floor = Math.min(protectedAt, messages.length - 1)
  if (bytesFrom(floor) > maxBytes) return messages.slice(floor)
  if (bytesFrom(0) <= maxBytes) return messages
  let lo = 0
  let hi = floor
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1
    if (bytesFrom(mid) <= maxBytes) hi = mid
    else lo = mid
  }
  return messages.slice(hi)
}

function protectedIndex(rows: MessageRow[], lastPromptSeq: number | null): number {
  if (lastPromptSeq === null) return rows.length
  const index = rows.findIndex((row) => row.seq >= lastPromptSeq)
  return index === -1 ? rows.length : index
}

// Outline fields are wire values. A UTF-16 unit uses at most six JSON bytes (including an escaped surrogate).
// This lets windows well inside the cap skip the first JSON encoding without changing the exact fit at the cap.
function outlineSizeBound(value: unknown): number {
  if (typeof value === "string") return 2 + 6 * value.length
  if (typeof value === "number") return 32
  if (Array.isArray(value)) {
    let size = 2 + value.length
    for (const item of value) size += outlineSizeBound(item)
    return size
  }
  if (value != null && typeof value === "object") {
    let size = 2
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue
      size += outlineSizeBound(key) + 2 + outlineSizeBound(item)
    }
    return size
  }
  return 5
}

/**
 * The same window as `outlineTranscript`, read newest-first in limited batches.
 * `read(beforeSeq, limit)` must be `listMessages`: `beforeSeq === undefined` is the newest page.
 * Rows that cannot fit are not outlined, except the single boundary row that crosses the byte cap.
 * A live turn that alone exceeds the cap is returned whole. The 5000-row cap is applied before that exemption.
 */
export function readOutlineMessages(
  read: (beforeSeq: number | undefined, limit: number) => MessageRow[],
  lastPromptSeq: number | null,
  options: { maxMessages?: number; maxBytes?: number; beforeSeq?: number } = {},
): OutlineMessage[] {
  const maxMessages = options.maxMessages ?? OUTLINE_MAX_MESSAGES
  const maxBytes = options.maxBytes ?? OUTLINE_MAX_BYTES
  const kept: OutlineMessage[] = []
  let bytes = 2
  let exact = false
  let examined = 0
  let before = options.beforeSeq
  while (examined < maxMessages) {
    const limit = Math.min(OUTLINE_BATCH, maxMessages - examined)
    const batch = read(before, limit)
    if (batch.length === 0) break
    for (let index = batch.length - 1; index >= 0; index -= 1) {
      const row = batch[index]
      if (!row || examined >= maxMessages) break
      const mandatory = kept.length === 0 || (lastPromptSeq !== null && row.seq >= lastPromptSeq)
      if (!mandatory && exact && bytes > maxBytes) return kept.reverse()
      const outlined = messageOutline(row, lastPromptSeq)
      const separator = kept.length === 0 ? 0 : 1
      let next = bytes + separator + (exact ? Buffer.byteLength(JSON.stringify(outlined)) : outlineSizeBound(outlined))
      if (!mandatory && !exact && next > maxBytes) {
        exact = true
        bytes = 2 + Math.max(0, kept.length - 1)
        for (const message of kept) bytes += Buffer.byteLength(JSON.stringify(message))
        next = bytes + separator + Buffer.byteLength(JSON.stringify(outlined))
      }
      examined += 1
      if (!mandatory && next > maxBytes) return kept.reverse()
      kept.push(outlined)
      bytes = next
    }
    const oldest = batch[0]
    if (!oldest || batch.length < limit) break
    before = oldest.seq
  }
  return kept.reverse()
}

export type ImagePayload = {
  id: string
  name: string
  bytes: number
  mediaType: string
  width: number
  height: number
  // set when the picture is a file the agent wrote (its base name, and its path in the session folder).
  fileName?: string
  sourcePath?: string
}

function imageFrom(raw: unknown): ImagePayload | undefined {
  if (!isObject(raw)) return undefined
  const value = raw as Partial<ImagePayload>
  if (
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.bytes !== "number" ||
    typeof value.mediaType !== "string" ||
    typeof value.width !== "number" ||
    typeof value.height !== "number"
  ) {
    return undefined
  }
  return {
    id: value.id,
    name: value.name,
    bytes: value.bytes,
    mediaType: value.mediaType,
    width: value.width,
    height: value.height,
    ...(typeof value.fileName === "string" ? { fileName: value.fileName } : {}),
    ...(typeof value.sourcePath === "string" ? { sourcePath: value.sourcePath } : {}),
  }
}

/** A user message's uploads (`message.send {attachments}`): id, name and size, never the path. */
function attachmentsFrom(value: unknown): Array<{ id: string; name: string; bytes: number }> | undefined {
  if (!isObject(value)) return undefined
  return Array.isArray(value.attachments) && value.attachments.length ? value.attachments : undefined
}

export function scheduledPublic(row: ScheduledRow) {
  return {
    id: row.id,
    sessionId: row.session_id,
    text: row.text,
    fireAt: row.fire_at,
    status: row.status,
    createdAt: row.created_at,
  }
}

// Optional fields are absent on rows written before the unified event model.
export type PermissionPayload = {
  id: string
  tool: string
  title: string
  detail: string
  status: "pending" | "allowed" | "denied" | "expired" | "cancelled"
  kind?: ToolKind
  options?: PermissionOption[]
  diffs?: ToolDiff[]
  // Chosen option id.
  decision?: string
  // Id of the tool message this request belongs to.
  toolId?: string
  // Set with status "cancelled".
  cancelReason?: CancelReason
}

export type QuestionPayload = {
  id: string
  // First question, kept for older clients.
  prompt: string
  options: string[]
  status: "pending" | "answered" | "expired" | "cancelled"
  // Answer to the first question, kept for older clients.
  answer?: string
  questions?: QuestionItem[]
  answers?: QuestionAnswers
  // Set with status "cancelled".
  cancelReason?: CancelReason
}

export type ToolPayload = {
  id: string
  tool: string
  title: string
  detail: string
  // "done" only appears on legacy rows.
  status: ToolStatus | "done"
  kind?: ToolKind
  output?: string
  // Set when output was cut to TOOL_OUTPUT_LIMIT.
  outputTruncated?: boolean
  exitCode?: number
  diffs?: ToolDiff[]
}

export type ReasoningPayload = { startedAt: number; endedAt?: number }

export type PlanPayload = { entries: PlanEntry[] }

export const TOOL_OUTPUT_LIMIT = 4 * 1024
export const TOOL_DIFF_LIMIT = 8 * 1024

const utf8Encoder = new TextEncoder()
const utf8Decoder = new TextDecoder()

export function truncateUtf8(text: string, maxBytes: number): string {
  if (text.length * 3 <= maxBytes) return text
  const bytes = utf8Encoder.encode(text)
  if (bytes.byteLength <= maxBytes) return text
  const ellipsis = "…"
  const room = Math.max(0, maxBytes - utf8Encoder.encode(ellipsis).byteLength)
  // A multi-byte character cut in half decodes to U+FFFD; drop it.
  return utf8Decoder.decode(bytes.subarray(0, room)).replace(/�$/, "") + ellipsis
}

// The byte budget is per diff, split evenly across the text fields it carries; a cut sets `truncated`.
export function truncateDiff(diff: ToolDiff, maxBytes = TOOL_DIFF_LIMIT): ToolDiff {
  const fields = (["patch", "oldText", "newText"] as const).filter((key) => typeof diff[key] === "string")
  const share = Math.floor(maxBytes / Math.max(1, fields.length))
  const out: ToolDiff = { path: diff.path }
  for (const key of fields) {
    const text = diff[key] as string
    out[key] = truncateUtf8(text, share)
    if (out[key] !== text) out.truncated = true
  }
  return out
}

const USAGE_SUM_KEYS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens", "costUsd"] as const
const USAGE_LATEST_KEYS = ["contextUsed", "contextSize"] as const

// Counters add up across turns; context fields are a snapshot, so the latest wins.
export function accumulateUsage(total: TurnUsage, turn: TurnUsage): TurnUsage {
  const next: TurnUsage = { ...total }
  for (const key of USAGE_SUM_KEYS) {
    const value = turn[key]
    if (typeof value === "number" && Number.isFinite(value)) next[key] = (next[key] ?? 0) + value
  }
  for (const key of USAGE_LATEST_KEYS) {
    const value = turn[key]
    if (typeof value === "number" && Number.isFinite(value)) next[key] = value
  }
  return next
}

export function parseUsage(raw: string | null): TurnUsage {
  if (!raw) return {}
  try {
    const value = JSON.parse(raw) as Record<string, unknown>
    const usage: TurnUsage = {}
    for (const key of [...USAGE_SUM_KEYS, ...USAGE_LATEST_KEYS]) {
      const field = value[key]
      if (typeof field === "number" && Number.isFinite(field)) usage[key] = field
    }
    return usage
  } catch {
    return {}
  }
}

export function parseReasoning(raw: string | null): ReasoningPayload | undefined {
  return parsedOrUndefined(raw, reasoningFrom)
}

function reasoningFrom(raw: unknown): ReasoningPayload | undefined {
  if (!isObject(raw)) return undefined
  const value = raw as ReasoningPayload
  if (typeof value.startedAt !== "number") return undefined
  return value
}

export function parsePlan(raw: string | null): PlanPayload | undefined {
  return parsedOrUndefined(raw, planFrom)
}

function planFrom(raw: unknown): PlanPayload | undefined {
  if (!isObject(raw)) return undefined
  const value = raw as PlanPayload
  if (!Array.isArray(value.entries)) return undefined
  return value
}

export function parsePermission(raw: string | null): PermissionPayload | undefined {
  return parsedOrUndefined(raw, permissionFrom)
}

function permissionFrom(raw: unknown): PermissionPayload | undefined {
  if (!isObject(raw)) return undefined
  const value = raw as PermissionPayload
  if (!value.id || !value.tool || !value.status) return undefined
  return value
}

export function parseQuestion(raw: string | null): QuestionPayload | undefined {
  return parsedOrUndefined(raw, questionFrom)
}

function questionFrom(raw: unknown): QuestionPayload | undefined {
  if (!isObject(raw)) return undefined
  const value = raw as QuestionPayload
  if (!value.id || typeof value.prompt !== "string" || !value.status) return undefined
  return value
}

export function parseTool(raw: string | null): ToolPayload | undefined {
  return parsedOrUndefined(raw, toolFrom)
}

function toolFrom(raw: unknown): ToolPayload | undefined {
  if (!isObject(raw)) return undefined
  const value = raw as ToolPayload
  if (!value.id || !value.tool) return undefined
  return value
}
