/**
 * Session titles and the card's step line for two cases the plain text reads badly in (11-19, seen on device):
 * a session opened with a slash command (`/superpowers:requesting-code-review`), and a turn waiting on a sub-agent,
 * whose step was its long English task description shown as if it were a tool name.
 */

// `/name` or `/plugin:name`, then a blank or the end. A path (`/Users/…`) has a second slash and is not a command.
const COMMAND = /^\/([A-Za-z0-9][\w.:-]*)(?:\s+([\s\S]*))?$/

export function isSlashCommand(text: string): boolean {
  return COMMAND.test(text.trim())
}

/** `/superpowers:requesting-code-review` -> 「requesting code review」; its arguments follow on one line. */
export function readableCommand(text: string): string | undefined {
  const match = COMMAND.exec(text.trim())
  if (!match) return undefined
  const name = match[1]!.split(":").pop()!.replace(/[-_]+/g, " ").trim()
  const args = (match[2] ?? "").replace(/\s+/g, " ").trim()
  const readable = [name, args].filter((part) => part !== "").join(" ")
  return readable || undefined
}

/**
 * v112 short titles: the title the home list, the lock card and the island share. Chinese
 * 4–12 characters, Latin letters, digits and blanks counting half; English at most 26 characters. A longer one is cut
 * once, between words, with an ellipsis (rule 3).
 */
export const TITLE_UNITS_ZH = 12
export const TITLE_CHARS_EN = 26

const CJK = /[\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]/

function hasCJK(text: string): boolean {
  return CJK.test(text)
}

/** Length in v112 units: a CJK or full-width character 1, anything else ½ (Chinese); characters (English). */
export function titleUnits(text: string, chinese = hasCJK(text)): number {
  let units = 0
  for (const char of text) units += chinese ? (CJK.test(char) ? 1 : 0.5) : 1
  return units
}

/**
 * Cuts `text` once to `limit` units between words (ICU word breaks: Chinese between words, English at blanks), never
 * inside one, with a trailing ellipsis. Text within the limit comes back as it is.
 */
export function cutWords(text: string, limit: number, chinese = hasCJK(text)): string {
  if (titleUnits(text, chinese) <= limit) return text
  const segmenter = new Intl.Segmenter(chinese ? "zh" : "en", { granularity: "word" })
  let out = ""
  let best = ""
  for (const { segment, isWordLike } of segmenter.segment(text)) {
    out += segment
    if (titleUnits(out, chinese) + 1 > limit) break
    if (isWordLike) best = out
  }
  const head = best || [...text].slice(0, Math.max(1, Math.floor(limit) - 1)).join("")
  return `${head.replace(/[\s，,、:：;；·\-–—]+$/u, "")}…`
}

/** A short title within v112's limits: one line, cut once between words. */
export function shortTitle(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim()
  const chinese = hasCJK(oneLine)
  return cutWords(oneLine, chinese ? TITLE_UNITS_ZH : TITLE_CHARS_EN, chinese)
}

// v112 fallback ②: requests and pleasantries ahead of the ask, then everything after the first clause.
const LEAD_ZH = /^(?:请你|请|麻烦你|麻烦|你能不能|能不能|你可以|可以|帮我看看|帮我查一下|帮我|帮忙|看看|我想|我要)+/u
const LEAD_EN = /^(?:(?:please|pls|can you|could you|would you|help me|look at|i want you to|i need you to)[\s,]+)+/iu
const CLAUSE = /[，。！？；\n—]|[,!?;](?=\s|$)|\.(?=\s|$)/u

/** The ask in a first message: no 「帮我 / 请 / can you / please」, only its first clause. */
export function cleanPrompt(text: string): string {
  const line = text.split("\n").map((part) => part.trim()).find((part) => part !== "") ?? ""
  let ask = line.replace(LEAD_ZH, "").replace(LEAD_EN, "").trim()
  const end = ask.search(CLAUSE)
  if (end > 0) ask = ask.slice(0, end).trim()
  if (!ask) return line
  return hasCJK(ask) ? ask : ask.charAt(0).toUpperCase() + ask.slice(1)
}

/** v112 ③: the slash commands with a name of their own; `[Simplified, Traditional, English]`. */
export const COMMAND_TITLES: Record<string, [string, string, string]> = {
  "requesting-code-review": ["请求代码审查", "請求程式碼審查", "Code review request"],
  "receiving-code-review": ["处理审查意见", "處理審查意見", "Handle review notes"],
  brainstorming: ["头脑风暴", "腦力激盪", "Brainstorm"],
  "writing-plans": ["写实施计划", "寫實施計畫", "Write a plan"],
  "executing-plans": ["按计划实施", "按計畫實施", "Carry out the plan"],
  "systematic-debugging": ["系统排查问题", "系統排查問題", "Debug step by step"],
  "test-driven-development": ["测试驱动开发", "測試驅動開發", "Test-driven work"],
  review: ["代码审查", "程式碼審查", "Code review"],
  init: ["初始化项目", "初始化專案", "Set up the project"],
  compact: ["压缩上下文", "壓縮上下文", "Compact context"],
}

/** `/superpowers:requesting-code-review focus` -> `requesting-code-review` (the namespace dropped, lower case). */
export function commandName(text: string): string | undefined {
  const match = COMMAND.exec(text.trim())
  if (!match) return undefined
  const name = match[1]!.split(":").pop()!.toLowerCase()
  return name || undefined
}

/**
 * v112 ③ in a phone language: the table's name; else Chinese 「运行命令」 and other languages the name's words
 * (`deploy-preview` -> 「Deploy preview」). Chinese never carries the plugin's or anyone's brand.
 */
export function commandTitle(name: string, locale = "zh-Hans"): string {
  const known = COMMAND_TITLES[name]
  const traditional = locale === "zh-Hant"
  const chinese = locale.startsWith("zh")
  if (known) return chinese ? known[traditional ? 1 : 0] : known[2]
  if (chinese) return traditional ? "執行命令" : "运行命令"
  const words = name.split(/[-_.]+/).filter(Boolean).join(" ")
  return shortTitle(words.charAt(0).toUpperCase() + words.slice(1))
}

/** The title a first ordinary message gives (v112 ②). */
export function titleFromMessage(text: string): string {
  return shortTitle(cleanPrompt(text))
}

/**
 * `sessions.auto_title`: who named the session, so a better source may still replace it. 1: the phone's placeholder;
 * 2: a slash command (`title_command` keeps its name, each phone words it); 3: the first ordinary message; 4: the
 * agent's own title (Claude's ai-title, an ACP `session_info_update`, a Codex thread name). 0: the user named it,
 * and nothing replaces that.
 */
export const AUTO_TITLE_PLACEHOLDER = 1
export const AUTO_TITLE_COMMAND = 2
export const AUTO_TITLE_MESSAGE = 3
export const AUTO_TITLE_AGENT = 4

/** An agent's own title replaces any automatic one, never the user's (v112 ①). */
export function agentMayRetitle(autoTitle: number | undefined): boolean {
  return autoTitle === AUTO_TITLE_PLACEHOLDER || autoTitle === AUTO_TITLE_COMMAND || autoTitle === AUTO_TITLE_MESSAGE || autoTitle === AUTO_TITLE_AGENT
}

/** The phone copy a command-named session's title travels as, so each phone words it in its own language. */
export function commandTitleCopy(name: string): { code: string; args: { command: string; words: string }; text: string } {
  return { code: "command_title", args: { command: name, words: commandTitle(name, "en") }, text: commandTitle(name, "zh-Hans") }
}

// Claude Code's sub-agent tool (`Task`, `Agent` since 2.x; every adapter maps its own to `Agent`) and Codex's collab
// tools that wait on one. `TaskOutput` and the todo tools are not sub-agents.
const SUBAGENT_TOOLS = new Set(["Task", "Agent", "spawnAgent", "wait", "waitAgent", "wait_agent", "resumeAgent"])

export function isSubagentTool(tool: string | undefined): boolean {
  return tool !== undefined && SUBAGENT_TOOLS.has(tool)
}

/** v103's step slot holds 「等子 agent · 」 and about this much more on the 393 phone. */
export const SUBAGENT_STEP_CHARS = 24

/**
 * The sub-agent's description cut for the card: its first line; the part before a colon when that is a short label
 * (「Implement D10: command ranking…」 -> 「Implement D10」); else clipped. Empty when it only repeats the tool.
 */
export function subagentStep(title: string, tool: string): string {
  const line = title.split("\n").map((part) => part.trim()).find((part) => part !== "") ?? ""
  if (!line || line.toLowerCase() === tool.toLowerCase() || /^(sub-?agent|agent)$/i.test(line)) return ""
  const head = /^(.{1,24}?):\s/.exec(line)?.[1]?.trim()
  const text = head || line
  const chars = [...text]
  return chars.length <= SUBAGENT_STEP_CHARS ? text : `${chars.slice(0, SUBAGENT_STEP_CHARS - 1).join("").trimEnd()}…`
}
