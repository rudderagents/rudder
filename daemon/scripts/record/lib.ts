// r66 step 2: records what a real agent CLI reads and writes, frame by frame, for fixtures and the compat matrix.
// Each recorder (record-<agent>.ts) lists scenarios; `free` ones never reach a model (handshake, model list, quota),
// the rest call a model and run only with --paid. Output: src/adapter/fixtures/<agent>/recorded/<scenario>.jsonl, first
// line {"recorded": {cli, at, scenario}}, then one {"dir": "spawn" | "in" | "out" | "err", ...} per line, redacted only.
//
// Every scenario runs in a fresh temp root: `work/` is the agent's cwd, `home/` holds the isolated config a recorder's
// `setup` writes (CODEX_HOME, GOOSE_PATH_ROOT, …), so the owner's own config is never read or changed. Scenarios with
// `keys` start the CLI through `sh`, which sources the owner's test key file (TEST_KEYS) into that process only: the key
// never passes through this script, is never printed, and the redactor drops anything shaped like one.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { homedir, hostname, tmpdir, userInfo } from "node:os"
import { join, resolve } from "node:path"

export type Frame = Record<string, unknown>
export type Line =
  | { dir: "spawn"; argv: string[] }
  | { dir: "in"; frame: Frame }
  | { dir: "out"; frame: Frame }
  | { dir: "out"; raw: string }
  | { dir: "err"; text: string }

export const TEST_KEYS = join(homedir(), ".config", "rudder", "test-keys.env")

export type ScenarioContext = {
  /** The agent's working folder (empty temp dir). */
  cwd: string
  /** Starts the CLI (again, for resume); every process of the scenario writes into the same recording. */
  start: (extraArgs?: string[]) => Recording
}

export type Scenario = {
  name: string
  /** True when nothing is sent to a model: safe to run without the owner's approval. */
  free: boolean
  summary: string
  /** Rough cost, for the dry-run list. */
  cost?: string
  /** Start through the test key file (DeepSeek for Codex / Qwen / goose / pi). */
  keys?: boolean
  /** Shell lines run after the key file is sourced (a wrong key for the auth-error path). */
  afterKeys?: string[]
  /** The recorder's argv with these flags taken out (Claude's elicit-form needs its MCP server under --safe-mode's place). */
  dropArgs?: string[]
  run: (ctx: ScenarioContext) => Promise<void>
}

export type RecorderSpec = {
  agent: string
  cli: string
  argv: string[]
  scenarios: Scenario[]
  /** Writes isolated config under `home` and returns the env that points the CLI at it. */
  setup?: (home: string, scenario: Scenario) => Record<string, string>
  /** Shell lines after the key file is sourced, mapping its names onto the CLI's (OPENAI_API_KEY=$DEEPSEEK_API_KEY). */
  keyExports?: string[]
  /**
   * Shrinks a bulky frame kept whole in one scenario (Qwen's 600 KB command list, whole in `models`). Returns the
   * replacement or undefined to keep it; the header names what was elided.
   */
  elide?: (frame: Frame, scenario: Scenario) => { frame: Frame; note: string } | undefined
}

// Provider settings the calling shell may carry (an OPENAI_BASE_URL relay sent goose's key elsewhere, 2026-11-05).
// Dropped before every launch; a recorder's setup and the test key file set the ones a scenario needs.
const PROVIDER_ENV = /^(OPENAI|ANTHROPIC|DEEPSEEK|XAI|GROK|GEMINI|GOOGLE_API|QWEN|DASHSCOPE|MOONSHOT|KIMI|OPENROUTER|OLLAMA|GOOSE|PI_CODING|CODEX)_/i

function callerEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined && !PROVIDER_ENV.test(name)) env[name] = value
  return env
}

// Flags that let an agent act without asking. A recorder never starts one.
const BYPASS = ["bypassPermissions", "--dangerously-skip-permissions", "--always-approve", "--yolo", "--allow-all-tools", "allow_all"]

/** One CLI process. Lines go into the scenario's shared list in the order they happen. */
export class Recording {
  private readonly proc: ReturnType<typeof Bun.spawn<"pipe", "pipe", "pipe">>
  private readonly frames: Frame[] = []
  private readonly waiters: { match: (frame: Frame) => boolean; resolve: (frame: Frame) => void }[] = []
  private readonly listeners: ((frame: Frame) => void)[] = []
  private readonly pumps: Promise<void>[]
  private exited = false

  constructor(
    readonly lines: Line[],
    launch: string[],
    shown: string[],
    cwd: string,
    env: Record<string, string>,
  ) {
    const bypass = shown.find((arg) => BYPASS.some((flag) => arg.includes(flag)))
    if (bypass) throw new Error(`refusing to record with ${bypass}: recordings never skip permissions`)
    lines.push({ dir: "spawn", argv: shown })
    this.proc = Bun.spawn(launch, { cwd, env: { ...callerEnv(), ...env }, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
    this.pumps = [this.pump(this.proc.stdout, (text) => this.out(text)), this.pump(this.proc.stderr, (text) => lines.push({ dir: "err", text }))]
    void this.proc.exited.then(() => {
      this.exited = true
    })
  }

  send(frame: Frame) {
    this.lines.push({ dir: "in", frame })
    this.proc.stdin.write(`${JSON.stringify(frame)}\n`)
  }

  /**
   * The first stdout frame of this process `match` accepts, or an error after timeoutMs. Frames already seen count
   * unless `fresh` (a second turn's `result` must not be the first turn's).
   */
  waitFor(match: (frame: Frame) => boolean, timeoutMs: number, what = "frame", fresh = false): Promise<Frame> {
    const seen = fresh ? undefined : this.frames.find(match)
    if (seen) return Promise.resolve(seen)
    return new Promise((done, fail) => {
      const waiter = {
        match,
        resolve: (frame: Frame) => {
          clearTimeout(timer)
          done(frame)
        },
      }
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1)
        fail(new Error(`no ${what} within ${timeoutMs} ms${this.exited ? " (process exited)" : ""}`))
      }, timeoutMs)
      this.waiters.push(waiter)
    })
  }

  /** Calls `handle` for every stdout frame from now on (and the ones already seen). */
  onFrame(handle: (frame: Frame) => void) {
    for (const frame of this.frames) handle(frame)
    this.listeners.push(handle)
  }

  /** Closes stdin, gives the CLI graceMs to leave on its own, then kills it. */
  async close(graceMs = 3000) {
    if (!this.exited) this.proc.stdin.end()
    const left = await Promise.race([this.proc.exited.then(() => true), Bun.sleep(graceMs).then(() => false)])
    if (!left) this.proc.kill()
    await this.proc.exited
    await Promise.all(this.pumps)
  }

  private out(text: string) {
    let frame: unknown
    try {
      frame = JSON.parse(text)
    } catch {
      this.lines.push({ dir: "out", raw: text })
      return
    }
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) return void this.lines.push({ dir: "out", raw: text })
    const value = frame as Frame
    this.lines.push({ dir: "out", frame: value })
    this.frames.push(value)
    for (const listener of this.listeners) listener(value)
    for (const waiter of [...this.waiters]) {
      if (!waiter.match(value)) continue
      this.waiters.splice(this.waiters.indexOf(waiter), 1)
      waiter.resolve(value)
    }
  }

  private async pump(stream: ReadableStream<Uint8Array>, onLine: (text: string) => void) {
    const decoder = new TextDecoder()
    let buffer = ""
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true })
      let index = buffer.indexOf("\n")
      while (index >= 0) {
        const line = buffer.slice(0, index).trimEnd()
        buffer = buffer.slice(index + 1)
        if (line) onLine(line)
        index = buffer.indexOf("\n")
      }
    }
    if (buffer.trim()) onLine(buffer.trim())
  }
}

/** JSON-RPC 2.0 over a Recording (Codex app-server, ACP). Server requests go to `onRequest`; unhandled ones get -32601. */
export class RpcRecording {
  private next = 0
  onRequest: (method: string, params: Frame) => unknown | undefined = () => undefined

  constructor(readonly rec: Recording) {
    rec.onFrame((frame) => {
      if (typeof frame.method !== "string" || frame.id === undefined) return
      const answer = this.onRequest(frame.method, (frame.params ?? {}) as Frame)
      if (answer === undefined) rec.send({ jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: "not handled by the recorder" } })
      else rec.send({ jsonrpc: "2.0", id: frame.id, result: answer } as Frame)
    })
  }

  async request(method: string, params: unknown, timeoutMs = 30_000): Promise<Frame> {
    const id = ++this.next
    this.rec.send({ jsonrpc: "2.0", id, method, params } as Frame)
    const reply = await this.rec.waitFor((frame) => frame.id === id && !("method" in frame), timeoutMs, `${method} reply`)
    if (reply.error) throw new Error(`${method}: ${JSON.stringify(reply.error)}`)
    return (reply.result ?? {}) as Frame
  }

  notify(method: string, params?: unknown) {
    this.rec.send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) } as Frame)
  }

  /** The next notification `match` accepts. */
  notification(match: (method: string, params: Frame) => boolean, timeoutMs: number, what: string): Promise<Frame> {
    return this.rec.waitFor(
      (frame) => typeof frame.method === "string" && frame.id === undefined && match(frame.method, (frame.params ?? {}) as Frame),
      timeoutMs,
      what,
    )
  }
}

// Keys whose values are secrets or identify the owner.
const SECRET_KEY = /token|secret|password|api[_-]?key|authorization|cookie|credential|session[_-]?key/i
const PERSON_KEY = /^(email|e-mail|userEmail|login|username|organization|organizationName|orgName|accountName|(account|user|org|organization)[_-]?(id|uuid))$/i
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g
// API keys (sk-…, xai-…) and bearer tokens, wherever they show up in text.
const KEY_TEXT = /\b(sk|xai|ghp|gho|github_pat)[-_][A-Za-z0-9_-]{12,}\b|Bearer\s+[A-Za-z0-9._~+/=-]{12,}/g

/** Well-known places a user skill or slash-command might live, relative to a home directory. */
const USER_SKILL_DIRS = [
  ".claude/skills",
  ".claude/commands",
  ".agents/skills",
  ".codex/skills",
  ".copilot/skills",
]

/**
 * Skill / command names found on disk under `home`. Recorders pass the real home, not the isolated
 * temp one, so the owner's skills can be stripped from a frame even when the CLI ignored --safe-mode.
 * Names are never logged.
 */
export function collectUserSkillNames(home = homedir()): Set<string> {
  const names = new Set<string>()
  for (const relative of USER_SKILL_DIRS) {
    const root = join(home, relative)
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const stem = entry.name.replace(/\.(md|txt|toml|json|yaml|yml)$/i, "")
      if (stem && !stem.startsWith(".")) names.add(stem)
    }
  }
  return names
}

export function isUserCommand(command: unknown, userSkills: Set<string>): boolean {
  if (!command || typeof command !== "object") return false
  const entry = command as Frame
  const name = typeof entry.name === "string" ? entry.name : ""
  if (name.startsWith("<elided")) return false
  if (entry.builtin === false) return true
  if (entry.builtin === true) return false
  const meta = entry._meta
  if (meta && typeof meta === "object") {
    const scope = (meta as Frame).scope
    if (scope === "user") return true
    if (scope === "bundled" || scope === "built-in" || scope === "builtin") return false
  }
  return name !== "" && userSkills.has(name)
}

/** Replace user-scoped skills / commands with a count, and drop a personal output style name. */
export function elideUserSkills(value: Frame, userSkills: Set<string>): { frame: Frame; note: string } | undefined {
  const notes: string[] = []
  const frame = walk(value, "") as Frame
  if (notes.length === 0) return undefined
  return { frame, note: notes.join(", ") }

  function walk(node: unknown, path: string): unknown {
    if (Array.isArray(node)) {
      const leaf = path.split(".").pop() ?? ""
      if (leaf === "availableCommands") {
        const kept: unknown[] = []
        let removed = 0
        for (const command of node) {
          if (isUserCommand(command, userSkills)) removed++
          else kept.push(walk(command, `${path}[]`))
        }
        if (removed === 0) return kept
        kept.push({ name: `<elided: ${removed} user commands>`, description: "" })
        notes.push(`availableCommands ${removed} user commands`)
        return kept
      }
      if (leaf === "availableSkillDetails") {
        const kept: unknown[] = []
        let removed = 0
        for (const detail of node) {
          const name = detail && typeof detail === "object" && typeof (detail as Frame).name === "string" ? ((detail as Frame).name as string) : ""
          const level = detail && typeof detail === "object" ? (detail as Frame).level : undefined
          if ((name && userSkills.has(name)) || level === "user") removed++
          else kept.push(detail)
        }
        if (removed === 0) return node
        notes.push(`availableSkillDetails ${removed} user skills`)
        return kept.length === 0 ? `<elided: ${removed} user skill details>` : [...kept, `<elided: ${removed} user skill details>`]
      }
      return node.map((item) => walk(item, `${path}[]`))
    }
    if (node && typeof node === "object") {
      const out: Frame = {}
      for (const [key, item] of Object.entries(node as Frame)) {
        if (key === "output_style" && typeof item === "string" && item !== "default" && item !== "<elided>") {
          out[key] = "<elided>"
          notes.push("output_style")
        } else {
          out[key] = walk(item, path ? `${path}.${key}` : key)
        }
      }
      return out
    }
    return node
  }
}

/** Redaction only: home and temp paths, ids, keys, the account's email. Structure and other text stay as recorded. */
export class Redactor {
  private readonly ids = new Map<string, string>()
  private readonly paths: [string, string][]

  constructor(root: string) {
    const variants = (path: string) => {
      const list = [path]
      try {
        list.push(realpathSync(path))
      } catch {}
      return [...new Set(list)]
    }
    // Longest first, so the temp root wins over the home it may sit under.
    this.paths = [
      ...variants(join(root, "work")).map((path): [string, string] => [path, "$CWD"]),
      ...variants(join(root, "home")).map((path): [string, string] => [path, "$HOME_ISOLATED"]),
      ...variants(root).map((path): [string, string] => [path, "$ROOT"]),
      ...variants(tmpdir()).map((path): [string, string] => [path, "$TMPDIR"]),
      ...variants(homedir()).map((path): [string, string] => [path, "~"]),
      // The computer's name (Codex serverName, prompts that show the host).
      ...[hostname(), hostname().replace(/\.local$/, "")].map((name): [string, string] => [name, "$HOST"]),
      // The login name (ls -l output, process lists).
      [userInfo().username, "user"] as [string, string],
    ].filter(([path]) => path.length > 2).sort((a, b) => b[0].length - a[0].length)
  }

  value(value: unknown, key = ""): unknown {
    // The owner's own MCP servers (Grok announces them): commands, URLs and env values are local config.
    if (key === "mcpServers" && Array.isArray(value) && value.length > 0) return [`<redacted: ${value.length} local MCP servers>`]
    if (typeof value === "string") {
      if (value && (SECRET_KEY.test(key) || PERSON_KEY.test(key))) return "<redacted>"
      return this.text(value)
    }
    if (Array.isArray(value)) return value.map((item) => this.value(item, key))
    if (value && typeof value === "object") {
      const out: Frame = {}
      for (const [name, item] of Object.entries(value)) out[name] = this.value(item, name)
      return out
    }
    return value
  }

  text(text: string): string {
    let out = text.replace(KEY_TEXT, "<redacted>")
    for (const [path, mark] of this.paths) out = out.split(path).join(mark)
    out = out.replace(UUID, (id) => this.id(id.toLowerCase()))
    return out.replace(EMAIL, "user@example.com")
  }

  // Same id, same stand-in, in a valid UUID shape so parsers still accept it.
  private id(id: string): string {
    let mapped = this.ids.get(id)
    if (!mapped) {
      mapped = `00000000-0000-4000-8000-${String(this.ids.size + 1).padStart(12, "0")}`
      this.ids.set(id, mapped)
    }
    return mapped
  }
}

export function cliVersion(cli: string): string {
  const run = Bun.spawnSync([cli, "--version"], { stdout: "pipe", stderr: "pipe" })
  const text = `${run.stdout.toString()}${run.stderr.toString()}`.trim().split("\n")[0] ?? ""
  return text.match(/\d+\.\d+\.\d+[\w.-]*/)?.[0] ?? (text || "unknown")
}

function usage(agent: string): string {
  return [
    `usage: bun scripts/record/record-${agent}.ts [--dry-run] [--run] [--paid] [--only name,name]`,
    "  --dry-run  (default) list the scenarios and the command each would run",
    "  --run      run the free scenarios (no model is called)",
    "  --paid     with --run, also run the scenarios that call a model; only with the owner's approval",
  ].join("\n")
}

/** Entry point shared by the recorders. */
export async function runRecorder(spec: RecorderSpec, argv = process.argv.slice(2)) {
  if (argv.includes("--help")) return void console.log(usage(spec.agent))
  const run = argv.includes("--run") && !argv.includes("--dry-run")
  const paid = argv.includes("--paid")
  const onlyIndex = argv.indexOf("--only")
  const only = onlyIndex >= 0 ? new Set((argv[onlyIndex + 1] ?? "").split(",").filter(Boolean)) : undefined
  const version = cliVersion(spec.cli)
  const userSkills = collectUserSkillNames()
  const picked = spec.scenarios.filter((scenario) => !only || only.has(scenario.name))
  const outDir = resolve(import.meta.dir, "../../src/adapter/fixtures", spec.agent, "recorded")
  let failures = 0

  console.log(`${spec.agent}: ${spec.cli} ${version} → ${outDir}`)
  for (const scenario of picked) {
    const will = scenario.free ? run : run && paid
    const tag = scenario.free ? "free" : `paid${scenario.cost ? ` ${scenario.cost}` : ""}`
    console.log(`  ${will ? "run " : "list"}  ${scenario.name.padEnd(20)} ${tag.padEnd(14)} ${scenario.summary}`)
    if (!will) continue
    if (scenario.keys && !existsSync(TEST_KEYS)) {
      console.log(`        skipped: ${TEST_KEYS} is missing`)
      continue
    }
    const root = mkdtempSync(join(tmpdir(), `rudder-record-${spec.agent}-`))
    const cwd = join(root, "work")
    const home = join(root, "home")
    mkdirSync(cwd)
    mkdirSync(home)
    const env = spec.setup?.(home, scenario) ?? {}
    const lines: Line[] = []
    const procs: Recording[] = []
    const start = (extraArgs: string[] = []) => {
      const shown = [...spec.argv.filter((arg) => !scenario.dropArgs?.includes(arg)), ...extraArgs]
      const exports = scenario.keys ? [...(spec.keyExports ?? []), ...(scenario.afterKeys ?? [])] : []
      const launch = scenario.keys
        ? ["sh", "-c", `set -a; . "$RUDDER_TEST_KEYS"; set +a; ${exports.map((line) => `${line}; `).join("")}exec "$@"`, "sh", ...shown]
        : shown
      const rec = new Recording(lines, launch, shown, cwd, { ...env, ...(scenario.keys ? { RUDDER_TEST_KEYS: TEST_KEYS } : {}) })
      procs.push(rec)
      return rec
    }
    let failure: unknown
    try {
      await scenario.run({ cwd, start })
    } catch (error) {
      failure = error
    } finally {
      for (const proc of procs) await proc.close()
    }
    const redactor = new Redactor(root)
    const error = failure ? redactor.text(failure instanceof Error ? failure.message : String(failure)) : undefined
    const elided = new Set<string>()
    const kept = lines.map((line) => {
      if (!("frame" in line)) return line
      let frame = line.frame
      const skills = elideUserSkills(frame, userSkills)
      if (skills) {
        frame = skills.frame
        elided.add(skills.note)
      }
      if (spec.elide) {
        const shrunk = spec.elide(frame, scenario)
        if (shrunk) {
          frame = shrunk.frame
          elided.add(shrunk.note)
        }
      }
      return frame === line.frame ? line : { ...line, frame }
    })
    const body = kept.map((line) => JSON.stringify(redactor.value(line)))
    const header = { recorded: { cli: `${spec.cli} ${version}`, at: new Date().toISOString(), scenario: scenario.name, ...(error ? { error } : {}), ...(elided.size ? { elided: [...elided] } : {}) } }
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, `${scenario.name}.jsonl`), `${[JSON.stringify(header), ...body].join("\n")}\n`)
    rmSync(root, { recursive: true, force: true })
    if (error) failures += 1
    console.log(`        ${error ? `error: ${error}` : "ok"} · ${lines.length} lines`)
  }
  if (!run) console.log("dry run: nothing started. --run records the free scenarios; --run --paid also the paid ones.")
  if (failures) process.exitCode = 1
}
