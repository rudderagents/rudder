import Foundation

// Session handoff (the session handoff notes): who may write a session, and the terminal Claude
// sessions `handoff.list` finds on the computer.

/// `session.holder`. The daemon computes it each time; it never carries a pid.
public struct RudderSessionHolder: Equatable, Hashable, Sendable {
    public enum Kind: String, Hashable, Sendable {
        /// The daemon's adapter is on it (a turn, or its idle process).
        case rudder
        /// A terminal Claude on the computer has it open, or `rudder attach` claimed it.
        case terminal
        case none
    }

    public var kind: Kind
    /// busy | idle while a terminal holds it.
    public var terminalBusy: Bool
    /// Milliseconds, daemon clock.
    public var since: Double
    /// `handoff.takeover {when: "afterTurn"}` is waiting.
    public var pendingTakeover: Bool
    /// The terminal Claude did not quit within the wait.
    public var takeoverFailed: Bool
    /// Rudder is running a turn while a terminal opened the same session.
    public var conflict: Bool
    /// Claimed by `rudder attach` (the session started on the phone).
    public var viaAttach: Bool

    public init(kind: Kind, terminalBusy: Bool = false, since: Double = 0, pendingTakeover: Bool = false,
                takeoverFailed: Bool = false, conflict: Bool = false, viaAttach: Bool = false) {
        self.kind = kind
        self.terminalBusy = terminalBusy
        self.since = since
        self.pendingTakeover = pendingTakeover
        self.takeoverFailed = takeoverFailed
        self.conflict = conflict
        self.viaAttach = viaAttach
    }

    public init?(json: RudderJSON) {
        guard let raw = json["kind"]?.string, let kind = Kind(rawValue: raw) else { return nil }
        self.init(
            kind: kind,
            terminalBusy: json["status"]?.string == "busy",
            since: json["since"]?.number ?? 0,
            pendingTakeover: json["pendingTakeover"]?.bool ?? false,
            takeoverFailed: json["takeoverFailed"]?.bool ?? false,
            conflict: json["conflict"]?.bool ?? false,
            viaAttach: json["via"]?.string == "attach"
        )
    }
}

/// One `handoff.list` entry: a terminal session on the computer. `ref` is the daemon's handle; the agent-native id
/// never comes to the phone this way.
public struct RudderExternalSession: Equatable, Hashable, Sendable, Identifiable {
    public enum Live: String, Hashable, Sendable { case busy, idle }

    public var ref: String
    public var agent: String
    public var title: String
    public var cwd: String
    /// Milliseconds, daemon clock.
    public var updatedAt: Double
    public var preview: String?
    /// nil: the terminal Claude has exited.
    public var live: Live?
    /// Already a Rudder session: open it instead of importing again.
    public var sessionId: String?
    public var importable: Bool
    public var reason: String?
    /// The Claude version that wrote it (shown when the format is not readable).
    public var version: String?
    /// the folder is inside what Rudder can write to. False: view-only. True from older daemons.
    public var writable: Bool
    /// v102 (ACP: Grok, Copilot): the daemon cannot tell whether a terminal still has it open; the import sheet asks to
    /// close it on the computer first. The phone reads this field, never the agent's name.
    public var closeFirst: Bool

    public var id: String { ref }

    /// v102 C③: open in another program on the computer (a Codex thread whose writer lock another process holds).
    /// Listed with the terminal ones, but it cannot come over until that program quits.
    public var inUse: Bool { !importable && reason == "in_use" }

    /// v102: what the home entry, the new-session row and the computer card count: running in a terminal now, not in
    /// Rudder yet, and able to come over now (`live != nil && importable && sessionId == nil`).
    public var readyToContinue: Bool { live != nil && importable && sessionId == nil }

    public init(ref: String, agent: String = "claude", title: String, cwd: String, updatedAt: Double, preview: String? = nil,
                live: Live? = nil, sessionId: String? = nil, importable: Bool = true, reason: String? = nil, version: String? = nil,
                writable: Bool = true, closeFirst: Bool = false) {
        self.ref = ref
        self.agent = agent
        self.title = title
        self.cwd = cwd
        self.updatedAt = updatedAt
        self.preview = preview
        self.live = live
        self.sessionId = sessionId
        self.importable = importable
        self.reason = reason
        self.version = version
        self.writable = writable
        self.closeFirst = closeFirst
    }

    public init?(json: RudderJSON) {
        guard let ref = json["ref"]?.string, let title = json["title"]?.string else { return nil }
        self.init(
            ref: ref,
            agent: json["agent"]?.string ?? "claude",
            title: title,
            cwd: json["cwd"]?.string ?? "",
            updatedAt: json["updatedAt"]?.number ?? 0,
            preview: json["preview"]?.string,
            live: json["live"]?["status"]?.string.flatMap(Live.init(rawValue:)),
            sessionId: json["sessionId"]?.string,
            importable: json["importable"]?.bool ?? true,
            reason: json["reason"]?.string,
            version: json["version"]?.string,
            writable: json["writable"]?.bool ?? true,
            closeFirst: json["closeFirst"]?.bool ?? false
        )
    }
}

/// `handoff.list` `unsupported[]`: an agent whose sessions the computer could not list (`not_installed`,
/// `no_session_list`, `unavailable`, `later`). Kept as sent; no screen shows it yet (the v102 draft draws no such state).
public struct RudderHandoffUnsupported: Equatable, Hashable, Sendable {
    public var agent: String
    public var reason: String

    public init(agent: String, reason: String) {
        self.agent = agent
        self.reason = reason
    }

    public init?(json: RudderJSON) {
        guard let agent = json["agent"]?.string else { return nil }
        self.init(agent: agent, reason: json["reason"]?.string ?? "")
    }
}

/// `handoff.inspect`: what the import sheet says.
public struct RudderHandoffInspect: Equatable, Sendable {
    public var title: String
    public var cwd: String
    public var updatedAt: Double
    /// Text messages in the whole transcript.
    public var messages: Int
    /// Of those, the ones older than the last 200 turns: they stay on the computer for now.
    public var earlier: Int
    public var live: RudderExternalSession.Live?
    /// false → the sheet offers a view-only import only. True from older daemons.
    public var writable: Bool
    /// v102 C④: as `RudderExternalSession.closeFirst`.
    public var closeFirst: Bool

    public init(title: String, cwd: String, updatedAt: Double, messages: Int, earlier: Int, live: RudderExternalSession.Live?,
                writable: Bool = true, closeFirst: Bool = false) {
        self.title = title
        self.cwd = cwd
        self.updatedAt = updatedAt
        self.messages = messages
        self.earlier = earlier
        self.live = live
        self.writable = writable
        self.closeFirst = closeFirst
    }

    public init?(json: RudderJSON) {
        guard let title = json["title"]?.string else { return nil }
        self.init(
            title: title,
            cwd: json["cwd"]?.string ?? "",
            updatedAt: json["updatedAt"]?.number ?? 0,
            messages: json["messages"]?.int ?? 0,
            earlier: json["earlier"]?.int ?? 0,
            live: json["live"]?["status"]?.string.flatMap(RudderExternalSession.Live.init(rawValue:)),
            writable: json["writable"]?.bool ?? true,
            closeFirst: json["closeFirst"]?.bool ?? false
        )
    }
}

/// `handoff.release`: the commands the continue-on-computer sheet shows. Hands nothing over by itself.
public struct RudderHandoffCommands: Equatable, Sendable, Identifiable {
    public var id: String { command }

    /// The session's short id, as `rudder attach` takes it.
    public var short: String
    public var command: String
    /// Claude's own resume command; nil before the session's first turn.
    public var native: String?
    /// A phone turn is running: the computer waits for it.
    public var running: Bool

    public init(short: String, command: String, native: String?, running: Bool) {
        self.short = short
        self.command = command
        self.native = native
        self.running = running
    }

    public init?(json: RudderJSON) {
        guard let short = json["short"]?.string, let command = json["command"]?.string else { return nil }
        self.init(short: short, command: command, native: json["native"]?.string, running: json["running"]?.bool ?? false)
    }
}
