// r66: records pi through `pi-acp` (the launch line in adapter/index.ts) on DeepSeek, pi's own provider
// (owner-approved 2026-11-05). HOME and PI_CODING_AGENT_DIR point into the temp root: pi-acp keeps its session map
// under homedir() (~/.pi/pi-acp) whatever PI_CODING_AGENT_DIR says, and lists ~/.pi/agent extensions in its banner.
// npm's cache stays the owner's, so npx does not download pi-acp again.
// pi runs tools without asking, so there is no approval scenario.
import { mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { acpFreeScenarios, acpPaidScenarios } from "./acp"
import { runRecorder } from "./lib"

const MODEL = process.env.DEEPSEEK_MODEL ?? "deepseek-flash"

await runRecorder({
  agent: "pi",
  cli: "pi",
  argv: ["npx", "-y", "pi-acp@0.0.34"],
  scenarios: [...acpFreeScenarios({ session: true, keys: true }), ...acpPaidScenarios(new Set(["perm-deny"]))],
  setup: (home) => {
    const dir = join(home, ".pi", "agent")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ defaultProvider: "deepseek", defaultModel: MODEL }, null, 2))
    return { HOME: home, npm_config_cache: join(homedir(), ".npm"), PI_CODING_AGENT_DIR: dir, PI_CODING_AGENT_SESSION_DIR: join(home, "sessions"), PI_TELEMETRY: "0" }
  },
})
