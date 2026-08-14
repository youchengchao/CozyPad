// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "CozypadCapacitorIosNative",
    platforms: [.iOS(.v17)],
    products: [
        .library(
            name: "CozypadCapacitorIosNative",
            targets: ["CozypadCapacitorIosNative"]
        )
    ],
    dependencies: [
        .package(
            url: "https://github.com/ionic-team/capacitor-swift-pm.git",
            exact: "8.4.2"
        ),
        .package(
            url: "https://github.com/orlandos-nl/Citadel.git",
            exact: "0.12.1"
        ),
        .package(
            url: "https://github.com/Wellz26/swift-nio-ssh.git",
            ">= 0.3.4", "< 0.4.0"
        ),
        .package(
            url: "https://github.com/apple/swift-nio.git",
            from: "2.81.0"
        ),
        .package(
            url: "https://github.com/apple/swift-crypto.git",
            from: "3.12.3"
        )
    ],
    targets: [
        .target(
            name: "CozypadCapacitorIosNative",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Citadel", package: "Citadel"),
                .product(name: "NIOCore", package: "swift-nio"),
                .product(name: "NIOSSH", package: "swift-nio-ssh"),
                .product(name: "Crypto", package: "swift-crypto")
            ],
            resources: [
                .copy("Resources/remote-agent-host.cjs")
            ]
        )
    ]
)
