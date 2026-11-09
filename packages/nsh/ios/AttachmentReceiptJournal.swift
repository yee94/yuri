import Foundation
import CryptoKit

@MainActor struct AttachmentDraftContext {
    let identity: String
    let revision: Int
    let pageOperation: String
    init(_ fields: [String: Any]) throws {
        guard let identity = fields["draftIdentity"] as? String, !identity.isEmpty, identity.utf8.count <= 16384,
              let page = fields["pageOperation"] as? String, AttachmentReceiptRecord.identifier(page) else { throw AttachmentUploadFailure.invalid }
        self.identity = SHA256.hash(data: Data(identity.utf8)).map { String(format: "%02x", $0) }.joined()
        revision = try AttachmentUploadPolicy.safeInteger(fields["draftRevision"])
        pageOperation = page
    }
}

/// Metadata only. Transport and authorization IDs refer to the existing Keychain
/// owner; no credential, URL, user path, original bytes or closure is serialized.
@MainActor struct AttachmentReceiptRecord {
    let requestID: String
    let uploadID: String
    let assistantID: String
    let connectionID: String
    let transportID: String
    let authorizationID: String
    let connectionVersion: String
    let generation: Int
    let draftID: String
    let draftRevision: Int
    let pageOperation: String
    var phase: String
    var descriptor: [String: Any]?
    static func identifier(_ value: String) -> Bool {
        value.range(of: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$", options: .regularExpression) != nil
    }
    var json: [String: Any] {
        ["requestID": requestID, "uploadID": uploadID, "assistantID": assistantID, "connectionID": connectionID, "transportID": transportID, "authorizationID": authorizationID, "connectionVersion": connectionVersion,
         "generation": generation, "draftID": draftID, "draftRevision": draftRevision, "pageOperation": pageOperation, "phase": phase, "descriptor": descriptor as Any? ?? NSNull()]
    }
    init(_ raw: [String: Any]) throws {
        guard Set(raw.keys) == ["requestID", "uploadID", "assistantID", "connectionID", "transportID", "authorizationID", "connectionVersion", "generation", "draftID", "draftRevision", "pageOperation", "phase", "descriptor"],
              let request = raw["requestID"] as? String, Self.identifier(request), let upload = raw["uploadID"] as? String, Self.identifier(upload),
              let assistant = raw["assistantID"] as? String, !assistant.isEmpty, assistant.utf8.count <= 256, !assistant.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              let connection = raw["connectionID"] as? String, Self.identifier(connection), let transport = raw["transportID"] as? String, Self.identifier(transport),
              let authorization = raw["authorizationID"] as? String, Self.identifier(authorization), authorization != "legacy",
              let connectionVersion = raw["connectionVersion"] as? String, Self.identifier(connectionVersion), connectionVersion != "legacy",
              let draft = raw["draftID"] as? String, draft.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              let page = raw["pageOperation"] as? String, Self.identifier(page), let phase = raw["phase"] as? String, ["prepared", "unknown", "retiring", "retired"].contains(phase) else { throw AttachmentUploadFailure.invalid }
        requestID = request; uploadID = upload; assistantID = assistant; connectionID = connection; transportID = transport; authorizationID = authorization; self.connectionVersion = connectionVersion
        generation = try AttachmentUploadPolicy.safeInteger(raw["generation"]); draftRevision = try AttachmentUploadPolicy.safeInteger(raw["draftRevision"])
        draftID = draft; pageOperation = page; self.phase = phase
        descriptor = raw["descriptor"] is NSNull ? nil : raw["descriptor"] as? [String: Any]
        guard raw["descriptor"] is NSNull || descriptor != nil else { throw AttachmentUploadFailure.invalid }
        // Restore through the same typed descriptor owner, never a lossy dictionary copy.
        _ = try AttachmentUploadPolicy(restoringAssistant: assistantID, uploadID: uploadID, generation: generation, descriptor: descriptor, phase: phase)
    }
    var publicValue: [String: Any] {
        ["requestId": requestID, "uploadID": uploadID, "assistantID": assistantID, "generation": generation, "draftRevision": draftRevision, "phase": phase]
    }
}

/// Synchronous MainActor transactions in the existing NSH device storage directory.
/// Reread before each write, exact request/upload CAS and atomic replacement prevent
/// a late completion from resurrecting or erasing another operation.
@MainActor final class AttachmentReceiptJournal {
    private let load: () throws -> Data?
    private let save: (Data) throws -> Void
    init(directory: URL) {
        let file = directory.appendingPathComponent("native-contact-upload-receipts-v1.json")
        load = { FileManager.default.fileExists(atPath: file.path) ? try Data(contentsOf: file) : nil }
        save = { data in
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try data.write(to: file, options: .atomic)
        }
    }
    init(load: @escaping () throws -> Data?, save: @escaping (Data) throws -> Void) { self.load = load; self.save = save }
    func records() throws -> [AttachmentReceiptRecord] {
        do {
            guard let bytes = try load() else { return [] }
            guard bytes.count <= 262144, let root = try JSONSerialization.jsonObject(with: bytes) as? [String: Any], Set(root.keys) == ["version", "receipts"],
                  try AttachmentUploadPolicy.safeInteger(root["version"]) == 1, let rows = root["receipts"] as? [[String: Any]], rows.count <= 64 else { throw AttachmentUploadFailure.storage }
            let result = try rows.map(AttachmentReceiptRecord.init)
            guard Set(result.map(\.requestID)).count == result.count, Set(result.map { $0.assistantID + "\n" + $0.uploadID }).count == result.count else { throw AttachmentUploadFailure.storage }
            return result
        } catch { throw AttachmentUploadFailure.storage }
    }
    private func write(_ rows: [AttachmentReceiptRecord]) throws {
        do {
            let bytes = try JSONSerialization.data(withJSONObject: ["version": 1, "receipts": rows.map(\.json)])
            guard rows.count <= 64, bytes.count <= 262144 else { throw AttachmentUploadFailure.capacity }
            try save(bytes)
        } catch let failure as AttachmentUploadFailure { throw failure }
        catch { throw AttachmentUploadFailure.storage }
    }
    func insert(_ record: AttachmentReceiptRecord) throws {
        var rows = try records()
        guard rows.count < 64 else { throw AttachmentUploadFailure.capacity }
        guard !rows.contains(where: { $0.requestID == record.requestID || $0.assistantID == record.assistantID && $0.uploadID == record.uploadID }) else { throw AttachmentUploadFailure.invalid }
        rows.append(record); try write(rows)
    }
    func update(requestID: String, uploadID: String, phase: String, descriptor: [String: Any]?) throws {
        var rows = try records()
        guard let index = rows.firstIndex(where: { $0.requestID == requestID && $0.uploadID == uploadID }) else { throw AttachmentUploadFailure.storage }
        // An ACK arriving after retirement can retain identity, never undo its fence.
        if rows[index].phase != "retired" && rows[index].phase != "retiring" || phase == "retired" { rows[index].phase = phase }
        if let descriptor { rows[index].descriptor = descriptor }
        rows[index] = try AttachmentReceiptRecord(rows[index].json)
        try write(rows)
    }
    func remove(requestID: String, uploadID: String) throws {
        var rows = try records()
        guard let index = rows.firstIndex(where: { $0.requestID == requestID }) else { return }
        guard rows[index].uploadID == uploadID else { throw AttachmentUploadFailure.invalid }
        rows.remove(at: index); try write(rows)
    }
}
