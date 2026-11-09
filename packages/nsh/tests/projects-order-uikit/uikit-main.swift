import Foundation
import UIKit
import NativeShell

@MainActor private final class ProjectsOrderFixtureController: UIViewController {
    private let surface = NshAppView()
    private var synthetic: ProjectsOrderSyntheticHost?
    override func viewDidLoad() {
        super.viewDidLoad(); view.backgroundColor = .systemBackground
        surface.translatesAutoresizingMaskIntoConstraints = false; view.addSubview(surface)
        NSLayoutConstraint.activate([surface.topAnchor.constraint(equalTo: view.topAnchor), surface.bottomAnchor.constraint(equalTo: view.bottomAnchor), surface.leadingAnchor.constraint(equalTo: view.leadingAnchor), surface.trailingAnchor.constraint(equalTo: view.trailingAnchor)])
        surface.onError = { [weak self] message in self?.showError(message) }
        surface.onOpenURL = { _ in false }
        NativeSheetPresentation.install(on: surface)
        do {
            guard let seedURL = Bundle.main.url(forResource: "seed", withExtension: "json", subdirectory: "fixture"),
                  let seed = try JSONSerialization.jsonObject(with: Data(contentsOf: seedURL)) as? [String: Any],
                  let bundle = Bundle.main.url(forResource: "bundle", withExtension: "nshc", subdirectory: "nsh") else { throw ProjectsOrderSyntheticHost.failure("Missing Projects fixture resources") }
            let synthetic = try ProjectsOrderSyntheticHost(seed: seed); self.synthetic = synthetic
            let methods = ["connection.list", "runtime.request", "fixture.projectsOrder.audit"]
            for method in methods {
                surface.handle(method) { [weak synthetic] input async throws -> Any? in
                    guard let synthetic else { throw CancellationError() }; return try synthetic.call(method, input)
                }
            }
            try surface.grantCapabilities(try ProjectsOrderSyntheticHost.json(["host": methods]))
            let storage = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("SyntheticProjectsStorage", isDirectory: true)
            try FileManager.default.createDirectory(at: storage, withIntermediateDirectories: true)
            surface.storageDirectory = storage; surface.cacheOptions = NshCacheOptions(location: .off, images: .off)
            surface.params = ["projectsOrderUIKitFixture": true, "projects": seed["projects"]!, "buildID": Bundle.main.object(forInfoDictionaryKey: "FixtureBuildID") ?? "unknown"]
            try surface.loadBundle(at: bundle)
        } catch { showError(error.localizedDescription) }
    }
    private func showError(_ message: String) {
        let label = UILabel(); label.accessibilityIdentifier = "projects-order-uikit-native-error"; label.text = message; label.numberOfLines = 0
        label.textColor = .label; label.backgroundColor = .systemBackground; label.frame = view.bounds.insetBy(dx: 20, dy: 100); label.autoresizingMask = [.flexibleWidth, .flexibleHeight]; view.addSubview(label)
    }
    override var preferredStatusBarStyle: UIStatusBarStyle { NshAppView.preferredStatusBarStyle }
}
@MainActor private final class ProjectsOrderFixtureDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds); window.rootViewController = ProjectsOrderFixtureController(); window.makeKeyAndVisible(); self.window = window; return true
    }
}
@main private struct ProjectsOrderFixtureMain {
    static func main() { UIApplicationMain(CommandLine.argc, CommandLine.unsafeArgv, nil, NSStringFromClass(ProjectsOrderFixtureDelegate.self)) }
}
