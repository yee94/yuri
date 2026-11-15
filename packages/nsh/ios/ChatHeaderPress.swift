import UIKit
import NativeShell

/// On iOS 26 the system draws each navigation bar item inside its own glass platter, and a touch that begins on an NSH
/// view in that platter is cancelled before it ends: `onPressDown` fires, `onPress` never does. The chat header's
/// metadata ring and workspace menu therefore take their press from a passive tap recognizer on the window: a tap that
/// ends on one of the header buttons is emitted to JS, which toggles the popup exactly as `onPress` would.
@MainActor enum NativeChatHeaderPress {
    static func install(on surface: NshAppView) {
        surface.register(component: "yuri.chat.headerPress") { ChatHeaderPressOwner(context: $0) }
    }
}

@MainActor private final class HeaderPressAnchorView: UIView {
    var changed: (() -> Void)?
    override func didMoveToWindow() { super.didMoveToWindow(); changed?() }
}

@MainActor private final class ChatHeaderPressOwner: NSObject, NshComponent, UIGestureRecognizerDelegate {
    private static let ids: Set<String> = ["chat-header-metadata", "chat-header-options"]
    private let anchor = HeaderPressAnchorView(frame: .zero)
    private let recognizer = UITapGestureRecognizer()
    private let context: NshComponentContext
    var view: UIView { anchor }

    init(context: NshComponentContext) {
        self.context = context
        super.init()
        anchor.isUserInteractionEnabled = false
        anchor.accessibilityElementsHidden = true
        recognizer.addTarget(self, action: #selector(tapped(_:)))
        // Passive: it observes the tap and never competes with, delays or cancels any other touch handling.
        recognizer.cancelsTouchesInView = false
        recognizer.delaysTouchesBegan = false
        recognizer.delaysTouchesEnded = false
        recognizer.delegate = self
        anchor.changed = { [weak self] in self?.attach() }
    }

    func setProp(_ name: String, _ value: Any?) {}

    private func attach() {
        guard let window = anchor.window else { recognizer.view?.removeGestureRecognizer(recognizer); return }
        if recognizer.view !== window {
            recognizer.view?.removeGestureRecognizer(recognizer)
            window.addGestureRecognizer(recognizer)
        }
    }

    nonisolated func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }

    /// The header slot this owner sits in: only buttons inside it count, so another page's header never answers.
    private func scope() -> UIView? {
        var view: UIView? = anchor.superview
        while let current = view {
            if String(describing: type(of: current)).contains("ItemWrapperView") { return current }
            view = current.superview
        }
        return anchor.superview?.superview
    }

    @objc private func tapped(_ gesture: UITapGestureRecognizer) {
        guard let window = gesture.view, anchor.window === window, let scope = scope() else { return }
        var hit = window.hitTest(gesture.location(in: window), with: nil)
        while let current = hit {
            if let id = current.accessibilityIdentifier, Self.ids.contains(id), current.isDescendant(of: scope) {
                context.emit("press", ["id": id])
                return
            }
            hit = current.superview
        }
    }
}
