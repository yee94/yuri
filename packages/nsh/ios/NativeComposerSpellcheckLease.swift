import Foundation

struct NativeComposerSpellcheckConfig: Equatable {
    let ownerID: String, inputID: String
    init?(_ value: Any?) {
        guard let value = value as? [String: Any], value.count == 2,
              let ownerID = value["ownerID"] as? String, !ownerID.isEmpty,
              let inputID = value["inputID"] as? String, !inputID.isEmpty else { return nil }
        self.ownerID = ownerID; self.inputID = inputID
    }
}

/// A separate resolver: AX's active/window retirement policy is intentionally not shared.
struct NativeComposerSpellcheckTree<Node: AnyObject> {
    let parent: (Node) -> Node?
    let children: (Node) -> [Node]
    let window: (Node) -> Node?
    let identifier: (Node) -> String?
    let editorKind: (Node) -> String?

    func resolve(_ registration: Node, config: NativeComposerSpellcheckConfig) -> Node? {
        guard let window = window(registration), let host = parent(registration), let owner = parent(host),
              identifier(owner) == config.ownerID, self.window(host) === window, self.window(owner) === window else { return nil }
        let containers = children(owner).filter { $0 !== host && identifier($0) == config.inputID }
        guard containers.count == 1, let container = containers.first,
              parent(container) === owner, self.window(container) === window else { return nil }
        let editors = children(container).filter { editorKind($0) != nil }
        guard editors.count == 1, let editor = editors.first, editorKind(editor) == "multiline",
              parent(editor) === container, self.window(editor) === window,
              parent(registration) === host, parent(host) === owner else { return nil }
        return editor
    }
}

struct NativeComposerSpellcheckAccess<Editor: AnyObject> {
    let read: (Editor) -> Int
    let marked: (Editor) -> Bool
    let write: (Editor, Int) -> Void
    let yes: Int
}

/// A trait lease belongs to this editor object, including when its page leaves a window.
/// After retirement this object can only restore the original trait; it can never enable again.
final class NativeComposerSpellcheckLease<Editor: AnyObject> {
    private(set) weak var editor: Editor?
    private let access: NativeComposerSpellcheckAccess<Editor>
    private var original: Int?
    private var retired = false, settled = false
    private(set) var pendingRestore = false
    var pendingEnable: Bool { !retired && !settled && editor != nil }

    init(editor: Editor, access: NativeComposerSpellcheckAccess<Editor>) {
        self.editor = editor; self.access = access
    }
    func enable(if valid: () -> Bool) {
        guard pendingEnable, let editor, valid(), !access.marked(editor), valid(), !access.marked(editor) else { return }
        let current = access.read(editor)
        settled = true
        guard current != access.yes else { return }
        original = current
        access.write(editor, access.yes)
    }
    func retire() {
        guard !retired else { return }
        retired = true
        pendingRestore = original != nil
        restore()
    }
    func restore() {
        guard retired, pendingRestore else { return }
        guard let editor, let original, access.read(editor) == access.yes else {
            pendingRestore = false; self.original = nil; return
        }
        guard !access.marked(editor) else { return }
        pendingRestore = false; self.original = nil
        access.write(editor, original)
    }
}

/// No active, Host or window lifetime inputs. Only a resolved replacement or explicit removal retires.
final class NativeComposerSpellcheckCoordinator<Editor: AnyObject> {
    typealias Lease = NativeComposerSpellcheckLease<Editor>
    private let resolve: () -> Editor?
    private let access: NativeComposerSpellcheckAccess<Editor>
    private let canEnable: (Editor) -> Bool
    private let retired: (Lease) -> Void
    private(set) var lease: Lease?
    private(set) var generation = 0
    private var disposed = false

    init(resolve: @escaping () -> Editor?, access: NativeComposerSpellcheckAccess<Editor>,
         canEnable: @escaping (Editor) -> Bool = { _ in true }, retired: @escaping (Lease) -> Void) {
        self.resolve = resolve; self.access = access; self.canEnable = canEnable; self.retired = retired
    }
    deinit { remove() }
    private func retireCurrent() {
        guard let lease else { return }
        self.lease = nil; lease.retire(); retired(lease)
    }
    func configure() { generation += 1; reconcile() }
    func reset() { generation += 1; retireCurrent() }
    func remove() {
        guard !disposed else { return }
        disposed = true; generation += 1; retireCurrent()
    }
    func reconcile() {
        guard !disposed, let editor = resolve() else { return }
        if lease?.editor !== editor {
            generation += 1; retireCurrent()
            lease = Lease(editor: editor, access: access)
        }
        attempt(editor: editor, generation: generation)
    }
    /// An exact-editor notification can only finish its captured generation, never adopt a replacement.
    func event(editor: Editor, generation: Int) { attempt(editor: editor, generation: generation) }
    private func attempt(editor: Editor, generation: Int) {
        guard !disposed, generation == self.generation, let lease, lease.editor === editor else { return }
        lease.enable { [self] in
            !disposed && generation == self.generation && self.lease === lease && resolve() === editor && canEnable(editor)
        }
    }
}
