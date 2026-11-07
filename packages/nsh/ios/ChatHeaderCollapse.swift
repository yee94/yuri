import UIKit
import NativeShell

@MainActor enum NativeChatHeaderCollapse {
    static func install(on surface: NshAppView) {
        surface.register(component: "yuri.chat.headerCollapse") { ChatHeaderCollapseOwner(context: $0) }
    }
}

@MainActor private final class HeaderRegistrationView: UIView {
    var changed: (() -> Void)?
    override func didMoveToWindow() { super.didMoveToWindow(); changed?() }
    override func layoutSubviews() { super.layoutSubviews(); changed?() }
}

/// One visual writer per navigation bar. Never changes its frame, safe area or content offset.
@MainActor private final class ChatHeaderCollapseOwner: NSObject, NshComponent {
    private static let writers = NSMapTable<UINavigationBar, ChatHeaderCollapseOwner>.weakToWeakObjects()
    private let registration = HeaderRegistrationView(frame: .zero)
    var view: UIView { registration }
    private weak var bar: UINavigationBar?
    private var progress: CGFloat = 0, duration = 0.0, active = false
    private var applied: CGFloat?
    init(context: NshComponentContext) {
        super.init()
        registration.isUserInteractionEnabled = false
        registration.accessibilityElementsHidden = true
        registration.changed = { [weak self] in self?.apply() }
    }
    func setProp(_ name: String, _ value: Any?) {
        switch name {
        case "progress": if let number = value as? NSNumber, number.doubleValue.isFinite { progress = min(1, max(0, CGFloat(number.doubleValue))) }
        case "duration": duration = max(0, (value as? NSNumber)?.doubleValue ?? 0) / 1000
        case "active": active = value as? Bool ?? false
        default: break
        }
        apply()
    }
    private func restore() {
        guard let bar, Self.writers.object(forKey: bar) === self else { return }
        bar.layer.removeAllAnimations()
        bar.transform = .identity; bar.alpha = 1
        bar.isUserInteractionEnabled = true; bar.accessibilityElementsHidden = false
        Self.writers.removeObject(forKey: bar); applied = nil
    }
    private func apply() {
        guard registration.window != nil, active else { restore(); return }
        var responder: UIResponder? = registration
        while let current = responder {
            if let controller = current as? UIViewController, let navigation = controller.navigationController {
                guard let top = navigation.topViewController, let root = top.viewIfLoaded, registration.isDescendant(of: root) else { return }
                bar = navigation.navigationBar; break
            }
            responder = current.next
        }
        guard let bar, applied != progress || Self.writers.object(forKey: bar) !== self else { return }
        applied = progress; Self.writers.setObject(self, forKey: bar)
        let progress = self.progress
        let changes = {
            bar.transform = CGAffineTransform(translationX: 0, y: -(bar.bounds.height + 32) * progress)
            bar.alpha = 1 - progress
        }
        bar.isUserInteractionEnabled = progress == 0
        bar.accessibilityElementsHidden = progress >= 1
        if duration > 0 && !UIAccessibility.isReduceMotionEnabled {
            UIView.animate(withDuration: duration, delay: 0, options: [.beginFromCurrentState, .curveEaseOut, .allowUserInteraction], animations: changes)
        } else { bar.layer.removeAllAnimations(); changes() }
    }
}
