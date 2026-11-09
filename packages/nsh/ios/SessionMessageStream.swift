import Foundation

enum SessionStreamMode: String { case auto, ws, sse }
enum SessionStreamFailure: Error { case invalid, closed, deadline, http(Int) }

enum SessionStreamFrame {
    case event(String, String?), ready, backpressure
    static func decode(_ text: String) throws -> Self {
        guard let data = text.data(using: .utf8), let frame = try JSONSerialization.jsonObject(with: data) as? [String: Any], let type = frame["type"] as? String else { throw SessionStreamFailure.invalid }
        switch type {
        case "ready":
            guard frame["scope"] as? String == "global" else { throw SessionStreamFailure.invalid }
            return .ready
        case "backpressure":
            guard let buffered = frame["bufferedBytes"] as? Double, let maximum = frame["maxBytes"] as? Double,
                  buffered.isFinite, maximum.isFinite, buffered >= 0, maximum > 0 else { throw SessionStreamFailure.invalid }
            return .backpressure
        case "event":
            guard let payload = frame["payload"] as? [String: Any], let kind = payload["type"] as? String, !kind.isEmpty,
                  frame["directory"] == nil || frame["directory"] is String,
                  frame["eventId"] == nil || frame["eventId"] is String else { throw SessionStreamFailure.invalid }
            let envelope: [String: Any] = ["payload": payload, "directory": frame["directory"] as? String ?? ""]
            let bytes = try JSONSerialization.data(withJSONObject: envelope)
            guard let value = String(data: bytes, encoding: .utf8) else { throw SessionStreamFailure.invalid }
            return .event(value, frame["eventId"] as? String)
        default: throw SessionStreamFailure.invalid
        }
    }
}

/// The existing global SSE parser is shared with Chat; IDs remain transport
/// cursors, never fabricated domain event IDs or proof of complete replay.
@MainActor final class SSEEvents {
    private var line = Data(), eventLines: [String] = []
    private var eventSize = 0, previousCR = false, firstLine = true
    private var eventID: String?
    private let emit: (String, String?) throws -> Void
    private let activity: () throws -> Void
    init(emit: @escaping (String) -> Void) { self.emit = { data, _ in if !data.isEmpty { emit(data) } }; activity = {} }
    init(event: @escaping (String, String?) throws -> Void, activity: @escaping () throws -> Void = {}) { emit = event; self.activity = activity }
    func consume(_ data: Data) throws { for byte in data { try consume(byte) } }
    func consume(_ byte: UInt8) throws {
        if previousCR && byte == 10 { previousCR = false; return }
        previousCR = false
        if byte == 10 || byte == 13 {
            previousCR = byte == 13
            guard var value = String(data: line, encoding: .utf8) else { throw SessionStreamFailure.invalid }
            if firstLine { firstLine = false; if value.first == "\u{FEFF}" { value.removeFirst() } }
            try activity()
            if value.isEmpty {
                if !eventLines.isEmpty || eventID != nil { try emit(eventLines.joined(separator: "\n"), eventID) }
                eventLines.removeAll(keepingCapacity: true); eventSize = 0; eventID = nil
            } else {
                let split = value.firstIndex(of: ":")
                let field = split.map { String(value[..<$0]) } ?? value
                var content = split.map { String(value[value.index(after: $0)...]) } ?? ""
                if content.first == " " { content.removeFirst() }
                if field == "data" {
                    eventSize += line.count + 1
                    guard eventSize <= 2_000_000 else { throw SessionStreamFailure.invalid }
                    eventLines.append(content)
                } else if field == "id", !content.contains("\0") { eventID = content }
            }
            line.removeAll(keepingCapacity: true)
        } else {
            guard line.count < 2_000_000 else { throw SessionStreamFailure.invalid }
            line.append(byte)
        }
    }
}
@MainActor struct SessionStreamSocket {
    let receive: () async throws -> String
    let close: () -> Void
}
@MainActor struct SessionStreamTransport {
    let relay: Bool
    let current: () -> Bool
    let open: (String?) async throws -> SessionStreamSocket
    let sse: (String?, @escaping () -> Void, @escaping (String, String?) throws -> Void) async throws -> Void
}
struct SessionStreamURLToken {
    let token: String
    let validUntil: TimeInterval
    func value(at monotonicNow: TimeInterval) throws -> String {
        guard monotonicNow.isFinite, monotonicNow < validUntil else { throw SessionStreamFailure.invalid }
        return token
    }
}
@MainActor final class SessionMessageStream {
    nonisolated static func validCursor(_ id: String?) -> Bool {
        guard let id else { return true }
        return id.utf8.count <= 8192 && !id.contains("\r") && !id.contains("\n") && !id.contains("\0")
    }
    nonisolated static func urlToken(status: Int, headers: [String: String], body: Any, credential: String, requestStartedAt: TimeInterval, now: TimeInterval) throws -> SessionStreamURLToken {
        guard status == 200 else { throw SessionStreamFailure.http(status) }
        guard let value = body as? [String: Any], let token = value["token"] as? String,
              !token.isEmpty, token != credential, token.utf8.count <= 8192,
              token.utf8.allSatisfy({ $0 > 32 && $0 < 127 }), let expiry = value["expiresAt"] as? Double,
              expiry.isFinite, requestStartedAt.isFinite, now.isFinite, now >= requestStartedAt,
              let date = headers.first(where: { $0.key.lowercased() == "date" })?.value else { throw SessionStreamFailure.invalid }
        let format = DateFormatter()
        format.locale = Locale(identifier: "en_US_POSIX"); format.calendar = Calendar(identifier: .gregorian)
        format.timeZone = TimeZone(secondsFromGMT: 0); format.dateFormat = "EEE, dd MMM yyyy HH:mm:ss 'GMT'"; format.isLenient = false
        guard let serverTime = format.date(from: date), format.string(from: serverTime) == date else { throw SessionStreamFailure.invalid }
        // Host Date has one-second precision. Its upper edge gives a conservative
        // remaining TTL; charging the full request duration also covers delivery
        // and tunnel delays without comparing the phone and Host wall clocks.
        let remainingMilliseconds = expiry - (serverTime.timeIntervalSince1970 * 1000 + 1000)
        guard remainingMilliseconds > 0, remainingMilliseconds <= 60_000 else { throw SessionStreamFailure.invalid }
        let receipt = SessionStreamURLToken(token: token, validUntil: requestStartedAt + remainingMilliseconds / 1000)
        _ = try receipt.value(at: now)
        return receipt
    }
    enum Output { case event(String), ready, disconnected }
    let transport: SessionStreamTransport
    let emit: (Output) -> Void
    private let now: () -> TimeInterval
    private let wait: (TimeInterval) async throws -> Void
    private(set) var cursor: String?
    private var fallbackUntil: TimeInterval = 0
    private var activity = ProcessInfo.processInfo.systemUptime
    private var ready = false
    private var readyAt: TimeInterval = 0
    private var failures = 0
    init(transport: SessionStreamTransport, now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }, wait: @escaping (TimeInterval) async throws -> Void = { try await Task.sleep(nanoseconds: UInt64($0 * 1_000_000_000)) }, emit: @escaping (Output) -> Void) {
        self.transport = transport; self.now = now; self.wait = wait; self.emit = emit
    }
    func run(mode: SessionStreamMode) async {
        while !Task.isCancelled && transport.current() {
            let ws = mode == .ws || mode == .auto && !transport.relay && now() >= fallbackUntil
            ready = false; readyAt = 0; activity = now()
            var permanentFailure = false
            let attempt = Task { try await self.attempt(ws: ws) }
            let deadline = Task {
                while !Task.isCancelled {
                    do { try await Task.sleep(nanoseconds: 250_000_000) } catch { return }
                    let budget: TimeInterval = self.ready ? 30 : (ws ? (self.transport.relay ? 8 : 2) : 30)
                    if self.now() - self.activity > budget { attempt.cancel(); return }
                }
            }
            do {
                try await withTaskCancellationHandler(operation: { try await attempt.value }, onCancel: { attempt.cancel() })
            } catch SessionStreamFailure.http(let status) {
                permanentFailure = (400..<500).contains(status) && status != 408 && status != 429
            } catch { /* Recovery preserves the last cursor and all caller authority. */ }
            deadline.cancel()
            if Task.isCancelled || !transport.current() { return }
            emit(.disconnected)
            failures += 1
            if mode == .auto && ws && (!ready || now() - readyAt < 2) {
                fallbackUntil = now() + 60
                continue
            }
            let delay = permanentFailure ? 60 : min(30.0, pow(2.0, Double(min(failures - 1, 5))))
            do { try await wait(delay) } catch { return }
        }
    }
    private func check() throws { try Task.checkCancellation(); guard transport.current() else { throw CancellationError() } }
    private func connected() {
        ready = true; readyAt = now(); activity = readyAt
        emit(.ready)
    }
    private func delivered(_ data: String, id: String?) throws {
        try check()
        guard Self.validCursor(id) else { throw SessionStreamFailure.invalid }
        if !data.isEmpty {
            guard let bytes = data.data(using: .utf8), let value = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { throw SessionStreamFailure.invalid }
            let event = (value["payload"] as? [String: Any]) ?? value
            guard let type = event["type"] as? String, !type.isEmpty else { throw SessionStreamFailure.invalid }
            emit(.event(data))
        }
        // Empty SSE id explicitly resets Last-Event-ID. Missing IDs do not invent one.
        if let id { cursor = id.isEmpty ? nil : id }
        activity = now()
        if ready && activity - readyAt >= 2 { failures = 0 }
    }
    private func attempt(ws: Bool) async throws {
        try check()
        if ws {
            let socket = try await transport.open(cursor)
            defer { socket.close() }
            try check()
            while true {
                let text = try await withTaskCancellationHandler(operation: { try await socket.receive() }, onCancel: { Task { @MainActor in socket.close() } })
                try check()
                switch try SessionStreamFrame.decode(text) {
                case .event(let data, let id): try delivered(data, id: id)
                case .ready: connected()
                case .backpressure: activity = now()
                }
            }
        } else {
            try await transport.sse(cursor, { if !Task.isCancelled && self.transport.current() { self.connected() } }, { data, id in try self.delivered(data, id: id) })
            throw SessionStreamFailure.closed
        }
    }
}
