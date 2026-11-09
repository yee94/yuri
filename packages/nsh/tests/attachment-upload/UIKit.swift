@_exported import Foundation
import UniformTypeIdentifiers
@MainActor public enum AttachmentUIKit {
    public static var dismissals: [() -> Void] = []
    public static var presentations: [UIViewController] = []
    public static func completeDismissal() { dismissals.removeFirst()() }
}
@MainActor public protocol UIAdaptivePresentationControllerDelegate: AnyObject { func presentationControllerDidDismiss(_ controller: UIPresentationController) }
@MainActor public final class UIPresentationController {
    public weak var delegate: UIAdaptivePresentationControllerDelegate?
    public let presentedViewController: UIViewController
    public init(_ controller: UIViewController) { presentedViewController = controller }
}
@MainActor open class UIViewController: NSObject {
    public var presentedViewController: UIViewController?
    public weak var presentingViewController: UIViewController?
    public lazy var presentationController: UIPresentationController? = UIPresentationController(self)
    public func present(_ controller: UIViewController, animated: Bool) { presentedViewController = controller; controller.presentingViewController = self; AttachmentUIKit.presentations.append(controller) }
    public func dismiss(animated: Bool, completion: (() -> Void)? = nil) {
        AttachmentUIKit.dismissals.append { [self] in presentingViewController?.presentedViewController = nil; completion?() }
    }
}
@MainActor public protocol UIDocumentPickerDelegate: AnyObject {
    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController)
    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL])
}
@MainActor public final class UIDocumentPickerViewController: UIViewController {
    public weak var delegate: UIDocumentPickerDelegate?
    public var allowsMultipleSelection = false
    public init(forOpeningContentTypes: [UTType], asCopy: Bool) { super.init() }
}
public enum UIApplication { public static let didEnterBackgroundNotification = Notification.Name("fixture.background") }
