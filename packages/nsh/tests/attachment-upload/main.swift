import Foundation

@MainActor final class Host {
    var generation = 3
    var states: [String: String] = [:]
    var descriptors: [String: [String: Any]] = [:]
    var methods: [String] = []
    var loseACK = false
    var failDelete = false
    var beforeCommit: (() async throws -> Void)?
    func send(_ request: AttachmentUploadRequest) async throws -> (Int, Any) {
        methods.append(request.method)
        if request.path.contains("messages?") { return (200, ["generation": generation]) }
        let parts = URLComponents(string: request.path)!
        let id = parts.path.split(separator: "/").last.map(String.init)!
        let requested = Int(parts.queryItems?.first?.value ?? "")
        func receipt(_ state: String) -> [String: Any] {
            ["assistantID": "bot", "uploadID": id, "generation": requested ?? 3, "currentGeneration": generation, "state": state, "descriptor": descriptors[id] as Any? ?? NSNull()]
        }
        if request.method == "GET" { let state = states[id] ?? "not_found"; return (state == "not_found" ? 404 : 200, receipt(state)) }
        if request.method == "DELETE" {
            if failDelete { throw URLError(.notConnectedToInternet) }
            let assertion = try JSONSerialization.jsonObject(with: request.data) as! [String: Any]
            precondition(assertion["generation"] as? Int == 3 && assertion.keys.contains("descriptor"))
            states[id] = "retired"
            var body = receipt("retired"); body["newAdmissionAllowed"] = false; body["ownershipRetained"] = descriptors[id] != nil; body["bytesDeleted"] = false
            return (200, body)
        }
        precondition(request.method == "PUT" && request.headers["Accept"] == "application/vnd.yuri.contact-upload+json")
        if states[id] == "retired" || requested != generation { return (409, [:]) }
        states[id] = "inflight"
        try await beforeCommit?()
        if states[id] == "retired" || requested != generation { return (409, [:]) }
        let descriptor: [String: Any] = ["type": "file", "attachmentID": "att_" + id, "generation": requested!, "sha256": request.headers["X-Content-SHA256"]!, "size": request.data.count, "mime": request.headers["Content-Type"]!, "filename": request.headers["X-Attachment-Filename"]!.removingPercentEncoding!]
        descriptors[id] = descriptor; states[id] = "committed"
        if loseACK { throw URLError(.networkConnectionLost) }
        return (201, descriptor)
    }
}

@main struct Contract {
    @MainActor static func main() async throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try Data("original".utf8).write(to: file)
        defer { try? FileManager.default.removeItem(at: file) }
        let bytes = try Data(contentsOf: file)
        let host = Host(), policy = try AttachmentUploadPolicy(assistantID: "bot", uploadID: "u1")
        try await policy.prepare(current: { true }, send: host.send)
        precondition(host.methods == ["GET", "GET"])
        host.loseACK = true
        do { _ = try await policy.upload(bytes, name: "中.txt", mime: "text/plain", current: { true }, send: host.send); fatalError("lost ACK") } catch { }
        precondition(policy.attempted && policy.descriptor == nil)
        let result = try await policy.reconcile(current: { true }, send: host.send)
        precondition(result?["generation"] as? Int == 3 && host.methods == ["GET", "GET", "PUT", "GET"])
        do { _ = try await policy.upload(bytes, name: "中.txt", mime: "text/plain", current: { true }, send: host.send); fatalError("replay") } catch { }
        let second = try AttachmentUploadPolicy(assistantID: "bot", uploadID: "u2")
        host.loseACK = false
        try await second.prepare(current: { true }, send: host.send)
        _ = try await second.upload(bytes, name: "中.txt", mime: "text/plain", current: { true }, send: host.send)
        precondition(host.descriptors["u1"]!["sha256"] as? String == host.descriptors["u2"]!["sha256"] as? String)
        host.failDelete = true
        do { try await policy.retire(send: host.send); fatalError("cleanup failure") } catch { }
        do { _ = try await policy.reconcile(current: { true }, send: host.send); fatalError("local retirement fence") } catch { }
        host.failDelete = false; try await policy.retire(send: host.send)
        precondition(host.states["u1"] == "retired" && host.states["u2"] == "committed" && FileManager.default.fileExists(atPath: file.path))
        for timing in ["before", "during", "delete"] {
            let h = Host(), p = try AttachmentUploadPolicy(assistantID: "bot", uploadID: timing)
            try await p.prepare(current: { true }, send: h.send)
            if timing == "before" { h.generation = 4 }
            if timing == "during" { h.beforeCommit = { h.generation = 4 } }
            if timing == "delete" { h.beforeCommit = { try await p.retire(send: h.send) } }
            do { _ = try await p.upload(bytes, name: "x.txt", mime: "text/plain", current: { true }, send: h.send); fatalError("stale commit") } catch { }
            precondition(h.descriptors[timing] == nil)
        }
        for bad: Any in [true, NSNull(), [0], "0", -1, 1.5, 9007199254740992.0] {
            do { _ = try AttachmentUploadPolicy.safeInteger(bad); fatalError("generation coercion") } catch { }
        }
        let old = try AttachmentUploadPolicy(assistantID: "bot")
        do { try await old.prepare(current: { true }, send: { request in request.path.contains("messages?") ? (200, ["generation": 0]) : (404, ["error": "not_found"]) }); fatalError("legacy fallback") } catch { }
        for mutation: [String: Any] in [["assistantID": "other"], ["uploadID": "other"], ["generation": true], ["generation": [3]], ["currentGeneration": NSNull()], ["currentGeneration": 2], ["state": "committed"], ["descriptor": [:]]] {
            let p = try AttachmentUploadPolicy(assistantID: "bot", uploadID: "probe")
            var envelope: [String: Any] = ["assistantID": "bot", "uploadID": "probe", "generation": 3, "currentGeneration": 3, "state": "not_found", "descriptor": NSNull()]
            envelope.merge(mutation) { _, new in new }
            do { try await p.prepare(current: { true }, send: { request in request.path.contains("messages?") ? (200, ["generation": 3]) : (404, envelope) }); fatalError("invalid receipt") } catch { }
        }
        var leaseCurrent = true
        let leaseHost = Host(), leasePolicy = try AttachmentUploadPolicy(assistantID: "bot", uploadID: "lease")
        try await leasePolicy.prepare(current: { leaseCurrent }, send: leaseHost.send)
        leaseCurrent = false
        do { _ = try await leasePolicy.upload(bytes, name: "x.txt", mime: "text/plain", current: { leaseCurrent }, send: leaseHost.send); fatalError("expired lease") } catch { }
        precondition(!leaseHost.methods.contains("PUT"))
        // Cleanup has its own exact native authority, not the revoked upload lease.
        try await leasePolicy.retire(send: leaseHost.send)
        precondition(leaseHost.states["lease"] == "retired")
        let absent = Host(), missing = try AttachmentUploadPolicy(assistantID: "bot", uploadID: "missing")
        try await missing.prepare(current: { true }, send: absent.send)
        try await missing.retire(send: absent.send)
        precondition(absent.states["missing"] == "retired")
        print("Attachment upload contract passed")
    }
}
