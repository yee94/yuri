import UIKit
import NativeShell
import ObjectiveC

@MainActor enum NativeComposerSpellcheck {
    static func install(on surface: NshAppView) {
        surface.register(component: "yuri.composer.spellcheck") { ComposerSpellcheckOwner(context: $0) }
    }
}

@MainActor private final class ComposerSpellcheckRegistration: UIView {
    var changed: (() -> Void)?
    override func didMoveToSuperview() { super.didMoveToSuperview(); changed?() }
    override func didMoveToWindow() { super.didMoveToWindow(); changed?() }
    override func layoutSubviews() { super.layoutSubviews(); changed?() }
}

/// Only pending work observes these three notifications, filtered to the exact editor object.
@MainActor private final class ComposerSpellcheckObservation {
    private weak var editor: UITextView?
    private let work: (UITextView) -> Void
    private var tokens: [NSObjectProtocol] = []
    private var queued = false
    init(editor: UITextView, work: @escaping (UITextView) -> Void) {
        self.editor = editor; self.work = work
        for name in [UITextView.textDidBeginEditingNotification, UITextView.textDidEndEditingNotification, UITextView.textDidChangeNotification] {
            // Do not hand NotificationCenter a strong sender filter. Identity is checked
            // against the weak editor before scheduling any work; no view search occurs.
            tokens.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] notification in
                MainActor.assumeIsolated {
                    guard let self, let editor = notification.object as? UITextView, editor === self.editor, !self.queued else { return }
                    self.queued = true
                    DispatchQueue.main.async { [weak self, weak editor] in
                        guard let self else { return }
                        self.queued = false
                        guard let editor, editor === self.editor else { return }
                        self.work(editor)
                    }
                }
            })
        }
    }
    deinit { for token in tokens { NotificationCenter.default.removeObserver(token) } }
}

/// The editor retains this restoration ticket; the ticket and its observers hold only a weak editor.
/// It survives component removal during IME and has no path back to enable/replacement discovery.
@MainActor private final class ComposerSpellcheckRestoration {
    private static var key: UInt8 = 0
    private let lease: NativeComposerSpellcheckLease<UITextView>
    private var observation: ComposerSpellcheckObservation?
    private init(_ lease: NativeComposerSpellcheckLease<UITextView>) { self.lease = lease }
    static func pending(on editor: UITextView) -> Bool {
        objc_getAssociatedObject(editor, &key) != nil
    }
    static func retainIfNeeded(_ lease: NativeComposerSpellcheckLease<UITextView>) {
        guard lease.pendingRestore, let editor = lease.editor else { return }
        // One application writer per composer editor; never replace another pending restoration.
        guard !pending(on: editor) else { return }
        let ticket = ComposerSpellcheckRestoration(lease)
        objc_setAssociatedObject(editor, &key, ticket, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
        ticket.observation = ComposerSpellcheckObservation(editor: editor) { [weak ticket] editor in
            guard let ticket, objc_getAssociatedObject(editor, &key) as? ComposerSpellcheckRestoration === ticket else { return }
            ticket.lease.restore()
            if !ticket.lease.pendingRestore {
                ticket.observation = nil
                objc_setAssociatedObject(editor, &key, nil, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
            }
        }
    }
}

@MainActor private final class ComposerSpellcheckOwner: NshComponent {
    private let registration = ComposerSpellcheckRegistration(frame: .zero)
    var view: UIView { registration }
    private var config: NativeComposerSpellcheckConfig?
    private var observation: ComposerSpellcheckObservation?
    private weak var observedEditor: UITextView?
    private var observedGeneration: Int?
    private var retryQueued = false, removed = false
    private var coordinator: NativeComposerSpellcheckCoordinator<UITextView>!

    init(context: NshComponentContext) {
        registration.isAccessibilityElement = false
        registration.accessibilityElementsHidden = true
        registration.isUserInteractionEnabled = false
        coordinator = NativeComposerSpellcheckCoordinator(resolve: { [weak self] in self?.resolve() }, access: .init(
            read: { $0.spellCheckingType.rawValue }, marked: { $0.markedTextRange != nil },
            write: { editor, raw in if let value = UITextSpellCheckingType(rawValue: raw) { editor.spellCheckingType = value } },
            yes: UITextSpellCheckingType.yes.rawValue
        ), canEnable: { !ComposerSpellcheckRestoration.pending(on: $0) }, retired: { ComposerSpellcheckRestoration.retainIfNeeded($0) })
        registration.changed = { [weak self] in self?.changed() }
    }
    deinit {
        observation = nil
        coordinator.remove()
    }
    func setProp(_ name: String, _ value: Any?) {
        guard name == "config", !removed else { return }
        config = NativeComposerSpellcheckConfig(value)
        if config == nil { coordinator.reset() } else { coordinator.configure() }
        syncObservation(); retry()
    }
    func command(_ name: String, _ args: Any?) {
        guard name == "retire", !removed else { return }
        removed = true; observation = nil; coordinator.remove()
    }
    private func resolve() -> UITextView? {
        guard !removed, let config else { return nil }
        let tree = NativeComposerSpellcheckTree<UIView>(parent: { $0.superview }, children: { $0.subviews }, window: { $0.window },
            identifier: { $0.accessibilityIdentifier }, editorKind: { $0 is UITextView ? "multiline" : $0 is UITextField ? "singleline" : nil })
        return tree.resolve(registration, config: config) as? UITextView
    }
    private func changed() {
        guard !removed else { return }
        coordinator.reconcile(); syncObservation(); retry()
    }
    private func retry() {
        guard !removed, config != nil, !retryQueued else { return }
        retryQueued = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.retryQueued = false
            guard !self.removed else { return }
            self.coordinator.reconcile(); self.syncObservation()
        }
    }
    private func syncObservation() {
        guard !removed, let lease = coordinator.lease, lease.pendingEnable, let editor = lease.editor else {
            observation = nil; observedEditor = nil; observedGeneration = nil; return
        }
        let generation = coordinator.generation
        if observation != nil, observedEditor === editor, observedGeneration == generation { return }
        observation = nil; observedEditor = editor; observedGeneration = generation
        observation = ComposerSpellcheckObservation(editor: editor) { [weak self] editor in
            guard let self, !self.removed else { return }
            self.coordinator.event(editor: editor, generation: generation)
            self.syncObservation()
        }
    }
}
