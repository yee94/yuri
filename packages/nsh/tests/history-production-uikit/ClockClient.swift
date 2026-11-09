import Foundation

/// Main-only file handshake; no simulator launch, engine, network or history request.
@main struct HistoryClockClient {
    static func main() throws {
        let args = CommandLine.arguments
        guard args.count >= 3, ["clock", "mark", "flush", "prepare-ax", "read-ax"].contains(args[2]), args.count == (args[2] == "mark" ? 6 : 3) else { throw HistoryProductionHost.failure("usage_clock_client_directory_command_mark_requires_three_anchor_IDs") }
        let directory = URL(fileURLWithPath: args[1]), command = args[2], nonce = UUID().uuidString
        let send = ProcessInfo.processInfo.systemUptime * 1000
        var request: [String: Any] = ["nonce": nonce, "command": command]
        if command == "mark" { request["anchors"] = Array(args.dropFirst(3)) }
        try HistoryProductionHost.json(request).write(to: directory.appendingPathComponent("control.json"), options: .atomic)
        let deadline = ProcessInfo.processInfo.systemUptime + 10
        let ackURL = directory.appendingPathComponent(command == "clock" ? "clock-ack.json" : "control-ack.json")
        while ProcessInfo.processInfo.systemUptime < deadline {
            if let bytes = try? Data(contentsOf: ackURL), var ack = (try? JSONSerialization.jsonObject(with: bytes)) as? [String: Any], ack["nonce"] as? String == nonce {
                ack["hostSendMs"] = send; ack["hostReceiveMs"] = ProcessInfo.processInfo.systemUptime * 1000; ack["hostClock"] = "ProcessInfo.systemUptime milliseconds"
                print(String(decoding: try HistoryProductionHost.json(ack), as: UTF8.self)); return
            }
            Thread.sleep(forTimeInterval: 0.001)
        }
        throw HistoryProductionHost.failure("clock_or_control_ack_timeout")
    }
}
