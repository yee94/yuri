import Foundation
public struct UTType: Sendable {
    public static let image = UTType("image")!
    public static let item = UTType("item")!
    public init?(_ value: String) { }
    public init?(filenameExtension: String) { }
    public func conforms(to other: UTType) -> Bool { true }
    public var preferredFilenameExtension: String? { "png" }
    public var preferredMIMEType: String? { "image/png" }
}
