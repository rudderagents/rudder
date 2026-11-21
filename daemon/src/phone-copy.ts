// Text rudderd writes for the phone to show, as a stable code with its arguments beside the Simplified Chinese text it
// has always sent. A phone that knows the code words it in its own language (`ios/App/DaemonCopy.swift`, whose catalog
// keys are these same texts); an older phone, or one that does not know a code, shows `text`. An argument is plain
// (a command, a path, an agent's label, an error the agent wrote) or another piece of copy, worded the same way.

export type PhoneCopyArg = string | PhoneCopy
export type PhoneCopy = { code: string; args?: Record<string, PhoneCopyArg>; text: string }

function textOf(arg: PhoneCopyArg): string {
  return typeof arg === "string" ? arg : arg.text
}

export function isPhoneCopy(value: unknown): value is PhoneCopy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const copy = value as { code?: unknown; text?: unknown }
  return typeof copy.code === "string" && typeof copy.text === "string"
}

/** The copy an error carries (`withCopy`), if any. */
export function copyOf(error: unknown): PhoneCopy | undefined {
  const copy = (error as { copy?: unknown } | null)?.copy
  return isPhoneCopy(copy) ? copy : undefined
}

/** An Error whose message is the copy's text and that keeps the copy for the phone. */
export function copyError(copy: PhoneCopy, fields: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(copy.text), { ...fields, copy })
}

export const phoneCopy = {
  commandMissing: (command: string): PhoneCopy => ({ code: "command_missing", args: { command }, text: `未找到命令 ${command}` }),
  agentSignedOut: (agent: string, command: string): PhoneCopy => ({
    code: "agent_signed_out",
    args: { agent, command },
    text: `${agent} 未登录：在电脑上运行 ${command}`,
  }),
  agentSilentTurn: (agent: string): PhoneCopy => ({
    code: "agent_silent_turn",
    args: { agent },
    text: `${agent} 这一轮没有任何回复：可能未登录或 API key 无效，请在电脑上检查`,
  }),
  agentOutdated: (agent: string, version: string, minimum: string): PhoneCopy => ({
    code: "agent_outdated",
    args: { agent, version, minimum },
    text: `${agent} 版本太旧：电脑上是 ${version}，需要 ${minimum} 或更新`,
  }),
  agentStartFailed: (agent: string, detail: PhoneCopyArg): PhoneCopy => ({
    code: "agent_start_failed",
    args: { agent, detail },
    text: `${agent} 启动失败：${textOf(detail)}`,
  }),
  // The command on PATH is a link: `path` is the file it resolves to.
  agentStartFailedAt: (agent: string, command: string, path: string, detail: PhoneCopyArg): PhoneCopy => ({
    code: "agent_start_failed_at",
    args: { agent, command, path, detail },
    text: `${agent} 启动失败（${command} → ${path}）：${textOf(detail)}`,
  }),
  // ACP `initialize` named another agent (or none): the command on PATH is not the agent it is configured as.
  agentMismatch: (command: string, agent: string, reported: string): PhoneCopy =>
    reported
      ? { code: "agent_mismatch", args: { command, agent, reported }, text: `${command} 不是 ${agent}（initialize 自报：${reported}）` }
      : { code: "agent_mismatch_unnamed", args: { command, agent }, text: `${command} 不是 ${agent}（initialize 自报：无 agentInfo / authMethods）` },
  // Claude Code's own sign-in: `claude`, then /login inside it. "未登录" keeps `unavailableCode` at auth_required.
  claudeSignedOut: (): PhoneCopy => ({ code: "claude_signed_out", text: "Claude Code 未登录：在电脑上运行 claude，再输入 /login" }),
  // Plan 2026-11-17-agent-questions: questions the phone cannot show yet (design v96).
  mcpFormUnsupported: (server: string): PhoneCopy => ({
    code: "mcp_form_unsupported",
    args: { server },
    text: `MCP 服务器 ${server} 要你填的表单手机上还显示不了，已拒绝`,
  }),
  mcpUrlUnsupported: (server: string, message: string): PhoneCopy => ({
    code: "mcp_url_unsupported",
    args: { server, message },
    text: `MCP 服务器 ${server} 要你在浏览器里操作（${message}），手机上还不支持，已拒绝`,
  }),
  questionSecretSkipped: (agent: string, question: string): PhoneCopy => ({
    code: "question_secret_skipped",
    args: { agent, question },
    text: `${agent} 要你填一个密文（「${question}」），手机上还不能填，已留空`,
  }),
  agentUnknown: (agent: string): PhoneCopy => ({ code: "agent_unknown", args: { agent }, text: `未知 agent：${agent}` }),
  agentUnavailable: (agent: string, reason?: PhoneCopyArg): PhoneCopy => {
    const why = reason ?? { code: "reason_unknown", text: "未知原因" }
    return { code: "agent_unavailable", args: { agent, reason: why }, text: `${agent} 不可用：${textOf(why)}` }
  },
  cwdUnavailable: (path: string, detail: PhoneCopyArg): PhoneCopy => ({
    code: "cwd_unavailable",
    args: { path, detail },
    text: `工作目录不可用：${path}（${textOf(detail)}）`,
  }),
  hiddenPath: (): PhoneCopy => ({ code: "hidden_path", text: "隐藏文件（以 . 开头）不对手机开放" }),
  // A terminal opened the session between the send and the agent's start (handoff §2 rule 3).
  terminalTookOver: (): PhoneCopy => ({ code: "terminal_took_over", text: "这个会话刚在电脑终端里打开，这一轮没有开始" }),
  // Shown before the reply when a stale --resume id forced a fresh Claude session.
  staleResume: (): PhoneCopy => ({
    code: "stale_resume",
    text: "原来的 Claude 会话已无法续接，这一轮在新会话里继续（之前的上下文不在 Claude 那边了）",
  }),
  // The first message of the sample session a fresh install starts with.
  welcome: (): PhoneCopy => ({ code: "welcome", text: "rudderd 已就绪。发一条消息试试。" }),
  demoTitle: (): PhoneCopy => ({ code: "demo_title", text: "示例会话" }),
}
