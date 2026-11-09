import UIKit
import NativeShell

/// Compile-only production registration and public UIKit trait contract; no VoiceOver/IME claims.
@MainActor func composerSpellcheckSDKProbe(surface: NshAppView, editor: UITextView) {
    NativeComposerSpellcheck.install(on: surface)
    let lease = NativeComposerSpellcheckLease(editor: editor, access: NativeComposerSpellcheckAccess<UITextView>(
        read: { $0.spellCheckingType.rawValue }, marked: { $0.markedTextRange != nil },
        write: { target, raw in if let trait = UITextSpellCheckingType(rawValue: raw) { target.spellCheckingType = trait } },
        yes: UITextSpellCheckingType.yes.rawValue
    ))
    lease.enable(if: { editor.window != nil }); lease.retire(); lease.restore()
}
