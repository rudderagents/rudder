import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { classifyAgentFailure, loginCommand, stderrTail, unavailableCode } from "./adapter/agent-error"
import { codexErrorInfo } from "./adapter/codex"
import { createFakeAdapter } from "./adapter/fake"
import type { Frame } from "./protocol"
import { SessionService } from "./session-service"
import { Store } from "./store"
import { WORKSPACE_ROOT } from "./workspace"

async function waitFor(predicate: () => boolean, timeoutMs = 3000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out")
    await Bun.sleep(10)
  }
}

describe("classifyAgentFailure", () => {
  test("Claude's usage limit carries its reset time", () => {
    expect(classifyAgentFailure("claude", "Claude AI usage limit reached|1761944400")).toEqual({
      code: "usage_limit",
      resetsAt: 1761944400_000,
    })
    expect(classifyAgentFailure("codex", "You've hit your usage limit.")).toEqual({ code: "usage_limit" })
  })

  test("a signed-out agent names its login command when it is certain", () => {
    expect(classifyAgentFailure("codex", "401 Unauthorized")).toEqual({ code: "auth_required", command: "codex login" })
    expect(classifyAgentFailure("claude", "Invalid API key · Please run /login")).toEqual({ code: "auth_required" })
    expect(loginCommand("copilot", "Not signed in. Run `copilot login` first")).toBe("copilot login")
  })

  test("a process that died keeps its exit code and the tail of stderr", () => {
    const stderr = Array.from({ length: 9 }, (_, index) => `line ${index + 1}`).join("\n")
    expect(classifyAgentFailure("claude", `Claude exited with code 1 before the turn finished: ${stderr}`)).toEqual({
      code: "agent_exited",
      exitCode: 1,
      detail: "line 4\nline 5\nline 6\nline 7\nline 8\nline 9",
    })
    expect(stderrTail("\n\n")).toBeUndefined()
  })

  test("anything else stays a plain error", () => {
    expect(classifyAgentFailure("claude", "ENOENT: no such file")).toBeUndefined()
  })

  test("detect reasons map to unavailableCode", () => {
    expect(unavailableCode("未找到命令 codex")).toBe("not_installed")
    expect(unavailableCode("Codex 未登录：在电脑上运行 codex login")).toBe("auth_required")
    expect(unavailableCode('403 "unauthorized: not authorized to use Copilot CLI"')).toBe("auth_required")
    expect(unavailableCode("spawn failed")).toBe("failed")
  })

  test("Codex codexErrorInfo, as a string or a one-key object", () => {
    expect(codexErrorInfo({ message: "limit", codexErrorInfo: "usageLimitExceeded" })).toEqual({ code: "usage_limit" })
    expect(codexErrorInfo({ codexErrorInfo: { unauthorized: {} } })).toEqual({ code: "auth_required", command: "codex login" })
    expect(codexErrorInfo({ codexErrorInfo: "other" })).toBeUndefined()
    expect(codexErrorInfo(null)).toBeUndefined()
  })
})

describe("SessionService agent errors", () => {
  async function failedTurn(text: string) {
    const store = new Store(":memory:")
    const frames: Frame[] = []
    const service = new SessionService(store, createFakeAdapter(), (frame) => frames.push(frame))
    const created = await service.invoke("session.create", { title: "t" }, "c")
    const sessionId = (created.result as { session: { id: string } }).session.id
    await service.invoke("message.send", { sessionId, text }, "s")
    const isError = (frame: Frame) =>
      frame.name === "message.append" && (frame.payload as { kind?: string } | undefined)?.kind === "error"
    await waitFor(() => frames.some(isError))
    return (frames.find(isError)?.payload ?? {}) as { text: string; error?: Record<string, unknown> }
  }

  test("a usage limit goes out as a structured error block", async () => {
    const message = await failedTurn("fail-usage")
    expect(message.error?.code).toBe("usage_limit")
    expect(typeof message.error?.resetsAt).toBe("number")
  })

  test("a process exit keeps its exit code and stderr", async () => {
    const message = await failedTurn("fail-exit")
    expect(message.error).toMatchObject({ code: "agent_exited", exitCode: 1 })
    expect(String(message.error?.detail)).toContain("heap out of memory")
  })

  test("an unavailable signed-out agent fails the turn as auth_required", async () => {
    const store = new Store(":memory:")
    const frames: Frame[] = []
    const adapter = createFakeAdapter()
    adapter.detect = async () => ({ available: false, reason: "401 unauthorized" })
    const service = new SessionService(store, adapter, (frame) => frames.push(frame))
    const hello = (await service.invoke("hello", {}, "h")).result as { agents: { unavailableCode?: string }[] }
    expect(hello.agents[0]?.unavailableCode).toBe("auth_required")
    const created = await service.invoke("session.create", { title: "t" }, "c")
    const sessionId = (created.result as { session: { id: string } }).session.id
    await service.invoke("message.send", { sessionId, text: "hi" }, "s")
    await waitFor(() => frames.some((frame) => (frame.payload as { kind?: string } | undefined)?.kind === "error"))
    const error = frames.find((frame) => (frame.payload as { kind?: string } | undefined)?.kind === "error")
    expect(((error?.payload ?? {}) as { error?: unknown }).error).toEqual({ code: "auth_required" })
  })

  test("session.create refuses a folder that is gone", async () => {
    const store = new Store(":memory:")
    const service = new SessionService(store, createFakeAdapter(), () => {})
    const folder = mkdtempSync(join(WORKSPACE_ROOT, "r48-"))
    try {
      const ok = await service.invoke("session.create", { cwd: folder }, "ok")
      expect(ok.type).toBe("result")
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
    const gone = await service.invoke("session.create", { cwd: folder }, "gone")
    expect(gone.error?.code).toBe("not_found")
  })
})
