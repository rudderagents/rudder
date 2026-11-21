import { describe, expect, test } from "bun:test"
import { parsePsStarts, systemProbe } from "./claude-registry"

describe("system probe prefetch", () => {
  test("parsePsStarts reads pid and start time per line", () => {
    expect(parsePsStarts("  123 Wed Nov 19 09:01:34 2026\n 4567 Thu  Nov  6 10:00:00 2026\n")).toEqual(
      new Map([
        [123, "Wed Nov 19 09:01:34 2026"],
        [4567, "Thu Nov 6 10:00:00 2026"],
      ]),
    )
  })

  test("a prefetched pid needs no synchronous ps", async () => {
    let sync = 0
    const probe = systemProbe({
      sync: () => {
        sync += 1
        return "x"
      },
      batch: async () => `${process.pid} Wed Nov 19 09:01:34 2026\n`,
    })
    await probe.prefetch!([process.pid])
    expect(probe.startTime(process.pid)).toBe("Wed Nov 19 09:01:34 2026")
    expect(sync).toBe(0)
  })

  test("an unprefetched pid still falls back to a synchronous check", () => {
    let sync = 0
    const probe = systemProbe({
      sync: () => {
        sync += 1
        return "Mon Jan 1 00:00:00 2026"
      },
      batch: async () => "",
    })
    expect(probe.startTime(4242)).toBe("Mon Jan 1 00:00:00 2026")
    expect(sync).toBe(1)
  })

  test("a dead pid is not handed to ps", async () => {
    const asked: number[][] = []
    const probe = systemProbe({
      sync: () => null,
      batch: async (pids) => {
        asked.push([...pids])
        return ""
      },
    })
    await probe.prefetch!([2_147_483_646])
    expect(asked).toEqual([])
    await probe.prefetch!([2_147_483_646, process.pid])
    expect(asked).toEqual([[process.pid]])
  })
})
