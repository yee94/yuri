import Foundation
import Darwin

private enum LoopbackFailure: Error {
    case invalidConfiguration, assertion(String), deadline(String)
}

@MainActor private final class LoopbackResult<Value> {
    private var result: Result<Value, Error>?
    private var continuation: CheckedContinuation<Value, Error>?
    func finish(_ value: Result<Value, Error>) {
        guard result == nil else { return }; result = value
        continuation?.resume(with: value); continuation = nil
    }
    func value() async throws -> Value {
        if let result { return try result.get() }
        return try await withCheckedThrowingContinuation { continuation = $0 }
    }
}

@MainActor private final class DirectLoopbackChecks {
    private let origin: URL
    private let authorization: String
    private let control: URLSession
    init(file: String) throws {
        let raw = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: file)))
        guard let fields = raw as? [String: String], let value = fields["origin"], let origin = URL(string: value),
              origin.scheme == "http", origin.host == "127.0.0.1", origin.port != nil,
              origin.user == nil, origin.password == nil, origin.query == nil, origin.fragment == nil,
              origin.path.isEmpty, let authorization = fields["authorization"], authorization.count >= 32,
              !authorization.contains(where: { $0.isWhitespace }) else { throw LoopbackFailure.invalidConfiguration }
        self.origin = origin; self.authorization = authorization
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil; config.httpShouldSetCookies = false; config.urlCache = nil; config.urlCredentialStorage = nil
        config.timeoutIntervalForRequest = 2
        control = URLSession(configuration: config)
    }
    func dispose() { control.invalidateAndCancel() }
    private func request(_ name: String, webSocket: Bool = false) -> URLRequest {
        var components = URLComponents(url: origin, resolvingAgainstBaseURL: false)!
        components.path = "/" + name
        if webSocket { components.scheme = "ws" }
        var request = URLRequest(url: components.url!)
        request.setValue("Bearer " + authorization, forHTTPHeaderField: "Authorization")
        request.setValue(origin.absoluteString, forHTTPHeaderField: "Origin")
        return request
    }
    private func bounded<Value>(_ name: String, _ work: @escaping @MainActor () async throws -> Value) async throws -> Value {
        let result = LoopbackResult<Value>()
        let running = Task { do { result.finish(.success(try await work())) } catch { result.finish(.failure(error)) } }
        let timeout = Task {
            do { try await Task.sleep(nanoseconds: 3_000_000_000); result.finish(.failure(LoopbackFailure.deadline(name))) } catch {}
        }
        defer { timeout.cancel(); running.cancel() }
        return try await result.value()
    }
    private func assertRejected<Value>(_ task: Task<Value, Error>, _ name: String) async throws {
        try await bounded(name) {
            var failed = false
            do { _ = try await task.value } catch { failed = true }
            guard failed else { throw LoopbackFailure.assertion(name + " unexpectedly succeeded") }
        }
    }
    private func audit() async throws -> [String: Any] {
        let (bytes, response) = try await control.data(for: request("audit"))
        guard (response as? HTTPURLResponse)?.statusCode == 200,
              let value = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { throw LoopbackFailure.assertion("audit unavailable") }
        return value
    }
    private func waitForRequest(_ name: String) async throws {
        try await bounded("handshake observed") {
            while true {
                let records = try await self.audit()["records"] as? [String: [String: Any]]
                if (records?[name]?["requests"] as? Int ?? 0) > 0 { return }
                try await Task.sleep(nanoseconds: 10_000_000)
            }
        }
    }
    func capabilityProbe() async throws {
        let wire = control.webSocketTask(with: request("probe", webSocket: true)); wire.resume()
        defer { wire.cancel(with: .goingAway, reason: nil) }
        let value = try await bounded("Foundation capability probe") { try await wire.receive() }
        guard case .string("loopback-capability") = value else { throw LoopbackFailure.assertion("Foundation probe payload") }
    }
    func replay() async throws {
        let adapter = SessionMessageStreamDirect(request: request("replay", webSocket: true))
        defer { adapter.close() }
        let socket = try await bounded("replay open") { try await adapter.open() }
        // The child sends the entire replay in open(), before this first receive.
        try await Task.sleep(nanoseconds: 100_000_000)
        for ordinal in 0..<128 {
            let raw = try await bounded("replay frame") { try await socket.receive() }
            guard case .event(let value, let eventID) = try SessionStreamFrame.decode(raw), eventID == "loopback-\(ordinal)",
                  let envelope = try JSONSerialization.jsonObject(with: Data(value.utf8)) as? [String: Any],
                  let payload = envelope["payload"] as? [String: Any], payload["ordinal"] as? Int == ordinal else { throw LoopbackFailure.assertion("replay order before ready") }
        }
        let ready = try await bounded("ready barrier") { try await socket.receive() }
        guard case .ready = try SessionStreamFrame.decode(ready) else { throw LoopbackFailure.assertion("ready after complete replay") }
        socket.close()
    }
    func receiveWakeup(_ name: String) async throws {
        let adapter = SessionMessageStreamDirect(request: request(name, webSocket: true))
        defer { adapter.close() }
        let socket = try await bounded(name + " open") { try await adapter.open() }
        let marker = try await bounded(name + " marker") { try await socket.receive() }
        guard marker == "loopback-waiting" else { throw LoopbackFailure.assertion("receive marker") }
        let pending = Task { try await socket.receive() }
        defer { pending.cancel() }
        await Task.yield()
        switch name {
        case "local-close": socket.close()
        case "receive-cancel": pending.cancel()
        case "server-close":
            var close = request("control-close"); close.httpMethod = "POST"
            let (_, response) = try await control.data(for: close)
            guard (response as? HTTPURLResponse)?.statusCode == 204 else { throw LoopbackFailure.assertion("server close control") }
        default: throw LoopbackFailure.invalidConfiguration
        }
        try await assertRejected(pending, name + " receive wakes")
    }
    func openingWakeup(_ name: String) async throws {
        let adapter = SessionMessageStreamDirect(request: request(name, webSocket: true))
        defer { adapter.close() }
        let pending = Task { try await adapter.open() }
        defer { pending.cancel() }
        try await waitForRequest(name)
        if name == "open-close" { adapter.close() } else { pending.cancel() }
        try await assertRejected(pending, name + " handshake wakes")
    }
    func unauthorized() async throws {
        let adapter = SessionMessageStreamDirect(request: request("unauthorized", webSocket: true))
        defer { adapter.close() }
        do { _ = try await bounded("HTTP 401 rejection") { try await adapter.open() } }
        catch SessionStreamFailure.http(401) { return }
        catch { throw LoopbackFailure.assertion("HTTP 401 was not classified as a rejected handshake") }
        throw LoopbackFailure.assertion("HTTP 401 socket opened")
    }
    func redirect(_ name: String) async throws {
        let adapter = SessionMessageStreamDirect(request: request(name, webSocket: true))
        defer { adapter.close() }
        let attempt = Task { try await adapter.open() }
        defer { attempt.cancel() }
        try await assertRejected(attempt, name + " rejected")
    }
    func verifyAudit() async throws {
        let value = try await audit()
        guard value["targetRequests"] as? Int == 0, value["targetAuthorization"] as? Int == 0,
              let records = value["records"] as? [String: [String: Any]] else { throw LoopbackFailure.assertion("redirect target was contacted") }
        for name in ["probe", "replay", "local-close", "receive-cancel", "server-close", "open-close", "open-cancel", "unauthorized", "redirect-same", "redirect-cross"] {
            guard let record = records[name], record["requests"] as? Int == 1,
                  record["authorizationExact"] as? Bool == true, record["originExact"] as? Bool == true else { throw LoopbackFailure.assertion("same-origin headers/count changed: " + name) }
        }
        guard records["replay"]?["frames"] as? Int == 129 else { throw LoopbackFailure.assertion("server replay frame count") }
    }
}

@main private struct SessionDirectLoopbackRunner {
    @MainActor static func main() async {
        do {
            guard CommandLine.arguments.count == 2 else { throw LoopbackFailure.invalidConfiguration }
            let checks = try DirectLoopbackChecks(file: CommandLine.arguments[1]); defer { checks.dispose() }
            do { try await checks.capabilityProbe() }
            catch {
                let value = error as NSError
                if value.domain == NSURLErrorDomain && value.code == NSURLErrorUnsupportedURL {
                    print("{\"kind\":\"unsupported\",\"reason\":\"macOS Foundation rejects the loopback ws scheme in a raw URLSession capability probe (NSURLErrorUnsupportedURL)\"}")
                    exit(77)
                }
                throw error
            }
            try await checks.replay()
            for name in ["local-close", "receive-cancel", "server-close"] { try await checks.receiveWakeup(name) }
            for name in ["open-close", "open-cancel"] { try await checks.openingWakeup(name) }
            try await checks.unauthorized()
            for name in ["redirect-same", "redirect-cross"] { try await checks.redirect(name) }
            try await checks.verifyAudit()
            print("{\"kind\":\"passed\",\"adapter\":\"production SessionMessageStreamDirect\",\"replayFrames\":128,\"readyAfterReplay\":true,\"redirectTargetRequests\":0}")
        } catch {
            // Never serialize URLRequest, headers, the config, or credential values.
            let reason: String
            switch error {
            case LoopbackFailure.assertion(let value): reason = value
            case LoopbackFailure.deadline(let value): reason = "deadline: " + value
            case LoopbackFailure.invalidConfiguration: reason = "invalid loopback fixture configuration"
            default: let value = error as NSError; reason = "native adapter error domain/code: \(value.domain)/\(value.code)"
            }
            let bytes = try! JSONSerialization.data(withJSONObject: ["kind": "failed", "reason": reason])
            print(String(data: bytes, encoding: .utf8)!); exit(1)
        }
    }
}
