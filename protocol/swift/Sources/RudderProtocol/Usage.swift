import Foundation

// `usage.summary` (the implementation notes): per-turn token and cost usage of one daemon, grouped
// by local day, agent and agent + model. The phone fetches one summary per paired computer and merges them.

/// Token counts and cost of one group. `costUsd` is nil when no row in the group reported a cost (shown as "—"),
/// which is different from a reported `0`; `costPartial` means some rows reported a cost and some did not.
public struct UsageTotals: Codable, Equatable, Hashable, Sendable {
    public var inputTokens: Int
    public var outputTokens: Int
    public var cacheReadTokens: Int
    public var cacheWriteTokens: Int
    /// Part of `outputTokens`, never added on top.
    public var reasoningTokens: Int
    public var costUsd: Double?
    public var costPartial: Bool
    /// Recorded turns (backfilled rows excluded).
    public var turns: Int
    /// Distinct sessions.
    public var sessions: Int

    public init(
        inputTokens: Int = 0,
        outputTokens: Int = 0,
        cacheReadTokens: Int = 0,
        cacheWriteTokens: Int = 0,
        reasoningTokens: Int = 0,
        costUsd: Double? = nil,
        costPartial: Bool = false,
        turns: Int = 0,
        sessions: Int = 0
    ) {
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.cacheReadTokens = cacheReadTokens
        self.cacheWriteTokens = cacheWriteTokens
        self.reasoningTokens = reasoningTokens
        self.costUsd = costUsd
        self.costPartial = costPartial
        self.turns = turns
        self.sessions = sessions
    }

    public static let zero = UsageTotals()

    /// Reads the `Totals` fields of `json` (a group row carries them next to its own keys). Token counts must be
    /// numbers; `costUsd` may be a number or null.
    public init?(json: RudderJSON) {
        guard let input = json["inputTokens"]?.int,
              let output = json["outputTokens"]?.int,
              let cacheRead = json["cacheReadTokens"]?.int,
              let cacheWrite = json["cacheWriteTokens"]?.int
        else { return nil }
        self.init(
            inputTokens: input,
            outputTokens: output,
            cacheReadTokens: cacheRead,
            cacheWriteTokens: cacheWrite,
            reasoningTokens: json["reasoningTokens"]?.int ?? 0,
            costUsd: json["costUsd"]?.number,
            costPartial: json["costPartial"]?.bool ?? false,
            turns: json["turns"]?.int ?? 0,
            sessions: json["sessions"]?.int ?? 0
        )
    }

    /// Input + output + cache read + cache write (reasoning is inside output).
    public var tokens: Int { inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens }

    /// Cache read ÷ (input + cache read); nil when both are 0.
    public var hitRate: Double? {
        let base = inputTokens + cacheReadTokens
        return base > 0 ? Double(cacheReadTokens) / Double(base) : nil
    }

    /// Nothing recorded: the identity of `merged(with:)`, so an idle computer does not mark a total partial.
    public var isEmpty: Bool { tokens == 0 && reasoningTokens == 0 && turns == 0 && sessions == 0 && costUsd == nil }

    /// Two disjoint groups added up. Cost sums the reported parts; it stays nil only when neither reported one,
    /// and becomes partial when either was partial or only one of them reported.
    public func merged(with other: UsageTotals) -> UsageTotals {
        if other.isEmpty { return self }
        if isEmpty { return other }
        let cost: Double? = switch (costUsd, other.costUsd) {
        case (nil, nil): nil
        case let (a?, nil): a
        case let (nil, b?): b
        case let (a?, b?): a + b
        }
        return UsageTotals(
            inputTokens: inputTokens + other.inputTokens,
            outputTokens: outputTokens + other.outputTokens,
            cacheReadTokens: cacheReadTokens + other.cacheReadTokens,
            cacheWriteTokens: cacheWriteTokens + other.cacheWriteTokens,
            reasoningTokens: reasoningTokens + other.reasoningTokens,
            costUsd: cost,
            costPartial: costPartial || other.costPartial || (costUsd == nil) != (other.costUsd == nil),
            turns: turns + other.turns,
            sessions: sessions + other.sessions
        )
    }

    public static func sum<S: Sequence>(_ groups: S) -> UsageTotals where S.Element == UsageTotals {
        groups.reduce(.zero) { $0.merged(with: $1) }
    }
}

/// `byDay[]`: one local day ("YYYY-MM-DD" in the `tz` the request named).
public struct UsageDay: Codable, Equatable, Hashable, Sendable {
    public var day: String
    public var totals: UsageTotals

    public init(day: String, totals: UsageTotals) {
        self.day = day
        self.totals = totals
    }

    public init?(json: RudderJSON) {
        guard let day = json["day"]?.string, let totals = UsageTotals(json: json) else { return nil }
        self.init(day: day, totals: totals)
    }
}

/// `byAgent[]`: `label` comes from the daemon's adapter registry (the id for an agent it no longer knows).
public struct UsageAgentRow: Codable, Equatable, Hashable, Sendable {
    public var agent: String
    public var label: String
    public var totals: UsageTotals

    public init(agent: String, label: String, totals: UsageTotals) {
        self.agent = agent
        self.label = label
        self.totals = totals
    }

    public init?(json: RudderJSON) {
        guard let agent = json["agent"]?.string, let totals = UsageTotals(json: json) else { return nil }
        self.init(agent: agent, label: json["label"]?.string ?? agent, totals: totals)
    }
}

/// `byModel[]`: `model` is what the adapter was given; `""` means the agent's own default.
public struct UsageModelRow: Codable, Equatable, Hashable, Sendable {
    public var agent: String
    public var model: String
    public var totals: UsageTotals

    public init(agent: String, model: String, totals: UsageTotals) {
        self.agent = agent
        self.model = model
        self.totals = totals
    }

    public init?(json: RudderJSON) {
        guard let agent = json["agent"]?.string, let totals = UsageTotals(json: json) else { return nil }
        self.init(agent: agent, model: json["model"]?.string ?? "", totals: totals)
    }
}

/// v53: one window of a subscription limit (`limits[].windows[]`). `limit` names a separately metered bucket (Codex
/// limitName; nil for the main one); `kind` is Claude's rateLimitType; `status` is Claude's own verdict (Codex sends
/// only `usedPercent`).
public struct QuotaWindow: Codable, Equatable, Hashable, Sendable {
    public enum Status: String, Codable, Sendable {
        case allowed
        case warning = "allowed_warning"
        case rejected
    }

    public var limit: String?
    public var kind: String?
    public var minutes: Int?
    /// 0–100.
    public var usedPercent: Int?
    /// Milliseconds since 1970.
    public var resetsAt: Double?
    public var status: Status?

    public init(limit: String? = nil, kind: String? = nil, minutes: Int? = nil, usedPercent: Int? = nil,
                resetsAt: Double? = nil, status: Status? = nil) {
        self.limit = limit
        self.kind = kind
        self.minutes = minutes
        self.usedPercent = usedPercent
        self.resetsAt = resetsAt
        self.status = status
    }

    public init(json: RudderJSON) {
        self.init(
            limit: json["limit"]?.string,
            kind: json["kind"]?.string,
            minutes: json["minutes"]?.int,
            usedPercent: json["usedPercent"]?.int,
            resetsAt: json["resetsAt"]?.number,
            status: json["status"]?.string.flatMap(Status.init(rawValue:))
        )
    }

    public var resetDate: Date? { resetsAt.map { Date(timeIntervalSince1970: $0 / 1000) } }
}

/// v53: what one subscription agent last said about its limits (`usage.summary` / `usage.limits` `limits[]`).
/// Empty `windows`: the agent can report limits but has not yet (Claude before its first turn on this computer).
public struct AgentQuota: Codable, Equatable, Hashable, Sendable, Identifiable {
    public var agent: String
    public var label: String
    /// Codex planType (plus, pro, team …); Claude reports none.
    public var plan: String?
    /// Codex credits balance as sent.
    public var credits: String?
    public var windows: [QuotaWindow]
    /// Milliseconds since 1970.
    public var updatedAt: Double?

    public var id: String { agent }

    public init(agent: String, label: String, plan: String? = nil, credits: String? = nil, windows: [QuotaWindow],
                updatedAt: Double? = nil) {
        self.agent = agent
        self.label = label
        self.plan = plan
        self.credits = credits
        self.windows = windows
        self.updatedAt = updatedAt
    }

    public init?(json: RudderJSON) {
        guard let agent = json["agent"]?.string else { return nil }
        self.init(
            agent: agent,
            label: json["label"]?.string ?? agent,
            plan: json["plan"]?.string,
            credits: json["credits"]?.string,
            windows: json["windows"]?.array?.map(QuotaWindow.init(json:)) ?? [],
            updatedAt: json["updatedAt"]?.number
        )
    }

    public static func list(_ json: RudderJSON?) -> [AgentQuota]? {
        json?.array?.compactMap(AgentQuota.init(json:))
    }
}

/// One `usage.summary` reply, or several merged.
public struct UsageSummary: Codable, Equatable, Hashable, Sendable {
    public var machineName: String?
    /// Milliseconds since 1970, as the daemon stamped it.
    public var generatedAt: Double?
    public var from: Double?
    public var to: Double?
    public var totals: UsageTotals
    /// Ascending local days, only the days with data.
    public var byDay: [UsageDay]
    public var byAgent: [UsageAgentRow]
    public var byModel: [UsageModelRow]
    /// v53 subscription limits; nil from a daemon that predates them (and in caches written before).
    public var limits: [AgentQuota]?

    public init(
        machineName: String? = nil,
        generatedAt: Double? = nil,
        from: Double? = nil,
        to: Double? = nil,
        totals: UsageTotals = .zero,
        byDay: [UsageDay] = [],
        byAgent: [UsageAgentRow] = [],
        byModel: [UsageModelRow] = [],
        limits: [AgentQuota]? = nil
    ) {
        self.machineName = machineName
        self.generatedAt = generatedAt
        self.from = from
        self.to = to
        self.totals = totals
        self.byDay = byDay
        self.byAgent = byAgent
        self.byModel = byModel
        self.limits = limits
    }

    /// Rows that do not parse are dropped; a reply without `totals` is not a summary.
    public init?(json: RudderJSON) {
        guard let totals = json["totals"].flatMap(UsageTotals.init(json:)) else { return nil }
        self.init(
            machineName: json["machine"]?["name"]?.string,
            generatedAt: json["generatedAt"]?.number,
            from: json["range"]?["from"]?.number,
            to: json["range"]?["to"]?.number,
            totals: totals,
            byDay: json["byDay"]?.array?.compactMap(UsageDay.init(json:)) ?? [],
            byAgent: json["byAgent"]?.array?.compactMap(UsageAgentRow.init(json:)) ?? [],
            byModel: json["byModel"]?.array?.compactMap(UsageModelRow.init(json:)) ?? [],
            limits: AgentQuota.list(json["limits"])
        )
    }

    /// Several computers' summaries of the same range as one: totals added, days merged by date, agents by id,
    /// models by agent + model; groups sorted by tokens (descending) as the daemon sorts them.
    public static func merge(_ summaries: [UsageSummary]) -> UsageSummary {
        if summaries.count == 1 { return summaries[0] }
        var days: [String: UsageTotals] = [:]
        var agents: [String: UsageAgentRow] = [:]
        var models: [String: UsageModelRow] = [:]
        for summary in summaries {
            for day in summary.byDay { days[day.day, default: .zero] = days[day.day, default: .zero].merged(with: day.totals) }
            for row in summary.byAgent {
                if var existing = agents[row.agent] {
                    existing.totals = existing.totals.merged(with: row.totals)
                    agents[row.agent] = existing
                } else {
                    agents[row.agent] = row
                }
            }
            for row in summary.byModel {
                let key = row.agent + "\u{1F}" + row.model
                if var existing = models[key] {
                    existing.totals = existing.totals.merged(with: row.totals)
                    models[key] = existing
                } else {
                    models[key] = row
                }
            }
        }
        return UsageSummary(
            machineName: nil,
            generatedAt: summaries.compactMap(\.generatedAt).max(),
            from: summaries.first?.from,
            to: summaries.first?.to,
            totals: .sum(summaries.map(\.totals)),
            byDay: days.map { UsageDay(day: $0.key, totals: $0.value) }.sorted { $0.day < $1.day },
            byAgent: agents.values.sorted { ($0.totals.tokens, $1.agent) > ($1.totals.tokens, $0.agent) },
            byModel: models.values.sorted { ($0.totals.tokens, $1.agent + $1.model) > ($1.totals.tokens, $0.agent + $0.model) }
        )
    }
}

/// Local calendar days as `byDay` spells them.
public enum UsageCalendar {
    /// "YYYY-MM-DD" of `date` in `calendar`'s time zone. The key is the daemon's Gregorian date whatever the phone's
    /// calendar (a Buddhist or Japanese year never matches it).
    public static func dayKey(_ date: Date, calendar: Calendar) -> String {
        let parts = gregorian(calendar).dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    /// The local midnight starting `key`, or nil when it is not a date.
    public static func date(_ key: String, calendar: Calendar) -> Date? {
        let parts = key.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        return gregorian(calendar).date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
    }

    /// A Gregorian calendar in `calendar`'s time zone and week rules.
    static func gregorian(_ calendar: Calendar) -> Calendar {
        guard calendar.identifier != .gregorian else { return calendar }
        var out = Calendar(identifier: .gregorian)
        out.timeZone = calendar.timeZone
        out.firstWeekday = calendar.firstWeekday
        out.minimumDaysInFirstWeek = calendar.minimumDaysInFirstWeek
        out.locale = calendar.locale
        return out
    }

    /// Daily rows added up by week. Each week starts on the calendar's first weekday and is keyed by that day;
    /// ascending, only weeks with data.
    public static func weekly(_ days: [UsageDay], calendar: Calendar) -> [UsageDay] {
        var weeks: [String: UsageTotals] = [:]
        for day in days {
            guard let date = date(day.day, calendar: calendar),
                  let start = calendar.dateInterval(of: .weekOfYear, for: date)?.start
            else { continue }
            let key = dayKey(start, calendar: calendar)
            weeks[key, default: .zero] = weeks[key, default: .zero].merged(with: day.totals)
        }
        return weeks.map { UsageDay(day: $0.key, totals: $0.value) }.sorted { $0.day < $1.day }
    }
}
