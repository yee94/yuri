import Foundation
import UIKit
import WebKit
import Network
import CryptoKit

/// Synthetic in-memory bytes only. No RuntimeBridge, credentials or Host exists.
@MainActor struct ResourceTransport {
    let read: (String, Int) async throws -> (status: Int, mime: String, data: Data)
    let isCurrent: () -> Bool
}

@main @MainActor final class SVGFixtureApp: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = SVGFixtureController(); window.makeKeyAndVisible(); self.window = window; return true
    }
}

@MainActor private final class SVGFixtureController: UIViewController {
    private let label = UILabel()
    private var bridge: ResourceBridge?
    private var image: ResourceSVGImageView?
    private var listeners: [NWListener] = []
    private var connections = 0, statReads = 0, serveReads = 0, contactReads = 0
    private struct ProbeRead { let connection: NWConnection; var bytes = Data(); var deadline: Task<Void, Never>? }
    private var probeReads: [Int: ProbeRead] = [:]
    private var probeRecords: [[String: Any]] = [], probeSnapshots: [[String: Any]] = []
    private var probePhase = "setup"
    private var current = true, started = false
    private var result: [String: Any] = ["runtimeExecuted": true, "syntheticOnly": true]
    private let expected = RuntimeHostScope(hostID: "synthetic-svg", lease: UUID())
    override func viewDidLoad() {
        super.viewDidLoad(); view.backgroundColor = .systemBackground
        label.numberOfLines = 0; label.text = "WK SVG image fixture — running"; view.addSubview(label)
    }
    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews(); label.frame = CGRect(x: 20, y: view.safeAreaInsets.top + 10, width: view.bounds.width - 40, height: 180)
        image?.frame = CGRect(x: 20, y: view.safeAreaInsets.top + 200, width: 320, height: 192)
    }
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated); guard !started else { return }; started = true
        Task {
            var passed = false
            do { try await run(); passed = true } catch { result["failure"] = String(describing: error) }
            // Preserve a published red result even when a peer cancels before
            // sending HTTP. Give bounded pending request-line captures time to settle.
            for _ in 0..<8 {
                do { try await sleep(0.1) } catch { break }
                if probeReads.isEmpty { break }
            }
            if connections != 0 { passed = false; result["externalNavigationAndSubresourceConnectionsZero"] = false }
            finish(passed)
        }
    }
    private func require(_ condition: Bool, _ name: String) throws {
        result[name] = condition; if !condition { throw NSError(domain: "SVGFixture", code: 1, userInfo: [NSLocalizedDescriptionKey: name]) }
    }
    private func finish(_ passed: Bool) {
        for number in Array(probeReads.keys) { endProbe(number, reason: "fixture-finished") }
        result["passed"] = passed; result["externalConnections"] = connections
        result["probeConnections"] = probeRecords; result["probePhaseSnapshots"] = probeSnapshots
        result["probeCaptureTruncated"] = connections > 32
        result["statReads"] = statReads; result["serveReads"] = serveReads; result["contactReads"] = contactReads
        label.text = passed ? "PASS — SVG CSS / style / SMIL / filter / embedded image; script/navigation/network blocked; leases retired" : "FAIL — see svg-image-result.json"
        label.textColor = passed ? .systemGreen : .systemRed
        if let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first,
           let data = try? JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: documents.appendingPathComponent("svg-image-result.json"), options: .atomic)
        }
        for read in probeReads.values { read.deadline?.cancel(); read.connection.cancel() }; probeReads.removeAll()
        for listener in listeners { listener.cancel() }; bridge?.invalidate()
    }
    private func sleep(_ seconds: Double) async throws { try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000)) }
    /// Count real loopback connection attempts; never connect to an external service.
    private func startProbe(_ channel: String) async throws -> UInt16 {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        let listener = try NWListener(using: parameters); listeners.append(listener)
        listener.newConnectionHandler = { [weak self] connection in
            MainActor.assumeIsolated { self?.acceptProbe(connection, channel: channel) }
        }
        return try await withCheckedThrowingContinuation { continuation in
            var completed = false
            listener.stateUpdateHandler = { state in
                guard !completed else { return }
                if case .ready = state, let port = listener.port { completed = true; continuation.resume(returning: port.rawValue) }
                else if case .failed(let error) = state { completed = true; continuation.resume(throwing: error) }
            }
            listener.start(queue: .main)
        }
    }
    private func markProbePhase(_ phase: String) {
        probePhase = phase
        if probeSnapshots.count < 16 { probeSnapshots.append(["phase": phase, "connections": connections]) }
    }
    private func acceptProbe(_ connection: NWConnection, channel: String) {
        connections += 1 // Every TCP accept counts, including an empty preconnect.
        let number = connections
        guard probeRecords.count < 32 else { connection.start(queue: .main); connection.cancel(); return }
        probeRecords.append(["connection": number, "listener": channel, "acceptedPhase": probePhase,
            "method": "none", "path": "none", "kind": "no-http-request-line", "end": "pending"])
        probeReads[number] = ProbeRead(connection: connection)
        connection.start(queue: .main)
        probeReads[number]?.deadline = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 500_000_000) } catch { return }
            guard !Task.isCancelled else { return }
            self?.endProbe(number, reason: "deadline")
        }
        readProbe(number)
    }
    private func readProbe(_ number: Int) {
        guard let pending = probeReads[number] else { return }
        pending.connection.receive(minimumIncompleteLength: 1, maximumLength: SVGFixtureProbeRequest.byteLimit - pending.bytes.count) { [weak self] bytes, _, complete, error in
            MainActor.assumeIsolated {
                guard let self, var pending = self.probeReads[number] else { return }
                if let bytes { pending.bytes.append(bytes.prefix(SVGFixtureProbeRequest.byteLimit - pending.bytes.count)) }
                self.probeReads[number] = pending
                if let request = SVGFixtureProbeRequest.classify(pending.bytes) { self.endProbe(number, reason: "request-line", request: request) }
                else if complete || error != nil { self.endProbe(number, reason: complete ? "peer-closed" : "receive-error") }
                else if pending.bytes.count >= SVGFixtureProbeRequest.byteLimit { self.endProbe(number, reason: "read-limit") }
                else { self.readProbe(number) }
            }
        }
    }
    private func endProbe(_ number: Int, reason: String, request: [String: String]? = nil) {
        guard let pending = probeReads.removeValue(forKey: number) else { return }
        pending.deadline?.cancel()
        if let index = probeRecords.firstIndex(where: { $0["connection"] as? Int == number }) {
            if let request { for (key, value) in request { probeRecords[index][key] = value } }
            probeRecords[index]["end"] = reason; probeRecords[index]["capturedPhase"] = probePhase
        }
        pending.connection.cancel()
    }
    private func svg(_ probe: String) -> Data {
        let png = UIGraphicsImageRenderer(size: CGSize(width: 60, height: 60)).pngData { context in
            UIColor.yellow.setFill(); context.fill(CGRect(x: 0, y: 0, width: 60, height: 60))
        }.base64EncodedString()
        let nestedDataSVG = Data("""
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="120" onload="document.querySelector('.nested').setAttribute('style','fill:red');fetch('\(probe)/nested-event');top.location='\(probe)/nested-top'">
        <style>@import url('\(probe)/nested-css');@font-face{font-family:Probe;src:url('\(probe)/nested-font')} .nested{fill:cyan}.fontProbe{font-family:Probe}</style>
        <rect class="nested" width="20" height="120"/>
        <script>document.querySelector('.nested').setAttribute('style','fill:red');fetch('\(probe)/nested-script');top.location='\(probe)/nested-script-top'</script>
        <image x="19" y="119" width="1" height="1" href="\(probe)/nested-image"/>
        <text class="fontProbe" x="0" y="119" font-size="1">X</text>
        </svg>
        """.utf8).base64EncodedString()
        return Data("""
        <svg xmlns="http://www.w3.org/2000/svg" width="200" height="120" viewBox="0 0 200 120">
        <style>.css{fill:rgb(0,180,0)} @keyframes shift{from{fill:rgb(0,255,0)}to{fill:rgb(255,0,255)}} .cssAnimation{animation:shift 1.7s infinite alternate linear}</style>
        <defs><filter id="blue"><feFlood flood-color="rgb(0,0,220)"/><feComposite in2="SourceGraphic" operator="in"/></filter></defs>
        <rect class="css" width="60" height="60"/>
        <rect x="60" width="60" height="60" style="fill:rgb(0,0,220)"/>
        <rect x="120" width="60" height="60" fill="red" filter="url(#blue)"/>
        <image x="0" y="60" width="60" height="60" href="data:image/png;base64,\(png)"/>
        <rect x="60" y="60" width="60" height="60" fill="red"><animate attributeName="fill" values="red;blue;red" dur="2s" repeatCount="indefinite"/></rect>
        <rect class="cssAnimation" x="120" y="60" width="60" height="60"/>
        <image x="180" width="20" height="120" href="data:image/svg+xml;base64,\(nestedDataSVG)"/>
        <script>document.querySelector('style').textContent='.css{fill:red}';window.top.location='\(probe)/top';fetch('\(probe)/script')</script>
        <image x="190" width="1" height="1" href="\(probe)/image"/>
        <style>@import url('\(probe)/css');</style>
        <rect x="198" width="1" height="1" onload="window.top.location='\(probe)/event'"/>
        </svg>
        """.utf8)
    }
    private func mount(_ lease: String, prepare: ResourceSVGImageView.Prepare? = nil) -> ResourceSVGImageView {
        image?.stop(); image?.removeFromSuperview()
        let image = ResourceSVGImageView(prepare: prepare) { [weak self] key, expected in
            guard let bridge = self?.bridge else { throw CancellationError() }
            let asset = try bridge.svgAsset(key, expectedHost: expected)
            return ResourceSVGImageAsset(url: asset.url, current: asset.current, observeRetirement: asset.observe)
        }
        self.image = image
        image.update(["lease": lease, "expectedHost": expected.publicValue, "active": true])
        view.addSubview(image); view.setNeedsLayout(); view.layoutIfNeeded(); return image
    }
    private func decoded(_ image: ResourceSVGImageView) async throws -> WKWebView {
        for _ in 0..<80 {
            if let web = image.webView {
                let ready = try? await web.callAsyncJavaScript("return document.getElementById('image')?.complete && document.getElementById('image')?.naturalWidth > 0", arguments: [:], in: nil, contentWorld: .defaultClient)
                if ready as? Bool == true && image.presentation.phase == .ready { return web }
            }
            try await sleep(0.1)
        }
        throw NSError(domain: "SVGFixture", code: 2, userInfo: [NSLocalizedDescriptionKey: "real WK image decode timed out"])
    }
    private func pixels(_ web: WKWebView) async throws -> [[Int]] {
        let value = try await web.callAsyncJavaScript("""
        const img=document.getElementById('image'); await img.decode();
        const c=document.createElement('canvas'); c.width=200;c.height=120;
        const x=c.getContext('2d');x.drawImage(img,0,0,200,120);
        return [[30,30],[90,30],[150,30],[30,90],[90,90],[150,90],[190,30]].map(([a,b])=>Array.from(x.getImageData(a,b,1,1).data));
        """, arguments: [:], in: nil, contentWorld: .defaultClient)
        guard let pixels = value as? [[Int]], pixels.count == 7 else { throw ResourceWebPreviewFailure.response }; return pixels
    }
    private func wait(_ phase: ResourceSVGImagePresentation.Phase, image: ResourceSVGImageView) async throws {
        for _ in 0..<120 {
            if image.presentation.phase == phase { return }
            try await sleep(0.1)
        }
        throw NSError(domain: "SVGFixture", code: 3, userInfo: [NSLocalizedDescriptionKey: "expected visible image state did not arrive"])
    }
    private func feedback(_ image: ResourceSVGImageView) -> Bool {
        let elements = image.accessibilityElements ?? []
        let label = elements.compactMap { $0 as? UILabel }.first
        let retry = elements.compactMap { $0 as? UIButton }.first
        return label?.text?.isEmpty == false && label?.superview?.isHidden == false
            && retry?.isHidden == false && retry?.isEnabled == true && retry?.configuration?.title?.isEmpty == false
    }
    private func verifyFailures(lease: String, bytes: Data) async throws {
        guard let bridge else { throw CancellationError() }
        let body = try await bridge.startRead(["path": "/fixture/invalid.svg", "requestId": "invalid-read", "expectedHost": expected.publicValue]) as? [String: Any]
        guard let invalidLease = body?["lease"] as? String else { throw ResourceWebPreviewFailure.response }
        let invalidAsset = try bridge.svgAsset(invalidLease, expectedHost: expected)
        let reads = [statReads, serveReads, contactReads]
        let invalid = mount(invalidLease)
        var wrapperCount = 0, reportedReadyAtWrapper = false, loadedCount = 0
        invalid.event = { [weak invalid] event in
            if case .wrapperLoaded = event { wrapperCount += 1; reportedReadyAtWrapper = invalid?.presentation.phase == .ready }
            if case .loaded = event { loadedCount += 1 }
        }
        try await wait(.failed, image: invalid)
        try require(feedback(invalid) && invalid.webView == nil, "invalidSVGShowsAccessibleFailure")
        try require(wrapperCount > 0 && !reportedReadyAtWrapper && loadedCount == 0, "wrapperLoadedNeverMeansImageDecoded")
        invalid.retry(); try await wait(.failed, image: invalid)
        try require(feedback(invalid) && [statReads, serveReads, contactReads] == reads, "invalidSVGRetryOnlyUsesLocalLease")
        try require(try Data(contentsOf: invalidAsset.url) == Data("<svg".utf8), "invalidSVGOriginalRetainedForSaveShare")

        let fullscreen = try ResourceSVGImageFactory.controller(lease: invalidLease, expectedHost: expected, resolve: { [weak bridge] key, scope in
            guard let bridge else { throw CancellationError() }
            let asset = try bridge.svgAsset(key, expectedHost: scope)
            return ResourceSVGImageAsset(url: asset.url, current: asset.current, observeRetirement: asset.observe)
        })
        await withCheckedContinuation { continuation in present(fullscreen, animated: false) { continuation.resume() } }
        guard let fullImage = fullscreen.view as? ResourceSVGImageView else { throw ResourceWebPreviewFailure.response }
        try await wait(.failed, image: fullImage)
        try require(feedback(fullImage), "fullscreenConsumesSameAccessibleFailureAndRetry")
        fullImage.retry(); try await wait(.failed, image: fullImage)
        await withCheckedContinuation { continuation in fullscreen.dismiss(animated: false) { continuation.resume() } }

        var attempts = 0
        let preparing = mount(lease, prepare: { url in
            attempts += 1
            if attempts == 1 { throw ResourceWebPreviewFailure.response }
            return try await ResourceSVGImageView.prepareDocument(url)
        })
        try require(preparing.presentation.phase == .loading && (preparing.accessibilityElements?.first as? UILabel)?.text?.isEmpty == false, "preparationHasVisibleAccessibleLoading")
        try await wait(.failed, image: preparing)
        try require(feedback(preparing), "preparationFailureShowsRetry")
        preparing.retry(); let ready = try await decoded(preparing)
        try require(attempts == 2 && preparing.presentation.phase == .ready, "preparationRetryDecodesOriginalLocalLease")
        preparing.webViewWebContentProcessDidTerminate(ready)
        try require(preparing.presentation.phase == .failed && feedback(preparing) && preparing.webView == nil, "processTerminationCallbackShowsFailure")
        preparing.retry(); _ = try await decoded(preparing)
        try require([statReads, serveReads, contactReads] == reads, "processRetryDoesNotReadHost")
        let original = try bridge.svgAsset(lease, expectedHost: expected)
        try require(try Data(contentsOf: original.url) == bytes, "previewFailuresPreserveOriginalSaveShareBytes")

        let expiring = mount(invalidLease); try await wait(.failed, image: expiring)
        bridge.release(invalidLease)
        try require(expiring.presentation.phase == .expired && feedback(expiring), "failedThenInvalidatedLeaseShowsExpired")
        expiring.retry()
        try require(expiring.presentation.phase == .expired && feedback(expiring) && expiring.webView == nil, "expiredRetryRemainsExplicitFailure")
        try require([statReads, serveReads, contactReads] == reads && connections == 0, "allFailureRetriesHaveZeroHostReadsAndExternalConnections")
    }
    private func run() async throws {
        let port = try await startProbe("svg-subresources"), navigationPort = try await startProbe("native-navigation")
        let probe = "http://127.0.0.1:\(port)", navigationProbe = "http://127.0.0.1:\(navigationPort)", bytes = svg(probe)
        markProbePhase("svg-preparing")
        bridge = try ResourceBridge(controller: self, capture: { [weak self] expected in
            guard let self, expected == self.expected, self.current else { throw RuntimeHostScopeFailure.stale }
            return ResourceTransport(read: { [weak self] route, limit in
                guard let self, self.current else { throw CancellationError() }
                if route.hasPrefix("/api/fs/stat?") {
                    self.statReads += 1
                    let size = route.contains("invalid.svg") ? Data("<svg".utf8).count : bytes.count
                    let stat = try JSONSerialization.data(withJSONObject: ["isFile": true, "size": size, "mtimeMs": 1, "isBinary": false])
                    return (200, "application/json", stat)
                }
                if ["/api/fs/serve/fixture/drawing.svg", "/api/fs/serve/fixture/invalid.svg"].contains(route) { self.serveReads += 1 }
                else if route == "/api/yuri/assistants/assistant/contact/attachments/fixture-svg" { self.contactReads += 1 }
                else { throw ResourceWebPreviewFailure.invalid }
                guard bytes.count <= limit else { throw ResourceWebPreviewFailure.limit }
                return (200, "image/svg+xml", route.hasSuffix("invalid.svg") ? Data("<svg".utf8) : bytes)
            }, isCurrent: { [weak self] in self?.current == true })
        })
        guard let bridge else { throw CancellationError() }
        let body = try await bridge.startRead(["path": "/fixture/drawing.svg", "requestId": "fixture-read", "expectedHost": expected.publicValue]) as? [String: Any]
        guard let lease = body?["lease"] as? String else { throw ResourceWebPreviewFailure.response }
        try require(body?["thumbnail"] == nil && body?["text"] == nil && body?["preview"] as? String == "svg-image", "opaqueLeaseOnly")
        let asset = try bridge.svgAsset(lease, expectedHost: expected)
        try require(try Data(contentsOf: asset.url) == bytes, "exactOriginalBytes")
        let image = mount(lease), web = try await decoded(image)
        markProbePhase("svg-decoded")
        try require(!web.configuration.defaultWebpagePreferences.allowsContentJavaScript && !web.configuration.websiteDataStore.isPersistent && web.configuration.userContentController.userScripts.isEmpty, "isolatedConfiguration")
        try require(!web.isHidden && web.isAccessibilityElement && web.accessibilityLabel?.isEmpty == false, "decodedImageHasAccessibleLabel")
        let a = try await pixels(web); try await sleep(0.65); let b = try await pixels(web)
        result["pixelsFirst"] = a; result["pixelsLater"] = b
        try require(a[0][1] > 150 && a[0][0] < 30, "cssClassAndScriptInert")
        try require(a[1][2] > 180 && a[1][0] < 30, "styleAttribute")
        try require(a[2][2] > 180 && a[2][0] < 30, "filterRendered")
        try require(a[3][0] > 220 && a[3][1] > 220 && a[3][2] < 30, "embeddedDataImage")
        try require(a[4] != b[4], "smilAnimated")
        try require(a[5] != b[5], "cssAnimated")
        try require(a[6][0] < 30 && a[6][1] > 220 && a[6][2] > 220, "nestedDataSVGRenderedWithScriptAndEventInert")
        try require(web.url?.absoluteString == "about:blank", "svgNotTopLevelAndScriptNavigationInert")
        markProbePhase("pixels-verified")
        result["connectionsBeforeNativeNavigation"] = connections
        var blocked = 0, nativeBlocked = 0, delegateBlocked = 0
        image.event = {
            if case .navigationBlocked = $0 { blocked += 1 }
            if case .nativeLoadBlocked = $0 { nativeBlocked += 1 }
            if case .delegateNavigationBlocked = $0 { delegateBlocked += 1 }
        }
        markProbePhase("native-navigation")
        let nativeBase: WKWebView = web
        let navigation = nativeBase.load(URLRequest(url: URL(string: navigationProbe + "/native-navigation-probe")!))
        let rejectedBeforeWebKit = navigation == nil && nativeBlocked == 1 && delegateBlocked == 0
        try await sleep(0.3)
        markProbePhase("native-navigation-finished")
        result["nativeNavigationBlocked"] = blocked > 0
        result["nativeLoadGuardEvents"] = nativeBlocked; result["delegateBlockedEventsForNativeProbe"] = delegateBlocked
        try require(rejectedBeforeWebKit, "nativeRequestRejectedBeforeWebKitThroughBaseType")
        try require(image.presentation.phase == .ready && web.url?.absoluteString == "about:blank", "nativeLoadGuardPreservesDecodedWrapper")
        try require(blocked > 0 && connections == 0, "externalNavigationAndSubresourceConnectionsZero")
        markProbePhase("failure-cases")
        try await verifyFailures(lease: lease, bytes: bytes)
        let closingImage = mount(lease), closingWeb = try await decoded(closingImage)
        bridge.close(lease)
        try require(closingImage.webView == nil && closingWeb.superview == nil, "leaseCloseStopsOldView")
        try require(try Data(contentsOf: asset.url) == bytes, "closeRetainsOriginalForSaveShare")
        bridge.release(lease); try require(!asset.current() && !FileManager.default.fileExists(atPath: asset.url.path), "leaseReleaseRetiresOriginal")
        let digest = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        let contact = try await bridge.startRead(["source": ["kind": "contact", "assistantID": "assistant", "descriptor": ["type": "file", "attachmentID": "fixture-svg", "sha256": digest, "size": bytes.count, "mime": "image/svg+xml", "filename": "drawing.svg"]], "requestId": "contact-read", "expectedHost": expected.publicValue]) as? [String: Any]
        guard let contactLease = contact?["lease"] as? String else { throw ResourceWebPreviewFailure.response }
        try require(statReads == 2 && serveReads == 2 && contactReads == 1, "contactUsesDescriptorNotFSPath")
        let pendingImage = mount(contactLease)
        bridge.close(contactLease); try await sleep(0.6)
        try require(pendingImage.webView == nil, "closeDuringPreparationRejectsLateWK")
        pendingImage.update(["lease": contactLease, "expectedHost": expected.publicValue, "active": false])
        current = false; bridge.invalidate(); try await sleep(0.1)
        try require(pendingImage.webView == nil && connections == 0, "invalidateLeavesNoViewOrNetwork")
    }
}
