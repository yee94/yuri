import Foundation
import UIKit
import NativeShell

@MainActor private final class InsetsAnchorView: UIView {
    var key = ""
}
@MainActor private final class InsetsAnchor: NshComponent {
    let anchor = InsetsAnchorView(frame: .zero)
    var view: UIView { anchor }
    init() { anchor.isUserInteractionEnabled = false; anchor.isAccessibilityElement = false }
    func setProp(_ name: String, _ value: Any?) { if name == "probeName", let value = value as? String { anchor.key = value } }
}
@MainActor private final class InsetsController: UIViewController {
    private let surface = NshAppView()
    private let status = UILabel(), capture = UIButton(type: .system)
    private var synthetic: ProjectsOrderSyntheticHost?
    private var snapshots: [[String: Any]] = []
    private var errors: [String] = []
    private var sequence = 0
    private var mode = "minimal"
    private var buildID: String { Bundle.main.object(forInfoDictionaryKey: "FixtureBuildID") as? String ?? "missing" }
    override func viewDidLoad() {
        super.viewDidLoad(); view.backgroundColor = .systemBackground
        let args = ProcessInfo.processInfo.arguments
        if let index = args.firstIndex(of: "--insets-mode"), args.indices.contains(index + 1), args[index + 1] == "production" { mode = "production" }
        status.numberOfLines = 2; status.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        status.accessibilityIdentifier = "insets-build-identity"
        status.text = "\(buildID)\n\(Bundle.main.bundleIdentifier ?? "missing") · \(mode)"
        capture.setTitle("Capture geometry", for: .normal); capture.accessibilityIdentifier = "insets-capture"
        capture.addTarget(self, action: #selector(requestCapture), for: .touchUpInside)
        for child in [status, capture, surface] { child.translatesAutoresizingMaskIntoConstraints = false; view.addSubview(child) }
        NSLayoutConstraint.activate([
            status.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 8), status.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -8), status.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor), status.heightAnchor.constraint(equalToConstant: 42),
            capture.topAnchor.constraint(equalTo: status.bottomAnchor), capture.leadingAnchor.constraint(equalTo: view.leadingAnchor), capture.trailingAnchor.constraint(equalTo: view.trailingAnchor), capture.heightAnchor.constraint(equalToConstant: 40),
            surface.topAnchor.constraint(equalTo: capture.bottomAnchor), surface.leadingAnchor.constraint(equalTo: view.leadingAnchor), surface.trailingAnchor.constraint(equalTo: view.trailingAnchor), surface.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
        surface.accessibilityIdentifier = "insets-nsh-surface"
        surface.onError = { [weak self] error in self?.errors.append(error); self?.status.text = error }
        surface.onOpenURL = { _ in false }
        surface.register(component: "fixture.insets.anchor") { _ in InsetsAnchor() }
        do {
            let seedURL = Bundle.main.url(forResource: "seed", withExtension: "json", subdirectory: "fixture")!
            let seed = try JSONSerialization.jsonObject(with: Data(contentsOf: seedURL)) as! [String: Any]
            let synthetic = try ProjectsOrderSyntheticHost(seed: seed); self.synthetic = synthetic
            let methods = ["connection.list", "runtime.request", "fixture.insets.report"]
            for method in methods where method != "fixture.insets.report" {
                surface.handle(method) { [weak synthetic] input async throws -> Any? in
                    guard let synthetic else { throw CancellationError() }; return try synthetic.call(method, input)
                }
            }
            surface.handle("fixture.insets.report") { [weak self] input async throws -> Any? in
                guard let self else { throw CancellationError() }; return try self.persist(input)
            }
            try surface.grantCapabilities(String(data: JSONSerialization.data(withJSONObject: ["host": methods]), encoding: .utf8))
            surface.params = ["mode": mode, "buildID": buildID]
            surface.cacheOptions = NshCacheOptions(location: .off, images: .off)
            try surface.loadBundle(at: Bundle.main.url(forResource: "bundle", withExtension: "nshc", subdirectory: "nsh")!)
        } catch { errors.append(String(describing: error)); status.text = String(describing: error) }
    }
    @objc private func requestCapture() { surface.send("fixture.insets.capture", ["buildID": buildID]) }
    private func rect(_ r: CGRect) -> [String: CGFloat] { ["x": r.minX, "y": r.minY, "width": r.width, "height": r.height] }
    private func inset(_ i: UIEdgeInsets) -> [String: CGFloat] { ["top": i.top, "left": i.left, "bottom": i.bottom, "right": i.right] }
    private func token(_ node: UIView) -> String { String(UInt(bitPattern: ObjectIdentifier(node)), radix: 16) }
    private func geometry(_ node: UIView, window: UIWindow) -> [String: Any] {
        var result: [String: Any] = ["token": token(node), "publicIdentifier": node.accessibilityIdentifier as Any? ?? NSNull(), "frame": rect(node.frame), "bounds": rect(node.bounds), "windowRect": rect(node.convert(node.bounds, to: window)), "surfaceRect": rect(node.convert(node.bounds, to: surface)), "safeAreaInsets": inset(node.safeAreaInsets), "layoutMargins": inset(node.layoutMargins), "isScrollView": node is UIScrollView, "isSurface": node === surface, "hidden": node.isHidden, "alpha": node.alpha, "attachedToWindow": node.window === window, "parentToken": node.superview.map(token) as Any? ?? NSNull()]
        if let scroll = node as? UIScrollView {
            result["scroll"] = ["contentSize": ["width": scroll.contentSize.width, "height": scroll.contentSize.height], "contentOffset": ["x": scroll.contentOffset.x, "y": scroll.contentOffset.y], "contentInset": inset(scroll.contentInset), "adjustedContentInset": inset(scroll.adjustedContentInset), "contentLayoutGuide": rect(scroll.contentLayoutGuide.layoutFrame), "frameLayoutGuide": rect(scroll.frameLayoutGuide.layoutFrame)]
        }
        return result
    }
    private func persist(_ core: Any?) throws -> Any {
        guard let window = view.window else { throw ProjectsOrderSyntheticHost.failure("Capture requires an attached window") }
        sequence += 1
        var queue: [(UIView, Int)] = [(surface, 0)], hierarchy: [[String: Any]] = [], anchors: [[String: Any]] = []
        var exhausted = false
        while !queue.isEmpty {
            if hierarchy.count >= 512 { exhausted = true; break }
            let (node, depth) = queue.removeFirst()
            var row = geometry(node, window: window); row["depth"] = depth; hierarchy.append(row)
            if let anchor = node as? InsetsAnchorView {
                var chain: [[String: Any]] = [], cursor: UIView? = anchor
                while let item = cursor, chain.count < 32 { chain.append(geometry(item, window: window)); if item === surface { break }; cursor = item.superview }
                let host = anchor.superview, owner = host?.superview
                anchors.append(["key": anchor.key, "registrationToken": token(anchor), "chainToSurface": chain,
                    "hostContainsRegistration": host?.subviews.contains(where: { $0 === anchor }) == true,
                    "ownerContainsHost": owner?.subviews.contains(where: { $0 === host }) == true,
                    "structuralOwnerToken": owner.map(token) as Any? ?? NSNull(),
                    "structuralOwnerIdentifierMatches": owner?.accessibilityIdentifier == anchor.key,
                    "binding": "explicit zero-size native component child; registration -> component host -> TSX owner; correlate complete chain with original ref.measure/onLayout, never AX text"])
            }
            queue.append(contentsOf: node.subviews.map { ($0, depth + 1) })
        }
        let snapshot: [String: Any] = ["sequence": sequence, "buildID": buildID, "bundleID": Bundle.main.bundleIdentifier ?? "missing", "pid": ProcessInfo.processInfo.processIdentifier, "mode": mode,
            "applicationActive": UIApplication.shared.applicationState == .active, "sceneActivationState": window.windowScene?.activationState.rawValue as Any? ?? NSNull(),
            "core": core ?? NSNull(), "window": geometry(window, window: window), "controller": geometry(view, window: window), "surface": geometry(surface, window: window), "hierarchy": hierarchy, "anchors": anchors, "capacityExceeded": exhausted, "errors": errors,
            "scope": "synthetic geometry only; no text/labels/body/AX tree read; UIView/UIScrollView public API; no geometry writes"]
        snapshots.append(snapshot); if snapshots.count > 12 { snapshots.removeFirst() }
        let document = ["schema": 1, "snapshots": snapshots] as [String: Any]
        let destination = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("projects-insets-report.json")
        try JSONSerialization.data(withJSONObject: document, options: [.prettyPrinted, .sortedKeys]).write(to: destination, options: .atomic)
        status.text = "\(buildID) · \(mode)\nCaptured \(sequence) · \(anchors.count) anchors"
        return ["captured": sequence, "filename": destination.lastPathComponent, "buildID": buildID]
    }
}
@MainActor private final class InsetsDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds); window.rootViewController = InsetsController(); window.makeKeyAndVisible(); self.window = window; return true
    }
}
@main private struct InsetsMain {
    static func main() { UIApplicationMain(CommandLine.argc, CommandLine.unsafeArgv, nil, NSStringFromClass(InsetsDelegate.self)) }
}
