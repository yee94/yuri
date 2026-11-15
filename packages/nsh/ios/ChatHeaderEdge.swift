import UIKit
import NativeShell

/// iOS 26 draws a glass/blur "scroll edge effect" where scrolling content passes under a transparent
/// navigation bar. The chat header follows Web instead: no material, only the page background fading
/// down from the top. This owner switches that effect off for the transcript scroll view and draws the
/// fade in its place, sized from UIKit's own top safe area (status bar + navigation bar).
@MainActor enum NativeChatHeaderEdge {
    static func install(on surface: NshAppView) {
        surface.register(component: "yuri.chat.headerEdge") { ChatHeaderEdgeOwner(context: $0) }
    }
}

/// The fade follows the navigation bar's collapse (`ChatHeaderCollapse`), so Web's header-owned fade goes with the header.
@MainActor enum NativeChatHeaderFade {
    private static let fades = NSMapTable<UINavigationBar, UIView>.weakToWeakObjects()
    static func register(_ fade: UIView, for bar: UINavigationBar) { fades.setObject(fade, forKey: bar) }
    /// Call inside the animation block that moves the bar.
    static func mirror(bar: UINavigationBar, progress: CGFloat) {
        guard let fade = fades.object(forKey: bar) else { return }
        fade.transform = CGAffineTransform(translationX: 0, y: -(bar.bounds.height + 32) * progress)
        fade.alpha = 1 - progress
    }
}

@MainActor private final class HeaderEdgeAnchorView: UIView {
    var changed: (() -> Void)?
    override func didMoveToWindow() { super.didMoveToWindow(); changed?() }
    override func layoutSubviews() { super.layoutSubviews(); changed?() }
}

@MainActor private final class HeaderEdgeFadeView: UIView {
    override class var layerClass: AnyClass { CAGradientLayer.self }
}

@MainActor private final class ChatHeaderEdgeOwner: NSObject, NshComponent {
    /// Points over which the page background fades out below the navigation bar.
    private static let fadeLength: CGFloat = 28
    /// Web `--yuri-mobile-header-fade`: the background at 85%, not opaque.
    private static let fadeOpacity: CGFloat = 0.85
    private static let transcriptID = "transcript"
    private let anchor = HeaderEdgeAnchorView(frame: .zero)
    private let fade = HeaderEdgeFadeView(frame: .zero)
    var view: UIView { anchor }
    private var color = ""
    /// Assistant chats draw Web's own taller header scrim, so only the scroll-edge effect is switched off there.
    private var showsFade = true

    init(context: NshComponentContext) {
        super.init()
        anchor.isUserInteractionEnabled = false
        anchor.accessibilityElementsHidden = true
        fade.isUserInteractionEnabled = false
        fade.accessibilityElementsHidden = true
        if let gradient = fade.layer as? CAGradientLayer {
            gradient.startPoint = CGPoint(x: 0.5, y: 0)
            gradient.endPoint = CGPoint(x: 0.5, y: 1)
        }
        anchor.changed = { [weak self] in self?.apply() }
    }

    func setProp(_ name: String, _ value: Any?) {
        if name == "color" { color = value as? String ?? ""; apply() }
        else if name == "fade" { showsFade = value as? Bool ?? true; apply() }
    }

    private func background() -> UIColor {
        let digits = color.hasPrefix("#") ? String(color.dropFirst()) : color
        guard digits.count == 6 || digits.count == 8, let value = UInt32(digits.prefix(6), radix: 16) else { return .systemBackground }
        return UIColor(red: CGFloat((value >> 16) & 0xff) / 255, green: CGFloat((value >> 8) & 0xff) / 255, blue: CGFloat(value & 0xff) / 255, alpha: Self.fadeOpacity)
    }

    private func apply() {
        var responder: UIResponder? = anchor
        var owner: UIViewController?
        while let current = responder {
            if let controller = current as? UIViewController { owner = controller; break }
            responder = current.next
        }
        guard anchor.window != nil, let owner, let root = owner.viewIfLoaded,
              let navigation = owner.navigationController, navigation.topViewController === owner else {
            fade.removeFromSuperview(); return
        }
        hideScrollEdgeEffect(in: root, inside: false)
        guard showsFade else { fade.removeFromSuperview(); return }
        let solid = root.safeAreaInsets.top
        guard solid > 0, root.bounds.width > 0 else { fade.removeFromSuperview(); return }
        let total = solid + Self.fadeLength
        // Web: `linear-gradient(fade 0%, fade calc(safe-area-top + 35%), transparent 100%)` over safe-top + bar + 1.75rem.
        let hold = min(total, (root.window?.safeAreaInsets.top ?? 0) + total * 0.35)
        let base = background()
        // Under the bar, so the title and buttons always draw over it; the collapse drives it through `NativeChatHeaderFade`.
        let bar = navigation.navigationBar
        if fade.superview !== root { fade.transform = bar.transform; fade.alpha = bar.alpha; root.addSubview(fade) }
        else if root.subviews.last !== fade { root.bringSubviewToFront(fade) }
        NativeChatHeaderFade.register(fade, for: bar)
        let identity = fade.transform
        fade.transform = .identity
        fade.frame = CGRect(x: 0, y: 0, width: root.bounds.width, height: total)
        fade.transform = identity
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        if let gradient = fade.layer as? CAGradientLayer {
            gradient.colors = [base.cgColor, base.cgColor, base.withAlphaComponent(0).cgColor]
            gradient.locations = [0, NSNumber(value: Double(hold / total)), 1]
        }
        CATransaction.commit()
    }

    /// Only the transcript list: sheets and other scroll views keep the system look.
    private func hideScrollEdgeEffect(in view: UIView, inside: Bool) {
        let inside = inside || view.accessibilityIdentifier == Self.transcriptID
        if inside, let scroll = view as? UIScrollView {
            // A tap anywhere on the header (the bar's glass button capsule included) otherwise starts UIKit's animated
            // "scroll to top", which the chat must never do: its history is read from the bottom.
            scroll.scrollsToTop = false
            if #available(iOS 26.0, *) {
                // A list laid out upside down puts its visual top on the scroll view's bottom edge.
                let flipped = scroll.transform.d < 0 || scroll.layer.affineTransform().d < 0
                if flipped { scroll.bottomEdgeEffect.isHidden = true } else { scroll.topEdgeEffect.isHidden = true }
            }
        }
        for child in view.subviews { hideScrollEdgeEffect(in: child, inside: inside) }
    }
}
