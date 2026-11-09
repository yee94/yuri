import Foundation
#if canImport(NativeShell)
import NativeShell

/// Main owns this bridge alongside RuntimeBridge; it never performs reset POSTs.
@MainActor final class AuthorizationCacheCleanupBridge {
    private weak var app: NshAppView?
    private let owner: AuthorizationCacheCleanup
    private let afterSweep: () async throws -> Void

    init(app: NshAppView, pending: @escaping () -> Set<AuthorizationCacheCleanup.Identity>, afterSweep: @escaping () async throws -> Void) {
        self.app = app
        owner = AuthorizationCacheCleanup(pending: pending)
        self.afterSweep = afterSweep
        for name in ["ready", "list", "claim", "ack", "retry"] {
            app.handle("authorization.cache.\(name)") { [weak self] input async throws -> Any? in
                guard let self else { throw CancellationError() }
                let keys: Set<String> = name == "ready" || name == "retry" ? [] : name == "list" ? ["owner"] : ["owner", "ticket"]
                let fields = try Self.fields(input, keys: keys)
                switch name {
                case "ready": return self.owner.ready()
                case "list": return try self.owner.list(owner: fields["owner"]!)
                case "claim": return try self.owner.claim(owner: fields["owner"]!, ticket: fields["ticket"]!)
                case "ack": try self.owner.ack(owner: fields["owner"]!, ticket: fields["ticket"]!); return true
                default: try await self.afterSweep(); return true
                }
            }
        }
    }

    func requestSweep() { app?.send("authorization.cache.pending", [:]) }

    func requireCompletion(connectionID: String, authorizationID: String) throws {
        try owner.requireCompletion(connectionID: connectionID, authorizationID: authorizationID)
    }

    private static func fields(_ input: Any?, keys: Set<String>) throws -> [String: String] {
        guard let fields = input as? [String: Any], Set(fields.keys) == keys else { throw Failure.invalidInput }
        var result: [String: String] = [:]
        for key in keys {
            guard let value = fields[key] as? String, !value.isEmpty, value.utf8.count <= 128,
                  value.utf8.allSatisfy({ (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45 || $0 == 95 }) else { throw Failure.invalidInput }
            result[key] = value
        }
        return result
    }
    private enum Failure: LocalizedError {
        case invalidInput
        var errorDescription: String? { "authorization_cache_invalid_input" }
    }
}
#endif
