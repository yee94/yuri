import Foundation
import UIKit
import NativeShell

@MainActor private final class HistoryProductionController: UIViewController {
    private let surface = NshAppView()
    private var host: HistoryProductionHost?, observer: HistoryProductionObserver?, appearance: AppearanceBridge?
    private var cacheCleanup: AuthorizationCacheCleanupBridge?
    private let uiParityProcessNonce = UUID().uuidString
    override func viewDidLoad() {
        super.viewDidLoad(); view.backgroundColor = .systemBackground
        surface.translatesAutoresizingMaskIntoConstraints = false; view.addSubview(surface)
        NSLayoutConstraint.activate([surface.leadingAnchor.constraint(equalTo: view.leadingAnchor), surface.trailingAnchor.constraint(equalTo: view.trailingAnchor), surface.topAnchor.constraint(equalTo: view.topAnchor), surface.bottomAnchor.constraint(equalTo: view.bottomAnchor)])
        surface.onOpenURL = { _ in false }; surface.onError = { [weak self] _ in self?.fail() }
        NativeSheetPresentation.install(on: surface); NativeDatePicker.install(on: surface); NativeChatHeaderCollapse.install(on: surface); NewSessionPickerOwners.install(on: surface)
        NativeInputMetadataOwner.install(on: surface)
        NativeComposerSpellcheck.install(on: surface)
        do {
            guard let bundle = Bundle.main.url(forResource: "bundle", withExtension: "nshc", subdirectory: "nsh"),
                  let configURL = Bundle.main.url(forResource: "capabilities", withExtension: "json", subdirectory: "nsh"),
                  let scenario = Bundle.main.object(forInfoDictionaryKey: "HistoryScenario") as? String else { throw HistoryProductionHost.failure("bundle") }
            let host = try HistoryProductionHost(scenario: scenario); self.host = host
            host.onEvent = { [weak self] name, value in self?.surface.send(name, value) }
            cacheCleanup = AuthorizationCacheCleanupBridge(app: surface, pending: { [] }, afterSweep: { [weak host] in
                guard let host else { throw CancellationError() }; host.completeStartupSweep()
            })
            for method in HistoryProductionHost.methods {
                surface.handle(method) { [weak host] input async throws -> Any? in guard let host else { throw CancellationError() }; return try host.call(method, input) }
            }
            appearance = AppearanceBridge(app: surface, selectedHost: { HistoryProductionHost.hostID })
            FeedbackLayoutBridge.install(on: surface)
            if host.observerDisabled {
                NativeSheetLifecycleAudit.shared.setEnabled(true)
                host.sheetLifecycleAudit = { NativeSheetLifecycleAudit.shared.snapshot }
                let diagnosticDirectory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("history-production", isDirectory: true)
                for file in ["ready.json", "capture.json", "control.json", "control-ack.json", "clock-ack.json"] {
                    guard !FileManager.default.fileExists(atPath: diagnosticDirectory.appendingPathComponent(file).path) else { throw HistoryProductionHost.failure("ui_parity_requires_fresh_artifact") }
                }
                for method in HistoryProductionHost.uiParityControlMethods {
                    surface.handle(method) { [weak host] input async throws -> Any? in guard let host else { throw CancellationError() }; return try host.call(method, input) }
                }
                try writeUIParityAudit(trigger: "startup")
            } else {
                observer = try HistoryProductionObserver(surface: surface, host: host)
            }
            // This is the build's exact grant ceiling, not production wildcard capabilities.
            try surface.grantCapabilities(String(decoding: Data(contentsOf: configURL), as: UTF8.self))
            let storage = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("HistorySyntheticStorage", isDirectory: true)
            try FileManager.default.createDirectory(at: storage, withIntermediateDirectories: true); surface.storageDirectory = storage
            try surface.loadBundle(at: bundle)
        } catch { fail() }
    }
    private func fail() {
        observer?.fail()
        let label = UILabel(); label.accessibilityIdentifier = "hp-native-error"; label.text = "history_production_fixture_native_failure"; label.textColor = .red
        label.frame = CGRect(x: 12, y: 60, width: 360, height: 44); view.addSubview(label)
    }
    override var preferredStatusBarStyle: UIStatusBarStyle { NshAppView.preferredStatusBarStyle }
    private func writeUIParityAudit(trigger: String) throws {
        guard let host, host.observerDisabled else { return }
        let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("ui-parity", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var audit = try JSONSerialization.jsonObject(with: host.uiParityAuditData()) as! [String: Any]
        audit["processNonce"] = uiParityProcessNonce
        audit["auditTrigger"] = trigger
        audit["nativeUptimeMs"] = ProcessInfo.processInfo.systemUptime * 1000
        audit["artifact"] = ["bundleID": Bundle.main.bundleIdentifier ?? "", "buildID": Bundle.main.object(forInfoDictionaryKey: "HistoryBuildID") as? String ?? ""]
        let data = try HistoryProductionHost.json(audit)
        guard data.count <= 65536 else { throw HistoryProductionHost.failure("ui_parity_audit_size") }
        try data.write(to: directory.appendingPathComponent("ui-parity-audit.json"), options: .atomic)
    }
    func flush() {
        if host?.observerDisabled == true {
            do { try writeUIParityAudit(trigger: "background") } catch { fail() }
        } else { try? observer?.flush() }
    }
}
@MainActor private final class HistoryProductionDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    func application(_ app: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let navigation = UINavigationBarAppearance(); navigation.configureWithDefaultBackground(); navigation.backgroundColor = .clear; navigation.shadowColor = .clear
        UINavigationBar.appearance().standardAppearance = navigation; UINavigationBar.appearance().scrollEdgeAppearance = navigation
        UINavigationBar.appearance().compactAppearance = navigation; UINavigationBar.appearance().compactScrollEdgeAppearance = navigation
        let tab = UITabBarAppearance(); tab.configureWithDefaultBackground(); tab.backgroundColor = .clear; tab.shadowColor = .clear
        UITabBar.appearance().standardAppearance = tab; UITabBar.appearance().scrollEdgeAppearance = tab
        let window = UIWindow(frame: UIScreen.main.bounds); window.rootViewController = HistoryProductionController(); window.makeKeyAndVisible(); self.window = window; return true
    }
    func applicationDidEnterBackground(_ app: UIApplication) { (window?.rootViewController as? HistoryProductionController)?.flush() }
}
@main private struct HistoryProductionMain {
    static func main() { UIApplicationMain(CommandLine.argc, CommandLine.unsafeArgv, nil, NSStringFromClass(HistoryProductionDelegate.self)) }
}
