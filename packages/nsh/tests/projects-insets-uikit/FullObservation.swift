import Foundation
import UIKit
import NativeShell

@MainActor private final class FullInsetsAnchorView: UIView {
    var key = ""
    weak var observation: FullInsetsObservation?
    override func didMoveToWindow() { super.didMoveToWindow(); if window != nil { observation?.schedule("anchor-mounted:" + key) } }
    override func layoutSubviews() { super.layoutSubviews(); if window != nil { observation?.schedule("anchor-layout:" + key) } }
}
@MainActor private final class FullInsetsAnchor: NshComponent {
    let anchor = FullInsetsAnchorView(frame: .zero)
    var view: UIView { anchor }
    init(observation: FullInsetsObservation) { anchor.observation = observation; anchor.isUserInteractionEnabled = false; anchor.isAccessibilityElement = false }
    func setProp(_ name: String, _ value: Any?) { if name == "probeName", let value = value as? String { anchor.key = value } }
}

@MainActor final class FullInsetsObservation {
    static weak var current: FullInsetsObservation?
    private weak var surface: NshAppView?
    private var sequence = 0, scheduled = false, scheduledCount = 0
    private var snapshots: [[String: Any]] = [], consumerMarker = ""
    private let nonce = UUID().uuidString
    private var expectedMarker: String { Bundle.main.object(forInfoDictionaryKey: "HistoryInsetsMarker") as? String ?? "missing" }
    init(surface: NshAppView) {
        self.surface = surface; Self.current = self
        surface.register(component: "fixture.insets.anchor") { [weak self] _ in
            guard let self else { preconditionFailure("Insets fixture retired before component creation") }; return FullInsetsAnchor(observation: self)
        }
        surface.handle("fixture.insets.consumer") { [weak self] input async throws -> Any? in
            guard let self, let value = input as? [String: Any], value.count == 1, let marker = value["marker"] as? String else { throw HistoryProductionHost.failure("insets_consumer_invalid") }
            self.consumerMarker = marker; self.schedule("ProjectsHome-function-consumed"); return ["matches": marker == self.expectedMarker]
        }
        surface.handle("fixture.insets.report") { [weak self] input async throws -> Any? in
            guard let self, let core = input as? [String: Any], let request = core["request"] as? [String: Any], let id = request["captureID"] as? Int,
                  let index = self.snapshots.firstIndex(where: { $0["sequence"] as? Int == id }) else { throw HistoryProductionHost.failure("insets_capture_retired") }
            self.snapshots[index]["coreResponse"] = core
            self.snapshots[index]["coreResponseNativeMs"] = ProcessInfo.processInfo.systemUptime * 1000
            self.snapshots[index]["nativeAtCoreResponse"] = self.nativeGeometry()
            try self.write(); return ["captureID": id]
        }
    }
    func schedule(_ reason: String) {
        guard !scheduled, scheduledCount < 24 else { return }
        scheduled = true; scheduledCount += 1
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }; self.scheduled = false; self.capture(reason, requestCore: true)
        }
    }
    func capture(_ reason: String, requestCore: Bool = false) {
        sequence += 1
        snapshots.append(["sequence": sequence, "reason": reason, "nativeMs": ProcessInfo.processInfo.systemUptime * 1000, "native": nativeGeometry()])
        if snapshots.count > 48 { snapshots.removeFirst() }
        try? write()
        if requestCore { surface?.send("fixture.insets.capture", ["captureID": sequence, "reason": reason, "expectedMarker": expectedMarker]) }
    }
    private func token(_ node: UIView) -> String { String(UInt(bitPattern: ObjectIdentifier(node)), radix: 16) }
    private func rect(_ r: CGRect) -> [String: CGFloat] { ["x": r.minX, "y": r.minY, "width": r.width, "height": r.height] }
    private func inset(_ i: UIEdgeInsets) -> [String: CGFloat] { ["top": i.top, "left": i.left, "bottom": i.bottom, "right": i.right] }
    private func geometry(_ node: UIView, surface: UIView, window: UIWindow) -> [String: Any] {
        var result: [String: Any] = ["token": token(node), "publicIdentifier": node.accessibilityIdentifier as Any? ?? NSNull(), "parentToken": node.superview.map(token) as Any? ?? NSNull(), "frame": rect(node.frame), "bounds": rect(node.bounds), "windowRect": rect(node.convert(node.bounds, to: window)), "surfaceRect": rect(node.convert(node.bounds, to: surface)), "safeAreaInsets": inset(node.safeAreaInsets), "layoutMargins": inset(node.layoutMargins), "isSurface": node === surface, "isScrollView": node is UIScrollView, "hidden": node.isHidden, "alpha": node.alpha, "attachedToWindow": node.window === window]
        if let scroll = node as? UIScrollView {
            result["scroll"] = ["contentSize": ["width": scroll.contentSize.width, "height": scroll.contentSize.height], "contentOffset": ["x": scroll.contentOffset.x, "y": scroll.contentOffset.y], "contentInset": inset(scroll.contentInset), "adjustedContentInset": inset(scroll.adjustedContentInset), "contentLayoutGuide": rect(scroll.contentLayoutGuide.layoutFrame), "frameLayoutGuide": rect(scroll.frameLayoutGuide.layoutFrame)]
        }
        return result
    }
    private func nativeGeometry() -> [String: Any] {
        guard let surface, let window = surface.window else { return ["attached": false] }
        var queue: [(UIView, Int)] = [(surface, 0)], hierarchy: [[String: Any]] = [], anchors: [[String: Any]] = []
        while !queue.isEmpty && hierarchy.count < 512 {
            let (node, depth) = queue.removeFirst(); var row = geometry(node, surface: surface, window: window); row["depth"] = depth; hierarchy.append(row)
            if let anchor = node as? FullInsetsAnchorView {
                var chain: [[String: Any]] = [], cursor: UIView? = anchor
                while let item = cursor, chain.count < 32 { chain.append(geometry(item, surface: surface, window: window)); if item === surface { break }; cursor = item.superview }
                let host = anchor.superview, owner = host?.superview
                anchors.append(["key": anchor.key, "chainToSurface": chain, "structuralOwnerToken": owner.map(token) as Any? ?? NSNull(), "hostContainsRegistration": host?.subviews.contains(where: { $0 === anchor }) == true, "ownerContainsHost": owner?.subviews.contains(where: { $0 === host }) == true])
            }
            queue.append(contentsOf: node.subviews.map { ($0, depth + 1) })
        }
        var ancestorChain: [[String: Any]] = [], cursor: UIView? = surface
        while let node = cursor, ancestorChain.count < 32 { ancestorChain.append(geometry(node, surface: surface, window: window)); if node === window { break }; cursor = node.superview }
        return ["attached": true, "applicationActive": UIApplication.shared.applicationState == .active, "sceneActivationState": window.windowScene?.activationState.rawValue as Any? ?? NSNull(), "window": geometry(window, surface: surface, window: window), "surface": geometry(surface, surface: surface, window: window), "surfaceAncestorChain": ancestorChain, "hierarchy": hierarchy, "anchors": anchors, "capacityExceeded": !queue.isEmpty]
    }
    private func write() throws {
        let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("full-projects-insets", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let data: [String: Any] = ["schema": 2, "bundleID": Bundle.main.bundleIdentifier ?? "missing", "buildID": Bundle.main.object(forInfoDictionaryKey: "HistoryBuildID") as? String ?? "missing", "processNonce": nonce, "pid": ProcessInfo.processInfo.processIdentifier, "expectedConsumerMarker": expectedMarker, "observedConsumerMarker": consumerMarker, "consumerMarkerMatches": consumerMarker == expectedMarker, "snapshots": snapshots, "scope": "full Home/Nav/Tab/history synthetic Host; metadata only; synchronous native before/after and separately timestamped core response; no geometry/appearance/AX writes"]
        try JSONSerialization.data(withJSONObject: data, options: [.prettyPrinted, .sortedKeys]).write(to: directory.appendingPathComponent("report.json"), options: .atomic)
    }
}
