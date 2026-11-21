import { describe, expect, test } from "bun:test"
import { appLocale } from "./app-locale"
import { AlertLadder, liveAlertKind, liveAlertText } from "./live-alerts"

describe("lock-screen alert text", () => {
  test("a reported language maps to one the app ships; old phones' zh / en still work", () => {
    expect(["zh", "zh-Hans", "zh-Hant", "zh-TW", "en", "en-GB", "de", "de-AT", "ja", "es", "es-MX", "es-419", "pt-BR", "", undefined].map(appLocale)).toEqual([
      "zh-Hans", "zh-Hans", "zh-Hant", "zh-Hant", "en", "en", "de", "de", "ja", "es-419", "es-419", "es-419", "en", "zh-Hans", "zh-Hans",
    ])
  })

  test("keys first; after one refusal, Simplified Chinese for a zh-Hans phone and English for every other language", () => {
    const logged: string[] = []
    const ladder = new AlertLadder((line) => logged.push(line))
    expect(ladder.alert("de", "done")).toEqual({ titleKey: "完成", bodyKey: "这一轮结束了" })
    expect(ladder.refused(500, { titleKey: "完成" }, "alert")).toBe(false)
    expect(ladder.refused(400, { titleKey: "完成" }, "bad ticket")).toBe(false)
    expect(ladder.refused(400, { titleKey: "完成" }, "alert not allowed")).toBe(true)
    expect(ladder.refused(400, { title: "Done" }, "alert not allowed")).toBe(false)
    expect(logged).toHaveLength(1)
    expect(ladder.alert("zh-Hans", "done")).toEqual({ title: "完成", body: "这一轮结束了" })
    expect(ladder.alert("zh", "waiting")).toEqual(liveAlertText("zh-Hans", "waiting"))
    for (const locale of ["en", "de", "ja", "zh-Hant", "es-419"]) expect(ladder.alert(locale, "done")).toEqual({ title: "Done", body: "This turn finished" })
  })

  test("an alert's kind is read back from keys or text", () => {
    expect(liveAlertKind({ titleKey: "需批准", bodyKey: "有一项操作等你批准" })).toBe("waiting")
    expect(liveAlertKind({ title: "Failed", body: "This turn did not finish" })).toBe("failed")
    expect(liveAlertKind({ title: "?", body: "?" })).toBeUndefined()
  })
})
