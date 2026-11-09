#if canImport(UIKit) && canImport(WebKit) && canImport(NativeShell)
import UIKit
import WebKit

@MainActor struct ResourceHTMLPrepared {
    let scope: ResourceWebPreviewScope, owner: String, entry: URL
    let initial: ResourceWebPreviewResponse
    let rules: WKContentRuleList
    let current: () -> Bool
    let read: (String, Int) async throws -> ResourceWebPreviewResponse
    let diagnostic: (ResourceWebPreviewDiagnostic) -> Void
}

@MainActor private final class ResourceHTMLSchemeHandler: NSObject, WKURLSchemeHandler {
    weak var content: ResourceHTMLContentView?
    init(_ content: ResourceHTMLContentView) { self.content = content }
    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let content else { urlSchemeTask.didFailWithError(ResourceWebPreviewFailure.stale); return }
        content.start(urlSchemeTask)
    }
    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) { content?.cancel(urlSchemeTask) }
}

/// The actual UIView carrier is shared by inline Files and the legacy loopback
/// controller. No UIViewController.view is detached or borrowed without containment.
@MainActor final class ResourceHTMLContentView: UIView, WKNavigationDelegate {
    private let prepared: ResourceHTMLPrepared
    private var initial: ResourceWebPreviewResponse?
    private var web: WKWebView?
    private var tasks: [ObjectIdentifier: Task<Void, Never>] = [:]
    private var bytes = 0, requests = 0, stopped = false
    var onFailure: (() -> Void)?
    var onLoaded: (() -> Void)?
    init(_ prepared: ResourceHTMLPrepared) {
        self.prepared = prepared; initial = prepared.initial
        super.init(frame: .zero)
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.setURLSchemeHandler(ResourceHTMLSchemeHandler(self), forURLScheme: ResourceWebPreviewScope.scheme)
        configuration.userContentController.add(prepared.rules)
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.allowsAirPlayForMediaPlayback = false
        let web = WKWebView(frame: bounds, configuration: configuration); self.web = web
        web.navigationDelegate = self; addSubview(web)
        web.load(URLRequest(url: prepared.entry))
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) unavailable") }
    override func layoutSubviews() { super.layoutSubviews(); web?.frame = bounds }
    func stop() {
        guard !stopped else { return }
        stopped = true; tasks.values.forEach { $0.cancel() }; tasks.removeAll(); initial = nil
        web?.stopLoading(); web?.navigationDelegate = nil; web?.removeFromSuperview(); web = nil
    }
    func start(_ task: WKURLSchemeTask) {
        let key = ObjectIdentifier(task), scope = prepared.scope, owner = prepared.owner
        guard !stopped, prepared.current(), tasks.count < 8, requests < 256, let url = task.request.url,
              task.request.httpMethod == "GET", let route = try? scope.route(url, owner: owner) else {
            prepared.diagnostic(ResourceWebPreviewDiagnostic(.schemeAdmission, error: ResourceWebPreviewFailure.invalid))
            task.didFailWithError(ResourceWebPreviewFailure.invalid); onFailure?(); return
        }
        requests += 1
        tasks[key] = Task { [weak self] in
            guard let self else { return }
            var stage: ResourceWebPreviewDiagnostic.Stage = .schemeRoute
            do {
                let response: ResourceWebPreviewResponse
                if route == (try scope.route(prepared.entry, owner: owner)), let initial { self.initial = nil; response = initial }
                else {
                    let limit = min(ResourceWebPreviewScope.responseLimit, ResourceWebPreviewScope.totalLimit - bytes)
                    guard limit > 0 else { throw ResourceWebPreviewFailure.limit }
                    stage = .subresourceRead; prepared.diagnostic(ResourceWebPreviewDiagnostic(stage))
                    response = try await prepared.read(route, limit)
                }
                try Task.checkCancellation()
                guard tasks[key] != nil, !stopped, prepared.current() else { throw CancellationError() }
                stage = .responseValidate; prepared.diagnostic(ResourceWebPreviewDiagnostic(stage))
                try ResourceWebPreviewScope.validate(response, document: route == scope.route(prepared.entry, owner: owner))
                guard response.data.count <= ResourceWebPreviewScope.totalLimit - bytes else { throw ResourceWebPreviewFailure.limit }
                bytes += response.data.count
                stage = .responseConstruct; prepared.diagnostic(ResourceWebPreviewDiagnostic(stage))
                let head = try response.webResponse(for: url)
                stage = .responseDeliver; prepared.diagnostic(ResourceWebPreviewDiagnostic(stage))
                task.didReceive(head); task.didReceive(response.data); task.didFinish(); tasks.removeValue(forKey: key)
            } catch {
                guard tasks.removeValue(forKey: key) != nil, !stopped else { return }
                prepared.diagnostic(ResourceWebPreviewDiagnostic(stage, error: error))
                task.didFailWithError(ResourceWebPreviewFailure.response); onFailure?()
            }
        }
    }
    func cancel(_ task: WKURLSchemeTask) { tasks.removeValue(forKey: ObjectIdentifier(task))?.cancel() }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let permitted = !stopped && prepared.current() && action.targetFrame?.isMainFrame == true && action.request.httpMethod == "GET"
            && action.request.url.map { (try? prepared.scope.route($0, owner: prepared.owner)) != nil } == true
        prepared.diagnostic(ResourceWebPreviewDiagnostic(.navigationPolicy, error: permitted ? nil : ResourceWebPreviewFailure.invalid))
        decisionHandler(permitted ? .allow : .cancel)
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { fail(.navigationProvisional, error) }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { if !stopped && prepared.current() { onLoaded?() } }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { fail(.navigationCommitted, error) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { fail(.contentProcess, ResourceWebPreviewFailure.response) }
    private func fail(_ stage: ResourceWebPreviewDiagnostic.Stage, _ error: Error) {
        guard !stopped else { return }; prepared.diagnostic(ResourceWebPreviewDiagnostic(stage, error: error)); onFailure?()
    }
}

@MainActor final class ResourceWebPreviewMountView: UIView {
    private weak var bridge: ResourceWebPreviewBridge?
    private let failure: (String) -> Void
    private let coveredByOwnPresentation: (String?) -> Bool
    private var config: [String: Any]?, owner: String?, presentationOwner: String?
    private var started = false, retired = false
    private var content: ResourceHTMLContentView?
    private let loading = UIActivityIndicatorView(style: .medium)
    init(bridge: ResourceWebPreviewBridge, failure: @escaping (String) -> Void, covered: @escaping (String?) -> Bool) {
        self.bridge = bridge; self.failure = failure; coveredByOwnPresentation = covered; super.init(frame: .zero)
        loading.hidesWhenStopped = true; addSubview(loading)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) unavailable") }
    func update(_ value: Any?) {
        guard !retired, !started, config == nil, var args = value as? [String: Any], let owner = args["owner"] as? String else { return }
        presentationOwner = args.removeValue(forKey: "presentationOwner") as? String
        config = args; self.owner = owner; begin()
    }
    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window != nil { begin() }
        else if started, !coveredByOwnPresentation(presentationOwner), let owner { retired = true; bridge?.detach(owner: owner) }
    }
    override func layoutSubviews() { super.layoutSubviews(); content?.frame = bounds; loading.center = CGPoint(x: bounds.midX, y: bounds.midY) }
    private func begin() {
        guard !retired, !started, window != nil, let config, let owner, let bridge else { return }
        started = true; loading.startAnimating()
        do { try bridge.mount(config, in: self) } catch { retired = true; loading.stopAnimating(); failure(owner) }
    }
    func adopt(_ content: ResourceHTMLContentView, owner: String) {
        guard !retired, self.owner == owner else { content.stop(); return }
        self.content = content; content.frame = bounds; insertSubview(content, belowSubview: loading)
        content.onLoaded = { [weak self] in self?.loading.stopAnimating() }
    }
    func failed(_ owner: String) { if self.owner == owner { loading.stopAnimating(); failure(owner) } }
    func stop(owner: String) {
        guard self.owner == owner else { return }
        retired = true; loading.stopAnimating(); content?.stop(); content?.removeFromSuperview(); content = nil; config = nil
    }
}
#endif
