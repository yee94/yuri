import Foundation

@main struct NotificationRetirementHarness {
    static let old = "12345678-1234-1234-1234-123456789ab1"
    static let next = "12345678-1234-1234-1234-123456789ab2"
    static let peer = "12345678-1234-1234-1234-123456789ab3"
    static func admission() throws -> NativeNotificationAdmission {
        try NativeNotificationAdmission(["v": 1, "kind": "completion", "eventID": "admitted_completion_1_s_1_e", "target": ["kind": "session", "id": "s"],
            "source": ["type": "session", "sessionID": "s", "directory": "/synthetic", "parentID": NSNull(), "boundaryID": "e"]])
    }
    static func populated() throws -> NativeNotificationLaunchInbox {
        let inbox = try NativeNotificationLaunchInbox()
        for (receipt, host, auth) in [(old, "host", "auth-old"), (next, "host", "auth-new"), (peer, "peer", "auth-old")] {
            try inbox.record(receipt: receipt, hostID: host, authorizationID: auth, admission: admission())
        }
        _ = try inbox.receive(action: "default", identifier: NativeNotificationLaunchInbox.prefix + next, payload: ["v": 1, "receipt": next])
        return inbox
    }
    static func rejects(_ work: () throws -> Void) {
        do { try work(); fatalError("invalid transaction accepted") } catch {}
    }
    @MainActor static func clean(_ inbox: NativeNotificationLaunchInbox, pending: Set<String> = [], delivered: Set<String> = [], failRead: Bool = false, removed: @escaping ([String]) -> Void = { _ in }) async throws {
        try await NativeNotificationRetirementCleanup.run(inbox: inbox, connectionID: "host", authorizationID: "auth-old", remove: removed,
            pending: { if failRead { throw NativeNotificationFailure.unavailable }; await Task.yield(); return Array(pending) },
            delivered: { await Task.yield(); return Array(delivered) })
    }
    @MainActor static func main() async throws {
        let scenario = CommandLine.arguments[1]
        switch scenario {
        case "legacy":
            let legacy = try JSONSerialization.data(withJSONObject: ["v": 1, "records": [], "queuedReceipt": NSNull()])
            let inbox = try NativeNotificationLaunchInbox(memoryData: legacy)
            precondition(inbox.pendingRetirements.isEmpty && inbox.writes == 0 && inbox.memoryPersisted == legacy)
        case "begin-crash", "export":
            let inbox = try populated()
            let batch = try inbox.beginRetirement(connectionID: "host", authorizationID: "auth-old")
            precondition(batch.receipts == [old] && batch.identifiers == [NativeNotificationLaunchInbox.prefix + old])
            precondition(inbox.pending?.receipt == next && inbox.records.count == 2)
            let restored = try NativeNotificationLaunchInbox(memoryData: inbox.memoryPersisted)
            let replay = try restored.beginRetirement(connectionID: "host", authorizationID: "auth-old")
            precondition(replay.receipts == [old] && restored.pendingRetirements.count == 1 && restored.writes == 0)
            let accepted = try restored.receive(action: "default", identifier: NativeNotificationLaunchInbox.prefix + old, payload: ["v": 1, "receipt": old])
            precondition(!accepted && restored.pending?.receipt == next)
            rejects { _ = try restored.claim(receipt: old, hostID: "host", authorizationID: "auth-old") }
            rejects { try restored.record(receipt: old, hostID: "host", authorizationID: "auth-old", admission: admission()) }
            if scenario == "export" { print(String(data: inbox.memoryPersisted!, encoding: .utf8)!); return }
        case "restore":
            let data = FileHandle.standardInput.readDataToEndOfFile()
            let inbox = try NativeNotificationLaunchInbox(memoryData: data)
            var removals: [String] = []
            try await clean(inbox, removed: { removals += $0 })
            precondition(removals == [NativeNotificationLaunchInbox.prefix + old] && inbox.pendingRetirements.isEmpty && inbox.pending?.receipt == next)
        case "begin-failure":
            let inbox = try populated(), prior = inbox.memoryPersisted
            inbox.failNextWrite = true
            rejects { _ = try inbox.beginRetirement(connectionID: "host", authorizationID: "auth-old") }
            precondition(inbox.memoryPersisted == prior && inbox.records.count == 3 && inbox.pendingRetirements.isEmpty && inbox.pending?.receipt == next)
            inbox.failNextWrite = true; var removes = 0
            do { try await clean(inbox, removed: { _ in removes += 1 }); fatalError("begin failure swallowed") } catch {}
            precondition(removes == 0)
        case "os-before-ack":
            let inbox = try populated()
            let batch = try inbox.beginRetirement(connectionID: "host", authorizationID: "auth-old")
            var os = Set(batch.identifiers)
            for id in batch.identifiers { os.remove(id) } // Process exits here, without persistent ACK.
            let restored = try NativeNotificationLaunchInbox(memoryData: inbox.memoryPersisted)
            var removals: [String] = []
            try await clean(restored, pending: os, removed: { removals += $0 })
            precondition(removals == batch.identifiers && restored.pendingRetirements.isEmpty && restored.records.count == 2)
        case "ack-failure":
            let inbox = try populated()
            _ = try inbox.beginRetirement(connectionID: "host", authorizationID: "auth-old")
            let prior = inbox.memoryPersisted
            inbox.failNextWrite = true
            do { try await clean(inbox); fatalError("ACK failure swallowed") } catch {}
            precondition(inbox.memoryPersisted == prior && inbox.pendingRetirements.count == 1 && inbox.records.count == 2)
            let restored = try NativeNotificationLaunchInbox(memoryData: inbox.memoryPersisted)
            try await clean(restored)
            precondition(restored.pendingRetirements.isEmpty && restored.pending?.receipt == next)
        case "readback":
            for (pending, delivered, failure) in [(Set([NativeNotificationLaunchInbox.prefix + old]), Set<String>(), false),
                (Set<String>(), Set([NativeNotificationLaunchInbox.prefix + old]), false), (Set<String>(), Set<String>(), true)] {
                let inbox = try populated()
                do { try await clean(inbox, pending: pending, delivered: delivered, failRead: failure); fatalError("unconfirmed cleanup accepted") } catch {}
                precondition(inbox.pendingRetirements.count == 1 && !inbox.records.contains { $0.receipt == old } && inbox.pending?.receipt == next)
                try await clean(inbox, pending: ["unrelated"], delivered: [NativeNotificationLaunchInbox.prefix + next, NativeNotificationLaunchInbox.prefix + peer])
                precondition(inbox.pendingRetirements.isEmpty && inbox.pending?.receipt == next)
            }
        case "capacity":
            let inbox = try NativeNotificationLaunchInbox()
            for _ in 0..<256 { try inbox.record(receipt: UUID().uuidString, hostID: "host", authorizationID: "auth-old", admission: admission(), now: 0) }
            let batch = try inbox.beginRetirement(connectionID: "host", authorizationID: "auth-old")
            precondition(batch.receipts.count == 256)
            let restored = try NativeNotificationLaunchInbox(memoryData: inbox.memoryPersisted)
            rejects { try restored.record(receipt: next, hostID: "host", authorizationID: "auth-new", admission: admission()) }
            precondition(restored.pendingRetirements.count == 256 && restored.records.isEmpty)
            try restored.acknowledgeRetirement(.init(connectionID: "host", authorizationID: "auth-old", receipts: [batch.receipts[0]]))
            try restored.record(receipt: next, hostID: "host", authorizationID: "auth-new", admission: admission())
            _ = try restored.receive(action: "default", identifier: NativeNotificationLaunchInbox.prefix + next, payload: ["v": 1, "receipt": next])
            rejects { try restored.record(receipt: peer, hostID: "peer", authorizationID: "auth-new", admission: admission()) }
            precondition(restored.pending?.receipt == next && restored.pendingRetirements.count == 255)
        case "malformed":
            let row: [String: Any] = ["connectionID": "host", "authorizationID": "auth-old", "receipt": old]
            for value: Any in [NSNull(), [row, row], [["connectionID": "host", "authorizationID": "legacy", "receipt": old]], [["connectionID": "host", "authorizationID": "auth-old", "receipt": old, "extra": true]], Array(repeating: row, count: 257)] {
                let data = try JSONSerialization.data(withJSONObject: ["v": 1, "records": [], "queuedReceipt": NSNull(), "pendingRetirements": value])
                rejects { _ = try NativeNotificationLaunchInbox(memoryData: data) }
            }
            let inbox = try populated()
            var root = try JSONSerialization.jsonObject(with: inbox.memoryPersisted!) as! [String: Any]
            root["pendingRetirements"] = [row]
            let conflict = try JSONSerialization.data(withJSONObject: root)
            rejects { _ = try NativeNotificationLaunchInbox(memoryData: conflict) }
        case "precise-ack":
            let inbox = try populated()
            let first = try inbox.beginRetirement(connectionID: "host", authorizationID: "auth-old")
            let second = try inbox.beginRetirement(connectionID: "peer", authorizationID: "auth-old")
            try inbox.acknowledgeRetirement(.init(connectionID: "host", authorizationID: "auth-new", receipts: first.receipts))
            precondition(inbox.pendingRetirements.count == 2)
            try inbox.acknowledgeRetirement(first)
            precondition(inbox.pendingRetirements.map(\.receipt) == second.receipts && inbox.pending?.receipt == next)
            let writes = inbox.writes
            try inbox.acknowledgeRetirement(first)
            precondition(inbox.writes == writes && inbox.pendingRetirements.count == 1)
            try inbox.acknowledgeRetirement(second)
            precondition(inbox.pendingRetirements.isEmpty && inbox.pending?.receipt == next)
        case "queued-retirement":
            let inbox = try populated()
            _ = try inbox.receive(action: "default", identifier: NativeNotificationLaunchInbox.prefix + old, payload: ["v": 1, "receipt": old])
            _ = try inbox.beginRetirement(connectionID: "host", authorizationID: "auth-old")
            let restored = try NativeNotificationLaunchInbox(memoryData: inbox.memoryPersisted)
            precondition(restored.pending == nil && restored.queuedReceipt == nil && restored.records.count == 2)
            try restored.remove(old, includingQueued: true) // Late add cleanup cannot erase the tombstone.
            precondition(restored.pendingRetirements.map(\.receipt) == [old])
            try await clean(restored)
            let accepted = try restored.receive(action: "default", identifier: NativeNotificationLaunchInbox.prefix + old, payload: ["v": 1, "receipt": old])
            precondition(!accepted && restored.pending == nil)
        case "late-add":
            let inbox = try populated()
            var release: CheckedContinuation<Void, Never>?
            var os: Set<String> = [], removed = false, settled = false
            let work = Task { @MainActor in
                try await NativeNotificationRetirementCleanup.run(inbox: inbox, connectionID: "host", authorizationID: "auth-old", settleAdds: { receipts in
                    precondition(receipts == [old]); await withCheckedContinuation { release = $0 }; settled = true
                }, remove: { identifiers in
                    precondition(settled); removed = true; for id in identifiers { os.remove(id) }
                }, pending: { Array(os) }, delivered: { [] })
            }
            while release == nil { await Task.yield() }
            precondition(!removed && inbox.pendingRetirements.map(\.receipt) == [old])
            os.insert(NativeNotificationLaunchInbox.prefix + old) // Synthetic add accepts only after begin.
            release?.resume(); try await work.value
            precondition(removed && os.isEmpty && inbox.pendingRetirements.isEmpty)
        case "cancelled":
            let inbox = try populated()
            let work = Task { @MainActor in
                try await NativeNotificationRetirementCleanup.run(inbox: inbox, connectionID: "host", authorizationID: "auth-old", settleAdds: { _ in
                    withUnsafeCurrentTask { $0?.cancel() }
                }, remove: { _ in fatalError("cancelled work removed notifications") }, pending: { [] }, delivered: { [] })
            }
            do { try await work.value; fatalError("cancelled attempt acknowledged") } catch {}
            precondition(inbox.pendingRetirements.map(\.receipt) == [old])
        default: fatalError("unknown scenario")
        }
        print("PASS \(scenario)")
    }
}
