// swift-tools-version: 6.1

import PackageDescription

let package = Package(
    name: "Anymux",
    platforms: [
        .macOS(.v13),
    ],
    products: [
        .executable(name: "Anymux", targets: ["Anymux"]),
    ],
    dependencies: [
        .package(url: "https://github.com/OskarGroth/MaterialView.git", from: "1.0.0"),
    ],
    targets: [
        .executableTarget(
            name: "Anymux",
            dependencies: [
                .product(name: "MaterialView", package: "MaterialView"),
            ]
        ),
    ]
)
