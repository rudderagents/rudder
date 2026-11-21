import type { TurnExecutionIdentity } from "./turn-termination"
export type TurnGuardTimings = { checkMs: number; afterSpeechMs: number; silentMs: number }
export type TurnHealthSnapshot = {
  identity: TurnExecutionIdentity
  lastEventAt: number
  lastProgressAt: number
  lastCheckAt: number
  retryUntil: number
  waiting: boolean
  openTools: number
  openBackground: number
  pendingFinalization: boolean
  terminalStatus?: "completed" | "interrupted" | "failed"
  transport: "open" | "closed" | "unknown"
  // The agent's own words for the closed transport (its exit line), for the failed turn's reason.
  closeDetail?: string
}
export function decideTurnHealth(s: TurnHealthSnapshot, now: number, t: TurnGuardTimings): "continue" | "inspect" | "finish_terminal" | "fail_transport" {
  if (s.terminalStatus) return s.pendingFinalization ? "continue" : "finish_terminal"
  if (s.transport === "closed") return "fail_transport"
  if (s.waiting || s.openTools > 0 || s.openBackground > 0 || s.pendingFinalization || now <= s.retryUntil) return "continue"
  if (now - s.lastCheckAt > t.checkMs * 2) return "inspect"
  return Math.max(0, now - Math.max(s.lastEventAt, s.lastProgressAt, s.retryUntil)) > t.silentMs ? "inspect" : "continue"
}
