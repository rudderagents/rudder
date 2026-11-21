import { validateExternalUrl } from "../platform/open-url"
import type { AdapterContext } from "./types"

type UrlRequest = { server: string; message: string; url: string; elicitationId: string }
type UrlResponse = { action: "accept" | "decline" | "cancel" }

/** Acceptance is consent to an external interaction, not proof that authorization finished. */
export async function urlElicitation(
  request: UrlRequest,
  ask: AdapterContext["askQuestion"],
  open: (url: string) => Promise<void>,
  signal: AbortSignal,
): Promise<UrlResponse> {
  if (signal.aborted) return { action: "cancel" }
  try {
    validateExternalUrl(request.url)
  } catch {
    return { action: "decline" }
  }
  if (!request.elicitationId) return { action: "decline" }
  const question = `${request.server}: ${request.message}\n${request.url}`
  const answers = await ask({ questions: [{
    question, header: "MCP", multiSelect: false, allowsOther: false,
    options: [{ label: "Open on computer" }, { label: "Decline" }],
  }] }, signal)
  if (signal.aborted || !answers) return { action: "cancel" }
  const choice = answers[question]
  if (choice === "Decline") return { action: "decline" }
  if (choice !== "Open on computer") return { action: "cancel" }
  try {
    await open(request.url)
    return { action: signal.aborted ? "cancel" : "accept" }
  } catch {
    console.warn("MCP browser launch failed; retry the authorization from the computer")
    return { action: "cancel" }
  }
}
