import Foundation
import NativeShell

@MainActor private final class RetirementRuntimeFixture {
    let app = NshAppView()
    let store: ConnectionStore
    var runtime: RuntimeBridge!
    var hostPaths = [String]()
    init(_ bytes: Data) throws {
        store = try ConnectionStore(memoryData: bytes)
        runtime = RuntimeBridge(app: app, store: store, hostIO: RuntimeHostIO(json: { [weak self] request, _ in
            guard let self, request.url?.path == "/api/config/settings" else { throw ConnectionEditorFailure.invalid }
            self.hostPaths.append(request.url!.path)
            return (200, ["synthetic": true])
        }))
    }
    func status(_ pending: Int, _ failed: Int) throws {
        let value = runtime.authorizationRetirementStatus
        try RuntimeAuthorizationRetirementChecks.check(value["pending"] as? Int == pending && value["failed"] as? Int == failed, "durable pending/failure status mismatch")
        let snapshot = runtime.snapshot["authorizationCleanup"] as! [String: Any]
        try RuntimeAuthorizationRetirementChecks.check(snapshot["pending"] as? Int == pending && snapshot["failed"] as? Int == failed, "snapshot discarded durable status")
    }
    func call(_ name: String, _ value: [String: Any]) async throws {
        _ = try await app.handlers[name]!(value)
    }
}

@main @MainActor enum RuntimeAuthorizationRetirementChecks {
    static func main() async throws {
        let mode = CommandLine.arguments[1]
        try await run(mode)
        print("PASS \(mode) false")
    }
    static func check(_ value: Bool, _ message: String) throws {
        if !value { throw NSError(domain: "RetirementRuntimeSynthetic", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
    }
    static func row(_ id: String, _ auth: String? = nil) -> SavedConnection {
        SavedConnection(id: id, label: id, url: URL(string: "https://\(id.lowercased()).synthetic.invalid")!, token: "synthetic-\(id)", lastUsedAt: 0, editorVersion: "version-1", authorizationID: auth)
    }
    static func bytes(_ rows: [SavedConnection], selected: String? = "live") throws -> Data {
        try JSONEncoder().encode(ConnectionEditorRecords(connections: rows, selected: selected))
    }
    private static func cold(_ count: Int = 2) throws -> RetirementRuntimeFixture {
        let retired = (0..<count).map { row("old-\($0)", "auth-old-\($0)") }
        let seed = try ConnectionStore(memoryData: bytes(retired + [row("live", "auth-live")]))
        for value in retired { try seed.remove(value.id) }
        return try RetirementRuntimeFixture(seed.memoryPersisted)
    }
    static func pair(_ id: String, _ auth: String) throws -> AuthorizationRetirement {
        try AuthorizationRetirement(connectionID: id, authorizationID: auth)
    }
    static func eventually(_ condition: () -> Bool) async throws {
        for _ in 0..<10000 {
            if condition() { return }
            await Task.yield()
        }
        try check(false, "synthetic continuation did not start")
    }
    static func run(_ mode: String) async throws {
        let f = try cold(mode == "retirement-partial" ? 3 : mode == "retirement-ack-failure" || mode == "retirement-cancel" ? 1 : 2)
        defer { f.runtime.stop() }
        var calls = [AuthorizationRetirement]()
        switch mode {
        case "retirement-cold-no-hook":
            let persisted = f.store.memoryPersisted
            try f.status(2, 2)
            await f.runtime.retryAuthorizationRetirements()
            try f.status(2, 2)
            try check(f.store.memoryWrites == 0 && f.store.memoryPersisted == persisted && f.hostPaths.isEmpty, "missing hook acknowledged or touched Host/store")
        case "retirement-cold-retry":
            let pending = f.store.pendingAuthorizationRetirements
            f.runtime.onAuthorizationRetired = { id, auth in calls.append(try pair(id, auth)) }
            await f.runtime.retryAuthorizationRetirements()
            try f.status(0, 0)
            try check(calls == pending && f.store.memoryWrites == pending.count && f.store.selected?.authorizationID == "auth-live", "cold retry lost exact old pairs or mutated live authorization")
        case "retirement-cleanup-failure", "retirement-partial":
            f.runtime.onAuthorizationRetired = { id, auth in
                calls.append(try pair(id, auth))
                if id == "old-0" { throw ConnectionEditorFailure.storage }
                if mode == "retirement-partial" && id == "old-1" { f.store.failNextWrite = true }
            }
            await f.runtime.retryAuthorizationRetirements()
            let failures = mode == "retirement-partial" ? 2 : 1
            try f.status(failures, failures)
            try check(calls.count == (mode == "retirement-partial" ? 3 : 2) && f.store.memoryWrites == 1, "one failed cleanup/ACK blocked unrelated success")
            let retained = f.store.pendingAuthorizationRetirements
            f.runtime.onAuthorizationRetired = { id, auth in calls.append(try pair(id, auth)) }
            await f.runtime.retryAuthorizationRetirements()
            try f.status(0, 0)
            try check(Array(calls.suffix(failures)) == retained && f.store.selected?.id == "live", "retry replayed mutation or retried acknowledged items")
        case "retirement-ack-failure":
            let persisted = f.store.memoryPersisted
            f.runtime.onAuthorizationRetired = { id, auth in calls.append(try pair(id, auth)) }
            f.store.failNextWrite = true
            await f.runtime.retryAuthorizationRetirements()
            try f.status(1, 1)
            try check(f.store.memoryPersisted == persisted && f.store.memoryWrites == 0 && calls.count == 1, "ACK failure forgot pending or replayed mutation")
            let restart = try RetirementRuntimeFixture(f.store.memoryPersisted)
            restart.runtime.onAuthorizationRetired = { id, auth in calls.append(try pair(id, auth)) }
            await restart.runtime.retryAuthorizationRetirements()
            try restart.status(0, 0)
            try check(calls.count == 2 && calls[0] == calls[1] && restart.store.memoryWrites == 1 && restart.store.selected?.id == "live", "restart failed to retry cleanup plus exact ACK")
            restart.runtime.stop()
        case "retirement-dedup":
            var wait: CheckedContinuation<Void, Never>?
            f.runtime.onAuthorizationRetired = { id, auth in
                calls.append(try pair(id, auth))
                if id == "old-0" { await withCheckedContinuation { wait = $0 } }
            }
            let first = Task { await f.runtime.retryAuthorizationRetirements() }
            try await eventually { wait != nil }
            await f.runtime.retryAuthorizationRetirements()
            try f.status(1, 0)
            try check(calls.count == 2 && calls.filter { $0.connectionID == "old-0" }.count == 1, "overlapping retries duplicated in-flight cleanup")
            wait!.resume(); wait = nil; await first.value
            try f.status(0, 0)
        case "retirement-late-old":
            let seed = try ConnectionStore(memoryData: bytes([row("A", "auth-a1")], selected: "A"))
            let url = seed.selected!.url
            try seed.save(url: url, token: "synthetic-a2", label: "A2")
            let a2 = seed.selected!.authorizationID!
            try seed.save(url: url, token: "synthetic-a3", label: "A3")
            let a3 = seed.selected!.authorizationID!
            let changed = try RetirementRuntimeFixture(seed.memoryPersisted)
            var wait: CheckedContinuation<Void, Never>?
            changed.runtime.onAuthorizationRetired = { id, auth in
                calls.append(try pair(id, auth))
                if auth == "auth-a1" { await withCheckedContinuation { wait = $0 } }
            }
            let old = Task { await changed.runtime.retryAuthorizationRetirements() }
            try await eventually { wait != nil }
            try changed.store.save(url: url, token: "synthetic-a4", label: "A4")
            let a4 = changed.store.selected!.authorizationID!
            await changed.runtime.retryAuthorizationRetirements()
            try changed.status(1, 0)
            wait!.resume(); wait = nil; await old.value
            try changed.status(0, 0)
            try check(calls.map(\.authorizationID) == ["auth-a1", a2, a3] && changed.store.selected?.authorizationID == a4 && changed.hostPaths.isEmpty, "late old cleanup borrowed or acknowledged latest authorization")
            changed.runtime.stop()
        case "retirement-metadata":
            let clean = try RetirementRuntimeFixture(bytes([row("live", "auth-live"), row("B", "auth-b")]))
            clean.runtime.onAuthorizationRetired = { id, auth in calls.append(try pair(id, auth)) }
            clean.runtime.setForeground(true)
            try await clean.call("connection.rename", ["id": "live", "version": "version-1", "label": "Renamed"])
            try await clean.call("connection.select", ["id": "B"])
            try await clean.call("connection.select", ["id": "live"])
            clean.runtime.setForeground(false); clean.runtime.setForeground(true)
            await clean.runtime.retryAuthorizationRetirements()
            try clean.status(0, 0)
            try check(calls.isEmpty && clean.store.selected?.authorizationID == "auth-live", "metadata/background manufactured retirement")
            clean.runtime.stop()
            let legacy = try RetirementRuntimeFixture(bytes([row("live")]))
            legacy.runtime.setForeground(true)
            legacy.runtime.onAuthorizationRetired = { id, auth in calls.append(try pair(id, auth)) }
            try await legacy.call("connection.remove", ["id": "live"])
            try legacy.status(0, 0)
            try check(calls.isEmpty, "legacy nil manufactured authorization cleanup")
            legacy.runtime.stop()
        case "retirement-remove", "retirement-remove-failure", "retirement-connect", "retirement-connect-failure":
            f.runtime.setForeground(true)
            let pending = f.store.pendingAuthorizationRetirements, previous = f.store.selected!, persisted = f.store.memoryPersisted
            f.runtime.onAuthorizationRetired = { id, auth in calls.append(try pair(id, auth)) }
            let failed = mode.hasSuffix("failure"), connecting = mode.hasPrefix("retirement-connect")
            if failed { f.store.failNextWrite = true }
            var mutationFailed = false
            do {
                if connecting {
                    try await f.call("connection.connect", ["id": previous.id, "version": previous.editorVersion!, "url": previous.url.absoluteString, "token": "synthetic-new-authorization", "label": "Reauthorized"])
                } else { try await f.call("connection.remove", ["id": previous.id]) }
            } catch { mutationFailed = true }
            try check(mutationFailed == failed, "mutation did not preserve persistence failure")
            if failed {
                try check(calls.isEmpty && f.store.memoryPersisted == persisted && f.store.pendingAuthorizationRetirements == pending && f.store.selected?.authorizationID == previous.authorizationID, "uncommitted mutation triggered retirement")
            } else {
                try f.status(0, 0)
                try check(calls == pending + [pair(previous.id, previous.authorizationID!)], "successful mutation failed to drain complete durable journal")
                try check(f.store.memoryWrites == 1 + calls.count, "cleanup replayed successful store mutation")
                if connecting { try check(f.store.selected?.authorizationID != previous.authorizationID, "old cleanup reverted replacement") }
                else { try check(f.store.selected == nil, "old cleanup replayed removal") }
            }
            try check(f.hostPaths.count == (connecting ? 1 : 0), "cleanup touched Host or repeated candidate authorization")
        case "retirement-cancel":
            var wait: CheckedContinuation<Void, Never>?
            f.runtime.onAuthorizationRetired = { id, auth in calls.append(try pair(id, auth)); await withCheckedContinuation { wait = $0 } }
            let work = Task { await f.runtime.retryAuthorizationRetirements() }
            try await eventually { wait != nil }
            work.cancel(); wait!.resume(); wait = nil; await work.value
            try f.status(1, 1)
            try check(f.store.memoryWrites == 0 && calls.count == 1, "cancelled retry acknowledged uncertain completion")
            f.runtime.onAuthorizationRetired = { id, auth in calls.append(try pair(id, auth)) }
            await f.runtime.retryAuthorizationRetirements()
            try f.status(0, 0)
        default: throw ConnectionEditorFailure.invalid
        }
        for (name, value) in f.app.events where name == "runtime.authorizationRetirement" {
            try check(Set((value as! [String: Any]).keys) == ["pending", "failed"], "cleanup diagnostics exposed identity or error text")
        }
        try check(f.hostPaths.isEmpty || mode.hasPrefix("retirement-connect"), "retirement unexpectedly used a Host transport")
    }
}
