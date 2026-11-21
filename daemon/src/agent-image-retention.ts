// Agent images (`kind:"image"` rows: Codex image generation, turn pictures) are copied into
// `<cwd>/.rudder/attachments/<sessionId>/` and were never removed until the session was deleted. This keeps them to a
// byte budget and an age limit, oldest first. A removed image's row stays; the phone asks for it, gets not_found and
// shows v65 A5's 「这张图在电脑上已经不在了」 placeholder (a picture it already holds keeps showing from its own cache).

import { rm } from "node:fs/promises"
import { attachmentFiles } from "./attachments"
import { REPLAY_MAX_AGE_MS } from "./event-hub"

export type AgentImageRetention = {
  /** Total bytes of agent images kept across every session. */
  budgetBytes: number
  /** An image older than this goes whatever the total. */
  maxAgeMs: number
  /** An image younger than this is never removed: its row may still be replayed to a phone catching up. */
  keepRecentMs: number
  /** Wait after an image is saved before checking, so a turn's burst of images costs one pass. */
  afterWriteDelayMs: number
}

export const AGENT_IMAGE_RETENTION: AgentImageRetention = {
  budgetBytes: 500 * 1024 * 1024,
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,
  keepRecentMs: REPLAY_MAX_AGE_MS,
  afterWriteDelayMs: 60_000,
}

type ImageScope = { sessionId: string; cwd: string }
type Sized = { createdAt: number; path: string; bytes: number }

/**
 * Which images to remove: oldest first, each one past `maxAgeMs` or while the total is over `budgetBytes`. Stops at
 * the first image inside `keepRecentMs`, and everything after it is newer still.
 */
export function pickEvictions<T extends { createdAt: number; bytes: number }>(images: T[], now: number, retention: AgentImageRetention): T[] {
  const sorted = [...images].sort((a, b) => a.createdAt - b.createdAt)
  let total = sorted.reduce((sum, image) => sum + image.bytes, 0)
  const out: T[] = []
  for (const image of sorted) {
    if (image.createdAt > now - retention.keepRecentMs) break
    const expired = image.createdAt < now - retention.maxAgeMs
    if (!expired && total <= retention.budgetBytes) break
    out.push(image)
    total -= image.bytes
  }
  return out
}

/** Looks up retained files against image rows; historical rows for missing files never leave SQLite. */
export async function pruneAgentImages(
  scopes: ImageScope[],
  createdAt: (sessionId: string, attachmentId: string) => number | null,
  now: number,
  retention: AgentImageRetention = AGENT_IMAGE_RETENTION,
): Promise<{ removed: number; freedBytes: number; keptBytes: number }> {
  const sized: Sized[] = []
  for (const { cwd, sessionId } of scopes) {
    const files = await attachmentFiles(cwd, sessionId, (id) => createdAt(sessionId, id))
    for (const { path, bytes, metadata } of files.values()) sized.push({ path, bytes, createdAt: metadata })
  }
  const evict = pickEvictions(sized, now, retention)
  let freedBytes = 0
  let removed = 0
  for (const image of evict) {
    try {
      await rm(image.path, { force: true })
      freedBytes += image.bytes
      removed += 1
    } catch (error) {
      console.warn(`rudderd: could not remove old agent image ${image.path}:`, error)
    }
  }
  const keptBytes = sized.reduce((sum, image) => sum + image.bytes, 0) - freedBytes
  return { removed, freedBytes, keptBytes }
}
