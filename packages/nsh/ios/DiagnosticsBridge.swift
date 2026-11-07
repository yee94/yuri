import Foundation
import CoreFoundation

/// Closed, content-free projection. Never serialize a Host response, error, or connection.
enum NativeAboutSnapshot {
    static let blockers = ["signed-artifact", "trusted-update-origin", "signed-manifest-verifier", "native-install-lifecycle"]
    static let management = ["manual-global", "manual-external", "bundled", "in-app", "none"]
    static let operations = ["checking", "downloading", "installing", "restarting", "succeeded", "failed"]
    static func version(_ value: Any?) -> String? {
        guard let raw = value as? String else { return nil }
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.utf8.count <= 96,
              text.range(of: #"^v?[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$"#, options: .regularExpression) != nil else { return nil }
        return text
    }
    static func build(_ value: Any?) -> String? {
        guard let text = value as? String, text.trimmingCharacters(in: .whitespacesAndNewlines) == text,
              text.range(of: #"^[0-9]{1,18}(?:\.[0-9]{1,6}){0,2}$"#, options: .regularExpression) != nil else { return nil }
        return text
    }
    static func metadata(info: [String: Any]) -> [String: Any] {
        ["schemaVersion": 1, "version": version(info["CFBundleShortVersionString"]) as Any? ?? NSNull(),
         "build": build(info["CFBundleVersion"]) as Any? ?? NSNull(),
         "updates": ["status": "unsupported", "blockers": blockers]]
    }
    static func boolean(_ value: Any?) -> Any {
        guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return NSNull() }
        return number.boolValue
    }
    static func choice(_ value: Any?, _ allowed: [String]) -> Any {
        guard let text = value as? String, allowed.contains(text) else { return NSNull() }
        return text
    }
    static func make(_ input: Any?, info: [String: Any]) throws -> Data {
        guard let root = input as? [String: Any], let schema = root["schemaVersion"] as? NSNumber,
              CFGetTypeID(schema) != CFBooleanGetTypeID(), schema.intValue == 1, schema.doubleValue == 1 else {
            throw NSError(domain: "NSHDiagnostics", code: 1)
        }
        let host = root["host"] as? [String: Any] ?? [:]
        let opencode = root["opencode"] as? [String: Any] ?? [:]
        let update = root["hostUpdate"] as? [String: Any] ?? [:]
        let states = ["unknown", "ready", "failed"]
        let snapshot: [String: Any] = [
            "schemaVersion": 1, "kind": "nsh-about-snapshot", "mode": "snapshot-only",
            "client": metadata(info: info),
            "host": ["version": version(host["version"]) as Any? ?? NSNull(), "status": choice(host["status"], states)],
            "opencode": ["version": version(opencode["version"]) as Any? ?? NSNull(), "status": choice(opencode["status"], states),
                         "management": choice(opencode["management"], management), "canManage": boolean(opencode["canManage"])],
            "hostUpdate": ["status": choice(update["status"], states), "supported": boolean(update["supported"]),
                           "operation": choice(update["operation"], operations), "checkFailed": boolean(update["checkFailed"])]
        ]
        return try JSONSerialization.data(withJSONObject: snapshot, options: [.prettyPrinted, .sortedKeys])
    }
}

/// Native second projection of Web diagnostics' content-free subset. In-memory
/// ring only; no defaults/log-file persistence and no recursive string redactor.
final class NativeEventDiagnostics {
    static let maxEntries = 500, maxBytes = 256 * 1024, maxExportBytes = 512 * 1024
    static let types: Set<String> = [
        "reconnected", "server.connected", "global.disposed", "session.status", "session.idle", "session.error", "session.created", "session.updated", "session.deleted",
        "session.execution.started", "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted",
        "session.step.started", "session.step.finished", "session.tool.started", "session.tool.finished",
        "session.step.failed", "session.text.started", "session.text.ended", "session.reasoning.started", "session.reasoning.ended",
        "session.tool.input.started", "session.tool.input.ended", "session.tool.called", "session.tool.success", "session.tool.failed",
        "session.retry.scheduled", "session.inbox.delivered", "session.inbox.cancelled", "session.instructions.updated", "session.metadata.updated", "session.usage.updated",
        "session.revert.staged", "session.revert.committed", "session.revert.cleared",
        "message.updated", "message.removed", "message.part.updated", "message.part.removed",
        "permission.asked", "permission.replied", "question.asked", "question.replied", "question.rejected", "form.asked", "form.replied", "form.cancelled",
        "yuri:session-status", "yuri:session-index-changed", "yuri:assistants-changed", "yuri:scheduled-tasks-changed",
        "yuri:contact-turn-start", "yuri:contact-turn-end",
        "yuri:project-order-changed", "yuri:worktree-topology-changed"
    ]
    private var ring = [Data?](repeating: nil, count: maxEntries)
    private var head = 0
    private(set) var count = 0, bytes = 0, dropped = 0
    private(set) var enabled = false
    private(set) var lease: String?
    func setEnabled(_ next: Bool) {
        guard enabled != next else { return }
        invalidate(); enabled = next
        lease = next ? UUID().uuidString : nil
    }
    func invalidate() {
        ring = [Data?](repeating: nil, count: Self.maxEntries); head = 0; count = 0; bytes = 0; dropped = 0
        lease = enabled ? UUID().uuidString : nil
    }
    static func project(_ input: Any) throws -> Data {
        guard let row = input as? [String: Any], Set(row.keys) == ["at", "feat", "kind", "sessionID", "source", "sseType", "surfaceKind"],
              row["feat"] as? String == "transcript", row["kind"] as? String == "sse-event", row["source"] as? String == "sse",
              let at = row["at"] as? NSNumber, CFGetTypeID(at) != CFBooleanGetTypeID(), at.doubleValue.isFinite,
              at.doubleValue >= 0, at.doubleValue <= 9_007_199_254_740_991,
              let session = row["sessionID"] as? String, session.range(of: #"^session-(?:0|[1-9][0-9]{0,2})$"#, options: .regularExpression) != nil,
              let type = row["sseType"] as? String, types.contains(type), let channel = row["surfaceKind"] as? String,
              ["global", "chat"].contains(channel) else { throw NSError(domain: "NSHDiagnostics", code: 4) }
        return try JSONSerialization.data(withJSONObject: ["at": at, "feat": "transcript", "kind": "sse-event", "source": "sse", "sessionID": session, "sseType": type, "surfaceKind": channel], options: [.sortedKeys])
    }
    func append(_ input: Any?, lease expected: String, dropped ingressDropped: Int = 0) throws {
        guard enabled, lease == expected, ingressDropped >= 0, ingressDropped <= 1_000_000, let rows = input as? [Any], !rows.isEmpty, rows.count <= 32 else { throw NSError(domain: "NSHDiagnostics", code: 5) }
        // Validate whole batch first, so a bad later row cannot partially commit.
        let data = try rows.map(Self.project)
        dropped = min(dropped + ingressDropped, 9_007_199_254_740_991)
        for item in data {
            while count > 0 && (count == Self.maxEntries || bytes + item.count > Self.maxBytes) {
                bytes -= ring[head]?.count ?? 0; ring[head] = nil; head = (head + 1) % Self.maxEntries; count -= 1; dropped += 1
            }
            guard item.count <= Self.maxBytes else { dropped += 1; continue }
            ring[(head + count) % Self.maxEntries] = item; count += 1; bytes += item.count
        }
    }
    func report(snapshot: Any?, info: [String: Any]) throws -> Data {
        guard enabled else { throw NSError(domain: "NSHDiagnostics", code: 5) }
        let context = try JSONSerialization.jsonObject(with: NativeAboutSnapshot.make(snapshot, info: info))
        let events = try (0..<count).map { index -> Any in
            try JSONSerialization.jsonObject(with: ring[(head + index) % Self.maxEntries]!)
        }
        let report: [String: Any] = ["schema": "yuri.client-diagnostics.v1", "exportedAt": Date().timeIntervalSince1970 * 1000,
            "feats": count > 0 ? ["transcript"] : [], "kind": "nsh-client-diagnostics", "mode": "event-recorder", "eventCount": count,
            "events": events, "dropped": dropped, "context": context,
            "coverage": "runtime-global-and-chat-events-content-free", "maxEntries": Self.maxEntries, "maxBytes": Self.maxBytes]
        let data = try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
        guard data.count <= Self.maxExportBytes else { throw NSError(domain: "NSHDiagnostics", code: 2) }
        return data
    }
}

/// One protected, random export lease. No caller-supplied filenames or directory traversal.
final class NativeDiagnosticsFile {
    let folder: URL
    let url: URL
    init(data: Data, temporaryDirectory: URL = FileManager.default.temporaryDirectory) throws {
        folder = temporaryDirectory.appendingPathComponent("nsh-diagnostics-" + UUID().uuidString, isDirectory: true)
        url = folder.appendingPathComponent("yuri-native-diagnostics.json", isDirectory: false)
        guard data.count <= NativeEventDiagnostics.maxExportBytes else { throw NSError(domain: "NSHDiagnostics", code: 2) }
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
            try data.write(to: url, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
            #if os(iOS)
            try FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: url.path)
            #endif
        } catch {
            try? FileManager.default.removeItem(at: folder)
            throw NSError(domain: "NSHDiagnostics", code: 3)
        }
    }
    func cleanup() throws {
        if FileManager.default.fileExists(atPath: folder.path) { try FileManager.default.removeItem(at: folder) }
    }
    deinit { try? cleanup() }
}

/// The real share owner uses this Foundation lifecycle too, allowing cancellation,
/// scope fences, duplicate completion and cleanup to be tested without UIKit.
final class NativeDiagnosticsShare {
    let id = UUID(), file: NativeDiagnosticsFile
    let eventCount: Int
    private let isCurrent: () -> Bool
    private(set) var finished = false
    init(data: Data, eventCount: Int = 0, temporaryDirectory: URL = FileManager.default.temporaryDirectory, isCurrent: @escaping () -> Bool) throws {
        self.isCurrent = isCurrent; self.eventCount = eventCount
        file = try NativeDiagnosticsFile(data: data, temporaryDirectory: temporaryDirectory)
    }
    func finish(_ outcome: String) -> String? {
        guard !finished else { return nil }; finished = true
        var result = isCurrent() ? outcome : "cancelled"
        do { try file.cleanup() } catch { result = "failed" }
        return result
    }
}

#if canImport(UIKit) && canImport(NativeShell)
import UIKit
import NativeShell

@MainActor struct DiagnosticsScope {
    let hostID: String
    let isCurrent: () -> Bool
}

/// Main registers/retains this bridge and calls invalidate on Host changes and teardown.
@MainActor final class DiagnosticsBridge: NSObject {
    private weak var controller: UIViewController?
    private let capture: () throws -> DiagnosticsScope
    private let defaults: UserDefaults
    // A snapshot-sharing opt-in is NOT consent to runtime event recording.
    private let preference = "nsh.about.eventDiagnostics.enabled.v2"
    private let recorder = NativeEventDiagnostics()
    private var ticket: UUID?
    private var share: NativeDiagnosticsShare?
    private weak var sheet: UIActivityViewController?
    private var completion: CheckedContinuation<Any?, Never>?
    init(app: NshAppView, controller: UIViewController, defaults: UserDefaults = .standard, capture: @escaping () throws -> DiagnosticsScope) {
        self.controller = controller; self.capture = capture; self.defaults = defaults
        super.init()
        recorder.setEnabled(defaults.bool(forKey: preference))
        app.handle("native.clientMetadata") { _ async throws -> Any? in
            NativeAboutSnapshot.metadata(info: Bundle.main.infoDictionary ?? [:])
        }
        app.handle("native.diagnostics.status") { [weak self] _ async throws -> Any? in
            guard let self else { throw CancellationError() }; return self.status()
        }
        app.handle("native.diagnostics.setEnabled") { [weak self] input async throws -> Any? in
            guard let self, let body = input as? [String: Any], Set(body.keys) == ["enabled"],
                  let enabled = body["enabled"] as? NSNumber, CFGetTypeID(enabled) == CFBooleanGetTypeID(), self.ticket == nil else { throw CancellationError() }
            self.defaults.set(enabled.boolValue, forKey: self.preference)
            self.recorder.setEnabled(enabled.boolValue)
            return self.status()
        }
        app.handle("native.diagnostics.append") { [weak self] input async throws -> Any? in
            guard let self, let body = input as? [String: Any], Set(body.keys) == ["hostID", "lease", "events", "dropped"],
                  let lease = body["lease"] as? String, let dropped = body["dropped"] as? NSNumber,
                  CFGetTypeID(dropped) != CFBooleanGetTypeID(), dropped.doubleValue >= 0, dropped.doubleValue <= 1_000_000,
                  dropped.doubleValue == Double(dropped.intValue) else { throw CancellationError() }
            let scope = try self.capture()
            guard body["hostID"] as? String == scope.hostID, scope.isCurrent() else { throw CancellationError() }
            try self.recorder.append(body["events"], lease: lease, dropped: dropped.intValue)
            return ["accepted": true]
        }
        app.handle("native.diagnostics.export") { [weak self] input async throws -> Any? in
            guard let self else { throw CancellationError() }; return await self.export(input)
        }
    }
    private func status() -> [String: Any] {
        ["schemaVersion": 2, "enabled": recorder.enabled, "mode": "event-recorder",
         "recordingLease": recorder.lease as Any? ?? NSNull(), "eventCount": recorder.count,
         "maxEntries": NativeEventDiagnostics.maxEntries, "maxBytes": NativeEventDiagnostics.maxBytes]
    }
    private func export(_ input: Any?) async -> Any? {
        guard ticket == nil, defaults.bool(forKey: preference), let controller,
              controller.viewIfLoaded?.window != nil, controller.presentedViewController == nil,
              let body = input as? [String: Any], Set(body.keys) == ["hostID", "snapshot"] else { return ["outcome": "failed"] }
        do {
            let scope: DiagnosticsScope
            do { scope = try capture() } catch { return ["outcome": "cancelled"] }
            guard !scope.hostID.isEmpty, body["hostID"] as? String == scope.hostID, scope.isCurrent() else { return ["outcome": "cancelled"] }
            let data = try recorder.report(snapshot: body["snapshot"], info: Bundle.main.infoDictionary ?? [:])
            let lease = try NativeDiagnosticsShare(data: data, eventCount: recorder.count, isCurrent: scope.isCurrent)
            guard scope.isCurrent() else { _ = lease.finish("cancelled"); return ["outcome": "cancelled"] }
            let id = lease.id, activity = UIActivityViewController(activityItems: [lease.file.url], applicationActivities: nil)
            ticket = id; share = lease; sheet = activity
            activity.completionWithItemsHandler = { [weak self] _, completed, _, error in
                Task { @MainActor in
                    self?.finish(id: id, outcome: error != nil ? "failed" : !scope.isCurrent() || !completed ? "cancelled" : "shared")
                }
            }
            if let popover = activity.popoverPresentationController {
                popover.sourceView = controller.view
                popover.sourceRect = CGRect(x: controller.view.bounds.midX, y: controller.view.bounds.midY, width: 1, height: 1)
                popover.permittedArrowDirections = []
            }
            return await withCheckedContinuation { continuation in
                completion = continuation
                controller.present(activity, animated: true) { [weak self, weak controller, weak activity] in
                    guard let self else { return }
                    if controller?.presentedViewController !== activity { self.finish(id: id, outcome: "failed") }
                }
            }
        } catch { return ["outcome": "failed"] }
    }
    private func finish(id: UUID, outcome: String) {
        guard ticket == id else { return }
        let continuation = completion, lease = share
        completion = nil; share = nil; ticket = nil; sheet = nil
        let result = lease?.finish(outcome) ?? "failed"
        continuation?.resume(returning: ["outcome": result, "eventCount": lease?.eventCount ?? 0])
    }
    func invalidate() {
        recorder.invalidate()
        let activity = sheet
        if let id = ticket { finish(id: id, outcome: "cancelled") }
        activity?.dismiss(animated: false)
    }
}
#endif
