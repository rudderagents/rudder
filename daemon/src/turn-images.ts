// picture files an agent wrote or named during a turn, attached under the reply when the turn ends.
// A path counts when it stays inside the session folder (resolveSafe: no escape, no dot segment), has a picture
// extension, holds at most TURN_IMAGE_LIMIT_BYTES and sniffs as png / jpeg / gif / webp.

import { homedir } from "node:os"
import { basename, extname, isAbsolute, join, relative } from "node:path"
import { readPlainFile } from "./attachments"
import { sniffImage, type ImageMediaType } from "./image-bytes"
import { resolveSafe } from "./workspace"

export const TURN_IMAGE_LIMIT_BYTES = 8 * 1024 * 1024
export const TURN_IMAGE_MAX = 12

const EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"])

// Quotes, brackets, whitespace and CJK punctuation delimit runs. Scan each run once so a run without an
// extension does not restart a greedy path match at every character.
const PATH_RUN = /[^\s`'"()<>[\]{}|，。、；：！？「」『』（）]+/g
const PICTURE_END = /\.(?:png|jpe?g|gif|webp)(?!\.*[\w/-])/gi

/** Picture paths named in `text`, in order. URLs other than `file://` are not files on this computer. */
export function imageMentions(text: string): string[] {
  const out: string[] = []
  for (const [run] of text.matchAll(PATH_RUN)) {
    // Taking the last eligible end preserves the old greedy match. A bare extension has no path prefix.
    let end = 0
    for (const extension of run.matchAll(PICTURE_END)) {
      if (extension.index > 0) end = extension.index + extension[0].length
    }
    if (end === 0) continue
    let path = run.slice(0, end)
    if (/^file:\/\//i.test(path)) path = decodeURIComponent(path.replace(/^file:\/\//i, ""))
    else if (path.includes("://")) continue
    path = path.replace(/^[*_~]+(?=[^/])/, "")
    if (path) out.push(path)
  }
  return out
}

/** What the turn wrote or said, in the order it happened. Text blocks keep their latest text and their first place. */
export class TurnImageScan {
  private readonly sources: ({ path: string } | { text: string })[] = []
  private readonly texts = new Map<string, string>()

  notePaths(paths: string[]) {
    for (const path of paths) if (path) this.sources.push({ path })
  }

  noteText(id: string, text: string) {
    if (!this.texts.has(id)) this.sources.push({ text: id })
    this.texts.set(id, text)
  }

  candidates(): string[] {
    return this.sources.flatMap((source) =>
      "path" in source ? [source.path] : imageMentions(this.texts.get(source.text) ?? ""),
    )
  }
}

export type TurnImage = {
  /** The file's base name, as the phone captions it. */
  fileName: string
  /** Relative to the session folder. */
  sourcePath: string
  mediaType: ImageMediaType
  width: number
  height: number
  bytes: Uint8Array
}

/** The readable pictures among `candidates`, deduplicated by resolved path, at most TURN_IMAGE_MAX. Never throws. */
export async function collectTurnImages(candidates: string[], cwd: string): Promise<TurnImage[]> {
  const seen = new Set<string>()
  const out: TurnImage[] = []
  for (const raw of candidates) {
    if (out.length >= TURN_IMAGE_MAX) break
    const path = absolute(raw.trim(), cwd)
    if (!path || seen.has(path)) continue
    seen.add(path)
    if (!EXTENSIONS.has(extname(path).toLowerCase())) continue
    let safe: string
    try {
      safe = resolveSafe(path, cwd)
    } catch {
      continue
    }
    let data: Uint8Array
    try {
      data = await readPlainFile(safe, TURN_IMAGE_LIMIT_BYTES, [cwd])
    } catch {
      continue
    }
    const sniffed = sniffImage(data)
    if (!sniffed) continue
    out.push({ fileName: basename(safe), sourcePath: relative(cwd, safe), ...sniffed, bytes: data })
  }
  return out
}

function absolute(path: string, cwd: string): string {
  if (!path) return ""
  if (path === "~" || path.startsWith("~/")) return join(homedir(), path.slice(1))
  return isAbsolute(path) ? path : join(cwd, path)
}
