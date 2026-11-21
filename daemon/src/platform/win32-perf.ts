// Windows readings for the perf feed (perf.ts) and the machine's identity (the Windows notes).
//
// Windows has no ps / vm_stat. One PowerShell process stays up while the phone watches and answers each request with
// a block: every process (pid, parent, working set, CPU time, start time) from Win32_Process, adapter byte counters
// from Get-NetAdapterStatistics, page-file use, and what the block cost it. Starting PowerShell costs ~0.3–0.5 s of
// CPU, so starting one per reading (every 2 s) would cost more than the reading. Output format: see parseWindowsSample.
import type { LineProcess } from "../adapter/stdio"
import { spawnLines } from "../adapter/stdio"
import type { ByteCounters, CommandResult, MachineIdentity, PsRow } from "../perf"
import { powershellArgv } from "./run"

export const SAMPLE_END = "#end"

const SAMPLE_SCRIPT = [
  "$ErrorActionPreference = 'Continue'",
  "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
  "$self = [System.Diagnostics.Process]::GetCurrentProcess()",
  "while ($null -ne [Console]::In.ReadLine()) {",
  "  $self.Refresh(); $before = $self.TotalProcessorTime.TotalMilliseconds",
  "  '#proc'",
  "  foreach ($p in Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,WorkingSetSize,KernelModeTime,UserModeTime,CreationDate) {",
  "    $made = if ($p.CreationDate) { ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds() } else { 0 }",
  "    '{0} {1} {2} {3} {4}' -f $p.ProcessId, $p.ParentProcessId, $p.WorkingSetSize, ($p.KernelModeTime + $p.UserModeTime), $made",
  "  }",
  "  '#net'",
  "  foreach ($a in Get-NetAdapterStatistics -ErrorAction SilentlyContinue) { '{0}|{1}|{2}|{3}' -f $a.Name, $a.InterfaceDescription, $a.ReceivedBytes, $a.SentBytes }",
  "  '#swap'",
  "  foreach ($f in Get-CimInstance Win32_PageFileUsage) { '{0} {1}' -f $f.AllocatedBaseSize, $f.CurrentUsage }",
  "  $self.Refresh(); '#cost ' + [int64](($self.TotalProcessorTime.TotalMilliseconds - $before) * 1000)",
  `  '${SAMPLE_END}'`,
  "  [Console]::Out.Flush()",
  "}",
].join("\n")

export function sampleWorkerArgv(): string[] {
  return powershellArgv(SAMPLE_SCRIPT)
}

export type WindowsSample = {
  processes: PsRow[]
  network: Map<string, ByteCounters>
  /** Adapters in `network` that are VPNs or virtual switches. */
  tunnels: Set<string>
  swap: { totalBytes: number; usedBytes: number } | null
  costMicros: number
}

// Virtual adapters whose bytes also cross a physical one (VPNs, Hyper-V / WSL switches): left out of the totals.
export function isWindowsTunnel(name: string, description: string): boolean {
  return /tailscale|wireguard|wintun|tap-windows|openvpn|zerotier|vpn|hyper-v|vethernet|virtual|loopback/i.test(`${name} ${description}`)
}

/**
 * Win32_Process times are 100 ns units; start times epoch ms. A parent link to a process that started after its
 * child is a reused pid (Windows hands pids out again), so that link is cut instead of misattributing the child.
 */
export function parseWindowsSample(text: string, now: number): WindowsSample {
  const sections = new Map<string, string[]>()
  let current: string[] | null = null
  let costMicros = 0
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith("#cost ")) costMicros = Number(line.slice(6)) || 0
    else if (line.startsWith("#")) {
      current = []
      sections.set(line.slice(1), current)
    } else if (line && current) current.push(line)
  }
  const made = new Map<number, number>()
  const rows: (PsRow & { made: number })[] = []
  for (const line of sections.get("proc") ?? []) {
    const fields = line.split(/\s+/).map(Number)
    if (fields.length !== 5 || !fields.every(Number.isFinite)) continue
    const [pid, ppid, workingSet, cpu100ns, createdMs] = fields as [number, number, number, number, number]
    made.set(pid, createdMs)
    rows.push({
      pid,
      ppid,
      rssBytes: workingSet,
      cpuPercent: 0,
      elapsedSec: createdMs > 0 ? Math.max(0, (now - createdMs) / 1000) : 0,
      cpuSec: cpu100ns / 1e7,
      made: createdMs,
    })
  }
  const processes = rows.map(({ made: started, ...row }) => {
    const parentMade = made.get(row.ppid)
    return parentMade !== undefined && started > 0 && parentMade > started ? { ...row, ppid: -1 } : row
  })
  const network = new Map<string, ByteCounters>()
  const tunnels = new Set<string>()
  for (const line of sections.get("net") ?? []) {
    const [name, description = "", rx, tx] = line.split("|")
    const rxBytes = Number(rx)
    const txBytes = Number(tx)
    if (!name || !Number.isFinite(rxBytes) || !Number.isFinite(txBytes) || rxBytes + txBytes === 0) continue
    network.set(name, { rxBytes, txBytes })
    if (isWindowsTunnel(name, description)) tunnels.add(name)
  }
  // Page files report megabytes; several drives can each have one.
  let totalMiB = 0
  let usedMiB = 0
  let files = 0
  for (const line of sections.get("swap") ?? []) {
    const [allocated, used] = line.split(/\s+/).map(Number)
    if (!Number.isFinite(allocated) || !Number.isFinite(used)) continue
    totalMiB += allocated!
    usedMiB += used!
    files++
  }
  const swap = files > 0 ? { totalBytes: totalMiB * 1024 ** 2, usedBytes: usedMiB * 1024 ** 2 } : null
  return { processes, network, tunnels, swap, costMicros }
}

/**
 * The long-lived PowerShell behind the readings. It starts on the first reading, and exits after `idleMs` without one
 * (the phone closed the panel) or with rudderd. A reading that takes longer than `timeoutMs` restarts it.
 */
export function createSampleWorker(options: { idleMs?: number; timeoutMs?: number; spawn?: typeof spawnLines } = {}) {
  const idleMs = options.idleMs ?? 60_000
  const timeoutMs = options.timeoutMs ?? 10_000
  const spawn = options.spawn ?? spawnLines
  let proc: LineProcess | null = null
  let lines: string[] = []
  let waiting: ((text: string) => void) | null = null
  let idle: ReturnType<typeof setTimeout> | undefined

  const start = (): LineProcess => {
    const child = spawn(sampleWorkerArgv(), {
      onLine: (line) => {
        if (line !== SAMPLE_END) return void lines.push(line)
        const text = lines.join("\n")
        lines = []
        waiting?.(text)
        waiting = null
      },
    })
    void child.exited.then(() => {
      if (proc === child) proc = null
    })
    return child
  }

  const close = () => {
    clearTimeout(idle)
    const child = proc
    proc = null
    void child?.stop({ closeStdinFirst: true, graceMs: 1000 })
  }

  return {
    async read(): Promise<CommandResult> {
      if (waiting) throw new Error("a Windows reading is already running")
      proc ??= start()
      const child = proc
      clearTimeout(idle)
      const text = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting = null
          close()
          reject(new Error(`powershell gave no reading within ${timeoutMs / 1000}s${child.stderrTail() ? `: ${child.stderrTail()}` : ""}`))
        }, timeoutMs)
        waiting = (value) => {
          clearTimeout(timer)
          resolve(value)
        }
        void child.exited.then((code) => {
          if (!waiting) return
          waiting = null
          clearTimeout(timer)
          reject(new Error(`powershell exited with code ${code}${child.stderrTail() ? `: ${child.stderrTail()}` : ""}`))
        })
        child.write("sample")
      })
      idle = setTimeout(close, idleMs)
      idle.unref?.()
      const cost = /^#cost (\d+)$/m.exec(text)
      return { stdout: text, pid: child.pid, cpuMicros: cost ? Number(cost[1]) : 0 }
    },
    close,
  }
}

// ---------- identity ----------

const IDENTITY_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
  "$cs = Get-CimInstance Win32_ComputerSystem",
  "$os = Get-CimInstance Win32_OperatingSystem",
  "$cv = Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion'",
  "[pscustomobject]@{ manufacturer = [string]$cs.Manufacturer; model = [string]$cs.Model; family = [string]$cs.SystemFamily; " +
    "caption = [string]$os.Caption; build = [string]$os.BuildNumber; displayVersion = [string]$cv.DisplayVersion } | ConvertTo-Json -Compress",
].join("; ")

export function identityArgv(): string[] {
  return powershellArgv(IDENTITY_SCRIPT)
}

const PLACEHOLDER = /^(system (product name|manufacturer|version)|to be filled by o\.?e\.?m\.?|default string|not applicable|none|o\.e\.m\.|\s*)$/i
const VENDORS: [RegExp, string][] = [
  [/^dell/i, "Dell"],
  [/^(hp|hewlett[- ]packard)/i, "HP"],
  [/^lenovo/i, "Lenovo"],
  [/^microsoft/i, "Microsoft"],
  [/^asus/i, "ASUS"],
  [/^acer/i, "Acer"],
  [/^micro-star|^msi\b/i, "MSI"],
  [/^gigabyte/i, "Gigabyte"],
  [/^samsung/i, "Samsung"],
  [/^razer/i, "Razer"],
  [/^framework/i, "Framework"],
  [/^huawei/i, "HUAWEI"],
  [/^xiaomi|^timi/i, "Xiaomi"],
  [/^vmware/i, "VMware"],
  [/^qemu/i, "QEMU"],
]

/**
 * "Dell XPS 15 9530", "Microsoft Surface Laptop 5", "Lenovo ThinkPad X1 Carbon Gen 10" (Lenovo puts the product in
 * SystemFamily and a type number like 21CB0012US in Model). Placeholders a self-built PC's board reports are dropped.
 */
export function windowsModel(manufacturer: string, model: string, family: string): string | undefined {
  const vendor = VENDORS.find(([pattern]) => pattern.test(manufacturer.trim()))?.[1] ?? (PLACEHOLDER.test(manufacturer) ? "" : manufacturer.trim())
  let product = PLACEHOLDER.test(model) ? "" : model.trim()
  if (vendor === "Lenovo" && family.trim() && !PLACEHOLDER.test(family) && !/^lenovo$/i.test(family.trim())) product = family.trim()
  if (!product) return undefined
  if (!vendor || product.toLowerCase().startsWith(vendor.toLowerCase())) return product
  return `${vendor} ${product}`
}

/** "11 24H2": the product (builds from 22000 on are Windows 11, though the kernel still says 10.0) and the release. */
export function windowsVersion(build: string, displayVersion: string, caption: string): string | undefined {
  const number = Number.parseInt(build, 10)
  const product = /windows (1[01])\b/i.exec(caption)?.[1] ?? (Number.isFinite(number) ? (number >= 22000 ? "11" : "10") : undefined)
  if (!product) return undefined
  const release = displayVersion.trim()
  return release ? `${product} ${release}` : Number.isFinite(number) ? `${product} (${number})` : product
}

export function parseWindowsIdentity(stdout: string): MachineIdentity {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(stdout.trim()) as Record<string, unknown>
  } catch {
    return {}
  }
  const text = (key: string) => (typeof raw[key] === "string" ? (raw[key] as string) : "")
  const identity: MachineIdentity = {}
  const model = windowsModel(text("manufacturer"), text("model"), text("family"))
  const osVersion = windowsVersion(text("build"), text("displayVersion"), text("caption"))
  if (model) identity.model = model
  if (osVersion) identity.osVersion = osVersion
  return identity
}
