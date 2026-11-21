import { describe, expect, test } from "bun:test"
import { spawnRpc } from "./jsonrpc"
import { INLINE_IMAGE_LIMIT_BYTES } from "./images"
import { MAX_LINE_LENGTH, spawnLines } from "./stdio"

function collect(argv: string[], onLine?: (line: string) => void, maxLineLength?: number) {
  const lines: string[] = []
  const proc = spawnLines(argv, {
    onLine: (line) => {
      lines.push(line)
      onLine?.(line)
    },
    maxLineLength,
  })
  return { proc, lines }
}

describe("spawnLines", () => {
  test("splits lines across chunks and delivers the last unterminated line", async () => {
    const { proc, lines } = collect(["sh", "-c", "printf 'a\\n\\n  b  \\nc'; sleep 0.05; printf 'd\\ne'"])
    expect(await proc.exited).toBe(0)
    expect(lines).toEqual(["a", "b", "cd", "e"])
  })

  test("a throwing handler does not stop the reader", async () => {
    const { proc, lines } = collect(["sh", "-c", "echo one; echo two; echo three"], (line) => {
      if (line === "one") throw new Error("boom")
    })
    await proc.exited
    expect(lines).toEqual(["one", "two", "three"])
  })

  test("exit is reported although a grandchild holds stdout open", async () => {
    const { proc, lines } = collect(["sh", "-c", "echo last; sleep 6 & exit 0"])
    const started = Date.now()
    expect(await proc.exited).toBe(0)
    expect(Date.now() - started).toBeLessThan(1500)
    expect(lines).toEqual(["last"])
  })

  test("stop signals the whole process group, so a grandchild does not outlive the agent", async () => {
    let grandchild = 0
    const { proc } = collect(["sh", "-c", "sleep 30 & echo $!; wait"], (line) => {
      grandchild = Number(line)
    })
    const started = Date.now()
    while (!grandchild) {
      if (Date.now() - started > 2000) throw new Error("grandchild pid not reported")
      await Bun.sleep(5)
    }
    await proc.stop({ graceMs: 200 })
    await Bun.sleep(50)
    expect(() => process.kill(grandchild, 0)).toThrow()
  })

  // Audit 2026-11-10 #24: an agent that dies on its own (no stop()) left its dev servers and shells running.
  test("an agent that dies without stop() takes its process group with it", async () => {
    let grandchild = 0
    const { proc } = collect(["sh", "-c", "sleep 30 & echo $!; sleep 0.2; kill -9 $$"], (line) => {
      grandchild = Number(line)
    })
    await proc.exited
    expect(grandchild).toBeGreaterThan(0)
    await Bun.sleep(50)
    expect(() => process.kill(grandchild, 0)).toThrow()
  })

  // Second review: the normal stop (idle timeout, delete, shutdown) closes stdin and the agent leaves on its own;
  // that path signalled nothing, so its background jobs outlived it.
  test("an agent that leaves on stdin EOF during stop() takes its process group with it", async () => {
    let grandchild = 0
    const { proc } = collect(["sh", "-c", "sleep 30 & echo $!; read x; exit 0"], (line) => {
      grandchild = Number(line)
    })
    const started = Date.now()
    while (!grandchild) {
      if (Date.now() - started > 2000) throw new Error("grandchild pid not reported")
      await Bun.sleep(5)
    }
    await proc.stop({ closeStdinFirst: true, graceMs: 2000 })
    await Bun.sleep(50)
    expect(() => process.kill(grandchild, 0)).toThrow()
  })

  test("stop escalates to SIGKILL for a child that ignores SIGTERM and stdin EOF", async () => {
    const { proc } = collect(["sh", "-c", "trap '' TERM; while :; do sleep 0.05; done"])
    await Bun.sleep(100)
    const started = Date.now()
    await proc.stop({ closeStdinFirst: true, graceMs: 200 })
    expect(Date.now() - started).toBeLessThan(4000)
    expect(await Promise.race([proc.exited, Bun.sleep(100).then(() => "alive")])).not.toBe("alive")
  }, 10_000)

  test("stderr keeps a bounded tail; writes after exit are harmless", async () => {
    const proc = spawnLines(["sh", "-c", "read line; echo \"got $line\" >&2; exit 2"], { onLine: () => {}, stderrMax: 5 })
    proc.write("hello")
    expect(await proc.exited).toBe(2)
    expect(proc.stderrTail()).toBe("ello")
    proc.write("late")
    await proc.stop()
  })

  test("a stdout line past the cap stops the child and says why", async () => {
    const { proc, lines } = collect(["sh", "-c", "echo ok; while :; do printf 0123456789; done"], undefined, 1_000)
    expect(await proc.exited).toBe(143)
    expect(lines).toEqual(["ok"])
    expect(proc.stderrTail()).toBe("rudderd stopped sh: a stdout line ran past 1000 characters")
  })

  test("the default cap passes the largest inline image and stops a runaway line", async () => {
    const image = collect([
      "sh",
      "-c",
      `printf '{"data":"'; head -c ${INLINE_IMAGE_LIMIT_BYTES} /dev/zero | base64 | tr -d '\\n'; printf '"}\\n'`,
    ])
    expect(await image.proc.exited).toBe(0)
    expect(image.lines).toHaveLength(1)
    expect(image.lines[0]?.length).toBeGreaterThan(Math.ceil(INLINE_IMAGE_LIMIT_BYTES / 3) * 4)

    const runaway = collect(["sh", "-c", "yes 0123456789 | tr -d '\\n'"])
    expect(await runaway.proc.exited).not.toBe(0)
    expect(runaway.lines).toEqual([])
    expect(runaway.proc.stderrTail()).toBe(`rudderd stopped sh: a stdout line ran past ${MAX_LINE_LENGTH} characters`)
  })

  test("a JSON-RPC request in flight fails with the cap's reason", async () => {
    const handlers = { onNotification() {}, onRequest: async () => null, onClose() {} }
    const rpc = spawnRpc(["sh", "-c", "while :; do printf 0123456789; done"], handlers, { maxLineLength: 1_000 })
    await expect(rpc.request("initialize", {}, 0)).rejects.toThrow(
      "sh exited (code 143): rudderd stopped sh: a stdout line ran past 1000 characters",
    )
    expect(rpc.closed).toBe(true)
  })
})

 test("shared RPC drains session B after session A throws, before reporting pipe close", async () => {
  const seen: string[] = []
  let resolve!: () => void
  const closed = new Promise<void>(done => { resolve = done })
  const frames = [{ method: "A", params: {} }, { method: "B", params: {} }].map(frame => JSON.stringify(frame)).join("\n")
  const rpc = spawnRpc([process.execPath, "-e", `process.stdout.write(${JSON.stringify(frames)})`], {
    onNotification(method) { if (method === "A") throw new Error("injected A"); seen.push(method) },
    onRequest: async () => null,
    onClose() { seen.push("closed"); resolve() },
  })
  await closed
  expect(seen).toEqual(["B", "closed"])
  await rpc.close()
})
