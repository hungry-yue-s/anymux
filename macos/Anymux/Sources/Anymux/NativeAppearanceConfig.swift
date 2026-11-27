import AppKit
import Foundation

enum NativeGlassEngine: String, Sendable, Equatable {
    case material = "material"
    case liquidRegular = "liquid-regular"
    case liquidClear = "liquid-clear"
    case system = "system"
    case off = "off"
}

struct NativeAppearanceConfig: Sendable, Equatable {
    var glassIntensity: Double
    var mode: String
    var engine: NativeGlassEngine
    var blurRadius: Double
    var saturation: Double
    var brightness: Double
    var tintHex: String?
    var tintAlpha: Double
    var isLight: Bool

    static let `default` = NativeAppearanceConfig(
        glassIntensity: 100.0,
        mode: "desktop",
        engine: .material,
        blurRadius: 22.0,
        saturation: 1.35,
        brightness: 0.0,
        tintHex: nil,
        tintAlpha: 0.22,
        isLight: false
    )

    var effectiveBlurRadius: Double {
        max(0.0, min(60.0, blurRadius))
    }

    init(
        glassIntensity: Double,
        mode: String,
        engine: NativeGlassEngine,
        blurRadius: Double,
        saturation: Double,
        brightness: Double,
        tintHex: String?,
        tintAlpha: Double,
        isLight: Bool
    ) {
        self.glassIntensity = glassIntensity
        self.mode = mode
        self.engine = engine
        self.blurRadius = blurRadius
        self.saturation = saturation
        self.brightness = brightness
        self.tintHex = tintHex
        self.tintAlpha = tintAlpha
        self.isLight = isLight
    }

    init(messageBody body: [String: Any], fallback: NativeAppearanceConfig = .default) {
        let rawIntensity = Self.doubleValue(body["glassIntensity"]) ?? fallback.glassIntensity
        let clampedIntensity = Self.clamp(rawIntensity, min: 0.0, max: 100.0, fallback: fallback.glassIntensity)

        let rawMode = (body["mode"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let allowedModes: Set<String> = ["desktop", "none", "solid", "wallpaper", "builtin", "custom"]
        let resolvedMode: String
        if let rawMode, allowedModes.contains(rawMode) {
            resolvedMode = rawMode
        } else if body["mode"] == nil {
            resolvedMode = "desktop"
        } else {
            resolvedMode = fallback.mode
        }

        let resolvedEngine: NativeGlassEngine
        if let rawEngine = body["engine"] as? String,
           let parsedEngine = NativeGlassEngine(rawValue: rawEngine) {
            resolvedEngine = parsedEngine
        } else if body["mode"] == nil && body["engine"] == nil {
            // Legacy `{ glassIntensity }` payload keeps classic intensity curve.
            resolvedEngine = fallback.engine
        } else {
            resolvedEngine = fallback.engine
        }

        let resolvedBlur: Double
        if let explicitBlur = Self.doubleValue(body["blurRadius"]) {
            resolvedBlur = Self.clamp(explicitBlur, min: 0.0, max: 60.0, fallback: fallback.blurRadius)
        } else if body["mode"] == nil && body["blurRadius"] == nil {
            resolvedBlur = Self.clamp((clampedIntensity / 100.0) * 30.0, min: 0.0, max: 60.0, fallback: fallback.blurRadius)
        } else {
            resolvedBlur = fallback.blurRadius
        }

        let resolvedSaturation = Self.clamp(
            Self.doubleValue(body["saturation"]) ?? fallback.saturation,
            min: 0.5,
            max: 2.2,
            fallback: fallback.saturation
        )
        let resolvedBrightness = Self.clamp(
            Self.doubleValue(body["brightness"]) ?? fallback.brightness,
            min: -0.3,
            max: 0.3,
            fallback: fallback.brightness
        )
        let resolvedTintAlpha = Self.clamp(
            Self.doubleValue(body["tintAlpha"]) ?? fallback.tintAlpha,
            min: 0.0,
            max: 1.0,
            fallback: fallback.tintAlpha
        )

        var resolvedTintHex = fallback.tintHex
        if let rawHex = body["tintHex"] as? String {
            resolvedTintHex = Self.normalizeHex(rawHex)
        } else if body["tintHex"] is NSNull {
            resolvedTintHex = nil
        }

        let resolvedLight: Bool
        if let scheme = body["colorScheme"] as? String {
            resolvedLight = scheme == "light"
        } else if let lightBool = body["isLight"] as? Bool {
            resolvedLight = lightBool
        } else {
            resolvedLight = fallback.isLight
        }

        self.init(
            glassIntensity: clampedIntensity,
            mode: resolvedMode,
            engine: resolvedEngine,
            blurRadius: resolvedBlur,
            saturation: resolvedSaturation,
            brightness: resolvedBrightness,
            tintHex: resolvedTintHex,
            tintAlpha: resolvedTintAlpha,
            isLight: resolvedLight
        )
    }

    static func doubleValue(_ value: Any?) -> Double? {
        if let d = value as? Double { return d.isFinite ? d : nil }
        if let n = value as? NSNumber {
            let d = n.doubleValue
            return d.isFinite ? d : nil
        }
        return nil
    }

    static func clamp(_ value: Double, min lower: Double, max upper: Double, fallback: Double) -> Double {
        guard value.isFinite else { return fallback }
        return Swift.max(lower, Swift.min(upper, value))
    }

    static func normalizeHex(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count == 7, trimmed.hasPrefix("#") else { return nil }
        let hexPart = trimmed.dropFirst()
        guard hexPart.allSatisfy({ $0.isHexDigit }) else { return nil }
        return "#" + hexPart.lowercased()
    }

    func parsedTintColor(alpha: CGFloat) -> NSColor {
        let fallbackColor = isLight ? NSColor(white: 0.96, alpha: alpha) : NSColor(white: 0.09, alpha: alpha)
        guard let hex = tintHex, let rgb = UInt32(hex.dropFirst(), radix: 16) else {
            return fallbackColor
        }
        let r = CGFloat((rgb >> 16) & 0xff) / 255.0
        let g = CGFloat((rgb >> 8) & 0xff) / 255.0
        let b = CGFloat(rgb & 0xff) / 255.0
        return NSColor(srgbRed: r, green: g, blue: b, alpha: alpha)
    }
}
