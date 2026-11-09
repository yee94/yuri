import Foundation
import CoreFoundation

/// Request-local native stamps; JS and host clocks are never assumed to share an epoch.
final class HistoryProductionClock {
    private var issued: [String: Double] = [:]
    private var replies: [String: [String: Double]] = [:]
    static func now() -> Double { ProcessInfo.processInfo.systemUptime * 1000 }
    private func number(_ value: Any?) -> Double? {
        guard let value = value as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(), value.doubleValue.isFinite else { return nil }
        return value.doubleValue
    }
    func issue(_ nonce: String) throws {
        guard nonce.range(of: "^[a-zA-Z0-9-]{8,80}$", options: .regularExpression) != nil, issued[nonce] == nil, issued.count < 64 else { throw HistoryProductionHost.failure("clock_nonce") }
        issued[nonce] = Self.now()
    }
    func reply(_ input: Any?) throws -> [String: Any] {
        let received = Self.now()
        guard let value = input as? [String: Any], Set(value.keys) == ["nonce", "jsSendMs"], let nonce = value["nonce"] as? String,
              issued[nonce] != nil, replies[nonce] == nil, let send = number(value["jsSendMs"]), send >= 0 else { throw HistoryProductionHost.failure("clock_reply") }
        let reply = ["jsSendMs": send, "receivedNativeMs": received, "returnedNativeMs": Self.now()]
        replies[nonce] = reply
        return reply.merging(["issuedNativeMs": issued[nonce]!]) { _, next in next }
            .reduce(into: ["nonce": nonce, "nativeClock": "ProcessInfo.systemUptime milliseconds"] as [String: Any]) { $0[$1.key] = $1.value }
    }
    func acknowledge(_ input: Any?) throws -> [String: Any] {
        guard let value = input as? [String: Any], Set(value.keys) == ["nonce", "jsSendMs", "jsReceiveMs", "receivedNativeMs", "returnedNativeMs"],
              let nonce = value["nonce"] as? String, let reply = replies[nonce], let issuedAt = issued[nonce],
              let receive = number(value["jsReceiveMs"]),
              reply.allSatisfy({ number(value[$0.key]) == $0.value }), receive >= reply["jsSendMs"]!,
              reply["returnedNativeMs"]! - receive <= reply["receivedNativeMs"]! - reply["jsSendMs"]! else { throw HistoryProductionHost.failure("clock_ack") }
        issued.removeValue(forKey: nonce); replies.removeValue(forKey: nonce)
        return ["nonce": nonce, "nativeMs": reply["receivedNativeMs"]!, "nativeClock": "ProcessInfo.systemUptime milliseconds", "jsClock": "performance.now milliseconds",
                "issuedNativeMs": issuedAt, "nativeAckMs": Self.now(), "jsSendMs": reply["jsSendMs"]!, "jsReceiveMs": receive,
                "receivedNativeMs": reply["receivedNativeMs"]!, "returnedNativeMs": reply["returnedNativeMs"]!,
                "jsNativeOffsetLowerMs": reply["returnedNativeMs"]! - receive, "jsNativeOffsetUpperMs": reply["receivedNativeMs"]! - reply["jsSendMs"]!]
    }
}
