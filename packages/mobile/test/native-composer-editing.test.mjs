import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

// Execute the actual Swift method bodies, not a JS copy of the policy. UIKit is
// unavailable in a macOS process: only the responder/layout collaborators below
// are doubles. The opt-in platform run remains necessary for real UIKit/HID.
function method(source, signature) {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`Missing production method: ${signature}`);
  const body = source.indexOf('{', start);
  let depth = 1;
  let end = body + 1;
  while (depth && end < source.length) {
    if (source[end] === '{') depth++;
    if (source[end] === '}') depth--;
    end++;
  }
  if (depth) throw new Error(`Unclosed production method: ${signature}`);
  return source.slice(start, end).replace(/^private /, '');
}

test.skipIf(process.platform !== 'darwin')('compiled production hide completion preserves editing during input-view reload and hardware minimization', async () => {
  const view = await readFile(fileURLToPath(new URL('../ios/App/App/YuriComposerView.swift', import.meta.url)), 'utf8');
  const plugin = await readFile(fileURLToPath(new URL('../ios/App/App/YuriComposerPlugin.swift', import.meta.url)), 'utf8');
  const work = await mkdtemp(join(tmpdir(), 'yuri-composer-editing-'));
  try {
    const source = `
import Foundation
import CoreGraphics
enum UIResponder {
    static let keyboardWillChangeFrameNotification = Notification.Name("UIKeyboardWillChangeFrameNotification")
    static let keyboardDidChangeFrameNotification = Notification.Name("UIKeyboardDidChangeFrameNotification")
    static let keyboardWillHideNotification = Notification.Name("UIKeyboardWillHideNotification")
    static let keyboardDidHideNotification = Notification.Name("UIKeyboardDidHideNotification")
    static let keyboardWillShowNotification = Notification.Name("UIKeyboardWillShowNotification")
    static let keyboardDidShowNotification = Notification.Name("UIKeyboardDidShowNotification")
    static let keyboardFrameEndUserInfoKey = "endFrame"
    static let keyboardAnimationDurationUserInfoKey = "duration"
    static let keyboardAnimationCurveUserInfoKey = "curve"
}
enum UIApplication {
    static let didEnterBackgroundNotification = Notification.Name("UIApplicationDidEnterBackgroundNotification")
}
struct Insets { var bottom: CGFloat = 34 }
final class UIView {
    var window: UIView? { nil }
    var safeAreaInsets = Insets()
    var bounds = CGRect(x: 0, y: 0, width: 402, height: 874)
    func convert(_ frame: CGRect, from: UIView?) -> CGRect { frame }
    func convert(_ frame: CGRect, to: UIView) -> CGRect { frame }
    func layoutIfNeeded() {}
    enum AnimationCurve: Int { case easeInOut = 0 }
    struct AnimationOptions: OptionSet {
        let rawValue: UInt
        static let beginFromCurrentState = AnimationOptions(rawValue: 4)
    }
    static var completions: [() -> Void] = []
    static func animate(withDuration: Double, delay: Double, options: AnimationOptions,
                        animations: @escaping () -> Void, completion: @escaping (Bool) -> Void) {
        animations()
        completions.append { completion(true) }
    }
}
final class Constraint { var constant: CGFloat = -46 }
final class UITextView {
    var isFirstResponder = true
    var resignCount = 0
    func resignFirstResponder() { resignCount += 1; isFirstResponder = false }
}
final class Composer {
    var superview: UIView? = UIView()
    var isHidden = false
    var textView = UITextView()
    var keepExpandedThroughPicker = false
    var isExpanded = true
    func dismissAttachMenu() {}
    func setExpanded(_ value: Bool, animated: Bool) { isExpanded = value }
    func notifyText() {}
    ${method(view, 'func handleKeyboardDidHide()')}
    ${method(view, 'func blurInput()')}
    ${method(view, 'func textViewDidEndEditing(')}
}
final class Plugin {
    var composerView: Composer? = Composer()
    var keyboardObservers: [NSObjectProtocol] = []
    var keyboardSessionOpen = false
    var bottomConstraint: Constraint? = Constraint()
    func reportHeight() {}
    ${method(plugin, 'private func observeKeyboard(')}
    ${method(plugin, 'private func stopObservingKeyboard(')}
    ${method(plugin, 'private func applyKeyboard(')}
    ${method(plugin, 'private func completeKeyboardEvent(')}
    ${method(plugin, 'private static func shouldReportKeyboardHeight(')}
    ${method(plugin, 'private static func keyboardEventName(')}
    ${method(plugin, 'private static func nextSession(')}
    ${method(plugin, 'private static func bottomGap(')}
    ${method(plugin, 'private static func keyboardOverlap(')}
}
var failures: [String] = []
func check(_ condition: Bool, _ name: String) { if !condition { failures.append(name) } }
let plugin = Plugin()
let composer = plugin.composerView!
plugin.observeKeyboard()
func post(_ name: Notification.Name, y: CGFloat = 874, duration: Double = 0) {
    NotificationCenter.default.post(name: name, object: nil, userInfo: [
        UIResponder.keyboardFrameEndUserInfoKey: CGRect(x: 0, y: y, width: 402, height: 311),
        UIResponder.keyboardAnimationDurationUserInfoKey: duration,
    ])
}
// native-resign-stack.json: applyKeyboard's unchanged-geometry fast path calls
// completeKeyboardEvent(willHide) while UITextView is still first responder.
for event in [UIResponder.keyboardWillHideNotification, UIResponder.keyboardDidHideNotification,
              UIResponder.keyboardWillHideNotification, UIResponder.keyboardDidHideNotification] {
    post(event)
    check(composer.textView.isFirstResponder, "\\(event) revoked responder")
    check(composer.isExpanded, "\\(event) collapsed live editing")
}
check(composer.textView.resignCount == 0, "presentation called resignFirstResponder")
post(UIResponder.keyboardWillShowNotification, y: 538)
check(plugin.bottomConstraint?.constant == -348, "software keyboard did not raise overlay")
post(UIResponder.keyboardWillHideNotification, duration: 0.25)
check(plugin.bottomConstraint?.constant == -46, "minimized keyboard left overlay raised")
// Host tap / explicit blur still ends editing, independently of keyboard mode.
composer.blurInput()
composer.textViewDidEndEditing(composer.textView)
check(!composer.textView.isFirstResponder, "explicit blur did not resign")
check(composer.textView.resignCount == 1, "explicit blur must resign once")
check(!composer.isExpanded, "didEndEditing did not collapse")
// A late old hide completion must not collapse a newly focused owner.
composer.textView.isFirstResponder = true
composer.isExpanded = true
UIView.completions.forEach { $0() }
post(UIResponder.keyboardDidHideNotification)
check(composer.textView.isFirstResponder && composer.isExpanded, "stale completion ended new editing")
composer.keepExpandedThroughPicker = true
composer.textView.isFirstResponder = false
composer.textViewDidEndEditing(composer.textView)
plugin.completeKeyboardEvent("didHide")
check(composer.isExpanded, "picker lost expansion")
composer.keepExpandedThroughPicker = false
composer.textView.isFirstResponder = true
// The real registered background observer must still terminate editing.
NotificationCenter.default.post(name: UIApplication.didEnterBackgroundNotification, object: nil)
check(!composer.textView.isFirstResponder, "background failed to end editing")
plugin.stopObservingKeyboard()
print(failures.isEmpty ? "PASS production Swift hide/editing lifecycle" : "FAIL: " + failures.joined(separator: "; "))
`;
    const input = join(work, 'main.swift');
    const binary = join(work, 'probe');
    await writeFile(input, source);
    execFileSync('swiftc', [input, '-o', binary], { timeout: 60_000 });
    const output = execFileSync(binary, [], { encoding: 'utf8', timeout: 10_000 });
    expect(output.trim()).toBe('PASS production Swift hide/editing lifecycle');
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}, 90_000);

test.skipIf(process.platform !== 'darwin')('compiled native text notifications deliver composition transitions without text or selection changes', async () => {
  const view = await readFile(fileURLToPath(new URL('../ios/App/App/YuriComposerView.swift', import.meta.url)), 'utf8');
  const plugin = await readFile(fileURLToPath(new URL('../ios/App/App/YuriComposerPlugin.swift', import.meta.url)), 'utf8');
  const state = view.match(/private var lastEmittedTextChange:[^\n]+/)?.[0];
  if (!state) throw new Error('Missing production text-notification state');
  const work = await mkdtemp(join(tmpdir(), 'yuri-composer-composition-'));
  try {
    const source = `
import Foundation
final class UITextView {
    var text: String? = "你"
    var selectedRange = NSRange(location: 1, length: 0)
    var markedTextRange: NSRange? = NSRange(location: 0, length: 1)
}
final class YuriComposerView {
    let textView = UITextView()
    var applyingExternalText = false
    var delegate: Plugin?
    ${state}
    var isComposing: Bool { textView.markedTextRange != nil }
    ${method(view, 'func textViewDidChangeSelection(')}
    ${method(view, 'private func emitTextChange(')}
}
final class Plugin {
    var events: [[String: Any]] = []
    func notifyListeners(_ name: String, data: [String: Any]) { events.append(data) }
    ${method(plugin, 'func composerViewDidChangeText(')}
}
let composer = YuriComposerView()
let plugin = Plugin()
composer.delegate = plugin
var failures: [String] = []
func check(_ condition: Bool, _ name: String) { if !condition { failures.append(name) } }
func selectionChanged() { composer.textViewDidChangeSelection(composer.textView) }
selectionChanged()
check(plugin.events.last?["composing"] as? Bool == true, "marked text must report composing")
for _ in 0..<50 { selectionChanged() }
check(plugin.events.count == 1, "unchanged composition must not repeat events")
// UIKit can clear the marked range after the committed text/caret already arrived.
composer.textView.markedTextRange = nil
selectionChanged()
check(plugin.events.count == 2, "composition completion notification missing")
check(plugin.events.last?["composing"] as? Bool == false, "completion still composing")
check(plugin.events.last?["text"] as? String == "你", "commit changed text")
check(plugin.events.last?["selectionStart"] as? Int == 1, "commit moved caret")
for _ in 0..<50 { selectionChanged() }
check(plugin.events.count == 2, "completed selection callbacks repeated events")
composer.textView.markedTextRange = NSRange(location: 0, length: 1)
selectionChanged()
check(plugin.events.count == 3 && plugin.events.last?["composing"] as? Bool == true, "same-text new composition missing")
composer.applyingExternalText = true
composer.textView.markedTextRange = nil
selectionChanged()
check(plugin.events.count == 3, "external update echoed")
composer.applyingExternalText = false
selectionChanged()
check(plugin.events.count == 4 && plugin.events.last?["composing"] as? Bool == false, "external update swallowed later completion")
composer.textView.selectedRange = NSRange(location: 0, length: 1)
selectionChanged()
check(plugin.events.count == 5 && plugin.events.last?["selectionEnd"] as? Int == 1, "normal selection change missing")
print(failures.isEmpty ? "PASS production Swift composition notifications" : "FAIL: " + failures.joined(separator: "; "))
`;
    const input = join(work, 'main.swift');
    const binary = join(work, 'probe');
    await writeFile(input, source);
    execFileSync('swiftc', [input, '-o', binary], { timeout: 60_000 });
    const output = execFileSync(binary, [], { encoding: 'utf8', timeout: 10_000 });
    expect(output.trim()).toBe('PASS production Swift composition notifications');
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}, 90_000);
