import { describe, expect, test } from "bun:test"
import type { LineProcess, LineProcessOptions } from "../adapter/stdio"
import { createPerfSampler, readMachineIdentity } from "../perf"
import {
  createSampleWorker,
  isWindowsTunnel,
  parseWindowsIdentity,
  parseWindowsSample,
  SAMPLE_END,
  sampleWorkerArgv,
  windowsModel,
  windowsVersion,
} from "./win32-perf"

const NOW = Date.UTC(2026, 9, 30, 1, 0, 0)
const GiB = 1024 ** 3

/** One block as the worker prints it (CRLF, as PowerShell writes on Windows). */
function block(cpu: { rudderd: number; claude: number; node: number }, rx: number, tx: number) {
  return [
    "#proc",
    `0 0 8192 0 0`, // System Idle Process: no start time
    `4 0 1515520 61234560000 ${NOW - 86_400_000}`, // System
    `5120 4096 104857600 ${cpu.rudderd} ${NOW - 3_600_000}`, // rudderd (its parent, explorer, is gone)
    `6000 5120 52428800 ${cpu.claude} ${NOW - 600_000}`, // claude.exe under rudderd
    `6100 5120 4194304 1000000 ${NOW - 300_000}`, // the PowerShell worker
    `7000 5120 3145728 20000 ${NOW - 120_000}`, // cmd.exe of codex.cmd
    `7010 7000 209715200 ${cpu.node} ${NOW - 119_000}`, // node.exe behind it
    `9000 7010 1048576 10 ${NOW - 7_200_000}`, // pid 7010 reused: this one started before its "parent"
    "#net",
    `Wi-Fi|Intel(R) Wi-Fi 6E AX211 160MHz|${rx}|${tx}`,
    `Tailscale|Tailscale Tunnel|${rx / 2}|${tx / 2}`,
    "vEthernet (WSL)|Hyper-V Virtual Ethernet Adapter|5000|5000",
    "Bluetooth Network Connection|Bluetooth Device (Personal Area Network)|0|0",
    "#swap",
    "4864 312",
    "#cost 85000",
    "",
  ].join("\r\n")
}

describe("parseWindowsSample", () => {
  const parsed = parseWindowsSample(block({ rudderd: 30_000_000, claude: 50_000_000, node: 80_000_000 }, 1_000_000, 200_000), NOW)

  test("processes: working set, CPU seconds from 100 ns units, age from the start time", () => {
    const claude = parsed.processes.find((row) => row.pid === 6000)!
    expect(claude).toEqual({ pid: 6000, ppid: 5120, rssBytes: 52428800, cpuPercent: 0, elapsedSec: 600, cpuSec: 5 })
    expect(parsed.processes.find((row) => row.pid === 0)!.elapsedSec).toBe(0)
  })

  test("a parent link to a reused pid is cut", () => {
    expect(parsed.processes.find((row) => row.pid === 9000)!.ppid).toBe(-1)
    expect(parsed.processes.find((row) => row.pid === 7010)!.ppid).toBe(7000)
  })

  test("adapters with traffic; VPNs and virtual switches are tunnels", () => {
    expect([...parsed.network.keys()]).toEqual(["Wi-Fi", "Tailscale", "vEthernet (WSL)"])
    expect([...parsed.tunnels]).toEqual(["Tailscale", "vEthernet (WSL)"])
    expect(isWindowsTunnel("Ethernet", "Realtek PCIe GbE Family Controller")).toBe(false)
    expect(isWindowsTunnel("OpenVPN", "TAP-Windows Adapter V9")).toBe(true)
  })

  test("page file in MiB, and the worker's own CPU cost", () => {
    expect(parsed.swap).toEqual({ totalBytes: 4864 * 1024 ** 2, usedBytes: 312 * 1024 ** 2 })
    expect(parsed.costMicros).toBe(85000)
  })
})

describe("sampler on Windows", () => {
  test("same sample shape as macOS: CPU from time deltas, trees through cmd.exe shims, tunnels out of the totals", async () => {
    let now = NOW
    let reads = 0
    const blocks = [
      block({ rudderd: 30_000_000, claude: 50_000_000, node: 80_000_000 }, 1_000_000, 200_000),
      block({ rudderd: 31_000_000, claude: 60_000_000, node: 100_000_000 }, 3_000_000, 600_000),
    ]
    const sampler = createPerfSampler({
      platform: "win32",
      arch: "x64",
      now: () => now,
      sleep: async (ms) => {
        now += ms
      },
      readWindows: async () => ({ stdout: blocks[Math.min(reads++, 1)]!, pid: 6100, cpuMicros: 85_000 }),
      cpus: () => [{ user: reads * 100, nice: 0, sys: 0, idle: reads * 300, irq: 0 }],
      cpuModel: () => "13th Gen Intel(R) Core(TM) i7-1365U",
      loadavg: () => [0, 0, 0],
      totalmem: () => 32 * GiB,
      freemem: () => 20 * GiB,
      uptime: () => 7200,
      selfPid: 5120,
      machineName: () => "test-pc",
      processes: () => [
        { agent: "claude", label: "Claude Code", pid: 6000, sessionIds: ["s1"], shared: false },
        { agent: "codex", label: "Codex", pid: 7000, sessionIds: ["s2"], shared: true },
      ],
      baselineMs: 1000,
      readIdentity: async () => ({ model: "Lenovo ThinkPad X1 Carbon Gen 11", osVersion: "11 24H2" }),
      readDisk: async () => ({ totalBytes: 512 * GiB, freeBytes: 128 * GiB }),
    })
    const sample = await sampler.sample()
    expect(sample.machine).toEqual({
      name: "test-pc",
      platform: "win32",
      arch: "x64",
      cpuModel: "13th Gen Intel(R) Core(TM) i7-1365U",
      cores: 1,
      memoryBytes: 32 * GiB,
      uptimeSec: 7200,
      model: "Lenovo ThinkPad X1 Carbon Gen 11",
      osVersion: "11 24H2",
    })
    // Windows has no load average; null, not zeros the phone would draw as a real 0.
    expect(sample.cpu.load).toBeNull()
    expect(sample.memory).toEqual({
      totalBytes: 32 * GiB,
      usedBytes: 12 * GiB,
      pressure: null,
      swapUsedBytes: 312 * 1024 ** 2,
      swapTotalBytes: 4864 * 1024 ** 2,
    })
    // 2 MB in 1 s on Wi-Fi; the tunnel and the WSL switch are listed but not counted.
    expect(sample.network.rxBytesPerSec).toBe(2_000_000)
    expect(sample.network.txBytesPerSec).toBe(400_000)
    expect(sample.network.interfaces.map((entry) => [entry.name, entry.tunnel])).toEqual([
      ["Wi-Fi", false],
      ["Tailscale", true],
      ["vEthernet (WSL)", true],
    ])
    const byAgent = Object.fromEntries(sample.processes.map((row) => [row.agent, row]))
    // 1 s of CPU in 1 s: 100 %; codex is its cmd.exe plus node.exe (2 s → 200 %), without the reused-pid process.
    expect(byAgent.claude!.cpuPercent).toBe(100)
    expect(byAgent.codex!.processCount).toBe(2)
    expect(byAgent.codex!.cpuPercent).toBe(200)
    expect(byAgent.codex!.rssBytes).toBe(3145728 + 209715200)
    // rudderd without the worker it spawned for this reading.
    expect(byAgent.rudderd!.processCount).toBe(1)
    expect(sample.sampler.spawned).toBe(1)
    expect(sample.disk).toEqual({ totalBytes: 512 * GiB, freeBytes: 128 * GiB })
    expect(sample.errors).toBeUndefined()
  })

  test("a failed reading still ships CPU and memory, with the error named", async () => {
    const sampler = createPerfSampler({
      platform: "win32",
      readWindows: async () => {
        throw new Error("powershell exited with code 1")
      },
      sleep: async () => {},
      machineName: () => "pc",
      processes: () => [],
      readIdentity: async () => ({}),
      readDisk: async () => undefined,
    })
    const sample = await sampler.sample()
    expect(sample.errors).toEqual(["powershell: powershell exited with code 1"])
    expect(sample.processes).toEqual([])
    expect(sample.memory.totalBytes).toBeGreaterThan(0)
  })
})

describe("identity", () => {
  test.each([
    ["Dell Inc.", "XPS 15 9530", "XPS", "Dell XPS 15 9530"],
    ["Microsoft Corporation", "Surface Laptop 5", "Surface", "Microsoft Surface Laptop 5"],
    ["LENOVO", "21CB0012US", "ThinkPad X1 Carbon Gen 10", "Lenovo ThinkPad X1 Carbon Gen 10"],
    ["HP", "HP EliteBook 840 G9 Notebook PC", "103C_5336AN HP EliteBook", "HP EliteBook 840 G9 Notebook PC"],
    ["ASUSTeK COMPUTER INC.", "ROG Zephyrus G14 GA402XV", "ROG Zephyrus G14", "ASUS ROG Zephyrus G14 GA402XV"],
    ["System manufacturer", "System Product Name", "To be filled by O.E.M.", undefined],
    ["To Be Filled By O.E.M.", "To Be Filled By O.E.M.", "", undefined],
    ["Micro-Star International Co., Ltd.", "MS-7D25", "Default string", "MSI MS-7D25"],
  ])("%s / %s → %s", (manufacturer, model, family, expected) => {
    expect(windowsModel(manufacturer, model, family)).toBe(expected)
  })

  test("Windows 11 from the build, though the kernel says 10.0", () => {
    expect(windowsVersion("26100", "24H2", "Microsoft Windows 11 Pro")).toBe("11 24H2")
    expect(windowsVersion("22631", "23H2", "")).toBe("11 23H2")
    expect(windowsVersion("19045", "22H2", "Microsoft Windows 10 Home")).toBe("10 22H2")
    expect(windowsVersion("17763", "", "")).toBe("10 (17763)")
  })

  // Recorded ConvertTo-Json -Compress output.
  const RECORDED =
    '{"manufacturer":"LENOVO","model":"21HMCTO1WW","family":"ThinkPad X1 Carbon Gen 11","caption":"Microsoft Windows 11 Pro","build":"26100","displayVersion":"24H2"}\r\n'

  test("parses the recorded identity, and garbage to nothing", () => {
    expect(parseWindowsIdentity(RECORDED)).toEqual({ model: "Lenovo ThinkPad X1 Carbon Gen 11", osVersion: "11 24H2" })
    expect(parseWindowsIdentity("Get-CimInstance : Access denied")).toEqual({})
  })

  test("readMachineIdentity asks PowerShell once on win32", async () => {
    const calls: string[][] = []
    const identity = await readMachineIdentity(
      "win32",
      async (argv) => {
        calls.push(argv)
        return { stdout: RECORDED, pid: 1, cpuMicros: 0 }
      },
      async () => "",
    )
    expect(identity.osVersion).toBe("11 24H2")
    expect(calls).toHaveLength(1)
    expect(calls[0]!.slice(0, 4)).toEqual(["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive"])
  })
})

describe("PowerShell worker", () => {
  function fakeSpawn() {
    const started: { argv: string[]; written: string[]; options: LineProcessOptions; exit: (code: number) => void; stopped: boolean }[] = []
    const spawn = (argv: string[], options: LineProcessOptions): LineProcess => {
      let exit!: (code: number) => void
      const exited = new Promise<number>((resolve) => {
        exit = resolve
      })
      const entry = { argv, written: [] as string[], options, exit, stopped: false }
      started.push(entry)
      return {
        pid: 6100 + started.length,
        exited,
        write: (line) => entry.written.push(line),
        stderrTail: () => "",
        stop: async () => {
          entry.stopped = true
          exit(0)
        },
      }
    }
    return { started, spawn }
  }

  test("one process for many readings; each answer ends at the marker", async () => {
    const fake = fakeSpawn()
    const worker = createSampleWorker({ spawn: fake.spawn, idleMs: 60_000 })
    for (const round of [1, 2]) {
      const pending = worker.read()
      const proc = fake.started[0]!
      for (const line of ["#proc", `1 0 10 ${round} 0`, "#cost 4000", SAMPLE_END]) proc.options.onLine(line)
      const result = await pending
      expect(result.stdout).toBe(`#proc\n1 0 10 ${round} 0\n#cost 4000`)
      expect(result.cpuMicros).toBe(4000)
      expect(result.pid).toBe(6101)
    }
    expect(fake.started).toHaveLength(1)
    expect(fake.started[0]!.written).toEqual(["sample", "sample"])
    expect(fake.started[0]!.argv).toEqual(sampleWorkerArgv())
    worker.close()
    expect(fake.started[0]!.stopped).toBe(true)
  })

  test("a worker that dies mid-reading fails that reading; the next one starts a new worker", async () => {
    const fake = fakeSpawn()
    const worker = createSampleWorker({ spawn: fake.spawn })
    const pending = worker.read()
    fake.started[0]!.exit(1)
    await expect(pending).rejects.toThrow("powershell exited with code 1")
    const next = worker.read()
    fake.started[1]!.options.onLine(SAMPLE_END)
    expect((await next).pid).toBe(6102)
    worker.close()
  })

  test("a reading that never ends times out and stops the worker", async () => {
    const fake = fakeSpawn()
    const worker = createSampleWorker({ spawn: fake.spawn, timeoutMs: 20 })
    await expect(worker.read()).rejects.toThrow("no reading within")
    expect(fake.started[0]!.stopped).toBe(true)
  })
})
