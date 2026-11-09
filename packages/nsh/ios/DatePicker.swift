import Foundation

struct NativeDatePickerConfiguration {
    var localeIdentifier: String = Locale.current.identifier
    var firstDayOfWeek: Int?
    var minimumDate: String?
    var maximumDate: String?

    func calendar(timeZone: TimeZone = .current) -> Calendar {
        var value = Calendar(identifier: .gregorian)
        value.locale = Locale(identifier: localeIdentifier)
        value.timeZone = timeZone
        if let firstDayOfWeek { value.firstWeekday = firstDayOfWeek + 1 }
        return value
    }
    static func date(_ text: String, timeZone: TimeZone = .current) -> Date? {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = timeZone
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.isLenient = false
        guard let value = formatter.date(from: text), formatter.string(from: value) == text else { return nil }
        return value
    }
    mutating func setProp(_ name: String, _ value: Any?) -> Bool {
        let cleared = value == nil || value is NSNull
        switch name {
        case "firstDayOfWeek":
            if cleared { firstDayOfWeek = nil; return true }
            guard let day = value as? Int, (0...6).contains(day) else { return false }
            firstDayOfWeek = day
        case "localeIdentifier":
            if cleared { localeIdentifier = Locale.current.identifier; return true }
            guard let identifier = value as? String, !identifier.isEmpty, identifier.utf8.count <= 128 else { return false }
            localeIdentifier = identifier
        case "minimumDate", "maximumDate":
            let text: String?
            if cleared { text = nil }
            else { guard let candidate = value as? String, Self.date(candidate) != nil else { return false }; text = candidate }
            if name == "minimumDate" { minimumDate = text } else { maximumDate = text }
        default: return false
        }
        return true
    }
}

#if canImport(UIKit) && canImport(NativeShell)
import UIKit
import NativeShell

@MainActor enum NativeDatePicker {
    static func install(on surface: NshAppView) {
        surface.register(component: "yuri.datePicker") { DatePickerOwner(context: $0) }
    }
}

@MainActor private final class DatePickerOwner: NSObject, NshComponent {
    private let picker = UIDatePicker()
    var view: UIView { picker }
    private let context: NshComponentContext
    private var configuration = NativeDatePickerConfiguration()
    private var selectedDate: String?
    private let formatter: DateFormatter = {
        let value = DateFormatter()
        value.locale = Locale(identifier: "en_US_POSIX")
        value.calendar = Calendar(identifier: .gregorian)
        value.timeZone = .current
        value.dateFormat = "yyyy-MM-dd"
        value.isLenient = false
        return value
    }()
    init(context: NshComponentContext) {
        self.context = context; super.init()
        picker.datePickerMode = .date
        picker.preferredDatePickerStyle = .inline
        picker.addTarget(self, action: #selector(changed), for: .valueChanged)
    }
    func setProp(_ name: String, _ value: Any?) {
        if name == "value" {
            guard let text = value as? String, NativeDatePickerConfiguration.date(text) != nil else { return }
            selectedDate = text
        } else if !configuration.setProp(name, value) { return }
        picker.locale = Locale(identifier: configuration.localeIdentifier)
        picker.calendar = configuration.calendar()
        picker.timeZone = .current
        picker.minimumDate = configuration.minimumDate.flatMap { NativeDatePickerConfiguration.date($0) }
        picker.maximumDate = configuration.maximumDate.flatMap { NativeDatePickerConfiguration.date($0) }
        if let selectedDate, let date = NativeDatePickerConfiguration.date(selectedDate) { picker.setDate(date, animated: false) }
    }
    @objc private func changed() { context.emit("change", ["value": formatter.string(from: picker.date)]) }
}
#endif
