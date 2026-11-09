import Foundation

private final class Node {
    weak var parent: Node?
    weak var window: Node?
    var children: [Node] = []
    var id: String?, label: String?, kind: String?
    var idWrites = 0, labelWrites = 0
    var afterIDWrite: (() -> Void)?
    init(_ id: String? = nil, kind: String? = nil) { self.id = id; self.kind = kind }
    func add(_ child: Node) { children.append(child); child.parent = self; child.window = window }
    func remove(_ child: Node) { children.removeAll { $0 === child }; child.parent = nil; child.window = nil }
}

private let access = NativeInputMetadataAccess<Node>(
    parent: { $0.parent }, children: { $0.children }, window: { $0.window }, kind: { $0.kind },
    identifier: { $0.id }, label: { $0.label },
    writeIdentifier: { $0.id = $1; $0.idWrites += 1; $0.afterIDWrite?() },
    writeLabel: { $0.label = $1; $0.labelWrites += 1 }
)
private func snapshot(_ overrides: [String: Any] = [:]) -> [String: Any] {
    ["ownerID": "glass", "inputID": "composer", "expectedKind": "multiline", "editorAXID": "editor-1", "label": "写消息", "active": true].merging(overrides) { _, new in new }
}
private final class Fixture {
    let window = Node(), wrapper = Node("glass"), host = Node(), registration = Node()
    let container = Node("composer"), editor = Node(nil, kind: "multiline")
    var binding: NativeInputMetadataBinding<Node>!
    init() {
        wrapper.window = window; wrapper.add(host); host.add(registration)
        wrapper.add(container); container.add(editor)
        binding = NativeInputMetadataBinding(registration: registration, access: access)
    }
}

@main private enum Checks {
    static func main() {
        var count = 0
        func check(_ name: String, _ run: () -> Void) { run(); count += 1; print("PASS \(name)") }
        check("atomic config rejects missing, extra, wrong kind, numeric active and empty label") {
            let f = Fixture()
            for key in snapshot().keys {
                var invalid = snapshot(); invalid.removeValue(forKey: key)
                f.binding.update(invalid); precondition(f.editor.id == nil)
            }
            for invalid in [snapshot(["extra": true]), snapshot(["expectedKind": "singleline"]), snapshot(["active": 1]), snapshot(["label": ""]), snapshot(["editorAXID": "composer"])] {
                f.binding.update(invalid); precondition(f.editor.id == nil)
            }
        }
        check("nil and empty originals round trip independently; unchanged reconcile performs zero setters") {
            let f = Fixture(); f.editor.label = ""
            f.binding.update(snapshot())
            precondition(f.editor.id == "editor-1" && f.editor.label == "写消息")
            for _ in 0..<100 { f.binding.reconcile() }
            precondition(f.editor.idWrites == 1 && f.editor.labelWrites == 1)
            f.binding.update(nil)
            precondition(f.editor.id == nil && f.editor.label == "")
        }
        check("missing and duplicate local input IDs retire an existing binding") {
            for duplicate in [false, true] {
                let f = Fixture(); f.binding.update(snapshot())
                if duplicate { f.wrapper.add(Node("composer")) } else { f.container.id = "other" }
                f.binding.changed(); precondition(f.editor.id == nil && f.editor.label == nil)
                precondition(f.container.id == (duplicate ? "composer" : "other"))
            }
        }
        check("wrong kind, two public editors, wrong wrapper and wrong ancestry fail closed") {
            for mutation in 0..<5 {
                let f = Fixture(); f.binding.update(snapshot())
                let otherWindow = Node()
                switch mutation {
                case 0: f.editor.kind = "singleline"
                case 1: f.container.add(Node(nil, kind: "singleline"))
                case 2: f.wrapper.id = "other"
                case 3: let extra = Node(); f.wrapper.remove(f.host); f.wrapper.add(extra); extra.add(f.host)
                default: f.editor.window = otherWindow
                }
                f.binding.changed(); precondition(f.editor.id == nil && f.editor.label == nil)
            }
        }
        check("late application label write yields only label across config, invalid props and lifecycle") {
            let f = Fixture(); f.binding.update(snapshot()); f.editor.label = "application"
            f.binding.update(snapshot(["label": "owner-new", "editorAXID": "editor-2"]))
            precondition(f.editor.label == "application" && f.editor.id == "editor-2")
            f.binding.update(nil); f.binding.update(snapshot())
            f.binding.lifecycle(false); f.binding.lifecycle(true)
            precondition(f.editor.label == "application" && f.editor.labelWrites == 1)
            f.binding.retire(); precondition(f.editor.id == nil && f.editor.label == "application")
        }
        check("late nil/empty identifier writes are preserved and never reclaimed") {
            for late in [nil, ""] as [String?] {
                let f = Fixture(); f.editor.id = "original"; f.binding.update(snapshot()); f.editor.id = late
                f.binding.changed(); f.binding.update(snapshot(["editorAXID": "editor-2"]))
                precondition(f.editor.id == late && f.editor.idWrites == 1)
                f.binding.retire(); precondition(f.editor.id == late && f.editor.label == nil)
            }
        }
        check("detach without parent restores and stale queued retry cannot bind") {
            let f = Fixture(); var queued: [() -> Void] = []
            f.binding.update(snapshot()); f.binding.enqueue { queued.append($0) }
            f.host.remove(f.registration); f.binding.changed()
            queued.forEach { $0() }
            precondition(f.editor.id == nil && f.editor.label == nil)
        }
        check("replacement restores old editor and adopts only exact current direct editor") {
            let f = Fixture(); f.editor.label = "original"; f.binding.update(snapshot())
            f.container.remove(f.editor); let replacement = Node(nil, kind: "multiline"); f.container.add(replacement)
            f.binding.changed()
            precondition(f.editor.id == nil && f.editor.label == "original")
            precondition(replacement.id == "editor-1" && replacement.label == "写消息")
            f.binding.lifecycle(false); precondition(replacement.id == nil)
        }
        check("between-field topology change prevents second write") {
            let f = Fixture(); f.editor.afterIDWrite = { [weak f] in f?.editor.window = nil }
            f.binding.update(snapshot())
            precondition(f.editor.labelWrites == 0 && f.editor.id == nil)
        }
        check("coalesced retry, invalid props and newer generation fence old tasks") {
            let f = Fixture(); var queued: [() -> Void] = []
            f.binding.update(snapshot()); f.binding.enqueue { queued.append($0) }; f.binding.enqueue { queued.append($0) }
            precondition(queued.count == 1)
            f.binding.update(snapshot(["active": false])); queued[0]()
            precondition(f.editor.id == nil)
            f.binding.update(snapshot(["label": "new"])); queued[0]()
            precondition(f.editor.label == "new")
        }
        check("two retained pages with same local IDs stay isolated; Sheet neighbor is ignored") {
            let a = Fixture(), b = Fixture(); a.binding.update(snapshot())
            b.binding.update(snapshot(["editorAXID": "editor-2", "active": false]))
            let sheet = Node("sheet"); a.wrapper.add(sheet); sheet.add(Node("composer", kind: "singleline"))
            a.binding.changed()
            precondition(a.editor.id == "editor-1" && b.editor.id == nil)
            a.binding.lifecycle(false); b.binding.update(snapshot(["editorAXID": "editor-2"]))
            precondition(a.editor.id == nil && b.editor.id == "editor-2")
        }
        check("deinit restores only owned current-equal fields") {
            let f = Fixture(); var queued: [() -> Void] = []
            f.binding.update(snapshot()); f.editor.label = "late"
            f.binding.enqueue { queued.append($0) }
            f.binding = nil
            queued.forEach { $0() }
            precondition(f.editor.id == nil && f.editor.label == "late")
        }
        print("\(count) native input metadata state checks passed")
    }
}
