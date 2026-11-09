import Foundation
import NativeShell

@main @MainActor enum PasskeyRuntimeChecks {
    static func check(_ value: Bool, _ label: String) { precondition(value, label) }
    static func reject(_ action: () async throws -> Void) async { do { try await action(); fatalError("expected rejection") } catch {} }
    static func main() async throws {
        let a = SavedConnection(id: "a", label: "a", url: URL(string: "https://a.example")!, token: "synthetic-paired-a", lastUsedAt: 0, authorizationID: "auth-a")
        let b = SavedConnection(id: "b", label: "b", url: URL(string: "https://b.example")!, token: "synthetic-paired-b", lastUsedAt: 0, authorizationID: "auth-b")
        let c = SavedConnection(id: "c", label: "c", url: URL(string: "http://c.example:80")!, token: "synthetic-paired-c", lastUsedAt: 0, authorizationID: "auth-c")
        let old = SavedConnection(id: "old-other", label: "old", url: URL(string: "https://old.example")!, token: "synthetic-old", lastUsedAt: 0, authorizationID: "auth-old")
        let relay = SavedConnection(id: "relay", label: "relay", url: URL(string: "https://host.invalid")!, token: "synthetic-relay", lastUsedAt: 0, relay: RelayConfiguration(relayUrl: "wss://relay.invalid", serverId: "synthetic", hostEncPubJwk: [:]), authorizationID: "auth-relay")
        let store = try ConnectionStore(memoryData: JSONEncoder().encode(ConnectionEditorRecords(connections: [a, b, c, old, relay], selected: "a")))
        try store.remove("old-other")
        let app = NshAppView(); var calls = 0, resetPosts = 0, cleanupCalls = 0
        let runtime = RuntimeBridge(app: app, store: store, hostIO: RuntimeHostIO(json: { _, _ in fatalError("unexpected generic/network lane") }, managementJSON: { request, connection in
            calls += 1
            check(request.value(forHTTPHeaderField: "Authorization") == nil, "paired bearer never management authority")
            switch request.url!.path {
            case "/auth/session": return (200, ["Set-Cookie": "yuri_ui_session=session-a; Path=/; Secure; HttpOnly"], ["authenticated": true])
            case "/api/passkeys":
                check(request.value(forHTTPHeaderField: "Cookie") == (connection.id == "a" ? "yuri_ui_session=session-a" : nil), "exact Host session isolation")
                return (200, [:], ["passkeys": []])
            case "/api/auth/reset": resetPosts += 1; return (200, [:], ["cleared": true, "signedOutEverywhere": true])
            default: fatalError("unexpected management path")
            }
        }))
        runtime.setForeground(true)
        let scopeA = try RuntimeHostScope(runtime.snapshot["runtimeScope"])
        let identityA: ((URL) -> Bool)? = try runtime.guiPluginPreviewCapture(expectedHost: scopeA).isHostResourceURL
        check(identityA != nil, "GUI captured origin predicate supplied")
        for value in ["https://a.example/api/fs/serve/file", "https://A.EXAMPLE:443/api/fs/serve/file"] { check(identityA!(URL(string: value)!), "same immutable origin and effective HTTPS port") }
        for value in ["https://b.example/api/fs/serve/file", "http://a.example/api/fs/serve/file", "https://a.example:444/api/fs/serve/file", "https://user@a.example/file", "https://:password@a.example/file", "https://a.example.attacker.invalid/file", "/api/fs/serve/file", "file:///api/fs/serve/file"] { check(!identityA!(URL(string: value)!), "GUI arbitrary origin/userinfo rejected") }
        check(calls == 0, "GUI origin identity does not perform I/O or reselect Host")
        let transport = try runtime.passkeyTransport(expectedHost: scopeA)
        await reject { try await transport.reset() }; check(store.selected?.id == "a" && calls == 0, "reset without Host ACK changes nothing")
        _ = try await transport.request("/auth/session", "POST", ["password": "synthetic"])
        let result = try await app.handlers["runtime.request"]!(["path": "/api/passkeys", "expectedHost": scopeA.publicValue]) as! [String: Any]
        check(result["status"] as? Int == 200, "JS management GET uses captured full session")
        _ = try await app.handlers["runtime.request"]!(["path": "/api/auth/reset", "method": "POST", "expectedHost": scopeA.publicValue])
        runtime.onAuthorizationRetired = { id, auth in
            check(id == "a" && auth == "auth-a", "exact retired authorization"); cleanupCalls += 1
            if cleanupCalls == 1 { throw PasskeyFailure.cleanup }
        }
        store.failNextWrite = true
        await reject { try await transport.reset() }; check(store.selected?.id == "a", "failed cleanup persistence retains source")
        await reject { try await transport.reset() }
        check(store.selected == nil && resetPosts == 1 && cleanupCalls == 1, "ACK cleanup retires exact credential and transport once")
        check(!identityA!(URL(string: "https://a.example/file")!), "retired GUI admission no longer proves Host identity")
        try store.select("b"); runtime.stop()
        let scopeB = try RuntimeHostScope(runtime.snapshot["runtimeScope"])
        let transportB = try runtime.passkeyTransport(expectedHost: scopeB)
        let identityB: ((URL) -> Bool)? = try runtime.guiPluginPreviewCapture(expectedHost: scopeB).isHostResourceURL
        check(!identityA!(URL(string: "https://b.example/file")!), "old predicate never adopts selected Host")
        _ = try await transportB.request("/api/passkeys", "GET", nil)
        try await transport.reset()
        check(store.selected?.id == "b" && resetPosts == 1 && cleanupCalls == 2, "retry old cleanup does not touch another Host or POST")
        check(store.pendingAuthorizationRetirements.map(\.connectionID) == ["old-other"], "reset must not process another Host's pending cache/credential cleanup")
        await reject { _ = try runtime.passkeyTransport(expectedHost: scopeA) }
        var retired = false; transportB.onRetire { retired = true }
        runtime.setForeground(false); check(retired, "background retires session/controller owner")
        check(!identityB!(URL(string: "https://b.example/file")!), "background revokes GUI identity")
        let before = calls
        await reject { _ = try await transportB.request("/api/passkeys", "GET", nil) }; check(calls == before, "retired transport cannot dispatch")
        try store.select("relay"); runtime.setForeground(true)
        let relayScope = try RuntimeHostScope(runtime.snapshot["runtimeScope"])
        await reject { _ = try runtime.passkeyTransport(expectedHost: relayScope) }; check(calls == before, "Relay denied before I/O")
        try store.select("c"); runtime.stop()
        let scopeC = try RuntimeHostScope(runtime.snapshot["runtimeScope"])
        let identityC: ((URL) -> Bool)? = try runtime.guiPluginPreviewCapture(expectedHost: scopeC).isHostResourceURL
        check(identityC!(URL(string: "http://c.example/file")!) && identityC!(URL(string: "http://c.example:80/file")!), "HTTP implicit/explicit port equivalence")
        check(!identityC!(URL(string: "http://c.example:81/file")!) && !identityC!(URL(string: "https://c.example/file")!), "HTTP port and scheme isolation")
        runtime.stop()
        print("PASS: production RuntimeBridge management/reset and GUI immutable origin/effective-port/userinfo/lifecycle memory tests")
    }
}
