// Copilot serves models from several vendors (1.0.105). The phone groups them by vendor and folds each family's older
// versions, so the daemon names the vendor from the id prefix and splits off the version.

const VENDORS: Record<string, string> = {
  claude: "Anthropic",
  gpt: "OpenAI",
  gemini: "Google",
  grok: "xAI",
  kimi: "Moonshot",
  mai: "Microsoft",
}

export type ModelLineage = { vendor: string; family: string; version?: string }

// "claude-opus-4.8-fast" → Anthropic · claude-opus · 4.8. A trailing "fast" is a speed variant of the same family,
// so Opus 4.8 fast folds under Opus. "auto" has no vendor; an unknown prefix is its own vendor, capitalized.
export function modelLineage(id: string): ModelLineage | undefined {
  const tokens = id.toLowerCase().split("-").filter(Boolean)
  const prefix = tokens[0]
  if (!prefix || id === "auto") return undefined
  const vendor = VENDORS[prefix] ?? prefix.charAt(0).toUpperCase() + prefix.slice(1)
  const at = tokens.findIndex((token, index) => index > 0 && /^\d+(\.\d+)*$/.test(token))
  const rest = at < 0 ? tokens : tokens.filter((_, index) => index !== at)
  if (rest.length > 1 && rest[rest.length - 1] === "fast") rest.pop()
  return { vendor, family: rest.join("-"), ...(at < 0 ? {} : { version: tokens[at] }) }
}

// `_meta.copilotUsage` "0.33x" / "14x" → 0.33 / 14 (premium requests per message).
export function copilotMultiplier(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined
  const match = /^\s*(\d+(?:\.\d+)?)\s*x\s*$/i.exec(value)
  if (!match) return undefined
  const multiplier = Number(match[1])
  return Number.isFinite(multiplier) && multiplier >= 0 ? multiplier : undefined
}
