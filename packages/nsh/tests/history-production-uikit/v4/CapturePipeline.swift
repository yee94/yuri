import Foundation

@MainActor final class HistoryV4FenceTicket {
    private var result: Result<HistoryV4Receipt, Error>?
    private var continuation: CheckedContinuation<HistoryV4Receipt, Error>?
    func complete(_ result: Result<HistoryV4Receipt, Error>) {
        self.result = result; continuation?.resume(with: result); continuation = nil
    }
    func value() async throws -> HistoryV4Receipt {
        try Task.checkCancellation()
        let value: HistoryV4Receipt
        if let result { value = try result.get() }
        else {
            guard continuation == nil else { throw HistoryV4Error.invalid("duplicate_fence_waiter") }
            value = try await withCheckedThrowingContinuation { continuation = $0 }
        }
        try Task.checkCancellation(); return value
    }
}

/// Main-actor admission only. One encoding batch plus one accumulating batch; no task per frame.
@MainActor final class HistoryV4CapturePipeline {
    struct Limits {
        let frames: Int, batchBytes: Int, nextReadReservation: Int
        init(frames: Int = 16, batchBytes: Int = 32 * 1024 * 1024, nextReadReservation: Int = 4 * 1024 * 1024) {
            self.frames = frames; self.batchBytes = batchBytes; self.nextReadReservation = nextReadReservation
        }
    }
    private struct Pending {
        let fence: HistoryV4Fence, deadline: Double
        let ticket: HistoryV4FenceTicket
    }
    let limits: Limits
    private let writer: HistoryV4SegmentWriter
    private var pending: [Pending] = [], current: [HistoryV4Record] = []
    private var busy = false, frameCount = 0, currentBytes = 0, eventCount = 0
    private(set) var ordinal = 0, sequence = 0, durableOrdinal = 0, durableSequence = 0
    private(set) var stopped: String?, failure: Error?
    private(set) var peakQueuedBudget = 0, peakBatchFrames = 0
    private var inFlightBytes = 0, requestedRevision = 0
    private var failedBatch: [HistoryV4Record] = []
    private var pendingMetadataBytes = 0
    private var reading = false, terminalWritten = false
    private var lastReadSequence = 0

    init(directory: URL, limits: Limits = Limits(), fault: HistoryV4SegmentWriter.Fault = .none, gate: HistoryV4WriteGate? = nil) throws {
        guard [8, 16, 32].contains(limits.frames), limits.batchBytes > limits.nextReadReservation, limits.nextReadReservation > 0 else { throw HistoryV4Error.invalid("pipeline_limits") }
        self.limits = limits; writer = try HistoryV4SegmentWriter(directory: directory, fault: fault, gate: gate)
    }
    func beforeRead() -> Bool {
        guard stopped == nil, failure == nil, !reading else { return false }
        if sequence >= 18000 { stop("frame_cap_18000"); return false }
        if eventCount >= 20000 { stop("event_cap_20000"); return false }
        if frameCount >= limits.frames || currentBytes + limits.nextReadReservation > limits.batchBytes || current.count >= 4000 {
            pump()
            if frameCount >= limits.frames || currentBytes + limits.nextReadReservation > limits.batchBytes || current.count >= 4000 {
                stop("writer_backlog_before_next_read"); return false
            }
        }
        lastReadSequence = sequence + 1; reading = true; return true
    }
    func append(kind: String, value: HistorySnapshotValue) throws {
        guard failure == nil, stopped == nil || kind == "control" || kind == "frame" && reading else { throw HistoryV4Error.invalid("capture_stopped") }
        if kind == "frame" {
            guard reading else { throw HistoryV4Error.invalid("frame_without_read_reservation") }
            sequence += 1; frameCount += 1; reading = false
        }
        if kind == "event" { eventCount += 1 }
        ordinal += 1
        let record = HistoryV4Record(ordinal: ordinal, kind: kind, sequence: sequence, value: value)
        current.append(record); currentBytes += record.allocatorBytes
        peakQueuedBudget = max(peakQueuedBudget, currentBytes + inFlightBytes)
        peakBatchFrames = max(peakBatchFrames, frameCount)
        // An unexpectedly large completed read is preserved in full, then capture stops explicitly.
        // Reservation is not a license to truncate the already observed value.
        if stopped != nil && !reading { finishStop() }
        else if currentBytes > limits.batchBytes { stop("completed_record_exceeded_allocator_reservation") }
        else if current.count >= 4000 { stop("record_queue_capacity") }
        else if sequence >= 18000 { stop("frame_cap_18000") }
        else if frameCount >= limits.frames { pump() }
    }
    func stop(_ reason: String) {
        guard stopped == nil else { return }
        stopped = reason
        if !reading { finishStop() }
    }
    func abortRead(_ reason: String) {
        reading = false
        if stopped == nil { stopped = reason }
        finishStop()
    }
    private func finishStop() {
        guard !terminalWritten, let reason = stopped else { return }
        terminalWritten = true; ordinal += 1
        let value: HistorySnapshotValue = .object(["reason": .string(reason), "overflow": .bool(reason != "cancelled"),
            "lastReadSequence": .integer(Int64(lastReadSequence)), "lastCapturedSequence": .integer(Int64(sequence)),
            "lastDurableSequenceAtStop": .integer(Int64(durableSequence)), "lastDurableOrdinalAtStop": .integer(Int64(durableOrdinal)),
            "nativeMs": .doubleBits((ProcessInfo.processInfo.systemUptime * 1000).bitPattern)])
        let terminator = HistoryV4Record(ordinal: ordinal, kind: "terminator", sequence: sequence, value: value)
        current.append(terminator); currentBytes += terminator.allocatorBytes
        peakQueuedBudget = max(peakQueuedBudget, currentBytes + inFlightBytes)
        pump()
    }
    func flush(nonce: String, metadata: HistorySnapshotValue, timeout: Double = 10) async throws -> HistoryV4Receipt {
        try Task.checkCancellation()
        return try await requestFence(nonce: nonce, metadata: metadata, timeout: timeout).value()
    }
    func requestFence(nonce: String, metadata: HistorySnapshotValue, timeout: Double = 10) throws -> HistoryV4FenceTicket {
        let metadataBytes = metadata.allocationBudget
        guard failure == nil, pending.count < 16, pendingMetadataBytes + metadataBytes <= limits.batchBytes,
              UUID(uuidString: nonce) != nil else { throw HistoryV4Error.invalid("flush_state_or_metadata_budget") }
        requestedRevision += 1
        let fence = HistoryV4Fence(nonce: nonce, revision: requestedRevision, ordinal: ordinal, sequence: sequence, metadata: metadata)
        let ticket = HistoryV4FenceTicket()
        pendingMetadataBytes += metadataBytes
        pending.append(.init(fence: fence, deadline: ProcessInfo.processInfo.systemUptime + timeout, ticket: ticket)); pump()
        return ticket
    }
    private func pump() {
        guard !busy, failure == nil else { return }
        if let request = pending.first, request.fence.ordinal == durableOrdinal {
            busy = true
            Task {
                do {
                    let receipt = try await writer.fence(request.fence)
                    pending.removeFirst(); pendingMetadataBytes -= request.fence.metadata.allocationBudget; busy = false
                    if ProcessInfo.processInfo.systemUptime <= request.deadline { request.ticket.complete(.success(receipt)) }
                    else { request.ticket.complete(.failure(HistoryV4Error.invalid("durable_ack_timeout"))) }
                    pump()
                } catch { fail(error) }
            }
            return
        }
        guard !current.isEmpty else { return }
        let end = pending.first?.fence.ordinal ?? ordinal
        let split = current.firstIndex { $0.ordinal > end } ?? current.count
        guard split > 0 else { return }
        let batch = Array(current.prefix(split)); current.removeFirst(split)
        inFlightBytes = batch.reduce(0) { $0 + $1.allocatorBytes }
        currentBytes = current.reduce(0) { $0 + $1.allocatorBytes }
        frameCount = current.filter { $0.kind == "frame" }.count
        busy = true
        Task {
            do {
                try await writer.append(batch)
                durableOrdinal = batch.last!.ordinal; durableSequence = batch.last!.sequence
                busy = false; inFlightBytes = 0; pump()
            } catch { failedBatch = batch; fail(error) }
        }
    }
    private func fail(_ error: Error) {
        failure = error; busy = false; stopped = stopped ?? "writer_io_failure"
        // Completed but not durable values remain retained for diagnosis; no success ACK is produced.
        for request in pending { request.ticket.complete(.failure(error)) }
        pending.removeAll()
        pendingMetadataBytes = 0
    }
}
