import Foundation
import CoreFoundation
import Darwin

/// Offline scale calibration only. Never imports UIKit/NativeShell or opens a large capture.
@main struct HistoryEncodingProfile {
    static func swiftValue(_ value: Any) -> Any {
        if let object = value as? [String: Any] { return object.mapValues { swiftValue($0) } }
        if let array = value as? [Any] { return array.map { swiftValue($0) } }
        if let number = value as? NSNumber {
            if CFGetTypeID(number) == CFBooleanGetTypeID() { return number.boolValue }
            if String(cString: number.objCType).contains("f") || String(cString: number.objCType).contains("d") { return number.doubleValue }
            return number.int64Value
        }
        if let string = value as? String { return String(string) }
        return NSNull()
    }
    static func expanded(_ frame: [String: Any]) throws -> [String: Any] {
        guard let sequence = frame["sequence"] as? Int, let window = frame["windowObservation"] as? [String: Any], window["sequence"] as? Int == sequence,
              var identity = frame["diagnosticIdentity"] as? [String: Any], identity["windowObservationRef"] as? Int == sequence,
              identity["windowObservation"] == nil else { throw NSError(domain: "profile_reference", code: 1) }
        identity.removeValue(forKey: "windowObservationRef"); identity["windowObservation"] = window
        var result = frame; result["diagnosticIdentity"] = identity; return result
    }
    static func main() {
        do { try run() }
        catch {
            let failure = error as NSError
            FileHandle.standardError.write(Data((failure.domain + ":" + String(failure.code) + "\n").utf8)); exit(2)
        }
    }
    static func run() throws {
        let args = CommandLine.arguments
        guard args.count == 4, let count = Int(args[2]), (1...128).contains(count), ["legacy", "same-sequence-ref-model"].contains(args[3]) else { throw NSError(domain: "profile_usage", code: 1) }
        let url = URL(fileURLWithPath: args[1])
        let size = (try FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.intValue ?? Int.max
        guard size <= 4 * 1024 * 1024 else { throw NSError(domain: "profile_input_over_4MiB_refused_before_read", code: 1) }
        guard count <= (32 * 1024 * 1024) / max(1, size) else { throw NSError(domain: "profile_input_times_count_over_32MiB_refused_before_read", code: 1) }
        let handle = try FileHandle(forReadingFrom: url); defer { try? handle.close() }
        let inputBytes = try handle.read(upToCount: 4 * 1024 * 1024 + 1) ?? Data()
        guard inputBytes.count <= 4 * 1024 * 1024 && count <= (32 * 1024 * 1024) / max(1, inputBytes.count) else { throw NSError(domain: "profile_input_grew_beyond_budget_refused_before_parse", code: 1) }
        let input = try JSONSerialization.jsonObject(with: inputBytes) as! [String: Any]
        let read = input["result"] as? [String: Any] ?? input
        guard let window = read["windowObservation"] as? [String: Any], let bindings = read["bindings"] as? [[String: Any]], !bindings.isEmpty else { throw NSError(domain: "profile_deep_native_read_required", code: 1) }
        var frames: [[String: Any]] = []
        let started = ProcessInfo.processInfo.systemUptime
        for index in 1...count {
            var identity = swiftValue(read) as! [String: Any], currentWindow = swiftValue(window) as! [String: Any]
            currentWindow["sequence"] = index; identity["lastPeriodicSequence"] = index
            identity["windowObservation"] = currentWindow
            let legacy: [String: Any] = ["sequence": index, "windowObservation": currentWindow, "diagnosticIdentity": identity]
            var frame = legacy
            if args[3] == "same-sequence-ref-model" {
                identity.removeValue(forKey: "windowObservation"); identity["windowObservationRef"] = index
                frame["diagnosticIdentity"] = identity
                // Exact JSON value reconstruction is tested per frame; no UIKit geometry cache.
                let restored = try expanded(frame)
                guard try JSONSerialization.data(withJSONObject: restored, options: [.sortedKeys]) == JSONSerialization.data(withJSONObject: legacy, options: [.sortedKeys]) else { throw NSError(domain: "profile_lossless_expansion", code: 1) }
            }
            frames.append(frame)
        }
        let encodeStart = ProcessInfo.processInfo.systemUptime
        let bytes = try JSONSerialization.data(withJSONObject: ["frames": frames])
        let finished = ProcessInfo.processInfo.systemUptime
        var usage = rusage(); getrusage(RUSAGE_SELF, &usage)
        let report: [String: Any] = ["purpose": "offline deep-payload calibration; not a shipping v4 codec or UIKit performance proof", "mode": args[3],
            "frames": count, "bindingsPerFrame": bindings.count, "inputBytes": size, "jsonBytes": bytes.count,
            "buildAndValidationMs": (encodeStart - started) * 1000, "encodingMs": (finished - encodeStart) * 1000,
            "maxRSSBytes": usage.ru_maxrss, "provenExpansion": args[3] == "same-sequence-ref-model"]
        print(String(decoding: try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]), as: UTF8.self))
    }
}
