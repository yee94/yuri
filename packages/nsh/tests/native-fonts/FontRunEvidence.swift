import Foundation
import CoreFoundation

enum FontRunEvidence {
    private static func number(_ value: Any?) -> NSNumber? {
        guard let value = value as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(), value.doubleValue.isFinite else { return nil }
        return value
    }
    private static func positiveInteger(_ value: Any?) -> UInt64? {
        guard let number = number(value), number.doubleValue > 0, number.doubleValue.rounded(.towardZero) == number.doubleValue else { return nil }
        return number.uint64Value
    }
    static func validates(_ evidence: [String: Any], generation: UInt64, expected: [String: [String: Any]]) -> Bool {
        guard generation > 0, evidence["contract"] as? String == "nsh-ctrun-after-draw-v1",
              evidence["source"] as? String == "TextView.drawRect/CTLine.draw",
              positiveInteger(evidence["captureGeneration"]) == generation,
              let missing = evidence["missing"] as? [String], missing.isEmpty,
              let records = evidence["records"] as? [String: [String: Any]], !expected.isEmpty,
              Set(records.keys) == Set(expected.keys) else { return false }
        var displays: Set<UInt64> = []
        for (id, expectation) in expected {
            guard let record = records[id], positiveInteger(record["captureGeneration"]) == generation,
                  let display = positiveInteger(record["displayGeneration"]), displays.insert(display).inserted,
                  positiveInteger(record["layoutGeneration"]) != nil,
                  let runs = record["runs"] as? [[String: Any]], !runs.isEmpty,
                  let name = expectation["postScriptName"] as? String, let version = expectation["fontVersion"] as? String, !version.isEmpty,
                  let size = number(expectation["pointSize"]) else { return false }
            for run in runs {
                guard run["postScriptName"] as? String == name, run["fontVersion"] as? String == version, positiveInteger(run["glyphCount"]) != nil,
                      let actualSize = number(run["pointSize"]), abs(actualSize.doubleValue - size.doubleValue) <= 0.01 else { return false }
            }
        }
        return true
    }
}
