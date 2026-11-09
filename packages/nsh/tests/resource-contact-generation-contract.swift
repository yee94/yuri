import Foundation
import CryptoKit

@MainActor final class ContactMemory {
    let bytes = Data("synthetic contact generation bytes".utf8)
    var generation = 7, rowGeneration = 7, hostCurrent = true, rawReset = false
    var rowID = "att_owned", mime = "text/plain", corrupt = false, status = 200
    var metadataGeneration: Any?
    var paths: [String] = [], pending = false, hold = false
    var continuation: CheckedContinuation<Void, Never>?
    var descriptor: [String: Any] {
        ["type": "file", "attachmentID": rowID, "sha256": SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined(),
         "size": bytes.count, "mime": "text/plain", "filename": "original.txt", "generation": 7]
    }
    func read(_ route: String, _ limit: Int) async throws -> (status: Int, mime: String, data: Data) {
        paths.append(route)
        if route == "/api/yuri/assistants/bot/contact/messages?limit=1" {
            return (status, "application/json", try JSONSerialization.data(withJSONObject: ["generation": metadataGeneration ?? generation, "messages": []]))
        }
        guard route == "/api/yuri/assistants/bot/contact/attachments/" + rowID, rowGeneration == generation else { return (404, "application/json", Data()) }
        if hold { pending = true; await withCheckedContinuation { continuation = $0 } }
        if rawReset { generation += 1 }
        return (200, mime, corrupt ? Data("changed".utf8) : bytes)
    }
    func releaseBytes() { let callback = continuation; continuation = nil; pending = false; hold = false; callback?.resume() }
}

@main struct ContactGenerationContract {
    @MainActor static func main() async throws {
        func contact(_ descriptor: [String: Any]) throws -> ContactAttachmentResource { try ContactAttachmentResource(["kind": "contact", "assistantID": "bot", "descriptor": descriptor]) }
        func rejected(_ work: () throws -> Void) { do { try work(); preconditionFailure("invalid admitted") } catch {} }
        func denied(_ work: () async throws -> Void) async { do { try await work(); preconditionFailure("stale admitted") } catch {} }
        let memory = ContactMemory(), original = try contact(memory.descriptor)
        precondition(original.generation == 7 && original.attachmentID == "att_owned")
        precondition(NSDictionary(dictionary: original.descriptor).isEqual(to: memory.descriptor))
        for value: Any in [true, false, NSNull(), "7", [7], [String: Int](), -1, 0.5, 9007199254740992.0, Double.infinity, Double.nan] {
            var invalid = memory.descriptor; invalid["generation"] = value
            var captures = 0
            rejected { _ = try ResourceReadRequest.admit(["source": ["kind": "contact", "assistantID": "bot", "descriptor": invalid], "expectedHost": ["hostID": "fixture", "lease": UUID().uuidString]], capture: { _ in captures += 1 }) }
            precondition(captures == 0)
        }
        for value in [0, 7, 9007199254740991] {
            var valid = memory.descriptor; valid["generation"] = value
            let parsed = try contact(valid); precondition(parsed.generation == value)
        }
        for key in ["unknown", "uri", "path", "url", "currentGeneration"] {
            var invalid = memory.descriptor; invalid[key] = "forbidden"
            rejected { _ = try contact(invalid) }
        }
        var legacyDescriptor = memory.descriptor; legacyDescriptor.removeValue(forKey: "generation")
        let legacy = try contact(legacyDescriptor)
        precondition(legacy.generation == nil && legacy.descriptor["generation"] == nil)
        _ = try await legacy.readVerified(limit: 1_000_000, current: { memory.hostCurrent }, read: memory.read)
        precondition(memory.paths == [original.route])
        memory.paths = []
        _ = try await original.readVerified(limit: 1_000_000, current: { memory.hostCurrent }, read: memory.read)
        precondition(memory.paths == [original.generationRoute, original.route, original.generationRoute])
        precondition(!original.route.contains("?") && !original.route.contains("fs/"))
        var zeroDescriptor = memory.descriptor; zeroDescriptor["generation"] = 0
        let zero = try contact(zeroDescriptor); memory.generation = 0; memory.rowGeneration = 0; memory.paths = []
        _ = try await zero.readVerified(limit: 1_000_000, current: { memory.hostCurrent }, read: memory.read)
        precondition(memory.paths == [original.generationRoute, original.route, original.generationRoute])
        memory.generation = 7; memory.rowGeneration = 7
        for value: Any in [true, false, NSNull(), "7", [7], -1, 0.5, 9007199254740992.0] {
            memory.metadataGeneration = value; memory.paths = []
            await denied { _ = try await original.readVerified(limit: 1_000_000, current: { memory.hostCurrent }, read: memory.read) }
            precondition(memory.paths == [original.generationRoute])
        }
        memory.metadataGeneration = nil
        for (key, value): (String, Any) in [("sha256", String(repeating: "b", count: 64)), ("size", memory.bytes.count + 1), ("mime", "application/pdf"), ("attachmentID", "att_other"), ("generation", 8)] {
            var changed = memory.descriptor; changed[key] = value
            let candidate = try contact(changed)
            precondition(candidate != original)
            await denied { _ = try await candidate.readVerified(limit: 1_000_000, current: { memory.hostCurrent }, read: memory.read) }
        }
        memory.paths = []; memory.generation = 8
        await denied { _ = try await original.readVerified(limit: 1_000_000, current: { memory.hostCurrent }, read: memory.read) }
        precondition(memory.paths == [original.generationRoute])
        memory.generation = 7; memory.rawReset = true
        await denied { _ = try await original.readVerified(limit: 1_000_000, current: { memory.hostCurrent }, read: memory.read) }
        memory.rawReset = false; memory.generation = 7; memory.status = 500
        await denied { _ = try await original.readVerified(limit: 1_000_000, current: { memory.hostCurrent }, read: memory.read) }
        memory.status = 200; memory.hostCurrent = false; memory.paths = []
        await denied { _ = try await original.readVerified(limit: 1_000_000, current: { memory.hostCurrent }, read: memory.read) }
        precondition(memory.paths.isEmpty)
        memory.hostCurrent = true
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("contact-permission-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let source = root.appendingPathComponent("original.txt"); try memory.bytes.write(to: source)
        let scope = RuntimeHostScope(hostID: "fixture", lease: UUID()), bridge = ResourceBridge()
        let transport = ResourceTransport(read: memory.read, isCurrent: { memory.hostCurrent })
        func seed(_ key: String, _ owner: ContactAttachmentResource) throws {
            let directory = root.appendingPathComponent(key); try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let url = directory.appendingPathComponent(owner.name); try memory.bytes.write(to: url)
            bridge.seed(key, url: url, scope: scope, contact: owner, transport: transport)
        }
        try seed("owned", original); try seed("peer", original)
        _ = try await bridge.invoke(["lease": "owned", "action": "preview"])
        precondition(bridge.shows == 1 && bridge.lastKey == "owned")
        memory.generation = 8
        await denied { _ = try await bridge.invoke(["lease": "owned", "action": "preview"]) }
        precondition(bridge.shows == 1 && bridge.contains("owned"))
        memory.generation = 7; memory.rowGeneration = 6
        await denied { _ = try await bridge.invoke(["lease": "owned", "action": "share"]) }
        precondition(bridge.shows == 1)
        memory.rowGeneration = 7; memory.hold = true
        let pending = Task { try await bridge.invoke(["lease": "owned", "action": "save"]) }
        for _ in 0..<100 where !memory.pending { await Task.yield() }
        precondition(memory.pending)
        bridge.close("owned"); bridge.release("owned")
        precondition(!bridge.contains("owned") && bridge.contains("peer"))
        memory.releaseBytes()
        await denied { _ = try await pending.value }
        precondition(bridge.shows == 1 && FileManager.default.fileExists(atPath: source.path))
        bridge.release("owned"); precondition(bridge.contains("peer"))
        try seed("legacy", legacy); memory.paths = []
        _ = try await bridge.invoke(["lease": "legacy", "action": "preview"])
        precondition(memory.paths == [legacy.route] && bridge.lastKey == "legacy")
        let shows = bridge.shows; memory.generation = 8
        await denied { _ = try await bridge.invoke(["lease": "legacy", "action": "preview"]) }
        precondition(bridge.shows == shows)
        bridge.release("legacy"); bridge.release("peer")
        precondition(FileManager.default.fileExists(atPath: source.path))
        if CommandLine.arguments.count > 1 {
            let bodies = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) as! [[String: Any]]
            for body in bodies {
                let parsed = try ResourceReadRequest(body), raw = (body["source"] as! [String: Any])["descriptor"] as! [String: Any]
                precondition(NSDictionary(dictionary: parsed.contact!.descriptor).isEqual(to: raw))
            }
        }
        print("Contact generation parser, wire, authenticated bytes and exact permission retirement passed")
    }
}
