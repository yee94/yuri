import Foundation
import UIKit
public struct PHPickerConfiguration {
    public enum Filter { case images }
    public enum Representation { case current }
    public var filter: Filter?
    public var selectionLimit = 1
    public var preferredAssetRepresentationMode = Representation.current
    public init() { }
}
public final class AttachmentProvider {
    public var suggestedName: String? = "photo.png"
    public let registeredTypeIdentifiers = ["image/png"]
    public var reply: ((URL?, Error?) -> Void)?
    public init() { }
    public func loadFileRepresentation(forTypeIdentifier: String, completionHandler: @escaping (URL?, Error?) -> Void) { reply = completionHandler }
}
public struct PHPickerResult { public let itemProvider: AttachmentProvider; public init(_ provider: AttachmentProvider) { itemProvider = provider } }
@MainActor public protocol PHPickerViewControllerDelegate: AnyObject { func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) }
@MainActor public final class PHPickerViewController: UIViewController {
    public weak var delegate: PHPickerViewControllerDelegate?
    public init(configuration: PHPickerConfiguration) { super.init() }
}
