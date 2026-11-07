import Foundation

actor TerminalCaptureWriter {
    private var written = 0
    func write(_ envelope: [String: Any], to directory: URL, revision: Int) throws -> Int {
        guard revision > written else { return written }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var value = envelope
        value["persistedSnapshotRevision"] = revision
        let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        try data.write(to: directory.appendingPathComponent("captures.json"), options: .atomic)
        written = revision
        return written
    }
}

/// Persistence trigger only. It neither decides release nor synthesizes native observations.
struct TerminalPostWindow {
    static let observationSpanMs = 4000.0
    private var baselines: [Int: Double] = [:]
    private var released: Set<Int> = []
    mutating func notePre(id: Int, nativeMs: Double) {
        guard nativeMs.isFinite else { return }
        baselines[id] = nativeMs
        trim()
    }
    mutating func noteReleased(id: Int) { released.insert(id); trim() }
    mutating func takeReady(atNativeSampleMs now: Double) -> [Int] {
        let ready = baselines.keys.filter { released.contains($0) && now - baselines[$0]! >= Self.observationSpanMs }.sorted()
        for id in ready { baselines[id] = nil; released.remove(id) }
        return ready
    }
    mutating func reset() { baselines.removeAll(); released.removeAll() }
    private mutating func trim() {
        let keep = Set(Set(baselines.keys).union(released).sorted().suffix(4))
        baselines = baselines.filter { keep.contains($0.key) }; released.formIntersection(keep)
    }
}
