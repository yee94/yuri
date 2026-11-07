import Foundation
import CryptoKit
import NativeShell

/// Pure in-memory tests can replace only Host JSON I/O. Admission, request/auth
/// construction, connection persistence and lifecycle fences remain production code.
@MainActor struct RuntimeHostIO {
    let json: (URLRequest, SavedConnection) async throws -> (Int, Any)
}

struct SpeechResourceResponse {
    let status: Int
    let mime: String
    let data: Data
    let pitch: String?
    let volume: String?
}
@MainActor struct ResourceTransport {
    let read: (_ route: String, _ limit: Int) async throws -> (status: Int, mime: String, data: Data)
    let isCurrent: () -> Bool
    var speech: ((_ route: String, _ text: String?) async throws -> SpeechResourceResponse)? = nil
}

private actor ResourceBytesBuffer {
    private let limit: Int
    private var bytes = Data()
    init(limit: Int) { self.limit = limit }
    func receive(_ chunk: Data) throws {
        guard chunk.count <= limit - bytes.count else { throw NativeFailure.message("文件超过原生预览大小限制") }
        bytes.append(chunk)
    }
    func value() -> Data { bytes }
}

/// Authentication lives at the native boundary. Redirects never forward a client credential.
final class NoRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

@MainActor private final class SSEEvents {
    private var line = Data()
    private var eventLines: [String] = []
    private var eventSize = 0
    private var previousCR = false
    let emit: (String) -> Void
    init(emit: @escaping (String) -> Void) { self.emit = emit }
    func consume(_ data: Data) throws { for byte in data { try consume(byte) } }
    func consume(_ byte: UInt8) throws {
        if previousCR && byte == 10 { previousCR = false; return }
        previousCR = false
        if byte == 10 || byte == 13 {
            previousCR = byte == 13
            guard let value = String(data: line, encoding: .utf8) else { throw NativeFailure.message("事件不是有效的 UTF-8 文本") }
            if line.isEmpty {
                if !eventLines.isEmpty { emit(eventLines.joined(separator: "\n")) }
                eventLines.removeAll(keepingCapacity: true); eventSize = 0
            } else if value.hasPrefix("data:") {
                let content = value.dropFirst(5)
                eventSize += line.count + 1
                guard eventSize <= 2_000_000 else { throw NativeFailure.message("事件超过大小限制") }
                eventLines.append(String(content.first == " " ? content.dropFirst() : content))
            }
            line.removeAll(keepingCapacity: true)
        } else {
            guard line.count < 2_000_000 else { throw NativeFailure.message("事件超过大小限制") }
            line.append(byte)
        }
    }
}

@MainActor final class RuntimeBridge {
    let store: ConnectionStore
    private weak var app: NshAppView?
    private let session: URLSession
    private var streams: [String: Task<Void, Never>] = [:]
    private var streamTokens: [String: UUID] = [:]
    private var streamScopes: [String: RuntimeHostScope] = [:]
    private var generation = 0
    private var connectionAttempt = 0
    private var tunnels: [String: RelayTunnel] = [:]
    private var resourceTasks: [UUID: Task<(status: Int, mime: String, data: Data), Error>] = [:]
    private var guiResources: [UUID: () -> Void] = [:]
    private var speechTasks: [UUID: Task<SpeechResourceResponse, Error>] = [:]
    private var desktopSockets: [UUID: () -> Void] = [:]
    private var desktopRequests: [UUID: Task<(Int, Any), Error>] = [:]
    private var recognitionResources: [UUID: () -> Void] = [:]
    private let recognitionIO: VoiceRecognitionRuntimeIO?
    private let hostIO: RuntimeHostIO?
    private let terminalIO: TerminalRuntimeIO?
    private var terminalResources: [UUID: () -> Void] = [:]
    private let hostAuthority = RuntimeHostAuthority()
    private var runtimeRequests: [UUID: Task<(Int, Any), Error>] = [:]
    var onInvalidate: (() -> Void)?
    /// Native-only exact old authorization cleanup. Never fired for ordinary
    /// invalidation, rename/select, background, or an uncommitted store write.
    var onAuthorizationRetired: ((String, String) async throws -> Void)?
    private var failedAuthorizationRetirements = Set<AuthorizationRetirement>()
    private var retiringAuthorizations = Set<AuthorizationRetirement>()
    var authorizationRetirementStatus: [String: Any] {
        let pending = store.pendingAuthorizationRetirements
        return ["pending": pending.count, "failed": pending.filter { onAuthorizationRetired == nil || failedAuthorizationRetirements.contains($0) }.count]
    }

    init(app: NshAppView, store: ConnectionStore, voiceRecognitionIO: VoiceRecognitionRuntimeIO? = nil, hostIO: RuntimeHostIO? = nil,
         terminalIO: TerminalRuntimeIO? = nil) {
        self.app = app; self.store = store; recognitionIO = voiceRecognitionIO; self.hostIO = hostIO
        self.terminalIO = terminalIO
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        configuration.timeoutIntervalForRequest = 20
        session = URLSession(configuration: configuration, delegate: NoRedirect(), delegateQueue: nil)
        app.handle("connection.list") { [weak self] _ async throws -> Any? in self?.snapshot }
        app.handle("connection.editor") { [weak self] input async throws -> Any? in
            guard let self else { return nil }
            return try self.store.editor(self.string(input, "id"))
        }
        app.handle("connection.rename") { [weak self] input async throws -> Any? in
            guard let self else { return nil }
            try self.requireForeground()
            try self.store.edit(ConnectionEditorInput(input, rename: true))
            return self.snapshot
        }
        app.handle("connection.edit") { [weak self] input async throws -> Any? in
            guard let self else { return nil }
            try self.requireForeground()
            try self.store.edit(ConnectionEditorInput(input))
            return self.snapshot
        }
        app.handle("connection.select") { [weak self] input async throws -> Any? in
            guard let self else { return nil }
            try self.requireForeground()
            try self.store.select(try self.string(input, "id")); self.stop(); return self.snapshot
        }
        app.handle("connection.remove") { [weak self] input async throws -> Any? in
            guard let self else { return nil }
            try self.requireForeground()
            let id = try self.string(input, "id")
            let current = self.store.selected?.id == id
            try self.store.remove(id)
            if current { self.stop() }
            await self.retryAuthorizationRetirements()
            return self.snapshot
        }
        app.handle("connection.connect") { [weak self] input async throws -> Any? in
            guard let self else { return nil }; return try await self.connect(input)
        }
        app.handle("runtime.request") { [weak self] input async throws -> Any? in
            guard let self else { return nil }; return try await self.request(input)
        }
        app.handle("runtime.stream") { [weak self] input async throws -> Any? in
            guard let self else { return nil }
            guard let body = input as? [String: Any], Set(body.keys) == ["path", "key", "expectedHost"] else { throw RuntimeHostScopeFailure.invalid }
            let path = try self.string(body, "path"), key = try self.string(body, "key")
            let expected = try RuntimeHostScope(body["expectedHost"])
            let admission = try self.admit(expected, required: true)
            try self.stream(path: path, key: key, admission: admission); return true
        }
        app.handle("runtime.stop") { [weak self] input async throws -> Any? in
            guard let self, let body = input as? [String: Any], Set(body.keys) == ["key", "expectedHost"],
                  let key = body["key"] as? String, ["global", "chat"].contains(key) else { throw RuntimeHostScopeFailure.invalid }
            let expected = try RuntimeHostScope(body["expectedHost"])
            // Cleanup never adopts current authority. An old scope can only
            // release the exact old stream, never a new Host/lease's same key.
            if self.streamScopes[key] == expected {
                self.streamScopes.removeValue(forKey: key); self.streamTokens.removeValue(forKey: key)
                self.streams.removeValue(forKey: key)?.cancel()
            }
            return true
        }
    }
    var snapshot: [String: Any] {
        var value = store.snapshot
        value["runtimeScope"] = hostAuthority.scope(hostID: store.selected?.id)?.publicValue ?? NSNull()
        value["authorizationCleanup"] = authorizationRetirementStatus
        return value
    }
    /// Native lifecycle only. Default admission is closed, including queued JS
    /// calls before main has supplied the app's actual foreground state.
    func setForeground(_ active: Bool) {
        guard hostAuthority.setForeground(active, hostID: store.selected?.id) else { return }
        retireResources()
    }
    func stop() {
        hostAuthority.rotate(hostID: store.selected?.id)
        retireResources()
    }
    private func retireResources() {
        let gui = guiResources; guiResources.removeAll(); gui.values.forEach { $0() }
        generation += 1; connectionAttempt += 1; streams.values.forEach { $0.cancel() }; streams.removeAll(); streamTokens.removeAll()
        streamScopes.removeAll()
        runtimeRequests.values.forEach { $0.cancel() }; runtimeRequests.removeAll()
        resourceTasks.values.forEach { $0.cancel() }; resourceTasks.removeAll()
        speechTasks.values.forEach { $0.cancel() }; speechTasks.removeAll()
        desktopRequests.values.forEach { $0.cancel() }; desktopRequests.removeAll()
        let previousDesktop = Array(desktopSockets.values); desktopSockets.removeAll()
        previousDesktop.forEach { $0() }
        let previousRecognition = Array(recognitionResources.values); recognitionResources.removeAll()
        previousRecognition.forEach { $0() }
        let previousTerminal = Array(terminalResources.values); terminalResources.removeAll()
        previousTerminal.forEach { $0() }
        onInvalidate?()
        let previous = Array(tunnels.values); tunnels.removeAll()
        Task { for tunnel in previous { await tunnel.close() } }
    }
    private func requireForeground() throws { guard hostAuthority.isForeground else { throw RuntimeHostScopeFailure.background } }
    /// Retries cleanup only, never repeats removal/reauthorization or revives its
    /// committed authority. Pending native receipts survive all runtime switches.
    func retryAuthorizationRetirements() async {
        let pending = store.pendingAuthorizationRetirements
        failedAuthorizationRetirements.formIntersection(Set(pending))
        for value in pending { await retireAuthorization(value) }
    }
    private func retireAuthorization(_ value: AuthorizationRetirement) async {
        guard store.pendingAuthorizationRetirements.contains(value), retiringAuthorizations.insert(value).inserted else { return }
        defer { retiringAuthorizations.remove(value) }
        if let cleanup = onAuthorizationRetired {
            do {
                try Task.checkCancellation()
                try await cleanup(value.connectionID, value.authorizationID)
                try Task.checkCancellation()
                try store.acknowledgeAuthorizationRetirement(connectionID: value.connectionID, authorizationID: value.authorizationID)
                failedAuthorizationRetirements.remove(value)
            } catch {
                if store.pendingAuthorizationRetirements.contains(value) { failedAuthorizationRetirements.insert(value) }
                else { failedAuthorizationRetirements.remove(value) }
            }
        } else { failedAuthorizationRetirements.insert(value) }
        // Counts are safe for UI/diagnostics. Never expose identifiers or callback
        // error text; absence/failure remains explicit and requires native retry.
        app?.send("runtime.authorizationRetirement", authorizationRetirementStatus)
    }
    private struct HostAdmission {
        let connection: SavedConnection
        let generation: Int
        let expectedHost: RuntimeHostScope
    }
    /// Synchronous MainActor transaction: no await between validating the caller's
    /// lease and copying the exact connection/credential/generation used for I/O.
    private func admit(_ expected: RuntimeHostScope?, required: Bool) throws -> HostAdmission {
        let accepted = try hostAuthority.admit(expected, hostID: store.selected?.id, required: required)
        guard let connection = store.selected else { throw RuntimeHostScopeFailure.unavailable }
        return HostAdmission(connection: connection, generation: generation, expectedHost: accepted)
    }
    private func checkHost(_ connection: SavedConnection, generation scope: Int, expected: RuntimeHostScope? = nil) throws {
        try Task.checkCancellation()
        guard hostAuthority.isForeground, scope == generation, let selected = store.selected,
              selected.id == connection.id, selected.url == connection.url, selected.token == connection.token, selected.relay == connection.relay, selected.authorizationID == connection.authorizationID else { throw CancellationError() }
        if let expected, !hostAuthority.matches(expected, hostID: selected.id) { throw CancellationError() }
    }
    private func tunnel(for relay: RelayConfiguration) throws -> RelayTunnel {
        if let value = tunnels[relay.scope] { return value }
        let value = try RelayTunnel(relayUrl: relay.relayUrl, serverId: relay.serverId, hostEncPubJwk: relay.hostEncPubJwk)
        tunnels[relay.scope] = value
        return value
    }
    private func string(_ input: Any?, _ key: String) throws -> String {
        guard let result = (input as? [String: Any])?[key] as? String, !result.isEmpty else { throw NativeFailure.message("缺少参数：\(key)") }
        return result
    }
    static func origin(_ value: String) throws -> URL {
        guard let url = URL(string: value.trimmingCharacters(in: .whitespacesAndNewlines)), ["http", "https"].contains(url.scheme), url.host != nil, url.user == nil, url.password == nil, url.query == nil, url.fragment == nil, url.path.isEmpty || url.path == "/" else { throw NativeFailure.message("请输入有效的 HTTP(S) Host 地址，不包含路径或凭据") }
        return url
    }
    private func makeRequest(_ path: String, connection: SavedConnection, method: String = "GET", body: Any? = nil, authentication: Bool = false) throws -> URLRequest {
        guard let parts = URLComponents(string: path), parts.scheme == nil, parts.host == nil, parts.fragment == nil,
              let decoded = parts.percentEncodedPath.removingPercentEncoding,
              !decoded.contains("\\"), !decoded.contains("%"), !decoded.contains("//"),
              !decoded.split(separator: "/").contains(where: { $0 == "." || $0 == ".." }),
              (decoded.hasPrefix("/api/") || decoded == "/health" || (authentication && decoded == "/auth/session")),
              authentication || (!decoded.hasPrefix("/api/client-auth") && decoded != "/api/auth" && !decoded.hasPrefix("/api/auth/")),
              let url = URL(string: path, relativeTo: connection.url)?.absoluteURL,
              url.scheme == connection.url.scheme, url.host == connection.url.host, url.port == connection.url.port else { throw NativeFailure.message("无效的 Host API 路径") }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        guard connection.token.utf8.count <= 8192, connection.token.utf8.allSatisfy({ $0 > 32 && $0 < 127 }) else { throw NativeFailure.message("无效的设备访问凭据") }
        if !connection.token.isEmpty { request.setValue("Bearer \(connection.token)", forHTTPHeaderField: "Authorization") }
        if let body { request.httpBody = try JSONSerialization.data(withJSONObject: body); request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        return request
    }
    private func responseKind(path: String?, status: Int, contentType: String?) throws -> Bool {
        let type = contentType?.split(separator: ";").first?.trimmingCharacters(in: .whitespaces).lowercased()
        let plainText = path == "/api/fs/read" && type == "text/plain"
        guard type == "application/json" || plainText || status == 204 || status == 205 else { throw NativeFailure.message("Host 返回了非预期数据，请检查地址与服务版本") }
        return plainText
    }
    private func decoded(_ data: Data, status: Int, plainText: Bool) throws -> (Int, Any) {
        if plainText {
            guard let value = String(data: data, encoding: .utf8) else { throw NativeFailure.message("文件不是有效的 UTF-8 文本") }
            return (status, value)
        }
        if data.isEmpty { return (status, NSNull()) }
        return (status, try JSONSerialization.jsonObject(with: data, options: .fragmentsAllowed))
    }
    private func json(_ request: URLRequest, connection: SavedConnection, candidateTunnel: RelayTunnel? = nil) async throws -> (Int, Any) {
        if let hostIO { return try await hostIO.json(request, connection) }
        if let relay = connection.relay {
            let transport = try candidateTunnel ?? tunnel(for: relay)
            let response = try await transport.request(path: route(request), method: request.httpMethod ?? "GET", headers: request.allHTTPHeaderFields ?? [:], body: request.httpBody, timeout: request.timeoutInterval)
            let contentType = response.headers.first { $0.key.lowercased() == "content-type" }?.value
            let text = try responseKind(path: request.url?.path, status: response.status, contentType: contentType)
            return try decoded(response.body, status: response.status, plainText: text)
        }
        let (bytes, response) = try await session.bytes(for: request)
        defer { bytes.task.cancel() }
        guard let response = response as? HTTPURLResponse else { throw NativeFailure.message("无效的 Host 响应") }
        let plainText = try responseKind(path: request.url?.path, status: response.statusCode, contentType: response.value(forHTTPHeaderField: "Content-Type"))
        let limit = 32 * 1024 * 1024
        guard response.expectedContentLength <= limit else { throw NativeFailure.message("Host 响应超过 32 MiB 限制") }
        var data = Data()
        for try await byte in bytes {
            guard data.count < limit else { throw NativeFailure.message("Host 响应超过 32 MiB 限制") }
            data.append(byte)
        }
        return try decoded(data, status: response.statusCode, plainText: plainText)
    }
    private func route(_ request: URLRequest) -> String {
        let parts = URLComponents(url: request.url!, resolvingAgainstBaseURL: true)!
        return parts.percentEncodedPath + (parts.percentEncodedQuery.map { "?" + $0 } ?? "")
    }
    private func scopedJSON(_ request: URLRequest, connection: SavedConnection, scope: Int, expectedHost: RuntimeHostScope? = nil) async throws -> (Int, Any) {
        try checkHost(connection, generation: scope, expected: expectedHost)
        let ticket = UUID()
        let work = Task {
            // The child can be scheduled after a foreground/Host transition.
            // Reject again before crossing into URLSession or the Relay actor.
            try self.checkHost(connection, generation: scope, expected: expectedHost)
            return try await self.json(request, connection: connection)
        }
        runtimeRequests[ticket] = work
        defer { runtimeRequests.removeValue(forKey: ticket) }
        do {
            let result = try await withTaskCancellationHandler(operation: { try await work.value }, onCancel: { work.cancel() })
            try checkHost(connection, generation: scope, expected: expectedHost)
            return result
        } catch {
            try checkHost(connection, generation: scope, expected: expectedHost)
            throw error
        }
    }
    private func request(_ input: Any?) async throws -> Any {
        let path = try string(input, "path")
        let args = input as? [String: Any] ?? [:]
        guard args["method"] == nil || args["method"] is String else { throw NativeFailure.message("不支持的请求方式") }
        let method = args["method"] as? String ?? "GET"
        guard ["GET", "POST", "PUT", "PATCH", "DELETE"].contains(method) else { throw NativeFailure.message("不支持的请求方式") }
        let expected = try args["expectedHost"].map { try RuntimeHostScope($0) }
        let admission = try admit(expected, required: method != "GET")
        let connection = admission.connection
        let (status, value) = try await scopedJSON(makeRequest(path, connection: connection, method: method, body: args["body"]), connection: connection, scope: admission.generation, expectedHost: admission.expectedHost)
        return ["status": status, "body": value]
    }
    /// Captured native admission, never the latest lease at dispatch time. All
    /// terminal HTTP/WS/SSE use this exact connection and its authorized Relay.
    func terminalTransport(expectedHost: RuntimeHostScope) throws -> TerminalTransport {
        let admission = try admit(expectedHost, required: true)
        let connection = admission.connection
        guard connection.relay == nil || !connection.token.isEmpty else { throw TerminalFailure.unavailable }
        let current = { [weak self] in
            guard let self else { return false }
            return (try? self.checkHost(connection, generation: admission.generation, expected: admission.expectedHost)) != nil
        }
        return TerminalTransport(expectedHost: admission.expectedHost, isCurrent: current, request: { [weak self] operation in
            guard let self, current() else { throw CancellationError() }
            try Self.validateTerminalRequest(operation)
            var request = try self.makeRequest(operation.path, connection: connection, method: operation.method, body: operation.body)
            request.timeoutInterval = 15
            if let text = operation.text { request.httpBody = Data(text.utf8); request.setValue("text/plain", forHTTPHeaderField: "Content-Type") }
            let response = try await self.terminalHTTP(request, connection: connection, current: current, limit: TerminalTransportWire.responseLimit)
            return (response.status, try TerminalTransportWire.json(response))
        }, open: { [weak self] in
            guard let self, current() else { throw CancellationError() }
            let ticket = UUID(), lease = TerminalSocketLease(current: current, released: { [weak self] in self?.terminalResources.removeValue(forKey: ticket) })
            self.terminalResources[ticket] = { lease.close() }
            return try await lease.open { [self] in
                try Task.checkCancellation(); guard current() else { throw CancellationError() }
                var request = try self.makeRequest("/api/terminal/ws", connection: connection); request.timeoutInterval = 15
                if let relay = connection.relay {
                    var mint = try self.makeRequest("/api/terminal/ws", connection: connection, method: "POST")
                    mint.url = URL(string: "/auth/url-token", relativeTo: connection.url)!.absoluteURL; mint.timeoutInterval = 10
                    let response = try await self.terminalHTTP(mint, connection: connection, current: current, limit: TerminalTransportWire.responseLimit)
                    let token = try TerminalTransportWire.token(response, credential: connection.token)
                    try Task.checkCancellation(); guard current() else { throw CancellationError() }
                    if let io = self.terminalIO { return try await io.socket(request, relay, token) }
                    let socket = try await self.tunnel(for: relay).openWebSocket(path: "/api/terminal/ws", urlToken: token, timeout: 15)
                    return TerminalSocket(receive: {
                        switch try await socket.receive() {
                        case .text(let text): return .text(text)
                        case .binary(let data): return .binary(data)
                        case .closed(let code): return .closed(code)
                        }
                    }, send: { value in
                        switch value {
                        case .text(let text): try await socket.send(text)
                        case .binary(let data): try await socket.sendBinary(data)
                        case .closed: throw TerminalFailure.invalid
                        }
                    }, close: { Task { await socket.close() } })
                }
                request.setValue(connection.url.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")), forHTTPHeaderField: "Origin")
                var parts = URLComponents(url: request.url!, resolvingAgainstBaseURL: true)!
                parts.scheme = connection.url.scheme == "https" ? "wss" : "ws"; request.url = parts.url
                if let io = self.terminalIO { return try await io.socket(request, nil, nil) }
                let socket = TerminalDirectConnection(request: request)
                try await socket.open()
                return TerminalSocket(receive: { try await socket.receive() }, send: { try await socket.send($0) }, close: { socket.close() })
            }
        }, stream: { [weak self] id in
            guard let self, current(), TerminalProtocol.identifier(id) else { throw TerminalFailure.invalid }
            return try await self.terminalSSE(id: id, connection: connection, current: current)
        }, optionalFile: { [weak self] directory, file in
            guard let self, current(), TerminalProtocol.directory(directory),
                  ["package.json", "bun.lock", "bun.lockb", "pnpm-lock.yaml", "yarn.lock", "package-lock.json", "index.html"].contains(file) else { throw TerminalFailure.invalid }
            var parts = URLComponents(); parts.path = "/api/fs/read"
            parts.queryItems = [URLQueryItem(name: "path", value: (directory == "/" ? "" : directory) + "/" + file), URLQueryItem(name: "directory", value: directory), URLQueryItem(name: "optional", value: "true")]
            var request = try self.makeRequest(parts.string!, connection: connection); request.timeoutInterval = 15
            request.setValue("text/plain", forHTTPHeaderField: "Accept")
            let response = try await self.terminalHTTP(request, connection: connection, current: current, limit: TerminalTransportWire.messageLimit)
            guard response.status == 200, response.header("content-type")?.split(separator: ";").first?.trimmingCharacters(in: .whitespaces).lowercased() == "text/plain",
                  let text = String(data: response.data, encoding: .utf8) else { throw TerminalFailure.response }
            if response.header("x-yuri-file-exists") == "false" { return nil }
            return text
        }, freePort: { [weak self] in
            guard let self, current() else { throw CancellationError() }
            var request = try self.makeRequest("/api/system/free-port", connection: connection); request.timeoutInterval = 15
            let response = try await self.terminalHTTP(request, connection: connection, current: current, limit: TerminalTransportWire.responseLimit)
            let body = try TerminalTransportWire.json(response)
            guard response.status == 200, let port = TerminalProtocol.integer(body["port"]), (1...65535).contains(port) else { throw TerminalFailure.response }
            return port
        }, supportsWebSocket: true)
    }
    private static func validateTerminalRequest(_ operation: TerminalRequest) throws {
        switch operation {
        case .create(let directory, let cols, let rows):
            guard TerminalProtocol.directory(directory), directory.utf8.count <= 8192 else { throw TerminalFailure.invalid }
            _ = try TerminalProtocol.size(["cols": cols, "rows": rows])
        case .resize(let id, let cols, let rows):
            guard TerminalProtocol.identifier(id) else { throw TerminalFailure.invalid }; _ = try TerminalProtocol.size(["cols": cols, "rows": rows])
        case .close(let id), .forceKill(let id): guard TerminalProtocol.identifier(id) else { throw TerminalFailure.invalid }
        case .input(let id, let text): guard TerminalProtocol.identifier(id), !text.isEmpty, text.utf8.count <= TerminalTransportWire.inputLimit else { throw TerminalFailure.invalid }
        case .probeURL(let url): guard TerminalProtocol.loopback(url) else { throw TerminalFailure.invalid }
        }
    }
    private func terminalHTTP(_ input: URLRequest, connection: SavedConnection, current: @escaping () -> Bool, limit: Int) async throws -> TerminalHTTPResponse {
        try Task.checkCancellation(); guard current() else { throw CancellationError() }
        let ticket = UUID(), pending = TerminalPending<TerminalHTTPResponse>()
        terminalResources[ticket] = { pending.cancel() }; defer { terminalResources.removeValue(forKey: ticket) }
        do {
            let result = try await pending.run(seconds: input.timeoutInterval) { [self] in
                try Task.checkCancellation(); guard current() else { throw CancellationError() }
                let result: TerminalHTTPResponse
                if let io = self.terminalIO { result = try await io.http(input, connection.relay, limit) }
                else if let relay = connection.relay {
                    let bytes = ResourceBytesBuffer(limit: limit)
                    let response = try await self.tunnel(for: relay).stream(path: self.route(input), method: input.httpMethod ?? "GET", headers: input.allHTTPHeaderFields ?? [:], body: input.httpBody, timeout: input.timeoutInterval,
                        onResponse: { status, headers in
                            guard !(300..<400).contains(status) else { throw TerminalFailure.response }
                            if let raw = headers.first(where: { $0.key.lowercased() == "content-length" })?.value, let length = Int(raw), length > limit { throw TerminalFailure.overflow }
                        }, onData: { try await bytes.receive($0) })
                    result = TerminalHTTPResponse(status: response.status, headers: response.headers, data: await bytes.value())
                } else {
                    let (response, bytes) = try await Self.boundedBytes(input, session: self.session, limit: limit)
                    var headers: [String: String] = [:]; for (key, value) in response.allHeaderFields { if let key = key as? String { headers[key] = String(describing: value) } }
                    result = TerminalHTTPResponse(status: response.statusCode, headers: headers, data: bytes)
                }
                try Task.checkCancellation(); guard current() else { throw CancellationError() }
                try TerminalTransportWire.head(result, limit: limit); return result
            }
            try Task.checkCancellation(); guard current() else { throw CancellationError() }; return result
        } catch { throw TerminalTransportWire.failure(error) }
    }
    private func terminalSSE(id: String, connection: SavedConnection, current: @escaping () -> Bool) async throws -> TerminalEventStream {
        var request = try makeRequest("/api/terminal/\(id)/stream", connection: connection)
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept"); request.timeoutInterval = 60
        let ticket = UUID(), inbox = TerminalStreamInbox(), opening = TerminalPending<Void>()
        var producer: Task<Void, Never>?, ended = false
        let close: () -> Void = { [weak self] in
            guard !ended else { return }; ended = true; producer?.cancel(); opening.cancel(); inbox.fail(CancellationError()); self?.terminalResources.removeValue(forKey: ticket)
        }
        terminalResources[ticket] = close
        let parser = TerminalSSEParser(heartbeat: { try inbox.push(.binary(Data())) }) { text in
            guard current(), !ended else { throw CancellationError() }
            guard let data = text.data(using: .utf8), let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  ["connected", "data", "exit"].contains(object["type"] as? String ?? "") else { throw TerminalFailure.protocolViolation }
            try inbox.push(.text(text))
        }
        func head(_ status: Int, _ mime: String?) throws {
            guard current(), !ended else { throw CancellationError() }
            if status == 404 { throw TerminalFailure.sessionNotFound }
            guard status == 200, mime?.split(separator: ";").first?.trimmingCharacters(in: .whitespaces).lowercased() == "text/event-stream" else { throw TerminalFailure.response }
            try inbox.didOpen()
        }
        producer = Task { [self] in
            do {
                try Task.checkCancellation(); guard current(), !ended else { throw CancellationError() }
                if let relay = connection.relay {
                    _ = try await self.tunnel(for: relay).stream(path: self.route(request), headers: request.allHTTPHeaderFields ?? [:], timeout: 7 * 24 * 3600,
                        onResponse: { status, headers in try await MainActor.run { try head(status, headers.first(where: { $0.key.lowercased() == "content-type" })?.value) } },
                        onData: { bytes in try await MainActor.run { guard current(), !ended else { throw CancellationError() }; try parser.consume(bytes) } })
                } else {
                    let (bytes, response) = try await self.session.bytes(for: request); defer { bytes.task.cancel() }
                    guard let response = response as? HTTPURLResponse else { throw TerminalFailure.response }
                    try head(response.statusCode, response.value(forHTTPHeaderField: "Content-Type"))
                    for try await byte in bytes { try Task.checkCancellation(); guard current(), !ended else { throw CancellationError() }; try parser.consume(byte) }
                }
                // An SSE EOF is a lost stream, never authoritative empty success.
                inbox.end(TerminalFailure.connectionFailed)
            } catch { inbox.fail(error) }
        }
        do {
            try await opening.run(seconds: 15) { try await inbox.waitOpen() }
            try Task.checkCancellation(); guard current(), !ended else { throw CancellationError() }
            return TerminalEventStream(receive: {
                do {
                    try Task.checkCancellation(); guard current(), !ended else { throw CancellationError() }
                    while true {
                        let pending = TerminalPending<TerminalWireMessage>()
                        let value = try await pending.run(seconds: 65) { try await inbox.receive() }
                        try Task.checkCancellation(); guard current(), !ended else { throw CancellationError() }
                        if case .binary = value { continue }
                        guard case .text(let text) = value, let data = text.data(using: .utf8), let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw TerminalFailure.protocolViolation }
                        return object
                    }
                } catch { close(); throw TerminalTransportWire.failure(error) }
            }, close: close)
        } catch { close(); throw TerminalTransportWire.failure(error) }
    }
    func voiceRecognitionTransport(expectedHost: RuntimeHostScope) throws -> VoiceRecognitionTransport {
        let admission = try admit(expectedHost, required: true)
        let connection = admission.connection, scope = admission.generation
        guard connection.relay == nil || !connection.token.isEmpty else { throw VoiceRecognitionFailure.unavailable }
        let current = { [weak self] in
            guard let self, let selected = self.store.selected else { return false }
            return self.hostAuthority.matches(admission.expectedHost, hostID: selected.id) && self.generation == scope && selected.id == connection.id && selected.url == connection.url && selected.token == connection.token && selected.relay == connection.relay && selected.authorizationID == connection.authorizationID
        }
        return VoiceRecognitionTransport(settings: { [weak self] in
            guard let self, current() else { throw CancellationError() }
            let request = try self.makeRequest("/api/voice/settings", connection: connection)
            return try await self.recognitionHTTP(request, connection: connection, current: current, limit: VoiceRecognitionWire.settingsLimit)
        }, transcribe: { [weak self] bytes in
            guard let self, current() else { throw CancellationError() }
            guard !bytes.isEmpty, bytes.count <= VoiceRecognitionWire.fileLimit else { throw VoiceRecognitionFailure.limit }
            var request = try self.makeRequest("/api/stt/transcribe", connection: connection, method: "POST")
            request.setValue("audio/wav", forHTTPHeaderField: "Content-Type"); request.httpBody = bytes
            return try await self.recognitionHTTP(request, connection: connection, current: current, limit: VoiceRecognitionWire.responseLimit)
        }, open: { [weak self] in
            guard let self, current() else { throw CancellationError() }
            let ticket = UUID()
            let lease = VoiceRecognitionSocketLease(current: current, released: { [weak self] in self?.recognitionResources.removeValue(forKey: ticket) })
            self.recognitionResources[ticket] = { lease.close() }
            return try await lease.open { [self] in
                try Task.checkCancellation(); guard current() else { throw CancellationError() }
                var request = try self.makeRequest("/api/dictation/ws", connection: connection)
                request.timeoutInterval = 20
                let token: String?
                if connection.relay != nil {
                    // Mint only over this captured authorized tunnel. No bearer in
                    // URL auth, and never fall back to a direct Host/provider dial.
                    var mint = try self.makeRequest("/api/voice/settings", connection: connection, method: "POST")
                    mint.url = URL(string: "/auth/url-token", relativeTo: connection.url)!.absoluteURL
                    mint.timeoutInterval = 10
                    let response = try await self.recognitionHTTP(mint, connection: connection, current: current, limit: VoiceRecognitionWire.settingsLimit)
                    token = try VoiceRecognitionWire.scopedToken(response, credential: connection.token)
                } else {
                    token = nil
                    request.setValue(connection.url.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")), forHTTPHeaderField: "Origin")
                    var parts = URLComponents(url: request.url!, resolvingAgainstBaseURL: true)!
                    parts.scheme = connection.url.scheme == "https" ? "wss" : "ws"; request.url = parts.url
                }
                try Task.checkCancellation(); guard current() else { throw CancellationError() }
                if let io = self.recognitionIO { return try await io.socket(request, connection.relay, token) }
                if let relay = connection.relay {
                    let socket = try await self.tunnel(for: relay).openWebSocket(path: "/api/dictation/ws", urlToken: token!, timeout: 20)
                    return VoiceRecognitionSocket(receive: { try Self.recognitionMessage(try await socket.receive()) }, send: socket.send, close: { Task { await socket.close() } })
                }
                let socket = DesktopDirectConnection(request: request, incomingLimit: VoiceRecognitionWire.messageLimit, outgoingLimit: VoiceRecognitionWire.sendLimit)
                try await socket.open()
                return VoiceRecognitionSocket(receive: { try Self.recognitionMessage(try await socket.receive()) }, send: { try await socket.send($0) }, close: { socket.close() })
            }
        }, isCurrent: current)
    }
    private static func recognitionMessage(_ value: NativeSocketInbox.Message) throws -> VoiceRecognitionMessage {
        switch value { case .text(let text): return .text(text); case .closed: return .closed; case .binary: throw VoiceRecognitionFailure.transport }
    }
    private func recognitionHTTP(_ input: URLRequest, connection: SavedConnection, current: @escaping () -> Bool, limit: Int) async throws -> VoiceRecognitionResponse {
        try Task.checkCancellation(); guard current() else { throw CancellationError() }
        let ticket = UUID(), pending = VoiceRecognitionPending<VoiceRecognitionResponse>()
        recognitionResources[ticket] = { pending.cancel() }
        defer { recognitionResources.removeValue(forKey: ticket) }
        var request = input
        if request.url?.path != "/auth/url-token" { request.timeoutInterval = 90 }
        do {
            let result = try await pending.run(seconds: request.timeoutInterval) { [self] in
                try Task.checkCancellation(); guard current() else { throw CancellationError() }
                let value: VoiceRecognitionResponse
                if let io = self.recognitionIO { value = try await io.http(request, connection.relay, limit) }
                else if let relay = connection.relay {
                    let buffer = ResourceBytesBuffer(limit: limit)
                    let response = try await self.tunnel(for: relay).stream(path: self.route(request), method: request.httpMethod ?? "GET", headers: request.allHTTPHeaderFields ?? [:], body: request.httpBody, timeout: request.timeoutInterval,
                        onResponse: { status, headers in
                            let mime = headers.first(where: { $0.key.lowercased() == "content-type" })?.value ?? ""
                            let lengthHeader = headers.first(where: { $0.key.lowercased() == "content-length" })?.value
                            let length = lengthHeader.flatMap(Int.init) ?? -1
                            try VoiceRecognitionWire.head(status: status, mime: mime, length: length, limit: limit)
                        }, onData: { try await buffer.receive($0) })
                    value = VoiceRecognitionResponse(status: response.status, mime: response.headers.first(where: { $0.key.lowercased() == "content-type" })?.value ?? "", data: await buffer.value())
                } else {
                    let (response, bytes) = try await Self.boundedBytes(request, session: self.session, limit: limit)
                    value = VoiceRecognitionResponse(status: response.statusCode, mime: response.value(forHTTPHeaderField: "Content-Type") ?? "", data: bytes)
                }
                try Task.checkCancellation(); guard current() else { throw CancellationError() }
                return try VoiceRecognitionWire.response(value, limit: limit)
            }
            try Task.checkCancellation(); guard current() else { throw CancellationError() }; return result
        } catch { throw VoiceRecognitionWire.failure(error) }
    }
    func remoteDesktopTransport() throws -> RemoteDesktopTransport {
        try requireForeground()
        guard let connection = store.selected else { throw RemoteDesktopBridgeFailure(code: "authentication_required") }
        let scope = generation
        let current = { [weak self] in self?.hostAuthority.isForeground == true && self?.generation == scope && self?.store.selected?.id == connection.id }
        return RemoteDesktopTransport(capability: { [weak self] in
            guard let self, current() else { throw CancellationError() }
            var request = try self.makeRequest("/api/remote-desktop", connection: connection)
            request.timeoutInterval = 10
            let (status, body) = try await self.desktopJSON(request, connection: connection, scope: scope)
            guard let object = body as? [String: Any] else { throw RemoteDesktopBridgeFailure(code: "connection_failed") }
            return (status, object)
        }, open: { [weak self] in
            guard let self, current() else { throw CancellationError() }
            let ticket = UUID()
            do {
                let receive: () async throws -> NativeSocketInbox.Message
                let send: (String) async throws -> Void
                let close: () -> Void
                if let relay = connection.relay {
                    // Native direct upgrades carry headers; the Host's Relay dialer
                    // intentionally does not, so mint scoped auth over THIS tunnel.
                    var request = URLRequest(url: URL(string: "/auth/url-token", relativeTo: connection.url)!.absoluteURL)
                    request.httpMethod = "POST"; request.timeoutInterval = 10
                    let authenticated = try self.makeRequest("/api/remote-desktop", connection: connection)
                    request.allHTTPHeaderFields = authenticated.allHTTPHeaderFields
                    let (status, body) = try await self.desktopJSON(request, connection: connection, scope: scope)
                    guard status == 200 else { throw RemoteDesktopBridgeFailure(code: status == 401 || status == 403 ? "authentication_required" : "connection_failed") }
                    guard let object = body as? [String: Any], let token = object["token"] as? String,
                          let expiry = object["expiresAt"] as? NSNumber, CFGetTypeID(expiry) != CFBooleanGetTypeID(),
                          expiry.doubleValue.isFinite, expiry.doubleValue > Date().timeIntervalSince1970 * 1000,
                          token != connection.token else { throw RemoteDesktopBridgeFailure(code: "connection_failed") }
                    guard current() else { throw CancellationError() }
                    let socket = try await self.tunnel(for: relay).openWebSocket(path: "/api/remote-desktop/ws", urlToken: token)
                    receive = socket.receive; send = socket.send
                    close = { Task { await socket.close() } }
                } else {
                    var request = try self.makeRequest("/api/remote-desktop/ws", connection: connection)
                    request.setValue(connection.url.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")), forHTTPHeaderField: "Origin")
                    var components = URLComponents(url: request.url!, resolvingAgainstBaseURL: true)!
                    components.scheme = connection.url.scheme == "https" ? "wss" : "ws"
                    request.url = components.url; request.timeoutInterval = 20
                    let socket = DesktopDirectConnection(request: request)
                    // Register before suspension, so a Host switch cancels upgrade.
                    self.desktopSockets[ticket] = { socket.close() }
                    try await socket.open()
                    receive = { try await socket.receive() }; send = { try await socket.send($0) }
                    close = { socket.close() }
                }
                guard current(), !Task.isCancelled else { close(); throw CancellationError() }
                var released = false
                let release = { [weak self] in
                    guard !released else { return }; released = true
                    self?.desktopSockets.removeValue(forKey: ticket); close()
                }
                self.desktopSockets[ticket] = release
                return RemoteDesktopSocket(receive: {
                    guard current(), !released else { release(); throw CancellationError() }
                    do {
                        let value = try await receive()
                        guard current(), !released, !Task.isCancelled else { release(); throw CancellationError() }
                        switch value {
                        case .text(let text): return .text(text)
                        case .binary(let data): return .binary(data)
                        case .closed(let code):
                            release()
                            if code == 4001 { throw RemoteDesktopBridgeFailure(code: "authentication_required") }
                            return .closed(code)
                        }
                    } catch { release(); throw Self.desktopError(error) }
                }, send: { text in
                    guard current(), !released else { release(); throw CancellationError() }
                    do { try await send(text); guard current(), !released else { throw CancellationError() } }
                    catch { release(); throw Self.desktopError(error) }
                }, close: release)
            } catch {
                self.desktopSockets.removeValue(forKey: ticket)?()
                throw Self.desktopError(error)
            }
        }, isCurrent: current)
    }
    private func desktopJSON(_ request: URLRequest, connection: SavedConnection, scope: Int) async throws -> (Int, Any) {
        let ticket = UUID()
        let work = Task { try await self.scopedJSON(request, connection: connection, scope: scope) }
        desktopRequests[ticket] = work
        defer { desktopRequests.removeValue(forKey: ticket) }
        do {
            let value = try await withTaskCancellationHandler(operation: { try await work.value }, onCancel: { work.cancel() })
            try Task.checkCancellation(); return value
        } catch {
            try Task.checkCancellation(); throw Self.desktopError(error)
        }
    }
    fileprivate static func desktopFailure(status: Int) -> RemoteDesktopBridgeFailure {
        switch status {
        case 401: return RemoteDesktopBridgeFailure(code: "authentication_required")
        case 403: return RemoteDesktopBridgeFailure(code: "disabled")
        case 501: return RemoteDesktopBridgeFailure(code: "unsupported")
        case 409: return RemoteDesktopBridgeFailure(code: "occupied")
        default: return RemoteDesktopBridgeFailure(code: "connection_failed")
        }
    }
    fileprivate static func desktopError(_ error: Error) -> Error {
        if error is CancellationError || error is RemoteDesktopBridgeFailure { return error }
        if let failure = error as? RelayTunnel.Failure {
            switch failure {
            case .authentication: return RemoteDesktopBridgeFailure(code: "authentication_required")
            case .webSocketRejected(let status): return desktopFailure(status: status)
            case .webSocketClosed(let code) where code == 4001: return RemoteDesktopBridgeFailure(code: "authentication_required")
            default: break
            }
        }
        // URLSession and Host error descriptions may contain URLs. Never expose them.
        return RemoteDesktopBridgeFailure(code: "connection_failed")
    }
    /// Synchronous admission captures the same receipt for GUI and resource I/O.
    /// UI bootstrap and presentation ownership remain with the caller.
    func guiPluginPreviewCapture(expectedHost: RuntimeHostScope) throws -> GuiPluginRuntimeCapture {
        let admission = try admit(expectedHost, required: true)
        let resource = try resourceWebPreviewTransport(expectedHost: admission.expectedHost)
        let current = { [weak self] in
            guard let self else { return false }
            return (try? self.checkHost(admission.connection, generation: admission.generation, expected: admission.expectedHost)) != nil
        }
        let open: (RuntimeHostScope, GuiPluginPreviewRequest) async throws -> GuiPluginPreviewByteStream = { [weak self] expected, request in
            guard let self, expected == admission.expectedHost else { throw CancellationError() }
            return try await self.openGuiPlugin(request, admission: admission)
        }
        return GuiPluginRuntimeCapture(expectedHost: admission.expectedHost, resource: resource, isCurrent: current, readGui: { expected, request, limit in
            guard limit > 0, limit <= GuiPluginPreviewScope.replyLimit else { throw GuiPluginPreviewFailure.limit }
            let stream = try await open(expected, request)
            defer { stream.cancel() }
            let buffer = GuiPluginRuntimeBuffer(limit)
            while let chunk = try await stream.read(65536) { try await buffer.append(chunk) }
            let data = await buffer.value()
            guard current() else { throw CancellationError() }
            return GuiPluginPreviewResponse(status: stream.status, mime: stream.mime, data: data, headers: stream.headers)
        }, openGui: open)
    }
    private func openGuiPlugin(_ input: GuiPluginPreviewRequest, admission: HostAdmission) async throws -> GuiPluginPreviewByteStream {
        let check = { [self] in try checkHost(admission.connection, generation: admission.generation, expected: admission.expectedHost) }
        try check()
        // Match the native GUI surface's existing eight-request/reader budget;
        // independent paired lanes must not turn into unbounded connections.
        guard guiResources.count < 8 else { throw GuiPluginPreviewFailure.busy }
        var request = try makeRequest(input.route, connection: admission.connection, method: input.method)
        request.httpBody = input.body
        for (name, value) in input.headers { request.setValue(value, forHTTPHeaderField: name) }
        let id = UUID()
        var stopped = false, reading = false, sourceCancelled = false
        let head: GuiPluginRuntimeHead
        let read: (Int) async throws -> Data?
        let cancel: () -> Void
        if let relay = admission.connection.relay {
            // GUI pull can intentionally stall onData. Give each reader its own
            // native-managed, identically paired lane so it never holds the
            // shared realtime tunnel's only receive loop (including pong).
            let tunnel = try RelayTunnel(relayUrl: relay.relayUrl, serverId: relay.serverId, hostEncPubJwk: relay.hostEncPubJwk)
            let body = GuiPluginRelayBody()
            let path = route(request), headers = request.allHTTPHeaderFields ?? [:]
            let method = input.method, payload = input.body
            let producer = Task {
                do {
                    try check()
                    _ = try await tunnel.stream(path: path, method: method, headers: headers, body: payload, timeout: 300,
                        onResponse: { status, headers in try await body.response(status, headers) },
                        onData: { data in try await body.receive(data) })
                    await body.finish()
                } catch {
                    if Task.isCancelled { await body.cancel() }
                    else { await body.finish(error) }
                }
                await tunnel.close()
            }
            cancel = {
                guard !sourceCancelled else { return }; sourceCancelled = true
                producer.cancel(); Task { await body.cancel(); await tunnel.close() }
            }
            guiResources[id] = { stopped = true; cancel() }
            do {
                head = try await withTaskCancellationHandler(operation: { try await body.waitHead() }, onCancel: { producer.cancel(); Task { await body.cancel(); await tunnel.close() } })
            } catch { guiResources.removeValue(forKey: id)?(); throw error }
            read = { limit in
                try await withTaskCancellationHandler(operation: { try await body.read(limit) }, onCancel: { producer.cancel(); Task { await body.cancel(); await tunnel.close() } })
            }
        } else {
            let opening = Task { try check(); return try await session.bytes(for: request) }
            guiResources[id] = { stopped = true; opening.cancel() }
            do {
                let (bytes, response) = try await withTaskCancellationHandler(operation: { try await opening.value }, onCancel: { opening.cancel() })
                let body = GuiPluginDirectBody(bytes.makeAsyncIterator())
                cancel = {
                    guard !sourceCancelled else { return }; sourceCancelled = true
                    bytes.task.cancel(); Task { await body.cancel() }
                }
                guiResources[id] = { stopped = true; cancel() }
                guard let response = response as? HTTPURLResponse else { cancel(); throw GuiPluginPreviewFailure.response }
                var headers: [String: String] = [:]
                for (key, value) in response.allHeaderFields { if let key = key as? String { headers[key] = String(describing: value) } }
                do { head = try GuiPluginRuntimeHead(status: response.statusCode, headers: headers) } catch { cancel(); throw error }
                read = { limit in
                    try await withTaskCancellationHandler(operation: { try await body.read(limit) }, onCancel: { bytes.task.cancel(); Task { await body.cancel() } })
                }
            } catch { guiResources.removeValue(forKey: id)?(); throw error }
        }
        let close = { [weak self] in stopped = true; self?.guiResources.removeValue(forKey: id); cancel() }
        do { try check() } catch { close(); throw error }
        return GuiPluginPreviewByteStream(status: head.status, mime: head.mime, read: { limit in
            do {
                guard !stopped, !reading else { throw CancellationError() }
                reading = true; defer { reading = false }
                try check()
                let bytes = try await read(limit)
                try check()
                guard !stopped else { throw CancellationError() }
                if bytes == nil { close() }
                return bytes
            } catch { close(); throw error }
        }, cancel: close, headers: head.headers)
    }

    func resourceWebPreviewTransport(expectedHost: RuntimeHostScope? = nil) throws -> ResourceWebPreviewTransport {
        let admission = try admit(expectedHost, required: expectedHost != nil)
        let connection = admission.connection, scope = admission.generation
        guard !connection.token.isEmpty else { throw ResourceWebPreviewFailure.unavailable }
        let resource = try resourceTransport(expectedHost: expectedHost)
        let current = { [weak self] in
            guard let self else { return false }
            return (try? self.checkHost(connection, generation: scope, expected: admission.expectedHost)) != nil
        }
        return ResourceWebPreviewTransport.authorized(readFile: { path, limit in
            let response = try await resource.read(path, limit)
            return ResourceWebPreviewResponse(status: response.status, mime: response.mime, data: response.data)
        }, isCurrent: current, send: { [weak self] path, method, body, headers, limit in
            guard let self, current() else { throw CancellationError() }
            guard limit > 0, limit <= ResourceWebPreviewScope.responseLimit,
                  (method == "POST" && path == "/api/preview/targets") || (method == "GET" && path.hasPrefix("/api/preview/proxy/")),
                  headers["X-Yuri-Native-Preview"] == "1", Set(headers.keys).isSubset(of: ["X-Yuri-Native-Preview", "X-Yuri-Preview-Token"]) else { throw ResourceWebPreviewFailure.invalid }
            var request = try self.makeRequest(path, connection: connection, method: method)
            request.httpBody = body; request.timeoutInterval = 60
            request.setValue(method == "POST" ? "application/json" : "*/*", forHTTPHeaderField: "Accept")
            if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
            for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
            let ticket = UUID()
            var policy: String?
            let task = Task { () throws -> (status: Int, mime: String, data: Data) in
                try Task.checkCancellation(); guard current() else { throw CancellationError() }
                let result: (status: Int, mime: String, data: Data)
                if let relay = connection.relay {
                    let buffer = ResourceBytesBuffer(limit: limit)
                    let response = try await self.tunnel(for: relay).stream(path: self.route(request), method: method, headers: request.allHTTPHeaderFields ?? [:], body: body, timeout: 60,
                        onResponse: { status, headers in
                            guard (200..<300).contains(status) else { throw ResourceWebPreviewFailure.response }
                            if let raw = headers.first(where: { $0.key.lowercased() == "content-length" })?.value, let length = Int(raw), length > limit { throw ResourceWebPreviewFailure.limit }
                        }, onData: { try await buffer.receive($0) })
                    policy = response.headers.first(where: { $0.key.lowercased() == "content-security-policy" })?.value
                    result = (response.status, response.headers.first(where: { $0.key.lowercased() == "content-type" })?.value ?? "application/octet-stream", await buffer.value())
                } else {
                    let (response, data) = try await Self.boundedBytes(request, session: self.session, limit: limit)
                    policy = response.value(forHTTPHeaderField: "Content-Security-Policy")
                    result = (response.statusCode, response.value(forHTTPHeaderField: "Content-Type") ?? "application/octet-stream", data)
                }
                try Task.checkCancellation(); guard current() else { throw CancellationError() }
                guard (200..<300).contains(result.status) else { throw ResourceWebPreviewFailure.response }
                return result
            }
            self.resourceTasks[ticket] = task
            defer { self.resourceTasks.removeValue(forKey: ticket) }
            do {
                let result = try await withTaskCancellationHandler(operation: { try await task.value }, onCancel: { task.cancel() })
                try Task.checkCancellation(); guard current() else { throw CancellationError() }
                return ResourceWebPreviewResponse(status: result.status, mime: result.mime, data: result.data, contentSecurityPolicy: policy)
            } catch is CancellationError { throw CancellationError() }
            catch let failure as ResourceWebPreviewFailure { throw failure }
            catch { throw ResourceWebPreviewFailure.response }
        })
    }
    func resourceTransport(expectedHost: RuntimeHostScope? = nil) throws -> ResourceTransport {
        let admission = try admit(expectedHost, required: expectedHost != nil)
        let connection = admission.connection, scope = admission.generation
        let current = { [weak self] in
            guard let self else { return false }
            return (try? self.checkHost(connection, generation: scope, expected: admission.expectedHost)) != nil
        }
        var transport = ResourceTransport(read: { [weak self] path, limit in
            guard let self, current() else { throw CancellationError() }
            guard limit > 0, limit <= 25 * 1024 * 1024,
                  let parts = URLComponents(string: path),
                  parts.path == "/api/fs/stat" || parts.path.hasPrefix("/api/fs/serve/") else { throw NativeFailure.message("无效的文件读取请求") }
            var request = try self.makeRequest(path, connection: connection)
            request.setValue("*/*", forHTTPHeaderField: "Accept")
            let ticket = UUID()
            let task = Task { () throws -> (status: Int, mime: String, data: Data) in
            try Task.checkCancellation(); guard current() else { throw CancellationError() }
            let result: (status: Int, mime: String, data: Data)
            if let relay = connection.relay {
                let buffer = ResourceBytesBuffer(limit: limit)
                let response = try await self.tunnel(for: relay).stream(path: self.route(request), headers: request.allHTTPHeaderFields ?? [:], timeout: 60,
                    onResponse: { _, headers in
                        if let raw = headers.first(where: { $0.key.lowercased() == "content-length" })?.value,
                           let length = Int(raw), length > limit { throw NativeFailure.message("文件超过原生预览大小限制") }
                    }, onData: { data in try await buffer.receive(data) })
                result = (response.status, response.headers.first(where: { $0.key.lowercased() == "content-type" })?.value ?? "application/octet-stream", await buffer.value())
            } else {
                result = try await Self.resourceBytes(request, session: self.session, limit: limit)
            }
            try Task.checkCancellation()
            guard current() else { throw CancellationError() }
            return result
            }
            self.resourceTasks[ticket] = task
            defer { self.resourceTasks.removeValue(forKey: ticket) }
            let result = try await withTaskCancellationHandler(operation: { try await task.value }, onCancel: { task.cancel() })
            try Task.checkCancellation(); guard current() else { throw CancellationError() }; return result
        }, isCurrent: current)
        transport.speech = { [weak self] path, text in
            guard let self, current() else { throw CancellationError() }
            let settings = path == "/api/voice/settings" && text == nil
            guard settings || (["/api/tts/speak", "/api/tts/say/speak", "/api/dictation/tts/speak"].contains(path) && text.map({ !$0.isEmpty && $0.utf8.count <= 4096 }) == true) else { throw NativeFailure.message("无效的朗读请求") }
            let limit = settings ? 65536 : 16 * 1024 * 1024
            var request = try self.makeRequest(path, connection: connection, method: settings ? "GET" : "POST", body: text.map { ["text": $0] })
            request.setValue(settings ? "application/json" : "audio/*", forHTTPHeaderField: "Accept")
            let ticket = UUID()
            let task = Task { () throws -> SpeechResourceResponse in
                try Task.checkCancellation(); guard current() else { throw CancellationError() }
                let result: SpeechResourceResponse
                if let relay = connection.relay {
                    let buffer = ResourceBytesBuffer(limit: limit)
                    let response = try await self.tunnel(for: relay).stream(path: self.route(request), method: settings ? "GET" : "POST", headers: request.allHTTPHeaderFields ?? [:], body: request.httpBody, timeout: 60,
                        onResponse: { _, headers in
                            if let raw = headers.first(where: { $0.key.lowercased() == "content-length" })?.value, let count = Int(raw), count > limit { throw NativeFailure.message("朗读响应超过限制") }
                        }, onData: { try await buffer.receive($0) })
                    func header(_ key: String) -> String? { response.headers.first(where: { $0.key.lowercased() == key })?.value }
                    result = SpeechResourceResponse(status: response.status, mime: header("content-type") ?? "", data: await buffer.value(), pitch: header("x-speech-pitch"), volume: header("x-speech-volume"))
                } else {
                    let (response, data) = try await Self.boundedBytes(request, session: self.session, limit: limit)
                    result = SpeechResourceResponse(status: response.statusCode, mime: response.value(forHTTPHeaderField: "Content-Type") ?? "", data: data, pitch: response.value(forHTTPHeaderField: "X-Speech-Pitch"), volume: response.value(forHTTPHeaderField: "X-Speech-Volume"))
                }
                try Task.checkCancellation()
                guard current() else { throw CancellationError() }
                return result
            }
            self.speechTasks[ticket] = task
            defer { self.speechTasks.removeValue(forKey: ticket) }
            let result = try await withTaskCancellationHandler(operation: { try await task.value }, onCancel: { task.cancel() })
            try Task.checkCancellation(); guard current() else { throw CancellationError() }; return result
        }
        return transport
    }
    nonisolated private static func resourceBytes(_ request: URLRequest, session: URLSession, limit: Int) async throws -> (status: Int, mime: String, data: Data) {
        let (response, data) = try await boundedBytes(request, session: session, limit: limit)
        return (response.statusCode, response.value(forHTTPHeaderField: "Content-Type") ?? "application/octet-stream", data)
    }
    nonisolated private static func boundedBytes(_ request: URLRequest, session: URLSession, limit: Int) async throws -> (HTTPURLResponse, Data) {
        let (bytes, response) = try await session.bytes(for: request)
        defer { bytes.task.cancel() }
        guard let response = response as? HTTPURLResponse else { throw NativeFailure.message("无效的 Host 响应") }
        guard response.expectedContentLength <= limit else { throw NativeFailure.message("文件超过原生预览大小限制") }
        var data = Data()
        for try await byte in bytes {
            if data.count & 65535 == 0 { try Task.checkCancellation() }
            guard data.count < limit else { throw NativeFailure.message("文件超过原生预览大小限制") }
            data.append(byte)
        }
        return (response, data)
    }
    func attachmentUploader() throws -> (Data, String, String) async throws -> [String: Any] {
        try requireForeground()
        guard let connection = store.selected else { throw NativeFailure.message("请先连接设备") }
        let scope = generation
        return { [weak self] data, name, mime in
            guard let self else { throw CancellationError() }
            try self.checkHost(connection, generation: scope)
            guard !data.isEmpty, data.count <= 25 * 1024 * 1024 else { throw NativeFailure.message("附件须为非空文件，且不超过 25 MiB") }
            let digest = await Task.detached(priority: .userInitiated) { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }.value
            try Task.checkCancellation()
            try self.checkHost(connection, generation: scope)
            let identifier = UUID().uuidString.lowercased()
            var request = try self.makeRequest("/api/fs/prompt-attachments/\(identifier)?storage=temporary", connection: connection, method: "PUT")
            request.httpBody = data
            request.timeoutInterval = 120
            request.setValue(mime, forHTTPHeaderField: "Content-Type")
            request.setValue(String(data.count), forHTTPHeaderField: "X-Yuri-Content-Length")
            request.setValue(digest, forHTTPHeaderField: "X-Yuri-Sha256")
            request.setValue(mime, forHTTPHeaderField: "X-Yuri-Mime")
            let componentCharacters = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")
            request.setValue(name.addingPercentEncoding(withAllowedCharacters: componentCharacters), forHTTPHeaderField: "X-Yuri-Filename")
            let (status, body) = try await self.scopedJSON(request, connection: connection, scope: scope)
            try Task.checkCancellation()
            try self.checkHost(connection, generation: scope)
            guard status == 200, let result = body as? [String: Any], result["success"] as? Bool == true,
                  let hostPath = result["path"] as? String,
                  result["sha256"] as? String == digest, result["size"] as? Int == data.count else { throw NativeFailure.message("附件上传失败 (\(status))，请重新选择文件重试") }
            let localPath: String
            if hostPath.hasPrefix("/") { localPath = hostPath }
            else if hostPath.range(of: "^[A-Za-z]:[/\\\\]", options: .regularExpression) != nil { localPath = "/" + hostPath.replacingOccurrences(of: "\\", with: "/") }
            else { throw NativeFailure.message("Host 返回了无效的附件绝对路径") }
            return ["uri": URL(fileURLWithPath: localPath).absoluteString, "name": name, "mime": mime]
        }
    }
    private func connect(_ input: Any?) async throws -> Any {
        try requireForeground()
        let args = input as? [String: Any] ?? [:]
        let editingID = args["id"] as? String
        let editingVersion = args["version"] as? String
        if let editingID {
            guard let editingVersion, !editingID.isEmpty, !editingVersion.isEmpty else { throw ConnectionEditorFailure.invalid }
            try store.validateReplacement(id: editingID, version: editingVersion, input: args)
        } else if args["id"] != nil || args["version"] != nil { throw ConnectionEditorFailure.invalid }
        connectionAttempt += 1
        let attempt = connectionAttempt
        let scope = generation
        func checkCurrent() throws {
            try Task.checkCancellation()
            guard hostAuthority.isForeground, attempt == connectionAttempt, scope == generation else { throw CancellationError() }
        }
        func send(_ request: URLRequest, connection: SavedConnection, tunnel: RelayTunnel? = nil) async throws -> (Int, Any) {
            try checkCurrent()
            let ticket = UUID()
            let work = Task {
                try checkCurrent()
                return try await self.json(request, connection: connection, candidateTunnel: tunnel)
            }
            runtimeRequests[ticket] = work
            defer { runtimeRequests.removeValue(forKey: ticket) }
            do {
                let result = try await withTaskCancellationHandler(operation: { try await work.value }, onCancel: { work.cancel() })
                try checkCurrent(); return result
            } catch { try checkCurrent(); throw error }
        }
        let pairing = args["pairingLink"] as? String ?? ""
        var url: URL
        var token = args["token"] as? String ?? ""
        var label = args["label"] as? String ?? ""
        var relay: RelayConfiguration?
        var pairingTunnel: RelayTunnel?
        defer { if let tunnel = pairingTunnel { Task { await tunnel.close() } } }
        if !pairing.isEmpty {
            guard pairing.count <= 16384, let components = URLComponents(string: pairing), components.scheme == "yuri", components.host == "connect", components.queryItems?.first(where: { $0.name == "v" })?.value == "2", let encoded = components.queryItems?.first(where: { $0.name == "p" })?.value else { throw NativeFailure.message("无效的配对链接") }
            var base64 = encoded.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
            base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
            guard let data = Data(base64Encoded: base64), let payload = try JSONSerialization.jsonObject(with: data) as? [String: Any], payload["v"] as? Int == 2, let candidates = payload["candidates"] as? [[String: Any]], !candidates.isEmpty, candidates.count <= 16, let pairingID = payload["pairingId"] as? String, let secret = payload["secret"] as? String, !pairingID.isEmpty, !secret.isEmpty else { throw NativeFailure.message("无效的配对内容") }
            if let expiry = payload["expiresAt"] as? String, let date = ISO8601DateFormatter().date(from: expiry), date <= Date() { throw NativeFailure.message("配对链接已过期，请在 Host 重新生成") }
            let ordered = candidates.enumerated().sorted {
                let leftRelay = $0.element["type"] as? String == "relay", rightRelay = $1.element["type"] as? String == "relay"
                if leftRelay != rightRelay { return !leftRelay }
                let left = $0.element["priority"] as? Int ?? 100, right = $1.element["priority"] as? Int ?? 100
                return left == right ? $0.offset < $1.offset : left < right
            }.map(\.element)
            let expectedServer = candidates.first { $0["type"] as? String == "relay" }?["serverId"] as? String
            var chosen: SavedConnection?
            for candidate in ordered {
                try checkCurrent()
                var configuration: RelayConfiguration?
                var transport: RelayTunnel?
                let endpoint: URL
                if candidate["type"] as? String == "relay" {
                    guard let address = candidate["relayUrl"] as? String, var components = URLComponents(string: address), let server = candidate["serverId"] as? String, let key = candidate["hostEncPubJwk"] as? [String: String] else { throw NativeFailure.message("无效的 Relay 配对信息") }
                    components.scheme = components.scheme?.lowercased(); components.host = components.host?.lowercased()
                    if (components.scheme == "wss" && components.port == 443) || (components.scheme == "ws" && components.port == 80) { components.port = nil }
                    guard let canonical = components.string else { throw NativeFailure.message("无效的 Relay 地址") }
                    configuration = RelayConfiguration(relayUrl: canonical, serverId: server, hostEncPubJwk: key)
                    transport = try RelayTunnel(relayUrl: canonical, serverId: server, hostEncPubJwk: key)
                    // This origin is a routing placeholder; Relay never opens an HTTP connection to it.
                    endpoint = URL(string: "https://relay.invalid")!
                } else {
                    guard ["lan", "tunnel"].contains(candidate["type"] as? String ?? ""), let address = candidate["url"] as? String else { continue }
                    endpoint = try Self.origin(address)
                }
                let temporary = SavedConnection(id: "", label: "", url: endpoint, token: "", lastUsedAt: 0, relay: configuration)
                do {
                    let (healthStatus, health) = try await send(makeRequest("/health", connection: temporary), connection: temporary, tunnel: transport)
                    try checkCurrent()
                    guard healthStatus == 200 else { throw NativeFailure.message("Host 健康检查失败 (\(healthStatus))") }
                    if let expectedServer, (health as? [String: Any])?["serverId"] as? String != expectedServer { throw NativeFailure.message("Host 身份与配对链接不一致") }
                    chosen = temporary; pairingTunnel = transport; break
                } catch {
                    if let transport { await transport.close() }
                    try checkCurrent()
                    let networkFailure = (error as? URLError).map { $0.code != .cancelled } ?? false
                    let relayFailure = (error as? RelayTunnel.Failure).map { failure -> Bool in
                        switch failure { case .timeout, .disconnected: return true; default: return false }
                    } ?? false
                    guard networkFailure || relayFailure else { throw error }
                }
            }
            guard let temporary = chosen else { throw NativeFailure.message("所有配对地址均无法连接，请检查 Host 与网络后重试") }
            url = temporary.url; relay = temporary.relay
            // Probe candidates before redeeming. A lost redemption response is ambiguous and never retried.
            let (status, response) = try await send(makeRequest("/api/client-auth/pairing/redeem", connection: temporary, method: "POST", body: ["pairingId": pairingID, "secret": secret, "clientKind": "mobile", "clientLabel": "Yuri Native iOS", "devicePlatform": "ios", "appVersion": "0.1.0"], authentication: true), connection: temporary, tunnel: pairingTunnel)
            try checkCurrent()
            guard status == 200, let body = response as? [String: Any], let credential = body["clientToken"] as? String, !credential.isEmpty else { throw NativeFailure.message("配对失败 (\(status))，请确认链接未失效") }
            token = credential; label = (body["server"] as? [String: Any])?["label"] as? String ?? label
        } else {
            url = try Self.origin(try string(input, "url"))
            if let password = args["password"] as? String, !password.isEmpty {
                let temporary = SavedConnection(id: "", label: "", url: url, token: "", lastUsedAt: 0)
                let (status, response) = try await send(makeRequest("/auth/session", connection: temporary, method: "POST", body: ["password": password, "issueClientToken": true, "trustDevice": true, "clientKind": "mobile", "clientLabel": "Yuri Native iOS", "devicePlatform": "ios", "appVersion": "0.1.0"], authentication: true), connection: temporary)
                try checkCurrent()
                guard status == 200, let credential = (response as? [String: Any])?["clientToken"] as? String, !credential.isEmpty else { throw NativeFailure.message("设备解锁失败 (\(status))") }
                token = credential
            }
        }
        let candidate = SavedConnection(id: "", label: label, url: url, token: token, lastUsedAt: 0, relay: relay)
        let (status, _) = try await send(makeRequest("/api/config/settings", connection: candidate), connection: candidate, tunnel: pairingTunnel)
        try checkCurrent()
        guard status == 200 else { throw NativeFailure.message("无法访问设备 (\(status))，请检查连接授权") }
        // Persist only after validation succeeds; failed writes preserve the selected connection.
        if let editingID, let editingVersion {
            try store.replace(id: editingID, version: editingVersion, url: url, token: token, label: args["label"] as? String ?? label, relay: relay)
        } else { try store.save(url: url, token: token, label: label, relay: relay) }
        let invalidated = editingID == nil || store.selected?.id == editingID
        if invalidated { stop() }
        await retryAuthorizationRetirements()
        var value = snapshot
        value["runtimeInvalidated"] = invalidated
        return value
    }
    private func stream(path: String, key: String, admission: HostAdmission) throws {
        guard ["global", "chat"].contains(key), path == "/api/yuri/events" || path.hasPrefix("/api/event?") else { throw NativeFailure.message("不支持的事件流") }
        let connection = admission.connection, scope = admission.generation, expected = admission.expectedHost
        try checkHost(connection, generation: scope, expected: expected)
        var request = try makeRequest(path, connection: connection)
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.timeoutInterval = 3600
        // Parsing, synchronous admission, route and request validation all precede
        // cancellation of a previously authorized same-key stream.
        streams.removeValue(forKey: key)?.cancel()
        let ticket = UUID(); streamTokens[key] = ticket
        streamScopes[key] = expected
        let current = { [weak self] in
            guard let self, self.streamTokens[key] == ticket, self.streamScopes[key] == expected else { return false }
            return (try? self.checkHost(connection, generation: scope, expected: expected)) != nil
        }
        streams[key] = Task { [weak self] in
            guard let self else { return }
            var delay: UInt64 = 1
            while !Task.isCancelled && current() {
                do {
                    let parser = SSEEvents { [weak self] data in
                        guard let self, current(), !Task.isCancelled else { return }
                        self.app?.send("runtime.event", ["data": data, "key": key, "expectedHost": expected.publicValue])
                    }
                    try self.checkHost(connection, generation: scope, expected: expected)
                    guard current() else { return }
                    if let relay = connection.relay {
                        let transport = try self.tunnel(for: relay)
                        _ = try await transport.stream(path: path, headers: request.allHTTPHeaderFields ?? [:], onResponse: { [self] status, headers in
                            try Task.checkCancellation()
                            guard status == 200, headers.first(where: { $0.key.lowercased() == "content-type" })?.value.lowercased().contains("text/event-stream") == true else { throw NativeFailure.message("事件连接失败") }
                            try await MainActor.run {
                                guard current() else { throw CancellationError() }
                                self.app?.send("runtime.event", ["type": "reconnected", "key": key, "expectedHost": expected.publicValue])
                            }
                        }, onData: { data in
                            try Task.checkCancellation()
                            try await MainActor.run {
                                guard current() else { throw CancellationError() }
                                try parser.consume(data)
                            }
                        })
                    } else {
                    let (bytes, response) = try await self.session.bytes(for: request)
                    defer { bytes.task.cancel() }
                    try Task.checkCancellation()
                    guard current() else { return }
                    guard let http = response as? HTTPURLResponse, http.statusCode == 200, http.value(forHTTPHeaderField: "Content-Type")?.contains("text/event-stream") == true else { throw NativeFailure.message("事件连接失败") }
                    delay = 1
                    self.app?.send("runtime.event", ["type": "reconnected", "key": key, "expectedHost": expected.publicValue])
                    // AsyncBytes.lines omits empty lines on some Foundation releases; SSE needs them.
                    for try await byte in bytes {
                        try Task.checkCancellation()
                        guard current() else { return }
                        try parser.consume(byte)
                    }
                    }
                    if !Task.isCancelled && current() { self.app?.send("runtime.disconnected", ["key": key, "expectedHost": expected.publicValue]) }
                } catch {
                    if Task.isCancelled || !current() { return }
                    self.app?.send("runtime.disconnected", ["key": key, "expectedHost": expected.publicValue])
                }
                try? await Task.sleep(nanoseconds: delay * 1_000_000_000)
                delay = min(delay * 2, 30)
            }
        }
    }
}

/// Terminal-only direct socket; no desktop/dictation inbox limit or behavior is
/// changed. RuntimeBridge alone constructs its authenticated same-origin request.
@MainActor private final class TerminalDirectConnection: NSObject, URLSessionWebSocketDelegate {
    private let request: URLRequest
    private let inbox = TerminalStreamInbox()
    private var session: URLSession?, wire: URLSessionWebSocketTask?, reader: Task<Void, Never>?
    private var ended = false, sending = false
    init(request: URLRequest) { self.request = request }
    func open() async throws {
        try Task.checkCancellation()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil; configuration.httpShouldSetCookies = false; configuration.urlCache = nil
        configuration.timeoutIntervalForRequest = 15; configuration.timeoutIntervalForResource = 7 * 24 * 3600
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil); self.session = session
        let task = session.webSocketTask(with: request); wire = task; task.maximumMessageSize = TerminalTransportWire.messageLimit; task.resume()
        do {
            try await withTaskCancellationHandler(operation: { try await inbox.waitOpen(); try Task.checkCancellation() }, onCancel: { Task { @MainActor in self.close() } })
        } catch { close(); throw TerminalTransportWire.failure(error) }
    }
    func receive() async throws -> TerminalWireMessage {
        try await withTaskCancellationHandler(operation: {
            try Task.checkCancellation(); let value = try await inbox.receive(); try Task.checkCancellation(); return value
        }, onCancel: { Task { @MainActor in self.close() } })
    }
    func send(_ value: TerminalWireMessage) async throws {
        guard !ended, !sending, let wire else { throw TerminalFailure.connectionFailed }
        let message: URLSessionWebSocketTask.Message
        switch value {
        case .text(let text): guard text.utf8.count <= TerminalTransportWire.inputLimit else { throw TerminalFailure.overflow }; message = .string(text)
        case .binary(let bytes): guard bytes.count <= TerminalTransportWire.inputLimit else { throw TerminalFailure.overflow }; message = .data(bytes)
        case .closed: throw TerminalFailure.invalid
        }
        sending = true; defer { sending = false }
        try await withTaskCancellationHandler(operation: { try Task.checkCancellation(); try await wire.send(message); try Task.checkCancellation(); guard !ended else { throw CancellationError() } }, onCancel: { Task { @MainActor in self.close() } })
    }
    func close(error: Error = CancellationError()) {
        guard !ended else { return }; ended = true; reader?.cancel(); reader = nil
        wire?.cancel(with: .goingAway, reason: nil); wire = nil; session?.invalidateAndCancel(); session = nil; inbox.fail(error)
    }
    nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
    nonisolated func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        Task { @MainActor in
            guard !self.ended else { return }
            do { try self.inbox.didOpen() } catch { self.close(error: error); return }
            self.reader = Task { [weak self] in
                guard let self else { return }
                do {
                    while !Task.isCancelled && !self.ended {
                        let message = try await webSocketTask.receive(); try Task.checkCancellation()
                        switch message {
                        case .string(let text): try self.inbox.push(.text(text))
                        case .data(let bytes): try self.inbox.push(.binary(bytes))
                        @unknown default: throw TerminalFailure.protocolViolation
                        }
                    }
                } catch {
                    if !self.ended { let code = webSocketTask.closeCode.rawValue; if code > 0 { try? self.inbox.push(.closed(code)); self.inbox.end(TerminalFailure.connectionFailed) } else { self.inbox.fail(error) } }
                }
            }
        }
    }
    nonisolated func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        Task { @MainActor in if !self.ended { try? self.inbox.push(.closed(closeCode.rawValue)); self.inbox.end(TerminalFailure.connectionFailed) } }
    }
    nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        Task { @MainActor in
            guard !self.ended else { return }
            if let response = task.response as? HTTPURLResponse, response.statusCode != 101 { self.close(error: TerminalFailure.connectionFailed) }
            else if let error, (task as? URLSessionWebSocketTask)?.closeCode.rawValue ?? 0 <= 0 { self.close(error: error) }
        }
    }
}

/// Runtime-owned direct socket. URLSession preserves logical message boundaries;
/// the bounded mailbox fails closed rather than silently dropping screen/control.
@MainActor private final class DesktopDirectConnection: NSObject, URLSessionWebSocketDelegate {
    private let request: URLRequest
    private let inbox = NativeSocketInbox()
    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private var reader: Task<Void, Never>?
    private var timer: Task<Void, Never>?
    private var ended = false
    private var sending = false
    private let incomingLimit: Int
    private let outgoingLimit: Int
    init(request: URLRequest, incomingLimit: Int = 512 * 1024, outgoingLimit: Int = 96 * 1024) { self.request = request; self.incomingLimit = incomingLimit; self.outgoingLimit = outgoingLimit }
    func open() async throws {
        try Task.checkCancellation()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil; configuration.httpShouldSetCookies = false; configuration.urlCache = nil
        configuration.timeoutIntervalForRequest = 20; configuration.timeoutIntervalForResource = 3600
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        self.session = session
        let wire = session.webSocketTask(with: request); task = wire
        wire.maximumMessageSize = incomingLimit
        timer = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 20_000_000_000) } catch { return }
            self?.close(error: RemoteDesktopBridgeFailure(code: "connection_failed"))
        }
        wire.resume()
        do {
            try await withTaskCancellationHandler(operation: {
                try await inbox.waitUntilOpen(); try Task.checkCancellation()
            }, onCancel: { Task { @MainActor in self.close() } })
            timer?.cancel(); timer = nil
        } catch { close(error: error); throw error }
    }
    func receive() async throws -> NativeSocketInbox.Message {
        try await withTaskCancellationHandler(operation: {
            try Task.checkCancellation()
            let message = try await inbox.receive()
            try Task.checkCancellation(); return message
        }, onCancel: { Task { @MainActor in self.close() } })
    }
    func send(_ text: String) async throws {
        try Task.checkCancellation()
        guard !ended, !sending, let task, text.utf8.count <= outgoingLimit else { throw RemoteDesktopBridgeFailure(code: "connection_failed") }
        sending = true
        defer { sending = false }
        let deadline = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 20_000_000_000) } catch { return }
            self?.close(error: RemoteDesktopBridgeFailure(code: "connection_failed"))
        }
        defer { deadline.cancel() }
        try await withTaskCancellationHandler(operation: {
            try await task.send(.string(text)); try Task.checkCancellation()
            guard !ended else { throw CancellationError() }
        }, onCancel: { Task { @MainActor in self.close() } })
    }
    func close(error: Error = CancellationError()) {
        guard !ended else { return }; ended = true
        timer?.cancel(); timer = nil; reader?.cancel(); reader = nil
        task?.cancel(with: .goingAway, reason: nil); task = nil
        session?.invalidateAndCancel(); session = nil
        Task { await inbox.fail(error) }
    }
    nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
    nonisolated func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        Task { @MainActor in
            guard !self.ended else { return }
            do { try await self.inbox.didOpen() } catch { self.close(error: error); return }
            self.reader = Task { [weak self] in
                guard let self else { return }
                do {
                    while !Task.isCancelled && !self.ended {
                        let message = try await webSocketTask.receive()
                        try Task.checkCancellation()
                        switch message {
                        case .string(let text): try await self.inbox.consume(type: 8, payload: Data(text.utf8))
                        case .data(let data): try await self.inbox.consume(type: 9, payload: data)
                        @unknown default: throw RelayTunnel.Failure.invalidFrame
                        }
                    }
                } catch {
                    if !self.ended {
                        let code = webSocketTask.closeCode.rawValue
                        if code > 0 { await self.inbox.end(code: code) }
                        self.close(error: RuntimeBridge.desktopError(error))
                    }
                }
            }
        }
    }
    nonisolated func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        Task { @MainActor in
            guard !self.ended else { return }
            await self.inbox.end(code: closeCode.rawValue); self.close()
        }
    }
    nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        Task { @MainActor in
            guard !self.ended else { return }
            if let response = task.response as? HTTPURLResponse, response.statusCode != 101 {
                self.close(error: RuntimeBridge.desktopFailure(status: response.statusCode))
            } else if let error {
                if let wire = task as? URLSessionWebSocketTask, wire.closeCode.rawValue > 0 { await self.inbox.end(code: wire.closeCode.rawValue) }
                self.close(error: RuntimeBridge.desktopError(error))
            }
        }
    }
}
