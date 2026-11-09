import Foundation
import CoreFoundation
import CryptoKit
import Darwin

/// Offline restoration of this Observer's native field types; never loads UIKit or executes a Host.
@main struct HistoryControlValueProbe {
    static func restore(_ value: Any, key: String = "") -> Any {
        if let object = value as? [String: Any] {
            if Set(object.keys) == Set(["x", "y", "width", "height"]) {
                return object.mapValues { CGFloat(($0 as! NSNumber).doubleValue) }
            }
            if Set(object.keys) == Set(["top", "left", "bottom", "right"]) {
                if key == "contentInset" || key == "adjustedContentInset" { return object.mapValues { ($0 as! NSNumber).doubleValue } }
                return object.mapValues { CGFloat(($0 as! NSNumber).doubleValue) }
            }
            if key == "readOperationCounts" { return object.mapValues { ($0 as! NSNumber).intValue } }
            return object.mapValuesWithKey { restore($1, key: $0) }
        }
        if let array = value as? [Any] {
            if ["transform", "layerTransform", "sublayerTransform"].contains(key) { return array.map { CGFloat(($0 as! NSNumber).doubleValue) } }
            if ["ancestorVisibility", "bindings", "navigationBars", "nativeTextOwners", "composerBounds", "headerBounds"].contains(key) {
                return array.map { restore($0) as! [String: Any] }
            }
            return array.map { $0 as! String }
        }
        if let number = value as? NSNumber {
            if CFGetTypeID(number) == CFBooleanGetTypeID() { return number.boolValue }
            if key == "layerOpacity" { return number.floatValue }
            if ["alpha", "effectiveAlpha", "offsetX", "offsetY", "contentHeight", "panTranslationX", "panTranslationY"].contains(key) { return CGFloat(number.doubleValue) }
            if key.hasSuffix("Ms") || key.hasSuffix("CPUms") { return number.doubleValue }
            return number.intValue
        }
        if let string = value as? String { return string }
        return NSNull()
    }
    static func cpu() -> Double {
        var value = timespec(); clock_gettime(CLOCK_THREAD_CPUTIME_ID, &value)
        return Double(value.tv_sec) * 1000 + Double(value.tv_nsec) / 1_000_000
    }
    @MainActor static func main() throws {
        let args = CommandLine.arguments, url = URL(fileURLWithPath: args[1])
        guard try url.resourceValues(forKeys: [.fileSizeKey]).fileSize! < 1024 * 1024 else { throw HistoryV4Error.invalid("small_control_input_only") }
        let raw = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
        let input = restore(raw["result"]!) as! [String: Any]
        let baseline = try HistoryV4NativeSnapshotValue.freeze(input)
        var canonical: [String: HistorySnapshotValue] = [:], inconsistent: Set<String> = []
        func collect(_ value: Any) throws {
            if let object = value as? [String: Any] {
                if let rows = object["ancestorVisibility"] as? [[String: Any]] {
                    for row in rows {
                        guard let id = row["instance"] as? String else { continue }
                        let frozen = try HistoryV4NativeSnapshotValue.freeze(row)
                        if let old = canonical[id], old != frozen { inconsistent.insert(id) }
                        canonical[id] = frozen
                    }
                }
                for child in object.values { try collect(child) }
            } else if let array = value as? [Any] { for child in array { try collect(child) } }
        }
        try collect(input)
        let changing: [String: Any] = ["bindings": [["geometry": ["ancestorVisibility": [
            ["instance": "not-canonical", "alpha": CGFloat(1), "extraAudit": -Double.zero],
            ["instance": "not-canonical", "alpha": CGFloat(0.5), "extraAudit": Double(bitPattern: 0x7ff8000000000042)]
        ]]]]]
        let unchangedFallback = try HistoryV4NativeSnapshotValue.freeze(HistoryV4ControlValueSnapshot().shadow(changing, canonicalInstances: []))
        guard unchangedFallback == (try HistoryV4NativeSnapshotValue.freeze(changing)) else { throw HistoryV4Error.invalid("uncaptured_audit_alias") }
        var oldBytes = Data(); baseline.encode(into: &oldBytes)
        var oldTimes: [Double] = [], newTimes: [Double] = [], oldCPU: [Double] = [], newCPU: [Double] = []
        var measurements: [[String: Any]] = []
        var auditReads = 0, auditHits = 0
        for iteration in 0..<80 {
            for shared in (iteration % 2 == 0 ? [false, true] : [true, false]) {
                let startedCPU = cpu(), start = ProcessInfo.processInfo.systemUptime
                let plan = HistoryV4ControlValueSnapshot()
                let value = try HistoryV4NativeSnapshotValue.freeze(shared ? plan.shadow(input, canonicalInstances: Set(canonical.keys).subtracting(inconsistent)) : input)
                plan.finishRead()
                let elapsed = (ProcessInfo.processInfo.systemUptime - start) * 1000, elapsedCPU = cpu() - startedCPU
                measurements.append(["iteration": iteration, "shared": shared, "wallMs": elapsed, "threadCPUMs": elapsedCPU])
                if shared { newTimes.append(elapsed); newCPU.append(elapsedCPU); auditReads = plan.auditReads; auditHits = plan.auditHits }
                else { oldTimes.append(elapsed); oldCPU.append(elapsedCPU) }
                var bytes = Data(); value.encode(into: &bytes)
                guard bytes == oldBytes else { throw HistoryV4Error.invalid("complete_control_bits_or_fields_changed") }
            }
        }
        oldTimes.sort(); newTimes.sort(); oldCPU.sort(); newCPU.sort()
        let result: [String: Any] = ["scope": "offline complete captured control types; fresh plan per read; no UIKit or real control acceptance",
            "bindings": (input["bindings"] as! [Any]).count, "iterationsPerVariant": 80,
            "oldMedianMs": oldTimes[40], "newMedianMs": newTimes[40], "oldP95Ms": oldTimes[76], "newP95Ms": newTimes[76],
            "oldMaxMs": oldTimes.last!, "newMaxMs": newTimes.last!, "oldThreadCPUMedianMs": oldCPU[40], "newThreadCPUMedianMs": newCPU[40],
            "typedAuditReads": auditReads, "typedAuditHits": auditHits, "emittedAuditRecords": auditReads + auditHits,
            "wireBytes": oldBytes.count, "wireSHA256": SHA256.hash(data: oldBytes).map { String(format: "%02x", $0) }.joined()]
        var output = result; output["measurements"] = measurements
        print(String(data: try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]), encoding: .utf8)!)
        try oldBytes.write(to: URL(fileURLWithPath: args[2]))
    }
}

private extension Dictionary where Key == String, Value == Any {
    func mapValuesWithKey(_ transform: (String, Any) -> Any) -> [String: Any] {
        Dictionary(uniqueKeysWithValues: map { ($0.key, transform($0.key, $0.value)) })
    }
}
