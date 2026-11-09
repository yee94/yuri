import Foundation

@main struct SVGImageContract {
    static func main() throws {
        func require(_ value: Bool, _ message: String) { precondition(value, message) }
        let scope = RuntimeHostScope(hostID: "fixture", lease: UUID()), lease = UUID().uuidString
        func config(_ active: Any = true, _ receipt: RuntimeHostScope? = nil) -> [String: Any] {
            ["lease": lease, "expectedHost": (receipt ?? scope).publicValue, "active": active]
        }
        var lifetime = ResourceSVGImageLifetime()
        require(lifetime.update(config()), "initial config")
        let ticket = lifetime.generation
        require(lifetime.accepts(ticket), "active ticket")
        require(!lifetime.update(config()), "same config is a no-op")
        lifetime.retire(); require(!lifetime.accepts(ticket), "lease close rejects late rules/decode")
        require(!lifetime.update(config()) && lifetime.retired, "late identical config cannot reopen closed view")
        require(lifetime.update(config(false)), "explicit hide")
        require(!lifetime.accepts(lifetime.generation), "hidden cannot prepare")
        require(lifetime.update(config()), "explicit new active cycle")
        let resumed = lifetime.generation
        require(lifetime.accepts(resumed), "fresh active cycle can resolve original lease again")
        lifetime.stop(); require(!lifetime.accepts(resumed), "unmount/background rejects preparation")
        let replacement = RuntimeHostScope(hostID: "fixture", lease: UUID())
        require(lifetime.update(config(true, replacement)), "new native receipt")
        require(lifetime.request?.expectedHost == replacement && !lifetime.accepts(resumed), "scope never borrowed by old ticket")
        require(lifetime.update(["lease": "/fake/path.svg", "expectedHost": scope.publicValue, "active": true]), "invalid config retires old snapshot")
        require(lifetime.request == nil, "paths cannot be leases")
        for bad in [config(1), ["lease": lease, "active": true], ["lease": lease, "expectedHost": scope.publicValue, "active": true, "path": "/fake.svg"]] {
            require((try? ResourceSVGImageRequest(bad)) == nil, "strict config admission")
        }
        let svg = Data("""
        <svg xmlns="http://www.w3.org/2000/svg"><style>.a{fill:red;animation:x 2s infinite}@keyframes x{to{fill:blue}}</style><defs><filter id="f"><feGaussianBlur stdDeviation="1"/></filter></defs><rect class="a" style="filter:url(#f)"><animate attributeName="x" values="0;2" dur="1s"/></rect><image href="data:image/png;base64,YQ=="/><script>top.location='https://external.invalid'</script></svg>
        """.utf8)
        let wrapper = try ResourceSVGImageDocument.wrapper(svg)
        let prefix = "src=\"data:image/svg+xml;base64,"
        let encoded = wrapper.components(separatedBy: prefix)[1].components(separatedBy: "\"")[0]
        require(Data(base64Encoded: encoded) == svg, "complete byte-for-byte SVG; no CSS/filter/SMIL/data whitelist")
        require(!wrapper.contains("<svg") && !wrapper.contains("<script>"), "source is never wrapper markup or top-level SVG")
        require(wrapper.contains("<img id=\"image\"") && wrapper.contains("default-src 'none'") && wrapper.contains("script-src 'none'"), "fixed image context and CSP")
        require((try? ResourceSVGImageDocument.wrapper(Data(repeating: 0, count: ResourceSVGImageDocument.byteLimit + 1))) == nil, "bounded local bytes")
        var presentation = ResourceSVGImagePresentation()
        presentation.begin(10)
        require(presentation.phase == .loading, "preparation has visible loading")
        require(presentation.wrapperFinished(10) && presentation.phase == .decoding, "wrapper finish is not image decoded")
        require(!presentation.decoded(9, success: true) && presentation.phase == .decoding, "stale image callback cannot report ready")
        require(presentation.decoded(10, success: false) && presentation.phase == .failed, "invalid SVG image decode shows failure")
        presentation.begin(11); require(presentation.fail(11) && presentation.phase == .failed, "rule/local-read preparation failure is visible")
        presentation.begin(12); require(presentation.wrapperFinished(12) && presentation.decoded(12, success: true) && presentation.phase == .ready, "only successful actual decode becomes ready")
        require(presentation.fail(12) && presentation.phase == .failed, "process/navigation failure replaces ready image with error")
        presentation.expire(); require(presentation.phase == .expired, "failed lease invalidation has explicit expired state")
        require(!presentation.decoded(12, success: true) && !presentation.wrapperFinished(12), "late callbacks cannot hide expired error")
        presentation.stop(); require(presentation.phase == .stopped, "hidden/disposed clears transient presentation")
        require(!presentation.fail(12), "retired callback cannot resurrect error after unmount")
        let english = ResourceSVGImageCopy.localized("en")
        for locale in ["zh-CN", "zh-TW", "ja", "ko", "fr", "es", "pl", "pt-BR", "uk"] {
            let copy = ResourceSVGImageCopy.localized(locale)
            require(copy.loading != english.loading && copy.failed != english.failed && copy.expired != english.expired && copy.retry != english.retry, "real native feedback translations")
        }
        require(ResourceSVGImageDecodeProbe.script.contains("await image.decode()") && !ResourceSVGImageDecodeProbe.script.contains("getSVGDocument"), "fixed wrapper probe never enters SVG DOM")
        require((try? ResourceSVGImageDocument.load(URL(fileURLWithPath: "/nonexistent-fixture-parent/opaque.svg"))) == nil, "local read failure stays a failure")
        require(SVGFixtureProbeRequest.classify(Data("GET /nested-fo".utf8)) == nil, "fragmented request line waits for its delimiter")
        require(SVGFixtureProbeRequest.classify(Data("GET /nested-font HTTP/1.1\r\nAuthorization: never-retain\r\n\r\n".utf8)) == ["method": "GET", "path": "/nested-font", "kind": "nested-font"], "only the synthetic method/path classification survives")
        require(SVGFixtureProbeRequest.classify(Data("GET /native-navigation-probe HTTP/1.1\r\n".utf8))?["kind"] == "native-navigation", "navigation probe identified without interpreting headers")
        let unknown = SVGFixtureProbeRequest.classify(Data("POST /unknown?token=never-retain HTTP/1.1\r\n".utf8))
        require(unknown == ["method": "POST", "path": "unknown", "kind": "unknown"], "unknown path/query never retained")
        require(SVGFixtureProbeRequest.classify(Data(repeating: 65, count: SVGFixtureProbeRequest.byteLimit + 1)) == nil, "request-line read stays bounded")
        print("SVG image Foundation lifetime/document contract passed")
    }
}
