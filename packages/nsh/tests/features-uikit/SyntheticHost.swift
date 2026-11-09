import Foundation
import CoreFoundation

/// Foundation-only mapper for the features-memory-host.js policy. No production transport or credentials.
final class FeaturesSyntheticHost {
    static let hostID = "features-memory", lease = "features-memory-lease"
    private var connection: [String: Any], settings: [String: Any]
    private var providers: [[String: Any]], bots: [[String: Any]], tasks: [[String: Any]], runs: [[String: Any]]
    private var sequence = 1, auditSequence = 0, rejected = 0, lostACKs = 0
    private var requests: [[String: String]] = []
    private var lose = "", failRead = ""
    private var cursors = ["memory-opaque-next": 2]
    private(set) var selectedHostID: String?
    var scopeIsCurrent: Bool { selectedHostID == Self.hostID }
    init(seed: [String: Any]) throws {
        guard seed["schemaVersion"] as? Int == 1, let connection = seed["connection"] as? [String: Any],
              let scope = connection["runtimeScope"] as? [String: String], scope == ["hostID": Self.hostID, "lease": Self.lease],
              connection["selected"] as? String == Self.hostID,
              let settings = seed["settings"] as? [String: Any], let providers = seed["providers"] as? [[String: Any]],
              let bots = seed["bots"] as? [[String: Any]], let tasks = seed["tasks"] as? [[String: Any]], let runs = seed["runs"] as? [[String: Any]] else { throw Self.failure("Invalid synthetic Features seed") }
        self.connection = connection; self.settings = settings; self.providers = providers; self.bots = bots; self.tasks = tasks; self.runs = runs
    }
    static func failure(_ message: String) -> NSError { NSError(domain: "FeaturesSyntheticHost", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
    static func json(_ value: Any) throws -> String { String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .fragmentsAllowed]), as: UTF8.self) }
    private func fields(_ input: Any?, allowed: Set<String>, required: Set<String> = []) throws -> [String: Any] {
        guard let value = input as? [String: Any], required.isSubset(of: Set(value.keys)), Set(value.keys).isSubset(of: allowed) else { throw Self.failure("Unexpected fixture fields") }
        return value
    }
    private func integer(_ value: Any?) -> Int? {
        guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite, n.doubleValue.rounded() == n.doubleValue, n.doubleValue >= 0, n.doubleValue < Double(Int.max) else { return nil }
        return n.intValue
    }
    private func ok(_ body: Any, _ status: Int = 200) -> [String: Any] { ["status": status, "body": body] }
    func call(_ name: String, _ value: Any?) throws -> Any {
        do {
            let input = value ?? [String: Any]()
            if name == "features.fixture.identity" { _ = try fields(input, allowed: []); return "features-memory-only" }
            if name == "connection.list" { _ = try fields(input, allowed: []); selectedHostID = Self.hostID; return connection }
            if name == "features.fixture.audit" { _ = try fields(input, allowed: []); auditSequence += 1; return snapshot }
            if name == "features.fixture.configure" {
                let options = try fields(input, allowed: ["lose", "failRead"])
                let loss = options["lose"] as? String ?? "", read = options["failRead"] as? String ?? ""
                guard ["", "POST /api/yuri/assistants", "PATCH /api/projects/project/scheduled-tasks"].contains(loss),
                      read.isEmpty || read == "/api/yuri/scheduled-task-runs?limit=20&before=memory-opaque-next&projectId=project&taskId=task" else { throw Self.failure("Unsupported fixture fault") }
                lose = loss; failRead = read; return true
            }
            guard name == "runtime.request" else { throw Self.failure("Unlisted synthetic capability") }
            let request = try fields(input, allowed: ["path", "method", "body", "expectedHost"], required: ["path", "method", "expectedHost"])
            let expected = try fields(request["expectedHost"], allowed: ["hostID", "lease"], required: ["hostID", "lease"])
            guard scopeIsCurrent, expected["hostID"] as? String == Self.hostID, expected["lease"] as? String == Self.lease,
                  let resource = request["path"] as? String, resource.hasPrefix("/api/"), !resource.contains("\\"), !resource.contains("#"),
                  resource.rangeOfCharacter(from: .whitespacesAndNewlines.union(.controlCharacters)) == nil,
                  let method = request["method"] as? String, ["GET", "POST", "PATCH", "PUT", "DELETE"].contains(method) else { throw Self.failure("Synthetic runtime scope mismatch") }
            if method == "GET" && request["body"] != nil { throw Self.failure("Unexpected GET body") }
            requests.append(["path": resource, "method": method])
            if method == "GET" && resource == failRead { failRead = ""; return ok(["error": "fixture read failed"], 503) }
            let response = try route(resource, method, request["body"])
            if lose == "\(method) \(resource)" { lose = ""; lostACKs += 1; throw Self.failure("fixture ACK lost") }
            return response
        } catch { rejected += 1; throw error }
    }
    private func route(_ resource: String, _ method: String, _ rawBody: Any?) throws -> [String: Any] {
        let base = "/api/projects/project/scheduled-tasks"
        if method == "GET" {
            switch resource {
            case "/api/config/settings": return ok(settings)
            case "/api/config/settings/bootstrap": return ok(settings.merging(["schemaVersion": 1]) { _, new in new })
            case "/api/config/themes": return ok(["themes": []])
            case "/api/config", "/api/config?location%5Bdirectory%5D=%2Ffirst-project": return ok([])
            case "/api/config/catalog/providers", "/api/config/catalog/providers?directory=%2Fmanaged", "/api/config/catalog/providers?directory=%2Ffirst-project": return ok(["schemaVersion": 1, "providers": providers])
            case "/api/agent?location%5Bdirectory%5D=%2Ffirst-project": return ok(["data": [["id": "build", "name": "build", "mode": "primary"]]])
            case "/api/yuri/assistants/capability": return ok(["supported": true, "enabled": true])
            case "/api/yuri/assistants/snapshot": return ok(["assistants": bots, "revision": sequence, "enabled": true])
            case base: return ok(["tasks": tasks])
            case "/api/yuri/scheduled-tasks": return ok(["tasks": tasks.map { ["projectId": "project", "task": $0] as [String: Any] }, "failedProjectIds": []])
            case "/api/yuri/session-index": return ok(["available": true, "directories": [["directory": "/first-project", "sessions": []]]])
            default:
                if resource.hasPrefix("/api/yuri/scheduled-task-runs?") { return try history(resource) }
                throw Self.failure("Unlisted synthetic GET")
            }
        }
        if resource == "/api/config/settings" && method == "PUT" {
            let body = try fields(rawBody, allowed: ["favoriteModels", "recentModels"])
            for (key, value) in body { guard value is [[String: Any]] else { throw Self.failure("Invalid model preference") }; settings[key] = value }
            return ok(["ok": true])
        }
        if resource == "/api/yuri/assistants" && method == "POST" {
            var body = try fields(rawBody, allowed: ["name", "avatarSeed", "defaultPrompt", "workspacePath", "providerID", "modelID", "variant", "language"], required: ["name", "defaultPrompt", "workspacePath", "providerID", "modelID"])
            guard let name = body["name"] as? String, !name.isEmpty, body["providerID"] as? String == "fixture", body["modelID"] as? String == "model" else { return ok(["error": "invalid Bot"], 400) }
            sequence += 1; body["id"] = "memory-bot-\(sequence)"; body["revision"] = 1; body["managedWorkspacePath"] = "/managed"; bots.append(body); return ok(body)
        }
        if resource.hasPrefix("/api/yuri/assistants/") {
            let id = String(resource.dropFirst("/api/yuri/assistants/".count))
            guard !id.contains("/"), let index = bots.firstIndex(where: { $0["id"] as? String == id }) else { return ok(["error": "missing Bot"], 404) }
            let body = try fields(rawBody, allowed: ["name", "avatarSeed", "defaultPrompt", "workspacePath", "providerID", "modelID", "variant", "expectedRevision"], required: ["expectedRevision"])
            guard let revision = integer(body["expectedRevision"]), revision == integer(bots[index]["revision"]) else { return ok(["error": "revision conflict"], 409) }
            if method == "DELETE" { bots.remove(at: index); sequence += 1; return ok(["assistantID": id, "tombstoneAt": sequence]) }
            guard method == "PATCH" else { throw Self.failure("Unlisted Bot method") }
            for (key, value) in body where key != "expectedRevision" { bots[index][key] = value }; bots[index]["revision"] = revision + 1; return ok(bots[index])
        }
        if resource == base && ["PUT", "PATCH"].contains(method) {
            let body = try fields(rawBody, allowed: ["task"], required: ["task"])
            let task = try fields(body["task"], allowed: ["id", "name", "enabled", "schedule", "execution"], required: ["id"])
            guard let id = task["id"] as? String, !id.isEmpty else { return ok(["error": "missing task"], 400) }
            let existing = tasks.firstIndex(where: { $0["id"] as? String == id })
            if method == "PATCH" && existing == nil { return ok(["error": "missing task"], 404) }
            var updated = existing.map { tasks[$0] } ?? ["state": ["createdAt": 1, "updatedAt": 1, "lastStatus": "idle"]]
            for (key, value) in task { updated[key] = value }
            if let index = existing { tasks[index] = updated } else { tasks.append(updated) }
            return ok(["task": updated, "tasks": tasks, "schedulerSynced": true])
        }
        if resource.hasPrefix(base + "/") {
            let parts = String(resource.dropFirst(base.count + 1)).split(separator: "/").map(String.init)
            guard let id = parts.first, let index = tasks.firstIndex(where: { $0["id"] as? String == id }) else { return ok(["error": "missing task"], 404) }
            if parts.count == 1 && method == "DELETE" { tasks.remove(at: index); return ok(["tasks": tasks, "schedulerSynced": true]) }
            if parts.count == 2 && parts[1] == "run" && method == "POST" {
                sequence += 1; let at = 1800000000000 + sequence, session = "memory-session-\(sequence)"
                var state = tasks[index]["state"] as? [String: Any] ?? [:]; state["lastStatus"] = "success"; state["lastRunAt"] = at; state["lastSessionId"] = session; tasks[index]["state"] = state
                runs.insert(["id": "memory-run-\(sequence)", "projectId": "project", "taskId": id, "taskName": tasks[index]["name"] ?? "", "trigger": "manual", "status": "success", "sessionId": session, "directory": "/first-project", "error": NSNull(), "startedAt": at, "finishedAt": at + 100, "durationMs": 100], at: 0)
                return ok(["ok": true, "task": tasks[index], "sessionId": session])
            }
        }
        throw Self.failure("Unlisted synthetic write")
    }
    private func history(_ resource: String) throws -> [String: Any] {
        let split = resource.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
        var query: [String: String] = [:]
        for field in split[1].split(separator: "&", omittingEmptySubsequences: false) {
            let pair = field.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            guard pair.count == 2, let key = String(pair[0]).removingPercentEncoding, let value = String(pair[1]).removingPercentEncoding, query[key] == nil else { throw Self.failure("Invalid history query") }
            query[key] = value
        }
        guard Set(query.keys).isSubset(of: ["projectId", "taskId", "limit", "before"]), query["projectId"] == "project", query["limit"] == "20", let id = query["taskId"], tasks.contains(where: { $0["id"] as? String == id }) else { throw Self.failure("Unexpected history scope") }
        let offset: Int
        if let cursor = query["before"] { guard let known = cursors[cursor] else { throw Self.failure("Unknown opaque history cursor") }; offset = known } else { offset = 0 }
        let rows = runs.filter { $0["taskId"] as? String == id }, end = min(offset + 2, rows.count)
        guard offset <= rows.count else { throw Self.failure("Invalid history offset") }
        var next: Any = NSNull()
        if end < rows.count { let token = end == 2 ? "memory-opaque-next" : "features-opaque-page-\(end)"; cursors[token] = end; next = token }
        return ok(["runs": Array(rows[offset..<end]), "nextCursor": next, "complete": end == rows.count])
    }
    var snapshot: [String: Any] { ["syntheticOnly": true, "network": false, "keychain": false, "modelInvocations": 0, "auditSequence": auditSequence, "rejected": rejected, "lostACKs": lostACKs, "requests": requests, "bots": bots, "tasks": tasks, "runs": runs, "settings": settings] }
}
