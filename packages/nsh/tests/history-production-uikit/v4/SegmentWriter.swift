import Foundation
import CryptoKit
import Darwin

struct HistoryV4Segment: Codable, Sendable {
    let file: String, sha256: String
    let bytes: Int, firstOrdinal: Int, lastOrdinal: Int, lastSequence: Int
}
struct HistoryV4Fence: Sendable {
    let nonce: String, revision: Int, ordinal: Int, sequence: Int
    let metadata: HistorySnapshotValue
}
struct HistoryV4Receipt: Sendable {
    let nonce: String, revision: Int, ordinal: Int, sequence: Int, manifest: String, sha256: String
}

actor HistoryV4WriteGate {
    private var released = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    func wait() async { if !released { await withCheckedContinuation { waiters.append($0) } } }
    func release() { released = true; for waiter in waiters { waiter.resume() }; waiters.removeAll() }
}

/// One actor owns all filesystem state and encoding. Its messages contain immutable typed values only.
actor HistoryV4SegmentWriter {
    static let schema = "history-native-segments-v4"
    private let directory: URL
    private var segments: [HistoryV4Segment] = []
    private var ordinal = 0, sequence = 0, revision = 0
    private var failed = false
    private var fenceNonces: Set<String> = []
    // Pure I/O fault injection, never an observer closure or UIKit reference.
    enum Fault: Sendable { case none, write, manifest }
    private let fault: Fault
    private let gate: HistoryV4WriteGate?
    init(directory: URL, fault: Fault = .none, gate: HistoryV4WriteGate? = nil) throws {
        self.directory = directory; self.fault = fault; self.gate = gate
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        guard try FileManager.default.contentsOfDirectory(atPath: directory.path).isEmpty else { throw HistoryV4Error.invalid("fresh_directory_required") }
    }
    static func hash(_ bytes: Data) -> String { SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined() }

    private func atomic(_ bytes: Data, name: String) throws {
        let destination = directory.appendingPathComponent(name), temporary = directory.appendingPathComponent("." + name + ".pending")
        guard !FileManager.default.fileExists(atPath: destination.path) else { throw HistoryV4Error.invalid("immutable_file_exists") }
        let fd = open(temporary.path, O_WRONLY | O_CREAT | O_EXCL, S_IRUSR | S_IWUSR)
        guard fd >= 0 else { throw HistoryV4Error.invalid("open_failed") }
        var closed = false
        defer { if !closed { close(fd) }; try? FileManager.default.removeItem(at: temporary) }
        try bytes.withUnsafeBytes { buffer in
            var offset = 0
            while offset < buffer.count {
                let count = Darwin.write(fd, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
                if count < 0 && errno == EINTR { continue }
                guard count > 0 else { throw HistoryV4Error.invalid("write_failed") }
                offset += count
            }
        }
        guard fsync(fd) == 0 else { throw HistoryV4Error.invalid("file_sync_failed") }
        guard close(fd) == 0 else { closed = true; throw HistoryV4Error.invalid("close_failed") }; closed = true
        guard rename(temporary.path, destination.path) == 0 else { throw HistoryV4Error.invalid("rename_failed") }
        let dir = open(directory.path, O_RDONLY); guard dir >= 0 else { throw HistoryV4Error.invalid("directory_open_failed") }
        defer { close(dir) }
        guard fsync(dir) == 0 else { throw HistoryV4Error.invalid("directory_sync_failed") }
    }

    func append(_ records: [HistoryV4Record]) async throws {
        if let gate { await gate.wait() }
        try autoreleasepool { try appendBatch(records) }
    }
    private func appendBatch(_ records: [HistoryV4Record]) throws {
        guard !failed, !records.isEmpty, records.count <= 4096, segments.count < 25000 else { throw HistoryV4Error.invalid("writer_state_or_batch") }
        do {
            if fault == .write { throw HistoryV4Error.invalid("injected_write") }
            var bytes = Data("HNSV4\n".utf8), nextOrdinal = ordinal, nextSequence = sequence
            for record in records {
                guard record.ordinal == nextOrdinal + 1, record.sequence >= nextSequence else { throw HistoryV4Error.invalid("record_order") }
                if record.kind == "frame" {
                    guard record.sequence == nextSequence + 1, record.sequence <= 18000, record.value["sequence"]?.int == record.sequence else { throw HistoryV4Error.invalid("frame_order") }
                    nextSequence = record.sequence
                } else { guard ["event", "control", "clock", "host", "terminator"].contains(record.kind), record.sequence == nextSequence else { throw HistoryV4Error.invalid("record_kind_or_sequence") } }
                let wire = record.wire, size = try wire.wireByteCount()
                guard bytes.count + size + 4 <= 128 * 1024 * 1024 else { throw HistoryV4Error.invalid("batch_wire_budget") }
                var payload = Data(); payload.reserveCapacity(size); wire.encode(into: &payload)
                for shift in [24, 16, 8, 0] { bytes.append(UInt8(truncatingIfNeeded: UInt32(payload.count) >> shift)) }
                bytes.append(payload); nextOrdinal += 1
            }
            let name = String(format: "segment-%06d.hns4", segments.count + 1)
            try atomic(bytes, name: name)
            let descriptor = HistoryV4Segment(file: name, sha256: Self.hash(bytes), bytes: bytes.count, firstOrdinal: ordinal + 1, lastOrdinal: nextOrdinal, lastSequence: nextSequence)
            let index = try JSONEncoder().encode(descriptor)
            try atomic(index, name: name + ".json")
            segments.append(descriptor); ordinal = nextOrdinal; sequence = nextSequence
        } catch { failed = true; throw error }
    }

    func fence(_ fence: HistoryV4Fence) throws -> HistoryV4Receipt {
        try autoreleasepool { try publishFence(fence) }
    }
    private func publishFence(_ fence: HistoryV4Fence) throws -> HistoryV4Receipt {
        guard !failed, fence.ordinal == ordinal, fence.sequence == sequence, fence.revision == revision + 1,
              UUID(uuidString: fence.nonce) != nil, !fenceNonces.contains(fence.nonce.lowercased()), fenceNonces.count < 25000 else { throw HistoryV4Error.invalid("fence_prefix_or_revision") }
        do {
            if fault == .manifest { throw HistoryV4Error.invalid("injected_manifest") }
            struct Manifest: Encodable {
                let schema: String, nonce: String, revision: Int, lastOrdinal: Int, lastSequence: Int
                let segments: [HistoryV4Segment]
                let metadataFile: String, metadataSHA256: String
            }
            let prefix = String(format: "fence-%06d", fence.revision)
            _ = try fence.metadata.wireByteCount()
            var metadata = Data(); fence.metadata.encode(into: &metadata)
            try atomic(metadata, name: prefix + ".metadata.hns4")
            let manifest = Manifest(schema: Self.schema, nonce: fence.nonce, revision: fence.revision, lastOrdinal: ordinal, lastSequence: sequence,
                segments: segments, metadataFile: prefix + ".metadata.hns4", metadataSHA256: Self.hash(metadata))
            let bytes = try JSONEncoder().encode(manifest), name = prefix + ".json"
            try atomic(bytes, name: name)
            revision = fence.revision
            fenceNonces.insert(fence.nonce.lowercased())
            return HistoryV4Receipt(nonce: fence.nonce, revision: revision, ordinal: ordinal, sequence: sequence, manifest: name, sha256: Self.hash(bytes))
        } catch { failed = true; throw error }
    }
}
