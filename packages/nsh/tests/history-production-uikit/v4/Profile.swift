import Foundation
import CryptoKit
import Darwin
import CoreFoundation

@main struct HistoryV4Profile {
    static func freshTypedContainers(_ value: HistorySnapshotValue) -> HistorySnapshotValue {
        switch value {
        case let .array(values): return .array(values.map { freshTypedContainers($0) })
        case let .object(values): return .object(values.mapValues { freshTypedContainers($0) })
        default: return value
        }
    }
    static func typedFrame(_ source: HistorySnapshotValue, seq: Int) -> HistorySnapshotValue {
        var identity = freshTypedContainers(source).object!
        var window = identity["windowObservation"]!.object!
        window["sequence"] = .integer(Int64(seq)); window["observationKind"] = .string("periodic")
        identity["windowObservation"] = .object(window); identity["observationKind"] = .string("periodic"); identity["lastPeriodicSequence"] = .integer(Int64(seq))
        guard case var .array(bindings) = identity["bindings"]! else { preconditionFailure() }
        var binding = bindings[0].object!, geometry = binding["geometry"]!.object!, rect = geometry["frameInWindow"]!.object!
        rect["x"] = .doubleBits((Double(seq) + 0.125).bitPattern); geometry["frameInWindow"] = .object(rect)
        binding["geometry"] = .object(geometry); bindings[0] = .object(binding); identity["bindings"] = .array(bindings)
        let time = Double(seq) * 16.666 + (seq % 97 == 0 ? 125.0 : 0.0)
        return .object(["sequence": .integer(Int64(seq)), "nativeUptimeMs": .doubleBits(time.bitPattern),
            "readEndNativeMs": .doubleBits((time + (seq % 83 == 0 ? 7.0 : 1.0)).bitPattern),
            "windowObservation": .object(window), "diagnosticIdentity": .object(identity), "nativeFailure": .bool(seq % 101 == 0),
            "doubleBitsFixture": .array([.doubleBits(0x8000000000000000), .doubleBits(0x7ff8000000000042), .doubleBits(0x7ff0000000000000)])])
    }
    static func nativeContainers(_ value: Any) -> Any {
        if let object = value as? [String: Any] { return object.mapValues { nativeContainers($0) } }
        if let array = value as? [Any] { return array.map { nativeContainers($0) } }
        if let number = value as? NSNumber {
            if CFGetTypeID(number) == CFBooleanGetTypeID() { return number.boolValue }
            let kind = number.objCType.pointee
            if kind == 100 || kind == 102 { return number.doubleValue }
            return Int(number.int64Value)
        }
        if let string = value as? String { return string }
        return NSNull()
    }
    @MainActor static func main() async {
        do { try await run() }
        catch { FileHandle.standardError.write(Data((String(describing: error) + "\n").utf8)); exit(2) }
    }
    @MainActor static func run() async throws {
        let args = CommandLine.arguments
        guard args.count == 6, let count = Int(args[3]), (1...18000).contains(count), let batch = Int(args[4]), [8, 16, 32].contains(batch) else { throw HistoryV4Error.invalid("profile_usage") }
        let input = URL(fileURLWithPath: args[1]), output = URL(fileURLWithPath: args[2]), mode = args[5]
        let size = try input.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? Int.max
        guard size <= 4 * 1024 * 1024 else { throw HistoryV4Error.invalid("small_input_only") }
        let raw = try JSONSerialization.jsonObject(with: Data(contentsOf: input)) as! [String: Any]
        let boxedRead = raw["result"] as? [String: Any] ?? raw
        let read = mode == "native" ? nativeContainers(boxedRead) as! [String: Any] : boxedRead
        let typedSource = try HistorySnapshotValue.freeze(read)
        guard (read["bindings"] as? [Any])?.count == 9 else { throw HistoryV4Error.invalid("actual_nine_bindings_required") }
        let started = ProcessInfo.processInfo.systemUptime
        var timings: [Double] = [], encodedBytes = 0
        let gate = ["backpressure", "ack-gate", "cancel-waiter"].contains(mode) ? HistoryV4WriteGate() : nil
        let fault: HistoryV4SegmentWriter.Fault = mode == "io-failure" ? .write : mode == "manifest-failure" ? .manifest : .none
        let pipeline = try HistoryV4CapturePipeline(directory: output, limits: .init(frames: batch, batchBytes: batch * 4 * 1024 * 1024), fault: fault, gate: gate)
        var expected = SHA256()
        for seq in 1...count {
            guard pipeline.beforeRead() else {
                if mode == "backpressure" { break }
                throw HistoryV4Error.invalid("unexpected_backpressure_\(seq)")
            }
            let before = ProcessInfo.processInfo.systemUptime
            var identity = read, window = read["windowObservation"] as! [String: Any]
            window["sequence"] = seq; window["observationKind"] = "periodic"
            identity["windowObservation"] = window; identity["observationKind"] = "periodic"; identity["lastPeriodicSequence"] = seq
            var bindings = identity["bindings"] as! [[String: Any]]
            var geometry = bindings[0]["geometry"] as! [String: Any]
            var rect = geometry["frameInWindow"] as! [String: Any]
            rect["x"] = Double(seq) + 0.125; geometry["frameInWindow"] = rect
            bindings[0]["geometry"] = geometry; identity["bindings"] = bindings
            let time = Double(seq) * 16.666 + (seq % 97 == 0 ? 125.0 : 0.0)
            let frame: [String: Any] = ["sequence": seq, "nativeUptimeMs": time, "readEndNativeMs": time + (seq % 83 == 0 ? 7.0 : 1.0),
                "windowObservation": window, "diagnosticIdentity": identity, "nativeFailure": seq % 101 == 0,
                "doubleBitsFixture": [-Double.zero, Double(bitPattern: 0x7ff8000000000042), Double.infinity]]
            let frozen = mode == "typed" ? typedFrame(typedSource, seq: seq) : try HistorySnapshotValue.freeze(frame)
            if seq % 17 == 0 {
                try pipeline.append(kind: "event", value: .object(["phase": .string("deep-profile-event"), "beforeSequence": .integer(Int64(seq))]))
            }
            if seq % 113 == 0 {
                try pipeline.append(kind: "control", value: HistorySnapshotValue.freeze(["result": read, "nonce": UUID().uuidString]))
            }
            if mode == "event-stop-during-read" { pipeline.stop("event_stop_during_read") }
            try pipeline.append(kind: "frame", value: HistorySnapshotValue.periodic(frozen))
            timings.append((ProcessInfo.processInfo.systemUptime - before) * 1000)
            // Independent full-value oracle work is not part of the shipping snapshot producer.
            if count <= 128 || seq % 128 == 1 || seq == count {
                var bytes = Data(); frozen.encode(into: &bytes); expected.update(data: bytes)
            }
            if seq % batch == 0 && mode != "backpressure" {
                // Deterministic producer barrier, not polling. All reads remain real and every record is written.
                let receipt = try await pipeline.flush(nonce: UUID().uuidString, metadata: .object(["profileBarrier": .bool(true)]))
                encodedBytes += receipt.ordinal
            }
            // UIKit returns to its run loop between display-link callbacks. Yield the pure producer
            // likewise; the deliberate gate test above remains a non-yielding backlog adversary.
            if mode == "normal" || mode == "native" || mode == "typed" { await Task.yield() }
        }
        if let gate {
            if mode == "ack-gate" || mode == "cancel-waiter" {
                let ticket = try pipeline.requestFence(nonce: UUID().uuidString, metadata: .null)
                await Task.yield()
                guard pipeline.durableOrdinal == 0, !(try FileManager.default.contentsOfDirectory(atPath: output.path)).contains(where: { $0.hasPrefix("fence-") }) else {
                    throw HistoryV4Error.invalid("queued_work_was_acked")
                }
                if mode == "cancel-waiter" {
                    let waiter = Task { try await ticket.value() }; waiter.cancel(); await gate.release()
                    do { _ = try await waiter.value; throw HistoryV4Error.invalid("cancelled_waiter_acked") }
                    catch is CancellationError { }
                } else { await gate.release(); _ = try await ticket.value() }
            } else { await gate.release() }
        }
        if mode == "cancel" { pipeline.stop("cancelled") }
        var finalReceipt: HistoryV4Receipt?
        if mode == "io-failure" || mode == "manifest-failure" || mode == "timeout" {
            do {
                _ = try await pipeline.flush(nonce: UUID().uuidString, metadata: .null, timeout: mode == "timeout" ? -1 : 10)
                throw HistoryV4Error.invalid("expected_failure_did_not_happen")
            } catch { if case HistoryV4Error.invalid("expected_failure_did_not_happen") = error { throw error } }
        } else {
            let nonce = UUID().uuidString
            finalReceipt = try await pipeline.flush(nonce: nonce, metadata: .object(["purpose": .string("pure Foundation stress; no UIKit proof")]))
            let second = try await pipeline.flush(nonce: UUID().uuidString, metadata: .null)
            guard second.ordinal == finalReceipt!.ordinal, second.revision == finalReceipt!.revision + 1, second.nonce != nonce else { throw HistoryV4Error.invalid("repeated_flush") }
        }
        // Reject unknown reference objects rather than carrying them across the executor boundary.
        do { _ = try HistorySnapshotValue.freeze(NSObject()); throw HistoryV4Error.invalid("reference_admitted") }
        catch { if case HistoryV4Error.invalid("reference_admitted") = error { throw error } }
        timings.sort(); var usage = rusage(); getrusage(RUSAGE_SELF, &usage)
        let report: [String: Any] = ["schema": HistoryV4SegmentWriter.schema, "mode": mode, "frames": pipeline.sequence, "batch": batch,
            "lastOrdinal": pipeline.ordinal, "lastDurableSequence": pipeline.durableSequence, "stop": pipeline.stopped as Any? ?? NSNull(),
            "manifest": finalReceipt?.manifest as Any? ?? NSNull(), "revision": finalReceipt?.revision as Any? ?? NSNull(),
            "maxRSSBytes": usage.ru_maxrss, "peakQueuedAllocatorBudget": pipeline.peakQueuedBudget, "peakBatchFrames": pipeline.peakBatchFrames,
            "batchAllocatorBudget": pipeline.limits.batchBytes,
            "elapsedMs": (ProcessInfo.processInfo.systemUptime - started) * 1000, "readAndFreezeMedianMs": timings[timings.count / 2],
            "readAndFreezeP95Ms": timings[min(timings.count - 1, timings.count * 95 / 100)], "readAndFreezeMaxMs": timings.last!,
            "sampledExpandedSHA256": expected.finalize().map { String(format: "%02x", $0) }.joined(), "barrierOrdinals": encodedBytes]
        print(String(decoding: try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]), as: UTF8.self))
    }
}
