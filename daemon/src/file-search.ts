/**
 * Whether the bytes of `stream` contain `needle` (UTF-8), reading one chunk at a time: only the chunk and the tail of
 * the one before it (a needle can straddle the cut) are held, never the whole input.
 */
export async function streamContains(stream: AsyncIterable<Uint8Array>, needle: string): Promise<boolean> {
  const target = Buffer.from(needle, "utf8")
  if (target.length === 0) return true
  let carry = Buffer.alloc(0)
  for await (const chunk of stream) {
    const window = carry.length > 0 ? Buffer.concat([carry, chunk]) : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    if (window.indexOf(target) !== -1) return true
    carry = Buffer.from(window.subarray(Math.max(0, window.length - (target.length - 1))))
  }
  return false
}

/** `streamContains` over the file at `path`; false when it can't be read (said in the log, review3-1117). */
export async function fileContains(path: string, needle: string): Promise<boolean> {
  const file = Bun.file(path)
  if (!(await file.exists())) return false
  try {
    return await streamContains(file.stream(), needle)
  } catch (error) {
    console.warn(`rudderd: searching ${path} failed:`, error instanceof Error ? error.message : error)
    return false
  }
}
