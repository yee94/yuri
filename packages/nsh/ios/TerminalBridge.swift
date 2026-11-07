import Foundation
import CoreFoundation

enum TerminalFailure: String, Error {
    case invalid, stale, unavailable, response, createUnknown, closeUnknown, connectionFailed, protocolViolation, inputUnknown, overflow, sessionNotFound
}

enum TerminalRequest {
    case create(directory: String, cols: Int, rows: Int)
    case resize(sessionID: String, cols: Int, rows: Int)
    case close(sessionID: String)
    case input(sessionID: String, text: String)
    case forceKill(sessionID: String)
    case probeURL(String)

    var method: String { if case .close = self { return "DELETE" }; return "POST" }
    var path: String {
        switch self {
        case .create: return "/api/terminal/create"
        case .resize(let id, _, _): return "/api/terminal/\(id)/resize"
        case .close(let id): return "/api/terminal/\(id)"
        case .input(let id, _): return "/api/terminal/\(id)/input"
        case .forceKill: return "/api/terminal/force-kill"
        case .probeURL: return "/api/system/probe-url"
        }
    }
    var body: [String: Any]? {
        switch self {
        case .create(let directory, let cols, let rows): return ["cwd": directory, "cols": cols, "rows": rows]
        case .resize(_, let cols, let rows): return ["cols": cols, "rows": rows]
        case .close: return nil
        case .input: return nil
        case .forceKill(let id): return ["sessionId": id]
        case .probeURL(let url): return ["url": url]
        }
    }
    var text: String? { if case .input(_, let text) = self { return text }; return nil }
    var contentType: String { text == nil ? "application/json" : "text/plain" }
}

enum TerminalWireMessage { case text(String), binary(Data), closed(Int) }
@MainActor struct TerminalSocket {
    let receive: () async throws -> TerminalWireMessage
    let send: (TerminalWireMessage) async throws -> Void
    let close: () -> Void
}
@MainActor struct TerminalEventStream {
    /// Exact authenticated GET /api/terminal/:id/stream, parsed SSE data objects.
    /// Owner must bound event bytes while decoding, ignore SSE comments, propagate
    /// HTTP 404 as sessionNotFound and close/cancel the underlying stream.
    let receive: () async throws -> [String: Any]
    let close: () -> Void
}

/// RuntimeBridge alone implements this contract after admit(expectedHost:). The
/// opaque RuntimeHostScope is issued by native and rotated across A→B→A/lifecycle.
/// No URL/credential is exposed. request uses authenticated JSON; open is EXACT
/// /api/terminal/ws, with origin/redirect policy, scoped URL auth as required, and
/// the existing authorized E2EE pairedRelay mux (never a direct fallback).
/// Bound receive DURING receipt to 1 MiB and cancel all work when isCurrent changes.
@MainActor struct TerminalTransport {
    let expectedHost: RuntimeHostScope
    let isCurrent: () -> Bool
    let request: (TerminalRequest) async throws -> (status: Int, body: [String: Any])
    let open: () async throws -> TerminalSocket
    var stream: ((String) async throws -> TerminalEventStream)? = nil
    /// Authenticated GET /api/fs/read?path=<directory/name>&directory=...&optional=true.
    /// name is from the fixed allowlist below. nil means authoritative absent ONLY.
    var optionalFile: ((String, String) async throws -> String?)? = nil
    /// Authenticated GET /api/system/free-port. No process is started here.
    var freePort: (() async throws -> Int?)? = nil
    var supportsWebSocket = true
}

enum TerminalProtocol {
    static func loopback(_ value: String) -> Bool {
        guard value.utf8.count <= 8192, !value.unicodeScalars.contains(where: { $0.value <= 32 || $0.value == 127 }), !value.contains("\\"),
              let url = URLComponents(string: value), ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
              ["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "[::]", "::1", "::"].contains(url.host?.lowercased() ?? ""), url.user == nil, url.password == nil,
              url.port.map({ (1...65535).contains($0) }) ?? true else { return false }
        return !(url.queryItems ?? []).contains { ["token", "access_token", "authorization", "password", "secret", "yuri_client_token", "yuri_url_token"].contains($0.name.lowercased()) }
    }
    static func integer(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite,
              number.doubleValue.rounded() == number.doubleValue, abs(number.doubleValue) <= 9_007_199_254_740_991 else { return nil }
        return number.intValue
    }
    static func directory(_ value: String) -> Bool {
        guard value.hasPrefix("/"), !value.hasPrefix("//"), !value.contains("\\"),
              !value.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else { return false }
        return value == "/" || !value.dropFirst().split(separator: "/", omittingEmptySubsequences: false).contains(where: { $0.isEmpty || $0 == "." || $0 == ".." })
    }
    static func identifier(_ value: String) -> Bool {
        value.range(of: "^[a-zA-Z0-9_-]{1,128}$", options: .regularExpression) != nil
    }
    static func size(_ body: [String: Any]) throws -> (Int, Int) {
        guard let cols = integer(body["cols"]), let rows = integer(body["rows"]), (2...1000).contains(cols), (1...1000).contains(rows) else { throw TerminalFailure.invalid }
        return (cols, rows)
    }
    static func frame(_ object: [String: Any]) throws -> TerminalWireMessage {
        var data = Data([1]); data.append(try JSONSerialization.data(withJSONObject: object)); return .binary(data)
    }
    static func control(_ message: TerminalWireMessage) throws -> [String: Any]? {
        switch message {
        case .binary(let bytes):
            guard bytes.count <= 1_048_576, bytes.first == 1,
                  let value = try JSONSerialization.jsonObject(with: bytes.dropFirst()) as? [String: Any], value["t"] is String else { throw TerminalFailure.protocolViolation }
            return value
        case .text(let text):
            guard text.utf8.count <= 1_048_576 else { throw TerminalFailure.overflow }; return nil
        case .closed: throw TerminalFailure.connectionFailed
        }
    }
}

/// Metadata-only local journal. No lease, output, command, token or transport URL is Codable.
final class TerminalCatalogStore {
    private let url: URL
    init(url: URL? = nil) {
        self.url = url ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("YuriNative/terminal-catalog-v1.json")
    }
    private func all() throws -> [String: [String: Any]] {
        guard FileManager.default.fileExists(atPath: url.path) else { return [:] }
        let bytes = try Data(contentsOf: url)
        guard bytes.count <= 4_194_304, let values = try JSONSerialization.jsonObject(with: bytes) as? [String: [String: Any]], values.count <= 64 else { throw TerminalFailure.response }
        return values
    }
    func read(hostID: String) throws -> [String: Any] {
        let value = try all()[hostID] ?? ["schema": 1, "hostID": hostID, "directories": []]
        try validate(value, hostID: hostID); return value
    }
    func validate(_ value: [String: Any], hostID: String) throws {
        guard Set(value.keys) == ["schema", "hostID", "directories"], TerminalProtocol.integer(value["schema"]) == 1,
              value["hostID"] as? String == hostID, let directories = value["directories"] as? [[String: Any]], directories.count <= 128 else { throw TerminalFailure.invalid }
        var ids = Set<String>(), paths = Set<String>()
        for entry in directories {
            guard Set(entry.keys) == ["directory", "activeId", "tabs"], let path = entry["directory"] as? String, TerminalProtocol.directory(path), paths.insert(path).inserted,
                  let active = entry["activeId"] as? String, let tabs = entry["tabs"] as? [[String: Any]], !tabs.isEmpty, tabs.count <= 64 else { throw TerminalFailure.invalid }
            var containsActive = false
            for tab in tabs {
                guard Set(tab.keys).isSubset(of: ["id", "sessionId", "label", "iconKey", "lifecycle", "createUnknown"]),
                      let id = tab["id"] as? String, TerminalProtocol.identifier(id), ids.insert(id).inserted,
                      ["idle", "running", "exited"].contains(tab["lifecycle"] as? String ?? ""),
                      tab["sessionId"] == nil || (tab["sessionId"] as? String).map(TerminalProtocol.identifier) == true,
                      tab["label"] == nil || (tab["label"] as? String).map({ $0.utf8.count <= 1024 }) == true,
                      tab["iconKey"] == nil || (tab["iconKey"] as? String).map({ $0.utf8.count <= 128 }) == true,
                      tab["createUnknown"] == nil || tab["createUnknown"] is Bool else { throw TerminalFailure.invalid }
                containsActive = containsActive || id == active
            }
            guard containsActive else { throw TerminalFailure.invalid }
        }
    }
    func write(_ input: Any?, hostID: String) throws {
        guard let value = input as? [String: Any] else { throw TerminalFailure.invalid }
        try validate(value, hostID: hostID)
        var values = try all(); values[hostID] = value
        let bytes = try JSONSerialization.data(withJSONObject: values)
        guard values.count <= 64, bytes.count <= 4_194_304 else { throw TerminalFailure.overflow }
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try bytes.write(to: url, options: .atomic)
    }
    func contains(hostID: String, owner: String, directory: String, sessionID: String) throws -> Bool {
        let value = try read(hostID: hostID)
        return (value["directories"] as? [[String: Any]] ?? []).contains { entry in
            entry["directory"] as? String == directory && (entry["tabs"] as? [[String: Any]] ?? []).contains { $0["id"] as? String == owner && $0["sessionId"] as? String == sessionID }
        }
    }
    func remember(hostID: String, owner: String, directory: String, sessionID: String) throws {
        var value = try read(hostID: hostID), directories = value["directories"] as? [[String: Any]] ?? []
        let index = directories.firstIndex { $0["directory"] as? String == directory }
        var entry = index.map { directories[$0] } ?? ["directory": directory, "activeId": owner, "tabs": []]
        var tabs = entry["tabs"] as? [[String: Any]] ?? []
        if let tabIndex = tabs.firstIndex(where: { $0["id"] as? String == owner }) { tabs[tabIndex]["sessionId"] = sessionID; tabs[tabIndex]["lifecycle"] = "running"; tabs[tabIndex].removeValue(forKey: "createUnknown") }
        else { tabs.append(["id": owner, "sessionId": sessionID, "lifecycle": "running"]) }
        entry["tabs"] = tabs
        if let index { directories[index] = entry } else { directories.append(entry) }
        value["directories"] = directories; try write(value, hostID: hostID)
    }
    func forget(hostID: String, owner: String) throws {
        var value = try read(hostID: hostID), directories = value["directories"] as? [[String: Any]] ?? []
        for index in directories.indices {
            var tabs = directories[index]["tabs"] as? [[String: Any]] ?? []
            for tab in tabs.indices where tabs[tab]["id"] as? String == owner {
                tabs[tab].removeValue(forKey: "sessionId"); tabs[tab].removeValue(forKey: "createUnknown"); tabs[tab]["lifecycle"] = "exited"
            }
            directories[index]["tabs"] = tabs
        }
        value["directories"] = directories; try write(value, hostID: hostID)
    }
}

/// Foundation-only PTY owner. It never opens a shell, network session, or reads credentials.
/// Detach/background closes only sockets. DELETE is exclusive to explicit terminal.close.
@MainActor final class TerminalBridge {
    private final class Session {
        let owner: String
        let directory: String
        let transport: TerminalTransport
        var id: String?
        var createUnknown = false
        var closing = false
        var createTask: Task<String, Error>?
        var reader: Task<Void, Never>?
        var timer: Task<Void, Never>?
        var heartbeat: Task<Void, Never>?
        var writer: Task<Void, Error>?
        var queuedBytes = 0
        var socket: TerminalSocket?
        var stream: TerminalEventStream?
        var sse = false
        var preferSSE = false
        var httpInput = false
        var missing = false
        var outputID = 0
        var attempt = UUID()
        var bound = false
        var exited = false
        var cursor = 0
        var attachment = 0
        init(owner: String, directory: String, transport: TerminalTransport) {
            self.owner = owner; self.directory = directory; self.transport = transport
        }
    }
    private let capture: (RuntimeHostScope) throws -> TerminalTransport
    private let emit: ([String: Any]) -> Void
    private var sessions: [String: Session] = [:]
    private var foreground = true
    private let catalog: TerminalCatalogStore
    init(capture: @escaping (RuntimeHostScope) throws -> TerminalTransport, emit: @escaping ([String: Any]) -> Void, catalog: TerminalCatalogStore = TerminalCatalogStore()) {
        self.capture = capture; self.emit = emit; self.catalog = catalog
    }
    private func authority(_ body: [String: Any]) throws -> RuntimeHostScope {
        try RuntimeHostScope(body["expectedHost"])
    }
    func admitted(_ expected: RuntimeHostScope) throws -> TerminalTransport {
        let transport = try capture(expected)
        guard transport.expectedHost == expected, transport.isCurrent() else { throw TerminalFailure.stale }
        return transport
    }
    private func owned(_ body: [String: Any], interactive: Bool = true) throws -> Session {
        guard let owner = body["owner"] as? String, let value = sessions[owner],
              value.transport.expectedHost == (try authority(body)), value.transport.isCurrent(),
              body["directory"] as? String == value.directory,
              body["sessionId"] == nil || body["sessionId"] is NSNull || body["sessionId"] as? String == value.id,
              !interactive || foreground else { throw TerminalFailure.stale }
        _ = try admitted(value.transport.expectedHost)
        return value
    }
    private func current(_ value: Session, _ attempt: UUID) -> Bool {
        sessions[value.owner] === value && foreground && value.transport.isCurrent() && value.attempt == attempt && !value.closing
    }
    private func event(_ value: Session, _ type: String, _ fields: [String: Any] = [:]) {
        guard value.transport.isCurrent() else { return }
        var body = fields; body["type"] = type; body["owner"] = value.owner; body["sessionId"] = value.id
        body["expectedHost"] = value.transport.expectedHost.publicValue
        body["attachment"] = value.attachment
        emit(body)
    }
    private func stop(_ value: Session) {
        value.attempt = UUID(); value.bound = false
        value.reader?.cancel(); value.reader = nil; value.timer?.cancel(); value.timer = nil
        value.heartbeat?.cancel(); value.heartbeat = nil; value.writer?.cancel(); value.writer = nil
        value.socket?.close(); value.socket = nil
        value.stream?.close(); value.stream = nil; value.sse = false
    }
    func setForeground(_ active: Bool) {
        foreground = active
        for value in sessions.values where !value.exited && !value.closing {
            if !active { stop(value); event(value, "paused") }
            else { event(value, "resume") }
        }
        // Resume is only a demand hint. Only the active page controller may attach;
        // failure/exit does not automatically resurrect or replay input.
    }
    func invalidate() { for value in sessions.values { stop(value) }; sessions.removeAll() }

    func call(_ name: String, _ body: [String: Any]) async throws -> Any {
        if name == "terminal.capabilities" {
            let transport = try admitted(try authority(body))
            return ["schema": 1, "wsVersion": 2, "wsAvailable": transport.supportsWebSocket, "httpInput": true, "sseOutput": transport.stream != nil, "durableMetadata": true, "actionDiscovery": transport.optionalFile != nil && transport.freePort != nil, "scope": "native-opaque"]
        }
        if name == "terminal.discovery.file" || name == "terminal.discovery.port" {
            let transport = try admitted(try authority(body))
            if name == "terminal.discovery.port" {
                guard let read = transport.freePort else { throw TerminalFailure.unavailable }
                let port = try await read(); guard transport.isCurrent() else { throw TerminalFailure.stale }
                if let port { guard (1...65535).contains(port) else { throw TerminalFailure.response }; return port }
                return NSNull()
            }
            guard let directory = body["directory"] as? String, TerminalProtocol.directory(directory), let file = body["file"] as? String,
                  ["package.json", "bun.lock", "bun.lockb", "pnpm-lock.yaml", "yarn.lock", "package-lock.json", "index.html"].contains(file), let read = transport.optionalFile else { throw TerminalFailure.invalid }
            let text = try await read(directory, file); guard transport.isCurrent() else { throw TerminalFailure.stale }
            if let text { guard text.utf8.count <= 1_048_576 else { throw TerminalFailure.overflow }; return text }
            return NSNull()
        }
        if name == "terminal.detach" {
            // Cleanup checks the originally registered authority without new admission.
            // A delayed old workspace cannot stop a restored Tab on a new lease.
            let expected = try authority(body)
            guard let owner = body["owner"] as? String, TerminalProtocol.identifier(owner),
                  let attachment = TerminalProtocol.integer(body["attachment"]), attachment > 0 else { throw TerminalFailure.invalid }
            guard let value = sessions[owner], value.transport.expectedHost == expected, attachment == value.attachment else { return true }
            stop(value); return true
        }
        if name == "terminal.catalog.read" || name == "terminal.catalog.write" || name == "terminal.restore" {
            let expected = try authority(body), transport = try admitted(expected)
            if name == "terminal.catalog.read" { return try catalog.read(hostID: expected.hostID) }
            if name == "terminal.catalog.write" {
                if let catalogValue = body["catalog"] as? [String: Any], let entries = catalogValue["directories"] as? [[String: Any]] {
                    for entry in entries { for tab in entry["tabs"] as? [[String: Any]] ?? [] {
                        if let id = tab["sessionId"] as? String {
                            guard let owner = tab["id"] as? String, let directory = entry["directory"] as? String else { throw TerminalFailure.invalid }
                            let known = sessions[owner].map { $0.id == id && $0.directory == directory && $0.transport.expectedHost == expected } == true
                            if !known { guard try catalog.contains(hostID: expected.hostID, owner: owner, directory: directory, sessionID: id) else { throw TerminalFailure.invalid } }
                        }
                    } }
                }
                guard var journal = body["catalog"] as? [String: Any], var entries = journal["directories"] as? [[String: Any]] else { throw TerminalFailure.invalid }
                // A metadata write queued before create's receipt must not erase
                // the stronger native receipt when its completion arrives late.
                for index in entries.indices {
                    var tabs = entries[index]["tabs"] as? [[String: Any]] ?? []
                    for tab in tabs.indices {
                        if let owner = tabs[tab]["id"] as? String, let value = sessions[owner], value.transport.expectedHost == expected, !value.exited, let id = value.id {
                            tabs[tab]["sessionId"] = id; tabs[tab]["lifecycle"] = "running"; tabs[tab].removeValue(forKey: "createUnknown")
                        }
                    }
                    entries[index]["tabs"] = tabs
                }
                journal["directories"] = entries
                try catalog.write(journal, hostID: expected.hostID)
                return true
            }
            guard let owner = body["owner"] as? String, TerminalProtocol.identifier(owner), let directory = body["directory"] as? String,
                  let id = body["sessionId"] as? String, try catalog.contains(hostID: expected.hostID, owner: owner, directory: directory, sessionID: id) else { throw TerminalFailure.invalid }
            if let existing = sessions[owner] {
                guard existing.transport.expectedHost == expected, existing.id == id, existing.directory == directory else { throw TerminalFailure.stale }
            } else { let value = Session(owner: owner, directory: directory, transport: transport); value.id = id; sessions[owner] = value }
            return ["sessionId": id]
        }
        if name == "terminal.probe" {
            let transport = try admitted(try authority(body))
            guard let url = body["url"] as? String, TerminalProtocol.loopback(url) else { throw TerminalFailure.invalid }
            let response = try await transport.request(.probeURL(url))
            guard transport.isCurrent() else { throw TerminalFailure.stale }
            guard (200..<300).contains(response.status), let ok = response.body["ok"] as? Bool else { throw TerminalFailure.response }
            return ok
        }
        if name == "terminal.create" { return try await create(body) }
        let value = try owned(body, interactive: name != "terminal.detach" && name != "terminal.close")
        switch name {
        case "terminal.attach":
            guard !value.closing, !value.exited, let id = value.id, let cursor = TerminalProtocol.integer(body["cursor"]), cursor >= 0,
                  let attachment = TerminalProtocol.integer(body["attachment"]), attachment > value.attachment else { throw TerminalFailure.invalid }
            stop(value); value.cursor = cursor; value.attachment = attachment
            let attempt = value.attempt
            value.reader = Task { [weak self, weak value] in
                guard let self, let value else { return }
                do {
                    if value.preferSSE { try await self.receiveSSE(value, attempt, id); return }
                    let socket: TerminalSocket
                    do { socket = try await value.transport.open() }
                    catch {
                        guard self.current(value, attempt) else { return }
                        // No input was written on this failed upgrade. Only this
                        // unambiguous pre-bind failure may select SSE/HTTP.
                        if value.transport.stream != nil { try await self.receiveSSE(value, attempt, id); return }
                        throw error
                    }
                    guard self.current(value, attempt), !Task.isCancelled else { socket.close(); return }
                    value.socket = socket
                    try await self.send(value, attempt, TerminalProtocol.frame(["t": "b", "s": id, "r": cursor, "v": 2]), bytes: 256)
                    self.deadline(value, attempt, seconds: 15)
                    value.heartbeat = Task { [weak self, weak value] in
                        while !Task.isCancelled {
                            do { try await Task.sleep(nanoseconds: 20_000_000_000) } catch { return }
                            guard let self, let value, self.current(value, attempt) else { return }
                            do { try await self.send(value, attempt, TerminalProtocol.frame(["t": "p", "v": 2]), bytes: 64) }
                            catch { self.failed(value, attempt, "connection_failed"); return }
                        }
                    }
                    while self.current(value, attempt), !Task.isCancelled {
                        let message = try await socket.receive()
                        guard self.current(value, attempt), !Task.isCancelled else { return }
                        try self.receive(message, value, attempt)
                    }
                } catch { self.failed(value, attempt, error as? TerminalFailure == .sessionNotFound ? "session_not_found" : "connection_failed") }
            }
            // The deadline also covers an open() that never completes. Late sockets close above.
            deadline(value, attempt, seconds: 15)
            return true
        case "terminal.input":
            guard value.bound, !value.closing, let text = body["data"] as? String, !text.isEmpty, text.utf8.count <= 65_536 else { throw TerminalFailure.invalid }
            let attempt = value.attempt
            do {
                if value.sse || value.httpInput {
                    guard value.queuedBytes + text.utf8.count <= 262_144 else { throw TerminalFailure.overflow }
                    value.queuedBytes += text.utf8.count
                    defer { value.queuedBytes -= text.utf8.count }
                    let prior = value.writer
                    let writer = Task { @MainActor in
                        if let prior { try await prior.value }
                        guard self.current(value, attempt) else { throw TerminalFailure.stale }
                        let response = try await value.transport.request(.input(sessionID: value.id!, text: text))
                        guard self.current(value, attempt), (200..<300).contains(response.status), response.body["success"] as? Bool == true else { throw TerminalFailure.inputUnknown }
                    }
                    value.writer = writer; try await writer.value
                } else { try await send(value, attempt, .text(text), bytes: text.utf8.count) }
            }
            catch { failed(value, attempt, "input_unknown"); throw TerminalFailure.inputUnknown }
            return true
        case "terminal.resize":
            guard value.bound, !value.closing, let id = value.id else { throw TerminalFailure.invalid }
            let (cols, rows) = try TerminalProtocol.size(body)
            let response = try await value.transport.request(.resize(sessionID: id, cols: cols, rows: rows))
            guard value.transport.isCurrent() else { throw TerminalFailure.stale }
            guard (200..<300).contains(response.status), response.body["success"] as? Bool == true else { throw TerminalFailure.response }
            return true
        case "terminal.close", "terminal.forceKill":
            guard !value.closing else { throw TerminalFailure.closeUnknown }; value.closing = true; stop(value)
            defer { value.closing = false }
            if let pending = value.createTask { _ = try? await pending.value }
            guard value.transport.isCurrent() else { throw TerminalFailure.stale }
            if let id = value.id {
                let response = try await value.transport.request(name == "terminal.forceKill" ? .forceKill(sessionID: id) : .close(sessionID: id))
                guard value.transport.isCurrent() else { throw TerminalFailure.stale }
                guard response.status == 404 || (200..<300).contains(response.status) && response.body["success"] as? Bool == true else { throw TerminalFailure.closeUnknown }
            } else if value.createUnknown { throw TerminalFailure.closeUnknown }
            try catalog.forget(hostID: value.transport.expectedHost.hostID, owner: value.owner)
            sessions.removeValue(forKey: value.owner)
            return ["closed": true]
        default: throw TerminalFailure.invalid
        }
    }
    private func create(_ body: [String: Any]) async throws -> [String: Any] {
        let expected = try authority(body)
        guard foreground, let owner = body["owner"] as? String, TerminalProtocol.identifier(owner),
              let directory = body["directory"] as? String, TerminalProtocol.directory(directory) else { throw TerminalFailure.invalid }
        if let prior = sessions[owner] {
            guard prior.missing, prior.transport.expectedHost == expected else { throw TerminalFailure.invalid }
            stop(prior); sessions.removeValue(forKey: owner)
        }
        let (cols, rows) = try TerminalProtocol.size(body)
        let transport = try admitted(expected)
        let value = Session(owner: owner, directory: directory, transport: transport); sessions[owner] = value
        let task = Task<String, Error> {
            guard transport.isCurrent(), !Task.isCancelled else { throw TerminalFailure.stale }
            let response = try await transport.request(.create(directory: directory, cols: cols, rows: rows))
            guard transport.isCurrent() else { throw TerminalFailure.stale }
            guard (200..<300).contains(response.status), let id = response.body["sessionId"] as? String, TerminalProtocol.identifier(id) else { throw TerminalFailure.response }
            value.id = id
            if let capabilities = response.body["capabilities"] as? [String: Any] {
                value.preferSSE = Self.explicitlyNonWS(capabilities["stream"])
                value.httpInput = Self.explicitlyNonWS(capabilities["input"])
            }
            try self.catalog.remember(hostID: expected.hostID, owner: owner, directory: directory, sessionID: id)
            return id
        }
        value.createTask = task
        do {
            let id = try await task.value; value.createTask = nil
            guard transport.isCurrent() else { throw TerminalFailure.stale }
            return ["sessionId": id]
        } catch { value.createTask = nil; value.createUnknown = true; throw TerminalFailure.createUnknown }
    }
    private func send(_ value: Session, _ attempt: UUID, _ message: TerminalWireMessage, bytes: Int) async throws {
        guard current(value, attempt), let socket = value.socket, value.queuedBytes + bytes <= 262_144 else { throw TerminalFailure.overflow }
        value.queuedBytes += bytes
        defer { value.queuedBytes -= bytes }
        let prior = value.writer
        let write = Task { @MainActor in
            if let prior { try await prior.value }
            guard self.current(value, attempt), !Task.isCancelled else { throw TerminalFailure.stale }
            try await socket.send(message)
            guard self.current(value, attempt) else { throw TerminalFailure.stale }
        }
        value.writer = write
        try await write.value
    }
    private func deadline(_ value: Session, _ attempt: UUID, seconds: UInt64) {
        value.timer?.cancel()
        value.timer = Task { [weak self, weak value] in
            do { try await Task.sleep(nanoseconds: seconds * 1_000_000_000) } catch { return }
            guard let self, let value else { return }; self.failed(value, attempt, "connection_failed")
        }
    }
    private func failed(_ value: Session, _ attempt: UUID, _ code: String) {
        guard current(value, attempt) else { return }; value.missing = code == "session_not_found"; stop(value); event(value, "error", ["code": code])
    }
    private func receive(_ message: TerminalWireMessage, _ value: Session, _ attempt: UUID) throws {
        if let control = try TerminalProtocol.control(message) {
            let type = control["t"] as? String ?? ""
            if ["bok", "d", "x"].contains(type), control["s"] as? String != value.id { throw TerminalFailure.protocolViolation }
            switch type {
            case "ok", "po": break
            case "bok":
                guard TerminalProtocol.integer(control["v"]) == 2 else { throw TerminalFailure.protocolViolation }
                value.bound = true; event(value, "connected", ["transport": "ws"])
            case "d":
                guard value.bound, let id = TerminalProtocol.integer(control["i"]), id > 0, let data = control["d"] as? String else { throw TerminalFailure.protocolViolation }
                if id > value.cursor {
                    let gap = id > value.cursor + 1; value.cursor = id; value.outputID += 1
                    event(value, "data", ["id": value.outputID, "cursor": id, "data": data, "replayGap": gap])
                }
            case "x":
                value.exited = true; stop(value)
                var fields: [String: Any] = [:]
                if let code = TerminalProtocol.integer(control["exitCode"]) { fields["exitCode"] = code }
                if let signal = TerminalProtocol.integer(control["signal"]) { fields["signal"] = signal }
                event(value, "exit", fields); return
            case "e": value.missing = control["c"] as? String == "SESSION_NOT_FOUND"; failed(value, attempt, value.missing ? "session_not_found" : "connection_failed"); return
            default: throw TerminalFailure.protocolViolation
            }
        } else if case .text(let text) = message {
            // v2 Host uses tagged output only. Do not invent replay IDs for legacy raw output.
            if !text.isEmpty { throw TerminalFailure.protocolViolation }
        }
        if current(value, attempt), value.bound { deadline(value, attempt, seconds: 60) }
    }
    private static func explicitlyNonWS(_ input: Any?) -> Bool {
        guard let value = input as? [String: Any] else { return false }
        let transports = value["transports"] as? [String] ?? []
        return value["preferred"] as? String != "ws" && !transports.contains("ws")
    }
    private func receiveSSE(_ value: Session, _ attempt: UUID, _ id: String) async throws {
        guard let stream = value.transport.stream else { throw TerminalFailure.unavailable }
        let source = try await stream(id)
        guard current(value, attempt), !Task.isCancelled else { source.close(); return }
        value.stream = source; value.sse = true; deadline(value, attempt, seconds: 15)
        while current(value, attempt), !Task.isCancelled {
            let data = try await source.receive()
            guard current(value, attempt), !Task.isCancelled else { return }
            switch data["type"] as? String {
            case "connected": value.bound = true; value.timer?.cancel(); value.timer = nil; event(value, "connected", ["transport": "sse", "replayUnavailable": true])
            case "data":
                guard value.bound, let text = data["data"] as? String, text.utf8.count <= 1_048_576 else { throw TerminalFailure.protocolViolation }
                value.outputID += 1; event(value, "data", ["id": value.outputID, "cursor": value.cursor, "data": text, "transport": "sse"])
            case "exit":
                value.exited = true; stop(value)
                var fields: [String: Any] = [:]
                if let code = TerminalProtocol.integer(data["exitCode"]) { fields["exitCode"] = code }
                if let signal = TerminalProtocol.integer(data["signal"]) { fields["signal"] = signal }
                event(value, "exit", fields); return
            default: throw TerminalFailure.protocolViolation
            }
        }
    }
}

#if canImport(NativeShell)
import NativeShell

@MainActor extension TerminalBridge {
    func register(app: NshAppView) {
        for name in ["terminal.capabilities", "terminal.discovery.file", "terminal.discovery.port", "terminal.catalog.read", "terminal.catalog.write", "terminal.restore", "terminal.probe", "terminal.create", "terminal.attach", "terminal.detach", "terminal.input", "terminal.resize", "terminal.close", "terminal.forceKill"] {
            app.handle(name) { [weak self] input async throws -> Any? in
                guard let self, let body = input as? [String: Any] else { throw TerminalFailure.invalid }
                return try await self.call(name, body)
            }
        }
    }
}
#endif
