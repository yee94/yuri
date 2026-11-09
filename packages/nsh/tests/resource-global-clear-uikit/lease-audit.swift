// Appended after the unchanged ResourceBridge.swift. Only the fixture's handler
// observes release; the actual production release method owns the operation.
@MainActor extension ResourceBridge {
    func installGlobalClearLeaseAudit(on surface: NshAppView, audit: GlobalClearAudit) {
        surface.handle("resources.release") { [weak self] input async throws -> Any? in
            if let key = (input as? [String: Any])?["lease"] as? String, let self {
                let existed = self.leases[key] != nil
                self.release(key)
                if existed, self.leases[key] == nil { audit.record(.leaseRelease) }
            }
            return true
        }
    }
}
