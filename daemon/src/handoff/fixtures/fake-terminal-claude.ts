// A stand-in for an interactive `claude` in a terminal, for the handoff tests only. It registers itself the way
// Claude does (FAKE_CLAUDE_REGISTRY/<pid>.json with its real start time), waits for FAKE_CLAUDE_GO to exist, writes
// one turn to its transcript under its own leaf, unregisters and exits. With FAKE_CLAUDE_HANG it never writes and
// only a signal ends it (the takeover test's SIGTERM).
import { existsSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { TranscriptWriter } from "../test-kit"

const args = process.argv.slice(2)
const idAt = Math.max(args.indexOf("--resume"), args.indexOf("--session-id"))
const nativeId = idAt >= 0 ? args[idAt + 1]! : crypto.randomUUID()
const registry = process.env.FAKE_CLAUDE_REGISTRY!
const project = process.env.FAKE_CLAUDE_PROJECT!
const go = process.env.FAKE_CLAUDE_GO
if (process.env.FAKE_CLAUDE_ARGS) writeFileSync(process.env.FAKE_CLAUDE_ARGS, JSON.stringify({ args, cwd: process.cwd() }))
const procStart = spawnSync("ps", ["-o", "lstart=", "-p", String(process.pid)], { encoding: "utf8" }).stdout.trim().replace(/\s+/g, " ")
const file = join(registry, `${process.pid}.json`)
writeFileSync(
  file,
  JSON.stringify({ pid: process.pid, sessionId: nativeId, cwd: process.cwd(), procStart, version: "2.1.312", kind: "interactive", entrypoint: "cli", status: "idle", updatedAt: Date.now() }),
)
const unregister = () => rmSync(file, { force: true })
process.on("SIGTERM", () => {
  unregister()
  process.exit(143)
})
if (process.env.FAKE_CLAUDE_HANG) {
  setInterval(() => {}, 1000)
} else {
  const deadline = Date.now() + 10_000
  while (go && !existsSync(go) && Date.now() < deadline) await Bun.sleep(20)
  new TranscriptWriter(join(project, `${nativeId}.jsonl`), nativeId, "cli", process.cwd()).turn("typed in the terminal", "answered in the terminal")
  unregister()
  process.exit(0)
}
