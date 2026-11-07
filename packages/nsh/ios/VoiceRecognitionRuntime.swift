import Foundation
import CoreFoundation

/// Native I/O seam. Production defaults stay in RuntimeBridge and use its existing
/// authenticated HTTP / direct socket / paired Relay. Synthetic tests replace only
/// I/O, never request construction, auth admission, scope fences or cancellation.
@MainActor struct VoiceRecognitionRuntimeIO {
    let http: (URLRequest, RelayConfiguration?, Int) async throws -> VoiceRecognitionResponse
    let socket: (URLRequest, RelayConfiguration?, String?) async throws -> VoiceRecognitionSocket
}

enum VoiceRecognitionWire {
    static let fileLimit = 1_920_044
    static let settingsLimit = 65536
    static let responseLimit = 131072
    static let messageLimit = 131072
    static let sendLimit = 16384
    static func response(_ value: VoiceRecognitionResponse, limit: Int) throws -> VoiceRecognitionResponse {
        try head(status: value.status, mime: value.mime, length: value.data.count, limit: limit)
        return value
    }
    static func head(status: Int, mime: String, length: Int, limit: Int) throws {
        guard length <= limit else { throw VoiceRecognitionFailure.limit }
        guard (200..<300).contains(status) else { throw status == 401 || status == 403 ? VoiceRecognitionFailure.unavailable : VoiceRecognitionFailure.transport }
        guard mime.split(separator: ";", maxSplits: 1).first?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "application/json" else { throw VoiceRecognitionFailure.transport }
    }
    static func scopedToken(_ value: VoiceRecognitionResponse, credential: String) throws -> String {
        _ = try response(value, limit: settingsLimit)
        guard value.status == 200, let object = try? JSONSerialization.jsonObject(with: value.data) as? [String: Any],
              let token = object["token"] as? String, !token.isEmpty, token != credential, token.utf8.count <= 8192,
              token.utf8.allSatisfy({ $0 > 32 && $0 < 127 }),
              let expiry = object["expiresAt"] as? NSNumber, CFGetTypeID(expiry) != CFBooleanGetTypeID(),
              expiry.doubleValue.isFinite, expiry.doubleValue > Date().timeIntervalSince1970 * 1000 else { throw VoiceRecognitionFailure.transport }
        return token
    }
    static func failure(_ error: Error) -> Error {
        if error is CancellationError || (error as? URLError)?.code == .cancelled { return CancellationError() }
        if let error = error as? VoiceRecognitionFailure { return error }
        // Native/Host/URLSession descriptions may contain endpoints or credentials.
        return VoiceRecognitionFailure.transport
    }
}

/// Settles cancellation/deadlines immediately while also cancelling native I/O.
/// A late non-cooperative operation cannot install a socket in a newer lease.
@MainActor final class VoiceRecognitionPending<Value> {
    private var reply: CheckedContinuation<Value, Error>?
    private var work: Task<Void, Never>?
    private var timer: Task<Void, Never>?
    private var completed = false
    func run(seconds: TimeInterval, operation: @escaping @MainActor () async throws -> Value) async throws -> Value {
        try await withTaskCancellationHandler(operation: {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                guard !completed else { continuation.resume(throwing: CancellationError()); return }
                reply = continuation
                work = Task { [self] in
                    do { try Task.checkCancellation(); finish(.success(try await operation())) } catch { finish(.failure(VoiceRecognitionWire.failure(error))) }
                }
                timer = Task { [self] in
                    do { try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000)) } catch { return }
                    finish(.failure(VoiceRecognitionFailure.transport))
                }
            }
        }, onCancel: { Task { @MainActor in self.cancel() } })
    }
    func cancel() { finish(.failure(CancellationError())) }
    private func finish(_ result: Result<Value, Error>) {
        guard !completed else { return }; completed = true
        let continuation = reply; reply = nil
        timer?.cancel(); timer = nil; work?.cancel(); work = nil
        continuation?.resume(with: result)
    }
}

/// One RuntimeBridge registry entry covers pending upgrade AND the established
/// socket. The same close wakes every pending operation and closes physical I/O.
@MainActor final class VoiceRecognitionSocketLease {
    private var raw: VoiceRecognitionSocket?
    private var opening: VoiceRecognitionPending<Void>?
    private var reading: VoiceRecognitionPending<VoiceRecognitionMessage>?
    private var writing: VoiceRecognitionPending<Void>?
    private var closed = false
    private let current: () -> Bool
    private let released: () -> Void
    init(current: @escaping () -> Bool, released: @escaping () -> Void) { self.current = current; self.released = released }
    func open(_ operation: @escaping @MainActor () async throws -> VoiceRecognitionSocket) async throws -> VoiceRecognitionSocket {
        let pending = VoiceRecognitionPending<Void>(); opening = pending
        defer { opening = nil }
        do {
            try await pending.run(seconds: 20) {
                let socket = try await operation()
                do { try self.check() } catch { socket.close(); throw error }
                self.raw = socket
            }
            try check()
            return VoiceRecognitionSocket(receive: { try await self.receive() }, send: { try await self.send($0) }, close: { self.close() })
        } catch { close(); throw VoiceRecognitionWire.failure(error) }
    }
    private func check() throws { try Task.checkCancellation(); guard !closed, current() else { throw CancellationError() } }
    private func receive() async throws -> VoiceRecognitionMessage {
        do {
            try check(); guard let raw, reading == nil else { throw VoiceRecognitionFailure.transport }
            let pending = VoiceRecognitionPending<VoiceRecognitionMessage>(); reading = pending
            defer { reading = nil }
            let value = try await pending.run(seconds: 305) { try await raw.receive() }
            try check()
            switch value {
            case .text(let text): guard text.utf8.count <= VoiceRecognitionWire.messageLimit else { throw VoiceRecognitionFailure.limit }
            case .closed: close()
            }
            return value
        } catch { close(); throw VoiceRecognitionWire.failure(error) }
    }
    private func send(_ text: String) async throws {
        do {
            try check(); guard let raw, writing == nil else { throw VoiceRecognitionFailure.transport }
            guard text.utf8.count <= VoiceRecognitionWire.sendLimit else { throw VoiceRecognitionFailure.limit }
            let pending = VoiceRecognitionPending<Void>(); writing = pending
            defer { writing = nil }
            try await pending.run(seconds: 20) { try await raw.send(text) }; try check()
        } catch { close(); throw VoiceRecognitionWire.failure(error) }
    }
    func close() {
        guard !closed else { return }; closed = true
        opening?.cancel(); opening = nil; reading?.cancel(); reading = nil; writing?.cancel(); writing = nil
        raw?.close(); raw = nil; released()
    }
}
