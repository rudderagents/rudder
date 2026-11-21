// Structured agent failures (r48). The phone draws a card per code; any other failure stays
// plain text. Adapters throw `AgentError` when the agent's own protocol names the cause (Codex codexErrorInfo,
// an ACP auth error); everything else is read from the failure text by `classifyAgentFailure`.

export type AgentErrorInfo =
  // resetsAt: ms on the daemon clock, when known.
  | { code: "usage_limit"; resetsAt?: number }
  // command: what to run in a terminal on the computer, when the agent names one.
  | { code: "auth_required"; command?: string }
  // detail: the last lines of the process's stderr.
  | { code: "agent_exited"; exitCode?: number; detail?: string }

export class AgentError extends Error {
  constructor(
    message: string,
    readonly info: AgentErrorInfo,
    options?: { cause?: unknown },
  ) {
    super(message, options)
  }
}

// The login command each agent's CLI documents. Only agents whose command is certain are listed.
const LOGIN_COMMANDS: Record<string, string> = { codex: "codex login" }

export function loginCommand(agent: string, text = ""): string | undefined {
  const named = text.match(/\brun\s+[`'"]?((?:[a-z][\w.-]*\s+)?(?:login|auth\s+login))\b/i)?.[1]
  return named ?? LOGIN_COMMANDS[agent]
}

const STDERR_LINES = 6

/** The tail of a process's stderr, the part that says why it died. */
export function stderrTail(stderr: string): string | undefined {
  const lines = stderr
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
  return lines.length > 0 ? lines.slice(-STDERR_LINES).join("\n") : undefined
}

const USAGE_LIMIT = /usage limit|usageLimitExceeded|limit reached|rate limit(?:ed| exceeded)|quota exceeded|insufficient_quota/i
const AUTH = /\b401\b|unauthori[sz]ed|not (?:logged|signed) in|please run \/login|invalid api key|authentication (?:failed|required)|requiresOpenaiAuth|未登录/i
const EXITED = /exited with code (-?\d+)(?:[^:]*:\s*([\s\S]*))?/i

/** Reads a failure's text. Undefined: an ordinary error with no card of its own. */
export function classifyAgentFailure(agent: string, message: string): AgentErrorInfo | undefined {
  if (USAGE_LIMIT.test(message)) {
    // Claude CLI: "Claude AI usage limit reached|1761944400" (unix seconds).
    const stamp = Number(message.match(/limit reached\|(\d{9,13})/i)?.[1])
    return Number.isFinite(stamp) && stamp > 0
      ? { code: "usage_limit", resetsAt: stamp > 1e12 ? stamp : stamp * 1000 }
      : { code: "usage_limit" }
  }
  if (AUTH.test(message)) {
    const command = loginCommand(agent, message)
    return command ? { code: "auth_required", command } : { code: "auth_required" }
  }
  const exited = message.match(EXITED)
  if (exited) {
    const info: AgentErrorInfo = { code: "agent_exited", exitCode: Number(exited[1]) }
    const detail = stderrTail(exited[2] ?? "")
    if (detail) info.detail = detail
    return info
  }
  return undefined
}

/** `unavailableCode` for `hello.agents[]`, from a detect reason. */
export function unavailableCode(reason: string | undefined): "not_installed" | "auth_required" | "failed" {
  const text = (reason ?? "").trim()
  if (text.startsWith("未找到命令")) return "not_installed"
  return AUTH.test(text) || /\b403\b/.test(text) ? "auth_required" : "failed"
}
