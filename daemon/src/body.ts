// Small request bodies read with a byte cap, for routes that must never buffer up to the server-wide limit.

/**
 * The body as text, or undefined once it passes `limit` bytes. Reads the stream itself, so a chunked body with no
 * Content-Length is cut off at the limit instead of buffered up to the server-wide cap.
 */
export async function readBodyCapped(request: Request, limit: number): Promise<string | undefined> {
  if (!request.body) return ""
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel().catch(() => {})
      return undefined
    }
    chunks.push(value)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}
