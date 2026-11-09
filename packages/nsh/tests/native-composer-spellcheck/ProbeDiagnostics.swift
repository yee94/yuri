import UIKit
import NativeShell

/// Installed only by the isolated fixture, with an explicit build-time diagnostics opt-in.
@MainActor final class ComposerProbeDiagnostics {
    private let ledger: ComposerProbeLedger<UITextView>
    private let processRunID = UUID().uuidString
    private var owner: WeakOwner?
    private final class WeakOwner {
        weak var value: ComposerProbeRegistrationOwner?
        init(_ value: ComposerProbeRegistrationOwner) { self.value = value }
    }
    private let control = ComposerProbeControl()
    private var printedErrors = Set<ComposerProbeErrorCode>()
    init(enabled: Bool) { ledger = ComposerProbeLedger(enabled: enabled) }
    var enabled: Bool { ledger.enabled }

    func install(on surface: NshAppView) {
        guard enabled else { return }
        surface.register(component: "yuri.fixture.composer.readback") { [weak self] _ in
            let owner = ComposerProbeRegistrationOwner(diagnostics: self)
            self?.owner = WeakOwner(owner)
            return owner
        }
    }
    func requestHostChange() -> Int { control.request() }
    func hostAdopted(_ input: Any?) -> [String: Any] {
        guard enabled else { return ["accepted": false, "revision": 0] }
        let response = control.acknowledge(input)
        if response["accepted"] as? Bool == true { owner?.value?.capture(.hostAcknowledged) }
        publishErrors(); return response
    }
    fileprivate func jsStatus(_ input: Any?) {
        guard enabled else { return }
        if control.status(input), (input as? [String: Any])?["phase"] as? String == "accepted" { owner?.value?.capture(.hostChanged) }
        publishErrors()
    }
    func recordError(_ code: ComposerProbeErrorCode) {
        guard enabled else { return }
        control.note(code); publishErrors()
    }
    private func publishErrors() {
        for code in ComposerProbeErrorCode.allCases where control.errors[code] != nil && printedErrors.insert(code).inserted {
            print("[composer-probe] error=\(code.rawValue)")
        }
    }
    func readback(_ step: ComposerProbeStep) throws {
        guard enabled else { return }
        owner?.value?.capture(step)
        try export()
    }
    fileprivate func record(editor: UITextView?, generation: Int, registrationAttached: Bool, step: ComposerProbeStep) {
        let state: String
        switch UIApplication.shared.applicationState {
        case .active: state = "active"
        case .inactive: state = "inactive"
        case .background: state = "background"
        @unknown default: state = "unknown"
        }
        ledger.capture(editor: editor, generation: generation, step: step, state: state,
            registrationAttached: registrationAttached, requestedHostRevision: control.requestedHostRevision,
            adoptedHostRevision: control.adoptedHostRevision) { editor in
                let name: String
                switch editor.spellCheckingType {
                case .default: name = "default"
                case .no: name = "no"
                case .yes: name = "yes"
                @unknown default: name = "unknown"
                }
                return ComposerProbeFacts(spellCheckingName: name, spellCheckingRawValue: editor.spellCheckingType.rawValue,
                    markedTextPresent: editor.markedTextRange != nil, attached: editor.window != nil, firstResponder: editor.isFirstResponder)
            }
    }
    private func export() throws {
        let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let report = ComposerProbeReport(schema: 2, processRunID: processRunID,
            buildRunID: Bundle.main.object(forInfoDictionaryKey: "ComposerProbeBuildID") as? String ?? "unavailable", samples: ledger.samples, control: control.snapshot)
        try encoder.encode(report).write(to: directory.appendingPathComponent("composer-readback.json"), options: .atomic)
    }
}

@MainActor private final class ComposerProbeRegistrationView: UIView {
    var changed: (() -> Void)?
    override func didMoveToSuperview() { super.didMoveToSuperview(); changed?() }
    override func didMoveToWindow() { super.didMoveToWindow(); changed?() }
    override func layoutSubviews() { super.layoutSubviews(); changed?() }
}

@MainActor private final class ComposerProbeRegistrationOwner: NshComponent {
    private let registration = ComposerProbeRegistrationView(frame: .zero)
    var view: UIView { registration }
    private weak var diagnostics: ComposerProbeDiagnostics?
    private var config: NativeComposerSpellcheckConfig?
    private var generation = 0
    private weak var lastEditor: UITextView?
    private var tokens: [NSObjectProtocol] = []
    init(diagnostics: ComposerProbeDiagnostics?) {
        self.diagnostics = diagnostics
        registration.isAccessibilityElement = false; registration.accessibilityElementsHidden = true
        registration.isUserInteractionEnabled = false
        registration.changed = { [weak self] in self?.mounted() }
        for (name, step) in [(UITextView.textDidBeginEditingNotification, ComposerProbeStep.editingBegin),
                             (UITextView.textDidChangeNotification, .editingChange), (UITextView.textDidEndEditingNotification, .editingEnd)] {
            tokens.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] notification in
                MainActor.assumeIsolated {
                    guard let self, let editor = notification.object as? UITextView,
                          editor === self.lastEditor, self.resolve() === editor else { return }
                    let generation = self.generation
                    self.capture(step)
                    DispatchQueue.main.async { [weak self, weak editor] in
                        guard let self, let editor, generation == self.generation, self.resolve() === editor else { return }
                        self.capture(.afterNotification)
                    }
                }
            })
        }
    }
    deinit { for token in tokens { NotificationCenter.default.removeObserver(token) } }
    func setProp(_ name: String, _ value: Any?) {
        if name == "ackStatus" { diagnostics?.jsStatus(value); return }
        guard name == "config" else { return }
        guard let snapshot = value as? [String: Any], snapshot.count == 3,
              let ownerID = snapshot["ownerID"] as? String, let inputID = snapshot["inputID"] as? String,
              let generation = snapshot["generation"] as? Int, generation > 0 else { config = nil; return }
        config = NativeComposerSpellcheckConfig(["ownerID": ownerID, "inputID": inputID])
        self.generation = generation
        mounted()
    }
    private func resolve() -> UITextView? {
        guard let config else { return nil }
        let tree = NativeComposerSpellcheckTree<UIView>(parent: { $0.superview }, children: { $0.subviews }, window: { $0.window },
            identifier: { $0.accessibilityIdentifier }, editorKind: { $0 is UITextView ? "multiline" : $0 is UITextField ? "singleline" : nil })
        return tree.resolve(registration, config: config) as? UITextView
    }
    private func mounted() {
        guard let editor = resolve(), editor !== lastEditor else { return }
        lastEditor = editor; capture(.mounted)
    }
    fileprivate func capture(_ step: ComposerProbeStep) {
        guard let diagnostics, generation > 0 else { return }
        let editor = resolve()
        if let editor { lastEditor = editor }
        diagnostics.record(editor: editor, generation: generation, registrationAttached: registration.window != nil, step: step)
    }
}
