import Foundation
import UIKit
import NativeShell

/// Links real production Swift declarations, including ResourceTransport. No SDK shim.
@MainActor private final class ResourcePageFixtureController: UIViewController {
    private let surface = NshAppView(), memory = ResourcePageSyntheticHost()
    private var resources: ResourceBridge?, html: ResourceWebPreviewBridge?, appearance: AppearanceBridge?
    private var gui: GuiPluginPreviewBridge?, guiResources: GuiPluginPreviewResources?
    override func viewDidLoad() {
        super.viewDidLoad(); view.backgroundColor = .systemBackground
        surface.translatesAutoresizingMaskIntoConstraints = false; view.addSubview(surface)
        NSLayoutConstraint.activate([surface.topAnchor.constraint(equalTo: view.topAnchor), surface.bottomAnchor.constraint(equalTo: view.bottomAnchor), surface.leadingAnchor.constraint(equalTo: view.leadingAnchor), surface.trailingAnchor.constraint(equalTo: view.trailingAnchor)])
        surface.onError = { [weak self] in self?.failure($0) }; surface.onOpenURL = { _ in false }
        NativeSheetPresentation.install(on: surface)
        do {
            guard let bundle = Bundle.main.url(forResource: "bundle", withExtension: "nshc", subdirectory: "nsh"), let assets = Bundle.main.url(forResource: "gui-plugin-preview", withExtension: nil) else { throw RuntimeHostScopeFailure.invalid }
            let memory = self.memory
            surface.handle("connection.list") { _ async throws -> Any? in memory.snapshot() }
            surface.handle("runtime.request") { input async throws -> Any? in try memory.request(input) }
            surface.handle("fixture.resourcePage.audit") { _ async throws -> Any? in memory.audit() }
            surface.handle("fixture.resourcePage.bumpStat") { _ async throws -> Any? in memory.bump(); return true }
            appearance = AppearanceBridge(app: surface, selectedHost: { memory.scope.hostID })
            let resources = try ResourceBridge(controller: self, capture: { expected in
                try memory.admit(expected)
                return ResourceTransport(read: { route, limit in let value = try memory.read(route, limit: limit); return (value.status, value.mime, value.data) }, isCurrent: { memory.current })
            })
            self.resources = resources; resources.install(on: surface); resources.installPresentationAnchor(on: surface)
            let svg: ResourceSVGImageFactory.Resolve = { [weak resources] lease, expected in
                guard let resources else { throw CancellationError() }
                let asset = try resources.svgAsset(lease, expectedHost: expected)
                return ResourceSVGImageAsset(url: asset.url, current: asset.current, observeRetirement: asset.observe)
            }
            ResourceSVGImageFactory.install(on: surface, resolve: svg)
            resources.makeSVGPreview = { lease, expected in try ResourceSVGImageFactory.controller(lease: lease, expectedHost: expected, resolve: svg) }
            let html = ResourceWebPreviewBridge(controller: self, capture: { expected in
                try memory.admit(expected)
                return ResourceWebPreviewTransport(readFile: { try memory.read($0, limit: $1) }, isCurrent: { memory.current })
            }, diagnostic: { event in memory.count("html:" + event.stage.rawValue) })
            self.html = html; html.install(on: surface)
            html.initialFile = { [weak resources] lease, path, expected in
                guard let resources else { throw CancellationError() }
                let value = try resources.htmlInitial(lease, path: path, expectedHost: expected)
                memory.count("htmlInitial"); return ResourceWebPreviewResponse(status: 200, mime: value.mime, data: value.data)
            }
            html.installView(on: surface, covered: { [weak resources] in resources?.ownsPresentation($0) == true })
            let storage = FileManager.default.temporaryDirectory.appendingPathComponent("SyntheticResourcePage-" + UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: storage, withIntermediateDirectories: true)
            surface.storageDirectory = storage.appendingPathComponent("nsh", isDirectory: true)
            try FileManager.default.createDirectory(at: surface.storageDirectory!, withIntermediateDirectories: true)
            let guiResources = try GuiPluginPreviewResources(stagedDirectory: assets, storageDirectory: storage.appendingPathComponent("gui", isDirectory: true))
            self.guiResources = guiResources
            let gui = GuiPluginPreviewBridge(controller: self, capture: { expected in
                try memory.admit(expected)
                return try guiResources.capture(expectedHost: expected, isCurrent: { memory.current && $0 == memory.scope }, resource: ResourceWebPreviewTransport(readFile: { try memory.read($0, limit: $1) }, isCurrent: { memory.current }), readGui: { try memory.gui($0, $1, $2) }, openGui: nil)
            })
            self.gui = gui; gui.install(on: surface)
            let methods = ["connection.list", "runtime.request", "resources.read", "resources.present", "resources.release", "resources.cancel", "resources.close", "resources.web.present", "resources.web.close", "plugins.preview.present", "plugins.preview.close", "appearance.reset", "appearance.apply", "fixture.resourcePage.audit", "fixture.resourcePage.bumpStat"]
            try surface.grantCapabilities(String(data: JSONSerialization.data(withJSONObject: ["host": methods]), encoding: .utf8)!)
            surface.cacheOptions = NshCacheOptions(location: .off, images: .off)
            surface.params = ["resourcePageSyntheticOnly": true, "buildID": Bundle.main.object(forInfoDictionaryKey: "FixtureBuildID") ?? "unknown"]
            try surface.loadBundle(at: bundle)
        } catch { failure(error.localizedDescription) }
    }
    func suspend() { resources?.invalidate(); html?.invalidate(); memory.invalidate() }
    private func failure(_ message: String) {
        let label = UILabel(); label.accessibilityIdentifier = "resource-page-native-error"; label.text = message; label.numberOfLines = 0
        label.frame = view.bounds.insetBy(dx: 20, dy: 100); label.autoresizingMask = [.flexibleWidth, .flexibleHeight]; label.textColor = .label; label.backgroundColor = .systemBackground; view.addSubview(label)
    }
}
@MainActor private final class ResourcePageFixtureDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds); window.rootViewController = ResourcePageFixtureController(); window.makeKeyAndVisible(); self.window = window; return true
    }
    func applicationDidEnterBackground(_ application: UIApplication) { (window?.rootViewController as? ResourcePageFixtureController)?.suspend() }
}
@main private struct ResourcePageFixtureMain {
    static func main() { UIApplicationMain(CommandLine.argc, CommandLine.unsafeArgv, nil, NSStringFromClass(ResourcePageFixtureDelegate.self)) }
}
