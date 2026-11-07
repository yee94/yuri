import Foundation

enum RuntimeHostScopeFailure: String, LocalizedError {
    case invalid = "runtime_host_scope_invalid"
    case required = "runtime_host_scope_required"
    case stale = "runtime_host_scope_stale"
    case background = "runtime_background"
    case unavailable = "runtime_host_unavailable"
    var errorDescription: String? { rawValue }
}

/// Process-local admission receipt, not a persisted connection version or provider
/// configuration revision. Neither Codable nor ConnectionStore owns this value.
struct RuntimeHostScope: Equatable {
    let hostID: String
    let lease: UUID
    init(hostID: String, lease: UUID) { self.hostID = hostID; self.lease = lease }
    init(_ input: Any?) throws {
        guard let value = input as? [String: Any], Set(value.keys) == ["hostID", "lease"],
              let hostID = value["hostID"] as? String, !hostID.isEmpty, hostID.utf8.count <= 256,
              !hostID.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              let raw = value["lease"] as? String, raw.utf8.count == 36, let lease = UUID(uuidString: raw) else { throw RuntimeHostScopeFailure.invalid }
        self.hostID = hostID; self.lease = lease
    }
    var publicValue: [String: Any] { ["hostID": hostID, "lease": lease.uuidString.lowercased()] }
}

/// Closed until native foreground admission. Observing a snapshot never creates or
/// refreshes a lease; only explicit successful lifecycle/connection transitions do.
@MainActor final class RuntimeHostAuthority {
    private(set) var isForeground = false
    private var issued: RuntimeHostScope?
    func scope(hostID: String?) -> RuntimeHostScope? {
        guard isForeground, let issued, issued.hostID == hostID else { return nil }; return issued
    }
    func rotate(hostID: String?) {
        issued = isForeground ? hostID.map { RuntimeHostScope(hostID: $0, lease: UUID()) } : nil
    }
    @discardableResult func setForeground(_ active: Bool, hostID: String?) -> Bool {
        guard active != isForeground else { return false }
        isForeground = active; rotate(hostID: hostID); return true
    }
    func admit(_ expected: RuntimeHostScope?, hostID: String?, required: Bool) throws -> RuntimeHostScope {
        guard isForeground else { throw RuntimeHostScopeFailure.background }
        if required && expected == nil { throw RuntimeHostScopeFailure.required }
        guard let current = scope(hostID: hostID) else { throw RuntimeHostScopeFailure.unavailable }
        if let expected, expected != current { throw RuntimeHostScopeFailure.stale }
        return current
    }
    func matches(_ expected: RuntimeHostScope, hostID: String?) -> Bool { scope(hostID: hostID) == expected }
}
