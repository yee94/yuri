import Foundation
import NativeShell
@main struct TerminalLoopbackHarness {
    @MainActor static func main() async throws {
        let mode = CommandLine.arguments[2]
        let scenario = CommandLine.arguments.count > 3 ? CommandLine.arguments[3] : "normal"
        let configURL = URL(string: CommandLine.arguments[1] + "?scenario=" + scenario)!
        let (bytes, _) = try await URLSession.shared.data(from: configURL)
        let config = try JSONSerialization.jsonObject(with: bytes) as! [String: Any]
        let relay = mode == "relay" ? RelayConfiguration(relayUrl: config["relayUrl"] as! String, serverId: config["serverId"] as! String, hostEncPubJwk: config["hostEncPubJwk"] as! [String: String]) : nil
        let store = try ConnectionStore(); try store.save(url: URL(string: config["origin"] as! String)!, token: "loopback-terminal:" + scenario, label: "Synthetic", relay: relay)
        let app = NshAppView(), runtime = RuntimeBridge(app: app, store: store); runtime.setForeground(true); defer { runtime.stop() }
        let scope = try RuntimeHostScope(runtime.snapshot["runtimeScope"]), transport = try runtime.terminalTransport(expectedHost: scope)
        if scenario == "legacy-regression" {
            let voice = try runtime.voiceRecognitionTransport(expectedHost: scope), voiceSocket = try await voice.open()
            guard case .text("ready") = try await voiceSocket.receive() else { throw TerminalFailure.invalid }
            try await voiceSocket.send("legacy-ASR-text")
            guard case .text("legacy-ASR-text") = try await voiceSocket.receive() else { throw TerminalFailure.invalid }
            voiceSocket.close()
            let desktop = try runtime.remoteDesktopTransport(), desktopSocket = try await desktop.open()
            guard case .text("ready") = try await desktopSocket.receive() else { throw TerminalFailure.invalid }
            try await desktopSocket.send("legacy-desktop-text")
            guard case .text("legacy-desktop-text") = try await desktopSocket.receive() else { throw TerminalFailure.invalid }
            desktopSocket.close(); print("PASS \(mode) \(scenario)"); return
        }
        if scenario == "runtime-stream" {
            func call(_ name: String, _ body: [String: Any]) async throws -> Any? { try await app.handlers[name]!(body) }
            func audit() async throws -> Int { let (bytes, _) = try await URLSession.shared.data(from: configURL); return (try JSONSerialization.jsonObject(with: bytes) as! [String: Any])["globalRequests"] as! Int }
            func eventCount() -> Int { app.events.filter { $0.0 == "runtime.event" && $0.1["data"] != nil }.count }
            func waitEvents(_ greaterThan: Int) async throws {
                let deadline = Date().addingTimeInterval(5)
                while eventCount() <= greaterThan && Date() < deadline { try await Task.sleep(nanoseconds: 10_000_000) }
                precondition(eventCount() > greaterThan)
            }
            let base = try await audit()
            for body: [String: Any] in [[:], ["path": "/api/yuri/events", "key": "global"], ["path": "/api/yuri/events", "key": "global", "expectedHost": scope.publicValue, "extra": true]] {
                do { _ = try await call("runtime.stream", body); preconditionFailure() } catch {}
            }
            for body: [String: Any] in [[:], ["key": "global"], ["key": "global", "expectedHost": scope.publicValue, "extra": true]] {
                do { _ = try await call("runtime.stop", body); preconditionFailure() } catch {}
            }
            let deniedCount = try await audit(); precondition(deniedCount == base)
            _ = try await call("runtime.stream", ["path": "/api/yuri/events", "key": "global", "expectedHost": scope.publicValue]); try await waitEvents(0)
            let a = store.selected!.id
            try store.save(url: URL(string: "http://127.0.0.1:2")!, token: "unused", label: "B"); runtime.stop()
            try store.select(a); runtime.stop()
            let next = try RuntimeHostScope(runtime.snapshot["runtimeScope"]), before = eventCount()
            _ = try await call("runtime.stream", ["path": "/api/yuri/events", "key": "global", "expectedHost": next.publicValue]); try await waitEvents(before)
            let requestsBeforeOld = try await audit()
            do { _ = try await call("runtime.stream", ["path": "/api/yuri/events", "key": "global", "expectedHost": scope.publicValue]); preconditionFailure() } catch {}
            let requestsAfterOld = try await audit(); precondition(requestsAfterOld == requestsBeforeOld)
            _ = try await call("runtime.stop", ["key": "global", "expectedHost": scope.publicValue])
            try await Task.sleep(nanoseconds: 60_000_000)
            let tickBefore = eventCount(), nextTransport = try runtime.terminalTransport(expectedHost: next)
            _ = try await nextTransport.freePort!(); try await waitEvents(tickBefore)
            _ = try await call("runtime.stop", ["key": "global", "expectedHost": next.publicValue])
            runtime.setForeground(false)
            do { _ = try await call("runtime.stream", ["path": "/api/yuri/events", "key": "global", "expectedHost": next.publicValue]); preconditionFailure() } catch {}
            let finalCount = try await audit(); precondition(finalCount == requestsAfterOld)
            print("PASS \(mode) \(scenario)"); return
        }
        if scenario == "fallback" || scenario == "explicit-sse" {
            var events: [[String: Any]] = []
            let catalog = TerminalCatalogStore(url: URL(fileURLWithPath: CommandLine.arguments[4]).appendingPathComponent(mode + scenario + ".json"))
            let controller = TerminalBridge(capture: { try runtime.terminalTransport(expectedHost: $0) }, emit: { events.append($0) }, catalog: catalog)
            var input: [String: Any] = ["expectedHost": scope.publicValue, "owner": "loopback-feature", "directory": "/tree", "cols": 80, "rows": 24]
            _ = try await controller.call("terminal.create", input)
            input["sessionId"] = "pty"; input["cursor"] = 0; input["attachment"] = 1
            _ = try await controller.call("terminal.attach", input)
            let deadline = Date().addingTimeInterval(8)
            while !events.contains(where: { $0["type"] as? String == "data" }) && Date() < deadline { try await Task.sleep(nanoseconds: 10_000_000) }
            precondition(events.contains { $0["data"] as? String == "中文😀" && $0["transport"] as? String == "sse" })
            input["data"] = "中文\u{0}\r\n"; _ = try await controller.call("terminal.input", input)
            _ = try await controller.call("terminal.close", input); controller.invalidate()
            print("PASS \(mode) \(scenario)"); return
        }
        if scenario != "normal" {
            var rejected = false
            do { let socket = try await transport.open(); socket.close() } catch { rejected = true }
            precondition(rejected)
            let (auditBytes, _) = try await URLSession.shared.data(from: configURL), audit = try JSONSerialization.jsonObject(with: auditBytes) as! [String: Any]
            precondition(audit["redirects"] as? Int == 0)
            if mode == "relay" { precondition(audit["directWS"] as? Int == config["directWS"] as? Int) }
            print("PASS \(mode) \(scenario)"); return
        }
        _ = try await transport.request(.input(sessionID: "pty", text: "中文\u{0}\r\n"))
        let absent = try await transport.optionalFile!("/tree 中文", "index.html"), empty = try await transport.optionalFile!("/tree 中文", "package.json")
        precondition(absent == nil && empty == "")
        let port = try await transport.freePort!(); precondition(port == 8123)
        do { _ = try await transport.request(.close(sessionID: "redirect")); preconditionFailure() } catch {}
        do { _ = try await transport.request(.close(sessionID: "overflow")); preconditionFailure() } catch {}
        let events = try await transport.stream!("pty")
        let connected = try await events.receive(), output = try await events.receive()
        precondition(connected["type"] as? String == "connected" && output["data"] as? String == "中文😀")
        events.close()
        do { _ = try await events.receive(); preconditionFailure() } catch {}
        do { _ = try await transport.stream!("missing"); preconditionFailure() } catch let error as TerminalFailure { precondition(error == .sessionNotFound) }
        do {
            let socket = try await transport.open()
            guard case .text("connected") = try await socket.receive(), case .binary(let large) = try await socket.receive() else { throw TerminalFailure.protocolViolation }
            precondition(large.count == 1_048_576)
            let frame = Data([1, 123, 125]); try await socket.send(.binary(frame))
            guard case .binary(let echoed) = try await socket.receive(), echoed == frame else { throw TerminalFailure.protocolViolation }
            try await socket.send(.text("中文\r")); guard case .text("中文\r") = try await socket.receive() else { throw TerminalFailure.protocolViolation }
            let fragmented = Data(repeating: 17, count: 65_536); try await socket.send(.binary(fragmented))
            guard case .binary(let reconstructed) = try await socket.receive(), reconstructed == fragmented else { throw TerminalFailure.protocolViolation }
            socket.close()
        }
        runtime.setForeground(false)
        do { _ = try await transport.request(.input(sessionID: "pty", text: "forbidden")); preconditionFailure() } catch is CancellationError {}
        print("PASS \(mode)")
    }
}
