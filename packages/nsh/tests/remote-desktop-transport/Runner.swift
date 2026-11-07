import Foundation
import NativeShell

@main struct DesktopTransportRunner {
    static func check(_ condition: Bool, _ message: String) throws {
        if !condition { throw NSError(domain: "DesktopTransportFixture", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
    }
    @MainActor static func main() async throws {
        let mode = CommandLine.arguments[2], scenario = CommandLine.arguments[3]
        if mode == "core" {
            try await core(scenario)
            print("PASS core \(scenario)"); return
        }
        let (data, _) = try await URLSession.shared.data(from: URL(string: CommandLine.arguments[1] + "?scenario=" + scenario)!)
        let config = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        let store = try ConnectionStore()
        let relay = mode == "relay" ? RelayConfiguration(relayUrl: config["relayUrl"] as! String, serverId: config["serverId"] as! String, hostEncPubJwk: config["hostEncPubJwk"] as! [String: String]) : nil
        try store.save(url: URL(string: mode == "relay" ? "https://relay.invalid" : config["origin"] as! String)!, token: "fixture-only:\(mode):\(scenario)", label: "fixture", relay: relay)
        let runtime = RuntimeBridge(app: NshAppView(), store: store)
        runtime.setForeground(true)
        let transport = try runtime.remoteDesktopTransport()
        defer { runtime.stop() }
        if scenario == "upgrade-timeout" || scenario == "invalid-path" {
            let tunnel = try RelayTunnel(relayUrl: relay!.relayUrl, serverId: relay!.serverId, hostEncPubJwk: relay!.hostEncPubJwk)
            do {
                _ = try await tunnel.openWebSocket(path: scenario == "invalid-path" ? "/api/remote-desktop/ws?evil=1" : "/api/remote-desktop/ws", urlToken: "fixture-url-\(scenario)", timeout: 0.05)
                try check(false, "invalid or timed out open succeeded")
            } catch RelayTunnel.Failure.timeout { try check(scenario == "upgrade-timeout", "wrong failure") }
            catch RelayTunnel.Failure.invalidRequest { try check(scenario == "invalid-path", "wrong failure") }
            await tunnel.close(); print("PASS \(mode) \(scenario)"); return
        }
        if scenario == "carrier-redirect" {
            var rejected = false
            do { _ = try await transport.capability() } catch { rejected = true }
            try check(rejected, "redirected Relay connected")
            print("PASS \(mode) \(scenario)"); return
        }
        if scenario == "old-socket" {
            let tunnel = try RelayTunnel(relayUrl: relay!.relayUrl, serverId: relay!.serverId, hostEncPubJwk: relay!.hostEncPubJwk)
            let first = try await tunnel.openWebSocket(path: "/api/remote-desktop/ws", urlToken: "fixture-url-\(scenario)")
            _ = try await first.receive()
            await tunnel.cancel()
            let next = try await tunnel.openWebSocket(path: "/api/remote-desktop/ws", urlToken: "fixture-url-\(scenario)")
            _ = try await next.receive()
            await first.close()
            try await next.send("new-socket-survives")
            guard case .text("new-socket-survives") = try await next.receive() else { try check(false, "old handle cancelled new substream"); return }
            await next.close(); await tunnel.close()
            print("PASS \(mode) \(scenario)"); return
        }
        if ["bad-open", "bad-close", "bad-abort", "bad-text", "control-fragment"].contains(scenario) {
            do {
                let socket = try await transport.open()
                defer { socket.close() }
                _ = try await socket.receive()
                try check(false, "malformed mux frame accepted")
            } catch let error as RemoteDesktopBridgeFailure { try check(error.code == "connection_failed", "invented source fields were trusted") }
            let after = try await transport.capability()
            try check(after.status == 200, "malformed WS poisoned unrelated HTTP")
            print("PASS \(mode) \(scenario)"); return
        }
        if scenario == "cancel-mint" || scenario == "switch-mint" {
            let opening = Task { try await transport.open() }
            try await Task.sleep(nanoseconds: 80_000_000)
            if scenario == "switch-mint" { runtime.stop() } else { opening.cancel() }
            do { _ = try await opening.value; try check(false, "cancelled auth mint opened socket") } catch is CancellationError {}
            if scenario == "cancel-mint" { let survivor = try await transport.capability(); try check(survivor.status == 200, "auth cancellation broke tunnel") }
            print("PASS \(mode) \(scenario)"); return
        }
        if scenario == "stale" {
            let pending = Task { try await transport.capability() }
            try await Task.sleep(nanoseconds: 40_000_000)
            runtime.stop()
            try check(!transport.isCurrent(), "old captured transport survived generation change")
            do { _ = try await pending.value; try check(false, "stale capability committed") } catch is CancellationError {}
            do { _ = try await transport.open(); try check(false, "stale open succeeded") } catch is CancellationError {}
        } else {
            let capability = try await transport.capability()
            try check(capability.status == 200 && capability.body["enabled"] as? Bool == true, "capability failed")
            if scenario == "multiplex" {
                var sockets: [RemoteDesktopSocket] = []
                for _ in 0..<4 {
                    let socket = try await transport.open(); _ = try await socket.receive(); sockets.append(socket)
                }
                let tasks = sockets.enumerated().map { index, socket in Task {
                    let text = String(repeating: "\(index)", count: 80_000)
                    try await socket.send(text)
                    guard case .text(let received) = try await socket.receive() else { try check(false, "multiplex message boundary lost"); return }
                    try check(received == text, "concurrent substreams crossed")
                } }
                for task in tasks { try await task.value }
                for socket in sockets { socket.close() }
                let after = try await transport.capability()
                if mode == "relay" { try check(after.body["relayConnections"] as? Int == capability.body["relayConnections"] as? Int, "multiple substreams created multiple tunnels") }
                print("PASS \(mode) \(scenario)"); return
            }
            let failures = ["unauthorized": "authentication_required", "disabled": "disabled", "unsupported": "unsupported", "occupied": "occupied", "redirect": "connection_failed", "unpaired": "authentication_required", "mint-denied": "authentication_required", "bearer-url": "connection_failed", "expired-url": "connection_failed", "bad-mint": "connection_failed"]
            if let code = failures[scenario] {
                do { _ = try await transport.open(); try check(false, "rejected upgrade succeeded") }
                catch let error as RemoteDesktopBridgeFailure { try check(error.code == code, "wrong rejection: \(error.code), expected \(code)") }
            } else if scenario == "cancel-upgrade" {
                let opening = Task { try await transport.open() }
                try await Task.sleep(nanoseconds: 80_000_000)
                opening.cancel()
                do { _ = try await opening.value; try check(false, "cancelled upgrade succeeded") } catch is CancellationError {}
            } else {
                let socket = try await transport.open()
                defer { socket.close() }
                guard case .text("ready") = try await socket.receive() else { try check(false, "text boundary lost"); return }
                switch scenario {
                case "messages":
                    guard case .binary(let bytes) = try await socket.receive() else { try check(false, "binary boundary lost"); return }
                    try check(bytes.count == 300_000 && bytes.enumerated().allSatisfy({ $0.element == UInt8($0.offset % 251) }), "fragmented bytes corrupted")
                    let text = String(repeating: "你", count: 24_000)
                    try await socket.send(text)
                    guard case .text(let received) = try await socket.receive() else { try check(false, "fragmented text boundary lost"); return }
                    try check(received == text, "fragmented outgoing text corrupted")
                    let again = try await transport.capability()
                    if mode == "relay" {
                        try check(again.body["relayConnections"] as? Int == capability.body["relayConnections"] as? Int, "feature opened another tunnel")
                    }
                    try await socket.send("done")
                    guard case .closed(1000) = try await socket.receive() else { try check(false, "normal close lost"); return }
                case "cancel":
                    let reading = Task { try await socket.receive() }
                    try await Task.sleep(nanoseconds: 40_000_000)
                    reading.cancel()
                    do { _ = try await reading.value; try check(false, "receive cancellation lost") } catch is CancellationError {}
                    let survivor = try await transport.capability()
                    try check(survivor.status == 200, "cancelling socket broke HTTP")
                case "close":
                    try await socket.send("revoke")
                    do { _ = try await socket.receive(); try check(false, "revocation was not authentication failure") }
                    catch let error as RemoteDesktopBridgeFailure { try check(error.code == "authentication_required", "wrong revocation failure") }
                case "oversize", "flood":
                    try await socket.send(scenario)
                    if scenario == "flood" { try await Task.sleep(nanoseconds: 100_000_000) }
                    do { _ = try await socket.receive(); try check(false, "oversized/unbounded mailbox accepted") }
                    catch let error as RemoteDesktopBridgeFailure { try check(error.code == "connection_failed", "wrong size failure") }
                case "outgoing":
                    do { try await socket.send(String(repeating: "x", count: 96 * 1024 + 1)); try check(false, "outgoing limit bypassed") }
                    catch let error as RemoteDesktopBridgeFailure { try check(error.code == "connection_failed", "wrong outgoing failure") }
                case "runtime-close", "selected-host":
                    let pending = Task { try await socket.receive() }
                    try await Task.sleep(nanoseconds: 30_000_000)
                    if scenario == "runtime-close" { runtime.stop() }
                    else {
                        let previous = store.selected!
                        try store.remove(previous.id)
                        try store.save(url: previous.url, token: previous.token, label: "other", relay: previous.relay)
                        socket.close()
                    }
                    try check(!transport.isCurrent(), "scope remained current")
                    do { _ = try await pending.value; try check(false, "stale pending receive completed") } catch is CancellationError {}
                    do { try await socket.send("must-not-send"); try check(false, "stale input sent") } catch is CancellationError {}
                    socket.close(); socket.close()
                case "local-close":
                    socket.close(); socket.close()
                    do { try await socket.send("must-not-send"); try check(false, "send after close succeeded") } catch is CancellationError {}
                    do { _ = try await socket.receive(); try check(false, "receive after close succeeded") } catch is CancellationError {}
                default: try check(false, "unknown scenario")
                }
            }
        }
        print("PASS \(mode) \(scenario)")
    }

    private static func core(_ scenario: String) async throws {
        let inbox = NativeSocketInbox()
        try await inbox.didOpen()
        switch scenario {
        case "fragments":
            try await inbox.consume(type: 8, payload: Data([0xe4]), more: true)
            try await inbox.consume(type: 9, payload: Data([1, 2]), more: true)
            try await inbox.consume(type: 8, payload: Data([0xbd, 0xa0]))
            try await inbox.consume(type: 9, payload: Data([3]))
            guard case .text("你") = try await inbox.receive(), case .binary(Data([1, 2, 3])) = try await inbox.receive() else { try check(false, "per-type assembly failed"); return }
        case "invalid-utf8":
            do { try await inbox.consume(type: 8, payload: Data([0xff])); try check(false, "invalid UTF8 accepted") }
            catch RelayTunnel.Failure.invalidFrame {}
        case "fragment-overflow":
            try await inbox.consume(type: 9, payload: Data(repeating: 0, count: 512 * 1024), more: true)
            do { try await inbox.consume(type: 9, payload: Data([1])); try check(false, "fragment limit bypassed") }
            catch RelayTunnel.Failure.limit {}
        case "queue-limit":
            try await inbox.consume(type: 8, payload: Data([65])); try await inbox.consume(type: 8, payload: Data([66]))
            do { try await inbox.consume(type: 8, payload: Data([67])); try check(false, "queue unbounded") }
            catch RelayTunnel.Failure.limit {}
        case "closed-pending":
            let pending = Task { try await inbox.receive() }
            await inbox.fail(CancellationError())
            do { _ = try await pending.value; try check(false, "pending receive not cancelled") } catch is CancellationError {}
            do { _ = try await inbox.receive(); try check(false, "closed receive succeeded") } catch is CancellationError {}
        case "duplicate-open":
            do { try await inbox.didOpen(); try check(false, "duplicate open accepted") } catch RelayTunnel.Failure.invalidFrame {}
        default: try check(false, "unknown core scenario")
        }
    }
}
