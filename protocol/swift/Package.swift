// swift-tools-version: 6.1
import PackageDescription

// The Rudder wire protocol as seen from Swift: the frames the phone and the `rudder` daemon exchange.
// The daemon's side of the same protocol is daemon/src/protocol.ts.
let package = Package(
    name: "RudderProtocol",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "RudderProtocol", targets: ["RudderProtocol"]),
    ],
    targets: [
        .target(name: "RudderProtocol"),
        .testTarget(name: "RudderProtocolTests", dependencies: ["RudderProtocol"]),
    ]
)
