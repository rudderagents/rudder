import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import { acpAcceptsImages, acpPrompt, claudeUserContent, codexTurnInput, imageMediaType, INLINE_IMAGE_LIMIT_BYTES } from "./images"
import type { AdapterImage } from "./types"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function image(name: string, bytes: number): AdapterImage {
  const dir = mkdtempSync(join(tmpdir(), "rudder-img-"))
  dirs.push(dir)
  const path = join(dir, name)
  writeFileSync(path, Buffer.alloc(bytes, 7))
  return { path, mediaType: "image/png", bytes }
}

describe("agent image input", () => {
  test("image names map to a mime type; other files do not", () => {
    expect(imageMediaType("截图 1.PNG")).toBe("image/png")
    expect(imageMediaType("a.jpeg")).toBe("image/jpeg")
    expect(imageMediaType("a.jpg")).toBe("image/jpeg")
    expect(imageMediaType("a.gif")).toBe("image/gif")
    expect(imageMediaType("a.webp")).toBe("image/webp")
    expect(imageMediaType("notes.txt")).toBeUndefined()
    expect(imageMediaType("noext")).toBeUndefined()
  })

  test("Claude and ACP inline a small image and leave a large one as a path", async () => {
    const small = image("shot.png", 4)
    const content = await claudeUserContent("look", [small])
    expect(content).toEqual([
      { type: "text", text: "look" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.alloc(4, 7).toString("base64") } },
    ])
    expect(await claudeUserContent("look", [])).toBe("look")
    expect(await claudeUserContent("look", [{ ...small, bytes: INLINE_IMAGE_LIMIT_BYTES + 1 }])).toBe("look")

    expect(acpAcceptsImages({ agentCapabilities: { promptCapabilities: { image: true } } })).toBe(true)
    expect(acpAcceptsImages({ agentCapabilities: {} })).toBe(false)
    expect(acpAcceptsImages(null)).toBe(false)
    expect(await acpPrompt("look", [small], false)).toEqual([{ type: "text", text: "look" }])
    expect(await acpPrompt("look", [small], true)).toEqual([
      { type: "text", text: "look" },
      { type: "image", mimeType: "image/png", data: Buffer.alloc(4, 7).toString("base64") },
    ])
  })

  test("Codex gets the path as localImage", () => {
    expect(codexTurnInput("look", [{ path: "/tmp/shot.png", mediaType: "image/png", bytes: 4 }])).toEqual([
      { type: "text", text: "look", text_elements: [] },
      { type: "localImage", path: "/tmp/shot.png" },
    ])
  })
})
