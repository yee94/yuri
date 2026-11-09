import UIKit
import NativeShell

@MainActor private final class FeedbackFixtureController: UIViewController {
    private let surface = NshAppView()
    private var failed = true
    private var reads = 0
    private var sequence = 0
    private var timer: Timer?
    private var previousPhase = "before"
    private var backCount = 0
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        title = "通知 UIKit 验收"
        navigationItem.leftBarButtonItem = UIBarButtonItem(title: "返回", style: .plain, target: self, action: #selector(backPressed))
        surface.frame = view.bounds; surface.autoresizingMask = [.flexibleWidth, .flexibleHeight]; view.addSubview(surface)
        do {
            guard let bundle = Bundle.main.url(forResource: "bundle", withExtension: "nshc", subdirectory: "nsh"),
                  let grants = Bundle.main.url(forResource: "grants", withExtension: "json") else { throw failure("missing_fixture_resource") }
            try surface.grantCapabilities(String(decoding: Data(contentsOf: grants), as: UTF8.self))
            FeedbackLayoutBridge.install(on: surface)
            surface.handle("connection.list") { _ async throws -> Any? in
                ["selected": "feedback-fixture", "connections": [["id": "feedback-fixture", "url": "https://fixture.example", "authorizationID": "synthetic", "lastUsedAt": 0]], "runtimeScope": ["hostID": "feedback-fixture", "lease": "lease-1"]]
            }
            surface.handle("feedback.fixture.read") { [weak self] input async throws -> Any? in
                guard let self, let fields = input as? [String: Any], fields.count == 1,
                      let scope = fields["expectedHost"] as? [String: String], scope == ["hostID": "feedback-fixture", "lease": "lease-1"] else { throw NSError(domain: "fixture_scope_rejected", code: 1) }
                self.reads += 1
                guard !self.failed else {
                    // Deliberately matches the screenshot's untrusted diagnostic length.
                    throw self.failure("nsh/host: 'connection.list' not granted: add it to capabilities.host in nsh.json. /host/private/path token=fixture-secret synthetic internal stack trace")
                }
                self.capture("read-recovered", metadata: [:]); return ["ready": true]
            }
            surface.handle("feedback.fixture.recover") { [weak self] _ async throws -> Any? in self?.failed = false; return ["enabled": true] }
            surface.handle("appearance.fonts.retry") { input async throws -> Any? in
                guard let fields = input as? [String: Any], fields.count == 3, fields["hostID"] as? String == "feedback-fixture", fields["fontRevision"] as? Int == 1,
                      let ticket = fields["fontTicket"] as? Int, ticket >= 1 else { throw NSError(domain: "fixture_font_retry_rejected", code: 1) }
                return ["hostID": "feedback-fixture", "fontRevision": 1, "fontTicket": ticket + 1, "fontStatus": "unsupported", "uiFontFamily": "system-ui", "monoFontFamily": "monospace", "assistantFontFamilies": ["light": "system-ui", "dark": "system-ui"], "unsupportedFonts": ["Synthetic font"]]
            }
            surface.handle("feedback.fixture.capture") { [weak self] input async throws -> Any? in
                guard let self, let metadata = input as? [String: Any], let phase = metadata["phase"] as? String else { throw NSError(domain: "fixture_input_rejected", code: 1) }
                self.previousPhase = phase
                try await Task.sleep(nanoseconds: 150_000_000)
                self.capture(phase, metadata: metadata); return ["captured": true]
            }
            surface.cacheOptions = NshCacheOptions(location: .off, images: .off)
            try surface.loadBundle(at: bundle)
            timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.capture("periodic", metadata: [:]) }
            }
        } catch { surface.accessibilityIdentifier = "feedback-fixture-engine-failed" }
    }
    private func failure(_ message: String) -> NSError { NSError(domain: "SyntheticFeedback", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
    @objc private func backPressed() { backCount += 1; capture("native-back", metadata: ["nativeBack": backCount]) }
    private func capture(_ phase: String, metadata: [String: Any]) {
        guard isViewLoaded, view.window != nil else { return }
        let names = Set(["native-feedback-layer", "root-error-feedback", "root-error-feedback-message", "root-error-feedback-close", "root-error-feedback-retry", "appearance-feedback", "appearance-feedback-message", "appearance-feedback-close", "appearance-feedback-retry", "feedback-back", "feedback-body", "feedback-body-first", "feedback-bottom-tab"])
        var frames: [String: [[String: Any]]] = [:]
        var leaked = false
        func scan(_ node: UIView) {
            if let text = (node as? UILabel)?.text, ["nsh/host:", "fixture-secret", "/host/private", "stack trace"].contains(where: text.contains) { leaked = true }
            if let text = node.accessibilityLabel, ["nsh/host:", "fixture-secret", "/host/private", "stack trace"].contains(where: text.contains) { leaked = true }
            if let id = node.accessibilityIdentifier, names.contains(id), !node.isHidden, node.alpha > 0 {
                let frame = node.convert(node.bounds, to: view)
                var entry: [String: Any] = ["x": frame.minX, "y": frame.minY, "width": frame.width, "height": frame.height, "interactive": node.isUserInteractionEnabled]
                if let label = node as? UILabel { entry["fontSize"] = label.font.pointSize; entry["lines"] = label.numberOfLines; entry["scaling"] = label.adjustsFontForContentSizeCategory }
                frames[id, default: []].append(entry)
            }
            node.subviews.forEach(scan)
        }
        scan(surface)
        sequence += 1
        let insets = view.safeAreaInsets
        let navFrame = navigationController?.navigationBar.convert(navigationController!.navigationBar.bounds, to: view) ?? .zero
        let record: [String: Any] = ["sequence": sequence, "phase": phase, "lastControlPhase": previousPhase, "frames": frames, "safeArea": ["top": insets.top, "bottom": insets.bottom, "left": insets.left, "right": insets.right], "navigationBar": ["x": navFrame.minX, "y": navFrame.minY, "width": navFrame.width, "height": navFrame.height], "window": ["width": view.bounds.width, "height": view.bounds.height], "contentSizeCategory": traitCollection.preferredContentSizeCategory.rawValue, "reads": reads, "nativeBack": backCount, "ownerFailure": failed, "rawLeak": leaked, "metadata": metadata]
        do {
            let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("feedback-probes", isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let data = try JSONSerialization.data(withJSONObject: record, options: [.sortedKeys])
            try data.write(to: directory.appendingPathComponent(String(format: "%06d.json", sequence)), options: .atomic)
        } catch { /* Probe failure never changes product authority or admission. */ }
    }
    deinit { timer?.invalidate() }
}
@MainActor private final class FeedbackFixtureDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds); window.rootViewController = UINavigationController(rootViewController: FeedbackFixtureController()); window.makeKeyAndVisible(); self.window = window; return true
    }
}
UIApplicationMain(CommandLine.argc, CommandLine.unsafeArgv, nil, NSStringFromClass(FeedbackFixtureDelegate.self))
