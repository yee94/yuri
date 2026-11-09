import Foundation

struct NativeFontProjection: Equatable {
    var ui = "system-ui"
    var mono = "monospace"
    var assistantLight = "system-ui"
    var assistantDark = "system-ui"
    var unsupported: [String] = []
    var status = "ready"
    var ticket = 0
    var value: [String: Any] {
        ["uiFontFamily": ui, "monoFontFamily": mono,
         "assistantFontFamilies": ["light": assistantLight, "dark": assistantDark],
         "unsupportedFonts": unsupported, "fontStatus": status, "fontTicket": ticket]
    }
}

/// One selected appearance's font projection, independent of palette ownership.
/// Immutable catalog bytes may finish after retirement; process registration
/// and projection publication both require this exact live selection/revision.
@MainActor final class NativeFontOwner {
    struct Dependencies {
        var cached: @MainActor (NativeFontDefinition) -> NativeRegisteredFont?
        var load: @MainActor (NativeFontDefinition, @escaping NativeFontRegistry.Authorization) async throws -> NativeRegisteredFont
        var bundledMono: @MainActor () -> String?
        static func registry(_ registry: NativeFontRegistry) -> Self {
            Self(cached: registry.cached, load: registry.load, bundledMono: registry.bundledMono)
        }
    }
    private let dependencies: Dependencies
    private let changed: (String, Int, NativeFontProjection) -> Void
    private var operation = 0
    private var hostID: String?
    private var revision = 0
    private var selected: [String: String] = [:]
    private var pending: Set<String> = []
    private var failed: Set<String> = []
    private var unsupported: Set<String> = []
    private var tasks: [Task<Void, Never>] = []
    private(set) var projection = NativeFontProjection()
    init(dependencies: Dependencies, changed: @escaping (String, Int, NativeFontProjection) -> Void) { self.dependencies = dependencies; self.changed = changed }
    func invalidate() {
        operation += 1; tasks.forEach { $0.cancel() }; tasks = []
        hostID = nil; selected = [:]; pending = []; failed = []; unsupported = []
        projection = NativeFontProjection()
    }
    func select(hostID: String, revision: Int, fonts: [String: String], retry: Bool = false) -> NativeFontProjection {
        if !retry, self.hostID == hostID, self.revision == revision, selected == fonts { return projection }
        operation += 1; tasks.forEach { $0.cancel() }; tasks = []
        self.hostID = hostID; self.revision = revision; selected = fonts
        let captured = operation
        pending = []; failed = []; unsupported = []
        projection.ticket = captured
        for (role, kind, system) in [("ui", "ui", "system-ui"), ("mono", "mono", "monospace")] {
            let family = fonts[role] ?? system
            if family == system { assign(role, system); continue }
            guard let definition = NativeFontCatalog.family(family), definition.kind == kind else { unsupported.insert(family); continue }
            if let cached = dependencies.cached(definition) { assign(role, Self.stack(cached.family, kind: kind)); continue }
            pending.insert(role)
            tasks.append(Task { [weak self, dependencies] in
                let result: Result<NativeRegisteredFont, Error>
                let authorized: NativeFontRegistry.Authorization = { [weak self] in
                    guard let self else { return false }
                    return !Task.isCancelled && captured == self.operation && self.hostID == hostID && self.revision == revision
                }
                do { result = .success(try await dependencies.load(definition, authorized)) } catch { result = .failure(error) }
                guard let self, !Task.isCancelled, captured == self.operation, self.hostID == hostID, self.revision == revision else { return }
                self.pending.remove(role)
                switch result {
                case .success(let value): self.assign(role, Self.stack(value.family, kind: kind))
                case .failure: self.failed.insert(role)
                }
                self.resolveAssistants(); self.updateStatus()
                self.changed(hostID, revision, self.projection)
            })
        }
        resolveAssistants(); updateStatus()
        return projection
    }
    private func assign(_ role: String, _ family: String) {
        if role == "ui" { projection.ui = family } else { projection.mono = family }
    }
    private func resolveAssistants() {
        func resolve(_ key: String) -> String {
            let name = selected[key] ?? "system-ui"
            if name == "system-ui" || name == "monospace" { return name }
            if name == selected["ui"], !pending.contains("ui"), !failed.contains("ui") { return projection.ui }
            if name == selected["mono"], !pending.contains("mono"), !failed.contains("mono") { return projection.mono }
            if let definition = NativeFontCatalog.family(name), let value = dependencies.cached(definition) { return Self.stack(value.family, kind: definition.kind) }
            if name == "JetBrains Mono", let family = dependencies.bundledMono() { return family }
            // A renderer family never creates a CDN URL or initiates a download.
            unsupported.insert(name)
            return projection.ui
        }
        unsupported = Set(unsupported.filter { $0 == selected["ui"] || $0 == selected["mono"] })
        projection.assistantLight = resolve("assistantLight")
        projection.assistantDark = resolve("assistantDark")
    }
    private func updateStatus() {
        projection.unsupported = unsupported.sorted()
        projection.status = !pending.isEmpty ? "loading" : !failed.isEmpty ? "failed" : !unsupported.isEmpty ? "unsupported" : "ready"
    }
    private static func stack(_ family: String, kind: String) -> String { family + (kind == "mono" ? ", monospace" : ", system-ui") }
}
