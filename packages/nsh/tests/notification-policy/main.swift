import Foundation

func rejects(_ work: () throws -> Void) {
    do { try work(); fatalError("Invalid input accepted") } catch { }
}
let host = "host-a"
let configuration: [String: Any] = ["hostID": host, "enabled": true, "mode": "hidden-only", "events": ["completion", "permission"], "language": "en"]
_ = try NativeNotificationPolicy.object([String: Any](), keys: [])
for input: Any? in [nil, [Any](), ["url": "https://outside.invalid"], ["token": "excluded"]] {
    rejects { _ = try NativeNotificationPolicy.object(input, keys: []) }
}
let decoded = try NativeNotificationConfiguration(configuration, hostID: host)
precondition(decoded.enabled && decoded.events == ["completion", "permission"])
for (key, value) in [("enabled", 1 as Any), ("hostID", "host-b"), ("mode", "sometimes"), ("language", "ar"), ("events", ["completion", "completion"]), ("events", ["https://outside.invalid"]), ("token", "excluded")] {
    var bad = configuration; bad[key] = value
    rejects { _ = try NativeNotificationConfiguration(bad, hostID: host) }
}
for id in ["", "../../private", "https://outside.invalid", "id?token=x", String(repeating: "a", count: 129)] {
    rejects { _ = try NativeNotificationTarget(["kind": "session", "id": id]) }
}
let target = try NativeNotificationTarget(["kind": "session", "id": "session-1"])
precondition(target.value == ["kind": "session", "id": "session-1"])
rejects { _ = try NativeNotificationTarget(["kind": "session", "id": "session-1", "url": "https://outside.invalid"]) }
let event: [String: Any] = ["lease": "lease-1", "eventID": "event-1", "kind": "completion", "target": target.value]
let decodedEvent = try NativeNotificationEvent(event, lease: "lease-1")
precondition(decodedEvent.target == target)
var namespacedEvent = event; namespacedEvent["eventID"] = "n_assistant_128_" + String(repeating: "a", count: 128) + "_128_" + String(repeating: "b", count: 128)
let namespacedDecoded = try NativeNotificationEvent(namespacedEvent, lease: "lease-1")
precondition(namespacedDecoded.target == target)
for invalid in ["", "https://outside.invalid", String(repeating: "a", count: 385)] {
    var badEvent = event; badEvent["eventID"] = invalid
    rejects { _ = try NativeNotificationEvent(badEvent, lease: "lease-1") }
}
var visibleEvent = event; visibleEvent["requireHidden"] = false
rejects { _ = try NativeNotificationEvent(visibleEvent, lease: "lease-1") }
rejects { _ = try NativeNotificationEvent(event, lease: "lease-2") }
var privateEvent = event; privateEvent["body"] = "must never reach the lock screen"
rejects { _ = try NativeNotificationEvent(privateEvent, lease: "lease-1") }
for status in ["authorized", "provisional", "ephemeral"] { precondition(NativeNotificationPolicy.authorized(status)) }
for status in ["denied", "notDetermined", "unknown"] { precondition(!NativeNotificationPolicy.authorized(status)) }
for active in [false, true] {
    precondition(NativeNotificationPolicy.present(enabled: true, active: active, test: false) == !active)
    precondition(!NativeNotificationPolicy.present(enabled: false, active: active, test: false))
    precondition(NativeNotificationPolicy.present(enabled: false, active: active, test: true))
}
let receipt = UUID().uuidString
precondition(NativeNotificationPolicy.receipt(["v": 1, "receipt": receipt]) == receipt)
for bad: [AnyHashable: Any] in [["v": true, "receipt": receipt], ["v": 2, "receipt": receipt], ["v": 1, "receipt": "not-a-uuid"], ["v": 1, "receipt": receipt, "url": "https://outside.invalid"]] {
    precondition(NativeNotificationPolicy.receipt(bad) == nil)
}
for language in NativeNotificationPolicy.languages {
    let normal = NativeNotificationPolicy.copy(language: language, test: false), test = NativeNotificationPolicy.copy(language: language, test: true)
    precondition(normal.0 == "Yuri" && !normal.1.isEmpty && !test.0.isEmpty && !test.1.isEmpty)
}
print("Notification Foundation policy passed; no notifications scheduled")
