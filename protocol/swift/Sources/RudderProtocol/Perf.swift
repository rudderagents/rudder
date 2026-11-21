import Foundation

// `perf.sample` / `perf.snapshot` (the implementation notes): one reading of a computer's CPU,
// memory, network and agent process trees. Every section is optional so a sample with a part the daemon could not
// read (`errors[]`), or from a platform without it (Linux has no memory pressure), still decodes.

public struct RudderPerfSample: Equatable, Sendable {
    public struct Machine: Equatable, Sendable {
        public var name: String
        public var platform: String
        public var cpuModel: String
        public var cores: Int
        public var memoryBytes: Int
        public var uptimeSec: Int
        /// Marketing name ("Mac Studio"). Nil when the daemon did not send one.
        public var model: String?
        /// Product version ("26.1"), without the "macOS" prefix. Nil on an older daemon.
        public var osVersion: String?

        public init(name: String, platform: String = "", cpuModel: String = "", cores: Int = 0, memoryBytes: Int = 0, uptimeSec: Int = 0,
                    model: String? = nil, osVersion: String? = nil) {
            self.name = name
            self.platform = platform
            self.cpuModel = cpuModel
            self.cores = cores
            self.memoryBytes = memoryBytes
            self.uptimeSec = uptimeSec
            self.model = model
            self.osVersion = osVersion
        }
    }

    /// Space on the volume that holds the computer's home directory.
    public struct Disk: Equatable, Sendable {
        public var totalBytes: Int
        public var freeBytes: Int

        public init(totalBytes: Int, freeBytes: Int) {
            self.totalBytes = totalBytes
            self.freeBytes = freeBytes
        }
    }

    public struct CPU: Equatable, Sendable {
        /// 0–100, the whole machine.
        public var percent: Double
        /// 0–100 per core.
        public var cores: [Double]
        /// 1, 5 and 15 minute load averages (may be shorter when the daemon could not read them).
        public var load: [Double]

        public init(percent: Double, cores: [Double] = [], load: [Double] = []) {
            self.percent = percent
            self.cores = cores
            self.load = load
        }
    }

    public enum Pressure: String, Equatable, Sendable {
        case normal, warn, critical
    }

    public struct Memory: Equatable, Sendable {
        public var totalBytes: Int
        public var usedBytes: Int
        /// macOS memory pressure; nil where the platform has none (Linux) or the level was unknown.
        public var pressure: Pressure?
        public var swapUsedBytes: Int?
        public var swapTotalBytes: Int?

        public init(totalBytes: Int, usedBytes: Int, pressure: Pressure? = nil, swapUsedBytes: Int? = nil, swapTotalBytes: Int? = nil) {
            self.totalBytes = totalBytes
            self.usedBytes = usedBytes
            self.pressure = pressure
            self.swapUsedBytes = swapUsedBytes
            self.swapTotalBytes = swapTotalBytes
        }
    }

    public struct Interface: Equatable, Sendable {
        public var name: String
        public var rxBytesPerSec: Double
        public var txBytesPerSec: Double
        /// A VPN / tunnel interface: its traffic also crosses a physical one, so it is not in the totals.
        public var tunnel: Bool

        public init(name: String, rxBytesPerSec: Double, txBytesPerSec: Double, tunnel: Bool = false) {
            self.name = name
            self.rxBytesPerSec = rxBytesPerSec
            self.txBytesPerSec = txBytesPerSec
            self.tunnel = tunnel
        }
    }

    public struct Network: Equatable, Sendable {
        public var interfaces: [Interface]
        /// Totals over the non-tunnel interfaces, as the daemon adds them.
        public var rxBytesPerSec: Double
        public var txBytesPerSec: Double

        public init(interfaces: [Interface], rxBytesPerSec: Double, txBytesPerSec: Double) {
            self.interfaces = interfaces
            self.rxBytesPerSec = rxBytesPerSec
            self.txBytesPerSec = txBytesPerSec
        }
    }

    /// One agent process tree (root plus tool subprocesses), or rudderd itself.
    public struct Process: Equatable, Sendable, Identifiable {
        public var agent: String
        public var label: String
        public var pid: Int
        public var sessionIds: [String]
        /// One process serves several sessions (Codex app-server, ACP agents): memory is per process only.
        public var shared: Bool
        public var rssBytes: Int
        /// 100 = one core busy; a tree can exceed 100.
        public var cpuPercent: Double
        public var uptimeSec: Int
        public var processCount: Int

        public var id: String { "\(agent):\(pid)" }
        public var isDaemon: Bool { agent == "rudderd" }

        public init(agent: String, label: String, pid: Int, sessionIds: [String] = [], shared: Bool = false, rssBytes: Int,
                    cpuPercent: Double, uptimeSec: Int = 0, processCount: Int = 1) {
            self.agent = agent
            self.label = label
            self.pid = pid
            self.sessionIds = sessionIds
            self.shared = shared
            self.rssBytes = rssBytes
            self.cpuPercent = cpuPercent
            self.uptimeSec = uptimeSec
            self.processCount = processCount
        }
    }

    /// When the reading finished (daemon clock).
    public var at: Date
    public var machine: Machine?
    public var cpu: CPU?
    public var memory: Memory?
    public var network: Network?
    public var disk: Disk?
    /// Largest RSS first, as the daemon sorts them.
    public var processes: [Process]
    /// A process tree above this gets the 偏大 hint; nil when the daemon did not send one.
    public var processRssWarnBytes: Int?
    /// Parts the daemon could not read this time ("sysctl: …").
    public var errors: [String]

    public init(at: Date, machine: Machine? = nil, cpu: CPU? = nil, memory: Memory? = nil, network: Network? = nil,
                disk: Disk? = nil, processes: [Process] = [], processRssWarnBytes: Int? = nil, errors: [String] = []) {
        self.at = at
        self.machine = machine
        self.cpu = cpu
        self.memory = memory
        self.network = network
        self.disk = disk
        self.processes = processes
        self.processRssWarnBytes = processRssWarnBytes
        self.errors = errors
    }

    /// Reads a `PerfSample`. Only `at` is required; a malformed section is dropped, a malformed process row skipped.
    public init?(json: RudderJSON) {
        guard let at = json["at"]?.number else { return nil }
        self.at = Date(timeIntervalSince1970: at / 1000)
        machine = json["machine"].flatMap(Self.machine)
        cpu = json["cpu"].flatMap(Self.cpu)
        memory = json["memory"].flatMap(Self.memory)
        network = json["network"].flatMap(Self.network)
        disk = json["disk"].flatMap(Self.disk)
        processes = json["processes"]?.array?.compactMap(Self.process) ?? []
        processRssWarnBytes = json["limits"]?["processRssWarnBytes"]?.int
        errors = json["errors"]?.array?.compactMap(\.string) ?? []
    }

    private static func machine(_ json: RudderJSON) -> Machine? {
        guard let name = json["name"]?.string else { return nil }
        return Machine(
            name: name,
            platform: json["platform"]?.string ?? "",
            cpuModel: json["cpuModel"]?.string ?? "",
            cores: json["cores"]?.int ?? 0,
            memoryBytes: json["memoryBytes"]?.int ?? 0,
            uptimeSec: json["uptimeSec"]?.int ?? 0,
            model: json["model"]?.string,
            osVersion: json["osVersion"]?.string
        )
    }

    private static func disk(_ json: RudderJSON) -> Disk? {
        guard let total = json["totalBytes"]?.int, let free = json["freeBytes"]?.int else { return nil }
        return Disk(totalBytes: total, freeBytes: free)
    }

    private static func cpu(_ json: RudderJSON) -> CPU? {
        guard let percent = json["percent"]?.number else { return nil }
        return CPU(percent: percent, cores: json["cores"]?.array?.compactMap(\.number) ?? [], load: json["load"]?.array?.compactMap(\.number) ?? [])
    }

    private static func memory(_ json: RudderJSON) -> Memory? {
        guard let total = json["totalBytes"]?.int, let used = json["usedBytes"]?.int else { return nil }
        return Memory(
            totalBytes: total,
            usedBytes: used,
            pressure: json["pressure"]?.string.flatMap(Pressure.init(rawValue:)),
            swapUsedBytes: json["swapUsedBytes"]?.int,
            swapTotalBytes: json["swapTotalBytes"]?.int
        )
    }

    private static func network(_ json: RudderJSON) -> Network? {
        guard let rx = json["rxBytesPerSec"]?.number, let tx = json["txBytesPerSec"]?.number else { return nil }
        let interfaces = json["interfaces"]?.array?.compactMap { row -> Interface? in
            guard let name = row["name"]?.string, let rx = row["rxBytesPerSec"]?.number, let tx = row["txBytesPerSec"]?.number else { return nil }
            return Interface(name: name, rxBytesPerSec: rx, txBytesPerSec: tx, tunnel: row["tunnel"]?.bool ?? false)
        } ?? []
        return Network(interfaces: interfaces, rxBytesPerSec: rx, txBytesPerSec: tx)
    }

    private static func process(_ json: RudderJSON) -> Process? {
        guard let agent = json["agent"]?.string, let pid = json["pid"]?.int, let rss = json["rssBytes"]?.int else { return nil }
        return Process(
            agent: agent,
            label: json["label"]?.string ?? agent,
            pid: pid,
            sessionIds: json["sessionIds"]?.array?.compactMap(\.string) ?? [],
            shared: json["shared"]?.bool ?? false,
            rssBytes: rss,
            cpuPercent: json["cpuPercent"]?.number ?? 0,
            uptimeSec: json["uptimeSec"]?.int ?? 0,
            processCount: json["processCount"]?.int ?? 1
        )
    }
}
