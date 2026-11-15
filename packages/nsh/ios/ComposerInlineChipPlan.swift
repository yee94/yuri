import Foundation
import CoreFoundation

/**
 * Pure validation for `yuri.composer.inlineChips`. Kept UIKit-free so the
 * production rules run in the same checks as the bridge without an engine.
 *
 * The Input keeps the logical text. Each chip is the stored `@` trigger plus
 * its display range: the bridge attaches an icon to `start` and tints
 * `start + 1 ..< end`, never inserting a character.
 */
enum ComposerInlineChipPlan {
    struct Chip: Equatable {
        let start: Int
        let end: Int
        let kind: String
        let icon: String
        let color: String
    }

    struct Config: Equatable {
        let ownerID: String
        let inputID: String
        let textLength: Int
        let chips: [Chip]
    }

    static let kinds: Set<String> = ["file", "directory", "agent", "skill", "session"]
    static let icons: Set<String> = ["file", "folder", "ai-agent", "book-open", "chat-thread"]
    private static let hex = try! NSRegularExpression(pattern: "^#(?:[0-9a-fA-F]{6})$")

    static func parse(_ value: Any?) -> Config? {
        guard let data = value as? [String: Any] else { return nil }
        guard let ownerID = data["ownerID"] as? String, !ownerID.isEmpty,
              ownerID.utf16.count <= 256,
              let inputID = data["inputID"] as? String, !inputID.isEmpty,
              inputID.utf16.count <= 256,
              let textLength = integer(data["textLength"]), textLength >= 0, textLength <= 4_000_000,
              let rows = data["chips"] as? [Any], rows.count <= 64 else { return nil }
        var chips: [Chip] = []
        chips.reserveCapacity(rows.count)
        for row in rows {
            guard let chip = row as? [String: Any],
                  let start = integer(chip["start"]), let end = integer(chip["end"]),
                  start >= 0, end > start, end <= textLength, end - start >= 2,
                  let kind = chip["kind"] as? String, kinds.contains(kind),
                  let icon = chip["icon"] as? String, icons.contains(icon),
                  let color = chip["color"] as? String,
                  hex.firstMatch(in: color, range: NSRange(location: 0, length: color.utf16.count)) != nil,
                  chips.last.map({ start >= $0.end }) ?? true else { continue }
            chips.append(Chip(start: start, end: end, kind: kind, icon: icon, color: color))
        }
        return Config(ownerID: ownerID, inputID: inputID, textLength: textLength, chips: chips)
    }

    private static func integer(_ value: Any?) -> Int? {
        if let number = value as? NSNumber {
            guard CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
            let double = number.doubleValue
            guard double.isFinite, double.rounded() == double, double >= Double(Int.min), double <= Double(Int.max) else { return nil }
            return Int(double)
        }
        if let string = value as? String, let parsed = Int(string) { return parsed }
        return nil
    }
}
