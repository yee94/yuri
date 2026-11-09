import Foundation

@main struct ConnectionTransportHarness {
    static func require(_ value: @autoclosure () -> Bool, _ message: String) {
        if !value() { fatalError(message) }
    }
    static func rejects(_ work: () throws -> Void) {
        do { try work(); fatalError("Expected rejection") } catch { }
    }
    @MainActor static func main() throws {
        let direct = URL(string: "https://host.example.invalid")!
        let legacy = SavedConnection(id: "old-record", label: "Kept", url: direct, token: "synthetic-token", lastUsedAt: 42)
        let legacyBytes = try JSONEncoder().encode(ConnectionEditorRecords(connections: [legacy], selected: legacy.id))
        let decoded = try JSONDecoder().decode(ConnectionEditorRecords.self, from: legacyBytes)
        require(decoded.transportPartitions == nil && decoded.connections[0].transportID == nil, "Legacy decode issued transient identity")
        rejects { _ = try ConnectionStore(memoryData: legacyBytes, failWrites: true) }
        let store = try ConnectionStore(memoryData: legacyBytes)
        let original = store.selected!
        let first = original.transportID!
        require(UUID(uuidString: first) != nil, "Identity is not opaque UUID")
        require(original.id == legacy.id && original.url == legacy.url && original.token == legacy.token && original.label == legacy.label && original.authorizationID == nil && original.lastUsedAt == 42, "Migration changed existing connection or manufactured authorization")
        require(store.persisted != legacyBytes, "Migration did not persist before snapshot")
        let cold = try ConnectionStore(memoryData: store.persisted)
        require(cold.selected?.transportID == first, "Cold restore changed partition")
        require(Set(original.publicValue.keys) == Set(["id", "label", "url", "transport", "lastUsedAt", "transportID"]), "Snapshot leaked private partition mapping")
        let beforeFailure = store.persisted
        store.failWrites = true
        rejects { try store.save(url: URL(string: "https://other.example.invalid")!, token: "synthetic-new-token", label: "Rejected") }
        require(store.persisted == beforeFailure && store.selected?.transportID == first && store.selected?.id == original.id, "Failed atomic write published connection or temporary UUID")
        store.failWrites = false
        try store.save(url: URL(string: "https://HOST.example.invalid:443/")!, token: "synthetic-rotated-token", label: "New label")
        require(store.selected?.transportID == first && store.selected?.id == legacy.id, "Equivalent origin or credential rotation changed partition")
        let version = store.selected!.editorVersion!
        try store.edit(ConnectionEditorInput(["id": legacy.id, "version": version, "label": "Rename"]))
        require(store.selected?.transportID == first, "Rename changed partition")
        try store.remove(legacy.id)
        try store.save(url: direct, token: "synthetic-third-token", label: "Recreated")
        require(store.selected?.id != legacy.id && store.selected?.transportID == first, "New record ID for same transport lost partition")
        let record = store.selected!
        try store.replace(id: record.id, version: record.editorVersion!, url: URL(string: "https://host.example.invalid:444")!, token: "synthetic-fourth-token", label: "Different port", relay: nil)
        require(store.selected?.id == record.id && store.selected?.transportID != first, "Port change reused partition")
        let changed = store.selected!
        try store.replace(id: changed.id, version: changed.editorVersion!, url: direct, token: "synthetic-fifth-token", label: "Return", relay: nil)
        require(store.selected?.transportID == first, "Returning to same transport lost stable mapping")
        let relayA = RelayConfiguration(relayUrl: "wss://relay.example.invalid/device/path", serverId: "device-a", hostEncPubJwk: ["x": "synthetic-key"])
        let relayEquivalent = RelayConfiguration(relayUrl: "wss://RELAY.example.invalid:443/device/path", serverId: "device-a", hostEncPubJwk: ["x": "synthetic-rotated-key"])
        let relayB = RelayConfiguration(relayUrl: "wss://second.example.invalid/device/path", serverId: "device-a", hostEncPubJwk: [:])
        let relayPath = RelayConfiguration(relayUrl: "wss://relay.example.invalid/other/path", serverId: "device-a", hostEncPubJwk: [:])
        let relayDevice = RelayConfiguration(relayUrl: relayA.relayUrl, serverId: "device-b", hostEncPubJwk: [:])
        let placeholder = URL(string: "https://relay.invalid")!
        var relayIDs: [String] = []
        for relay in [relayA, relayB, relayPath, relayDevice] {
            try store.save(url: placeholder, token: "synthetic-relay-token", label: "Relay", relay: relay)
            relayIDs.append(store.selected!.transportID!)
        }
        require(Set(relayIDs + [first]).count == 5, "Relay origin/path/device or direct partition merged")
        try store.save(url: placeholder, token: "synthetic-other-token", label: "Same route", relay: relayEquivalent)
        require(store.selected?.transportID == relayIDs[0], "Relay credential/key rotation or equivalent origin changed partition")
        let relayRecord = store.selected!
        rejects { try store.replace(id: relayRecord.id, version: relayRecord.editorVersion!, url: direct, token: "synthetic-authorized-token", label: "Direct", relay: nil) }
        try store.remove(record.id)
        try store.replace(id: relayRecord.id, version: relayRecord.editorVersion!, url: direct, token: "synthetic-authorized-token", label: "Direct", relay: nil)
        require(store.selected?.id == relayRecord.id && store.selected?.transportID == first && store.selected?.relay == nil, "Authorized Relay/direct replacement used record identity")
        let restored = try ConnectionStore(memoryData: store.persisted)
        require(restored.selected?.transportID == first, "Durable mapping lost after route replacement")
        let bytes = store.persisted!
        let data = try JSONSerialization.jsonObject(with: bytes) as! [String: Any]
        let partitions = data["transportPartitions"] as! [[String: Any]]
        let mappingText = String(data: try JSONSerialization.data(withJSONObject: partitions), encoding: .utf8)!
        require(!mappingText.contains("synthetic-") && !mappingText.contains("hostEncPubJwk") && !mappingText.contains("token"), "Transport mapping persisted credentials")
        for mode in ["null", "duplicate-tuple", "duplicate-id", "malformed-id", "credential-route", "missing-map", "wrong-connection-id", "extra-field"] {
            var malformed = data
            var items = partitions
            switch mode {
            case "null": malformed["transportPartitions"] = NSNull()
            case "duplicate-tuple": items.append(items[0]); malformed["transportPartitions"] = items
            case "duplicate-id": items[1]["id"] = items[0]["id"]; malformed["transportPartitions"] = items
            case "malformed-id": items[0]["id"] = "not-an-opaque-uuid"; malformed["transportPartitions"] = items
            case "credential-route": items[0]["transport"] = ["address": "https://user:synthetic@host.example.invalid"]; malformed["transportPartitions"] = items
            case "missing-map": malformed.removeValue(forKey: "transportPartitions")
            case "wrong-connection-id":
                var rows = malformed["connections"] as! [[String: Any]]; rows[0]["transportID"] = UUID().uuidString.lowercased(); malformed["connections"] = rows
            default: items[0]["credential"] = "synthetic"; malformed["transportPartitions"] = items
            }
            let broken = try JSONSerialization.data(withJSONObject: malformed)
            rejects { _ = try ConnectionStore(memoryData: broken) }
        }
        var full = data, fullPartitions = partitions
        while fullPartitions.count < ConnectionEditorRecords.transportPartitionLimit {
            fullPartitions.append(["transport": ["address": "https://capacity-\(fullPartitions.count).example.invalid"], "id": UUID().uuidString.lowercased()])
        }
        full["transportPartitions"] = fullPartitions
        let capacityBytes = try JSONSerialization.data(withJSONObject: full)
        let capacity = try ConnectionStore(memoryData: capacityBytes)
        rejects { try capacity.save(url: URL(string: "https://overflow.example.invalid")!, token: "synthetic", label: "Overflow") }
        require(capacity.persisted == capacityBytes && capacity.selected?.transportID == first, "Capacity failure evicted stable partition or changed connection")
        print("connection-transport atomic harness passed")
    }
}
