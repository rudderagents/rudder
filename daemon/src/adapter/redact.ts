// Agent stderr reaches the phone (the error card's detail and the failure text). CLIs print request URLs, headers
// and config lines there, so anything shaped like a credential is replaced before it leaves the computer.
const REDACTED = "[redacted]"

const PATTERNS: RegExp[] = [
  // Authorization headers and bearer tokens.
  /\b(authorization\s*[:=]\s*)(?:bearer\s+|basic\s+)?[^\s"',;]+/gi,
  /\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
  // key=value / key: value for secret-looking names (api_key, token, secret, password, access_key …).
  /\b((?:[a-z_]*?(?:api[_-]?key|apikey|token|secret|password|passwd|access[_-]?key|private[_-]?key|session[_-]?key))["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi,
  // Query strings: ?key=… &token=…
  /([?&](?:key|api_key|apikey|token|access_token|auth|sig|signature)=)[^&\s"']+/gi,
  // Provider key shapes.
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g,
  /\bxai-[A-Za-z0-9_-]{16,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  // JSON Web Tokens.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
]

/** Replaces credential-shaped substrings with [redacted]; a leading label (`api_key=`, `Bearer `) is kept. */
export function redactSecrets(text: string): string {
  let out = text
  for (const pattern of PATTERNS) {
    out = out.replace(pattern, (match, label?: unknown) => (typeof label === "string" && match.startsWith(label) ? `${label}${REDACTED}` : REDACTED))
  }
  return out
}
