import Foundation

public let rudderProtocolVersion = 1

public enum RudderFrameType: String, Codable, Sendable {
    case invoke
    case result
    case error
    case event
    /// A type a newer rudderd sends that this app does not know. The frame still decodes (its `id` may answer a
    /// request) and is skipped; this side never sends it.
    case unknown

    public init(from decoder: Decoder) throws {
        self = Self(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .unknown
    }
}

/// An error reply's body. Never fails to decode: a missing or malformed field must still resolve the request it
/// answers, or the caller would wait out its timeout instead of showing the failure.
public struct RudderErrorBody: Codable, Sendable, Equatable {
    public var code: String
    public var message: String
    /// `message` as rudderd's copy, for the app to word in its own language. Absent on older daemons.
    public var copy: RudderCopy?

    public init(code: String, message: String, copy: RudderCopy? = nil) {
        self.code = code
        self.message = message
        self.copy = copy
    }

    private enum CodingKeys: String, CodingKey { case code, message, copy }

    public init(from decoder: Decoder) throws {
        if let container = try? decoder.container(keyedBy: CodingKeys.self) {
            let code = (try? container.decodeIfPresent(String.self, forKey: .code)) ?? nil
            let message = (try? container.decodeIfPresent(String.self, forKey: .message)) ?? nil
            let copy = RudderCopy(json: (try? container.decodeIfPresent(RudderJSON.self, forKey: .copy)) ?? nil)
            self.init(code: code ?? "failed", message: message ?? code ?? "request failed", copy: copy)
        } else {
            let text = try? decoder.singleValueContainer().decode(String.self)
            self.init(code: "failed", message: text ?? "request failed")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(code, forKey: .code)
        try container.encode(message, forKey: .message)
        try container.encodeIfPresent(copy?.json, forKey: .copy)
    }
}

public struct RudderFrame: Codable, Sendable, Equatable {
    public var v: Int
    public var id: String
    public var type: RudderFrameType
    public var method: String?
    public var params: [String: RudderJSON]?
    public var result: RudderJSON?
    public var error: RudderErrorBody?
    public var name: String?
    public var payload: RudderJSON?
    /// Event frames: the daemon's event log position, sent back as `hello {lastEventId}` to replay what was missed.
    public var eventId: Int?
    /// message.* events: the event id published before this one in the same session (0 for its first). The ids a
    /// socket sees skip other sessions' events; this chain is what shows one of the open chat's own went missing.
    public var prev: Int?
    /// Global events naming a session: that session's last message.* event id when this one was published.
    public var tip: Int?

    public init(
        v: Int = rudderProtocolVersion,
        id: String,
        type: RudderFrameType,
        method: String? = nil,
        params: [String: RudderJSON]? = nil,
        result: RudderJSON? = nil,
        error: RudderErrorBody? = nil,
        name: String? = nil,
        payload: RudderJSON? = nil,
        eventId: Int? = nil,
        prev: Int? = nil,
        tip: Int? = nil
    ) {
        self.prev = prev
        self.tip = tip
        self.v = v
        self.id = id
        self.type = type
        self.method = method
        self.params = params
        self.result = result
        self.error = error
        self.name = name
        self.payload = payload
        self.eventId = eventId
    }

    public static func invoke(id: String, method: String, params: [String: RudderJSON] = [:]) -> RudderFrame {
        RudderFrame(id: id, type: .invoke, method: method, params: params)
    }
}

public enum RudderJSON: Codable, Sendable, Equatable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: RudderJSON])
    case array([RudderJSON])
    case null

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null; return }
        // Each miss throws a DecodingError, so the most common kinds go first: on a 1.3 MB snapshot this order
        // decodes in 30 ms instead of 45 (-O, M5 Max). Bool stays ahead of Double so `true` never reads as a number.
        if let value = try? container.decode(String.self) { self = .string(value); return }
        if let value = try? container.decode([String: RudderJSON].self) { self = .object(value); return }
        if let value = try? container.decode(Bool.self) { self = .bool(value); return }
        if let value = try? container.decode(Double.self) { self = .number(value); return }
        if let value = try? container.decode([RudderJSON].self) { self = .array(value); return }
        throw DecodingError.dataCorruptedError(in: container, debugDescription: "unsupported JSON")
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }

    public var string: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    public var bool: Bool? {
        if case .bool(let value) = self { return value }
        return nil
    }

    public subscript(key: String) -> RudderJSON? {
        if case .object(let object) = self { return object[key] }
        return nil
    }

    public var array: [RudderJSON]? {
        if case .array(let value) = self { return value }
        return nil
    }

    public var number: Double? {
        if case .number(let value) = self { return value }
        return nil
    }

    /// The number truncated toward zero, or nil when it is not a number or does not fit an `Int` (never traps).
    public var int: Int? {
        guard case .number(let value) = self else { return nil }
        return Int(exactly: value.rounded(.towardZero))
    }
}

public struct RudderToolDiff: Equatable, Hashable, Sendable {
    public var path: String
    public var oldText: String?
    public var newText: String?
    public var patch: String?
    // The daemon cut a text field to its 8 KB per-diff budget.
    public var truncated: Bool

    public init(path: String, oldText: String? = nil, newText: String? = nil, patch: String? = nil, truncated: Bool = false) {
        self.path = path
        self.oldText = oldText
        self.newText = newText
        self.patch = patch
        self.truncated = truncated
    }

    public init?(json: RudderJSON) {
        guard let path = json["path"]?.string else { return nil }
        self.init(
            path: path,
            oldText: json["oldText"]?.string,
            newText: json["newText"]?.string,
            patch: json["patch"]?.string,
            truncated: json["truncated"]?.bool ?? false
        )
    }
}

public struct RudderPermissionOption: Equatable, Hashable, Sendable, Identifiable {
    public var id: String
    public var label: String
    // allow_once | allow_always | reject_once | reject_always
    public var kind: String

    public init(id: String, label: String, kind: String) {
        self.id = id
        self.label = label
        self.kind = kind
    }

    public init?(json: RudderJSON) {
        guard let id = json["id"]?.string, let kind = json["kind"]?.string else { return nil }
        self.init(id: id, label: json["label"]?.string ?? id, kind: kind)
    }

    public var allows: Bool { kind.hasPrefix("allow") }
}

public struct RudderPermission: Equatable, Hashable, Sendable {
    public var id: String
    public var tool: String
    public var title: String
    public var detail: String
    // pending | allowed | denied | expired | cancelled
    public var status: String
    public var kind: String?
    public var options: [RudderPermissionOption]
    public var diffs: [RudderToolDiff]
    // Chosen option id.
    public var decision: String?
    // Id of the tool message (RudderChatMessage.id) this request belongs to.
    public var toolId: String?
    // withdrawn (the agent retracted it) | interrupted (the turn was stopped or ended); with status cancelled.
    public var cancelReason: String?

    public init(
        id: String,
        tool: String,
        title: String,
        detail: String,
        status: String,
        kind: String? = nil,
        options: [RudderPermissionOption] = [],
        diffs: [RudderToolDiff] = [],
        decision: String? = nil,
        toolId: String? = nil,
        cancelReason: String? = nil
    ) {
        self.id = id
        self.tool = tool
        self.title = title
        self.detail = detail
        self.status = status
        self.kind = kind
        self.options = options
        self.diffs = diffs
        self.decision = decision
        self.toolId = toolId
        self.cancelReason = cancelReason
    }

    public init?(json: RudderJSON) {
        guard let id = json["id"]?.string,
              let tool = json["tool"]?.string,
              let title = json["title"]?.string,
              let detail = json["detail"]?.string,
              let status = json["status"]?.string
        else { return nil }
        self.init(
            id: id,
            tool: tool,
            title: title,
            detail: detail,
            status: status,
            kind: json["kind"]?.string,
            options: json["options"]?.array?.compactMap(RudderPermissionOption.init(json:)) ?? [],
            diffs: json["diffs"]?.array?.compactMap(RudderToolDiff.init(json:)) ?? [],
            decision: json["decision"]?.string,
            toolId: json["toolId"]?.string,
            cancelReason: json["cancelReason"]?.string
        )
    }

    public var isPending: Bool { status == "pending" }
    public var isCancelled: Bool { status == "cancelled" }
    public var chosenOption: RudderPermissionOption? { options.first { $0.id == decision } }
}

public struct RudderQuestionChoice: Equatable, Hashable, Sendable, Identifiable {
    public var label: String
    public var description: String?
    public var id: String { label }

    public init(label: String, description: String? = nil) {
        self.label = label
        self.description = description
    }
}

public struct RudderQuestionItem: Equatable, Hashable, Sendable, Identifiable {
    public var question: String
    public var header: String?
    public var options: [RudderQuestionChoice]
    public var multiSelect: Bool
    /// false: only the option labels are accepted. Missing on the wire (older daemons) reads as true.
    public var allowsOther: Bool
    public var id: String { question }

    public init(
        question: String,
        header: String? = nil,
        options: [RudderQuestionChoice],
        multiSelect: Bool = false,
        allowsOther: Bool = true
    ) {
        self.question = question
        self.header = header
        self.options = options
        self.multiSelect = multiSelect
        self.allowsOther = allowsOther
    }

    public init?(json: RudderJSON) {
        guard let question = json["question"]?.string else { return nil }
        let options = json["options"]?.array?.compactMap { option in
            option["label"]?.string.map { RudderQuestionChoice(label: $0, description: option["description"]?.string) }
        } ?? []
        self.init(
            question: question,
            header: json["header"]?.string,
            options: options,
            multiSelect: json["multiSelect"]?.bool ?? false,
            allowsOther: json["allowsOther"]?.bool ?? true
        )
    }
}

public struct RudderQuestion: Equatable, Hashable, Sendable {
    public var id: String
    // First question; older daemons send only this.
    public var prompt: String
    public var options: [String]
    public var status: String
    public var answer: String?
    // Always at least one item: older payloads are lifted from prompt/options.
    public var questions: [RudderQuestionItem]
    // Keyed by question text; single-select answers are one-element arrays.
    public var answers: [String: [String]]
    // withdrawn | interrupted; with status cancelled.
    public var cancelReason: String?

    public init(
        id: String,
        prompt: String,
        options: [String],
        status: String,
        answer: String? = nil,
        questions: [RudderQuestionItem] = [],
        answers: [String: [String]] = [:],
        cancelReason: String? = nil
    ) {
        self.id = id
        self.prompt = prompt
        self.options = options
        self.status = status
        self.answer = answer
        self.questions = questions.isEmpty
            ? [RudderQuestionItem(question: prompt, options: options.map { RudderQuestionChoice(label: $0) })]
            : questions
        self.answers = answers
        self.cancelReason = cancelReason
    }

    public init?(json: RudderJSON) {
        guard let id = json["id"]?.string, let prompt = json["prompt"]?.string, let status = json["status"]?.string else { return nil }
        var answers: [String: [String]] = [:]
        if case .object(let raw) = json["answers"] {
            for (key, value) in raw {
                if let single = value.string { answers[key] = [single] }
                else if let many = value.array?.compactMap(\.string) { answers[key] = many }
            }
        }
        self.init(
            id: id,
            prompt: prompt,
            options: json["options"]?.array?.compactMap(\.string) ?? [],
            status: status,
            answer: json["answer"]?.string,
            questions: json["questions"]?.array?.compactMap(RudderQuestionItem.init(json:)) ?? [],
            answers: answers,
            cancelReason: json["cancelReason"]?.string
        )
    }

    public var isPending: Bool { status == "pending" }

    public enum Outcome: Equatable, Sendable { case pending, answered, onComputer, expired }

    /// answered → .answered; cancelled + withdrawn (handled on the computer) → .onComputer;
    /// cancelled for any other reason, or expired → .expired.
    public var outcome: Outcome {
        switch status {
        case "pending": .pending
        case "answered": .answered
        case "cancelled" where cancelReason == "withdrawn": .onComputer
        default: .expired
        }
    }
}

public struct RudderToolCall: Equatable, Hashable, Sendable {
    public var id: String
    public var tool: String
    public var title: String
    public var detail: String
    // pending | running | completed | failed | declined | cancelled
    public var status: String
    // read | edit | execute | search | fetch | think | other
    public var kind: String
    public var output: String?
    public var exitCode: Int?
    public var diffs: [RudderToolDiff]
    // The daemon cut output to 4 KB.
    public var outputTruncated: Bool

    public init(
        id: String,
        tool: String,
        title: String,
        detail: String,
        status: String,
        kind: String = "other",
        output: String? = nil,
        exitCode: Int? = nil,
        diffs: [RudderToolDiff] = [],
        outputTruncated: Bool = false
    ) {
        self.id = id
        self.tool = tool
        self.title = title
        self.detail = detail
        self.status = status
        self.kind = kind
        self.output = output
        self.exitCode = exitCode
        self.diffs = diffs
        self.outputTruncated = outputTruncated
    }

    public init?(json: RudderJSON) {
        guard let id = json["id"]?.string, let tool = json["tool"]?.string else { return nil }
        let status = json["status"]?.string ?? "running"
        self.init(
            id: id,
            tool: tool,
            title: json["title"]?.string ?? tool,
            detail: json["detail"]?.string ?? "",
            // "done" only appears on rows written before the unified event model.
            status: status == "done" ? "completed" : status,
            kind: json["kind"]?.string ?? "other",
            output: json["output"]?.string,
            exitCode: json["exitCode"]?.int,
            diffs: json["diffs"]?.array?.compactMap(RudderToolDiff.init(json:)) ?? [],
            outputTruncated: json["outputTruncated"]?.bool ?? false
        )
    }
}

public struct RudderReasoning: Equatable, Hashable, Sendable {
    // Milliseconds since 1970, daemon clock.
    public var startedAt: Double
    public var endedAt: Double?

    public init(startedAt: Double, endedAt: Double? = nil) {
        self.startedAt = startedAt
        self.endedAt = endedAt
    }

    public init?(json: RudderJSON) {
        guard let startedAt = json["startedAt"]?.number else { return nil }
        self.init(startedAt: startedAt, endedAt: json["endedAt"]?.number)
    }

    public var isThinking: Bool { endedAt == nil }
    public var seconds: Double? { endedAt.map { max(0, $0 - startedAt) / 1000 } }
    /// Rounded seconds the card shows; nil below one second or for rows without timestamps (older daemons).
    public var displaySeconds: Int? {
        guard let seconds, seconds >= 1 else { return nil }
        return Int(seconds.rounded())
    }
}

public struct RudderPlanEntry: Equatable, Hashable, Sendable {
    public var content: String
    // pending | in_progress | completed
    public var status: String

    public init(content: String, status: String) {
        self.content = content
        self.status = status
    }
}

public struct RudderPlan: Equatable, Hashable, Sendable {
    public var entries: [RudderPlanEntry]

    public init(entries: [RudderPlanEntry]) {
        self.entries = entries
    }

    public init?(json: RudderJSON) {
        guard let rows = json["entries"]?.array else { return nil }
        self.init(entries: rows.compactMap { row in
            row["content"]?.string.map { RudderPlanEntry(content: $0, status: row["status"]?.string ?? "pending") }
        })
    }
}

// Session totals; counters add up per turn, context fields are the latest snapshot.
public struct RudderUsage: Equatable, Hashable, Sendable {
    public var inputTokens: Int?
    public var outputTokens: Int?
    public var cacheReadTokens: Int?
    public var cacheWriteTokens: Int?
    public var reasoningTokens: Int?
    public var costUsd: Double?
    public var contextUsed: Int?
    public var contextSize: Int?

    public init(
        inputTokens: Int? = nil,
        outputTokens: Int? = nil,
        cacheReadTokens: Int? = nil,
        cacheWriteTokens: Int? = nil,
        reasoningTokens: Int? = nil,
        costUsd: Double? = nil,
        contextUsed: Int? = nil,
        contextSize: Int? = nil
    ) {
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.cacheReadTokens = cacheReadTokens
        self.cacheWriteTokens = cacheWriteTokens
        self.reasoningTokens = reasoningTokens
        self.costUsd = costUsd
        self.contextUsed = contextUsed
        self.contextSize = contextSize
    }

    public init(json: RudderJSON?) {
        func int(_ key: String) -> Int? { json?[key]?.int }
        self.init(
            inputTokens: int("inputTokens"),
            outputTokens: int("outputTokens"),
            cacheReadTokens: int("cacheReadTokens"),
            cacheWriteTokens: int("cacheWriteTokens"),
            reasoningTokens: int("reasoningTokens"),
            costUsd: json?["costUsd"]?.number,
            contextUsed: int("contextUsed"),
            contextSize: int("contextSize")
        )
    }

    public var isEmpty: Bool { self == RudderUsage() }
}

public struct RudderAgentCapabilities: Equatable, Hashable, Sendable {
    public var reasoning: Bool
    public var steer: Bool
    public var interrupt: Bool
    public var plan: Bool
    public var question: Bool
    // tokens | context | both | none
    public var usage: String
    // static | dynamic
    public var models: String
    public var efforts: Bool
    public var permissionModes: [String]
    /// The agent's permission-mode list; from older daemons, `permissionModes` with no copy.
    public var modes: [RudderPermissionModeInfo]
    // Grok: approves tools itself; the phone cannot ask it to stop.
    public var autoApproval: Bool
    /// The agent says it takes images in a prompt (Copilot). Claude, Codex and Grok are in `ImageCapability` already.
    public var images: Bool

    public init(json: RudderJSON?) {
        reasoning = json?["reasoning"]?.bool ?? false
        steer = json?["steer"]?.bool ?? false
        interrupt = json?["interrupt"]?.bool ?? false
        plan = json?["plan"]?.bool ?? false
        question = json?["question"]?.bool ?? false
        usage = json?["usage"]?.string ?? "none"
        models = json?["models"]?.string ?? "static"
        efforts = json?["efforts"]?.bool ?? false
        permissionModes = json?["permissionModes"]?.array?.compactMap(\.string) ?? ["ask"]
        let modes = json?["modes"]?.array?.compactMap(RudderPermissionModeInfo.init(json:)) ?? []
        self.modes = modes.isEmpty ? permissionModes.map { RudderPermissionModeInfo(id: $0, label: $0) } : modes
        autoApproval = json?["autoApproval"]?.bool ?? false
        images = json?["images"]?.bool ?? false
    }
}

/// How far a permission mode lets the agent act on its own. `caution` and `danger` are confirmed before switching.
public enum RudderPermissionRisk: String, Sendable {
    case normal, caution, danger
}

/// One entry of an agent's permission-mode list (`capabilities.modes`, `models.list` → `modes`).
/// `ask`, `acceptEdits` and `plan` mean the same for every agent that has them; other ids belong to one agent.
/// `native` is the agent's own name for the mode; `fromAgent` marks a label and description the agent sent itself.
public struct RudderPermissionModeInfo: Equatable, Hashable, Sendable, Identifiable {
    public var id: String
    public var label: String
    public var description: String?
    public var risk: RudderPermissionRisk
    /// Switching to it restarts the agent process (the conversation is resumed).
    public var restart: Bool
    public var native: String?
    public var fromAgent: Bool

    public init(id: String, label: String, description: String? = nil, risk: RudderPermissionRisk = .normal,
                restart: Bool = false, native: String? = nil, fromAgent: Bool = false) {
        self.id = id
        self.label = label
        self.description = description
        self.risk = risk
        self.restart = restart
        self.native = native
        self.fromAgent = fromAgent
    }

    public init?(json: RudderJSON) {
        guard let id = json["id"]?.string, !id.isEmpty else { return nil }
        self.init(
            id: id,
            label: json["label"]?.string ?? id,
            description: json["description"]?.string,
            risk: json["risk"]?.string.flatMap(RudderPermissionRisk.init(rawValue:)) ?? .normal,
            restart: json["restart"]?.bool ?? false,
            native: json["native"]?.string,
            fromAgent: json["fromAgent"]?.bool ?? false
        )
    }
}

public struct RudderAgent: Equatable, Hashable, Sendable, Identifiable {
    public var id: String
    public var label: String
    // fake | claude | codex | acp
    public var transport: String
    public var experimental: Bool
    public var available: Bool
    public var unavailableReason: String?
    /// r48: not_installed · auth_required · failed; v83: outdated. Nil on an older daemon (the phone reads the reason text then).
    public var unavailableCode: String?
    /// `unavailableReason` as a code the app words in its own language. Nil on an older daemon.
    public var unavailableCopy: RudderCopy?
    public var capabilities: RudderAgentCapabilities
    /// The agent CLI's version ("2.1.4"). Nil until a probe has landed, or when the daemon is older.
    public var version: String?
    /// v71: the agent's own settings pin its permission mode (Grok `permission_mode = "always-approve"`) and
    /// Rudder cannot change it. Nil when nothing is pinned, or on an older daemon.
    public var permissionLock: RudderPermissionLock?
    /// v83: the oldest CLI version Rudder supports ("0.52.0"). Sent whenever the daemon knows one.
    public var minimumVersion: String?
    /// v83: the command that upgrades the CLI. Only when outdated and the daemon knows how it was installed.
    public var upgradeCommand: String?

    /// v83: installed but older than `minimumVersion`; one command fixes it.
    public var isOutdated: Bool { unavailableCode == "outdated" }

    public init?(json: RudderJSON) {
        guard let id = json["id"]?.string else { return nil }
        self.id = id
        self.label = json["label"]?.string ?? id
        self.transport = json["transport"]?.string ?? ""
        self.experimental = json["experimental"]?.bool ?? false
        self.available = json["available"]?.bool ?? false
        self.unavailableReason = json["unavailableReason"]?.string
        self.unavailableCode = json["unavailableCode"]?.string
        self.unavailableCopy = RudderCopy(json: json["unavailableCopy"])
        self.capabilities = RudderAgentCapabilities(json: json["capabilities"])
        self.version = json["version"]?.string
        self.permissionLock = RudderPermissionLock(json: json["permissionLock"])
        self.minimumVersion = json["minimumVersion"]?.string
        self.upgradeCommand = json["upgradeCommand"]?.string
    }
}

/// `hello.agents[].permissionLock` (r70, v71).
public struct RudderPermissionLock: Equatable, Hashable, Sendable {
    /// Only "always-approve" today.
    public var mode: String
    /// The settings file that pins it (`~/.grok/config.toml`).
    public var source: String

    public init(mode: String, source: String) {
        self.mode = mode
        self.source = source
    }

    public init?(json: RudderJSON?) {
        guard let mode = json?["mode"]?.string, !mode.isEmpty else { return nil }
        self.mode = mode
        self.source = json?["source"]?.string ?? ""
    }

    /// The approve-everything lock: Rudder's ask modes do not apply, plan still does.
    public var approvesEverything: Bool { mode == "always-approve" }
}

public struct RudderSkill: Equatable, Hashable, Sendable, Identifiable {
    public var id: String
    public var trigger: String
    public var title: String
    public var detail: String

    public init?(json: RudderJSON) {
        guard let id = json["id"]?.string,
              let trigger = json["trigger"]?.string,
              let title = json["title"]?.string
        else { return nil }
        self.id = id
        self.trigger = trigger
        self.title = title
        self.detail = json["detail"]?.string ?? ""
    }
}

/// One entry of the composer's `/` list (`commands.list`). `insert` is what goes into the message:
/// `/name`, or `$name` for Codex skills. `source`: `project`, `user`, `plugin:<name>` or `agent`.
public struct RudderCommand: Equatable, Hashable, Sendable, Identifiable {
    public enum Kind: String, Sendable { case skill, command }

    public var name: String
    public var insert: String
    public var kind: Kind
    public var description: String?
    public var source: String
    public var id: String { name }

    public init(name: String, insert: String, kind: Kind, description: String? = nil, source: String) {
        self.name = name
        self.insert = insert
        self.kind = kind
        self.description = description
        self.source = source
    }

    public init?(json: RudderJSON) {
        guard let name = json["name"]?.string, !name.isEmpty,
              let insert = json["insert"]?.string, !insert.isEmpty,
              let kind = json["kind"]?.string.flatMap(Kind.init(rawValue:))
        else { return nil }
        self.init(name: name, insert: insert, kind: kind, description: json["description"]?.string, source: json["source"]?.string ?? "agent")
    }
}

public struct RudderModelChoice: Equatable, Hashable, Sendable, Identifiable {
    public var id: String
    public var label: String
    public var description: String?

    public init(id: String, label: String, description: String? = nil) {
        self.id = id
        self.label = label
        self.description = description
    }

    public init?(json: RudderJSON) {
        guard let id = json["id"]?.string, !id.isEmpty else { return nil }
        self.init(id: id, label: json["label"]?.string ?? id, description: json["description"]?.string)
    }
}

public struct RudderModel: Equatable, Hashable, Sendable, Identifiable {
    public var id: String
    public var label: String
    public var efforts: [String]
    public var defaultEffort: String?
    /// The agent's own default model (Codex `model/list` isDefault).
    public var isDefault: Bool
    public var description: String?
    public var contextWindows: [Int]
    public var speeds: [RudderModelChoice]
    public var defaultSpeed: String?
    /// Copilot: premium requests per message (`_meta.copilotUsage` 「14x」 → 14) and its price category
    /// (low · medium · high · very_high).
    public var multiplier: Double?
    public var priceTier: String?
    /// Derived by rudderd from the id prefix for multi-vendor lists (Copilot): the vendor group, the family whose
    /// older versions fold, and the version within it.
    public var vendor: String?
    public var family: String?
    public var version: String?

    public init(id: String, label: String, efforts: [String] = [], defaultEffort: String? = nil, isDefault: Bool = false,
                description: String? = nil, contextWindows: [Int] = [], speeds: [RudderModelChoice] = [],
                defaultSpeed: String? = nil, multiplier: Double? = nil, priceTier: String? = nil,
                vendor: String? = nil, family: String? = nil, version: String? = nil) {
        self.id = id
        self.label = label
        self.efforts = efforts
        self.defaultEffort = defaultEffort
        self.isDefault = isDefault
        self.description = description
        self.contextWindows = contextWindows
        self.speeds = speeds
        self.defaultSpeed = defaultSpeed
        self.multiplier = multiplier
        self.priceTier = priceTier
        self.vendor = vendor
        self.family = family
        self.version = version
    }

    public init?(json: RudderJSON) {
        guard let id = json["id"]?.string else { return nil }
        self.init(
            id: id,
            label: json["label"]?.string ?? id,
            efforts: json["efforts"]?.array?.compactMap(\.string) ?? [],
            defaultEffort: json["defaultEffort"]?.string,
            isDefault: json["isDefault"]?.bool ?? false,
            description: json["description"]?.string,
            contextWindows: json["contextWindows"]?.array?.compactMap(\.int) ?? [],
            speeds: json["speeds"]?.array?.compactMap(RudderModelChoice.init(json:)) ?? [],
            defaultSpeed: json["defaultSpeed"]?.string,
            multiplier: json["multiplier"]?.number,
            priceTier: json["priceTier"]?.string,
            vendor: json["vendor"]?.string,
            family: json["family"]?.string,
            version: json["version"]?.string
        )
    }
}

/// Effort levels the way the picker lists them: by known strength (minimal < low < medium < high < xhigh < max < ultra),
/// then any level Rudder does not know in the agent's order (Grok lists its levels strongest first).
public enum RudderEffort {
    public static let known = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]

    public static func sorted(_ levels: [String]) -> [String] {
        var seen = Set<String>()
        let unique = levels.filter { seen.insert($0).inserted }
        let ranked = unique.filter(known.contains).sorted { known.firstIndex(of: $0)! < known.firstIndex(of: $1)! }
        return ranked + unique.filter { !known.contains($0) }
    }
}

public struct RudderFileEntry: Equatable, Hashable, Sendable, Identifiable {
    public var name: String
    public var path: String
    public var directory: Bool
    public var size: Int

    public var id: String { path }

    public init(name: String, path: String, directory: Bool = false, size: Int = 0) {
        self.name = name
        self.path = path
        self.directory = directory
        self.size = size
    }

    public init?(json: RudderJSON) {
        guard let name = json["name"]?.string, let path = json["path"]?.string else { return nil }
        self.name = name
        self.path = path
        self.directory = json["directory"]?.bool ?? false
        self.size = json["size"]?.int ?? 0
    }
}

/// `fs.read`: a file's text (first 32 KB), its full size, and whether the daemon judged it binary (no text sent).
public struct RudderFileContent: Equatable, Sendable {
    public var path: String
    public var text: String
    public var truncated: Bool
    public var bytes: Int
    public var binary: Bool

    public init(path: String, text: String, truncated: Bool = false, bytes: Int = 0, binary: Bool = false) {
        self.path = path
        self.text = text
        self.truncated = truncated
        self.bytes = bytes
        self.binary = binary
    }

    public init?(json: RudderJSON) {
        guard let path = json["path"]?.string else { return nil }
        let text = json["text"]?.string ?? ""
        self.init(
            path: path,
            text: text,
            truncated: json["truncated"]?.bool ?? false,
            bytes: json["bytes"]?.int ?? text.utf8.count,
            binary: json["binary"]?.bool ?? false
        )
    }
}

/// One changed path in `git.status` `files[]`. `status` is the summary letter (M A D R C U ?); counts are
/// `git diff --numstat` against HEAD, absent for untracked and binary files.
public struct RudderGitFile: Equatable, Hashable, Sendable, Identifiable {
    /// Relative to `git.status`'s `root`: the repository top, or the workspace when it is a folder inside a repository.
    public var path: String
    public var origPath: String?
    public var status: String
    public var added: Int?
    public var removed: Int?
    public var binary: Bool

    public var id: String { path }
    public var untracked: Bool { status == "?" }

    public init(path: String, origPath: String? = nil, status: String, added: Int? = nil, removed: Int? = nil, binary: Bool = false) {
        self.path = path
        self.origPath = origPath
        self.status = status
        self.added = added
        self.removed = removed
        self.binary = binary
    }

    public init?(json: RudderJSON) {
        guard let path = json["path"]?.string, let status = json["status"]?.string else { return nil }
        self.init(
            path: path,
            origPath: json["origPath"]?.string,
            status: status,
            added: json["added"]?.int,
            removed: json["removed"]?.int,
            binary: json["binary"]?.bool ?? false
        )
    }
}

/// `git.status`'s structured fields. A daemon older than them sends only `text`: `files` is then empty and
/// `structured` is false.
public struct RudderGitStatus: Equatable, Sendable {
    public var root: String
    /// nil when HEAD is detached.
    public var branch: String?
    public var oid: String?
    public var upstream: String?
    public var ahead: Int
    public var behind: Int
    public var files: [RudderGitFile]
    public var filesTruncated: Bool
    public var structured: Bool

    public init(root: String, branch: String?, oid: String? = nil, upstream: String? = nil, ahead: Int = 0, behind: Int = 0,
                files: [RudderGitFile], filesTruncated: Bool = false, structured: Bool = true) {
        self.root = root
        self.branch = branch
        self.oid = oid
        self.upstream = upstream
        self.ahead = ahead
        self.behind = behind
        self.files = files
        self.filesTruncated = filesTruncated
        self.structured = structured
    }

    public init(json: RudderJSON) {
        self.init(
            root: json["root"]?.string ?? json["cwd"]?.string ?? "",
            branch: json["branch"]?.string,
            oid: json["oid"]?.string,
            upstream: json["upstream"]?.string,
            ahead: json["ahead"]?.int ?? 0,
            behind: json["behind"]?.int ?? 0,
            files: json["files"]?.array?.compactMap(RudderGitFile.init(json:)) ?? [],
            filesTruncated: json["filesTruncated"]?.bool ?? false,
            structured: json["files"] != nil
        )
    }

    /// Tracked changes; untracked paths are listed but not counted (the design's「4 处改动」beside five rows).
    public var changeCount: Int { files.filter { !$0.untracked }.count }
}

/// `git.diff` with `file`: one file's unified diff against HEAD (untracked files as all-added), cut at 64 KB.
public struct RudderGitPatch: Equatable, Sendable {
    public var path: String
    public var patch: String
    public var truncated: Bool
    public var binary: Bool
    public var untracked: Bool

    public init(path: String, patch: String, truncated: Bool = false, binary: Bool = false, untracked: Bool = false) {
        self.path = path
        self.patch = patch
        self.truncated = truncated
        self.binary = binary
        self.untracked = untracked
    }

    public init?(json: RudderJSON) {
        guard let path = json["path"]?.string, let patch = json["patch"]?.string else { return nil }
        self.init(
            path: path,
            patch: patch,
            truncated: json["truncated"]?.bool ?? false,
            binary: json["binary"]?.bool ?? false,
            untracked: json["untracked"]?.bool ?? false
        )
    }
}

public struct RudderScheduled: Equatable, Hashable, Sendable, Identifiable {
    public var id: String
    public var sessionId: String
    public var text: String
    public var fireAt: Double
    public var status: String

    public init?(json: RudderJSON) {
        guard let id = json["id"]?.string,
              let sessionId = json["sessionId"]?.string,
              let text = json["text"]?.string
        else { return nil }
        self.id = id
        self.sessionId = sessionId
        self.text = text
        self.fireAt = json["fireAt"]?.number ?? 0
        self.status = json["status"]?.string ?? "pending"
    }
}

public struct RudderDraft: Equatable, Hashable, Sendable, Identifiable {
    public var sessionId: String
    public var text: String
    public var updatedAt: Double
    public var id: String { sessionId }

    public init?(json: RudderJSON) {
        guard let sessionId = json["sessionId"]?.string, let text = json["text"]?.string else { return nil }
        self.sessionId = sessionId
        self.text = text
        self.updatedAt = json["updatedAt"]?.number ?? 0
    }
}

public struct RudderMachine: Equatable, Hashable, Sendable {
    public var name: String
    public var cwd: String
    /// The daemon user's home directory, for `~` abbreviations; nil from daemons that predate it.
    public var home: String?
    /// `process.platform` (`darwin`, `win32`, …); nil from daemons before v49. Known before the first perf sample.
    public var platform: String?
    /// Marketing name and OS version, once the computer's perf sampler has read them.
    public var model: String?
    public var osVersion: String?
    /// r73 A / B: the computer continues a turn by itself after a usage limit resets / after it restarts. Nil from
    /// daemons that predate the settings (the phone then shows neither the switches nor the error card's line).
    public var autoResumeLimits: Bool?
    public var continueAfterRestart: Bool?

    public init(name: String, cwd: String, home: String? = nil, platform: String? = nil, model: String? = nil, osVersion: String? = nil,
                autoResumeLimits: Bool? = nil, continueAfterRestart: Bool? = nil) {
        self.name = name
        self.cwd = cwd
        self.home = home
        self.platform = platform
        self.model = model
        self.osVersion = osVersion
        self.autoResumeLimits = autoResumeLimits
        self.continueAfterRestart = continueAfterRestart
    }

    public init?(json: RudderJSON) {
        guard let name = json["name"]?.string else { return nil }
        self.init(
            name: name, cwd: json["cwd"]?.string ?? "", home: json["home"]?.string,
            platform: json["platform"]?.string, model: json["model"]?.string, osVersion: json["osVersion"]?.string,
            autoResumeLimits: json["autoResumeLimits"]?.bool, continueAfterRestart: json["continueAfterRestart"]?.bool
        )
    }
}

/// One image the agent returned. The bytes stay on the computer; the phone downloads them by `id`.
public struct RudderAgentImage: Equatable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var bytes: Int
    public var mediaType: String
    public var width: Int
    public var height: Int
    /// the file's base name when the picture is a file the agent wrote (the bubble captions it). Nil for a
    /// generated image (Codex `imageGeneration`) and on older daemons.
    public var fileName: String?
    /// The file's path in the session folder, as rudderd attached it: a reply that names the same file shows it here,
    /// not again as a file card (r75). Nil for a generated image and on older daemons.
    public var sourcePath: String?

    public init(id: String, name: String, bytes: Int, mediaType: String, width: Int, height: Int, fileName: String? = nil,
                sourcePath: String? = nil) {
        self.id = id
        self.name = name
        self.bytes = bytes
        self.mediaType = mediaType
        self.width = width
        self.height = height
        self.fileName = fileName
        self.sourcePath = sourcePath
    }

    public init?(json: RudderJSON) {
        guard let id = json["id"]?.string,
              let name = json["name"]?.string,
              let mediaType = json["mediaType"]?.string,
              let width = json["width"]?.int, width > 0,
              let height = json["height"]?.int, height > 0
        else { return nil }
        let fileName = json["fileName"]?.string.flatMap { $0.isEmpty ? nil : $0 }
        self.init(id: id, name: name, bytes: json["bytes"]?.int ?? 0, mediaType: mediaType, width: width, height: height,
                  fileName: fileName, sourcePath: json["sourcePath"]?.string.flatMap { $0.isEmpty ? nil : $0 })
    }
}

/// A file the user sent with a message (`attachments` on a user text row). The bytes stay on the computer.
public struct RudderMessageAttachment: Equatable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var bytes: Int
    /// r75: an image's pixel size, read from its header when rudderd saved it, so a photo is laid out at its own aspect
    /// before its bytes arrive. Nil for other files and for messages from before r75.
    public var width: Int?
    public var height: Int?

    public init(id: String, name: String, bytes: Int, width: Int? = nil, height: Int? = nil) {
        self.id = id
        self.name = name
        self.bytes = bytes
        self.width = width
        self.height = height
    }

    public init?(json: RudderJSON) {
        guard let id = json["id"]?.string, let name = json["name"]?.string else { return nil }
        let width = json["width"]?.int, height = json["height"]?.int
        let sized = (width ?? 0) > 0 && (height ?? 0) > 0
        self.init(id: id, name: name, bytes: json["bytes"]?.int ?? 0, width: sized ? width : nil, height: sized ? height : nil)
    }

    /// a long paste the phone sent as `paste-HHmm.txt` (`paste-HHmm-2.txt` within the same minute).
    public var isPaste: Bool { Self.isPasteName(name) }

    public static func isPasteName(_ name: String) -> Bool {
        name.range(of: #"^paste-\d{4}(-\d+)?\.txt$"#, options: .regularExpression) != nil
    }
}

public struct RudderCompaction: Equatable, Sendable {
    public var state: String
    public var trigger: String
    public var startedAt: Double?
    public var tokensBefore: Int?
    public var tokensAfter: Int?
    public var count: Int

    public init(state: String, trigger: String, startedAt: Double? = nil, tokensBefore: Int? = nil,
                tokensAfter: Int? = nil, count: Int = 0) {
        self.state = state
        self.trigger = trigger
        self.startedAt = startedAt
        self.tokensBefore = tokensBefore
        self.tokensAfter = tokensAfter
        self.count = count
    }

    public init?(json: RudderJSON?) {
        guard let json, let state = json["state"]?.string, let trigger = json["trigger"]?.string else { return nil }
        self.state = state
        self.trigger = trigger
        self.startedAt = json["startedAt"]?.number
        self.tokensBefore = json["tokensBefore"]?.int
        self.tokensAfter = json["tokensAfter"]?.int
        self.count = json["count"]?.int ?? 0
    }
}

/// r48: why a turn failed, on an `error` row. Absent on a plain error and on older daemons.
public enum RudderAgentError: Equatable, Sendable {
    /// Milliseconds since 1970 on the daemon clock, when the agent said.
    case usageLimit(resetsAt: Double?)
    case authRequired(command: String?)
    case agentExited(exitCode: Int?, detail: String?)

    public init?(json: RudderJSON?) {
        guard let json, let code = json["code"]?.string else { return nil }
        switch code {
        case "usage_limit": self = .usageLimit(resetsAt: json["resetsAt"]?.number)
        case "auth_required": self = .authRequired(command: json["command"]?.string)
        case "agent_exited": self = .agentExited(exitCode: json["exitCode"]?.int, detail: json["detail"]?.string)
        default: return nil
        }
    }

    public var json: RudderJSON {
        switch self {
        case .usageLimit(let resetsAt):
            var fields: [String: RudderJSON] = ["code": .string("usage_limit")]
            if let resetsAt { fields["resetsAt"] = .number(resetsAt) }
            return .object(fields)
        case .authRequired(let command):
            var fields: [String: RudderJSON] = ["code": .string("auth_required")]
            if let command { fields["command"] = .string(command) }
            return .object(fields)
        case .agentExited(let exitCode, let detail):
            var fields: [String: RudderJSON] = ["code": .string("agent_exited")]
            if let exitCode { fields["exitCode"] = .number(Double(exitCode)) }
            if let detail { fields["detail"] = .string(detail) }
            return .object(fields)
        }
    }
}

/// Text rudderd wrote for the phone (an error row, a notice, an agent's unavailable reason) as a stable code with its
/// arguments (`daemon/src/phone-copy.ts`). The app words a code it knows in its own language; `text` is rudderd's
/// Simplified Chinese, shown for a code it does not know. Absent on older daemons.
public struct RudderCopy: Equatable, Hashable, Sendable {
    private static let wording = WordingSlot()

    /// How copy reads in the app's language (`RudderLocalization.wordCopy` sets it at launch). Unset: rudderd's text.
    public static func setWording(_ word: @escaping @Sendable (RudderCopy) -> String) {
        wording.set(word)
    }

    /// This copy in the app's language, or rudderd's text before a wording is set.
    public var worded: String { Self.wording.get()?(self) ?? text }

    private final class WordingSlot: @unchecked Sendable {
        private let lock = NSLock()
        private var word: (@Sendable (RudderCopy) -> String)?
        func set(_ word: @escaping @Sendable (RudderCopy) -> String) { lock.withLock { self.word = word } }
        func get() -> (@Sendable (RudderCopy) -> String)? { lock.withLock { word } }
    }

    public indirect enum Arg: Equatable, Hashable, Sendable {
        /// A command, a path, an agent's label, an error the agent wrote: shown as is.
        case text(String)
        /// Another piece of copy, worded the same way.
        case copy(RudderCopy)
    }

    public var code: String
    public var args: [String: Arg]
    public var text: String

    public init(code: String, args: [String: Arg] = [:], text: String) {
        self.code = code
        self.args = args
        self.text = text
    }

    public init?(json: RudderJSON?) {
        guard let json, let code = json["code"]?.string, let text = json["text"]?.string else { return nil }
        var args: [String: Arg] = [:]
        guard case .object(let raw)? = json["args"] else {
            self.init(code: code, text: text)
            return
        }
        for (key, value) in raw {
            if let string = value.string {
                args[key] = .text(string)
            } else if let copy = RudderCopy(json: value) {
                args[key] = .copy(copy)
            }
        }
        self.init(code: code, args: args, text: text)
    }

    public var json: RudderJSON {
        var fields: [String: RudderJSON] = ["code": .string(code), "text": .string(text)]
        if !args.isEmpty {
            fields["args"] = .object(args.mapValues {
                switch $0 {
                case .text(let string): .string(string)
                case .copy(let copy): copy.json
                }
            })
        }
        return .object(fields)
    }
}

/// v66 B2: the text messages one reply bubble joins, in order. The bubble keeps the first one's id.
public struct RudderReplyRun: Equatable, Hashable, Sendable {
    /// The joined messages' ids; the last is the one that may still stream.
    public var partIDs: [String]
    /// Where each part starts in the joined text, in UTF-8 bytes. The first is 0.
    public var starts: [Int]

    public init(partIDs: [String], starts: [Int]) {
        self.partIDs = partIDs
        self.starts = starts
    }

    /// Where the last part (the one a token patches) starts.
    public var tailStart: Int { starts.last ?? 0 }
}

/// r72 `session.switchAgent`'s notice row: `{from, to}`, each an agent id and a model id (empty = the agent's default).
public struct RudderAgentSwitch: Equatable, Hashable, Sendable {
    public var fromAgent: String
    public var fromModel: String
    public var toAgent: String
    public var toModel: String
    /// `resume: true`: the switch was 「换成 X 接着做」 (`session.switchAgent {resume: true}`); the computer sends the
    /// continuation right after it, so the row is the continuation line from its first frame.
    public var resume: Bool

    public init(fromAgent: String, fromModel: String = "", toAgent: String, toModel: String = "", resume: Bool = false) {
        self.fromAgent = fromAgent
        self.fromModel = fromModel
        self.toAgent = toAgent
        self.toModel = toModel
        self.resume = resume
    }

    public init?(json: RudderJSON) {
        guard let from = json["from"]?["agent"]?.string, let to = json["to"]?["agent"]?.string else { return nil }
        self.init(fromAgent: from, fromModel: json["from"]?["model"]?.string ?? "", toAgent: to, toModel: json["to"]?["model"]?.string ?? "",
                  resume: json["resume"]?.bool == true)
    }
}

/// r73: a user row the computer or the phone sent to continue a turn; the timeline draws it as a notice row.
public enum RudderResumeOrigin: String, Sendable, CaseIterable {
    /// A: the usage limit reset (「额度已恢复，自动接着做」).
    case limit = "auto_resume"
    /// B: the computer restarted mid-turn (「电脑重启过，自动接着做」).
    case restart = "restart_resume"
    /// G: the phone switched to the fallback agent (「换成 Codex，接着做」).
    case fallback = "fallback_resume"
    /// v94: the agent spoke after its turn (a background task or subagent finished); rudderd opened this turn for it.
    case agentContinue = "agent_continue"
}

public extension RudderChatMessage {
    /// The continuation this user row is, if it is one.
    var resumeOrigin: RudderResumeOrigin? {
        guard role == "user", kind == "text", let origin else { return nil }
        return RudderResumeOrigin(rawValue: origin)
    }
}

public struct RudderChatMessage: Equatable, Sendable, Identifiable {
    public var id: String
    public var sessionId: String
    public var seq: Int
    public var kind: String
    public var role: String
    public var text: String
    /// Structured choices attached to a Codex asynchronous reply. Empty on older messages.
    public var replyChoices: [String]
    public var clientMessageId: String?
    public var clientDeviceId: String?
    public var turnId: String?
    public var turnEnd: RudderMessageTurnEnd?
    public var permission: RudderPermission?
    public var question: RudderQuestion?
    public var tool: RudderToolCall?
    public var reasoning: RudderReasoning?
    public var plan: RudderPlan?
    // Milliseconds since 1970, daemon clock; 0 when absent.
    public var createdAt: Double
    /// Set on a `kind == "image"` row. Absent on every older message.
    public var image: RudderAgentImage?
    public var compaction: RudderCompaction?
    /// The daemon kept the fold fields and left out tool output, diff patches, or the rest of a thought.
    public var trimmed: Bool
    /// This turn's images, filled in by the timeline. Not on the wire.
    public var gallery: [RudderAgentImage]
    /// `sent` while a steered line waits for the live turn. `read` once the agent has continued.
    public var steer: String?
    /// Daemon clock, milliseconds, when `steer` became `read`.
    public var steerReadAt: Double
    /// The steered line was the user's reply to an agent that had finished speaking and waited on background work.
    /// It reads as an ordinary message; it still is not a turn's first prompt (no 从这里重来).
    public var steerWaiting: Bool
    /// Files sent with a user message, in send order. Empty on every other row.
    public var attachments: [RudderMessageAttachment]
    /// r47: "relay" = line comments Rudder sent for the user after a declined approval (「Rudder 代发」); "review" =
    /// comments sent from 本轮改动. r73: "auto_resume" / "restart_resume" / "fallback_resume" = the continuation the
    /// computer or the phone sent for the user (drawn as a notice row, `RudderResumeOrigin`). nil on every other row.
    public var origin: String?
    /// r72: on `session.switchAgent`'s notice row, the agent and model the session left and took.
    public var agentSwitch: RudderAgentSwitch?
    /// r48: set on a `kind == "error"` row whose cause the daemon named.
    public var agentError: RudderAgentError?
    /// `text` as a code the app words in its own language (an error row, a notice rudderd wrote). Nil on most rows.
    public var copy: RudderCopy?
    /// v56: brought over from a terminal Claude transcript; read-only history (approvals and questions show their result).
    public var imported: Bool
    /// v56: `kind == "handoff"` rows: "terminal" / "phone" dividers, or "earlier", the marker for rows still on the computer.
    public var handoff: String?
    /// v56: on the "earlier" marker, how many rows are still on the computer (0 once all came over).
    public var handoffEarlier: Int
    /// A kind this app does not know (`RudderMessageKind.isKnown`): the daemon's plain-text fallback line, if it sent one.
    public var summary: String?
    /// r64 `sync`: the session's change counter when this row was last written. 0 from daemons without it.
    public var rev: Int
    /// v66 B2: this reply is several of the turn's text messages drawn as one bubble. Filled in by the timeline, not on
    /// the wire.
    public var run: RudderReplyRun? = nil

    public init(
        id: String,
        sessionId: String,
        seq: Int,
        kind: String,
        role: String,
        text: String,
        clientMessageId: String? = nil,
        clientDeviceId: String? = nil,
        turnId: String? = nil,
        turnEnd: RudderMessageTurnEnd? = nil,
        permission: RudderPermission? = nil,
        question: RudderQuestion? = nil,
        tool: RudderToolCall? = nil,
        reasoning: RudderReasoning? = nil,
        plan: RudderPlan? = nil,
        createdAt: Double = 0,
        image: RudderAgentImage? = nil,
        trimmed: Bool = false,
        gallery: [RudderAgentImage] = [],
        compaction: RudderCompaction? = nil,
        steer: String? = nil,
        steerReadAt: Double = 0,
        steerWaiting: Bool = false,
        attachments: [RudderMessageAttachment] = [],
        origin: String? = nil,
        agentError: RudderAgentError? = nil,
        imported: Bool = false,
        handoff: String? = nil,
        handoffEarlier: Int = 0,
        summary: String? = nil,
        rev: Int = 0,
        agentSwitch: RudderAgentSwitch? = nil,
        copy: RudderCopy? = nil,
        replyChoices: [String] = []
    ) {
        self.id = id
        self.sessionId = sessionId
        self.seq = seq
        self.kind = kind
        self.role = role
        self.text = text
        self.replyChoices = replyChoices
        self.clientMessageId = clientMessageId
        self.clientDeviceId = clientDeviceId
        self.turnId = turnId
        self.turnEnd = turnEnd
        self.permission = permission
        self.question = question
        self.tool = tool
        self.reasoning = reasoning
        self.plan = plan
        self.createdAt = createdAt
        self.image = image
        self.compaction = compaction
        self.trimmed = trimmed
        self.gallery = gallery
        self.steer = steer
        self.steerReadAt = steerReadAt
        self.steerWaiting = steerWaiting
        self.attachments = attachments
        self.origin = origin
        self.agentError = agentError
        self.imported = imported
        self.handoff = handoff
        self.handoffEarlier = handoffEarlier
        self.summary = summary
        self.rev = rev
        self.agentSwitch = agentSwitch
        self.copy = copy
    }

    public init?(json: RudderJSON) {
        guard let id = json["id"]?.string,
              let sessionId = json["sessionId"]?.string,
              let kind = json["kind"]?.string,
              let role = json["role"]?.string,
              let text = json["text"]?.string
        else { return nil }
        let seq = json["seq"]?.int ?? 0
        let steerJSON = json["steer"]
        self.init(
            id: id,
            sessionId: sessionId,
            seq: seq,
            kind: kind,
            role: role,
            text: text,
            clientMessageId: json["clientMessageId"]?.string,
            clientDeviceId: json["clientDeviceId"]?.string,
            turnId: json["turnId"]?.string,
            turnEnd: json["turnEnd"].flatMap(RudderMessageTurnEnd.init(json:)),
            permission: json["permission"].flatMap(RudderPermission.init(json:)),
            question: json["question"].flatMap(RudderQuestion.init(json:)),
            tool: json["tool"].flatMap(RudderToolCall.init(json:)),
            reasoning: json["reasoning"].flatMap(RudderReasoning.init(json:)),
            plan: json["plan"].flatMap(RudderPlan.init(json:)),
            createdAt: json["createdAt"]?.number ?? 0,
            image: json["image"].flatMap(RudderAgentImage.init(json:)),
            trimmed: json["trimmed"]?.bool ?? false,
            compaction: RudderCompaction(json: json["compaction"]),
            steer: steerJSON?["state"]?.string ?? steerJSON?.string,
            steerReadAt: steerJSON?["readAt"]?.number ?? 0,
            steerWaiting: steerJSON?["waiting"]?.bool ?? false,
            attachments: json["attachments"]?.array?.compactMap(RudderMessageAttachment.init(json:)) ?? [],
            origin: json["origin"]?.string,
            agentError: RudderAgentError(json: json["error"]),
            imported: json["imported"]?.bool ?? false,
            handoff: json["handoff"]?.string,
            handoffEarlier: json["earlier"]?.int ?? 0,
            summary: json["summary"]?.string,
            rev: json["rev"]?.int ?? 0,
            agentSwitch: json["agentSwitch"].flatMap(RudderAgentSwitch.init(json:)),
            copy: RudderCopy(json: json["copy"]),
            replyChoices: json["replyChoices"]?.array?.compactMap(\.string) ?? []
        )
    }

    /// Patches the message with the same id (searched from the newest end, where streaming happens), else inserts
    /// it by `seq`: appended when it is not older than the last row, binary-inserted otherwise.
    /// Takes a newer frame of this message. Local fields (seq, time, the gallery) stay.
    public mutating func absorb(_ incoming: RudderChatMessage) {
        text = incoming.text
        replyChoices = incoming.replyChoices
        clientMessageId = incoming.clientMessageId ?? clientMessageId
        clientDeviceId = incoming.clientDeviceId ?? clientDeviceId
        turnId = incoming.turnId ?? turnId
        turnEnd = incoming.turnEnd ?? turnEnd
        kind = incoming.kind
        permission = incoming.permission
        question = incoming.question
        tool = incoming.tool
        reasoning = incoming.reasoning
        plan = incoming.plan
        image = incoming.image
        compaction = incoming.compaction
        trimmed = incoming.trimmed
        steer = incoming.steer
        steerReadAt = incoming.steerReadAt
        steerWaiting = incoming.steerWaiting
        attachments = incoming.attachments
        origin = incoming.origin ?? origin
        agentError = incoming.agentError
        imported = incoming.imported
        handoff = incoming.handoff
        handoffEarlier = incoming.handoffEarlier
        summary = incoming.summary ?? summary
        agentSwitch = incoming.agentSwitch ?? agentSwitch
        copy = incoming.copy
        if incoming.rev != 0 { rev = incoming.rev }
    }


    public static func upsert(_ incoming: RudderChatMessage, into messages: inout [RudderChatMessage]) {
        if let index = messages.lastIndex(where: { $0.id == incoming.id }) {
            messages[index].absorb(incoming)
            return
        }
        guard let last = messages.last, incoming.seq < last.seq else {
            messages.append(incoming)
            return
        }
        var low = 0, high = messages.count
        while low < high {
            let mid = (low + high) / 2
            if messages[mid].seq <= incoming.seq { low = mid + 1 } else { high = mid }
        }
        messages.insert(incoming, at: low)
    }
}

/// `session.preview`: the newest user or agent text message as the list shows it, already one line (Markdown marks
/// stripped, at most 120 characters, `…` when cut).
public struct RudderSessionPreview: Equatable, Hashable, Sendable {
    // user | assistant
    public var role: String
    public var text: String
    // Milliseconds since 1970, daemon clock; 0 when absent.
    public var createdAt: Double

    public var fromUser: Bool { role == "user" }

    public init(role: String, text: String, createdAt: Double = 0) {
        self.role = role
        self.text = text
        self.createdAt = createdAt
    }

    public init?(json: RudderJSON) {
        guard let text = json["text"]?.string, !text.isEmpty else { return nil }
        self.init(role: json["role"]?.string ?? "assistant", text: text, createdAt: json["createdAt"]?.number ?? 0)
    }
}

/// v48 H1: what a running turn is doing now (the list row's second line). Only sent while a tool runs or the agent
/// thinks; older daemons never send it.
public struct RudderSessionStep: Equatable, Hashable, Sendable {
    /// edit | execute | think
    public var kind: String
    /// The file's name (edit) or the command's first line (execute); nil for think.
    public var text: String?

    public init(kind: String, text: String? = nil) {
        self.kind = kind
        self.text = text
    }

    public init?(json: RudderJSON) {
        guard let kind = json["kind"]?.string, !kind.isEmpty else { return nil }
        let text = json["text"]?.string
        self.init(kind: kind, text: text?.isEmpty == true ? nil : text)
    }
}

/// r47 `session.lastTurn`: the result the session list leads the second line with.
public struct RudderTurnTermination: Equatable, Hashable, Sendable {
    public let cause: String
    public let requestedAt: Double
    public let json: RudderJSON
    private let fingerprint: Data

    public init?(json: RudderJSON) {
        guard let cause = json["cause"]?.string, let requestedAt = json["requestedAt"]?.number else { return nil }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        guard let fingerprint = try? encoder.encode(json) else { return nil }
        self.cause = cause
        self.requestedAt = requestedAt
        self.json = json
        self.fingerprint = fingerprint
    }

    public static func == (lhs: Self, rhs: Self) -> Bool { lhs.fingerprint == rhs.fingerprint }
    public func hash(into hasher: inout Hasher) { hasher.combine(fingerprint) }
}

public struct RudderMessageTurnEnd: Equatable, Hashable, Sendable {
    public var id: String
    public var revision: Int
    public var outcome: RudderLastTurn

    public init(id: String, revision: Int, outcome: RudderLastTurn) {
        self.id = id
        self.revision = revision
        self.outcome = outcome
    }

    public init?(json: RudderJSON) {
        guard let id = json["id"]?.string, let outcome = json["outcome"].flatMap(RudderLastTurn.init(json:)) else { return nil }
        self.init(id: id, revision: json["revision"]?.int ?? 0, outcome: outcome)
    }

    public var json: RudderJSON {
        .object(["id": .string(id), "revision": .number(Double(revision)), "outcome": outcome.json])
    }
}

public struct RudderLastTurn: Equatable, Hashable, Sendable {
    public var termination: RudderTurnTermination?
    public var replyDisposition: String?
    public var finalMessageIds: [String]?
    public enum Phase: String, Hashable, Sendable { case done, failed, interrupted }

    public struct Changes: Equatable, Hashable, Sendable {
        public var files: Int
        public var added: Int
        public var removed: Int
        public init(files: Int, added: Int, removed: Int) {
            self.files = files
            self.added = added
            self.removed = removed
        }
    }

    public var phase: Phase
    /// failed: the failed tool's title (with `toolId`), or the error's first line (without).
    public var reason: String?
    public var exitCode: Int?
    public var toolId: String?
    public var changes: Changes?
    public var endedAt: Double
    /// rudderd's copy for `reason` when it wrote that text itself (the session's `lastResultCopy`), worded on the
    /// phone; nil for an agent's own error text and from older daemons.
    public var reasonCopy: RudderCopy?

    public init(phase: Phase, reason: String? = nil, exitCode: Int? = nil, toolId: String? = nil, changes: Changes? = nil, endedAt: Double = 0,
                reasonCopy: RudderCopy? = nil, termination: RudderTurnTermination? = nil,
                replyDisposition: String? = nil, finalMessageIds: [String]? = nil) {
        self.termination = termination
        self.replyDisposition = replyDisposition
        self.finalMessageIds = finalMessageIds
        self.phase = phase
        self.reason = reason
        self.exitCode = exitCode
        self.toolId = toolId
        self.changes = changes
        self.endedAt = endedAt
        self.reasonCopy = reasonCopy
    }

    public init?(json: RudderJSON) {
        guard let raw = json["phase"]?.string, let phase = Phase(rawValue: raw) else { return nil }
        var changes: Changes?
        if let files = json["changes"]?["files"]?.int, files > 0 {
            changes = Changes(files: files, added: json["changes"]?["added"]?.int ?? 0, removed: json["changes"]?["removed"]?.int ?? 0)
        }
        let endedAt: Double
        if case .number(let value) = json["endedAt"] { endedAt = value } else { endedAt = 0 }
        self.init(
            phase: phase,
            reason: json["reason"]?.string.flatMap { $0.isEmpty ? nil : $0 },
            exitCode: json["exitCode"]?.int,
            toolId: json["toolId"]?.string,
            changes: changes,
            endedAt: endedAt,
            reasonCopy: RudderCopy(json: json["reasonCopy"]),
            termination: json["termination"].flatMap(RudderTurnTermination.init(json:)),
            replyDisposition: json["replyDisposition"]?.string,
            finalMessageIds: json["finalMessageIds"]?.array?.compactMap(\.string)
        )
    }
}

public extension RudderLastTurn {
    var json: RudderJSON {
        var fields: [String: RudderJSON] = ["phase": .string(phase.rawValue), "endedAt": .number(endedAt)]
        if let reason { fields["reason"] = .string(reason) }
        if let exitCode { fields["exitCode"] = .number(Double(exitCode)) }
        if let toolId { fields["toolId"] = .string(toolId) }
        if let changes { fields["changes"] = .object(["files": .number(Double(changes.files)), "added": .number(Double(changes.added)), "removed": .number(Double(changes.removed))]) }
        if let reasonCopy { fields["reasonCopy"] = reasonCopy.json }
        if let termination { fields["termination"] = termination.json }
        if let replyDisposition { fields["replyDisposition"] = .string(replyDisposition) }
        if let finalMessageIds { fields["finalMessageIds"] = .array(finalMessageIds.map(RudderJSON.string)) }
        return .object(fields)
    }
}

public struct RudderTurnState: Equatable, Hashable, Sendable {

    public enum Phase: String, Hashable, Sendable {
        case preparing, running, waiting, done, failed, interrupted
    }

    public var id: String
    public var sessionId: String
    public var userMessageId: String
    public var clientMessageId: String?
    public var sequence: Int
    public var revision: Int
    public var phase: Phase

    public init(id: String, sessionId: String, userMessageId: String, clientMessageId: String? = nil,
                sequence: Int, revision: Int, phase: Phase) {
        self.id = id
        self.sessionId = sessionId
        self.userMessageId = userMessageId
        self.clientMessageId = clientMessageId
        self.sequence = sequence
        self.revision = revision
        self.phase = phase
    }

    public init?(json: RudderJSON) {
        guard let id = json["id"]?.string, let session = json["sessionId"]?.string,
              let message = json["userMessageId"]?.string, let sequence = json["sequence"]?.int, sequence > 0,
              let revision = json["revision"]?.int, revision > 0,
              let raw = json["phase"]?.string, let phase = Phase(rawValue: raw) else { return nil }
        self.init(id: id, sessionId: session, userMessageId: message, clientMessageId: json["clientMessageId"]?.string,
                  sequence: sequence, revision: revision, phase: phase)
    }

    public func follows(_ current: RudderTurnState) -> Bool {
        sessionId == current.sessionId && (sequence > current.sequence || (sequence == current.sequence && id == current.id && revision > current.revision))
    }
}

/// one task the agent left running in the background (Claude Code `run_in_background` / a background
/// subagent, a Grok background command). Times are ms on the computer's clock.
public struct RudderBackgroundTask: Equatable, Hashable, Sendable, Identifiable {
    public enum Kind: String, Hashable, Sendable { case subagent, command }
    public enum Status: String, Hashable, Sendable { case running, done, failed, cancelled }

    public var id: String
    public var kind: Kind
    /// A subagent's task description; a command's first line.
    public var title: String
    /// The row id of the tool card that started it, when the computer knows it (the jump from the sheet).
    public var toolId: String?
    public var startedAt: Double
    public var endedAt: Double?
    public var status: Status
    public var exitCode: Int?

    public init(id: String, kind: Kind, title: String, toolId: String? = nil, startedAt: Double, endedAt: Double? = nil,
                status: Status, exitCode: Int? = nil) {
        self.id = id
        self.kind = kind
        self.title = title
        self.toolId = toolId
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.status = status
        self.exitCode = exitCode
    }

    public init?(json: RudderJSON) {
        guard let id = json["id"]?.string, !id.isEmpty else { return nil }
        let startedAt: Double
        if case .number(let value) = json["startedAt"] { startedAt = value } else { startedAt = 0 }
        var endedAt: Double?
        if case .number(let value) = json["endedAt"] { endedAt = value }
        self.init(
            id: id,
            kind: json["kind"]?.string.flatMap(Kind.init(rawValue:)) ?? .command,
            title: json["title"]?.string ?? "",
            toolId: json["toolId"]?.string.flatMap { $0.isEmpty ? nil : $0 },
            startedAt: startedAt,
            endedAt: endedAt,
            // A status a later daemon adds reads as ended, so the line never spins on it forever.
            status: json["status"]?.string.flatMap(Status.init(rawValue:)) ?? .cancelled,
            exitCode: json["exitCode"]?.int
        )
    }

    public var isRunning: Bool { status == .running }
}

public struct RudderSession: Equatable, Hashable, Sendable, Identifiable {
    public var id: String
    public var title: String
    public var agent: String
    public var status: String
    public var turn: RudderTurnState?
    public var pinned: Bool
    public var archived: Bool
    public var unreadCount: Int
    /// Manual unread dot from `markedUnread`. False when the daemon omits the key.
    public var markedUnread: Bool
    public var cwd: String
    public var model: String
    public var effort: String
    // A permission-mode id of the agent's list: ask | acceptEdits | plan, or one only that agent has (§6).
    public var permissionMode: String
    public var usage: RudderUsage
    public var scheduledCount: Int
    public var updatedAt: Double
    /// Product decision (2026-11-19): rudderd's list order key, moved at turn start, when the owner is needed and at turn
    /// end. nil from older daemons; the runtime then derives it (`SessionOrder.stamped`).
    public var activeAt: Double?
    // permission | question while the session waits on the user; nil otherwise (and from older daemons).
    public var pending: String?
    /// nil before the first message, and from daemons that predate it.
    public var preview: RudderSessionPreview?
    public var contextWindow: Int?
    /// Speed id from the model's `speeds`. Empty leaves the agent's default. Omitted by older daemons.
    public var speed: String
    public var compactionCount: Int
    /// The running turn's current tool or thought (v48 H1); nil when idle or from older daemons.
    public var step: RudderSessionStep?
    /// How the latest turn ended (r47); nil while a turn runs, before the first one, and from older daemons.
    public var lastTurn: RudderLastTurn?
    /// v56: "terminal" for a session brought over from a terminal Claude; "rudder" otherwise (and from older daemons).
    public var origin: String
    /// v56: who may write the session now; nil from daemons without session handoff.
    public var holder: RudderSessionHolder?
    /// v56: rows of the terminal transcript still on the computer (「更早的 N 条留在电脑上」).
    public var importedEarlier: Int
    /// false for a session brought over from a folder Rudder cannot write to (only to view). True from older daemons.
    public var writable: Bool
    /// Background tasks still open after the agent paused its speech. 0 when the daemon omits it (older builds, or none open).
    public var backgroundOpen: Int
    /// this turn's background tasks, running and ended; the last list stays until the next turn starts.
    /// Empty from older daemons and when the turn left nothing in the background.
    public var backgroundTasks: [RudderBackgroundTask]
    /// r73 A: daemon milliseconds when the computer continues this session after its usage limit resets; nil when
    /// nothing waits (and from older daemons).
    public var autoResumeAt: Double?

    public init(
        id: String,
        title: String,
        agent: String,
        status: String,
        pinned: Bool,
        archived: Bool = false,
        unreadCount: Int = 0,
        markedUnread: Bool = false,
        cwd: String = "",
        model: String = "",
        effort: String = "",
        permissionMode: String = "ask",
        usage: RudderUsage = RudderUsage(),
        scheduledCount: Int = 0,
        updatedAt: Double,
        pending: String? = nil,
        preview: RudderSessionPreview? = nil,
        contextWindow: Int? = nil,
        speed: String = "",
        compactionCount: Int = 0,
        step: RudderSessionStep? = nil,
        turn: RudderTurnState? = nil,
        lastTurn: RudderLastTurn? = nil,
        origin: String = "rudder",
        holder: RudderSessionHolder? = nil,
        importedEarlier: Int = 0,
        writable: Bool = true,
        backgroundOpen: Int = 0,
        backgroundTasks: [RudderBackgroundTask] = [],
        autoResumeAt: Double? = nil,
        activeAt: Double? = nil
    ) {
        self.id = id
        self.title = title
        self.agent = agent
        self.status = status
        self.pinned = pinned
        self.archived = archived
        self.unreadCount = unreadCount
        self.markedUnread = markedUnread
        self.cwd = cwd
        self.model = model
        self.effort = effort
        self.permissionMode = permissionMode
        self.usage = usage
        self.scheduledCount = scheduledCount
        self.updatedAt = updatedAt
        self.pending = pending
        self.preview = preview
        self.contextWindow = contextWindow
        self.speed = speed
        self.compactionCount = compactionCount
        self.step = step
        self.turn = turn
        self.lastTurn = lastTurn
        self.origin = origin
        self.holder = holder
        self.importedEarlier = importedEarlier
        self.writable = writable
        self.backgroundOpen = backgroundOpen
        self.backgroundTasks = backgroundTasks
        self.autoResumeAt = autoResumeAt
        self.activeAt = activeAt
    }

    /// The home list's order key: `activeAt`, or `updatedAt` when neither rudderd nor the runtime set one.
    public var orderAt: Double { activeAt ?? updatedAt }

    /// rudderd's copy for the last turn's result line (`lastResultCopy`); nil from older daemons.
    public var lastResultCopy: RudderCopy? { lastTurn?.reasonCopy }

    /// A terminal holds the session: the phone may only watch.
    public var heldByTerminal: Bool { holder?.kind == .terminal }
    /// the phone may never write it, whoever holds it.
    public var viewOnly: Bool { !writable }
    /// The phone can only watch: a terminal holds it (v56) or its folder is view-only.
    public var phoneReadOnly: Bool { heldByTerminal || viewOnly }

    #if DEBUG
    /// Threads from `init(json:)` while a test has armed capture. Other decodes stay out, so a parallel suite can share the process.
    private final class DecodeThreadLog: @unchecked Sendable {
        private let lock = NSLock()
        private var armed = false
        private var threads: [Thread] = []

        func arm() {
            lock.lock()
            threads = []
            armed = true
            lock.unlock()
        }

        func disarm() {
            lock.lock()
            armed = false
            lock.unlock()
        }

        func isArmed() -> Bool {
            lock.lock()
            defer { lock.unlock() }
            return armed
        }

        func record(_ thread: Thread) {
            lock.lock()
            defer { lock.unlock() }
            guard armed else { return }
            threads.append(thread)
        }

        func snapshot() -> [Thread] {
            lock.lock()
            defer { lock.unlock() }
            return threads
        }
    }

    private static let decodeThreadLog = DecodeThreadLog()
    @TaskLocal private static var captureEnabled = false

    public static var decodeThreads: [Thread] { decodeThreadLog.snapshot() }

    public static func armDecodeThreads() { decodeThreadLog.arm() }

    public static func disarmDecodeThreads() { decodeThreadLog.disarm() }

    /// Runs `body` on this task. Records only when `armDecodeThreads` is set, so a parallel upsert does not join the log.
    public static func capturingDecodeThreads<T>(_ body: () -> T) -> T {
        $captureEnabled.withValue(decodeThreadLog.isArmed(), operation: body)
    }
    #endif

    public init?(json: RudderJSON) {
        #if DEBUG
        if Self.captureEnabled {
            Self.decodeThreadLog.record(Thread.current)
        }
        #endif
        guard let id = json["id"]?.string,
              let stored = json["title"]?.string,
              let agent = json["agent"]?.string,
              let status = json["status"]?.string
        else { return nil }
        // rudderd's own placeholder title (the sample session) comes with copy, worded in the app's language.
        let title = RudderCopy(json: json["titleCopy"]).map(\.worded) ?? stored
        let pinned = json["pinned"]?.bool ?? false
        let archived = json["archived"]?.bool ?? false
        let unreadCount = json["unreadCount"]?.int ?? 0
        let updatedAt: Double
        if case .number(let value) = json["updatedAt"] { updatedAt = value } else { updatedAt = 0 }
        self.init(
            id: id,
            title: title,
            agent: agent,
            status: status,
            pinned: pinned,
            archived: archived,
            unreadCount: unreadCount,
            markedUnread: json["markedUnread"]?.bool ?? false,
            cwd: json["cwd"]?.string ?? "",
            model: json["model"]?.string ?? "",
            effort: json["effort"]?.string ?? "",
            permissionMode: json["permissionMode"]?.string ?? "ask",
            usage: RudderUsage(json: json["usage"]),
            scheduledCount: json["scheduledCount"]?.int ?? 0,
            updatedAt: updatedAt,
            pending: json["pending"]?.string,
            preview: json["preview"].flatMap(RudderSessionPreview.init(json:)),
            contextWindow: json["contextWindow"]?.int,
            speed: json["speed"]?.string ?? "",
            compactionCount: json["compactionCount"]?.int ?? 0,
            step: json["step"].flatMap(RudderSessionStep.init(json:)),
            turn: json["turn"].flatMap(RudderTurnState.init(json:)),
            lastTurn: json["lastTurn"].flatMap(RudderLastTurn.init(json:)).map { turn in
                var turn = turn
                turn.reasonCopy = RudderCopy(json: json["lastResultCopy"])
                return turn
            },
            origin: json["origin"]?.string ?? "rudder",
            holder: json["holder"].flatMap(RudderSessionHolder.init(json:)),
            importedEarlier: json["importedEarlier"]?.int ?? 0,
            writable: json["writable"]?.bool ?? true,
            backgroundOpen: json["backgroundOpen"]?.int ?? 0,
            backgroundTasks: json["backgroundTasks"]?.array?.compactMap(RudderBackgroundTask.init(json:)) ?? [],
            autoResumeAt: json["autoResumeAt"]?.number,
            activeAt: json["activeAt"]?.number
        )
    }
}
