import Foundation
import NativeShell

@MainActor private final class MemorySocket {
    var closed = false, sends = [String]()
    var reader: CheckedContinuation<VoiceRecognitionMessage, Error>?
    var writer: CheckedContinuation<Void, Error>?
    var delaySend = false, next: VoiceRecognitionMessage?
    var closes = 0
    func socket() -> VoiceRecognitionSocket {
        VoiceRecognitionSocket(receive: {
            if self.closed { throw CancellationError() }
            if let next = self.next { self.next = nil; return next }
            return try await withCheckedThrowingContinuation { self.reader = $0 }
        }, send: { text in
            if self.closed { throw CancellationError() }; self.sends.append(text)
            if self.delaySend { try await withCheckedThrowingContinuation { self.writer = $0 } }
        }, close: {
            guard !self.closed else { return }; self.closed = true; self.closes += 1
            self.reader?.resume(throwing: CancellationError()); self.reader = nil
            self.writer?.resume(throwing: CancellationError()); self.writer = nil
        })
    }
}

@MainActor private final class MemoryIO {
    struct HTTP { let request: URLRequest; let relay: RelayConfiguration?; let limit: Int }
    struct Upgrade { let request: URLRequest; let relay: RelayConfiguration?; let token: String? }
    var http = [HTTP](), upgrades = [Upgrade](), sockets = [MemorySocket]()
    var badMint: String?, badResponse: String?
    var settingsProvider = "volcengine"
    var hostRequests = [URLRequest](), hostStatus = 200, delayHost = false, hostCancelled = false
    var hostWait: CheckedContinuation<(Int, Any), Error>?
    var speechGET: (() -> Void)?
    var delayHTTP = false, delayOpen = false, httpCancelled = false, openCancelled = false
    var httpWait: CheckedContinuation<VoiceRecognitionResponse, Error>?
    var openWait: CheckedContinuation<VoiceRecognitionSocket, Error>?
    func json(_ object: [String: Any], status: Int = 200) throws -> VoiceRecognitionResponse {
        VoiceRecognitionResponse(status: status, mime: "application/json; charset=utf-8", data: try JSONSerialization.data(withJSONObject: object))
    }
    func response(_ path: String) throws -> VoiceRecognitionResponse {
        if path == "/auth/url-token" {
            switch badMint {
            case "denied": return try json(["error": "synthetic"], status: 401)
            case "redirect": return try json([:], status: 302)
            case "html": return VoiceRecognitionResponse(status: 200, mime: "text/html", data: Data("not a token".utf8))
            case "oversize": return VoiceRecognitionResponse(status: 200, mime: "application/json", data: Data(repeating: 0, count: 65537))
            default: break
            }
            var token = "fixture-url-grant"
            if badMint == "bearer" { token = "fixture-client" }
            if badMint == "empty" { token = "" }
            if badMint == "whitespace" { token = "invalid grant" }
            if badMint == "newline" { token = "invalid\r\ngrant" }
            if badMint == "long" { token = String(repeating: "x", count: 8193) }
            var expiry: Any = Date().timeIntervalSince1970 * 1000 + 60000
            if badMint == "expired" { expiry = 1 }
            if badMint == "bool" { expiry = true }
            return try json(["token": token, "expiresAt": expiry])
        }
        if let badResponse {
            if badResponse == "oversize" { return VoiceRecognitionResponse(status: 200, mime: "application/json", data: Data(repeating: 0, count: path == "/api/voice/settings" ? 65537 : 131073)) }
            if badResponse == "html" { return VoiceRecognitionResponse(status: 200, mime: "text/html", data: Data("SPA".utf8)) }
            if badResponse == "unauthorized" { return try json(["error": "synthetic private endpoint must not escape"], status: 401) }
            if badResponse == "redirect" { return try json([:], status: 302) }
            throw NSError(domain: "synthetic-sensitive-origin.invalid", code: 1)
        }
        return try json(path == "/api/voice/settings" ? ["sttProvider": settingsProvider, "configured": true, "sttServerUrl": "https://stt-fixture.invalid/v1"] : ["transcript": "recognized"])
    }
    var hostIO: RuntimeHostIO {
        RuntimeHostIO(json: { request, _ in
            self.hostRequests.append(request)
            if self.delayHost {
                return try await withTaskCancellationHandler(operation: {
                    try await withCheckedThrowingContinuation { self.hostWait = $0 }
                }, onCancel: { Task { @MainActor in
                    self.hostCancelled = true; self.hostWait?.resume(throwing: CancellationError()); self.hostWait = nil
                } })
            }
            if request.url?.path == "/auth/session" { return (self.hostStatus, ["clientToken": "fixture-reauthorized"]) }
            return (self.hostStatus, ["ok": true])
        })
    }
    var io: VoiceRecognitionRuntimeIO {
        VoiceRecognitionRuntimeIO(http: { request, relay, limit in
            self.http.append(HTTP(request: request, relay: relay, limit: limit))
            if request.url?.path == "/api/voice/settings" { self.speechGET?() }
            if self.delayHTTP {
                return try await withTaskCancellationHandler(operation: {
                    try await withCheckedThrowingContinuation { self.httpWait = $0 }
                }, onCancel: { Task { @MainActor in self.httpCancelled = true } })
            }
            return try self.response(request.url!.path)
        }, socket: { request, relay, token in
            self.upgrades.append(Upgrade(request: request, relay: relay, token: token))
            if self.delayOpen {
                return try await withTaskCancellationHandler(operation: {
                    try await withCheckedThrowingContinuation { self.openWait = $0 }
                }, onCancel: { Task { @MainActor in self.openCancelled = true } })
            }
            let socket = MemorySocket(); self.sockets.append(socket); return socket.socket()
        })
    }
}

@MainActor private final class AdmissionAudio: VoiceRecognitionAudio {
    var permissions = 0, starts = 0, cancels = 0
    var step: ((String) -> Void)?
    func permission() async -> Bool { permissions += 1; step?("permission"); return true }
    func start() throws { starts += 1; step?("record") }
    func readPCM() async throws -> Data { Data() }
    func stop() throws {}
    func cancel() throws { cancels += 1 }
}

@main struct RecognitionTransportCheck {
    static func check(_ condition: Bool, _ message: String) throws {
        if !condition { throw NSError(domain: "RecognitionTransportFixture", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
    }
    @MainActor static func eventually(_ condition: () -> Bool) async throws {
        let deadline = ProcessInfo.processInfo.systemUptime + 1
        while !condition() { try check(ProcessInfo.processInfo.systemUptime < deadline, "synthetic operation did not settle"); try await Task.sleep(nanoseconds: 1_000_000) }
    }
    @MainActor static func main() async throws {
        let scenario = CommandLine.arguments[1], relayMode = CommandLine.arguments[2] == "relay"
        let io = MemoryIO(), app = NshAppView(), store = try ConnectionStore(memoryData: nil)
        let relay = relayMode ? RelayConfiguration(relayUrl: "wss://relay-fixture.invalid", serverId: "fixture-host", hostEncPubJwk: ["fixture": "never-dialed"]) : nil
        let origin = URL(string: relayMode ? "https://relay.invalid" : "https://native-fixture.invalid")!
        let credential = scenario == "unpaired" ? "" : scenario == "bad-credential" ? "invalid\ncredential" : "fixture-client"
        try store.save(url: origin, token: credential, label: "synthetic", relay: relay)
        let runtime = RuntimeBridge(app: app, store: store, voiceRecognitionIO: io.io, hostIO: io.hostIO)
        runtime.setForeground(true)
        let expectedHost = try RuntimeHostScope(runtime.snapshot["runtimeScope"])
        defer { runtime.stop() }
        if scenario == "unpaired" {
            do { _ = try runtime.voiceRecognitionTransport(expectedHost: expectedHost); try check(false, "unpaired Relay admitted") } catch VoiceRecognitionFailure.unavailable {}
            try check(io.http.isEmpty && io.upgrades.isEmpty, "unpaired traffic escaped"); print("PASS \(scenario) \(relayMode)"); return
        }
        let transport = try runtime.voiceRecognitionTransport(expectedHost: expectedHost)
        func call(_ name: String, _ value: [String: Any] = [:]) async throws -> Any? { try await app.handlers[name]!(value) }
        func liveScope() throws -> RuntimeHostScope { try RuntimeHostScope(runtime.snapshot["runtimeScope"]) }
        func request(_ method: String, expected: Any? = nil) async throws {
            var value: [String: Any] = ["path": "/api/config/settings", "method": method]
            if let expected { value["expectedHost"] = expected }
            _ = try await call("runtime.request", value)
        }
        func rejects(_ code: RuntimeHostScopeFailure, _ operation: () async throws -> Void) async throws {
            do { try await operation() }
            catch let failure as RuntimeHostScopeFailure { try check(failure == code, "unexpected admission failure"); return }
            try check(false, "admission unexpectedly accepted")
        }
        switch scenario {
        case let value where value.hasPrefix("resource-start-"):
            var payload: [String: Any] = ["path": "/fixture/private.txt", "requestId": "resource-old-owner", "expectedHost": expectedHost.publicValue]
            if value == "resource-start-a-b-a" {
                let a = store.selected!
                try store.save(url: URL(string: "https://second-fixture.invalid")!, token: "fixture-second", label: "second")
                _ = try await call("connection.select", ["id": store.selected!.id])
                _ = try await call("connection.select", ["id": a.id])
            }
            if value == "resource-start-background" { runtime.setForeground(false) }
            if value == "resource-start-missing" { payload.removeValue(forKey: "expectedHost") }
            if value == "resource-start-invalid" { payload["expectedHost"] = ["hostID": expectedHost.hostID, "lease": "invalid"] }
            if value == "resource-start-extra-scope" { var mixed = expectedHost.publicValue; mixed["authorizationID"] = store.selected!.authorizationID!; payload["expectedHost"] = mixed }
            var captured = 0, stat = 0, read = 0, files = 0, failed = false
            do {
                // Exact production ResourceBridge startRead parser/admission. Only
                // UIKit/materialization is replaced by counters, never the gate.
                let admitted = try ResourceReadRequest.admit(payload, capture: { expected in
                    let result = try runtime.resourceTransport(expectedHost: expected); captured += 1; return result
                })
                try check(admitted.request.path == "/fixture/private.txt" && admitted.request.requestID == "resource-old-owner" && admitted.transport.isCurrent(), "positive resource capture lost request identity")
                // Synthetic downstream effects; no file, stat or Host is accessed.
                stat += 1; read += 1; files += 1
            } catch { failed = true }
            if value == "resource-start-current" { try check(!failed && captured == 1 && stat == 1 && read == 1 && files == 1, "current resource scope rejected") }
            else { try check(failed && captured == 0 && stat == 0 && read == 0 && files == 0, "rejected queued read touched capture/stat/read/files") }
            try check(io.http.isEmpty && io.hostRequests.isEmpty && io.upgrades.isEmpty, "resource admission fixture contacted a Host")
        case "resource-admission":
            let scoped = try runtime.resourceTransport(expectedHost: expectedHost)
            let preview = try runtime.resourceWebPreviewTransport(expectedHost: expectedHost)
            runtime.setForeground(false); runtime.setForeground(true)
            try check(!scoped.isCurrent() && !preview.isCurrent(), "resource capture survived foreground lease change")
            do { _ = try runtime.resourceTransport(expectedHost: expectedHost); try check(false, "stale resource capture admitted") } catch RuntimeHostScopeFailure.stale {}
            do { _ = try runtime.resourceWebPreviewTransport(expectedHost: expectedHost); try check(false, "stale preview capture admitted") } catch RuntimeHostScopeFailure.stale {}
            do { _ = try await scoped.read("/api/fs/stat?path=%2Ffixture", 65536); try check(false, "retired resource GET escaped") } catch is CancellationError {}
            do { _ = try await scoped.speech!("/api/tts/speak", "synthetic"); try check(false, "retired speech POST escaped") } catch is CancellationError {}
            do { _ = try await preview.prepareLoopback!("http://localhost:3000"); try check(false, "retired preview mutation escaped") } catch ResourceWebPreviewFailure.stale {}
            runtime.setForeground(false)
            do { _ = try runtime.resourceTransport(); try check(false, "background legacy capture admitted") } catch RuntimeHostScopeFailure.background {}
            try check(io.http.isEmpty && io.upgrades.isEmpty && io.hostRequests.isEmpty, "denied resource operation contacted Host")
        case "resource-authorization-change":
            let scoped = try runtime.resourceTransport(expectedHost: expectedHost)
            let previous = store.selected!
            try store.replace(id: previous.id, version: previous.editorVersion!, url: previous.url, token: previous.token, label: previous.label, relay: previous.relay)
            try check(store.selected!.authorizationID != previous.authorizationID && !scoped.isCurrent(), "same-token reauthorization retained resource lease")
            do { _ = try await scoped.read("/api/fs/stat?path=%2Ffixture", 65536); try check(false, "revoked resource lease read") } catch is CancellationError {}
        case "resource-queued-retire":
            let scoped = try runtime.resourceTransport(expectedHost: expectedHost)
            let queued = Task { try await scoped.read("/api/fs/stat?path=%2Ffixture", 65536) }
            runtime.setForeground(false); runtime.setForeground(true)
            do { _ = try await queued.value; try check(false, "queued read borrowed new scope") } catch is CancellationError {}
            try check(io.http.isEmpty && io.hostRequests.isEmpty && io.upgrades.isEmpty, "queued retired read touched I/O")
        case "host-snapshot":
            let value = try await call("connection.list") as! [String: Any]
            try check(try RuntimeHostScope(value["runtimeScope"]) == expectedHost, "list did not use Runtime wrapper")
            try check(store.snapshot["runtimeScope"] == nil, "scope contaminated persisted store metadata")
            let rows = value["connections"] as! [[String: Any]]
            try check(rows[0]["authorizationID"] as? String == store.selected!.authorizationID, "public durable authorization missing")
            let second = RuntimeBridge(app: NshAppView(), store: store, voiceRecognitionIO: io.io, hostIO: io.hostIO)
            try check(second.snapshot["runtimeScope"] is NSNull, "native admission defaulted open")
            second.setForeground(true)
            let nextProcess = try RuntimeHostScope(second.snapshot["runtimeScope"])
            try check(nextProcess.hostID == expectedHost.hostID && nextProcess.lease != expectedHost.lease, "ephemeral receipt crossed Runtime process owner")
            second.stop()
            let persisted = try JSONSerialization.jsonObject(with: store.memoryPersisted) as! [String: Any]
            try check(persisted["runtimeScope"] == nil && persisted["lease"] == nil, "runtime authority was persisted")
        case "host-startup-deny":
            let isolatedApp = NshAppView()
            let isolated = RuntimeBridge(app: isolatedApp, store: store, voiceRecognitionIO: io.io, hostIO: io.hostIO)
            do { _ = try await isolatedApp.handlers["runtime.request"]!(["path": "/api/config/settings", "method": "GET"]); try check(false, "read admitted before native foreground") } catch RuntimeHostScopeFailure.background {}
            do { _ = try await isolatedApp.handlers["runtime.request"]!(["path": "/api/config/settings", "method": "POST", "expectedHost": expectedHost.publicValue]); try check(false, "write admitted before native foreground") } catch RuntimeHostScopeFailure.background {}
            try check(io.hostRequests.isEmpty && io.http.isEmpty && isolated.snapshot["runtimeScope"] is NSNull, "startup denial performed I/O or fabricated scope")
            isolated.stop()
        case "host-required":
            for method in ["POST", "PUT", "PATCH", "DELETE"] { try await rejects(.required) { try await request(method) } }
            for method in ["GET", "POST"] {
                try await rejects(.invalid) { try await request(method, expected: NSNull()) }
                try await rejects(.invalid) { try await request(method, expected: ["hostID": expectedHost.hostID, "lease": "not-a-uuid"]) }
                try await rejects(.stale) { try await request(method, expected: RuntimeHostScope(hostID: "other", lease: expectedHost.lease).publicValue) }
                try await rejects(.stale) { try await request(method, expected: RuntimeHostScope(hostID: expectedHost.hostID, lease: UUID()).publicValue) }
                var mixed = expectedHost.publicValue; mixed["authorizationID"] = store.selected!.authorizationID!
                try await rejects(.invalid) { try await request(method, expected: mixed) }
                for persistent in [store.selected!.editorVersion!, store.selected!.authorizationID!] {
                    try await rejects(.stale) { try await request(method, expected: RuntimeHostScope(hostID: expectedHost.hostID, lease: UUID(uuidString: persistent)!).publicValue) }
                }
            }
            try check(io.hostRequests.isEmpty && io.http.isEmpty && io.upgrades.isEmpty, "rejected admission performed preflight I/O")
            try await request("GET", expected: expectedHost.publicValue)
            try await request("POST", expected: expectedHost.publicValue)
            try check(io.hostRequests.count == 2 && io.hostRequests[1].httpMethod == "POST" && io.hostRequests[1].value(forHTTPHeaderField: "Authorization") == "Bearer fixture-client", "admitted request was redirected/reinterpreted")
            try check(io.hostRequests.allSatisfy { $0.url?.host == origin.host && $0.url?.query == nil && $0.value(forHTTPHeaderField: "expectedHost") == nil }, "process receipt escaped to Host")
        case "host-legacy-get":
            try await request("GET")
            try check(io.hostRequests.count == 1, "legacy read compatibility lost")
            runtime.setForeground(false)
            try await rejects(.background) { try await request("GET") }
            try await rejects(.background) { try await request("POST", expected: expectedHost.publicValue) }
            runtime.stop(); try check(runtime.snapshot["runtimeScope"] is NSNull, "JS stop reopened background admission")
            runtime.setForeground(true)
            try await rejects(.stale) { try await request("GET", expected: expectedHost.publicValue) }
            try await rejects(.required) { try await request("POST") }
            try check(io.hostRequests.count == 1, "legacy writes/background reads were admitted")
        case "host-a-b-a":
            let a = store.selected!
            try store.save(url: URL(string: "https://second-fixture.invalid")!, token: "fixture-second", label: "second")
            let b = store.selected!
            _ = try await call("connection.select", ["id": a.id]); let firstA = try liveScope()
            _ = try await call("connection.select", ["id": b.id]); let scopeB = try liveScope()
            _ = try await call("connection.select", ["id": a.id]); let nextA = try liveScope()
            try check(firstA.hostID == nextA.hostID && firstA.lease != nextA.lease && scopeB != nextA && scopeB != firstA, "A-B-A restored an old lease")
            for old in [expectedHost, firstA, scopeB] { try await rejects(.stale) { try await request("POST", expected: old.publicValue) } }
            try check(io.hostRequests.isEmpty, "stale owner performed I/O on returned Host")
            try await request("POST", expected: nextA.publicValue)
            try check(io.hostRequests.count == 1 && io.hostRequests[0].value(forHTTPHeaderField: "Authorization") == "Bearer fixture-client", "new A capture lost its credential")
        case "host-select-failure", "host-remove-failure":
            let selected = store.selected!, persisted = store.memoryPersisted
            let socket = try await transport.open()
            var invalidations = 0; runtime.onInvalidate = { invalidations += 1 }
            store.failNextWrite = true
            var failed = false
            do { _ = try await call(scenario == "host-select-failure" ? "connection.select" : "connection.remove", ["id": selected.id]) } catch { failed = true }
            try check(failed && (try liveScope()) == expectedHost && transport.isCurrent() && invalidations == 0 && !io.sockets[0].closed, "failed persistence retired valid scope/resources")
            try check(store.memoryPersisted == persisted && store.selected!.authorizationID == selected.authorizationID, "failed persistence changed authorization")
            try await socket.send("still-live"); socket.close()
            if scenario == "host-remove-failure" {
                _ = try await call("connection.remove", ["id": selected.id])
                try check(store.selected == nil && runtime.snapshot["runtimeScope"] is NSNull && !transport.isCurrent() && invalidations == 1, "successful current remove did not revoke scope")
            } else {
                var missingFailed = false
                do { _ = try await call("connection.select", ["id": "missing"]) } catch { missingFailed = true }
                try check(missingFailed && (try liveScope()) == expectedHost && invalidations == 0, "missing selection stopped current Host")
            }
        case "host-reauth-failure", "host-reauth-storage-failure", "host-reauth-success":
            let selected = store.selected!, oldAuth = selected.authorizationID
            var invalidations = 0; runtime.onInvalidate = { invalidations += 1 }
            if scenario == "host-reauth-failure" { io.hostStatus = 401 }
            if scenario == "host-reauth-storage-failure" { store.failNextWrite = true }
            var failed = false
            do { _ = try await call("connection.connect", ["id": selected.id, "version": selected.editorVersion!, "url": selected.url.absoluteString, "token": "fixture-replaced"]) } catch { failed = true }
            if scenario == "host-reauth-success" {
                try check(!failed && (try liveScope()) != expectedHost && store.selected!.authorizationID != oldAuth && invalidations == 1 && !transport.isCurrent(), "confirmed reauthorization retained old scope/proof")
                try await rejects(.stale) { try await request("POST", expected: expectedHost.publicValue) }
            } else {
                try check(failed && (try liveScope()) == expectedHost && store.selected!.authorizationID == oldAuth && invalidations == 0 && transport.isCurrent(), "failed reauthorization retired current authority")
            }
        case "host-reauth-noncurrent":
            let a = store.selected!
            try store.save(url: URL(string: "https://second-fixture.invalid")!, token: "fixture-second", label: "second")
            let b = store.selected!
            _ = try await call("connection.select", ["id": a.id]); let current = try liveScope()
            var invalidations = 0; runtime.onInvalidate = { invalidations += 1 }
            _ = try await call("connection.connect", ["id": b.id, "version": b.editorVersion!, "url": b.url.absoluteString, "token": "fixture-second-replaced"])
            let changed = (store.snapshot["connections"] as! [[String: Any]]).first { $0["id"] as? String == b.id }!
            try check((try liveScope()) == current && invalidations == 0 && store.selected!.authorizationID == a.authorizationID && changed["authorizationID"] as? String != b.authorizationID, "noncurrent reauthorization changed current scope or retained old durable grant")
        case "host-reauth-background":
            let previous = store.selected!, persisted = store.memoryPersisted
            io.delayHost = true
            let authorizing = Task { try await call("connection.connect", ["id": previous.id, "version": previous.editorVersion!, "url": previous.url.absoluteString, "token": "fixture-replaced"]) }
            try await eventually { io.hostWait != nil }
            runtime.setForeground(false)
            do { _ = try await authorizing.value; try check(false, "background reauthorization committed") } catch is CancellationError {}
            try check(store.memoryPersisted == persisted && store.selected!.authorizationID == previous.authorizationID && runtime.snapshot["runtimeScope"] is NSNull, "cancelled candidate replaced durable credentials/proof")
        case "host-background":
            let socket = try await transport.open(), raw = io.sockets[0]
            let reading = Task { try await socket.receive() }
            io.delayHost = true
            let pulling = Task { try await request("GET", expected: expectedHost.publicValue) }
            try await eventually { raw.reader != nil && io.hostWait != nil }
            runtime.setForeground(false)
            try check(runtime.snapshot["runtimeScope"] is NSNull && raw.closed && !transport.isCurrent(), "background gate/retirement was asynchronous")
            do { _ = try await reading.value; try check(false, "background receive survived") } catch is CancellationError {}
            do { try await pulling.value; try check(false, "background HTTP survived") } catch is CancellationError {}
            try await eventually { io.hostCancelled }
            let count = io.hostRequests.count
            try await rejects(.background) { try await request("POST", expected: expectedHost.publicValue) }
            runtime.setForeground(true); let resumed = try liveScope()
            runtime.setForeground(true)
            try check(resumed != expectedHost && (try liveScope()) == resumed, "foreground reused lease or duplicate lifecycle rotated it")
            try await rejects(.stale) { try await request("POST", expected: expectedHost.publicValue) }
            try check(io.hostRequests.count == count, "queued old write escaped during resume")
        case "host-queued-resume":
            let queued = Task { try await request("POST", expected: expectedHost.publicValue) }
            runtime.setForeground(false); runtime.setForeground(true)
            do { try await queued.value; try check(false, "queued old owner borrowed new admission") } catch RuntimeHostScopeFailure.stale {}
            try check(io.hostRequests.isEmpty && io.http.isEmpty && io.upgrades.isEmpty, "queued rejected write performed I/O")
        case "authorization-legacy":
            let legacy = SavedConnection(id: "legacy", label: "legacy", url: URL(string: "https://legacy-fixture.invalid")!, token: "fixture-legacy", lastUsedAt: 0)
            try check(legacy.authorizationID == nil, "old initializer fabricated durable proof")
            let bytes = try JSONEncoder().encode(ConnectionEditorRecords(connections: [legacy], selected: legacy.id))
            let memory = try ConnectionStore(memoryData: bytes)
            let isolated = RuntimeBridge(app: NshAppView(), store: memory, voiceRecognitionIO: io.io, hostIO: io.hostIO)
            isolated.setForeground(true)
            try check(memory.selected!.authorizationID == nil && memory.memoryWrites == 0 && memory.snapshot["runtimeScope"] == nil, "cold legacy decode silently migrated Keychain")
            let row = (isolated.snapshot["connections"] as! [[String: Any]])[0]
            try check(row["authorizationID"] == nil && isolated.snapshot["runtimeScope"] != nil, "ephemeral foreground lease was mistaken for durable proof")
            try memory.edit(ConnectionEditorInput(["id": legacy.id, "version": "legacy", "label": "legacy metadata"], rename: true))
            try memory.select(legacy.id)
            try check(memory.selected!.authorizationID == nil, "metadata/select fabricated legacy cold-restore proof")
            try memory.replace(id: legacy.id, version: memory.selected!.editorVersion!, url: legacy.url, token: "fixture-real-reauthorization", label: legacy.label, relay: nil)
            try check(memory.selected!.authorizationID.flatMap(UUID.init(uuidString:)) != nil && memory.memoryWrites == 3, "explicit reauthorization did not create durable proof")
            isolated.stop()
        case "authorization-remove-readd":
            let previous = store.selected!
            try store.remove(previous.id)
            try store.save(url: previous.url, token: "fixture-authorized-again", label: previous.label, relay: previous.relay)
            try check(store.selected!.id != previous.id && store.selected!.authorizationID != previous.authorizationID && (store.snapshot["connections"] as! [[String: Any]]).allSatisfy({ $0["id"] as? String != previous.id }), "remove/readd resurrected a revoked authorization")
        case "authorization-roundtrip", "authorization-replacements":
            let first = store.selected!, firstID = first.authorizationID!
            try check(UUID(uuidString: firstID) != nil, "saved authorization is not a UUID")
            let restored = try ConnectionStore(memoryData: store.memoryPersisted)
            try check(restored.selected!.authorizationID == firstID && restored.memoryWrites == 0, "durable authorization did not round trip without migration")
            _ = try await call("connection.rename", ["id": first.id, "version": first.editorVersion!, "label": "renamed"])
            let renamed = store.selected!
            _ = try await call("connection.edit", ["id": renamed.id, "version": renamed.editorVersion!, "label": "metadata", "url": renamed.url.absoluteString])
            try store.select(first.id)
            try check(store.selected!.authorizationID == firstID && (try liveScope()) == expectedHost, "metadata/last-used edit rotated durable or ephemeral authority")
            if scenario == "authorization-replacements" {
                for replacement in 0..<3 {
                    let previous = store.selected!
                    let relay = replacement == 2 ? RelayConfiguration(relayUrl: "wss://second-relay-fixture.invalid", serverId: "fixture-other-host", hostEncPubJwk: ["fixture": "not-dialed"]) : nil
                    let url = replacement == 1 ? URL(string: "https://replacement-origin.invalid")! : previous.url
                    try store.replace(id: previous.id, version: previous.editorVersion!, url: url, token: "fixture-replacement-\(replacement)", label: previous.label, relay: relay)
                    try check(store.selected!.authorizationID != previous.authorizationID, "credential/origin/Relay replacement retained durable proof")
                }
            }
        case "authorization-failed-write":
            let previous = store.selected!, bytes = store.memoryPersisted
            for replacement in [false, true] {
                store.failNextWrite = true
                var failed = false
                do {
                    if replacement { try store.replace(id: previous.id, version: previous.editorVersion!, url: previous.url, token: "fixture-replaced", label: previous.label, relay: previous.relay) }
                    else { try store.save(url: previous.url, token: "fixture-replaced", label: previous.label, relay: previous.relay) }
                } catch { failed = true }
                try check(failed && store.selected!.authorizationID == previous.authorizationID && store.memoryPersisted == bytes, "failed Keychain sink rotated persisted authorization")
            }
        case let value where value.hasPrefix("voice-admission-") && value != "voice-admission-order":
            let audio = AdmissionAudio()
            var stops = 0, factories = 0
            let core = VoiceRecognitionCore(capture: { try runtime.voiceRecognitionTransport(expectedHost: $0) }, audio: { factories += 1; return audio }, beforeCapture: { stops += 1 }, foreground: { true })
            var payload: [String: Any] = ["owner": "old-owner", "revision": 1, "provider": "openai-compatible", "expectedHost": expectedHost.publicValue]
            if value == "voice-admission-missing" { payload.removeValue(forKey: "expectedHost") }
            if value == "voice-admission-invalid" { payload["expectedHost"] = ["hostID": expectedHost.hostID, "lease": "invalid"] }
            if value == "voice-admission-forged" { payload["expectedHost"] = RuntimeHostScope(hostID: expectedHost.hostID, lease: UUID()).publicValue }
            if value == "voice-admission-other-host" { payload["expectedHost"] = RuntimeHostScope(hostID: "other-host", lease: expectedHost.lease).publicValue }
            if value == "voice-admission-background" { runtime.setForeground(false) }
            if value == "voice-admission-resume" { runtime.setForeground(false); runtime.setForeground(true) }
            var failed = false
            do { _ = try await core.start(payload) } catch { failed = true }
            try check(failed && stops == 0 && factories == 0 && audio.permissions == 0 && audio.starts == 0 && io.http.isEmpty && io.hostRequests.isEmpty && io.upgrades.isEmpty, "denied ASR touched TTS/recorder/permission/Host")
        case "voice-queued-background":
            let audio = AdmissionAudio(); var stops = 0
            let core = VoiceRecognitionCore(capture: { try runtime.voiceRecognitionTransport(expectedHost: $0) }, audio: { audio }, beforeCapture: { stops += 1 }, foreground: { true })
            let queued = Task { try await core.start(["owner": "queued-old", "revision": 1, "provider": "openai-compatible", "expectedHost": expectedHost.publicValue]) }
            runtime.setForeground(false)
            do { _ = try await queued.value; try check(false, "queued background ASR admitted") } catch RuntimeHostScopeFailure.background {}
            try check(stops == 0 && audio.permissions == 0 && audio.starts == 0 && io.http.isEmpty && io.upgrades.isEmpty, "queued ASR touched privileged resources")
        case "voice-admission-order", "voice-cleanup-retired":
            let audio = AdmissionAudio(); var order = [String]()
            io.settingsProvider = "openai-compatible"; io.speechGET = { order.append("get") }; audio.step = { order.append($0) }
            let core = VoiceRecognitionCore(capture: { expected in let result = try runtime.voiceRecognitionTransport(expectedHost: expected); order.append("admit"); return result }, audio: { order.append("audio"); return audio }, beforeCapture: { order.append("tts-stop") }, foreground: { true })
            _ = try await core.start(["owner": "capture-owner", "revision": 1, "provider": "openai-compatible", "expectedHost": expectedHost.publicValue])
            try check(order == ["admit", "tts-stop", "audio", "get", "permission", "record"], "ASR effect happened before native admission")
            if scenario == "voice-cleanup-retired" {
                runtime.setForeground(false)
                do { _ = try await core.finish(owner: "capture-owner", revision: 1); try check(false, "retired finish borrowed new Host") } catch is CancellationError {}
                try check(audio.cancels > 0 && io.http.count == 1 && io.upgrades.isEmpty, "retired finish failed to clean or contacted Host")
            }
            try core.cancel(owner: "capture-owner", revision: 1)
            _ = try VoiceRecognitionRequest(["owner": "capture-owner", "revision": 1], start: false)
        case "routes":
            _ = try await transport.settings()
            let wav = try VoiceRecognitionPCM.wav(Data([1, 0]))
            let response = try await transport.transcribe(wav)
            try check(try VoiceRecognitionPCM.transcript(response) == "recognized", "transcript response lost")
            let socket = try await transport.open(); defer { socket.close() }
            try check(io.http[0].request.url?.path == "/api/voice/settings" && io.http[0].request.httpMethod == "GET" && io.http[0].limit == 65536, "settings route changed")
            let file = io.http[1]
            try check(file.request.url?.path == "/api/stt/transcribe" && file.request.httpMethod == "POST" && file.request.httpBody == wav && file.limit == 131072 && file.request.timeoutInterval == 90, "file route/body/bounds changed")
            try check(file.request.value(forHTTPHeaderField: "Content-Type") == "audio/wav", "audio was JSON encoded")
            try check(io.http.allSatisfy { $0.request.value(forHTTPHeaderField: "Authorization") == "Bearer fixture-client" && $0.relay == relay && $0.request.url?.query == nil }, "auth/tunnel/request fidelity lost")
            try check(Set(file.request.allHTTPHeaderFields!.keys.map { $0.lowercased() }).isSubset(of: ["accept", "authorization", "content-type"]), "provider override header escaped")
            let upgrade = io.upgrades[0]
            try check(upgrade.request.url?.path == "/api/dictation/ws" && upgrade.request.url?.query == nil && upgrade.request.timeoutInterval == 20 && upgrade.relay == relay, "upgrade route/bounds changed")
            if relayMode {
                try check(io.http.count == 3 && io.http[2].request.url?.path == "/auth/url-token" && io.http[2].request.httpMethod == "POST" && io.http[2].request.timeoutInterval == 10 && io.http[2].limit == 65536, "scoped mint was not bounded/authenticated")
                try check(upgrade.token == "fixture-url-grant" && upgrade.request.url?.scheme == "https", "Relay dial fell back to direct/bearer URL")
            } else {
                try check(io.http.count == 2 && upgrade.token == nil && upgrade.request.url?.scheme == "wss" && upgrade.request.value(forHTTPHeaderField: "Origin") == origin.absoluteString && upgrade.request.value(forHTTPHeaderField: "Authorization") == "Bearer fixture-client", "direct Origin/native header auth changed")
            }
        case "file-limit":
            for count in [0, 1_920_045] {
                do { _ = try await transport.transcribe(Data(repeating: 0, count: count)); try check(false, "file bound bypassed") } catch VoiceRecognitionFailure.limit {}
            }
            _ = try await transport.transcribe(Data(repeating: 0, count: 1_920_044))
            try check(io.http.count == 1, "invalid bytes reached I/O")
        case "bad-credential":
            do { _ = try await transport.settings(); try check(false, "credential injection accepted") } catch {}
            try check(io.http.isEmpty && io.upgrades.isEmpty, "malformed auth reached I/O")
        case "response-oversize", "response-html", "response-unauthorized", "response-redirect", "response-private-error":
            io.badResponse = String(scenario.dropFirst("response-".count))
            for file in [false, true] {
                do { if file { _ = try await transport.transcribe(Data([1])) } else { _ = try await transport.settings() }; try check(false, "bad response accepted") }
                catch let error as VoiceRecognitionFailure { try check(error == .limit || error == .transport || error == .unavailable, "unsafe error projection") }
            }
        case let value where value.hasPrefix("mint-"):
            io.badMint = String(value.dropFirst(5))
            do { _ = try await transport.open(); try check(false, "invalid mint opened a socket") } catch is VoiceRecognitionFailure {}
            try check(io.upgrades.isEmpty && io.http.count == 1 && io.http[0].relay != nil, "mint failure downgraded to direct")
        case "cancel-http", "generation-http", "select-http", "cancel-file", "generation-file":
            io.delayHTTP = true
            var settled = false
            let task = Task {
                defer { settled = true }
                if scenario.hasSuffix("file") { return try await transport.transcribe(Data([1, 0])) }
                return try await transport.settings()
            }
            try await eventually { io.httpWait != nil }
            if scenario.hasPrefix("cancel-") { task.cancel() }
            else if scenario.hasPrefix("generation-") { runtime.stop() }
            else {
                try store.save(url: URL(string: "https://second-fixture.invalid")!, token: "fixture-second", label: "second")
                _ = try await app.handlers["connection.select"]!(["id": store.selected!.id])
            }
            try await eventually { settled && io.httpCancelled }
            do { _ = try await task.value; try check(false, "cancelled HTTP returned success") } catch is CancellationError {}
            io.httpWait?.resume(returning: try io.response("/api/voice/settings")); io.httpWait = nil
            if !scenario.hasPrefix("cancel-") { try check(!transport.isCurrent(), "old Host scope survived") }
        case "cancel-mint", "generation-mint":
            io.delayHTTP = true
            var settled = false
            let task = Task { defer { settled = true }; return try await transport.open() }
            try await eventually { io.httpWait != nil }
            if scenario == "cancel-mint" { task.cancel() } else { runtime.stop() }
            try await eventually { settled && io.httpCancelled }
            do { _ = try await task.value; try check(false, "cancelled mint opened socket") } catch is CancellationError {}
            io.httpWait?.resume(returning: try io.response("/auth/url-token")); io.httpWait = nil
            await Task.yield(); try check(io.upgrades.isEmpty, "late mint was adopted")
        case "cancel-open", "generation-open", "late-open":
            io.delayOpen = true
            var settled = false
            let task = Task { defer { settled = true }; return try await transport.open() }
            try await eventually { io.openWait != nil }
            if scenario == "generation-open" { runtime.stop() } else { task.cancel() }
            try await eventually { settled && io.openCancelled }
            do { _ = try await task.value; try check(false, "cancelled upgrade returned success") } catch is CancellationError {}
            io.delayOpen = false
            let newer = scenario == "late-open" ? try await transport.open() : nil
            let late = MemorySocket(); io.openWait?.resume(returning: late.socket()); io.openWait = nil
            try await eventually { late.closed }
            if let newer { try await newer.send("new lease"); try check(!io.sockets[0].closed, "late socket cleanup killed new lease"); newer.close() }
        case "cancel-receive", "generation-receive", "close-receive":
            let socket = try await transport.open(), raw = io.sockets[0]
            let task = Task { try await socket.receive() }
            try await eventually { raw.reader != nil }
            if scenario == "cancel-receive" { task.cancel() } else if scenario == "generation-receive" { runtime.stop() } else { socket.close(); socket.close() }
            do { _ = try await task.value; try check(false, "pending receive survived cancellation") } catch is CancellationError {}
            try check(raw.closed && raw.closes == 1, "physical socket not closed exactly once")
        case "cancel-send", "generation-send":
            let socket = try await transport.open(), raw = io.sockets[0]; raw.delaySend = true
            let task = Task { try await socket.send("synthetic") }
            try await eventually { raw.writer != nil }
            if scenario == "cancel-send" { task.cancel() } else { runtime.stop() }
            do { try await task.value; try check(false, "pending send survived cancellation") } catch is CancellationError {}
            try check(raw.closed, "cancel did not close physical writer")
        case "incoming-limit", "outgoing-limit", "closed":
            let socket = try await transport.open(), raw = io.sockets[0]
            if scenario == "incoming-limit" {
                raw.next = .text(String(repeating: "x", count: 131073))
                do { _ = try await socket.receive(); try check(false, "oversized message accepted") } catch VoiceRecognitionFailure.limit {}
            } else if scenario == "outgoing-limit" {
                do { try await socket.send(String(repeating: "x", count: 16385)); try check(false, "oversized outgoing accepted") } catch VoiceRecognitionFailure.limit {}
                try check(raw.sends.isEmpty, "oversized write reached native I/O")
            } else { raw.next = .closed; _ = try await socket.receive() }
            try check(raw.closed, "terminal socket retained")
        case "isolation":
            let first = try await transport.open(), second = try await transport.open()
            let waiting = Task { try await first.receive() }
            try await eventually { io.sockets[0].reader != nil }
            waiting.cancel()
            do { _ = try await waiting.value; try check(false, "cancel did not settle") } catch is CancellationError {}
            try await second.send("surviving stream"); _ = try await transport.settings()
            try check(io.sockets[0].closed && !io.sockets[1].closed && io.sockets[1].sends == ["surviving stream"], "one cancellation poisoned a sibling or HTTP")
            second.close()
        case "stale", "rename", "credential-change":
            if scenario == "stale" {
                runtime.stop()
                do { _ = try await transport.settings(); try check(false, "stale GET admitted") } catch is CancellationError {}
                do { _ = try await transport.open(); try check(false, "stale upgrade admitted") } catch is CancellationError {}
                try check(io.http.isEmpty && io.upgrades.isEmpty, "stale scope performed I/O")
            } else if scenario == "rename" {
                let selected = store.selected!
                _ = try await app.handlers["connection.rename"]!(["id": selected.id, "version": selected.editorVersion!, "label": "renamed"])
                try check(transport.isCurrent(), "metadata rename invalidated transport")
                _ = try await transport.settings()
            } else {
                let selected = store.selected!
                try store.replace(id: selected.id, version: selected.editorVersion!, url: selected.url, token: "fixture-replaced", label: selected.label, relay: selected.relay)
                try check(!transport.isCurrent(), "same-ID credential replacement retained old authority")
                do { _ = try await transport.settings(); try check(false, "stale credential performed request") } catch is CancellationError {}
                runtime.stop()
                let nextScope = try RuntimeHostScope(runtime.snapshot["runtimeScope"])
                let next = try runtime.voiceRecognitionTransport(expectedHost: nextScope); _ = try await next.settings()
                try check(io.http.count == 1 && io.http[0].request.value(forHTTPHeaderField: "Authorization") == "Bearer fixture-replaced", "fresh capture reused a cached credential")
            }
        default: try check(false, "unknown scenario")
        }
        print("PASS \(scenario) \(relayMode)")
    }
}
