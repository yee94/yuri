import Foundation
import CoreFoundation

/// Terminal-only native test seam. Production request construction, captured
/// credentials, admission and invalidation remain in RuntimeBridge.
@MainActor struct TerminalRuntimeIO {
    let http: (URLRequest, RelayConfiguration?, Int) async throws -> TerminalHTTPResponse
    let socket: (URLRequest, RelayConfiguration?, String?) async throws -> TerminalSocket
}
struct TerminalHTTPResponse {
    let status: Int
    let headers: [String: String]
    let data: Data
    func header(_ name: String) -> String? { headers.first { $0.key.lowercased() == name.lowercased() }?.value }
}

enum TerminalTransportWire {
    static let responseLimit = 65_536, messageLimit = 1_048_576, inputLimit = 65_536
    static func failure(_ error: Error) -> Error {
        if error is CancellationError || (error as? URLError)?.code == .cancelled { return CancellationError() }
        if let relay = error as? RelayTunnel.Failure {
            switch relay {
            case .limit: return TerminalFailure.overflow
            case .invalidFrame: return TerminalFailure.protocolViolation
            case .authentication: return TerminalFailure.unavailable
            default: break
            }
        }
        return error as? TerminalFailure ?? .connectionFailed
    }
    static func head(_ value: TerminalHTTPResponse, limit: Int) throws {
        guard value.data.count <= limit else { throw TerminalFailure.overflow }
        guard !(300..<400).contains(value.status) else { throw TerminalFailure.response }
    }
    static func json(_ value: TerminalHTTPResponse, limit: Int = responseLimit) throws -> [String: Any] {
        try head(value, limit: limit)
        guard value.header("content-type")?.split(separator: ";").first?.trimmingCharacters(in: .whitespaces).lowercased() == "application/json",
              let object = try? JSONSerialization.jsonObject(with: value.data) as? [String: Any] else { throw TerminalFailure.response }
        return object
    }
    static func token(_ value: TerminalHTTPResponse, credential: String) throws -> String {
        let body = try json(value)
        guard value.status == 200, let token = body["token"] as? String, !token.isEmpty, token != credential,
              token.utf8.count <= 8192, token.utf8.allSatisfy({ $0 > 32 && $0 < 127 }),
              let expiry = body["expiresAt"] as? NSNumber, CFGetTypeID(expiry) != CFBooleanGetTypeID(), expiry.doubleValue.isFinite,
              expiry.doubleValue > Date().timeIntervalSince1970 * 1000 else { throw TerminalFailure.response }
        return token
    }
}

/// Immediate cancellation/deadline settlement, including non-cooperative injected
/// I/O. Late values can only be discarded; a late socket is physically closed.
@MainActor final class TerminalPending<Value> {
    private var reply: CheckedContinuation<Value, Error>?, work: Task<Void, Never>?, timer: Task<Void, Never>?
    private var complete = false
    private let discard: (Value) -> Void
    init(discard: @escaping (Value) -> Void = { _ in }) { self.discard = discard }
    func run(seconds: TimeInterval, operation: @escaping @MainActor () async throws -> Value) async throws -> Value {
        try await withTaskCancellationHandler(operation: {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                guard !complete else { continuation.resume(throwing: CancellationError()); return }
                reply = continuation
                work = Task { do { try Task.checkCancellation(); finish(.success(try await operation())) } catch { finish(.failure(TerminalTransportWire.failure(error))) } }
                timer = Task { do { try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000)) } catch { return }; finish(.failure(TerminalFailure.connectionFailed)) }
            }
        }, onCancel: { Task { @MainActor in self.cancel() } })
    }
    func cancel() { finish(.failure(CancellationError())) }
    private func finish(_ result: Result<Value, Error>) {
        guard !complete else { if case .success(let value) = result { discard(value) }; return }
        complete = true; let continuation = reply; reply = nil
        work?.cancel(); work = nil; timer?.cancel(); timer = nil; continuation?.resume(with: result)
    }
}

@MainActor final class TerminalSocketLease {
    private var raw: TerminalSocket?, opening: TerminalPending<TerminalSocket>?, reading: TerminalPending<TerminalWireMessage>?, writing: TerminalPending<Void>?
    private var closed = false
    private let current: () -> Bool, released: () -> Void
    init(current: @escaping () -> Bool, released: @escaping () -> Void) { self.current = current; self.released = released }
    private func check() throws { try Task.checkCancellation(); guard !closed, current() else { throw CancellationError() } }
    func open(_ operation: @escaping @MainActor () async throws -> TerminalSocket) async throws -> TerminalSocket {
        let pending = TerminalPending<TerminalSocket>(discard: { $0.close() }); opening = pending
        defer { opening = nil }
        do {
            let socket = try await pending.run(seconds: 15, operation: operation)
            do { try check() } catch { socket.close(); throw error }
            raw = socket
            return TerminalSocket(receive: { try await self.receive() }, send: { try await self.send($0) }, close: { self.close() })
        } catch { close(); throw TerminalTransportWire.failure(error) }
    }
    private func receive() async throws -> TerminalWireMessage {
        do {
            try check(); guard let raw, reading == nil else { throw TerminalFailure.invalid }
            let pending = TerminalPending<TerminalWireMessage>(); reading = pending; defer { reading = nil }
            let value = try await pending.run(seconds: 65) { try await raw.receive() }; try check()
            switch value {
            case .text(let text): guard text.utf8.count <= TerminalTransportWire.messageLimit else { throw TerminalFailure.overflow }
            case .binary(let bytes): guard bytes.count <= TerminalTransportWire.messageLimit else { throw TerminalFailure.overflow }
            case .closed: close()
            }
            return value
        } catch { close(); throw TerminalTransportWire.failure(error) }
    }
    private func send(_ value: TerminalWireMessage) async throws {
        do {
            try check(); guard let raw, writing == nil else { throw TerminalFailure.invalid }
            switch value {
            case .text(let text): guard text.utf8.count <= TerminalTransportWire.inputLimit else { throw TerminalFailure.overflow }
            case .binary(let bytes): guard bytes.count <= TerminalTransportWire.inputLimit else { throw TerminalFailure.overflow }
            case .closed: throw TerminalFailure.invalid
            }
            let pending = TerminalPending<Void>(); writing = pending; defer { writing = nil }
            try await pending.run(seconds: 15) { try await raw.send(value) }; try check()
        } catch { close(); throw TerminalTransportWire.failure(error) }
    }
    func close() {
        guard !closed else { return }; closed = true
        opening?.cancel(); reading?.cancel(); writing?.cancel(); raw?.close(); raw = nil; released()
    }
}

/// Bounded logical messages: shared by direct WS and terminal SSE, with no silent
/// drop. The parser preserves split UTF-8/CRLF and only emits complete SSE data.
@MainActor final class TerminalStreamInbox {
    private var opening: CheckedContinuation<Void, Error>?, waiting: CheckedContinuation<TerminalWireMessage, Error>?
    private var queue: [TerminalWireMessage] = [], bytes = 0, opened = false
    private var failure: Error?
    private var endError: Error?
    func didOpen() throws { guard !opened, failure == nil else { throw TerminalFailure.protocolViolation }; opened = true; opening?.resume(); opening = nil }
    func waitOpen() async throws {
        if let failure { throw failure }; if opened { return }
        guard opening == nil else { throw TerminalFailure.invalid }; try await withCheckedThrowingContinuation { opening = $0 }
    }
    func receive() async throws -> TerminalWireMessage {
        if let failure { throw failure }
        if !queue.isEmpty { let value = queue.removeFirst(); bytes -= size(value); return value }
        if let endError { throw endError }
        guard waiting == nil else { throw TerminalFailure.invalid }; return try await withCheckedThrowingContinuation { waiting = $0 }
    }
    func push(_ value: TerminalWireMessage) throws {
        guard failure == nil, opened else { throw TerminalFailure.connectionFailed }
        let count = size(value); guard count <= TerminalTransportWire.messageLimit else { throw TerminalFailure.overflow }
        if let reply = waiting { waiting = nil; reply.resume(returning: value); return }
        guard queue.count < 64, bytes + count <= 2_097_152 else { throw TerminalFailure.overflow }
        queue.append(value); bytes += count
    }
    func fail(_ error: Error) {
        guard failure == nil else { return }; failure = TerminalTransportWire.failure(error)
        queue.removeAll(); bytes = 0; opening?.resume(throwing: failure!); opening = nil; waiting?.resume(throwing: failure!); waiting = nil
    }
    func end(_ error: Error) {
        guard failure == nil, endError == nil else { return }; endError = TerminalTransportWire.failure(error)
        opening?.resume(throwing: endError!); opening = nil
        if queue.isEmpty { waiting?.resume(throwing: endError!); waiting = nil }
    }
    private func size(_ value: TerminalWireMessage) -> Int { switch value { case .text(let text): return text.utf8.count; case .binary(let bytes): return bytes.count; case .closed: return 0 } }
}

@MainActor final class TerminalSSEParser {
    private var line = Data(), lines: [String] = [], size = 0, previousCR = false
    let emit: (String) throws -> Void
    let heartbeat: () throws -> Void
    init(heartbeat: @escaping () throws -> Void = {}, emit: @escaping (String) throws -> Void) { self.emit = emit; self.heartbeat = heartbeat }
    func consume(_ bytes: Data) throws { for byte in bytes { try consume(byte) } }
    func consume(_ byte: UInt8) throws {
        if previousCR && byte == 10 { previousCR = false; return }; previousCR = false
        if byte == 10 || byte == 13 {
            previousCR = byte == 13
            guard let value = String(data: line, encoding: .utf8) else { throw TerminalFailure.protocolViolation }
            if line.isEmpty { if !lines.isEmpty { try emit(lines.joined(separator: "\n")) } else { try heartbeat() }; lines.removeAll(keepingCapacity: true); size = 0 }
            else if value.hasPrefix("data:") {
                size += line.count + 1; guard size <= TerminalTransportWire.messageLimit else { throw TerminalFailure.overflow }
                let content = value.dropFirst(5); lines.append(String(content.first == " " ? content.dropFirst() : content))
            }
            line.removeAll(keepingCapacity: true)
        } else { guard line.count < TerminalTransportWire.messageLimit else { throw TerminalFailure.overflow }; line.append(byte) }
    }
}
