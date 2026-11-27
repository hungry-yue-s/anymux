import AppKit
import Foundation

private enum SelfTestError: Error, CustomStringConvertible {
    case failed(String)

    var description: String {
        switch self {
        case let .failed(message): message
        }
    }
}

private func expect(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    guard condition() else { throw SelfTestError.failed(message) }
}

private func testEndpointResolution() throws {
    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }

    let certificateDER = Data([0x30, 0x03, 0x02, 0x01, 0x01])
    let certificateURL = directory.appendingPathComponent("cert.der")
    try certificateDER.write(to: certificateURL)
    let plistURL = directory.appendingPathComponent("panel.plist")
    let plist: [String: Any] = [
        "EnvironmentVariables": [
            "PORT": "9443",
            "HOST": "0.0.0.0",
            "TLS_CERT": certificateURL.path,
        ],
    ]
    let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
    try data.write(to: plistURL)

    let endpoint = PanelEndpointResolver.resolve(environment: [:], launchAgentURL: plistURL)
    try expect(endpoint.url.absoluteString == "https://127.0.0.1:9443/", "TLS endpoint resolution failed")
    try expect(endpoint.pinnedCertificateDER == certificateDER, "certificate pin loading failed")

    let override = PanelEndpointResolver.resolve(
        environment: ["ANYMUX_URL": "http://localhost:8080"],
        launchAgentURL: plistURL
    )
    try expect(override.url.absoluteString == "http://localhost:8080/", "URL override failed")
    try expect(PanelEndpointResolver.normalizedURL("file:///tmp/panel") == nil, "unsafe URL scheme accepted")
    try expect(PanelEndpointResolver.normalizedURL("not a url") == nil, "invalid URL accepted")
    try expect(PanelEndpointResolver.isLoopback("127.0.0.1"), "IPv4 loopback rejected")
    try expect(PanelEndpointResolver.isLoopback("LOCALHOST"), "localhost rejected")
    try expect(PanelEndpointResolver.isLoopback("::1"), "IPv6 loopback rejected")
    try expect(!PanelEndpointResolver.isLoopback("192.168.1.10"), "LAN host accepted as loopback")
    try expect(
        PanelEndpointResolver.isSameOrigin(
            URL(string: "https://127.0.0.1:9443/terminal.html")!,
            as: endpoint.url
        ),
        "same-origin panel URL rejected"
    )
    try expect(
        !PanelEndpointResolver.isSameOrigin(
            URL(string: "https://example.com/terminal.html")!,
            as: endpoint.url
        ),
        "external origin accepted"
    )
    try expect(
        PanelEndpointResolver.isSameOrigin(
            URL(string: "http://localhost/path")!,
            as: URL(string: "http://localhost:80/")!
        ),
        "default HTTP port did not match explicit port"
    )

    let rootEndpoint = URL(string: "https://127.0.0.1:9443/")!
    for allowed in ["/", "/index.html", "/login.html?next=%23%2Fservers", "/#/servers/local"] {
        try expect(
            PanelEndpointResolver.isAllowedPrimaryDocument(
                URL(string: "https://127.0.0.1:9443\(allowed)")!,
                as: rootEndpoint
            ),
            "allowed primary document rejected: \(allowed)"
        )
    }
    for blocked in ["/research/note.md", "/api/files/raw", "/terminal.html"] {
        try expect(
            !PanelEndpointResolver.isAllowedPrimaryDocument(
                URL(string: "https://127.0.0.1:9443\(blocked)")!,
                as: rootEndpoint
            ),
            "unexpected primary document accepted: \(blocked)"
        )
    }
    try expect(
        !PanelEndpointResolver.isAllowedPrimaryDocument(
            URL(string: "https://example.com/")!, as: rootEndpoint
        ),
        "cross-origin primary document accepted"
    )

    let baseEndpoint = URL(string: "https://panel.test/base/")!
    try expect(
        PanelEndpointResolver.isAllowedPrimaryDocument(
            URL(string: "https://panel.test/base/login.html")!, as: baseEndpoint
        ),
        "base-path login document rejected"
    )
    try expect(
        !PanelEndpointResolver.isAllowedPrimaryDocument(
            URL(string: "https://panel.test/research/note.md")!, as: baseEndpoint
        ),
        "path outside base accepted"
    )
}

private func testServiceStateParsing() throws {
    try expect(
        ServiceInspector.parseLaunchctlOutput("state = running\npid = 42") == .running,
        "running launchd state was not recognized"
    )
    try expect(
        ServiceInspector.parseLaunchctlOutput("state = exited\nlast exit code = 1") == .stopped,
        "stopped launchd state was not recognized"
    )
    try expect(ServiceInspector.parseLaunchctlOutput("") == .unavailable, "empty state should be unavailable")
}

@MainActor
private func testTitlebarDragHitTesting() throws {
    let container = NSView(frame: NSRect(x: 0, y: 0, width: 1200, height: 800))
    let drag = PanelTitlebarDragView(frame: NSRect(x: 80, y: 756, width: 1120, height: 44))
    container.addSubview(drag)
    drag.exclusions = [NSRect(x: 4, y: 8, width: 28, height: 28)]
    try expect(drag.hitTest(NSPoint(x: 500, y: 778)) === drag, "blank titlebar must receive native dragging")
    try expect(drag.hitTest(NSPoint(x: 100, y: 778)) == nil, "sidebar button must remain clickable")
    try expect(drag.hitTest(NSPoint(x: 500, y: 730)) == nil, "content below titlebar must remain clickable")
    drag.exclusions = [NSRect(x: 4, y: 8, width: 28, height: 28), NSRect(x: 400, y: 8, width: 28, height: 28)]
    try expect(drag.hitTest(NSPoint(x: 500, y: 778)) == nil, "new toolbar controls must be excluded")
    drag.frame.size.height = 0
    try expect(drag.hitTest(NSPoint(x: 500, y: 778)) == nil, "hidden titlebar must not intercept modal clicks")
}

private func testNativeAppearanceConfig() throws {
    let legacy = NativeAppearanceConfig(messageBody: ["glassIntensity": 60.0])
    try expect(legacy.glassIntensity == 60.0, "legacy glassIntensity should parse")
    try expect(legacy.mode == "desktop", "legacy payload should default to desktop mode")
    try expect(legacy.blurRadius == 18.0, "legacy payload should derive blurRadius from intensity")

    let rich = NativeAppearanceConfig(messageBody: [
        "glassIntensity": 140.0,
        "mode": "desktop",
        "engine": "liquid-clear",
        "blurRadius": 99.0,
        "saturation": 3.5,
        "brightness": -0.9,
        "tintHex": " #7AA2F7 ",
        "tintAlpha": 1.8,
        "colorScheme": "light",
    ])
    try expect(rich.glassIntensity == 100.0, "intensity should clamp to 100")
    try expect(rich.engine == .liquidClear, "liquid-clear engine should parse")
    try expect(rich.blurRadius == 60.0, "blurRadius should clamp to 60")
    try expect(rich.effectiveBlurRadius == 60.0, "effectiveBlurRadius should track blurRadius directly")
    try expect(rich.saturation == 2.2, "saturation should clamp to 2.2")
    try expect(rich.brightness == -0.3, "brightness should clamp to -0.3")
    try expect(rich.tintHex == "#7aa2f7", "tintHex should normalize lowercase")
    try expect(rich.tintAlpha == 1.0, "tintAlpha should clamp to 1.0")
    try expect(rich.isLight == true, "light colorScheme should parse")

    let materialDirect = NativeAppearanceConfig(messageBody: [
        "mode": "desktop",
        "engine": "material",
        "blurRadius": 28.0,
        "glassIntensity": 25.0,
    ])
    try expect(materialDirect.effectiveBlurRadius == 28.0, "material blurRadius must not be multiplied by glassIntensity")

    let invalid = NativeAppearanceConfig(messageBody: [
        "mode": "evil",
        "engine": "unknown",
        "tintHex": "not-a-hex",
        "blurRadius": Double.nan,
    ], fallback: rich)
    try expect(invalid.mode == rich.mode, "invalid mode should keep fallback")
    try expect(invalid.engine == rich.engine, "invalid engine should keep fallback")
    try expect(invalid.tintHex == nil, "invalid tintHex should reject safely")
    try expect(invalid.blurRadius == rich.blurRadius, "NaN blurRadius should keep fallback")
}

private func testNativeBrowserLauncher() throws {
    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("anymux-browser-test-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }

    // 1. HTML staging + path traversal sanitization
    let htmlBody: [String: Any] = [
        "html": "<!doctype html><h1>Hello</h1>",
        "filename": "../../evil/report.html",
    ]
    let stagedHTML = NativeBrowserLauncher.stagePreviewFile(body: htmlBody, directory: directory)
    try expect(stagedHTML != nil, "HTML preview file should stage")
    try expect(stagedHTML!.deletingLastPathComponent().path == directory.path, "staged file must stay in preview directory")
    try expect(stagedHTML!.lastPathComponent.hasSuffix("-report.html"), "sanitized filename should retain safe basename")
    let htmlContent = try String(contentsOf: stagedHTML!, encoding: .utf8)
    try expect(htmlContent == "<!doctype html><h1>Hello</h1>", "HTML bytes must match")

    // 2. Binary base64 staging for allowed extensions (PDF/PNG)
    let pdfData = Data("%PDF-1.7".utf8)
    let stagedPDF = NativeBrowserLauncher.stagePreviewFile(body: [
        "dataBase64": pdfData.base64EncodedString(),
        "filename": "../sub\\doc.pdf",
    ], directory: directory)
    try expect(stagedPDF != nil && stagedPDF!.lastPathComponent.hasSuffix("-doc.pdf"), "PDF preview should stage safely")
    let readPDF = try Data(contentsOf: stagedPDF!)
    try expect(readPDF == pdfData, "PDF bytes must match")

    // 3. Reject dangerous extensions and path-only payloads
    for badName in ["run.command", "script.sh", "payload.app", "noext"] {
        let rejected = NativeBrowserLauncher.stagePreviewFile(body: [
            "dataBase64": Data("echo hi".utf8).base64EncodedString(),
            "filename": badName,
        ], directory: directory)
        try expect(rejected == nil, "dangerous or extensionless binary filename must be rejected: \(badName)")
    }
    let pathOnly = NativeBrowserLauncher.stagePreviewFile(body: ["path": "/etc/passwd"], directory: directory)
    try expect(pathOnly == nil, "arbitrary filesystem path payload must be rejected")

    // 4. Reject oversized payloads
    let oversizedHTML = String(repeating: "x", count: NativeBrowserLauncher.maximumHTMLBytes + 1)
    try expect(
        NativeBrowserLauncher.stagePreviewFile(body: ["html": oversizedHTML], directory: directory) == nil,
        "oversized HTML payload must be rejected"
    )

    // 5. Prune stale files by age and count
    let oldFile = directory.appendingPathComponent("stale.html")
    try Data("old".utf8).write(to: oldFile)
    try FileManager.default.setAttributes([.modificationDate: Date().addingTimeInterval(-90_000)], ofItemAtPath: oldFile.path)
    NativeBrowserLauncher.pruneStaleFiles(in: directory, now: Date(), maxFiles: 2, maxAge: 86_400)
    try expect(!FileManager.default.fileExists(atPath: oldFile.path), "expired preview file should be pruned")

    for i in 0..<4 {
        let url = directory.appendingPathComponent("item-\(i).html")
        try Data("x".utf8).write(to: url)
        try FileManager.default.setAttributes([.modificationDate: Date().addingTimeInterval(TimeInterval(i))], ofItemAtPath: url.path)
    }
    NativeBrowserLauncher.pruneStaleFiles(in: directory, now: Date().addingTimeInterval(10), maxFiles: 2, maxAge: 86_400)
    let remaining = try FileManager.default.contentsOfDirectory(atPath: directory.path)
    try expect(remaining.count == 2, "only maxFiles newest previews should remain")

    // 6. HTTP/HTTPS URL validation
    let base = URL(string: "https://127.0.0.1:7681/")!
    try expect(NativeBrowserLauncher.validatedHTTPURL(from: "/api/files/raw?path=%2Ftmp%2Fa.mp4", relativeTo: base)?.scheme == "https", "relative HTTPS URL should validate")
    try expect(NativeBrowserLauncher.validatedHTTPURL(from: "file:///etc/passwd", relativeTo: base) == nil, "file:// URL must be rejected")
    try expect(NativeBrowserLauncher.validatedHTTPURL(from: "javascript:alert(1)", relativeTo: base) == nil, "javascript: URL must be rejected")
}

do {
    try testEndpointResolution()
    try testServiceStateParsing()
    try MainActor.assumeIsolated { try testTitlebarDragHitTesting() }
    try testNativeAppearanceConfig()
    try testNativeBrowserLauncher()
    print("macOS shell self-tests passed: endpoint, TLS pin, loopback policy, service state, native titlebar hit-testing, appearance config, native browser launcher")
} catch {
    fputs("macOS shell self-test failed: \(error)\n", stderr)
    exit(1)
}
