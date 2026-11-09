import UIKit
import NativeShell

/// The glass card does not receive touches: the multiline editor does, and NSH
/// activeStyle never reaches the card. Watch that editor's touches and scale the
/// card that owns it. The editor itself is not transformed, so its scrolling stays intact.
@MainActor enum NativeComposerPress {
    static func install(on surface: NshAppView) {
        surface.register(component: "yuri.composer.press") { _ in ComposerPressOwner() }
    }
}

@MainActor private final class ComposerPressRegistration: UIView {
    var changed: (() -> Void)?
    override func didMoveToSuperview() { super.didMoveToSuperview(); changed?() }
    override func didMoveToWindow() { super.didMoveToWindow(); changed?() }
    override func layoutSubviews() { super.layoutSubviews(); changed?() }
}

@MainActor private final class ComposerPressWatch: UIView {
    var pressed: ((Bool) -> Void)?
    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        super.touchesBegan(touches, with: event)
        pressed?(true)
    }
    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        super.touchesEnded(touches, with: event)
        pressed?(false)
    }
    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
        super.touchesCancelled(touches, with: event)
        pressed?(false)
    }
}

@MainActor private final class ComposerPressOwner: NshComponent {
    private let registration = ComposerPressRegistration(frame: .zero)
    var view: UIView { registration }
    private var config: NativeComposerSpellcheckConfig?
    private weak var editor: UITextView?
    private weak var card: UIView?
    private var watch: ComposerPressWatch?
    private var down = false

    init() {
        registration.isAccessibilityElement = false
        registration.accessibilityElementsHidden = true
        registration.isUserInteractionEnabled = false
        registration.changed = { [weak self] in self?.attach() }
    }

    func setProp(_ name: String, _ value: Any?) {
        guard name == "config" else { return }
        config = NativeComposerSpellcheckConfig(value)
        if config == nil { release() } else { attach() }
    }

    func command(_ name: String, _ args: Any?) {
        guard name == "retire" else { return }
        release()
    }

    private func attach() {
        guard let config, let found = resolve(config), found !== editor else { return }
        releaseWatch()
        editor = found
        card = configCard(of: found, ownerID: config.ownerID)
        let cover = ComposerPressWatch(frame: found.bounds)
        cover.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        cover.backgroundColor = .clear
        cover.isAccessibilityElement = false
        cover.accessibilityElementsHidden = true
        cover.pressed = { [weak self] pressed in self?.setPressed(pressed) }
        found.addSubview(cover)
        watch = cover
    }

    private func resolve(_ config: NativeComposerSpellcheckConfig) -> UITextView? {
        let tree = NativeComposerSpellcheckTree<UIView>(
            parent: { $0.superview }, children: { $0.subviews }, window: { $0.window },
            identifier: { $0.accessibilityIdentifier },
            editorKind: { $0 is UITextView ? "multiline" : $0 is UITextField ? "singleline" : nil })
        return tree.resolve(registration, config: config) as? UITextView
    }

    /// Glass owner sits above the input container: editor → container → card.
    private func configCard(of editor: UIView, ownerID: String) -> UIView? {
        guard let container = editor.superview, let card = container.superview,
              card.accessibilityIdentifier == ownerID else { return nil }
        return card
    }

    private func setPressed(_ pressed: Bool) {
        guard pressed != down, let card, !UIAccessibility.isReduceMotionEnabled else {
            if !pressed { down = false; card?.transform = .identity }
            return
        }
        down = pressed
        let scale: CGFloat = pressed ? 1.02 : 1
        UIView.animate(withDuration: pressed ? 0.08 : 0.26, delay: 0, options: [.allowUserInteraction, .beginFromCurrentState, .curveEaseOut]) {
            card.transform = CGAffineTransform(scaleX: scale, y: scale)
        }
    }

    private func releaseWatch() {
        down = false
        card?.transform = .identity
        watch?.removeFromSuperview()
        watch = nil
        editor = nil
        card = nil
    }

    private func release() {
        releaseWatch()
        config = nil
    }
}
