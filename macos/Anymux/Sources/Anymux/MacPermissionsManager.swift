import AppKit
import ApplicationServices
import Combine
import CoreGraphics
import Darwin
import Foundation

enum MacPermissionStatus: String, Sendable {
    case granted
    case denied
    case unknown

    var label: String {
        switch self {
        case .granted: "已授权"
        case .denied: "未授权"
        case .unknown: "未知"
        }
    }
}

enum MacPermissionKind: String, CaseIterable, Identifiable, Sendable {
    case fullDiskAccess = "full-disk-access"
    case filesAndFolders = "files-and-folders"
    case localNetwork = "local-network"
    case automation = "automation"
    case accessibility = "accessibility"
    case screenRecording = "screen"

    var id: String { rawValue }

    var title: String {
        switch self {
        case .fullDiskAccess: "完全磁盘访问权限"
        case .filesAndFolders: "文件和文件夹"
        case .localNetwork: "本地网络"
        case .automation: "自动化（Apple Events）"
        case .accessibility: "辅助功能"
        case .screenRecording: "屏幕录制"
        }
    }

    var subtitle: String {
        switch self {
        case .fullDiskAccess:
            "推荐优先开启。允许 Anymux 及其终端中的 Agent 访问桌面、文稿、下载与其他应用目录，避免使用中反复弹窗。"
        case .filesAndFolders:
            "如果暂不开启完全磁盘访问，可在此单独放行桌面、文稿与下载文件夹。"
        case .localNetwork:
            "允许终端与 Agent 连接本地开发服务及局域网设备。"
        case .automation:
            "允许开发脚本通过 osascript 控制其他本地应用。"
        case .accessibility:
            "允许自动化工具或辅助脚本注入按键与读取窗口状态。"
        case .screenRecording:
            "允许本地截图与视觉检查工具读取屏幕内容。"
        }
    }

    var actionLabel: String {
        switch self {
        case .accessibility, .automation, .localNetwork: "请求授权"
        case .fullDiskAccess, .filesAndFolders, .screenRecording: "打开系统设置"
        }
    }

    var settingsURLString: String {
        switch self {
        case .fullDiskAccess:
            "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"
        case .filesAndFolders:
            "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders"
        case .localNetwork:
            "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_LocalNetwork"
        case .automation:
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"
        case .accessibility:
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        case .screenRecording:
            "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
        }
    }
}

@MainActor
final class MacPermissionsManager: ObservableObject {
    @Published private(set) var statuses: [MacPermissionKind: MacPermissionStatus] = [:]
    @Published private(set) var isRefreshing = false

    private var activationCancellable: AnyCancellable?

    init() {
        activationCancellable = NotificationCenter.default
            .publisher(for: NSApplication.didBecomeActiveNotification)
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in
                self?.refresh()
            }
        refresh()
    }

    var fullDiskAccessStatus: MacPermissionStatus {
        statuses[.fullDiskAccess] ?? .unknown
    }

    func status(for kind: MacPermissionKind) -> MacPermissionStatus {
        statuses[kind] ?? .unknown
    }

    /// Reads 1 byte from TCC.db without prompting; `access()` would bypass MAC enforcement.
    nonisolated static func probeFullDiskAccess(
        homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser
    ) -> MacPermissionStatus {
        let tccURL = homeDirectory
            .appendingPathComponent("Library", isDirectory: true)
            .appendingPathComponent("Application Support", isDirectory: true)
            .appendingPathComponent("com.apple.TCC", isDirectory: true)
            .appendingPathComponent("TCC.db", isDirectory: false)
        let fd = Darwin.open(tccURL.path, O_RDONLY)
        if fd >= 0 {
            var byte: UInt8 = 0
            let readCount = Darwin.read(fd, &byte, 1)
            let readErrno = errno
            Darwin.close(fd)
            if readCount >= 0 { return .granted }
            return (readErrno == EPERM || readErrno == EACCES) ? .denied : .unknown
        }
        let openErrno = errno
        return (openErrno == EPERM || openErrno == EACCES) ? .denied : .unknown
    }

    nonisolated static func triggerLocalNetworkPrompt() {
        let fd = Darwin.socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP)
        guard fd >= 0 else { return }
        defer { Darwin.close(fd) }
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = in_port_t(5353).bigEndian
        inet_pton(AF_INET, "224.0.0.251", &addr.sin_addr)
        var payload: UInt8 = 0
        withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
                _ = Darwin.sendto(fd, &payload, 1, 0, sockPtr, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
    }

    nonisolated static func triggerAutomationPrompt() {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        process.arguments = ["-e", "tell application \"System Events\" to return 1"]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try? process.run()
        let deadline = Date().addingTimeInterval(3)
        while process.isRunning && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.05)
        }
        if process.isRunning { process.terminate() }
    }

    func refresh() {
        guard !isRefreshing else { return }
        isRefreshing = true
        Task {
            let fda = await Task.detached(priority: .utility) {
                Self.probeFullDiskAccess()
            }.value
            let ax: MacPermissionStatus = AXIsProcessTrusted() ? .granted : .unknown
            let screen: MacPermissionStatus = CGPreflightScreenCaptureAccess() ? .granted : .unknown
            statuses = [
                .fullDiskAccess: fda,
                .filesAndFolders: .unknown,
                .localNetwork: .unknown,
                .automation: .unknown,
                .accessibility: ax,
                .screenRecording: screen,
            ]
            isRefreshing = false
        }
    }

    func openSystemSettings(for kind: MacPermissionKind) {
        guard let url = URL(string: kind.settingsURLString) else { return }
        NSWorkspace.shared.open(url)
    }

    func request(_ kind: MacPermissionKind) {
        switch kind {
        case .accessibility:
            let options = ["AXTrustedCheckOptionPrompt": true] as CFDictionary
            if AXIsProcessTrustedWithOptions(options) {
                refresh()
            } else {
                openSystemSettings(for: kind)
            }
        case .automation:
            Task {
                await Task.detached(priority: .utility) { Self.triggerAutomationPrompt() }.value
                openSystemSettings(for: kind)
                refresh()
            }
        case .localNetwork:
            Task {
                await Task.detached(priority: .utility) { Self.triggerLocalNetworkPrompt() }.value
                openSystemSettings(for: kind)
            }
        case .fullDiskAccess, .filesAndFolders, .screenRecording:
            openSystemSettings(for: kind)
        }
    }

    func revealAppInFinder() {
        NSWorkspace.shared.activateFileViewerSelecting([Bundle.main.bundleURL])
    }
}
