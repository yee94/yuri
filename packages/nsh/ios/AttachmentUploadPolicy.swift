import Foundation
import CryptoKit
import CoreFoundation

enum AttachmentUploadFailure: String, LocalizedError {
    case invalid = "attachment_upload_invalid"
    case unknown = "attachment_upload_unknown"
    case retired = "attachment_upload_retired"
    case capacity = "attachment_upload_pending_capacity"
    case storage = "attachment_receipt_storage_failed"
    case authorizationUnavailable = "attachment_original_authorization_unavailable"
    case notDispatched = "attachment_upload_not_dispatched"
    case generationConflict = "attachment_contact_generation_conflict"
    var errorDescription: String? { rawValue }
}

struct AttachmentUploadRequest {
    let path: String
    var data = Data()
    var headers: [String: String] = [:]
    var method = "GET"
}

/// Exact native-owned authority. No byte buffer or credential crosses the JS bridge.
@MainActor struct NativeAttachmentOperation {
    let upload: (Data, String, String) async throws -> [String: Any]
    let reconcile: () async throws -> [String: Any]?
    let retire: () async throws -> Void
    let acknowledge: (Any?) throws -> Void
    var dispatched: () -> Bool = { true }
}

/// One selection, one PUT. Ambiguous results retain this exact receipt until
/// authoritative GET reconciliation or durable exact retirement succeeds.
@MainActor final class AttachmentUploadPolicy {
    let assistantID: String
    let uploadID: String
    private(set) var generation: Int?
    private(set) var descriptor: [String: Any]?
    private(set) var attempted = false
    private(set) var retired = false
    private var retiring = false
    private var recoveryOnly = false
    var persist: ((String, [String: Any]?) throws -> Void)?
    private var expected: (hash: String, size: Int, mime: String, name: String)?
    private static let component = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")
    typealias Send = (AttachmentUploadRequest) async throws -> (Int, Any)

    init(assistantID: String, uploadID: String = UUID().uuidString.lowercased()) throws {
        guard !assistantID.isEmpty, assistantID.utf8.count <= 256,
              !assistantID.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              uploadID.range(of: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$", options: .regularExpression) != nil else { throw AttachmentUploadFailure.invalid }
        self.assistantID = assistantID; self.uploadID = uploadID
    }
    convenience init(restoringAssistant assistantID: String, uploadID: String, generation: Int, descriptor: [String: Any]?, phase: String) throws {
        try self.init(assistantID: assistantID, uploadID: uploadID)
        self.generation = try Self.safeInteger(generation)
        if let descriptor { self.descriptor = try parseDescriptor(descriptor) }
        attempted = true; recoveryOnly = true; retiring = phase == "retiring"; retired = phase == "retired"
    }
    static func safeInteger(_ value: Any?) throws -> Int {
        guard let value = value as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(),
              value.doubleValue >= 0, value.doubleValue <= 9007199254740991,
              value.doubleValue.rounded(.towardZero) == value.doubleValue else { throw AttachmentUploadFailure.invalid }
        return value.intValue
    }
    private var base: String { "/api/yuri/assistants/\(assistantID.addingPercentEncoding(withAllowedCharacters: Self.component)!)/contact" }
    private var receiptPath: String { "\(base)/attachments/uploads/\(uploadID)" }

    func prepare(expectedGeneration: Int? = nil, current: () -> Bool, send: Send) async throws {
        guard generation == nil, current(), !retiring else { throw AttachmentUploadFailure.invalid }
        let (status, raw) = try await send(AttachmentUploadRequest(path: "\(base)/messages?limit=1"))
        guard status == 200, current(), let body = raw as? [String: Any] else { throw AttachmentUploadFailure.invalid }
        generation = try Self.safeInteger(body["generation"])
        guard expectedGeneration == nil || generation == expectedGeneration else { throw AttachmentUploadFailure.invalid }
        // Require explicit protocol support before the picker becomes visible.
        let receipt = try await read(send: send)
        guard receipt.state == "not_found", receipt.current == generation, current(), !retiring else { throw AttachmentUploadFailure.invalid }
    }

    private func parseDescriptor(_ raw: Any) throws -> [String: Any] {
        guard let body = raw as? [String: Any], Set(body.keys).isSubset(of: ["type", "attachmentID", "sha256", "size", "mime", "filename", "generation"]),
              body["type"] as? String == "file", let id = body["attachmentID"] as? String,
              id.range(of: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$", options: .regularExpression) != nil,
              let hash = body["sha256"] as? String, hash.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              let mime = body["mime"] as? String, mime.range(of: "^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+$", options: .regularExpression) != nil,
              try Self.safeInteger(body["generation"]) == generation else { throw AttachmentUploadFailure.invalid }
        let size = try Self.safeInteger(body["size"])
        guard size > 0, size <= 25 * 1024 * 1024 else { throw AttachmentUploadFailure.invalid }
        if let name = body["filename"] { guard let name = name as? String, Self.validName(name) else { throw AttachmentUploadFailure.invalid } }
        if let expected {
            guard hash == expected.hash, size == expected.size, mime == expected.mime,
                  body["filename"] == nil || body["filename"] as? String == expected.name else { throw AttachmentUploadFailure.invalid }
        }
        if let descriptor { guard NSDictionary(dictionary: descriptor).isEqual(to: body) else { throw AttachmentUploadFailure.invalid } }
        return body
    }
    private static func validName(_ name: String) -> Bool {
        !name.isEmpty && name.utf8.count <= 1024 && name.utf16.count <= 512 && name == name.trimmingCharacters(in: .whitespacesAndNewlines) && !name.contains("/") && !name.contains("\\") && !name.contains("..") && !name.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) })
    }
    private func receipt(status: Int, raw: Any, deletion: Bool = false) throws -> (state: String, current: Int, descriptor: [String: Any]?) {
        guard let body = raw as? [String: Any], body["assistantID"] as? String == assistantID, body["uploadID"] as? String == uploadID,
              try Self.safeInteger(body["generation"]) == generation,
              let state = body["state"] as? String,
              (status == 404 && state == "not_found" || status == 200 && ["inflight", "committed", "retired"].contains(state)),
              body.keys.contains("descriptor") else { throw AttachmentUploadFailure.invalid }
        let now = try Self.safeInteger(body["currentGeneration"])
        guard let generation, now >= generation else { throw AttachmentUploadFailure.invalid }
        let parsed = body["descriptor"] is NSNull ? nil : try parseDescriptor(body["descriptor"]!)
        guard (state != "committed" || parsed != nil), (!["not_found", "inflight"].contains(state) || parsed == nil), descriptor == nil || parsed != nil else { throw AttachmentUploadFailure.invalid }
        if deletion {
            guard status == 200, state == "retired", let admission = body["newAdmissionAllowed"] as? NSNumber, CFGetTypeID(admission) == CFBooleanGetTypeID(), !admission.boolValue,
                  let bytes = body["bytesDeleted"] as? NSNumber, CFGetTypeID(bytes) == CFBooleanGetTypeID(), !bytes.boolValue,
                  let retained = body["ownershipRetained"] as? NSNumber, CFGetTypeID(retained) == CFBooleanGetTypeID(), retained.boolValue == (parsed != nil) else { throw AttachmentUploadFailure.invalid }
        }
        if let parsed { descriptor = parsed }
        try persist?(state == "retired" ? "retired" : retiring ? "retiring" : "unknown", descriptor)
        if state == "retired" { retired = true }
        return (state, now, parsed)
    }
    private func read(send: Send) async throws -> (state: String, current: Int, descriptor: [String: Any]?) {
        guard let generation else { throw AttachmentUploadFailure.invalid }
        let (status, body) = try await send(AttachmentUploadRequest(path: "\(receiptPath)?generation=\(generation)"))
        return try receipt(status: status, raw: body)
    }
    func reconcile(current: () -> Bool, send: Send) async throws -> [String: Any]? {
        guard attempted, !retiring, !retired else { throw AttachmentUploadFailure.retired }
        let value = try await read(send: send)
        guard !retiring, !retired else { throw AttachmentUploadFailure.retired }
        guard current() else { throw AttachmentUploadFailure.unknown }
        guard value.current == generation else { throw AttachmentUploadFailure.generationConflict }
        return value.state == "committed" ? value.descriptor : nil
    }
    func retire(send: Send) async throws {
        retiring = true // irreversible local adoption fence, including a failed DELETE
        guard let generation else { throw AttachmentUploadFailure.invalid }
        try persist?("retiring", descriptor)
        let body: [String: Any] = ["generation": generation, "descriptor": descriptor as Any? ?? NSNull()]
        let (status, raw) = try await send(AttachmentUploadRequest(path: receiptPath, data: JSONSerialization.data(withJSONObject: body), headers: ["Content-Type": "application/json"], method: "DELETE"))
        _ = try receipt(status: status, raw: raw, deletion: true)
    }
    func acknowledge(_ raw: Any?, current: () -> Bool) throws {
        guard !retiring, !retired, current(), let descriptor, let raw,
              NSDictionary(dictionary: descriptor).isEqual(to: try parseDescriptor(raw)) else { throw AttachmentUploadFailure.unknown }
    }
    func upload(_ data: Data, name: String, mime: String, current: () -> Bool, send: Send) async throws -> [String: Any] {
        guard let generation, !attempted, !retiring, !retired, !recoveryOnly else { throw AttachmentUploadFailure.unknown }
        try Task.checkCancellation()
        guard current() else { throw CancellationError() }
        guard !data.isEmpty, data.count <= 25 * 1024 * 1024, Self.validName(name),
              mime.range(of: "^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+$", options: .regularExpression) != nil else { throw AttachmentUploadFailure.invalid }
        let digest = await Task.detached(priority: .userInitiated) { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }.value
        try Task.checkCancellation()
        guard current(), !retiring else { throw CancellationError() }
        expected = (digest, data.count, mime, name)
        try persist?("unknown", descriptor) // durable write-ahead: failure here sent zero PUTs
        attempted = true
        let request = AttachmentUploadRequest(path: "\(base)/attachments/\(uploadID)?generation=\(generation)", data: data,
            headers: ["Accept": "application/vnd.yuri.contact-upload+json", "Content-Type": mime, "X-Content-SHA256": digest, "X-Content-Size": String(data.count), "X-Attachment-Filename": name.addingPercentEncoding(withAllowedCharacters: Self.component)!], method: "PUT")
        do {
            let (status, raw) = try await send(request)
            guard status == 201 else { throw AttachmentUploadFailure.unknown }
            let parsed = try parseDescriptor(raw)
            descriptor = parsed // retain exact ACK even if the original page has retired
            try persist?(retiring ? "retiring" : "unknown", parsed)
            guard !Task.isCancelled, current(), !retiring, !retired else { throw AttachmentUploadFailure.unknown }
            let confirmed = try await read(send: send)
            guard !retiring, !retired else { throw AttachmentUploadFailure.retired }
            guard confirmed.current == generation else { throw AttachmentUploadFailure.generationConflict }
            guard current(), confirmed.state == "committed" else { throw AttachmentUploadFailure.unknown }
            return parsed
        } catch let failure as AttachmentUploadFailure where failure == .generationConflict || failure == .retired { throw failure }
        catch { throw AttachmentUploadFailure.unknown }
    }
}
