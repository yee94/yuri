import UIKit
import NativeShell
import CoreFoundation

/// Explicit fixture opt-in only. Closed metadata projection; no source, URL or error strings.
final class NativeSheetLifecycleAudit {
    static let shared = NativeSheetLifecycleAudit()
    static let maxEntries = 32, maxBytes = 8192
    private let lock = NSLock()
    private var enabled = false, serial = 0, sequence = 0, bytes = 0, dropped = 0
    private var rows: [(value: [String: Any], bytes: Int)] = []
    func setEnabled(_ value: Bool) {
        lock.lock(); defer { lock.unlock() }
        enabled = value; serial = 0; sequence = 0; bytes = 0; dropped = 0; rows = []
    }
    func ticket() -> Int {
        lock.lock(); defer { lock.unlock() }
        guard enabled else { return 0 }
        serial += 1; return serial
    }
    static func project(_ value: Any?) -> [String: Any]? {
        let numbers = ["owner", "ticket", "intent", "ownerGeneration", "revision"], booleans = ["open", "active", "current"]
        guard let fields = value as? [String: Any], Set(fields.keys) == Set(numbers + booleans + ["status"]) else { return nil }
        var result: [String: Any] = [:]
        for key in numbers {
            guard let number = fields[key] as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite,
                  number.doubleValue >= 0, number.doubleValue <= 9_007_199_254_740_991, number.doubleValue.rounded() == number.doubleValue else { return nil }
            result[key] = number
        }
        for key in booleans {
            guard let number = fields[key] as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
            result[key] = number.boolValue
        }
        guard let status = fields["status"] as? String, ["none", "pending", "complete", "failed", "cancelled"].contains(status) else { return nil }
        result["status"] = status; return result
    }
    func record(_ phase: String, ticket: Int, generation: Int, metadata: [String: Any], flags: [String: Bool] = [:]) {
        lock.lock(); defer { lock.unlock() }
        guard enabled, ticket > 0, generation >= 0,
              ["metadata", "metadata-rejected", "attach", "ready", "opened", "dismiss-command", "dismissed", "cancel", "released"].contains(phase),
              metadata.isEmpty || Self.project(metadata) != nil,
              Set(flags.keys).isSubset(of: ["window", "controller", "presenting", "presented", "ready", "opened", "closing", "requested"]) else { return }
        sequence += 1
        let value: [String: Any] = ["phase": phase, "nativeTicket": ticket, "generation": generation, "sequence": sequence,
                                   "nativeUptimeMs": ProcessInfo.processInfo.systemUptime * 1000, "metadata": metadata, "flags": flags]
        guard let data = try? JSONSerialization.data(withJSONObject: value), data.count <= Self.maxBytes else { dropped += 1; return }
        while !rows.isEmpty && (rows.count >= Self.maxEntries || bytes + data.count > Self.maxBytes) {
            bytes -= rows.removeFirst().bytes; dropped += 1
        }
        rows.append((value, data.count)); bytes += data.count
    }
    var snapshot: [String: Any] {
        lock.lock(); defer { lock.unlock() }
        return ["schema": 1, "enabled": enabled, "sequence": sequence, "dropped": dropped, "bytes": bytes,
                "maxEntries": Self.maxEntries, "maxBytes": Self.maxBytes, "events": rows.map { $0.value }]
    }
}

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
    private var viewportDetents = false, configuredViewportDetents = false
    private let auditTicket = NativeSheetLifecycleAudit.shared.ticket()
    private var diagnostic: [String: Any] = [:]
    private var lastAttachment: [String: Bool]?

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
        case "viewportDetents": viewportDetents = value as? Bool ?? false
        case "dismissible": dismissible = value as? Bool ?? true
        case "diagnostic":
            if auditTicket > 0 {
                if let projected = NativeSheetLifecycleAudit.project(value) {
                    if !NSDictionary(dictionary: diagnostic).isEqual(to: projected) { diagnostic = projected; trace("metadata") }
                } else if value != nil { trace("metadata-rejected") }
            }
        default: break
        }
        attach()
    }
    func command(_ name: String, _ args: Any?) {
        guard name == "dismiss", let data = args as? [String: Any], data["generation"] as? Int == generation else { return }
        requested = true; trace("dismiss-command"); dismiss()
    }
    private func emit(_ name: String, _ extra: [String: Any] = [:]) {
        trace(name)
        context.emit(name, extra.merging(["generation": generation]) { _, new in new })
    }
    private var auditFlags: [String: Bool] {
        ["window": registration.window != nil, "controller": controller != nil, "presenting": controller?.isBeingPresented == true,
         "presented": controller?.presentingViewController?.presentedViewController === controller && controller != nil,
         "ready": ready, "opened": opened, "closing": closing, "requested": requested]
    }
    private func trace(_ phase: String) {
        guard auditTicket > 0 else { return }
        NativeSheetLifecycleAudit.shared.record(phase, ticket: auditTicket, generation: generation, metadata: diagnostic, flags: auditFlags)
    }
    deinit { NativeSheetLifecycleAudit.shared.record("released", ticket: auditTicket, generation: generation, metadata: diagnostic) }
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
        if auditTicket > 0 {
            let attachment = auditFlags
            if lastAttachment != attachment { lastAttachment = attachment; trace("attach") }
        }
        guard let controller, let sheet = controller.sheetPresentationController else { return }
        controller.isModalInPresentation = !dismissible
        if sheet.delegate !== self { previousDelegate = sheet.delegate; sheet.delegate = self }
        sheet.prefersGrabberVisible = true
        sheet.prefersScrollingExpandsWhenScrolledToEdge = true
        sheet.prefersEdgeAttachedInCompactHeight = true
        sheet.widthFollowsPreferredContentSizeWhenEdgeAttached = true
        if configured != detents || configuredViewportDetents != viewportDetents || (!ready && configuredInitial != initial) {
            configured = detents
            configuredInitial = initial
            configuredViewportDetents = viewportDetents
            if #available(iOS 16.0, *) {
                let viewport = viewportDetents
                sheet.detents = detents.map { fraction in
                    .custom(identifier: .init("yuri-\(fraction)")) { [weak controller] context in
                        let reference = viewport ? controller?.viewIfLoaded?.window?.bounds.height ?? context.maximumDetentValue : context.maximumDetentValue
                        return min(context.maximumDetentValue, reference * fraction)
                    }
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
