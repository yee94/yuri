import Foundation
import CoreFoundation

/// Foundation-only, in-memory protocol fixture. Also compiled by macOS pure
/// tests; it cannot load a connection, credential, socket or production bridge.
final class NewSessionSyntheticHost {
    private static let hostID = "new-session-uikit-synthetic"
    private static let lease = "new-session-uikit-memory-lease"
    private let seed: [String: Any]
    private let roots: Set<String>
    private let home: String
    private var settings: [String: Any]
    private var files: [String: String] = [:]
    private var fileRoots: [String: String] = [:]
    private var directoryMade = false
    private var requests = 0, reads = 0, captures = 0, settingsWrites = 0, configWrites = 0, mkdirCalls = 0
    private var rejected = 0, deniedSessionWrites = 0, auditReads = 0, sequence = 0, journalDropped = 0
    private var journal: [[String: Any]] = []
    private var lastCapture: [String: Any] = [:]

    init(seed: [String: Any]) throws {
        guard seed["schemaVersion"] as? Int == 1, let home = seed["home"] as? String,
              let projects = seed["projects"] as? [[String: Any]], !projects.isEmpty,
              let settings = seed["settings"] as? [String: Any], let configs = seed["projectConfigs"] as? [String: Any],
              seed["commands"] is [[String: Any]], seed["skills"] is [[String: Any]],
              seed["agents"] is [[String: Any]], seed["providers"] is [[String: Any]] else { throw Self.failure("Invalid synthetic seed") }
        self.seed = seed; self.home = home; self.settings = settings
        roots = Set(projects.compactMap { $0["path"] as? String })
        for root in roots {
            guard let config = configs[root] as? [String: Any] else { throw Self.failure("Missing synthetic project config") }
            let encoded = Data(root.utf8).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
            let fallback = root.replacingOccurrences(of: "[^A-Za-z0-9._-]+", with: "_", options: .regularExpression)
            let text = try Self.json(config)
            for identifier in Set([encoded, fallback]) {
                let path = home + "/.config/yuri/projects/path_" + identifier + ".json"
                fileRoots[path] = root; files[path] = text
            }
            fileRoots[root + "/.yuri/yuri.json"] = root
        }
    }

    static func failure(_ message: String) -> NSError { NSError(domain: "NewSessionSyntheticHost", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
    static func json(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .fragmentsAllowed]), as: UTF8.self)
    }
    private func record(_ kind: String, _ detail: [String: Any]) {
        sequence += 1; journal.append(["sequence": sequence, "kind": kind, "detail": detail])
        if journal.count > 128 { journal.removeFirst(); journalDropped += 1 }
    }
    private func keys(_ value: Any?, allowed: Set<String>, required: Set<String>) throws -> [String: Any] {
        guard let object = value as? [String: Any], Set(object.keys).isSubset(of: allowed), required.isSubset(of: Set(object.keys)) else { throw Self.failure("Invalid synthetic body") }
        return object
    }
    private func nonempty(_ value: Any?) -> Bool { (value as? String)?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false }
    private func starters(_ value: Any?) -> Bool {
        guard let refs = value as? [[String: Any]], refs.count <= 64 else { return false }
        return refs.allSatisfy { Set($0.keys) == ["type", "name"] && ["command", "skill"].contains($0["type"] as? String ?? "") && nonempty($0["name"]) }
    }
    private func models(_ value: Any?) -> Bool {
        guard let refs = value as? [[String: Any]], refs.count <= 64 else { return false }
        return refs.allSatisfy { Set($0.keys).isSubset(of: ["providerID", "modelID", "variant"]) && nonempty($0["providerID"]) && nonempty($0["modelID"]) && ($0["variant"] == nil || $0["variant"] is String) }
    }
    private func ok(_ body: Any) -> [String: Any] { ["status": 200, "body": body] }

    /// Every call is captured here before routing. Reads and rejected calls are
    /// separate from successful writes; inspection never increments captures.
    func call(_ name: String, _ input: Any?) throws -> Any {
        do {
            if name == "connection.list" {
                _ = try keys(input, allowed: [], required: [])
                return ["selected": Self.hostID, "connections": [["id": Self.hostID, "label": "Synthetic memory Host", "url": "https://synthetic.invalid", "authorizationID": "fixture-memory-authorization", "lastUsedAt": 0]],
                        "runtimeScope": ["hostID": Self.hostID, "lease": Self.lease]] as [String: Any]
            }
            if name == "fixture.newSession.audit" {
                _ = try keys(input, allowed: [], required: [])
                auditReads += 1; return snapshot
            }
            if name == "fixture.newSession.capture" {
                let body = try keys(input, allowed: ["directory", "selection", "agent"], required: ["directory"])
                guard let directory = body["directory"] as? String, roots.contains(directory),
                      body["agent"] == nil || body["agent"] is String else { throw Self.failure("Invalid synthetic selection scope") }
                if let selection = body["selection"] { guard models([selection]) else { throw Self.failure("Invalid synthetic selection") } }
                captures += 1
                lastCapture = ["directory": directory, "selection": body["selection"] ?? NSNull(), "agent": body["agent"] ?? NSNull()]
                record("capture", lastCapture); return snapshot
            }
            guard name == "runtime.request" else { throw Self.failure("Unsupported synthetic native call: " + name) }
            requests += 1
            let input = try keys(input, allowed: ["path", "method", "body", "expectedHost"], required: ["path", "expectedHost"])
            let expected = try keys(input["expectedHost"], allowed: ["hostID", "lease"], required: ["hostID", "lease"])
            guard expected["hostID"] as? String == Self.hostID, expected["lease"] as? String == Self.lease else { throw Self.failure("Synthetic runtime scope mismatch") }
            let route = try Route(input)
            let method = route.method, path = route.path
            if path == "/api/session" || path.hasPrefix("/api/session/") {
                if method != "GET" { deniedSessionWrites += 1 }
                throw Self.failure("Session creation and model invocation are disabled in this fixture")
            }
            if path == "/api/config/settings" {
                try route.expect(method == "PUT" ? "PUT" : "GET")
                if method == "PUT" {
                    let patch = try keys(input["body"], allowed: ["draftStarters", "favoriteModels"], required: [])
                    guard patch.count == 1, patch["draftStarters"] != nil ? starters(patch["draftStarters"]) : models(patch["favoriteModels"]) else { throw Self.failure("Invalid synthetic settings patch") }
                    settings.merge(patch) { _, new in new }; settingsWrites += 1; record("settings-write", patch)
                } else { reads += 1 }
                return ok(settings)
            }
            if path == "/api/fs/home" { try route.expect("GET"); reads += 1; return ok(["home": home]) }
            if path == "/api/fs/read" {
                try route.expect("GET", allowed: ["path", "optional"], required: ["path"])
                let file = route.params["path"]!
                guard fileRoots[file] != nil, route.params["optional"] == nil || route.params["optional"] == "true" else { throw Self.failure("Unexpected synthetic config read") }
                reads += 1
                if let text = files[file] { return ok(text) }
                return route.params["optional"] == "true" ? ok("") : ["status": 404, "body": ["error": "Synthetic file absent"]]
            }
            if path == "/api/fs/mkdir" {
                try route.expect("POST")
                let body = try keys(input["body"], allowed: ["path"], required: ["path"])
                guard body["path"] as? String == home + "/.config/yuri/projects" else { throw Self.failure("Unexpected synthetic mkdir") }
                directoryMade = true; mkdirCalls += 1; record("mkdir", body); return ok(["success": true])
            }
            if path == "/api/fs/write" {
                try route.expect("POST")
                let body = try keys(input["body"], allowed: ["path", "content"], required: ["path", "content"])
                guard directoryMade, let file = body["path"] as? String, file.hasPrefix(home + "/.config/yuri/projects/"), let root = fileRoots[file],
                      let text = body["content"] as? String, text.utf8.count <= 65536,
                      let config = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
                      config["projectPath"] as? String == root, starters(config["draftStarters"]) else { throw Self.failure("Invalid synthetic project write") }
                // Both explicit runtime projectId spellings represent this root.
                for (alias, candidate) in fileRoots where candidate == root && alias.hasPrefix(home + "/.config/yuri/projects/") { files[alias] = text }
                configWrites += 1; record("config-write", body); return ok(["success": true])
            }
            if path == "/api/config/commands/metadata" {
                try route.expect("POST", allowed: ["directory"], required: ["directory"]); try scope(route.params["directory"])
                let body = try keys(input["body"], allowed: ["catalog"], required: ["catalog"])
                guard let flag = body["catalog"] as? NSNumber, CFGetTypeID(flag) == CFBooleanGetTypeID(), flag.boolValue else { throw Self.failure("Invalid synthetic catalog flag") }
                reads += 1; return ok(["commands": seed["commands"]!])
            }
            if path == "/api/config/skills" {
                try route.expect("GET", allowed: ["directory", "summary"], required: ["directory", "summary"]); try scope(route.params["directory"])
                guard route.params["summary"] == "true" else { throw Self.failure("Invalid synthetic summary") }
                reads += 1; return ok(["skills": seed["skills"]!])
            }
            if path == "/api/config/catalog/providers" {
                try route.expect("GET", allowed: ["directory"], required: ["directory"]); try scope(route.params["directory"])
                reads += 1; return ok(["schemaVersion": 1, "providers": seed["providers"]!])
            }
            if ["/api/agent", "/api/skill", "/api/command"].contains(path) {
                try route.expect("GET", allowed: ["location[directory]"], required: ["location[directory]"]); try scope(route.params["location[directory]"])
                reads += 1; return ok(["data": seed[path == "/api/agent" ? "agents" : path == "/api/skill" ? "skills" : "commands"]!])
            }
            if path == "/api/magic-prompts" { try route.expect("GET"); reads += 1; return ok(["version": 1, "overrides": [String: Any]()]) }
            if path == "/api/yuri/session-index" { try route.expect("GET"); reads += 1; return ok(["available": true, "directories": [Any]()]) }
            throw Self.failure("Unexpected synthetic route: " + path)
        } catch {
            rejected += 1; record("rejected", ["name": name, "reason": error.localizedDescription]); throw error
        }
    }
    private func scope(_ value: String?) throws {
        guard let value, roots.contains(value) else { throw Self.failure("Unexpected synthetic directory") }
    }
    var snapshot: [String: Any] {
        ["syntheticOnly": true, "networkEnabled": false, "keychainEnabled": false, "sessionWritesEnabled": false,
         "requests": requests, "reads": reads, "captures": captures, "settingsWrites": settingsWrites, "configWrites": configWrites,
         "mkdirCalls": mkdirCalls, "rejected": rejected, "deniedSessionWrites": deniedSessionWrites, "auditReads": auditReads,
         "lastCapture": lastCapture, "settings": settings, "projectFiles": files, "journal": journal, "journalDropped": journalDropped]
    }

    private struct Route {
        let path: String, method: String
        let params: [String: String]
        init(_ input: [String: Any]) throws {
            guard let resource = input["path"] as? String, resource.hasPrefix("/"), !resource.hasPrefix("//"),
                  resource.rangeOfCharacter(from: .whitespacesAndNewlines.union(.controlCharacters)) == nil,
                  !resource.contains("\\"), !resource.contains("#"), input["method"] == nil || input["method"] is String else { throw NewSessionSyntheticHost.failure("Invalid synthetic resource") }
            let split = resource.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
            path = String(split[0]); method = input["method"] as? String ?? "GET"
            var query: [String: String] = [:]
            if split.count > 1 && !split[1].isEmpty {
                for field in split[1].split(separator: "&", omittingEmptySubsequences: false) {
                    let pair = field.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
                    guard pair.count == 2, let key = String(pair[0]).replacingOccurrences(of: "+", with: " ").removingPercentEncoding, !key.isEmpty,
                          let value = String(pair[1]).replacingOccurrences(of: "+", with: " ").removingPercentEncoding, query[key] == nil else { throw NewSessionSyntheticHost.failure("Invalid or duplicate synthetic query") }
                    query[key] = value
                }
            }
            params = query
        }
        func expect(_ expected: String, allowed: Set<String> = [], required: Set<String> = []) throws {
            guard method == expected, Set(params.keys).isSubset(of: allowed), required.allSatisfy({ params[$0]?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false }) else { throw NewSessionSyntheticHost.failure("Unexpected synthetic method/query") }
        }
    }
}
