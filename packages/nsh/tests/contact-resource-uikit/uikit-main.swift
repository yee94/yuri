import Foundation
import CryptoKit
import UIKit
import NativeShell

@MainActor private final class ContactPreviewMemory {
    let scope = RuntimeHostScope(hostID: "synthetic-contact-preview", lease: UUID())
    var active = true, generation = 7
    private var files: [String: (Data, String, String)] = [:], counts: [String: Int] = [:]
    init() {
        let format = UIGraphicsImageRendererFormat(); format.scale = 1
        let image = UIGraphicsImageRenderer(size: CGSize(width: 768, height: 4096), format: format).image { context in
            UIColor.systemBackground.setFill(); context.fill(CGRect(x: 0, y: 0, width: 768, height: 4096))
            for index in 0..<16 {
                (index.isMultiple(of: 2) ? UIColor.systemBlue : UIColor.systemGreen).setFill()
                context.fill(CGRect(x: 24, y: CGFloat(index * 256 + 16), width: 720, height: 128))
                ("Synthetic image section \(index + 1)" as NSString).draw(at: CGPoint(x: 32, y: CGFloat(index * 256 + 160)), withAttributes: [.font: UIFont.systemFont(ofSize: 28), .foregroundColor: UIColor.label])
            }
        }
        files["png"] = (image.pngData()!, "image/png", "synthetic-long.png")
        let pdf = UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: 612, height: 792)).pdfData { context in
            for index in 1...3 { context.beginPage(); ("Synthetic attachment PDF page \(index)" as NSString).draw(at: CGPoint(x: 32, y: 48), withAttributes: [.font: UIFont.systemFont(ofSize: 24)]) }
        }
        files["pdf"] = (pdf, "application/pdf", "synthetic.pdf")
    }
    func count(_ key: String) { counts[key, default: 0] += 1 }
    func admit(_ expected: RuntimeHostScope) throws { guard active, expected == scope else { count("rejected"); throw RuntimeHostScopeFailure.stale } }
    func select(_ input: Any?) throws -> [String: Any] {
        guard let kind = (input as? [String: Any])?["kind"] as? String, let file = files[kind] else { throw RuntimeHostScopeFailure.invalid }
        return ["expectedHost": scope.publicValue, "file": ["kind": "contact", "hostID": scope.hostID, "assistantID": "synthetic-contact", "type": "file", "attachmentID": "att_" + kind,
            "sha256": SHA256.hash(data: file.0).map { String(format: "%02x", $0) }.joined(), "size": file.0.count, "mime": file.1, "filename": file.2, "name": file.2, "generation": 7]]
    }
    func read(_ route: String, limit: Int) throws -> (status: Int, mime: String, data: Data) {
        let response: (Int, String, Data)
        if route == "/api/yuri/assistants/synthetic-contact/contact/messages?limit=1" {
            count("generationReads"); response = (200, "application/json", try JSONSerialization.data(withJSONObject: ["generation": generation, "messages": []]))
        } else if let kind = ["png", "pdf"].first(where: { route == "/api/yuri/assistants/synthetic-contact/contact/attachments/att_" + $0 }), let file = files[kind] {
            count("rawBytesReads")
            response = generation == 7 ? (200, file.1, file.0) : (404, "application/json", Data())
        } else { count("rejected"); throw RuntimeHostScopeFailure.invalid }
        guard response.2.count <= limit else { count("rejected"); throw RuntimeHostScopeFailure.invalid }
        return response
    }
    func reset() { generation += 1; count("contactResets") }
    func audit() -> [String: Any] { ["syntheticOnly": true, "generation": generation, "counts": counts, "originalsRetained": files.count] }
}
@MainActor private final class ContactPreviewFixtureController: UIViewController {
    private let surface = NshAppView(), memory = ContactPreviewMemory()
    private var resources: ResourceBridge?
    override func viewDidLoad() {
        super.viewDidLoad(); view.backgroundColor = .systemBackground
        surface.translatesAutoresizingMaskIntoConstraints = false; view.addSubview(surface)
        NSLayoutConstraint.activate([surface.topAnchor.constraint(equalTo: view.topAnchor), surface.bottomAnchor.constraint(equalTo: view.bottomAnchor), surface.leadingAnchor.constraint(equalTo: view.leadingAnchor), surface.trailingAnchor.constraint(equalTo: view.trailingAnchor)])
        surface.onOpenURL = { _ in false }; surface.onError = { [weak self] _ in self?.fail() }
        do {
            guard let bundle = Bundle.main.url(forResource: "bundle", withExtension: "nshc", subdirectory: "nsh") else { throw RuntimeHostScopeFailure.invalid }
            let memory = self.memory
            surface.handle("fixture.contactResource.select") { input async throws -> Any? in try memory.select(input) }
            surface.handle("fixture.contactResource.reset") { _ async throws -> Any? in memory.reset(); return true }
            surface.handle("fixture.contactResource.audit") { _ async throws -> Any? in memory.audit() }
            let resources = try ResourceBridge(controller: self, capture: { expected in
                try memory.admit(expected)
                return ResourceTransport(read: { route, limit in try memory.admit(expected); return try memory.read(route, limit: limit) }, isCurrent: { memory.active && expected == memory.scope })
            })
            self.resources = resources; resources.install(on: surface)
            let methods = ["resources.read", "resources.present", "resources.release", "resources.cancel", "resources.close", "fixture.contactResource.select", "fixture.contactResource.reset", "fixture.contactResource.audit"]
            try surface.grantCapabilities(String(data: JSONSerialization.data(withJSONObject: ["host": methods]), encoding: .utf8)!)
            let storage = FileManager.default.temporaryDirectory.appendingPathComponent("SyntheticContactPreview-" + UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: storage, withIntermediateDirectories: true); surface.storageDirectory = storage
            surface.cacheOptions = NshCacheOptions(location: .off, images: .off)
            surface.params = ["contactResourceSyntheticOnly": true, "buildID": Bundle.main.object(forInfoDictionaryKey: "FixtureBuildID") ?? "unknown"]
            try surface.loadBundle(at: bundle)
        } catch { fail() }
    }
    func suspend() { memory.active = false; resources?.invalidate() }
    private func fail() {
        let label = UILabel(); label.text = "Synthetic contact fixture native failure"; label.accessibilityIdentifier = "contact-resource-native-failure"
        label.frame = view.bounds.insetBy(dx: 20, dy: 100); view.addSubview(label)
    }
}
@MainActor private final class ContactPreviewFixtureDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds); window.rootViewController = ContactPreviewFixtureController(); window.makeKeyAndVisible(); self.window = window; return true
    }
    func applicationDidEnterBackground(_ application: UIApplication) { (window?.rootViewController as? ContactPreviewFixtureController)?.suspend() }
}
@main private struct ContactPreviewFixtureMain {
    static func main() { UIApplicationMain(CommandLine.argc, CommandLine.unsafeArgv, nil, NSStringFromClass(ContactPreviewFixtureDelegate.self)) }
}
