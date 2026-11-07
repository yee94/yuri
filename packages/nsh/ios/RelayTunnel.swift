import Foundation
import CryptoKit

private final class RelayRedirectPolicy: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

/// Shared bounded native WS mailbox. No UI, credential, URL or reconnect ownership.
actor NativeSocketInbox {
    enum Message { case text(String), binary(Data), closed(Int) }
    private var opened = false
    private var failure: Error?
    private var closeCode: Int?
    private var opening: CheckedContinuation<Void, Error>?
    private var waiting: CheckedContinuation<Message, Error>?
    private var messages: [Message] = []
    private var bytes = 0
    private var fragments: [UInt8: Data] = [:]
    private let maxMessageBytes: Int

    init(maxMessageBytes: Int = 512 * 1024) {
        precondition(maxMessageBytes > 0 && maxMessageBytes <= 1024 * 1024)
        self.maxMessageBytes = maxMessageBytes
    }

    func waitUntilOpen() async throws {
        if let failure { throw failure }
        if closeCode != nil { throw RelayTunnel.Failure.disconnected }
        if opened { return }
        guard opening == nil else { throw RelayTunnel.Failure.invalidRequest }
        try await withCheckedThrowingContinuation { opening = $0 }
    }
    func didOpen() throws {
        guard !opened, failure == nil, closeCode == nil else { throw RelayTunnel.Failure.invalidFrame }
        opened = true; opening?.resume(); opening = nil
    }
    func receive() async throws -> Message {
        if let failure { throw failure }
        if let closeCode { return .closed(closeCode) }
        guard opened, waiting == nil else { throw RelayTunnel.Failure.invalidRequest }
        if !messages.isEmpty {
            let message = messages.removeFirst(); bytes -= Self.size(message); return message
        }
        return try await withCheckedThrowingContinuation { waiting = $0 }
    }
    func consume(type: UInt8, payload: Data, more: Bool = false) throws {
        guard opened, failure == nil, closeCode == nil, type == 8 || type == 9 else { throw RelayTunnel.Failure.invalidFrame }
        let previous = fragments[type]?.count ?? 0
        guard payload.count <= maxMessageBytes - previous else { throw RelayTunnel.Failure.limit }
        // A peer may fragment text and binary independently; the combined bound also
        // includes complete messages, so a stalled consumer cannot grow the tunnel.
        guard bytes + fragments.values.reduce(0, { $0 + $1.count }) + payload.count <= 1024 * 1024 else { throw RelayTunnel.Failure.limit }
        var data = fragments.removeValue(forKey: type) ?? Data()
        data.append(payload)
        if more { fragments[type] = data; return }
        let message: Message
        if type == 8 {
            guard let text = String(data: data, encoding: .utf8) else { throw RelayTunnel.Failure.invalidFrame }
            message = .text(text)
        } else { message = .binary(data) }
        if let reply = waiting { waiting = nil; reply.resume(returning: message); return }
        guard messages.count < 2 else { throw RelayTunnel.Failure.limit }
        messages.append(message); bytes += data.count
    }
    func end(code: Int) {
        guard failure == nil, closeCode == nil else { return }
        closeCode = code; clear()
        opening?.resume(throwing: RelayTunnel.Failure.webSocketClosed(code)); opening = nil
        waiting?.resume(returning: .closed(code)); waiting = nil
    }
    func fail(_ error: Error) {
        guard failure == nil, closeCode == nil else { return }
        failure = error; clear()
        opening?.resume(throwing: error); opening = nil
        waiting?.resume(throwing: error); waiting = nil
    }
    private func clear() { messages.removeAll(); fragments.removeAll(); bytes = 0 }
    private static func size(_ value: Message) -> Int {
        switch value { case .text(let text): return text.utf8.count; case .binary(let data): return data.count; case .closed: return 0 }
    }
}

/// Native relay-v1 HTTP/SSE/WS transport. One instance owns one multiplexed connection.
/// Pass a pairing-pinned host key, and supply the client's bearer in request headers.
/// Cancelling the calling Task aborts only its stream. Call close() on runtime switches.
/// Broken connections fail all streams; the next call reconnects with fresh keys. Mutations
/// are never replayed. SSE reconnection/backoff and UTF-8/event parsing belong to the caller.
actor RelayTunnel {
    typealias Response = (status: Int, headers: [String: String], body: Data)
    typealias OnResponse = @Sendable (Int, [String: String]) async throws -> Void
    typealias OnData = @Sendable (Data) async throws -> Void

    enum Failure: LocalizedError {
        case invalidConfiguration, invalidRequest, invalidFrame, authentication, closed
        case timeout, limit, disconnected, hostAborted
        case webSocketRejected(Int), webSocketClosed(Int)

        var errorDescription: String? {
            switch self {
            case .invalidConfiguration: return "无效的 Relay 地址或 Host 公钥"
            case .invalidRequest: return "无效的 Relay 请求"
            case .invalidFrame: return "Relay 协议或加密验证失败"
            case .authentication: return "Relay 拒绝认证，请重新配对"
            case .closed: return "Relay 连接已关闭"
            case .timeout: return "Relay 请求或连接超时"
            case .limit: return "Relay 请求超过并发或内存限制"
            case .disconnected: return "Relay 连接中断"
            case .hostAborted: return "Host 已中止 Relay 请求"
            case .webSocketRejected, .webSocketClosed: return "Host 拒绝或关闭了 WebSocket"
            }
        }
    }

    private static let maxPlaintext = 65_536
    // protocol.ts reserves 5 bytes for the mux header and 5 for a batch envelope,
    // even for legacy peers. HTTP bodies are independent chunks, never WS fragments.
    private static let maxPayload = 65_526
    private static let maxBody = 32 * 1024 * 1024
    private static let totalBodyBudget = 64 * 1024 * 1024
    private static let queueBudget = 2 * 1024 * 1024
    private static let maxStreams = 32

    private final class Pending {
        let token: UUID
        let inputBytes: Int
        let continuation: CheckedContinuation<Response, Error>
        let onResponse: OnResponse?
        let onData: OnData?
        let requestHead: Data
        var requestBody: Data?
        var streamID: UInt32?
        var head: (Int, [String: String])?
        var body = Data()
        var timer: Task<Void, Never>?
        var upload: Task<Void, Never>?

        init(token: UUID, requestHead: Data, requestBody: Data?, continuation: CheckedContinuation<Response, Error>,
             onResponse: OnResponse?, onData: OnData?) {
            self.token = token
            self.inputBytes = requestBody?.count ?? 0
            self.requestHead = requestHead
            self.requestBody = requestBody
            self.continuation = continuation
            self.onResponse = onResponse
            self.onData = onData
        }
    }

    private final class Write {
        let id = UUID()
        let streamID: UInt32
        let frame: Data
        private var continuation: CheckedContinuation<Void, Error>?
        init(streamID: UInt32, frame: Data, continuation: CheckedContinuation<Void, Error>) {
            self.streamID = streamID; self.frame = frame; self.continuation = continuation
        }
        func finish(_ result: Result<Void, Error>) {
            let reply = continuation; continuation = nil; reply?.resume(with: result)
        }
    }

    private let endpoint: URL
    private let hostKey: P256.KeyAgreement.PublicKey
    private let session: URLSession
    private var socket: URLSessionWebSocketTask?
    private var crypto: RelayChannelCrypto?
    private var connection: Task<Void, Never>?
    private var receiver: Task<Void, Never>?
    private var keepalive: Task<Void, Never>?
    private var generation: UInt64 = 0
    private var ready = false
    private var closed = false
    private var terminalError: Error?
    private var nextStream: UInt64 = 1
    private var pending: [UUID: Pending] = [:]
    private var streams: [UInt32: UUID] = [:]
    private var webSockets: [UInt32: NativeSocketInbox] = [:]
    private var sendingWebSockets = Set<UInt32>()
    private var inputBytes = 0
    private var responseBytes = 0
    private var writes: [Write] = []
    private var writing: Write?
    private var queuedBytes = 0
    private var writerRunning = false
    private var lastReceived = ProcessInfo.processInfo.systemUptime
    private var lastSent = ProcessInfo.processInfo.systemUptime
    private var probeStarted: TimeInterval?

    /// relayUrl must be ws(s) with no userinfo/query/fragment. Only public routing
    /// metadata (v, role, serverId) is placed in the URL; no client credential is accepted.
    init(relayUrl: String, serverId: String, hostEncPubJwk: [String: String]) throws {
        guard var components = URLComponents(string: relayUrl),
              ["ws", "wss"].contains(components.scheme?.lowercased() ?? ""),
              components.host != nil, components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil,
              !serverId.isEmpty, serverId.utf8.count <= 256,
              serverId.utf8.allSatisfy({ (65...90).contains($0) || (97...122).contains($0)
                  || (48...57).contains($0) || $0 == 45 || $0 == 95 }) else {
            throw Failure.invalidConfiguration
        }
        hostKey = try RelayChannelCrypto.importKey(hostEncPubJwk)
        components.queryItems = [URLQueryItem(name: "v", value: "1"),
                                 URLQueryItem(name: "role", value: "client"),
                                 URLQueryItem(name: "serverId", value: serverId)]
        guard let url = components.url else { throw Failure.invalidConfiguration }
        endpoint = url
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 7 * 24 * 3600
        // The relay is an untrusted carrier. There is no HTTP bearer on this socket,
        // and all application bytes remain encrypted to the pinned Host key.
        session = URLSession(configuration: configuration, delegate: RelayRedirectPolicy(), delegateQueue: nil)
    }

    func request(path: String, method: String = "GET", headers: [String: String] = [:],
                 body: Data? = nil, timeout: TimeInterval = 60) async throws -> Response {
        try await perform(path: path, method: method, headers: headers, body: body,
                          timeout: timeout, onResponse: nil, onData: nil)
    }

    struct WebSocket {
        let receive: () async throws -> NativeSocketInbox.Message
        let send: (String) async throws -> Void
        let sendBinary: (Data) async throws -> Void
        let close: () async -> Void
    }

    static func allowsWebSocketPath(_ path: String) -> Bool {
        path == "/api/remote-desktop/ws" || path == "/api/dictation/ws" || path == "/api/terminal/ws"
    }

    /// Only the paired desktop, dictation and terminal endpoints are exposed. The Host independently checks
    /// the current Relay pairing grant using this freshly minted scoped token.
    func openWebSocket(path: String, urlToken: String, timeout: TimeInterval = 20) async throws -> WebSocket {
        try Task.checkCancellation()
        guard !closed else { throw Failure.closed }
        if let terminalError { throw terminalError }
        guard Self.allowsWebSocketPath(path), !urlToken.isEmpty, urlToken.utf8.count <= 8192,
              urlToken.utf8.allSatisfy({ $0 > 32 && $0 < 127 }),
              timeout.isFinite, timeout > 0, timeout <= 60 else { throw Failure.invalidRequest }
        guard webSockets.count < 4, pending.count + webSockets.count < Self.maxStreams,
              nextStream <= UInt64(UInt32.max) else { throw Failure.limit }
        let id = UInt32(nextStream); nextStream += 2
        let inbox = NativeSocketInbox(maxMessageBytes: path == "/api/terminal/ws" ? 1024 * 1024 : 512 * 1024); webSockets[id] = inbox
        var query = URLComponents(); query.queryItems = [URLQueryItem(name: "yuri_url_token", value: urlToken)]
        let head = try JSONSerialization.data(withJSONObject: ["path": path, "query": query.percentEncodedQuery ?? ""])
        let timer = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000)) } catch { return }
            await self?.closeWebSocket(id, error: Failure.timeout)
        }
        let launch = Task { [weak self] in await self?.startWebSocket(id, head: head) }
        defer { timer.cancel(); launch.cancel() }
        do {
            try await withTaskCancellationHandler(operation: {
                try Task.checkCancellation(); try await inbox.waitUntilOpen(); try Task.checkCancellation()
            }, onCancel: { Task { await self.closeWebSocket(id, error: CancellationError()) } })
            guard webSockets[id] === inbox, ready else { throw Failure.disconnected }
            return WebSocket(receive: {
                try await withTaskCancellationHandler(operation: {
                    try Task.checkCancellation()
                    let message = try await inbox.receive()
                    try Task.checkCancellation(); return message
                }, onCancel: { Task { await self.closeWebSocket(id, error: CancellationError()) } })
            }, send: { text in
                let limit = path == "/api/terminal/ws" ? 1024 * 1024 : 96 * 1024
                guard text.utf8.count <= limit else { throw Failure.limit }
                try await self.sendWebSocket(id, inbox: inbox, bytes: Data(text.utf8), type: 8)
            }, sendBinary: { bytes in
                guard path == "/api/terminal/ws" else { throw Failure.invalidRequest }
                guard bytes.count <= 1024 * 1024 else { throw Failure.limit }
                try await self.sendWebSocket(id, inbox: inbox, bytes: bytes, type: 9)
            },
            close: { await self.closeWebSocket(id, error: CancellationError()) })
        } catch {
            // A failed old attempt must never close a reused ID on a fresh channel.
            if webSockets[id] === inbox { await closeWebSocket(id, error: error) }
            throw error
        }
    }

    private func startWebSocket(_ id: UInt32, head: Data) async {
        do {
            if !ready {
                if connection == nil {
                    generation += 1
                    let current = generation
                    connection = Task {
                        do { try await self.establish(generation: current) }
                        catch { self.failConnection(error, generation: current) }
                    }
                }
                await connection?.value
            }
            guard webSockets[id] != nil else { return }
            try await send(type: 6, streamID: id, payload: head)
        } catch { await closeWebSocket(id, error: error) }
    }

    private func sendWebSocket(_ id: UInt32, inbox: NativeSocketInbox, bytes: Data, type: UInt8) async throws {
        try Task.checkCancellation()
        guard webSockets[id] === inbox else { throw Failure.closed }
        guard bytes.count <= 1024 * 1024 else { throw Failure.limit }
        guard sendingWebSockets.insert(id).inserted else { throw Failure.limit }
        defer { sendingWebSockets.remove(id) }
        let deadline = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 20_000_000_000) } catch { return }
            await self?.closeWebSocket(id, error: Failure.timeout)
        }
        defer { deadline.cancel() }
        do {
            try await withTaskCancellationHandler(operation: {
                var offset = 0
                repeat {
                    try Task.checkCancellation()
                    guard webSockets[id] === inbox else { throw Failure.closed }
                    let end = min(offset + Self.maxPayload, bytes.count)
                    try await send(type: end < bytes.count ? type | 0x80 : type, streamID: id, payload: bytes.subdata(in: offset..<end))
                    offset = end
                } while offset < bytes.count
                try Task.checkCancellation()
                guard webSockets[id] === inbox else { throw Failure.closed }
            }, onCancel: { Task { await self.closeWebSocket(id, error: CancellationError()) } })
        } catch { await closeWebSocket(id, error: error); throw error }
    }

    private func closeWebSocket(_ id: UInt32, error: Error) async {
        guard let inbox = webSockets.removeValue(forKey: id) else { return }
        await inbox.fail(error)
        let removed = writes.filter { $0.streamID == id }
        writes.removeAll { $0.streamID == id }
        for entry in removed { queuedBytes -= entry.frame.count; entry.finish(.failure(error)) }
        // Bytes already handed to URLSession cannot be unsent. Settle the caller
        // immediately, retain the serialized wire owner, then queue EOF after it.
        if let writing, writing.streamID == id { writing.finish(.failure(error)) }
        guard ready else { return }
        let current = generation
        Task {
            guard current == self.generation, self.ready else { return }
            do { try await self.send(type: 10, streamID: id, payload: Data("{\"code\":1000,\"reason\":\"\"}".utf8)) }
            catch { self.failConnection(error, generation: current) }
        }
    }

    /// Returns when StreamEnd arrives. onResponse runs before any onData, so the
    /// caller can reject HTTP errors/non-SSE content before consuming bytes. Callbacks
    /// are awaited in wire order, with backpressure and no unbounded callback queue.
    /// Keep callbacks short; bytes are arbitrary chunks, not UTF-8 lines or SSE events.
    /// The returned body is empty. timeout bounds the entire stream lifetime.
    func stream(path: String, method: String = "GET", headers: [String: String] = [:],
                body: Data? = nil, timeout: TimeInterval = 3600,
                onResponse: OnResponse? = nil, onData: @escaping OnData) async throws -> Response {
        var streamHeaders = headers
        if !headers.keys.contains(where: { $0.lowercased() == "accept" }) {
            streamHeaders["Accept"] = "text/event-stream"
        }
        return try await perform(path: path, method: method, headers: streamHeaders, body: body,
                                 timeout: timeout, onResponse: onResponse, onData: onData)
    }

    /// Permanently closes this instance, including handshake, pending requests and SSE.
    func close() {
        guard !closed else { return }
        closed = true
        failConnection(Failure.closed, generation: generation)
        session.invalidateAndCancel()
    }

    /// Cancel all current operations while retaining the instance for a future call.
    func cancel() {
        failConnection(CancellationError(), generation: generation)
    }

    private func perform(path: String, method: String, headers: [String: String], body: Data?,
                         timeout: TimeInterval, onResponse: OnResponse?, onData: OnData?) async throws -> Response {
        try Task.checkCancellation()
        guard !closed else { throw Failure.closed }
        if let error = terminalError { throw error }
        guard timeout.isFinite, timeout > 0, timeout <= 7 * 24 * 3600,
              let components = URLComponents(string: path), components.scheme == nil,
              components.host == nil, components.fragment == nil,
              path.hasPrefix("/"), !path.hasPrefix("//"),
              !components.percentEncodedPath.contains("\\"),
              !method.isEmpty, method.utf8.count <= 32,
              method.utf8.allSatisfy({ (65...90).contains($0) }),
              headers.count <= 128,
              headers.allSatisfy({ !$0.key.isEmpty && !$0.key.contains("\r") && !$0.key.contains("\n")
                  && !$0.value.contains("\r") && !$0.value.contains("\n") }) else {
            throw Failure.invalidRequest
        }
        guard pending.count + webSockets.count < Self.maxStreams, (body?.count ?? 0) <= Self.maxBody,
              inputBytes + (body?.count ?? 0) <= Self.totalBodyBudget else { throw Failure.limit }
        let head = try JSONSerialization.data(withJSONObject: ["method": method,
            "path": components.percentEncodedPath, "query": components.percentEncodedQuery ?? "", "headers": headers])
        // Request/response heads are single frames in the normative protocol.
        guard head.count <= Self.maxPayload else { throw Failure.limit }
        let token = UUID()
        return try await withTaskCancellationHandler(operation: {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                let item = Pending(token: token, requestHead: head, requestBody: body,
                                   continuation: continuation, onResponse: onResponse, onData: onData)
                pending[token] = item
                inputBytes += item.inputBytes
                item.timer = Task { [weak self] in
                    do { try await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000)) }
                    catch { return }
                    await self?.cancelRequest(token, error: Failure.timeout)
                }
                start(item)
            }
        }, onCancel: { [weak self] in
            Task { await self?.cancelRequest(token, error: CancellationError()) }
        })
    }

    private func start(_ item: Pending) {
        if ready {
            let token = item.token
            item.upload = Task { [weak self] in await self?.upload(token: token) }
        } else if connection == nil {
            generation += 1
            let current = generation
            connection = Task {
                do { try await self.establish(generation: current) }
                catch { self.failConnection(error, generation: current) }
            }
        }
    }

    private func upload(token: UUID) async {
        do {
            try Task.checkCancellation()
            guard let item = pending[token], ready else { return }
            let head = item.requestHead
            let body = item.requestBody
            guard nextStream <= UInt64(UInt32.max) else { throw Failure.limit }
            let id = UInt32(nextStream)
            nextStream += 2
            item.streamID = id
            streams[id] = token
            try await send(type: 1, streamID: id, payload: head)
            if let body {
                var offset = 0
                while offset < body.count {
                    try Task.checkCancellation()
                    guard pending[token] != nil else { return }
                    let end = min(offset + Self.maxPayload, body.count)
                    try await send(type: 2, streamID: id, payload: body.subdata(in: offset..<end))
                    offset = end
                }
            }
            try Task.checkCancellation()
            guard pending[token] != nil else { return }
            try await send(type: 4, streamID: id, payload: Data())
        } catch {
            cancelRequest(token, error: error)
        }
    }

    private func establish(generation current: UInt64) async throws {
        let channel = try RelayChannelCrypto(hostKey: hostKey)
        let wire = session.webSocketTask(with: endpoint)
        wire.maximumMessageSize = Self.maxPlaintext + 29
        socket = wire
        crypto = channel
        wire.resume()
        let deadline = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 30_000_000_000) } catch { return }
            await self?.failConnection(Failure.timeout, generation: current)
        }
        let retry = Task { [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(nanoseconds: 1_000_000_000) } catch { return }
                guard let self, await self.shouldRetryHello(generation: current) else { return }
                do { try await wire.send(.string(channel.hello)) } catch { return }
            }
        }
        defer { deadline.cancel(); retry.cancel() }
        do {
            try await wire.send(.string(channel.hello))
            while true {
                let message = try await wire.receive()
                guard current == generation, !closed else { throw Failure.disconnected }
                switch message {
                case .string(let text):
                    if Self.isReady(text) {
                        ready = true
                        connection = nil
                        lastReceived = ProcessInfo.processInfo.systemUptime
                        lastSent = lastReceived
                        receiver = Task { [weak self] in await self?.receive(wire, generation: current) }
                        keepalive = Task { [weak self] in
                            while !Task.isCancelled {
                                do { try await Task.sleep(nanoseconds: 15_000_000_000) } catch { return }
                                guard let self else { return }
                                await self.checkLiveness(generation: current)
                            }
                        }
                        for item in pending.values { start(item) }
                        return
                    }
                    // Match the TS initiator: tolerate relay control noise before ready.
                case .data: throw Failure.invalidFrame
                @unknown default: throw Failure.invalidFrame
                }
            }
        } catch {
            let failure: Error = wire.closeCode.rawValue == 4010 ? Failure.authentication : error
            failConnection(failure, generation: current)
            throw failure
        }
    }

    private func shouldRetryHello(generation current: UInt64) -> Bool {
        current == generation && !closed && !ready
    }

    private static func isReady(_ text: String) -> Bool {
        guard text.utf8.count <= maxPlaintext,
              let object = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
              let version = object["v"] as? NSNumber, CFGetTypeID(version) != CFBooleanGetTypeID(),
              version.doubleValue == 1, object["t"] as? String == "ready" else { return false }
        return true
    }

    private func receive(_ wire: URLSessionWebSocketTask, generation current: UInt64) async {
        do {
            while !Task.isCancelled {
                let message = try await wire.receive()
                guard current == generation, ready else { return }
                switch message {
                case .string(let text):
                    // Duplicate ready is legal when a hello retry raced establishment.
                    guard Self.isReady(text) else { throw Failure.invalidFrame }
                case .data(let bytes):
                    guard let crypto else { throw Failure.invalidFrame }
                    let frame = try crypto.decrypt(bytes)
                    lastReceived = ProcessInfo.processInfo.systemUptime
                    probeStarted = nil
                    try await handle(frame, generation: current)
                @unknown default: throw Failure.invalidFrame
                }
            }
        } catch {
            failConnection(wire.closeCode.rawValue == 4010 ? Failure.authentication : error, generation: current)
        }
    }

    private func handle(_ frame: Data, generation current: UInt64) async throws {
        guard frame.count >= 5 else { throw Failure.invalidFrame }
        let type = frame[0] & 0x7f
        let more = frame[0] & 0x80 != 0
        guard (1...12).contains(type), !more || type == 8 || type == 9,
              frame.count <= Self.maxPayload + 5 else { throw Failure.invalidFrame }
        let id = frame[1..<5].reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
        let payload = Data(frame.dropFirst(5))
        if type == 11 {
            try await send(type: 12, streamID: id, payload: Data())
            return
        }
        if type == 12 { return }
        if let inbox = webSockets[id] {
            do {
                switch type {
                case 7:
                    guard let head = try JSONSerialization.jsonObject(with: payload) as? [String: Any],
                          head["protocol"] == nil || head["protocol"] as? String == "" else { throw Failure.invalidFrame }
                    try await inbox.didOpen()
                case 8, 9: try await inbox.consume(type: type, payload: payload, more: more)
                case 10:
                    guard let close = try JSONSerialization.jsonObject(with: payload) as? [String: Any],
                          let number = close["code"] as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
                          number.doubleValue == Double(number.intValue), (1000...4999).contains(number.intValue),
                          let reason = close["reason"] as? String, reason.utf8.count <= 123 else { throw Failure.invalidFrame }
                    webSockets.removeValue(forKey: id); await inbox.end(code: number.intValue)
                case 5:
                    guard let abort = try JSONSerialization.jsonObject(with: payload) as? [String: Any],
                          let reason = abort["reason"] as? String else { throw Failure.invalidFrame }
                    throw Self.webSocketRejection(reason)
                default: throw Failure.invalidFrame
                }
            } catch { await closeWebSocket(id, error: error) }
            return
        }
        // A cancelled stream can have authenticated response frames already in flight.
        guard let token = streams[id], let item = pending[token] else { return }
        do {
            switch type {
            case 3:
                guard item.head == nil,
                      let head = try JSONSerialization.jsonObject(with: payload) as? [String: Any],
                      let number = head["status"] as? NSNumber,
                      CFGetTypeID(number) != CFBooleanGetTypeID(),
                      number.doubleValue == Double(number.intValue), (200...599).contains(number.intValue),
                      let headers = head["headers"] as? [String: String], head["encoding"] == nil else {
                    throw Failure.invalidFrame
                }
                item.head = (number.intValue, headers)
                try await item.onResponse?(number.intValue, headers)
            case 2:
                guard item.head != nil else { throw Failure.invalidFrame }
                if let onData = item.onData {
                    try await onData(payload)
                } else {
                    guard item.body.count + payload.count <= Self.maxBody,
                          responseBytes + payload.count <= Self.totalBodyBudget else { throw Failure.limit }
                    item.body.append(payload)
                    responseBytes += payload.count
                }
            case 4:
                guard let head = item.head, payload.isEmpty else { throw Failure.invalidFrame }
                finish(token, result: .success((head.0, head.1, item.body)))
            case 5:
                // Do not surface untrusted Host text or credentials through error logs.
                throw Failure.hostAborted
            default: throw Failure.invalidFrame
            }
        } catch {
            // Consumer rejection and malformed response fail only their owning stream.
            guard current == generation else { return }
            cancelRequest(token, error: error)
        }
    }

    private static func webSocketRejection(_ reason: String) -> Error {
        if reason == "Relay pairing authorization required" { return Failure.authentication }
        // ws emits this exact status-only error before open. Never forward its text:
        // other error strings may contain scoped URLs, headers or Host data.
        for status in [401, 403, 409, 501] where reason == "Unexpected server response: \(status)" {
            return Failure.webSocketRejected(status)
        }
        return Failure.hostAborted
    }

    private func send(type: UInt8, streamID: UInt32, payload: Data) async throws {
        try Task.checkCancellation()
        guard ready, socket != nil else { throw Failure.disconnected }
        guard payload.count <= Self.maxPayload else { throw Failure.limit }
        var frame = Data([type])
        frame.append(contentsOf: (0..<4).reversed().map { UInt8(truncatingIfNeeded: streamID >> ($0 * 8)) })
        frame.append(payload)
        guard queuedBytes + frame.count <= Self.queueBudget else { throw Failure.limit }
        try await withCheckedThrowingContinuation { continuation in
            writes.append(Write(streamID: streamID, frame: frame, continuation: continuation))
            queuedBytes += frame.count
            if !writerRunning {
                writerRunning = true
                let current = generation
                Task { await self.drainWrites(generation: current) }
            }
        }
    }

    private func drainWrites(generation current: UInt64) async {
        // Exactly one drain owns encrypt+send. Actor isolation alone is insufficient:
        // an actor is reentrant while URLSession's asynchronous send is suspended.
        while current == generation, ready, !writes.isEmpty {
            let entry = writes.removeFirst()
            writing = entry
            do {
                guard let crypto, let wire = socket else { throw Failure.disconnected }
                let encrypted = try crypto.encrypt(entry.frame)
                try await wire.send(.data(encrypted))
                guard current == generation, writing?.id == entry.id else { return }
                writing = nil
                queuedBytes -= entry.frame.count
                lastSent = ProcessInfo.processInfo.systemUptime
                entry.finish(.success(()))
            } catch {
                failConnection(error, generation: current)
                return
            }
        }
        if current == generation { writerRunning = false }
    }

    private func checkLiveness(generation current: UInt64) async {
        guard current == generation, ready else { return }
        let now = ProcessInfo.processInfo.systemUptime
        if let started = probeStarted {
            if now - started >= 15 { failConnection(Failure.timeout, generation: current) }
            return
        }
        if now - lastReceived >= 30 || now - lastSent >= 30 {
            probeStarted = now
            do { try await send(type: 11, streamID: 0, payload: Data()) }
            catch { failConnection(error, generation: current) }
        }
    }

    private func cancelRequest(_ token: UUID, error: Error) {
        guard let item = pending[token] else { return }
        let id = item.streamID
        finish(token, result: .failure(error))
        guard let id, ready else { return }
        // Drop queued upload chunks before the abort. An in-flight frame may finish;
        // it still precedes this abort in the single serialized send direction.
        let removed = writes.filter { $0.streamID == id }
        writes.removeAll { $0.streamID == id }
        for entry in removed {
            queuedBytes -= entry.frame.count
            entry.finish(.failure(error))
        }
        let current = generation
        Task {
            guard current == self.generation, self.ready else { return }
            do {
                try await self.send(type: 5, streamID: id, payload: Data("{\"reason\":\"cancelled\"}".utf8))
            } catch {
                // If abort cannot be delivered, close the connection so no orphaned
                // Host request survives locally completed cancellation.
                self.failConnection(error, generation: current)
            }
        }
    }

    private func finish(_ token: UUID, result: Result<Response, Error>) {
        guard let item = pending.removeValue(forKey: token) else { return }
        if let id = item.streamID { streams.removeValue(forKey: id) }
        inputBytes -= item.inputBytes
        responseBytes -= item.body.count
        item.timer?.cancel()
        item.upload?.cancel()
        item.requestBody = nil
        item.continuation.resume(with: result)
    }

    private func failConnection(_ error: Error, generation current: UInt64) {
        guard current == generation else { return }
        generation += 1
        if case Failure.authentication = error { terminalError = error }
        ready = false
        connection?.cancel(); connection = nil
        receiver?.cancel(); receiver = nil
        keepalive?.cancel(); keepalive = nil
        socket?.cancel(with: .goingAway, reason: nil); socket = nil
        crypto = nil
        probeStarted = nil
        let allWrites = writes + (writing.map { [$0] } ?? [])
        writes.removeAll()
        writing = nil
        queuedBytes = 0
        writerRunning = false
        for entry in allWrites { entry.finish(.failure(error)) }
        for token in Array(pending.keys) { finish(token, result: .failure(error)) }
        let sockets = Array(webSockets.values); webSockets.removeAll()
        // IDs remain monotonic for this object so cancelled old closures cannot
        // address a new substream after fresh-key establishment.
        for inbox in sockets { Task { await inbox.fail(error) } }
    }
}

/// Byte-compatible with lib/relay/crypto.ts. No NSH or other native app dependency.
private final class RelayChannelCrypto {
    let hello: String
    private let outgoing: SymmetricKey
    private let incoming: SymmetricKey
    private let prefix: Data
    private var sent: UInt64 = 0
    private var received: UInt64 = 0

    init(hostKey: P256.KeyAgreement.PublicKey) throws {
        let ephemeral = P256.KeyAgreement.PrivateKey()
        let point = ephemeral.publicKey.x963Representation
        let nonce = Self.random(count: 16)
        prefix = Self.random(count: 4)
        let secret = try ephemeral.sharedSecretFromKeyAgreement(with: hostKey)
        let material = secret.hkdfDerivedSymmetricKey(using: SHA256.self, salt: nonce,
            sharedInfo: Data("yuri-relay-v1".utf8), outputByteCount: 64)
        let bytes = material.withUnsafeBytes { Data($0) }
        outgoing = SymmetricKey(data: bytes.prefix(32))
        incoming = SymmetricKey(data: bytes.suffix(32))
        let object: [String: Any] = ["t": "hello", "v": 1, "batch": false,
            "clientPubJwk": ["kty": "EC", "crv": "P-256",
                "x": Self.base64url(Data(point[1..<33])), "y": Self.base64url(Data(point[33..<65]))],
            "nonce": Self.base64url(nonce)]
        hello = String(decoding: try JSONSerialization.data(withJSONObject: object), as: UTF8.self)
    }

    static func importKey(_ jwk: [String: String]) throws -> P256.KeyAgreement.PublicKey {
        guard jwk["kty"] == "EC", jwk["crv"] == "P-256",
              let x = decode(jwk["x"]), let y = decode(jwk["y"]), x.count == 32, y.count == 32 else {
            throw RelayTunnel.Failure.invalidConfiguration
        }
        do { return try P256.KeyAgreement.PublicKey(x963Representation: Data([4]) + x + y) }
        catch { throw RelayTunnel.Failure.invalidConfiguration }
    }

    func encrypt(_ plaintext: Data) throws -> Data {
        guard plaintext.count <= 65_536, sent < UInt64.max else { throw RelayTunnel.Failure.invalidFrame }
        sent += 1
        var iv = prefix
        iv.append(contentsOf: (0..<8).reversed().map { UInt8(truncatingIfNeeded: sent >> ($0 * 8)) })
        let sealed = try AES.GCM.seal(plaintext, using: outgoing, nonce: AES.GCM.Nonce(data: iv))
        return Data([1]) + iv + sealed.ciphertext + sealed.tag
    }

    func decrypt(_ frame: Data) throws -> Data {
        guard frame.count >= 29, frame.count <= 65_565, frame[0] == 1 else {
            throw RelayTunnel.Failure.invalidFrame
        }
        let counter = frame[5..<13].reduce(UInt64(0)) { ($0 << 8) | UInt64($1) }
        guard counter > received else { throw RelayTunnel.Failure.invalidFrame }
        do {
            let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: frame[1..<13]),
                ciphertext: frame[13..<(frame.count - 16)], tag: frame.suffix(16))
            let plaintext = try AES.GCM.open(box, using: incoming)
            received = counter
            return plaintext
        } catch { throw RelayTunnel.Failure.invalidFrame }
    }

    private static func random(count: Int) -> Data {
        var generator = SystemRandomNumberGenerator()
        return Data((0..<count).map { _ in UInt8.random(in: .min ... .max, using: &generator) })
    }

    private static func base64url(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    private static func decode(_ value: String?) -> Data? {
        guard let value, value.utf8.count == 43,
              value.utf8.allSatisfy({ (65...90).contains($0) || (97...122).contains($0)
                  || (48...57).contains($0) || $0 == 45 || $0 == 95 }) else { return nil }
        let base = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        return Data(base64Encoded: base + "=")
    }
}
