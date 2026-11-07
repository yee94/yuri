import UIKit
import NativeShell

/// Only registered new-session leaves; no application/window traversal or background AX writes.
@MainActor enum NewSessionPickerOwners {
    static func install(on surface: NshAppView) {
        surface.register(component: "yuri.newSession.inputAX") { InputAXOwner(context: $0) }
    }
}

@MainActor private final class RegistrationView: UIView {
    var changed: (() -> Void)?
    override init(frame: CGRect) {
        super.init(frame: frame)
        isAccessibilityElement = false
        accessibilityElementsHidden = true
        isUserInteractionEnabled = false
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }
    override func didMoveToWindow() { super.didMoveToWindow(); changed?() }
    override func didMoveToSuperview() { super.didMoveToSuperview(); changed?() }
    override func layoutSubviews() { super.layoutSubviews(); changed?() }
}

@MainActor private final class InputAXOwner: NshComponent {
    let registration = RegistrationView(frame: .zero)
    var view: UIView { registration }
    private let context: NshComponentContext
    private var field: String?, label: String?
    private weak var editor: UITextField?
    private var savedID: String?, savedLabel: String?, writtenID: String?, writtenLabel: String?
    private var lastFailure: String?
    private static let identifiers = ["selection": "new-session-selection-search", "presets": "new-session-presets-search", "directory": "new-session-directory"]

    init(context: NshComponentContext) {
        self.context = context
        registration.changed = { [weak self] in self?.bind() }
    }
    func setProp(_ name: String, _ value: Any?) {
        if name == "field" { field = value as? String }
        if name == "label" { label = value as? String }
        bind()
    }
    private func restore() {
        if let editor {
            if editor.accessibilityIdentifier == writtenID { editor.accessibilityIdentifier = savedID }
            if editor.accessibilityLabel == writtenLabel { editor.accessibilityLabel = savedLabel }
        }
        editor = nil; writtenID = nil; writtenLabel = nil
    }
    private func fail(_ code: String) {
        guard lastFailure != code else { return }
        lastFailure = code
        context.emit("failure", ["code": code])
        print("[new-session-input-ax] failure \(code)")
    }
    private func bind() {
        guard registration.window != nil else { restore(); return }
        guard let field, let id = Self.identifiers[field], let label, !label.isEmpty else { return }
        // Public nativeComponent host -> the existing owning TS parent. Only
        // its direct child containers' direct UITextFields are candidates.
        guard let host = registration.superview, let owner = host.superview else { return }
        let candidates = owner.subviews.filter { $0 !== host }.flatMap { sibling in
            sibling.subviews.compactMap { $0 as? UITextField }
        }
        guard candidates.count == 1, let target = candidates.first,
              target.window === registration.window, target.superview?.superview === owner else {
            restore(); fail("expected-one-owned-text-field"); return
        }
        guard target.accessibilityIdentifier == nil || target.accessibilityIdentifier == id,
              target.accessibilityLabel == nil || target.accessibilityLabel == label || target === editor else {
            restore(); fail("conflicting-editor-identity"); return
        }
        if target !== editor {
            restore(); editor = target
            savedID = target.accessibilityIdentifier; savedLabel = target.accessibilityLabel
            print("[new-session-input-ax] bound \(id)")
        }
        target.accessibilityIdentifier = id; target.accessibilityLabel = label
        writtenID = id; writtenLabel = label; lastFailure = nil
    }
}
