// r66: records `qwen --acp` on DeepSeek (owner-approved 2026-11-05). See lib.ts / acp.ts.
// HOME points at the temp root, so ~/.qwen there is the only settings file Qwen Code reads; the key comes in as
// OPENAI_API_KEY from the test key file.
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { acpFreeScenarios, acpPaidScenarios } from "./acp"
import { type Frame, runRecorder } from "./lib"

const MODEL = process.env.DEEPSEEK_MODEL ?? "deepseek-flash"
const BASE_URL = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com"

await runRecorder({
  agent: "qwen",
  cli: "qwen",
  argv: ["qwen", "--acp"],
  scenarios: [...acpFreeScenarios({ session: true, keys: true }), ...acpPaidScenarios()],
  // Every session/new and session/load announces the commands with every skill's full text in
  // `_meta.availableSkillDetails` (about 600 KB); `models` keeps it whole.
  elide: (frame, scenario) => {
    const params = frame.params as Frame | undefined
    const update = params?.update as Frame | undefined
    const meta = update?._meta as Frame | undefined
    if (scenario.name === "models" || update?.sessionUpdate !== "available_commands_update" || !meta?.availableSkillDetails) return undefined
    return {
      frame: { ...frame, params: { ...params, update: { ...update, _meta: { ...meta, availableSkillDetails: "<elided, see models.jsonl>" } } } },
      note: "session/update available_commands_update._meta.availableSkillDetails",
    }
  },
  keyExports: ["export OPENAI_API_KEY=\"$DEEPSEEK_API_KEY\""],
  setup: (home) => {
    mkdirSync(join(home, ".qwen"))
    writeFileSync(join(home, ".qwen", "settings.json"), JSON.stringify({ security: { auth: { selectedType: "openai" } }, model: { name: MODEL } }, null, 2))
    return { HOME: home, OPENAI_BASE_URL: `${BASE_URL}/v1`, OPENAI_MODEL: MODEL }
  },
})
