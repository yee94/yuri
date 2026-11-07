import Foundation

private actor Gate {
    private var waiter: CheckedContinuation<Void, Never>?
    private var opened = false
    func wait() async { if !opened { await withCheckedContinuation { waiter = $0 } } }
    func open() { opened = true; waiter?.resume(); waiter = nil }
}

@main struct CaptureStorageChecks {
    static func main() async throws {
        var window = TerminalPostWindow()
        window.notePre(id: 19, nativeMs: 516458068.24187505)
        window.noteReleased(id: 19)
        precondition(window.takeReady(atNativeSampleMs: 516458068.24187505).isEmpty)
        precondition(window.takeReady(atNativeSampleMs: 516462068.0).isEmpty)
        precondition(window.takeReady(atNativeSampleMs: 516462068.24187505) == [19])
        precondition(window.takeReady(atNativeSampleMs: 516462085).isEmpty)
        window.noteReleased(id: 20) // Arrival order does not invent a baseline.
        precondition(window.takeReady(atNativeSampleMs: 600000000).isEmpty)
        window.notePre(id: 20, nativeMs: 600000000)
        precondition(window.takeReady(atNativeSampleMs: 600004000) == [20])
        window.notePre(id: 21, nativeMs: 700000000); window.noteReleased(id: 21); window.reset()
        precondition(window.takeReady(atNativeSampleMs: 700004000).isEmpty)
        print("PASS: real-clock baseline; no post samples never trigger publication; unchanged 4000ms prefix triggers once; reset/arrival-order fences")

        let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
        let writer = TerminalCaptureWriter(), gate = Gate()
        _ = try await writer.write(["frames": [], "label": "pre-only"], to: directory, revision: 1)
        let pending = Task { await gate.wait(); return try await writer.write(["frames": Array(1...240), "label": "continuous-post"], to: directory, revision: 2) }
        func read() throws -> [String: Any] { try JSONSerialization.jsonObject(with: Data(contentsOf: directory.appendingPathComponent("captures.json"))) as! [String: Any] }
        // Deterministic analogue of the probe's un-awaited tap→copy: no sleep or timing guess.
        let preCopy = try read()
        precondition(preCopy["label"] as? String == "pre-only")
        await gate.open(); let ack = try await pending.value
        precondition(ack == 2)
        let saved = try read()
        precondition(saved["label"] as? String == "continuous-post")
        precondition((saved["frames"] as? [Int])?.count == 240)
        precondition(saved["persistedSnapshotRevision"] as? Int == 2)
        let superseded = try await writer.write(["label": "older-late-write"], to: directory, revision: 1)
        let final = try read()
        precondition(superseded == 2 && final["label"] as? String == "continuous-post")
        print("PASS: un-awaited copy sees stale snapshot; awaited disk ACK sees full prefix; older late writer cannot overwrite it (Foundation only)")
    }
}
