import Foundation

/// Authentication and native admission remain in RuntimeBridge. Main supplies
/// the actual assets/theme/labels/storage; no fake bootstrap enters this capture.
@MainActor struct GuiPluginRuntimeCapture {
    let expectedHost: RuntimeHostScope
    let resource: ResourceWebPreviewTransport
    let isCurrent: () -> Bool
    let readGui: (RuntimeHostScope, GuiPluginPreviewRequest, Int) async throws -> GuiPluginPreviewResponse
    let openGui: (RuntimeHostScope, GuiPluginPreviewRequest) async throws -> GuiPluginPreviewByteStream
    var isHostResourceURL: ((URL) -> Bool)? = nil
}

struct GuiPluginRuntimeHead {
    let status: Int
    let mime: String
    let headers: [String: String]
    init(status: Int, headers: [String: String]) throws {
        guard (200...599).contains(status), !(300..<400).contains(status) else { throw GuiPluginPreviewFailure.response }
        var metadata: [String: String] = [:]
        var mime: String?
        for (key, value) in headers {
            let name = key.lowercased()
            if name == "content-type" { guard mime == nil else { throw GuiPluginPreviewFailure.response }; mime = value }
            if ["x-yuri-file-exists", "x-yuri-gui-revision", "x-yuri-gui-code"].contains(name) {
                guard metadata[name] == nil else { throw GuiPluginPreviewFailure.response }; metadata[name] = value
            }
        }
        let contentType = mime ?? ""
        guard !contentType.contains("\r"), !contentType.contains("\n"), !contentType.contains("\0") else { throw GuiPluginPreviewFailure.response }
        self.status = status; self.mime = contentType
        self.headers = try GuiPluginPreviewResponseHeaders.checked(metadata)
    }
}

/// Relay callbacks await consumption of one wire chunk. The producer never
/// appends the whole response and cancel wakes both pending sides immediately.
actor GuiPluginRelayBody {
    private var head: GuiPluginRuntimeHead?
    private var headWait: CheckedContinuation<GuiPluginRuntimeHead, Error>?
    private var readWait: (Int, CheckedContinuation<Data?, Error>)?
    private var producerWait: CheckedContinuation<Void, Error>?
    private var bytes: Data?
    private var offset = 0
    private var ended = false
    private var failure: Error?
    func response(_ status: Int, _ headers: [String: String]) throws {
        guard !ended, head == nil else { throw CancellationError() }
        let value = try GuiPluginRuntimeHead(status: status, headers: headers)
        head = value; let wait = headWait; headWait = nil; wait?.resume(returning: value)
    }
    func waitHead() async throws -> GuiPluginRuntimeHead {
        if let failure { throw failure }; if let head { return head }
        guard !ended, headWait == nil else { throw GuiPluginPreviewFailure.response }
        return try await withCheckedThrowingContinuation { headWait = $0 }
    }
    func receive(_ value: Data) async throws {
        try Task.checkCancellation()
        guard !ended, head != nil, bytes == nil, producerWait == nil else { throw CancellationError() }
        if value.isEmpty { return }
        // Relay's own frame bound is unchanged. A response frame is retained once,
        // and each consumer reply is still at most 64 KiB.
        bytes = value; offset = 0
        try await withCheckedThrowingContinuation { producerWait = $0; drain() }
    }
    func read(_ limit: Int) async throws -> Data? {
        try Task.checkCancellation()
        guard (1...65536).contains(limit), readWait == nil else { throw GuiPluginPreviewFailure.invalid }
        if bytes == nil {
            if let failure { throw failure }
            if ended { return nil }
        }
        return try await withCheckedThrowingContinuation { readWait = (limit, $0); drain() }
    }
    private func drain() {
        guard let (limit, read) = readWait, let bytes else { return }
        let end = min(bytes.count, offset + limit), result = bytes.subdata(in: offset..<end)
        offset = end; readWait = nil
        if offset == bytes.count {
            self.bytes = nil; offset = 0; let producer = producerWait; producerWait = nil; producer?.resume()
        }
        read.resume(returning: result)
    }
    func finish(_ error: Error? = nil) {
        guard !ended else { return }; ended = true; failure = error
        let opening = headWait; headWait = nil
        if head == nil { opening?.resume(throwing: error ?? GuiPluginPreviewFailure.response) }
        if let error {
            let producer = producerWait; producerWait = nil; producer?.resume(throwing: error)
        }
        if bytes == nil { let read = readWait; readWait = nil; if let error { read?.1.resume(throwing: error) } else { read?.1.resume(returning: nil) } }
        else { drain() }
    }
    /// Explicit ownership revocation discards bytes even after a transport error.
    /// A terminal upstream error uses finish instead and must drain arrived data.
    func cancel() {
        ended = true; failure = CancellationError(); bytes = nil; offset = 0
        let opening = headWait; headWait = nil; opening?.resume(throwing: CancellationError())
        let producer = producerWait; producerWait = nil; producer?.resume(throwing: CancellationError())
        let read = readWait; readWait = nil; read?.1.resume(throwing: CancellationError())
    }
}

/// Owns the existing session's pull iterator off MainActor. There is one bounded
/// output chunk and no app-side callback queue, whole-body Data or base64.
actor GuiPluginDirectBody<Source: AsyncIteratorProtocol> where Source.Element == UInt8 {
    private var iterator: Source?
    private var reading = false
    private var closed = false
    private var terminalError: Error?
    init(_ iterator: Source) { self.iterator = iterator }
    func cancel() { closed = true; iterator = nil }
    func read(_ limit: Int) async throws -> Data? {
        try Task.checkCancellation()
        guard !closed else { throw CancellationError() }
        if let terminalError { throw terminalError }
        guard !reading, (1...65536).contains(limit), var source = iterator else { throw GuiPluginPreviewFailure.busy }
        reading = true; iterator = nil
        defer { reading = false }
        var chunk = Data(); chunk.reserveCapacity(limit)
        do {
            while chunk.count < limit, let byte = try await source.next() { chunk.append(byte) }
            try Task.checkCancellation()
            guard !closed else { throw CancellationError() }
            iterator = source
            return chunk.isEmpty ? nil : chunk
        } catch {
            if closed || Task.isCancelled {
                closed = true; throw CancellationError()
            }
            terminalError = error
            // Never turn bytes already collected by this read into a false EOF
            // or lose them when the following source.next() reports an error.
            if !chunk.isEmpty { return chunk }
            throw error
        }
    }
}

/// Buffering remains an explicit legacy read contract, isolated from MainActor.
actor GuiPluginRuntimeBuffer {
    private let limit: Int
    private var bytes = Data()
    init(_ limit: Int) { self.limit = limit }
    func append(_ chunk: Data) throws {
        guard chunk.count <= limit - bytes.count else { throw GuiPluginPreviewFailure.limit }; bytes.append(chunk)
    }
    func value() -> Data { bytes }
}
