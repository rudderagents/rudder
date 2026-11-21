import { expect, test } from "bun:test"
import { decideTurnHealth, type TurnHealthSnapshot } from "./turn-health"

const timings = { checkMs: 30_000, afterSpeechMs: 20_000, silentMs: 300_000 }
const base: TurnHealthSnapshot = {
  identity: { sessionId: "s", turnId: "t", generation: 0, agentId: "codex" },
  lastEventAt: 0, lastProgressAt: 0, lastCheckAt: 0, retryUntil: 0,
  waiting: false, openTools: 0, openBackground: 0, pendingFinalization: false, transport: "unknown",
}

test("silence without terminal evidence only requests inspection", () => {
  expect(decideTurnHealth(base, 21_000, timings)).toBe("continue")
  expect(decideTurnHealth({ ...base, lastCheckAt: 290_000 }, 301_000, timings)).toBe("inspect")
})

test("work and pending finalization survive a long quiet interval", () => {
  for (const patch of [{ waiting: true }, { openTools: 1 }, { openBackground: 1 }, { pendingFinalization: true }, { retryUntil: 400_000 }]) {
    expect(decideTurnHealth({ ...base, lastCheckAt: 290_000, ...patch }, 301_000, timings)).toBe("continue")
  }
})

test("confirmed terminal can finish, confirmed closed transport can fail", () => {
  expect(decideTurnHealth({ ...base, transport: "closed" }, 1, timings)).toBe("fail_transport")
  expect(decideTurnHealth({ ...base, terminalStatus: "completed", transport: "closed" }, 1, timings)).toBe("finish_terminal")
})

test("a large scheduler gap or backward clock is not model silence", () => {
  expect(decideTurnHealth(base, 5_000_000, timings)).toBe("inspect")
  expect(decideTurnHealth({ ...base, lastEventAt: 1000 }, 0, timings)).toBe("continue")
})

test("known terminal keeps local drain alive after pipe closure", () => {
  expect(decideTurnHealth({ ...base, terminalStatus: "completed", pendingFinalization: true, transport: "closed" }, 1, timings)).toBe("continue")
})

test("open background work never vetoes a closed transport", () => {
  expect(decideTurnHealth({ ...base, openBackground: 1, transport: "closed" }, 1, timings)).toBe("fail_transport")
  expect(decideTurnHealth({ ...base, openBackground: 1, openTools: 1, waiting: true, transport: "closed" }, 1, timings)).toBe("fail_transport")
})
