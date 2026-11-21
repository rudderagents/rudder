import Testing
@testable import RudderProtocol

/// The Copilot 1.0.105 list as rudderd sends it (daemon fixture `copilot-models.json`), in Copilot's order.
private let copilot: [RudderJSON] = {
    let rows: [(String, String, Double?, String?)] = [
        ("auto", "Auto", nil, nil),
        ("claude-sonnet-5.5", "Claude Sonnet 5.5", 1, "medium"), ("claude-sonnet-5", "Claude Sonnet 5", 1, "medium"),
        ("claude-fable-5.1", "Claude Fable 5.1", 1, "medium"), ("claude-fable-5", "Claude Fable 5", 1, "medium"),
        ("claude-opus-5.5", "Claude Opus 5.5", 15, "high"), ("claude-opus-5", "Claude Opus 5", 15, "high"),
        ("claude-opus-4.8", "Claude Opus 4.8", 14, "high"), ("claude-opus-4.8-fast", "Claude Opus 4.8 fast", 30, "very_high"),
        ("claude-haiku-5.5", "Claude Haiku 5.5", 0.33, "low"), ("claude-haiku-4.5", "Claude Haiku 4.5", 0.33, "low"),
        ("gpt-6.1-sol", "GPT-6.1 Sol", 1, "medium"), ("gpt-6.1-terra", "GPT-6.1 Terra", 1, "medium"),
        ("gpt-6-sol", "GPT-6 Sol", 1, "medium"), ("gpt-6-luna", "GPT-6 Luna", 0.33, "low"), ("gpt-6-astra", "GPT-6 Astra", 14, "high"),
        ("gpt-5.6-sol", "GPT-5.6 Sol", 1, "medium"), ("gpt-5.6-terra", "GPT-5.6 Terra", 1, "medium"),
        ("gpt-5.6-luna", "GPT-5.6 Luna", 0.33, "low"), ("gpt-5.3-codex", "GPT-5.3-Codex", 1, "medium"),
        ("gemini-4-argon", "Gemini 4 Argon", 1, "medium"), ("gemini-3.8-flash", "Gemini 3.8 Flash", 14, "low"),
        ("grok-4.7", "Grok 4.7", 1, "medium"), ("grok-4.6", "Grok 4.6", 1, "medium"),
        ("kimi-k3", "Kimi K3", 1, "medium"), ("mai-code-1.1-flash", "MAI-Code-1.1-Flash", 0.33, "low"),
    ]
    let vendors = ["claude": "Anthropic", "gpt": "OpenAI", "gemini": "Google", "grok": "xAI", "kimi": "Moonshot", "mai": "Microsoft"]
    return rows.map { id, label, multiplier, tier in
        var object: [String: RudderJSON] = ["id": .string(id), "label": .string(label), "efforts": .array([.string("low"), .string("max")])]
        if let multiplier { object["multiplier"] = .number(multiplier) }
        if let tier { object["priceTier"] = .string(tier) }
        if id != "auto" {
            var tokens = id.split(separator: "-").map(String.init)
            object["vendor"] = .string(vendors[tokens[0]]!)
            if let at = tokens.indices.dropFirst().first(where: { tokens[$0].first!.isNumber }) {
                object["version"] = .string(tokens.remove(at: at))
            }
            if tokens.count > 1, tokens.last == "fast" { tokens.removeLast() }
            object["family"] = .string(tokens.joined(separator: "-"))
        }
        return .object(object)
    }
}()

@Test func modelDecodesCopilotFieldsAndOldListsStayBare() throws {
    let models = copilot.compactMap(RudderModel.init(json:))
    let opusFast = try #require(models.first { $0.id == "claude-opus-4.8-fast" })
    #expect(opusFast.multiplier == 30)
    #expect(opusFast.priceTier == "very_high")
    #expect(opusFast.vendor == "Anthropic")
    #expect(opusFast.family == "claude-opus")
    #expect(opusFast.version == "4.8")
    let plain = try #require(RudderModel(json: .object(["id": .string("sonnet"), "label": .string("Sonnet")])))
    #expect(plain.multiplier == nil && plain.vendor == nil)
    #expect(!RudderModelVendors.applies(to: [plain]))
}

@Test func copilotListGroupsByVendorWithAutoOnTopAndFifteenRows() {
    let models = copilot.compactMap(RudderModel.init(json:))
    #expect(RudderModelVendors.applies(to: models))
    let layout = RudderModelVendors.layout(models)
    #expect(layout.automatic.map(\.id) == ["auto"])
    #expect(layout.groups.map(\.vendor) == ["Anthropic", "OpenAI", "Google", "xAI", "Moonshot", "Microsoft"])
    #expect(layout.groups.map(\.total) == [10, 9, 2, 2, 1, 1])
    let anthropic = layout.groups[0]
    #expect(anthropic.recent.map(\.id) == ["claude-sonnet-5.5", "claude-opus-5.5", "claude-haiku-5.5", "claude-fable-5.1"])
    #expect(anthropic.earlier.map(\.id) == ["claude-sonnet-5", "claude-fable-5", "claude-opus-5", "claude-opus-4.8",
                                             "claude-opus-4.8-fast", "claude-haiku-4.5"])
    #expect(layout.groups[1].recent.map(\.id) == ["gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna", "gpt-6-astra", "gpt-5.3-codex"])
    // The design's default: Auto + 4 + 5 + 2 + 1 + 1 + 1 = 15 rows.
    #expect(layout.automatic.count + layout.groups.map(\.recent.count).reduce(0, +) == 15)
}

@Test func multiplierTextMatchesCopilot() {
    #expect(RudderModelVendors.multiplierText(0.33) == "0.33x")
    #expect(RudderModelVendors.multiplierText(1) == "1x")
    #expect(RudderModelVendors.multiplierText(14) == "14x")
    #expect(RudderModelVendors.multiplierText(0.5) == "0.5x")
}
