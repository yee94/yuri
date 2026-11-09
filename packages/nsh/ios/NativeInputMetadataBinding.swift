import Foundation
import CoreFoundation

/// One atomic registration snapshot. Container identity and editor AX identity are separate.
struct NativeInputMetadataConfig: Equatable {
    let ownerID: String
    let inputID: String
    let expectedKind: String
    let editorAXID: String
    let label: String
    let active: Bool

    init?(_ value: Any?) {
        guard let data = value as? [String: Any], data.count == 6,
              let ownerID = data["ownerID"] as? String, !ownerID.isEmpty,
              let inputID = data["inputID"] as? String, !inputID.isEmpty,
              let kind = data["expectedKind"] as? String, kind == "multiline",
              let editorAXID = data["editorAXID"] as? String, !editorAXID.isEmpty, editorAXID != inputID,
              let label = data["label"] as? String, !label.isEmpty,
              let active = data["active"] as? NSNumber, CFGetTypeID(active) == CFBooleanGetTypeID() else { return nil }
        self.ownerID = ownerID; self.inputID = inputID; expectedKind = kind
        self.editorAXID = editorAXID; self.label = label; self.active = active.boolValue
    }
}

/// Public view relationships only; UIKit and the executable state fixture use the same resolver.
struct NativeInputMetadataAccess<Node: AnyObject> {
    let parent: (Node) -> Node?
    let children: (Node) -> [Node]
    let window: (Node) -> Node?
    let kind: (Node) -> String?
    let identifier: (Node) -> String?
    let label: (Node) -> String?
    let writeIdentifier: (Node, String?) -> Void
    let writeLabel: (Node, String?) -> Void
}

private struct InputMetadataField {
    var original: String?
    var lastWritten: String?
    var owns = false
    var yielded = false

    mutating func observe(_ current: String?) {
        if owns && current != lastWritten { owns = false; yielded = true }
    }
    mutating func prepare(_ current: String?, desired: String?) -> Bool {
        observe(current)
        guard !yielded else { return false }
        if !owns { original = current }
        owns = true; lastWritten = desired
        return current != desired
    }
    mutating func release(_ current: String?) -> (restore: Bool, value: String?) {
        observe(current)
        let result = (owns && current == lastWritten, original)
        owns = false; original = nil; lastWritten = nil
        return result
    }
}

/// Fixed multiline paired-local binding. No editor traits, delegates, text or focus ownership.
final class NativeInputMetadataBinding<Node: AnyObject> {
    private let access: NativeInputMetadataAccess<Node>
    private weak var registration: Node?
    private weak var editor: Node?
    private weak var boundHost: Node?, boundOwner: Node?, boundContainer: Node?, boundWindow: Node?
    private var identifier = InputMetadataField(), label = InputMetadataField()
    private var config: NativeInputMetadataConfig?
    private var enabled = true
    private var generation = 0
    private var pending: Int?

    init(registration: Node, access: NativeInputMetadataAccess<Node>) {
        self.registration = registration; self.access = access
    }
    deinit { retire() }

    func update(_ value: Any?) {
        generation += 1; pending = nil
        config = NativeInputMetadataConfig(value)
        reconcile()
    }
    func lifecycle(_ active: Bool) {
        generation += 1; pending = nil; enabled = active
        reconcile()
    }
    func changed() {
        generation += 1; pending = nil
        reconcile()
    }
    /// At most one queued mount-order retry; old callbacks cannot adopt a new lease.
    func enqueue(_ schedule: (@escaping () -> Void) -> Void) {
        guard pending == nil, enabled, config?.active == true else { return }
        let ticket = generation; pending = ticket
        schedule { [weak self] in
            guard let self, self.pending == ticket, self.generation == ticket else { return }
            self.pending = nil; self.reconcile()
        }
    }
    private struct Target {
        let host: Node, owner: Node, container: Node, editor: Node, window: Node
        func matches(_ other: Target) -> Bool {
            host === other.host && owner === other.owner && container === other.container && editor === other.editor && window === other.window
        }
    }
    private func resolve() -> Target? {
        guard enabled, let config, config.active, let registration,
              let window = access.window(registration), let host = access.parent(registration),
              let owner = access.parent(host), access.identifier(owner) == config.ownerID,
              access.window(host) === window, access.window(owner) === window else { return nil }
        let containers = access.children(owner).filter { $0 !== host && access.identifier($0) == config.inputID }
        guard containers.count == 1, let container = containers.first,
              access.parent(container) === owner, access.window(container) === window else { return nil }
        let editors = access.children(container).filter { access.kind($0) != nil }
        guard editors.count == 1, let editor = editors.first,
              access.kind(editor) == config.expectedKind, access.parent(editor) === container,
              access.window(editor) === window,
              access.parent(registration) === host, access.parent(host) === owner else { return nil }
        return Target(host: host, owner: owner, container: container, editor: editor, window: window)
    }
    func reconcile() {
        guard let target = resolve(), let config else { retire(); return }
        if target.editor !== editor || target.host !== boundHost || target.owner !== boundOwner || target.container !== boundContainer || target.window !== boundWindow {
            let replacement = target.editor !== editor
            retire(); editor = target.editor
            if replacement { identifier = InputMetadataField(); label = InputMetadataField() }
            boundHost = target.host; boundOwner = target.owner
            boundContainer = target.container; boundWindow = target.window
        }
        guard let fresh = resolve(), target.matches(fresh) else { retire(); return }
        if identifier.prepare(access.identifier(target.editor), desired: config.editorAXID) {
            access.writeIdentifier(target.editor, config.editorAXID)
        }
        guard let fresh = resolve(), target.matches(fresh) else { retire(); return }
        if label.prepare(access.label(target.editor), desired: config.label) {
            access.writeLabel(target.editor, config.label)
        }
    }
    /// Rollback touches only the captured editor, never a newly discovered replacement.
    func retire() {
        boundHost = nil; boundOwner = nil; boundContainer = nil; boundWindow = nil
        guard let editor else { return }
        let id = identifier.release(access.identifier(editor))
        if id.restore { access.writeIdentifier(editor, id.value) }
        let text = label.release(access.label(editor))
        if text.restore { access.writeLabel(editor, text.value) }
        // Keep only a weak editor and per-field yielding across inactive/invalid snapshots.
        // A late application write is never reclaimed on that editor's next activation.
    }
}
