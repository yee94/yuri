import UIKit
import NativeShell

@MainActor extension ResourceWebPreviewBridge {
    func installView(on app: NshAppView, covered: @escaping (String?) -> Bool) {
        app.register(component: "yuri.resource.html") { [weak self] context in
            guard let self else { return ResourceHTMLUnavailableComponent() }
            return ResourceHTMLComponent(bridge: self, context: context, covered: covered)
        }
    }
}
@MainActor private final class ResourceHTMLUnavailableComponent: NshComponent {
    let view = UIView()
    func setProp(_ name: String, _ value: Any?) {}
}
@MainActor private final class ResourceHTMLComponent: NshComponent {
    let mount: ResourceWebPreviewMountView
    var view: UIView { mount }
    init(bridge: ResourceWebPreviewBridge, context: NshComponentContext, covered: @escaping (String?) -> Bool) {
        mount = ResourceWebPreviewMountView(bridge: bridge, failure: { context.emit("failed", ["owner": $0]) }, covered: covered)
    }
    func setProp(_ name: String, _ value: Any?) { if name == "config" { mount.update(value) } }
}

@MainActor extension ResourceBridge {
    func installPresentationAnchor(on app: NshAppView) {
        app.register(component: "yuri.resource.presentation") { [weak self] context in ResourcePresentationAnchor(bridge: self, context: context) }
    }
}
@MainActor private final class ResourcePresenterRegistrationView: UIView {
    var changed: (() -> Void)?
    override func didMoveToWindow() { super.didMoveToWindow(); changed?() }
    override func didMoveToSuperview() { super.didMoveToSuperview(); changed?() }
    override func layoutSubviews() { super.layoutSubviews(); changed?() }
}
/// Register only the Dialog actually containing this anchor. No topmost/window search.
@MainActor private final class ResourcePresentationAnchor: NshComponent {
    private let anchor = ResourcePresenterRegistrationView()
    var view: UIView { anchor }
    private weak var bridge: ResourceBridge?
    private let context: NshComponentContext, registration = UUID()
    private var owner: String?, expected: RuntimeHostScope?, ready = false, retired = false
    private weak var controller: UIViewController?
    private var opening = false, opened = false, closeRequested = false, closing = false, closed = false
    private var captured = false, closeAttempt = 0, failedAttempt: Int?
    init(bridge: ResourceBridge?, context: NshComponentContext) {
        self.bridge = bridge; self.context = context
        anchor.isUserInteractionEnabled = false
        anchor.changed = { [weak self] in self?.attach() }
    }
    func setProp(_ name: String, _ value: Any?) {
        if name == "closing" {
            closeRequested = value as? Bool == true
            attach(); dismissIfRequested(); return
        }
        if name == "closeAttempt", let attempt = value as? Int, attempt > closeAttempt {
            closeAttempt = attempt
            attach(); dismissIfRequested(); return
        }
        guard name == "config", owner == nil, let args = value as? [String: Any], Set(args.keys) == ["owner", "expectedHost"],
              let owner = args["owner"] as? String, !owner.isEmpty, let expected = try? RuntimeHostScope(args["expectedHost"]) else { return }
        self.owner = owner; self.expected = expected; attach()
    }
    private func attach() {
        if captured, anchor.window == nil, !closing, !closed { failClose("controller_detached") }
        if ready, anchor.window == nil, let owner, bridge?.ownsPresentation(owner) != true {
            retired = true; bridge?.unregisterPresenter(owner, registration: registration); return
        }
        guard !retired, anchor.window != nil, let owner, let expected else { return }
        if captured {
            guard let controller else { failClose("controller_released"); return }
            finishOpening(controller, owner: owner); dismissIfRequested(); return
        }
        var responder: UIResponder? = anchor
        while let current = responder {
            if let controller = current as? UIViewController, controller.presentingViewController != nil,
               let root = controller.viewIfLoaded, anchor.isDescendant(of: root) {
                self.controller = controller; captured = true
                do {
                    guard let bridge else { throw RuntimeHostScopeFailure.invalid }
                    try bridge.registerPresenter(owner, registration: registration, expectedHost: expected, controller: controller)
                    ready = true; context.emit("ready", ["owner": owner])
                } catch { context.emit("failed", ["owner": owner]) }
                // Cleanup belongs to the captured controller, not to Host action authority.
                finishOpening(controller, owner: owner)
                return
            }
            responder = current.next
        }
        failClose("controller_unavailable")
    }
    private func finishOpening(_ controller: UIViewController, owner: String) {
        guard !opening, !opened, failedAttempt != closeAttempt else { return }
        opening = true
        if let transition = controller.transitionCoordinator {
            let accepted = transition.animate(alongsideTransition: nil) { [weak self] result in
                guard let self else { return }
                self.opening = false
                guard !result.isCancelled else { self.failClose("opening_cancelled"); return }
                self.opened = true; self.context.emit("opened", ["owner": owner]); self.dismissIfRequested()
            }
            if !accepted { opening = false; failClose("opening_observer_rejected") }
        } else {
            guard !controller.isBeingPresented else { opening = false; failClose("opening_transition_unavailable"); return }
            opened = true; context.emit("opened", ["owner": owner]); dismissIfRequested()
        }
    }
    private func dismissIfRequested() {
        guard closeRequested, closeAttempt > 0, failedAttempt != closeAttempt, !closing, !closed else { return }
        guard captured else { return } // Retain a request made before the anchor attaches.
        guard let controller, let owner else { failClose("controller_released"); return }
        guard opened, !controller.isBeingPresented else { return } // Opening completion drains the intent.
        guard controller.presentingViewController?.presentedViewController === controller,
              controller.presentedViewController == nil else { failClose("controller_not_dismissible"); return }
        closing = true
        // Keep the JS Dialog and exact presenter registration live until UIKit's
        // real dismissal completion. Removing Dialog.open first loses onClose.
        controller.dismiss(animated: !UIAccessibility.isReduceMotionEnabled) { [self] in
            guard !closed else { return }
            closed = true; context.emit("closed", ["owner": owner])
        }
    }
    private func failClose(_ code: String) {
        guard closeRequested, closeAttempt > 0, failedAttempt != closeAttempt, !closed, let owner else { return }
        failedAttempt = closeAttempt
        context.emit("closeFailed", ["owner": owner, "attempt": closeAttempt, "code": code])
    }
    deinit {
        let owner = owner, registration = registration, bridge = bridge
        Task { @MainActor in if let owner { bridge?.unregisterPresenter(owner, registration: registration) } }
    }
}
