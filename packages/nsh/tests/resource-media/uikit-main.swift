import Foundation
import UIKit
import AVKit
import NativeShell

/// Only the narrow production type is replaced. ResourceBridge.swift is linked
/// unchanged; no RuntimeBridge, connection store, network or credential access.
@MainActor struct ResourceTransport {
    let read: (String, Int) async throws -> (status: Int, mime: String, data: Data)
    let isCurrent: () -> Bool
}

@MainActor private final class SyntheticMediaTransport {
    private weak var surface: NshAppView?
    private let files: [String: (mime: String, data: Data)]
    private let initialTemporaryResourceFiles: Int
    var invalidateBridge: (() -> Void)?
    var inspectPlayer: (() -> [String: Any])?
    private var timer: Task<Void, Never>?
    private var generation = 0, captures = 0, statReads = 0, serveReads = 0, pending = 0
    private var cancelled = 0, currentInvalidations = 0, rejected = 0, readFailures = 0
    private var failNextServe = false
    private var playerSample: [String: Any] = [:]
    private var samples = 0
    private var sequenceTask: Task<Void, Never>?
    private var sequenceRun = 0
    private var sequenceActive = false
    private var playerSequence: [[String: Any]] = []
    private var expectedHost: RuntimeHostScope {
        RuntimeHostScope(hostID: "synthetic-media", lease: UUID(uuidString: String(format: "00000000-0000-4000-8000-%012d", generation + 1))!)
    }
    init(surface: NshAppView) throws {
        self.surface = surface
        guard let wav = Bundle.main.url(forResource: "silent", withExtension: "wav", subdirectory: "media"),
              let mp4 = Bundle.main.url(forResource: "neutral", withExtension: "mp4", subdirectory: "media") else { throw Self.failure("Missing generated neutral media") }
        let audio = try Data(contentsOf: wav), video = try Data(contentsOf: mp4)
        guard audio.count <= 1_000_000, video.count <= 1_000_000 else { throw Self.failure("Synthetic fixture assets exceed 1 MB") }
        files = ["/fixture/media/silent.wav": ("audio/wav", audio), "/fixture/media/neutral.mp4": ("video/mp4", video),
                 "/fixture/media/slow.mp4": ("video/mp4", video), "/fixture/media/unsupported.mp4": ("video/mp4", Data("Neutral invalid container; never decoded".utf8))]
        initialTemporaryResourceFiles = Self.temporaryResourceFiles
        surface.handle("fixture.media.control") { [weak self] input async throws -> Any? in
            guard let self, let action = (input as? [String: Any])?["action"] as? String else { throw Self.failure("Invalid fixture control") }
            switch action {
            case "inspect": break
            case "fail-next-serve": self.failNextServe = true
            case "invalidate": self.invalidate()
            case "sample-sequence":
                guard #available(iOS 16.0, *) else { throw Self.failure("Continuous sampling requires iOS 16 or later") }
                self.startSampleSequence()
            case "invalidate-after", "sample-after":
                self.timer?.cancel()
                self.timer = Task { [weak self] in
                    do { try await Task.sleep(nanoseconds: 3_500_000_000) } catch { return }
                    guard let self else { return }
                    if action == "invalidate-after" { self.invalidate() }
                    else { self.samples += 1; self.playerSample = self.inspectPlayer?() ?? [:]; self.publish() }
                }
            default: throw Self.failure("Unknown fixture control")
            }
            self.publish(); return self.counters
        }
    }
    @available(iOS 16.0, *)
    private func startSampleSequence() {
        sequenceTask?.cancel()
        sequenceRun += 1; sequenceActive = true; playerSequence = []
        let run = sequenceRun, clock = ContinuousClock(), start = ContinuousClock.now
        let deadline = start.advanced(by: .seconds(8))
        sequenceTask = Task { [weak self] in
            for tick in 0...16 {
                do { try await clock.sleep(until: start.advanced(by: .milliseconds(tick * 500))) }
                catch { break }
                let instant = clock.now
                guard let self, !Task.isCancelled, self.sequenceRun == run, instant <= deadline, self.playerSequence.count < 20 else { break }
                let duration = start.duration(to: instant).components
                var sample = self.inspectPlayer?() ?? [:]
                sample["elapsedMs"] = Double(duration.seconds) * 1_000 + Double(duration.attoseconds) / 1_000_000_000_000_000
                sample["generation"] = self.generation
                sample["applicationState"] = UIApplication.shared.applicationState.rawValue
                self.playerSequence.append(sample)
                self.publish()
            }
            guard let self, self.sequenceRun == run else { return }
            self.sequenceActive = false; self.publish()
        }
    }
    func capture(_ expected: RuntimeHostScope) throws -> ResourceTransport {
        guard expected == expectedHost else { throw RuntimeHostScopeFailure.stale }
        captures += 1; publish()
        let scope = generation
        return ResourceTransport(read: { [weak self] route, limit in
            guard let self else { throw CancellationError() }
            return try await self.read(route, limit: limit, scope: scope)
        }, isCurrent: { [weak self] in self?.generation == scope })
    }
    private func read(_ route: String, limit: Int, scope: Int) async throws -> (status: Int, mime: String, data: Data) {
        guard scope == generation, limit > 0, limit <= 25 * 1024 * 1024 else { throw CancellationError() }
        pending += 1; publish(); defer { pending -= 1; publish() }
        do {
            let response: (status: Int, mime: String, data: Data)
            if let parts = URLComponents(string: route), parts.path == "/api/fs/stat",
               parts.queryItems?.count == 1, parts.queryItems?.first?.name == "path",
               let path = parts.queryItems?.first?.value, let file = files[path] {
                statReads += 1
                response = (200, "application/json", try JSONSerialization.data(withJSONObject: ["isFile": true, "isBinary": true, "size": file.data.count]))
            } else if let file = files.first(where: { "/api/fs/serve" + $0.key == route }) {
                serveReads += 1
                if failNextServe { failNextServe = false; readFailures += 1; throw Self.failure("Neutral media refresh failed; previous lease retained") }
                if file.key == "/fixture/media/slow.mp4" { try await Task.sleep(nanoseconds: 8_000_000_000) }
                response = (200, file.value.mime, file.value.data)
            } else { rejected += 1; throw Self.failure("Only fixed synthetic stat/serve paths are available") }
            // Simulate bounded receiver chunks, never an unbounded network/body API.
            var received = Data()
            for offset in stride(from: 0, to: response.data.count, by: 65_536) {
                try Task.checkCancellation()
                guard scope == generation else { throw CancellationError() }
                let end = min(offset + 65_536, response.data.count)
                guard end - offset <= limit - received.count else { throw Self.failure("Synthetic receive limit") }
                received.append(response.data[offset..<end])
                try await Task.sleep(nanoseconds: 5_000_000)
            }
            return (response.status, response.mime, received)
        } catch is CancellationError { cancelled += 1; throw CancellationError() }
    }
    func invalidate() {
        generation += 1; currentInvalidations += 1; invalidateBridge?()
        surface?.send("fixture.media.scope", ["generation": generation]); publish()
    }
    private static var temporaryResourceFiles: Int {
        let manager = FileManager.default
        let roots = (try? manager.contentsOfDirectory(at: manager.temporaryDirectory, includingPropertiesForKeys: nil)) ?? []
        return roots.filter { $0.lastPathComponent.hasPrefix("resources-") }.reduce(0) { count, root in
            guard let enumerator = manager.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey]) else { return count }
            return count + enumerator.compactMap { $0 as? URL }.filter { (try? $0.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true }.count
        }
    }
    var counters: [String: Any] {
        ["synthetic": true, "generation": generation, "captures": captures, "statReads": statReads, "serveReads": serveReads,
         "pending": pending, "cancelled": cancelled, "currentInvalidations": currentInvalidations, "rejected": rejected,
         "readFailures": readFailures, "failNextServe": failNextServe, "temporaryResourceFiles": Self.temporaryResourceFiles,
         "initialTemporaryResourceFiles": initialTemporaryResourceFiles,
         "samples": samples, "lastPlayerSample": playerSample, "playerNow": inspectPlayer?() ?? [:],
         "sequenceRun": sequenceRun, "sequenceActive": sequenceActive, "playerSequence": playerSequence]
    }
    func publish() { surface?.send("fixture.media.counters", counters) }
    private static func failure(_ message: String) -> NSError { NSError(domain: "SyntheticMediaFixture", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
}

@MainActor private final class ResourceMediaFixtureController: UIViewController {
    private let surface = NshAppView()
    private var bridge: ResourceBridge?
    private var synthetic: SyntheticMediaTransport?
    private var nativePresentations = 0, avkitPresentations = 0
    override func viewDidLoad() {
        super.viewDidLoad(); view.backgroundColor = .systemBackground
        surface.translatesAutoresizingMaskIntoConstraints = false; view.addSubview(surface)
        NSLayoutConstraint.activate([surface.topAnchor.constraint(equalTo: view.topAnchor), surface.bottomAnchor.constraint(equalTo: view.bottomAnchor),
                                     surface.leadingAnchor.constraint(equalTo: view.leadingAnchor), surface.trailingAnchor.constraint(equalTo: view.trailingAnchor)])
        surface.onError = { [weak self] message in self?.showError(message) }
        do {
            let synthetic = try SyntheticMediaTransport(surface: surface)
            let bridge = try ResourceBridge(controller: self, capture: { [weak synthetic] expectedHost in
                guard let synthetic else { throw CancellationError() }; return try synthetic.capture(expectedHost)
            })
            self.synthetic = synthetic; self.bridge = bridge
            synthetic.invalidateBridge = { [weak bridge] in bridge?.invalidate() }
            synthetic.inspectPlayer = { [weak self] in self?.playerSnapshot ?? [:] }
            bridge.install(on: surface)
            surface.params = ["resourceMediaUIKitFixture": true]
            guard let bundle = Bundle.main.url(forResource: "bundle", withExtension: "nshc", subdirectory: "nsh") else { throw NSError(domain: "SyntheticMediaFixture", code: 1, userInfo: [NSLocalizedDescriptionKey: "Missing fixture bundle"]) }
            try surface.loadBundle(at: bundle)
        } catch { showError(error.localizedDescription) }
    }
    private func playerController(in controller: UIViewController?) -> AVPlayerViewController? {
        guard let controller else { return nil }
        if let player = controller as? AVPlayerViewController { return player }
        for child in controller.children { if let player = playerController(in: child) { return player } }
        return playerController(in: controller.presentedViewController)
    }
    private var playerSnapshot: [String: Any] {
        let player = playerController(in: presentedViewController)?.player
        let seconds = player?.currentTime().seconds ?? 0
        return ["nativePresentations": nativePresentations, "avkitPresentations": avkitPresentations, "hasItem": player?.currentItem != nil,
                "itemStatus": player?.currentItem?.status.rawValue ?? -1, "time": seconds.isFinite ? seconds : 0, "rate": player?.rate ?? 0]
    }
    override func present(_ controller: UIViewController, animated flag: Bool, completion: (() -> Void)? = nil) {
        super.present(controller, animated: flag) { [weak self, weak controller] in
            guard let self else { completion?(); return }
            self.nativePresentations += 1
            if self.playerController(in: controller) != nil { self.avkitPresentations += 1 }
            self.synthetic?.publish(); completion?()
        }
    }
    private func showError(_ message: String) {
        let label = UILabel(); label.accessibilityIdentifier = "resource-media-uikit-native-error"
        label.text = message; label.numberOfLines = 0; label.textColor = .label; label.backgroundColor = .systemBackground
        label.frame = view.bounds.insetBy(dx: 20, dy: 100); label.autoresizingMask = [.flexibleWidth, .flexibleHeight]; view.addSubview(label)
    }
    override var preferredStatusBarStyle: UIStatusBarStyle { NshAppView.preferredStatusBarStyle }
}

@MainActor private final class ResourceMediaFixtureDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds); window.rootViewController = ResourceMediaFixtureController()
        window.makeKeyAndVisible(); self.window = window; return true
    }
}

@main private struct ResourceMediaFixtureMain {
    static func main() { UIApplicationMain(CommandLine.argc, CommandLine.unsafeArgv, nil, NSStringFromClass(ResourceMediaFixtureDelegate.self)) }
}
