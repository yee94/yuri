import Foundation
import CoreFoundation

enum VoiceRecognitionFailure: String, Error { case invalid, unavailable, permissionDenied, audio, limit, transport, settingsChanged }

/// Parsed outside UIKit so admission-before-side-effect is exercised by the same
/// production entrypoint in pure native tests. Old ASR starts have no fallback.
struct VoiceRecognitionRequest {
    let owner: String
    let revision: Int
    let provider: String?
    let expectedHost: RuntimeHostScope?
    init(_ input: Any?, start: Bool) throws {
        guard let object = input as? [String: Any], Set(object.keys) == (start ? ["owner", "revision", "provider", "expectedHost"] : ["owner", "revision"]),
              let owner = object["owner"] as? String, !owner.isEmpty, owner.utf8.count <= 128,
              let number = object["revision"] as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.isFinite, number.doubleValue > 0, number.doubleValue <= 9007199254740991, number.doubleValue.rounded() == number.doubleValue else { throw VoiceRecognitionFailure.invalid }
        let provider = object["provider"] as? String
        if start && !["local", "openai-compatible", "volcengine"].contains(provider ?? "") { throw VoiceRecognitionFailure.invalid }
        self.owner = owner; revision = number.intValue; self.provider = provider
        expectedHost = start ? try RuntimeHostScope(object["expectedHost"]) : nil
    }
}

struct VoiceRecognitionResponse {
    let status: Int
    let mime: String
    let data: Data
}
enum VoiceRecognitionMessage { case text(String), closed }
@MainActor struct VoiceRecognitionSocket {
    let receive: () async throws -> VoiceRecognitionMessage
    let send: (String) async throws -> Void
    let close: () -> Void
}
/// RuntimeBridge supplies captured, authenticated same-Host operations only. No endpoint,
/// provider key, audio or session ticket crosses the JavaScript boundary.
@MainActor struct VoiceRecognitionTransport {
    let settings: () async throws -> VoiceRecognitionResponse
    /// Exact POST /api/stt/transcribe, audio/wav, no configuration headers.
    let transcribe: (Data) async throws -> VoiceRecognitionResponse
    /// Exact /api/dictation/ws via existing native direct / authorized E2EE Relay.
    let open: () async throws -> VoiceRecognitionSocket
    let isCurrent: () -> Bool
}
@MainActor protocol VoiceRecognitionAudio: AnyObject {
    func permission() async -> Bool
    func start() throws
    /// Incremental 16 kHz mono signed PCM16LE. Stop flushes the file before the last read.
    func readPCM() async throws -> Data
    func stop() throws
    /// Idempotent: stop recording, deactivate its session and remove temporary audio.
    func cancel() throws
}

struct VoiceRecognitionSettings {
    let provider: String
    let authority: Data
    init(_ response: VoiceRecognitionResponse, expected: String) throws {
        guard (200..<300).contains(response.status), response.mime.lowercased().hasPrefix("application/json"),
              response.data.count <= 65536,
              let object = try JSONSerialization.jsonObject(with: response.data) as? [String: Any],
              let provider = object["sttProvider"] as? String,
              ["local", "openai-compatible", "volcengine"].contains(provider) else { throw VoiceRecognitionFailure.invalid }
        guard provider == expected else { throw VoiceRecognitionFailure.settingsChanged }
        if provider == "volcengine", object["configured"] as? Bool != true { throw VoiceRecognitionFailure.unavailable }
        if provider == "openai-compatible", (object["sttServerUrl"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty != false { throw VoiceRecognitionFailure.unavailable }
        self.provider = provider
        // Kept only in Swift. This detects saved non-secret ASR setting changes;
        // the existing Host API does not expose a secret/config revision token.
        let keys = ["sttProvider", "configured", "sttApiKeyConfigured", "sttServerUrl", "sttModel", "sttLocalModel", "sttLanguage", "asrResourceId", "asrContext"]
        var snapshot: [String: Any] = [:]
        for key in keys { snapshot[key] = object[key] ?? NSNull() }
        authority = try JSONSerialization.data(withJSONObject: snapshot, options: .sortedKeys)
    }
}

enum VoiceRecognitionPCM {
    static let sampleRate = 16000
    static let maximumSeconds: TimeInterval = 60
    static let maximumBytes = 16000 * 2 * 60
    static let chunkBytes = 6400
    static func wav(_ pcm: Data) throws -> Data {
        guard pcm.count % 2 == 0, pcm.count <= maximumBytes else { throw VoiceRecognitionFailure.limit }
        var data = Data("RIFF".utf8)
        func append(_ value: UInt32, bytes: Int = 4) { for i in 0..<bytes { data.append(UInt8((value >> (8 * i)) & 255)) } }
        append(UInt32(pcm.count + 36)); data.append(Data("WAVEfmt ".utf8)); append(16)
        append(1, bytes: 2); append(1, bytes: 2); append(16000); append(32000); append(2, bytes: 2); append(16, bytes: 2)
        data.append(Data("data".utf8)); append(UInt32(pcm.count)); data.append(pcm); return data
    }
    /// AVAudioRecorder may leave RIFF/data lengths unfinished while capturing. Chunk
    /// traversal still validates the actual fmt block and uses the bounded file length.
    static func payloadOffset(_ data: Data) throws -> Int? {
        guard data.count >= 12 else { return nil }
        guard String(data: data[0..<4], encoding: .ascii) == "RIFF", String(data: data[8..<12], encoding: .ascii) == "WAVE" else { throw VoiceRecognitionFailure.audio }
        func number(_ offset: Int, _ count: Int) -> Int { (0..<count).reduce(0) { $0 | Int(data[offset + $1]) << (8 * $1) } }
        var offset = 12, validFormat = false
        while offset + 8 <= data.count {
            let kind = String(data: data[offset..<offset + 4], encoding: .ascii), size = number(offset + 4, 4)
            if kind == "data" { guard validFormat else { throw VoiceRecognitionFailure.audio }; return offset + 8 }
            guard size <= 65536 else { throw VoiceRecognitionFailure.audio }
            guard offset + 8 + size <= data.count else { return nil }
            if kind == "fmt " {
                guard size >= 16, number(offset + 8, 2) == 1, number(offset + 10, 2) == 1,
                      number(offset + 12, 4) == sampleRate, number(offset + 20, 2) == 2, number(offset + 22, 2) == 16 else { throw VoiceRecognitionFailure.audio }
                validFormat = true
            }
            offset += 8 + size + size % 2
        }
        return nil
    }
    static func transcript(_ response: VoiceRecognitionResponse) throws -> String {
        guard (200..<300).contains(response.status), response.mime.lowercased().hasPrefix("application/json"), response.data.count <= 131072,
              let object = try JSONSerialization.jsonObject(with: response.data) as? [String: Any], let text = object["transcript"] as? String,
              text.utf8.count <= 65536 else { throw VoiceRecognitionFailure.transport }
        return text
    }
}

@MainActor private final class VoiceRecognitionStream {
    let socket: VoiceRecognitionSocket
    let id = UUID().uuidString
    var reader: Task<Void, Never>?
    var ready = false, started = false, closed = false, finishing = false
    var failure: Error?, text: String?
    var finishDeadline: TimeInterval?
    var sequence = 0
    let current: () -> Bool
    let partial: (String) -> Void
    init(socket: VoiceRecognitionSocket, current: @escaping () -> Bool, partial: @escaping (String) -> Void) {
        self.socket = socket; self.current = current; self.partial = partial
        reader = Task { [weak self] in await self?.read() }
    }
    func start() async throws {
        try await wait(seconds: 10) { self.ready }
        try await send(["type": "start", "dictationId": id, "format": "audio/pcm;rate=16000;bits=16;channels=1"])
        try await wait(seconds: 15) { self.started }
    }
    func append(_ data: Data) async throws {
        for offset in stride(from: 0, to: data.count, by: VoiceRecognitionPCM.chunkBytes) {
            let chunk = data.subdata(in: offset..<min(offset + VoiceRecognitionPCM.chunkBytes, data.count))
            let seq = sequence; sequence += 1
            try await send(["type": "chunk", "dictationId": id, "seq": seq, "audio": chunk.base64EncodedString()])
        }
    }
    func finish() async throws -> String {
        finishing = true
        finishDeadline = ProcessInfo.processInfo.systemUptime + 30
        try await send(["type": "finish", "dictationId": id, "finalSeq": sequence - 1])
        while text == nil {
            try check()
            guard ProcessInfo.processInfo.systemUptime < (finishDeadline ?? 0) else { throw VoiceRecognitionFailure.transport }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        try check()
        return text!
    }
    func cancel() { guard !closed else { return }; closed = true; reader?.cancel(); reader = nil; socket.close() }
    private func send(_ object: [String: Any]) async throws {
        try check()
        guard let text = String(data: try JSONSerialization.data(withJSONObject: object), encoding: .utf8) else { throw VoiceRecognitionFailure.invalid }
        try await socket.send(text); try check()
    }
    private func check() throws { try Task.checkCancellation(); guard !closed, current() else { throw CancellationError() }; if let failure { throw failure } }
    private func wait(seconds: TimeInterval, until: () -> Bool) async throws {
        let deadline = ProcessInfo.processInfo.systemUptime + seconds
        while true { try check(); if until() { return }; guard ProcessInfo.processInfo.systemUptime < deadline else { throw VoiceRecognitionFailure.transport }; try await Task.sleep(nanoseconds: 10_000_000) }
    }
    private func read() async {
        do {
            while !closed {
                let message = try await socket.receive(); try check()
                guard case .text(let raw) = message, raw.utf8.count <= 131072,
                      let data = raw.data(using: .utf8), let value = try JSONSerialization.jsonObject(with: data) as? [String: Any], let type = value["type"] as? String else { throw VoiceRecognitionFailure.transport }
                if type == "ready" { guard !ready else { throw VoiceRecognitionFailure.transport }; ready = true; continue }
                guard value["dictationId"] as? String == id else { throw VoiceRecognitionFailure.transport }
                switch type {
                case "ack":
                    guard let seq = value["ackSeq"] as? Int, seq >= -1, seq < sequence || seq == -1 else { throw VoiceRecognitionFailure.transport }
                    if seq == -1 { started = true }
                case "partial", "final":
                    guard started, type != "final" || finishing, let text = value["text"] as? String, text.utf8.count <= 65536 else { throw VoiceRecognitionFailure.transport }
                    if type == "final" { self.text = text; return }; partial(text)
                case "finish_accepted":
                    guard finishing, let timeout = value["timeoutMs"] as? NSNumber, CFGetTypeID(timeout) != CFBooleanGetTypeID(),
                          timeout.doubleValue.isFinite, (1...300000).contains(timeout.doubleValue) else { throw VoiceRecognitionFailure.transport }
                    // Same bounded adaptive budget as Host stream-manager, with a
                    // small transport margin. Do not shorten valid local ASR work.
                    finishDeadline = ProcessInfo.processInfo.systemUptime + timeout.doubleValue / 1000 + 5
                default: throw VoiceRecognitionFailure.transport
                }
            }
        } catch { if !closed { failure = error } }
    }
}

/// The Foundation-only owner is also the production state machine used by fake-audio
/// tests. A cancelled start cannot acquire audio, and failed finish retains bounded
/// PCM for an explicit retry with the same captured provider, never a new microphone.
@MainActor final class VoiceRecognitionCore {
    private final class Lease {
        let owner: String, revision: Int, expected: String
        let transport: VoiceRecognitionTransport, audio: VoiceRecognitionAudio
        var settings: VoiceRecognitionSettings?, stream: VoiceRecognitionStream?
        var pcm = Data(), recording = false, cancelled = false
        var failure: Error?, result: String?, pumping: Task<Void, Never>?, watchdog: Task<Void, Never>?
        var recordingDeadline: TimeInterval?
        var processing: Task<String, Error>?, starting: Task<Void, Error>?
        init(owner: String, revision: Int, expected: String, transport: VoiceRecognitionTransport, audio: VoiceRecognitionAudio) {
            self.owner = owner; self.revision = revision; self.expected = expected; self.transport = transport; self.audio = audio
        }
    }
    private let capture: (RuntimeHostScope) throws -> VoiceRecognitionTransport
    private let beforeCapture: () -> Void
    private let makeAudio: () -> VoiceRecognitionAudio
    private let foreground: () -> Bool
    private let now: () -> TimeInterval
    private let partial: (String, Int, String) -> Void
    private let invalidated: (String, Int) -> Void
    private var lease: Lease?
    init(capture: @escaping (RuntimeHostScope) throws -> VoiceRecognitionTransport, audio: @escaping () -> VoiceRecognitionAudio, beforeCapture: @escaping () -> Void = {},
         foreground: @escaping () -> Bool, partial: @escaping (String, Int, String) -> Void = { _, _, _ in }, invalidated: @escaping (String, Int) -> Void = { _, _ in }, now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) {
        self.capture = capture; makeAudio = audio; self.beforeCapture = beforeCapture; self.foreground = foreground; self.partial = partial; self.invalidated = invalidated; self.now = now
    }
    func start(_ input: Any?) async throws -> [String: Any] {
        try Task.checkCancellation()
        let request = try VoiceRecognitionRequest(input, start: true)
        return try await start(owner: request.owner, revision: request.revision, provider: request.provider!, expectedHost: request.expectedHost!)
    }
    func start(owner: String, revision: Int, provider: String, expectedHost: RuntimeHostScope) async throws -> [String: Any] {
        try Task.checkCancellation()
        guard !owner.isEmpty, owner.utf8.count <= 128, revision > 0, ["local", "openai-compatible", "volcengine"].contains(provider), foreground() else { throw VoiceRecognitionFailure.invalid }
        // A page must cancel its exact prior lease before opening another one.
        guard lease == nil else { throw VoiceRecognitionFailure.unavailable }
        // capture performs native synchronous Host admission. It must precede TTS
        // stop, the recorder factory, settings GET, OS permission and audio start.
        let transport = try capture(expectedHost)
        try Task.checkCancellation()
        guard transport.isCurrent() else { throw CancellationError() }
        beforeCapture()
        try Task.checkCancellation()
        guard transport.isCurrent() else { throw CancellationError() }
        let value = Lease(owner: owner, revision: revision, expected: provider, transport: transport, audio: makeAudio()); lease = value
        value.watchdog = Task { [weak self, weak value] in
            guard let self, let value else { return }
            while !Task.isCancelled {
                do { try await Task.sleep(nanoseconds: 200_000_000) } catch { return }
                guard self.lease === value else { return }
                let instant = self.now()
                if !self.current(value) || value.recordingDeadline.map({ instant >= $0 && value.recording }) == true { self.invalidate(); return }
            }
        }
        let work = Task { try await self.prepare(value) }; value.starting = work
        do {
            try await withTaskCancellationHandler(operation: { try await work.value }, onCancel: {
                // Mark the child cancelled synchronously, before its next actor
                // continuation can proceed past settings/permission to audio.
                work.cancel()
                Task { @MainActor [weak self, weak value] in
                    guard let self, let value, self.lease === value else { return }
                    try? self.cancel(owner: value.owner, revision: value.revision)
                }
            })
            try check(value); value.starting = nil; return ["provider": provider, "owner": owner, "revision": revision]
        }
        catch { if lease === value { try cancel(owner: owner, revision: revision) }; throw error }
    }
    private func prepare(_ value: Lease) async throws {
        try check(value)
        let settings = try VoiceRecognitionSettings(try await value.transport.settings(), expected: value.expected)
        try check(value); value.settings = settings
        guard await value.audio.permission() else { throw VoiceRecognitionFailure.permissionDenied }; try check(value)
        if settings.provider != "openai-compatible" { value.stream = try await openStream(value) }
        try check(value); try value.audio.start(); value.recording = true
        let deadline = now() + VoiceRecognitionPCM.maximumSeconds
        value.recordingDeadline = deadline
        value.pumping = Task { [weak self, weak value] in
            guard let self, let value else { return }
            do {
                while value.recording {
                    try await Task.sleep(nanoseconds: 200_000_000); try self.check(value)
                    guard value.recording else { return }
                    if self.now() >= deadline { throw VoiceRecognitionFailure.limit }
                    let bytes = try await value.audio.readPCM(); try self.check(value)
                    try self.append(bytes, value)
                    if let stream = value.stream {
                        do { try await stream.append(bytes) }
                        catch { stream.cancel(); value.stream = nil }
                    }
                }
            } catch { if self.lease === value && !value.cancelled && value.recording { self.invalidate() } }
        }
    }
    func finish(owner: String, revision: Int) async throws -> String {
        let value = try owned(owner, revision)
        guard current(value), !Task.isCancelled else { try cancel(owner: owner, revision: revision); throw CancellationError() }
        guard value.starting == nil else { throw VoiceRecognitionFailure.unavailable }
        if let result = value.result { return result }
        if let work = value.processing { return try await work.value }
        let work = Task { try await self.process(value) }; value.processing = work
        defer { value.processing = nil }
        return try await work.value
    }
    private func process(_ value: Lease) async throws -> String {
        if value.recording {
            value.recording = false
            // Stop the microphone synchronously, before waiting for a slow socket.
            // Join the sole incremental reader before reading the flushed tail.
            try value.audio.stop()
            await value.pumping?.value; value.pumping = nil; try check(value)
            let tail = try await value.audio.readPCM(); try check(value); try append(tail, value)
            if let stream = value.stream {
                do { try await stream.append(tail) } catch { stream.cancel(); value.stream = nil }
            }
        }
        if let failure = value.failure { throw failure }
        // Re-read before billing/replay. This Host API has no settings revision/CAS;
        // never substitute a draft or silently accept a changed provider.
        let saved = try VoiceRecognitionSettings(try await value.transport.settings(), expected: value.expected); try check(value)
        guard saved.authority == value.settings?.authority else { throw VoiceRecognitionFailure.settingsChanged }
        let text: String
        if value.expected == "openai-compatible" {
            text = try VoiceRecognitionPCM.transcript(try await value.transport.transcribe(VoiceRecognitionPCM.wav(value.pcm)))
        } else {
            if value.stream == nil {
                let stream = try await openStream(value); value.stream = stream
                do { try await stream.append(value.pcm) } catch { stream.cancel(); value.stream = nil; throw error }
            }
            guard let stream = value.stream else { throw VoiceRecognitionFailure.transport }
            do { text = try await stream.finish(); stream.cancel(); value.stream = nil }
            catch { stream.cancel(); value.stream = nil; throw error }
        }
        try check(value); value.result = text; value.pcm.removeAll(); try value.audio.cancel(); return text
    }
    private func openStream(_ value: Lease) async throws -> VoiceRecognitionStream {
        let socket = try await value.transport.open()
        do { try check(value) } catch { socket.close(); throw error }
        let stream = VoiceRecognitionStream(socket: socket, current: { [weak self, weak value] in
            guard let self, let value else { return false }; return self.current(value)
        }, partial: { [weak self, weak value] text in
            guard let self, let value, self.current(value) else { return }; self.partial(value.owner, value.revision, text)
        })
        // Install before suspension so cancellation closes an in-flight start too.
        value.stream = stream
        do { try await stream.start(); try check(value); return stream } catch { stream.cancel(); if value.stream === stream { value.stream = nil }; throw error }
    }
    private func append(_ data: Data, _ value: Lease) throws {
        guard data.count % 2 == 0, data.count <= VoiceRecognitionPCM.maximumBytes - value.pcm.count else { value.failure = VoiceRecognitionFailure.limit; throw VoiceRecognitionFailure.limit }
        value.pcm.append(data)
    }
    private func owned(_ owner: String, _ revision: Int) throws -> Lease {
        guard let value = lease, value.owner == owner, value.revision == revision else { throw CancellationError() }; return value
    }
    private func current(_ value: Lease) -> Bool { lease === value && !value.cancelled && value.transport.isCurrent() && foreground() }
    private func check(_ value: Lease) throws { try Task.checkCancellation(); guard current(value) else { throw CancellationError() } }
    func cancel(owner: String, revision: Int) throws {
        guard let value = lease, value.owner == owner, value.revision == revision else { return }
        value.cancelled = true; value.recording = false
        value.starting?.cancel(); value.starting = nil; value.processing?.cancel(); value.processing = nil
        value.watchdog?.cancel(); value.watchdog = nil
        value.pumping?.cancel(); value.pumping = nil; value.stream?.cancel(); value.stream = nil; value.pcm.removeAll()
        // Failed deletion/deactivation retains the exact cancelled lease, so UI
        // cleanup retries it and cannot acquire a second microphone owner.
        try value.audio.cancel(); if lease === value { lease = nil }
    }
    func invalidate() { if let value = lease { try? cancel(owner: value.owner, revision: value.revision); invalidated(value.owner, value.revision) } }
}
