import Foundation
import CryptoKit

@main struct ContactPreviewContract {
    static func main() throws {
        let data = Data("synthetic preview".utf8), scope = RuntimeHostScope(hostID: "host", lease: UUID())
        let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        let descriptor: [String: Any] = ["type": "file", "attachmentID": "att_owned", "sha256": digest, "size": data.count, "mime": "text/plain", "filename": "notes.txt"]
        let source: [String: Any] = ["kind": "contact", "assistantID": "bot/中文", "descriptor": descriptor]
        let request = try ResourceReadRequest(["source": source, "requestId": "r", "expectedHost": scope.publicValue])
        let contact = request.contact!
        precondition(contact.route == "/api/yuri/assistants/bot%2F%E4%B8%AD%E6%96%87/contact/attachments/att_owned")
        precondition(!contact.route.contains("fs/"))
        try contact.verify(status: 200, mime: "text/plain", data: data)
        for (status, mime, bytes) in [(404, "text/plain", data), (200, "image/png", data), (200, "text/plain", Data("changed".utf8))] {
            do { try contact.verify(status: status, mime: mime, data: bytes); preconditionFailure("invalid bytes adopted") } catch { }
        }
        do { _ = try ResourceReadRequest(["source": source, "path": "/fake-uri", "expectedHost": scope.publicValue]); preconditionFailure("hybrid") } catch { }
        var hostile = descriptor; hostile["uri"] = "file:///private/path"
        do { _ = try ContactAttachmentResource(["kind": "contact", "assistantID": "bot", "descriptor": hostile]); preconditionFailure("path") } catch { }
        print("Contact preview contract passed")
    }
}
