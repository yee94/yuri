import Foundation
import CoreFoundation

/// Only memory-backed wire reads. Never imports a transport, model runner or credential store.
final class HistoryProductionHost {
    static let hostID = "history-production-synthetic"
    static let transportID = "cd9d3a81-277a-4e69-958a-cf789c8b46e3"
    static let lease = "00000000-0000-4000-8000-000000000053"
    static let directory = "/fixture/history"
    static let sessionID = "history-production-500"
    static let methods = ["connection.list", "runtime.request", "runtime.stream", "runtime.stop", "native.diagnostics.status", "notification.configure", "notification.launch.peek", "speech.prepare", "speech.stop", "speech.release", "speech.voices"]
    let scenario: String
    let diffLayout: String
    let appearanceProfile: String?
    let density: Int?
    let runMode: String
    var observerDisabled: Bool { runMode == "ui-parity" }
    static let uiParityControlMethods = ["history.qa.ready", "history.qa.clock", "history.qa.clockAck"]
    private var admitted = false, partialFailed = false, tailReads = 0, sequence = 0
    struct StreamTicket: Equatable {
        let id: UUID, key: String, hostID: String, lease: UUID, ownerID: String?
        var expectedHost: [String: Any] { ["hostID": hostID, "lease": lease.uuidString.lowercased()] }
    }
    enum StreamOutput { case ready, data(String), disconnected }
    private var streams: [String: StreamTicket] = [:]
    private(set) var journal: [[String: Any]] = []
    private(set) var rejected = 0
    private var journalOverflow = false
    private var journalBytes = 0, journalDropped = 0
    private var startupSweeps = 0
    private var runCursors: [String: (scope: String, offset: Int)] = [:]
    private var syntheticBtwGenerateCount = 0
    private static let btwQuestion = "fixture code question"
    private static let btwInstructions = "The user is asking a quick side question about the conversation so far. Answer directly and concisely in markdown from what you already know. Do not call any tools and do not take any actions."
    private static let btwMarkdown = """
    Synthetic BTW fixture only. No model was invoked. 🧪🙂

    Inline code: `let count = 2`.

    ```swift
    let message = "Synthetic 🧪"
    let count = 2
    print(message, count)
    ```

    Plain text after the code block. This is a fixed memory-backed response.
    """
    func completeStartupSweep() { startupSweeps += 1; record("empty-authorization-retirement-sweep", ["pending": 0]) }
    var onEvent: ((String, Any) -> Void)?
    var onRecord: (([String: Any]) -> Void)?
    var sheetLifecycleAudit: (() -> [String: Any])?
    init(scenario: String, diffLayout: String? = ProcessInfo.processInfo.environment["HISTORY_SYNTHETIC_DIFF_LAYOUT"], appearanceProfile: String? = ProcessInfo.processInfo.environment["HISTORY_SYNTHETIC_APPEARANCE"], runMode: String? = ProcessInfo.processInfo.environment["HISTORY_SYNTHETIC_RUN_MODE"], densityProfile: String? = ProcessInfo.processInfo.environment["HISTORY_SYNTHETIC_DENSITY"]) throws {
        guard ["normal", "terminal", "partial", "growth"].contains(scenario) else { throw Self.failure("scenario") }
        guard appearanceProfile == nil || appearanceProfile == "reference-105" else { throw Self.failure("appearance_profile") }
        if let diffLayout { guard ["inline", "side-by-side", "dynamic"].contains(diffLayout) else { throw Self.failure("diff_layout") } }
        guard runMode == nil || runMode == "ui-parity" else { throw Self.failure("run_mode") }
        let densities = ["50": 50, "100": 100, "105": 105, "200": 200]
        if let densityProfile {
            guard densities[densityProfile] != nil else { throw Self.failure("density_profile") }
            guard runMode == "ui-parity" else { throw Self.failure("density_requires_ui_parity") }
        }
        self.scenario = scenario
        self.appearanceProfile = appearanceProfile
        self.diffLayout = diffLayout ?? (appearanceProfile == "reference-105" ? "dynamic" : "inline")
        self.runMode = runMode ?? "history-diagnostic"
        self.density = densityProfile.flatMap { densities[$0] }
    }
    static func failure(_ code: String) -> NSError { NSError(domain: "HistoryProductionHost", code: 1, userInfo: [NSLocalizedDescriptionKey: "history_fixture_" + code]) }
    static func json(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .fragmentsAllowed]) }
    private func keys(_ value: Any?, _ allowed: Set<String>, _ required: Set<String> = []) throws -> [String: Any] {
        guard let object = value as? [String: Any], Set(object.keys).isSubset(of: allowed), required.isSubset(of: Set(object.keys)) else { throw Self.failure("arguments") }
        return object
    }
    private func scope(_ value: Any?) throws {
        let parsed = try parsedScope(value)
        guard admitted, parsed.hostID == Self.hostID, parsed.lease == UUID(uuidString: Self.lease) else { throw Self.failure("scope") }
    }
    private func parsedScope(_ value: Any?) throws -> (hostID: String, lease: UUID) {
        let object = try keys(value, ["hostID", "lease"], ["hostID", "lease"])
        guard let hostID = object["hostID"] as? String, !hostID.isEmpty, hostID.utf8.count <= 256,
              !hostID.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              let raw = object["lease"] as? String, raw.utf8.count == 36, let lease = UUID(uuidString: raw) else { throw Self.failure("scope") }
        return (hostID, lease)
    }
    private static func validOwner(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 128 && value.utf8.allSatisfy { (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95 }
    }
    private func rejectedRequestMetadata(_ input: Any?) -> [String: Any] {
        let object = input as? [String: Any] ?? [:]
        let allowed: Set<String> = ["path", "method", "body", "expectedHost"]
        let present = Set(object.keys)
        let resource = (object["path"] as? String ?? "").split(whereSeparator: { $0 == "?" || $0 == "#" }).first.map(String.init) ?? ""
        let paths: Set<String> = ["/api/config/settings", "/api/config/themes", "/api/config/catalog/providers", "/api/agent", "/api/debug/location", "/api/yuri/session-index", "/api/yuri/assistants/snapshot", "/api/yuri/scheduled-tasks", "/api/session/active"]
        let method = object["method"] as? String ?? (object["method"] == nil ? "GET" : "<invalid>")
        let scopeKeys = Set((object["expectedHost"] as? [String: Any] ?? [:]).keys)
        let knownScopeKeys: Set<String> = ["hostID", "lease"]
        return ["path": paths.contains(resource) ? resource : "<unlisted>", "method": ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].contains(method) ? method : "<invalid>",
                "knownKeys": present.intersection(allowed).sorted(), "missingRequiredKeys": Set(["path", "expectedHost"]).subtracting(present).sorted(), "unknownKeyCount": present.subtracting(allowed).count,
                "scopeKnownKeys": scopeKeys.intersection(knownScopeKeys).sorted(), "scopeUnknownKeyCount": scopeKeys.subtracting(knownScopeKeys).count]
    }
    // The pure callback harness may retain a ticket across replacement, just as an async transport would.
    func streamTicket(_ key: String) -> StreamTicket? { streams[key] }
    func emit(_ output: StreamOutput, ticket: StreamTicket) {
        guard admitted, streams[ticket.key] == ticket else { return }
        var envelope: [String: Any] = ["key": ticket.key, "expectedHost": ticket.expectedHost]
        if let owner = ticket.ownerID { envelope["ownerID"] = owner }
        var name = "runtime.event"
        switch output {
        case .ready: envelope["type"] = "reconnected"
        case .data(let data): envelope["data"] = data
        case .disconnected: name = "runtime.disconnected"
        }
        onEvent?(name, envelope)
    }
    private func record(_ phase: String, _ fields: [String: Any] = [:]) {
        if !observerDisabled, journal.count >= 20000 { journalOverflow = true; return }
        sequence += 1
        var event = fields; event["phase"] = phase; event["sequence"] = sequence
        event["nativeUptimeMs"] = ProcessInfo.processInfo.systemUptime * 1000
        event["scenario"] = scenario; event["sourceGeneration"] = 1
        if observerDisabled {
            var bytes = (try? Self.json(event).count) ?? 2049
            if bytes > 2048 {
                event = ["phase": "ui-parity-entry-omitted", "sequence": sequence, "reason": "entry-byte-limit"]
                bytes = (try? Self.json(event).count) ?? 128
            }
            while !journal.isEmpty && (journal.count >= 128 || journalBytes + bytes > 32768) {
                journalBytes -= (try? Self.json(journal.removeFirst()).count) ?? 0
                journalDropped += 1; journalOverflow = true
            }
            journalBytes += bytes
        }
        journal.append(event); onRecord?(event)
    }
    private var activeProfiles: [String: Any] {
        var profiles: [String: Any] = ["appearance": NSNull(), "diffLayout": NSNull()]
        if let appearanceProfile { profiles["appearance"] = appearanceProfile }
        if scenario == "normal" || appearanceProfile != nil { profiles["diffLayout"] = diffLayout }
        if let density { profiles["density"] = density }
        return profiles
    }
    var snapshot: [String: Any] {
        var value: [String: Any] = ["schema": 1, "synthetic": true, "scenario": scenario, "runMode": runMode, "observerDisabled": observerDisabled, "activeProfiles": activeProfiles, "startupSweeps": startupSweeps, "messageCount": 500, "tailReads": tailReads, "rejected": rejected, "journal": journal, "journalOverflow": journalOverflow, "journalSequence": sequence, "journalDropped": journalDropped, "sdkAdoptionIdentity": NSNull(), "network": false, "mutations": 0]
        if observerDisabled { value["syntheticBtwGenerateCount"] = syntheticBtwGenerateCount }
        if observerDisabled, let sheetLifecycleAudit { value["sheetLifecycle"] = sheetLifecycleAudit() }
        return value
    }
    func uiParityAuditData() throws -> Data {
        guard observerDisabled else { throw Self.failure("ui_parity_audit_unavailable") }
        let admission: [String: Any] = ["clock": false, "mark": false, "prepareAX": false, "readAX": false, "capture": false]
        let audit: [String: Any] = ["schema": 1, "sourceSynthetic": true, "runMode": runMode, "observerDisabled": true, "strictAcceptance": false, "historyDriverAdmission": false,
                                   "diagnosticsAvailable": admission, "host": snapshot, "journalLimits": ["entries": 128, "bytes": 32768, "entryBytes": 2048], "journalBytes": journalBytes]
        let data = try Self.json(audit)
        guard data.count <= 49152 else { throw Self.failure("ui_parity_audit_size") }
        return data
    }
    private var session: [String: Any] { ["id": Self.sessionID, "title": "History production 500", "location": ["directory": Self.directory], "time": ["created": 1000, "updated": 2000], "model": ["providerID": "fixture", "id": "gpt-fixture"], "agent": "build"] }
    static func id(_ index: Int) -> String { String(format: "hp-%04d", index) }
    func message(_ index: Int, full: Bool = false, grown: Bool = false) -> [String: Any] {
        let id = Self.id(index), userIndex = index - index % 3, created = 1_700_000_000_000 + index * 1000
        let marker = "ANCHOR " + id
        var row: [String: Any] = ["id": id, "sessionID": Self.sessionID, "type": index % 3 == 0 ? "user" : "assistant", "time": ["created": created], "model": ["providerID": "fixture", "id": "gpt-fixture"], "agent": "build"]
        if index % 3 == 0 {
            row["content"] = [["type": "text", "text": marker + "\n\nSynthetic question about ordered records, natural layout and a stable reading position."]]
        } else {
            row["parentID"] = Self.id(userIndex)
            if index % 3 == 1 {
                row["finish"] = "tool-calls"
                row["content"] = [
                    ["id": "thought-" + id, "type": "reasoning", "text": marker + " reasoning\n\n" + String(repeating: "A neutral observation preserves the original ordering and complete content. ", count: 8)],
                    ["id": "tool-" + id, "type": "tool", "name": "shell", "slim": !full, "time": ["ran": created + 10, "completed": created + 500], "state": ["status": "completed", "input": ["command": "printf synthetic-memory-only"], "output": full ? String(repeating: marker + " synthetic output without execution\n", count: 45) : "", "metadata": ["synthetic": true]]]
                ] as [[String: Any]]
            } else {
                row["finish"] = "stop"; row["time"] = ["created": created, "completed": created + 1771000]
                row["tokens"] = ["output": 71]
                let prose = String(repeating: "A complete neutral paragraph exercises variable natural line wrapping without removing source content. ", count: 2 + index % 7)
                row["content"] = [["type": "text", "text": marker + "\n\n" + prose + "\n\n1. Preserve identity\n2. Preserve order\n3. Observe native geometry\n\n```text\n" + marker + "\nno command is executed\n```" + (grown ? String(repeating: "\n\n" + marker + " newly received complete paragraph. " + prose, count: min(32, max(0, tailReads - 1))) : "")]]
            }
        }
        if scenario == "normal", index == 499, full {
            var content = row["content"] as! [[String: Any]]
            let files: [[String: Any]] = changeFiles.map { file in
                ["relativePath": file.path, "status": file.added ? "added" : "modified", "before": file.added ? "" : "Synthetic incomplete historical side", "additions": file.added ? 72 : 3, "deletions": file.added ? 0 : 3]
            }
            let state: [String: Any] = ["status": "completed", "input": ["patch": "Synthetic recorded metadata only; no patch was applied."], "output": "Synthetic historical changes.", "metadata": ["files": files]]
            let tool: [String: Any] = ["id": "outer-history-patch", "type": "tool", "name": "apply_patch", "slim": false, "time": ["ran": created + 10, "completed": created + 500], "state": state]
            content.append(tool)
            row["content"] = content
        }
        return row
    }
    func call(_ name: String, _ input: Any?) throws -> Any {
        do {
            if observerDisabled, Self.uiParityControlMethods.contains(name) {
                if name == "history.qa.ready" {
                    _ = try keys(input, [])
                    record("ui-parity-sidecar-unavailable")
                    return ["available": false, "runMode": runMode, "observerDisabled": true, "strictAcceptance": false, "historyDriverAdmission": false] as [String: Any]
                }
                throw Self.failure("ui_parity_diagnostics_unavailable")
            }
            if name == "connection.list" {
                guard startupSweeps > 0 else { throw Self.failure("startup_retirement_not_ready") }
                _ = try keys(input, []); admitted = true; record("connection-snapshot")
                return ["selected": Self.hostID, "connections": [["id": Self.hostID, "label": "Synthetic history memory Host", "url": "https://synthetic.invalid", "authorizationID": "history-synthetic-only", "transportID": Self.transportID, "lastUsedAt": 0]], "runtimeScope": ["hostID": Self.hostID, "lease": Self.lease]] as [String: Any]
            }
            guard admitted else { throw Self.failure("admission_required") }
            if name == "speech.voices" {
                let value = try keys(input, ["expectedHost"], ["expectedHost"]); try scope(value["expectedHost"])
                record("lazy-voice-catalog-read"); return ["voices": []]
            }
            if name == "runtime.stream" || name == "runtime.stop" {
                guard let body = input as? [String: Any], let key = body["key"] as? String, ["global", "chat"].contains(key) else { throw Self.failure("stream") }
                let starting = name == "runtime.stream", chat = key == "chat"
                var exact: Set<String> = ["key", "expectedHost"]
                if starting { exact.insert("path") }
                if chat { exact.insert("ownerID"); if starting { exact.insert("mode") } }
                let value = try keys(input, exact, exact), expected = try parsedScope(value["expectedHost"])
                let owner = value["ownerID"] as? String
                if chat { guard let owner, Self.validOwner(owner) else { throw Self.failure("stream_owner") } }
                if starting {
                    try scope(value["expectedHost"])
                    if chat {
                        guard let mode = value["mode"] as? String, ["auto", "ws", "sse"].contains(mode) else { throw Self.failure("stream_mode") }
                        let route = try HistoryProductionRoute(["path": value["path"] as Any])
                        guard route.path == "/api/event" else { throw Self.failure("stream_path") }
                        try route.expect("GET", ["directory"], ["directory"])
                    } else { guard value["path"] as? String == "/api/yuri/events" else { throw Self.failure("stream_path") } }
                    let ticket = StreamTicket(id: UUID(), key: key, hostID: expected.hostID, lease: expected.lease, ownerID: owner)
                    streams[key] = ticket
                    emit(.ready, ticket: ticket)
                } else if let ticket = streams[key], ticket.ownerID == owner, ticket.hostID == expected.hostID, ticket.lease == expected.lease {
                    streams.removeValue(forKey: key)
                }
                record(name, ["key": key]); return true
            }
            if name == "native.diagnostics.status" {
                _ = try keys(input, []); return ["schemaVersion": 2, "mode": "event-recorder", "enabled": false, "recordingLease": NSNull(), "eventCount": 0, "maxEntries": 500, "maxBytes": 262144] as [String: Any]
            }
            if name == "notification.launch.peek" { _ = try keys(input, []); return ["record": NSNull()] }
            if name == "notification.configure" {
                let value = try keys(input, ["hostID", "enabled", "mode", "events", "language"], ["hostID", "enabled", "mode", "events", "language"])
                guard value["hostID"] as? String == Self.hostID, let enabled = value["enabled"] as? NSNumber, CFGetTypeID(enabled) == CFBooleanGetTypeID(), !enabled.boolValue,
                      value["mode"] as? String == "hidden-only", let language = value["language"] as? String, language.count <= 16,
                      let events = value["events"] as? [String], Set(events) == ["completion", "error", "question", "permission", "schedule", "assistant", "goal"], events.count == 7 else { throw Self.failure("notification") }
                return ["lease": "history-synthetic-notifications-disabled"]
            }
            if name.hasPrefix("speech.") {
                let value = try keys(input, ["owner", "revision"], ["owner"])
                guard let owner = value["owner"] as? String, owner.hasPrefix("speech-"), owner.count < 128 else { throw Self.failure("speech_owner") }
                if name == "speech.prepare" { return ["visible": false, "provider": "browser", "mode": "sanitized"] }
                guard ["speech.stop", "speech.release"].contains(name) else { throw Self.failure("speech_disabled") }; return NSNull()
            }
            guard name == "runtime.request" else { throw Self.failure("native_call_denied") }
            let value = try keys(input, ["path", "method", "body", "expectedHost"], ["path", "expectedHost"])
            try scope(value["expectedHost"])
            let route = try HistoryProductionRoute(value)
            let requestID = sequence + 1
            if route.path == "/api/session/" + Self.sessionID + "/generate" {
                record("request", ["requestID": requestID, "path": route.path, "query": [String: String](), "queryKeyCount": route.params.count, "method": route.method])
            } else {
                record("request", ["requestID": requestID, "path": route.path, "query": route.params, "method": route.method])
            }
            let result = try request(route, value["body"], requestID)
            record("response", ["requestID": requestID, "status": result["status"] ?? 0])
            return result
        } catch {
            rejected += 1
            var rejection: [String: Any] = ["name": name, "code": error.localizedDescription]
            if name == "runtime.request" { rejection.merge(rejectedRequestMetadata(input)) { _, diagnostic in diagnostic } }
            record("rejected", rejection); throw error
        }
    }
    private func ok(_ body: Any) -> [String: Any] { ["status": 200, "body": body] }
    // Wire fields follow tests/assistants-settings-host.js, tests/schedules-host.js and features-uikit.
    // Only newly built normal artifacts expose this memory-only outer navigation dataset.
    private var bots: [[String: Any]] {
        guard scenario == "normal" else { return [] }
        return (1...2).map { index in
            ["id": "outer-bot-\(index)", "revision": index, "name": "Synthetic \(index == 1 ? "Research" : "Review") Bot", "avatarSeed": "outer-bot-\(index)",
             "defaultPrompt": "Synthetic read-only configuration. No model is invoked.", "providerID": "fixture", "modelID": "gpt-fixture",
             "workspacePath": Self.directory, "effectiveWorkspacePath": Self.directory, "managedWorkspacePath": Self.directory,
             "pinnedAt": index == 1 ? 3 as Any : NSNull(), "unreadCount": index == 2 ? 2 : 0, "working": index == 1,
             "latestMessagePreview": ["text": "Synthetic fixture preview \(index)", "createdAt": 1_700_000_000_000 + index, "fallbackKind": NSNull()]]
        }
    }
    private var tasks: [[String: Any]] {
        guard scenario == "normal" else { return [] }
        return (1...2).map { index in
            ["id": "outer-task-\(index)", "name": "Synthetic \(index == 1 ? "daily" : "paused") schedule", "enabled": index == 1,
             "schedule": ["kind": "daily", "times": [index == 1 ? "09:00" : "18:30"], "timezone": "UTC"],
             "execution": ["prompt": "Inspect synthetic history only; never execute.", "providerID": "fixture", "modelID": "gpt-fixture", "agent": "build", "goalEnabled": false],
             "state": ["createdAt": 1, "updatedAt": 2, "lastStatus": index == 1 ? "success" : "error", "lastRunAt": 1_700_000_000_000, "nextRunAt": 1_800_000_000_000]]
        }
    }
    private var taskEntries: [[String: Any]] { tasks.map { ["projectId": "history-project", "task": $0] } }
    private var changeFiles: [(path: String, staged: Bool, added: Bool)] {
        [("src/staged.txt", true, false), ("src/working.txt", false, false), ("docs/new-note.md", false, true)]
    }
    private var workspaceStatus: [String: Any] {
        var stats: [String: Any] = [:]
        let files: [[String: Any]] = changeFiles.map { file in
            stats[file.path] = ["insertions": file.added ? 72 : 3, "deletions": file.added ? 0 : 3]
            return ["path": file.path, "index": file.added ? "?" : file.staged ? "M" : " ", "working_dir": file.added ? "?" : file.staged ? " " : "M"]
        }
        return ["isGitRepository": true, "isClean": false, "current": "synthetic-changes", "tracking": NSNull(), "ahead": 0, "behind": 0, "oversized": false, "files": files, "diffStats": stats]
    }
    private func changeText(_ path: String, historical: Bool) -> (original: String, modified: String, patch: String, added: Bool) {
        let added = path == "docs/new-note.md", count = added ? 72 : 180
        let label = historical ? "HISTORICAL RECORDED" : "WORKSPACE SYNTHETIC"
        let lines = (1...count).map { "\(label) \(path) line \($0): " + String(repeating: "neutral selectable text ", count: $0 % 7 == 0 ? 12 : 2) }
        let old = added ? [] : lines
        let next = added ? lines : lines.enumerated().map { [7, 69, 139].contains($0.offset) ? $0.element + " changed" : $0.element }
        var patch = "diff --git a/\(path) b/\(path)\n--- \(added ? "/dev/null" : "a/" + path)\n+++ b/\(path)\n@@ -\(added ? "0,0" : "1,180") +1,\(count) @@\n"
        for (index, line) in next.enumerated() {
            if added { patch += "+" + line + "\n" }
            else if old[index] != line { patch += "-" + old[index] + "\n+" + line + "\n" }
            else { patch += " " + line + "\n" }
        }
        return (old.isEmpty ? "" : old.joined(separator: "\n") + "\n", next.joined(separator: "\n") + "\n", patch, added)
    }
    private func runHistory(_ r: HistoryProductionRoute, _ requestID: Int) throws -> [String: Any] {
        try r.expect("GET", ["limit", "before", "projectId", "taskId"], ["limit"])
        guard scenario == "normal", r.params["limit"] == "20", (r.params["projectId"] == nil) == (r.params["taskId"] == nil) else { throw Self.failure("run_scope") }
        if let task = r.params["taskId"] {
            guard r.params["projectId"] == "history-project", tasks.contains(where: { $0["id"] as? String == task }) else { throw Self.failure("run_scope") }
        }
        let owner = r.params["taskId"] ?? "global"
        let offset: Int
        if let token = r.params["before"] {
            guard let issued = runCursors[token], issued.scope == owner else { throw Self.failure("run_cursor") }
            offset = issued.offset
        } else { offset = 0 }
        let rows: [[String: Any]] = (0..<6).compactMap { index in
            let task = tasks[index % 2], taskID = task["id"] as! String
            guard r.params["taskId"] == nil || taskID == owner else { return nil }
            let started = 1_700_000_000_000 - index * 1000, failed = index % 2 == 1
            let row: [String: Any] = ["id": "outer-run-\(index)", "projectId": "history-project", "taskId": taskID, "taskName": task["name"]!,
                    "trigger": index % 2 == 0 ? "scheduled" : "manual", "status": failed ? "error" : "success",
                    "sessionId": Self.sessionID, "directory": Self.directory, "error": failed ? "Synthetic recorded failure; no execution occurred." as Any : NSNull(),
                    "startedAt": started, "finishedAt": started + 100, "durationMs": 100]
            return row
        }
        let end = min(offset + 2, rows.count)
        guard offset < rows.count else { throw Self.failure("run_cursor") }
        var next: Any = NSNull()
        if end < rows.count {
            let token = "outer-opaque+/=\(owner)-\(end)"
            runCursors[token] = (scope: owner, offset: end); next = token
        }
        let page = Array(rows[offset..<end])
        record("outer-history-response", ["requestID": requestID, "scope": owner, "requestCursor": r.params["before"] ?? NSNull(), "responseIDs": page.map { $0["id"]! }, "nextCursor": next, "complete": end == rows.count])
        return ok(["runs": page, "nextCursor": next, "complete": end == rows.count])
    }
    private func request(_ r: HistoryProductionRoute, _ body: Any?, _ requestID: Int) throws -> [String: Any] {
        if r.path == "/api/config/commands/metadata" {
            guard observerDisabled, scenario == "normal" else { throw Self.failure("synthetic_preset_catalog_disabled") }
            try r.expect("POST", ["directory"], ["directory"])
            let payload = try keys(body, ["catalog"], ["catalog"])
            guard r.params["directory"] == Self.directory, let catalog = payload["catalog"] as? NSNumber,
                  CFGetTypeID(catalog) == CFBooleanGetTypeID(), catalog.boolValue else { throw Self.failure("synthetic_preset_catalog_shape") }
            let commands: [[String: Any]] = [
                ["name": "fixture-command", "description": "Synthetic user command; catalog only.", "agent": NSNull(), "model": NSNull(), "source": "command", "scope": "user", "isBuiltIn": false, "reference": "/fixture/home/.config/opencode/commands/fixture-command.md"],
                ["name": "fixture-project-command", "description": "Synthetic project command; catalog only.", "agent": NSNull(), "model": NSNull(), "source": "command", "scope": "project", "isBuiltIn": false, "reference": "/fixture/history/.opencode/commands/fixture-project-command.md"]
            ]
            record("synthetic-preset-catalog-read", ["requestID": requestID, "catalog": "commands", "rowCount": 2, "synthetic": true])
            return ok(["commands": commands])
        }
        // Fixed stateless simulation, not a model call or business write; UI mode only.
        if r.path == "/api/session/" + Self.sessionID + "/generate" {
            guard observerDisabled, scenario == "normal" else { throw Self.failure("synthetic_btw_disabled") }
            try r.expect("POST")
            let payload = try keys(body, ["prompt"], ["prompt"])
            guard let prompt = payload["prompt"] as? String,
                  prompt == Self.btwQuestion || prompt == Self.btwInstructions + "\n\n" + Self.btwQuestion else { throw Self.failure("synthetic_btw_prompt") }
            syntheticBtwGenerateCount += 1
            record("synthetic-btw-generate", ["requestID": requestID, "generateCount": syntheticBtwGenerateCount, "synthetic": true])
            return ok(["data": ["text": Self.btwMarkdown]])
        }
        if r.path == "/api/rpc/opencode.goal/get" {
            try r.expect("POST", ["location[directory]"], ["location[directory]"])
            let outer = try keys(body, ["input"], ["input"]), inner = try keys(outer["input"], ["sessionID"], ["sessionID"])
            guard inner["sessionID"] as? String == Self.sessionID else { throw Self.failure("goal_scope") }
            return ok(["output": NSNull()])
        }
        guard r.method == "GET", body == nil else { throw Self.failure("mutation_denied") }
        switch r.path {
        case "/api/fs/home":
            try r.expect("GET")
            guard scenario == "normal" else { throw Self.failure("unlisted_route") }
            return ok(["home": "/fixture/home"])
        case "/api/fs/read":
            try r.expect("GET", ["path", "optional"], ["path", "optional"])
            // The normal fixture has one canonical project config, not a filesystem reader.
            guard scenario == "normal", r.params["optional"] == "true",
                  r.params["path"] == "/fixture/home/.config/yuri/projects/path_L2ZpeHR1cmUvaGlzdG9yeQ.json" else { throw Self.failure("new_draft_config_scope") }
            let config: [String: Any] = ["projectPath": Self.directory, "draftStarters": [[String: String]]()]
            return ok(String(decoding: try Self.json(config), as: UTF8.self))
        case "/api/config/settings":
            try r.expect("GET")
            var settings: [String: Any] = ["projects": [["id": "history-project", "name": "History production workspace", "path": Self.directory]], "nativeNotificationsEnabled": false, "sessionGoalEnabled": false, "collapsibleUserMessages": false, "chatRenderMode": "sorted", "activityRenderMode": "collapsed", "showReasoningTraces": true, "sessionRetentionEnabled": false]
            if appearanceProfile == "reference-105" {
                let reference: [String: Any] = ["themeId": "jetbrains-dark", "themeVariant": "dark", "lightThemeId": "nightowl-light", "darkThemeId": "jetbrains-dark", "useSystemTheme": true, "fontSize": 105, "monoFont": "system-mono", "uiFont": "system", "chatRenderMode": "sorted", "diffLayoutPreference": "dynamic"]
                settings.merge(reference) { _, profile in profile }
                record("synthetic-appearance-read", ["activeProfiles": activeProfiles])
            }
            if let density { settings["padding"] = density; record("synthetic-density-read", ["density": density]) }
            if scenario == "normal" || appearanceProfile != nil { settings["diffLayoutPreference"] = diffLayout; record("synthetic-layout-read", ["diffLayoutPreference": diffLayout]) }
            return ok(settings)
        case "/api/config/themes": try r.expect("GET"); return ok(["themes": []])
        case "/auth/passkey/status": try r.expect("GET"); record("lazy-passkey-status-read"); return ok(["enabled": false])
        case "/api/passkeys": try r.expect("GET"); record("lazy-passkey-list-read"); return ok(["passkeys": []])
        case "/api/yuri/session-index": try r.expect("GET"); return ok(["available": true, "directories": [["directory": Self.directory, "sessions": [session], "hasMore": false]]])
        case "/api/yuri/assistants/snapshot":
            try r.expect("GET")
            if scenario == "normal" {
                let snapshot: [String: Any] = ["assistants": bots, "revision": 3, "enabled": true]
                return ok(snapshot)
            }
            return ok(["assistants": []])
        case "/api/yuri/assistants/capability":
            try r.expect("GET"); guard scenario == "normal" else { throw Self.failure("unlisted_route") }
            return ok(["supported": true, "enabled": true, "sharingAvailable": false])
        case "/api/yuri/scheduled-tasks": try r.expect("GET"); return ok(["tasks": taskEntries, "failedProjectIds": []])
        case "/api/projects/history-project/scheduled-tasks":
            try r.expect("GET"); guard scenario == "normal" else { throw Self.failure("unlisted_route") }; return ok(["tasks": tasks])
        case "/api/yuri/scheduled-task-runs": return try runHistory(r, requestID)
        case "/api/yuri/history-import/jobs": try r.expect("GET"); return ok([])
        case "/api/session/active": try r.expect("GET"); return ok([String: Any]())
        case "/api/permission/request", "/api/form": try r.expect("GET", ["directory"], ["directory"]); return ok([])
        case "/api/session-folders/order": try r.expect("GET"); return ok(["revision": 1, "sessionOrderByScope": [Self.directory: [Self.sessionID], "__pinned__": []], "sessionOrderActivityByScope": [Self.directory: [Self.sessionID: 2000], "__pinned__": [:]]])
        case "/api/yuri/message-queue/worktrees/order": try r.expect("GET", ["projectDirectory"], ["projectDirectory"]); return ok(["projectDirectory": Self.directory, "revision": 1, "orderedPaths": []])
        case "/api/git/check": try r.expect("GET", ["directory"], ["directory"]); return ok(["isGitRepository": scenario == "normal"])
        case "/api/git/worktrees": try r.expect("GET", ["directory"], ["directory"]); return ok([])
        case "/api/git/status":
            try r.expect("GET", ["directory", "mode"], ["directory"])
            guard r.params["mode"] == nil || r.params["mode"] == "light" else { throw Self.failure("git_mode") }
            if scenario == "normal" { record("synthetic-changes-status", ["requestID": requestID, "fileCount": 3, "insertions": 78, "deletions": 6]); return ok(workspaceStatus) }
            return ok(["isGitRepository": false, "isClean": true, "files": []])
        case "/api/git/remotes", "/api/git/branches", "/api/git/primary-root":
            try r.expect("GET", ["directory"], ["directory"])
            guard scenario == "normal" else { throw Self.failure("unlisted_route") }
            if r.path == "/api/git/remotes" { return ok([]) }
            if r.path == "/api/git/branches" { return ok(["all": ["synthetic-changes"]]) }
            return ok(["root": Self.directory])
        case "/api/git/file-diff", "/api/git/diff":
            try r.expect("GET", ["directory", "path", "staged"], ["directory", "path", "staged"])
            guard scenario == "normal", let file = changeFiles.first(where: { $0.path == r.params["path"] }),
                  r.params["staged"] == String(file.staged) else { throw Self.failure("change_file_scope") }
            let diff = changeText(file.path, historical: false)
            record("synthetic-changes-diff", ["requestID": requestID, "source": "workspace", "file": file.path, "staged": file.staged])
            if r.path == "/api/git/diff" { return ok(["diff": diff.patch]) }
            return ok(["original": diff.original, "modified": diff.modified, "isBinary": false])
        case "/api/yuri/sessions/" + Self.sessionID + "/changes":
            try r.expect("GET", ["directory", "messageID", "file"], ["directory", "messageID", "file"])
            guard scenario == "normal", r.params["messageID"] == Self.id(499), let path = r.params["file"], changeFiles.contains(where: { $0.path == path }) else { throw Self.failure("historical_change_scope") }
            let diff = changeText(path, historical: true)
            record("synthetic-changes-diff", ["requestID": requestID, "source": "historical", "messageID": Self.id(499), "file": path])
            let historical: [String: Any] = ["file": path, "status": diff.added ? "added" : "modified", "before": diff.original, "after": diff.modified, "patch": diff.patch, "isBinary": false]
            return ok(["diff": historical])
        case "/api/debug/location": try r.expect("GET"); return ok([])
        case "/api/config/catalog/providers":
            try r.expect("GET", ["directory"], scenario == "normal" ? [] : ["directory"])
            return ok(["schemaVersion": 1, "providers": [["id": "fixture", "name": "Synthetic catalog only", "models": ["gpt-fixture": ["id": "gpt-fixture", "name": "Synthetic GPT", "limit": ["context": 128000]]]]]])
        case "/api/agent":
            try r.expect("GET", ["location[directory]"], scenario == "normal" ? [] : ["location[directory]"])
            return ok(["data": [["name": "build", "mode": "primary"]]])
        case "/api/command", "/api/skill": try r.expect("GET", ["location[directory]"], ["location[directory]"]); return ok(["data": []])
        case "/api/config/skills":
            try r.expect("GET", ["directory", "summary"], ["directory", "summary"])
            guard r.params["summary"] == "true" else { throw Self.failure("summary") }
            if observerDisabled, scenario == "normal" {
                let skills: [[String: Any]] = [["name": "fixture-review", "path": "/fixture/history/.agents/skills/fixture-review/SKILL.md", "scope": "project", "source": "agents", "description": "Synthetic project review skill; catalog only."]]
                record("synthetic-preset-catalog-read", ["requestID": requestID, "catalog": "skills", "rowCount": 1, "synthetic": true])
                return ok(["skills": skills])
            }
            return ok(["skills": []])
        case "/api/magic-prompts": try r.expect("GET"); return ok(["version": 1, "overrides": [String: Any]()])
        case "/api/session":
            try r.expect("GET", ["directory", "parentID", "limit", "order", "archived", "search"], ["parentID", "limit", "order"])
            guard r.params["limit"] == "20", r.params["order"] == "desc" else { throw Self.failure("session_query") }
            return ok(["data": r.params["parentID"] == "null" ? [session] : [], "cursor": [String: Any]()])
        case "/api/session/" + Self.sessionID: try r.expect("GET", ["directory"], ["directory"]); return ok(["data": session])
        case "/api/session/" + Self.sessionID + "/message":
            try r.expect("GET", ["directory", "limit", "order", "cursor"], ["directory", "limit"])
            guard r.params["limit"] == "20" else { throw Self.failure("page_size") }
            let end: Int
            if let cursor = r.params["cursor"] {
                guard r.params["order"] == nil, cursor.hasPrefix("history.before."), let n = Int(cursor.dropFirst(15)), n > 0, n < 500, n % 20 == 0 else { throw Self.failure("cursor") }; end = n
            } else { guard r.params["order"] == "desc" else { throw Self.failure("page_order") }; end = 500; tailReads += 1 }
            if scenario == "partial", end == 480, !partialFailed {
                partialFailed = true; record("intentional-history-error", ["requestID": requestID, "cursor": "history.before.480"])
                return ["status": 503, "body": ["error": "Synthetic page read failed. The existing history and retry remain visible."]]
            }
            let start = max(0, end - 20), grown = scenario == "growth" && tailReads >= 2
            let rows = (start..<end).reversed().map { message($0, grown: grown && $0 == 497) }
            let next: Any = start > 0 ? "history.before.\(start)" as Any : NSNull()
            record("history-response", ["requestID": requestID, "requestCursor": r.params["cursor"] ?? NSNull(), "responseIDs": rows.map { $0["id"]! }, "nextCursor": next, "complete": start == 0, "growth": grown, "growthGeneration": min(32, max(0, tailReads - 1))])
            return ok(["data": rows, "cursor": ["next": next]])
        case "/api/session/" + Self.sessionID + "/inbox", "/api/session/" + Self.sessionID + "/form": try r.expect("GET", ["directory"], ["directory"]); return ok([])
        default:
            if scenario == "normal" {
                for (index, bot) in bots.enumerated() {
                    let prefix = "/api/yuri/assistants/" + (bot["id"] as! String)
                    if r.path == prefix + "/scheduled-tasks" {
                        try r.expect("GET")
                        let task = tasks[index]
                        return ok(["tasks": [["projectID": "history-project", "taskID": task["id"]!, "task": task]], "complete": true])
                    }
                    if r.path == prefix + "/weixin" { try r.expect("GET"); return ok(["status": "disconnected"]) }
                    for channel in ["wecom", "feishu", "dingtalk"] where r.path == prefix + "/channels/" + channel {
                        try r.expect("GET")
                        return ok(["provider": channel, "status": "disconnected", "configured": false, "hasSecret": false, "clientID": "", "ownerID": "", "error": NSNull(), "transferSources": []])
                    }
                }
            }
            let prefix = "/api/session/" + Self.sessionID + "/message/"
            if r.path.hasPrefix(prefix) {
                try r.expect("GET", ["directory"], ["directory"])
                let id = String(r.path.dropFirst(prefix.count))
                guard id.hasPrefix("hp-"), let index = Int(id.dropFirst(3)), (0..<500).contains(index), Self.id(index) == id else { throw Self.failure("message_id") }
                record("exact-fill", ["requestID": requestID, "messageID": id]); return ok(message(index, full: true))
            }
            throw Self.failure("unlisted_route")
        }
    }
}

struct HistoryProductionRoute {
    let path: String, method: String, params: [String: String]
    init(_ input: [String: Any]) throws {
        guard let resource = input["path"] as? String, resource.hasPrefix("/"), !resource.hasPrefix("//"), !resource.contains("\\"), !resource.contains("#"),
              resource.rangeOfCharacter(from: .whitespacesAndNewlines.union(.controlCharacters)) == nil,
              input["method"] == nil || input["method"] is String else { throw HistoryProductionHost.failure("resource") }
        let pieces = resource.split(separator: "?", omittingEmptySubsequences: false)
        guard pieces.count <= 2, pieces.count != 2 || !pieces[1].isEmpty else { throw HistoryProductionHost.failure("query") }
        path = String(pieces[0]); method = input["method"] as? String ?? "GET"
        var values: [String: String] = [:]
        if pieces.count == 2 {
            for field in pieces[1].split(separator: "&", omittingEmptySubsequences: false) {
                let pair = field.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
                guard pair.count == 2, let key = String(pair[0]).removingPercentEncoding, !key.isEmpty, let value = String(pair[1]).removingPercentEncoding, values[key] == nil else { throw HistoryProductionHost.failure("query") }
                if ["directory", "location[directory]", "projectDirectory"].contains(key), value != HistoryProductionHost.directory { throw HistoryProductionHost.failure("directory") }
                values[key] = value
            }
        }
        params = values
    }
    func expect(_ method: String, _ allowed: Set<String> = [], _ required: Set<String> = []) throws {
        guard self.method == method, Set(params.keys).isSubset(of: allowed), required.allSatisfy({ params[$0]?.isEmpty == false }) else { throw HistoryProductionHost.failure("method_or_query") }
    }
}
