import Foundation
import CryptoKit
import NativeShell

@MainActor private final class RuntimeDeferred<Value> {
    private var continuation: CheckedContinuation<Value, Error>?
    private var result: Result<Value, Error>?
    func value() async throws -> Value {
        if let result { return try result.get() }
        return try await withCheckedThrowingContinuation { continuation = $0 }
    }
    func finish(_ value: Result<Value, Error>) { result = value; continuation?.resume(with: value); continuation = nil }
}
@main struct SessionRuntimeChecks {
    @MainActor static func main() async throws {
        try await pausedSessionReplay()
        for relay in [false, true] { for mode in ["auto", "ws", "sse"] { try await scenario(relay: relay, mode: mode) } }
        print("PASS native session runtime modes, auth, owner replacement and lifecycle")
    }
    @MainActor static func pausedSessionReplay() async throws {
        let inbox = NativeSocketInbox.sessionStream()
        try await inbox.didOpen()
        // Match the Host's complete 2048-event replay plus its ready barrier.
        // No consumer runs while the actual production mailbox receives frames.
        for index in 0..<2048 {
            try await inbox.consume(type: 8, payload: Data("{\"type\":\"event\",\"eventId\":\"r-\(index)\",\"payload\":{\"type\":\"fixture\",\"ordinal\":\(index)}}".utf8))
        }
        try await inbox.consume(type: 8, payload: Data("{\"type\":\"ready\",\"scope\":\"global\"}".utf8))
        let ready = RuntimeDeferred<Void>()
        var events = 0
        let controller = SessionMessageStream(transport: SessionStreamTransport(relay: true, current: { true }, open: { _ in
            SessionStreamSocket(receive: {
                guard case .text(let text) = try await inbox.receive() else { throw SessionStreamFailure.invalid }; return text
            }, close: { Task { await inbox.fail(CancellationError()) } })
        }, sse: { _, _, _ in fatalError("explicit session WS fell back") }), emit: { output in
            switch output {
            case .event(let data):
                let envelope = try! JSONSerialization.jsonObject(with: Data(data.utf8)) as! [String: Any]
                guard (envelope["payload"] as? [String: Any])?["ordinal"] as? Int == events else { fatalError("paused replay reordered") }; events += 1
            case .ready: ready.finish(.success(()))
            case .disconnected: fatalError("bounded replay disconnected")
            }
        })
        let run = Task { await controller.run(mode: .ws) }
        _ = try await ready.value(); run.cancel(); await run.value
        guard events == 2048, controller.cursor == "r-2047" else { fatalError("replay lost or reordered") }
        for countOverflow in [true, false] {
            let bounded = NativeSocketInbox.sessionStream(); try await bounded.didOpen()
            let data = Data(repeating: 120, count: countOverflow ? 1 : 1024 * 1024)
            let count = countOverflow ? 4096 : 8
            for _ in 0..<count { try await bounded.consume(type: 9, payload: data) }
            do { try await bounded.consume(type: 9, payload: data); fatalError("session mailbox overflow silently accepted") }
            catch { await bounded.fail(error) } // Same owning-stream close path as RelayTunnel.handle.
            do { _ = try await bounded.receive(); fatalError("overflow silently dropped frames and continued") } catch {}
            let recovered = NativeSocketInbox.sessionStream(); try await recovered.didOpen()
            try await recovered.consume(type: 8, payload: Data("{\"type\":\"ready\",\"scope\":\"global\"}".utf8))
            let barrier = RuntimeDeferred<Void>(); var opens = 0, disconnects = 0
            let recovery = SessionMessageStream(transport: SessionStreamTransport(relay: true, current: { true }, open: { _ in
                opens += 1; let source = opens == 1 ? bounded : recovered
                return SessionStreamSocket(receive: {
                    guard case .text(let text) = try await source.receive() else { throw SessionStreamFailure.invalid }; return text
                }, close: { Task { await source.fail(CancellationError()) } })
            }, sse: { _, _, _ in fatalError("explicit WS overflow silently changed transport") }), wait: { _ in }, emit: { output in
                switch output { case .ready: barrier.finish(.success(())); case .disconnected: disconnects += 1; case .event: fatalError("overflow published discarded payload") }
            })
            let retry = Task { await recovery.run(mode: .ws) }
            _ = try await barrier.value(); retry.cancel(); await retry.value
            guard opens == 2, disconnects == 1 else { fatalError("mailbox overflow did not disconnect and recover explicitly") }
        }
        let standard = NativeSocketInbox(maxMessageBytes: 1024 * 1024); try await standard.didOpen()
        for _ in 0..<2 { try await standard.consume(type: 8, payload: Data("x".utf8)) }
        do { try await standard.consume(type: 8, payload: Data("x".utf8)); fatalError("non-session mailbox budget changed") } catch {}
    }
    @MainActor static func scenario(relay: Bool, mode: String) async throws {
        let store = try ConnectionStore(), app = NshAppView()
        let key = P256.KeyAgreement.PrivateKey().publicKey.x963Representation
        func b64(_ data: Data) -> String { data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
        let configuration = relay ? RelayConfiguration(relayUrl: "wss://relay.example.invalid/ws", serverId: "fixture", hostEncPubJwk: ["kty": "EC", "crv": "P-256", "x": b64(key.subdata(in: 1..<33)), "y": b64(key.subdata(in: 33..<65))]) : nil
        try store.save(url: URL(string: "https://fixture.example.invalid")!, token: "fixture-client-credential", label: "fixture", relay: configuration)
        var minted = 0
        let bridge = RuntimeBridge(app: app, store: store)
        bridge.setForeground(true)
        let scope = bridge.snapshot["runtimeScope"]!
        var opened = 0, streams = 0, closed = 0
        var read = RuntimeDeferred<String>(), streamWait = RuntimeDeferred<Void>()
        bridge.sessionStreamIO = RuntimeBridge.SessionStreamIO(open: { request, tunnel, token in
            opened += 1
            guard request.url?.path == "/api/global/event/ws", request.value(forHTTPHeaderField: "Authorization") == "Bearer fixture-client-credential", (tunnel != nil) == relay,
                  !request.url!.absoluteString.contains("fixture-client-credential") else { fatalError("capture auth violated") }
            if relay { guard token == "fixture-short-token" else { fatalError("missing fresh token") } }
            else { guard token == nil, request.url?.scheme == "wss", request.value(forHTTPHeaderField: "Origin") == "https://fixture.example.invalid" else { fatalError("invalid direct WS") } }
            let captured = read
            let parked = RuntimeDeferred<String>(); var consumed = false
            return SessionStreamSocket(receive: { if consumed { return try await parked.value() }; consumed = true; return try await captured.value() }, close: { closed += 1; captured.finish(.failure(CancellationError())); parked.finish(.failure(CancellationError())) })
        }, sse: { request, tunnel, ready, data in
            streams += 1
            guard request.url?.path == "/api/event", request.value(forHTTPHeaderField: "Authorization") == "Bearer fixture-client-credential", (tunnel != nil) == relay else { fatalError("invalid SSE capture") }
            ready(); try data(Data("id: cursor-1\ndata: {\"type\":\"session.status\"}\n\n".utf8))
            let pending = streamWait
            try await withTaskCancellationHandler(operation: { try await pending.value() }, onCancel: { Task { @MainActor in pending.finish(.failure(CancellationError())) } })
        }, mint: { request, _ in
            guard request.url?.path == "/auth/url-token", request.httpMethod == "POST", request.value(forHTTPHeaderField: "Authorization") == "Bearer fixture-client-credential" else { fatalError("unexpected auth I/O") }
            minted += 1
            return (200, ["date": "Wed, 01 Jan 2020 00:00:00 GMT"], ["token": "fixture-short-token", "expiresAt": 1_577_836_860_000.0])
        })
        func start(_ owner: String, _ scope: Any, path: String = "/api/event?directory=%2Frepo", selectedMode: String? = nil) async throws {
            _ = try await app.handlers["runtime.stream"]!(["key": "chat", "path": path, "expectedHost": scope, "ownerID": owner, "mode": selectedMode ?? mode])
        }
        func stop(_ owner: String, _ scope: Any) async throws { _ = try await app.handlers["runtime.stop"]!(["key": "chat", "ownerID": owner, "expectedHost": scope]) }
        try await start("first", scope)
        for _ in 0..<300 { if opened + streams > 0 { break }; await Task.yield() }
        guard opened + streams == 1, opened == (mode == "ws" || mode == "auto" && !relay ? 1 : 0), minted == (relay && mode == "ws" ? 1 : 0) else { fatalError("mode or mint contract violated") }
        // Invalid input must not replace the admitted stream.
        for (path, candidateMode) in [("/api/terminal/ws", mode), ("/api/event?directory=%2Frepo&evil=1", mode), ("/api/event?directory=%2Frepo", "invalid")] {
            do { try await start("bad", scope, path: path, selectedMode: candidateMode); fatalError("invalid stream accepted") } catch {}
        }
        guard closed == 0 else { fatalError("invalid replacement cancelled old owner") }
        read = RuntimeDeferred<String>(); streamWait = RuntimeDeferred<Void>()
        try await start("replacement", scope)
        for _ in 0..<300 { if opened + streams == 2 { break }; await Task.yield() }
        try await stop("first", scope)
        let count = app.events.count
        read.finish(.success("{\"type\":\"ready\",\"scope\":\"global\"}"))
        // A new read must park after this frame, so the fixture cannot flood.
        if mode == "ws" || mode == "auto" && !relay {
            for _ in 0..<100 { await Task.yield(); if app.events.count > count { break } }
            guard app.events.contains(where: { $0.1["ownerID"] as? String == "replacement" && $0.1["type"] as? String == "reconnected" }) else { fatalError("old same-lease stop killed replacement") }
        }
        bridge.setForeground(false)
        do { try await start("background", scope); fatalError("background admission") } catch {}
        bridge.setForeground(true)
        do { try await start("stale", scope); fatalError("old lease admission") } catch {}
        let firstID = store.selected!.id
        try store.save(url: URL(string: "https://other.example.invalid")!, token: "other-fixture-credential", label: "other", relay: nil)
        bridge.stop()
        let otherScope = bridge.snapshot["runtimeScope"]!
        _ = try await app.handlers["connection.select"]!(["id": firstID])
        for retired in [scope, otherScope] {
            do { try await start("retired", retired); fatalError("A-B-A resurrected old scope") } catch {}
        }
        // Old cleanup remains a no-op after the latest authority is selected.
        try await stop("first", scope)
        bridge.stop()
    }
}
