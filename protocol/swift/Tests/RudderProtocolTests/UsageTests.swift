import Foundation
import Testing
@testable import RudderProtocol

private func totals(_ input: Int, _ output: Int, cacheRead: Int = 0, cacheWrite: Int = 0, cost: Double?,
                    partial: Bool = false, turns: Int = 1, sessions: Int = 1) -> UsageTotals {
    UsageTotals(inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite,
                costUsd: cost, costPartial: partial, turns: turns, sessions: sessions)
}

struct UsageTests {
    @Test func parsesSummaryKeepingNullCostApartFromZero() throws {
        let data = Data("""
        {"machine":{"name":"mac-studio"},"generatedAt":1792600000000,"range":{"from":1792540800000,"to":null},
         "totals":{"inputTokens":100,"outputTokens":50,"cacheReadTokens":800,"cacheWriteTokens":50,"reasoningTokens":10,
                   "costUsd":0.5,"costPartial":true,"turns":4,"sessions":2},
         "byDay":[{"day":"2026-10-21","inputTokens":100,"outputTokens":50,"cacheReadTokens":800,"cacheWriteTokens":50,
                   "reasoningTokens":10,"costUsd":0.5,"costPartial":true,"turns":4,"sessions":2}],
         "byAgent":[{"agent":"claude","label":"Claude Code","inputTokens":60,"outputTokens":30,"cacheReadTokens":800,
                     "cacheWriteTokens":50,"reasoningTokens":0,"costUsd":0,"costPartial":false,"turns":2,"sessions":1},
                    {"agent":"codex","label":"Codex","inputTokens":40,"outputTokens":20,"cacheReadTokens":0,
                     "cacheWriteTokens":0,"reasoningTokens":10,"costUsd":null,"costPartial":false,"turns":2,"sessions":1}],
         "byModel":[{"agent":"codex","model":"","inputTokens":40,"outputTokens":20,"cacheReadTokens":0,
                     "cacheWriteTokens":0,"reasoningTokens":10,"costUsd":null,"costPartial":false,"turns":2,"sessions":1}]}
        """.utf8)
        let json = try JSONDecoder().decode(RudderJSON.self, from: data)
        let summary = try #require(UsageSummary(json: json))
        #expect(summary.machineName == "mac-studio")
        #expect(summary.from == 1_792_540_800_000)
        #expect(summary.to == nil)
        #expect(summary.totals.tokens == 1000)
        #expect(summary.totals.costPartial)
        #expect(summary.byDay.map(\.day) == ["2026-10-21"])
        #expect(summary.byAgent[0].totals.costUsd == 0)
        #expect(summary.byAgent[1].totals.costUsd == nil)
        #expect(summary.byModel[0].model == "")
        #expect(summary.totals.hitRate == 800.0 / 900.0)

        // The disk cache round-trips null and 0 apart.
        let decoded = try JSONDecoder().decode(UsageSummary.self, from: JSONEncoder().encode(summary))
        #expect(decoded == summary)
        #expect(decoded.byAgent[0].totals.costUsd == 0)
        #expect(decoded.byAgent[1].totals.costUsd == nil)
    }

    @Test func rejectsReplyWithoutTotals() {
        #expect(UsageSummary(json: .object(["byDay": .array([])])) == nil)
        #expect(UsageTotals(json: .object(["inputTokens": .string("1")])) == nil)
    }

    @Test func costMergeSumsReportedPartsAndMarksMixedPartial() {
        let paid = totals(10, 5, cost: 1.25)
        let free = totals(20, 5, cost: nil)
        let zero = totals(1, 1, cost: 0)

        let mixed = paid.merged(with: free)
        #expect(mixed.costUsd == 1.25)
        #expect(mixed.costPartial)
        #expect(mixed.tokens == 40)
        #expect(mixed.turns == 2)

        let none = free.merged(with: free)
        #expect(none.costUsd == nil)
        #expect(!none.costPartial)

        let reportedZero = paid.merged(with: zero)
        #expect(reportedZero.costUsd == 1.25)
        #expect(!reportedZero.costPartial)

        #expect(paid.merged(with: totals(1, 1, cost: 2, partial: true)).costPartial)
    }

    @Test func emptyTotalsDoNotMakeCostPartial() {
        let paid = totals(10, 5, cost: 1)
        #expect(paid.merged(with: .zero) == paid)
        #expect(UsageTotals.zero.merged(with: paid) == paid)
        #expect(UsageTotals.sum([]) == .zero)
        #expect(UsageTotals.zero.hitRate == nil)
    }

    @Test func mergeAddsComputersByDayAgentAndModel() {
        let a = UsageSummary(
            machineName: "mac-studio",
            totals: totals(10, 10, cacheRead: 80, cost: 2),
            byDay: [UsageDay(day: "2026-10-20", totals: totals(4, 4, cost: 1)), UsageDay(day: "2026-10-22", totals: totals(6, 6, cost: 1))],
            byAgent: [UsageAgentRow(agent: "claude", label: "Claude Code", totals: totals(10, 10, cacheRead: 80, cost: 2))],
            byModel: [UsageModelRow(agent: "claude", model: "sonnet", totals: totals(10, 10, cacheRead: 80, cost: 2))]
        )
        let b = UsageSummary(
            machineName: "devbox",
            totals: totals(300, 100, cost: nil),
            byDay: [UsageDay(day: "2026-10-21", totals: totals(100, 50, cost: nil)), UsageDay(day: "2026-10-22", totals: totals(200, 50, cost: nil))],
            byAgent: [
                UsageAgentRow(agent: "codex", label: "Codex", totals: totals(290, 90, cost: nil)),
                UsageAgentRow(agent: "claude", label: "Claude Code", totals: totals(10, 10, cost: 0.5)),
            ],
            byModel: [UsageModelRow(agent: "claude", model: "sonnet", totals: totals(10, 10, cost: 0.5))]
        )
        let merged = UsageSummary.merge([a, b])
        #expect(merged.machineName == nil)
        #expect(merged.totals.tokens == 500)
        #expect(merged.totals.costUsd == 2)
        #expect(merged.totals.costPartial)
        #expect(merged.byDay.map(\.day) == ["2026-10-20", "2026-10-21", "2026-10-22"])
        #expect(merged.byDay[2].totals.tokens == 262)
        #expect(merged.byDay[2].totals.costUsd == 1)
        #expect(merged.byDay[2].totals.costPartial)
        #expect(merged.byAgent.map(\.agent) == ["codex", "claude"])
        #expect(merged.byAgent[1].totals.tokens == 120)
        #expect(merged.byAgent[1].totals.costUsd == 2.5)
        #expect(merged.byModel.count == 1)
        #expect(merged.byModel[0].totals.costUsd == 2.5)
        #expect(UsageSummary.merge([a]) == a)
    }

    @Test func weeklyBucketsStartOnTheCalendarsFirstWeekday() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Shanghai")!
        calendar.firstWeekday = 2 // Monday
        let days = [
            UsageDay(day: "2026-10-18", totals: totals(1, 0, cost: nil)), // Sunday: week of 10-12
            UsageDay(day: "2026-10-19", totals: totals(2, 0, cost: 1)),   // Monday
            UsageDay(day: "2026-10-22", totals: totals(4, 0, cost: 2)),   // Thursday
        ]
        let weeks = UsageCalendar.weekly(days, calendar: calendar)
        #expect(weeks.map(\.day) == ["2026-10-12", "2026-10-19"])
        #expect(weeks[1].totals.inputTokens == 6)
        #expect(weeks[1].totals.costUsd == 3)
        #expect(UsageCalendar.dayKey(UsageCalendar.date("2026-01-05", calendar: calendar)!, calendar: calendar) == "2026-01-05")
    }

    /// Third review #21: a phone on the Buddhist or Japanese calendar keys its days like the daemon (Gregorian).
    @Test func dayKeysAreGregorianWhateverThePhonesCalendar() {
        for identifier in [Calendar.Identifier.buddhist, .japanese] {
            var calendar = Calendar(identifier: identifier)
            calendar.timeZone = TimeZone(identifier: "Asia/Tokyo")!
            let date = UsageCalendar.date("2026-11-11", calendar: calendar)
            #expect(date != nil)
            #expect(date.map { UsageCalendar.dayKey($0, calendar: calendar) } == "2026-11-11")
            #expect(UsageCalendar.dayKey(Date(timeIntervalSince1970: 1_762_819_200), calendar: calendar) == "2025-11-11")
        }
    }

    @Test func parsesLimitsAndReadsCachesWrittenBeforeThem() throws {
        let data = Data("""
        {"totals":{"inputTokens":0,"outputTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0},
         "limits":[{"agent":"codex","label":"Codex","plan":"pro","credits":"12.40","updatedAt":1793390000000,
                    "windows":[{"minutes":300,"usedPercent":34,"resetsAt":1793400000000},
                               {"limit":"GPT-6.1-Codex-Spark","minutes":10080,"usedPercent":22}]},
                   {"agent":"claude","label":"Claude Code","windows":[{"kind":"five_hour","status":"rejected","resetsAt":1793400000000},
                                                                     {"kind":"seven_day","status":"bogus"}]},
                   {"label":"no agent id"}]}
        """.utf8)
        let summary = try #require(UsageSummary(json: try JSONDecoder().decode(RudderJSON.self, from: data)))
        let limits = try #require(summary.limits)
        #expect(limits.map(\.agent) == ["codex", "claude"])
        #expect(limits[0].plan == "pro")
        #expect(limits[0].credits == "12.40")
        #expect(limits[0].windows[0] == QuotaWindow(minutes: 300, usedPercent: 34, resetsAt: 1_793_400_000_000))
        #expect(limits[0].windows[1].limit == "GPT-6.1-Codex-Spark")
        #expect(limits[1].windows[0].status == .rejected)
        #expect(limits[1].windows[0].resetDate == Date(timeIntervalSince1970: 1_793_400_000))
        #expect(limits[1].windows[1].status == nil)

        let roundTrip = try JSONDecoder().decode(UsageSummary.self, from: JSONEncoder().encode(summary))
        #expect(roundTrip == summary)
        // A cache from before v53 has no `limits` key.
        let old = try JSONDecoder().decode(UsageSummary.self, from: Data(#"{"totals":{"inputTokens":0,"outputTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0,"reasoningTokens":0,"costPartial":false,"turns":0,"sessions":0},"byDay":[],"byAgent":[],"byModel":[]}"#.utf8))
        #expect(old.limits == nil)
    }
}
