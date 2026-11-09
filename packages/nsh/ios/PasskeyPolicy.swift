import Foundation

enum PasskeyFailure: String, LocalizedError {
    case invalid = "passkey_invalid_request"
    case locked = "passkey_management_scope_locked"
    case session = "passkey_full_ui_session_required"
    case rp = "passkey_rp_must_match_https_host"
    case associatedDomain = "passkey_associated_domain_required"
    case options = "passkey_options_not_supported"
    case presentation = "passkey_presentation_unavailable"
    case cancelled = "passkey_cancelled"
    case busy = "passkey_ceremony_busy"
    case response = "passkey_invalid_host_response"
    case reset = "passkey_reset_ack_required"
    case cleanup = "passkey_authorization_cleanup_pending"
    case systemVersion = "passkey_registration_requires_ios_17_4"
    var errorDescription: String? { rawValue }
}

struct PasskeySystemFailure: LocalizedError {
    let code: Int
    var errorDescription: String? { "passkey_system_authorization_failed_\(code)" }
}

struct PasskeyManagementLabels {
    let title: String
    let cancel: String
    let submit: String
    let passwordPlaceholder: String
    init(_ input: Any?) throws {
        guard let values = input as? [String: Any], Set(values.keys) == ["title", "cancel", "submit", "passwordPlaceholder"] else { throw PasskeyFailure.invalid }
        func label(_ key: String) throws -> String {
            guard let value = values[key] as? String, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  value.utf8.count <= 512, !value.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { throw PasskeyFailure.invalid }
            return value
        }
        title = try label("title"); cancel = try label("cancel"); submit = try label("submit"); passwordPlaceholder = try label("passwordPlaceholder")
    }
}

/// Shared synchronous presentation reservation. Cancellation invalidates the
/// receipt without freeing it; only the owning operation's defer can drain it.
@MainActor final class PasskeyPresentationAdmission {
    private var owner: UUID?
    private var cancelled = false
    private var closed = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    func requireOpen() throws { guard !closed else { throw PasskeyFailure.cancelled } }
    func reserve() throws -> UUID {
        try requireOpen(); guard owner == nil else { throw PasskeyFailure.busy }
        let id = UUID(); owner = id; cancelled = false; return id
    }
    func isCurrent(_ id: UUID) -> Bool { !closed && !cancelled && owner == id }
    func check(_ id: UUID) throws { try Task.checkCancellation(); guard isCurrent(id) else { throw PasskeyFailure.cancelled } }
    func cancel(_ id: UUID) { if owner == id { cancelled = true } }
    func release(_ id: UUID) {
        guard owner == id else { return }; owner = nil
        let pending = waiters; waiters.removeAll(); pending.forEach { $0.resume() }
    }
    func beginClose() { closed = true }
    func drain() async { if owner != nil { await withCheckedContinuation { waiters.append($0) } } }
}

enum PasskeyWire {
    static func encode(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
    static func decode(_ value: Any?) throws -> Data {
        guard let text = value as? String, !text.isEmpty, text.utf8.count <= 131072,
              text.utf8.allSatisfy({ (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95 }),
              let data = Data(base64Encoded: text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") + String(repeating: "=", count: (4 - text.count % 4) % 4)), encode(data) == text else { throw PasskeyFailure.invalid }
        return data
    }
    static func canonical(_ value: [String: Any]) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) }
    static func management(_ path: String, _ method: String) -> Bool {
        if path == "/auth/passkey/status" { return method == "GET" }
        if ["/auth/passkey/register/options", "/auth/passkey/register/verify", "/api/auth/reset"].contains(path) { return method == "POST" }
        if path == "/api/passkeys" { return method == "GET" }
        if path.hasPrefix("/api/passkeys/"), method == "DELETE" {
            let id = String(path.dropFirst("/api/passkeys/".count))
            return !id.isEmpty && id.utf8.allSatisfy { (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95 }
        }
        return false
    }
}

struct PasskeyRegistrationOptions {
    let rpID: String
    let challenge: Data
    let userID: Data
    let name: String
    let excluded: [Data]
    let verification: String
    init(_ value: [String: Any], origin: URL, associatedDomains: Set<String>) throws {
        guard let rp = value["rp"] as? [String: Any], let rpID = rp["id"] as? String,
              origin.scheme == "https", origin.host?.lowercased() == rpID.lowercased(), !rpID.contains(":"), !rpID.isEmpty else { throw PasskeyFailure.rp }
        guard associatedDomains.contains("webcredentials:" + rpID.lowercased()) else { throw PasskeyFailure.associatedDomain }
        guard let user = value["user"] as? [String: Any], let name = user["name"] as? String, !name.isEmpty,
              let params = value["pubKeyCredParams"] as? [[String: Any]], params.contains(where: { ($0["type"] as? String) == "public-key" && ($0["alg"] as? Int) == -7 }) else { throw PasskeyFailure.options }
        // Platform passkeys are discoverable ES256 credentials. Do not pretend to
        // configure security-key algorithms or extension semantics on this API.
        if let raw = value["authenticatorSelection"], !(raw is [String: Any]) { throw PasskeyFailure.options }
        if let raw = value["extensions"], !(raw is [String: Any]) { throw PasskeyFailure.options }
        let selection = value["authenticatorSelection"] as? [String: Any] ?? [:]
        guard selection["authenticatorAttachment"] == nil || selection["authenticatorAttachment"] as? String == "platform",
              value["attestation"] == nil || value["attestation"] as? String == "none",
              (value["extensions"] as? [String: Any] ?? [:]).isEmpty,
              selection["residentKey"] == nil || ["required", "preferred", "discouraged"].contains(selection["residentKey"] as? String ?? "") else { throw PasskeyFailure.options }
        let verification = selection["userVerification"] as? String ?? "preferred"
        guard ["required", "preferred", "discouraged"].contains(verification) else { throw PasskeyFailure.options }
        let descriptors: [[String: Any]]
        if let raw = value["excludeCredentials"] { guard let list = raw as? [[String: Any]] else { throw PasskeyFailure.invalid }; descriptors = list }
        else { descriptors = [] }
        self.excluded = try descriptors.map { guard $0["type"] as? String == "public-key" else { throw PasskeyFailure.invalid }; return try PasskeyWire.decode($0["id"]) }
        self.rpID = rpID; self.name = name; self.verification = verification
        challenge = try PasskeyWire.decode(value["challenge"]); userID = try PasskeyWire.decode(user["id"])
        guard userID.count <= 64 else { throw PasskeyFailure.invalid }
    }
}

/// Captured native-only transport. No cookie, password or bearer crosses JS.
@MainActor struct PasskeyTransport {
    let origin: URL
    let isCurrent: () -> Bool
    let request: (_ path: String, _ method: String, _ body: [String: Any]?) async throws -> (Int, [String: Any])
    let bind: (_ options: [String: Any], _ ceremony: String) throws -> Void
    let complete: (_ ceremony: String, _ credential: String) throws -> Void
    let cancel: (_ ceremony: String) -> Void
    let reset: () async throws -> Void
    let onRetire: (_ cleanup: @escaping () -> Void) -> Void
}

/// Full UI session owner, independent of the paired-client bearer and the global
/// cookie jar. Its caller supplies an exact captured Host and lifecycle fence.
@MainActor final class PasskeyManagementSession {
    let origin: URL
    private let current: () -> Bool
    private let io: (URLRequest) async throws -> (Int, [String: String], [String: Any])
    private var cookie: String?
    private var pending: (requestID: String, options: Data, ceremony: String?, credential: String?)?
    private(set) var resetAcknowledged = false
    private var resetAttempted = false
    private var retired = false
    private var cleanup: [() -> Void] = []
    private var flights: [UUID: Task<(Int, [String: String], [String: Any]), Error>] = [:]
    init(origin: URL, current: @escaping () -> Bool, io: @escaping (URLRequest) async throws -> (Int, [String: String], [String: Any])) {
        self.origin = origin; self.current = current; self.io = io
    }
    func observeRetirement(_ action: @escaping () -> Void) { if retired { action() } else { cleanup.append(action) } }
    func retire() {
        guard !retired else { return }; retired = true; cookie = nil; pending = nil
        flights.values.forEach { $0.cancel() }; flights.removeAll()
        let actions = cleanup; cleanup.removeAll(); actions.forEach { $0() }
    }
    private func check() throws { try Task.checkCancellation(); guard !retired, current() else { throw CancellationError() } }
    func request(_ path: String, _ method: String, _ body: [String: Any]?) async throws -> (Int, [String: Any]) {
        try check()
        let login = path == "/auth/session" && method == "POST"
        guard login || PasskeyWire.management(path, method) else { throw PasskeyFailure.invalid }
        if path == "/api/auth/reset" {
            guard !resetAttempted else { throw PasskeyFailure.reset }
            resetAttempted = true
        }
        guard origin.scheme == "https" || ["localhost", "127.0.0.1", "::1"].contains(origin.host ?? "") else { throw PasskeyFailure.rp }
        if path == "/auth/passkey/register/verify" {
            guard let proof = pending, let id = proof.credential, proof.ceremony != nil,
                  body?["requestId"] as? String == proof.requestID,
                  let response = body?["response"] as? [String: Any], response["id"] as? String == id, response["rawId"] as? String == id else { throw PasskeyFailure.cancelled }
            pending = nil // One attempt only, including an unknown network result.
        }
        var request = URLRequest(url: URL(string: path, relativeTo: origin)!.absoluteURL)
        request.httpMethod = method; request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let cookie { request.setValue(cookie, forHTTPHeaderField: "Cookie") }
        if let body { request.httpBody = try JSONSerialization.data(withJSONObject: body); request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let ticket = UUID()
        let work = Task { try self.check(); return try await self.io(request) }
        flights[ticket] = work
        defer { flights.removeValue(forKey: ticket) }
        let (status, headers, value) = try await withTaskCancellationHandler(operation: { try await work.value }, onCancel: { work.cancel() })
        try check()
        if value["tunnelLocked"] as? Bool == true || value["scope"] as? String == "tunnel" { cookie = nil; throw PasskeyFailure.locked }
        guard !(300..<400).contains(status) else { throw PasskeyFailure.response }
        if status == 401 { cookie = nil }
        if login && status == 200 {
            guard value["authenticated"] as? Bool == true, value["scope"] as? String != "client",
                  let raw = headers.first(where: { $0.key.lowercased() == "set-cookie" })?.value else { throw PasskeyFailure.session }
            let cookies = HTTPCookie.cookies(withResponseHeaderFields: ["Set-Cookie": raw], for: origin)
            guard let session = cookies.first(where: { $0.name == "yuri_ui_session" && !$0.value.isEmpty && $0.path == "/" && $0.domain.trimmingCharacters(in: CharacterSet(charactersIn: ".")).lowercased() == origin.host?.lowercased() }) else { throw PasskeyFailure.session }
            cookie = session.name + "=" + session.value
        }
        if path == "/auth/passkey/register/options", status == 200 {
            guard let id = value["requestId"] as? String, !id.isEmpty, let options = value["optionsJSON"] as? [String: Any] else { throw PasskeyFailure.response }
            pending = (id, try PasskeyWire.canonical(options), nil, nil)
        }
        if path == "/api/auth/reset", status == 200, value["cleared"] as? Bool == true, value["signedOutEverywhere"] as? Bool == true { resetAcknowledged = true; cookie = nil; pending = nil }
        return (status, value)
    }
    func bind(_ options: [String: Any], ceremony: String) throws {
        try check(); guard var proof = pending, proof.ceremony == nil, proof.options == (try PasskeyWire.canonical(options)) else { throw PasskeyFailure.invalid }
        proof.ceremony = ceremony; pending = proof
    }
    func complete(_ ceremony: String, credential: String) throws {
        try check(); guard var proof = pending, proof.ceremony == ceremony else { throw PasskeyFailure.cancelled }
        proof.credential = credential; pending = proof
    }
    func cancel(_ ceremony: String) { if pending?.ceremony == ceremony { pending = nil } }
}
