import { expect, test } from "bun:test"
import { urlElicitation } from "./url-elicitation"

const request = { server: "fixture", message: "Sign in", url: "https://example.test/auth?state=fixture", elicitationId: "fixture-id" }

test("URL consent displays the complete URL and opens only after approval", async () => {
  const opened: string[] = []
  const result = await urlElicitation(request, async form => {
    expect(opened).toEqual([])
    const item = form.questions[0]!
    expect(item.question).toContain(request.url)
    return { [item.question]: item.options[0]!.label }
  }, async url => { opened.push(url) }, new AbortController().signal)
  expect(opened).toEqual([request.url])
  expect(result).toEqual({ action: "accept" })
})

test("decline and withdrawal do not open an outstanding URL", async () => {
  let opened = 0
  const abort = new AbortController()
  const result = await urlElicitation(request, async form => {
    abort.abort()
    return { [form.questions[0]!.question]: form.questions[0]!.options[0]!.label }
  }, async () => { opened++ }, abort.signal)
  expect(result).toEqual({ action: "cancel" })
  const declined = await urlElicitation(request, async form => ({ [form.questions[0]!.question]: form.questions[0]!.options[1]!.label }), async () => { opened++ }, new AbortController().signal)
  expect(declined).toEqual({ action: "decline" })
  expect(opened).toBe(0)
})

test("invalid URLs are declined without asking or opening", async () => {
  let asked = 0
  const result = await urlElicitation({ ...request, url: "file:///tmp/fixture" }, async () => { asked++; return null }, async () => { throw new Error("must not open") }, new AbortController().signal)
  expect(result).toEqual({ action: "decline" })
  expect(asked).toBe(0)
})
