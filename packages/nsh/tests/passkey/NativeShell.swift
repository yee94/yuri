import Foundation
@MainActor public final class NshAppView {
    public init() {}
    public var handlers: [String: @MainActor (Any?) async throws -> Any?] = [:]
    public func handle(_ name: String, _ callback: @escaping @MainActor (Any?) async throws -> Any?) { handlers[name] = callback }
    public func send(_ name: String, _ value: Any? = nil) {}
}
