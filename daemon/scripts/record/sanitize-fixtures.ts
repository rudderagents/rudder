// Re-apply skill / output-style elision to already-recorded fixtures. Does not launch a CLI or re-record.
// Usage: bun scripts/record/sanitize-fixtures.ts
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { collectUserSkillNames, elideUserSkills, type Frame } from "./lib"

const FIXTURES = join(import.meta.dir, "../../src/adapter/fixtures")

/** Names already captured in this tree under a personal prefix, in case those folders are no longer on disk. */
const LEGACY_PREFIX = /^zy-/

function* jsonlFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* jsonlFiles(path)
    else if (entry.name.endsWith(".jsonl")) yield path
  }
}

function harvestLegacyNames(files: string[]): Set<string> {
  const names = new Set<string>()
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item)
      return
    }
    if (!node || typeof node !== "object") return
    const obj = node as Frame
    if (typeof obj.name === "string" && LEGACY_PREFIX.test(obj.name)) names.add(obj.name)
    for (const value of Object.values(obj)) visit(value)
  }
  for (const file of files) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line) continue
      try {
        visit(JSON.parse(line))
      } catch {}
    }
  }
  return names
}

const files = [...jsonlFiles(FIXTURES)]
const userSkills = new Set([...collectUserSkillNames(), ...harvestLegacyNames(files)])
let changedFiles = 0
let changedLines = 0
for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n")
  let fileChanged = false
  const out: string[] = []
  for (const line of lines) {
    if (!line) {
      out.push(line)
      continue
    }
    let parsed: Frame
    try {
      parsed = JSON.parse(line) as Frame
    } catch {
      out.push(line)
      continue
    }
    const shrunk = elideUserSkills(parsed, userSkills)
    if (!shrunk) {
      out.push(line)
      continue
    }
    out.push(JSON.stringify(shrunk.frame))
    fileChanged = true
    changedLines++
  }
  if (fileChanged) {
    const body = out.join("\n")
    writeFileSync(file, body.endsWith("\n") ? body : `${body}\n`)
    changedFiles++
  }
}

// Do not print skill names. Counts only.
console.log(
  `sanitize-fixtures: ${files.length} jsonl files, ${userSkills.size} user skill names in the elision set, ${changedFiles} files rewritten, ${changedLines} lines elided (${relative(process.cwd(), FIXTURES)})`,
)
