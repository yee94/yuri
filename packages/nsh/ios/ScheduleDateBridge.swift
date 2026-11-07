import Foundation
import CoreFoundation

/// Read-only IANA offset data. Cron parsing/iteration remains in cron-parser, never here.
enum NativeScheduleDateContext {
    enum Failure: LocalizedError {
        case invalidRequest, invalidZone, invalidRange, invalidTransition, staleScope
        var errorDescription: String? {
            switch self {
            case .invalidRequest: return "schedule_date_invalid_request"
            case .invalidZone: return "schedule_date_invalid_iana_zone"
            case .invalidRange: return "schedule_date_invalid_range"
            case .invalidTransition: return "schedule_date_invalid_transition"
            case .staleScope: return "schedule_date_stale_scope"
            }
        }
    }

    static func make(_ input: Any?, expectedHostID: String) throws -> [String: Any] {
        guard let value = input as? [String: Any],
              Set(value.keys) == ["hostID", "timeZone", "startMs", "endMs"],
              value["hostID"] as? String == expectedHostID, !expectedHostID.isEmpty,
              let identifier = value["timeZone"] as? String, !identifier.isEmpty,
              identifier.utf8.count <= 128,
              identifier.utf8.allSatisfy({ (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || [43, 45, 47, 95].contains($0) }) else {
            throw Failure.invalidRequest
        }
        func milliseconds(_ key: String) throws -> Double {
            guard let number = value[key] as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
                  number.doubleValue.isFinite, number.doubleValue.rounded() == number.doubleValue else {
                throw Failure.invalidRequest
            }
            return number.doubleValue
        }
        let startMs = try milliseconds("startMs"), endMs = try milliseconds("endMs")
        guard startMs >= -62_135_596_800_000, endMs <= 253_402_300_799_999,
              startMs < endMs, endMs - startMs <= 64 * 366 * 86_400_000 else { throw Failure.invalidRange }
        guard let zone = TimeZone(identifier: identifier) else { throw Failure.invalidZone }
        let start = Date(timeIntervalSince1970: startMs / 1000)
        let end = Date(timeIntervalSince1970: endMs / 1000)
        var transitions: [[String: Any]] = [["atMs": startMs, "offsetSeconds": zone.secondsFromGMT(for: start)]]
        var cursor = start
        while let transition = zone.nextDaylightSavingTimeTransition(after: cursor), transition < end {
            let atMs = transition.timeIntervalSince1970 * 1000
            guard transition > cursor, atMs.isFinite, atMs.rounded() == atMs,
                  transitions.count < 1024 else { throw Failure.invalidTransition }
            transitions.append(["atMs": atMs, "offsetSeconds": zone.secondsFromGMT(for: transition)])
            cursor = transition.addingTimeInterval(0.001)
        }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        let parts = calendar.dateComponents([.era, .year, .month, .day, .hour, .minute, .second, .weekday], from: start)
        guard let era = parts.era, let year = parts.year, let month = parts.month, let day = parts.day,
              let hour = parts.hour, let minute = parts.minute, let second = parts.second, let weekday = parts.weekday else {
            throw Failure.invalidRange
        }
        return [
            "schemaVersion": 1, "hostID": expectedHostID, "timeZone": identifier,
            "startMs": startMs, "endMs": endMs, "transitions": transitions,
            "anchor": ["timestampMs": startMs, "era": era, "year": year, "month": month, "day": day,
                       "hour": hour, "minute": minute, "second": second, "weekday": weekday,
                       "offsetSeconds": zone.secondsFromGMT(for: start)]
        ]
    }
}

#if canImport(UIKit) && canImport(NativeShell)
import NativeShell

@MainActor struct ScheduleDateScope {
    let hostID: String
    let isCurrent: () -> Bool
}

/// No credentials, network, file access, scheduler mutation, or persistent cache.
@MainActor final class ScheduleDateBridge {
    private let capture: () throws -> ScheduleDateScope
    init(app: NshAppView, capture: @escaping () throws -> ScheduleDateScope) {
        self.capture = capture
        app.handle("schedule.dateContext") { [weak self] input async throws -> Any? in
            guard let self else { throw CancellationError() }
            let scope = try self.capture()
            guard scope.isCurrent() else { throw NativeScheduleDateContext.Failure.staleScope }
            let result = try NativeScheduleDateContext.make(input, expectedHostID: scope.hostID)
            guard scope.isCurrent() else { throw NativeScheduleDateContext.Failure.staleScope }
            return result
        }
    }
}
#endif
