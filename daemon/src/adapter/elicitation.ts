// MCP form elicitation (`requestedSchema`, MCP 2025-11-25) as Rudder questions, and the phone's answers back as the
// form's `content`. Claude, Codex and Grok forward the same schema; each adapter words its own reply.
import { arr, isObject, type Json, obj, str } from "./json"
import type { AdapterContext, QuestionAnswers, QuestionItem, QuestionRequest } from "./types"

export type FormMapping = { request: QuestionRequest; content(answers: QuestionAnswers): Record<string, unknown> }

// Booleans read as two options; the form's own language is the server's, so the words stay English.
const YES = "Yes"
const NO = "No"

type Choice = { label: string; value: string }
type Field = { key: string; item: QuestionItem; schema: Json; omit?: string; read(answer: string | string[]): unknown }

export class FormValidationError extends Error {}

/** Undefined when a field is not one the spec allows (a nested object, an array of free text): the caller declines. */
export function formQuestions(message: string, schema: unknown): FormMapping | undefined {
  if (!isObject(schema) || (schema.type !== undefined && schema.type !== "object")) return undefined
  const properties = obj(schema.properties)
  const required = new Set(arr(schema.required).filter((key): key is string => typeof key === "string"))
  if ([...required].some(key => !(key in properties))) return undefined
  const fields: Field[] = []
  for (const [key, raw] of Object.entries(properties)) {
    if (!isObject(raw)) return undefined
    const field = fieldOf(key, raw)
    if (!field) return undefined
    let omit: string | undefined
    if (!required.has(key) || raw.default !== undefined) {
      omit = raw.default !== undefined ? "Leave blank (use default)" : "Leave blank (omit field)"
      while (field.item.options.some(option => option.label === omit)) omit += " ·"
      field.item.options.push({ label: omit })
    }
    fields.push({ ...field, schema: raw, omit })
  }
  const intro = message.trim()
  if (intro && fields[0]) fields[0].item.question = `${intro}\n${fields[0].item.question}`
  distinctTexts(fields.map((field) => field.item))
  return {
    request: { questions: fields.map((field) => field.item) },
    content(answers) {
      const out: Record<string, unknown> = {}
      for (const field of fields) {
        const answer = answers[field.item.question]
        const omitted = field.omit !== undefined && (answer === field.omit || (Array.isArray(answer) && answer.length === 1 && answer[0] === field.omit))
        const missing = omitted || answer === undefined || (answer === "" && (!required.has(field.key) || field.schema.type !== "string"))
        let value: unknown
        if (missing) {
          if (field.schema.default !== undefined) value = field.schema.default
          else if (required.has(field.key)) throw new FormValidationError(`${field.item.header}: an answer is required`)
          else continue
        } else value = field.read(answer)
        validateValue(field, value)
        out[field.key] = value
      }
      return out
    },
  }
}

function validateValue(field: Field, value: unknown): void {
  const raw = field.schema
  const invalid = (reason: string): never => { throw new FormValidationError(`${field.item.header}: ${reason}`) }
  if (raw.type === "number" || raw.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value)) invalid("enter a finite number")
    const number = value as number
    if (raw.type === "integer" && !Number.isInteger(number)) invalid("enter a whole number")
    if (typeof raw.minimum === "number" && number < raw.minimum) invalid(`minimum is ${raw.minimum}`)
    if (typeof raw.maximum === "number" && number > raw.maximum) invalid(`maximum is ${raw.maximum}`)
  } else if (raw.type === "boolean") {
    if (typeof value !== "boolean") invalid("choose Yes or No")
  } else if (raw.type === "string") {
    if (typeof value !== "string") invalid("choose a listed option or enter text")
    const text = value as string
    if (typeof raw.minLength === "number" && [...text].length < raw.minLength) invalid(`minimum length is ${raw.minLength}`)
    if (typeof raw.maxLength === "number" && [...text].length > raw.maxLength) invalid(`maximum length is ${raw.maxLength}`)
    const choices = choicesOf(raw)
    if (choices && !choices.some(choice => choice.value === value)) invalid("choose a listed option")
  } else if (raw.type === "array") {
    const choices = choicesOf(obj(raw.items)) ?? []
    if (!Array.isArray(value) || value.some(item => !choices.some(choice => choice.value === item))) invalid("choose listed options only")
    const count = (value as unknown[]).length
    if (typeof raw.minItems === "number" && count < raw.minItems) invalid(`choose at least ${raw.minItems}`)
    if (typeof raw.maxItems === "number" && count > raw.maxItems) invalid(`choose at most ${raw.maxItems}`)
  }
}

export async function elicitForm(form: FormMapping, ask: AdapterContext["askQuestion"], signal: AbortSignal): Promise<{ action: "accept"; content: Record<string, unknown> } | { action: "cancel" }> {
  let request = form.request
  while (!signal.aborted) {
    const answers = await ask(request, signal)
    if (!answers || signal.aborted) return { action: "cancel" }
    const normalized: QuestionAnswers = {}
    request.questions.forEach((item, index) => {
      const answer = answers[item.question]
      if (answer !== undefined) normalized[form.request.questions[index]!.question] = answer
    })
    try {
      return { action: "accept", content: form.content(normalized) }
    } catch (error) {
      if (!(error instanceof FormValidationError)) throw error
      request = { questions: form.request.questions.map((item, index) => index === 0 ? { ...item, question: `${error.message}\n${item.question}` } : item) }
    }
  }
  return { action: "cancel" }
}

/**
 * The phone keys answers by question text: questions sharing one get their header (or their position) added, so one
 * answer cannot land on two fields.
 */
export function distinctTexts(items: QuestionItem[]) {
  const count = new Map<string, number>()
  for (const item of items) count.set(item.question, (count.get(item.question) ?? 0) + 1)
  const used = new Set<string>()
  items.forEach((item, index) => {
    if ((count.get(item.question) ?? 0) > 1) {
      const byHeader = item.header ? `${item.question} (${item.header})` : ""
      item.question = byHeader && !used.has(byHeader) && !count.has(byHeader) ? byHeader : `${item.question} (${index + 1})`
    }
    used.add(item.question)
  })
}

function fieldOf(key: string, raw: Json): Omit<Field, "schema"> | undefined {
  const header = str(raw.title) || key
  const question = str(raw.description) || header
  const item = (options: Choice[], multiSelect: boolean, allowsOther: boolean): QuestionItem => ({
    question,
    header,
    options: options.map((choice) => ({ label: choice.label })),
    multiSelect,
    allowsOther,
  })
  const one = (answer: string | string[]) => (Array.isArray(answer) ? answer[0] ?? "" : answer)
  if (raw.type === "array") {
    const choices = choicesOf(obj(raw.items))
    if (!choices) return undefined
    const values = (answer: string | string[]) =>
      (Array.isArray(answer) ? answer : answer.split(", ")).map((label) => valueFor(choices, label))
    return { key, item: item(choices, true, false), read: values }
  }
  if (raw.type === "boolean") {
    return { key, item: item([{ label: YES, value: YES }, { label: NO, value: NO }], false, false), read: (answer) => one(answer) === YES ? true : one(answer) === NO ? false : undefined }
  }
  if (raw.type === "number" || raw.type === "integer") {
    return {
      key,
      item: item([], false, true),
      read: (answer) => {
        const text = one(answer).trim()
        const value = Number(text)
        return text !== "" && Number.isFinite(value) ? value : undefined
      },
    }
  }
  if (raw.type === "string") {
    const choices = choicesOf(raw)
    if (choices) return { key, item: item(choices, false, false), read: (answer) => valueFor(choices, one(answer)) }
    return { key, item: item([], false, true), read: one }
  }
  return undefined
}

// `enum` (with the legacy `enumNames` as labels), or titled `oneOf` / `anyOf` entries of `{const, title}`.
function choicesOf(raw: Json): Choice[] | undefined {
  const values = arr(raw.enum).filter((value): value is string => typeof value === "string")
  if (values.length) {
    const names = arr(raw.enumNames)
    return values.map((value, index) => ({ value, label: typeof names[index] === "string" ? (names[index] as string) : value }))
  }
  const titled = arr(raw.oneOf).length ? arr(raw.oneOf) : arr(raw.anyOf)
  const choices = titled.filter(isObject).filter((entry) => typeof entry.const === "string")
  if (!choices.length) return undefined
  return choices.map((entry) => ({ value: str(entry.const), label: str(entry.title) || str(entry.const) }))
}

function valueFor(choices: Choice[], label: string): string | undefined {
  return choices.find((choice) => choice.label === label)?.value
}
