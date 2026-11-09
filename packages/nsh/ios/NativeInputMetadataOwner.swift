import UIKit
import NativeShell

@MainActor enum NativeInputMetadataOwner {
    static func install(on surface: NshAppView) {
        surface.register(component: "yuri.input.metadata") { InputMetadataOwner(context: $0) }
    }
}

@MainActor private final class InputMetadataRegistration: UIView {
    var changed: (() -> Void)?
    override func didMoveToSuperview() { super.didMoveToSuperview(); changed?() }
    override func didMoveToWindow() { super.didMoveToWindow(); changed?() }
    override func layoutSubviews() { super.layoutSubviews(); changed?() }
}

@MainActor private final class InputMetadataOwner: NshComponent {
    private let registration = InputMetadataRegistration(frame: .zero)
    var view: UIView { registration }
    private let binding: NativeInputMetadataBinding<UIView>
    private var observers: [NSObjectProtocol] = []

    init(context: NshComponentContext) {
        binding = NativeInputMetadataBinding(registration: registration, access: .init(
            parent: { $0.superview }, children: { $0.subviews }, window: { $0.window },
            kind: { $0 is UITextView ? "multiline" : $0 is UITextField ? "singleline" : nil },
            identifier: { $0.accessibilityIdentifier }, label: { $0.accessibilityLabel },
            writeIdentifier: { $0.accessibilityIdentifier = $1 }, writeLabel: { $0.accessibilityLabel = $1 }
        ))
        registration.isAccessibilityElement = false
        registration.accessibilityElementsHidden = true
        registration.isUserInteractionEnabled = false
        registration.changed = { [weak self] in self?.changed() }
        for name in [UIApplication.willResignActiveNotification, UIApplication.didEnterBackgroundNotification, UIApplication.didBecomeActiveNotification] {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] event in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.binding.lifecycle(event.name == UIApplication.didBecomeActiveNotification)
                    self.retry()
                }
            })
        }
        binding.lifecycle(UIApplication.shared.applicationState == .active)
    }
    deinit {
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        binding.retire()
    }
    func setProp(_ name: String, _ value: Any?) {
        guard name == "config" else { return }
        binding.update(value); retry()
    }
    private func changed() { binding.changed(); retry() }
    private func retry() {
        binding.enqueue { work in DispatchQueue.main.async { work() } }
    }
}
