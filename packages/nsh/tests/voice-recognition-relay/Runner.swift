import Foundation
import NativeShell

@main struct RecognitionRelayCheck {
    static func require(_ condition: Bool) throws {
        if !condition { throw VoiceRecognitionFailure.transport }
    }
    @MainActor static func main() async throws {
        let mode = CommandLine.arguments[2], scenario = CommandLine.arguments[3]
        let configURL = URL(string: CommandLine.arguments[1] + "?scenario=" + scenario)!
        let (bytes, _) = try await URLSession.shared.data(from: configURL)
        let config = try JSONSerialization.jsonObject(with: bytes) as! [String: Any]
        let origin = URL(string: config["origin"] as! String)!
        let relay = mode == "relay" ? RelayConfiguration(relayUrl: config["relayUrl"] as! String, serverId: config["serverId"] as! String, hostEncPubJwk: config["hostEncPubJwk"] as! [String: String]) : nil
        let store = try ConnectionStore(memoryData: nil)
        try store.save(url: origin, token: "fixture-only:\(mode):\(scenario)", label: "Synthetic ASR transport", relay: relay)
        let runtime = RuntimeBridge(app: NshAppView(), store: store)
        runtime.setForeground(true)
        defer { runtime.stop() }
        let scope = try RuntimeHostScope(runtime.snapshot["runtimeScope"])
        let transport = try runtime.voiceRecognitionTransport(expectedHost: scope)
        let settings = try await transport.settings()
        try require(settings.status == 200)
        if scenario == "voice-denied" {
            do {
                let socket = try await transport.open(); socket.close()
                throw NSError(domain: "SyntheticRecognition", code: 1)
            } catch is VoiceRecognitionFailure {
                print("PASS \(mode) \(scenario)"); return
            }
        }
        let file = try await transport.transcribe(Data([82, 73, 70, 70]))
        try require(try VoiceRecognitionPCM.transcript(file) == "synthetic transport only")
        let socket = try await transport.open()
        defer { socket.close() }
        guard case .text("ready") = try await socket.receive() else { throw VoiceRecognitionFailure.transport }
        try await socket.send("synthetic transport round-trip")
        guard case .text("synthetic transport round-trip") = try await socket.receive() else { throw VoiceRecognitionFailure.transport }
        runtime.setForeground(false)
        try require(!transport.isCurrent())
        do { _ = try await transport.settings(); throw NSError(domain: "SyntheticRecognition", code: 2) }
        catch is CancellationError {}
        print("PASS \(mode) \(scenario)")
    }
}
