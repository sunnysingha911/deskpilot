// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "overlay",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "overlay",
            path: "Sources/overlay",
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("WebKit"),
            ]
        )
    ]
)
