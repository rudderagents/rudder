import Foundation
import Testing
@testable import RudderProtocol

struct ThinkingQuestionTests {
    private func json(_ text: String) throws -> RudderJSON {
        try JSONDecoder().decode(RudderJSON.self, from: Data(text.utf8))
    }

    @Test func allowsOtherDefaultsToTrueWhenMissing() throws {
        let strict = try #require(RudderQuestionItem(json: try json(#"{"question":"Q","options":[{"label":"a"}],"allowsOther":false}"#)))
        #expect(strict.allowsOther == false)
        let older = try #require(RudderQuestionItem(json: try json(#"{"question":"Q","options":[{"label":"a"}]}"#)))
        #expect(older.allowsOther == true)
    }

    @Test func displaySecondsRoundsAndHidesBelowOneSecond() {
        #expect(RudderReasoning(startedAt: 0, endedAt: 400).displaySeconds == nil)
        #expect(RudderReasoning(startedAt: 0, endedAt: 18_400).displaySeconds == 18)
        #expect(RudderReasoning(startedAt: 0, endedAt: 64_000).displaySeconds == 64)
        #expect(RudderReasoning(startedAt: 0).displaySeconds == nil)
    }

    @Test func outcomeFollowsStatusAndCancelReason() {
        func question(_ status: String, _ reason: String? = nil) -> RudderQuestion {
            RudderQuestion(id: "q", prompt: "Q", options: [], status: status, cancelReason: reason)
        }
        #expect(question("pending").outcome == .pending)
        #expect(question("answered").outcome == .answered)
        #expect(question("cancelled", "withdrawn").outcome == .onComputer)
        #expect(question("cancelled", "interrupted").outcome == .expired)
        #expect(question("cancelled").outcome == .expired)
        #expect(question("expired").outcome == .expired)
    }
}
