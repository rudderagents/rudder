import Foundation
import Testing
@testable import RudderProtocol

private func json(_ text: String) throws -> RudderJSON {
    try JSONDecoder().decode(RudderJSON.self, from: Data(text.utf8))
}

struct PerfTests {
    /// A sample rudderd took on an M5 Max (18 cores, en0 plus two utun tunnels), with a Claude and a Codex tree added.
    @Test func parsesADarwinSample() throws {
        let sample = try #require(RudderPerfSample(json: json("""
        {"at":1792644221642,
         "machine":{"name":"mac-studio","platform":"darwin","arch":"arm64","cpuModel":"Apple M5 Max","cores":18,
                    "memoryBytes":68719476736,"uptimeSec":1038303},
         "cpu":{"percent":18.5,"cores":[0,0.5,0,0,0,0,53.6,48.8,52.2,47.8,47.6,45.2,14.8,9,4.3,2.4,3.3,4.3],"load":[5.8,5.58,5.68]},
         "memory":{"totalBytes":68719476736,"usedBytes":43006066688,"pressure":"normal","swapUsedBytes":11642014269,
                   "swapTotalBytes":12884901888,"breakdown":{"activeBytes":21963653120,"wiredBytes":11561254912,"compressedBytes":9481158656}},
         "network":{"interfaces":[{"name":"en0","rxBytesPerSec":10736,"txBytesPerSec":8512,"tunnel":false},
                                  {"name":"utun7","rxBytesPerSec":73,"txBytesPerSec":71,"tunnel":true}],
                    "rxBytesPerSec":10736,"txBytesPerSec":8512},
         "processes":[{"agent":"claude","label":"Claude Code","pid":4100,"sessionIds":["s1"],"shared":false,"rssBytes":2437000000,
                       "cpuPercent":19.2,"uptimeSec":2460,"processCount":5},
                      {"agent":"codex","label":"Codex","pid":4200,"sessionIds":["s2","s3"],"shared":true,"rssBytes":2351000000,
                       "cpuPercent":18.7,"uptimeSec":11520,"processCount":3},
                      {"agent":"rudderd","label":"rudderd","pid":18492,"sessionIds":[],"shared":false,"rssBytes":38256640,
                       "cpuPercent":1,"uptimeSec":2,"processCount":1}],
         "limits":{"processRssWarnBytes":6871947674},
         "sampler":{"cpuMs":115.17,"wallMs":98.9,"spawned":4}}
        """)))
        #expect(sample.at == Date(timeIntervalSince1970: 1_792_644_221.642))
        #expect(sample.machine?.cpuModel == "Apple M5 Max")
        #expect(sample.machine?.cores == 18)
        #expect(sample.cpu?.cores.count == 18)
        #expect(sample.cpu?.load == [5.8, 5.58, 5.68])
        #expect(sample.memory?.pressure == .normal)
        #expect(sample.memory?.swapUsedBytes == 11_642_014_269)
        #expect(sample.network?.interfaces.map(\.tunnel) == [false, true])
        #expect(sample.network?.rxBytesPerSec == 10736)
        #expect(sample.processes.map(\.id) == ["claude:4100", "codex:4200", "rudderd:18492"])
        #expect(sample.processes[1].shared && sample.processes[1].sessionIds == ["s2", "s3"])
        #expect(sample.processes[2].isDaemon)
        #expect(sample.processRssWarnBytes == 6_871_947_674)
        #expect(sample.errors.isEmpty)
        #expect(sample.machine?.model == nil)
        #expect(sample.machine?.osVersion == nil)
        #expect(sample.disk == nil)
    }

    @Test func readsModelOsVersionAndDiskWhenPresent() throws {
        let sample = try #require(RudderPerfSample(json: json("""
        {"at":2000,"machine":{"name":"studio","model":"Mac Studio","osVersion":"26.1","cpuModel":"Apple M5 Max","cores":18},
         "disk":{"totalBytes":1000,"freeBytes":400}}
        """)))
        #expect(sample.machine?.model == "Mac Studio")
        #expect(sample.machine?.osVersion == "26.1")
        #expect(sample.disk == RudderPerfSample.Disk(totalBytes: 1000, freeBytes: 400))
        let broken = try #require(RudderPerfSample(json: json(#"{"at":1,"disk":{"totalBytes":1}}"#)))
        #expect(broken.disk == nil)
    }

    /// Linux has no pressure, swap may be absent, and a part the daemon could not read is missing with an error.
    @Test func toleratesMissingPartsAndErrors() throws {
        let sample = try #require(RudderPerfSample(json: json("""
        {"at":1000,"machine":{"name":"devbox","platform":"linux","cores":4,"memoryBytes":8000000000,"uptimeSec":5},
         "cpu":{"percent":3,"cores":[3,3,3,3],"load":[0.1,0.2,0.3]},
         "memory":{"totalBytes":8000000000,"usedBytes":2000000000,"pressure":null,"swapUsedBytes":null,"swapTotalBytes":null},
         "processes":[{"agent":"rudderd","pid":7,"rssBytes":1000},{"agent":"broken"}],
         "errors":["netstat: exited with code 1"]}
        """)))
        #expect(sample.memory?.pressure == nil)
        #expect(sample.memory?.swapUsedBytes == nil)
        #expect(sample.network == nil)
        #expect(sample.processes.map(\.id) == ["rudderd:7"])
        #expect(sample.processes[0].label == "rudderd")
        #expect(sample.processRssWarnBytes == nil)
        #expect(sample.errors == ["netstat: exited with code 1"])
    }

    @Test func unknownPressureIsNilAndASampleNeedsItsTime() throws {
        let odd = try #require(RudderPerfSample(json: json(#"{"at":1,"memory":{"totalBytes":1,"usedBytes":1,"pressure":"purple"}}"#)))
        #expect(odd.memory?.pressure == nil)
        #expect(RudderPerfSample(json: try json(#"{"cpu":{"percent":1}}"#)) == nil)
    }
}
