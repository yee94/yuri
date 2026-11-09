import Foundation

/// Strictly read-only in-memory Host. No URLSession, sockets, Keychain or mutation route.
@MainActor final class AssistantListPointerHost {
    static let methods = ["connection.list", "runtime.request"]
    static let hostID = "assistant-list-pointer"
    static let lease = "00000000-0000-4000-8000-000000000091"
    private var issued = false
    static func failure(_ code: String) -> NSError {
        NSError(domain: "AssistantListPointerHost", code: 1, userInfo: [NSLocalizedDescriptionKey: "list_pointer_" + code])
    }
    func call(_ method: String, _ input: Any?) throws -> Any {
        guard let args = input as? [String: Any] else { throw Self.failure("arguments") }
        if method == "connection.list" {
            guard args.isEmpty else { throw Self.failure("connection_arguments") }
            issued = true
            return ["connections": [["id": Self.hostID, "name": "Synthetic List", "url": "https://fixture.invalid", "authorizationID": "synthetic", "transportID": "synthetic-list-pointer"]], "selected": Self.hostID, "runtimeScope": ["hostID": Self.hostID, "lease": Self.lease]] as [String: Any]
        }
        guard method == "runtime.request", issued,
              Set(args.keys) == Set(["path", "method", "expectedHost"]), args["method"] as? String == "GET",
              let scope = args["expectedHost"] as? [String: String], scope == ["hostID": Self.hostID, "lease": Self.lease],
              let path = args["path"] as? String else { throw Self.failure("read_or_scope_rejected") }
        let body: [String: Any]
        switch path {
        case "/api/yuri/assistants/capability": body = ["supported": true, "enabled": true]
        case "/api/yuri/assistants/snapshot":
            body = ["enabled": true, "revision": 3, "assistants": [
                ["id": "outer-bot-1", "revision": 1, "name": "Synthetic Research Bot", "avatarSeed": "outer-bot-1", "working": true, "pinnedAt": 3, "unreadCount": 0, "latestMessagePreview": ["text": "Synthetic pinned preview", "createdAt": 2]],
                ["id": "outer-bot-2", "revision": 2, "name": "Synthetic Review Bot", "avatarSeed": "outer-bot-2", "working": false, "pinnedAt": NSNull(), "unreadCount": 0, "latestMessagePreview": ["text": "Synthetic normal preview", "createdAt": 1]]
            ]]
        default: throw Self.failure("route_rejected")
        }
        return ["status": 200, "body": body]
    }
}
