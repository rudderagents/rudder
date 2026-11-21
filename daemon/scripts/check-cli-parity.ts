import { resolve } from "node:path"
import { createAdapterRegistry } from "../src/adapter"
import { redactSecrets } from "../src/adapter/redact"
import type { AgentAdapter } from "../src/adapter/types"

type Discovery = { state: "discovered" | "failed" | "unsupported"; count?: number; graphify?: boolean; error?: string }
export type CliParityReport = {
  cwd: string
  behavioralVerification: "not-run"
  agents: { agent: string; nativePermissions: boolean; skills: Discovery }[]
}

/** Takes ownership of fresh diagnostic adapters; never pass a resident session's adapters. */
export async function checkCliParity(ownedAdapters: readonly AgentAdapter[], cwd: string, timeoutMs = 25_000): Promise<CliParityReport> {
  try {
    const agents = await Promise.all(ownedAdapters.map(async adapter => {
      const base = { agent: adapter.spec.id, nativePermissions: adapter.spec.capabilities.permissionModes?.includes("native") ?? false }
      if (!adapter.listCommands) return { ...base, skills: { state: "unsupported" as const } }
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const commands = await Promise.race([
          adapter.listCommands(cwd),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Native catalogue discovery timed out")), timeoutMs) }),
        ])
        return { ...base, skills: { state: "discovered" as const, count: commands.length, graphify: commands.some(command => command.name === "graphify") } }
      } catch (error) {
        return { ...base, skills: { state: "failed" as const, error: redactSecrets(error instanceof Error ? error.message : String(error)) } }
      } finally {
        clearTimeout(timer)
      }
    }))
    return { cwd, behavioralVerification: "not-run", agents }
  } finally {
    const cleanup = await Promise.allSettled(ownedAdapters.map(adapter => adapter.dispose?.()))
    const failure = cleanup.find(result => result.status === "rejected")
    if (failure?.status === "rejected") throw new Error(`Native diagnostic cleanup failed: ${redactSecrets(String(failure.reason))}`)
  }
}

if (import.meta.main) {
  const registry = createAdapterRegistry("real")
  const adapters = ["claude", "codex"].map(id => registry.get(id)!).filter(Boolean)
  const report = await checkCliParity(adapters, resolve(process.argv[2] || process.cwd()))
  console.log(JSON.stringify(report, null, 2))
  if (report.agents.some(agent => agent.skills.state === "failed")) process.exitCode = 1
}
