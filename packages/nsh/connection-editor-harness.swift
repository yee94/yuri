import Foundation

@main struct ConnectionEditorHarness {
    static func require(_ test: @autoclosure () -> Bool, _ message: String) {
        if !test() { fatalError(message) }
    }
    static func expect(_ code: ConnectionEditorFailure, _ work: () throws -> Void) {
        do { try work(); fatalError("Expected stable failure") }
        catch let failure as ConnectionEditorFailure { require(failure == code, "Incorrect failure code") }
        catch { fatalError("Unexpected failure type") }
    }
    static func main() throws {
        let token = UUID().uuidString, otherToken = UUID().uuidString
        let relayA = RelayConfiguration(relayUrl: "wss://relay-a.example.invalid", serverId: "synthetic-host", hostEncPubJwk: ["x": UUID().uuidString])
        let relayB = RelayConfiguration(relayUrl: "wss://relay-b.example.invalid", serverId: "synthetic-host", hostEncPubJwk: ["x": UUID().uuidString])
        let direct = SavedConnection(id: "direct", label: "Direct", url: URL(string: "https://host.example.invalid")!, token: token, lastUsedAt: 42)
        let a = SavedConnection(id: "relay-a", label: "A", url: URL(string: "https://relay.invalid")!, token: token, lastUsedAt: 20, relay: relayA)
        let b = SavedConnection(id: "relay-b", label: "B", url: URL(string: "https://relay.invalid")!, token: otherToken, lastUsedAt: 10, relay: relayB)
        var records = ConnectionEditorRecords(connections: [direct, a, b], selected: a.id)
        // Legacy serialized shape (no editorVersion) decodes without deleting or migrating any record.
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        let oldBytes = try encoder.encode(records)
        records = try JSONDecoder().decode(ConnectionEditorRecords.self, from: oldBytes)
        require(records.connections.count == 3 && records.connections.allSatisfy { $0.editorVersion == nil }, "Legacy decode lost records")
        var malformed = try JSONSerialization.jsonObject(with: oldBytes) as! [String: Any]
        var malformedRows = malformed["connections"] as! [[String: Any]]
        malformedRows[1].removeValue(forKey: "token")
        malformed["connections"] = malformedRows
        let malformedBytes = try JSONSerialization.data(withJSONObject: malformed)
        do { _ = try JSONDecoder().decode(ConnectionEditorRecords.self, from: malformedBytes); fatalError("Malformed saved record was silently discarded") }
        catch is DecodingError { }
        func input(_ id: String, _ name: String = "Renamed", url: String? = nil, version: String = "legacy") throws -> ConnectionEditorInput {
            var value = ["id": id, "label": name, "version": version]
            value["url"] = url
            return try ConnectionEditorInput(value)
        }
        let renamed = try records.editing(input(a.id))
        let unchanged = try records.editing(input(direct.id, direct.label))
        require(unchanged.connections[0].editorVersion == nil && unchanged.connections[0].label == direct.label, "No-op edit rotated its version")
        var historyOnly = records; historyOnly.selected = nil
        let renamedHistory = try historyOnly.editing(input(b.id))
        require(renamedHistory.selected == nil && renamedHistory.connections.count == 3, "History rename selected or removed a connection")
        require(renamed.selected == records.selected, "Rename changed selection")
        require(renamed.connections.map(\.id) == records.connections.map(\.id), "Rename changed record order/identity")
        require(renamed.connections.map(\.lastUsedAt) == records.connections.map(\.lastUsedAt), "Rename changed recency")
        require(renamed.connections[1].token == token && renamed.connections[1].relay == relayA && renamed.connections[2].relay == relayB, "Rename changed authorization")
        require(renamed.connections[1].label == "Renamed", "Rename failed")
        require(Set(renamed.connections[1].editorValue.keys) == Set(["id", "label", "url", "transport", "lastUsedAt", "version"]), "Editor exposed private identity")
        var committed = oldBytes
        expect(.storage) { try records.commit(renamed) { _ in throw ConnectionEditorFailure.storage } }
        let unchangedBytes = try encoder.encode(records)
        require(unchangedBytes == oldBytes, "Failed write changed in-memory state")
        require(committed == oldBytes, "Failed write changed durable bytes")
        try records.commit(renamed) { committed = $0 }
        let restored = try JSONDecoder().decode(ConnectionEditorRecords.self, from: committed)
        require(restored.connections[1].label == "Renamed" && restored.connections.count == 3 && restored.selected == a.id, "Committed round-trip failed")
        expect(.stale) { _ = try records.editing(input(a.id)) }
        expect(.missing) { _ = try records.editing(input("removed")) }
        for label in ["", "   ", "a\nb", String(repeating: "x", count: 121), String(repeating: "😀", count: 61)] { expect(.invalid) { _ = try input(direct.id, label) } }
        let equivalent = try records.editing(input(direct.id, "Equivalent", url: "https://HOST.example.invalid:443/"))
        require(equivalent.connections[0].url == direct.url && equivalent.connections[0].token == direct.token, "Equivalent origin rewrote authorization")
        for url in ["https://new.example.invalid", "http://host.example.invalid", "https://host.example.invalid:444"] { expect(.pairingRequired) { _ = try records.editing(input(direct.id, url: url)) } }
        for url in ["ssh://host.example.invalid", "https://user:password@host.example.invalid", "https://host.example.invalid/path", "https://host.example.invalid/?token=synthetic", "https://host.example.invalid/#fragment", "https://host.example.invalid/%2f", "https://host.example.invalid:0"] { expect(.invalid) { _ = try records.editing(input(direct.id, url: url)) } }
        expect(.pairingRequired) { _ = try records.editing(input(b.id, url: "wss://new.example.invalid")) }
        expect(.invalid) { _ = try ConnectionEditorInput(["id": direct.id, "label": "Name", "version": "legacy", "relay": [:]]) }
        expect(.invalid) { _ = try ConnectionEditorInput(["id": direct.id, "label": "Name", "version": "legacy", "url": direct.url.absoluteString], rename: true) }
        // An SSH/new-origin edit cannot reuse credentials, and an old Relay record cannot be reattached.
        expect(.pairingRequired) { try records.validateReplacement(id: direct.id, version: "legacy", input: ["url": "https://new.example.invalid"]) }
        expect(.pairingRequired) { try records.validateReplacement(id: direct.id, version: "legacy", input: ["token": token]) }
        expect(.pairingRequired) { try records.validateReplacement(id: direct.id, version: "legacy", input: ["token": otherToken]) }
        expect(.pairingRequired) { try records.validateReplacement(id: b.id, version: "legacy", input: ["token": UUID().uuidString]) }
        try records.validateReplacement(id: direct.id, version: "legacy", input: ["token": UUID().uuidString])
        try records.validateReplacement(id: b.id, version: "legacy", input: ["pairingLink": "synthetic-explicit-pairing"])
        let candidate = SavedConnection(id: "discarded", label: "Replacement", url: URL(string: "https://replacement.example.invalid")!, token: UUID().uuidString, lastUsedAt: 999)
        let replaced = try records.replacing(id: direct.id, version: "legacy", candidate: candidate)
        let selectedReplacement = try ConnectionEditorRecords(connections: [direct], selected: direct.id).replacing(id: direct.id, version: "legacy", candidate: candidate)
        require(selectedReplacement.selected == direct.id, "Active replacement lost selection")
        require(replaced.connections[0].id == direct.id && replaced.connections[0].lastUsedAt == direct.lastUsedAt && replaced.selected == a.id, "Replacement changed stable identity/selection")
        require(replaced.connections[0].relay == nil && replaced.connections[0].token == candidate.token && replaced.connections[1].relay == relayA && replaced.connections[2].relay == relayB, "Replacement leaked/mutated another authorization")
        expect(.duplicate) { _ = try records.replacing(id: direct.id, version: "legacy", candidate: b) }
        expect(.stale) { _ = try replaced.replacing(id: direct.id, version: "legacy", candidate: candidate) }
        expect(.storage) { try records.commit(replaced) { _ in throw ConnectionEditorFailure.storage } }
        require(records.connections[0].token == direct.token && records.connections[0].url == direct.url, "Replacement write failure lost old credentials")
        print("connection-editor Foundation synthetic harness passed")
    }
}
