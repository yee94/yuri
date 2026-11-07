import UIKit
import NativeShell

@MainActor enum NativeSheetPresentation {
    static func install(on surface: NshAppView) {
        surface.register(component: "yuri.sheet.presentation") { SheetPresentationOwner(context: $0) }
    }
}

@MainActor private final class SheetRegistrationView: UIView {
    var changed: (() -> Void)?
    override func didMoveToSuperview() { super.didMoveToSuperview(); changed?() }
    override func didMoveToWindow() { super.didMoveToWindow(); changed?() }
    override func layoutSubviews() { super.layoutSubviews(); changed?() }
}

/// Configures only the exact Dialog containing this registration, not another window's modal.
@MainActor private final class SheetPresentationOwner: NSObject, NshComponent, UISheetPresentationControllerDelegate {
    private let registration = SheetRegistrationView(frame: .zero)
    var view: UIView { registration }
    private let context: NshComponentContext
    private weak var controller: UIViewController?
    private weak var previousDelegate: UIAdaptivePresentationControllerDelegate?
    private var generation = 0, detents: [CGFloat] = [0.5, 1], initial = 0
    private var dismissible = true, ready = false, opened = false, closing = false, finished = false, requested = false
    private var configured: [CGFloat] = [], configuredInitial = -1

    init(context: NshComponentContext) {
        self.context = context
        super.init()
        registration.isUserInteractionEnabled = false
        registration.isAccessibilityElement = false
        registration.accessibilityElementsHidden = true
        registration.changed = { [weak self] in self?.attach() }
    }
    func setProp(_ name: String, _ value: Any?) {
        switch name {
        case "generation": if generation == 0, let id = value as? Int, id > 0 { generation = id }
        case "detents":
            if let values = value as? [NSNumber] {
                let valid = values.map { CGFloat($0.doubleValue) }.filter { $0.isFinite && $0 > 0 && $0 <= 1 }
                if !valid.isEmpty { detents = Array(Set(valid)).sorted() }
            }
        case "initialDetent": initial = max(0, value as? Int ?? 0)
        case "dismissible": dismissible = value as? Bool ?? true
        default: break
        }
        attach()
    }
    func command(_ name: String, _ args: Any?) {
        guard name == "dismiss", let data = args as? [String: Any], data["generation"] as? Int == generation else { return }
        requested = true; dismiss()
    }
    private func emit(_ name: String, _ extra: [String: Any] = [:]) {
        context.emit(name, extra.merging(["generation": generation]) { _, new in new })
    }
    private func attach() {
        guard generation > 0, !finished else { return }
        if controller == nil {
            var responder: UIResponder? = registration
            while let current = responder {
                if let owner = current as? UIViewController, owner.presentingViewController != nil {
                    guard let root = owner.viewIfLoaded, registration.isDescendant(of: root) else { return }
                    controller = owner; break
                }
                responder = current.next
            }
        }
        guard let controller, let sheet = controller.sheetPresentationController else { return }
        controller.isModalInPresentation = !dismissible
        if sheet.delegate !== self { previousDelegate = sheet.delegate; sheet.delegate = self }
        sheet.prefersGrabberVisible = true
        sheet.prefersScrollingExpandsWhenScrolledToEdge = true
        sheet.prefersEdgeAttachedInCompactHeight = true
        sheet.widthFollowsPreferredContentSizeWhenEdgeAttached = true
        if configured != detents || (!ready && configuredInitial != initial) {
            configured = detents
            configuredInitial = initial
            if #available(iOS 16.0, *) {
                sheet.detents = detents.map { fraction in
                    .custom(identifier: .init("yuri-\(fraction)")) { context in context.maximumDetentValue * fraction }
                }
                sheet.selectedDetentIdentifier = sheet.detents[min(initial, sheet.detents.count - 1)].identifier
            } else {
                sheet.detents = [.medium(), .large()]
                sheet.selectedDetentIdentifier = initial == 0 ? .medium : .large
            }
        }
        guard registration.window != nil else { return }
        if !ready { ready = true; emit("ready") }
        if !opened {
            opened = true
            if let transition = controller.transitionCoordinator {
                transition.animate(alongsideTransition: nil) { [weak self] result in
                    guard let self, !result.isCancelled else { return }
                    self.emit("opened"); self.dismiss()
                }
            } else { emit("opened") }
        }
        if requested { dismiss() }
    }
    private func dismiss() {
        guard requested, !closing, !finished, let controller else { return }
        if controller.isBeingPresented {
            return // The presentation transition's completion drains the request.
        }
        guard controller.presentingViewController?.presentedViewController === controller else { return }
        closing = true
        controller.dismiss(animated: !UIAccessibility.isReduceMotionEnabled) { [self] in complete(interactive: false) }
    }
    private func complete(interactive: Bool) {
        guard !finished else { return }
        finished = true; emit("dismissed", ["interactive": interactive])
    }
    func presentationControllerShouldDismiss(_ presentationController: UIPresentationController) -> Bool { dismissible }
    func presentationControllerDidAttemptToDismiss(_ presentationController: UIPresentationController) { emit("cancel") }
    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        previousDelegate?.presentationControllerDidDismiss?(presentationController)
        complete(interactive: true)
    }
}
