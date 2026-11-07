import Foundation

/// Existing Host alert-token protocol only. The owning runtime must inject a captured, authenticated
/// POST/DELETE transport; resourceTransport.read is deliberately insufficient. Never serialize this owner.
@MainActor final class NativeNotificationAPNSRegistration {
    struct Context {
        let hostID: String
        let bundleID: String
        let locale: String
        /// Native release/Host evidence, not a boolean accepted from JS or a guessed default origin.
        let verifiedPushConfiguration: Bool
        let isCurrent: () -> Bool
        let request: (_ method: String, _ path: String, _ body: [String: String]) async throws -> (Int, [String: Any])
    }
    enum State: String { case disabled, blocked, awaitingOS, osRegistered, hostAccepted, failed, cleanupPending }
    private struct Registration { let context: Context; let token: Data }
    private var waiting: (revision: Int, context: Context)?
    private var registration: Registration?
    private var operation: Task<Bool, Never>?
    private var revision = 0
    private(set) var state: State = .disabled
    /// Returns whether the app delegate may issue ONE OS registration request. No OS call here.
    /// A retired OS request must drain its callback before a new request can start (callbacks have no ticket).
    func begin(_ context: Context) -> Bool {
        guard waiting == nil, registration == nil, operation == nil else { return false }
        guard context.verifiedPushConfiguration else { state = .blocked; return false }
        guard NativeNotificationPolicy.identifier(context.hostID), context.isCurrent(), NativeNotificationPolicy.languages.contains(context.locale),
              context.bundleID.utf8.count <= 255, context.bundleID.range(of: "^[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)+$", options: .regularExpression) != nil else { state = .failed; return false }
        revision += 1; waiting = (revision, context); state = .awaitingOS; return true
    }
    /// Native AppDelegate callback only. Device token remains Data in memory; never sent to JS/logs/disk.
    func didRegister(_ token: Data) async {
        guard let pending = waiting else { return }
        waiting = nil
        guard pending.revision == revision, pending.context.isCurrent() else { return }
        // Existing Push Relay schema requires a 32-byte APNs token; no arbitrary-string fallback.
        guard token.count == 32 else { state = .failed; return }
        let value = Registration(context: pending.context, token: token)
        registration = value; state = .osRegistered
        let work = Task { @MainActor in await Self.send(value, method: "POST") }
        operation = work
        let accepted = await work.value
        operation = nil
        guard revision == pending.revision, pending.context.isCurrent() else { state = .cleanupPending; return }
        state = accepted ? .hostAccepted : .failed // Host ACK is NOT Push Relay/APNs acceptance or delivery.
    }
    func didFailToRegister() {
        guard let pending = waiting else { return }; waiting = nil
        if pending.revision == revision { state = .failed }
    }
    /// Must be synchronous in runtime invalidation. Does not discard an uncertain POST or rebind its token.
    func invalidate() {
        revision += 1
        state = registration == nil ? .disabled : .cleanupPending
    }
    /// Call before retiring the captured native transport, then invalidate the runtime itself.
    /// Failure keeps the captured registration for explicit retry; it never sends DELETE to a new Host.
    @discardableResult func cancel() async -> Bool {
        invalidate()
        if let operation { _ = await operation.value }
        guard let value = registration else { return waiting == nil }
        guard operation == nil else { return false }
        let work = Task { @MainActor in await Self.send(value, method: "DELETE") }
        operation = work
        let accepted = await work.value
        operation = nil
        if accepted { registration = nil; state = .disabled }
        else { state = .cleanupPending }
        return accepted
    }
    private static func send(_ value: Registration, method: String) async -> Bool {
        guard value.context.isCurrent() else { return false }
        let token = value.token.map { String(format: "%02x", $0) }.joined()
        let body = method == "POST" ? ["token": token, "platform": "ios", "locale": value.context.locale, "bundleId": value.context.bundleID] : ["token": token]
        do {
            let (status, response) = try await value.context.request(method, "/api/push/apns-token", body)
            return (200..<300).contains(status) && (try? NativeNotificationPolicy.boolean(response["ok"])) == true
        } catch { return false } // Never expose a transport error which might include credentials or the request body.
    }
}
