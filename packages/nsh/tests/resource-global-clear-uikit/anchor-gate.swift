// Appended after the unchanged production ResourceHTMLComponents.swift in a
// fixture-only compilation unit. Accesses its private factory, never its state.
@MainActor private final class GlobalClearCarrier: UIView {
    var changed: (() -> Void)?
    override func didMoveToWindow() { super.didMoveToWindow(); changed?() }
    override func layoutSubviews() { super.layoutSubviews(); changed?() }
}
@MainActor private final class GlobalClearAnchorGate: NshComponent {
    private let carrier = GlobalClearCarrier(), actual: ResourcePresentationAnchor
    private let audit: GlobalClearAudit
    private let revoke: () -> Void
    private weak var captured: UIViewController?
    private var held: Bool, configured = false, mounted = false, attached = false, closing = false, attempt = 0
    var view: UIView { carrier }
    init(bridge: ResourceBridge, context: NshComponentContext, audit: GlobalClearAudit, revoke: @escaping () -> Void) {
        actual = ResourcePresentationAnchor(bridge: bridge, context: context); self.audit = audit; self.revoke = revoke
        held = audit.controlsEnabled && audit.armed
        if held { audit.armed = false; audit.applied = false }
        carrier.isUserInteractionEnabled = false
        carrier.changed = { [weak self] in self?.attachStage() }
        if !held { attached = true; carrier.addSubview(actual.view) }
        audit.changed = { [weak self] in self?.releaseIfReady() }
    }
    func setProp(_ name: String, _ value: Any?) {
        if name == "config", let args = value as? [String: Any], let owner = args["owner"] as? String {
            configured = true
            audit.owner = owner; audit.generation = Int(owner.split(separator: "_").last ?? "") ?? 0
        }
        if name == "closing" { closing = value as? Bool == true }
        if name == "closeAttempt", let number = value as? Int { attempt = number; audit.attempt = number }
        actual.setProp(name, value)
        if held, closing, attempt > 0 { audit.record(.closeIntent); releaseIfReady() }
        attachStage()
    }
    private func attachStage() {
        guard held, configured, !mounted, carrier.window != nil else { return }
        var next: UIResponder? = carrier
        while let responder = next {
            if let controller = responder as? UIViewController, controller.presentingViewController != nil,
               let root = controller.viewIfLoaded, carrier.isDescendant(of: root) {
                mounted = true; captured = controller; audit.controllerToken = audit.controller(controller)
                audit.record(.controllerMounted)
                guard actual.view.window == nil else { audit.record(.gateMissed); return }
                audit.record(.preAttachConfirmed); revoke(); releaseIfReady(); return
            }
            next = responder.next
        }
    }
    private func releaseIfReady() {
        guard held, mounted, !attached, closing, attempt > 0, audit.applied,
              let controller = captured, controller.presentingViewController != nil else { return }
        attached = true; audit.record(.anchorAttached)
        // UIKit delivers the real anchor's lifecycle after this insertion.
        carrier.addSubview(actual.view)
    }
}
@MainActor func installGlobalClearAnchorGate(on surface: NshAppView, resources: ResourceBridge, audit: GlobalClearAudit, revoke: @escaping () -> Void) {
    surface.register(component: "yuri.resource.presentation") { context in
        GlobalClearAnchorGate(bridge: resources, context: context, audit: audit, revoke: revoke)
    }
}
