import type { ContinuationOffer } from "./adapter/types"

/** The row text when the agent gave no summary of what woke it. */
export const CONTINUE_FALLBACK = "后台任务完成"

/** The send identity's clientMessageId: a repeat of the same offer meets the existing send receipt and opens nothing. */
export function continuationClientId(offer: ContinuationOffer): string {
  return `agent-continue:${offer.identity.generation}:${offer.key}`
}
