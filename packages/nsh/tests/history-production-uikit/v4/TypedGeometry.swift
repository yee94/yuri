import UIKit

/// v4 periodic-only value construction. The public reads and fields mirror geometry(); no UIKit object escapes.
@MainActor enum HistoryV4TypedGeometry {
    static func number(_ value: Double) -> HistorySnapshotValue { .doubleBits(value.bitPattern) }
    static func insets(_ value: UIEdgeInsets) -> [String: Double] {
        ["top": Double(value.top), "left": Double(value.left), "bottom": Double(value.bottom), "right": Double(value.right)]
    }
    static func rect(_ value: CGRect) -> HistorySnapshotValue {
        guard !value.isNull, !value.isInfinite, [value.minX, value.minY, value.width, value.height].allSatisfy({ $0.isFinite }) else { return .null }
        return .object(["x": number(value.minX), "y": number(value.minY), "width": number(value.width), "height": number(value.height)])
    }
    private static func transform(_ value: CATransform3D) -> HistorySnapshotValue {
        .array([value.m11, value.m12, value.m13, value.m14, value.m21, value.m22, value.m23, value.m24,
                value.m31, value.m32, value.m33, value.m34, value.m41, value.m42, value.m43, value.m44].map { number($0) })
    }
    private static func presentationRect(_ view: UIView, to target: UIView) -> HistorySnapshotValue {
        guard let layer = view.layer.presentation(), let targetLayer = target.layer.presentation() else { return .null }
        func root(_ layer: CALayer) -> CALayer {
            var value = layer
            while let parent = value.superlayer { value = parent }
            return value
        }
        guard root(layer) === root(targetLayer) else { return .null }
        return rect(layer.convert(layer.bounds, to: targetLayer))
    }
    static func read(_ view: UIView, surface: UIView, window: UIWindow) -> HistorySnapshotValue {
        let path = HistoryProductionWindowObservation.chain(view, to: window), attached = path.last === window && view.window === window
        var clip = window.bounds, effectiveAlpha: CGFloat = 1
        var hidden = false, transformed = false, animated = false, masked = false
        var ancestry: [HistorySnapshotValue] = []
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
            ancestry.append(.object(["instance": .string(HistoryProductionWindowObservation.instance(ancestor)), "runtimeClass": .string(NSStringFromClass(type(of: ancestor))),
                "frameInWindow": rect(frame), "hidden": .bool(ancestor.isHidden), "alpha": number(ancestor.alpha),
                "clipsToBounds": .bool(ancestor.clipsToBounds), "hasLayerMask": .bool(ancestor.layer.mask != nil),
                "transform": .array([ancestor.transform.a, ancestor.transform.b, ancestor.transform.c, ancestor.transform.d, ancestor.transform.tx, ancestor.transform.ty].map { number($0) }),
                "layerTransform": transform(ancestor.layer.transform), "sublayerTransform": transform(ancestor.layer.sublayerTransform),
                "layerOpacity": number(Double(ancestor.layer.opacity)), "animationCount": .integer(Int64(animationCount)),
                "presentationAvailable": .bool(presentation != nil), "presentationDiffers": .bool(presentationDiffers)]))
        }
        let clipped = clip.intersection(view.convert(view.bounds, to: window))
        let modelVisible = attached && !hidden && effectiveAlpha > 0.01 && !clipped.isNull && !clipped.isEmpty
        return .object(["instance": .string(HistoryProductionWindowObservation.instance(view)), "runtimeClass": .string(NSStringFromClass(type(of: view))),
            "windowInstance": .string(HistoryProductionWindowObservation.instance(window)), "sameWindow": .bool(attached),
            "bounds": rect(view.bounds), "frameInWindow": rect(view.convert(view.bounds, to: window)), "frameInSurface": rect(view.convert(view.bounds, to: surface)),
            "hidden": .bool(view.isHidden), "alpha": number(view.alpha), "ancestorVisibility": .array(ancestry),
            "effectiveAlpha": number(effectiveAlpha), "effectiveHidden": .bool(hidden), "clippedRectInWindow": rect(clipped),
            "visibleRectInWindow": modelVisible ? rect(clipped) : .null, "modelVisible": .bool(modelVisible),
            "hasTransforms": .bool(transformed), "hasAnimation": .bool(animated), "hasLayerMask": .bool(masked),
            "presentationFrameInWindow": presentationRect(view, to: window), "presentationFrameInSurface": presentationRect(view, to: surface),
            "modelGeometryUnambiguous": .bool(attached && !transformed && !animated && !masked),
            "occlusion": .string("not evaluated; clipped bounds are not visual exposure ACK")])
    }
}
