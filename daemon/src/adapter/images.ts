import { readPlainFile } from "../attachments"
import type { Json } from "./json"
import type { AdapterImage } from "./types"

/**
 * Raw-byte cap for an image pasted into a JSON line (Claude stream-json, ACP).
 * Base64 grows by 4/3, and one stdio line stops at MAX_LINE_LENGTH (16M chars), so keep this under 12MB. Codex gets a path instead, so it is not capped here.
 */
export const INLINE_IMAGE_LIMIT_BYTES = 8 * 1024 * 1024

const IMAGE_MEDIA: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
}

/** MIME type for an image the agent can be shown directly. Other files stay a path in the text. */
export function imageMediaType(name: string): string | undefined {
  const dot = name.lastIndexOf(".")
  if (dot < 0 || dot === name.length - 1) return undefined
  return IMAGE_MEDIA[name.slice(dot + 1).toLowerCase()]
}

/** Claude stream-json user content: a string, or text plus image blocks when there is something to show. */
export async function claudeUserContent(text: string, images: AdapterImage[]): Promise<string | Json[]> {
  const blocks = await inlineBlocks(images, (image, data) => ({
    type: "image",
    source: { type: "base64", media_type: image.mediaType, data },
  }))
  if (blocks.length === 0) return text
  if (text) blocks.unshift({ type: "text", text })
  return blocks
}

/** Codex `turn/start` input. `localImage` is a path on this computer; Codex opens the file itself. */
export function codexTurnInput(text: string, images: AdapterImage[] = []) {
  return [
    { type: "text", text, text_elements: [] as unknown[] },
    ...images.map((image) => ({ type: "localImage", path: image.path })),
  ]
}

/** True when this ACP `initialize` result advertised `promptCapabilities.image`. */
export function acpAcceptsImages(init: unknown): boolean {
  if (!init || typeof init !== "object") return false
  const caps = (init as { agentCapabilities?: { promptCapabilities?: { image?: unknown } } }).agentCapabilities
  return caps?.promptCapabilities?.image === true
}

/** ACP `session/prompt` blocks. Image blocks only when the agent said it accepts them. */
export async function acpPrompt(text: string, images: AdapterImage[], acceptsImages: boolean): Promise<Json[]> {
  const blocks: Json[] = [{ type: "text", text }]
  if (!acceptsImages) return blocks
  blocks.push(
    ...(await inlineBlocks(images, (image, data) => ({
      type: "image",
      mimeType: image.mediaType,
      data,
    }))),
  )
  return blocks
}

async function inlineBlocks(images: AdapterImage[], block: (image: AdapterImage, data: string) => Json): Promise<Json[]> {
  const blocks: Json[] = []
  for (const image of images) {
    if (image.bytes > INLINE_IMAGE_LIMIT_BYTES) continue
    // A symlink, a vanished file, or one that grew past the cap is left as the path in the text.
    const data = await readPlainFile(image.path, INLINE_IMAGE_LIMIT_BYTES).catch(() => null)
    if (!data) continue
    blocks.push(block(image, Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("base64")))
  }
  return blocks
}
