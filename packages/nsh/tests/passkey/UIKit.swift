@_exported import Foundation

@MainActor public enum StubUIKit {
    public static var presentations: [UIViewController] = []
    public static var dismissals: [() -> Void] = []
    public static func finishDismissals() { let pending = dismissals; dismissals.removeAll(); pending.forEach { $0() } }
}
public enum UIActivationState { case foregroundActive, background }
@MainActor public final class UIWindowScene { public var activationState = UIActivationState.foregroundActive }
@MainActor public final class UIWindow { public var isKeyWindow = true; public var windowScene: UIWindowScene? = UIWindowScene() }
@MainActor public final class UIView { public var window: UIWindow? = UIWindow() }
@MainActor open class UIViewController: NSObject {
    public var presentedViewController: UIViewController?
    public var viewIfLoaded: UIView? = UIView()
    public func present(_ controller: UIViewController, animated: Bool) { presentedViewController = controller; StubUIKit.presentations.append(controller) }
    public func dismiss(animated: Bool, completion: (() -> Void)? = nil) { StubUIKit.dismissals.append { completion?() } }
}
public enum UITextContentType { case password }
public enum UITextAutocorrectionType { case no }
@MainActor public final class UITextField {
    public var isSecureTextEntry = false
    public var textContentType: UITextContentType?
    public var autocorrectionType = UITextAutocorrectionType.no
    public var text: String?
    public var placeholder: String?
}
@MainActor public final class UIAlertAction: NSObject {
    public enum Style { case cancel, `default` }
    public let title: String?
    private let callback: ((UIAlertAction) -> Void)?
    public init(title: String?, style: Style, handler: ((UIAlertAction) -> Void)? = nil) { self.title = title; callback = handler }
    public func invoke() { callback?(self) }
}
@MainActor public final class UIAlertController: UIViewController {
    public enum Style { case alert }
    public let title: String?
    public var textFields: [UITextField]? = []
    public var actions: [UIAlertAction] = []
    public init(title: String?, message: String?, preferredStyle: Style) { self.title = title; super.init() }
    public func addTextField(configurationHandler: ((UITextField) -> Void)? = nil) { let field = UITextField(); configurationHandler?(field); textFields?.append(field) }
    public func addAction(_ action: UIAlertAction) { actions.append(action) }
}
