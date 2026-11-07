import Foundation

@main struct AuthorizationRetirementChecks {
    static let first = "authorization-a1", second = "authorization-a2"
    static func row(_ id: String = "A", _ authorization: String? = first, relay: RelayConfiguration? = nil) -> SavedConnection {
        SavedConnection(id: id, label: id, url: URL(string: "https://\(id.lowercased()).synthetic.invalid")!, token: "synthetic-credential-\(id)", lastUsedAt: 1, relay: relay, editorVersion: "version-1", authorizationID: authorization)
    }
    static func bytes(_ rows: [SavedConnection], selected: String? = "A") throws -> Data {
        try JSONEncoder().encode(ConnectionEditorRecords(connections: rows, selected: selected))
    }
    static func rejected(_ work: () throws -> Void) {
        do { try work(); fatalError("expected failure") } catch {}
    }
    static func object(_ bytes: Data) throws -> [String: Any] { try JSONSerialization.jsonObject(with: bytes) as! [String: Any] }
    @MainActor static func main() throws {
        let mode = CommandLine.arguments[1]
        let retiredA = try AuthorizationRetirement(connectionID: "A", authorizationID: first)
        if mode == "restore" {
            let data = Data(base64Encoded: String(data: FileHandle.standardInput.readDataToEndOfFile(), encoding: .utf8)!.trimmingCharacters(in: .whitespacesAndNewlines))!
            let store = try ConnectionStore(memoryData: data)
            precondition(store.selected == nil && store.pendingAuthorizationRetirements.count == 1 && store.writes == 0)
            precondition(store.pendingAuthorizationRetirements[0] == retiredA)
            print("PASS restore"); return
        }
        let a = row(), b = row("B", "authorization-b1")
        let store = try ConnectionStore(memoryData: bytes([a, b]))
        if mode == "export" {
            try store.remove("A")
            print(store.memoryPersisted!.base64EncodedString()); return
        }
        switch mode {
        case "legacy":
            var legacy = try object(bytes([row("A", nil)])); legacy.removeValue(forKey: "pendingAuthorizationRetirements")
            let old = try ConnectionStore(memoryData: JSONSerialization.data(withJSONObject: legacy))
            precondition(old.writes == 0 && old.pendingAuthorizationRetirements.isEmpty && old.selected?.authorizationID == nil)
            try old.remove("A"); precondition(old.pendingAuthorizationRetirements.isEmpty)
            let legacyReauth = try ConnectionStore(memoryData: JSONSerialization.data(withJSONObject: legacy))
            try legacyReauth.save(url: a.url, token: a.token, label: "Reauthorized legacy")
            precondition(legacyReauth.selected?.authorizationID != nil && legacyReauth.pendingAuthorizationRetirements.isEmpty)
            let valid = try ConnectionStore(memoryData: bytes([a]))
            let restarted = try ConnectionStore(memoryData: valid.memoryPersisted)
            precondition(restarted.selected?.authorizationID == first && restarted.pendingAuthorizationRetirements.isEmpty && restarted.writes == 0)
        case "atomic":
            let before = store.memoryPersisted
            store.failNextWrite = true; rejected { try store.remove("A") }
            precondition(store.memoryPersisted == before && store.selected?.authorizationID == first && store.pendingAuthorizationRetirements.isEmpty)
            try store.remove("A")
            let restored = try ConnectionStore(memoryData: store.memoryPersisted)
            precondition(restored.selected == nil && (restored.snapshot["connections"] as! [[String: Any]]).count == 1)
            precondition(restored.pendingAuthorizationRetirements == [retiredA])
            let rows = try object(store.memoryPersisted!)["pendingAuthorizationRetirements"] as! [[String: Any]]
            precondition(Set(rows[0].keys) == ["connectionID", "authorizationID"])
            let journalBytes = try JSONSerialization.data(withJSONObject: rows)
            precondition(!String(data: journalBytes, encoding: .utf8)!.contains("synthetic"))
        case "metadata":
            try store.edit(ConnectionEditorInput(["id": "A", "version": "version-1", "label": "Renamed"]))
            try store.select("B"); try store.select("A")
            precondition(store.pendingAuthorizationRetirements.isEmpty && store.selected?.authorizationID == first)
            let restarted = try ConnectionStore(memoryData: store.memoryPersisted)
            precondition(restarted.pendingAuthorizationRetirements.isEmpty && restarted.selected?.authorizationID == first)
            try store.remove("B")
            try store.select("A")
            let pending = store.pendingAuthorizationRetirements
            try store.edit(ConnectionEditorInput(["id": "A", "version": store.selected!.editorVersion!, "label": "Again"]))
            precondition(store.pendingAuthorizationRetirements == pending)
            var records = try JSONDecoder().decode(ConnectionEditorRecords.self, from: store.memoryPersisted!)
            try records.commit(ConnectionEditorRecords(connections: records.connections, selected: records.selected)) { _ in }
            precondition(records.pendingAuthorizationRetirements == pending)
        case "replacement":
            let before = store.memoryPersisted
            store.failNextWrite = true
            rejected { try store.replace(id: "A", version: "version-1", url: URL(string: "https://replacement.invalid")!, token: "synthetic-new-credential", label: "New", relay: nil) }
            precondition(store.memoryPersisted == before && store.selected?.authorizationID == first && store.pendingAuthorizationRetirements.isEmpty)
            try store.replace(id: "A", version: "version-1", url: URL(string: "https://replacement.invalid")!, token: "synthetic-new-credential", label: "New", relay: nil)
            let changed = store.selected!.authorizationID!
            precondition(changed != first && store.pendingAuthorizationRetirements.count == 1)
            let writes = store.writes
            rejected { try store.replace(id: "A", version: "version-1", url: a.url, token: a.token, label: "Replay", relay: nil) }
            precondition(store.writes == writes && store.selected?.authorizationID == changed)
        case "ack":
            try store.remove("A"); try store.remove("B")
            let removed = store.memoryPersisted, writes = store.writes
            store.failNextWrite = true
            rejected { try store.acknowledgeAuthorizationRetirement(connectionID: "A", authorizationID: first) }
            precondition(store.memoryPersisted == removed && store.pendingAuthorizationRetirements.count == 2 && store.writes == writes)
            let restored = try ConnectionStore(memoryData: store.memoryPersisted)
            try restored.acknowledgeAuthorizationRetirement(connectionID: "A", authorizationID: "wrong-authorization")
            precondition(restored.writes == 0 && restored.pendingAuthorizationRetirements.count == 2)
            try restored.acknowledgeAuthorizationRetirement(connectionID: "A", authorizationID: first)
            precondition(restored.pendingAuthorizationRetirements.count == 1 && restored.pendingAuthorizationRetirements[0].connectionID == "B")
            let afterAck = restored.memoryPersisted
            try restored.acknowledgeAuthorizationRetirement(connectionID: "A", authorizationID: first)
            precondition(restored.memoryPersisted == afterAck && restored.writes == 1 && restored.selected == nil)
        case "aba-relay":
            try store.select("B"); try store.select("A")
            precondition(store.pendingAuthorizationRetirements.isEmpty)
            try store.save(url: a.url, token: a.token, label: "Reauthorize")
            let newAuthorization = store.selected!.authorizationID!
            precondition(newAuthorization != first && store.pendingAuthorizationRetirements.count == 1)
            try store.select("B"); try store.select("A")
            precondition(store.selected?.authorizationID == newAuthorization && store.pendingAuthorizationRetirements.count == 1)
            let ra = RelayConfiguration(relayUrl: "wss://relay-a.invalid", serverId: "same-device", hostEncPubJwk: ["x": "synthetic-a"])
            let rb = RelayConfiguration(relayUrl: "wss://relay-b.invalid", serverId: "same-device", hostEncPubJwk: ["x": "synthetic-b"])
            let relayStore = try ConnectionStore(memoryData: bytes([row("relay-a", first, relay: ra), row("relay-b", second, relay: rb)], selected: "relay-a"))
            try relayStore.save(url: a.url, token: "synthetic-new-relay", label: "A", relay: ra)
            precondition((relayStore.snapshot["connections"] as! [[String: Any]]).count == 2)
            let retiredRelay = try AuthorizationRetirement(connectionID: "relay-a", authorizationID: first)
            precondition(relayStore.pendingAuthorizationRetirements == [retiredRelay])
            try relayStore.select("relay-b"); precondition(relayStore.selected?.authorizationID == second)
            try relayStore.acknowledgeAuthorizationRetirement(connectionID: "relay-a", authorizationID: first)
            precondition(relayStore.selected?.authorizationID == second && relayStore.pendingAuthorizationRetirements.isEmpty)
        case "capacity":
            var snapshot = try object(bytes([a]))
            snapshot["pendingAuthorizationRetirements"] = (0..<ConnectionEditorRecords.retirementLimit).map { ["connectionID": "retired-\($0)", "authorizationID": "authorization-\($0)"] }
            let full = try ConnectionStore(memoryData: JSONSerialization.data(withJSONObject: snapshot)), before = full.memoryPersisted
            do { try full.remove("A"); fatalError("capacity must reject") }
            catch AuthorizationRetirementFailure.capacity {}
            precondition(full.memoryPersisted == before && full.selected?.authorizationID == first && full.pendingAuthorizationRetirements.count == ConnectionEditorRecords.retirementLimit && full.writes == 0)
            try full.edit(ConnectionEditorInput(["id": "A", "version": "version-1", "label": "Rename while full"]))
            try full.select("A")
            precondition(full.writes == 2 && full.pendingAuthorizationRetirements.count == ConnectionEditorRecords.retirementLimit && full.selected?.authorizationID == first)
            try full.acknowledgeAuthorizationRetirement(connectionID: "retired-0", authorizationID: "authorization-0")
            try full.remove("A")
            precondition(full.selected == nil && full.pendingAuthorizationRetirements.count == ConnectionEditorRecords.retirementLimit)
        case "replacement-variants":
            let credential = try ConnectionStore(memoryData: bytes([a]))
            credential.failNextWrite = true
            rejected { try credential.save(url: a.url, token: "synthetic-other", label: "A") }
            precondition(credential.writes == 0 && credential.selected?.authorizationID == first && credential.pendingAuthorizationRetirements.isEmpty)
            try credential.replace(id: "A", version: "version-1", url: a.url, token: "synthetic-other", label: "A", relay: nil)
            precondition(credential.selected?.authorizationID != first && credential.pendingAuthorizationRetirements == [retiredA])
            let origin = try ConnectionStore(memoryData: bytes([a]))
            try origin.replace(id: "A", version: "version-1", url: URL(string: "https://different-origin.invalid")!, token: a.token, label: "A", relay: nil)
            precondition(origin.pendingAuthorizationRetirements == [retiredA])
            let relay = RelayConfiguration(relayUrl: "wss://new-relay.invalid", serverId: "same-device", hostEncPubJwk: ["x": "synthetic"])
            try store.replace(id: "B", version: "version-1", url: b.url, token: b.token, label: "B", relay: relay)
            precondition(store.selected?.authorizationID == first && store.pendingAuthorizationRetirements[0].connectionID == "B")
            let rekey = try ConnectionStore(memoryData: bytes([row("A", first, relay: relay)]))
            let newKey = RelayConfiguration(relayUrl: relay.relayUrl, serverId: relay.serverId, hostEncPubJwk: ["x": "synthetic-new-key"])
            try rekey.replace(id: "A", version: "version-1", url: a.url, token: a.token, label: "A", relay: newKey)
            precondition(rekey.selected?.authorizationID != first && rekey.pendingAuthorizationRetirements == [retiredA])
            var records = ConnectionEditorRecords(connections: [a], selected: "A")
            let changedToken = SavedConnection(id: a.id, label: a.label, url: a.url, token: "synthetic-forged", lastUsedAt: a.lastUsedAt, editorVersion: a.editorVersion, authorizationID: first)
            let changedURL = SavedConnection(id: a.id, label: a.label, url: URL(string: "https://forged.invalid")!, token: a.token, lastUsedAt: a.lastUsedAt, editorVersion: a.editorVersion, authorizationID: first)
            var changedRelay = a; changedRelay.relay = relay
            for forged in [changedToken, changedURL, changedRelay] {
                rejected { try records.commit(ConnectionEditorRecords(connections: [forged], selected: "A")) { _ in fatalError("must reject before persistence") } }
            }
            precondition(records.connections[0].relay == nil && records.pendingAuthorizationRetirements.isEmpty)
        case "ack-generation":
            try store.save(url: a.url, token: a.token, label: "A2")
            let a2 = store.selected!.authorizationID!
            try store.save(url: a.url, token: a.token, label: "A3")
            let a3 = store.selected!.authorizationID!
            precondition(a3 != a2 && a2 != first && store.pendingAuthorizationRetirements.count == 2)
            try store.acknowledgeAuthorizationRetirement(connectionID: "A", authorizationID: first)
            try store.acknowledgeAuthorizationRetirement(connectionID: "A", authorizationID: first)
            precondition(store.selected?.authorizationID == a3 && store.pendingAuthorizationRetirements.count == 1 && store.pendingAuthorizationRetirements[0].authorizationID == a2)
        case "malformed":
            let base = try object(bytes([a]))
            for pending: Any in [NSNull(), [["connectionID": "A", "authorizationID": first]], [["connectionID": "old", "authorizationID": "legacy"]], [["connectionID": "https://url.invalid", "authorizationID": first]], [["connectionID": "old", "authorizationID": first, "token": "synthetic-forbidden"]], [["connectionID": "old", "authorizationID": first], ["connectionID": "old", "authorizationID": first]]] {
                var malformed = base; malformed["pendingAuthorizationRetirements"] = pending
                rejected { _ = try ConnectionStore(memoryData: JSONSerialization.data(withJSONObject: malformed)) }
            }
            var oversized = base
            oversized["pendingAuthorizationRetirements"] = (0...ConnectionEditorRecords.retirementLimit).map { ["connectionID": "old-\($0)", "authorizationID": "authorization-\($0)"] }
            do { _ = try ConnectionStore(memoryData: JSONSerialization.data(withJSONObject: oversized)); fatalError("oversized decode must fail") }
            catch AuthorizationRetirementFailure.capacity {}
        case "notification-idempotence":
            try notifications(store)
        default: fatalError("unknown scenario")
        }
        print("PASS \(mode)")
    }
    @MainActor static func notifications(_ store: ConnectionStore) throws {
        let target = try NativeNotificationTarget(["kind": "session", "id": "session-a"])
        let admission = try NativeNotificationAdmission(["v": 1, "kind": "completion", "eventID": "admitted_completion_9_session-a_5_event", "target": target.value,
            "source": ["type": "session", "sessionID": "session-a", "directory": "/synthetic", "parentID": NSNull(), "boundaryID": "event"]])
        let inbox = try NativeNotificationLaunchInbox(), receipt = UUID().uuidString, keep = UUID().uuidString, other = UUID().uuidString
        try inbox.record(receipt: receipt, hostID: "A", authorizationID: first, admission: admission)
        try inbox.record(receipt: keep, hostID: "A", authorizationID: second, admission: admission)
        try inbox.record(receipt: other, hostID: "B", authorizationID: first, admission: admission)
        let restarted = try NativeNotificationLaunchInbox(memoryData: inbox.memoryPersisted)
        precondition(restarted.records.count == 3) // Restart alone never revokes valid authorization.
        try store.remove("A")
        inbox.failNextWrite = true
        rejected { _ = try inbox.retireAuthorization(connectionID: "A", authorizationID: first) }
        precondition(inbox.records.count == 3 && store.pendingAuthorizationRetirements.count == 1)
        let retired = try inbox.retireAuthorization(connectionID: "A", authorizationID: first)
        precondition(retired == [receipt] && Set(inbox.records.map(\.receipt)) == [keep, other])
        store.failNextWrite = true
        rejected { try store.acknowledgeAuthorizationRetirement(connectionID: "A", authorizationID: first) }
        let storeAfterExit = try ConnectionStore(memoryData: store.memoryPersisted)
        let inboxAfterExit = try NativeNotificationLaunchInbox(memoryData: inbox.memoryPersisted)
        let duplicate = try inboxAfterExit.retireAuthorization(connectionID: "A", authorizationID: first)
        precondition(duplicate.isEmpty && Set(inboxAfterExit.records.map(\.receipt)) == [keep, other])
        try storeAfterExit.acknowledgeAuthorizationRetirement(connectionID: "A", authorizationID: first)
        precondition(storeAfterExit.pendingAuthorizationRetirements.isEmpty && storeAfterExit.selected == nil)
    }
}
