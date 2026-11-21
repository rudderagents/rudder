import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { collectTurnImages, imageMentions, TURN_IMAGE_LIMIT_BYTES, TURN_IMAGE_MAX, TurnImageScan } from "./turn-images"

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVQI12P4z8AAAAADAAEABf4C/tzMWecAAAAASUVORK5CYII=",
  "base64",
)

describe("imageMentions", () => {
  test("finds a picture after long uninterrupted non-image text", () => {
    const text = `${"a".repeat(40_000)} shots/a.png`
    const started = performance.now()
    const result = imageMentions(text)
    expect(result).toEqual(["shots/a.png"])
    // Keep a wide margin for slow test hosts while catching the old quadratic scan.
    expect(performance.now() - started).toBeLessThan(250)
  })

  test("keeps the last eligible extension in each run of path characters", () => {
    expect(imageMentions(".png a.png!!b.GIF c.jpeg...? d.png...tail")).toEqual(["a.png!!b.GIF", "c.jpeg"])
  })

  test("picks paths out of prose, markdown and CJK punctuation", () => {
    const text = [
      "截了一张：shots/home-se.png。",
      "And `out/chart.JPG`, ![x](docs/a b/../poster.webp) plus **bold.gif**.",
      "Not https://example.com/logo.png, not notes.png.bak, not dir.png/inner.",
      "file:///tmp/abs%20x.jpeg",
    ].join("\n")
    // A path with a space is cut at the space: only its tail is taken (and then resolves to nothing).
    expect(imageMentions(text)).toEqual(["shots/home-se.png", "out/chart.JPG", "b/../poster.webp", "bold.gif", "/tmp/abs x.jpeg"])
  })
})

describe("TurnImageScan", () => {
  test("keeps the order things happened in and the latest text of each block", () => {
    const scan = new TurnImageScan()
    scan.noteText("t1", "first a.png")
    scan.notePaths(["written.png"])
    scan.noteText("t1", "first a.png then b.png")
    scan.noteText("t2", "c.png")
    expect(scan.candidates()).toEqual(["a.png", "b.png", "written.png", "c.png"])
  })
})

describe("collectTurnImages", () => {
  function folder() {
    const root = mkdtempSync(join(tmpdir(), "rudder-turnimg-"))
    const cwd = join(root, "work")
    mkdirSync(join(cwd, "shots"), { recursive: true })
    return { root, cwd }
  }

  test("reads pictures inside the folder once each, in order, and skips the rest", async () => {
    const { root, cwd } = folder()
    try {
      writeFileSync(join(cwd, "shots", "home-se.png"), PNG)
      writeFileSync(join(cwd, "b.png"), PNG)
      writeFileSync(join(cwd, "fake.png"), "not a picture")
      writeFileSync(join(cwd, "notes.txt"), PNG)
      writeFileSync(join(root, "outside.png"), PNG)
      mkdirSync(join(cwd, ".hidden"))
      writeFileSync(join(cwd, ".hidden", "secret.png"), PNG)
      writeFileSync(join(cwd, "huge.png"), Buffer.concat([PNG, Buffer.alloc(TURN_IMAGE_LIMIT_BYTES)]))
      symlinkSync(join(root, "outside.png"), join(cwd, "link.png"))
      const images = await collectTurnImages(
        [
          "shots/home-se.png",
          join(cwd, "b.png"),
          "./shots/home-se.png",
          "fake.png",
          "notes.txt",
          "../outside.png",
          join(root, "outside.png"),
          ".hidden/secret.png",
          "huge.png",
          "link.png",
          "missing.png",
        ],
        cwd,
      )
      expect(images.map((image) => [image.fileName, image.sourcePath, image.mediaType, image.width])).toEqual([
        ["home-se.png", join("shots", "home-se.png"), "image/png", 1],
        ["b.png", "b.png", "image/png", 1],
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("stops at the cap", async () => {
    const { root, cwd } = folder()
    try {
      const names = Array.from({ length: TURN_IMAGE_MAX + 3 }, (_, i) => `p${i}.png`)
      for (const name of names) writeFileSync(join(cwd, name), PNG)
      const images = await collectTurnImages(names, cwd)
      expect(images.map((image) => image.fileName)).toEqual(names.slice(0, TURN_IMAGE_MAX))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
