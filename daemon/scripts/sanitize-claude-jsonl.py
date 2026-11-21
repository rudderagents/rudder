#!/usr/bin/env python3
"""Builds the session-handoff fixtures (daemon/src/handoff/fixtures/claude-<version>/) from real Claude transcripts.

Keeps the structure the parser reads (record types, uuid links, sidechain and meta flags, entrypoints, content block
types, tool names, tool-result flags, permission decisions) and replaces every other string with a placeholder, so no
original text, path, id or name leaves the machine. The same original string always gets the same placeholder: an
AskUserQuestion answer still keys on its question, a tool result still names its tool_use id.

    python3 -I daemon/scripts/sanitize-claude-jsonl.py OUT_DIR SRC.jsonl [SRC2.jsonl …]

Each source contributes chain windows around the records the parser cares about (question, rejection, interrupt,
compaction); two synthetic cases (a branch and a sidechain) are derived from the first window. Run it read-only on
your own transcripts; check the output with grep before committing (the session handoff notes step 1).
"""
import json
import os
import re
import sys
import uuid

# Enum-like values the parser branches on; everything else is replaced.
KEEP_KEYS = {
    "type", "subtype", "role", "entrypoint", "kind", "decision", "source", "reasonType", "reasonCode", "grantScope",
    "toolDenialKind", "userType", "level", "stop_reason", "permissionMode", "mode", "version", "trigger", "effort",
    "media_type", "status", "promptSource", "turnOrigin", "thinkingDisplay", "circuitBreaker", "classifierCategory",
}
DROP_TYPES = {"api-request", "api-request-blob", "api-request-shape", "atis-latch", "attachment", "file-history-snapshot",
              "file-history-delta", "cost-state", "tools-used", "queue-operation", "bridge-session"}
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
CWD = "/Users/tester/Documents/Project/demo"

strings: dict[str, str] = {}
ids: dict[str, str] = {}
salt = uuid.uuid4()


def new_id(original: str) -> str:
    if original not in ids:
        ids[original] = str(uuid.uuid5(salt, original))
    return ids[original]


def placeholder(original: str, prefix: str = "text") -> str:
    if original == "":
        return ""
    if original not in strings:
        strings[original] = f"{prefix}-{len(strings) + 1}"
    return strings[original]


def clean(value, key=None, parent=None):
    if isinstance(value, dict):
        # AskUserQuestion answers are keyed by the question text.
        if key == "answers":
            return {placeholder(k): clean(v, "answer", value) for k, v in value.items()}
        return {k: clean(v, k, value) for k, v in value.items()}
    if isinstance(value, list):
        return [clean(v, key, parent) for v in value]
    if not isinstance(value, str):
        return value
    if UUID.match(value):
        return new_id(value)
    if key in ("cwd", "backgroundCwdHint"):
        return CWD
    if key == "gitBranch":
        return "main"
    if key == "timestamp":
        return value
    if key == "name" and isinstance(parent, dict) and parent.get("type") == "tool_use":
        # Built-in tool names are structure; MCP tool names name the user's plugins.
        return "mcp__demo__tool" if value.startswith("mcp__") else value
    if key in ("id", "tool_use_id", "requestId", "requestRef", "promptId", "sourceToolUseID", "toolUseID", "agentId",
               "leafUuid", "interruptedMessageId"):
        return placeholder(value, "id")
    if key in ("file_path", "notebook_path", "filePath", "path"):
        return f"{CWD}/{placeholder(value, 'file')}.ts"
    if key == "command":
        return f"echo {placeholder(value, 'cmd')}"
    if key == "signature":
        return "sig"
    if key in KEEP_KEYS and len(value) <= 40 and "/" not in value:
        return value
    if key in ("text", "thinking", "content") and value.startswith("[Request interrupted"):
        return value
    return placeholder(value)


def sanitize(record: dict) -> dict:
    if record.get("type") in DROP_TYPES:
        # The body goes; the links stay, since attachments sit on the parentUuid chain.
        kept = {"type": record["type"], "sessionId": new_id(record.get("sessionId", "s"))}
        for key in ("uuid", "parentUuid", "isSidechain", "timestamp", "entrypoint"):
            if key in record:
                kept[key] = new_id(record[key]) if isinstance(record[key], str) and UUID.match(record[key]) else record[key]
        return kept
    out = clean(record)
    for drop in ("serverClassifierContext", "serverClassifierRequest", "wireToolInputs", "wireIngestContext",
                 "classifierBoundary", "classifierMetaLines", "messagingSocketPath", "slug", "mcpMeta"):
        out.pop(drop, None)
    return out


def load(path):
    records = []
    for line in open(path, errors="replace"):
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError:
            pass
    return records


def chain_of(records):
    by_uuid = {r["uuid"]: r for r in records if isinstance(r.get("uuid"), str)}
    leaf = None
    for r in records:
        if r.get("type") == "last-prompt" and r.get("leafUuid") in by_uuid:
            leaf = r["leafUuid"]
    if leaf is None:
        for r in records:
            if r.get("type") in ("user", "assistant") and isinstance(r.get("uuid"), str):
                leaf = r["uuid"]
    chain, seen, cur = [], set(), leaf
    while cur and cur in by_uuid and cur not in seen:
        seen.add(cur)
        rec = by_uuid[cur]
        chain.append(rec)
        cur = rec.get("parentUuid") or rec.get("logicalParentUuid")
    return list(reversed(chain))


def feature(record) -> str | None:
    if record.get("type") == "system" and record.get("subtype") == "compact_boundary":
        return "compaction"
    result = record.get("toolUseResult")
    if isinstance(result, dict) and "questions" in result:
        return "question"
    if record.get("toolDenialKind") == "user-rejected":
        return "reject"
    decision = record.get("permissionDecision")
    if isinstance(decision, dict) and decision.get("source") == "user_temporary" and decision.get("decision") == "accept":
        return "approval"
    content = (record.get("message") or {}).get("content")
    if isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text" and str(block.get("text", "")).startswith("[Request interrupted"):
                return "interrupt"
    return None


def window(chain, start, end, title):
    picked = [dict(r) for r in chain[max(0, start):end]]
    if not picked:
        return []
    picked[0]["parentUuid"] = None
    picked[0].pop("logicalParentUuid", None)
    session = picked[0].get("sessionId", "s")
    out = [sanitize(r) for r in picked]
    # Side records the scanner and parser read, plus two skipped kinds.
    out.insert(0, sanitize({"type": "permission-mode", "permissionMode": "auto", "sessionId": session}))
    out.insert(1, sanitize({"type": "attachment", "sessionId": session}))
    out.append(sanitize({"type": "ai-title", "aiTitle": title, "sessionId": session}))
    out.append({"type": "last-prompt", "leafUuid": new_id(picked[-1]["uuid"]), "lastPrompt": placeholder(title), "sessionId": new_id(session)})
    return out


def write(out_dir, name, records):
    with open(os.path.join(out_dir, name), "w") as fh:
        for record in records:
            fh.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")


def branch_case(records):
    """Rewinds once in the middle: a second child of the same parent, and last-prompt points at the new branch."""
    turns = [r for r in records if r.get("type") in ("user", "assistant")]
    cut = turns[len(turns) // 2]
    alt = []
    parent = cut["parentUuid"]
    for n, kind in enumerate(["user", "assistant"]):
        rid = str(uuid.uuid5(salt, f"branch-{n}"))
        rec = {"parentUuid": parent, "isSidechain": False, "type": kind, "uuid": rid, "timestamp": cut.get("timestamp"),
               "entrypoint": "cli", "cwd": CWD, "sessionId": cut.get("sessionId"), "version": cut.get("version")}
        if kind == "user":
            rec["message"] = {"role": "user", "content": "branch-user"}
        else:
            rec["message"] = {"id": "id-branch", "role": "assistant", "type": "message", "content": [{"type": "text", "text": "branch-reply"}]}
        alt.append(rec)
        parent = rid
    body = [r for r in records if r.get("type") not in ("last-prompt",)]
    tail = {"type": "last-prompt", "leafUuid": parent, "lastPrompt": "branch-user", "sessionId": cut.get("sessionId")}
    return body + alt + [tail]


def sidechain_case(records):
    turns = [r for r in records if r.get("type") in ("user", "assistant")]
    anchor = turns[min(3, len(turns) - 1)]
    side = []
    parent = None
    for n, kind in enumerate(["user", "assistant"]):
        rid = str(uuid.uuid5(salt, f"side-{n}"))
        rec = {"parentUuid": parent, "isSidechain": True, "type": kind, "uuid": rid, "timestamp": anchor.get("timestamp"),
               "entrypoint": "cli", "cwd": CWD, "sessionId": anchor.get("sessionId"), "version": anchor.get("version"),
               "message": {"role": kind, "content": [{"type": "text", "text": "side-text"}]}}
        side.append(rec)
        parent = rid
    at = records.index(anchor) + 1
    return records[:at] + side + records[at:]


def main():
    out_dir, sources = sys.argv[1], sys.argv[2:]
    os.makedirs(out_dir, exist_ok=True)
    done = set()
    first = None
    for path in sources:
        chain = chain_of(load(path))
        if first is None and len(chain) > 40:
            first = window(chain, 0, 40, "basic session title")
            write(out_dir, "basic.jsonl", first)
        for index, record in enumerate(chain):
            kind = feature(record)
            if not kind or kind in done:
                continue
            done.add(kind)
            write(out_dir, f"{kind}.jsonl", window(chain, index - 12, index + 6, f"{kind} session title"))
    if first:
        write(out_dir, "branch.jsonl", branch_case(first))
        write(out_dir, "sidechain.jsonl", sidechain_case(first))
    print("wrote", sorted(os.listdir(out_dir)), "missing", sorted({"question", "reject", "interrupt", "compaction", "approval"} - done))


main()
