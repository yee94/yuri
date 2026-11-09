import UIKit
import NativeShell

/// Compile-only seam: uses the production install and concrete public UIKit editors.
/// Calling this from an on-device harness would test setters, not VoiceOver speech.
@MainActor func inputMetadataSDKProbe(surface: NshAppView, window: UIWindow) {
    NativeInputMetadataOwner.install(on: surface)
    let owner = UIView(), host = UIView(), registration = UIView(), container = UIView(), editor = UITextView()
    owner.accessibilityIdentifier = "glass"; container.accessibilityIdentifier = "composer"
    window.addSubview(owner); owner.addSubview(host); host.addSubview(registration)
    owner.addSubview(container); container.addSubview(editor)
    let binding = NativeInputMetadataBinding<UIView>(registration: registration, access: .init(
        parent: { $0.superview }, children: { $0.subviews }, window: { $0.window },
        kind: { $0 is UITextView ? "multiline" : $0 is UITextField ? "singleline" : nil },
        identifier: { $0.accessibilityIdentifier }, label: { $0.accessibilityLabel },
        writeIdentifier: { $0.accessibilityIdentifier = $1 }, writeLabel: { $0.accessibilityLabel = $1 }
    ))
    binding.update(["ownerID": "glass", "inputID": "composer", "expectedKind": "multiline", "editorAXID": "editor", "label": "写消息", "active": true])
    binding.changed(); binding.lifecycle(false); binding.retire()
}
