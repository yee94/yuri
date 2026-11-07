import Foundation
import NativeShell

@main struct TerminalAuthorizationHarness {
    @MainActor static func main() async throws {
        let scenario = CommandLine.arguments[1], app = NshAppView()
        let store: ConnectionStore
        if scenario == "legacy" {
            let bytes = try JSONSerialization.data(withJSONObject: ["connections": [["id": "legacy", "label": "Legacy", "url": "http://127.0.0.1:1", "token": "synthetic", "lastUsedAt": 0]], "selected": "legacy"])
            store = try ConnectionStore(memoryData: bytes)
        } else {
            store = try ConnectionStore(); try store.save(url: URL(string: "http://127.0.0.1:1")!, token: "synthetic", label: "A")
        }
        let original = store.selected!, originalAuthorization = original.authorizationID
        let runtime = RuntimeBridge(app: app, store: store, hostIO: RuntimeHostIO(json: { _, _ in (200, ["authorized": true]) }))
        runtime.setForeground(true)
        var callbacks = 0
        runtime.onAuthorizationRetired = { id, authorization in
            callbacks += 1
            precondition(id == original.id && authorization == originalAuthorization)
            precondition(store.selected?.authorizationID != originalAuthorization)
            if scenario == "callback-failure" { throw NativeFailure.message("synthetic cleanup failure") }
        }
        func call(_ name: String, _ body: [String: Any]) async throws -> Any? { try await app.handlers[name]!(body) }
        switch scenario {
        case "non-revocations":
            _ = try await call("connection.rename", ["id": original.id, "version": original.editorVersion!, "label": "Renamed"])
            _ = try await call("connection.select", ["id": original.id]); runtime.stop(); runtime.setForeground(false); runtime.setForeground(true)
            precondition(callbacks == 0 && store.selected!.authorizationID == originalAuthorization)
        case "failed-remove":
            store.failNextWrite = true
            do { _ = try await call("connection.remove", ["id": original.id]); preconditionFailure() } catch {}
            precondition(callbacks == 0 && store.selected!.authorizationID == originalAuthorization)
        case "reauthorize", "failed-reauthorize":
            if scenario == "failed-reauthorize" { store.failNextWrite = true }
            let args: [String: Any] = ["id": original.id, "version": original.editorVersion!, "url": "http://127.0.0.1:2", "token": "synthetic-new", "label": "A"]
            if scenario == "failed-reauthorize" {
                do { _ = try await call("connection.connect", args); preconditionFailure() } catch {}
                precondition(callbacks == 0 && store.selected!.authorizationID == originalAuthorization)
            } else { _ = try await call("connection.connect", args); precondition(callbacks == 1 && store.selected!.authorizationID != originalAuthorization) }
        case "remove", "callback-failure", "legacy":
            _ = try await call("connection.remove", ["id": original.id])
            precondition(store.selected == nil)
            if scenario == "legacy" { precondition(callbacks == 0) }
            else if scenario == "callback-failure" {
                precondition(callbacks == 1 && runtime.authorizationRetirementStatus["pending"] as? Int == 1 && runtime.authorizationRetirementStatus["failed"] as? Int == 1)
                runtime.onAuthorizationRetired = { id, authorization in callbacks += 1; precondition(id == original.id && authorization == originalAuthorization && store.selected == nil) }
                await runtime.retryAuthorizationRetirements()
                precondition(callbacks == 2 && runtime.authorizationRetirementStatus["pending"] as? Int == 0)
            } else { precondition(callbacks == 1) }
        default: throw TerminalFailure.invalid
        }
        precondition((runtime.snapshot["authorizationCleanup"] as? [String: Any])?["pending"] as? Int == 0)
        runtime.stop(); print("PASS \(scenario)")
    }
}
