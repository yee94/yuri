import UIKit
import NativeShell
import CryptoKit
import Darwin

/// Pure admission facts for this synthetic observer; never a layout or AX identity ACK.
enum HistoryProductionObservationPolicy {
    static func navigationOwner(barInstances: [String], matchingOwners: [String], transcriptCount: Int) -> String? {
        guard transcriptCount == 1, barInstances.count == 1, matchingOwners.count == 1,
              barInstances[0] == matchingOwners[0] else { return nil }
        return barInstances[0]
    }
    static func syntheticFingerprint(_ label: String?, bodyID: String) -> String? {
        guard bodyID.range(of: "\\Abody-part-hp-[0-9]{4}:text:[0-9]+\\z", options: .regularExpression) != nil,
              let label, label.utf8.count <= 4096 else { return nil }
        let start = bodyID.index(bodyID.startIndex, offsetBy: 10)
        let message = String(bodyID[start..<bodyID.index(start, offsetBy: 7)])
        guard let index = Int(message.suffix(4)), index < 500 else { return nil }
        let marker = "ANCHOR " + message
        let prose = String(repeating: "A complete neutral paragraph exercises variable natural line wrapping without removing source content. ", count: 2 + index % 7)
        let known = [marker, marker + "\nno command is executed", prose,
                     "Synthetic question about ordered records, natural layout and a stable reading position.",
                     "1.", "2.", "3.", "Preserve identity", "Preserve order", "Observe native geometry"]
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        let canonical = label.trimmingCharacters(in: .whitespacesAndNewlines)
        guard known.contains(canonical) else { return nil }
        return SHA256.hash(data: Data(canonical.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

/// Full-rectangle coverage discovery; callers supply actual ancestor clipping, never a center hit substitute.
enum HistoryCoverageTraversal {
    struct Facts {
        let frame: CGRect, clip: CGRect
        let visible: Bool, geometryKnown: Bool, clipsChildren: Bool
    }
    struct Result { let blockers: [String]; let unknown: Bool; let inspected: Int }
    static func scan<Node>(roots: [Node], target: CGRect, capacity: Int,
                           facts: (Node) -> Facts, children: (Node) -> [Node], identity: (Node) -> String) -> Result {
        var stack = roots, inspected = 0, blockers: [String] = [], unknown = false
        guard capacity > 0, roots.count <= capacity else { return Result(blockers: [], unknown: true, inspected: 0) }
        while let node = stack.popLast() {
            guard inspected < capacity else { unknown = true; break }
            inspected += 1
            let current = facts(node)
            guard current.visible else { continue }
            guard current.geometryKnown else { unknown = true; continue }
            let visible = current.frame.intersection(current.clip)
            if !visible.isNull && !visible.isEmpty && visible.intersects(target) { blockers.append(identity(node)) }
            // Public bounds cannot bound arbitrary unclipped drawing, shadows, or layer descendants.
            // Even a disjoint sibling may have an out-of-bounds child over one corner of the text.
            if !current.clipsChildren { unknown = true }
            if current.clipsChildren && (visible.isNull || visible.isEmpty || !visible.intersects(target)) { continue }
            let descendants = children(node)
            guard descendants.count <= capacity - inspected - stack.count else { unknown = true; break }
            stack.append(contentsOf: descendants)
        }
        return Result(blockers: blockers, unknown: unknown, inspected: inspected)
    }
}

/// Bounded synthetic AX metadata instrumentation. Weak objects and never-reused tokens prevent pointer ABA.
final class HistoryDiagnosticAXLedger {
    struct Candidate {
        let view: AnyObject, body: AnyObject, outer: AnyObject
        let bodyID: String, label: String
        let isAXText: Bool, nested: Bool
        var ancestorChain: [AnyObject] = []
    }
    final class WeakObject { weak var object: AnyObject?; init(_ object: AnyObject) { self.object = object } }
    final class Binding {
        weak var view: AnyObject?, body: AnyObject?, outer: AnyObject?
        let token: String, generation: Int, bodyID: String, fingerprint: String, originalID: String?, label: String, assignedSequence: Int
        let ancestorChain: [WeakObject]
        var retirement: String?
        var assignmentReadbackKind: String?, assignmentReadbackNativeMs: Double?
        var firstRetirementObservation: [String: Any]?
        init(_ candidate: Candidate, token: String, generation: Int, originalID: String?, fingerprint: String, sequence: Int) {
            view = candidate.view; body = candidate.body; outer = candidate.outer
            self.token = token; self.generation = generation; self.originalID = originalID; self.fingerprint = fingerprint
            label = candidate.label; bodyID = candidate.bodyID; assignedSequence = sequence
            ancestorChain = candidate.ancestorChain.map { WeakObject($0) }
        }
    }
    let runNonce: String
    let capacity: Int, lifetimeCapacity: Int
    private(set) var bindings: [Binding] = []
    private(set) var generation = 0, issued = 0
    var sealed = false
    init(runNonce: String = UUID().uuidString, capacity: Int = 64, lifetimeCapacity: Int = 256) {
        self.runNonce = runNonce; self.capacity = capacity; self.lifetimeCapacity = lifetimeCapacity
    }
    func owns(_ identifier: String) -> Bool { bindings.contains { $0.token == identifier } }
    static func identifierKind(_ value: String?, token: String) -> String {
        value == token ? "ours" : value == nil ? "nil" : value == "" ? "empty" : "other"
    }
    func prepare(_ candidates: [Candidate], sequence: Int, stable: Bool,
                 readID: (AnyObject) -> String?, writeID: (AnyObject, String?) -> Void) -> [String: Any] {
        guard stable && !sealed else { return ["prepared": false, "reason": "prepare requires stable unsealed native window"] }
        var admitted: [(Candidate, String?, String)] = []
        for candidate in candidates {
            guard candidate.isAXText && !candidate.nested,
                  let fingerprint = HistoryProductionObservationPolicy.syntheticFingerprint(candidate.label, bodyID: candidate.bodyID) else { continue }
            let current = readID(candidate.view)
            let old = bindings.first { $0.view === candidate.view && $0.token == current }
            guard current == nil || current == "" || old != nil else { continue }
            let original: String?
            if let old { original = old.originalID } else { original = current }
            admitted.append((candidate, original, fingerprint))
        }
        guard admitted.count <= capacity, issued + admitted.count <= lifetimeCapacity,
              Set(admitted.map { ObjectIdentifier($0.0.view) }).count == admitted.count else {
            return ["prepared": false, "reason": "bounded AX registry capacity/duplicate candidate; no ID writes"]
        }
        // Only explicit preparation restores our IDs, never sampler/read/mark/gesture windows.
        for binding in bindings {
            if let view = binding.view, readID(view) == binding.token { writeID(view, binding.originalID) }
            binding.retirement = binding.retirement ?? "superseded by explicit prepare"
        }
        generation += 1
        let startIssued = issued
        for (candidate, original, fingerprint) in admitted {
            guard readID(candidate.view) == original else { return ["prepared": false, "reason": "application changed identifier during prepare", "assignedCount": issued - startIssued, "generation": generation, "partial": true] }
            issued += 1
            let token = "hpdiag-ax-" + runNonce + "-" + String(issued)
            let binding = Binding(candidate, token: token, generation: generation, originalID: original, fingerprint: fingerprint, sequence: sequence)
            bindings.append(binding); writeID(candidate.view, token)
            binding.assignmentReadbackKind = Self.identifierKind(readID(candidate.view), token: token)
            binding.assignmentReadbackNativeMs = ProcessInfo.processInfo.systemUptime * 1000
        }
        let assigned = bindings.filter { $0.generation == generation }
        let confirmed = assigned.filter { $0.assignmentReadbackKind == "ours" }.count
        return ["prepared": confirmed == assigned.count, "generation": generation, "assignedCount": admitted.count, "assignedSequence": sequence,
                "writeAttemptCount": assigned.count, "readbackConfirmedCount": confirmed,
                "reason": confirmed == assigned.count ? NSNull() : "public identifier getter did not immediately return assigned token" as Any,
                "assignmentReadbacks": assigned.map { ["token": $0.token, "kind": $0.assignmentReadbackKind as Any? ?? NSNull(), "nativeMs": $0.assignmentReadbackNativeMs as Any? ?? NSNull()] },
                "runNonce": runNonce, "instrumentation": "explicit synthetic accessibilityIdentifier writes; not readonly"]
    }
    func validate(_ binding: Binding, candidate: Candidate?, currentID: String?) -> String? {
        if let reason = binding.retirement { return reason }
        let reason: String?
        if binding.view == nil || binding.body == nil || binding.outer == nil { reason = "weak object retired" }
        else if currentID != binding.token { reason = "application identifier changed" }
        else if let candidate, binding.view === candidate.view, binding.body === candidate.body, binding.outer === candidate.outer,
                binding.bodyID == candidate.bodyID, binding.label == candidate.label, candidate.isAXText, !candidate.nested,
                binding.ancestorChain.count == candidate.ancestorChain.count,
                zip(binding.ancestorChain, candidate.ancestorChain).allSatisfy({ $0.object === $1 }) { reason = nil }
        else { reason = "object/text/body/transcript/AX/nested membership changed" }
        if let reason { binding.retirement = reason }
        return reason
    }
}

/// Public object membership and geometry only; no private-class recognition or AX-tree guessing.
@MainActor enum HistoryProductionWindowObservation {
    static func instance(_ object: AnyObject) -> String { String(UInt(bitPattern: ObjectIdentifier(object)), radix: 16) }
    static func rect(_ value: CGRect) -> Any {
        guard !value.isNull, !value.isInfinite, [value.minX, value.minY, value.width, value.height].allSatisfy({ $0.isFinite }) else { return NSNull() }
        return ["x": value.minX, "y": value.minY, "width": value.width, "height": value.height]
    }
    private static func transform(_ value: CATransform3D) -> [CGFloat] {
        [value.m11, value.m12, value.m13, value.m14, value.m21, value.m22, value.m23, value.m24,
         value.m31, value.m32, value.m33, value.m34, value.m41, value.m42, value.m43, value.m44]
    }
    static func chain(_ view: UIView, to window: UIWindow) -> [UIView] {
        var result: [UIView] = [], cursor: UIView? = view
        while let current = cursor {
            result.append(current)
            if current === window { break }
            cursor = current.superview
        }
        return result
    }
    private static func presentationRect(_ view: UIView, to target: UIView) -> Any {
        guard let layer = view.layer.presentation(), let targetLayer = target.layer.presentation() else { return NSNull() }
        func root(_ layer: CALayer) -> CALayer {
            var value = layer
            while let parent = value.superlayer { value = parent }
            return value
        }
        guard root(layer) === root(targetLayer) else { return NSNull() }
        return rect(layer.convert(layer.bounds, to: targetLayer))
    }
    static func geometry(_ view: UIView, surface: UIView, window: UIWindow) -> [String: Any] {
        let path = chain(view, to: window), attached = path.last === window && view.window === window
        var clip = window.bounds, effectiveAlpha: CGFloat = 1
        var hidden = false, transformed = false, animated = false, masked = false
        var ancestry: [[String: Any]] = []
        for ancestor in path {
            let frame = ancestor.convert(ancestor.bounds, to: window)
            effectiveAlpha *= ancestor.alpha; hidden = hidden || ancestor.isHidden
            transformed = transformed || !ancestor.transform.isIdentity || !CATransform3DIsIdentity(ancestor.layer.transform) || !CATransform3DIsIdentity(ancestor.layer.sublayerTransform)
            let animationCount = ancestor.layer.animationKeys()?.count ?? 0
            let presentation = ancestor.layer.presentation()
            let presentationDiffers = presentation.map {
                $0.bounds != ancestor.layer.bounds || $0.position != ancestor.layer.position ||
                    $0.opacity != ancestor.layer.opacity || !CATransform3DEqualToTransform($0.transform, ancestor.layer.transform) ||
                    !CATransform3DEqualToTransform($0.sublayerTransform, ancestor.layer.sublayerTransform)
            } ?? false
            animated = animated || animationCount > 0 || presentationDiffers
            masked = masked || ancestor.layer.mask != nil
            if ancestor.clipsToBounds { clip = clip.intersection(frame) }
            ancestry.append(["instance": instance(ancestor), "runtimeClass": NSStringFromClass(type(of: ancestor)),
                             "frameInWindow": rect(frame), "hidden": ancestor.isHidden, "alpha": ancestor.alpha,
                             "clipsToBounds": ancestor.clipsToBounds, "hasLayerMask": ancestor.layer.mask != nil,
                             "transform": [ancestor.transform.a, ancestor.transform.b, ancestor.transform.c, ancestor.transform.d, ancestor.transform.tx, ancestor.transform.ty],
                             "layerTransform": transform(ancestor.layer.transform), "sublayerTransform": transform(ancestor.layer.sublayerTransform),
                             "layerOpacity": ancestor.layer.opacity, "animationCount": animationCount,
                             "presentationAvailable": presentation != nil, "presentationDiffers": presentationDiffers])
        }
        let clipped = clip.intersection(view.convert(view.bounds, to: window))
        let modelVisible = attached && !hidden && effectiveAlpha > 0.01 && !clipped.isNull && !clipped.isEmpty
        return ["instance": instance(view), "runtimeClass": NSStringFromClass(type(of: view)), "windowInstance": instance(window),
                "sameWindow": attached, "bounds": rect(view.bounds), "frameInWindow": rect(view.convert(view.bounds, to: window)),
                "frameInSurface": rect(view.convert(view.bounds, to: surface)), "hidden": view.isHidden, "alpha": view.alpha,
                "ancestorVisibility": ancestry, "effectiveAlpha": effectiveAlpha, "effectiveHidden": hidden,
                "clippedRectInWindow": rect(clipped), "visibleRectInWindow": modelVisible ? rect(clipped) : NSNull(),
                "modelVisible": modelVisible, "hasTransforms": transformed, "hasAnimation": animated, "hasLayerMask": masked,
                "presentationFrameInWindow": presentationRect(view, to: window), "presentationFrameInSurface": presentationRect(view, to: surface),
                "modelGeometryUnambiguous": attached && !transformed && !animated && !masked,
                "occlusion": "not evaluated; clipped bounds are not visual exposure ACK"]
    }
    static func read(surface: UIView, sequence: Int, includeTextProofs: Bool = true, includeLiveSafety: Bool = false, includeScrollInsets: Bool = false,
                     controlContext: HistoryV4ControlReadContext? = nil,
                     textOwner: ((UIView, UIView, UIScrollView) -> Void)? = nil) -> [String: Any] {
        let started = HistoryProductionClock.now()
        func observedGeometry(_ view: UIView, window: UIWindow) -> [String: Any] {
            controlContext?.geometry(view) ?? geometry(view, surface: surface, window: window)
        }
        func identifier(_ view: UIView) -> String? {
            if let controlContext { return controlContext.identifier(view) }
            return view.accessibilityIdentifier
        }
        guard let window = surface.window else {
            return ["contract": "window-header-v1", "sequence": sequence, "readStartNativeMs": started,
                    "readEndNativeMs": HistoryProductionClock.now(), "windowInstance": NSNull(), "surfaceInstance": instance(surface),
                    "windowSafeAreaInsets": NSNull(), "navigationBars": [], "navigationOwnership": "unknown; surface has no window",
                    "selectedNavigationBarInstance": NSNull(), "navigationBarCount": 0, "transcriptInstances": [], "nativeTextOwners": []]
        }
        var bars: [UINavigationBar] = [], transcripts: [UIScrollView] = [], texts: [UIView] = []
        let composerIDs: Set<String> = ["chat-composer-expanded", "chat-composer-compact"]
        let headerIDs: Set<String> = ["chat-header-root", "chat-header-row", "chat-header-metadata", "chat-header-options", "chat-header-back", "BackButton"]
        var protectionViews: [UIView] = [], modalViews: [UIView] = []
        var visitedViews = 0, discoveryOverflow = false
        func visit(_ view: UIView, insideSurface: Bool = false) {
            guard visitedViews < 8192 else { discoveryOverflow = true; return }
            visitedViews += 1
            let belongs = controlContext == nil ? view.isDescendant(of: surface) : insideSurface || view === surface
            if includeLiveSafety {
                if composerIDs.contains(identifier(view) ?? "") || headerIDs.contains(identifier(view) ?? "") { protectionViews.append(view) }
                if view.accessibilityViewIsModal { modalViews.append(view) }
            }
            if let bar = view as? UINavigationBar { bars.append(bar) }
            if belongs {
                if let scroll = view as? UIScrollView, identifier(scroll) == "transcript" { transcripts.append(scroll) }
                if includeTextProofs && (view is UILabel || view is UITextView || view.isAccessibilityElement && view.accessibilityTraits.contains(.staticText)) {
                    if texts.count < 256 { texts.append(view) } else { discoveryOverflow = true }
                }
            }
            for child in view.subviews { visit(child, insideSurface: belongs) }
        }
        visit(window)
        var controllers: [UINavigationController] = [], visited: Set<ObjectIdentifier> = []
        var presentedControllers: [String] = [], controllerTransition = false
        func visitController(_ controller: UIViewController) {
            guard visited.insert(ObjectIdentifier(controller)).inserted else { return }
            if includeLiveSafety {
                if let presented = controller.presentedViewController { presentedControllers.append(instance(presented)) }
                controllerTransition = controllerTransition || controller.isBeingPresented || controller.isBeingDismissed || controller.transitionCoordinator != nil
            }
            if let nav = controller as? UINavigationController { controllers.append(nav) }
            for child in controller.children { visitController(child) }
            if let presented = controller.presentedViewController { visitController(presented) }
        }
        if let root = window.rootViewController { visitController(root) }
        var owned: [String] = []
        let navigationBars: [[String: Any]] = bars.map { bar in
            let readStart = HistoryProductionClock.now()
            let owners = controllers.filter { $0.isViewLoaded && $0.navigationBar === bar }
            let current = owners.filter { nav in
                guard transcripts.count == 1, let top = nav.topViewController?.viewIfLoaded, top.window === window,
                      let navView = nav.viewIfLoaded, navView.window === window else { return false }
                return transcripts[0].isDescendant(of: top) && transcripts[0].isDescendant(of: navView)
            }
            if owners.count == 1 && current.count == 1 { owned.append(instance(bar)) }
            var value = observedGeometry(bar, window: window)
            value["owningNavigationControllerInstances"] = owners.map { instance($0) }
            value["currentTranscriptOwnerInstances"] = current.map { instance($0) }
            value["isNavigationBarHidden"] = owners.count == 1 ? owners[0].isNavigationBarHidden as Any : NSNull()
            value["navigationTransitionInProgress"] = owners.contains { $0.transitionCoordinator != nil }
            value["readStartNativeMs"] = readStart; value["readEndNativeMs"] = HistoryProductionClock.now()
            return value
        }
        let selected = discoveryOverflow ? nil : HistoryProductionObservationPolicy.navigationOwner(barInstances: bars.map { instance($0) }, matchingOwners: owned, transcriptCount: transcripts.count)
        var unsupported = 0
        let nativeTextOwners: [[String: Any]] = texts.compactMap { text in
            let path = chain(text, to: window)
            let bodies = path.filter { ($0.accessibilityIdentifier ?? "").range(of: "\\Abody-part-hp-[0-9]{4}:text:[0-9]+\\z", options: .regularExpression) != nil }
            guard bodies.count == 1, transcripts.count == 1, let body = bodies.first,
                  text.isDescendant(of: body), body.isDescendant(of: transcripts[0]),
                  let bodyID = body.accessibilityIdentifier, let outerIndex = path.firstIndex(where: { $0 === transcripts[0] }) else { return nil }
            let readStart = HistoryProductionClock.now()
            // Read only the public accessibility label; never export arbitrary text, even as a hash.
            let fingerprint = HistoryProductionObservationPolicy.syntheticFingerprint(text.accessibilityLabel, bodyID: bodyID)
            if fingerprint == nil { unsupported += 1 }
            let outer = transcripts[0]
            textOwner?(text, body, outer)
            let outerPath = path.prefix(through: outerIndex)
            let nested = outerPath.compactMap { $0 as? UIScrollView }.filter { $0 !== outer }
            var value = observedGeometry(text, window: window)
            value["publicTextKind"] = text is UILabel ? "UILabel" : text is UITextView ? "UITextView" : "UIView with public staticText accessibility trait"
            value["isAccessibilityElement"] = text.isAccessibilityElement
            value["hasStaticTextTrait"] = text.accessibilityTraits.contains(.staticText)
            value["accessibilityFrameInScreen"] = rect(text.accessibilityFrame)
            value["accessibilityFrameInWindow"] = rect(window.convert(text.accessibilityFrame, from: window.screen.coordinateSpace))
            value["bodyID"] = bodyID; value["bodyInstance"] = instance(body); value["outerTranscriptInstance"] = instance(outer)
            value["ancestorInstancesToOuterTranscript"] = outerPath.map { instance($0) }
            value["nestedScrollInstances"] = nested.map { instance($0) }
            value["syntheticTextSHA256"] = fingerprint as Any? ?? NSNull()
            value["syntheticTextProof"] = fingerprint == nil ? "unavailable; label outside exact synthetic allowlist" : "exact fixture allowlist; trimmed UTF-8 SHA256"
            value["axIdentityBinding"] = "unavailable; external AX tree has no shared object identity; fingerprint/frame is correspondence only"
            value["readStartNativeMs"] = readStart; value["readEndNativeMs"] = HistoryProductionClock.now()
            return value
        }
        let insets = window.safeAreaInsets
        var result: [String: Any] = ["contract": "window-header-v1", "sequence": sequence, "readStartNativeMs": started,
                "windowInstance": instance(window), "surfaceInstance": instance(surface), "windowBounds": rect(window.bounds),
                "surfaceInWindow": rect(surface.convert(surface.bounds, to: window)),
                "windowSafeAreaInsets": ["top": insets.top, "left": insets.left, "bottom": insets.bottom, "right": insets.right],
                "navigationBars": navigationBars, "navigationBarCount": bars.count, "transcriptInstances": transcripts.map { instance($0) },
                "navigationOwnership": selected == nil ? "unknown; need one discovered bar and one exact current transcript/controller owner" : "unique public UIKit object membership; visibility evaluated separately",
                "selectedNavigationBarInstance": selected as Any? ?? NSNull(), "nativeTextOwners": nativeTextOwners,
                "discoveryOverflow": discoveryOverflow, "unsupportedSyntheticTextCount": unsupported, "textExport": "no raw text or unallowlisted digests", "sdkAdoptionIdentity": NSNull()]
        if controlContext != nil { result["discoveryVisitedViews"] = visitedViews; result["discoveryDescendantQueries"] = 0 }
        if includeLiveSafety {
            let protections = protectionViews.map { view -> [String: Any] in
                var value = observedGeometry(view, window: window)
                value["id"] = view.accessibilityIdentifier ?? ""
                return value
            }
            let visibleModalViews = modalViews.filter { observedGeometry($0, window: window)["modelVisible"] as? Bool == true }
            let windows = window.windowScene?.windows ?? UIApplication.shared.windows
            let otherWindows = windows.filter { $0 !== window && !$0.isHidden && $0.alpha > 0.01 && $0.screen === window.screen && $0.windowLevel >= window.windowLevel }
            var outer: Any = NSNull()
            if transcripts.count == 1 {
                let scrollReadStart = includeScrollInsets ? HistoryProductionClock.now() : 0
                let scroll = transcripts[0], pan = scroll.panGestureRecognizer
                let translation = pan.translation(in: window)
                var observation: [String: Any] = ["instance": instance(scroll), "geometry": observedGeometry(scroll, window: window),
                         "offsetX": scroll.contentOffset.x, "offsetY": scroll.contentOffset.y, "tracking": scroll.isTracking,
                         "dragging": scroll.isDragging, "decelerating": scroll.isDecelerating, "panState": pan.state.rawValue,
                          "panTranslationX": translation.x, "panTranslationY": translation.y] as [String: Any]
                if includeScrollInsets {
                    let content = scroll.contentInset, adjusted = scroll.adjustedContentInset
                    observation["contentInset"] = HistoryV4TypedGeometry.insets(content)
                    observation["adjustedContentInset"] = HistoryV4TypedGeometry.insets(adjusted)
                    observation["readStartNativeMs"] = scrollReadStart
                    observation["readEndNativeMs"] = HistoryProductionClock.now()
                }
                outer = observation
            }
            result["liveProtection"] = ["contract": "control-safety-v1", "composerBounds": protections.filter { composerIDs.contains($0["id"] as? String ?? "") },
                "headerBounds": protections.filter { headerIDs.contains($0["id"] as? String ?? "") }, "outerTranscript": outer,
                "presentedControllerInstances": presentedControllers, "modalViewInstances": visibleModalViews.map { instance($0) },
                "otherWindowInstances": otherWindows.map { instance($0) }, "controllerTransition": controllerTransition,
                "coverageKnown": !discoveryOverflow && window.rootViewController != nil && windows.contains(where: { $0 === window }) && window.isKeyWindow && UIApplication.shared.applicationState == .active,
                "unknownCoverage": discoveryOverflow || window.rootViewController == nil || !otherWindows.isEmpty]
        }
        result["readEndNativeMs"] = HistoryProductionClock.now()
        return result
    }
    static func siblingCoverage(text: UIView, surface: UIView, window: UIWindow, capacity: Int = 8192) -> HistoryCoverageTraversal.Result {
        let path = chain(text, to: window), target = text.convert(text.bounds, to: window)
        guard path.count <= capacity, path.last === window else { return .init(blockers: [], unknown: true, inspected: 0) }
        var roots: [UIView] = [], discovery = path.count
        for branch in path {
            guard let parent = branch.superview else { continue }
            let siblings = parent.subviews
            guard siblings.count <= capacity - discovery, let index = siblings.firstIndex(where: { $0 === branch }) else {
                return .init(blockers: [], unknown: true, inspected: discovery)
            }
            discovery += siblings.count
            for (position, sibling) in siblings.enumerated() where sibling !== branch &&
                (sibling.layer.zPosition > branch.layer.zPosition || sibling.layer.zPosition == branch.layer.zPosition && position > index) {
                roots.append(sibling)
            }
        }
        let result = HistoryCoverageTraversal.scan(roots: roots, target: target, capacity: capacity - discovery, facts: { view in
            let observation = geometry(view, surface: surface, window: window)
            var clip = window.bounds
            for ancestor in chain(view, to: window) where ancestor !== view && ancestor.clipsToBounds {
                clip = clip.intersection(ancestor.convert(ancestor.bounds, to: window))
            }
            return .init(frame: view.convert(view.bounds, to: window), clip: clip,
                visible: observation["sameWindow"] as? Bool == true && observation["effectiveHidden"] as? Bool == false && (observation["effectiveAlpha"] as? CGFloat ?? 0) > 0.01,
                geometryKnown: observation["modelGeometryUnambiguous"] as? Bool == true, clipsChildren: view.clipsToBounds)
        }, children: { $0.subviews }, identity: { instance($0) })
        return .init(blockers: result.blockers, unknown: result.unknown, inspected: discovery + result.inspected)
    }
    static func liveCoverage(text: UIView, outer: UIScrollView, surface: UIView, window: UIWindow, observedCoverage: HistoryCoverageTraversal.Result? = nil) -> [String: Any] {
        let coverage = observedCoverage ?? siblingCoverage(text: text, surface: surface, window: window)
        let target = text.convert(text.bounds, to: window)
        let hit = window.hitTest(CGPoint(x: target.midX, y: target.midY), with: nil)
        var hitBelongsToOuter = false
        if let hit, hit.isDescendant(of: outer) {
            let route = chain(hit, to: window)
            if let index = route.firstIndex(where: { $0 === outer }) { hitBelongsToOuter = !route.prefix(index).contains { $0 is UIScrollView } }
        }
        return ["known": !coverage.unknown, "unknownCoverage": coverage.unknown || !coverage.blockers.isEmpty || !hitBelongsToOuter,
                "aboveSiblingInstances": coverage.blockers, "hitBelongsToOuter": hitBelongsToOuter,
                "inspectedCoverageNodes": coverage.inspected,
                "scope": "bounded public above-sibling subtrees and actual clip chains; unclipped drawing unknown; hit route is supplemental only"]
    }
}

enum HistoryIdentityProbePolicy {
    static let maximumFrames = 24
    static let targetSpanMs: Double = 275
    static let maximumDurationMs: Double = 600
    static func needsFrame(count: Int, elapsedMs: Double) -> Bool {
        elapsedMs.isFinite && elapsedMs >= 0 && count < maximumFrames && elapsedMs < targetSpanMs
    }
    static func deadlineAllowsRead(elapsedMs: Double) -> Bool {
        elapsedMs.isFinite && elapsedMs >= 0 && elapsedMs <= maximumDurationMs
    }
}

/// UIKit diagnostic sampler; explicit prepare-ax writes only synthetic AX IDs, never layout/scroll state.
@MainActor final class HistoryProductionObserver: NSObject {
    @MainActor private final class PanTrace: NSObject {
        private(set) var generation = 0, boundaryRevision = 0
        @objc func observed(_ pan: UIPanGestureRecognizer) {
            if pan.state == .began { generation += 1 }
            if pan.state != .changed { boundaryRevision += 1 }
        }
    }
    private final class WeakNode { weak var view: UIView?; let role: String; init(_ view: UIView, _ role: String) { self.view = view; self.role = role } }
    private weak var surface: NshAppView?
    private let host: HistoryProductionHost
    private let clock = HistoryProductionClock()
    private var link: CADisplayLink?, watcher: DispatchSourceFileSystemObject?
    private var frames: [[String: Any]] = [], events: [[String: Any]] = []
    private var seen: Set<String> = [], controlNonces: Set<String> = []
    private var sequence = 0, overflow = false, revision = 0, nativeFailure = false
    private var controlAncestors: [String: WeakNode] = [:]
    private var panTraces: [ObjectIdentifier: PanTrace] = [:]
    private let directory: URL, identity: [String: Any]
    private let processNonce = UUID().uuidString
    private let diagnosticAX = HistoryDiagnosticAXLedger()
    private var exportV4: HistoryV4CapturePipeline?
    private let identityOnly: Bool
    private let readPhases: Bool
    private var initializationPhases: [String: Double] = [:]
    private var identityPreparing = false, identityPrepareIssued = false
    init(surface: NshAppView, host: HistoryProductionHost) throws {
        self.surface = surface; self.host = host
        let v4 = Bundle.main.object(forInfoDictionaryKey: "HistoryObserverSchema") as? String == "v4"
        let profile = Bundle.main.object(forInfoDictionaryKey: "HistoryObserverProfile") as? String ?? "continuous"
        guard ["continuous", "identity-only"].contains(profile), profile != "identity-only" || v4 else { throw HistoryProductionHost.failure("observer_profile") }
        identityOnly = profile == "identity-only"
        readPhases = v4 && Bundle.main.object(forInfoDictionaryKey: "HistoryReadPhases") as? Bool == true
        directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent(v4 ? "history-production-v4" : "history-production", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        func hash(_ file: URL?) throws -> String {
            guard let file else { throw HistoryProductionHost.failure("identity") }
            return SHA256.hash(data: try Data(contentsOf: file)).map { String(format: "%02x", $0) }.joined()
        }
        identity = ["buildID": Bundle.main.object(forInfoDictionaryKey: "HistoryBuildID") ?? NSNull(),
                    "bundleSHA256": try hash(Bundle.main.url(forResource: "bundle", withExtension: "nshc", subdirectory: "nsh")), "executableSHA256": try hash(Bundle.main.executableURL)]
        super.init()
        if v4 {
            let start = readPhases ? HistoryProductionClock.now() : 0
            exportV4 = try HistoryV4CapturePipeline(directory: directory.appendingPathComponent("segments", isDirectory: true))
            if readPhases { initializationPhases = ["pipelineInitStartNativeMs": start, "pipelineInitEndNativeMs": HistoryProductionClock.now()] }
        }
        host.onRecord = { [weak self] event in self?.recordEvent(event) }
        surface.handle("history.qa.ready") { [weak self] value async throws -> Any? in
            guard let self, let value = value as? [String: Any], value.isEmpty else { throw HistoryProductionHost.failure("ready") }
            var ready: [String: Any] = ["sidecarLoaded": true, "productionAdopted": false, "identity": self.identity, "processNonce": self.processNonce]
            if self.exportV4 != nil { ready["diagnosticRevision"] = "control-read-sharing-v2"; ready["scrollInsetsRevision"] = "scroll-insets-v1"; ready["readPhases"] = self.readPhases }
            if self.readPhases { ready["initializationPhases"] = self.initializationPhases }
            if self.identityOnly { ready["observerProfile"] = "identity-only"; ready["periodicSampling"] = false; ready["automaticInput"] = false }
            try self.write(ready, "ready.json")
            return true
        }
        surface.handle("history.qa.clock") { [weak self] value async throws -> Any? in guard let self else { throw CancellationError() }; return try self.clock.reply(value) }
        surface.handle("history.qa.clockAck") { [weak self] value async throws -> Any? in
            guard let self else { throw CancellationError() }
            let ack = try self.clock.acknowledge(value)
            try self.persistControl(ack.merging(["identity": self.identity, "processNonce": self.processNonce]) { _, next in next }, name: "clock-ack.json", kind: "clock")
            return true
        }
        let fd = open(directory.path, O_EVTONLY)
        guard fd >= 0 else { throw HistoryProductionHost.failure("control_watch") }
        let watcher = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: .write, queue: .main)
        watcher.setEventHandler { [weak self] in self?.readControl() }; watcher.setCancelHandler { close(fd) }; watcher.resume(); self.watcher = watcher
        if !identityOnly {
            let link = CADisplayLink(target: self, selector: #selector(sample(_:)))
            if #available(iOS 15.0, *) { link.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 60, preferred: 60) }
            link.add(to: .main, forMode: .common); self.link = link
        }
    }
    private func write(_ value: Any, _ name: String) throws { try HistoryProductionHost.json(value).write(to: directory.appendingPathComponent(name), options: .atomic) }
    private func recordEvent(_ value: [String: Any]) {
        guard let exporter = exportV4 else { events.append(value); return }
        guard exporter.stopped == nil, exporter.failure == nil else { return }
        do { try exporter.append(kind: "event", value: HistorySnapshotValue.freeze(value)) }
        catch { nativeFailure = true; exporter.stop("event_snapshot_failure"); writeExportFailure(error) }
    }
    private func exportMetadata() throws -> HistorySnapshotValue {
        try HistorySnapshotValue.freeze(["synthetic": true, "identity": identity, "scenario": host.scenario,
            "observerContract": "history-native-segments-v4; control-safety-v1; identifier-immediate-readback-v1; sibling-subtree-coverage-v1; scroll-insets-v1; native-freeze-v1; control-read-sharing-v2",
            "diagnosticRevision": "control-read-sharing-v2", "scrollInsetsRevision": "scroll-insets-v1",
            "sdkIdentifierWritePort": "independent SDK owner; public getter readback is authoritative, not adoption",
            "readPhases": readPhases, "initializationPhases": initializationPhases,
            "processNonce": processNonce, "overflow": overflow, "nativeFailure": nativeFailure, "host": host.snapshot,
            "ackAuthority": "durable export prefix only; not layout or SDK adoption",
            "observerProfile": identityOnly ? "identity-only" : "continuous", "periodicSampling": !identityOnly,
            "observationUnknowns": ["authoritative before/after row-key adoption is not observed",
                "row-local text anchor is not separately observed", "no public SDK adoption observer port; scroll_applied would only be an internal scroll count"],
            "production53ptVerdict": "unresolved", "sdkAdoptionIdentity": NSNull()] as [String: Any])
    }
    private func writeExportFailure(_ error: Error, nonce: String? = nil) {
        guard let exporter = exportV4 else { return }
        nativeFailure = true; link?.invalidate()
        if exporter.stopped == nil { exporter.stop("control_or_writer_failure") }
        try? write(["invalid": true, "schema": "history-native-segments-v4", "code": String(describing: error),
            "nonce": nonce as Any? ?? NSNull(), "lastReadSequence": sequence, "lastCapturedSequence": exporter.sequence,
            "lastDurableSequence": exporter.durableSequence, "lastCapturedOrdinal": exporter.ordinal,
            "lastDurableOrdinal": exporter.durableOrdinal, "stopReason": exporter.stopped as Any? ?? NSNull(),
            "nativeMs": HistoryProductionClock.now()], "failure.json")
        if exporter.failure == nil { try? flush() }
    }
    private func persistControl(_ ack: [String: Any], name: String = "control-ack.json", kind: String = "control", frozenResult: HistorySnapshotValue? = nil) throws {
        guard let exporter = exportV4 else { try write(ack, name); return }
        guard let nonce = ack["nonce"] as? String else { throw HistoryProductionHost.failure("v4_ack_nonce") }
        // Full control read, not just its phase, is part of the durable prefix before any success ACK.
        if exporter.stopped == nil || ack["command"] as? String == "flush" {
            if let frozenResult {
                var header = ack; header.removeValue(forKey: "result")
                var value = try HistoryV4NativeSnapshotValue.freeze(header).object!
                value["result"] = frozenResult
                try exporter.append(kind: kind, value: .object(value))
            } else { try exporter.append(kind: kind, value: HistorySnapshotValue.freeze(ack)) }
        }
        else { throw HistoryProductionHost.failure("v4_capture_stopped_no_control_ack") }
        let metadata = try exportMetadata()
        let ticket = try exporter.requestFence(nonce: nonce, metadata: metadata)
        Task { [weak self] in
            do {
                let receipt = try await ticket.value()
                guard let self else { return }
                var saved = ack
                saved["revision"] = receipt.revision; saved["durableOrdinal"] = receipt.ordinal
                saved["durableSequence"] = receipt.sequence; saved["manifest"] = receipt.manifest; saved["manifestSHA256"] = receipt.sha256
                saved["ackNativeMs"] = HistoryProductionClock.now()
                try self.write(saved, name)
            } catch {
                self?.writeExportFailure(error, nonce: nonce)
            }
        }
    }
    private func axCandidate(_ text: UIView, surface: UIView, context: HistoryV4ControlReadContext? = nil) -> HistoryDiagnosticAXLedger.Candidate? {
        guard let window = surface.window, text.window === window, text.isDescendant(of: surface) else { return nil }
        func identifier(_ view: UIView) -> String? { if let context { return context.identifier(view) }; return view.accessibilityIdentifier }
        let path = context?.chain(text) ?? HistoryProductionWindowObservation.chain(text, to: window)
        let bodies = path.filter { (identifier($0) ?? "").range(of: "\\Abody-part-hp-[0-9]{4}:text:[0-9]+\\z", options: .regularExpression) != nil }
        let outers = path.compactMap { $0 as? UIScrollView }.filter { identifier($0) == "transcript" }
        guard bodies.count == 1, outers.count == 1, let body = bodies.first, let outer = outers.first,
              body.isDescendant(of: outer), let outerIndex = path.firstIndex(where: { $0 === outer }), let bodyID = identifier(body) else { return nil }
        let nested = path.prefix(outerIndex).contains { $0 is UIScrollView }
        return .init(view: text, body: body, outer: outer, bodyID: bodyID, label: text.accessibilityLabel ?? "",
                     isAXText: text.isAccessibilityElement && text.accessibilityTraits.contains(.staticText), nested: nested,
                     ancestorChain: path.prefix(through: outerIndex).map { $0 as AnyObject })
    }
    private func axRead(surface: UIView, sequence: Int, origin: String = "control-read", readStart: Double? = nil, readStartCPU: Double? = nil, context: HistoryV4ControlReadContext? = nil) -> [String: Any] {
        let started = readStart ?? HistoryProductionClock.now()
        let phased = readPhases && origin == "control-read"
        let cpuStart = readStart != nil ? readStartCPU : phased ? HistoryV4NativeSnapshotValue.threadCPUms() : nil
        var window = HistoryProductionWindowObservation.read(surface: surface, sequence: sequence, includeTextProofs: false, includeLiveSafety: origin == "control-read", includeScrollInsets: exportV4 != nil, controlContext: context)
        window["observationKind"] = origin
        let windowEnd = phased ? HistoryProductionClock.now() : 0
        var bindingPhases: [[String: Any]] = []
        let bindings: [[String: Any]] = diagnosticAX.bindings.map { binding in
            let candidateStart = phased ? HistoryProductionClock.now() : 0
            let text = binding.view as? UIView
            let candidate = text.flatMap { axCandidate($0, surface: surface, context: context) }
            let candidateEnd = phased ? HistoryProductionClock.now() : 0
            let reason = diagnosticAX.validate(binding, candidate: candidate, currentID: text?.accessibilityIdentifier)
            if let reason, binding.firstRetirementObservation == nil {
                binding.firstRetirementObservation = ["sequence": sequence, "observationKind": origin, "nativeMs": HistoryProductionClock.now(),
                    "identifierKind": HistoryDiagnosticAXLedger.identifierKind(text?.accessibilityIdentifier, token: binding.token), "reason": reason]
            }
            var value: [String: Any] = ["token": binding.token, "generation": binding.generation, "bodyID": binding.bodyID,
                "fingerprint": binding.fingerprint, "assignedSequence": binding.assignedSequence, "valid": reason == nil,
                "originalIDKind": binding.originalID == nil ? "nil" : "empty", "retirementReason": reason as Any? ?? NSNull(),
                "assignmentReadbackKind": binding.assignmentReadbackKind as Any? ?? NSNull(), "assignmentReadbackNativeMs": binding.assignmentReadbackNativeMs as Any? ?? NSNull(),
                "firstRetirementObservation": binding.firstRetirementObservation as Any? ?? NSNull()]
            if let text, let nativeWindow = surface.window {
                let geometryStart = phased ? HistoryProductionClock.now() : 0
                value["geometry"] = context?.geometry(text) ?? HistoryProductionWindowObservation.geometry(text, surface: surface, window: nativeWindow)
                let geometryEnd = phased ? HistoryProductionClock.now() : 0
                value["viewInstance"] = HistoryProductionWindowObservation.instance(text)
                value["bodyInstance"] = binding.body.map { HistoryProductionWindowObservation.instance($0) } as Any? ?? NSNull()
                value["outerTranscriptInstance"] = binding.outer.map { HistoryProductionWindowObservation.instance($0) } as Any? ?? NSNull()
                value["nestedScroll"] = candidate?.nested ?? true
                value["isAXText"] = candidate?.isAXText ?? false
                value["ancestorInstancesToOuterTranscript"] = candidate?.ancestorChain.map { HistoryProductionWindowObservation.instance($0) } ?? []
                let accessibilityFrameStart = phased ? HistoryProductionClock.now() : 0
                value["accessibilityFrameInWindow"] = HistoryProductionWindowObservation.rect(nativeWindow.convert(text.accessibilityFrame, from: nativeWindow.screen.coordinateSpace))
                let coverageStart = phased ? HistoryProductionClock.now() : 0
                if origin == "control-read", let outer = candidate?.outer as? UIScrollView {
                    value["liveCoverage"] = context?.liveCoverage(text: text, outer: outer) ?? HistoryProductionWindowObservation.liveCoverage(text: text, outer: outer, surface: surface, window: nativeWindow)
                }
                if phased {
                    bindingPhases.append(["token": binding.token, "candidateStartNativeMs": candidateStart, "candidateEndNativeMs": candidateEnd,
                        "geometryStartNativeMs": geometryStart, "geometryEndNativeMs": geometryEnd, "accessibilityFrameStartNativeMs": accessibilityFrameStart,
                        "coverageStartNativeMs": coverageStart, "coverageEndNativeMs": HistoryProductionClock.now()])
                }
            }
            return value
        }
        var result: [String: Any] = ["contract": "synthetic-ax-id-v3", "instrumented": true, "runNonce": diagnosticAX.runNonce,
            "generation": diagnosticAX.generation, "lastPeriodicSequence": sequence, "readStartNativeMs": started, "observationKind": origin,
            "lastPeriodicReadEndNativeMs": origin == "control-read" ? frames.last?["readEndNativeMs"] ?? NSNull() : NSNull(),
            "windowObservation": window, "bindings": bindings, "sealed": diagnosticAX.sealed]
        if phased {
            var phases: [String: Any] = ["readStartNativeMs": started, "windowEndNativeMs": windowEnd, "bindings": bindingPhases]
            phases["readStartThreadCPUms"] = cpuStart as Any? ?? NSNull()
            phases["bindingsEndThreadCPUms"] = HistoryV4NativeSnapshotValue.threadCPUms() as Any? ?? NSNull()
            result["readPhases"] = phases
            var counts = context?.counts ?? [:]; counts["bindings"] = bindings.count; counts["fullBindingGeometryReads"] = bindingPhases.count
            result["readOperationCounts"] = counts
        }
        result["readEndNativeMs"] = HistoryProductionClock.now()
        return result
    }
    private func prepareAX(surface: UIView) -> [String: Any] {
        guard !nativeFailure && !overflow, let last = frames.last, let lastRead = last["readEndNativeMs"] as? Double,
              0 <= HistoryProductionClock.now() - lastRead && HistoryProductionClock.now() - lastRead <= 50 else {
            return ["prepared": false, "reason": "native sampler failed/overflowed/stale; no ID writes", "lastPeriodicSequence": sequence]
        }
        func headerSignature(_ observation: [String: Any]) -> [String: Any] {
            let keys = ["instance", "windowInstance", "frameInWindow", "frameInSurface", "isNavigationBarHidden", "navigationTransitionInProgress", "modelGeometryUnambiguous", "modelVisible", "effectiveHidden", "effectiveAlpha", "hasTransforms", "hasAnimation", "hasLayerMask"]
            return ["selected": observation["selectedNavigationBarInstance"] ?? NSNull(), "insets": observation["windowSafeAreaInsets"] ?? NSNull(),
                    "bars": (observation["navigationBars"] as? [[String: Any]] ?? []).map { bar in Dictionary(uniqueKeysWithValues: keys.map { ($0, bar[$0] ?? NSNull()) }) }]
        }
        let recent = frames.filter { ($0["nativeUptimeMs"] as? Double ?? 0) >= (frames.last?["nativeUptimeMs"] as? Double ?? 0) - 300 }
        var stable = recent.count >= 3 && (recent.last?["nativeUptimeMs"] as? Double ?? 0) - (recent.first?["nativeUptimeMs"] as? Double ?? 0) >= 250
        let reference = recent.first
        let referenceTranscripts = (reference?["scrolls"] as? [[String: Any]] ?? []).filter { $0["id"] as? String == "transcript" || $0["ownerID"] as? String == "transcript" }
        for (index, frame) in recent.enumerated() {
            if index > 0 {
                stable = stable && (frame["readEndNativeMs"] as? Double ?? .infinity) - (recent[index - 1]["nativeUptimeMs"] as? Double ?? 0) <= 50
            }
            stable = stable && NSDictionary(dictionary: frame["windowBounds"] as? [String: Any] ?? [:]).isEqual(to: reference?["windowBounds"] as? [String: Any] ?? [:])
            stable = stable && NSDictionary(dictionary: frame["surfaceInWindow"] as? [String: Any] ?? [:]).isEqual(to: reference?["surfaceInWindow"] as? [String: Any] ?? [:])
            stable = stable && !(frame["presentedController"] as? Bool ?? true)
            let transcripts = (frame["scrolls"] as? [[String: Any]] ?? []).filter { $0["id"] as? String == "transcript" || $0["ownerID"] as? String == "transcript" }
            if transcripts.count == 1 && referenceTranscripts.count == 1 {
                stable = stable && transcripts[0]["instance"] as? String == referenceTranscripts[0]["instance"] as? String && transcripts[0]["offsetY"] as? Double == referenceTranscripts[0]["offsetY"] as? Double
                stable = stable && NSDictionary(dictionary: transcripts[0]["frame"] as? [String: Any] ?? [:]).isEqual(to: referenceTranscripts[0]["frame"] as? [String: Any] ?? [:])
            } else { stable = false }
            stable = stable && NSDictionary(dictionary: headerSignature(frame["windowObservation"] as? [String: Any] ?? [:])).isEqual(to: headerSignature(reference?["windowObservation"] as? [String: Any] ?? [:]))
            for scroll in frame["scrolls"] as? [[String: Any]] ?? [] {
                stable = stable && !(scroll["tracking"] as? Bool ?? true) && !(scroll["dragging"] as? Bool ?? true) && !(scroll["decelerating"] as? Bool ?? true)
            }
        }
        let window = HistoryProductionWindowObservation.read(surface: surface, sequence: sequence, includeTextProofs: false)
        let bars = window["navigationBars"] as? [[String: Any]] ?? []
        stable = stable && window["selectedNavigationBarInstance"] is String && bars.count == 1 && bars[0]["modelGeometryUnambiguous"] as? Bool == true && bars[0]["navigationTransitionInProgress"] as? Bool == false
        stable = stable && NSDictionary(dictionary: headerSignature(window)).isEqual(to: headerSignature(reference?["windowObservation"] as? [String: Any] ?? [:]))
        if let currentWindow = surface.window {
            var count = 0
            func idle(_ view: UIView) -> Bool {
                count += 1; guard count <= 8192 else { return false }
                if let scroll = view as? UIScrollView, scroll.isTracking || scroll.isDragging || scroll.isDecelerating || scroll.panGestureRecognizer.state == .began || scroll.panGestureRecognizer.state == .changed { return false }
                return view.subviews.allSatisfy { idle($0) }
            }
            stable = stable && idle(currentWindow)
        } else { stable = false }
        guard stable && !diagnosticAX.sealed else { return ["prepared": false, "reason": "prepare requires 250ms stable idle/header baseline and unsealed window", "lastPeriodicSequence": sequence] }
        var candidates: [HistoryDiagnosticAXLedger.Candidate] = []
        let discovery = HistoryProductionWindowObservation.read(surface: surface, sequence: sequence) { text, _, _ in
            if let nativeWindow = surface.window, let candidate = self.axCandidate(text, surface: surface),
               HistoryProductionWindowObservation.geometry(text, surface: surface, window: nativeWindow)["modelVisible"] as? Bool == true { candidates.append(candidate) }
        }
        guard discovery["discoveryOverflow"] as? Bool == false else { return ["prepared": false, "reason": "bounded discovery overflow; no ID writes", "lastPeriodicSequence": sequence] }
        var result = diagnosticAX.prepare(candidates, sequence: sequence, stable: stable,
            readID: { ($0 as? UIView)?.accessibilityIdentifier }, writeID: { ($0 as? UIView)?.accessibilityIdentifier = $1 })
        result["lastPeriodicSequence"] = sequence; result["nativeMs"] = HistoryProductionClock.now()
        result["observedVisibleBodyChainCount"] = candidates.count
        return result
    }
    private func typedPeriodicRead(surface: UIView, sequence: Int) throws -> (window: [String: Any], typedWindow: HistorySnapshotValue, identity: HistorySnapshotValue, phases: [String: Double]) {
        let started = HistoryProductionClock.now()
        let windowCPUStart = readPhases ? HistoryV4NativeSnapshotValue.threadCPUms() : nil
        var window = HistoryProductionWindowObservation.read(surface: surface, sequence: sequence, includeTextProofs: false)
        let windowEnd = readPhases ? HistoryProductionClock.now() : 0
        let windowCPUEnd = readPhases ? HistoryV4NativeSnapshotValue.threadCPUms() : nil
        window["observationKind"] = "periodic"
        let typedWindow = try HistoryV4NativeSnapshotValue.freeze(window)
        let windowFreezeEnd = readPhases ? HistoryProductionClock.now() : 0
        let windowFreezeCPUEnd = readPhases ? HistoryV4NativeSnapshotValue.threadCPUms() : nil
        let bindings: [HistorySnapshotValue] = try diagnosticAX.bindings.map { binding in
            let text = binding.view as? UIView
            let candidate = text.flatMap { axCandidate($0, surface: surface) }
            let reason = diagnosticAX.validate(binding, candidate: candidate, currentID: text?.accessibilityIdentifier)
            if let reason, binding.firstRetirementObservation == nil {
                binding.firstRetirementObservation = ["sequence": sequence, "observationKind": "periodic", "nativeMs": HistoryProductionClock.now(),
                    "identifierKind": HistoryDiagnosticAXLedger.identifierKind(text?.accessibilityIdentifier, token: binding.token), "reason": reason]
            }
            let header: [String: Any] = ["token": binding.token, "generation": binding.generation, "bodyID": binding.bodyID,
                "fingerprint": binding.fingerprint, "assignedSequence": binding.assignedSequence, "valid": reason == nil,
                "originalIDKind": binding.originalID == nil ? "nil" : "empty", "retirementReason": reason as Any? ?? NSNull(),
                "assignmentReadbackKind": binding.assignmentReadbackKind as Any? ?? NSNull(), "assignmentReadbackNativeMs": binding.assignmentReadbackNativeMs as Any? ?? NSNull(),
                "firstRetirementObservation": binding.firstRetirementObservation as Any? ?? NSNull()]
            var value = try HistorySnapshotValue.freeze(header).object!
            if let text, let nativeWindow = surface.window {
                value["geometry"] = HistoryV4TypedGeometry.read(text, surface: surface, window: nativeWindow)
                value["viewInstance"] = .string(HistoryProductionWindowObservation.instance(text))
                value["bodyInstance"] = binding.body.map { .string(HistoryProductionWindowObservation.instance($0)) } ?? .null
                value["outerTranscriptInstance"] = binding.outer.map { .string(HistoryProductionWindowObservation.instance($0)) } ?? .null
                value["nestedScroll"] = .bool(candidate?.nested ?? true)
                value["isAXText"] = .bool(candidate?.isAXText ?? false)
                value["ancestorInstancesToOuterTranscript"] = .array(candidate?.ancestorChain.map { .string(HistoryProductionWindowObservation.instance($0)) } ?? [])
                value["accessibilityFrameInWindow"] = HistoryV4TypedGeometry.rect(nativeWindow.convert(text.accessibilityFrame, from: nativeWindow.screen.coordinateSpace))
            }
            return .object(value)
        }
        let identity: HistorySnapshotValue = .object(["contract": .string("synthetic-ax-id-v3"), "instrumented": .bool(true), "runNonce": .string(diagnosticAX.runNonce),
            "generation": .integer(Int64(diagnosticAX.generation)), "lastPeriodicSequence": .integer(Int64(sequence)), "readStartNativeMs": .doubleBits(started.bitPattern),
            "observationKind": .string("periodic"), "lastPeriodicReadEndNativeMs": .null, "windowObservationRef": .integer(Int64(sequence)),
            "bindings": .array(bindings), "sealed": .bool(diagnosticAX.sealed), "readEndNativeMs": .doubleBits(HistoryProductionClock.now().bitPattern)])
        var phases: [String: Double] = [:]
        if readPhases {
            phases = ["windowStartNativeMs": started, "windowEndNativeMs": windowEnd,
                "windowFreezeEndNativeMs": windowFreezeEnd, "bindingGeometryAndHeaderEndNativeMs": HistoryProductionClock.now()]
            phases["windowStartThreadCPUms"] = windowCPUStart; phases["windowEndThreadCPUms"] = windowCPUEnd
            phases["windowFreezeEndThreadCPUms"] = windowFreezeCPUEnd
        }
        return (window, typedWindow, identity, phases)
    }
    private func readControl() {
        guard !identityPreparing else { return }
        do {
            let file = directory.appendingPathComponent("control.json")
            guard FileManager.default.fileExists(atPath: file.path), let value = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any],
                  Set(value.keys).isSubset(of: ["nonce", "command", "anchors"]), let nonce = value["nonce"] as? String,
                  nonce.range(of: "^[a-zA-Z0-9-]{8,80}$", options: .regularExpression) != nil, let command = value["command"] as? String else { return }
            if controlNonces.contains(nonce) { return }
            guard controlNonces.count < 512 else { throw HistoryProductionHost.failure("control_limit") }
            controlNonces.insert(nonce)
            if identityOnly && command == "mark" { throw HistoryProductionHost.failure("identity_only_no_mark_or_pan") }
            if let exporter = exportV4, exporter.stopped != nil && command != "flush" { throw HistoryProductionHost.failure("v4_stopped_no_new_read") }
            if command == "clock" {
                guard value["anchors"] == nil else { throw HistoryProductionHost.failure("clock_arguments") }
                try clock.issue(nonce); surface?.send("history.qa.clock.request", ["nonce": nonce])
            } else if command == "prepare-ax" || command == "read-ax" {
                guard value["anchors"] == nil, let surface else { throw HistoryProductionHost.failure("ax_control_arguments") }
                if identityOnly && command == "prepare-ax" {
                    guard !identityPrepareIssued else { throw HistoryProductionHost.failure("identity_prepare_once_no_retry") }
                    identityPrepareIssued = true; identityPreparing = true
                    Task { [weak self] in
                        guard let self else { return }
                        defer { self.identityPreparing = false; self.readControl() }
                        do {
                            let baseline = try await self.collectIdentityBaseline()
                            var result = baseline["withinReadBudget"] as? Bool == true ? self.prepareAX(surface: surface) :
                                ["prepared": false, "reason": "explicit identity baseline exceeded unchanged 5ms read budget; no ID writes"]
                            result["identityBaseline"] = baseline
                            try self.persistControl(["nonce": nonce, "command": command, "nativeMs": HistoryProductionClock.now(),
                                "identity": self.identity, "processNonce": self.processNonce, "result": result])
                        } catch { self.writeExportFailure(error, nonce: nonce) }
                    }
                    return
                }
                let readStart = HistoryProductionClock.now()
                let readCPU = readPhases && command == "read-ax" ? HistoryV4NativeSnapshotValue.threadCPUms() : nil
                var context = exportV4 != nil && command == "read-ax" ? surface.window.map { HistoryV4ControlReadContext(surface: surface, window: $0) } : nil
                var result = command == "prepare-ax" ? prepareAX(surface: surface) : axRead(surface: surface, sequence: sequence, readStart: readStart, readStartCPU: readCPU, context: context)
                var frozenResult: HistorySnapshotValue?
                if exportV4 != nil && command == "read-ax" {
                    let freezeStart = readPhases ? HistoryProductionClock.now() : 0
                    var shadow = try context?.shadow(result) ?? result
                    if readPhases, let context {
                        var counts = context.counts
                        counts["bindings"] = (result["bindings"] as? [Any])?.count ?? 0
                        counts["fullBindingGeometryReads"] = (result["readOperationCounts"] as? [String: Int])?["fullBindingGeometryReads"] ?? 0
                        result["readOperationCounts"] = counts; shadow["readOperationCounts"] = counts
                    }
                    let shadowEnd = readPhases ? HistoryProductionClock.now() : 0
                    context?.finishRead()
                    context = nil
                    let contextReleaseEnd = readPhases ? HistoryProductionClock.now() : 0
                    var frozen = try HistoryV4NativeSnapshotValue.freeze(shadow).object!
                    if readPhases {
                        var phases = result["readPhases"] as? [String: Any] ?? [:]
                        phases["valueFreezeStartNativeMs"] = freezeStart; phases["valueFreezeEndNativeMs"] = HistoryProductionClock.now()
                        phases["typedShadowEndNativeMs"] = shadowEnd; phases["contextReleaseEndNativeMs"] = contextReleaseEnd
                        phases["valueFreezeEndThreadCPUms"] = HistoryV4NativeSnapshotValue.threadCPUms() as Any? ?? NSNull()
                        result["readPhases"] = phases; frozen["readPhases"] = try HistoryV4NativeSnapshotValue.freeze(phases)
                    }
                    let ended = HistoryProductionClock.now()
                    result["readEndNativeMs"] = ended; frozen["readEndNativeMs"] = .doubleBits(ended.bitPattern)
                    frozenResult = .object(frozen)
                }
                recordEvent(["phase": command, "nonce": nonce, "nativeUptimeMs": HistoryProductionClock.now(), "lastPeriodicSequence": sequence])
                try persistControl(["nonce": nonce, "command": command, "nativeMs": HistoryProductionClock.now(), "identity": identity,
                            "processNonce": processNonce, "result": result], frozenResult: frozenResult)
            } else if command == "mark" || command == "flush" {
                let anchors = value["anchors"] as? [String] ?? []
                if command == "mark" {
                    let nodes = frames.last?["nodes"] as? [[String: Any]] ?? []
                    guard anchors.count == 3, Set(anchors).count == 3, anchors.allSatisfy({ id in
                        let candidates = nodes.filter { $0["id"] as? String == id }
                        return (id.hasPrefix("body-part-") || id.hasPrefix("history-copy-") || id.hasPrefix("history-actions-")) && id.contains("hp-") && candidates.count == 1 && candidates[0]["fullyVisible"] as? Bool == true
                    }) else { throw HistoryProductionHost.failure("preselected_anchors") }
                    diagnosticAX.sealed = true
                } else if value["anchors"] != nil { throw HistoryProductionHost.failure("flush_arguments") }
                recordEvent(["phase": command, "nonce": nonce, "nativeUptimeMs": HistoryProductionClock.now(), "lastPeriodicSequence": sequence, "anchors": anchors])
                if command == "flush" && exportV4 == nil { try flush() }
                try persistControl(["nonce": nonce, "command": command, "nativeMs": HistoryProductionClock.now(), "revision": revision, "baselineSequence": sequence, "anchors": anchors])
            } else { throw HistoryProductionHost.failure("control_command") }
        } catch {
            if exportV4 != nil { writeExportFailure(error) }
            else { nativeFailure = true; try? write(["invalid": true, "code": error.localizedDescription, "nativeMs": HistoryProductionClock.now()], "failure.json") }
        }
    }
    private func rect(_ value: CGRect) -> [String: Double] { ["x": value.minX, "y": value.minY, "width": value.width, "height": value.height] }
    @objc private func sample(_ link: CADisplayLink) {
        captureFrame(displayTimestampMs: link.timestamp * 1000)
    }
    private func collectIdentityBaseline() async throws -> [String: Any] {
        let started = HistoryProductionClock.now(), firstSequence = sequence + 1
        var count = 0
        while HistoryIdentityProbePolicy.needsFrame(count: count, elapsedMs: HistoryProductionClock.now() - started) {
            try Task.checkCancellation()
            guard HistoryIdentityProbePolicy.deadlineAllowsRead(elapsedMs: HistoryProductionClock.now() - started),
                  !nativeFailure, exportV4?.stopped == nil else { throw HistoryProductionHost.failure("identity_baseline_stopped") }
            let before = sequence
            captureFrame(displayTimestampMs: nil)
            guard sequence == before + 1, !nativeFailure else { throw HistoryProductionHost.failure("identity_baseline_frame") }
            count += 1
            if HistoryProductionClock.now() - started < HistoryIdentityProbePolicy.targetSpanMs { try await Task.sleep(nanoseconds: 17_000_000) }
        }
        guard count >= 3, HistoryProductionClock.now() - started <= HistoryIdentityProbePolicy.maximumDurationMs else { throw HistoryProductionHost.failure("identity_baseline_deadline") }
        let reads = frames.filter { ($0["sequence"] as? Int ?? 0) >= firstSequence }.map { frame -> Double in
            (frame["readEndNativeMs"] as? Double ?? .infinity) - (frame["nativeUptimeMs"] as? Double ?? -.infinity)
        }
        return ["source": "explicit prepare-only native baseline; not a display-link recording", "periodicSampling": false,
            "frameCount": count, "firstSequence": firstSequence, "lastSequence": sequence, "nativeStartMs": started, "nativeEndMs": HistoryProductionClock.now(),
            "withinReadBudget": reads.count == count && reads.allSatisfy { $0.isFinite && $0 >= 0 && $0 <= 5 }]
    }
    private func captureFrame(displayTimestampMs: Double?) {
        guard let surface else { link?.invalidate(); return }
        let admissionStart = readPhases ? HistoryProductionClock.now() : 0
        if let exporter = exportV4 {
            guard exporter.beforeRead() else {
                overflow = true; link?.invalidate()
                // The display-link cap path only stops and queues work; no host snapshot or encoding here.
                Task { [weak self] in try? self?.flush() }
                return
            }
        } else if frames.count >= 18000 || events.count >= 20000 { overflow = true; link?.invalidate(); try? flush(); return }
        let started = HistoryProductionClock.now()
        let readCPUStart = readPhases ? HistoryV4NativeSnapshotValue.threadCPUms() : nil
        let initialPanTraceCount = panTraces.count
        var visitedViews = 0
        var insetGetterMs: Double = 0
        var nodes: [[String: Any]] = [], scrolls: [[String: Any]] = []
        func visit(_ view: UIView, _ hidden: Bool, _ clip: CGRect) {
            if readPhases { visitedViews += 1 }
            let hidden = hidden || view.isHidden || view.alpha <= 0.01
            let frame = view.convert(view.bounds, to: surface), id = view.accessibilityIdentifier ?? ""
            let instance = String(UInt(bitPattern: ObjectIdentifier(view)), radix: 16)
            let content = id.hasPrefix("body-part-") || id.hasPrefix("turn-body-") || id.hasPrefix("history-copy-") || id.hasPrefix("history-actions-") || id.hasPrefix("body-activity-") || id.hasPrefix("tool-")
            let control = ["transcript", "history-footer", "history-footer-natural", "history-load-older", "history-page-error", "history-refresh", "hp-native-error"].contains(id)
            if !hidden && (control || content && (frame.intersects(clip) || id.hasPrefix("body-part-") && id.contains("hp-0497"))) {
                nodes.append(["id": id, "instance": instance, "frame": rect(frame), "class": NSStringFromClass(type(of: view)), "visible": frame.intersects(clip), "fullyVisible": clip.contains(frame)])
                if ["history-load-older", "history-page-error", "history-refresh"].contains(id) {
                    var ancestor = view.superview, depth = 0
                    while let value = ancestor, value !== surface, depth < 8 {
                        let identity = String(UInt(bitPattern: ObjectIdentifier(value)), radix: 16)
                        if controlAncestors.count < 64 { controlAncestors[identity] = WeakNode(value, "ancestor-\(depth)-of-" + id) }
                        ancestor = value.superview; depth += 1
                    }
                }
            }
            if !hidden && content && !seen.contains(id + ":" + instance) {
                seen.insert(id + ":" + instance)
                recordEvent(["phase": "native-first-observed", "nativeUptimeMs": started, "id": id, "instance": instance, "visible": frame.intersects(clip),
                               "identityKind": "observed-UIView-not-SDK-adoption", "sdkMutationGeneration": NSNull()])
            }
            if !hidden, frame.intersects(clip), let scroll = view as? UIScrollView {
                let pan = scroll.panGestureRecognizer
                let panKey = ObjectIdentifier(pan)
                if panTraces[panKey] == nil && panTraces.count < 64 {
                    let trace = PanTrace(); panTraces[panKey] = trace
                    pan.addTarget(trace, action: #selector(PanTrace.observed(_:)))
                }
                let panStart = HistoryProductionClock.now()
                let translation = pan.translation(in: surface), velocity = pan.velocity(in: surface)
                var owner = view as UIView?, ownerID = ""
                while let candidate = owner, candidate !== surface {
                    if let identifier = candidate.accessibilityIdentifier, !identifier.isEmpty && !diagnosticAX.owns(identifier) { ownerID = identifier; break }
                    owner = candidate.superview
                }
                var observation: [String: Any] = ["id": id, "instance": instance, "frame": rect(frame), "offsetX": scroll.contentOffset.x, "offsetY": scroll.contentOffset.y, "contentHeight": scroll.contentSize.height,
                                 "ownerID": ownerID, "diagnosticIdentifier": diagnosticAX.owns(id) ? id as Any : NSNull(), "tracking": scroll.isTracking, "dragging": scroll.isDragging, "decelerating": scroll.isDecelerating,
                                "pan": ["instance": String(UInt(bitPattern: ObjectIdentifier(pan)), radix: 16), "state": pan.state.rawValue,
                                        "translationX": translation.x, "translationY": translation.y, "velocityX": velocity.x, "velocityY": velocity.y,
                                        "generation": panTraces[panKey]?.generation ?? 0, "boundaryRevision": panTraces[panKey]?.boundaryRevision ?? 0,
                                        "readStartNativeMs": panStart, "readEndNativeMs": HistoryProductionClock.now(), "coordinateSpace": "surface"]]
                if exportV4 != nil {
                    let insetStart = readPhases ? HistoryProductionClock.now() : 0
                    let content = scroll.contentInset, adjusted = scroll.adjustedContentInset
                    if readPhases { insetGetterMs += HistoryProductionClock.now() - insetStart }
                    observation["contentInset"] = HistoryV4TypedGeometry.insets(content)
                    observation["adjustedContentInset"] = HistoryV4TypedGeometry.insets(adjusted)
                    observation["readStartNativeMs"] = panStart
                    observation["readEndNativeMs"] = HistoryProductionClock.now()
                }
                scrolls.append(observation)
            }
            let childClip = view.clipsToBounds ? clip.intersection(frame) : clip
            for child in view.subviews { visit(child, hidden, childClip) }
        }
        visit(surface, false, surface.bounds); sequence += 1
        let traversalEnd = readPhases ? HistoryProductionClock.now() : 0
        let ancestry = controlAncestors.compactMap { identity, item -> [String: Any]? in
            guard let view = item.view else { return nil }
            return ["instance": identity, "role": item.role, "class": NSStringFromClass(type(of: view)), "frame": rect(view.convert(view.bounds, to: surface)), "hidden": view.isHidden]
        }
        let typedObservation: (window: [String: Any], typedWindow: HistorySnapshotValue, identity: HistorySnapshotValue, phases: [String: Double])?
        do { typedObservation = exportV4 == nil ? nil : try typedPeriodicRead(surface: surface, sequence: sequence) }
        catch {
            exportV4?.abortRead("typed_periodic_snapshot_failure"); link?.invalidate(); writeExportFailure(error); return
        }
        let diagnosticIdentity = typedObservation == nil ? axRead(surface: surface, sequence: sequence, origin: "periodic") : [:]
        let windowObservation = typedObservation?.window ?? diagnosticIdentity["windowObservation"] as? [String: Any] ?? [:]
        var frame: [String: Any] = ["sequence": sequence, "nativeUptimeMs": started, "readEndNativeMs": HistoryProductionClock.now(), "displayLinkTimestampMs": displayTimestampMs as Any? ?? NSNull(),
                       "screenScale": surface.window?.screen.scale ?? 0,
                       "windowBounds": rect(surface.window?.bounds ?? .zero), "surfaceInWindow": rect(surface.convert(surface.bounds, to: surface.window)),
                       "nodes": nodes, "scrolls": scrolls, "controlAncestors": ancestry, "windowObservation": windowObservation, "diagnosticIdentity": diagnosticIdentity, "nativeFailure": nativeFailure,
                         "presentedController": surface.window?.rootViewController?.presentedViewController != nil, "hostSequence": host.journal.last?["sequence"] ?? 0]
        if identityOnly { frame["samplingSource"] = "explicit-identity-baseline"; frame["historyDriverAdmission"] = false }
        let assemblyEnd = readPhases ? HistoryProductionClock.now() : 0
        if let exporter = exportV4 {
            do {
                var smallFrame = frame
                smallFrame.removeValue(forKey: "windowObservation"); smallFrame.removeValue(forKey: "diagnosticIdentity")
                let smallFreezeCPUStart = readPhases ? HistoryV4NativeSnapshotValue.threadCPUms() : nil
                var frozen = try HistoryV4NativeSnapshotValue.freeze(smallFrame).object!
                let smallFreezeCPUEnd = readPhases ? HistoryV4NativeSnapshotValue.threadCPUms() : nil
                guard let typedObservation else { throw HistoryV4Error.invalid("typed_periodic_missing") }
                frozen["windowObservation"] = typedObservation.typedWindow; frozen["diagnosticIdentity"] = typedObservation.identity
                if readPhases {
                    var phases = typedObservation.phases
                    phases["admissionStartNativeMs"] = admissionStart; phases["admissionEndNativeMs"] = started
                    phases["traversalEndNativeMs"] = traversalEnd; phases["assemblyEndNativeMs"] = assemblyEnd
                    phases["smallFrameFreezeEndNativeMs"] = HistoryProductionClock.now()
                    phases["insetGetterTotalMs"] = insetGetterMs
                    phases["smallFrameFreezeStartThreadCPUms"] = smallFreezeCPUStart; phases["smallFrameFreezeEndThreadCPUms"] = smallFreezeCPUEnd
                    phases["readStartThreadCPUms"] = readCPUStart
                    frozen["readPhases"] = try HistoryV4NativeSnapshotValue.freeze(phases)
                    frozen["readOperationCounts"] = try HistoryV4NativeSnapshotValue.freeze(["visitedViews": visitedViews, "scrolls": scrolls.count,
                        "insetGetterCalls": scrolls.count * 2, "newPanTraces": panTraces.count - initialPanTraceCount,
                        "bindings": diagnosticAX.bindings.count])
                    frozen["readEndThreadCPUms"] = HistoryV4NativeSnapshotValue.threadCPUms().map { .doubleBits($0.bitPattern) } ?? .null
                }
                let ended = HistoryProductionClock.now()
                frozen["readEndNativeMs"] = .doubleBits(ended.bitPattern); frame["readEndNativeMs"] = ended
                try exporter.append(kind: "frame", value: .object(frozen))
                if readPhases {
                    recordEvent(["phase": "diagnostic-frame-append", "sequence": sequence, "nativeStartMs": ended,
                        "nativeEndMs": HistoryProductionClock.now(), "scope": "main-actor append admission only; actor encoding/IO not measured here"])
                }
                // Only the existing 300ms preparation baseline is retained, with a hard 64-frame bound.
                frames.removeAll { ($0["nativeUptimeMs"] as? Double ?? 0) < started - 350 }
                if frames.count >= 64 { frames.removeFirst(frames.count - 63) }
            } catch { nativeFailure = true; exporter.abortRead("frame_snapshot_failure"); link?.invalidate(); writeExportFailure(error); try? flush() }
        }
        frames.append(frame)
    }
    func fail() {
        nativeFailure = true
        if let exporter = exportV4 { exporter.stop("native_failure"); link?.invalidate(); try? flush() }
    }
    func flush() throws {
        if let exporter = exportV4 {
            let metadata = try exportMetadata(), nonce = UUID().uuidString
            let ticket = try exporter.requestFence(nonce: nonce, metadata: metadata)
            Task { [weak self] in
                do { _ = try await ticket.value() }
                catch { self?.writeExportFailure(error, nonce: nonce) }
            }
            return
        }
        revision += 1
        try write(["schema": 1, "synthetic": true, "identity": identity, "scenario": host.scenario, "revision": revision,
                   "observerContract": "instrumented-v3; synthetic-ax-id-v3; control-safety-v1; identifier-immediate-readback-v1", "instrumentation": "explicit synthetic AX identifier metadata writes; not readonly",
                   "overflow": overflow, "nativeFailure": nativeFailure, "processNonce": processNonce, "nativeSnapshotMs": HistoryProductionClock.now(), "frames": frames, "events": events, "host": host.snapshot,
                   "sdkAdoptionIdentity": NSNull(), "production53ptVerdict": "unresolved"], "capture.json")
    }
}
