import Foundation
import NativeShell

@main struct TerminalRuntimeHarness {
    @MainActor static func main() async throws {
        let mode = CommandLine.arguments[1], relayMode = CommandLine.arguments[2] == "relay"
        let store = try ConnectionStore(), app = NshAppView()
        let relay = RelayConfiguration(relayUrl: "ws://127.0.0.1:1", serverId: "memory", hostEncPubJwk: [:])
        try store.save(url: URL(string: "http://127.0.0.1:1")!, token: "synthetic-credential", label: "Fixture", relay: relayMode ? relay : nil)
        var requests: [URLRequest] = [], sockets = 0, closed = 0, writes = 0
        var waiting: CheckedContinuation<TerminalHTTPResponse, Error>?, lateSocket: CheckedContinuation<TerminalSocket, Error>?
        var sendWaiting: CheckedContinuation<Void, Error>?
        var hasWaiting = false
        func json(_ body: [String: Any], status: Int = 200, headers: [String: String] = [:]) throws -> TerminalHTTPResponse {
            TerminalHTTPResponse(status: status, headers: ["Content-Type": "application/json"].merging(headers) { _, new in new }, data: try JSONSerialization.data(withJSONObject: body))
        }
        let raw = TerminalSocket(receive: { .binary(Data(repeating: 7, count: mode == "incoming-limit" ? 1_048_577 : 1_048_576)) }, send: { _ in
            writes += 1
            if mode == "cancel-send" { try await withCheckedThrowingContinuation { sendWaiting = $0; hasWaiting = true } }
        }, close: { closed += 1 })
        let io = TerminalRuntimeIO(http: { request, candidate, limit in
            requests.append(request); precondition((candidate != nil) == relayMode)
            precondition(request.value(forHTTPHeaderField: "Authorization") == "Bearer synthetic-credential")
            if request.url?.path == "/auth/url-token" {
                if mode == "mint-bearer" { return try json(["token": "synthetic-credential", "expiresAt": Date().timeIntervalSince1970 * 1000 + 60000]) }
                return try json(["token": "scoped-fixture-token", "expiresAt": Date().timeIntervalSince1970 * 1000 + 60000])
            }
            if mode == "cancel-http" || mode == "retire-http" {
                return try await withCheckedThrowingContinuation { waiting = $0; hasWaiting = true }
            }
            if mode == "redirect" { return TerminalHTTPResponse(status: 302, headers: ["Location": "https://not-contacted.invalid"], data: Data()) }
            if mode == "oversize" { return TerminalHTTPResponse(status: 200, headers: ["Content-Type": "application/json"], data: Data(repeating: 32, count: limit + 1)) }
            if request.url?.path == "/api/fs/read" {
                return TerminalHTTPResponse(status: mode == "optional-failure" ? 500 : 200, headers: ["Content-Type": "text/plain; charset=utf-8", "X-Yuri-File-Exists": mode == "optional-missing" ? "false" : "true"], data: Data())
            }
            if request.url?.path == "/api/system/free-port" { return try json(["port": mode == "bad-port" ? 0 : 8123]) }
            return try json(["success": true])
        }, socket: { request, candidate, token in
            sockets += 1
            precondition(request.url?.path == "/api/terminal/ws" && request.url?.query == nil)
            precondition(token == (relayMode ? "scoped-fixture-token" : nil))
            if !relayMode { precondition(request.value(forHTTPHeaderField: "Origin") == "http://127.0.0.1:1") }
            if mode == "late-open" || mode == "late-open-retire" { return try await withCheckedThrowingContinuation { lateSocket = $0; hasWaiting = true } }
            return raw
        })
        let runtime = RuntimeBridge(app: app, store: store, terminalIO: io)
        runtime.setForeground(true)
        let scope = try RuntimeHostScope(runtime.snapshot["runtimeScope"])
        let transport = try runtime.terminalTransport(expectedHost: scope)
        func reject(_ operation: () async throws -> Void) async throws {
            do { try await operation() } catch { return }; throw TerminalFailure.invalid
        }
        switch mode {
        case "routes":
            _ = try await transport.request(.input(sessionID: "pty", text: "中文\u{0}\r\n"))
            precondition(requests.last!.httpBody == Data("中文\u{0}\r\n".utf8) && requests.last!.value(forHTTPHeaderField: "Content-Type") == "text/plain")
            _ = try await transport.request(.forceKill(sessionID: "pty")); precondition(requests.last!.url!.path == "/api/terminal/force-kill")
            _ = try await transport.request(.close(sessionID: "pty")); precondition(requests.last!.httpMethod == "DELETE")
            let socket = try await transport.open(); try await socket.send(.binary(Data([1, 123, 125]))); try await socket.send(.text("中文"))
            let message = try await socket.receive(); if case .binary(let bytes) = message { precondition(bytes.count == 1_048_576) } else { throw TerminalFailure.invalid }; socket.close()
            precondition(writes == 2 && closed == 1)
        case "optional-missing", "optional-empty", "optional-failure":
            if mode == "optional-failure" { try await reject { _ = try await transport.optionalFile!("/tree 中文", "package.json") } }
            else { let value = try await transport.optionalFile!("/tree 中文", "package.json"); precondition(mode == "optional-missing" ? value == nil : value == "") }
            let query = URLComponents(url: requests.last!.url!, resolvingAgainstBaseURL: true)!.queryItems!
            precondition(query.first { $0.name == "directory" }?.value == "/tree 中文")
        case "port": let port = try await transport.freePort!(); precondition(port == 8123)
        case "bad-port": try await reject { _ = try await transport.freePort!() }
        case "redirect", "oversize": try await reject { _ = try await transport.request(.close(sessionID: "pty")) }
        case "invalid":
            for operation in [TerminalRequest.close(sessionID: "../other"), .input(sessionID: "pty", text: String(repeating: "x", count: 65537)), .forceKill(sessionID: ""), .create(directory: "/a/../b", cols: 80, rows: 24)] { try await reject { _ = try await transport.request(operation) } }
            precondition(requests.isEmpty)
        case "stale":
            runtime.stop(); let newScope = try RuntimeHostScope(runtime.snapshot["runtimeScope"]); precondition(scope != newScope)
            try await reject { _ = try runtime.terminalTransport(expectedHost: scope) }; try await reject { _ = try await transport.request(.close(sessionID: "pty")) }; precondition(requests.isEmpty)
        case "a-b-a":
            let a = store.selected!.id
            try store.save(url: URL(string: "http://127.0.0.1:2")!, token: "synthetic-b", label: "B"); runtime.stop()
            try store.select(a); runtime.stop()
            try await reject { _ = try runtime.terminalTransport(expectedHost: scope) }; try await reject { _ = try await transport.request(.close(sessionID: "pty")) }; precondition(requests.isEmpty)
        case "background":
            runtime.setForeground(false)
            try await reject { _ = try runtime.terminalTransport(expectedHost: scope) }; try await reject { _ = try await transport.open() }; precondition(requests.isEmpty && sockets == 0)
        case "credential-change":
            let selected = store.selected!
            try store.replace(id: selected.id, version: selected.editorVersion!, url: selected.url, token: selected.token, label: selected.label, relay: selected.relay)
            precondition(!transport.isCurrent())
            try await reject { _ = try await transport.request(.input(sessionID: "pty", text: "stale")) }; precondition(requests.isEmpty)
        case "cancel-http", "retire-http":
            let task = Task { try await transport.request(.input(sessionID: "pty", text: "once")) }
            while !hasWaiting { await Task.yield() }
            if mode == "cancel-http" { task.cancel() } else { runtime.stop() }
            try await reject { _ = try await task.value }
            waiting?.resume(returning: try json(["success": true])); waiting = nil
            precondition(requests.filter { $0.url?.path.hasSuffix("/input") == true }.count == 1)
        case "late-open", "late-open-retire":
            let task = Task { try await transport.open() }; while !hasWaiting { await Task.yield() }
            if mode == "late-open" { task.cancel() } else { runtime.stop() }
            try await reject { _ = try await task.value }; lateSocket?.resume(returning: raw); lateSocket = nil
            for _ in 0..<200 { await Task.yield() }; precondition(closed == 1)
        case "cancel-send":
            let socket = try await transport.open(), send = Task { try await socket.send(.text("once")) }
            while !hasWaiting { await Task.yield() }; send.cancel(); try await reject { _ = try await send.value }
            sendWaiting?.resume(); sendWaiting = nil; precondition(writes == 1 && closed == 1)
        case "incoming-limit": let socket = try await transport.open(); try await reject { _ = try await socket.receive() }; precondition(closed == 1)
        case "outgoing-limit": let socket = try await transport.open(); try await reject { try await socket.send(.binary(Data(repeating: 0, count: 65537))) }; precondition(writes == 0 && closed == 1)
        case "mint-bearer": try await reject { _ = try await transport.open() }; precondition(sockets == 0)
        default: throw TerminalFailure.invalid
        }
        runtime.stop()
        print("PASS \(mode) \(relayMode)")
    }
}
