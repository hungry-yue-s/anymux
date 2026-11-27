import Foundation

private struct Failure: Error, CustomStringConvertible {
    let description: String
}

private func expect(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    if !condition() { throw Failure(description: message) }
}

@main
struct DesktopSetupSelfTests {
    @MainActor
    static func main() async {
        do {
            let partial = try JSONDecoder().decode(DesktopSetupResult.self, from: Data("{\"ok\":true,\"status\":{\"runtimeAvailable\":false}}".utf8))
            try expect(partial.status?.runtimeAvailable == false, "missing runtime was treated as ready")
            try expect(partial.configuration == nil, "readiness was invented for a partial report")
            let payload = #"{"ok":true,"configuration":{"port":17681,"username":"admin","initialized":true,"relay":{"enabled":true,"hasToken":true}},"status":{"endpoint":"https://127.0.0.1:17681/","panelState":"running"},"paths":{"tlsCertificate":"/tmp/cert.pem"},"sessionToken":"temporary-session"}"#
            let report = try JSONDecoder().decode(DesktopSetupResult.self, from: Data(payload.utf8))
            try expect(report.configuration?.relay?.hasToken == true, "saved token availability was lost")
            try expect(report.paths?.tlsCertificate == "/tmp/cert.pem", "TLS pin path was lost")
            let records = [
                DesktopSetupEvent(id: "runtime", title: "内置组件", status: "running"),
                DesktopSetupEvent(id: "runtime", title: "内置组件", status: "complete"),
            ]
            let latest = DesktopSetupManager.latestEvents(records)
            try expect(latest.count == 1 && latest[0].status == "complete", "step updates produced duplicate UI identities")

            let missing = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            let absent = DesktopSetupManager(environment: ["ANYMUX_DATA_DIR": missing.path, "ANYMUX_RUNTIME_DIR": missing.appendingPathComponent("missing").path])
            await absent.refresh()
            try expect(absent.needsSetup && !absent.bundledRuntimeAvailable, "incomplete bundle bypassed setup")
            try expect(absent.error?.code == "RUNTIME_MISSING", "incomplete bundle has no actionable error")
            try expect(!FileManager.default.fileExists(atPath: missing.path), "read-only inspection wrote application data")

            try await testHelperProtocol()
            try testMacPermissions()
            print("macOS setup self-tests passed: partial reports, TLS metadata, missing bundle, no inspection writes, one-time session handoff, macOS permissions")
        } catch {
            print("macOS setup self-test failed: \(error)")
            exit(1)
        }
    }

    @MainActor
    private static func testHelperProtocol() async throws {
        let temp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: temp) }
        let runtime = temp.appendingPathComponent("runtime")
        try FileManager.default.createDirectory(at: runtime.appendingPathComponent("bin"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: runtime.appendingPathComponent("app/scripts"), withIntermediateDirectories: true)
        let json = #"{"ok":true,"configuration":{"port":17681,"username":"admin","initialized":true},"status":{"endpoint":"http://127.0.0.1:17681/","panelState":"running","tmuxState":"running"},"sessionToken":"one-time-session"}"#
        let executable = runtime.appendingPathComponent("bin/node")
        // A protocol fixture only: no real Node/tmux or service manager runs.
        try "#!/bin/sh\ncat >/dev/null\nprintf '%s' '\(json)'\n".write(to: executable, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)
        try "".write(to: runtime.appendingPathComponent("app/scripts/desktop-runtime.mjs"), atomically: true, encoding: .utf8)
        let manager = DesktopSetupManager(environment: ["ANYMUX_DATA_DIR": temp.appendingPathComponent("data").path, "ANYMUX_RUNTIME_DIR": runtime.path])
        let success = await manager.perform("initialize")
        try expect(success && manager.isManaged, "successful helper result was not adopted")
        try expect(manager.endpoint?.url.absoluteString == "http://127.0.0.1:17681/", "managed endpoint was not adopted")
        try expect(manager.takeSessionToken() == "one-time-session", "first handoff token missing")
        try expect(manager.takeSessionToken() == nil, "handoff token was not consumed once")
        try expect(!FileManager.default.fileExists(atPath: temp.appendingPathComponent("data").path), "protocol inspection wrote data")
    }

    @MainActor
    private static func testMacPermissions() throws {
        try expect(MacPermissionKind.fullDiskAccess.settingsURLString.contains("Privacy_AllFiles"), "FDA settings URL missing")
        let temp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: temp) }
        let tccDir = temp.appendingPathComponent("Library/Application Support/com.apple.TCC", isDirectory: true)
        try FileManager.default.createDirectory(at: tccDir, withIntermediateDirectories: true)
        let db = tccDir.appendingPathComponent("TCC.db")
        try Data([0x53]).write(to: db)
        try expect(MacPermissionsManager.probeFullDiskAccess(homeDirectory: temp) == .granted, "readable TCC.db fixture was not reported granted")
        try FileManager.default.removeItem(at: db)
        try expect(MacPermissionsManager.probeFullDiskAccess(homeDirectory: temp) == .unknown, "missing TCC.db fixture was not reported unknown")
        try expect(DesktopControlSection.allCases.contains(.permissions), "permissions section missing from control center")
    }
}
