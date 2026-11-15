import Foundation

@main struct RasterImageContract {
    static func main() throws {
        func require(_ value: Bool, _ message: String) { precondition(value, message) }
        let scope = RuntimeHostScope(hostID: "fixture", lease: UUID()), lease = UUID().uuidString
        func config(_ active: Any = true, _ receipt: RuntimeHostScope? = nil) -> [String: Any] {
            ["lease": lease, "expectedHost": (receipt ?? scope).publicValue, "active": active]
        }

        // The raster surface reuses the strict opaque-lease parser and fence.
        let parsed = try ResourceImageRequest(config())
        require(parsed.lease == lease && parsed.expectedHost == scope && parsed.active, "strict opaque config")
        for bad in [config(1), config("true"), ["lease": lease, "active": true],
                    ["lease": "/fake/path.png", "expectedHost": scope.publicValue, "active": true],
                    ["lease": lease, "expectedHost": scope.publicValue, "active": true, "path": "/fake.png"],
                    ["lease": lease, "expectedHost": scope.publicValue, "active": true, "original": "data:image/png;base64,YQ=="]] {
            require((try? ResourceImageRequest(bad)) == nil, "paths or original bytes cannot be admitted")
        }

        var lifetime = ResourceImageLifetime()
        require(lifetime.update(config()), "initial config")
        let ticket = lifetime.generation
        require(lifetime.accepts(ticket), "active ticket")
        require(!lifetime.update(config()), "same config is a no-op")
        lifetime.retire()
        require(!lifetime.accepts(ticket), "lease retirement rejects late decode")
        require(!lifetime.update(config()) && lifetime.retired, "identical config cannot reopen a retired lease")
        require(lifetime.update(config(false)), "explicit hide")
        require(!lifetime.accepts(lifetime.generation), "hidden cannot decode")
        require(lifetime.update(config()), "fresh active cycle")
        let resumed = lifetime.generation
        require(lifetime.accepts(resumed), "resumed cycle accepts a fresh decode")
        lifetime.stop()
        require(!lifetime.accepts(resumed), "unmount/background rejects preparation")

        // EXIF orientation is part of the intrinsic size reported to JS.
        let rotated = ResourceRasterImagePolicy.display(width: 4000, height: 3000, orientation: 6)
        require(rotated.width == 3000 && rotated.height == 4000, "90° EXIF swaps display size")
        for orientation in [1, 2, 3, 4] {
            let upright = ResourceRasterImagePolicy.display(width: 4000, height: 3000, orientation: orientation)
            require(upright.width == 4000 && upright.height == 3000, "non-90° orientation keeps size")
        }
        require(ResourceRasterImagePolicy.display(width: 0, height: 0, orientation: 6) == (0, 0), "unknown bounds stay unknown")

        // Decode budget: per-edge cap, then a pixel-count cap for extreme aspect ratios.
        require(ResourceRasterImagePolicy.maximumPixel(width: 0, height: 0) == 4096, "bounded default")
        require(ResourceRasterImagePolicy.maximumPixel(width: 8000, height: 1000) == 4096, "edge cap")
        require(ResourceRasterImagePolicy.maximumPixel(width: 3000, height: 2000) == 3000, "no upscale under budget")
        let square = ResourceRasterImagePolicy.maximumPixel(width: 12000, height: 12000)
        require(square <= 4096 && square > 0, "huge square stays bounded per edge")
        require(square * square <= ResourceRasterImagePolicy.maximumPixelCount, "huge square also honours the pixel budget")
        let panorama = ResourceRasterImagePolicy.maximumPixel(width: 20000, height: 100)
        require(panorama == 4096, "panorama keeps the longest useful edge")
        let sampledHeight = max(1, Int((100.0 * Double(panorama) / 20000.0).rounded()))
        require(panorama * sampledHeight <= ResourceRasterImagePolicy.maximumPixelCount, "panorama stays inside budget")

        var presentation = ResourceRasterImagePresentation()
        presentation.begin(10)
        require(presentation.phase == .loading, "decode has a loading phase")
        require(!presentation.loaded(9), "stale completion cannot become ready")
        require(presentation.loaded(10) && presentation.phase == .ready, "current decode becomes ready")
        require(!presentation.loaded(10), "one decode reports ready once")
        presentation.begin(11)
        require(presentation.fail(11) && presentation.phase == .failed, "decode failure is explicit")
        require(!presentation.loaded(11), "late success cannot replace a failure")
        presentation.expire()
        require(presentation.phase == .expired, "retired lease has an explicit expired state")
        require(!presentation.fail(11) && !presentation.loaded(11), "retired tickets stay rejected")
        presentation.stop()
        require(presentation.phase == .stopped, "hidden/disposed clears the transient presentation")
        require(!presentation.fail(99), "stopped presentation ignores foreign tickets")

        print("Raster image Foundation lifetime/budget contract passed")
    }
}
