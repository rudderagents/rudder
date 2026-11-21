// Live machine and agent-process performance for the phone's panel (perf.* RPCs, the implementation notes).
// macOS first: four short-lived commands per reading (vm_stat, sysctl, netstat, ps). Linux reads /proc and runs ps.
// Windows asks one long-lived PowerShell (platform/win32-perf.ts).
import { readFile, statfs } from "node:fs/promises"
import os from "node:os"
import type { AgentProcess } from "./adapter/types"
import { createSampleWorker, identityArgv, parseWindowsIdentity, parseWindowsSample } from "./platform/win32-perf"

export type CpuTimes = { user: number; nice: number; sys: number; idle: number; irq: number }
export type MemoryPressure = "normal" | "warn" | "critical"
export type ByteCounters = { rxBytes: number; txBytes: number }
export type PsRow = { pid: number; ppid: number; rssBytes: number; cpuPercent: number; elapsedSec: number; cpuSec: number; pgid?: number }
export type CommandResult = { stdout: string; pid: number; cpuMicros: number }

export type PerfProcess = AgentProcess & {
  label: string
  rssBytes: number
  // 100 = one core busy for the whole window; a tree can exceed 100.
  cpuPercent: number
  uptimeSec: number
  // The root plus its live descendants (tool subprocesses).
  processCount: number
}

export type DiskUsage = { totalBytes: number; freeBytes: number }
export type MachineIdentity = { model?: string; osVersion?: string }

export type PerfSample = {
  at: number
  machine: {
    name: string
    platform: string
    arch: string
    cpuModel: string
    cores: number
    memoryBytes: number
    uptimeSec: number
    // Marketing name ("Mac Studio") and OS version ("26.1"). Omitted when the platform has neither.
    model?: string
    osVersion?: string
  }
  // null on Windows, which has no load average (os.loadavg() returns zeros there).
  cpu: { percent: number; cores: number[]; load: number[] | null }
  memory: {
    totalBytes: number
    usedBytes: number
    pressure: MemoryPressure | null
    swapUsedBytes: number | null
    swapTotalBytes: number | null
    // macOS only: the three parts of usedBytes.
    breakdown?: { activeBytes: number; wiredBytes: number; compressedBytes: number }
  }
  network: {
    interfaces: { name: string; rxBytesPerSec: number; txBytesPerSec: number; tunnel: boolean }[]
    // Totals over the non-tunnel interfaces.
    rxBytesPerSec: number
    txBytesPerSec: number
  }
  processes: PerfProcess[]
  // Volume that holds the home directory. Omitted when statfs fails.
  disk?: DiskUsage
  // A process tree above this RSS gets the "unusually large" hint on the phone.
  limits: { processRssWarnBytes: number }
  // What producing this sample cost: commands spawned, their CPU plus this process's.
  sampler: { cpuMs: number; wallMs: number; spawned: number }
  // Sections that could not be read this time ("sysctl: …"); absent when everything worked.
  errors?: string[]
}

// ---------- CPU ----------

export function cpuUsage(prev: CpuTimes[], next: CpuTimes[]): { percent: number; cores: number[] } {
  let busyAll = 0
  let totalAll = 0
  const cores = next.map((now, index) => {
    const before = prev[index]
    if (!before) return 0
    const idle = now.idle - before.idle
    const total = now.user + now.nice + now.sys + now.idle + now.irq - (before.user + before.nice + before.sys + before.idle + before.irq)
    if (total <= 0 || idle < 0 || idle > total) return 0
    busyAll += total - idle
    totalAll += total
    return ((total - idle) / total) * 100
  })
  return { percent: totalAll > 0 ? (busyAll / totalAll) * 100 : 0, cores }
}

// ---------- macOS ----------

export function parseVmStat(text: string): { pageSize: number; pages: Record<string, number> } {
  const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1] ?? NaN)
  const pages: Record<string, number> = {}
  for (const line of text.split("\n")) {
    const match = /^"?([^":]+)"?:\s+(\d+)\.?\s*$/.exec(line)
    if (match) pages[match[1]!] = Number(match[2])
  }
  return { pageSize, pages }
}

/** Used = active + wired + occupied by compressor (the compressor's physical pages, not what it stores). */
export function darwinMemory(vm: { pageSize: number; pages: Record<string, number> }) {
  const active = vm.pages["Pages active"]
  const wired = vm.pages["Pages wired down"]
  const compressed = vm.pages["Pages occupied by compressor"]
  if (!Number.isFinite(vm.pageSize) || active === undefined || wired === undefined || compressed === undefined) {
    throw new Error("vm_stat output lacks page size, active, wired or compressor pages")
  }
  return {
    usedBytes: (active + wired + compressed) * vm.pageSize,
    activeBytes: active * vm.pageSize,
    wiredBytes: wired * vm.pageSize,
    compressedBytes: compressed * vm.pageSize,
  }
}

export function parseSysctl(text: string): Map<string, string> {
  const values = new Map<string, string>()
  for (const line of text.split("\n")) {
    const colon = line.indexOf(":")
    if (colon > 0) values.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim())
  }
  return values
}

// kern.memorystatus_vm_pressure_level: 1 normal, 2 warn, 4 critical (the levels Activity Monitor colours).
export function pressureLevel(value: string | undefined): MemoryPressure | null {
  if (value === "1") return "normal"
  if (value === "2") return "warn"
  if (value === "4") return "critical"
  return null
}

const UNIT: Record<string, number> = { K: 1024, M: 1024 ** 2, G: 1024 ** 3 }

// vm.swapusage: "total = 12288.00M  used = 11102.69M  free = 1185.31M  (encrypted)".
export function swapUsage(value: string | undefined): { totalBytes: number; usedBytes: number } | null {
  if (!value) return null
  const field = (name: string) => {
    const match = new RegExp(`${name} = ([\\d.]+)([KMG])`).exec(value)
    return match ? Math.round(Number(match[1]) * UNIT[match[2]!]!) : NaN
  }
  const totalBytes = field("total")
  const usedBytes = field("used")
  return Number.isFinite(totalBytes) && Number.isFinite(usedBytes) ? { totalBytes, usedBytes } : null
}

/**
 * `netstat -ibn` link rows of interfaces that are up and hold a routable address (IPv4, or IPv6 outside fe80::/10).
 * Loopback, interfaces marked down (`*`) and address-less ones (unused ports, system tunnels) are skipped.
 */
export function parseNetstat(text: string): Map<string, ByteCounters> {
  const links = new Map<string, ByteCounters>()
  const addressed = new Set<string>()
  for (const line of text.split("\n")) {
    const fields = line.trim().split(/\s+/)
    const name = fields[0]
    if (!name || fields.length < 9 || name.endsWith("*") || name.startsWith("lo") || name === "Name") continue
    if (!fields[2]?.startsWith("<Link#")) {
      // Address rows: Name Mtu Network Address …; the Address column is cut to its first characters.
      if (!fields[3]?.toLowerCase().startsWith("fe80:")) addressed.add(name)
      continue
    }
    // Read from the right: the address column is empty on tunnels. … Ibytes Opkts Oerrs Obytes Coll
    const rxBytes = Number(fields[fields.length - 5])
    const txBytes = Number(fields[fields.length - 2])
    if (Number.isFinite(rxBytes) && Number.isFinite(txBytes)) links.set(name, { rxBytes, txBytes })
  }
  return new Map([...links].filter(([name]) => addressed.has(name)))
}

// VPN and tunnel interfaces: their bytes also cross a physical interface, so totals leave them out.
export function isTunnel(name: string): boolean {
  return /^(utun|ipsec|ppp|tun|tap|wg|tailscale|zt)/.test(name)
}

// ---------- Linux ----------

export function parseMeminfo(text: string) {
  const kib = (key: string) => {
    const match = new RegExp(`^${key}:\\s+(\\d+) kB`, "m").exec(text)
    if (!match) throw new Error(`/proc/meminfo lacks ${key}`)
    return Number(match[1]) * 1024
  }
  const totalBytes = kib("MemTotal")
  const swapTotalBytes = kib("SwapTotal")
  return { totalBytes, usedBytes: totalBytes - kib("MemAvailable"), swapTotalBytes, swapUsedBytes: swapTotalBytes - kib("SwapFree") }
}

export function parseProcNetDev(text: string): Map<string, ByteCounters> {
  const counters = new Map<string, ByteCounters>()
  for (const line of text.split("\n")) {
    const match = /^\s*([^:\s]+):\s*(.*)$/.exec(line)
    if (!match || match[1] === "lo") continue
    const fields = match[2]!.trim().split(/\s+/).map(Number)
    const rxBytes = fields[0]
    const txBytes = fields[8]
    if (rxBytes === undefined || txBytes === undefined || !Number.isFinite(rxBytes) || !Number.isFinite(txBytes)) continue
    if (rxBytes + txBytes === 0) continue
    counters.set(match[1]!, { rxBytes, txBytes })
  }
  return counters
}

// ---------- processes ----------

/** ps etime / time: [[dd-]hh:]mm:ss[.cc] → seconds (macOS time is mm:ss.cc with minutes past 59). */
export function parseDuration(text: string): number {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(text)
  if (!match) return NaN
  return Number(match[1] ?? 0) * 86400 + Number(match[2] ?? 0) * 3600 + Number(match[3]) * 60 + Number(match[4])
}

/** `ps -o pid=,ppid=,rss=,%cpu=,etime=,time=[,pgid=]`; rows that do not parse are dropped. */
export function parsePs(text: string): PsRow[] {
  const rows: PsRow[] = []
  for (const line of text.split("\n")) {
    const fields = line.trim().split(/\s+/)
    if (fields.length !== 6 && fields.length !== 7) continue
    const [pid, ppid, rss, cpu] = fields.slice(0, 4).map(Number) as [number, number, number, number]
    const elapsedSec = parseDuration(fields[4]!)
    const cpuSec = parseDuration(fields[5]!)
    const pgid = fields.length === 7 ? Number(fields[6]) : undefined
    if (![pid, ppid, rss, cpu, elapsedSec, cpuSec, pgid ?? 0].every(Number.isFinite)) continue
    const row: PsRow = { pid, ppid, rssBytes: rss * 1024, cpuPercent: cpu, elapsedSec, cpuSec }
    if (pgid !== undefined) row.pgid = pgid
    rows.push(row)
  }
  return rows
}

/** Process groups of `roots` and everything below them, from a full listing that carries pgid. */
export function treeGroups(rows: PsRow[], roots: number[]): Set<number> {
  const tree = processTree(rows)
  const byPid = new Map(rows.map((row) => [row.pid, row]))
  const groups = new Set<number>()
  for (const root of roots) {
    for (const pid of tree.collect(root)) {
      const pgid = byPid.get(pid)?.pgid
      if (pgid !== undefined && pgid > 0) groups.add(pgid)
    }
  }
  return groups
}

export function processTree(rows: PsRow[]) {
  const children = new Map<number, number[]>()
  const known = new Set<number>()
  for (const row of rows) {
    known.add(row.pid)
    // pid 0's parent is itself on some systems.
    if (row.pid === row.ppid) continue
    let list = children.get(row.ppid)
    if (!list) {
      list = []
      children.set(row.ppid, list)
    }
    list.push(row.pid)
  }
  return {
    /** `root` and its descendants, breadth first, without `skip` and anything below it. Empty if root is gone. */
    collect(root: number, skip: Set<number> = new Set()): number[] {
      if (!known.has(root)) return []
      const found = [root]
      const seen = new Set(found)
      for (let index = 0; index < found.length; index++) {
        for (const child of children.get(found[index]!) ?? []) {
          if (seen.has(child) || skip.has(child)) continue
          seen.add(child)
          found.push(child)
        }
      }
      return found
    },
  }
}

// ---------- sampler ----------

export type ProcessRoot = AgentProcess & { label: string }

export type PerfSamplerOptions = {
  machineName: () => string
  processes: () => ProcessRoot[]
  platform?: NodeJS.Platform
  arch?: string
  run?: (argv: string[]) => Promise<CommandResult>
  readText?: (path: string) => Promise<string>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  cpus?: () => CpuTimes[]
  cpuModel?: () => string
  loadavg?: () => number[]
  totalmem?: () => number
  freemem?: () => number
  uptime?: () => number
  selfPid?: number
  /** Wait between the two readings of a sample that has no recent reading to diff against. */
  baselineMs?: number
  // Identity is read once (system_profiler is slow). Disk is statfs, refreshed every 30s. Both stay out of the ps window.
  readIdentity?: () => Promise<MachineIdentity>
  readDisk?: () => Promise<DiskUsage | undefined>
  /** Windows: one reading from the PowerShell worker (platform/win32-perf.ts); tests pass recorded output. */
  readWindows?: () => Promise<CommandResult>
}

type Memory = PerfSample["memory"]

type Reading = {
  at: number
  cpus: CpuTimes[]
  memory: Memory
  network: Map<string, ByteCounters> | null
  // Windows names its adapters freely ("Wi-Fi", "Tailscale"); its reading says which are tunnels.
  tunnels?: Set<string>
  ps: PsRow[] | null
  spawnedPids: Set<number>
  childCpuMicros: number
  errors: string[]
}

// A reading older than this is not diffed against: the sample takes a fresh baseline first.
const BASELINE_MAX_AGE_MS = 10_000
const RSS_WARN_SHARE = 0.1
const DISK_REFRESH_MS = 30_000

export function parseDarwinMachineName(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as { SPHardwareDataType?: { machine_name?: unknown }[] }
    const name = parsed.SPHardwareDataType?.[0]?.machine_name
    return typeof name === "string" && name.trim() ? name.trim() : undefined
  } catch {
    return undefined
  }
}

export function parseProductVersion(text: string): string | undefined {
  const line = text.split("\n").find((entry) => entry.trim())
  return line?.trim() || undefined
}

export function parseProductName(text: string): string | undefined {
  const name = text.trim()
  return name || undefined
}

export function parsePrettyName(text: string): string | undefined {
  for (const line of text.split("\n")) {
    const match = /^PRETTY_NAME=(.*)$/.exec(line.trim())
    if (!match?.[1]) continue
    let value = match[1].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    return value.trim() || undefined
  }
  return undefined
}

function presentIdentity(model: string | undefined, osVersion: string | undefined): MachineIdentity {
  const identity: MachineIdentity = {}
  if (model) identity.model = model
  if (osVersion) identity.osVersion = osVersion
  return identity
}

// Once per process. Failures become an empty identity so a later sample still ships CPU and memory.
export async function readMachineIdentity(
  platform: NodeJS.Platform,
  run: (argv: string[]) => Promise<CommandResult>,
  readText: (path: string) => Promise<string>,
): Promise<MachineIdentity> {
  if (platform === "darwin") {
    const [model, osVersion] = await Promise.all([
      run(["/usr/sbin/system_profiler", "SPHardwareDataType", "-json"]).then((result) => parseDarwinMachineName(result.stdout), () => undefined),
      run(["/usr/bin/sw_vers", "-productVersion"]).then((result) => parseProductVersion(result.stdout), () => undefined),
    ])
    return presentIdentity(model, osVersion)
  }
  if (platform === "linux") {
    const [model, osVersion] = await Promise.all([
      readText("/sys/devices/virtual/dmi/id/product_name").then(parseProductName, () => undefined),
      readText("/etc/os-release").then(parsePrettyName, () => undefined),
    ])
    return presentIdentity(model, osVersion)
  }
  if (platform === "win32") {
    return run(identityArgv()).then((result) => parseWindowsIdentity(result.stdout), () => ({}))
  }
  return {}
}

// bavail is the space a normal user can still use, which matches what Finder shows as free.
export async function readHomeDisk(): Promise<DiskUsage | undefined> {
  try {
    const stats = await statfs(os.homedir())
    const bsize = Number(stats.bsize)
    const blocks = Number(stats.blocks)
    const bavail = Number(stats.bavail)
    if (!(bsize > 0) || !Number.isFinite(blocks) || !Number.isFinite(bavail)) return undefined
    return { totalBytes: Math.round(blocks * bsize), freeBytes: Math.round(bavail * bsize) }
  } catch {
    return undefined
  }
}

// A wedged ps / netstat / vm_stat would otherwise hold the perf tick forever and freeze every subscriber.
const COMMAND_TIMEOUT_MS = 5_000

export async function runCommand(argv: string[], timeoutMs = COMMAND_TIMEOUT_MS): Promise<CommandResult> {
  const child = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill("SIGKILL")
  }, timeoutMs)
  let stdout: string
  let stderr: string
  let code: number
  try {
    ;[stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  } finally {
    clearTimeout(timer)
  }
  if (timedOut) throw new Error(`${argv.join(" ")} timed out after ${timeoutMs} ms`)
  if (code !== 0) throw new Error(`${argv.join(" ")} exited with code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`)
  return { stdout, pid: child.pid, cpuMicros: Number(child.resourceUsage()?.cpuTime.total ?? 0) }
}

const DARWIN = {
  vmStat: ["/usr/bin/vm_stat"],
  sysctl: ["/usr/sbin/sysctl", "kern.memorystatus_vm_pressure_level", "vm.swapusage"],
  netstat: ["/usr/sbin/netstat", "-ibn"],
  ps: "/bin/ps",
  psFormat: "pid=,ppid=,rss=,%cpu=,etime=,time=,pgid=",
}
// Walking every process costs about 20 ms of CPU on a Mac with ~1,600 of them; listing a few groups costs about 1 ms.
// Agents run detached (their own group), but some children open groups of their own (Codex's MCP servers, its
// code-mode host), so a full walk now and then learns those groups; in between only they are listed.
const FULL_PS_MS = 10_000
const PS_PORTABLE = ["ps", "-A", "-o", "pid=,ppid=,rss=,%cpu=,etime=,time="]

export function createPerfSampler(options: PerfSamplerOptions) {
  const platform = options.platform ?? process.platform
  const run = options.run ?? runCommand
  const readText = options.readText ?? ((path: string) => readFile(path, "utf8"))
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms))
  const cpus = options.cpus ?? (() => os.cpus().map((cpu) => cpu.times))
  const cpuModel = options.cpuModel ?? (() => os.cpus()[0]?.model ?? "")
  const loadavg = options.loadavg ?? os.loadavg
  const totalmem = options.totalmem ?? os.totalmem
  const freemem = options.freemem ?? os.freemem
  const uptime = options.uptime ?? os.uptime
  const selfPid = options.selfPid ?? process.pid
  const baselineMs = options.baselineMs ?? 250
  const readIdentity = options.readIdentity ?? (() => readMachineIdentity(platform, run, readText))
  const readDisk = options.readDisk ?? readHomeDisk
  let worker: ReturnType<typeof createSampleWorker> | undefined
  const readWindows =
    options.readWindows ??
    (() => {
      worker ??= createSampleWorker()
      return worker.read()
    })

  let last: Reading | undefined
  let inflight: Promise<PerfSample> | undefined
  let identityPromise: Promise<MachineIdentity> | undefined
  let diskCached: { at: number; value: Promise<DiskUsage | undefined> } | undefined
  let fullPsAt = Number.NEGATIVE_INFINITY
  let knownGroups = new Set<number>()

  function darwinPs(): { argv: string[]; full: boolean } {
    const roots = options.processes().map((root) => root.pid)
    if (now() - fullPsAt >= FULL_PS_MS || knownGroups.size === 0) return { argv: [DARWIN.ps, "-A", "-o", DARWIN.psFormat], full: true }
    // -g and -p select the union. An agent started since the last walk leads its own group (spawned detached);
    // roots and rudderd also go by pid, in case one is not its group's leader.
    const groups = new Set([...knownGroups, ...roots])
    const pids = [selfPid, ...roots]
    return { argv: [DARWIN.ps, "-o", DARWIN.psFormat, "-g", [...groups].join(","), "-p", pids.join(",")], full: false }
  }

  function loadIdentity(): Promise<MachineIdentity> {
    identityPromise ??= readIdentity().catch(() => ({}))
    return identityPromise
  }

  function loadDisk(): Promise<DiskUsage | undefined> {
    if (diskCached && now() - diskCached.at < DISK_REFRESH_MS) return diskCached.value
    const value = readDisk()
      .catch(() => undefined)
      .then((disk) => {
        if (diskCached?.value === value) diskCached = { at: now(), value: Promise.resolve(disk) }
        return disk
      })
    diskCached = { at: now(), value }
    return value
  }

  async function read(): Promise<Reading> {
    const errors: string[] = []
    const spawnedPids = new Set<number>()
    let childCpuMicros = 0
    const command = async (label: string, argv: string[]): Promise<string | null> => {
      try {
        const result = await run(argv)
        spawnedPids.add(result.pid)
        childCpuMicros += result.cpuMicros
        return result.stdout
      } catch (error) {
        errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`)
        return null
      }
    }
    const section = <T>(label: string, parse: () => T): T | null => {
      try {
        return parse()
      } catch (error) {
        errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`)
        return null
      }
    }
    const total = totalmem()
    const memory: Memory = { totalBytes: total, usedBytes: total - freemem(), pressure: null, swapUsedBytes: null, swapTotalBytes: null }
    let network: Map<string, ByteCounters> | null = null
    let tunnels: Set<string> | undefined
    let psText: string | null
    let ps: PsRow[] | null = null

    if (platform === "darwin") {
      const listing = darwinPs()
      const [vmText, sysctlText, netText, psOut] = await Promise.all([
        command("vm_stat", DARWIN.vmStat),
        command("sysctl", DARWIN.sysctl),
        command("netstat", DARWIN.netstat),
        command("ps", listing.argv),
      ])
      psText = psOut
      if (!listing.full && psOut === null) fullPsAt = Number.NEGATIVE_INFINITY
      if (listing.full && psOut !== null) {
        fullPsAt = now()
        const rows = parsePs(psOut)
        ps = rows
        knownGroups = treeGroups(rows, [selfPid, ...options.processes().map((root) => root.pid)])
      }
      const vm = vmText === null ? null : section("vm_stat", () => darwinMemory(parseVmStat(vmText)))
      if (vm) {
        memory.usedBytes = vm.usedBytes
        memory.breakdown = { activeBytes: vm.activeBytes, wiredBytes: vm.wiredBytes, compressedBytes: vm.compressedBytes }
      }
      if (sysctlText !== null) {
        const values = parseSysctl(sysctlText)
        memory.pressure = pressureLevel(values.get("kern.memorystatus_vm_pressure_level"))
        const swap = swapUsage(values.get("vm.swapusage"))
        memory.swapUsedBytes = swap?.usedBytes ?? null
        memory.swapTotalBytes = swap?.totalBytes ?? null
      }
      if (netText !== null) network = parseNetstat(netText)
    } else if (platform === "win32") {
      psText = null
      let reading: CommandResult | null = null
      try {
        reading = await readWindows()
        spawnedPids.add(reading.pid)
        childCpuMicros += reading.cpuMicros
      } catch (error) {
        errors.push(`powershell: ${error instanceof Error ? error.message : String(error)}`)
      }
      const parsed = reading === null ? null : section("powershell", () => parseWindowsSample(reading.stdout, now()))
      if (parsed) {
        ps = parsed.processes
        network = parsed.network
        tunnels = parsed.tunnels
        memory.swapUsedBytes = parsed.swap?.usedBytes ?? null
        memory.swapTotalBytes = parsed.swap?.totalBytes ?? null
      }
    } else {
      const [meminfo, netdev, psOut] = await Promise.all([
        platform === "linux"
          ? readText("/proc/meminfo").catch((error: Error) => {
              errors.push(`meminfo: ${error.message}`)
              return null
            })
          : null,
        platform === "linux"
          ? readText("/proc/net/dev").catch((error: Error) => {
              errors.push(`net/dev: ${error.message}`)
              return null
            })
          : null,
        command("ps", PS_PORTABLE),
      ])
      psText = psOut
      const mem = meminfo === null ? null : section("meminfo", () => parseMeminfo(meminfo))
      if (mem) Object.assign(memory, mem)
      if (netdev !== null) network = parseProcNetDev(netdev)
    }
    if (psText !== null) ps ??= parsePs(psText)
    return { at: now(), cpus: cpus(), memory, network, tunnels, ps, spawnedPids, childCpuMicros, errors }
  }

  function accountProcesses(prev: Reading, next: Reading, roots: ProcessRoot[]): PerfProcess[] {
    if (!next.ps) return []
    const rows = new Map(next.ps.map((row) => [row.pid, row]))
    const before = new Map((prev.ps ?? []).map((row) => [row.pid, row]))
    const seconds = (next.at - prev.at) / 1000
    // macOS ps %cpu is a decaying average over about a minute; cpu-time deltas give the actual window.
    // Linux ps time has whole-second resolution, so there %cpu (lifetime average) is used as is.
    // Windows reports CPU time only (100 ns resolution), so it takes the deltas too.
    const deltas = platform === "darwin" || platform === "win32"
    const cpuOf = (row: PsRow) => {
      const earlier = before.get(row.pid)
      if (!deltas || !earlier || seconds <= 0 || row.cpuSec < earlier.cpuSec) return row.cpuPercent
      return ((row.cpuSec - earlier.cpuSec) / seconds) * 100
    }
    const tree = processTree(next.ps)
    const rootPids = new Set(roots.map((root) => root.pid))
    const claimed = new Set<number>()
    const row = (root: ProcessRoot, pids: number[]): PerfProcess => {
      for (const pid of pids) claimed.add(pid)
      const members = pids.map((pid) => rows.get(pid)!)
      return {
        ...root,
        rssBytes: members.reduce((sum, member) => sum + member.rssBytes, 0),
        cpuPercent: round(members.reduce((sum, member) => sum + cpuOf(member), 0), 1),
        uptimeSec: Math.round(rows.get(root.pid)!.elapsedSec),
        processCount: members.length,
      }
    }
    const result: PerfProcess[] = []
    for (const root of roots) {
      const pids = tree.collect(root.pid, new Set([...rootPids].filter((pid) => pid !== root.pid)))
      if (pids.length > 0 && !claimed.has(root.pid)) result.push(row(root, pids))
    }
    // rudderd: itself plus children no adapter claimed (model probes), never the sampler's own commands.
    const own = tree.collect(selfPid, new Set([...rootPids, ...claimed, ...next.spawnedPids]))
    if (own.length > 0) result.push(row({ agent: "rudderd", label: "rudderd", pid: selfPid, sessionIds: [], shared: false }, own))
    return result.sort((a, b) => b.rssBytes - a.rssBytes)
  }

  function compose(prev: Reading, next: Reading, cost: PerfSample["sampler"], identity: MachineIdentity): PerfSample {
    const seconds = (next.at - prev.at) / 1000
    const interfaces: PerfSample["network"]["interfaces"] = []
    for (const [name, counters] of next.network ?? []) {
      const earlier = prev.network?.get(name)
      if (!earlier || seconds <= 0) continue
      const rate = (now: number, then: number) => (now >= then ? Math.round((now - then) / seconds) : 0)
      interfaces.push({
        name,
        rxBytesPerSec: rate(counters.rxBytes, earlier.rxBytes),
        txBytesPerSec: rate(counters.txBytes, earlier.txBytes),
        tunnel: isTunnel(name) || next.tunnels?.has(name) === true,
      })
    }
    const physical = interfaces.filter((entry) => !entry.tunnel)
    const cpu = cpuUsage(prev.cpus, next.cpus)
    const machine: PerfSample["machine"] = {
      name: options.machineName(),
      platform,
      arch: options.arch ?? process.arch,
      cpuModel: cpuModel(),
      cores: next.cpus.length,
      memoryBytes: next.memory.totalBytes,
      uptimeSec: Math.round(uptime()),
    }
    if (identity.model) machine.model = identity.model
    if (identity.osVersion) machine.osVersion = identity.osVersion
    const sample: PerfSample = {
      at: next.at,
      machine,
      cpu: { percent: round(cpu.percent, 1), cores: cpu.cores.map((value) => round(value, 1)), load: platform === "win32" ? null : loadavg().map((value) => round(value, 2)) },
      memory: next.memory,
      network: {
        interfaces,
        rxBytesPerSec: physical.reduce((sum, entry) => sum + entry.rxBytesPerSec, 0),
        txBytesPerSec: physical.reduce((sum, entry) => sum + entry.txBytesPerSec, 0),
      },
      processes: accountProcesses(prev, next, options.processes()),
      limits: { processRssWarnBytes: Math.round(next.memory.totalBytes * RSS_WARN_SHARE) },
      sampler: cost,
    }
    if (next.errors.length > 0) sample.errors = next.errors
    return sample
  }

  async function produce(): Promise<PerfSample> {
    // system_profiler must finish before ps, or its pid is counted as a child of rudderd.
    const identity = await loadIdentity()
    const diskPromise = loadDisk()
    if (!last || now() - last.at > BASELINE_MAX_AGE_MS) {
      last = await read()
      await sleep(baselineMs)
    }
    const started = performance.now()
    const selfBefore = process.cpuUsage()
    const next = await read()
    const prev = last
    last = next
    const self = process.cpuUsage(selfBefore)
    const cost = {
      cpuMs: round((self.user + self.system + next.childCpuMicros) / 1000, 2),
      wallMs: round(performance.now() - started, 2),
      spawned: next.spawnedPids.size,
    }
    const sample = compose(prev, next, cost, identity)
    const disk = await diskPromise
    if (disk) sample.disk = disk
    return sample
  }

  return {
    /** One sample; concurrent callers share it. */
    sample(): Promise<PerfSample> {
      inflight ??= produce().finally(() => {
        inflight = undefined
      })
      return inflight
    },
  }
}

export type PerfSampler = ReturnType<typeof createPerfSampler>

function round(value: number, digits: number) {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}
