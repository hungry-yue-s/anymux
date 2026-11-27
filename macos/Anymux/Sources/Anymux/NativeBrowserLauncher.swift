import AppKit
import Foundation

enum NativeBrowserLauncher {
    static let maximumHTMLBytes = 67_108_864
    static let maximumBinaryBytes = 33_554_432
    static let allowedExtensions: Set<String> = [
        "html", "htm", "pdf", "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg", "txt",
    ]
    static let maxRetainedFiles = 30
    static let maxAgeSeconds: TimeInterval = 86_400

    static var defaultPreviewDirectory: URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("anymux-browser-previews", isDirectory: true)
    }

    static func sanitizeFilename(
        _ raw: String?,
        fallbackExtension: String,
        enforceHTML: Bool = false
    ) -> String? {
        let trimmed = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let lastSegment = trimmed
            .split(whereSeparator: { $0 == "/" || $0 == "\\" })
            .last
            .map(String.init) ?? ""
        let cleaned = lastSegment
            .replacingOccurrences(of: ":", with: "-")
            .filter { ch in
                ch.unicodeScalars.allSatisfy { !CharacterSet.controlCharacters.contains($0) }
            }
            .drop(while: { $0 == "." })
        let candidate = String(cleaned)
        let nsCandidate = candidate as NSString
        let rawExt = nsCandidate.pathExtension.lowercased()
        var stem = nsCandidate.deletingPathExtension
            .trimmingCharacters(in: CharacterSet(charactersIn: ". "))
        if stem.isEmpty || stem == "." || stem == ".." {
            stem = "preview"
        }
        if stem.count > 80 {
            stem = String(stem.prefix(80))
        }

        let finalExt: String
        if enforceHTML {
            finalExt = (rawExt == "htm" || rawExt == "html") ? rawExt : fallbackExtension.lowercased()
        } else if rawExt.isEmpty {
            let fallback = fallbackExtension.lowercased()
            guard allowedExtensions.contains(fallback) else { return nil }
            finalExt = fallback
        } else {
            guard allowedExtensions.contains(rawExt) else { return nil }
            finalExt = rawExt
        }

        let token = String(UUID().uuidString.prefix(8)).lowercased()
        return "\(token)-\(stem).\(finalExt)"
    }

    static func validatedHTTPURL(from rawURL: String, relativeTo baseURL: URL) -> URL? {
        guard !rawURL.isEmpty,
              let url = URL(string: rawURL, relativeTo: baseURL)?.absoluteURL,
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https" else {
            return nil
        }
        return url
    }

    static func stagePreviewFile(
        body: [String: Any],
        directory: URL = defaultPreviewDirectory,
        now: Date = Date()
    ) -> URL? {
        let fm = FileManager.default
        let payload: Data
        let filename: String

        if let html = body["html"] as? String, !html.isEmpty {
            let utf8Count = html.utf8.count
            guard utf8Count <= maximumHTMLBytes,
                  let sanitized = sanitizeFilename(
                      body["filename"] as? String,
                      fallbackExtension: "html",
                      enforceHTML: true
                  ) else {
                return nil
            }
            payload = Data(html.utf8)
            filename = sanitized
        } else if let base64 = body["dataBase64"] as? String,
                  !base64.isEmpty,
                  let rawFilename = body["filename"] as? String {
            let maximumBase64Bytes = maximumBinaryBytes * 4 / 3 + 4
            guard base64.utf8.count <= maximumBase64Bytes,
                  let sanitized = sanitizeFilename(
                      rawFilename,
                      fallbackExtension: "",
                      enforceHTML: false
                  ),
                  let decoded = Data(base64Encoded: base64, options: .ignoreUnknownCharacters),
                  !decoded.isEmpty,
                  decoded.count <= maximumBinaryBytes else {
                return nil
            }
            payload = decoded
            filename = sanitized
        } else {
            return nil
        }

        do {
            try fm.createDirectory(
                at: directory,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
            let fileURL = directory.appendingPathComponent(filename, isDirectory: false)
            try payload.write(to: fileURL, options: .atomic)
            try? fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: fileURL.path)
            pruneStaleFiles(in: directory, now: now)
            return fileURL
        } catch {
            return nil
        }
    }

    static func pruneStaleFiles(
        in directory: URL,
        now: Date = Date(),
        maxFiles: Int = maxRetainedFiles,
        maxAge: TimeInterval = maxAgeSeconds
    ) {
        let fm = FileManager.default
        guard let urls = try? fm.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: [.contentModificationDateKey, .isRegularFileKey],
            options: [.skipsHiddenFiles]
        ) else {
            return
        }

        var entries: [(url: URL, mtime: Date)] = []
        for url in urls {
            guard let values = try? url.resourceValues(forKeys: [.contentModificationDateKey, .isRegularFileKey]),
                  values.isRegularFile == true else { continue }
            let mtime = values.contentModificationDate ?? .distantPast
            if now.timeIntervalSince(mtime) > maxAge {
                try? fm.removeItem(at: url)
            } else {
                entries.append((url, mtime))
            }
        }

        if entries.count > maxFiles {
            entries.sort { $0.mtime > $1.mtime }
            for item in entries.dropFirst(maxFiles) {
                try? fm.removeItem(at: item.url)
            }
        }
    }

    static func defaultBrowserApplicationURL() -> URL? {
        guard let probe = URL(string: "https://example.com") else { return nil }
        return NSWorkspace.shared.urlForApplication(toOpen: probe)
    }

    @MainActor
    static func open(_ body: [String: Any], relativeTo baseURL: URL) {
        if let fileURL = stagePreviewFile(body: body) {
            if let browserURL = defaultBrowserApplicationURL() {
                NSWorkspace.shared.open(
                    [fileURL],
                    withApplicationAt: browserURL,
                    configuration: NSWorkspace.OpenConfiguration()
                )
            } else {
                NSWorkspace.shared.open(fileURL)
            }
            return
        }

        if let rawURL = body["url"] as? String,
           let url = validatedHTTPURL(from: rawURL, relativeTo: baseURL) {
            NSWorkspace.shared.open(url)
        }
    }
}
