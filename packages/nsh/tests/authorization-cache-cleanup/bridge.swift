import Foundation
import NativeShell

@main struct BridgeTests {
    @MainActor static func main() async throws {
        typealias Identity = AuthorizationCacheCleanup.Identity
        var pending: Set<Identity> = [Identity(connectionID: "host", authorizationID: "old")]
        let app = NshAppView()
        var retries = 0
        var failRetry = false
        let bridge = AuthorizationCacheCleanupBridge(app: app, pending: { pending }, afterSweep: {
            retries += 1
            if failRetry { throw CancellationError() }
        })
        func call(_ name: String, _ value: Any? = [String: Any]()) async throws -> Any? {
            try await app.handlers["authorization.cache.\(name)"]!(value)
        }
        func rejects(_ name: String, _ value: Any?) async {
            do { _ = try await call(name, value); fatalError("unexpected handler success") } catch {}
        }
        precondition(app.handlers.count == 5)
        for name in ["ready", "retry"] {
            await rejects(name, nil)
            await rejects(name, ["extra": true])
            await rejects(name, [])
        }
        let ready = try await call("ready") as! [String: Any]
        let owner = ready["owner"] as! String, ticket = (ready["tickets"] as! [String])[0]
        for value: Any in ["", String(repeating: "x", count: 129), 123, true, NSNull(), "bad/owner", "é"] {
            await rejects("list", ["owner": value])
            await rejects("claim", ["owner": owner, "ticket": value])
        }
        await rejects("claim", ["owner": owner, "ticket": ticket, "authorizationID": "new"])
        await rejects("ack", ["owner": owner, "ticket": ticket])
        let claimed = try await call("claim", ["owner": owner, "ticket": ticket]) as! [String: String]
        precondition(claimed == ["connectionID": "host", "authorizationID": "old"])
        _ = try await call("ack", ["owner": owner, "ticket": ticket])
        try bridge.requireCompletion(connectionID: "host", authorizationID: "old")
        _ = try await call("retry")
        precondition(retries == 1 && pending.count == 1)
        failRetry = true
        await rejects("retry", [String: Any]())
        precondition(retries == 2)
        bridge.requestSweep()
        precondition(app.events == ["authorization.cache.pending"])
        _ = try await call("ready")
        await rejects("ack", ["owner": owner, "ticket": ticket])
        pending = []
        do { try bridge.requireCompletion(connectionID: "host", authorizationID: "old"); fatalError("stale completion") } catch {}
        print("authorization cache bridge memory contracts passed")
    }
}
