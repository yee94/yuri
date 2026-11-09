import Foundation

@main struct CleanupTests {
    @MainActor static func main() throws {
        typealias Identity = AuthorizationCacheCleanup.Identity
        let old = Identity(connectionID: "host", authorizationID: "old")
        let fresh = Identity(connectionID: "host", authorizationID: "new")
        var pending: Set<Identity> = [old]
        let cleanup = AuthorizationCacheCleanup(pending: { pending })
        func rejects(_ action: () throws -> Void) { do { try action(); fatalError("unexpected success") } catch {} }
        let ready = cleanup.ready(), owner = ready["owner"] as! String
        let ticket = (ready["tickets"] as! [String])[0]
        rejects { try cleanup.ack(owner: owner, ticket: ticket) }
        rejects { try cleanup.requireCompletion(connectionID: "host", authorizationID: "old") }
        rejects { _ = try cleanup.claim(owner: owner, ticket: "forged") }
        let identity = try cleanup.claim(owner: owner, ticket: ticket)
        precondition(identity == ["connectionID": "host", "authorizationID": "old"])
        try cleanup.ack(owner: owner, ticket: ticket)
        try cleanup.requireCompletion(connectionID: "host", authorizationID: "old")
        rejects { try cleanup.requireCompletion(connectionID: "host", authorizationID: "new") }
        let remaining = try cleanup.list(owner: owner)
        precondition(remaining.isEmpty)
        let replacement = cleanup.ready(), nextOwner = replacement["owner"] as! String
        rejects { try cleanup.ack(owner: owner, ticket: ticket) }
        rejects { try cleanup.requireCompletion(connectionID: "host", authorizationID: "old") }
        let nextTicket = (replacement["tickets"] as! [String])[0]
        _ = try cleanup.claim(owner: nextOwner, ticket: nextTicket)
        pending = [fresh]
        rejects { try cleanup.ack(owner: nextOwner, ticket: nextTicket) }
        let newTickets = try cleanup.list(owner: nextOwner)
        precondition(newTickets.count == 1)
        let freshClaim = try cleanup.claim(owner: nextOwner, ticket: newTickets[0])
        precondition(freshClaim["authorizationID"] == "new")
        let restarted = AuthorizationCacheCleanup(pending: { pending })
        rejects { try restarted.requireCompletion(connectionID: "host", authorizationID: "new") }
        print("authorization cache cleanup Foundation contracts passed")
    }
}
