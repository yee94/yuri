import Foundation

/// Only the JS history owner completion. The caller still combines every other
/// cleanup owner before acknowledging ConnectionStore's durable receipt.
@MainActor final class AuthorizationCacheCleanup {
    struct Identity: Hashable {
        let connectionID: String
        let authorizationID: String
    }
    enum Failure: Error { case staleOwner, invalidTicket, cleanupPending }
    private let pending: () -> Set<Identity>
    private var owner: String?
    private var tickets: [String: Identity] = [:]
    private var claimed = Set<String>()
    private var completed = Set<Identity>()

    init(pending: @escaping () -> Set<Identity>) { self.pending = pending }

    func ready() -> [String: Any] {
        owner = UUID().uuidString
        tickets.removeAll(); claimed.removeAll(); completed.removeAll()
        return ["owner": owner!, "tickets": refreshTickets()]
    }

    func list(owner: String) throws -> [String] {
        try validate(owner)
        return refreshTickets()
    }

    func claim(owner: String, ticket: String) throws -> [String: String] {
        try validate(owner)
        guard let identity = tickets[ticket], pending().contains(identity), !completed.contains(identity) else { throw Failure.invalidTicket }
        claimed.insert(ticket)
        return ["connectionID": identity.connectionID, "authorizationID": identity.authorizationID]
    }

    func ack(owner: String, ticket: String) throws {
        try validate(owner)
        guard let identity = tickets[ticket], pending().contains(identity), claimed.contains(ticket) else { throw Failure.invalidTicket }
        completed.insert(identity)
    }

    /// Called only with RuntimeBridge's native retirement callback arguments.
    /// Never accepts a JS-supplied identity as proof of completion.
    func requireCompletion(connectionID: String, authorizationID: String) throws {
        let identity = Identity(connectionID: connectionID, authorizationID: authorizationID)
        guard pending().contains(identity), completed.contains(identity) else { throw Failure.cleanupPending }
    }

    private func validate(_ value: String) throws {
        guard owner == value else { throw Failure.staleOwner }
    }

    private func refreshTickets() -> [String] {
        let current = pending()
        tickets = tickets.filter { current.contains($0.value) }
        claimed.formIntersection(Set(tickets.keys))
        completed.formIntersection(current)
        for identity in current where !completed.contains(identity) && !tickets.values.contains(identity) {
            tickets[UUID().uuidString] = identity
        }
        return tickets.filter { !completed.contains($0.value) }.map(\.key).sorted()
    }
}
