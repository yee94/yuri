import UIKit
import NativeShell

/// Top-level pages (Projects, Assistants, Scheduled, Settings) draw their own header over the scroll content.
/// Like the chat header, it has no material and no solid fill: the page background at 85% fading to transparent,
/// holding for the first 35% (Web `--yuri-mobile-header-fade`). The view is sized by NSH layout; JS drives opacity.
@MainActor enum NativeOuterHeaderFade {
    static func install(on surface: NshAppView) {
        surface.register(component: "yuri.outer.headerFade") { OuterHeaderFadeOwner(context: $0) }
    }
}

@MainActor private final class OuterHeaderFadeView: UIView {
    override class var layerClass: AnyClass { CAGradientLayer.self }
}

@MainActor private final class OuterHeaderFadeOwner: NSObject, NshComponent {
    /// Web: `--yuri-mobile-header-fade` is the background at 85%.
    private static let fadeOpacity: CGFloat = 0.85
    private static let hold: NSNumber = 0.35
    private let fade = OuterHeaderFadeView(frame: .zero)
    var view: UIView { fade }
    private var color = ""

    init(context: NshComponentContext) {
        super.init()
        fade.isUserInteractionEnabled = false
        fade.accessibilityElementsHidden = true
        if let gradient = fade.layer as? CAGradientLayer {
            gradient.startPoint = CGPoint(x: 0.5, y: 0)
            gradient.endPoint = CGPoint(x: 0.5, y: 1)
            gradient.locations = [0, Self.hold, 1]
        }
        apply()
    }

    func setProp(_ name: String, _ value: Any?) {
        if name == "color" { color = value as? String ?? ""; apply() }
    }

    private func background() -> UIColor {
        let digits = color.hasPrefix("#") ? String(color.dropFirst()) : color
        guard digits.count == 6 || digits.count == 8, let value = UInt32(digits.prefix(6), radix: 16) else { return .systemBackground }
        return UIColor(red: CGFloat((value >> 16) & 0xff) / 255, green: CGFloat((value >> 8) & 0xff) / 255, blue: CGFloat(value & 0xff) / 255, alpha: Self.fadeOpacity)
    }

    private func apply() {
        let base = background()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        if let gradient = fade.layer as? CAGradientLayer {
            gradient.colors = [base.cgColor, base.cgColor, base.withAlphaComponent(0).cgColor]
        }
        CATransaction.commit()
    }
}
