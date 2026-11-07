import Foundation

@main struct NotificationLaunchHarness {
    @MainActor static func main() async throws {
        let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
        let file = root.appendingPathComponent("receipts.json")
        let target = try NativeNotificationTarget(["kind": "session", "id": "session-a"])
        let admission = try NativeNotificationAdmission(["v": 1, "kind": "completion", "eventID": "admitted_completion_9_session-a_5_event", "target": target.value,
            "source": ["type": "session", "sessionID": "session-a", "directory": "/workspace/a", "parentID": NSNull(), "boundaryID": "event"]])
        let receipt = UUID().uuidString, other = UUID().uuidString
        var inbox = try NativeNotificationLaunchInbox(file: file)
        try inbox.record(receipt: receipt, hostID: "host-a", authorizationID: "authorization-a", admission: admission)
        inbox = try NativeNotificationLaunchInbox(file: file) // Simulated process death before the tap.
        precondition(inbox.pending == nil)
        let payload: [AnyHashable: Any] = ["v": 1, "receipt": receipt]
        let identifier = NativeNotificationLaunchInbox.prefix + receipt
        for (action, id, value): (String, String, [AnyHashable: Any]) in [
            ("dismiss", identifier, payload), ("default", "unrelated", payload),
            ("default", identifier, ["sessionId": "session-a"]),
            ("default", identifier, ["v": 1, "receipt": receipt, "hostID": "host-b"])
        ] { let accepted = try inbox.receive(action: action, identifier: id, payload: value); precondition(!accepted) }
        let accepted = try inbox.receive(action: "default", identifier: identifier, payload: payload); precondition(accepted)
        let duplicate = try inbox.receive(action: "default", identifier: identifier, payload: payload); precondition(duplicate)
        inbox = try NativeNotificationLaunchInbox(file: file) // Simulated process death while root is not ready.
        precondition(inbox.pending?.connectionID == "host-a" && inbox.pending?.target == target)
        let restored = try inbox.claim(receipt: receipt, hostID: "host-a", authorizationID: "authorization-a")
        precondition(restored.admission.eventID == admission.eventID)
        for (hostID, authorizationID) in [("host-b", "authorization-a"), ("host-a", "authorization-b"), ("host-a", "legacy")] {
            do { _ = try inbox.claim(receipt: receipt, hostID: hostID, authorizationID: authorizationID); fatalError("wrong authority accepted") } catch {}
        }
        for now in [restored.createdAt - 1, restored.createdAt + 7 * 24 * 60 * 60 * 1000] {
            do { _ = try inbox.claim(receipt: receipt, hostID: "host-a", authorizationID: "authorization-a", now: now); fatalError("expired/future record accepted") } catch {}
        }
        try inbox.remove(receipt) // Runtime invalidation must not consume a queued tap.
        precondition(inbox.pending?.receipt == receipt)
        try inbox.record(receipt: other, hostID: "host-b", authorizationID: "authorization-b", admission: admission)
        let newer = try inbox.receive(action: "default", identifier: NativeNotificationLaunchInbox.prefix + other, payload: ["v": 1, "receipt": other]); precondition(newer)
        precondition(inbox.pending?.receipt == other && inbox.queuedReceipt == other)
        do { try inbox.consume(receipt: other, expectedRevision: 2, hostID: "host-b", authorizationID: "authorization-b"); fatalError("wrong CAS accepted") } catch {}
        precondition(inbox.pending?.receipt == other)
        try inbox.consume(receipt: other, expectedRevision: 1, hostID: "host-b", authorizationID: "authorization-b")
        inbox = try NativeNotificationLaunchInbox(file: file)
        precondition(inbox.pending == nil) // Newest wins; older queued taps do not open after an ACK.
        let replay = try inbox.receive(action: "default", identifier: NativeNotificationLaunchInbox.prefix + other, payload: ["v": 1, "receipt": other]); precondition(!replay)
        let keep = UUID().uuidString
        try inbox.record(receipt: keep, hostID: "host-a", authorizationID: "authorization-b", admission: admission)
        let retired = try inbox.retireAuthorization(connectionID: "host-a", authorizationID: "authorization-a")
        precondition(retired == [receipt] && inbox.records.contains { $0.receipt == keep })
        let kept = inbox.records.first { $0.receipt == keep }!
        precondition(Set(kept.value.keys) == ["v", "receipt", "revision", "connectionID", "authorizationID", "admission", "createdAt", "expiresAt"])

        for late in [false, true] {
            let failed = UUID().uuidString
            try inbox.record(receipt: failed, hostID: "host-a", authorizationID: "authorization-b", admission: admission)
            var current = true, removedOS = 0
            do {
                try await NativeNotificationLaunchDelivery.submit(inbox: inbox, receipt: failed, current: { current }, add: {
                    await Task.yield()
                    if late { current = false } else { throw NativeNotificationFailure.unavailable }
                }, removeOS: { removedOS += 1 })
                fatalError("failed/late OS add accepted")
            } catch {}
            precondition(removedOS == 1 && !inbox.records.contains { $0.receipt == failed } && inbox.records.contains { $0.receipt == keep })
        }

        // A failed atomic write preserves the authoritative in-memory snapshot.
        let blocked = root.appendingPathComponent("blocked")
        let failing = try NativeNotificationLaunchInbox(file: blocked.appendingPathComponent("receipts.json"))
        try Data().write(to: blocked)
        do { try failing.record(receipt: UUID().uuidString, hostID: "host-a", authorizationID: "authorization-a", admission: admission); fatalError("failed write accepted") } catch {}
        precondition(failing.records.isEmpty)
        let failureDir = root.appendingPathComponent("consume-failure")
        let consumeFile = failureDir.appendingPathComponent("receipts.json")
        let consumeInbox = try NativeNotificationLaunchInbox(file: consumeFile), consumeReceipt = UUID().uuidString
        try consumeInbox.record(receipt: consumeReceipt, hostID: "host-a", authorizationID: "authorization-a", admission: admission)
        _ = try consumeInbox.receive(action: "default", identifier: NativeNotificationLaunchInbox.prefix + consumeReceipt, payload: ["v": 1, "receipt": consumeReceipt])
        try FileManager.default.moveItem(at: failureDir, to: root.appendingPathComponent("consume-failure-retained"))
        try Data().write(to: failureDir)
        do { try consumeInbox.consume(receipt: consumeReceipt, expectedRevision: 1, hostID: "host-a", authorizationID: "authorization-a"); fatalError("failed consume accepted") } catch {}
        precondition(consumeInbox.pending?.receipt == consumeReceipt)
        for change in ["eventID", "kind", "source", "v"] {
            var invalid = admission.value
            invalid[change] = change == "v" ? true : "wrong"
            do { _ = try NativeNotificationAdmission(invalid); fatalError("invalid admission accepted") } catch {}
        }
        let malformed = root.appendingPathComponent("malformed.json")
        try Data("{\"v\":true,\"records\":[]}".utf8).write(to: malformed)
        do { _ = try NativeNotificationLaunchInbox(file: malformed); fatalError("boolean version accepted") } catch {}

        let apns = NativeNotificationAPNSRegistration()
        var current = true, methods: [String] = []
        var finish: CheckedContinuation<(Int, [String: Any]), Never>?
        func context(verified: Bool, delayed: Bool = false) -> NativeNotificationAPNSRegistration.Context {
            .init(hostID: "host-a", bundleID: "com.example.installed", locale: "en", verifiedPushConfiguration: verified, isCurrent: { current }, request: { method, path, body in
                precondition(path == "/api/push/apns-token")
                precondition(Set(body.keys) == (method == "POST" ? ["token", "platform", "locale", "bundleId"] : ["token"]))
                methods.append(method)
                if delayed && method == "POST" { return await withCheckedContinuation { finish = $0 } }
                return (200, ["ok": true])
            })
        }
        precondition(!apns.begin(context(verified: false)) && apns.state == .blocked && methods.isEmpty)
        precondition(apns.begin(context(verified: true)))
        apns.invalidate()
        precondition(!apns.begin(context(verified: true))) // Do not assign a late OS callback to a new request.
        await apns.didRegister(Data(repeating: 0, count: 32)) // Synthetic bytes only; no OS registration.
        precondition(methods.isEmpty)
        precondition(apns.begin(context(verified: true)))
        await apns.didRegister(Data(repeating: 0, count: 32))
        precondition(apns.state == .hostAccepted && methods == ["POST"])
        let removed = await apns.cancel(); precondition(removed && methods == ["POST", "DELETE"])
        precondition(apns.begin(context(verified: true, delayed: true)))
        let task = Task { @MainActor in await apns.didRegister(Data(repeating: 0, count: 32)) }
        while finish == nil { await Task.yield() }
        apns.invalidate(); current = false
        finish?.resume(returning: (200, ["ok": true])); await task.value
        precondition(apns.state == .cleanupPending)
        let staleCleanup = await apns.cancel(); precondition(!staleCleanup)
        precondition(methods == ["POST", "DELETE", "POST"]) // Never DELETE using a new Host's credentials.
        precondition(!apns.begin(context(verified: true)))
        print("Notification launch Foundation/synthetic delegate and APNs fencing passed; no OS or network calls")
    }
}
