import Foundation
import UIKit
import NativeShell

@MainActor private final class FeaturesUIKitController: UIViewController {
    private let surface = NshAppView()
    private var synthetic: FeaturesSyntheticHost?
    private var appearance: AppearanceBridge?
    private var dates: ScheduleDateBridge?
    override func viewDidLoad() {
        super.viewDidLoad(); view.backgroundColor = .systemBackground
        surface.translatesAutoresizingMaskIntoConstraints = false; view.addSubview(surface)
        NSLayoutConstraint.activate([surface.topAnchor.constraint(equalTo: view.topAnchor), surface.bottomAnchor.constraint(equalTo: view.bottomAnchor), surface.leadingAnchor.constraint(equalTo: view.leadingAnchor), surface.trailingAnchor.constraint(equalTo: view.trailingAnchor)])
        surface.onError = { [weak self] message in self?.showError(message) }
        surface.onOpenURL = { _ in false }
        NativeSheetPresentation.install(on: surface)
        NativeDatePicker.install(on: surface)
        do {
            guard let seedURL = Bundle.main.url(forResource: "seed", withExtension: "json", subdirectory: "fixture"),
                  let seed = try JSONSerialization.jsonObject(with: Data(contentsOf: seedURL)) as? [String: Any],
                  let bundle = Bundle.main.url(forResource: "bundle", withExtension: "nshc", subdirectory: "nsh") else { throw FeaturesSyntheticHost.failure("Missing Features fixture resources") }
            let synthetic = try FeaturesSyntheticHost(seed: seed); self.synthetic = synthetic
            let methods = ["connection.list", "runtime.request", "features.fixture.identity", "features.fixture.configure", "features.fixture.audit"]
            for method in methods {
                surface.handle(method) { [weak self, weak synthetic] input async throws -> Any? in
                    guard let self, let synthetic else { throw CancellationError() }
                    let result = try synthetic.call(method, input)
                    if method == "features.fixture.audit", var audit = result as? [String: Any] {
                        audit["buildID"] = Bundle.main.object(forInfoDictionaryKey: "FixtureBuildID") ?? "unknown"
                        let output = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
                        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
                        try Data(FeaturesSyntheticHost.json(audit).utf8).write(to: output.appendingPathComponent("features-audit.json"), options: .atomic)
                        return audit
                    }
                    _ = self
                    return result
                }
            }
            appearance = AppearanceBridge(app: surface, selectedHost: { [weak synthetic] in synthetic?.selectedHostID })
            dates = ScheduleDateBridge(app: surface, capture: { [weak synthetic] in
                guard let synthetic, let id = synthetic.selectedHostID, synthetic.scopeIsCurrent else { throw NativeScheduleDateContext.Failure.staleScope }
                return ScheduleDateScope(hostID: id, isCurrent: { [weak synthetic] in synthetic?.selectedHostID == id && synthetic?.scopeIsCurrent == true })
            })
            try surface.grantCapabilities(try FeaturesSyntheticHost.json(["host": methods + ["appearance.reset", "appearance.apply", "schedule.dateContext"]]))
            let storage = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("FeaturesFixtureStorage", isDirectory: true)
            try FileManager.default.createDirectory(at: storage, withIntermediateDirectories: true)
            surface.storageDirectory = storage; surface.cacheOptions = NshCacheOptions(location: .off, images: .off)
            try surface.loadBundle(at: bundle)
        } catch { showError(error.localizedDescription) }
    }
    private func showError(_ message: String) {
        let label = UILabel(); label.accessibilityIdentifier = "features-uikit-native-error"; label.text = message; label.numberOfLines = 0
        label.textColor = .label; label.backgroundColor = .systemBackground; label.frame = view.bounds.insetBy(dx: 20, dy: 100); label.autoresizingMask = [.flexibleWidth, .flexibleHeight]; view.addSubview(label)
    }
    override var preferredStatusBarStyle: UIStatusBarStyle { NshAppView.preferredStatusBarStyle }
}
@MainActor private final class FeaturesUIKitDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds); window.rootViewController = FeaturesUIKitController(); window.makeKeyAndVisible(); self.window = window; return true
    }
}
@main private struct FeaturesUIKitMain {
    static func main() { UIApplicationMain(CommandLine.argc, CommandLine.unsafeArgv, nil, NSStringFromClass(FeaturesUIKitDelegate.self)) }
}
