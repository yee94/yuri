import Foundation
import UIKit
import NativeShell

@MainActor private final class PointerFixtureController: UIViewController {
    private let surface = NshAppView()
    private var phase = "create-surface"
    private var failures: [String] = []
    private let failureLabel = UILabel()
    #if ASSISTANT_LIST_POINTER
    private let host = AssistantListPointerHost()
    #endif
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        surface.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(surface)
        NSLayoutConstraint.activate([
            surface.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            surface.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            surface.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            surface.trailingAnchor.constraint(equalTo: view.trailingAnchor)
        ])
        surface.onError = { [weak self] message in self?.failure(message, origin: "engine-onError") }
        surface.onOpenURL = { _ in false }
        do {
            phase = "resolve-bundle"
            guard let bundle = Bundle.main.url(forResource: "bundle", withExtension: "nshc", subdirectory: "nsh") else {
                failure("Missing nsh/bundle.nshc", origin: "resolve-bundle"); return
            }
            var directory: ObjCBool = false
            guard FileManager.default.fileExists(atPath: bundle.path, isDirectory: &directory), !directory.boolValue else {
                failure("nsh/bundle.nshc is not a regular file", origin: "resolve-bundle"); return
            }
            phase = "grant-empty-capabilities"
            #if ASSISTANT_LIST_POINTER
            for method in AssistantListPointerHost.methods {
                surface.handle(method) { [weak host] input async throws -> Any? in
                    guard let host else { throw AssistantListPointerHost.failure("retired") }
                    return try host.call(method, input)
                }
            }
            try surface.grantCapabilities("{\"host\":[\"connection.list\",\"runtime.request\"]}")
            #else
            try surface.grantCapabilities("{}")
            #endif
            surface.cacheOptions = NshCacheOptions(location: .off, images: .off)
            phase = "load-bundle"
            try surface.loadBundle(at: bundle)
            phase = "bundle-loaded"
        } catch { failure(String(reflecting: error) + "\n" + error.localizedDescription, origin: "swift-catch") }
    }
    private func failure(_ message: String, origin: String) {
        // Synthetic-only fixture: retain the SDK message (including JS stack when supplied).
        // Four records / 4096 characters each; no Host methods or credentials exist here.
        let record = "phase=\(phase) origin=\(origin)\n" + String(message.prefix(4096))
        failures = Array((failures + [record]).suffix(4))
        let text = failures.joined(separator: "\n---\n")
        do {
            let directory = try FileManager.default.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            try Data(text.utf8).write(to: directory.appendingPathComponent("pointer-startup-errors.txt"), options: .atomic)
        } catch {
            failures = Array((failures + ["phase=save-error " + String(error.localizedDescription.prefix(512))]).suffix(4))
        }
        let label = failureLabel
        label.accessibilityIdentifier = "pointer-native-error"
        label.text = failures.joined(separator: "\n---\n")
        label.numberOfLines = 0
        label.accessibilityLabel = label.text
        label.frame = view.bounds.insetBy(dx: 20, dy: 100)
        label.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        label.textColor = .label
        label.backgroundColor = .systemBackground
        view.addSubview(label)
    }
}
@MainActor private final class PointerFixtureDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = PointerFixtureController()
        window.makeKeyAndVisible()
        self.window = window
        return true
    }
}
@main private struct PointerFixtureMain {
    static func main() { UIApplicationMain(CommandLine.argc, CommandLine.unsafeArgv, nil, NSStringFromClass(PointerFixtureDelegate.self)) }
}
