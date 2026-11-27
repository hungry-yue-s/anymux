import AppKit
import ImageIO
@preconcurrency import MaterialView

/// Fullscreen Spaces have no desktop behind the window for AppKit to sample.
/// Keep a local wallpaper layer below the material in a native fullscreen Space.
@MainActor
final class PanelBackgroundView: NSView {
    static var supportsLiquidGlass: Bool {
        NSClassFromString("NSGlassEffectView") != nil
    }

    let materialView = NSVisualEffectView()
    private let materialBehindView = NSMaterialView()
    private let materialWithinView = NSMaterialView()
    private let liquidGlassView: NSView?
    private let wallpaperView = NSView()
    private let workspaceNotifications = NSWorkspace.shared.notificationCenter
    private var wallpaperScreenNumber: NSNumber?
    private var wallpaperURL: URL?
    private let wallpaperQueue = DispatchQueue(label: "com.anymux.wallpaper", qos: .utility)
    private var wallpaperRequest = 0
    private var loadingWallpaperURL: URL?
    private var loadingScreenNumber: Int?
    private var appearanceConfig = NativeAppearanceConfig.default

    private static func makeLiquidGlassView() -> NSView? {
        guard let cls = NSClassFromString("NSGlassEffectView") as? NSView.Type else { return nil }
        let view = cls.init(frame: .zero)
        let emptyContent = NSView(frame: .zero)
        emptyContent.wantsLayer = true
        emptyContent.layer?.backgroundColor = NSColor.clear.cgColor
        view.setValue(emptyContent, forKey: "contentView")
        return view
    }

    override init(frame frameRect: NSRect) {
        liquidGlassView = Self.makeLiquidGlassView()
        super.init(frame: frameRect)
        wantsLayer = true
        wallpaperView.wantsLayer = true
        wallpaperView.layer?.contentsGravity = .resizeAspectFill
        wallpaperView.layer?.masksToBounds = true
        wallpaperView.isHidden = true

        materialView.material = .underWindowBackground
        materialView.blendingMode = .behindWindow
        materialView.state = .active

        materialBehindView.isContentView = true
        materialBehindView.state = .active
        materialBehindView.rimOpacity = 0
        materialBehindView.scale = 0.5

        materialWithinView.isContentView = false
        materialWithinView.state = .active
        materialWithinView.rimOpacity = 0
        materialWithinView.scale = 0.5

        var managedViews: [NSView] = [wallpaperView, materialView, materialBehindView, materialWithinView]
        if let liquidGlassView {
            managedViews.append(liquidGlassView)
        }
        for view in managedViews {
            view.frame = bounds
            view.autoresizingMask = [.width, .height]
            addSubview(view)
        }
        updateMaterial()
    }

    required init?(coder: NSCoder) { nil }

    deinit {
        NotificationCenter.default.removeObserver(self)
        workspaceNotifications.removeObserver(self)
    }

    func applyAppearance(_ config: NativeAppearanceConfig) {
        appearanceConfig = config
        updateMaterial()
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        wallpaperRequest += 1
        loadingWallpaperURL = nil
        loadingScreenNumber = nil
        NotificationCenter.default.removeObserver(self)
        workspaceNotifications.removeObserver(self)
        guard let window else { return }
        for name in [NSWindow.willEnterFullScreenNotification, NSWindow.didEnterFullScreenNotification,
                     NSWindow.didExitFullScreenNotification, NSWindow.didChangeScreenNotification] {
            NotificationCenter.default.addObserver(self, selector: #selector(updateBackground(_:)), name: name, object: window)
        }
        NotificationCenter.default.addObserver(self, selector: #selector(updateBackground(_:)),
            name: NSApplication.didBecomeActiveNotification, object: nil)
        workspaceNotifications.addObserver(self, selector: #selector(updateBackground(_:)),
            name: NSWorkspace.activeSpaceDidChangeNotification, object: nil)
        updateBackground(nil)
    }

    @objc private func updateBackground(_ notification: Notification?) {
        guard let window, let screen = window.screen ?? NSScreen.main else { return }
        // Cache the desktop image before entering its own Space. Fullscreen may
        // report no desktop image; retain the last decoded image in that case.
        let screenNumber = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber
        let screenChanged = wallpaperScreenNumber != screenNumber
        if let url = NSWorkspace.shared.desktopImageURL(for: screen), url.isFileURL {
            if screenChanged || url != wallpaperURL || notification?.name == NSApplication.didBecomeActiveNotification {
                loadWallpaper(url, screenNumber: screenNumber?.intValue)
            }
        } else if screenChanged {
            wallpaperRequest += 1
            loadingWallpaperURL = nil
            loadingScreenNumber = nil
            wallpaperView.layer?.contents = nil
            wallpaperURL = nil
            wallpaperScreenNumber = nil
        }
        updateMaterial()
    }

    private func loadWallpaper(_ url: URL, screenNumber: Int?) {
        guard loadingWallpaperURL != url || loadingScreenNumber != screenNumber else { return }
        wallpaperRequest += 1
        let request = wallpaperRequest
        loadingWallpaperURL = url
        loadingScreenNumber = screenNumber
        // A desktop image can live on an unavailable volume. File access and
        // decoding must not block activation, input, or an application quit.
        wallpaperQueue.async { [weak self] in
            let source = CGImageSourceCreateWithURL(url as CFURL, nil)
            let image = source.flatMap {
                CGImageSourceCreateImageAtIndex($0, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary)
            }
            DispatchQueue.main.async { [weak self] in
                guard let self, self.wallpaperRequest == request else { return }
                self.loadingWallpaperURL = nil
                self.loadingScreenNumber = nil
                if let image {
                    self.wallpaperView.layer?.contents = image
                    self.wallpaperURL = url
                    self.wallpaperScreenNumber = screenNumber.map { NSNumber(value: $0) }
                } else if self.wallpaperScreenNumber?.intValue != screenNumber {
                    self.wallpaperView.layer?.contents = nil
                    self.wallpaperURL = nil
                    self.wallpaperScreenNumber = nil
                }
                self.updateMaterial()
            }
        }
    }

    private func updateMaterial() {
        let hasWallpaper = wallpaperView.layer?.contents != nil
        let isFullscreen = window?.styleMask.contains(.fullScreen) == true
        let isDesktopMode = appearanceConfig.mode == "desktop"
        let glassEnabled = isDesktopMode && appearanceConfig.engine != .off && appearanceConfig.glassIntensity > 0.01

        if let window {
            window.appearance = NSAppearance(named: appearanceConfig.isLight ? .aqua : .darkAqua)
        }

        let useFullscreenWallpaper = isDesktopMode && hasWallpaper && isFullscreen
        wallpaperView.isHidden = !useFullscreenWallpaper

        materialView.isHidden = true
        materialBehindView.isHidden = true
        materialWithinView.isHidden = true
        liquidGlassView?.isHidden = true

        guard glassEnabled else { return }

        var resolvedEngine = appearanceConfig.engine
        if (resolvedEngine == .liquidRegular || resolvedEngine == .liquidClear) && liquidGlassView == nil {
            resolvedEngine = .material
        }

        switch resolvedEngine {
        case .liquidRegular, .liquidClear:
            guard let liquidGlassView else { break }
            liquidGlassView.isHidden = false
            liquidGlassView.setValue(resolvedEngine == .liquidClear ? 1 : 0, forKey: "style")
            liquidGlassView.setValue(CGFloat(0), forKey: "cornerRadius")
            let tintAlpha = CGFloat(max(0.0, min(0.45, appearanceConfig.tintAlpha * (appearanceConfig.glassIntensity / 100.0) * 0.45)))
            let tint = tintAlpha > 0.01 ? appearanceConfig.parsedTintColor(alpha: tintAlpha) : nil
            liquidGlassView.setValue(tint, forKey: "tintColor")

        case .material:
            let activeView = useFullscreenWallpaper ? materialWithinView : materialBehindView
            activeView.isHidden = false
            let tintAlpha = CGFloat(max(0.02, min(0.5, appearanceConfig.tintAlpha * (appearanceConfig.glassIntensity / 100.0) * 0.55)))
            let bgColor = appearanceConfig.parsedTintColor(alpha: tintAlpha)
            let style = NSMaterialView.Effect.MaterialStyle(
                backgroundColor: bgColor,
                tintColor: .clear,
                saturationFactor: CGFloat(appearanceConfig.saturation),
                brightnessFactor: CGFloat(appearanceConfig.brightness),
                blurRadius: CGFloat(appearanceConfig.effectiveBlurRadius)
            )
            let effect = NSMaterialView.Effect(active: style, inactive: style)
            activeView.effect = effect

        case .system:
            materialView.isHidden = false
            materialView.material = useFullscreenWallpaper ? .titlebar : .underWindowBackground
            materialView.blendingMode = useFullscreenWallpaper ? .withinWindow : .behindWindow
            let percent = appearanceConfig.glassIntensity
            if percent >= 100 {
                materialView.maskImage = nil
            } else {
                let mask = NSImage(size: NSSize(width: 1, height: 1))
                mask.lockFocus()
                NSColor(white: 1, alpha: max(0, min(100, percent)) / 100).setFill()
                NSRect(x: 0, y: 0, width: 1, height: 1).fill()
                mask.unlockFocus()
                materialView.maskImage = mask
            }

        case .off:
            break
        }
    }
}
