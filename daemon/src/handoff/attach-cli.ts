// `rudder attach <short id> [--now]`: asks the running daemon, over its own socket, to hand a
// session to this terminal, runs the agent's own CLI there with the terminal's TTY, and gives the session back to
// the phone when it exits. Copy is zh / en by LANG.
import { homedir } from "node:os"
import type { LocalAnswer } from "../local"
import type { TerminalLocale } from "../qr"

export type AttachDeps = {
  request: (method: "GET" | "POST", route: string, body?: unknown) => Promise<LocalAnswer | null>
  /** Runs argv in cwd with this terminal's stdio; resolves to its exit code. */
  run: (argv: string[], cwd: string) => Promise<number>
  /** null when `command` is not on PATH. */
  which: (command: string) => string | null
  out: (line: string) => void
  err: (line: string) => void
  locale: TerminalLocale
  tty: boolean
  pid: number
  sleep: (ms: number) => Promise<void>
  /** Called once Ctrl-C while waiting should cancel; returns a function that stops listening. */
  onInterrupt: (handler: () => void) => () => void
  claude: string
}

type Session = { id: string; title: string; agent: string; cwd: string }
type Ready = { state: "ready"; session: Session; argv: string[]; cwd: string }
type Waiting = { state: "waiting"; session: Session }

const COPY = {
  zh: {
    title: (title: string) => `「${title}」`,
    waiting: "手机上的这一轮还在跑，等它结束…（Ctrl-C 取消，手机不受影响）",
    handed: "已交给终端，手机上这个会话变为只能看。",
    agent: "（Claude 界面）",
    back: (count: number) => `已交还手机：终端里新增 ${count} 条消息已同步。`,
    notFound: (id: string) => `找不到会话 ${id}。在手机上打开会话 → … → 回电脑继续，看它的短号。`,
    notRunning: "Rudder 没在运行。先执行 rudder，或 rudder install 让它常驻。",
    noClaude: "这台电脑上找不到 claude 命令。装好 Claude Code 后再试。",
    ambiguous: (id: string) => `短号 ${id} 对应不止一个会话，多输几位再试。`,
    held: "这个会话已经在另一个终端里打开了。",
    unsupported: "这个会话的 agent 还不能在终端里接着用，目前只支持 Claude Code。",
    cancelled: "已取消，手机上的会话不受影响。",
  },
  en: {
    title: (title: string) => `“${title}”`,
    waiting: "A turn is still running on the phone. Waiting for it… (Ctrl-C cancels; the phone is unaffected)",
    handed: "Handed to the terminal. This session is view only on the phone.",
    agent: "(Claude)",
    back: (count: number) => `Back on the phone: ${count} new messages from the terminal are synced.`,
    notFound: (id: string) => `No session ${id}. On the phone, open the session → … → Continue on computer to see its short id.`,
    notRunning: "Rudder isn't running. Run rudder first, or rudder install to keep it running.",
    noClaude: "Can't find the claude command on this computer. Install Claude Code and try again.",
    ambiguous: (id: string) => `${id} matches more than one session. Type a few more characters.`,
    held: "This session is already open in another terminal.",
    unsupported: "This session's agent can't continue in a terminal yet; only Claude Code can for now.",
    cancelled: "Cancelled. The session on the phone is unaffected.",
  },
}

const tilde = (path: string) => {
  const home = homedir()
  return path === home ? "~" : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

/** The argv as the design prints it: the native id cut after its second group (`7c1e9b2a-41d0-…`). */
export function shownCommand(argv: string[]): string {
  return argv
    .map((part, index) => (index > 0 && /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(part) && part.length > 15 ? `${part.slice(0, 14)}…` : part))
    .map((part, index) => (index === 0 ? part.split("/").at(-1)! : part))
    .join(" ")
}

export async function attach(deps: AttachDeps, target: string, now: boolean): Promise<number> {
  const copy = COPY[deps.locale]
  const dim = (text: string) => (deps.tty ? `\u001b[2m${text}\u001b[0m` : text)
  const fail = (line: string) => {
    deps.err(`✗ ${line}`)
    return 1
  }
  if (!deps.which(deps.claude)) return fail(copy.noClaude)
  let answer = await deps.request("POST", "/local/attach", { target, now, pid: deps.pid })
  if (answer === null) return fail(copy.notRunning)
  let printedHeader = false
  const header = (session: Session) => {
    if (printedHeader) return
    printedHeader = true
    deps.out(`⎈ Rudder · ${copy.title(session.title)} · ${session.agent} · ${tilde(session.cwd)}`)
  }
  let interrupted = false
  const stop = deps.onInterrupt(() => {
    interrupted = true
  })
  try {
    let waited = false
    while (true) {
      if (answer === null) return fail(copy.notRunning)
      const body = (answer.body ?? {}) as Partial<Ready | Waiting> & { code?: string; error?: string }
      if (answer.status !== 200) {
        if (body.code === "not_found") return fail(copy.notFound(target))
        if (body.code === "ambiguous") return fail(copy.ambiguous(target))
        if (body.code === "held_elsewhere") return fail(copy.held)
        if (body.code === "unsupported") return fail(copy.unsupported)
        return fail(body.error ?? `the daemon answered ${answer.status}`)
      }
      if (body.session) header(body.session)
      if (body.state === "ready") break
      if (!waited) {
        deps.out(`  ${copy.waiting}`)
        waited = true
      }
      await deps.sleep(1000)
      if (interrupted) {
        deps.out(`  ${copy.cancelled}`)
        return 130
      }
      answer = await deps.request("POST", "/local/attach", { target, now: false, pid: deps.pid })
    }
  } finally {
    stop()
  }
  const ready = answer.body as Ready
  deps.out(`  ${copy.handed}`)
  deps.out(dim(`  → ${shownCommand(ready.argv)}`))
  const binary = deps.which(ready.argv[0]!)
  let code: number
  try {
    if (!binary) throw new Error("missing")
    code = await deps.run([binary, ...ready.argv.slice(1)], ready.cwd || process.cwd())
  } catch {
    await deps.request("POST", "/local/attach/done", { sessionId: ready.session.id })
    return fail(copy.noClaude)
  }
  const done = await deps.request("POST", "/local/attach/done", { sessionId: ready.session.id })
  const added = Number((done?.body as { added?: unknown } | undefined)?.added ?? 0)
  deps.out(`⎈ ${copy.back(Number.isFinite(added) ? added : 0)}`)
  return code
}

/** The real terminal: stdio inherited; Ctrl-C reaches Claude through the terminal's process group, not this one. */
export function terminalRun(argv: string[], cwd: string): Promise<number> {
  const ignore = () => {}
  process.on("SIGINT", ignore)
  const child = Bun.spawn(argv, { cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" })
  return child.exited.finally(() => {
    process.off("SIGINT", ignore)
  })
}
