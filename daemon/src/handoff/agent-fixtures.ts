// Test helpers for session handoff P2a / P3: the recorded Codex thread and ACP replays (adapter/fixtures), and scripts
// for the offline fakes built from them. Tests fill in folders and times, which must exist and be recent.
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export const ADAPTER_FIXTURES = join(import.meta.dir, "..", "adapter", "fixtures")

// biome-ignore lint/suspicious/noExplicitAny: recorded JSON-RPC shapes
export type Json = Record<string, any>

export const CODEX_THREAD = JSON.parse(readFileSync(join(ADAPTER_FIXTURES, "codex", "handoff-thread.json"), "utf8")) as { thread: Json; items: Json[] }
export const ACP_REPLAYS = JSON.parse(readFileSync(join(ADAPTER_FIXTURES, "acp", "handoff-replays.json"), "utf8")) as Record<
  "grok" | "copilot",
  { session: Json; replay: Json[] }
>

export function codexThread(overrides: Json): Json {
  return { ...structuredClone(CODEX_THREAD.thread), ...overrides }
}

/** A fake-app-server script: the handshake, then the given directives. */
export function codexScript(dir: string, directives: Json[]): string {
  const path = join(dir, `script-${crypto.randomUUID()}.jsonl`)
  const lines = [
    { expect: "initialize", result: { userAgent: "rudder/0.170.0", codexHome: "/tmp/codex-home", platformFamily: "unix", platformOs: "macos" } },
    { expect: "initialized" },
    ...directives,
  ]
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`)
  return path
}

/** A fake-agent scenario: the recorded initialize of `base` with `extra` on top (list pages, replay frames). */
export function acpScenario(dir: string, base: "grok" | "copilot", extra: Json): string {
  const scenario = { ...JSON.parse(readFileSync(join(ADAPTER_FIXTURES, "acp", `${base}.json`), "utf8")), ...extra }
  const path = join(dir, `${base}-${crypto.randomUUID()}.json`)
  writeFileSync(path, JSON.stringify(scenario))
  return path
}

/** The fixtures say `$CWD` where the recording had its working folder. */
export function withCwd<T>(value: T, cwd: string): T {
  return JSON.parse(JSON.stringify(value).replaceAll("$CWD", cwd)) as T
}
