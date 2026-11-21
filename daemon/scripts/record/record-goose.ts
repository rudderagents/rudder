// r66: records `goose acp` on DeepSeek (owner-approved 2026-11-05) through goose's OpenAI-compatible provider.
// GOOSE_PATH_ROOT keeps config, sessions and logs in the temp root, and HOME there keeps the owner's skills
// (~/.claude/skills, which goose loads) out of the recording; GOOSE_MODE approve makes tools ask.
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { acpFreeScenarios, acpPaidScenarios } from "./acp"
import { runRecorder } from "./lib"

const MODEL = process.env.DEEPSEEK_MODEL ?? "deepseek-flash"
const BASE_URL = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com"

await runRecorder({
  agent: "goose",
  cli: "goose",
  argv: ["goose", "acp"],
  scenarios: [...acpFreeScenarios({ session: true, keys: true }), ...acpPaidScenarios()],
  keyExports: ["export OPENAI_API_KEY=\"$DEEPSEEK_API_KEY\""],
  setup: (home) => {
    mkdirSync(join(home, "config"), { recursive: true })
    const config = [
      "GOOSE_PROVIDER: openai",
      `GOOSE_MODEL: ${MODEL}`,
      `OPENAI_HOST: ${BASE_URL}`,
      "OPENAI_BASE_PATH: v1/chat/completions",
      "GOOSE_MODE: approve",
      "",
    ].join("\n")
    writeFileSync(join(home, "config", "config.yaml"), config)
    // OPENAI_BASE_URL from the calling shell would otherwise win over OPENAI_HOST.
    return { HOME: home, OPENAI_BASE_URL: `${BASE_URL}/v1`, OPENAI_HOST: BASE_URL, GOOSE_PATH_ROOT: home, GOOSE_DISABLE_KEYRING: "1", GOOSE_PROVIDER: "openai", GOOSE_MODEL: MODEL, GOOSE_MODE: "approve" }
  },
})
