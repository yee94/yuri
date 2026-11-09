import UIKit
import NativeShell

/** Read-only UIKit geometry. It has no Host, credential or notification permission access. */
@MainActor enum FeedbackLayoutBridge {
    static func install(on surface: NshAppView) {
        surface.handle("feedback.layout") { [weak surface] input, reply in
            guard let surface, let fields = input as? [String: Any], fields.isEmpty else { reply.reject("feedback_layout_invalid"); return }
            var top = surface.safeAreaInsets.top
            @MainActor func visible(_ node: UIView) -> Bool {
                var current: UIView? = node
                while let view = current { if view.isHidden || view.alpha <= 0.01 { return false }; current = view.superview }
                return node.window != nil
            }
            @MainActor func scan(_ node: UIView) {
                if node is UINavigationBar, visible(node) {
                    let bounds = node.convert(node.bounds, to: surface)
                    if bounds.width > 0, bounds.height > 0, bounds.maxY > 0, bounds.minY < surface.bounds.height / 2 { top = max(top, bounds.maxY) }
                }
                node.subviews.forEach(scan)
            }
            if let window = surface.window { scan(window) }
            reply.resolve(["top": top])
        }
    }
}
