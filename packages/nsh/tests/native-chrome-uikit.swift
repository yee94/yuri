import Foundation
import UIKit
import NativeShell

@MainActor private final class FixtureController: UIViewController {
    private let surface = NshAppView()
    private var audit: Timer?
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        surface.translatesAutoresizingMaskIntoConstraints = false; view.addSubview(surface)
        NSLayoutConstraint.activate([surface.topAnchor.constraint(equalTo: view.topAnchor), surface.bottomAnchor.constraint(equalTo: view.bottomAnchor), surface.leadingAnchor.constraint(equalTo: view.leadingAnchor), surface.trailingAnchor.constraint(equalTo: view.trailingAnchor)])
        surface.onError = { error in print("[chrome-qa-error] \(error)") }
        NativeSheetPresentation.install(on: surface)
        NativeChatHeaderCollapse.install(on: surface)
        NativeDatePicker.install(on: surface)
        surface.cacheOptions = NshCacheOptions(location: .off, images: .off)
        do {
            try surface.grantCapabilities("{}")
            try surface.loadBundle(at: Bundle.main.url(forResource: "bundle", withExtension: "nshc", subdirectory: "nsh")!)
        } catch { print("[chrome-qa-error] \(error)") }
        audit = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.capture() }
        }
    }
    private func capture() {
        func controllers(_ root: UIViewController) -> [UIViewController] { [root] + root.children.flatMap(controllers) }
        let roots = controllers(self)
        let presented = roots.compactMap { $0.presentedViewController }.first
        let sheet = presented?.sheetPresentationController
        let navigation = roots.compactMap { $0 as? UINavigationController }.first
        let detents: [String]
        if #available(iOS 16.0, *) { detents = sheet?.detents.map { $0.identifier.rawValue } ?? [] }
        else { detents = sheet == nil ? [] : ["medium", "large"] }
        let value: [String: Any] = [
            "presented": presented.map { String(describing: type(of: $0)) } ?? "none",
            "presentation": sheet.map { String(describing: type(of: $0)) } ?? "none",
            "detents": detents,
            "selected": sheet?.selectedDetentIdentifier?.rawValue ?? "none",
            "grabber": sheet?.prefersGrabberVisible ?? false,
            "dismissalLocked": presented?.isModalInPresentation ?? false,
            "sheetTop": presented.map { $0.view.convert($0.view.bounds, to: nil).minY } ?? -1,
            "headerAlpha": navigation?.navigationBar.alpha ?? -1,
            "headerTranslation": navigation?.navigationBar.transform.ty ?? -1,
        ]
        if let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first {
            try? data.write(to: directory.appendingPathComponent("chrome-audit.json"), options: .atomic)
        }
    }
}
@MainActor private final class FixtureDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = FixtureController(); window.makeKeyAndVisible(); self.window = window; return true
    }
}
@main private struct FixtureMain {
    static func main() { UIApplicationMain(CommandLine.argc, CommandLine.unsafeArgv, nil, NSStringFromClass(FixtureDelegate.self)) }
}
