import { describe, expect, test } from "bun:test"
import { PIZZA } from "../../scripts/record/mcp-elicit-server"
import { elicitForm, formQuestions } from "./elicitation"

// The form scripts/record/mcp-elicit-server.ts asks, as Claude 2.1.312 forwarded it (claude/recorded/elicit-form.jsonl).
const SCHEMA = {
  type: "object",
  properties: {
    toppings: {
      type: "array",
      title: "Toppings",
      description: "Pick any number",
      items: { type: "string", enum: ["cheese", "mushroom", "olive", "pepper"] },
    },
    size: { type: "string", title: "Size", oneOf: [{ const: "s", title: "Small" }, { const: "l", title: "Large" }] },
    crust: { type: "string", title: "Crust", enum: ["thin", "thick"] },
    extraSauce: { type: "boolean", title: "Extra sauce", default: false },
    count: { type: "number", title: "How many", minimum: 1, maximum: 5 },
    note: { type: "string", title: "Note for the kitchen", maxLength: 80 },
  },
  required: ["toppings", "size"],
}

describe("formQuestions", () => {
  test("one question per field, in order, with the form's message first", () => {
    const form = formQuestions("How do you want your pizza?", SCHEMA)!
    const questions = form.request.questions
    expect(questions.map((item) => item.header)).toEqual(["Toppings", "Size", "Crust", "Extra sauce", "How many", "Note for the kitchen"])
    expect(questions[0]!.question.startsWith("How do you want your pizza?\n")).toBe(true)
    expect(questions[0]).toMatchObject({ multiSelect: true, allowsOther: false })
    expect(questions[0]!.options.map((option) => option.label)).toEqual(["cheese", "mushroom", "olive", "pepper"])
    expect(questions[1]).toMatchObject({ multiSelect: false, allowsOther: false, options: [{ label: "Small" }, { label: "Large" }] })
    expect(questions[3]!.options.map((option) => option.label)).toEqual(["Yes", "No", "Leave blank (use default)"])
    expect(questions[4]).toMatchObject({ options: [{ label: "Leave blank (omit field)" }], allowsOther: true })
    expect(questions[5]).toMatchObject({ options: [{ label: "Leave blank (omit field)" }], allowsOther: true })
  })

  test("answers map back to the form's values: const for titles, booleans, numbers", () => {
    const form = formQuestions("How do you want your pizza?", SCHEMA)!
    const [toppings, size, crust, sauce, count, note] = form.request.questions.map((item) => item.question)
    const content = form.content({
      [toppings!]: ["cheese", "olive"],
      [size!]: "Large",
      [crust!]: "thin",
      [sauce!]: "Yes",
      [count!]: "2",
      [note!]: "no onions",
    })
    expect(content).toEqual(PIZZA)
  })

  test("invalid numbers and missing required answers are not silently omitted", () => {
    const form = formQuestions("", SCHEMA)!
    const [toppings, , , , count] = form.request.questions.map((item) => item.question)
    expect(() => form.content({ [toppings!]: ["pepper"], [count!]: "two" })).toThrow()
  })

  test("fields with the same text get distinct questions, so their answers do not merge", () => {
    const form = formQuestions("", {
      type: "object",
      properties: { min: { type: "number", description: "Enter a value" }, max: { type: "number", description: "Enter a value" } },
    })!
    const [min, max] = form.request.questions.map((item) => item.question)
    expect(min).not.toBe(max)
    expect(form.content({ [min!]: "1", [max!]: "5" })).toEqual({ min: 1, max: 5 })
  })

  test("a field it cannot show makes the whole form unshowable; an empty form has no questions", () => {
    expect(formQuestions("x", { type: "object", properties: { address: { type: "object" } } })).toBeUndefined()
    const empty = formQuestions("Allow it?", { type: "object", properties: {} })!
    expect(empty.request.questions).toEqual([])
    expect(empty.content({})).toEqual({})
  })
})

describe("MCP form validation", () => {
  const schema = { type: "object", properties: { count: { type: "integer", title: "Count", minimum: 1, maximum: 5 } }, required: ["count"] }
  test("required integers retain their type and range", () => {
    const form = formQuestions("", schema)!
    for (const answer of ["1.5", "6", "0", "", "two"]) expect(() => form.content({ Count: answer })).toThrow()
    expect(() => form.content({})).toThrow()
    expect(form.content({ Count: "2" })).toEqual({ count: 2 })
  })

  test("defaults retain type and unknown boolean or enum labels are rejected", () => {
    const form = formQuestions("", { type: "object", properties: {
      sauce: { type: "boolean", title: "Sauce", default: false },
      size: { type: "string", title: "Size", oneOf: [{ const: "s", title: "Small" }] },
      toppings: { type: "array", title: "Toppings", items: { type: "string", enum: ["cheese"] } },
    } })!
    expect(form.content({})).toEqual({ sauce: false })
    expect(() => form.content({ Sauce: "perhaps" })).toThrow()
    expect(() => form.content({ Size: "invalid" })).toThrow()
    expect(() => form.content({ Toppings: ["cheese", "invalid"] })).toThrow()
    expect(form.content({ Size: "Small" })).toEqual({ sauce: false, size: "s" })
  })

  test("invalid editable answers are re-asked and can be corrected", async () => {
    const form = formQuestions("", schema)!
    let attempts = 0
    const result = await elicitForm(form, async request => {
      attempts++
      const question = request.questions[0]!.question
      if (attempts === 2) expect(question).toContain("Count")
      return { [question]: attempts === 1 ? "1.5" : "2" }
    }, new AbortController().signal)
    expect(result).toEqual({ action: "accept", content: { count: 2 } })
    expect(attempts).toBe(2)
  })
})

test("optional fields offer card-selectable omission and defaults without protocol changes", () => {
  const form = formQuestions("", {type:"object",properties:{note:{type:"string"},count:{type:"integer",default:2}}})!
  const answers = Object.fromEntries(form.request.questions.map(q => [q.question, [q.options.at(-1)!.label]]))
  expect(form.request.questions.every(q => q.options.some(o => o.label.startsWith("Leave blank")))).toBe(true)
  expect(form.content(answers)).toEqual({count:2})
})
