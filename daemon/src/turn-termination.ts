import { createHash } from "node:crypto"
export type TurnTerminationCause =
  | "user_stop" | "background_stop" | "queue_promote" | "session_removed" | "agent_switch"
  | "daemon_shutdown" | "restart_recovery" | "watchdog" | "transport_closed"
  | "engine_error" | "auth_required" | "usage_limit" | "unknown"
  // Plan 2026-11-18: the turn ended without the agent's own end signal (no idle frame to wait for), on quiet or a cap.
  | "inferred_quiet"

export type TurnExecutionIdentity = {
  sessionId: string
  turnId: string
  generation: number
  agentId: string
  agentVersion?: string
  nativeSessionId?: string
  nativeTurnId?: string
}

export type TurnTermination = {
  cause: TurnTerminationCause
  requestedAt: number
  engine?: TurnExecutionIdentity
  evidence?: {
    lastEventAt?: number
    lastProgressAt?: number
    quietMs?: number
    checkGapMs?: number
    trigger?: "short" | "long"
    transport?: "open" | "closed" | "unknown"
  }
}

const EXPLICIT = new Set<TurnTerminationCause>(["user_stop", "background_stop", "queue_promote", "session_removed", "agent_switch"])

export function recordTermination(current: TurnTermination | undefined, incoming: TurnTermination): TurnTermination {
  if (!current || (EXPLICIT.has(incoming.cause) && !EXPLICIT.has(current.cause))) return incoming
  return current
}

export function restartCandidate(turn: { id: string; phase: string; updatedAt: number; outcome?: { termination?: TurnTermination } }, now: number, enabled: boolean, windowMs = 1_800_000): boolean {
  const cause = turn.outcome?.termination?.cause
  return enabled && turn.phase === "interrupted" && (cause === "daemon_shutdown" || cause === "restart_recovery")
    && now >= turn.updatedAt && now - turn.updatedAt <= windowMs
}

export function restartMessageId(turnId: string, generation: number): string {
  const hex = createHash("sha256").update(`restart:${turnId}:${generation}`).digest("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}
