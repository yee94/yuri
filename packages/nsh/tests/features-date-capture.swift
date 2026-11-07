import Foundation

/// Main runs this Foundation-only capture, never the features worker's NSH engine.
@main struct FeaturesDateCapture {
    static func main() throws {
        let format = ISO8601DateFormatter()
        func date(_ value: String) throws -> Date {
            guard let result = format.date(from: value) else { throw NativeScheduleDateContext.Failure.invalidRequest }
            return result
        }
        func capture(_ identifier: String, _ start: String, _ end: String, samples: [String]) throws -> [String: Any] {
            let input: [String: Any] = [
                "hostID": "features-fixture", "timeZone": identifier,
                "startMs": try date(start).timeIntervalSince1970 * 1000,
                "endMs": try date(end).timeIntervalSince1970 * 1000
            ]
            let context = try NativeScheduleDateContext.make(input, expectedHostID: "features-fixture")
            guard let entries = context["transitions"] as? [[String: Any]], let zone = TimeZone(identifier: identifier) else {
                throw NativeScheduleDateContext.Failure.invalidTransition
            }
            // Verify real Foundation lookup vs the returned intervals, including
            // non-DST political changes, a skipped date and a half-hour DST shift.
            for sample in samples {
                let instant = try date(sample), milliseconds = instant.timeIntervalSince1970 * 1000
                guard let entry = entries.last(where: { ($0["atMs"] as? Double ?? .infinity) <= milliseconds }),
                      entry["offsetSeconds"] as? Int == zone.secondsFromGMT(for: instant) else {
                    throw NativeScheduleDateContext.Failure.invalidTransition
                }
            }
            return context
        }
        let contexts = try [
            capture("America/New_York", "2020-01-01T00:00:00Z", "2050-01-01T00:00:00Z", samples: ["2026-03-08T06:59:00Z", "2026-03-08T07:01:00Z", "2026-11-01T05:59:00Z", "2026-11-01T06:01:00Z"]),
            capture("Asia/Kathmandu", "1985-01-01T00:00:00Z", "1987-01-01T00:00:00Z", samples: ["1985-12-31T18:29:00Z", "1985-12-31T18:31:00Z"]),
            capture("Pacific/Apia", "2011-01-01T00:00:00Z", "2013-01-01T00:00:00Z", samples: ["2011-12-30T09:59:00Z", "2011-12-30T10:01:00Z"]),
            capture("Australia/Lord_Howe", "2025-01-01T00:00:00Z", "2030-01-01T00:00:00Z", samples: ["2026-04-04T14:59:00Z", "2026-04-04T15:01:00Z", "2026-10-03T15:29:00Z", "2026-10-03T15:31:00Z"])
        ]
        let data = try JSONSerialization.data(withJSONObject: contexts, options: [.sortedKeys])
        guard let json = String(data: data, encoding: .utf8) else { throw NativeScheduleDateContext.Failure.invalidRequest }
        print(json)
    }
}
