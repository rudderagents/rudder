import { describe, expect, test } from "bun:test"
import {
  agentMayRetitle,
  cleanPrompt,
  commandName,
  commandTitle,
  commandTitleCopy,
  cutWords,
  isSlashCommand,
  isSubagentTool,
  readableCommand,
  shortTitle,
  subagentStep,
  titleFromMessage,
  titleUnits,
} from "./session-title"

describe("slash-command titles", () => {
  test("a message that is a slash command is recognised; paths and prose are not", () => {
    expect(isSlashCommand("/superpowers:requesting-code-review")).toBe(true)
    expect(isSlashCommand("  /review src/a.ts\nmore")).toBe(true)
    expect(isSlashCommand("/Users/tester/project is slow")).toBe(false)
    expect(isSlashCommand("fix /etc/hosts")).toBe(false)
    expect(isSlashCommand("/")).toBe(false)
    expect(isSlashCommand("// comment")).toBe(false)
  })

  test("the readable form drops the plugin prefix and turns dashes into spaces", () => {
    expect(readableCommand("/superpowers:requesting-code-review")).toBe("requesting code review")
    expect(readableCommand("/compact")).toBe("compact")
    expect(readableCommand("/plugin:sub:do_thing  focus on auth")).toBe("do thing focus on auth")
    expect(readableCommand("plain text")).toBeUndefined()
  })

})

describe("v112 short titles", () => {
  test("units: CJK counts 1, Latin, digits and blanks ½ in Chinese; English counts characters", () => {
    expect(titleUnits("修复登录跳转")).toBe(6)
    expect(titleUnits("修复 D10 排序")).toBe(6.5)
    expect(titleUnits("Fix login redirect")).toBe(18)
  })

  test("a long title is cut once between words with an ellipsis, never inside a word", () => {
    expect(shortTitle("修复登录跳转")).toBe("修复登录跳转")
    const zh = shortTitle("迁移脚本改成增量旧表保留一周再把回滚脚本也写好")
    expect(zh.endsWith("…")).toBe(true)
    expect(titleUnits(zh)).toBeLessThanOrEqual(12)
    const en = shortTitle("Review the whole branch against the written plan")
    expect(en).toBe("Review the whole branch…")
    expect(en.length).toBeLessThanOrEqual(26)
    expect(shortTitle("Supercalifragilisticexpialidociousness-and-more")).toHaveLength(26)
    expect(cutWords("requesting-code-review-and-more-words", 26)).not.toMatch(/rev…$/)
  })

  test("the first message drops pleasantries and keeps its first clause", () => {
    expect(cleanPrompt("帮我修复登录跳转，顺便看看注册页")).toBe("修复登录跳转")
    expect(cleanPrompt("请你把迁移脚本改成增量的。旧表保留一周")).toBe("把迁移脚本改成增量的")
    expect(cleanPrompt("can you please fix the login redirect, it loops")).toBe("Fix the login redirect")
    expect(cleanPrompt("look at src/auth/redirect.ts and fix it")).toBe("Src/auth/redirect.ts and fix it")
    expect(cleanPrompt("帮我")).toBe("帮我")
    expect(titleFromMessage("帮我修复登录跳转，顺便看看注册页")).toBe("修复登录跳转")
    expect(titleFromMessage("please review the whole branch against the plan we wrote yesterday")).toBe("Review the whole branch…")
  })

  test("a slash command is named from the table, else 「运行命令」 in Chinese and its words elsewhere", () => {
    expect(commandName("/superpowers:requesting-code-review")).toBe("requesting-code-review")
    expect(commandName("/Review src/a.ts")).toBe("review")
    expect(commandName("/Users/tester")).toBeUndefined()
    expect(commandTitle("requesting-code-review")).toBe("请求代码审查")
    expect(commandTitle("requesting-code-review", "en")).toBe("Code review request")
    expect(commandTitle("requesting-code-review", "zh-Hant")).toBe("請求程式碼審查")
    expect(commandTitle("deploy-preview")).toBe("运行命令")
    expect(commandTitle("deploy-preview", "en")).toBe("Deploy preview")
    expect(commandTitle("deploy-preview", "de")).toBe("Deploy preview")
    expect(commandTitleCopy("deploy-preview")).toEqual({ code: "command_title", args: { command: "deploy-preview", words: "Deploy preview" }, text: "运行命令" })
    // No brand or plugin name reaches a Chinese title.
    for (const name of ["requesting-code-review", "claude-review", "codex-run"]) expect(commandTitle(name)).not.toMatch(/claude|codex|superpowers/i)
  })

  test("an agent's own title replaces automatic titles only", () => {
    for (const auto of [1, 2, 3, 4]) expect(agentMayRetitle(auto)).toBe(true)
    expect(agentMayRetitle(0)).toBe(false)
    expect(agentMayRetitle(undefined)).toBe(false)
  })
})

describe("sub-agent steps", () => {
  test("Claude Task / Agent and Codex's collab tools are sub-agent tools; ordinary tools are not", () => {
    for (const name of ["Task", "Agent", "spawnAgent", "wait", "waitAgent", "wait_agent", "resumeAgent"]) expect(isSubagentTool(name)).toBe(true)
    for (const name of ["Bash", "Read", "TaskOutput", "TodoWrite", "mcp__x__wait", undefined]) expect(isSubagentTool(name)).toBe(false)
  })

  test("the description is cut to a short head that fits the card's step slot", () => {
    expect(subagentStep("Implement D10: command ranking for the palette", "Agent")).toBe("Implement D10")
    expect(subagentStep("Review the whole branch against the plan and report", "Task")).toBe("Review the whole branch…")
    expect(subagentStep("修复登录\n第二行", "Agent")).toBe("修复登录")
    // A title that only repeats the tool (Codex `wait`, an untitled spawn) says nothing: no description.
    expect(subagentStep("wait", "wait")).toBe("")
    expect(subagentStep("Subagent", "Agent")).toBe("")
    expect(subagentStep("   ", "Agent")).toBe("")
  })
})
