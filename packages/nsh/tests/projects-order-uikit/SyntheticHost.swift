import Foundation
import CoreFoundation

/// Foundation-only in-memory ordering authority. No transport or production bridges.
final class ProjectsOrderSyntheticHost {
    private static let hostID = "projects-order-uikit-synthetic"
    private static let lease = "projects-order-uikit-memory-lease"
    private let project: String
    private let directories: [[String: Any]]
    private let sessions: [[String: Any]]
    private let pins: [String]
    private let running: [String]
    private var treePaths: [String]
    private var orders: [String: [String]] = [:]
    private var activities: [String: [String: Double]] = [:]
    private var revision = 1, treeRevision = 1, requests = 0, reads = 0, rejected = 0, auditReads = 0
    private var sessionOrderWrites = 0, worktreeOrderWrites = 0, journalDropped = 0
    private var journal: [[String: Any]] = []

    init(seed: [String: Any]) throws {
        guard seed["schemaVersion"] as? Int == 1,
              let projects = seed["projects"] as? [[String: Any]], projects.count == 1,
              let project = projects[0]["path"] as? String,
              let directories = seed["directories"] as? [[String: Any]], directories.count >= 2,
              let pins = seed["pinnedSessionIDs"] as? [String], let running = seed["runningSessionIDs"] as? [String],
              let retained = seed["retainedWorktreePaths"] as? [String] else { throw Self.failure("Invalid Projects seed") }
        self.project = project; self.directories = directories; self.pins = pins; self.running = running
        var rows: [[String: Any]] = [], paths: [String] = [], seededOrders: [String: [String]] = [:], seededActivities: [String: [String: Double]] = [:]
        for (directoryIndex, directory) in directories.enumerated() {
            guard let path = directory["path"] as? String, path.hasPrefix("/fixture/"),
                  let count = directory["sessionCount"] as? Int, (2...40).contains(count),
                  let prefix = directory["idPrefix"] as? String, !prefix.isEmpty,
                  directory["name"] is String, directory["branch"] is String else { throw Self.failure("Invalid directory seed") }
            paths.append(path)
            var ids: [String] = [], baseline: [String: Double] = [:]
            for index in 0..<count {
                let id = prefix + String(index), activity = Double(1000 - index)
                ids.append(id); baseline[id] = activity
                var row: [String: Any] = ["id": id, "title": "Session \(directoryIndex).\(index)", "location": ["directory": path],
                    "time": ["created": activity, "updated": activity], "metadata": ["fixture": ["retained": true, "identity": id]]]
                if index % 2 == 0 { row["summary"] = ["additions": 12 + index, "deletions": 3] }
                rows.append(row)
            }
            seededOrders[path] = ids; seededActivities[path] = baseline
        }
        guard paths.first == project, Set(paths).count == paths.count,
              Set(rows.compactMap { $0["id"] as? String }).count == rows.count,
              Set(pins).count == pins.count, Set(pins + running).isSubset(of: Set(rows.compactMap { $0["id"] as? String })),
              retained.allSatisfy({ $0.hasPrefix("/fixture/") && !paths.contains($0) }), Set(retained).count == retained.count else { throw Self.failure("Invalid seed identities") }
        sessions = rows; treePaths = Array(paths.dropFirst()) + retained
        orders = seededOrders; activities = seededActivities
        orders["__pinned__"] = pins; activities["__pinned__"] = [:]
    }
    static func failure(_ message: String) -> NSError { NSError(domain: "ProjectsOrderSyntheticHost", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
    static func json(_ value: Any) throws -> String { String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .fragmentsAllowed]), as: UTF8.self) }
    private func keys(_ value: Any?, allowed: Set<String>, required: Set<String>) throws -> [String: Any] {
        guard let object = value as? [String: Any], Set(object.keys).isSubset(of: allowed), required.isSubset(of: Set(object.keys)) else { throw Self.failure("Invalid fixture arguments") }
        return object
    }
    private func number(_ value: Any?) -> Double? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite else { return nil }
        return number.doubleValue
    }
    private func ok(_ body: Any) -> [String: Any] { ["status": 200, "body": body] }
    private func record(_ kind: String, _ body: [String: Any]) {
        journal.append(["sequence": sessionOrderWrites + worktreeOrderWrites, "kind": kind, "body": body])
        if journal.count > 128 { journal.removeFirst(); journalDropped += 1 }
    }
    func call(_ name: String, _ input: Any?) throws -> Any {
        do {
            if name == "connection.list" {
                _ = try keys(input, allowed: [], required: [])
                return ["selected": Self.hostID, "connections": [["id": Self.hostID, "label": "Synthetic Projects Host", "url": "https://synthetic.invalid", "authorizationID": "fixture-memory-authorization", "lastUsedAt": 0]], "runtimeScope": ["hostID": Self.hostID, "lease": Self.lease]] as [String: Any]
            }
            if name == "fixture.projectsOrder.audit" { _ = try keys(input, allowed: [], required: []); auditReads += 1; return snapshot }
            guard name == "runtime.request" else { throw Self.failure("Unsupported fixture native call") }
            requests += 1
            let input = try keys(input, allowed: ["path", "method", "body", "expectedHost"], required: ["path", "expectedHost"])
            let expected = try keys(input["expectedHost"], allowed: ["hostID", "lease"], required: ["hostID", "lease"])
            guard expected["hostID"] as? String == Self.hostID, expected["lease"] as? String == Self.lease else { throw Self.failure("Fixture runtime scope mismatch") }
            let route = try Route(input), path = route.path
            if route.method == "GET" && input["body"] != nil { throw Self.failure("Unexpected read body") }
            if path == "/api/yuri/session-index" {
                try route.expect("GET"); reads += 1
                return ok(["available": true, "pinnedSessionIds": pins, "directories": directories.map { directory -> [String: Any] in
                    let path = directory["path"] as! String
                    return ["directory": path, "sessions": sessions.filter { ($0["location"] as? [String: String])?["directory"] == path }, "hasMore": false]
                }])
            }
            if path == "/api/session/active" { try route.expect("GET"); reads += 1; return ok(Dictionary(uniqueKeysWithValues: running.map { ($0, ["type": "running"]) })) }
            if path == "/api/session" {
                try route.expect("GET", allowed: ["directory", "parentID", "limit", "order"], required: ["directory", "parentID", "limit", "order"])
                guard let directory = route.params["directory"], orders[directory] != nil, route.params["parentID"] == "null", route.params["order"] == "desc", route.params["limit"] == "20" else { throw Self.failure("Unexpected session directory read") }
                reads += 1; return ok(["data": sessions.filter { ($0["location"] as? [String: String])?["directory"] == directory }, "cursor": [String: Any]()])
            }
            if path == "/api/git/worktrees" || path == "/api/git/check" {
                try route.expect("GET", allowed: ["directory"], required: ["directory"])
                guard route.params["directory"] == project else { throw Self.failure("Unexpected synthetic project") }
                reads += 1
                return path == "/api/git/check" ? ok(["isGitRepository": true]) : ok(directories.map { ["path": $0["path"]!, "name": $0["name"]!, "branch": $0["branch"]!] })
            }
            if path == "/api/session-folders/order" {
                if route.method == "GET" { try route.expect("GET"); reads += 1 }
                else {
                    try route.expect("POST")
                    let body = try keys(input["body"], allowed: ["scopeKey", "order", "activity", "onlyIfAbsent"], required: ["scopeKey", "order", "activity", "onlyIfAbsent"])
                    guard let scope = body["scopeKey"] as? String, let previous = orders[scope], let ids = body["order"] as? [String],
                          Set(ids) == Set(previous), ids.count == previous.count,
                          let activity = body["activity"] as? [String: Any], let flag = body["onlyIfAbsent"] as? NSNumber,
                          CFGetTypeID(flag) == CFBooleanGetTypeID(), !flag.boolValue else { throw Self.failure("Invalid scoped session order") }
                    let expectedActivity = activities[scope] ?? [:]
                    guard Set(activity.keys) == Set(expectedActivity.keys), activity.allSatisfy({ number($0.value) == expectedActivity[$0.key] }) else { throw Self.failure("Invalid activity preservation") }
                    orders[scope] = ids; revision += 1; sessionOrderWrites += 1; record("session-order", body)
                }
                return ok(["revision": revision, "sessionOrderByScope": orders, "sessionOrderActivityByScope": activities])
            }
            if path == "/api/yuri/message-queue/worktrees/order" {
                if route.method == "GET" {
                    try route.expect("GET", allowed: ["projectDirectory"], required: ["projectDirectory"])
                    guard route.params["projectDirectory"] == project else { throw Self.failure("Unexpected tree scope") }
                    reads += 1; return ok(["projectDirectory": project, "revision": treeRevision, "orderedPaths": treePaths])
                }
                try route.expect("PUT")
                let body = try keys(input["body"], allowed: ["requestID", "projectDirectory", "expectedRevision", "orderedPaths"], required: ["requestID", "projectDirectory", "expectedRevision", "orderedPaths"])
                guard let requestID = body["requestID"] as? String, !requestID.isEmpty, requestID.utf8.count < 256,
                      body["projectDirectory"] as? String == project, let expected = number(body["expectedRevision"]), expected.rounded() == expected, expected >= 0,
                      let paths = body["orderedPaths"] as? [String], paths.count == treePaths.count, Set(paths) == Set(treePaths) else { throw Self.failure("Invalid worktree order") }
                guard expected == Double(treeRevision) else { return ["status": 409, "body": ["error": "revision_conflict"]] }
                treePaths = paths; treeRevision += 1; worktreeOrderWrites += 1; record("worktree-order", body)
                return ok(["projectDirectory": project, "revision": treeRevision])
            }
            throw Self.failure("Session/model/filesystem/Git writes and unlisted routes are disabled")
        } catch { rejected += 1; throw error }
    }
    var snapshot: [String: Any] {
        ["syntheticOnly": true, "networkEnabled": false, "keychainEnabled": false, "sessionWritesEnabled": false,
         "sessionOrderWrites": sessionOrderWrites, "worktreeOrderWrites": worktreeOrderWrites, "requests": requests, "reads": reads, "rejected": rejected, "auditReads": auditReads,
         "revision": revision, "treeRevision": treeRevision, "orders": orders, "activities": activities, "treePaths": treePaths, "sessions": sessions, "pins": pins, "journal": journal, "journalDropped": journalDropped]
    }
    private struct Route {
        let path: String, method: String, params: [String: String]
        init(_ input: [String: Any]) throws {
            guard let resource = input["path"] as? String, resource.hasPrefix("/"), !resource.hasPrefix("//"),
                  resource.rangeOfCharacter(from: .whitespacesAndNewlines.union(.controlCharacters)) == nil,
                  !resource.contains("\\"), !resource.contains("#"), input["method"] == nil || input["method"] is String else { throw ProjectsOrderSyntheticHost.failure("Invalid fixture resource") }
            let split = resource.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
            path = String(split[0]); method = input["method"] as? String ?? "GET"
            var params: [String: String] = [:]
            if split.count > 1 && !split[1].isEmpty {
                for field in split[1].split(separator: "&", omittingEmptySubsequences: false) {
                    let pair = field.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
                    guard pair.count == 2, let key = String(pair[0]).replacingOccurrences(of: "+", with: " ").removingPercentEncoding, !key.isEmpty,
                          let value = String(pair[1]).replacingOccurrences(of: "+", with: " ").removingPercentEncoding, params[key] == nil else { throw ProjectsOrderSyntheticHost.failure("Invalid or duplicate fixture query") }
                    params[key] = value
                }
            }
            self.params = params
        }
        func expect(_ method: String, allowed: Set<String> = [], required: Set<String> = []) throws {
            guard self.method == method, Set(params.keys).isSubset(of: allowed), required.allSatisfy({ params[$0]?.isEmpty == false }) else { throw ProjectsOrderSyntheticHost.failure("Unexpected fixture method/query") }
        }
    }
}
