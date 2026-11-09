import UIKit

/// One synchronous read owns every sample and immutable audit value; nothing survives into the next read.
@MainActor final class HistoryV4ControlReadContext {
    private struct State {
        let bounds: CGRect, frame: CGRect, alpha: CGFloat
        let hidden: Bool, clips: Bool, sameWindow: Bool, transformed: Bool, animated: Bool, masked: Bool
        let transform: CGAffineTransform, layerTransform: CATransform3D, sublayerTransform: CATransform3D
        let opacity: Float, animationCount: Int, presentation: CALayer?, presentationDiffers: Bool
    }
    private struct Identifier { let value: String? }
    private struct Parent { let value: UIView? }
    private struct Branch { let roots: [UIView], siblingCount: Int, found: Bool }
    private let surface: UIView, window: UIWindow, bounds: CGRect
    private var states: [ObjectIdentifier: State] = [:], identifiers: [ObjectIdentifier: Identifier] = [:]
    private var parents: [ObjectIdentifier: Parent] = [:], paths: [ObjectIdentifier: [UIView]] = [:]
    private var branches: [ObjectIdentifier: Branch] = [:]
    private var audits: [String: [String: Any]] = [:]
    private let values = HistoryV4ControlValueSnapshot()
    private var geometries: [ObjectIdentifier: [String: Any]] = [:]
    private var viewReads = 0, viewHits = 0, auditReads = 0, auditHits = 0
    private var branchReads = 0, branchHits = 0, pathReads = 0, pathHits = 0, geometryReads = 0, geometryHits = 0, coverageUIReads = 0
    private var pathLinksRetained = 0
    private(set) var coverageReads = 0, inspectedCoverageNodes = 0
    private var readMemo: HistoryV4CoverageReadMemo<UIView>?
    private var memo: HistoryV4CoverageReadMemo<UIView> {
        if let readMemo { return readMemo }
        let value = HistoryV4CoverageReadMemo<UIView>(root: window, bounds: bounds) { [unowned self] view in
            let before = self.viewReads, value = self.state(view)
            self.coverageUIReads += self.viewReads - before
            return .init(parent: self.parent(view), frame: value.frame, alpha: value.alpha,
                hidden: value.hidden, clips: value.clips, transformed: value.transformed, animated: value.animated,
                masked: value.masked, sameWindow: value.sameWindow)
        }
        readMemo = value; return value
    }
    init(surface: UIView, window: UIWindow) { self.surface = surface; self.window = window; bounds = window.bounds }
    func identifier(_ view: UIView) -> String? {
        let key = ObjectIdentifier(view)
        if let value = identifiers[key] { return value.value }
        let value = view.accessibilityIdentifier
        if identifiers.count < 8192 { identifiers[key] = .init(value: value) }
        return value
    }
    private func parent(_ view: UIView) -> UIView? {
        let key = ObjectIdentifier(view)
        if let value = parents[key] { return value.value }
        let value = view.superview
        if parents.count < 8192 { parents[key] = .init(value: value) }
        return value
    }
    func chain(_ view: UIView) -> [UIView] {
        let key = ObjectIdentifier(view)
        if let value = paths[key] { pathHits += 1; return value }
        pathReads += 1
        var value: [UIView] = [], cursor: UIView? = view
        while let current = cursor {
            if let tail = paths[ObjectIdentifier(current)] { value.append(contentsOf: tail); break }
            value.append(current); if current === window { break }; cursor = parent(current)
        }
        if pathLinksRetained + value.count <= 8192 { paths[key] = value; pathLinksRetained += value.count }
        return value
    }
    private func state(_ view: UIView) -> State {
        let key = ObjectIdentifier(view)
        if let value = states[key] { viewHits += 1; return value }
        viewReads += 1
        let layer = view.layer, presentation = layer.presentation(), localBounds = view.bounds
        let differs = presentation.map {
            $0.bounds != layer.bounds || $0.position != layer.position || $0.opacity != layer.opacity ||
                !CATransform3DEqualToTransform($0.transform, layer.transform) || !CATransform3DEqualToTransform($0.sublayerTransform, layer.sublayerTransform)
        } ?? false
        let transform = view.transform, layerTransform = layer.transform, sublayerTransform = layer.sublayerTransform
        let animationCount = layer.animationKeys()?.count ?? 0
        let value = State(bounds: localBounds, frame: view.convert(localBounds, to: window), alpha: view.alpha,
            hidden: view.isHidden, clips: view.clipsToBounds, sameWindow: view.window === window,
            transformed: !transform.isIdentity || !CATransform3DIsIdentity(layerTransform) || !CATransform3DIsIdentity(sublayerTransform),
            animated: animationCount > 0 || differs, masked: layer.mask != nil, transform: transform,
            layerTransform: layerTransform, sublayerTransform: sublayerTransform, opacity: layer.opacity,
            animationCount: animationCount, presentation: presentation, presentationDiffers: differs)
        if states.count < 8192 { states[key] = value }
        return value
    }
    private func matrix(_ value: CATransform3D) -> [CGFloat] {
        [value.m11, value.m12, value.m13, value.m14, value.m21, value.m22, value.m23, value.m24,
         value.m31, value.m32, value.m33, value.m34, value.m41, value.m42, value.m43, value.m44]
    }
    private func audit(_ view: UIView, _ value: State) -> [String: Any] {
        let id = HistoryProductionWindowObservation.instance(view)
        if let result = audits[id] { auditHits += 1; return result }
        auditReads += 1
        let result: [String: Any] = ["instance": id, "runtimeClass": NSStringFromClass(type(of: view)),
            "frameInWindow": HistoryProductionWindowObservation.rect(value.frame), "hidden": value.hidden, "alpha": value.alpha,
            "clipsToBounds": value.clips, "hasLayerMask": value.masked,
            "transform": [value.transform.a, value.transform.b, value.transform.c, value.transform.d, value.transform.tx, value.transform.ty],
            "layerTransform": matrix(value.layerTransform), "sublayerTransform": matrix(value.sublayerTransform),
            "layerOpacity": value.opacity, "animationCount": value.animationCount,
            "presentationAvailable": value.presentation != nil, "presentationDiffers": value.presentationDiffers]
        if audits.count < 8192 { audits[id] = result }
        return result
    }
    private func presentationRect(_ view: UIView, to target: UIView) -> Any {
        guard let layer = state(view).presentation, let targetLayer = state(target).presentation else { return NSNull() }
        func root(_ layer: CALayer) -> CALayer { var value = layer; while let parent = value.superlayer { value = parent }; return value }
        guard root(layer) === root(targetLayer) else { return NSNull() }
        return HistoryProductionWindowObservation.rect(layer.convert(layer.bounds, to: targetLayer))
    }
    func geometry(_ view: UIView) -> [String: Any] {
        let key = ObjectIdentifier(view)
        if let result = geometries[key] { geometryHits += 1; return result }
        geometryReads += 1
        let path = chain(view), own = state(view), attached = path.last === window && own.sameWindow
        var clip = bounds, alpha: CGFloat = 1, hidden = false, transformed = false, animated = false, masked = false
        var ancestry: [[String: Any]] = []
        for ancestor in path {
            let value = state(ancestor)
            alpha *= value.alpha; hidden = hidden || value.hidden; transformed = transformed || value.transformed
            animated = animated || value.animated; masked = masked || value.masked
            if value.clips { clip = clip.intersection(value.frame) }
            ancestry.append(audit(ancestor, value))
        }
        let clipped = clip.intersection(own.frame), visible = attached && !hidden && alpha > 0.01 && !clipped.isNull && !clipped.isEmpty
        let result: [String: Any] = ["instance": HistoryProductionWindowObservation.instance(view), "runtimeClass": NSStringFromClass(type(of: view)),
            "windowInstance": HistoryProductionWindowObservation.instance(window), "sameWindow": attached,
            "bounds": HistoryProductionWindowObservation.rect(own.bounds), "frameInWindow": HistoryProductionWindowObservation.rect(own.frame),
            "frameInSurface": HistoryProductionWindowObservation.rect(view.convert(own.bounds, to: surface)),
            "hidden": own.hidden, "alpha": own.alpha, "ancestorVisibility": ancestry,
            "effectiveAlpha": alpha, "effectiveHidden": hidden, "clippedRectInWindow": HistoryProductionWindowObservation.rect(clipped),
            "visibleRectInWindow": visible ? HistoryProductionWindowObservation.rect(clipped) : NSNull(), "modelVisible": visible,
            "hasTransforms": transformed, "hasAnimation": animated, "hasLayerMask": masked,
            "presentationFrameInWindow": presentationRect(view, to: window), "presentationFrameInSurface": presentationRect(view, to: surface),
            "modelGeometryUnambiguous": attached && !transformed && !animated && !masked,
            "occlusion": "not evaluated; clipped bounds are not visual exposure ACK"]
        if geometries.count < 128 { geometries[key] = result }
        return result
    }
    func shadow(_ raw: [String: Any]) throws -> [String: Any] {
        try values.shadow(raw, canonicalInstances: Set(audits.keys))
    }
    var counts: [String: Int] {
        ["coverageReads": coverageReads, "coverageFactRequests": readMemo?.factRequests ?? 0, "coverageFactHits": readMemo?.factHits ?? 0,
         "coveragePublicSampleReads": coverageUIReads, "coveragePublicSampleHits": readMemo?.sampleHits ?? 0,
         "coverageAncestorSteps": readMemo?.ancestorSteps ?? 0, "inspectedCoverageNodes": inspectedCoverageNodes,
         "publicViewSnapshotReads": viewReads, "publicViewSnapshotHits": viewHits, "ancestorAuditReads": auditReads,
         "ancestorAuditHits": auditHits, "typedAncestorAuditReads": values.auditReads, "typedAncestorAuditHits": values.auditHits,
         "branchReads": branchReads, "branchHits": branchHits, "pathReads": pathReads, "pathHits": pathHits,
         "pathLinksRetained": pathLinksRetained,
         "geometryReads": geometryReads, "geometryHits": geometryHits]
    }
    func finishRead() {
        states.removeAll(keepingCapacity: false); identifiers.removeAll(keepingCapacity: false)
        parents.removeAll(keepingCapacity: false); paths.removeAll(keepingCapacity: false); branches.removeAll(keepingCapacity: false)
        audits.removeAll(keepingCapacity: false); geometries.removeAll(keepingCapacity: false)
        readMemo?.finishRead(); readMemo = nil; values.finishRead()
    }
    private func branch(_ view: UIView, available: Int) -> Branch? {
        guard let parent = parent(view) else { return nil }
        let key = ObjectIdentifier(view)
        if let value = branches[key] { branchHits += 1; return value }
        branchReads += 1
        let siblings = parent.subviews
        guard siblings.count <= available else { return Branch(roots: [], siblingCount: siblings.count, found: false) }
        let position = siblings.firstIndex(where: { $0 === view })
        let roots = position.map { index in siblings.enumerated().compactMap { at, sibling -> UIView? in
            sibling !== view && (sibling.layer.zPosition > view.layer.zPosition || sibling.layer.zPosition == view.layer.zPosition && at > index) ? sibling : nil
        } } ?? []
        let value = Branch(roots: roots, siblingCount: siblings.count, found: position != nil)
        if branches.count < 8192 { branches[key] = value }
        return value
    }
    func liveCoverage(text: UIView, outer: UIScrollView, capacity: Int = 8192) -> [String: Any] {
        coverageReads += 1
        let path = chain(text), target = text.convert(text.bounds, to: window)
        let coverage: HistoryCoverageTraversal.Result
        if path.count > capacity || path.last !== window { coverage = .init(blockers: [], unknown: true, inspected: 0) }
        else {
            var roots: [UIView] = [], discovery = path.count, exhausted = false
            for view in path {
                guard let value = branch(view, available: capacity - discovery) else { continue }
                guard value.siblingCount <= capacity - discovery, value.found else { exhausted = true; break }
                discovery += value.siblingCount; roots.append(contentsOf: value.roots)
            }
            if exhausted { coverage = .init(blockers: [], unknown: true, inspected: discovery) }
            else {
                let result = HistoryCoverageTraversal.scan(roots: roots, target: target, capacity: capacity - discovery, facts: { view in
                    let value = self.memo.resolve(view)
                    return .init(frame: value.frame, clip: value.clip, visible: value.visible, geometryKnown: value.geometryKnown, clipsChildren: value.clipsChildren)
                }, children: { $0.subviews }, identity: { HistoryProductionWindowObservation.instance($0) })
                coverage = .init(blockers: result.blockers, unknown: result.unknown, inspected: discovery + result.inspected)
            }
        }
        inspectedCoverageNodes += coverage.inspected
        return HistoryProductionWindowObservation.liveCoverage(text: text, outer: outer, surface: surface, window: window, observedCoverage: coverage)
    }
}
