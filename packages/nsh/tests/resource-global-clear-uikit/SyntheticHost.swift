import Foundation
import UIKit
import NativeShell

@MainActor final class GlobalClearMemory {
    private let authority = RuntimeHostAuthority()
    private var selected = "synthetic-a"
    init() { _ = authority.setForeground(true, hostID: selected) }
    var scope: RuntimeHostScope { authority.scope(hostID: selected)! }
    func current(_ expected: RuntimeHostScope) -> Bool { authority.matches(expected, hostID: selected) }
    func admit(_ expected: RuntimeHostScope) throws { _ = try authority.admit(expected, hostID: selected, required: true) }
    func rotate() { selected = selected == "synthetic-a" ? "synthetic-b" : "synthetic-c"; authority.rotate(hostID: selected) }
    func snapshot() -> [String: Any] {
        ["connections": [["id": selected, "url": "https://synthetic.invalid", "name": "Memory only", "transportID": "syntheticGlobalClear", "authorizationID": "syntheticOnly"]], "selected": selected, "runtimeScope": scope.publicValue]
    }
    func read(_ route: String, limit: Int) throws -> ResourceWebPreviewResponse {
        let html = "<!doctype html><html><body><h1>Synthetic global clear</h1><p>No real Host or network.</p></body></html>"
        let response: ResourceWebPreviewResponse
        if route == "/api/fs/stat?path=%2Ffixture%2Findex.html" {
            response = ResourceWebPreviewResponse(status: 200, mime: "application/json", data: try JSONSerialization.data(withJSONObject: ["isFile": true, "isDirectory": false, "size": html.utf8.count, "mtimeMs": 1, "isBinary": false]))
        } else if route == "/api/fs/serve/fixture/index.html" {
            response = ResourceWebPreviewResponse(status: 200, mime: "text/html; charset=utf-8", data: Data(html.utf8))
        } else { throw RuntimeHostScopeFailure.invalid }
        guard response.data.count <= limit else { throw RuntimeHostScopeFailure.invalid }
        return response
    }
    func request(_ input: Any?) throws -> Any {
        guard let args = input as? [String: Any], let route = args["path"] as? String,
              args["method"] as? String == "GET", args["body"] == nil else { throw RuntimeHostScopeFailure.invalid }
        try admit(RuntimeHostScope(args["expectedHost"]))
        let value = try read(route, limit: 1_000_000)
        return ["status": value.status, "body": try JSONSerialization.jsonObject(with: value.data)]
    }
}

@MainActor final class GlobalClearAudit {
    enum Event: String, CaseIterable {
        case enabled, armed, resourceRouteAdded, resourceRead, controllerMounted, preAttachConfirmed, gateMissed
        case authorityRevoked, globalClearAdmitted, connectionApplied, lateRouteAdded, closeIntent, anchorAttached
        case actionRegistrationReady, actionRegistrationFailure, controllerOpened, dismissCompleted, closeFailed
        case leaseRelease, routeRemoved, nativeFailure, backgrounded
    }
    private final class WeakController { weak var value: UIViewController?; init(_ value: UIViewController) { self.value = value } }
    private var controllers: [Int: WeakController] = [:], sequence = 0, controllerSerial = 0
    private var rows: [[String: Any]] = []
    private let journalURL: URL?
    private var auditWriteFailed = false
    var controlsEnabled = false, armed = false, twice = false, applied = false, latest = ""
    var owner: String?, generation = 0, attempt = 0, controllerToken = 0
    var changed: (() -> Void)?
    init() {
        journalURL = try? FileManager.default.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("global-clear-audit.json")
    }
    func controller(_ value: UIViewController) -> Int {
        if let existing = controllers.first(where: { $0.value.value === value }) { return existing.key }
        controllerSerial += 1; controllers[controllerSerial] = WeakController(value)
        if controllers.count > 64, let oldest = controllers.keys.min() { controllers.removeValue(forKey: oldest) }
        return controllerSerial
    }
    func record(_ event: Event, route: Int = 0) {
        sequence += 1
        rows.append(["sequence": sequence, "event": event.rawValue, "controllerToken": controllerToken,
                     "generation": generation, "attempt": attempt, "route": route])
        if rows.count > 64 { rows.removeFirst(rows.count - 64) }
        do {
            guard let journalURL else { throw RuntimeHostScopeFailure.unavailable }
            try JSONSerialization.data(withJSONObject: snapshot(), options: [.sortedKeys]).write(to: journalURL, options: .atomic)
        } catch { auditWriteFailed = true }
    }
    func snapshot() -> [String: Any] {
        ["syntheticOnly": true, "controlsEnabled": controlsEnabled, "armed": armed, "events": rows,
         "capacity": 64, "controllerAlive": controllers[controllerToken]?.value != nil, "auditWriteFailed": auditWriteFailed]
    }
    func note(_ input: Any?) throws {
        guard let args = input as? [String: Any], let raw = args["event"] as? String, let event = Event(rawValue: raw),
              [.resourceRouteAdded, .globalClearAdmitted, .lateRouteAdded, .routeRemoved, .actionRegistrationReady, .actionRegistrationFailure,
               .controllerOpened, .dismissCompleted, .closeFailed].contains(event) else { throw RuntimeHostScopeFailure.invalid }
        if let supplied = args["owner"] as? String, supplied != owner { return }
        if let number = args["attempt"] as? Int { attempt = max(attempt, number) }
        record(event, route: args["route"] as? Int ?? 0)
    }
}
