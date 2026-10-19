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
                .linkedFramework("Speech"),
                .linkedFramework("AVFoundation"),
                .linkedFramework("Carbon"),
                // Usage descriptions for the Microphone / Speech Recognition prompts (push-to-talk),
                // embedded in the binary since the helper isn't an .app bundle.
                .unsafeFlags(["-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", "Support/Info.plist"]),
            ]
        )
    ]
)
