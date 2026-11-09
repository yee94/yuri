import Foundation
import CoreFoundation

enum HistoryV4Error: Error { case invalid(String) }

// Recognize native containers without attempting an Objective-C class cast first. Such a cast
// can recursively bridge an entire Swift dictionary/array just to discover it is not NSNumber.
private protocol HistorySnapshotArrayCopy { @MainActor func snapshotCopy() throws -> HistorySnapshotValue }
private protocol HistorySnapshotObjectCopy { @MainActor func snapshotCopy() throws -> HistorySnapshotValue }
extension Array: HistorySnapshotArrayCopy {
    @MainActor fileprivate func snapshotCopy() throws -> HistorySnapshotValue { .array(try map { try HistorySnapshotValue.freeze($0) }) }
}
extension Dictionary: HistorySnapshotObjectCopy where Key == String {
    @MainActor fileprivate func snapshotCopy() throws -> HistorySnapshotValue { .object(try mapValues { try HistorySnapshotValue.freeze($0) }) }
}

/// The only cross-executor payload. No Any, Foundation reference containers, UI object, or closure is stored.
indirect enum HistorySnapshotValue: Sendable, Equatable {
    case null, bool(Bool), integer(Int64), doubleBits(UInt64), string(String)
    case array([HistorySnapshotValue]), object([String: HistorySnapshotValue])

    var object: [String: HistorySnapshotValue]? { if case let .object(value) = self { return value }; return nil }
    var int: Int? { if case let .integer(value) = self { return Int(exactly: value) }; return nil }
    var string: String? { if case let .string(value) = self { return value }; return nil }
    subscript(_ key: String) -> HistorySnapshotValue? { object?[key] }

    // Deliberately conservative allocator accounting; validated against process RSS at actual deep-payload scale.
    var allocationBudget: Int {
        switch self {
        case .null, .bool, .integer, .doubleBits: return 64
        case let .string(value): return 96 + value.utf8.count * 2
        case let .array(values): return 128 + values.reduce(0) { $0 + 64 + $1.allocationBudget }
        case let .object(values): return 256 + values.reduce(0) { $0 + 192 + $1.key.utf8.count * 2 + $1.value.allocationBudget }
        }
    }

    /// Synchronous main-actor copy of existing public-read output. Unknown values fail; no description/getter fallback.
    @MainActor static func freeze(_ value: Any) throws -> HistorySnapshotValue {
        let valueType = type(of: value)
        // NSNumber bridging canonicalizes a native Double NaN payload on Darwin; copy native bits first.
        if valueType == Double.self, let number = value as? Double { return .doubleBits(number.bitPattern) }
        if valueType == CGFloat.self, let number = value as? CGFloat { return .doubleBits(Double(number).bitPattern) }
        if valueType == Float.self, let number = value as? Float { return .doubleBits(Double(number).bitPattern) }
        if valueType == Int.self, let number = value as? Int { return .integer(Int64(number)) }
        if valueType == Bool.self, let boolean = value as? Bool { return .bool(boolean) }
        if valueType == String.self, let string = value as? String { return .string(string) }
        if let array = value as? any HistorySnapshotArrayCopy { return try array.snapshotCopy() }
        if let object = value as? any HistorySnapshotObjectCopy { return try object.snapshotCopy() }
        if value is NSNull { return .null }
        if let number = value as? NSNumber {
            if CFGetTypeID(number) == CFBooleanGetTypeID() { return .bool(number.boolValue) }
            let kind = number.objCType.pointee
            if kind == 102 || kind == 100 { return .doubleBits(number.doubleValue.bitPattern) }
            if kind == 81 && number.uint64Value > UInt64(Int64.max) { throw HistoryV4Error.invalid("integer_range") }
            return .integer(number.int64Value)
        }
        if let string = value as? String { return .string(String(string)) }
        if let array = value as? [Any] { return .array(try array.map { try freeze($0) }) }
        if let object = value as? [String: Any] { return .object(try object.mapValues { try freeze($0) }) }
        throw HistoryV4Error.invalid("non_value_snapshot")
    }

    /// v4's typed TLV encoding preserves every Double bit (including -0, NaN payloads and infinity).
    func wireByteCount(limit: Int = 64 * 1024 * 1024, depth: Int = 0) throws -> Int {
        var nodes = 250000
        return try measureWire(limit: limit, depth: depth, nodes: &nodes)
    }
    private func measureWire(limit: Int, depth: Int, nodes: inout Int) throws -> Int {
        nodes -= 1
        guard depth < 128, limit >= 1, nodes >= 0 else { throw HistoryV4Error.invalid("wire_value_budget") }
        let size: Int
        switch self {
        case .null, .bool: size = 1
        case .integer, .doubleBits: size = 9
        case let .string(value): size = 5 + value.utf8.count
        case let .array(values):
            var total = 5
            for value in values { total += try value.measureWire(limit: limit - total, depth: depth + 1, nodes: &nodes) }
            size = total
        case let .object(values):
            var total = 5
            for (key, value) in values {
                total += 4 + key.utf8.count
                total += try value.measureWire(limit: limit - total, depth: depth + 1, nodes: &nodes)
            }
            size = total
        }
        guard size <= limit else { throw HistoryV4Error.invalid("wire_value_budget") }
        return size
    }
    func encode(into output: inout Data) {
        func word(_ value: UInt64, bytes: Int) { for shift in stride(from: (bytes - 1) * 8, through: 0, by: -8) { output.append(UInt8(truncatingIfNeeded: value >> shift)) } }
        func text(_ value: String) { let bytes = Data(value.utf8); word(UInt64(bytes.count), bytes: 4); output.append(bytes) }
        switch self {
        case .null: output.append(0)
        case let .bool(value): output.append(value ? 2 : 1)
        case let .integer(value): output.append(3); word(UInt64(bitPattern: value), bytes: 8)
        case let .doubleBits(value): output.append(4); word(value, bytes: 8)
        case let .string(value): output.append(5); text(value)
        case let .array(values):
            output.append(6); word(UInt64(values.count), bytes: 4)
            for value in values { value.encode(into: &output) }
        case let .object(values):
            output.append(7); word(UInt64(values.count), bytes: 4)
            for key in values.keys.sorted() { text(key); values[key]!.encode(into: &output) }
        }
    }

    static func periodic(_ source: HistorySnapshotValue) throws -> HistorySnapshotValue {
        guard var frame = source.object, let seq = frame["sequence"]?.int,
              let window = frame["windowObservation"], window["sequence"]?.int == seq,
              var identity = frame["diagnosticIdentity"]?.object,
              identity["observationKind"]?.string == "periodic", identity["windowObservation"] == window,
              identity["windowObservationRef"] == nil else { throw HistoryV4Error.invalid("same_seq_reference") }
        identity.removeValue(forKey: "windowObservation"); identity["windowObservationRef"] = .integer(Int64(seq))
        frame["diagnosticIdentity"] = .object(identity)
        return .object(frame)
    }
}

struct HistoryV4Record: Sendable {
    let ordinal: Int
    let kind: String
    let sequence: Int
    let value: HistorySnapshotValue
    let allocatorBytes: Int
    init(ordinal: Int, kind: String, sequence: Int, value: HistorySnapshotValue) {
        self.ordinal = ordinal; self.kind = kind; self.sequence = sequence; self.value = value
        allocatorBytes = value.allocationBudget + 512
    }
    var wire: HistorySnapshotValue { .object(["ordinal": .integer(Int64(ordinal)), "kind": .string(kind), "sequence": .integer(Int64(sequence)), "value": value]) }
}
