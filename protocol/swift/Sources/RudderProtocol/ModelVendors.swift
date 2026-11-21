import Foundation

/// One vendor's models as the quota card lists them: the newest version of each family, then the older ones
/// that fold into 「更早的 N 个」.
public struct RudderModelVendorGroup: Equatable, Sendable, Identifiable {
    public var vendor: String
    public var recent: [RudderModel]
    public var earlier: [RudderModel]

    public var id: String { vendor }
    /// The group header's count: every model of the vendor, folded ones included.
    public var total: Int { recent.count + earlier.count }

    public init(vendor: String, recent: [RudderModel], earlier: [RudderModel]) {
        self.vendor = vendor
        self.recent = recent
        self.earlier = earlier
    }
}

/// Groups a multi-vendor model list (Copilot). Vendors keep the order they first appear in; inside a vendor versions
/// run newest first, ties in the order sent. Models without a vendor (Copilot's `auto`) go on top on their own.
public enum RudderModelVendors {
    public static func applies(to models: [RudderModel]) -> Bool {
        models.contains { $0.vendor != nil }
    }

    public static func layout(_ models: [RudderModel]) -> (automatic: [RudderModel], groups: [RudderModelVendorGroup]) {
        let automatic = models.filter { $0.vendor == nil }
        var order: [String] = []
        var byVendor: [String: [RudderModel]] = [:]
        for model in models {
            guard let vendor = model.vendor else { continue }
            if byVendor[vendor] == nil { order.append(vendor) }
            byVendor[vendor, default: []].append(model)
        }
        let groups = order.map { vendor in
            let sorted = (byVendor[vendor] ?? []).enumerated()
                .sorted { lhs, rhs in
                    let order = compare(lhs.element.version, rhs.element.version)
                    return order == .orderedSame ? lhs.offset < rhs.offset : order == .orderedDescending
                }
                .map(\.element)
            var seen = Set<String>()
            var recent: [RudderModel] = []
            var earlier: [RudderModel] = []
            for model in sorted {
                if seen.insert(model.family ?? model.id).inserted { recent.append(model) } else { earlier.append(model) }
            }
            return RudderModelVendorGroup(vendor: vendor, recent: recent, earlier: earlier)
        }
        return (automatic, groups)
    }

    /// Dotted versions compared part by part ("6.1" > "6" > "5.6"); a missing version sorts like 0.
    static func compare(_ lhs: String?, _ rhs: String?) -> ComparisonResult {
        let left = parts(lhs), right = parts(rhs)
        for index in 0..<max(left.count, right.count) {
            let a = index < left.count ? left[index] : 0
            let b = index < right.count ? right[index] : 0
            if a != b { return a < b ? .orderedAscending : .orderedDescending }
        }
        return .orderedSame
    }

    private static func parts(_ version: String?) -> [Int] {
        (version ?? "").split(separator: ".").map { Int($0) ?? 0 }
    }

    /// 「0.33x」「1x」「14x」: the multiplier as Copilot writes it.
    public static func multiplierText(_ value: Double) -> String {
        let rounded = (value * 100).rounded() / 100
        if rounded == rounded.rounded() { return "\(Int(rounded))x" }
        var text = String(format: "%.2f", rounded)
        while text.hasSuffix("0") { text.removeLast() }
        return "\(text)x"
    }
}
