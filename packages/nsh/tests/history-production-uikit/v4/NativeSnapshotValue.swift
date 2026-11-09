import Foundation
import Darwin

/// Exact native container adapters for public-read values. Fallback keeps the existing rejection/bit contract.
@MainActor enum HistoryV4NativeSnapshotValue {
    static func freeze(_ value: Any) throws -> HistorySnapshotValue {
        let kind = type(of: value)
        if kind == HistorySnapshotValue.self, let frozen = value as? HistorySnapshotValue { return frozen }
        if kind == [String: HistorySnapshotValue].self, let object = value as? [String: HistorySnapshotValue] { return .object(object) }
        if kind == [HistorySnapshotValue].self, let array = value as? [HistorySnapshotValue] { return .array(array) }
        if kind == NSNull.self { return .null }
        if kind == [String: Any].self, let object = value as? [String: Any] {
            return .object(try object.mapValues { try freeze($0) })
        }
        if kind == [[String: Any]].self, let array = value as? [[String: Any]] {
            return .array(try array.map { try freeze($0) })
        }
        if kind == [String: CGFloat].self, let object = value as? [String: CGFloat] {
            return .object(object.mapValues { .doubleBits(Double($0).bitPattern) })
        }
        if kind == [CGFloat].self, let array = value as? [CGFloat] {
            return .array(array.map { .doubleBits(Double($0).bitPattern) })
        }
        if kind == [String].self, let array = value as? [String] {
            return .array(array.map { .string($0) })
        }
        if kind == [String: Double].self, let object = value as? [String: Double] {
            return .object(object.mapValues { .doubleBits($0.bitPattern) })
        }
        if kind == [String: Int].self, let object = value as? [String: Int] {
            return .object(object.mapValues { .integer(Int64($0)) })
        }
        return try HistorySnapshotValue.freeze(value)
    }

    static func threadCPUms() -> Double? {
        var time = timespec()
        guard clock_gettime(CLOCK_THREAD_CPUTIME_ID, &time) == 0 else { return nil }
        return Double(time.tv_sec) * 1000 + Double(time.tv_nsec) / 1_000_000
    }
}
