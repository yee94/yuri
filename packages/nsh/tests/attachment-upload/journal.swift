import Foundation
import CryptoKit

enum NativeFailure: Error { case message(String) }
struct SavedConnection {
    let id: String
    let authorizationID: String?
    let transportID: String?
    let token: String
    var editorVersion: String? = "record_A"
}
struct ConnectionState { var connections: [SavedConnection] }
@MainActor final class ConnectionStore {
    var state = ConnectionState(connections: [SavedConnection(id: "A", authorizationID: "auth_A", transportID: "transport_A", token: "credential_not_journaled")])
    var selected: SavedConnection? { state.connections.first }
    // The production exact authorization lookup is appended by the test runner.
}
struct Admission { let connection: SavedConnection; let generation: Int; let expectedHost: RuntimeHostScope }
@MainActor final class SyntheticAttachmentHost {
    var generation = 3
    var rows: [String: [String: Any]] = [:]
    var methods: [String] = []
    var lostACK = false
    var deleteFails = false
    var afterCommit: (() -> Void)?
    var hash: String?
    func json(_ request: URLRequest, _ connection: SavedConnection) async throws -> (Int, Any) {
        precondition(connection.token == "credential_not_journaled")
        let method = request.httpMethod!, url = request.url!
        methods.append(method)
        if url.path.hasSuffix("messages") { return (200, ["generation": generation]) }
        let uploadID = url.lastPathComponent
        let captured = Int(URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems?.first?.value ?? "3")!
        func receipt(_ phase: String) -> [String: Any] {
            ["assistantID": "bot", "uploadID": uploadID, "generation": captured, "currentGeneration": generation, "state": phase, "descriptor": rows[uploadID]?["descriptor"] ?? NSNull()]
        }
        if method == "GET" { let phase = rows[uploadID]?["state"] as? String ?? "not_found"; return (phase == "not_found" ? 404 : 200, receipt(phase)) }
        if method == "DELETE" {
            if deleteFails { throw URLError(.notConnectedToInternet) }
            let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
            precondition(body["generation"] as? Int == 3)
            var row = rows[uploadID] ?? [:]; row["state"] = "retired"; rows[uploadID] = row
            var result = receipt("retired"); result["newAdmissionAllowed"] = false; result["ownershipRetained"] = row["descriptor"] != nil; result["bytesDeleted"] = false
            return (200, result)
        }
        precondition(method == "PUT" && request.value(forHTTPHeaderField: "Accept") == "application/vnd.yuri.contact-upload+json")
        if captured != generation || rows[uploadID]?["state"] as? String == "retired" { return (409, [:]) }
        let descriptor: [String: Any] = ["type": "file", "attachmentID": "att_" + uploadID, "generation": captured, "sha256": request.value(forHTTPHeaderField: "X-Content-SHA256")!, "size": request.httpBody!.count, "mime": "text/plain", "filename": "original.txt"]
        rows[uploadID] = ["state": "committed", "descriptor": descriptor]
        hash = descriptor["sha256"] as? String
        afterCommit?()
        if lostACK { throw URLError(.networkConnectionLost) }
        return (201, descriptor)
    }
}

@MainActor final class RuntimeBridge {
    let store: ConnectionStore
    let host: SyntheticAttachmentHost
    var generation = 1
    var scope = RuntimeHostScope(hostID: "A", lease: UUID())
    init(_ store: ConnectionStore, _ host: SyntheticAttachmentHost) { self.store = store; self.host = host }
    private func admit(_ expected: RuntimeHostScope?, required: Bool) throws -> Admission {
        guard expected == scope, let connection = store.selected else { throw CancellationError() }
        return Admission(connection: connection, generation: generation, expectedHost: scope)
    }
    private func checkHost(_ connection: SavedConnection, generation: Int, expected: RuntimeHostScope? = nil) throws {
        guard generation == self.generation, expected == scope, store.selected?.id == connection.id, store.selected?.authorizationID == connection.authorizationID else { throw CancellationError() }
    }
    private func makeRequest(_ path: String, connection: SavedConnection, method: String) throws -> URLRequest {
        var request = URLRequest(url: URL(string: "https://fixture.invalid" + path)!)
        request.httpMethod = method; return request
    }
    private func scopedJSON(_ request: URLRequest, connection: SavedConnection, scope: Int, expectedHost: RuntimeHostScope? = nil) async throws -> (Int, Any) {
        try checkHost(connection, generation: scope, expected: expectedHost)
        let result = try await json(request, connection: connection)
        try checkHost(connection, generation: scope, expected: expectedHost)
        return result
    }
    private func json(_ request: URLRequest, connection: SavedConnection) async throws -> (Int, Any) { try await host.json(request, connection) }
    func attachmentUploader(expectedHost: RuntimeHostScope?) throws -> (Data, String, String) async throws -> [String: Any] { throw AttachmentUploadFailure.invalid }
    // Production attachment capture/restoration methods are appended as an extension.
}

@main struct JournalContract {
    @MainActor static func main() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let original = directory.appendingPathComponent("original.txt"); try Data("same original bytes".utf8).write(to: original)
        let bytes = try Data(contentsOf: original)
        let journal = AttachmentReceiptJournal(directory: directory), store = ConnectionStore(), host = SyntheticAttachmentHost(), runtime = RuntimeBridge(store, host)
        let context = try AttachmentDraftContext(["draftIdentity": "/user/path/is/hashed/not/stored", "draftRevision": 2, "pageOperation": "page_1"])
        let upload = try await runtime.contactAttachmentOperation(expectedHost: runtime.scope, assistantID: "bot", expectedGeneration: 3, requestID: "request_1", context: context, journal: journal)
        host.lostACK = true
        do { _ = try await upload.upload(bytes, "original.txt", "text/plain"); fatalError("lost ACK") } catch { }
        let saved = try journal.records().first!
        precondition(saved.phase == "unknown" && saved.descriptor == nil)
        let wire = String(data: try Data(contentsOf: directory.appendingPathComponent("native-contact-upload-receipts-v1.json")), encoding: .utf8)!
        precondition(!wire.contains("credential_not_journaled") && !wire.contains("/user/path") && !wire.contains("same original bytes"))
        // Recreate both journal and runtime: no live closure or lease survives.
        let coldJournal = AttachmentReceiptJournal(directory: directory), coldRuntime = RuntimeBridge(store, host)
        let recovered = try coldRuntime.restoreAttachmentOperation(saved, expectedHost: coldRuntime.scope, journal: coldJournal)
        let before = host.methods.count
        let descriptor = try await recovered.reconcile()!
        precondition(Array(host.methods.dropFirst(before)) == ["GET"] && descriptor["generation"] as? Int == 3)
        do { _ = try await recovered.upload(bytes, "original.txt", "text/plain"); fatalError("cold replay") } catch { }
        precondition(host.methods.filter { $0 == "PUT" }.count == 1)
        // Same hash, distinct original upload ownership survives exact retirement.
        host.lostACK = false
        let other = try await coldRuntime.contactAttachmentOperation(expectedHost: coldRuntime.scope, assistantID: "bot", expectedGeneration: 3, requestID: "request_2", context: context, journal: coldJournal)
        let secondDescriptor = try await other.upload(bytes, "original.txt", "text/plain")
        precondition(secondDescriptor["sha256"] as? String == descriptor["sha256"] as? String)
        host.deleteFails = true
        do { try await recovered.retire(); fatalError("false cleanup ACK") } catch { }
        let afterFailure = try coldJournal.records(); precondition(afterFailure.first { $0.requestID == "request_1" }!.phase == "retiring")
        let retryRuntime = RuntimeBridge(store, host), retryJournal = AttachmentReceiptJournal(directory: directory)
        let retiring = try retryJournal.records().first { $0.requestID == "request_1" }!
        let retry = try retryRuntime.restoreAttachmentOperation(retiring, journal: retryJournal)
        host.deleteFails = false; try await retry.retire()
        let remaining = try retryJournal.records(); precondition(remaining.count == 1 && host.rows[remaining.first!.uploadID]?["state"] as? String == "committed")
        // Changed/revoked authorization cannot capture any recovery transport.
        let retained = try retryJournal.records().first!, count = host.methods.count
        store.state.connections[0].editorVersion = "record_changed"
        do { _ = try retryRuntime.restoreAttachmentOperation(retained, expectedHost: retryRuntime.scope, journal: retryJournal); fatalError("changed record authority") } catch { }
        precondition(host.methods.count == count)
        store.state.connections[0].editorVersion = "record_A"
        store.state.connections = [SavedConnection(id: "A", authorizationID: "new_auth", transportID: "transport_A", token: "replacement_must_not_be_used")]
        do { _ = try retryRuntime.restoreAttachmentOperation(retained, expectedHost: retryRuntime.scope, journal: retryJournal); fatalError("new credentials") } catch { }
        let afterRevoked = try retryJournal.records(); precondition(host.methods.count == count && afterRevoked.count == 1)
        store.state.connections = []
        do { _ = try retryRuntime.restoreAttachmentOperation(retained, journal: retryJournal); fatalError("missing original") } catch { }
        precondition(host.methods.count == count)
        store.state.connections = [SavedConnection(id: "A", authorizationID: "auth_A", transportID: "transport_A", token: "credential_not_journaled")]
        host.generation = 4
        let resetOwner = try retryRuntime.restoreAttachmentOperation(retained, expectedHost: retryRuntime.scope, journal: retryJournal)
        do { _ = try await resetOwner.reconcile(); fatalError("reset adopted") } catch { precondition(error as? AttachmentUploadFailure == .generationConflict) }
        try await resetOwner.retire()
        let resetRows = try retryJournal.records(); precondition(resetRows.isEmpty)
        let beforeStale = host.methods.filter { $0 == "PUT" }.count
        do { _ = try await retryRuntime.contactAttachmentOperation(expectedHost: retryRuntime.scope, assistantID: "bot", expectedGeneration: 3, requestID: "stale_picker", context: context, journal: retryJournal); fatalError("stale picker borrowed generation") } catch { }
        precondition(host.methods.filter { $0 == "PUT" }.count == beforeStale)
        let retainedBytes = try Data(contentsOf: original); precondition(retainedBytes == bytes)
        // Failure before durable admission sends zero PUT; failure after real send
        // remains unknown, never retries PUT on restoration.
        var storage: Data?, fail = false
        let failing = AttachmentReceiptJournal(load: { storage }, save: { data in if fail { throw URLError(.cannotWriteToFile) }; storage = data })
        let freshStore = ConnectionStore(), failureHost = SyntheticAttachmentHost(), failureRuntime = RuntimeBridge(freshStore, failureHost)
        let prepared = try await failureRuntime.contactAttachmentOperation(expectedHost: failureRuntime.scope, assistantID: "bot", expectedGeneration: 3, requestID: "preflight", context: context, journal: failing)
        fail = true
        do { _ = try await prepared.upload(bytes, "original.txt", "text/plain"); fatalError("failed journal write") } catch { precondition(error as? AttachmentUploadFailure == .notDispatched) }
        precondition(!failureHost.methods.contains("PUT"))
        fail = false
        let row = try failing.records().first!
        let recoveredPrepared = try failureRuntime.restoreAttachmentOperation(row, expectedHost: failureRuntime.scope, journal: failing)
        let absent = try await recoveredPrepared.reconcile(); precondition(absent == nil)
        try await recoveredPrepared.retire()
        let afterRetired = try failing.records(); precondition(!failureHost.methods.contains("PUT") && afterRetired.isEmpty)
        let committed = try await failureRuntime.contactAttachmentOperation(expectedHost: failureRuntime.scope, assistantID: "bot", expectedGeneration: 3, requestID: "postflight", context: context, journal: failing)
        failureHost.afterCommit = { fail = true }
        do { _ = try await committed.upload(bytes, "original.txt", "text/plain"); fatalError("post-send persistence failure") } catch { precondition(error as? AttachmentUploadFailure == .unknown) }
        fail = false; failureHost.afterCommit = nil
        let postRow = try failing.records().first!
        precondition(postRow.phase == "unknown" && postRow.descriptor == nil && failureHost.methods.filter { $0 == "PUT" }.count == 1)
        let postRestore = try failureRuntime.restoreAttachmentOperation(postRow, expectedHost: failureRuntime.scope, journal: failing)
        let postDescriptor = try await postRestore.reconcile(); precondition(postDescriptor != nil && failureHost.methods.filter { $0 == "PUT" }.count == 1)
        try await postRestore.retire()
        // Exact late-clear cannot erase another operation, or resurrect old metadata.
        try failing.insert(row)
        do { try failing.remove(requestID: row.requestID, uploadID: "foreign"); fatalError("foreign clear") } catch { }
        try failing.remove(requestID: row.requestID, uploadID: row.uploadID)
        do { try failing.update(requestID: row.requestID, uploadID: row.uploadID, phase: "unknown", descriptor: nil); fatalError("late resurrection") } catch { }
        let afterClear = try failing.records(); precondition(afterClear.isEmpty)
        var replacement = row.json; replacement["uploadID"] = "replacement_upload"
        try failing.insert(AttachmentReceiptRecord(replacement))
        do { try failing.remove(requestID: row.requestID, uploadID: row.uploadID); fatalError("old clear erased replacement") } catch { }
        let preserved = try failing.records(); precondition(preserved.first!.uploadID == "replacement_upload")
        var bounded: Data?
        let cap = AttachmentReceiptJournal(load: { bounded }, save: { bounded = $0 })
        for index in 0..<64 {
            var value = row.json; value["requestID"] = "request_\(index)"; value["uploadID"] = "upload_\(index)"
            try cap.insert(AttachmentReceiptRecord(value))
        }
        do { var value = row.json; value["requestID"] = "overflow"; value["uploadID"] = "overflow"; try cap.insert(AttachmentReceiptRecord(value)); fatalError("unbounded journal") }
        catch { precondition(error as? AttachmentUploadFailure == .capacity) }
        let capped = try cap.records(); precondition(capped.count == 64 && capped.first!.requestID == "request_0")
        let resetHost = SyntheticAttachmentHost(), resetRuntime = RuntimeBridge(ConnectionStore(), resetHost)
        var resetData: Data?
        let resetJournal = AttachmentReceiptJournal(load: { resetData }, save: { resetData = $0 })
        let resetAfterCommit = try await resetRuntime.contactAttachmentOperation(expectedHost: resetRuntime.scope, assistantID: "bot", expectedGeneration: 3, requestID: "reset_ack", context: context, journal: resetJournal)
        resetHost.afterCommit = { resetHost.generation = 4 }
        do { _ = try await resetAfterCommit.upload(bytes, "original.txt", "text/plain"); fatalError("late reset ACK adopted") } catch { precondition(error as? AttachmentUploadFailure == .generationConflict) }
        precondition(resetHost.methods.suffix(2) == ["PUT", "GET"])
        try await resetAfterCommit.retire()
        let resetCleaned = try resetJournal.records(); precondition(resetCleaned.isEmpty && resetHost.methods.filter { $0 == "PUT" }.count == 1)
        let unavailableJournal = AttachmentReceiptJournal(load: { nil }, save: { _ in throw URLError(.cannotWriteToFile) })
        let beforeInsertFailure = resetHost.methods.filter { $0 == "PUT" }.count
        do { _ = try await resetRuntime.contactAttachmentOperation(expectedHost: resetRuntime.scope, assistantID: "bot", expectedGeneration: 4, requestID: "insert_failure", context: context, journal: unavailableJournal); fatalError("picker admitted without journal") } catch { }
        precondition(resetHost.methods.filter { $0 == "PUT" }.count == beforeInsertFailure)
        let expired = try await resetRuntime.contactAttachmentOperation(expectedHost: resetRuntime.scope, assistantID: "bot", expectedGeneration: 4, requestID: "expired", context: context, journal: resetJournal)
        resetRuntime.generation += 1
        do { _ = try await expired.upload(bytes, "original.txt", "text/plain"); fatalError("expired lease replay") } catch { precondition(error as? AttachmentUploadFailure == .notDispatched) }
        precondition(resetHost.methods.filter { $0 == "PUT" }.count == beforeInsertFailure)
        print("Attachment journal restart contract passed")
    }
}
