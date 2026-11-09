import Foundation

// Native policy test boundary only. Actual parser/present/close/release bodies are
// compiled verbatim; SDK compilation separately checks the complete UIKit bridge.
@MainActor final class AVURLAsset { func cancelLoading() {} }
@MainActor final class ResourceTestView { var window: Bool? = true }
@MainActor final class UIViewController {
    var presentingViewController: UIViewController?, presentedViewController: UIViewController?
    var viewIfLoaded: ResourceTestView? = ResourceTestView(), isBeingDismissed = false
}
@MainActor final class ResourceBridge {
    /* PRODUCTION_LEASE */
    private struct Presenter { let controller: UIViewController?; let expectedHost: RuntimeHostScope }
    private var leases: [String: Lease] = [:], presenters: [String: Presenter] = [:]
    private var controller: UIViewController? = UIViewController()
    private var completion: Bool?, presentationID: UUID?, presented: String?, presentedOwner: String?
    private var pendingRelease = Set<String>()
    private(set) var shows = 0, lastKey: String?
    private func failure(_ message: String) -> Error { RuntimeHostScopeFailure.invalid }
    private func retireSVG(_ key: String) {}
    private func closePresentation(_ result: Result<Any?, Error>) {}
    private func show(key: String, lease: Lease, action: String, controller: UIViewController, id: UUID) async throws -> Any? {
        shows += 1; lastKey = key; return ["completed": false]
    }
    func seed(_ key: String, url: URL, scope: RuntimeHostScope, contact: ContactAttachmentResource, transport: ResourceTransport) {
        leases[key] = Lease(url: url, current: transport.isCurrent, expectedHost: scope, kind: "text", preview: "quicklook", asset: nil,
                            sourcePath: nil, mime: contact.mime, contact: contact, transport: transport)
    }
    func contains(_ key: String) -> Bool { leases[key] != nil }
    func invoke(_ input: Any?) async throws -> Any? { try await present(input) }
    /* PRODUCTION_PRESENT */
    /* PRODUCTION_RETIRE */
}
