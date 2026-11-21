// Loose readers for agent JSON: wrong-typed fields read as empty instead of throwing.
import type { QuestionAnswers, QuestionItem } from "./types"

export type Json = Record<string, unknown>

export function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function isString(value: unknown): value is string {
  return typeof value === "string"
}

export function obj(value: unknown): Json {
  return isObject(value) ? value : {}
}

export function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function str(value: unknown): string {
  return typeof value === "string" ? value : ""
}

export function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// Claude AskUserQuestion input and Grok `_x.ai/ask_user_question` share this shape.
// Neither carries "can type an answer": both agents always offer "Other", so callers pass true.
export function parseQuestions(raw: unknown, allowsOther: boolean): QuestionItem[] {
  return arr(raw)
    .filter(isObject)
    .filter((item) => typeof item.question === "string")
    .map((item) => ({
      question: str(item.question),
      ...(typeof item.header === "string" ? { header: item.header } : {}),
      options: arr(item.options)
        .filter(isObject)
        .filter((option) => typeof option.label === "string")
        .map((option) => ({
          label: str(option.label),
          ...(typeof option.description === "string" ? { description: option.description } : {}),
        })),
      multiSelect: item.multiSelect === true,
      allowsOther,
    }))
}

// Both agents take one string per question; multi-select answers are comma-joined.
export function flattenAnswers(answers: QuestionAnswers): Record<string, string> {
  return Object.fromEntries(Object.entries(answers).map(([question, value]) => [question, Array.isArray(value) ? value.join(", ") : value]))
}
