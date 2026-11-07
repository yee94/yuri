import UIKit
import NativeShell

@MainActor enum NavigationBridge {
    static func install(on surface: NshAppView) {
        surface.handle("navigation.anchor") { [weak surface] input, reply in
            guard let surface,
                  let id = (input as? [String: Any])?["id"] as? String,
                  ["chat-header-metadata", "chat-header-options"].contains(id),
                  let window = surface.window,
                  let anchor = find(id, in: window),
                  !anchor.isHidden, anchor.alpha > 0 else { reply.resolve(nil); return }
            let bounds = anchor.convert(anchor.bounds, to: surface)
            guard bounds.width > 0, bounds.height > 0, surface.bounds.intersects(bounds) else { reply.resolve(nil); return }
            reply.resolve(["origin": ["x": bounds.minX, "y": bounds.minY], "size": ["width": bounds.width, "height": bounds.height]])
        }
    }

    private static func find(_ id: String, in view: UIView) -> UIView? {
        if view.accessibilityIdentifier == id { return view }
        for child in view.subviews {
            if let match = find(id, in: child) { return match }
        }
        return nil
    }
}
