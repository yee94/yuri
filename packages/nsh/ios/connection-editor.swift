import Foundation

enum ConnectionEditorFailure: String, LocalizedError {
    case invalid = "connection_editor_invalid"
    case missing = "connection_editor_missing"
    case stale = "connection_editor_stale"
    case pairingRequired = "connection_editor_pairing_required"
    case duplicate = "connection_editor_duplicate"
    case storage = "connection_editor_storage"
    var errorDescription: String? { rawValue }
}

/// Only metadata travels to JS. Tokens and Relay identities never round-trip through a form.
struct ConnectionEditorInput {
    let id: String
    let version: String
    let label: String
    let url: String?
    init(_ input: Any?, rename: Bool = false) throws {
        guard let args = input as? [String: Any],
              Set(args.keys).isSubset(of: rename ? ["id", "version", "label"] : ["id", "version", "label", "url"]),
              let id = args["id"] as? String, !id.isEmpty,
              let version = args["version"] as? String, !version.isEmpty,
              let rawLabel = args["label"] as? String else { throw ConnectionEditorFailure.invalid }
        let label = rawLabel.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !label.isEmpty, label.utf16.count <= 120,
              !label.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              args["url"] == nil || args["url"] is String else { throw ConnectionEditorFailure.invalid }
        self.id = id; self.version = version; self.label = label; self.url = args["url"] as? String
    }
}

enum AuthorizationRetirementFailure: String, LocalizedError {
    case invalid = "authorization_retirement_invalid"
    case capacity = "authorization_retirement_capacity"
    var errorDescription: String? { rawValue }
}

/// Durable revocation identity only. No credential, endpoint or clock-derived identity.
struct AuthorizationRetirement: Codable, Hashable {
    let connectionID: String
    let authorizationID: String
    init(connectionID: String, authorizationID: String) throws {
        func identifier(_ value: String) -> Bool {
            !value.isEmpty && value.utf8.count <= 128 && value.utf8.allSatisfy {
                (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45 || $0 == 95
            }
        }
        guard identifier(connectionID), identifier(authorizationID), authorizationID != "legacy" else { throw AuthorizationRetirementFailure.invalid }
        self.connectionID = connectionID; self.authorizationID = authorizationID
    }
    init(from decoder: Decoder) throws {
        let fields = try [String: String](from: decoder)
        guard Set(fields.keys) == ["connectionID", "authorizationID"], let id = fields["connectionID"], let authorization = fields["authorizationID"] else { throw AuthorizationRetirementFailure.invalid }
        try self.init(connectionID: id, authorizationID: authorization)
    }
}

struct ConnectionEditorRecords: Codable {
    var connections: [SavedConnection] = []
    var selected: String?
    private(set) var pendingAuthorizationRetirements: [AuthorizationRetirement] = []
    static let retirementLimit = 1024
    private enum CodingKeys: String, CodingKey { case connections, selected, pendingAuthorizationRetirements }
    init(connections: [SavedConnection] = [], selected: String? = nil) {
        self.connections = connections; self.selected = selected
    }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        connections = try values.decode([SavedConnection].self, forKey: .connections)
        selected = try values.decodeIfPresent(String.self, forKey: .selected)
        pendingAuthorizationRetirements = values.contains(.pendingAuthorizationRetirements) ? try values.decode([AuthorizationRetirement].self, forKey: .pendingAuthorizationRetirements) : []
        try validateRetirements()
    }
    private func validateRetirements() throws {
        guard pendingAuthorizationRetirements.count <= Self.retirementLimit else { throw AuthorizationRetirementFailure.capacity }
        guard Set(pendingAuthorizationRetirements).count == pendingAuthorizationRetirements.count,
              !pendingAuthorizationRetirements.contains(where: { pending in connections.contains { $0.id == pending.connectionID && $0.authorizationID == pending.authorizationID } }) else { throw AuthorizationRetirementFailure.invalid }
    }
    func connection(_ id: String, version: String? = nil) throws -> SavedConnection {
        guard let value = connections.first(where: { $0.id == id }) else { throw ConnectionEditorFailure.missing }
        if let version, version != (value.editorVersion ?? "legacy") { throw ConnectionEditorFailure.stale }
        return value
    }
    static func origin(_ raw: String) throws -> String {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.contains("\\"), !value.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              var parts = URLComponents(string: value), let scheme = parts.scheme?.lowercased(),
              ["http", "https"].contains(scheme), let host = parts.host?.lowercased(), !host.isEmpty,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.percentEncodedPath.isEmpty || parts.percentEncodedPath == "/",
              parts.port == nil || (1...65535).contains(parts.port!), parts.url != nil else { throw ConnectionEditorFailure.invalid }
        parts.scheme = scheme; parts.host = host; parts.path = ""
        if parts.port == (scheme == "https" ? 443 : 80) { parts.port = nil }
        guard let origin = parts.string else { throw ConnectionEditorFailure.invalid }
        return origin
    }
    func editing(_ input: ConnectionEditorInput) throws -> Self {
        let previous = try connection(input.id, version: input.version)
        if let url = input.url {
            if let relay = previous.relay {
                guard url == relay.relayUrl else { throw ConnectionEditorFailure.pairingRequired }
            } else {
                guard try Self.origin(url) == Self.origin(previous.url.absoluteString) else { throw ConnectionEditorFailure.pairingRequired }
            }
        }
        guard previous.label != input.label else { return self }
        var next = self
        let index = next.connections.firstIndex(where: { $0.id == input.id })!
        next.connections[index].label = input.label
        next.connections[index].editorVersion = UUID().uuidString
        return next
    }
    func validateReplacement(id: String, version: String, input: [String: Any]) throws {
        let previous = try connection(id, version: version)
        if let label = input["label"] {
            _ = try ConnectionEditorInput(["id": id, "version": version, "label": label])
        }
        if let pairing = input["pairingLink"] as? String, !pairing.isEmpty { return }
        if let password = input["password"] as? String, !password.isEmpty { return }
        guard let token = input["token"] as? String, !token.isEmpty,
              previous.relay == nil, !connections.contains(where: { $0.token == token }) else { throw ConnectionEditorFailure.pairingRequired }
    }
    /// Call only after independently authorizing and validating the replacement candidate.
    func replacing(id: String, version: String, candidate: SavedConnection) throws -> Self {
        let previous = try connection(id, version: version)
        guard !candidate.token.isEmpty else { throw ConnectionEditorFailure.pairingRequired }
        let collision = connections.contains { other in
            guard other.id != id else { return false }
            if let relay = candidate.relay { return other.relay?.scope == relay.scope }
            return other.relay == nil && (try? Self.origin(other.url.absoluteString)) == (try? Self.origin(candidate.url.absoluteString))
        }
        guard !collision else { throw ConnectionEditorFailure.duplicate }
        var next = self
        let index = next.connections.firstIndex(where: { $0.id == id })!
        next.connections[index] = SavedConnection(id: id, label: candidate.label, url: candidate.url, token: candidate.token, lastUsedAt: previous.lastUsedAt, relay: candidate.relay, editorVersion: UUID().uuidString, authorizationID: UUID().uuidString.lowercased())
        return next
    }
    /// Persist first; failed writes leave both selection and every record untouched.
    mutating func commit(_ next: Self, acknowledging: AuthorizationRetirement? = nil, persist: (Data) throws -> Void) throws {
        var staged = next
        // Ordinary mutations cannot drop outstanding cleanup, even if a caller
        // constructs a fresh records value. Only the exact ACK lane may remove it.
        staged.pendingAuthorizationRetirements = pendingAuthorizationRetirements
        for previous in connections {
            guard let authorizationID = previous.authorizationID else { continue }
            let replacement = next.connections.first { $0.id == previous.id }
            if let replacement, replacement.authorizationID == authorizationID {
                guard replacement.token == previous.token, replacement.url == previous.url, replacement.relay == previous.relay else { throw AuthorizationRetirementFailure.invalid }
                continue
            }
            let retired = try AuthorizationRetirement(connectionID: previous.id, authorizationID: authorizationID)
            if !staged.pendingAuthorizationRetirements.contains(retired) { staged.pendingAuthorizationRetirements.append(retired) }
        }
        if let acknowledging { staged.pendingAuthorizationRetirements.removeAll { $0 == acknowledging } }
        try staged.validateRetirements()
        let bytes = try JSONEncoder().encode(staged)
        try persist(bytes)
        self = staged
    }
}
