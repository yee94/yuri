import Foundation
import UIKit
import NativeShell

@MainActor private final class ComposerProbeController: UIViewController {
    private let surface = NshAppView()
    private let enabled = Bundle.main.object(forInfoDictionaryKey: "ComposerReadbackEnabled") as? Bool == true
    private lazy var diagnostics = ComposerProbeDiagnostics(enabled: enabled)

    override func viewDidLoad() {
        super.viewDidLoad(); view.backgroundColor = .systemBackground
        surface.translatesAutoresizingMaskIntoConstraints = false; view.addSubview(surface)
        NSLayoutConstraint.activate([surface.leadingAnchor.constraint(equalTo: view.leadingAnchor), surface.trailingAnchor.constraint(equalTo: view.trailingAnchor), surface.topAnchor.constraint(equalTo: view.topAnchor), surface.bottomAnchor.constraint(equalTo: view.bottomAnchor)])
        surface.onOpenURL = { _ in false }
        surface.onError = { [weak self] _ in self?.diagnostics.recordError(.runtimeError) }
        NativeInputMetadataOwner.install(on: surface)
        NativeComposerSpellcheck.install(on: surface)
        diagnostics.install(on: surface)
        surface.params = ["composerReadbackEnabled": enabled]
        surface.handle("fixture.composer.hostAdopted") { [weak self] input async throws -> Any? in
            guard let self else { return ["accepted": false, "revision": 0] }; return self.diagnostics.hostAdopted(input)
        }
        do {
            let grants: [String: Any] = ["host": ["fixture.composer.hostAdopted"]]
            try surface.grantCapabilities(String(decoding: JSONSerialization.data(withJSONObject: grants), as: UTF8.self))
            guard let bundle = Bundle.main.url(forResource: "bundle", withExtension: "nshc", subdirectory: "nsh") else { diagnostics.recordError(.bundleMissing); return }
            try surface.loadBundle(at: bundle)
        } catch { diagnostics.recordError(.bundleLoadFailed) }
    }
    func readback(_ step: ComposerProbeStep) {
        do { try diagnostics.readback(step) }
        catch { diagnostics.recordError(.exportFailed) }
    }
    func open(_ url: URL) -> Bool {
        guard enabled, url.scheme == Bundle.main.object(forInfoDictionaryKey: "ComposerProbeScheme") as? String,
              url.query == nil, url.fragment == nil, url.user == nil, url.password == nil, url.port == nil else { return false }
        if url.host == "readback", let step = ComposerProbeStep.manual(url.lastPathComponent), url.path == "/\(step.rawValue)" {
            readback(step); return true
        }
        if url.host == "host-change", url.path.isEmpty || url.path == "/" {
            let revision = diagnostics.requestHostChange()
            surface.send("fixture.composer.hostChanged", ["revision": revision]); return true
        }
        return false
    }
}

@MainActor private final class ComposerProbeDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    private weak var controller: ComposerProbeController?
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let controller = ComposerProbeController(), window = UIWindow(frame: UIScreen.main.bounds)
        self.controller = controller; window.rootViewController = controller; window.makeKeyAndVisible(); self.window = window
        return true
    }
    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool { controller?.open(url) ?? false }
    func applicationDidEnterBackground(_ application: UIApplication) { controller?.readback(.background) }
    func applicationDidBecomeActive(_ application: UIApplication) { controller?.readback(.foreground) }
}

@main private struct ComposerProbeMain {
    static func main() { UIApplicationMain(CommandLine.argc, CommandLine.unsafeArgv, nil, NSStringFromClass(ComposerProbeDelegate.self)) }
}
