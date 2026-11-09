import UIKit

@MainActor final class DurableWriteGate {
    var waiting: CheckedContinuation<Void, Never>?
    func commit(_ descriptor: [String: Any], to file: URL) async throws {
        await withCheckedContinuation { waiting = $0 }
        try JSONSerialization.data(withJSONObject: descriptor).write(to: file, options: .atomic)
    }
    func finish() { let pending = waiting; waiting = nil; pending?.resume() }
}

@main @MainActor struct ColdACKContract {
    static func until(_ condition: () -> Bool) async {
        for _ in 0..<10000 { if condition() { return }; await Task.yield() }
        fatalError("cold ACK callback timeout")
    }
    static func main() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let original = directory.appendingPathComponent("original.txt"), bytes = Data("original contact bytes".utf8)
        try bytes.write(to: original)
        for reason in ["background", "switch", "storage", "revoked", "record"] {
            let store = ConnectionStore(), host = SyntheticAttachmentHost()
            let originalConnection = store.state.connections[0]
            var persisted: Data?, failClear = false
            let journal = AttachmentReceiptJournal(load: { persisted }, save: { value in
                if failClear { throw URLError(.cannotWriteToFile) }; persisted = value
            })
            let contextFields: [String: Any] = ["draftIdentity": "same_durable_draft", "draftRevision": 7, "pageOperation": "original_page"]
            let context = try AttachmentDraftContext(contextFields), requestID = "cold_" + reason
            do {
                let producer = RuntimeBridge(store, host)
                let upload = try await producer.contactAttachmentOperation(expectedHost: producer.scope, assistantID: "bot", expectedGeneration: 3, requestID: requestID, context: context, journal: journal)
                host.lostACK = true
                do { _ = try await upload.upload(bytes, "original.txt", "text/plain"); fatalError("lost ACK") } catch { }
            }
            host.lostACK = false
            // Neither the original producer nor its live operation is supplied
            // to the reconstructed bridge. Only durable exact metadata survives.
            let cold = RuntimeBridge(store, host), presenter = UIViewController()
            let bridge = AttachmentBridge(controller: presenter, runtime: cold, journal: journal)
            let expected = cold.scope
            let args: [String: Any] = ["requestId": requestID, "expectedHost": expected.publicValue]
            let gate = DurableWriteGate(), durable = directory.appendingPathComponent(reason + "-draft.json")
            var adopted: [String: Any]?, acknowledged = false
            let networkBefore = host.methods.count
            let flow = Task { @MainActor in
                guard let descriptor = try await bridge.reconcilePick(args) as? [String: Any] else { fatalError("cold commit missing") }
                adopted = descriptor
                try await gate.commit(descriptor, to: durable)
                var ack = args; ack["descriptor"] = descriptor
                try bridge.acknowledgePick(ack)
                acknowledged = true
            }
            await until { gate.waiting != nil }
            precondition(!acknowledged && !FileManager.default.fileExists(atPath: durable.path))
            precondition(Array(host.methods.dropFirst(networkBefore)) == ["GET"])
            cold.generation += 1
            cold.scope = RuntimeHostScope(hostID: reason == "switch" ? "B" : "A", lease: UUID())
            if reason == "switch" { store.state.connections.insert(SavedConnection(id: "B", authorizationID: "auth_B", transportID: "transport_B", token: "new_host_must_not_be_used"), at: 0) }
            if reason == "storage" { failClear = true }
            if reason == "revoked" { store.state.connections = [] }
            if reason == "record" { store.state.connections[0].editorVersion = "changed_record" }
            let afterGET = host.methods.count
            // The retained local ACK must not retain a stale GET capability.
            do { _ = try await bridge.reconcilePick(args); fatalError("old lease GET") } catch { }
            precondition(host.methods.count == afterGET)
            gate.finish()
            if reason == "storage" || reason == "revoked" || reason == "record" {
                do { try await flow.value; fatalError("false local ACK") } catch { }
                let retained = try journal.records(); precondition(retained.count == 1)
                precondition(!acknowledged && FileManager.default.fileExists(atPath: durable.path))
                if reason == "storage" {
                    // While clear is pending, an old owner cannot erase a new
                    // upload even if a request ID were reused by another writer.
                    failClear = false
                    let saved = retained[0]
                    try journal.remove(requestID: saved.requestID, uploadID: saved.uploadID)
                    var replacement = saved.json; replacement["uploadID"] = "new_upload"
                    try journal.insert(AttachmentReceiptRecord(replacement))
                    var ack = args; ack["descriptor"] = adopted!
                    do { try bridge.acknowledgePick(ack); fatalError("old clear erased new upload") } catch { }
                    let preserved = try journal.records(); precondition(preserved.first!.uploadID == "new_upload")
                    try journal.remove(requestID: saved.requestID, uploadID: "new_upload"); try journal.insert(saved)
                }
                store.state.connections = [originalConnection]
                var ack = args; ack["descriptor"] = adopted!
                var wrong = adopted!; wrong["attachmentID"] = "foreign_descriptor"
                var wrongAck = args; wrongAck["descriptor"] = wrong
                do { try bridge.acknowledgePick(wrongAck); fatalError("foreign descriptor ACK") } catch { }
                let beforeRetry = try journal.records(); precondition(beforeRetry.count == 1)
                try bridge.acknowledgePick(ack)
            } else { try await flow.value; precondition(acknowledged) }
            let cleared = try journal.records(); precondition(cleared.isEmpty && host.methods.count == afterGET)
            // A same-contact Attach can now read pending and present the real
            // production picker with a new operation; the cold PUT is not replayed.
            store.state.connections = [originalConnection]
            cold.scope = RuntimeHostScope(hostID: "A", lease: UUID())
            var next: [String: Any] = contextFields
            next["expectedHost"] = cold.scope.publicValue; next["assistantID"] = "bot"
            let pending = try bridge.pendingReceipts(next) as! [[String: Any]]; precondition(pending.isEmpty)
            next["requestId"] = "next_" + reason; next["kind"] = "files"; next["contactGeneration"] = 3
            let selection = Task { try await bridge.pick(next) }
            await until { presenter.presentedViewController != nil }
            bridge.documentPickerWasCancelled(presenter.presentedViewController as! UIDocumentPickerViewController)
            await until { !AttachmentUIKit.dismissals.isEmpty }; AttachmentUIKit.completeDismissal()
            let result = try await selection.value; precondition(result == nil && host.methods.filter { $0 == "PUT" }.count == 1)
            let source = try Data(contentsOf: original); precondition(source == bytes)
        }
        // A not_found cold GET remains unknown, cannot manufacture an ACK owner
        // and never grants a retry PUT.
        let store = ConnectionStore(), host = SyntheticAttachmentHost(), runtime = RuntimeBridge(store, host)
        var unknownData: Data?
        let unknownJournal = AttachmentReceiptJournal(load: { unknownData }, save: { unknownData = $0 })
        let context = try AttachmentDraftContext(["draftIdentity": "unknown", "draftRevision": 1, "pageOperation": "unknown_page"])
        _ = try await runtime.contactAttachmentOperation(expectedHost: runtime.scope, assistantID: "bot", expectedGeneration: 3, requestID: "unknown", context: context, journal: unknownJournal)
        let cold = RuntimeBridge(store, host), bridge = AttachmentBridge(controller: UIViewController(), runtime: cold, journal: unknownJournal)
        let unknownArgs: [String: Any] = ["requestId": "unknown", "expectedHost": cold.scope.publicValue]
        let result = try await bridge.reconcilePick(unknownArgs); precondition(result == nil)
        do { try bridge.acknowledgePick(unknownArgs); fatalError("unknown became local ACK") } catch { }
        let remaining = try unknownJournal.records(); precondition(remaining.count == 1 && !host.methods.contains("PUT"))
        print("Production cold recovery local ACK contract passed")
    }
}
