import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { type Json, str } from "../adapter/json"
import { ClaudeMapper, currentBranch, type ImportedRow, parseRecords, readTranscript, recentStart, userText } from "./claude-transcript"

const DIR = join(import.meta.dir, "fixtures", "claude-2.1.312")
const fixture = (name: string) => readFileSync(join(DIR, name), "utf8")

// Kind, role and the state the phone draws; texts are placeholders anyway.
function shape(rows: ImportedRow[]): string[] {
  return rows.map((row) => {
    const payload = JSON.parse(row.payload) as Record<string, unknown>
    const state = payload.status ?? payload.state ?? (payload.notice ? "notice" : "")
    return `${row.kind}/${row.role}${state ? `/${String(state)}` : ""}${row.kind === "tool" ? `/${String(payload.tool)}` : ""}`
  })
}

describe("readTranscript", () => {
  for (const name of ["basic", "approval", "branch", "compaction", "interrupt", "question", "reject", "sidechain"]) {
    test(`${name}: block sequence`, () => {
      const read = readTranscript(fixture(`${name}.jsonl`))
      expect(read.recognized).toBe(true)
      expect(read.badLines).toBe(0)
      expect(read.entrypoint).toBe("cli")
      expect(read.version).toBe("2.1.312")
      expect(shape(read.rows)).toMatchSnapshot()
      for (const row of read.rows) expect(JSON.parse(row.payload).imported ?? JSON.parse(row.payload).handoff).toBeTruthy()
    })
  }

  test("ids are deterministic: two reads give the same rows", () => {
    const text = fixture("question.jsonl")
    expect(readTranscript(text).rows).toEqual(readTranscript(text).rows)
  })

  test("the title is the last ai-title", () => {
    expect(readTranscript(fixture("basic.jsonl")).title).toBeTruthy()
  })

  test("a terminal approval becomes an allowed permission row after its tool", () => {
    const rows = readTranscript(fixture("approval.jsonl")).rows
    const permission = rows.find((row) => row.kind === "permission")
    expect(permission).toBeDefined()
    const payload = JSON.parse(permission!.payload)
    expect(payload.status).toBe("allowed")
    expect(payload.imported).toBe(true)
    const tool = rows.find((row) => row.id === payload.toolId)
    expect(tool && rows.indexOf(tool) < rows.indexOf(permission!)).toBe(true)
  })

  test("an AskUserQuestion becomes an answered question card, not a tool card", () => {
    const rows = readTranscript(fixture("question.jsonl")).rows
    const question = rows.find((row) => row.kind === "question")
    const payload = JSON.parse(question!.payload)
    expect(payload.status).toBe("answered")
    expect(Object.keys(payload.answers).length).toBeGreaterThan(0)
    expect(payload.questions[0].question).toBe(Object.keys(payload.answers)[0])
    expect(rows.some((row) => row.kind === "tool" && JSON.parse(row.payload).tool === "AskUserQuestion")).toBe(false)
  })

  test("a rejected tool is declined and the interrupt is a notice", () => {
    const rows = readTranscript(fixture("reject.jsonl")).rows
    expect(rows.some((row) => row.kind === "tool" && JSON.parse(row.payload).status === "declined")).toBe(true)
    expect(rows.some((row) => row.text === "Cancelled." && JSON.parse(row.payload).notice === true)).toBe(true)
  })

  test("compaction boundaries keep the branch going (logicalParentUuid)", () => {
    const rows = readTranscript(fixture("compaction.jsonl")).rows
    const at = rows.findIndex((row) => row.kind === "compaction")
    expect(at).toBeGreaterThan(0)
    expect(rows.slice(0, at).length).toBeGreaterThan(0)
  })

  test("branch: only the branch last-prompt continues is imported", () => {
    const basic = readTranscript(fixture("basic.jsonl")).rows
    const branch = readTranscript(fixture("branch.jsonl")).rows
    expect(branch.at(-1)?.text).toBe("branch-reply")
    expect(branch.some((row) => row.text === "branch-user")).toBe(true)
    // Everything after the rewound point on the old branch is gone.
    expect(branch.length).toBeLessThan(basic.length + 2)
  })

  test("sidechain records never become rows", () => {
    const rows = readTranscript(fixture("sidechain.jsonl")).rows
    expect(rows.some((row) => row.text === "side-text")).toBe(false)
    expect(shape(rows)).toEqual(shape(readTranscript(fixture("basic.jsonl")).rows))
  })

  test("broken lines are counted and skipped", () => {
    const lines = fixture("basic.jsonl").split("\n")
    lines.splice(5, 0, "{not json", "[1,2]")
    const read = readTranscript(lines.join("\n"))
    expect(read.badLines).toBe(2)
    expect(shape(read.rows)).toEqual(shape(readTranscript(fixture("basic.jsonl")).rows))
  })

  test("a file of records in an unknown shape is not recognized", () => {
    const read = readTranscript(`${JSON.stringify({ kind: "turn", body: {} })}\n${JSON.stringify({ kind: "turn" })}\n`)
    expect(read.recognized).toBe(false)
    expect(read.rows).toEqual([])
  })
})

describe("mapper pieces", () => {
  test("slash commands and shell lines lose their wrappers; command output is dropped", () => {
    expect(userText("<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args>keep tests</command-args>")).toBe(
      "/compact keep tests",
    )
    expect(userText("<command-name>/clear</command-name><command-args></command-args>")).toBe("/clear")
    expect(userText("<bash-input>ls -la</bash-input>")).toBe("!ls -la")
    expect(userText("<local-command-stdout>done</local-command-stdout>")).toBe("")
    expect(userText("  plain  ")).toBe("plain")
  })

  test("a tool result arriving later finishes the stored card (follow mode)", () => {
    const { records } = parseRecords(fixture("basic.jsonl").split("\n"))
    const branch = currentBranch(records)
    const firstHalf = new Map<string, ImportedRow>()
    const useAt = records.findIndex((record) => JSON.stringify(record).includes('"type":"tool_use"'))
    const early = new ClaudeMapper()
    for (const record of records.slice(0, useAt + 1)) if (branch.has(String(record.uuid))) for (const row of early.map(record)) firstHalf.set(row.id, row)
    const late = new ClaudeMapper((id) => firstHalf.get(id))
    const updated = records.slice(useAt + 1).flatMap((record) => late.map(record))
    const tool = updated.find((row) => row.kind === "tool")
    expect(tool && firstHalf.has(tool.id)).toBe(true)
    expect(JSON.parse(tool!.payload).status).toBe("completed")
  })

  test("recentStart keeps the last N user turns", () => {
    const rows = readTranscript(fixture("question.jsonl")).rows
    expect(recentStart(rows, 10_000)).toBe(0)
    const users = rows.filter((row) => row.kind === "text" && row.role === "user").length
    if (users >= 1) expect(rows[recentStart(rows, 1)]?.role).toBe("user")
  })
})

// The previous branch selection is the behavioral oracle for small malformed graphs.
function referenceBranch(records: Json[]): Set<string> {
  const types = new Set(["user", "assistant", "system", "attachment"])
  const byId = new Map<string, Json>()
  for (const record of records) if (typeof record.uuid === "string" && types.has(str(record.type))) byId.set(record.uuid, record)
  const ancestry = (tip: string) => {
    const seen = new Set<string>()
    let cursor = tip
    while (cursor && byId.has(cursor) && !seen.has(cursor)) {
      seen.add(cursor)
      const record = byId.get(cursor)!
      cursor = str(record.parentUuid) || str(record.logicalParentUuid)
    }
    return seen
  }
  const main = records.filter(record => record.isSidechain !== true && byId.has(str(record.uuid)))
  const newest = main.at(-1)
  if (!newest) return new Set<string>()
  let branch = ancestry(str(newest.uuid))
  const leaf = records.filter(record => record.type === "last-prompt").map(record => str(record.leafUuid)).filter(id => byId.has(id)).at(-1)
  if (leaf && !branch.has(leaf)) {
    const tip = [...main].reverse().find(record => ancestry(str(record.uuid)).has(leaf))
    branch = ancestry(tip ? str(tip.uuid) : leaf)
  }
  return branch
}

describe("linear branch selection", () => {
  test("rewoundBranchVisitsParentsLinearly", () => {
    for (const count of [1000, 3000, 6000]) {
      let parentEdges = 0
      const records: Json[] = [{ type: "user", uuid: "root" }, { type: "assistant", uuid: "leaf", parentUuid: "root" }]
      for (let index = 0; index < count; index += 1) {
        records.push({ type: "assistant", uuid: `other-${index}`, get parentUuid() {
          parentEdges += 1
          return index === 0 ? "root" : `other-${index - 1}`
        } })
      }
      records.push({ type: "last-prompt", leafUuid: "leaf" })
      expect(currentBranch(records)).toEqual(new Set(["root", "leaf"]))
      expect(parentEdges).toBeGreaterThan(0)
      expect(parentEdges).toBeLessThanOrEqual(records.length * 6)
    }
  })

  test("branchSelectionMatchesReference", () => {
    let seed = 0x20261114
    const random = (max: number) => {
      seed ^= seed << 13
      seed ^= seed >>> 17
      seed ^= seed << 5
      return (seed >>> 0) % max
    }
    for (let round = 0; round < 300; round += 1) {
      const records: Json[] = []
      for (let index = 0; index < 40; index += 1) {
        records.push({ type: ["user", "assistant", "system", "attachment", "progress"][random(5)], uuid: `id-${random(30)}`,
          parentUuid: random(3) === 0 ? null : `id-${random(35)}`, logicalParentUuid: `id-${random(35)}`, isSidechain: random(4) === 0 })
        if (random(5) === 0) records.push({ type: "last-prompt", leafUuid: `id-${random(35)}` })
      }
      expect(currentBranch(records)).toEqual(referenceBranch(records))
    }
  })

  test("deepChainDoesNotUseCallStack", () => {
    const records: Json[] = Array.from({ length: 50000 }, (_, index) => ({
      type: "assistant", uuid: `id-${index}`, parentUuid: index === 0 ? null : `id-${index - 1}`,
    }))
    expect(currentBranch(records).size).toBe(50000)
  }, 15000)
})
