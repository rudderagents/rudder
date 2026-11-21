// A child process that speaks newline-delimited text over stdio: the transport under every adapter.
import { redactSecrets } from "./redact"
import { killTree, planSpawn } from "../platform/spawn"

export type LineProcessOptions = {
  cwd?: string
  env?: Record<string, string | undefined>
  // Called once per non-empty, trimmed stdout line. A throw is logged and the next line is still read.
  onLine(line: string): void
  // Bytes of stderr kept for error messages (the pipe is always drained, or the child blocks on it).
  stderrMax?: number
  formatStderr?: (tail: string) => string
  // A stdout line longer than this (in characters) stops the child instead of growing the buffer without end.
  maxLineLength?: number
}

export type LineProcess = {
  readonly pid: number
  // Appends the newline. Write errors are swallowed: `exited` reports the failure.
  write(line: string): void
  // For error messages: the stderr tail, led by rudderd's own reason when it stopped the child (an over-long line).
  stderrTail(): string
  // Exit code, once the process is gone and stdout drained (bounded: a grandchild may hold the pipe open).
  readonly exited: Promise<number>
  // closeStdinFirst: end stdin and give the child graceMs to leave on its own. Then SIGTERM, then SIGKILL.
  stop(options?: { closeStdinFirst?: boolean; graceMs?: number }): Promise<void>
}

const DRAIN_MS = 500
const TERM_GRACE_MS = 2_000
const KILL_WAIT_MS = 1_000
// The largest legit line is one inline image (INLINE_IMAGE_LIMIT_BYTES as base64, ~10.7M chars) plus its JSON;
// a line is buffered whole before parsing, so a looser cap lets one runaway line hold that much memory.
export const MAX_LINE_LENGTH = 16 * 1024 * 1024

export function spawnLines(argv: string[], options: LineProcessOptions): LineProcess {
  const name = argv[0] ?? "agent"
  const stderrMax = options.stderrMax ?? 2_000
  const maxLineLength = options.maxLineLength ?? MAX_LINE_LENGTH
  // Windows resolves `.cmd` shims and hides the console window (platform/spawn.ts); elsewhere argv is unchanged.
  // Off Windows each agent gets its own process group, so stop() reaches the tools it started too (kill(-pid));
  // on Windows stop() kills the tree (`killTree`). rudderd's shutdown disposes every adapter, which stops them.
  const plan = planSpawn(argv, options.env ?? process.env)
  const child = Bun.spawn(plan.argv, {
    cwd: options.cwd,
    env: options.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    detached: process.platform !== "win32",
    ...plan.options,
  })
  let stderr = ""
  let stdinOpen = true
  let stopping: Promise<void> | undefined
  let failure: string | undefined

  const overflow = () => {
    if (failure) return
    failure = `rudderd stopped ${name}: a stdout line ran past ${maxLineLength} characters`
    console.warn(failure)
    void stop()
  }

  const deliver = (raw: string) => {
    if (failure) return
    if (raw.length > maxLineLength) return overflow()
    const line = raw.trim()
    if (!line) return
    try {
      options.onLine(line)
    } catch (error) {
      console.warn(`rudderd: ${name} line handler failed:`, error)
    }
  }

  const stdoutDone = (async () => {
    const decoder = new TextDecoder()
    let buffer = ""
    const feed = (text: string) => {
      if (failure) return
      // Only the new text is scanned, so a long line arriving in many chunks stays linear.
      let index = text.indexOf("\n")
      if (index < 0) {
        buffer += text
      } else {
        deliver(buffer + text.slice(0, index))
        let start = index + 1
        for (index = text.indexOf("\n", start); index >= 0; index = text.indexOf("\n", start)) {
          deliver(text.slice(start, index))
          start = index + 1
        }
        buffer = text.slice(start)
      }
      if (buffer.length > maxLineLength) {
        buffer = ""
        overflow()
      }
    }
    for await (const chunk of child.stdout) feed(decoder.decode(chunk, { stream: true }))
    feed(decoder.decode())
    deliver(buffer)
  })().catch(() => {})

  const stderrDone = (async () => {
    const decoder = new TextDecoder()
    for await (const chunk of child.stderr) stderr = (stderr + decoder.decode(chunk, { stream: true })).slice(-stderrMax)
  })().catch(() => {})

  const exited = child.exited.then(async (code) => {
    // Whatever ended the agent (stop() closing stdin or signalling it, a crash, an OOM kill, its own exit), what it
    // started in its group (dev servers, background shells) would be orphaned, so the group goes with it: TERM, then
    // KILL for anything still there after the grace.
    reapGroup()
    await Promise.race([Promise.all([stdoutDone, stderrDone]), Bun.sleep(DRAIN_MS)])
    return code
  })

  const gone = (ms: number) => Promise.race([exited.then(() => true), Bun.sleep(ms).then(() => false)])

  const closeStdin = () => {
    if (!stdinOpen) return
    stdinOpen = false
    try {
      void Promise.resolve(child.stdin.end()).catch(() => {})
    } catch {
      // already closed
    }
  }

  const signal = (sig: NodeJS.Signals) => {
    // Windows: the whole tree, or a shim's node.exe outlives its cmd.exe. Elsewhere this is false and nothing changes.
    if (killTree(child.pid)) return
    try {
      process.kill(-child.pid, sig)
    } catch {
      try {
        child.kill(sig)
      } catch {
        // already exited
      }
    }
  }

  // Off Windows only: there the tree is found through the parent, which is gone by now.
  const reapGroup = () => {
    if (process.platform === "win32") return
    const group = (sig: NodeJS.Signals) => {
      try {
        process.kill(-child.pid, sig)
        return true
      } catch {
        return false
      }
    }
    if (group("SIGTERM")) setTimeout(() => group("SIGKILL"), TERM_GRACE_MS).unref?.()
  }

  const stop = ({ closeStdinFirst = false, graceMs = TERM_GRACE_MS } = {}) => {
    stopping ??= (async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        // The agent left on its own; anything it started in its group goes too.
        signal("SIGTERM")
        return void (await exited)
      }
      if (closeStdinFirst) {
        closeStdin()
        if (await gone(graceMs)) return
      }
      signal("SIGTERM")
      if (await gone(closeStdinFirst ? TERM_GRACE_MS : graceMs)) return
      signal("SIGKILL")
      await gone(KILL_WAIT_MS)
    })()
    return stopping
  }

  return {
    pid: child.pid,
    exited,
    write(line) {
      if (!stdinOpen) return
      try {
        child.stdin.write(`${line}\n`)
        void Promise.resolve(child.stdin.flush()).catch(() => {})
      } catch {
        // the child is gone; `exited` reports it
      }
    },
    stderrTail() {
      const tail = options.formatStderr ? options.formatStderr(stderr) : stderr.trim()
      // Shown on the phone: no credential leaves the computer in it.
      return redactSecrets(failure ? [failure, tail].filter(Boolean).join("\n") : tail)
    },
    stop,
  }
}
