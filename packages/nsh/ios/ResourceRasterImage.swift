import Foundation

/// Decode budget for raster originals. Sampling keeps peak RGBA memory bounded for
/// huge photos (the 25 MiB byte budget alone does not bound decoded pixels).
enum ResourceRasterImagePolicy {
    static let maximumPixelSize = 4096
    /// Rough RGBA budget (~32 MiB) applied together with the per-edge cap.
    static let maximumPixelCount = 8_000_000
    /// EXIF orientations 5...8 rotate the display by 90°.
    static func display(width: Int, height: Int, orientation: Int) -> (width: Int, height: Int) {
        guard width > 0, height > 0 else { return (0, 0) }
        return (5...8).contains(orientation) ? (height, width) : (width, height)
    }
    static func maximumPixel(width: Int, height: Int) -> Int {
        guard width > 0, height > 0 else { return maximumPixelSize }
        let scale = min(1, (Double(maximumPixelCount) / (Double(width) * Double(height))).squareRoot())
        let sampled = Int((Double(max(width, height)) * scale).rounded(.down))
        return max(1, min(maximumPixelSize, sampled))
    }
}

/// Raster has no document phase: it is either still decoding or the decoded image
/// is applied. Stale completions and retirements are rejected by the shared ticket.
struct ResourceRasterImagePresentation {
    enum Phase { case stopped, loading, ready, failed, expired }
    private(set) var phase: Phase = .stopped
    private var ticket: Int?
    mutating func begin(_ generation: Int) { ticket = generation; phase = .loading }
    @discardableResult mutating func loaded(_ generation: Int) -> Bool {
        guard ticket == generation, phase == .loading else { return false }
        phase = .ready; return true
    }
    @discardableResult mutating func fail(_ generation: Int, expired: Bool = false) -> Bool {
        guard ticket == generation else { return false }
        ticket = nil; phase = expired ? .expired : .failed; return true
    }
    mutating func stop() { ticket = nil; phase = .stopped }
    mutating func expire() { ticket = nil; phase = .expired }
}

#if canImport(UIKit)
import UIKit
import ImageIO
import NativeShell

enum ResourceRasterImageFailure: Error { case invalid, decode }

struct ResourceRasterImageDecoded {
    let image: UIImage
    let width: Int
    let height: Int
}

/// Resolver for an already verified private lease. It has no Host request
/// capability and never exposes a filesystem path or original bytes to JS.
@MainActor struct ResourceRasterImageAsset {
    let url: URL
    let current: () -> Bool
    let observeRetirement: (@escaping () -> Void) -> (() -> Void)
}

@MainActor enum ResourceRasterImageFactory {
    typealias Resolve = (String, RuntimeHostScope) throws -> ResourceRasterImageAsset
    typealias Decode = @Sendable (URL) async throws -> ResourceRasterImageDecoded

    /// ImageIO read of the original private file. The thumbnail transform applies
    /// EXIF orientation; the max pixel honours both the per-edge and pixel-count budget.
    static func decode(_ url: URL) async throws -> ResourceRasterImageDecoded {
        try await Task.detached(priority: .userInitiated) {
            guard url.isFileURL else { throw ResourceRasterImageFailure.invalid }
            let sourceOptions = [kCGImageSourceShouldCache: false] as CFDictionary
            guard let source = CGImageSourceCreateWithURL(url as CFURL, sourceOptions) else { throw ResourceRasterImageFailure.decode }
            let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
            let pixelWidth = (properties?[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue ?? 0
            let pixelHeight = (properties?[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue ?? 0
            let orientation = (properties?[kCGImagePropertyOrientation] as? NSNumber)?.intValue ?? 1
            let display = ResourceRasterImagePolicy.display(width: pixelWidth, height: pixelHeight, orientation: orientation)
            let options = [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceThumbnailMaxPixelSize: ResourceRasterImagePolicy.maximumPixel(width: display.width, height: display.height),
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceShouldCacheImmediately: true,
            ] as CFDictionary
            guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options) else { throw ResourceRasterImageFailure.decode }
            try Task.checkCancellation()
            let decoded = UIImage(cgImage: image)
            let size = display.width > 0 && display.height > 0 ? display : (width: image.width, height: image.height)
            return ResourceRasterImageDecoded(image: decoded, width: size.width, height: size.height)
        }.value
    }
}

/// Contain-only raster surface. Gestures, chrome and zoom belong to the JS
/// preview owner; this view only decodes the leased original.
@MainActor final class ResourceRasterImageView: UIImageView {
    enum Event { case sized(Int, Int), loaded(Int, Int), failed(String), stopped }
    var event: ((Event) -> Void)?
    private let resolve: ResourceRasterImageFactory.Resolve
    private let decode: ResourceRasterImageFactory.Decode
    private var lifetime = ResourceImageLifetime()
    private var presentation = ResourceRasterImagePresentation()
    private var operation: Task<Void, Never>?
    private var deadline: Task<Void, Never>?
    private var unsubscribe: (() -> Void)?
    private var observers: [NSObjectProtocol] = []
    private var resourceCurrent: (() -> Bool)?

    init(decode: @escaping ResourceRasterImageFactory.Decode = { url in try await ResourceRasterImageFactory.decode(url) },
         resolve: @escaping ResourceRasterImageFactory.Resolve) {
        self.decode = decode; self.resolve = resolve; super.init(frame: .zero)
        backgroundColor = .clear
        contentMode = .scaleAspectFit
        clipsToBounds = true
        isAccessibilityElement = true
        accessibilityTraits = .image
        for name in [UIApplication.willResignActiveNotification, UIApplication.didBecomeActiveNotification] {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] notification in
                MainActor.assumeIsolated {
                    if notification.name == UIApplication.willResignActiveNotification { self?.stop() }
                    else { self?.reconcile() }
                }
            })
        }
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) unavailable") }
    deinit { operation?.cancel(); deadline?.cancel(); unsubscribe?(); for observer in observers { NotificationCenter.default.removeObserver(observer) } }
    override func didMoveToWindow() { super.didMoveToWindow(); if window == nil { stop() } else { reconcile() } }
    /// Malformed config retires the old snapshot instead of keeping a stale image.
    func update(_ value: Any?) {
        guard lifetime.update(value) else {
            if (try? ResourceImageRequest(value)) == nil { expire() }
            return
        }
        stop()
        if lifetime.request == nil { expire() } else { reconcile() }
    }
    /// Retry keeps the captured lease/Host receipt; no new Host capture or path fallback.
    func retry() {
        guard presentation.phase == .failed || presentation.phase == .expired else { return }
        guard !lifetime.retired, lifetime.request?.active == true, window != nil,
              UIApplication.shared.applicationState == .active else { expire(); return }
        clearWork(); presentation.stop(); reconcile()
    }
    func stop() { clearWork(); presentation.stop(); image = nil; event?(.stopped) }
    private func reconcile() {
        guard operation == nil, image == nil, let request = lifetime.request, request.active,
              window != nil, UIApplication.shared.applicationState == .active else { return }
        guard !lifetime.retired else { expire(); return }
        guard presentation.phase != .failed && presentation.phase != .expired else { return }
        let ticket = lifetime.generation
        presentation.begin(ticket)
        let asset: ResourceRasterImageAsset
        do { asset = try resolve(request.lease, request.expectedHost) }
        catch { expire(); return }
        guard asset.current() else { expire(); return }
        resourceCurrent = asset.current
        unsubscribe = asset.observeRetirement { [weak self] in
            guard let self, self.lifetime.request == request else { return }
            self.lifetime.retire(); self.expire()
        }
        guard !lifetime.retired, asset.current() else { expire(); return }
        deadline = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 15_000_000_000) } catch { return }
            guard !Task.isCancelled, let self, self.lifetime.accepts(ticket),
                  self.presentation.phase == .loading else { return }
            if self.current() { self.fail(ticket) } else { self.expire() }
        }
        let decode = self.decode
        operation = Task { [weak self] in
            do {
                let decoded = try await decode(asset.url)
                try Task.checkCancellation()
                guard let self, self.lifetime.accepts(ticket) else { return }
                guard self.current() else { self.expire(); return }
                self.deadline?.cancel(); self.deadline = nil
                self.operation = nil
                guard self.presentation.loaded(ticket) else { return }
                self.image = decoded.image
                self.event?(.sized(decoded.width, decoded.height))
                self.event?(.loaded(decoded.width, decoded.height))
            } catch {
                guard let self, self.lifetime.accepts(ticket) else { return }
                self.fail(ticket)
            }
        }
    }
    private func current() -> Bool {
        !lifetime.retired && lifetime.request?.active == true && resourceCurrent?() == true
            && window != nil && UIApplication.shared.applicationState == .active
    }
    private func clearWork() {
        lifetime.stop(); operation?.cancel(); operation = nil
        deadline?.cancel(); deadline = nil
        let cancel = unsubscribe; unsubscribe = nil; cancel?(); resourceCurrent = nil
    }
    private func fail(_ ticket: Int) {
        guard presentation.fail(ticket) else { return }
        clearWork(); image = nil; event?(.failed("decode"))
    }
    private func expire() {
        clearWork(); presentation.expire(); image = nil; event?(.failed("expired"))
    }
}
#endif
