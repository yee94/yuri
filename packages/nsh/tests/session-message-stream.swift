import Foundation

@MainActor final class Deferred<Value> {
    private var continuation: CheckedContinuation<Value, Error>?
    private var result: Result<Value, Error>?
    func value() async throws -> Value {
        if let result { return try result.get() }
        return try await withCheckedThrowingContinuation { continuation = $0 }
    }
    func finish(_ value: Result<Value, Error>) { result = value; continuation?.resume(with: value); continuation = nil }
}
@main struct SessionStreamChecks {
    @MainActor static func main() async throws {
        let pending = Deferred<SessionStreamSocket>()
        var opened = false, closed = 0, outputs = 0
        let transport = SessionStreamTransport(relay: false, current: { true }, open: { _ in opened = true; return try await pending.value() }, sse: { _, _, _ in fatalError("unexpected SSE") })
        let controller = SessionMessageStream(transport: transport, emit: { _ in outputs += 1 })
        let task = Task { await controller.run(mode: .ws) }
        while !opened { await Task.yield() }
        task.cancel()
        pending.finish(.success(SessionStreamSocket(receive: { fatalError("retired socket read") }, close: { closed += 1 })))
        await task.value
        guard closed == 1, outputs == 0 else { fatalError("late pending open must close exactly once without publication") }
        try await replayAndReady()
        try await modesAndCursor()
        try await cursorAcrossFallback()
        try await explicitFailure()
        try skewedHostToken()
        try sseIDs()
        print("PASS session stream deferred cancellation")
    }
    @MainActor static func skewedHostToken() throws {
        let format = DateFormatter(); format.locale = Locale(identifier: "en_US_POSIX"); format.calendar = Calendar(identifier: .gregorian)
        format.timeZone = TimeZone(secondsFromGMT: 0); format.dateFormat = "EEE, dd MMM yyyy HH:mm:ss 'GMT'"
        let base = ISO8601DateFormatter().date(from: "2020-01-01T00:00:00Z")!.timeIntervalSince1970
        // Neither enormous positive/negative wall-clock skew nor Date's lost
        // milliseconds may reject an ordinary fresh 60-second Host receipt.
        for offset: TimeInterval in [-100 * 365 * 86400, 0, 100 * 365 * 86400] {
            let host = base + offset, headers = ["DaTe": format.string(from: Date(timeIntervalSince1970: host))]
            for milliseconds in [0.0, 500.0, 999.0] {
                let body: [String: Any] = ["token": "fresh-host-token", "expiresAt": host * 1000 + milliseconds + 60000]
                let receipt = try SessionMessageStream.urlToken(status: 200, headers: headers, body: body, credential: "credential", requestStartedAt: 500, now: 502.5)
                guard try receipt.value(at: 503) == "fresh-host-token", abs(receipt.validUntil - (559 + milliseconds / 1000)) < 0.0001 else { fatalError("Host relative TTL or Date precision changed") }
                do { _ = try receipt.value(at: receipt.validUntil); fatalError("expired monotonic receipt accepted") } catch {}
                do { _ = try SessionMessageStream.urlToken(status: 200, headers: headers, body: body, credential: "credential", requestStartedAt: 500, now: 561); fatalError("request/tunnel delay did not consume TTL") } catch {}
            }
            for expiry in [host * 1000 - 1, host * 1000, host * 1000 + 1000] {
                do { _ = try SessionMessageStream.urlToken(status: 200, headers: headers, body: ["token": "short", "expiresAt": expiry], credential: "credential", requestStartedAt: 500, now: 501); fatalError("expired/uncertain Host receipt accepted") } catch {}
            }
        }
        for headers in [[String: String](), ["date": "invalid"]] {
            do { _ = try SessionMessageStream.urlToken(status: 200, headers: headers, body: ["token": "short", "expiresAt": base * 1000 + 60000], credential: "credential", requestStartedAt: 500, now: 501); fatalError("missing server time fell back to phone clock") } catch {}
        }
    }

    @MainActor static func replayAndReady() async throws {
        let waiting = Deferred<String>(), received = Deferred<Void>()
        var frames = ["{\"type\":\"event\",\"eventId\":\"opaque-1\",\"directory\":\"/repo\",\"payload\":{\"type\":\"session.text.delta.1\",\"data\":{\"delta\":\"正文\"}}}", "{\"type\":\"ready\",\"scope\":\"global\"}", "{\"type\":\"ready\",\"scope\":\"global\"}"]
        var order: [String] = [], closeCount = 0
        let controller = SessionMessageStream(transport: SessionStreamTransport(relay: true, current: { true }, open: { _ in
            SessionStreamSocket(receive: { if !frames.isEmpty { return frames.removeFirst() }; received.finish(.success(())); return try await waiting.value() }, close: { closeCount += 1; waiting.finish(.failure(CancellationError())) })
        }, sse: { _, _, _ in fatalError("explicit WS cannot fallback") }), emit: {
            switch $0 { case .event(let text): guard text.contains("正文"), text.contains("/repo") else { fatalError("wire changed") }; order.append("event")
            case .ready: order.append("ready")
            case .disconnected: order.append("disconnected") }
        })
        let task = Task { await controller.run(mode: .ws) }
        _ = try await received.value()
        guard order == ["event", "ready", "ready"], controller.cursor == "opaque-1" else { fatalError("replay must merge before every ready") }
        task.cancel(); await task.value
        guard closeCount >= 1 else { fatalError("receive cancellation must close") }
    }

    @MainActor static func modesAndCursor() async throws {
        for relay in [false, true] {
            for mode in [SessionStreamMode.auto, .ws, .sse] {
                var opens = 0, sse = 0, live = true
                let stopped = Deferred<Void>(), parked = Deferred<String>()
                let controller = SessionMessageStream(transport: SessionStreamTransport(relay: relay, current: { live }, open: { _ in
                    opens += 1
                    if mode == .auto { throw SessionStreamFailure.closed }
                    return SessionStreamSocket(receive: { stopped.finish(.success(())); return try await parked.value() }, close: { parked.finish(.failure(CancellationError())) })
                }, sse: { cursor, ready, event in
                    sse += 1; guard cursor == nil else { fatalError("invented cursor") }
                    ready(); try event("{\"type\":\"yuri:heartbeat\"}", "cursor-α")
                    stopped.finish(.success(())); live = false
                }), emit: { _ in })
                let task = Task { await controller.run(mode: mode) }
                _ = try await stopped.value(); task.cancel(); await task.value
                let wantsSSE = mode == .sse || mode == .auto
                guard sse == (wantsSSE ? 1 : 0), opens == (mode == .ws || mode == .auto && !relay ? 1 : 0) else { fatalError("mode selection violated") }
                if wantsSSE { guard controller.cursor == "cursor-α" else { fatalError("SSE cursor not retained") } }
            }
        }
    }

    @MainActor static func sseIDs() throws {
        var records: [(String, String?)] = []
        let parser = SSEEvents(event: { records.append(($0, $1)) })
        // One byte at a time, including BOM/Unicode and CRLF split boundaries.
        let input = "\u{FEFF}: comment\r\nid: opaque α\r\ndata: {\"type\":\"x\",\r\ndata: \"text\":\"正文\"}\r\n\r\nid: bad\0value\ndata: {\"type\":\"next\"}\n\nid:\n\nid: unterminated"
        for byte in input.utf8 { try parser.consume(byte) }
        guard records.count == 3, records[0].1 == "opaque α", records[0].0 == "{\"type\":\"x\",\n\"text\":\"正文\"}", records[1].1 == nil, records[2].1 == "", records[2].0.isEmpty else { fatalError("SSE id/data/reset parsing violated") }
        for text in ["{}", "{\"type\":\"subscribe\"}", "{\"type\":\"ready\",\"scope\":\"directory\"}", "{\"type\":\"event\",\"payload\":{}}", "{\"type\":\"error\",\"message\":\"unavailable\"}"] {
            do { _ = try SessionStreamFrame.decode(text); fatalError("invalid frame accepted") } catch {}
        }
        for value: [String: Any] in [["token": "credential", "expiresAt": Date().timeIntervalSince1970 * 1000 + 60000], ["token": "short", "expiresAt": 1], ["token": "short"], ["token": "bad\nvalue", "expiresAt": Date().timeIntervalSince1970 * 1000 + 60000]] {
            do { _ = try SessionMessageStream.urlToken(status: 200, headers: ["date": "Wed, 01 Jan 2020 00:00:00 GMT"], body: value, credential: "credential", requestStartedAt: 10, now: 11); fatalError("invalid URL token accepted") } catch {}
        }
    }

    @MainActor static func cursorAcrossFallback() async throws {
        var time: TimeInterval = 1, opens: [String?] = [], emitted: [String] = [], live = true
        let complete = Deferred<Void>()
        let controller = SessionMessageStream(transport: SessionStreamTransport(relay: false, current: { live }, open: { cursor in
            opens.append(cursor)
            if opens.count == 1 { throw SessionStreamFailure.closed }
            guard cursor == "sse-opaque" else { fatalError("SSE resume id lost on WS probe") }
            live = false; complete.finish(.success(())); throw CancellationError()
        }, sse: { cursor, ready, event in
            guard cursor == nil else { fatalError("invented cursor before first event") }
            ready(); try event("{\"type\":\"session.status\"}", "sse-opaque")
            time += 61; throw SessionStreamFailure.closed
        }), now: { time }, wait: { _ in }, emit: { output in
            if case .event = output { emitted.append("event") }
        })
        let task = Task { await controller.run(mode: .auto) }
        _ = try await complete.value(); await task.value
        guard opens.count == 2, emitted == ["event"] else { fatalError("fallback did not recover through one stream") }
    }

    @MainActor static func explicitFailure() async throws {
        for relay in [false, true] {
            var opens = 0, sse = 0, live = true, waits: [TimeInterval] = []
            let controller = SessionMessageStream(transport: SessionStreamTransport(relay: relay, current: { live }, open: { _ in opens += 1; throw SessionStreamFailure.http(401) }, sse: { _, _, _ in sse += 1 }), wait: { delay in waits.append(delay); live = false }, emit: { _ in })
            await controller.run(mode: .ws)
            guard opens == 1, sse == 0, waits == [60] else { fatalError("explicit WS auth failure silently fell back or hot-retried") }
        }
    }
}
