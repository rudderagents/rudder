import { statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { createAcpAdapter, type AcpAdapterOptions } from "./acp"
import { createClaudeAdapter } from "./claude"
import { codexCatalogWindow, createCodexAdapter } from "./codex"
import { createFakeAdapter } from "./fake"
import { grokPermissionLock } from "./grok-config"
import { ACP_ASK, ACP_PLAN, CLAUDE_MODES, CODEX_MODES, COPILOT_BYPASS_MODE, GROK_BYPASS_MODE, capabilityModes, modesForAutoApproval } from "./modes"
import { phoneCopy } from "../phone-copy"
import { type AgentAdapter, type AgentCapabilities, type AgentSpec, type Availability, unavailable } from "./types"
import { upgradeCommandFor } from "./upgrade"
import { binaryStamp, cachedCliVersion, resolvedBinary, versionArgv } from "./version"

export type { AgentAdapter, AgentEvent } from "./types"

export type AdapterRegistry = {
  get(agentId: string): AgentAdapter | undefined
  list(): AgentAdapter[]
}

export const DETECT_TTL_MS = 60_000
// 2026-11-12 (perf-1112 R6): Claude's probe cold-starts a whole CLI (2.0–2.3 s, about 310 MB), and every hello and
// every turn asked again once the minute was up. A "yes" now holds for half an hour unless the binary or the
// credentials file changes, or a turn fails on sign-in (forgetDetect); a "no" still expires after a minute.
export const CLAUDE_DETECT_TTL_MS = 30 * 60_000

type BuiltinAgent = {
  spec: AgentSpec
  // Launch line; command[0] is what the default availability check looks up on PATH.
  command: string[]
  create: (spec: AgentSpec, command: string[]) => AgentAdapter
  // For a detect that starts a process of its own each time: how long a "yes" holds, and what ends it sooner.
  detectCache?: Pick<DetectCacheOptions, "availableTtlMs" | "stamp">
}

/** Claude's credentials file (Linux, Windows; macOS keeps them in the Keychain) and binary, as one stamp. */
function claudeStamp(command: string): () => string {
  return () => {
    const dir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")
    let credentials = 0
    try {
      credentials = statSync(join(dir, ".credentials.json")).mtimeMs
    } catch {}
    return `${binaryStamp(command)}|${credentials}`
  }
}

// Capabilities follow the agent protocol notes.
const ACP_EXPERIMENTAL: AgentCapabilities = {
  reasoning: true,
  steer: false,
  interrupt: true,
  plan: true,
  question: false,
  usage: "none",
  models: "dynamic",
  efforts: false,
  ...capabilityModes([ACP_ASK]),
}

function acpAgent(
  id: string,
  label: string,
  command: string[],
  capabilities: AgentCapabilities,
  experimental: boolean,
  extra: Pick<AcpAdapterOptions, "expectAgent" | "cumulativeUsage" | "probeSession" | "requires" | "credentialFiles" | "permissionLock"> = {},
): BuiltinAgent {
  return {
    spec: { id, label, transport: "acp", experimental, capabilities },
    command,
    create: (spec, argv) => createAcpAdapter({ spec, command: argv, ...extra }),
  }
}

export const BUILTIN_AGENTS: BuiltinAgent[] = [
  {
    spec: {
      id: "claude",
      label: "Claude Code",
      transport: "claude",
      experimental: false,
      // The launch passes --permission-mode manual (CHANGELOG 2.1.200); every other flag and control request is older.
      minimumVersion: "2.1.200",
      capabilities: {
        reasoning: true,
        // stream-json takes another user line on the live turn (`steer()`), so the phone offers 插话.
        // A busy message.send still goes to the daemon queue: this flag only feeds steerControl.
        steer: true,
        interrupt: true,
        plan: true,
        question: true,
        usage: "both",
        models: "dynamic",
        efforts: true,
        ...capabilityModes(CLAUDE_MODES),
      },
    },
    command: [process.env.RUDDER_CLAUDE_BIN ?? "claude"],
    create: (spec, command) => createClaudeAdapter({ spec, command: command[0] }),
    detectCache: { availableTtlMs: CLAUDE_DETECT_TTL_MS, stamp: claudeStamp(process.env.RUDDER_CLAUDE_BIN ?? "claude") },
  },
  {
    spec: {
      id: "codex",
      label: "Codex",
      transport: "codex",
      experimental: false,
      // thread/fork with excludeTurns (rust-v0.129.0, openai/codex 5affb7f9d5); thread/revert (0.148) is optional.
      minimumVersion: "0.129.0",
      capabilities: {
        reasoning: true,
        steer: true,
        interrupt: true,
        // turn/plan/updated {plan: [{step, status}]} is in the app-server v2 schema (0.163.0).
        plan: true,
        question: true,
        usage: "both",
        models: "dynamic",
        efforts: true,
        ...capabilityModes(CODEX_MODES),
      },
    },
    // Codex asks with request_user_input outside plan mode only with this feature (0.169).
    command: ["codex", "app-server", "-c", "features.default_mode_request_user_input=true"],
    create: (spec, command) => createCodexAdapter({ spec, command, catalogWindow: codexCatalogWindow }),
  },
  acpAgent(
    "grok",
    "Grok",
    ["grok", "agent", "stdio"],
    {
      reasoning: true,
      steer: false,
      interrupt: true,
      plan: true,
      question: true,
      usage: "tokens",
      models: "dynamic",
      efforts: true,
      ...capabilityModes(modesForAutoApproval([ACP_PLAN, GROK_BYPASS_MODE])),
      autoApproval: true,
    },
    false,
    // `grok login` rewrites this; the agent process reads it only at launch.
    { credentialFiles: [join(homedir(), ".grok", "auth.json")], permissionLock: () => grokPermissionLock() },
  ),
  acpAgent(
    "copilot",
    "Copilot",
    ["copilot", "--acp", "--stdio", "--no-auto-update"],
    {
      reasoning: true,
      steer: false,
      interrupt: true,
      plan: true,
      question: false,
      usage: "both",
      models: "static",
      // reasoning_effort (thought_level): low · medium · high · xhigh · max.
      efforts: true,
      // initialize says promptCapabilities.image: true (1.0.105).
      images: true,
      ...capabilityModes([{ ...ACP_ASK, native: "agent" }, ACP_PLAN, COPILOT_BYPASS_MODE]),
    },
    false,
    // PromptResponse.usage is cumulative over the live session; the adapter diffs it per turn.
    // The 403 for accounts without Copilot CLI access only shows at session/new, so detect probes it.
    { cumulativeUsage: true, probeSession: true },
  ),
  // `agent` is also Grok's alias (~/.grok/bin/agent -> grok); only a self-reported Cursor counts.
  // images: true only where initialize was seen to say promptCapabilities.image (2026-10-31: goose 1.57.0,
  // Qwen Code 0.26.3, pi-acp 0.0.34). Cursor did not answer; opencode, Kimi and Gemini were not installed.
  acpAgent("cursor", "Cursor", ["agent", "acp"], ACP_EXPERIMENTAL, true, { expectAgent: /cursor/i }),
  acpAgent("opencode", "opencode", ["opencode", "acp"], ACP_EXPERIMENTAL, true),
  acpAgent("kimi", "Kimi", ["kimi", "acp"], ACP_EXPERIMENTAL, true),
  // 2026-10-30. Gemini CLI signs in with Google (or GEMINI_API_KEY); goose takes the provider in ~/.config/goose;
  // Qwen Code reads OPENAI_* from ~/.qwen/.env. Each lists its own permission modes over ACP.
  acpAgent("gemini", "Gemini CLI", ["gemini", "--acp"], ACP_EXPERIMENTAL, true, { expectAgent: /gemini/i }),
  acpAgent("goose", "goose", ["goose", "acp"], { ...ACP_EXPERIMENTAL, images: true }, true, { expectAgent: /goose/i }),
  acpAgent("qwen", "Qwen Code", ["qwen", "--acp"], { ...ACP_EXPERIMENTAL, images: true }, true, { expectAgent: /qwen/i }),
  // Pinned so a launch never pulls an unreviewed release; pi-acp itself runs `pi --mode rpc`.
  acpAgent("pi", "pi", ["npx", "-y", "pi-acp@0.0.34"], { ...ACP_EXPERIMENTAL, reasoning: false, images: true }, true, { requires: ["pi"] }),
]

// RUDDER_ADAPTER=fake resolves every built-in agent to the fake adapter (dev and simulator demos).
export function createAdapterRegistry(mode = process.env.RUDDER_ADAPTER): AdapterRegistry {
  const adapters = BUILTIN_AGENTS.map((entry) =>
    mode === "fake"
      ? createFakeAdapter({ ...entry.spec, transport: "fake", capabilities: { ...entry.spec.capabilities, autoApproval: false } })
      : withCachedVersion(withCachedDetect(entry.create(entry.spec, entry.command), entry.command[0], entry.detectCache), entry.command),
  )
  const byId = new Map(adapters.map((adapter) => [adapter.spec.id, adapter]))
  return {
    get: (agentId) => byId.get(agentId),
    list: () => adapters,
  }
}

// One adapter answers for every agent id.
export function singleAdapterRegistry(adapter: AgentAdapter): AdapterRegistry {
  return { get: () => adapter, list: () => [adapter] }
}

export function commandAvailability(command: string): Availability {
  return Bun.which(command) ? { available: true } : unavailable(phoneCopy.commandMissing(command))
}

export type DetectCacheOptions = {
  /** How long an answer holds. */
  ttlMs?: number
  /** How long an "available" answer holds; defaults to ttlMs. */
  availableTtlMs?: number
  /** Read on every call; a different value from the cached answer's drops it (binary or credentials changed). */
  stamp?: () => string
}

export type CachedDetect = (() => Promise<Availability>) & { forget(): void }

export function cachedDetect(detect: () => Promise<Availability>, options: DetectCacheOptions = {}): CachedDetect {
  const ttlMs = options.ttlMs ?? DETECT_TTL_MS
  const availableTtlMs = options.availableTtlMs ?? ttlMs
  let cached: { at: number; stamp: string; value: Promise<Availability>; settled?: Availability } | undefined
  const read = () => {
    const now = Date.now()
    const stamp = options.stamp?.() ?? ""
    const ttl = cached?.settled?.available ? availableTtlMs : ttlMs
    if (!cached || cached.stamp !== stamp || now - cached.at >= ttl) {
      const entry: NonNullable<typeof cached> = {
        at: now,
        stamp,
        value: detect().catch((error: unknown) => ({
          available: false,
          reason: error instanceof Error ? error.message : String(error),
        })),
      }
      void entry.value.then((value) => {
        entry.settled = value
      })
      cached = entry
    }
    return cached.value
  }
  return Object.assign(read, {
    forget() {
      cached = undefined
    },
  })
}

function withCachedDetect(adapter: AgentAdapter, command: string | undefined, cache: DetectCacheOptions = {}): AgentAdapter {
  const own = adapter.detect?.bind(adapter)
  const detect = own ?? (command ? async () => commandAvailability(command) : undefined)
  if (detect) {
    const cached = cachedDetect(detect, cache)
    adapter.detect = cached
    adapter.forgetDetect = cached.forget
  }
  return adapter
}

// Attaches a lazy `--version` probe. Nothing is spawned until hello asks; the first hello does not wait for it.
function withCachedVersion(adapter: AgentAdapter, command: string[]): AgentAdapter {
  if (adapter.version || command.length === 0) return adapter
  const argv = versionArgv(command)
  if (argv.length > 0) adapter.version = cachedCliVersion(argv)
  const bin = command[0]
  if (bin && bin !== "npx") adapter.upgradeCommand = () => upgradeCommandFor(adapter.spec.id, resolvedBinary(bin))
  return adapter
}
