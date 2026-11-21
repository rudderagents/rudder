import { Resolver } from "node:dns/promises"
import { type HostCandidate, hostCandidates } from "./tls"

/** Tailscale's MagicDNS server; it answers PTR queries for tailnet IPs with the node's `*.ts.net` name. */
const MAGIC_DNS = "100.100.100.100"
const LOOKUP_TIMEOUT_MS = 1000

export type ReverseLookup = (address: string) => Promise<string[]>

function magicDnsReverse(address: string): Promise<string[]> {
  const resolver = new Resolver({ timeout: LOOKUP_TIMEOUT_MS, tries: 1 })
  resolver.setServers([MAGIC_DNS])
  return resolver.reverse(address)
}

/**
 * This machine's MagicDNS name (`mac-studio.tailxxxx.ts.net`), or null when it has no Tailscale address or MagicDNS
 * does not answer for it (MagicDNS off, Tailscale stopped). The phone can only use a tailnet by this name: iOS ATS
 * blocks pinned self-signed TLS to `100.x` IPs.
 */
export async function resolveTailnetName(
  candidates: HostCandidate[] = hostCandidates(),
  reverse: ReverseLookup = magicDnsReverse,
): Promise<string | null> {
  const address = candidates.find((candidate) => candidate.kind === "tailscale")?.address
  if (!address) return null
  try {
    const names = await reverse(address)
    const name = names.map((entry) => entry.toLowerCase().replace(/\.$/, "")).find((entry) => entry.endsWith(".ts.net"))
    return name ?? null
  } catch {
    // No answer is the normal state of a machine without MagicDNS; the link then carries only LAN hosts.
    return null
  }
}

/** The last resolved MagicDNS name, refreshed in the background because Tailscale comes and goes. */
export class TailnetName {
  private name: string | null = null

  constructor(private readonly resolve: () => Promise<string | null> = () => resolveTailnetName()) {}

  get current(): string | null {
    return this.name
  }

  async refresh(): Promise<string | null> {
    this.name = await this.resolve()
    return this.name
  }

  /** Re-resolves every `intervalMs` without keeping the process alive; returns the stop function. */
  watch(intervalMs: number): () => void {
    const timer = setInterval(() => void this.refresh(), intervalMs)
    timer.unref?.()
    return () => clearInterval(timer)
  }
}
