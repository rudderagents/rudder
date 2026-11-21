import Testing
import Foundation
@testable import RudderProtocol

struct FrameTests {
    /// Second review: the sample session's placeholder title comes as copy and is read through the wording, not `title`.
    @Test func aSessionTitleCopyTakesOverTheStoredTitle() throws {
        let json: RudderJSON = .object([
            "id": .string("s"), "title": .string("stored"), "agent": .string("claude"), "status": .string("idle"),
            "titleCopy": .object(["code": .string("demo_title"), "text": .string("示例会话")]),
        ])
        #expect(try #require(RudderSession(json: json)).title == "示例会话")
        let plain: RudderJSON = .object(["id": .string("s"), "title": .string("mine"), "agent": .string("claude"), "status": .string("idle")])
        #expect(try #require(RudderSession(json: plain)).title == "mine")
    }

    /// Third review #9: the result line's copy rides on the session (`lastResultCopy`) and lands on its last turn.
    @Test func aSteeredReplyToAWaitingAgentIsMarked() throws {
        func message(_ steer: RudderJSON) throws -> RudderChatMessage {
            try #require(RudderChatMessage(json: .object([
                "id": .string("u1"), "sessionId": .string("s"), "kind": .string("text"), "role": .string("user"),
                "text": .string("参数不用改"), "steer": steer,
            ])))
        }
        let waiting = try message(.object(["state": .string("read"), "readAt": .number(5), "waiting": .bool(true)]))
        #expect(waiting.steer == "read")
        #expect(waiting.steerWaiting)
        let tapped = try message(.object(["state": .string("sent")]))
        #expect(tapped.steer == "sent")
        #expect(!tapped.steerWaiting)
    }

    @Test func aSessionsLastResultCopyIsKeptWithItsLastTurn() throws {
        let json: RudderJSON = .object([
            "id": .string("s"), "title": .string("t"), "agent": .string("kimi"), "status": .string("idle"),
            "lastTurn": .object(["phase": .string("failed"), "reason": .string("未找到命令 kimi")]),
            "lastResultCopy": .object(["code": .string("command_missing"), "args": .object(["command": .string("kimi")]), "text": .string("未找到命令 kimi")]),
        ])
        let session = try #require(RudderSession(json: json))
        #expect(session.lastResultCopy == RudderCopy(code: "command_missing", args: ["command": .text("kimi")], text: "未找到命令 kimi"))
        #expect(session.lastTurn?.reason == "未找到命令 kimi")
        let older: RudderJSON = .object([
            "id": .string("s"), "title": .string("t"), "agent": .string("kimi"), "status": .string("idle"),
            "lastTurn": .object(["phase": .string("failed"), "reason": .string("x")]),
        ])
        #expect(try #require(RudderSession(json: older)).lastResultCopy == nil)
    }

    /// Copy rudderd wrote for the phone: the code, plain and nested arguments, and the Chinese text older apps show.
    @Test func copyDecodesOnMessagesAndAgentsAndRoundTrips() throws {
        let reason: RudderJSON = .object([
            "code": .string("command_missing"), "args": .object(["command": .string("kimi")]), "text": .string("未找到命令 kimi"),
        ])
        let copy: RudderJSON = .object([
            "code": .string("agent_unavailable"),
            "args": .object(["agent": .string("Kimi"), "reason": reason]),
            "text": .string("Kimi 不可用：未找到命令 kimi"),
        ])
        let message = try #require(RudderChatMessage(json: .object([
            "id": .string("e1"), "sessionId": .string("s"), "kind": .string("error"), "role": .string("assistant"),
            "text": .string("Kimi 不可用：未找到命令 kimi"), "copy": copy,
        ])))
        let decoded = try #require(message.copy)
        #expect(decoded.code == "agent_unavailable")
        #expect(decoded.args["agent"] == .text("Kimi"))
        #expect(decoded.args["reason"] == .copy(RudderCopy(code: "command_missing", args: ["command": .text("kimi")], text: "未找到命令 kimi")))
        #expect(RudderCopy(json: decoded.json) == decoded)

        let agent = try #require(RudderAgent(json: .object(["id": .string("kimi"), "unavailableCopy": reason])))
        #expect(agent.unavailableCopy?.code == "command_missing")
        // An older daemon sends neither.
        #expect(RudderAgent(json: .object(["id": .string("kimi")]))?.unavailableCopy == nil)
        #expect(RudderCopy(json: .object(["code": .string("x")])) == nil)
    }

    @Test func invokeRoundTrip() throws {
        let frame = RudderFrame.invoke(id: "1", method: "session.list", params: [:])
        let data = try JSONEncoder().encode(frame)
        let decoded = try JSONDecoder().decode(RudderFrame.self, from: data)
        #expect(decoded.method == "session.list")
        #expect(decoded.v == rudderProtocolVersion)
    }

    @Test func eventFramesCarryTheirEventId() throws {
        let raw = #"{"v":1,"id":"e","type":"event","name":"message.delta","eventId":42,"payload":{"sessionId":"s","id":"m","seq":2,"offset":3,"append":"lo"}}"#
        let frame = try JSONDecoder().decode(RudderFrame.self, from: Data(raw.utf8))
        #expect(frame.eventId == 42)
        #expect(frame.payload?["offset"]?.int == 3)
        // Frames from daemons without an event log still decode.
        let old = try JSONDecoder().decode(RudderFrame.self, from: Data(#"{"v":1,"id":"e","type":"event","name":"x","payload":{}}"#.utf8))
        #expect(old.eventId == nil)
        #expect(!String(decoding: try JSONEncoder().encode(RudderFrame.invoke(id: "1", method: "hello")), as: UTF8.self).contains("eventId"))
    }

    @Test func sessionFromJSON() throws {
        let json = RudderJSON.object([
            "id": .string("s1"),
            "title": .string("Demo"),
            "agent": .string("claude"),
            "status": .string("idle"),
            "pinned": .bool(true),
            "archived": .bool(false),
            "unreadCount": .number(3),
            "updatedAt": .number(1),
        ])
        let session = try #require(RudderSession(json: json))
        #expect(session.title == "Demo")
        #expect(session.agent == "claude")
        #expect(session.pinned)
        #expect(session.unreadCount == 3)
        #expect(session.markedUnread == false)
        #expect(session.archived == false)
        #expect(session.backgroundOpen == 0)
        let paused = try #require(RudderSession(json: .object([
            "id": .string("s1"), "title": .string("Demo"), "agent": .string("claude"), "status": .string("idle"),
            "backgroundOpen": .number(1),
        ])))
        #expect(paused.backgroundOpen == 1)
        #expect(paused.backgroundTasks.isEmpty)
        let tasks = try #require(RudderSession(json: .object([
            "id": .string("s1"), "title": .string("Demo"), "agent": .string("claude"), "status": .string("idle"),
            "backgroundOpen": .number(1),
            "backgroundTasks": .array([
                .object(["id": .string("a1"), "kind": .string("subagent"), "title": .string("查并发警告"), "toolId": .string("row_a"),
                         "startedAt": .number(1000), "status": .string("running")]),
                .object(["id": .string("b2"), "kind": .string("command"), "title": .string("bun test"), "startedAt": .number(1000),
                         "endedAt": .number(5000), "status": .string("failed"), "exitCode": .number(1)]),
                .object(["id": .string("c3"), "kind": .string("later"), "startedAt": .number(1), "status": .string("paused")]),
                .object(["kind": .string("command")]),
            ]),
        ])))
        #expect(tasks.backgroundTasks.map(\.id) == ["a1", "b2", "c3"])
        #expect(tasks.backgroundTasks[0] == RudderBackgroundTask(id: "a1", kind: .subagent, title: "查并发警告", toolId: "row_a",
                                                                   startedAt: 1000, status: .running))
        #expect(tasks.backgroundTasks[1].status == .failed && tasks.backgroundTasks[1].exitCode == 1 && tasks.backgroundTasks[1].endedAt == 5000)
        // Unknown kinds read as a command, unknown statuses as ended.
        #expect(tasks.backgroundTasks[2].kind == .command && tasks.backgroundTasks[2].status == .cancelled)
        let marked = try #require(RudderSession(json: .object([
            "id": .string("s1"), "title": .string("Demo"), "agent": .string("claude"), "status": .string("idle"),
            "markedUnread": .bool(true),
        ])))
        #expect(marked.markedUnread)
        #expect(marked.unreadCount == 0)
    }

    @Test func upsertPatchesSameMessageId() {
        var messages: [RudderChatMessage] = []
        let first = RudderChatMessage(id: "m1", sessionId: "s", seq: 2, kind: "text", role: "assistant", text: "Fake")
        let second = RudderChatMessage(id: "m1", sessionId: "s", seq: 2, kind: "text", role: "assistant", text: "Fake Claude heard")
        RudderChatMessage.upsert(first, into: &messages)
        RudderChatMessage.upsert(second, into: &messages)
        #expect(messages.count == 1)
        #expect(messages[0].text == "Fake Claude heard")
    }

    @Test func compactionAndContextWindowsDecode() throws {
        let compact = try #require(RudderChatMessage(json: .object([
            "id": .string("c"), "sessionId": .string("s"), "seq": .number(4), "kind": .string("compaction"),
            "role": .string("assistant"), "text": .string(""), "compaction": .object([
                "state": .string("done"), "trigger": .string("auto"), "tokensBefore": .number(241_000),
                "tokensAfter": .number(92_000), "count": .number(2),
            ]),
        ])))
        #expect(compact.compaction?.state == "done")
        #expect(compact.compaction?.tokensBefore == 241_000)
        let model = try #require(RudderModel(json: .object([
            "id": .string("grok-4"), "label": .string("Grok 4"),
            "contextWindows": .array([.number(256_000), .number(500_000)]),
        ])))
        #expect(model.contextWindows == [256_000, 500_000])
    }

    @Test func upsertKeepsSeqOrderWithoutResorting() {
        var messages: [RudderChatMessage] = []
        for seq in [1, 2, 5, 7] {
            RudderChatMessage.upsert(RudderChatMessage(id: "m\(seq)", sessionId: "s", seq: seq, kind: "text", role: "assistant", text: ""), into: &messages)
        }
        RudderChatMessage.upsert(RudderChatMessage(id: "m6", sessionId: "s", seq: 6, kind: "text", role: "assistant", text: ""), into: &messages)
        RudderChatMessage.upsert(RudderChatMessage(id: "m0", sessionId: "s", seq: 0, kind: "text", role: "assistant", text: ""), into: &messages)
        RudderChatMessage.upsert(RudderChatMessage(id: "m7b", sessionId: "s", seq: 7, kind: "text", role: "assistant", text: ""), into: &messages)
        #expect(messages.map(\.id) == ["m0", "m1", "m2", "m5", "m6", "m7", "m7b"])
    }

    @Test func hugeNumbersDoNotTrap() throws {
        #expect(RudderJSON.number(1e300).int == nil)
        #expect(RudderJSON.number(.nan).int == nil)
        #expect(RudderJSON.number(42).int == 42)
        #expect(RudderJSON.number(-3.9).int == -3)
        #expect(RudderJSON.string("1").int == nil)
        let huge = RudderJSON.number(1e300)
        let message = try #require(RudderChatMessage(json: .object([
            "id": .string("m"), "sessionId": .string("s"), "kind": .string("text"), "role": .string("user"),
            "text": .string(""), "seq": huge, "tool": .object(["id": .string("t"), "tool": .string("bash"), "exitCode": huge]),
        ])))
        #expect(message.seq == 0)
        #expect(message.tool?.exitCode == nil)
        let session = try #require(RudderSession(json: .object([
            "id": .string("s"), "title": .string("t"), "agent": .string("a"), "status": .string("idle"),
            "unreadCount": huge, "scheduledCount": huge, "usage": .object(["inputTokens": huge]),
        ])))
        #expect(session.unreadCount == 0)
        #expect(session.usage.inputTokens == nil)
        #expect(RudderFileEntry(json: .object(["name": .string("a"), "path": .string("/a"), "size": huge]))?.size == 0)
        #expect(RudderGitStatus(json: .object(["ahead": huge])).ahead == 0)
        #expect(RudderGitFile(json: .object(["path": .string("a"), "status": .string("M"), "added": huge]))?.added == nil)
        #expect(RudderFileContent(json: .object(["path": .string("a"), "bytes": huge]))?.bytes == 0)
    }

    @Test func permissionFromJSON() throws {
        let json = RudderJSON.object([
            "id": .string("m1"),
            "sessionId": .string("s"),
            "seq": .number(3),
            "kind": .string("permission"),
            "role": .string("assistant"),
            "text": .string("Bash: ls -la"),
            "permission": .object([
                "id": .string("m1"),
                "tool": .string("Bash"),
                "title": .string("Run command"),
                "detail": .string("ls -la"),
                "status": .string("pending"),
            ]),
        ])
        let message = try #require(RudderChatMessage(json: json))
        #expect(message.permission?.tool == "Bash")
        #expect(message.permission?.isPending == true)
        var messages = [message]
        let resolved = RudderChatMessage(
            id: "m1",
            sessionId: "s",
            seq: 3,
            kind: "permission",
            role: "assistant",
            text: "Bash: ls -la",
            permission: RudderPermission(id: "m1", tool: "Bash", title: "Run command", detail: "ls -la", status: "allowed")
        )
        RudderChatMessage.upsert(resolved, into: &messages)
        #expect(messages.count == 1)
        #expect(messages[0].permission?.status == "allowed")
    }

    @Test func imageDecodesAndAnOlderMessageStaysWithoutOne() throws {
        let older = try #require(RudderChatMessage(json: .object([
            "id": .string("m"), "sessionId": .string("s"), "seq": .number(1),
            "kind": .string("text"), "role": .string("assistant"), "text": .string("做好了。"),
        ])))
        #expect(older.image == nil)
        #expect(older.gallery.isEmpty)
        let broken = try #require(RudderChatMessage(json: .object([
            "id": .string("bad"), "sessionId": .string("s"), "seq": .number(2),
            "kind": .string("image"), "role": .string("assistant"), "text": .string(""),
            "image": .object(["id": .string("a"), "name": .string("x.png"), "mediaType": .string("image/png"), "width": .number(0), "height": .number(9)]),
        ])))
        #expect(broken.image == nil)
        let json = RudderJSON.object([
            "id": .string("img"), "sessionId": .string("s"), "seq": .number(3),
            "kind": .string("image"), "role": .string("assistant"), "text": .string(""),
            "image": .object([
                "id": .string("att"), "name": .string("launch-poster.png"), "bytes": .number(74),
                "mediaType": .string("image/png"), "width": .number(1600), "height": .number(900),
            ]),
        ])
        let message = try #require(RudderChatMessage(json: json))
        #expect(message.image == RudderAgentImage(id: "att", name: "launch-poster.png", bytes: 74, mediaType: "image/png", width: 1600, height: 900))
        var messages = [message]
        messages[0].gallery = [message.image!]
        let again = try #require(RudderChatMessage(json: json))
        RudderChatMessage.upsert(again, into: &messages)
        #expect(messages.count == 1)
        #expect(messages[0].gallery.map(\.id) == ["att"])
    }

    @Test func agentFileImageCarriesItsFileName() throws {
        let image = try #require(RudderAgentImage(json: .object([
            "id": .string("att"), "name": .string("home-se.png"), "bytes": .number(9), "mediaType": .string("image/png"),
            "width": .number(390), "height": .number(844), "fileName": .string("home-se.png"),
            "sourcePath": .string("shots/home-se.png"),
        ])))
        #expect(image.fileName == "home-se.png")
        let generated = try #require(RudderAgentImage(json: .object([
            "id": .string("g"), "name": .string("image.png"), "mediaType": .string("image/png"),
            "width": .number(1), "height": .number(1), "fileName": .string(""),
        ])))
        #expect(generated.fileName == nil)
    }

    @Test func questionAndToolFromJSON() throws {
        let questionJSON = RudderJSON.object([
            "id": .string("q1"),
            "sessionId": .string("s"),
            "seq": .number(4),
            "kind": .string("question"),
            "role": .string("assistant"),
            "text": .string("continue?"),
            "question": .object([
                "id": .string("q1"),
                "prompt": .string("continue?"),
                "options": .array([.string("是"), .string("否")]),
                "status": .string("pending"),
            ]),
        ])
        let question = try #require(RudderChatMessage(json: questionJSON))
        #expect(question.question?.isPending == true)
        #expect(question.question?.options.count == 2)

        let toolJSON = RudderJSON.object([
            "id": .string("t1"),
            "sessionId": .string("s"),
            "seq": .number(5),
            "kind": .string("tool"),
            "role": .string("assistant"),
            "text": .string("Bash"),
            "tool": .object([
                "id": .string("t1"),
                "tool": .string("Bash"),
                "title": .string("Run command"),
                "detail": .string("ls -la"),
                "status": .string("done"),
            ]),
        ])
        let tool = try #require(RudderChatMessage(json: toolJSON))
        #expect(tool.tool?.tool == "Bash")
        // Legacy "done" reads as the unified "completed".
        #expect(tool.tool?.status == "completed")
        #expect(tool.tool?.kind == "other")
        // A legacy question still exposes one item for the multi-question UI.
        #expect(question.question?.questions.first?.question == "continue?")
        #expect(question.question?.questions.first?.options.map(\.label) == ["是", "否"])
    }

    @Test func permissionOptionsAndDecision() throws {
        let json = RudderJSON.object([
            "id": .string("p1"),
            "tool": .string("Bash"),
            "title": .string("Run command"),
            "detail": .string("echo hi"),
            "status": .string("allowed"),
            "kind": .string("execute"),
            "options": .array([
                .object(["id": .string("accept"), "label": .string("批准"), "kind": .string("allow_once")]),
                .object(["id": .string("decline"), "label": .string("拒绝"), "kind": .string("reject_once")]),
            ]),
            "diffs": .array([.object(["path": .string("a.txt"), "patch": .string("+hi")])]),
            "decision": .string("accept"),
        ])
        let permission = try #require(RudderPermission(json: json))
        #expect(permission.options.map(\.id) == ["accept", "decline"])
        #expect(permission.options[0].allows)
        #expect(!permission.options[1].allows)
        #expect(permission.chosenOption?.label == "批准")
        #expect(permission.diffs.first?.patch == "+hi")
        #expect(!permission.isCancelled)
    }

    @Test func multiQuestionAnswers() throws {
        let json = RudderJSON.object([
            "id": .string("q2"),
            "prompt": .string("Which?"),
            "options": .array([.string("A")]),
            "status": .string("answered"),
            "questions": .array([
                .object([
                    "question": .string("Which?"),
                    "header": .string("Pick"),
                    "options": .array([.object(["label": .string("A"), "description": .string("first")])]),
                    "multiSelect": .bool(false),
                ]),
                .object([
                    "question": .string("Extras?"),
                    "options": .array([.object(["label": .string("X")]), .object(["label": .string("Y")])]),
                    "multiSelect": .bool(true),
                ]),
            ]),
            "answers": .object(["Which?": .string("A"), "Extras?": .array([.string("X"), .string("Y")])]),
        ])
        let question = try #require(RudderQuestion(json: json))
        #expect(question.questions.count == 2)
        #expect(question.questions[0].options.first?.description == "first")
        #expect(question.questions[1].multiSelect)
        #expect(question.answers["Which?"] == ["A"])
        #expect(question.answers["Extras?"] == ["X", "Y"])
    }

    @Test func toolReasoningPlanAndUsage() throws {
        let tool = try #require(RudderToolCall(json: .object([
            "id": .string("t2"),
            "tool": .string("Bash"),
            "status": .string("failed"),
            "kind": .string("execute"),
            "output": .string("boom"),
            "exitCode": .number(2),
        ])))
        #expect(tool.exitCode == 2)
        #expect(tool.output == "boom")
        #expect(tool.title == "Bash")

        let message = try #require(RudderChatMessage(json: .object([
            "id": .string("r1"),
            "sessionId": .string("s"),
            "seq": .number(6),
            "kind": .string("reasoning"),
            "role": .string("assistant"),
            "text": .string("thinking"),
            "createdAt": .number(1000),
            "reasoning": .object(["startedAt": .number(1000), "endedAt": .number(9000)]),
        ])))
        #expect(message.reasoning?.seconds == 8)
        #expect(message.reasoning?.isThinking == false)
        #expect(message.createdAt == 1000)

        let plan = try #require(RudderPlan(json: .object([
            "entries": .array([.object(["content": .string("Step"), "status": .string("in_progress")])]),
        ])))
        #expect(plan.entries.first?.status == "in_progress")

        let session = try #require(RudderSession(json: .object([
            "id": .string("s"),
            "title": .string("T"),
            "agent": .string("codex"),
            "status": .string("idle"),
            "effort": .string("high"),
            "permissionMode": .string("plan"),
            "usage": .object(["inputTokens": .number(120), "costUsd": .number(0.01), "contextSize": .number(200000)]),
        ])))
        #expect(session.effort == "high")
        #expect(session.permissionMode == "plan")
        #expect(session.usage.inputTokens == 120)
        #expect(session.usage.contextSize == 200000)
        #expect(session.usage.outputTokens == nil)
        #expect(RudderSession(json: .object(["id": .string("x"), "title": .string("t"), "agent": .string("a"), "status": .string("idle")]))?.usage.isEmpty == true)
    }

    @Test func agentFromHello() throws {
        let agent = try #require(RudderAgent(json: .object([
            "id": .string("copilot"),
            "label": .string("Copilot"),
            "transport": .string("acp"),
            "experimental": .bool(false),
            "available": .bool(false),
            "unavailableReason": .string("403"),
            "capabilities": .object([
                "steer": .bool(false),
                "usage": .string("both"),
                "permissionModes": .array([.string("ask"), .string("plan")]),
            ]),
        ])))
        #expect(!agent.available)
        #expect(agent.unavailableReason == "403")
        #expect(agent.capabilities.usage == "both")
        #expect(agent.capabilities.permissionModes == ["ask", "plan"])
        // A daemon without the mode list: the ids, no copy, all normal.
        #expect(agent.capabilities.modes.map(\.id) == ["ask", "plan"])
        #expect(agent.capabilities.modes.allSatisfy { $0.risk == .normal && $0.description == nil })
        #expect(!agent.capabilities.efforts)
        #expect(agent.version == nil)
        let versioned = try #require(RudderAgent(json: .object(["id": .string("claude"), "version": .string("2.1.4")])))
        #expect(versioned.version == "2.1.4")
        #expect(versioned.permissionLock == nil)
        let locked = try #require(RudderAgent(json: .object([
            "id": .string("grok"),
            "permissionLock": .object(["mode": .string("always-approve"), "source": .string("/Users/x/.grok/config.toml")]),
        ])))
        #expect(locked.permissionLock == RudderPermissionLock(mode: "always-approve", source: "/Users/x/.grok/config.toml"))
        #expect(locked.permissionLock?.approvesEverything == true)
    }

    @Test func agentOutdatedFields() throws {
        let outdated = try #require(RudderAgent(json: .object([
            "id": .string("codex"),
            "available": .bool(false),
            "unavailableCode": .string("outdated"),
            "unavailableReason": .string("Codex 版本太旧：电脑上是 0.40.0，需要 0.52.0 或更新"),
            "version": .string("0.40.0"),
            "minimumVersion": .string("0.52.0"),
            "upgradeCommand": .string("npm install -g @openai/codex@latest"),
        ])))
        #expect(outdated.isOutdated)
        #expect(!outdated.available)
        #expect(outdated.version == "0.40.0")
        #expect(outdated.minimumVersion == "0.52.0")
        #expect(outdated.upgradeCommand == "npm install -g @openai/codex@latest")
        // A fine agent still carries the minimum; no command.
        let fine = try #require(RudderAgent(json: .object([
            "id": .string("claude"), "available": .bool(true), "version": .string("2.1.4"), "minimumVersion": .string("2.0.0"),
        ])))
        #expect(!fine.isOutdated)
        #expect(fine.minimumVersion == "2.0.0")
        #expect(fine.upgradeCommand == nil)
        // An older daemon: neither field.
        let old = try #require(RudderAgent(json: .object(["id": .string("codex"), "unavailableCode": .string("not_installed")])))
        #expect(!old.isOutdated)
        #expect(old.minimumVersion == nil && old.upgradeCommand == nil)
    }

    @Test func permissionModesAndModelMetadata() throws {
        let capabilities = RudderAgentCapabilities(json: .object([
            "permissionModes": .array([.string("ask"), .string("bypassPermissions")]),
            "modes": .array([
                .object(["id": .string("ask"), "label": .string("Always ask"), "risk": .string("normal"), "native": .string("manual")]),
                .object([
                    "id": .string("bypassPermissions"), "label": .string("Bypass permissions"), "description": .string("Skips every check"),
                    "risk": .string("danger"), "restart": .bool(true), "native": .string("bypassPermissions"),
                ]),
                .object(["id": .string("https://x/session-modes#autopilot"), "label": .string("Autopilot"), "risk": .string("caution"), "fromAgent": .bool(true)]),
                .object(["label": .string("no id")]),
                .object(["id": .string("odd"), "risk": .string("unheard-of")]),
            ]),
        ]))
        #expect(capabilities.modes.map(\.id) == ["ask", "bypassPermissions", "https://x/session-modes#autopilot", "odd"])
        #expect(capabilities.modes[0].native == "manual")
        #expect(capabilities.modes[1].risk == .danger && capabilities.modes[1].restart && capabilities.modes[1].description == "Skips every check")
        #expect(capabilities.modes[2].fromAgent && capabilities.modes[2].risk == .caution)
        // An unknown risk reads as normal; a missing label is the id.
        #expect(capabilities.modes[3].risk == .normal && capabilities.modes[3].label == "odd")

        let model = try #require(RudderModel(json: .object([
            "id": .string("gpt-6.1-sol"), "label": .string("GPT-6.1-Sol"), "efforts": .array([.string("low")]),
            "defaultEffort": .string("low"), "isDefault": .bool(true), "description": .string("Frontier"),
        ])))
        #expect(model.isDefault && model.description == "Frontier")
        #expect(model.speeds.isEmpty)
        let fast = try #require(RudderModel(json: .object([
            "id": .string("opus"), "label": .string("Opus"),
            "speeds": .array([.object(["id": .string("fast"), "label": .string("Fast"), "description": .string("Faster")])]),
            "defaultSpeed": .string("off"),
        ])))
        #expect(fast.speeds.map(\.id) == ["fast"] && fast.defaultSpeed == "off")
        #expect(RudderModel(json: .object(["id": .string("m")]))?.isDefault == false)
    }

    @Test func effortLevelsSortByStrengthThenAgentOrder() {
        #expect(RudderEffort.sorted(["xhigh", "high", "medium", "low"]) == ["low", "medium", "high", "xhigh"])
        #expect(RudderEffort.sorted(["ultra", "low", "turbo", "max", "minimal", "custom", "low"]) == ["minimal", "low", "max", "ultra", "turbo", "custom"])
        #expect(RudderEffort.sorted([]).isEmpty)
    }
    @Test func dataLayerGapFields() throws {
        let base: [String: RudderJSON] = ["id": .string("s"), "title": .string("t"), "agent": .string("claude"), "status": .string("waiting")]
        var waiting = base
        waiting["pending"] = .string("question")
        #expect(RudderSession(json: .object(waiting))?.pending == "question")
        var cleared = base
        cleared["pending"] = .null
        #expect(RudderSession(json: .object(cleared))?.pending == nil)
        #expect(RudderSession(json: .object(base))?.pending == nil)

        var previewed = base
        previewed["preview"] = .object(["role": .string("user"), "text": .string("run ls"), "createdAt": .number(1_792_600_000_000)])
        let preview = try #require(RudderSession(json: .object(previewed))?.preview)
        #expect(preview == RudderSessionPreview(role: "user", text: "run ls", createdAt: 1_792_600_000_000))
        #expect(preview.fromUser)
        previewed["preview"] = .object(["role": .string("assistant"), "text": .string("Done.")])
        #expect(RudderSession(json: .object(previewed))?.preview?.fromUser == false)
        previewed["preview"] = .null
        #expect(RudderSession(json: .object(previewed))?.preview == nil)
        previewed["preview"] = .object(["role": .string("assistant"), "text": .string("")])
        #expect(RudderSession(json: .object(previewed))?.preview == nil)
        #expect(RudderSession(json: .object(base))?.preview == nil)

        let permission = try #require(RudderPermission(json: .object([
            "id": .string("p1"),
            "tool": .string("Bash"),
            "title": .string("Run"),
            "detail": .string("ls"),
            "status": .string("cancelled"),
            "toolId": .string("t1"),
            "cancelReason": .string("withdrawn"),
            "diffs": .array([.object(["path": .string("a.txt"), "newText": .string("x…"), "truncated": .bool(true)])]),
        ])))
        #expect(permission.toolId == "t1")
        #expect(permission.cancelReason == "withdrawn")
        #expect(permission.diffs.first?.truncated == true)
        let legacy = try #require(RudderPermission(json: .object([
            "id": .string("p0"), "tool": .string("Bash"), "title": .string("Run"), "detail": .string("ls"), "status": .string("pending"),
        ])))
        #expect(legacy.toolId == nil)
        #expect(legacy.cancelReason == nil)

        let question = try #require(RudderQuestion(json: .object([
            "id": .string("q1"), "prompt": .string("Go?"), "status": .string("cancelled"), "cancelReason": .string("interrupted"),
        ])))
        #expect(question.cancelReason == "interrupted")

        let tool = try #require(RudderToolCall(json: .object([
            "id": .string("t1"),
            "tool": .string("Bash"),
            "output": .string("long…"),
            "outputTruncated": .bool(true),
            "diffs": .array([.object(["path": .string("a.txt"), "patch": .string("@@")])]),
        ])))
        #expect(tool.outputTruncated)
        #expect(tool.diffs.first?.truncated == false)
        #expect(RudderToolCall(json: .object(["id": .string("t2"), "tool": .string("Read")]))?.outputTruncated == false)
    }
}

struct WorkspaceFrameTests {
    @Test func gitStatusStructuredFields() throws {
        let json = RudderJSON.object([
            "cwd": .string("/r/ios"), "text": .string("## main...origin/main [ahead 2]\n"), "root": .string("/r"),
            "branch": .string("main"), "oid": .string("abc"), "upstream": .string("origin/main"),
            "ahead": .number(2), "behind": .number(0),
            "files": .array([
                .object(["path": .string("ios/A.swift"), "status": .string("M"), "added": .number(24), "removed": .number(6)]),
                .object(["path": .string("new.ts"), "status": .string("A"), "added": .number(51), "removed": .number(0)]),
                .object(["path": .string("logo.png"), "status": .string("M"), "binary": .bool(true)]),
                .object(["path": .string(".build/"), "status": .string("?")]),
            ]),
        ])
        let status = RudderGitStatus(json: json)
        #expect(status.structured)
        #expect(status.root == "/r")
        #expect(status.branch == "main")
        #expect(status.ahead == 2)
        #expect(status.files.count == 4)
        #expect(status.changeCount == 3)
        #expect(status.files[0].added == 24)
        #expect(status.files[2].binary)
        #expect(status.files[2].added == nil)
        #expect(status.files[3].untracked)
    }

    @Test func gitStatusFromOldDaemonIsUnstructured() {
        let status = RudderGitStatus(json: .object(["cwd": .string("/r"), "text": .string("## main\n")]))
        #expect(!status.structured)
        #expect(status.files.isEmpty)
        #expect(status.root == "/r")
        #expect(status.branch == nil)
    }

    @Test func gitPatchAndFileContent() throws {
        let patch = try #require(RudderGitPatch(json: .object([
            "path": .string("note.txt"), "patch": .string("@@ -0,0 +1 @@\n+x\n"), "untracked": .bool(true),
        ])))
        #expect(patch.untracked)
        #expect(!patch.truncated)
        #expect(RudderGitPatch(json: .object(["path": .string("x"), "text": .string("stat")])) == nil)

        let content = try #require(RudderFileContent(json: .object([
            "path": .string("/r/a.bin"), "text": .string(""), "bytes": .number(3), "binary": .bool(true),
        ])))
        #expect(content.binary)
        #expect(content.bytes == 3)
        let old = try #require(RudderFileContent(json: .object(["path": .string("/r/a"), "text": .string("hé")])))
        #expect(old.bytes == 3)
        #expect(!old.binary)
    }

    @Test func sessionStepIsOptional() throws {
        let base: [String: RudderJSON] = [
            "id": .string("s"), "title": .string("t"), "agent": .string("claude"), "status": .string("running"), "updatedAt": .number(1),
        ]
        #expect(try #require(RudderSession(json: .object(base))).step == nil)
        var running = base
        running["step"] = .object(["kind": .string("execute"), "text": .string("bun install")])
        #expect(try #require(RudderSession(json: .object(running))).step == RudderSessionStep(kind: "execute", text: "bun install"))
        var thinking = base
        thinking["step"] = .object(["kind": .string("think")])
        #expect(try #require(RudderSession(json: .object(thinking))).step == RudderSessionStep(kind: "think"))
    }

    @Test func machineHomeIsOptional() throws {
        #expect(try #require(RudderMachine(json: .object(["name": .string("m")]))).home == nil)
        #expect(try #require(RudderMachine(json: .object(["name": .string("m"), "home": .string("/Users/z")]))).home == "/Users/z")
    }

    @Test func machineCarriesPlatformModelAndOSVersion() throws {
        let machine = try #require(RudderMachine(json: .object([
            "name": .string("test-pc"), "home": .string(#"C:\Users\tester"#), "platform": .string("win32"),
            "model": .string("Dell XPS 15 9530"), "osVersion": .string("11 24H2"),
        ])))
        #expect(machine.platform == "win32")
        #expect(machine.model == "Dell XPS 15 9530")
        #expect(machine.osVersion == "11 24H2")
        #expect(try #require(RudderMachine(json: .object(["name": .string("m")]))).platform == nil)
    }
}

/// Audit 40: newer daemons may add frame types and send thinner error bodies; neither may sink the frame.
struct FrameForwardCompatDecodingTests {
    private func frame(_ raw: String) throws -> RudderFrame {
        try JSONDecoder().decode(RudderFrame.self, from: Data(raw.utf8))
    }

    @Test func anUnknownTypeDecodesAsUnknown() throws {
        #expect(try frame(#"{"v":1,"id":"a","type":"progress"}"#).type == .unknown)
    }

    @Test func errorBodiesDecodeWhateverTheyHold() throws {
        #expect(try frame(#"{"v":1,"id":"a","type":"error","error":{"code":"busy"}}"#).error == RudderErrorBody(code: "busy", message: "busy"))
        #expect(try frame(#"{"v":1,"id":"a","type":"error","error":{"message":"no"}}"#).error == RudderErrorBody(code: "failed", message: "no"))
        #expect(try frame(#"{"v":1,"id":"a","type":"error","error":"gone"}"#).error == RudderErrorBody(code: "failed", message: "gone"))
        #expect(try frame(#"{"v":1,"id":"a","type":"error","error":{"code":7}}"#).error == RudderErrorBody(code: "failed", message: "request failed"))
        #expect(try frame(#"{"v":1,"id":"a","type":"error","error":{"code":"x","message":"y"}}"#).error == RudderErrorBody(code: "x", message: "y"))
    }

    /// rudderd's copy rides on an error beside its message; a malformed one is dropped, not the reply.
    @Test func errorBodiesCarryCopyWhenRudderdSendsIt() throws {
        let hidden = RudderCopy(code: "hidden_path", text: "隐藏文件（以 . 开头）不对手机开放")
        let raw = #"{"v":1,"id":"a","type":"error","error":{"code":"forbidden","message":"隐藏文件（以 . 开头）不对手机开放","copy":{"code":"hidden_path","text":"隐藏文件（以 . 开头）不对手机开放"}}}"#
        let body = try #require(try frame(raw).error)
        #expect(body == RudderErrorBody(code: "forbidden", message: hidden.text, copy: hidden))
        #expect(try JSONDecoder().decode(RudderErrorBody.self, from: JSONEncoder().encode(body)) == body)
        #expect(try frame(#"{"v":1,"id":"a","type":"error","error":{"code":"x","message":"y","copy":{"code":3}}}"#).error == RudderErrorBody(code: "x", message: "y"))
        #expect(try frame(#"{"v":1,"id":"a","type":"error","error":{"code":"x","message":"y","copy":"z"}}"#).error == RudderErrorBody(code: "x", message: "y"))
    }

    /// The decode order changed for speed; every JSON kind must still land on its own case.
    @Test func jsonKindsKeepTheirCases() throws {
        let raw = #"{"s":"true","n":1,"z":0,"f":1.5,"b":true,"c":false,"o":{"k":[1,"x",null,false]},"a":[],"e":{},"null":null}"#
        let json = try JSONDecoder().decode(RudderJSON.self, from: Data(raw.utf8))
        #expect(json == .object([
            "s": .string("true"), "n": .number(1), "z": .number(0), "f": .number(1.5), "b": .bool(true), "c": .bool(false),
            "o": .object(["k": .array([.number(1), .string("x"), .null, .bool(false)])]), "a": .array([]), "e": .object([:]),
            "null": .null,
        ]))
    }
}
