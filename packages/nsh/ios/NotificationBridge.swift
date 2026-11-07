import Foundation
import CoreFoundation

enum NativeNotificationFailure: String, LocalizedError {
    case invalid = "notification_invalid", stale = "notification_stale", denied = "notification_denied", unavailable = "notification_unavailable"
    var errorDescription: String? { rawValue }
}

/// Opaque identifiers only. Neither transport URLs nor credentials are route inputs.
struct NativeNotificationTarget: Equatable {
    let kind: String
    let id: String
    init(_ input: Any?) throws {
        let value = try NativeNotificationPolicy.object(input, keys: ["kind", "id"])
        guard let kind = value["kind"] as? String, ["session", "assistant", "schedule"].contains(kind),
              let id = value["id"] as? String, NativeNotificationPolicy.identifier(id) else { throw NativeNotificationFailure.invalid }
        self.kind = kind; self.id = id
    }
    var value: [String: String] { ["kind": kind, "id": id] }
}

enum NativeNotificationPolicy {
    static let kinds: Set<String> = ["completion", "subtask", "error", "question", "permission", "schedule", "assistant", "goal"]
    static let languages: Set<String> = ["en", "zh-CN", "zh-TW", "ja", "ko", "fr", "es", "pl", "pt-BR", "uk"]
    static func identifier(_ value: String) -> Bool {
        identifier(value, limit: 128)
    }
    static func eventIdentifier(_ value: String) -> Bool {
        identifier(value, limit: 384)
    }
    private static func identifier(_ value: String, limit: Int) -> Bool {
        !value.isEmpty && value.utf8.count <= limit && value.utf8.allSatisfy { (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45 || $0 == 95 }
    }
    static func object(_ input: Any?, keys: Set<String>) throws -> [String: Any] {
        guard let value = input as? [String: Any], Set(value.keys) == keys else { throw NativeNotificationFailure.invalid }
        return value
    }
    static func boolean(_ value: Any?) throws -> Bool {
        guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { throw NativeNotificationFailure.invalid }
        return number.boolValue
    }
    static func positiveInteger(_ value: Any?) throws -> Int {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite,
              number.doubleValue.rounded() == number.doubleValue, number.doubleValue >= 1, number.doubleValue <= 9_007_199_254_740_991 else { throw NativeNotificationFailure.invalid }
        return number.intValue
    }
    static func authorized(_ status: String) -> Bool { ["authorized", "provisional", "ephemeral"].contains(status) }
    static func present(enabled: Bool, active: Bool, test: Bool) -> Bool {
        // Native mobile is stricter than the browser's notificationMode/requireHidden override.
        // A live event can never bypass foreground suppression; an explicit local test may.
        test || (enabled && !active)
    }
    static func receipt(_ input: [AnyHashable: Any]) -> String? {
        guard Set(input.keys) == [AnyHashable("v"), AnyHashable("receipt")],
              let version = input["v"] as? NSNumber, CFGetTypeID(version) != CFBooleanGetTypeID(), version.doubleValue == 1,
              let id = input["receipt"] as? String, UUID(uuidString: id) != nil else { return nil }
        return id
    }
    // Fixed localized copy: never echo Host event text, custom templates, paths or error details to the lock screen.
    static func copy(language: String, test: Bool) -> (String, String) {
        let values: [String: (String, String, String)] = [
            "en": ("Test Notification", "This is a test notification from Yuri.", "Open Yuri to view the update."),
            "zh-CN": ("测试通知", "这是一条来自 Yuri 的测试通知。", "打开 Yuri 查看最新动态。"),
            "zh-TW": ("測試通知", "這是一則來自 Yuri 的測試通知。", "開啟 Yuri 查看最新動態。"),
            "ja": ("テスト通知", "これは Yuri からのテスト通知です。", "Yuri を開いて更新を確認してください。"),
            "ko": ("테스트 알림", "Yuri에서 보낸 테스트 알림입니다.", "Yuri를 열어 새 소식을 확인하세요."),
            "fr": ("Notification de test", "Ceci est une notification de test de Yuri.", "Ouvrez Yuri pour consulter la mise à jour."),
            "es": ("Notificación de prueba", "Esta es una notificación de prueba de Yuri.", "Abre Yuri para ver la actualización."),
            "pl": ("Powiadomienie testowe", "To jest powiadomienie testowe od Yuri.", "Otwórz Yuri, aby zobaczyć aktualizację."),
            "pt-BR": ("Notificação de teste", "Esta é uma notificação de teste do Yuri.", "Abra o Yuri para ver a atualização."),
            "uk": ("Тестове сповіщення", "Це тестове сповіщення від Yuri.", "Відкрийте Yuri, щоб переглянути оновлення.")
        ]
        let value = values[language] ?? values["en"]!
        return test ? (value.0, value.1) : ("Yuri", value.2)
    }
}

struct NativeNotificationConfiguration: Equatable {
    let enabled: Bool
    let events: Set<String>
    let language: String
    init(_ input: Any?, hostID: String) throws {
        let value = try NativeNotificationPolicy.object(input, keys: ["hostID", "enabled", "mode", "events", "language"])
        guard value["hostID"] as? String == hostID, NativeNotificationPolicy.identifier(hostID),
              let mode = value["mode"] as? String, ["always", "hidden-only"].contains(mode),
              let events = value["events"] as? [String], events.count <= NativeNotificationPolicy.kinds.count,
              Set(events).count == events.count, Set(events).isSubset(of: NativeNotificationPolicy.kinds),
              let language = value["language"] as? String, NativeNotificationPolicy.languages.contains(language) else { throw NativeNotificationFailure.invalid }
        enabled = try NativeNotificationPolicy.boolean(value["enabled"])
        self.events = Set(events); self.language = language
    }
}

struct NativeNotificationEvent {
    let eventID: String
    let kind: String
    let target: NativeNotificationTarget?
    let admission: NativeNotificationAdmission?
    init(_ input: Any?, lease: String) throws {
        guard let value = input as? [String: Any], Set(value.keys).isSubset(of: ["lease", "eventID", "kind", "target", "admission"]),
              value["lease"] as? String == lease, !lease.isEmpty,
              let eventID = value["eventID"] as? String, NativeNotificationPolicy.eventIdentifier(eventID),
              let kind = value["kind"] as? String, NativeNotificationPolicy.kinds.contains(kind) else { throw NativeNotificationFailure.invalid }
        self.eventID = eventID; self.kind = kind
        target = try value["target"].map { try NativeNotificationTarget($0) }
        admission = try value["admission"].map { try NativeNotificationAdmission($0) }
        if let admission {
            guard admission.eventID == eventID, admission.kind == kind, admission.target == target else { throw NativeNotificationFailure.invalid }
        }
    }
}

/// Native boundary validation of the existing admission-event.js proof, not a new producer/classifier.
struct NativeNotificationAdmission {
    let eventID: String
    let kind: String
    let target: NativeNotificationTarget
    let value: [String: Any]
    init(_ input: Any?) throws {
        let row = try NativeNotificationPolicy.object(input, keys: ["v", "kind", "eventID", "target", "source"])
        guard let version = row["v"] as? NSNumber, CFGetTypeID(version) != CFBooleanGetTypeID(), version.doubleValue == 1,
              let kind = row["kind"] as? String, let eventID = row["eventID"] as? String else { throw NativeNotificationFailure.invalid }
        let target = try NativeNotificationTarget(row["target"])
        let source: [String: Any], parts: [String]
        func id(_ value: Any?) throws -> String {
            guard let id = value as? String, NativeNotificationPolicy.identifier(id) else { throw NativeNotificationFailure.invalid }; return id
        }
        switch kind {
        case "completion", "subtask", "error", "question", "permission", "goal":
            source = try NativeNotificationPolicy.object(row["source"], keys: ["type", "sessionID", "directory", "parentID", "boundaryID"])
            let session = try id(source["sessionID"]), boundary = try id(source["boundaryID"])
            guard source["type"] as? String == "session", let directory = source["directory"] as? String,
                  !directory.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, directory.utf16.count <= 4096,
                  target.kind == "session", target.id == session else { throw NativeNotificationFailure.invalid }
            if kind == "subtask" { _ = try id(source["parentID"]) }
            else { guard source["parentID"] is NSNull else { throw NativeNotificationFailure.invalid } }
            parts = [session, boundary]
        case "assistant":
            source = try NativeNotificationPolicy.object(row["source"], keys: ["type", "assistantID", "turnID", "status", "publication"])
            let assistant = try id(source["assistantID"]), turn = try id(source["turnID"])
            guard source["type"] as? String == "assistant", ["complete", "error"].contains(source["status"] as? String ?? ""),
                  source["publication"] as? String == "published", target.kind == "assistant", target.id == assistant else { throw NativeNotificationFailure.invalid }
            parts = [assistant, turn]
        case "schedule":
            source = try NativeNotificationPolicy.object(row["source"], keys: ["type", "projectID", "taskID", "runID", "trigger", "resultOwner", "status"])
            let project = try id(source["projectID"]), task = try id(source["taskID"]), run = try id(source["runID"])
            guard source["type"] as? String == "schedule", source["trigger"] as? String == "scheduled", source["resultOwner"] as? String == "unowned",
                  ["success", "error"].contains(source["status"] as? String ?? ""), target.kind == "schedule", target.id == task else { throw NativeNotificationFailure.invalid }
            parts = [project, task, run]
        default: throw NativeNotificationFailure.invalid
        }
        let expected = (["admitted", kind] + parts.map { "\($0.utf8.count)_\($0)" }).joined(separator: "_")
        guard NativeNotificationPolicy.eventIdentifier(expected), expected == eventID else { throw NativeNotificationFailure.invalid }
        self.eventID = eventID; self.kind = kind; self.target = target
        value = ["v": 1, "kind": kind, "eventID": eventID, "target": target.value, "source": source]
    }
}

/// Durable, app-private route receipts. No notification text, URLs, transport leases or credentials.
/// A tap is committed before the OS completion handler returns; a missing JS Host is not rejection.
final class NativeNotificationLaunchInbox {
    static let prefix = "yuri.nsh.local."
    struct Retirement: Equatable {
        let connectionID: String
        let authorizationID: String
        let receipt: String
        var value: [String: String] { ["connectionID": connectionID, "authorizationID": authorizationID, "receipt": receipt] }
    }
    struct RetirementBatch {
        let connectionID: String
        let authorizationID: String
        let receipts: [String]
        var identifiers: [String] { receipts.map { NativeNotificationLaunchInbox.prefix + $0 } }
    }
    struct Record {
        let receipt: String
        let revision: Int
        let connectionID: String
        let authorizationID: String
        let admission: NativeNotificationAdmission
        let createdAt: Double
        let expiresAt: Double
        var target: NativeNotificationTarget { admission.target }
        var value: [String: Any] { ["v": 1, "receipt": receipt, "revision": revision, "connectionID": connectionID, "authorizationID": authorizationID, "admission": admission.value, "createdAt": createdAt, "expiresAt": expiresAt] }
        func unexpired(_ now: Double) -> Bool { now.isFinite && createdAt <= now && expiresAt > now }
    }
    private let file: URL
    private(set) var records: [Record] = []
    private(set) var queuedReceipt: String?
    private(set) var pendingRetirements: [Retirement] = []
    var pending: Record? { records.first(where: { $0.receipt == queuedReceipt }) }
    init(file: URL) throws {
        self.file = file
        guard FileManager.default.fileExists(atPath: file.path) else { return }
        let data = try Data(contentsOf: file)
        guard data.count <= 8 * 1024 * 1024 else { throw NativeNotificationFailure.invalid }
        guard let decoded = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw NativeNotificationFailure.invalid }
        let root = try NativeNotificationPolicy.object(decoded, keys: decoded.keys.contains("pendingRetirements")
            ? ["v", "records", "queuedReceipt", "pendingRetirements"] : ["v", "records", "queuedReceipt"])
        guard let version = root["v"] as? NSNumber, CFGetTypeID(version) != CFBooleanGetTypeID(), version.doubleValue == 1,
              let rows = root["records"] as? [[String: Any]], rows.count <= 256 else { throw NativeNotificationFailure.invalid }
        var seen: Set<String> = []
        records = try rows.map { row in
            let value = try NativeNotificationPolicy.object(row, keys: ["v", "receipt", "revision", "connectionID", "authorizationID", "admission", "createdAt", "expiresAt"])
            guard let version = value["v"] as? NSNumber, CFGetTypeID(version) != CFBooleanGetTypeID(), version.doubleValue == 1,
                  let receipt = value["receipt"] as? String, UUID(uuidString: receipt) != nil, seen.insert(receipt).inserted,
                  let hostID = value["connectionID"] as? String, NativeNotificationPolicy.identifier(hostID),
                  let authorizationID = value["authorizationID"] as? String, NativeNotificationPolicy.identifier(authorizationID), authorizationID != "legacy",
                  let createdAt = value["createdAt"] as? NSNumber, CFGetTypeID(createdAt) != CFBooleanGetTypeID(), createdAt.doubleValue.isFinite, createdAt.doubleValue >= 0,
                  let expiresAt = value["expiresAt"] as? NSNumber, CFGetTypeID(expiresAt) != CFBooleanGetTypeID(), expiresAt.doubleValue.isFinite,
                  expiresAt.doubleValue > createdAt.doubleValue, expiresAt.doubleValue - createdAt.doubleValue <= 7 * 24 * 60 * 60 * 1000 else { throw NativeNotificationFailure.invalid }
            return Record(receipt: receipt, revision: try NativeNotificationPolicy.positiveInteger(value["revision"]), connectionID: hostID, authorizationID: authorizationID, admission: try NativeNotificationAdmission(value["admission"]), createdAt: createdAt.doubleValue, expiresAt: expiresAt.doubleValue)
        }
        if let queued = root["queuedReceipt"] as? String {
            guard records.contains(where: { $0.receipt == queued }) else { throw NativeNotificationFailure.invalid }; queuedReceipt = queued
        } else { guard root["queuedReceipt"] is NSNull else { throw NativeNotificationFailure.invalid } }
        if root.keys.contains("pendingRetirements") {
            guard let retired = root["pendingRetirements"] as? [[String: Any]], retired.count + records.count <= 256 else { throw NativeNotificationFailure.invalid }
            pendingRetirements = try retired.map { row in
                let value = try NativeNotificationPolicy.object(row, keys: ["connectionID", "authorizationID", "receipt"])
                guard let connectionID = value["connectionID"] as? String, NativeNotificationPolicy.identifier(connectionID),
                      let authorizationID = value["authorizationID"] as? String, NativeNotificationPolicy.identifier(authorizationID), authorizationID != "legacy",
                      let receipt = value["receipt"] as? String, UUID(uuidString: receipt) != nil, seen.insert(receipt).inserted else { throw NativeNotificationFailure.invalid }
                return Retirement(connectionID: connectionID, authorizationID: authorizationID, receipt: receipt)
            }
        }
    }
    private func commit(_ next: [Record], queued: String?, retirements: [Retirement]? = nil) throws {
        let retired = retirements ?? pendingRetirements
        guard next.count + retired.count <= 256 else { throw NativeNotificationFailure.unavailable }
        let data = try JSONSerialization.data(withJSONObject: ["v": 1, "records": next.map(\.value), "queuedReceipt": queued as Any? ?? NSNull(), "pendingRetirements": retired.map(\.value)], options: [.sortedKeys])
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        #if os(iOS)
        try data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        #else
        try data.write(to: file, options: .atomic)
        #endif
        records = next; queuedReceipt = queued // Failed persistence must not become an acknowledged/consumed tap.
        pendingRetirements = retired
    }
    func record(receipt: String, hostID: String, authorizationID: String, admission: NativeNotificationAdmission, now: Double = Date().timeIntervalSince1970 * 1000) throws {
        guard UUID(uuidString: receipt) != nil, NativeNotificationPolicy.identifier(hostID), NativeNotificationPolicy.identifier(authorizationID), authorizationID != "legacy", now.isFinite, now >= 0,
              !records.contains(where: { $0.receipt == receipt }), !pendingRetirements.contains(where: { $0.receipt == receipt
                || $0.connectionID == hostID && $0.authorizationID == authorizationID }) else { throw NativeNotificationFailure.invalid }
        var next = records
        if next.count + pendingRetirements.count == 256 {
            guard let index = next.firstIndex(where: { $0.receipt != queuedReceipt }) else { throw NativeNotificationFailure.unavailable }
            next.remove(at: index)
        }
        next.append(Record(receipt: receipt, revision: 1, connectionID: hostID, authorizationID: authorizationID, admission: admission, createdAt: now, expiresAt: now + 7 * 24 * 60 * 60 * 1000))
        try commit(next, queued: queuedReceipt)
    }
    @discardableResult func receive(action: String, identifier: String, payload: [AnyHashable: Any]) throws -> Bool {
        guard action == "default", let receipt = NativeNotificationPolicy.receipt(payload), identifier == Self.prefix + receipt,
              records.contains(where: { $0.receipt == receipt }) else { return false }
        if queuedReceipt == receipt { return true } // Scene connection and delegate response can describe the same tap.
        try commit(records, queued: receipt); return true
    }
    func remove(_ receipt: String, includingQueued: Bool = false) throws {
        if queuedReceipt == receipt && !includingQueued { return }
        try commit(records.filter { $0.receipt != receipt }, queued: queuedReceipt == receipt ? nil : queuedReceipt)
    }
    func claim(receipt: String, hostID: String, authorizationID: String?, now: Double = Date().timeIntervalSince1970 * 1000) throws -> Record {
        guard let pending, pending.receipt == receipt, pending.connectionID == hostID, pending.authorizationID == authorizationID,
              pending.unexpired(now) else { throw NativeNotificationFailure.stale }
        return pending
    }
    func consume(receipt: String, expectedRevision: Int, hostID: String, authorizationID: String?) throws {
        let record = try claim(receipt: receipt, hostID: hostID, authorizationID: authorizationID)
        guard record.revision == expectedRevision else { throw NativeNotificationFailure.stale }
        try remove(receipt, includingQueued: true)
    }
    /// Only explicit authorization revocation calls this; transient transport generations never do.
    func retireAuthorization(connectionID: String, authorizationID: String) throws -> [String] {
        let newlyRetired = records.filter { $0.connectionID == connectionID && $0.authorizationID == authorizationID }.map(\.receipt)
        _ = try beginRetirement(connectionID: connectionID, authorizationID: authorizationID)
        return newlyRetired
    }
    func beginRetirement(connectionID: String, authorizationID: String) throws -> RetirementBatch {
        guard NativeNotificationPolicy.identifier(connectionID), NativeNotificationPolicy.identifier(authorizationID), authorizationID != "legacy" else { throw NativeNotificationFailure.invalid }
        let removed = records.filter { $0.connectionID == connectionID && $0.authorizationID == authorizationID }
        if !removed.isEmpty {
            let receipts = Set(removed.map(\.receipt))
            let next = pendingRetirements + removed.map { Retirement(connectionID: connectionID, authorizationID: authorizationID, receipt: $0.receipt) }
            try commit(records.filter { !receipts.contains($0.receipt) }, queued: receipts.contains(queuedReceipt ?? "") ? nil : queuedReceipt, retirements: next)
        }
        return RetirementBatch(connectionID: connectionID, authorizationID: authorizationID,
            receipts: pendingRetirements.filter { $0.connectionID == connectionID && $0.authorizationID == authorizationID }.map(\.receipt))
    }
    func acknowledgeRetirement(_ batch: RetirementBatch) throws {
        guard NativeNotificationPolicy.identifier(batch.connectionID), NativeNotificationPolicy.identifier(batch.authorizationID), batch.authorizationID != "legacy",
              Set(batch.receipts).count == batch.receipts.count, batch.receipts.allSatisfy({ UUID(uuidString: $0) != nil }) else { throw NativeNotificationFailure.invalid }
        let receipts = Set(batch.receipts)
        let next = pendingRetirements.filter { !($0.connectionID == batch.connectionID && $0.authorizationID == batch.authorizationID && receipts.contains($0.receipt)) }
        if next.count != pendingRetirements.count { try commit(records, queued: queuedReceipt, retirements: next) }
    }
}

/// One bounded cleanup attempt. A void OS remove call is never its completion evidence.
@MainActor enum NativeNotificationRetirementCleanup {
    static func run(inbox: NativeNotificationLaunchInbox, connectionID: String, authorizationID: String,
                    settleAdds: ([String]) async -> Void = { _ in },
                    remove: ([String]) -> Void, pending: () async throws -> [String], delivered: () async throws -> [String]) async throws {
        let batch = try inbox.beginRetirement(connectionID: connectionID, authorizationID: authorizationID)
        if batch.receipts.isEmpty { return }
        await settleAdds(batch.receipts)
        try Task.checkCancellation()
        remove(batch.identifiers)
        let targets = Set(batch.identifiers)
        let pendingIDs = try await pending()
        let deliveredIDs = try await delivered()
        guard targets.isDisjoint(with: pendingIDs), targets.isDisjoint(with: deliveredIDs) else { throw NativeNotificationFailure.unavailable }
        try Task.checkCancellation()
        try inbox.acknowledgeRetirement(batch)
    }
}

/// The actual add/late-result cleanup lane, injected for Foundation-only synthetic OS tests.
@MainActor enum NativeNotificationLaunchDelivery {
    static func submit(inbox: NativeNotificationLaunchInbox?, receipt: String, current: () -> Bool,
                       add: () async throws -> Void, removeOS: () -> Void) async throws {
        func discard() { try? inbox?.remove(receipt, includingQueued: true); removeOS() }
        guard current() else { discard(); throw NativeNotificationFailure.stale }
        do { try await add() }
        catch { discard(); throw NativeNotificationFailure.unavailable }
        guard current() else { discard(); throw NativeNotificationFailure.stale }
    }
}

#if canImport(UIKit) && canImport(NativeShell)
import UIKit
import UserNotifications
import NativeShell

/// Install in didFinishLaunching, before creating the root view or loading JS.
/// Scene notificationResponse and UN delegate callbacks share exactly this durable ingress.
@MainActor final class NotificationLaunchDelegate: NSObject, @preconcurrency UNUserNotificationCenterDelegate {
    static let shared = NotificationLaunchDelegate()
    private(set) var inbox: NativeNotificationLaunchInbox?
    private let file: URL?
    private var pendingReceipt: String?
    var changed: (() -> Void)?
    var presentation: ((UNNotification) -> UNNotificationPresentationOptions)?
    private(set) var failure = false
    override init() {
        file = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?.appendingPathComponent("notification-launch/receipts.json")
        super.init()
    }
    @discardableResult func refreshInbox() -> NativeNotificationLaunchInbox? {
        do {
            if inbox == nil {
                guard let file else { throw NativeNotificationFailure.unavailable }
                inbox = try NativeNotificationLaunchInbox(file: file)
            }
            if let receipt = pendingReceipt, let inbox {
                _ = try inbox.receive(action: "default", identifier: NativeNotificationLaunchInbox.prefix + receipt, payload: ["v": 1, "receipt": receipt])
                pendingReceipt = nil
            }
            failure = false; return inbox
        } catch { failure = true; return nil }
    }
    func install() { UNUserNotificationCenter.current().delegate = self; refreshInbox() }
    @discardableResult func receive(_ response: UNNotificationResponse) -> Bool {
        guard response.actionIdentifier == UNNotificationDefaultActionIdentifier,
              let receipt = NativeNotificationPolicy.receipt(response.notification.request.content.userInfo),
              response.notification.request.identifier == NativeNotificationLaunchInbox.prefix + receipt else { return false }
        pendingReceipt = receipt // Retain newest valid OS click while protected storage is locked/unreadable.
        let accepted = refreshInbox()?.pending?.receipt == receipt
        changed?(); return accepted
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler(presentation?(notification) ?? [])
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        defer { completionHandler() }; receive(response)
    }
}

@MainActor struct NotificationHostScope {
    let hostID: String
    /// Captures RuntimeBridge's native transport generation, not a JS-provided generation.
    let isCurrent: () -> Bool
    /// Durable authorization generation from the native connection owner. Re-pair/origin/credential changes rotate it.
    /// nil keeps cold navigation unavailable; editorVersion/Host ID are NOT substitutes.
    var authorizationID: String? = nil
}

/// Uses the early app-wide launch delegate. Does not register for remote notifications or run background networking.
@MainActor final class NotificationBridge: NSObject {
    private struct Entry {
        let scope: NotificationHostScope
        let revision: Int
        let target: NativeNotificationTarget?
        let configuration: NativeNotificationConfiguration?
        let test: Bool
        let admission: NativeNotificationAdmission?
    }
    private static let prefix = NativeNotificationLaunchInbox.prefix
    private let center = UNUserNotificationCenter.current()
    private weak var app: NshAppView?
    private let capture: () throws -> NotificationHostScope
    private var scope: NotificationHostScope?
    private var configuration: NativeNotificationConfiguration?
    private var lease = ""
    private var claims: [String: (revision: Int, lease: String)] = [:]
    private var revision = 0
    private var entries: [String: Entry] = [:]
    private var order: [String] = []
    private var seen: Set<String> = []
    private var seenOrder: [String] = []
    private var pendingAdds: [String: Task<Void, Error>] = [:]
    private let launch = NotificationLaunchDelegate.shared
    private var observers: [NSObjectProtocol] = []

    // Old main's route argument remains source-compatible; only the queued receipt consumer may navigate.
    init(app: NshAppView?, capture: @escaping () throws -> NotificationHostScope, route _: @escaping (String, String, NativeNotificationTarget) -> Void = { _, _, _ in }) {
        self.capture = capture; self.app = app
        super.init()
        launch.install()
        launch.presentation = { [weak self] notification in self?.presentation(notification) ?? [] }
        launch.changed = { [weak app] in app?.send("notification.launch.available", [:]) }
        app?.handle("notification.launch.peek") { [weak self] input async throws -> Any? in
            _ = try NativeNotificationPolicy.object(input, keys: [])
            guard let self, let inbox = self.launch.refreshInbox() else { throw NativeNotificationFailure.unavailable }
            return ["record": inbox.pending.map { $0.value as Any } ?? NSNull()]
        }
        app?.handle("notification.launch.claim") { [weak self] input async throws -> Any? in
            guard let self else { throw CancellationError() }; return try self.claimLaunch(input)
        }
        app?.handle("notification.launch.ack") { [weak self] input async throws -> Any? in
            guard let self else { throw CancellationError() }; try self.acknowledgeLaunch(input); return ["ok": true]
        }
        app?.handle("notification.status") { [weak self] input async throws -> Any? in
            _ = try NativeNotificationPolicy.object(input, keys: [])
            guard let self else { throw CancellationError() }; return await self.status()
        }
        app?.handle("notification.request") { [weak self] input async throws -> Any? in
            _ = try NativeNotificationPolicy.object(input, keys: [])
            guard let self else { throw CancellationError() }; return try await self.requestPermission()
        }
        app?.handle("notification.openSettings") { [weak self] input async throws -> Any? in
            _ = try NativeNotificationPolicy.object(input, keys: [])
            guard let self else { throw CancellationError() }; try await self.openSettings(); return nil
        }
        app?.handle("notification.configure") { [weak self] input async throws -> Any? in
            guard let self else { throw CancellationError() }; return try self.configure(input)
        }
        app?.handle("notification.live") { [weak self] input async throws -> Any? in
            guard let self else { throw CancellationError() }; return try await self.live(input)
        }
        app?.handle("notification.test") { [weak self] input async throws -> Any? in
            guard let self else { throw CancellationError() }; return try await self.test(input)
        }
        observers.append(NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in guard let self else { return }; self.app?.send("notification.status", await self.status()) }
        })
    }
    deinit { for observer in observers { NotificationCenter.default.removeObserver(observer) } }

    /// MUST be called synchronously from RuntimeBridge.onInvalidate (Host switch, remove, reconnect fence).
    func invalidate() {
        revision += 1; scope = nil; configuration = nil; lease = ""; claims.removeAll(); seen.removeAll(); seenOrder.removeAll()
        let identifiers = order.filter { entries[$0]?.target == nil }.map { Self.prefix + $0 }
        // Retain valid protected records and their OS notifications across ordinary transport generations.
        entries.removeAll(); order.removeAll()
        center.removePendingNotificationRequests(withIdentifiers: identifiers)
        center.removeDeliveredNotifications(withIdentifiers: identifiers)
    }
    func retireAuthorization(connectionID: String, authorizationID: String) async throws {
        guard NativeNotificationPolicy.identifier(connectionID), NativeNotificationPolicy.identifier(authorizationID), authorizationID != "legacy",
              let inbox = launch.refreshInbox() else { throw NativeNotificationFailure.unavailable }
        let batch = try inbox.beginRetirement(connectionID: connectionID, authorizationID: authorizationID)
        let retiredReceipts = Set(batch.receipts)
        for receipt in batch.receipts { entries.removeValue(forKey: receipt); claims.removeValue(forKey: receipt) }
        order.removeAll { retiredReceipts.contains($0) }
        if scope?.hostID == connectionID && scope?.authorizationID == authorizationID { invalidate() }
        // An accepted add must settle before absence read-back, or it could arrive after cleanup ACK.
        try await NativeNotificationRetirementCleanup.run(inbox: inbox, connectionID: connectionID, authorizationID: authorizationID, settleAdds: { receipts in
            let adds = receipts.compactMap { self.pendingAdds[$0] }
            for add in adds { _ = await add.result }
        }, remove: { identifiers in
            self.center.removePendingNotificationRequests(withIdentifiers: identifiers)
            self.center.removeDeliveredNotifications(withIdentifiers: identifiers)
        }, pending: {
            await self.center.pendingNotificationRequests().map(\.identifier)
        }, delivered: {
            await self.center.deliveredNotifications().map { $0.request.identifier }
        })
    }
    private func claimLaunch(_ input: Any?) throws -> [String: Any] {
        let value = try NativeNotificationPolicy.object(input, keys: ["connectionID", "receipt"])
        let pending = try launchRecord(value)
        claims = [pending.receipt: (pending.revision, lease)]
        return ["record": pending.value, "route": ["hostID": pending.connectionID, "lease": lease, "target": pending.target.value]]
    }
    private func launchRecord(_ value: [String: Any]) throws -> NativeNotificationLaunchInbox.Record {
        guard UIApplication.shared.applicationState == .active, let scope, scope.isCurrent(), !lease.isEmpty, let receipt = value["receipt"] as? String,
              value["connectionID"] as? String == scope.hostID, let inbox = launch.refreshInbox() else { throw NativeNotificationFailure.stale }
        let captured = try capture()
        guard captured.isCurrent(), captured.hostID == scope.hostID, captured.authorizationID == scope.authorizationID else { throw NativeNotificationFailure.stale }
        return try inbox.claim(receipt: receipt, hostID: scope.hostID, authorizationID: scope.authorizationID)
    }
    private func acknowledgeLaunch(_ input: Any?) throws {
        let value = try NativeNotificationPolicy.object(input, keys: ["connectionID", "receipt", "lease", "expectedRevision"])
        guard value["lease"] as? String == lease, !lease.isEmpty else { throw NativeNotificationFailure.stale }
        let record = try launchRecord(["connectionID": value["connectionID"] as Any, "receipt": value["receipt"] as Any])
        let expected = try NativeNotificationPolicy.positiveInteger(value["expectedRevision"])
        guard let claimed = claims[record.receipt], claimed.revision == expected, claimed.lease == lease else { throw NativeNotificationFailure.stale }
        guard let inbox = launch.inbox, let scope, let receipt = value["receipt"] as? String else { throw NativeNotificationFailure.invalid }
        try inbox.consume(receipt: receipt, expectedRevision: expected, hostID: scope.hostID, authorizationID: scope.authorizationID)
        claims.removeValue(forKey: receipt)
        entries.removeValue(forKey: receipt); order.removeAll { $0 == receipt }
        center.removeDeliveredNotifications(withIdentifiers: [Self.prefix + receipt])
    }
    private func authorization(_ value: UNAuthorizationStatus) -> String {
        switch value {
        case .notDetermined: return "notDetermined"
        case .denied: return "denied"
        case .authorized: return "authorized"
        case .provisional: return "provisional"
        case .ephemeral: return "ephemeral"
        @unknown default: return "unknown"
        }
    }
    private func setting(_ value: UNNotificationSetting) -> String {
        switch value { case .enabled: return "enabled"; case .disabled: return "disabled"; case .notSupported: return "unsupported"; @unknown default: return "unknown" }
    }
    func status() async -> [String: Any] {
        let value = await center.notificationSettings()
        return ["authorization": authorization(value.authorizationStatus), "alert": setting(value.alertSetting),
                "sound": setting(value.soundSetting), "badge": setting(value.badgeSetting), "backgroundPush": false]
    }
    func requestPermission() async throws -> [String: Any] {
        guard UIApplication.shared.applicationState == .active else { throw NativeNotificationFailure.unavailable }
        if await center.notificationSettings().authorizationStatus == .notDetermined {
            _ = try await center.requestAuthorization(options: [.alert, .sound])
        }
        return await status()
    }
    func openSettings() async throws {
        guard UIApplication.shared.applicationState == .active else { throw NativeNotificationFailure.unavailable }
        let value: String
        if #available(iOS 16.0, *) { value = UIApplication.openNotificationSettingsURLString }
        else { value = UIApplication.openSettingsURLString }
        guard let url = URL(string: value), await UIApplication.shared.open(url) else { throw NativeNotificationFailure.unavailable }
    }
    func configure(_ input: Any?) throws -> [String: String] {
        let captured = try capture()
        guard captured.isCurrent() else { throw NativeNotificationFailure.stale }
        let next = try NativeNotificationConfiguration(input, hostID: captured.hostID)
        if let scope, scope.hostID == captured.hostID, scope.isCurrent(), configuration == next, !lease.isEmpty,
           scope.authorizationID == captured.authorizationID { return ["lease": lease] }
        invalidate(); scope = captured; configuration = next; lease = UUID().uuidString
        return ["lease": lease]
    }
    private func current(_ entry: Entry) -> Bool {
        guard entry.revision == revision && entry.scope.isCurrent(), let selected = try? capture() else { return false }
        return selected.isCurrent() && selected.hostID == entry.scope.hostID && selected.authorizationID == entry.scope.authorizationID
    }
    private func shouldPresent(_ entry: Entry) -> Bool {
        current(entry) && NativeNotificationPolicy.present(enabled: entry.configuration?.enabled ?? false,
            active: UIApplication.shared.applicationState == .active, test: entry.test)
    }
    func live(_ input: Any?) async throws -> [String: String] {
        guard let scope, let configuration, scope.isCurrent() else { throw NativeNotificationFailure.stale }
        let event = try NativeNotificationEvent(input, lease: lease)
        guard event.admission != nil, event.target != nil else { throw NativeNotificationFailure.invalid }
        let entry = Entry(scope: scope, revision: revision, target: event.target, configuration: configuration, test: false, admission: event.admission)
        guard !seen.contains(event.eventID) else { return ["result": "duplicate"] }
        seen.insert(event.eventID); seenOrder.append(event.eventID)
        if seenOrder.count > 256 { seen.remove(seenOrder.removeFirst()) }
        guard configuration.events.contains(event.kind), shouldPresent(entry) else { return ["result": "suppressed"] }
        do { return try await schedule(entry, language: configuration.language) }
        catch { if current(entry) { seen.remove(event.eventID); seenOrder.removeAll { $0 == event.eventID } }; throw error }
    }
    func test(_ input: Any?) async throws -> [String: String] {
        let value = try NativeNotificationPolicy.object(input, keys: ["hostID", "language"])
        let captured = try capture()
        guard value["hostID"] as? String == captured.hostID, NativeNotificationPolicy.identifier(captured.hostID), captured.isCurrent(),
              UIApplication.shared.applicationState == .active, let language = value["language"] as? String,
              NativeNotificationPolicy.languages.contains(language) else { throw NativeNotificationFailure.invalid }
        return try await schedule(Entry(scope: captured, revision: revision, target: nil, configuration: nil, test: true, admission: nil), language: language)
    }
    private func schedule(_ entry: Entry, language: String) async throws -> [String: String] {
        let settings = await center.notificationSettings()
        guard current(entry) else { throw NativeNotificationFailure.stale }
        guard NativeNotificationPolicy.authorized(authorization(settings.authorizationStatus)) else { throw NativeNotificationFailure.denied }
        guard shouldPresent(entry) else { return ["result": "suppressed"] }
        guard pendingAdds.count < 256 else { throw NativeNotificationFailure.unavailable }
        let receipt = UUID().uuidString, identifier = Self.prefix + receipt
        let content = UNMutableNotificationContent(), copy = NativeNotificationPolicy.copy(language: language, test: entry.test)
        content.title = copy.0; content.body = copy.1; content.sound = .default
        content.userInfo = ["v": 1, "receipt": receipt]
        if entry.target != nil {
            guard let inbox = launch.refreshInbox(), let authorizationID = entry.scope.authorizationID, let admission = entry.admission else { throw NativeNotificationFailure.unavailable }
            try inbox.record(receipt: receipt, hostID: entry.scope.hostID, authorizationID: authorizationID, admission: admission)
        }
        entries[receipt] = entry; order.append(receipt)
        if order.count > 256 { let old = order.removeFirst(); entries.removeValue(forKey: old); center.removePendingNotificationRequests(withIdentifiers: [Self.prefix + old]); center.removeDeliveredNotifications(withIdentifiers: [Self.prefix + old]) }
        do {
            let add = Task { @MainActor in try await self.center.add(UNNotificationRequest(identifier: identifier, content: content, trigger: nil)) }
            pendingAdds[receipt] = add
            defer { pendingAdds.removeValue(forKey: receipt) }
            try await NativeNotificationLaunchDelivery.submit(inbox: launch.inbox, receipt: receipt, current: { self.current(entry) }, add: {
                try await add.value
            }, removeOS: {
                self.center.removePendingNotificationRequests(withIdentifiers: [identifier]); self.center.removeDeliveredNotifications(withIdentifiers: [identifier])
            })
        } catch {
            entries.removeValue(forKey: receipt); order.removeAll { $0 == receipt }; throw error
        }
        return ["result": "scheduled"] // OS acceptance, never a claim that the banner was seen.
    }
    private func presentation(_ notification: UNNotification) -> UNNotificationPresentationOptions {
        guard let receipt = NativeNotificationPolicy.receipt(notification.request.content.userInfo), notification.request.identifier == Self.prefix + receipt,
               let entry = entries[receipt], shouldPresent(entry) else { return [] }
        return [.banner, .list, .sound]
    }
}
#endif
