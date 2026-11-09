import Foundation

// A deterministic platform boundary for executing the unchanged production
// anchor and registerPresenter bodies on macOS. This is not a UIKit simulator.
@MainActor class UIResponder { var next: UIResponder? }
@MainActor class UIView: UIResponder {
    var window: UIView?, superview: UIView?
    var isUserInteractionEnabled = true
    func didMoveToWindow() {}
    func didMoveToSuperview() {}
    func layoutSubviews() {}
    func isDescendant(of root: UIView) -> Bool {
        var current: UIView? = self
        while let value = current { if value === root { return true }; current = value.superview }
        return false
    }
}
struct TransitionResult { let isCancelled: Bool }
@MainActor final class Transition {
    var accepted = true
    var completion: ((TransitionResult) -> Void)?
    @discardableResult func animate(alongsideTransition: ((TransitionResult) -> Void)?, completion: @escaping (TransitionResult) -> Void) -> Bool {
        if accepted { self.completion = completion }
        return accepted
    }
    func complete(cancelled: Bool = false) { let callback = completion; completion = nil; callback?(TransitionResult(isCancelled: cancelled)) }
}
@MainActor final class UIViewController: UIResponder {
    var presentingViewController: UIViewController?, presentedViewController: UIViewController?
    var viewIfLoaded: UIView? = UIView()
    var isBeingPresented = true
    var transitionCoordinator: Transition? = Transition()
    var dismissCalls = 0
    var completion: (() -> Void)?
    func dismiss(animated: Bool, completion: @escaping () -> Void) { dismissCalls += 1; self.completion = completion }
    func completeDismiss() {
        presentingViewController?.presentedViewController = nil
        presentingViewController = nil
        let callback = completion; completion = nil; callback?()
    }
}
enum UIAccessibility { static let isReduceMotionEnabled = false }
@MainActor protocol NshComponent { var view: UIView { get }; func setProp(_ name: String, _ value: Any?) }
@MainActor struct NshComponentContext { let emit: (String, [String: Any]) -> Void }

@MainActor final class ResourceBridge {
    struct Presenter {
        let registration: UUID
        init(_ controller: UIViewController, _ registration: UUID, _ expected: RuntimeHostScope) { self.registration = registration }
    }
    struct Receipt { let isCurrent: () -> Bool }
    let authority = RuntimeHostAuthority()
    var presenters: [String: Presenter] = [:], presentedOwner: String?
    var completion: Bool?, captures = 0
    let hostID = "fixture"
    func capture(_ expected: RuntimeHostScope) throws -> Receipt {
        captures += 1
        let admitted = try authority.admit(expected, hostID: hostID, required: true)
        return Receipt(isCurrent: { [self] in authority.matches(admitted, hostID: hostID) })
    }
    func closePresentation(_ result: Result<Void, Error>) {}
    // The runner inserts registerPresenter/unregisterPresenter/ownsPresentation
    // verbatim from ResourceBridge.swift here, rather than recreating admission.
    /* PRODUCTION_REGISTRATION */
}
