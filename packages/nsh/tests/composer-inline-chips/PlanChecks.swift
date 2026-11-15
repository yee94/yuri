import Foundation

@main
struct ComposerInlineChipPlanChecks {
    static func main() {
        var passed = 0
        func check(_ value: Bool, _ name: String) {
            if !value { fatalError("failed: \(name)") }
            passed += 1
        }
        let valid: [String: Any] = [
            "ownerID": "composer-glass", "inputID": "composer", "textLength": 12,
            "chips": [
                ["start": 0, "end": 9, "kind": "file", "icon": "file", "color": "#112233"],
                ["start": 10, "end": 12, "kind": "skill", "icon": "book-open", "color": "#ff8800"],
            ],
        ]
        let config = ComposerInlineChipPlan.parse(valid)
        check(config != nil, "valid config")
        check(config?.chips.count == 2, "two chips")
        check(config?.chips.first?.start == 0 && config?.chips.first?.end == 9, "first range")
        let inactive: [String: Any] = ["ownerID": "o", "inputID": "i", "textLength": 20, "chips": []]
        check(ComposerInlineChipPlan.parse(inactive)?.chips.isEmpty == true, "inactive has no chips")
        check(ComposerInlineChipPlan.parse(inactive)?.textLength == 20, "inactive keeps the real length")
        check(ComposerInlineChipPlan.parse(nil) == nil, "nil rejected")
        check(ComposerInlineChipPlan.parse(["ownerID": "", "inputID": "composer", "textLength": 1, "chips": []]) == nil, "empty owner")
        check(ComposerInlineChipPlan.parse(["ownerID": "o", "inputID": "i", "textLength": true, "chips": []]) == nil, "boolean length")
        check(ComposerInlineChipPlan.parse(["ownerID": "o", "inputID": "i", "textLength": 1.5, "chips": []]) == nil, "fractional length")
        check(ComposerInlineChipPlan.parse(["ownerID": "o", "inputID": "i", "textLength": 10, "chips": Array(repeating: ["start": 0, "end": 2, "kind": "file", "icon": "file", "color": "#000000"], count: 65)]) == nil, "over 64")
        let invalid: [String: Any] = [
            "ownerID": "o", "inputID": "i", "textLength": 20,
            "chips": [
                ["start": 5, "end": 5, "kind": "file", "icon": "file", "color": "#000000"],
                ["start": 6, "end": 21, "kind": "file", "icon": "file", "color": "#000000"],
                ["start": 0, "end": 3, "kind": "unknown", "icon": "file", "color": "#000000"],
                ["start": 4, "end": 7, "kind": "file", "icon": "unknown", "color": "#000000"],
                ["start": 8, "end": 11, "kind": "file", "icon": "file", "color": "red"],
                ["start": 12, "end": 15, "kind": "agent", "icon": "ai-agent", "color": "#00ff00"],
            ],
        ]
        check(ComposerInlineChipPlan.parse(invalid)?.chips.count == 1, "invalid rows dropped")
        check(ComposerInlineChipPlan.parse(invalid)?.chips.first?.kind == "agent", "remaining row")
        print("\(passed) composer inline chip plan checks passed")
    }
}
