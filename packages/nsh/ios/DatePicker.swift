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
        guard name == "value", let text = value as? String, let date = formatter.date(from: text), formatter.string(from: date) == text else { return }
        picker.setDate(date, animated: false)
    }
    @objc private func changed() { context.emit("change", ["value": formatter.string(from: picker.date)]) }
}
