import { expect, test } from "bun:test"
import { copilotMultiplier, modelLineage } from "./model-vendor"

test("modelLineage: vendor from the prefix, version split off, fast folds into its family", () => {
  expect(modelLineage("claude-opus-5.5")).toEqual({ vendor: "Anthropic", family: "claude-opus", version: "5.5" })
  expect(modelLineage("claude-opus-4.8-fast")).toEqual({ vendor: "Anthropic", family: "claude-opus", version: "4.8" })
  expect(modelLineage("gpt-5.3-codex")).toEqual({ vendor: "OpenAI", family: "gpt-codex", version: "5.3" })
  expect(modelLineage("grok-4.6")).toEqual({ vendor: "xAI", family: "grok", version: "4.6" })
  expect(modelLineage("kimi-k3")).toEqual({ vendor: "Moonshot", family: "kimi-k3" })
  expect(modelLineage("mistral-large-3")).toEqual({ vendor: "Mistral", family: "mistral-large", version: "3" })
  expect(modelLineage("auto")).toBeUndefined()
})

test("copilotMultiplier parses copilotUsage and rejects anything else", () => {
  expect(copilotMultiplier("0.33x")).toBe(0.33)
  expect(copilotMultiplier("30x")).toBe(30)
  expect(copilotMultiplier("1X")).toBe(1)
  expect(copilotMultiplier("free")).toBeUndefined()
  expect(copilotMultiplier(14)).toBeUndefined()
})
