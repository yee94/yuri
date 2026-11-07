import UIKit
import NativeShell

/// Synthetic-only Host. Never linked into the production app, and never opens a
/// socket, reads a connection/credential, captures a display or injects OS input.
@MainActor private final class SyntheticDesktopHost {
    private weak var surface: NshAppView?
    private let frame: String
    private var owner: String?
    private var pendingFrame: Int?
    private var frameTask: Task<Void, Never>?
    private var live = false
    private var failNextInput = false
    private var opens = 0, closes = 0, frames = 0, acks = 0, inputs = 0, views = 0
    private var inputFailures = 0, pointers = 0, releases = 0, textUnits = 0
    private var lastInput = "none"
    private var zoomed = false

    init(surface: NshAppView) throws {
        self.surface = surface
        // A single fixed neutral bitmap, encoded by UIKit itself. No external
        // image source, screenshot, user content or test-generated load event.
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1; format.opaque = true
        let image = UIGraphicsImageRenderer(size: CGSize(width: 320, height: 180), format: format).image { context in
            UIColor(white: 0.5, alpha: 1).setFill()
            context.fill(CGRect(x: 0, y: 0, width: 320, height: 180))
        }
        guard let data = image.jpegData(compressionQuality: 0.65), !data.isEmpty, data.count <= 512 * 1024 else { throw NSError(domain: "RemoteDesktopUIKitFixture", code: 1, userInfo: [NSLocalizedDescriptionKey: "Synthetic JPEG encoding failed"]) }
        frame = "data:image/jpeg;base64," + data.base64EncodedString()
        for name in ["remoteDesktop.open", "remoteDesktop.close", "remoteDesktop.input", "remoteDesktop.view", "remoteDesktop.ack", "runtime.request"] {
            surface.handle(name) { [weak self] input async throws -> Any? in
                guard let self else { throw CancellationError() }
                return try self.handle(name, input)
            }
        }
    }

    private var counters: [String: Any] {
        ["synthetic": true, "opens": opens, "closes": closes, "frames": frames,
         "acks": acks, "inputs": inputs, "views": views, "live": live,
         "pendingFrame": pendingFrame as Any? ?? NSNull(), "owner": owner as Any? ?? NSNull(),
         "inputFailures": inputFailures, "pointers": pointers, "releases": releases,
         "textUnits": textUnits, "lastInput": lastInput, "failNextInput": failNextInput,
         "zoomed": zoomed, "width": 320, "height": 180]
    }
    private func publish() { surface?.send("fixture.desktop.counters", counters) }
    private func state(_ phase: String, owner: String) {
        surface?.send("remoteDesktop.event", ["owner": owner, "type": "state", "phase": phase])
    }
    private func handle(_ name: String, _ input: Any?) throws -> Any {
        let args = input as? [String: Any] ?? [:]
        if name == "runtime.request" {
            let method = args["method"] as? String ?? "GET"
            if args["path"] as? String == "/api/fixture/desktop", method == "GET" { return counters }
            if args["path"] as? String == "/api/fixture/desktop/fail-next-input", method == "POST" {
                failNextInput = true; publish(); return counters
            }
            throw failure("Only synthetic fixture counter routes are available")
        }
        guard let requested = args["owner"] as? String, requested.hasPrefix("desktop-") else { throw failure("Missing synthetic owner") }
        if name == "remoteDesktop.close" {
            if owner == requested {
                frameTask?.cancel(); frameTask = nil
                owner = nil; pendingFrame = nil; live = false; closes += 1; publish()
            }
            return true
        }
        if name == "remoteDesktop.open" {
            guard owner == nil else { throw failure("Previous synthetic owner was not released") }
            owner = requested; live = false; pendingFrame = nil; opens += 1
            zoomed = args["zoomed"] as? Bool ?? false
            state("connecting", owner: requested); publish()
            frameTask = Task { [weak self] in
                do { try await Task.sleep(nanoseconds: 80_000_000) } catch { return }
                guard let self, self.owner == requested, !Task.isCancelled else { return }
                self.pendingFrame = 1; self.frames += 1
                self.surface?.send("remoteDesktop.event", ["owner": requested, "type": "frame", "frame": 1,
                                                          "width": 320, "height": 180, "source": self.frame])
                self.publish()
            }
            return true
        }
        guard owner == requested else { throw failure("Stale synthetic owner") }
        if name == "remoteDesktop.ack" {
            guard pendingFrame == 1, args["frame"] as? Int == 1, !live else { throw failure("Unexpected or repeated synthetic frame ACK") }
            // This is the ONLY live transition. The fixture never calls the JS
            // Image callback, sends an ACK itself or infers decode from mounting.
            pendingFrame = nil; acks += 1; live = true
            state("live", owner: requested); publish(); return true
        }
        if name == "remoteDesktop.view" {
            guard let value = args["zoomed"] as? Bool else { throw failure("Missing synthetic view state") }
            zoomed = value; views += 1; publish(); return true
        }
        if name == "remoteDesktop.input" {
            guard live, let command = args["input"] as? [String: Any], let type = command["type"] as? String,
                  ["pointer", "scroll", "text", "key", "release"].contains(type) else { throw failure("Synthetic input requires a decoded live frame") }
            inputs += 1; lastInput = type
            if failNextInput {
                failNextInput = false; inputFailures += 1; publish()
                throw failure("Synthetic failed input")
            }
            if type == "pointer" { pointers += 1 }
            if type == "release" { releases += 1 }
            // Counters never expose or log the entered text.
            if type == "text" { textUnits += (command["text"] as? String)?.utf16.count ?? 0 }
            publish(); return true
        }
        throw failure("Unknown synthetic fixture call")
    }
    private func failure(_ message: String) -> NSError {
        NSError(domain: "RemoteDesktopUIKitFixture", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }
}

@MainActor private final class RemoteDesktopFixtureDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = RemoteDesktopFixtureController()
        window.makeKeyAndVisible(); self.window = window
        return true
    }
}

@MainActor private final class RemoteDesktopFixtureController: UIViewController {
    private let surface = NshAppView()
    private var synthetic: SyntheticDesktopHost?
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        surface.onError = { [weak self] message in self?.showFailure(message) }
        surface.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(surface)
        // Same full-surface arrangement as the production embedding: do not fake
        // keyboard avoidance or modify global orientation to make a test pass.
        NSLayoutConstraint.activate([
            surface.topAnchor.constraint(equalTo: view.topAnchor), surface.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            surface.leadingAnchor.constraint(equalTo: view.leadingAnchor), surface.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
        do {
            surface.params = ["remoteDesktopUIKitFixture": true]
            synthetic = try SyntheticDesktopHost(surface: surface)
            guard let bundle = Bundle.main.url(forResource: "bundle", withExtension: "nshc", subdirectory: "nsh") else { throw NSError(domain: "RemoteDesktopUIKitFixture", code: 2, userInfo: [NSLocalizedDescriptionKey: "Missing fixture bundle"]) }
            try surface.loadBundle(at: bundle)
        } catch { showFailure(error.localizedDescription) }
    }
    private func showFailure(_ message: String) {
        let label = UILabel()
        label.accessibilityIdentifier = "remote-desktop-uikit-native-error"
        label.text = message; label.numberOfLines = 0
        label.textColor = .label; label.backgroundColor = .systemBackground
        label.frame = view.bounds.insetBy(dx: 24, dy: 100)
        label.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(label)
    }
    override var preferredStatusBarStyle: UIStatusBarStyle { NshAppView.preferredStatusBarStyle }
    override var prefersStatusBarHidden: Bool { NshAppView.prefersStatusBarHidden }
    override var preferredStatusBarUpdateAnimation: UIStatusBarAnimation { NshAppView.preferredStatusBarUpdateAnimation }
}

UIApplicationMain(CommandLine.argc, CommandLine.unsafeArgv, nil, NSStringFromClass(RemoteDesktopFixtureDelegate.self))
