import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import {
  cpuUsage,
  createPerfSampler,
  darwinMemory,
  isTunnel,
  parseDuration,
  parseMeminfo,
  parseNetstat,
  parseProcNetDev,
  parseDarwinMachineName,
  parsePrettyName,
  parseProductName,
  parseProductVersion,
  parsePs,
  parseSysctl,
  parseVmStat,
  pressureLevel,
  processTree,
  readMachineIdentity,
  runCommand,
  swapUsage,
  type CommandResult,
  type CpuTimes,
  type PerfSamplerOptions,
  type PsRow,
} from "./perf"

// darwin-*: captured on an M5 Max Mac (MACs and IPs replaced). linux-*: representative /proc formats.
const FIXTURES = join(import.meta.dir, "fixtures", "perf")
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8")
const GiB = 1024 ** 3

describe("cpu tick deltas", () => {
  const t = (user: number, sys: number, idle: number, nice = 0, irq = 0): CpuTimes => ({ user, nice, sys, idle, irq })

  test("busy share of each core's ticks since the previous reading; total weighs every tick", () => {
    const prev = [t(100, 50, 850), t(0, 0, 1000)]
    const next = [t(160, 70, 870, 10, 10), t(25, 25, 1050)]
    // core 0: busy 60+20+10+10 = 100 of 120 ticks; core 1: 50 of 100.
    const usage = cpuUsage(prev, next)
    expect(usage.cores.map((value) => Number(value.toFixed(2)))).toEqual([83.33, 50])
    expect(usage.percent).toBeCloseTo((150 / 220) * 100, 6)
  })

  test("no ticks elapsed, a core that went away, or counters that went backwards read as 0", () => {
    expect(cpuUsage([t(1, 1, 1)], [t(1, 1, 1)])).toEqual({ percent: 0, cores: [0] })
    expect(cpuUsage([], [t(5, 5, 5)])).toEqual({ percent: 0, cores: [0] })
    expect(cpuUsage([t(9, 9, 9)], [t(1, 1, 1)])).toEqual({ percent: 0, cores: [0] })
  })
})

describe("macOS parsers (captured output)", () => {
  test("vm_stat: page size from the header, counts keyed by label", () => {
    const vm = parseVmStat(fixture("darwin-vm_stat.txt"))
    expect(vm.pageSize).toBe(16384)
    expect(vm.pages["Pages active"]).toBe(1361063)
    expect(vm.pages["Pages wired down"]).toBe(682864)
    expect(vm.pages["Pages occupied by compressor"]).toBe(583386)
    // Quoted labels lose their quotes.
    expect(vm.pages["Translation faults"]).toBeGreaterThan(0)
  })

  test("used memory = (active + wired + occupied by compressor) × page size", () => {
    const memory = darwinMemory(parseVmStat(fixture("darwin-vm_stat.txt")))
    const page = 16384
    expect(memory).toEqual({
      usedBytes: (1361063 + 682864 + 583386) * page,
      activeBytes: 1361063 * page,
      wiredBytes: 682864 * page,
      compressedBytes: 583386 * page,
    })
    expect(() => darwinMemory(parseVmStat("garbage"))).toThrow(/vm_stat/)
  })

  test("sysctl: pressure level and swap usage", () => {
    const values = parseSysctl(fixture("darwin-sysctl.txt"))
    expect(pressureLevel(values.get("kern.memorystatus_vm_pressure_level"))).toBe("normal")
    expect(pressureLevel("2")).toBe("warn")
    expect(pressureLevel("4")).toBe("critical")
    expect(pressureLevel(undefined)).toBeNull()
    expect(swapUsage(values.get("vm.swapusage"))).toEqual({ totalBytes: 12288 * 1024 ** 2, usedBytes: Math.round(11102.69 * 1024 ** 2) })
    expect(swapUsage("total = 0.00M  used = 0.00M  free = 0.00M")).toEqual({ totalBytes: 0, usedBytes: 0 })
    expect(swapUsage("total = 2.00G  used = 512.00K  free = 1.99G")).toEqual({ totalBytes: 2 * GiB, usedBytes: 512 * 1024 })
    expect(swapUsage(undefined)).toBeNull()
  })

  test("netstat -ibn: counters of up interfaces with a routable address; loopback, down and address-less skipped", () => {
    const counters = parseNetstat(fixture("darwin-netstat-1.txt"))
    // en0: LAN IPv4; utun7: Tailscale 100.64/10; utun9: a ULA-only VPN. en1 and utun0-3 have no address beyond fe80.
    expect([...counters.keys()]).toEqual(["en0", "utun7", "utun9"])
    expect(counters.get("en0")).toEqual({ rxBytes: 196117180086, txBytes: 31508892599 })
    // Tunnel link rows have no address column; counters are read from the right.
    expect(counters.get("utun7")).toEqual({ rxBytes: 46442071, txBytes: 34815191 })
    expect(isTunnel("utun7")).toBe(true)
    expect(isTunnel("en0")).toBe(false)
  })

  test("ps: pid, ppid, rss KiB → bytes, %cpu, elapsed and cpu time in seconds", () => {
    const rows = parsePs(fixture("darwin-ps.txt"))
    expect(rows).toHaveLength(45)
    expect(rows[0]).toEqual({ pid: 1, ppid: 0, rssBytes: 26912 * 1024, cpuPercent: 0.3, elapsedSec: 12 * 86400 + 111, cpuSec: 156 * 60 + 48.67 })
    expect(rows[1]).toEqual({ pid: 297, ppid: 97909, rssBytes: 38320 * 1024, cpuPercent: 0, elapsedSec: 11 * 3600 + 8 * 60 + 57, cpuSec: 0.14 })
    expect(parsePs("  12  1  100  0.0  bogus  0:00.00\nnot a row\n")).toEqual([])
  })

  test("durations: [[dd-]hh:]mm:ss with optional fraction", () => {
    expect(parseDuration("05:07")).toBe(307)
    expect(parseDuration("1:02:03")).toBe(3723)
    expect(parseDuration("2-01:00:00")).toBe(2 * 86400 + 3600)
    expect(parseDuration("156:48.67")).toBeCloseTo(9408.67, 6)
    expect(parseDuration("x")).toBeNaN()
  })
})

describe("Linux parsers (/proc formats)", () => {
  test("meminfo: used = MemTotal − MemAvailable; swap = SwapTotal − SwapFree", () => {
    expect(parseMeminfo(fixture("linux-meminfo.txt"))).toEqual({
      totalBytes: 16303848 * 1024,
      usedBytes: (16303848 - 9876544) * 1024,
      swapTotalBytes: 4194300 * 1024,
      swapUsedBytes: (4194300 - 3145724) * 1024,
    })
  })

  test("net/dev: rx and tx bytes; loopback and silent interfaces skipped", () => {
    const counters = parseProcNetDev(fixture("linux-net-dev.txt"))
    expect([...counters]).toEqual([
      ["eth0", { rxBytes: 1234567890, txBytes: 987654321 }],
      ["wlan0", { rxBytes: 5000000, txBytes: 2500000 }],
    ])
  })
})

describe("process tree", () => {
  const row = (pid: number, ppid: number, rssKiB: number, cpuPercent = 0, cpuSec = 0, elapsedSec = 60): PsRow => ({
    pid,
    ppid,
    rssBytes: rssKiB * 1024,
    cpuPercent,
    cpuSec,
    elapsedSec,
  })

  test("a root plus every descendant; another root's subtree and excluded pids are not counted twice", () => {
    const rows = [row(10, 1, 100), row(20, 10, 200), row(21, 20, 300), row(30, 10, 50), row(40, 10, 70), row(41, 40, 5), row(99, 1, 999)]
    const children = processTree(rows)
    expect(children.collect(10, new Set([40]))).toEqual([10, 20, 30, 21])
    expect(children.collect(40)).toEqual([40, 41])
    expect(children.collect(12345)).toEqual([])
  })
})

describe("machine identity", () => {
  test("darwin: machine_name and the product version; chip stays out of model", async () => {
    const seen: string[][] = []
    const identity = await readMachineIdentity(
      "darwin",
      async (argv) => {
        seen.push(argv)
        const stdout = argv[0]?.endsWith("system_profiler") ? fixture("darwin-system-profiler.json") : fixture("darwin-sw-vers.txt")
        return { stdout, pid: 1, cpuMicros: 0 }
      },
      async () => {
        throw new Error("no files")
      },
    )
    expect(seen.map((argv) => argv.join(" ")).sort()).toEqual([
      "/usr/bin/sw_vers -productVersion",
      "/usr/sbin/system_profiler SPHardwareDataType -json",
    ])
    expect(identity).toEqual({ model: "Mac Studio", osVersion: "26.1" })
  })

  test("linux: product_name and PRETTY_NAME; a missing file or empty name is omitted", async () => {
    const identity = await readMachineIdentity(
      "linux",
      async () => {
        throw new Error("no commands")
      },
      async (path) => fixture(path.endsWith("product_name") ? "linux-product-name.txt" : "linux-os-release.txt"),
    )
    expect(identity).toEqual({ model: "ThinkPad X1 Carbon", osVersion: "Ubuntu 24.04.1 LTS" })
    const missing = await readMachineIdentity(
      "linux",
      async () => {
        throw new Error("no commands")
      },
      async () => {
        throw new Error("absent")
      },
    )
    expect(missing).toEqual({})
  })

  test("bad profiler JSON and a blank product name produce nothing", () => {
    expect(parseDarwinMachineName("{")).toBeUndefined()
    expect(parseDarwinMachineName('{"SPHardwareDataType":[{"machine_name":"  "}]}')).toBeUndefined()
    expect(parseProductVersion("\n26.1\n")).toBe("26.1")
    expect(parseProductName(" \n")).toBeUndefined()
    expect(parsePrettyName("NAME=Ubuntu\nPRETTY_NAME=''\n")).toBeUndefined()
    expect(parsePrettyName("PRETTY_NAME=Alpine")).toBe("Alpine")
  })
})

/** Fake command runner fed from fixtures; each call reports 1 ms of child CPU. */
function fakeRunner(outputs: Record<string, string[]>) {
  const calls: string[][] = []
  const run = async (argv: string[]): Promise<CommandResult> => {
    calls.push(argv)
    const name = argv[0]!.split("/").pop()!
    const queue = outputs[name]
    if (!queue?.length) throw new Error(`${name} unavailable`)
    return { stdout: queue.length > 1 ? queue.shift()! : queue[0]!, pid: 7000 + calls.length, cpuMicros: 1000 }
  }
  return { run, calls }
}

describe("sampler (fixtures, darwin)", () => {
  const ticks = (busy: number, idle: number): CpuTimes[] => [
    { user: busy, nice: 0, sys: 0, idle, irq: 0 },
    { user: busy / 2, nice: 0, sys: 0, idle, irq: 0 },
  ]
  const ps = (agentCpuSec: number) =>
    [
      `  500     1  20480   1.0    01:00:00   0:10.00`, // rudderd
      `  600   500 102400  50.0       10:00   1:${agentCpuSec.toFixed(2).padStart(5, "0")}`, // claude s1
      ...(agentCpuSec > 0 ? [`  601   600  51200   5.0       00:01   0:00.05`] : []), // its tool child, started since the baseline
      `  700   500 204800   9.0    02:00:00   5:00.00`, // codex app-server
      `  800   500   1024   0.0       00:01   0:00.01`, // a model probe: unclaimed child of rudderd
      `  900     1 999999  99.0       10:00  59:00.00`, // unrelated
    ].join("\n")

  function sampler(extra: Partial<PerfSamplerOptions> = {}) {
    let now = 1_000_000
    let cpuReads = 0
    const runner = fakeRunner({
      vm_stat: [fixture("darwin-vm_stat.txt")],
      sysctl: [fixture("darwin-sysctl.txt")],
      netstat: [fixture("darwin-netstat-1.txt"), fixture("darwin-netstat-2.txt")],
      ps: [ps(0), ps(1)],
    })
    const instance = createPerfSampler({
      platform: "darwin",
      run: runner.run,
      now: () => now,
      sleep: async (ms) => {
        now += ms
      },
      cpus: () => (cpuReads++ === 0 ? ticks(0, 0) : ticks(100, 300)),
      cpuModel: () => "Apple M5 Max",
      loadavg: () => [6.04, 6.1, 6.27],
      totalmem: () => 64 * GiB,
      uptime: () => 1036753,
      arch: "arm64",
      selfPid: 500,
      machineName: () => "studio",
      processes: () => [
        { agent: "claude", label: "Claude Code", pid: 600, sessionIds: ["s1"], shared: false },
        { agent: "codex", label: "Codex", pid: 700, sessionIds: ["s2", "s3"], shared: true },
        { agent: "claude", label: "Claude Code", pid: 4242, sessionIds: ["gone"], shared: false },
      ],
      baselineMs: 1000,
      readIdentity: async () => ({}),
      readDisk: async () => undefined,
      ...extra,
    })
    return { instance, runner, advance: (ms: number) => (now += ms) }
  }

  test("first sample takes its own baseline; numbers come from the deltas over it", async () => {
    const { instance, runner } = sampler()
    const sample = await instance.sample()
    // One baseline and one reading: four commands each.
    expect(runner.calls.map((argv) => argv[0])).toEqual([
      "/usr/bin/vm_stat",
      "/usr/sbin/sysctl",
      "/usr/sbin/netstat",
      "/bin/ps",
      "/usr/bin/vm_stat",
      "/usr/sbin/sysctl",
      "/usr/sbin/netstat",
      "/bin/ps",
    ])
    expect(sample.at).toBe(1_001_000)
    expect(sample.machine).toEqual({
      name: "studio",
      platform: "darwin",
      arch: "arm64",
      cpuModel: "Apple M5 Max",
      cores: 2,
      memoryBytes: 64 * GiB,
      uptimeSec: 1036753,
    })
    // core 0: 100 busy of 400; core 1: 50 of 350.
    // Rounded to 0.1 on the wire.
    expect(sample.cpu.cores).toEqual([25, 14.3])
    expect(sample.cpu.percent).toBe(20)
    expect(sample.cpu.load).toEqual([6.04, 6.1, 6.27])
    expect(sample.memory).toMatchObject({
      totalBytes: 64 * GiB,
      usedBytes: (1361063 + 682864 + 583386) * 16384,
      pressure: "normal",
      swapUsedBytes: Math.round(11102.69 * 1024 ** 2),
      swapTotalBytes: 12288 * 1024 ** 2,
    })
    const en0 = sample.network.interfaces.find((entry) => entry.name === "en0")!
    // 1 s between the two captures' counters.
    expect(en0).toEqual({ name: "en0", rxBytesPerSec: 196117299462 - 196117180086, txBytesPerSec: 31509078813 - 31508892599, tunnel: false })
    expect(sample.network.interfaces.map((entry) => [entry.name, entry.tunnel])).toEqual([["en0", false], ["utun7", true], ["utun9", true]])
    // Tunnelled bytes also cross en0: totals are en0 alone.
    expect([sample.network.rxBytesPerSec, sample.network.txBytesPerSec]).toEqual([en0.rxBytesPerSec, en0.txBytesPerSec])
    expect(sample.errors).toBeUndefined()
  })

  test("process rows: each root with its descendants, CPU from cpu-time deltas, rudderd keeps the rest, sorted by memory", async () => {
    const { instance } = sampler()
    const sample = await instance.sample()
    expect(sample.processes).toEqual([
      { agent: "codex", label: "Codex", pid: 700, sessionIds: ["s2", "s3"], shared: true, rssBytes: 204800 * 1024, cpuPercent: 0, uptimeSec: 7200, processCount: 1 },
      // claude: 1.00 s of cpu over 1 s (100 %), plus the child new since the baseline at its ps %cpu (5 %).
      { agent: "claude", label: "Claude Code", pid: 600, sessionIds: ["s1"], shared: false, rssBytes: (102400 + 51200) * 1024, cpuPercent: 105, uptimeSec: 600, processCount: 2 },
      // The probe (pid 800) counts toward rudderd; the sampler's own commands never do.
      { agent: "rudderd", label: "rudderd", pid: 500, sessionIds: [], shared: false, rssBytes: (20480 + 1024) * 1024, cpuPercent: 0, uptimeSec: 3600, processCount: 2 },
    ])
    expect(sample.limits.processRssWarnBytes).toBe(Math.round(64 * GiB * 0.1))
  })

  test("a failing command drops only its section and says why", async () => {
    const runner = fakeRunner({ vm_stat: [fixture("darwin-vm_stat.txt")], netstat: [fixture("darwin-netstat-1.txt")], ps: ["  500     1  20480   1.0    01:00:00   0:10.00"] })
    const { instance } = sampler({ run: runner.run })
    const sample = await instance.sample()
    expect(sample.memory.pressure).toBeNull()
    expect(sample.memory.swapUsedBytes).toBeNull()
    expect(sample.memory.usedBytes).toBeGreaterThan(0)
    expect(sample.errors).toEqual(["sysctl: sysctl unavailable"])
  })

  test("concurrent callers share one reading; a recent reading is the next baseline", async () => {
    const { instance, runner, advance } = sampler()
    const [a, b] = await Promise.all([instance.sample(), instance.sample()])
    expect(a).toBe(b)
    expect(runner.calls).toHaveLength(8)
    advance(2000)
    await instance.sample()
    expect(runner.calls).toHaveLength(12)
  })

  test("reports its own cost", async () => {
    const { instance } = sampler()
    const sample = await instance.sample()
    // Four commands at 1 ms each, plus whatever parsing took in this process.
    expect(sample.sampler.spawned).toBe(4)
    expect(sample.sampler.cpuMs).toBeGreaterThanOrEqual(4)
  })

  test("a full walk learns the tree's process groups; later readings list only those, and walk again after 10 s", async () => {
    // pgid last: rudderd 500 leads 500; claude 600 leads 600; its MCP child 650 opened group 650; codex 700 leads 700.
    const full = [
      `  500     1  20480   1.0    01:00:00   0:10.00   500`,
      `  600   500 102400  50.0       10:00   1:00.00   600`,
      `  650   600  10240   1.0       10:00   0:01.00   650`,
      `  700   500 204800   9.0    02:00:00   5:00.00   700`,
      `  900     1 999999  99.0       10:00  59:00.00   900`,
    ].join("\n")
    const scoped = full.split("\n").slice(0, 4).join("\n")
    const runner = fakeRunner({
      vm_stat: [fixture("darwin-vm_stat.txt")],
      sysctl: [fixture("darwin-sysctl.txt")],
      netstat: [fixture("darwin-netstat-1.txt"), fixture("darwin-netstat-2.txt")],
      ps: [full, scoped, scoped, full],
    })
    const { instance, advance } = sampler({ run: runner.run })
    const listings = () => runner.calls.filter((argv) => argv[0] === "/bin/ps").map((argv) => argv.slice(1).join(" "))
    const first = await instance.sample()
    expect(listings()).toEqual([
      "-A -o pid=,ppid=,rss=,%cpu=,etime=,time=,pgid=",
      "-o pid=,ppid=,rss=,%cpu=,etime=,time=,pgid= -g 500,600,700,650,4242 -p 500,600,700,4242",
    ])
    expect(first.processes.find((entry) => entry.pid === 600)?.processCount).toBe(2)
    advance(2000)
    await instance.sample()
    expect(listings()[2]).toStartWith("-o ")
    advance(10_000)
    await instance.sample()
    expect(listings()[3]).toStartWith("-A ")
  })

  test("a failed group listing falls back to a full walk next time", async () => {
    const full = `  500     1  20480   1.0    01:00:00   0:10.00   500`
    let calls = 0
    const base = fakeRunner({ vm_stat: [fixture("darwin-vm_stat.txt")], sysctl: [fixture("darwin-sysctl.txt")], netstat: [fixture("darwin-netstat-1.txt")] })
    const run = async (argv: string[]): Promise<CommandResult> => {
      if (argv[0] !== "/bin/ps") return base.run(argv)
      base.calls.push(argv)
      calls += 1
      if (calls === 2) throw new Error("ps exited with code 1")
      return { stdout: full, pid: 9000 + calls, cpuMicros: 1000 }
    }
    const { instance, advance } = sampler({ run })
    const sample = await instance.sample()
    expect(sample.errors).toEqual(["ps: ps exited with code 1"])
    advance(2000)
    await instance.sample()
    expect(base.calls.filter((argv) => argv[0] === "/bin/ps").map((argv) => argv[1])).toEqual(["-A", "-o", "-A"])
  })

  test("identity is read once; disk is cached for 30s and then refreshed", async () => {
    let identities = 0
    let disks = 0
    const { instance, advance } = sampler({
      readIdentity: async () => {
        identities += 1
        return { model: "Mac Studio", osVersion: "26.1" }
      },
      readDisk: async () => {
        disks += 1
        return { totalBytes: 1000, freeBytes: 400 }
      },
    })
    const first = await instance.sample()
    expect(first.machine.model).toBe("Mac Studio")
    expect(first.machine.osVersion).toBe("26.1")
    expect(first.disk).toEqual({ totalBytes: 1000, freeBytes: 400 })
    advance(2000)
    await instance.sample()
    advance(30_000)
    const third = await instance.sample()
    expect(third.disk).toEqual({ totalBytes: 1000, freeBytes: 400 })
    expect(identities).toBe(1)
    expect(disks).toBe(2)
  })
})

describe("sampler (live, this machine)", () => {
  test("a real snapshot has sane numbers", async () => {
    const instance = createPerfSampler({ machineName: () => "here", processes: () => [] })
    const sample = await instance.sample()
    expect(sample.machine.cores).toBeGreaterThan(0)
    expect(sample.cpu.percent).toBeGreaterThanOrEqual(0)
    expect(sample.cpu.percent).toBeLessThanOrEqual(100)
    expect(sample.memory.usedBytes).toBeGreaterThan(0)
    expect(sample.memory.usedBytes).toBeLessThanOrEqual(sample.memory.totalBytes)
    if (process.platform === "darwin") {
      expect(sample.machine.model?.length).toBeGreaterThan(0)
      expect(sample.machine.osVersion).toMatch(/^\d+\.\d+/)
    }
    expect(sample.disk?.totalBytes).toBeGreaterThan(sample.disk?.freeBytes ?? -1)
    expect(sample.disk?.freeBytes).toBeGreaterThanOrEqual(0)
    const self = sample.processes.find((entry) => entry.agent === "rudderd")!
    expect(self.pid).toBe(process.pid)
    expect(self.rssBytes).toBeGreaterThan(0)
    expect(sample.errors).toBeUndefined()
  }, 20_000)
})

describe("runCommand", () => {
  test("kills a command that hangs and rejects", async () => {
    const started = Date.now()
    await expect(runCommand(["/bin/sleep", "30"], 200)).rejects.toThrow("timed out after 200 ms")
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  test("returns the output of a command that finishes", async () => {
    const result = await runCommand(["/bin/echo", "hi"])
    expect(result.stdout.trim()).toBe("hi")
  })
})
