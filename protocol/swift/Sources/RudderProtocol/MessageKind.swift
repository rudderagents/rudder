import Foundation

/// The message kinds this app draws (daemon `KNOWN_MESSAGE_KINDS` in `daemon/src/store.ts`). A kind a later rudderd
/// adds is drawn as one 「需要新版 Rudder」 row, with the daemon's `summary` when it sent one, instead of a bubble.
public enum RudderMessageKind {
    public static let known: Set<String> = [
        "text", "tool", "permission", "question", "reasoning", "plan", "image", "compaction", "error", "handoff",
    ]

    public static func isKnown(_ kind: String) -> Bool { known.contains(kind) }
}

extension RudderChatMessage {
    /// A kind from a newer rudderd.
    public var isUnknownKind: Bool { !RudderMessageKind.isKnown(kind) }
}
