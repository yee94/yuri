import Foundation
import CoreFoundation

enum ComposerProbeErrorCode: String, Codable, CaseIterable {
    case runtimeError = "runtime_error", bundleMissing = "bundle_missing", bundleLoadFailed = "bundle_load_failed", exportFailed = "export_failed"
    case ackInputInvalid = "ack_input_invalid", ackRevisionMismatch = "ack_revision_mismatch", jsStatusInvalid = "js_status_invalid"
    case ackAccessDenied = "ack_access_denied", ackHostError = "ack_host_error", ackTimeout = "ack_timeout", ackUnavailable = "ack_unavailable"
    case ackReplyInvalid = "ack_reply_invalid", ackReplyRejected = "ack_reply_rejected", ackUnknown = "ack_unknown", ackConfirmationInvalid = "ack_confirmation_invalid"
}

struct ComposerProbeControlSnapshot: Codable {
    let requestedHostRevision: Int, adoptedHostRevision: Int, jsConfirmedHostRevision: Int
    let nativeHandlerCalls: Int, rejectedHandlerCalls: Int
    let lastRawInputKind: String
    let jsPhase: String
    let errors: [String: Int]
}

/// Only the exact SDK callback payload can advance adopted. JS status never substitutes for that callback.
final class ComposerProbeControl {
    private(set) var requestedHostRevision = 0, adoptedHostRevision = 0, jsConfirmedHostRevision = 0
    private var nativeHandlerCalls = 0, rejectedHandlerCalls = 0
    private var lastRawInputKind = "none", jsPhase = "idle"
    private(set) var errors: [ComposerProbeErrorCode: Int] = [:]
    private func integer(_ value: Any?, zero: Bool = false) -> Int? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        let n = number.doubleValue
        guard n.isFinite, n.rounded(.towardZero) == n, n >= (zero ? 0 : 1), n <= 1_000_000 else { return nil }
        return Int(n)
    }
    func note(_ code: ComposerProbeErrorCode) { errors[code] = min(1_000_000, (errors[code] ?? 0) + 1) }
    func request() -> Int {
        requestedHostRevision = min(1_000_000, requestedHostRevision + 1)
        return requestedHostRevision
    }
    func acknowledge(_ raw: Any?) -> [String: Any] {
        nativeHandlerCalls = min(1_000_000, nativeHandlerCalls + 1)
        lastRawInputKind = raw == nil || raw is NSNull ? "null" : raw is [String: Any] ? "object" : raw is String ? "string" : raw is [Any] ? "array" : "scalar"
        guard let data = raw as? [String: Any], Set(data.keys) == ["revision"], let revision = integer(data["revision"]) else {
            rejectedHandlerCalls = min(1_000_000, rejectedHandlerCalls + 1); note(.ackInputInvalid)
            return ["accepted": false, "revision": 0]
        }
        guard revision == requestedHostRevision else {
            rejectedHandlerCalls = min(1_000_000, rejectedHandlerCalls + 1); note(.ackRevisionMismatch)
            return ["accepted": false, "revision": revision]
        }
        adoptedHostRevision = revision
        return ["accepted": true, "revision": revision]
    }
    func status(_ raw: Any?) -> Bool {
        guard let data = raw as? [String: Any], Set(data.keys) == ["revision", "phase", "code"],
              let revision = integer(data["revision"], zero: true), let phase = data["phase"] as? String,
              ["idle", "pending", "accepted", "failed", "rejected"].contains(phase), let code = data["code"] as? String else { note(.jsStatusInvalid); return false }
        if phase == "idle", revision == 0, code == "none" { return true }
        guard revision > 0, revision <= requestedHostRevision else { note(.jsStatusInvalid); return false }
        guard revision == requestedHostRevision else { return false }
        if phase == "accepted" {
            guard code == "none", adoptedHostRevision == revision else { note(.ackConfirmationInvalid); return false }
            jsConfirmedHostRevision = revision
        } else if phase == "failed" || phase == "rejected" {
            guard let error = ComposerProbeErrorCode(rawValue: code), [.ackAccessDenied, .ackHostError, .ackTimeout, .ackUnavailable, .ackReplyInvalid, .ackReplyRejected, .ackUnknown].contains(error) else { note(.jsStatusInvalid); return false }
            note(error)
        } else if phase != "pending" || code != "none" { note(.jsStatusInvalid); return false }
        jsPhase = phase; return true
    }
    var snapshot: ComposerProbeControlSnapshot {
        .init(requestedHostRevision: requestedHostRevision, adoptedHostRevision: adoptedHostRevision, jsConfirmedHostRevision: jsConfirmedHostRevision,
              nativeHandlerCalls: nativeHandlerCalls, rejectedHandlerCalls: rejectedHandlerCalls, lastRawInputKind: lastRawInputKind, jsPhase: jsPhase,
              errors: Dictionary(uniqueKeysWithValues: errors.map { ($0.key.rawValue, $0.value) }))
    }
}

/// Test-only metadata schema. No text, AX labels, paths, selection, or credentials are accepted.
struct ComposerProbeFacts: Codable {
    let spellCheckingName: String
    let spellCheckingRawValue: Int
    let markedTextPresent: Bool
    let attached: Bool
    let firstResponder: Bool
}

enum ComposerProbeStep: String, Codable, CaseIterable {
    case mounted, readback, focused, typed, blurred, foreground, background
    case hostChanged, hostAcknowledged, ime, editingBegin, editingChange, editingEnd, afterNotification
    static func manual(_ raw: String) -> ComposerProbeStep? {
        guard let value = Self(rawValue: raw), [Self.readback, .focused, .typed, .blurred, .ime].contains(value) else { return nil }
        return value
    }
}

struct ComposerProbeSample: Codable {
    let sequence: Int
    let uptime: Double
    let step: ComposerProbeStep
    let applicationState: String
    let composerGeneration: Int
    let requestedHostRevision: Int
    let adoptedHostRevision: Int
    let registrationAttached: Bool
    let paired: Bool
    let editorToken: Int?
    let facts: ComposerProbeFacts?
}

struct ComposerProbeReport: Codable {
    let schema: Int
    let processRunID: String
    let buildRunID: String
    let samples: [ComposerProbeSample]
    let control: ComposerProbeControlSnapshot
}

/// The fixture retains only weak object tokens and a bounded metadata ring until an explicit export.
final class ComposerProbeLedger<Editor: AnyObject> {
    private final class Identity {
        weak var editor: Editor?
        let token: Int
        init(_ editor: Editor, token: Int) { self.editor = editor; self.token = token }
    }
    let enabled: Bool
    private var identities: [Identity] = []
    private var nextToken = 0, sequence = 0
    private(set) var samples: [ComposerProbeSample] = []
    init(enabled: Bool) { self.enabled = enabled }

    func capture(editor: Editor?, generation: Int, step: ComposerProbeStep, state: String,
                 registrationAttached: Bool, requestedHostRevision: Int, adoptedHostRevision: Int,
                 read: (Editor) -> ComposerProbeFacts) {
        guard enabled else { return }
        identities.removeAll { $0.editor == nil }
        var token: Int?
        if let editor {
            if let known = identities.first(where: { $0.editor === editor }) { token = known.token }
            else { nextToken += 1; token = nextToken; identities.append(Identity(editor, token: nextToken)) }
        }
        sequence += 1
        samples.append(ComposerProbeSample(sequence: sequence, uptime: ProcessInfo.processInfo.systemUptime,
            step: step, applicationState: state, composerGeneration: generation,
            requestedHostRevision: requestedHostRevision, adoptedHostRevision: adoptedHostRevision,
            registrationAttached: registrationAttached, paired: editor != nil, editorToken: token,
            facts: editor.map(read)))
        if samples.count > 128 { samples.removeFirst(samples.count - 128) }
    }
}
