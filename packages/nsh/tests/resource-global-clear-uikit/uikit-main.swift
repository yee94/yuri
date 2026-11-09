import Foundation
import UIKit
import NativeShell

@MainActor private final class GlobalClearFixtureController: UIViewController {
    private let surface = NshAppView(), memory = GlobalClearMemory(), audit = GlobalClearAudit()
    private var resources: ResourceBridge?, html: ResourceWebPreviewBridge?
    override func viewDidLoad() {
        super.viewDidLoad(); view.backgroundColor = .systemBackground
        surface.translatesAutoresizingMaskIntoConstraints = false; view.addSubview(surface)
        NSLayoutConstraint.activate([surface.topAnchor.constraint(equalTo: view.topAnchor), surface.bottomAnchor.constraint(equalTo: view.bottomAnchor), surface.leadingAnchor.constraint(equalTo: view.leadingAnchor), surface.trailingAnchor.constraint(equalTo: view.trailingAnchor)])
        surface.onOpenURL = { _ in false }
        surface.onError = { [weak self] _ in self?.fail() }
        do {
            guard let bundle = Bundle.main.url(forResource: "bundle", withExtension: "nshc", subdirectory: "nsh") else { throw RuntimeHostScopeFailure.invalid }
            let memory = self.memory, audit = self.audit
            surface.handle("connection.list") { _ async throws -> Any? in memory.snapshot() }
            surface.handle("runtime.request") { input async throws -> Any? in try memory.request(input) }
            surface.handle("fixture.globalClear.audit") { _ async throws -> Any? in audit.snapshot() }
            surface.handle("fixture.globalClear.event") { input async throws -> Any? in try audit.note(input); return true }
            surface.handle("fixture.globalClear.control") { input async throws -> Any? in
                guard let action = (input as? [String: Any])?["action"] as? String else { throw RuntimeHostScopeFailure.invalid }
                if action == "enable" { audit.controlsEnabled = true; audit.record(.enabled) }
                else {
                    guard audit.controlsEnabled, memory.scope.hostID == "synthetic-a", ["arm", "armTwice"].contains(action) else { throw RuntimeHostScopeFailure.invalid }
                    audit.armed = true; audit.twice = action == "armTwice"; audit.record(.armed)
                }
                return true
            }
            surface.handle("fixture.globalClear.applied") { [weak self] input async throws -> Any? in
                guard let self, let selected = (input as? [String: Any])?["selected"] as? String, selected == audit.latest else { throw RuntimeHostScopeFailure.invalid }
                audit.record(.connectionApplied)
                if audit.twice { audit.twice = false; self.revoke() }
                else { audit.applied = true; audit.changed?() }
                return true
            }
            let resources = try ResourceBridge(controller: self, capture: { expected in
                try memory.admit(expected)
                return ResourceTransport(read: { route, limit in
                    try memory.admit(expected); let value = try memory.read(route, limit: limit)
                    return (value.status, value.mime, value.data)
                }, isCurrent: { memory.current(expected) })
            })
            self.resources = resources; resources.install(on: surface)
            surface.handle("resources.read") { [weak resources] input async throws -> Any? in
                guard let resources else { throw CancellationError() }
                audit.record(.resourceRead); return try await resources.startRead(input)
            }
            resources.installGlobalClearLeaseAudit(on: surface, audit: audit)
            installGlobalClearAnchorGate(on: surface, resources: resources, audit: audit, revoke: { [weak self] in self?.revoke() })
            let html = ResourceWebPreviewBridge(controller: self, capture: { expected in
                try memory.admit(expected)
                return ResourceWebPreviewTransport(readFile: { route, limit in try memory.admit(expected); return try memory.read(route, limit: limit) }, isCurrent: { memory.current(expected) })
            })
            self.html = html; html.install(on: surface)
            html.initialFile = { [weak resources] lease, path, expected in
                guard let resources else { throw CancellationError() }
                let value = try resources.htmlInitial(lease, path: path, expectedHost: expected)
                return ResourceWebPreviewResponse(status: 200, mime: value.mime, data: value.data)
            }
            html.installView(on: surface, covered: { [weak resources] in resources?.ownsPresentation($0) == true })
            let storage = FileManager.default.temporaryDirectory.appendingPathComponent("SyntheticGlobalClear-" + UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: storage, withIntermediateDirectories: true); surface.storageDirectory = storage
            let methods = ["connection.list", "runtime.request", "resources.read", "resources.present", "resources.release", "resources.cancel", "resources.close", "resources.web.present", "resources.web.close", "fixture.globalClear.control", "fixture.globalClear.applied", "fixture.globalClear.event", "fixture.globalClear.audit"]
            try surface.grantCapabilities(String(data: JSONSerialization.data(withJSONObject: ["host": methods]), encoding: .utf8)!)
            surface.cacheOptions = NshCacheOptions(location: .off, images: .off)
            surface.params = ["resourceGlobalClearSyntheticOnly": true, "buildID": Bundle.main.object(forInfoDictionaryKey: "FixtureBuildID") ?? "unknown"]
            try surface.loadBundle(at: bundle)
        } catch { fail() }
    }
    private func revoke() {
        memory.rotate(); audit.latest = memory.scope.hostID; audit.record(.authorityRevoked)
        surface.send("fixture.globalClear.connection", memory.snapshot())
    }
    func suspend() { audit.record(.backgrounded); resources?.invalidate(); html?.invalidate() }
    private func fail() {
        audit.record(.nativeFailure)
        let label = UILabel(); label.accessibilityIdentifier = "resource-global-native-failure"; label.text = "Synthetic fixture native failure"
        label.frame = view.bounds.insetBy(dx: 20, dy: 100); label.autoresizingMask = [.flexibleWidth, .flexibleHeight]; view.addSubview(label)
    }
}
@MainActor private final class GlobalClearFixtureDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds); window.rootViewController = GlobalClearFixtureController(); window.makeKeyAndVisible(); self.window = window; return true
    }
    func applicationDidEnterBackground(_ application: UIApplication) { (window?.rootViewController as? GlobalClearFixtureController)?.suspend() }
}
@main private struct GlobalClearFixtureMain {
    static func main() { UIApplicationMain(CommandLine.argc, CommandLine.unsafeArgv, nil, NSStringFromClass(GlobalClearFixtureDelegate.self)) }
}
