import Foundation

private enum CheckFailure: Error {
    case assertion(String)
}

private func check(_ condition: Bool, _ message: String) throws {
    if !condition { throw CheckFailure.assertion(message) }
}

private actor SSECollector {
    private var headed = false
    private var bytes = Data()
    private var chunks = 0
    private var splitUTF8 = false
    private var waiter: CheckedContinuation<Void, Never>?

    func head(_ status: Int, _ headers: [String: String]) throws {
        try check(status == 200 && headers["content-type"] == "text/event-stream", "invalid SSE response head")
        headed = true
    }

    func append(_ chunk: Data) throws {
        try check(headed, "SSE data arrived before response head")
        splitUTF8 = splitUTF8 || String(data: chunk, encoding: .utf8) == nil
        bytes.append(chunk)
        chunks += 1
        waiter?.resume()
        waiter = nil
    }

    func waitForData() async {
        if chunks > 0 { return }
        await withCheckedContinuation { waiter = $0 }
    }

    func verify() throws {
        try check(chunks == 2 && splitUTF8, "fixture must split inside UTF-8")
        try check(String(data: bytes, encoding: .utf8) == "data: 你好\n\ndata: second\n\n", "SSE bytes corrupted")
    }
}

@main private struct RelayNativeRunner {
    private static let headers = ["Authorization": "Bearer native-relay-test-only"]

    static func main() async throws {
        try check(CommandLine.arguments.count == 3, "expected config URL and scenario")
        guard let configURL = URL(string: CommandLine.arguments[1]) else {
            throw CheckFailure.assertion("invalid fixture config URL")
        }
        let (data, _) = try await URLSession.shared.data(from: configURL)
        guard let config = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let url = config["relayUrl"] as? String, let id = config["serverId"] as? String,
              let jwk = config["hostEncPubJwk"] as? [String: String] else {
            throw CheckFailure.assertion("invalid fixture config")
        }
        let tunnel = try RelayTunnel(relayUrl: url, serverId: id, hostEncPubJwk: jwk)
        let scenario = CommandLine.arguments[2]
        do {
            switch scenario {
            case "multiplex": try await multiplex(tunnel)
            case "sse": try await sse(tunnel)
            case "cancel": try await cancel(tunnel)
            case "replay", "tamper": try await rejectAttack(tunnel, scenario: scenario)
            case "authentication":
                let result = try await tunnel.request(path: "/api/stats", timeout: 5)
                try check(result.status == 401, "missing encrypted bearer was not rejected")
                _ = try await stats(tunnel)
            default: throw CheckFailure.assertion("unknown scenario")
            }
        } catch {
            await tunnel.close()
            throw error
        }
        await tunnel.close()
        print("PASS \(scenario)")
    }

    private static func payload(_ slot: Int) -> Data {
        Data((0..<300_000).map { UInt8(truncatingIfNeeded: $0 + slot * 17) })
    }

    private static func stats(_ tunnel: RelayTunnel) async throws -> [String: Int] {
        let result = try await tunnel.request(path: "/api/stats", headers: headers, timeout: 5)
        try check(result.status == 200, "authenticated request failed")
        guard let values = try JSONSerialization.jsonObject(with: result.body) as? [String: Int] else {
            throw CheckFailure.assertion("invalid fixture statistics")
        }
        return values
    }

    private static func echo(_ tunnel: RelayTunnel, slot: Int, parallel: Bool = false) async throws {
        let body = payload(slot)
        let query = parallel ? "group=parallel&slot=\(slot)&q=a%2Fb" : "q=a%2Fb"
        let result = try await tunnel.request(path: "/api/echo?\(query)", method: "POST", headers: headers, body: body, timeout: 5)
        try check(result.status == 200 && result.body == body, "multiplexed body mismatch for slot \(slot)")
    }

    private static func multiplex(_ tunnel: RelayTunnel) async throws {
        try await withThrowingTaskGroup(of: Void.self) { group in
            for slot in 0..<8 {
                group.addTask { try await echo(tunnel, slot: slot, parallel: true) }
            }
            try await group.waitForAll()
        }
        let values = try await stats(tunnel)
        try check(values["maxActive"] == 8, "requests did not coexist on one connection")
        try check((values["bodyFrames"] ?? 0) >= 8 * 5, "large request bodies were not chunked")
    }

    private static func sse(_ tunnel: RelayTunnel) async throws {
        let collector = SSECollector()
        let result = try await tunnel.stream(path: "/api/sse", headers: headers, timeout: 5,
            onResponse: { try await collector.head($0, $1) },
            onData: { try await collector.append($0) })
        try check(result.status == 200 && result.body.isEmpty, "SSE was buffered instead of streamed")
        try await collector.verify()
    }

    private static func cancel(_ tunnel: RelayTunnel) async throws {
        let collector = SSECollector()
        let live = Task {
            try await tunnel.stream(path: "/api/live", headers: headers, timeout: 5,
                onResponse: { try await collector.head($0, $1) },
                onData: { try await collector.append($0) })
        }
        // Observe real response bytes before cancelling; no timing assumption about startup.
        await collector.waitForData()
        let before = try await stats(tunnel)
        async let survivor: Void = echo(tunnel, slot: 99)
        live.cancel()
        do {
            _ = try await live.value
            throw CheckFailure.assertion("cancelled SSE completed successfully")
        } catch is CancellationError {}
        try await survivor
        let deadline = ProcessInfo.processInfo.systemUptime + 2
        while true {
            let values = try await stats(tunnel)
            try check(values["connectionID"] == before["connectionID"], "cancellation reset unrelated streams")
            if values["aborts"] == 1 && values["liveStreams"] == 0 { break }
            try check(ProcessInfo.processInfo.systemUptime < deadline, "cancel did not send StreamAbort to Host")
            try await Task.sleep(nanoseconds: 20_000_000)
        }
    }

    private static func rejectAttack(_ tunnel: RelayTunnel, scenario: String) async throws {
        let before = try await stats(tunnel)
        do {
            _ = try await tunnel.request(path: "/api/\(scenario)", headers: headers, timeout: 5)
            throw CheckFailure.assertion("\(scenario) was accepted")
        } catch RelayTunnel.Failure.invalidFrame {}
        // A connection-level cryptographic failure must not poison the next fresh session.
        try await echo(tunnel, slot: 42)
        let after = try await stats(tunnel)
        try check(after["connectionID"] != before["connectionID"], "invalid encrypted session was reused")
    }
}
