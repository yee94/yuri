import Foundation
import Security

struct RelayConfiguration: Codable, Equatable {
    let relayUrl: String
    let serverId: String
    let hostEncPubJwk: [String: String]
    var scope: String { relayUrl + "\n" + serverId }
    static func canonicalAddress(_ value: String) throws -> String {
        guard var components = URLComponents(string: value),
              ["ws", "wss"].contains(components.scheme?.lowercased() ?? ""),
              let host = components.host, !host.isEmpty,
              components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil,
              components.port == nil || (1...65535).contains(components.port!),
              !value.contains("\\"), !value.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { throw ConnectionEditorFailure.invalid }
        components.scheme = components.scheme?.lowercased(); components.host = host.lowercased()
        if (components.scheme == "wss" && components.port == 443) || (components.scheme == "ws" && components.port == 80) { components.port = nil }
        guard let address = components.string, components.url != nil else { throw ConnectionEditorFailure.invalid }
        return address
    }
}

struct SavedConnection: Codable {
    let id: String
    var label: String
    let url: URL
    let token: String
    var lastUsedAt: Double
    var relay: RelayConfiguration? = nil
    var editorVersion: String? = nil
    /// Durable credential authorization generation. Missing legacy values remain
    /// unknown; ordinary metadata edits never manufacture a cold-restore proof.
    var authorizationID: String? = nil
    var transportID: String? = nil
    var publicValue: [String: Any] {
        var value: [String: Any] = ["id": id, "label": label, "url": relay?.relayUrl ?? url.absoluteString, "transport": relay == nil ? "direct" : "relay", "lastUsedAt": lastUsedAt]
        if let authorizationID { value["authorizationID"] = authorizationID }
        if let transportID { value["transportID"] = transportID }
        return value
    }
    var editorValue: [String: Any] {
        var value = publicValue
        value["version"] = editorVersion ?? "legacy"
        return value
    }
}

enum NativeFailure: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let value) = self { return value }; return nil }
}

/// One atomic Keychain record contains metadata and credentials. No UserDefaults credential copy.
@MainActor final class ConnectionStore {
    private typealias State = ConnectionEditorRecords
    private let service = "com.yee94.yuri.nsh.connections"
    private var state: State
    init() throws {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: "connections", kSecReturnData as String: true]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { state = State() }
        else if status == errSecSuccess, let bytes = result as? Data { state = try JSONDecoder().decode(State.self, from: bytes) }
        else { throw NativeFailure.message("无法读取设备安全存储 (\(status))") }
        if state.transportPartitions == nil && !state.connections.isEmpty { try commit(state) }
    }
    var selected: SavedConnection? { state.connections.first { $0.id == state.selected } }
    /// Reconstitute only the exact original attachment authorization. Selection
    /// and metadata edits do not grant a replacement credential this authority.
    func attachmentConnection(connectionID: String, transportID: String, authorizationID: String, version: String) throws -> SavedConnection {
        guard let connection = state.connections.first(where: { $0.id == connectionID && $0.transportID == transportID && $0.authorizationID == authorizationID && $0.editorVersion == version }) else { throw NativeFailure.message("attachment_original_authorization_unavailable") }
        return connection
    }
    var snapshot: [String: Any] {
        ["connections": state.connections.sorted { $0.lastUsedAt > $1.lastUsedAt }.map(\.publicValue), "selected": state.selected as Any? ?? NSNull()]
    }
    private func commit(_ next: State, acknowledging: AuthorizationRetirement? = nil) throws {
        try state.commit(next, acknowledging: acknowledging, persist: persist)
    }
    private func persist(_ data: Data) throws {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: "connections"]
        var status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var item = query
            item[kSecValueData as String] = data
            item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            status = SecItemAdd(item as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw NativeFailure.message("无法保存设备连接 (\(status))") }
    }
    func save(url: URL, token: String, label: String, relay: RelayConfiguration? = nil) throws {
        var next = state
        let transport = try ConnectionTransport(url: url, relay: relay)
        let existing = try next.connections.first { try ConnectionTransport(url: $0.url, relay: $0.relay) == transport }
        let value = SavedConnection(id: existing?.id ?? UUID().uuidString, label: label.isEmpty ? (relay?.serverId ?? url.host ?? "Yuri") : label, url: url, token: token, lastUsedAt: Date().timeIntervalSince1970 * 1000, relay: relay, editorVersion: UUID().uuidString, authorizationID: UUID().uuidString.lowercased())
        next.connections.removeAll { $0.id == value.id }
        next.connections.append(value); next.selected = value.id
        try commit(next)
    }
    func editor(_ id: String, version: String? = nil) throws -> [String: Any] {
        try state.connection(id, version: version).editorValue
    }
    func edit(_ input: ConnectionEditorInput) throws {
        let next = try state.editing(input)
        if try state.connection(input.id).editorVersion == next.connection(input.id).editorVersion { return }
        do { try commit(next) } catch { throw ConnectionEditorFailure.storage }
    }
    func validateReplacement(id: String, version: String, input: [String: Any]) throws {
        try state.validateReplacement(id: id, version: version, input: input)
    }
    func replace(id: String, version: String, url: URL, token: String, label: String, relay: RelayConfiguration?) throws {
        let candidate = SavedConnection(id: id, label: label.isEmpty ? (relay?.serverId ?? url.host ?? "Yuri") : label, url: url, token: token, lastUsedAt: 0, relay: relay)
        let next = try state.replacing(id: id, version: version, candidate: candidate)
        do { try commit(next) }
        catch let failure as AuthorizationRetirementFailure { throw failure }
        catch { throw ConnectionEditorFailure.storage }
    }
    func select(_ id: String) throws {
        guard let index = state.connections.firstIndex(where: { $0.id == id }) else { throw NativeFailure.message("连接已不存在") }
        var next = state
        next.selected = id; next.connections[index].lastUsedAt = Date().timeIntervalSince1970 * 1000
        try commit(next)
    }
    func remove(_ id: String) throws {
        var next = state
        next.connections.removeAll { $0.id == id }
        if next.selected == id { next.selected = nil }
        try commit(next)
    }
    /// Native cleanup only; never expose these identities as JS mutation authority.
    var pendingAuthorizationRetirements: [AuthorizationRetirement] { state.pendingAuthorizationRetirements }
    /// Call only after NotificationBridge successfully retires this exact pair.
    /// A failed ACK write preserves pending; retry cleanup, never the original mutation.
    func acknowledgeAuthorizationRetirement(connectionID: String, authorizationID: String) throws {
        let retired = try AuthorizationRetirement(connectionID: connectionID, authorizationID: authorizationID)
        guard state.pendingAuthorizationRetirements.contains(retired) else { return }
        try commit(state, acknowledging: retired)
    }
}
