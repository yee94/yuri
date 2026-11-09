import Foundation

/// The read-local context supplies canonical immutable audits per instance. This is not an external-input decoder.
@MainActor final class HistoryV4ControlValueSnapshot {
    private var typedAudits: [String: HistorySnapshotValue] = [:]
    private(set) var auditReads = 0, auditHits = 0
    private func geometry(_ raw: [String: Any], canonicalInstances: Set<String>) throws -> HistorySnapshotValue {
        var value = raw
        if let ancestry = raw["ancestorVisibility"] as? [[String: Any]] {
            value["ancestorVisibility"] = HistorySnapshotValue.array(try ancestry.map { row in
                guard let id = row["instance"] as? String, canonicalInstances.contains(id) else { return try HistoryV4NativeSnapshotValue.freeze(row) }
                if let frozen = typedAudits[id] { auditHits += 1; return frozen }
                auditReads += 1
                let frozen = try HistoryV4NativeSnapshotValue.freeze(row)
                if typedAudits.count < 8192 { typedAudits[id] = frozen }
                return frozen
            })
        }
        return try HistoryV4NativeSnapshotValue.freeze(value)
    }
    func shadow(_ raw: [String: Any], canonicalInstances: Set<String>) throws -> [String: Any] {
        var result = raw
        if var window = raw["windowObservation"] as? [String: Any] {
            for key in ["navigationBars", "nativeTextOwners"] {
                if let rows = window[key] as? [[String: Any]] { window[key] = HistorySnapshotValue.array(try rows.map { try geometry($0, canonicalInstances: canonicalInstances) }) }
            }
            if var live = window["liveProtection"] as? [String: Any] {
                for key in ["composerBounds", "headerBounds"] {
                    if let rows = live[key] as? [[String: Any]] { live[key] = HistorySnapshotValue.array(try rows.map { try geometry($0, canonicalInstances: canonicalInstances) }) }
                }
                if var outer = live["outerTranscript"] as? [String: Any], let observed = outer["geometry"] as? [String: Any] {
                    outer["geometry"] = try geometry(observed, canonicalInstances: canonicalInstances); live["outerTranscript"] = outer
                }
                window["liveProtection"] = live
            }
            result["windowObservation"] = window
        }
        if let rows = raw["bindings"] as? [[String: Any]] {
            result["bindings"] = try rows.map { row -> [String: Any] in
                var value = row
                if let observed = row["geometry"] as? [String: Any] { value["geometry"] = try geometry(observed, canonicalInstances: canonicalInstances) }
                return value
            }
        }
        return result
    }
    func finishRead() { typedAudits.removeAll(keepingCapacity: false) }
}
