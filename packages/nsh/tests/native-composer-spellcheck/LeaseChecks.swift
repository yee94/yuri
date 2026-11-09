import Foundation

private final class Editor {
    var trait = 0, marked = false, writes: [Int] = []
}
private final class WeakEditor {
    weak var value: Editor?
    init(_ value: Editor?) { self.value = value }
}
private let access = NativeComposerSpellcheckAccess<Editor>(read: { $0.trait }, marked: { $0.marked }, write: { $0.trait = $1; $0.writes.append($1) }, yes: 1)

private final class Fixture {
    var editor: Editor? = Editor()
    var resolved = true
    var restorations: [NativeComposerSpellcheckLease<Editor>] = []
    var coordinator: NativeComposerSpellcheckCoordinator<Editor>!
    init() {
        coordinator = NativeComposerSpellcheckCoordinator(resolve: { [weak self] in
            guard let self, self.resolved else { return nil }; return self.editor
        }, access: access, retired: { [weak self] lease in if lease.pendingRestore { self?.restorations.append(lease) } })
    }
}

private final class Node {
    weak var parent: Node?, window: Node?
    var children: [Node] = []
    var id: String?, kind: String?
    init(_ id: String? = nil, _ kind: String? = nil) { self.id = id; self.kind = kind }
    func add(_ child: Node) { children.append(child); child.parent = self; child.window = window }
}

@main private enum Checks {
    static func main() {
        var count = 0
        func check(_ name: String, _ body: () -> Void) { body(); count += 1; print("PASS \(name)") }
        check("only complete fixed local IDs are accepted; no active/Host preference config") {
            precondition(NativeComposerSpellcheckConfig(["ownerID": "glass", "inputID": "composer"]) != nil)
            for invalid in [["ownerID": "glass"], ["ownerID": "", "inputID": "composer"], ["ownerID": "glass", "inputID": "composer", "active": "false"]] {
                precondition(NativeComposerSpellcheckConfig(invalid) == nil)
            }
        }
        check("first safe resolve writes yes once; 100 changes do not repeat the setter") {
            let f = Fixture(); f.coordinator.reconcile()
            for _ in 0..<100 { f.coordinator.reconcile(); f.coordinator.event(editor: f.editor!, generation: f.coordinator.generation) }
            precondition(f.editor!.trait == 1 && f.editor!.writes == [1])
        }
        check("initial yes is not claimed or restored") {
            let f = Fixture(); f.editor!.trait = 1; f.coordinator.reconcile(); f.coordinator.remove()
            precondition(f.editor!.writes.isEmpty && f.editor!.trait == 1)
        }
        check("active, background, Host and window changes retain the same editor lease") {
            let f = Fixture(); f.coordinator.reconcile()
            for _ in ["hidden", "background", "Host changed", "window removed"] {
                f.resolved = false; f.coordinator.reconcile()
                precondition(f.editor!.trait == 1 && f.editor!.writes == [1])
                f.resolved = true; f.coordinator.configure()
                precondition(f.editor!.writes == [1])
            }
        }
        check("IME waits; exact current-generation event writes only after marked text clears") {
            let f = Fixture(); let editor = f.editor!; editor.marked = true; f.coordinator.reconcile()
            precondition(f.coordinator.lease!.pendingEnable && editor.writes.isEmpty)
            f.coordinator.event(editor: editor, generation: f.coordinator.generation)
            precondition(editor.writes.isEmpty)
            editor.marked = false; f.coordinator.event(editor: editor, generation: f.coordinator.generation)
            precondition(editor.writes == [1] && !f.coordinator.lease!.pendingEnable)
        }
        check("removing an unwritten IME consumer cancels enable permanently") {
            let f = Fixture(); let editor = f.editor!; editor.marked = true; f.coordinator.reconcile()
            let lease = f.coordinator.lease!, generation = f.coordinator.generation
            f.coordinator.remove(); editor.marked = false
            f.coordinator.event(editor: editor, generation: generation); lease.enable(if: { true }); lease.restore()
            precondition(editor.writes.isEmpty && f.restorations.isEmpty && !lease.pendingEnable)
        }
        check("IME retirement keeps yes until safe and then only restores, never re-enables") {
            let f = Fixture(); let editor = f.editor!; editor.trait = 2; f.coordinator.reconcile()
            editor.marked = true; f.coordinator.remove()
            precondition(editor.writes == [1] && f.restorations.count == 1)
            let ticket = f.restorations[0]; ticket.restore(); precondition(editor.writes == [1])
            editor.marked = false; ticket.restore(); ticket.enable(if: { true }); ticket.restore()
            precondition(editor.writes == [1, 2] && !ticket.pendingRestore)
        }
        check("external late write yields immediately when pending restoration is checked") {
            let f = Fixture(); let editor = f.editor!; f.coordinator.reconcile(); editor.marked = true; f.coordinator.remove()
            editor.trait = 2; f.restorations[0].restore(); editor.marked = false; f.restorations[0].restore()
            precondition(editor.trait == 2 && editor.writes == [1] && !f.restorations[0].pendingRestore)
        }
        check("owned late write is not reclaimed on layout or props, and is not restored") {
            let f = Fixture(); let editor = f.editor!; f.coordinator.reconcile(); editor.trait = 2
            f.coordinator.reconcile(); f.coordinator.configure(); f.coordinator.remove()
            precondition(editor.trait == 2 && editor.writes == [1])
        }
        check("late event cannot write a replacement or an old composer generation") {
            let f = Fixture(); let old = f.editor!; old.marked = true; f.coordinator.reconcile()
            let generation = f.coordinator.generation
            let replacement = Editor(); replacement.marked = true; f.editor = replacement
            old.marked = false; f.coordinator.event(editor: old, generation: generation)
            precondition(old.writes.isEmpty && replacement.writes.isEmpty)
            f.coordinator.reconcile(); replacement.marked = false
            f.coordinator.event(editor: old, generation: generation)
            f.coordinator.event(editor: replacement, generation: generation)
            precondition(replacement.writes.isEmpty)
            f.coordinator.event(editor: replacement, generation: f.coordinator.generation)
            precondition(replacement.writes == [1] && old.writes.isEmpty)
        }
        check("retired old-object ticket cannot target the replacement") {
            let f = Fixture(); let old = f.editor!; f.coordinator.reconcile(); old.marked = true
            let replacement = Editor(); f.editor = replacement; f.coordinator.reconcile()
            precondition(f.restorations.count == 1 && replacement.writes == [1])
            old.marked = false; f.restorations[0].restore()
            precondition(old.writes == [1, 0] && replacement.writes == [1])
        }
        check("pending restoration and active leases never keep their editor alive") {
            let f = Fixture(); let editor = WeakEditor(f.editor)
            f.coordinator.reconcile(); f.editor!.marked = true; f.coordinator.remove()
            precondition(f.restorations.count == 1)
            f.editor = nil; precondition(editor.value == nil)
            f.restorations[0].restore(); precondition(!f.restorations[0].pendingRestore)
            let active = Fixture(); let activeEditor = WeakEditor(active.editor)
            active.coordinator.reconcile(); active.editor = nil; precondition(activeEditor.value == nil)
        }
        check("standalone consumer removal restores while original editor remains mounted") {
            let f = Fixture(); let editor = f.editor!; f.coordinator.reconcile(); f.coordinator.remove()
            f.coordinator.reconcile(); f.coordinator.event(editor: editor, generation: f.coordinator.generation)
            precondition(editor.writes == [1, 0] && f.editor === editor)
        }
        check("invalid props retire safely; coordinator destruction also retires") {
            let f = Fixture(); let editor = f.editor!; f.coordinator.reconcile(); f.coordinator.reset()
            precondition(editor.writes == [1, 0])
            f.coordinator.configure(); f.coordinator = nil
            precondition(editor.writes == [1, 0, 1, 0])
        }
        check("resolver rejects missing/duplicate ID, wrong kind, two editors and unrelated neighbors") {
            let tree = NativeComposerSpellcheckTree<Node>(parent: { $0.parent }, children: { $0.children }, window: { $0.window }, identifier: { $0.id }, editorKind: { $0.kind })
            let config = NativeComposerSpellcheckConfig(["ownerID": "glass", "inputID": "composer"])!
            for mutation in 0..<7 {
                let window = Node(), otherWindow = Node(), wrapper = Node("glass"), host = Node(), registration = Node(), container = Node("composer"), editor = Node(nil, "multiline")
                wrapper.window = window; wrapper.add(host); host.add(registration); wrapper.add(container); container.add(editor)
                precondition(tree.resolve(registration, config: config) === editor)
                switch mutation {
                case 0: container.id = "other"
                case 1: wrapper.add(Node("composer"))
                case 2: editor.kind = "singleline"
                case 3: container.add(Node(nil, "singleline"))
                case 4: wrapper.id = "wrong"
                case 5: editor.window = otherWindow
                default: registration.parent = wrapper
                }
                precondition(tree.resolve(registration, config: config) == nil)
            }
            let window = Node(), wrapper = Node("glass"), host = Node(), registration = Node(), container = Node("composer"), editor = Node(nil, "multiline"), sheet = Node()
            wrapper.window = window; wrapper.add(host); host.add(registration); wrapper.add(container); container.add(editor)
            wrapper.add(sheet); sheet.add(Node("composer", "singleline"))
            precondition(tree.resolve(registration, config: config) === editor)
        }
        check("validation is repeated before the first setter") {
            let editor = Editor(); let lease = NativeComposerSpellcheckLease(editor: editor, access: access)
            var calls = 0
            lease.enable { calls += 1; return calls == 1 }
            precondition(editor.writes.isEmpty && lease.pendingEnable)
        }
        print("\(count) composer spellcheck state checks passed")
    }
}
