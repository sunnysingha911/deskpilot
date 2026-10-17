// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "axhelper",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "axhelper",
            path: "Sources/axhelper",
            linkerSettings: [
                .linkedFramework("ApplicationServices"),
                .linkedFramework("AppKit"),
            ]
        )
    ]
)
