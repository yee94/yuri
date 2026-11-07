import Foundation

/// Parsed in full before capture or an asynchronous presentation can begin.
struct ResourceWebPreviewRequest {
    let expectedHost: RuntimeHostScope
    let owner: String
    let scope: ResourceWebPreviewScope?
    let path: String?
    let url: String?
    static func identity(_ input: Any?) throws -> (RuntimeHostScope, String) {
        guard let args = input as? [String: Any], let owner = args["owner"] as? String,
              !owner.isEmpty, owner.utf8.count <= 128,
              owner.unicodeScalars.allSatisfy({ CharacterSet.alphanumerics.contains($0) || $0 == "_" || $0 == "-" }) else { throw ResourceWebPreviewFailure.invalid }
        return (try RuntimeHostScope(args["expectedHost"]), owner)
    }
    init(_ input: Any?) throws {
        let (expected, owner) = try Self.identity(input)
        guard let args = input as? [String: Any] else { throw ResourceWebPreviewFailure.invalid }
        expectedHost = expected; self.owner = owner
        if args["kind"] as? String == "html", Set(args.keys) == ["kind", "directory", "path", "expectedHost", "owner"],
           let directory = args["directory"] as? String, let path = args["path"] as? String {
            scope = try .html(directory: directory, path: path); self.path = path; url = nil
        } else if args["kind"] as? String == "loopback", Set(args.keys) == ["kind", "url", "expectedHost", "owner"], let url = args["url"] as? String {
            _ = try ResourceWebPreviewScope.loopback(url)
            scope = nil; path = nil; self.url = url
        } else { throw ResourceWebPreviewFailure.invalid }
    }
}

/// The same exact-ticket gate protects Foundation admission and UIKit callbacks.
@MainActor final class ResourceWebPreviewOwnership {
    final class Ticket {
        let request: ResourceWebPreviewRequest
        let transport: ResourceWebPreviewTransport
        var isClosing = false
        var closed: [CheckedContinuation<Void, Never>] = []
        init(_ request: ResourceWebPreviewRequest, _ transport: ResourceWebPreviewTransport) { self.request = request; self.transport = transport }
    }
    private(set) var active: Ticket?
    private var closedOwners: [String: Set<String>] = [:]
    private var closedCount = 0
    private var closedOverflow = false
    private func scopeKey(_ scope: RuntimeHostScope) -> String { scope.hostID + ":" + scope.lease.uuidString }
    func begin(_ input: Any?, capture: (RuntimeHostScope) throws -> ResourceWebPreviewTransport) throws -> Ticket {
        try Task.checkCancellation()
        let request = try ResourceWebPreviewRequest(input)
        guard !closedOverflow, closedOwners[scopeKey(request.expectedHost)]?.contains(request.owner) != true else { throw ResourceWebPreviewFailure.stale }
        guard active == nil else { throw ResourceWebPreviewFailure.busy }
        let transport = try capture(request.expectedHost)
        try Task.checkCancellation()
        guard transport.isCurrent() else { throw CancellationError() }
        let ticket = Ticket(request, transport); active = ticket; return ticket
    }
    func matches(_ ticket: Ticket) -> Bool { active === ticket && !ticket.isClosing }
    func startClosing(_ ticket: Ticket) -> Bool {
        guard matches(ticket) else { return false }
        rememberClosed(ticket.request.expectedHost, ticket.request.owner)
        ticket.isClosing = true; return true
    }
    func retire(_ ticket: Ticket) -> Bool {
        guard active === ticket else { return false }
        active = nil
        let pending = ticket.closed; ticket.closed.removeAll(); pending.forEach { $0.resume() }
        return true
    }
    func waitClosed(_ ticket: Ticket) async {
        guard active === ticket else { return }
        await withCheckedContinuation { ticket.closed.append($0) }
    }
    /// Runtime invalidation rotates the native receipt; old intents cannot re-admit.
    func invalidateClosedOwners() { closedOwners.removeAll(); closedCount = 0; closedOverflow = false }
    private func rememberClosed(_ expected: RuntimeHostScope, _ owner: String) {
        let key = scopeKey(expected)
        guard closedOwners[key]?.contains(owner) != true else { return }
        // Never evict a cancellation and accidentally admit its delayed request.
        guard closedCount < 4096 else { closedOverflow = true; return }
        closedOwners[key, default: []].insert(owner); closedCount += 1
    }
    func closing(_ input: Any?, capture: (RuntimeHostScope) throws -> ResourceWebPreviewTransport) throws -> Ticket? {
        let (expected, owner) = try ResourceWebPreviewRequest.identity(input)
        guard let args = input as? [String: Any], Set(args.keys) == ["expectedHost", "owner"] else { throw ResourceWebPreviewFailure.invalid }
        if let ticket = active, ticket.request.owner == owner, ticket.request.expectedHost == expected {
            // An existing old surface is always cleanable, even after revocation.
            rememberClosed(expected, owner); return ticket
        }
        // Unknown closes need current receipt proof before consuming this cycle's
        // bounded cancellation table. Never capture the latest unscoped Host.
        do { guard try capture(expected).isCurrent() else { return nil } }
        catch { return nil }
        rememberClosed(expected, owner)
        return nil
    }
}

struct ResourceWebPreviewResponse {
    let status: Int
    let mime: String
    let data: Data
    var contentSecurityPolicy: String? = nil

    /// Preserve the full upstream Content-Type, including charset; never infer or transcode bytes.
    func webResponse(for url: URL) throws -> HTTPURLResponse {
        try ResourceWebPreviewScope.validate(self, document: false)
        let policy = ResourceWebPreviewScope.policy + (contentSecurityPolicy.map { ", " + $0 } ?? "")
        let headers = ["Content-Type": mime, "Content-Security-Policy": policy, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff"]
        guard let head = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers) else { throw ResourceWebPreviewFailure.response }
        return head
    }
}

/// Produced only by RuntimeBridge's captured, authenticated POST /api/preview/targets.
/// The read closure privately owns the short-lived preview token; no client token is a URL.
@MainActor struct ResourceWebPreviewProxy {
    let basePath: String
    let expiresAt: Date
    let read: (_ route: String, _ limit: Int) async throws -> ResourceWebPreviewResponse
}

/// No credentials, endpoint, URLSession or alternate Relay owner enter the preview.
/// Both closures must bound bytes DURING receipt, reject redirects and cancel on Host change.
@MainActor struct ResourceWebPreviewTransport {
    let readFile: (_ route: String, _ limit: Int) async throws -> ResourceWebPreviewResponse
    let isCurrent: () -> Bool
    var prepareLoopback: ((_ url: String) async throws -> ResourceWebPreviewProxy)? = nil

    /// send is installed only by the captured RuntimeBridge, never by resource JavaScript.
    static func authorized(readFile: @escaping (String, Int) async throws -> ResourceWebPreviewResponse, isCurrent: @escaping () -> Bool,
                           send: @escaping (String, String, Data?, [String: String], Int) async throws -> ResourceWebPreviewResponse) -> Self {
        var transport = Self(readFile: readFile, isCurrent: isCurrent)
        transport.prepareLoopback = { value in
            try Task.checkCancellation(); guard isCurrent() else { throw ResourceWebPreviewFailure.stale }
            _ = try ResourceWebPreviewScope.loopback(value)
            let headers = ["X-Yuri-Native-Preview": "1"]
            let body = try JSONSerialization.data(withJSONObject: ["url": value, "ttlMs": 300000, "allowExternal": false])
            let response = try await send("/api/preview/targets", "POST", body, headers, 65536)
            try Task.checkCancellation(); guard isCurrent() else { throw ResourceWebPreviewFailure.stale }
            guard (200..<300).contains(response.status), response.data.count <= 65536,
                  response.mime.split(separator: ";").first?.lowercased() == "application/json",
                  let object = try JSONSerialization.jsonObject(with: response.data) as? [String: Any],
                  let id = object["id"] as? String, id.range(of: "^[a-f0-9]{16,64}$", options: .regularExpression) != nil,
                  let base = object["proxyBasePath"] as? String, base == "/api/preview/proxy/" + id,
                  let token = object["previewToken"] as? String, token.range(of: "^[a-f0-9]{32}$", options: .regularExpression) != nil,
                  let expiry = object["expiresAt"] as? NSNumber, CFGetTypeID(expiry) != CFBooleanGetTypeID(),
                  expiry.doubleValue.isFinite else { throw ResourceWebPreviewFailure.response }
            let expiresAt = Date(timeIntervalSince1970: expiry.doubleValue / 1000)
            guard expiresAt > Date(), expiresAt.timeIntervalSinceNow <= 300 else { throw ResourceWebPreviewFailure.response }
            let scope = try ResourceWebPreviewScope.proxy(basePath: base, target: ResourceWebPreviewScope.loopback(value))
            return ResourceWebPreviewProxy(basePath: base, expiresAt: expiresAt, read: { route, limit in
                try Task.checkCancellation(); guard isCurrent(), expiresAt > Date() else { throw ResourceWebPreviewFailure.stale }
                guard limit > 0, limit <= ResourceWebPreviewScope.responseLimit,
                      let url = URL(string: ResourceWebPreviewScope.scheme + "://capture" + route) else { throw ResourceWebPreviewFailure.invalid }
                let checked = try scope.route(url, owner: "capture")
                guard var parts = URLComponents(string: checked), parts.fragment == nil else { throw ResourceWebPreviewFailure.invalid }
                // Rewritten resources may contain an old scoped token. Never forward it.
                parts.queryItems = parts.queryItems?.filter { $0.name.lowercased() != "yuri_preview_token" }
                if parts.queryItems?.isEmpty == true { parts.query = nil }
                guard let path = parts.string else { throw ResourceWebPreviewFailure.invalid }
                let result = try await send(path, "GET", nil, ["X-Yuri-Native-Preview": "1", "X-Yuri-Preview-Token": token], limit)
                try Task.checkCancellation(); guard isCurrent(), expiresAt > Date() else { throw ResourceWebPreviewFailure.stale }
                guard result.data.count <= limit else { throw ResourceWebPreviewFailure.limit }
                try ResourceWebPreviewScope.validate(result, document: false)
                return result
            })
        }
        return transport
    }
}

enum ResourceWebPreviewFailure: String, Error {
    case invalid, unsupported, stale, limit, response, busy, unavailable
}

/// Optional native-only diagnostics: never carry error text, userInfo, URLs or page data.
struct ResourceWebPreviewDiagnostic {
    enum Stage: String {
        case capture, intent, proxyPrepare = "proxy.prepare", entryURL = "entry.url", current
        case statRead = "stat.read", statValidate = "stat.validate", entryRead = "entry.read", entryValidate = "entry.validate"
        case rulesCompile = "rules.compile", modalPresent = "modal.present", schemeAdmission = "scheme.admission", schemeRoute = "scheme.route"
        case subresourceRead = "subresource.read", responseValidate = "response.validate", responseConstruct = "response.construct", responseDeliver = "response.deliver"
        case navigationPolicy = "navigation.policy", navigationProvisional = "navigation.provisional", navigationCommitted = "navigation.committed", contentProcess = "content.process"
        case closed, invalidated
    }
    let stage: Stage
    let domain: String?
    let code: Int?
    init(_ stage: Stage, error: Error? = nil) {
        self.stage = stage
        guard let error else { domain = nil; code = nil; return }
        let value = error as NSError
        if error is ResourceWebPreviewFailure { domain = "ResourceWebPreviewFailure" }
        else if error is CancellationError { domain = "CancellationError" }
        else { domain = ["WKErrorDomain", "NSURLErrorDomain", "NSCocoaErrorDomain", "NSPOSIXErrorDomain", "NSOSStatusErrorDomain"].contains(value.domain) ? value.domain : "OtherErrorDomain" }
        code = value.code
    }
}

/// Foundation-only authority is compiled and executed by the isolated contract fixture.
struct ResourceWebPreviewScope {
    let directory: String?
    let proxyBase: String?
    let entryPath: String
    static let scheme = "yuri-resource"
    static let responseLimit = 8 * 1024 * 1024
    static let totalLimit = 32 * 1024 * 1024
    static let policy = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
    // WebKit content-blocker regexes do not support disjunctions (|).
    static let networkRules = """
    [{"trigger":{"url-filter":"^https?:"},"action":{"type":"block"}},
     {"trigger":{"url-filter":"^wss?:"},"action":{"type":"block"}},
     {"trigger":{"url-filter":"^ftp:"},"action":{"type":"block"}},
     {"trigger":{"url-filter":"^file:"},"action":{"type":"block"}}]
    """

    static func canonicalFile(_ value: String) -> Bool {
        guard value.hasPrefix("/"), !value.hasPrefix("//"), !value.contains("\\"), !value.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else { return false }
        return value == "/" || !value.dropFirst().split(separator: "/", omittingEmptySubsequences: false).contains(where: { $0.isEmpty || $0 == "." || $0 == ".." })
    }
    static func within(_ path: String, _ root: String) -> Bool { root == "/" || path.hasPrefix(root + "/") }
    static func html(directory: String, path: String) throws -> Self {
        guard canonicalFile(directory), canonicalFile(path), within(path, directory), ["html", "htm"].contains((path as NSString).pathExtension.lowercased()) else { throw ResourceWebPreviewFailure.invalid }
        return Self(directory: directory, proxyBase: nil, entryPath: encodePath(path))
    }
    static func loopback(_ value: String) throws -> URLComponents {
        guard value.utf8.count <= 8192, !value.unicodeScalars.contains(where: { $0.value <= 32 || $0.value == 127 }), !value.contains("\\"),
              let parts = URLComponents(string: value), ["http", "https"].contains(parts.scheme?.lowercased() ?? ""),
              ["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "::1"].contains(parts.host?.lowercased() ?? ""),
              parts.user == nil, parts.password == nil, parts.port.map({ (1...65535).contains($0) }) ?? true,
               safeQuery(parts), !(parts.queryItems ?? []).contains(where: { $0.name.lowercased() == "yuri_preview_token" }), let decoded = parts.percentEncodedPath.removingPercentEncoding,
              !decoded.contains("\\"), !decoded.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else { throw ResourceWebPreviewFailure.invalid }
        return parts
    }
    static func proxy(basePath: String, target: URLComponents) throws -> Self {
        guard basePath.range(of: "^/api/preview/proxy/[a-f0-9]{16,64}$", options: .regularExpression) != nil else { throw ResourceWebPreviewFailure.invalid }
        let path = target.percentEncodedPath.isEmpty ? "/" : target.percentEncodedPath
        let entry = basePath + path + (target.percentEncodedQuery.map { "?" + $0 } ?? "") + (target.percentEncodedFragment.map { "#" + $0 } ?? "")
        let scope = Self(directory: nil, proxyBase: basePath, entryPath: entry)
        _ = try scope.route(URL(string: Self.scheme + "://fixture" + entry)!, owner: "fixture")
        return scope
    }
    static func encodePath(_ path: String) -> String {
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")
        return path.split(separator: "/", omittingEmptySubsequences: false).map { String($0).addingPercentEncoding(withAllowedCharacters: allowed)! }.joined(separator: "/")
    }
    static func statRoute(_ path: String) -> String { "/api/fs/stat?path=" + encodePath(path).replacingOccurrences(of: "/", with: "%2F") }
    static func validateStat(_ response: ResourceWebPreviewResponse) throws {
        guard response.data.count <= 65536, (200..<300).contains(response.status), response.mime.lowercased().hasPrefix("application/json"),
              let metadata = try JSONSerialization.jsonObject(with: response.data) as? [String: Any], metadata["isFile"] as? Bool == true,
              let size = metadata["size"] as? Int, size >= 0 else { throw ResourceWebPreviewFailure.response }
        guard size <= responseLimit else { throw ResourceWebPreviewFailure.limit }
    }
    private static func safeQuery(_ parts: URLComponents) -> Bool {
        let forbidden: Set<String> = ["oc_client_token", "yuri_client_token", "yuri_url_token", "authorization", "access_token", "token"]
        return !(parts.queryItems ?? []).contains { forbidden.contains($0.name.lowercased()) || ($0.value ?? "").unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) }
    }
    func route(_ url: URL, owner: String) throws -> String {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false), parts.scheme == Self.scheme, parts.host == owner,
              parts.user == nil, parts.password == nil, parts.port == nil, Self.safeQuery(parts),
              let decoded = parts.percentEncodedPath.removingPercentEncoding,
              !decoded.contains("%"), Self.canonicalFile(proxyBase != nil && decoded.hasSuffix("/") ? String(decoded.dropLast()) : decoded) else { throw ResourceWebPreviewFailure.invalid }
        if let directory {
            guard Self.within(decoded, directory) else { throw ResourceWebPreviewFailure.invalid }
            return "/api/fs/serve" + Self.encodePath(decoded)
        }
        guard let proxyBase, decoded.hasPrefix(proxyBase + "/") else { throw ResourceWebPreviewFailure.invalid }
        return parts.percentEncodedPath + (parts.percentEncodedQuery.map { "?" + $0 } ?? "")
    }
    static func validate(_ response: ResourceWebPreviewResponse, document: Bool) throws {
        guard (200..<300).contains(response.status), response.data.count <= responseLimit,
              !response.mime.contains("\r"), !response.mime.contains("\n"),
              response.contentSecurityPolicy.map({ !$0.contains("\r") && !$0.contains("\n") }) ?? true else { throw ResourceWebPreviewFailure.response }
        let mime = response.mime.split(separator: ";").first?.trimmingCharacters(in: .whitespaces).lowercased()
        if document && mime != "text/html" { throw ResourceWebPreviewFailure.response }
    }
}

#if canImport(UIKit) && canImport(WebKit) && canImport(NativeShell)
import UIKit
import WebKit
import NativeShell

/// WKWebView owns only the presented resource surface; the application stays NSH/UIKit.
@MainActor final class ResourceWebPreviewBridge: NSObject, UIAdaptivePresentationControllerDelegate {
    private weak var controller: UIViewController?
    private let capture: (RuntimeHostScope) throws -> ResourceWebPreviewTransport
    private let ownership = ResourceWebPreviewOwnership()
    private weak var navigation: UINavigationController?
    private var preview: ResourceWebPreviewSurface?
    private var operation: Task<Any?, Error>?
    private var completion: CheckedContinuation<Any?, Error>?
    private let diagnostic: ((ResourceWebPreviewDiagnostic) -> Void)?
    private var stage: ResourceWebPreviewDiagnostic.Stage = .capture
    private var diagnosedFailure = false
    init(controller: UIViewController, capture: @escaping (RuntimeHostScope) throws -> ResourceWebPreviewTransport, diagnostic: ((ResourceWebPreviewDiagnostic) -> Void)? = nil) {
        self.controller = controller; self.capture = capture; self.diagnostic = diagnostic
    }
    private func report(_ event: ResourceWebPreviewDiagnostic) {
        stage = event.stage
        if event.domain != nil { diagnosedFailure = true }
        diagnostic?(event)
    }
    private func enter(_ value: ResourceWebPreviewDiagnostic.Stage) { report(ResourceWebPreviewDiagnostic(value)) }
    func install(on app: NshAppView) {
        app.handle("resources.web.present") { [weak self] input async throws -> Any? in
            guard let self else { throw CancellationError() }
            return try await self.present(input)
        }
        app.handle("resources.web.close") { [weak self] input async throws -> Any? in
            try await self?.close(input); return true
        }
    }
    /// Native callers and the isolated UIKit fixture share the same operation owner.
    func present(_ input: Any?) async throws -> Any? {
        guard UIApplication.shared.applicationState == .active else { throw CancellationError() }
        let ticket = try ownership.begin(input, capture: capture)
        diagnosedFailure = false; enter(.capture)
        let work = Task { try await self.prepareAndPresent(ticket) }
        operation = work
        defer { if ownership.matches(ticket) { terminate(ticket, result: .failure(CancellationError()), animated: false) } }
        do { return try await withTaskCancellationHandler(operation: { try await work.value }, onCancel: {
            work.cancel()
            Task { @MainActor [weak self] in self?.terminate(ticket, result: .failure(CancellationError()), animated: false) }
        }) }
        catch {
            if ownership.matches(ticket), !diagnosedFailure { report(ResourceWebPreviewDiagnostic(stage, error: error)) }
            if error is CancellationError { throw CancellationError() }
            if let failure = error as? ResourceWebPreviewFailure { throw failure }
            throw ResourceWebPreviewFailure.response
        }
    }
    /// Chain into RuntimeBridge.onInvalidate, app background, and native teardown.
    func invalidate() {
        enter(.invalidated)
        if let ticket = ownership.active { terminate(ticket, result: .failure(CancellationError()), animated: false) }
        ownership.invalidateClosedOwners()
    }
    func close(_ input: Any?) async throws {
        if let ticket = try ownership.closing(input, capture: capture) {
            terminate(ticket, result: .failure(CancellationError()), animated: false)
            await ownership.waitClosed(ticket)
        }
    }
    private func prepareAndPresent(_ ticket: ResourceWebPreviewOwnership.Ticket) async throws -> Any? {
        try Task.checkCancellation()
        guard UIApplication.shared.applicationState == .active else { throw CancellationError() }
        guard ownership.matches(ticket), preview == nil, completion == nil, let controller, controller.presentedViewController == nil else { throw ResourceWebPreviewFailure.busy }
        let transport = ticket.transport, request = ticket.request
        let admittedCurrent = { [weak self] in self?.ownership.matches(ticket) == true && transport.isCurrent() && UIApplication.shared.applicationState == .active }
        guard admittedCurrent() else { throw CancellationError() }
        enter(.intent)
        let scope: ResourceWebPreviewScope
        let read: (String, Int) async throws -> ResourceWebPreviewResponse
        var expiresAt: Date?
        if let html = request.scope {
            scope = html; read = transport.readFile
        } else if let value = request.url {
            let target = try ResourceWebPreviewScope.loopback(value)
            guard let prepare = transport.prepareLoopback else { throw ResourceWebPreviewFailure.unsupported }
            enter(.proxyPrepare)
            let proxy = try await prepare(value)
            try Task.checkCancellation(); guard admittedCurrent() else { throw CancellationError() }
            scope = try .proxy(basePath: proxy.basePath, target: target); read = proxy.read; expiresAt = proxy.expiresAt
        } else { throw ResourceWebPreviewFailure.invalid }
        let owner = UUID().uuidString.lowercased()
        enter(.entryURL)
        guard let entry = URL(string: ResourceWebPreviewScope.scheme + "://" + owner + scope.entryPath) else { throw ResourceWebPreviewFailure.invalid }
        let current = { admittedCurrent() && (expiresAt.map { $0 > Date() } ?? true) }
        enter(.current); guard current() else { throw CancellationError() }
        if let path = request.path, scope.directory != nil {
            enter(.statRead)
            let stat = try await read(ResourceWebPreviewScope.statRoute(path), 65536)
            try Task.checkCancellation(); guard current() else { throw CancellationError() }
            enter(.statValidate)
            try ResourceWebPreviewScope.validateStat(stat)
        }
        enter(.entryRead)
        let initial = try await read(scope.route(entry, owner: owner), ResourceWebPreviewScope.responseLimit)
        try Task.checkCancellation(); guard current() else { throw CancellationError() }
        enter(.entryValidate)
        try ResourceWebPreviewScope.validate(initial, document: true)
        let surface = ResourceWebPreviewSurface(scope: scope, owner: owner, entry: entry, initial: initial, current: current, read: read)
        enter(.rulesCompile)
        guard let rules = try await WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "yuri-resource-no-network", encodedContentRuleList: ResourceWebPreviewScope.networkRules) else { throw ResourceWebPreviewFailure.response }
        try Task.checkCancellation(); guard current(), controller.presentedViewController == nil else { throw CancellationError() }
        surface.rules = rules
        surface.diagnostic = { [weak self] event in if self?.ownership.matches(ticket) == true { self?.report(event) } }
        surface.onClose = { [weak self] in self?.terminate(ticket, result: .success(["closed": true]), animated: true) }
        surface.onFailure = { [weak self] in self?.terminate(ticket, result: .failure(ResourceWebPreviewFailure.response), animated: true) }
        enter(.modalPresent)
        return try await withTaskCancellationHandler(operation: {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                preview = surface
                completion = continuation
                let navigation = UINavigationController(rootViewController: surface)
                self.navigation = navigation
                controller.present(navigation, animated: true)
                navigation.presentationController?.delegate = self
            }
        }, onCancel: { Task { @MainActor in self.terminate(ticket, result: .failure(CancellationError()), animated: false) } })
    }
    private func terminate(_ ticket: ResourceWebPreviewOwnership.Ticket, result: Result<Any?, Error>, animated: Bool) {
        guard ownership.startClosing(ticket) else { return }
        let work = operation; operation = nil
        let pending = completion; completion = nil
        let surface = preview; preview = nil
        let navigation = navigation; self.navigation = nil
        surface?.stop(); navigation?.presentationController?.delegate = nil
        work?.cancel()
        let settled = { [self] in
            guard ownership.retire(ticket) else { return }
            pending?.resume(with: result)
        }
        if let navigation, navigation.presentingViewController != nil { navigation.dismiss(animated: animated, completion: settled) }
        else { settled() }
    }
    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        guard presentationController.presentedViewController === navigation, let ticket = ownership.active else { return }
        enter(.closed); terminate(ticket, result: .success(["closed": true]), animated: false)
    }
}

@MainActor private final class ResourceWebPreviewSchemeHandler: NSObject, WKURLSchemeHandler {
    weak var surface: ResourceWebPreviewSurface?
    init(_ surface: ResourceWebPreviewSurface) { self.surface = surface }
    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let surface else { urlSchemeTask.didFailWithError(ResourceWebPreviewFailure.stale); return }
        surface.webView(webView, start: urlSchemeTask)
    }
    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) { surface?.webView(webView, stop: urlSchemeTask) }
}

@MainActor private final class ResourceWebPreviewSurface: UIViewController, WKURLSchemeHandler, WKNavigationDelegate {
    let scope: ResourceWebPreviewScope, owner: String, entry: URL
    let current: () -> Bool
    let read: (String, Int) async throws -> ResourceWebPreviewResponse
    var rules: WKContentRuleList?
    var onClose: (() -> Void)?
    var onFailure: (() -> Void)?
    var diagnostic: ((ResourceWebPreviewDiagnostic) -> Void)?
    private var initial: ResourceWebPreviewResponse?
    private var web: WKWebView?
    private var tasks: [ObjectIdentifier: Task<Void, Never>] = [:]
    private var bytes = 0, requests = 0
    private var stopped = false
    init(scope: ResourceWebPreviewScope, owner: String, entry: URL, initial: ResourceWebPreviewResponse, current: @escaping () -> Bool, read: @escaping (String, Int) async throws -> ResourceWebPreviewResponse) {
        self.scope = scope; self.owner = owner; self.entry = entry; self.initial = initial; self.current = current; self.read = read
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) unavailable") }
    override func loadView() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.setURLSchemeHandler(ResourceWebPreviewSchemeHandler(self), forURLScheme: ResourceWebPreviewScope.scheme)
        if let rules { configuration.userContentController.add(rules) }
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.allowsAirPlayForMediaPlayback = false
        let web = WKWebView(frame: .zero, configuration: configuration); self.web = web
        web.navigationDelegate = self; view = web
        navigationItem.rightBarButtonItem = UIBarButtonItem(systemItem: .done, primaryAction: UIAction { [weak self] _ in self?.onClose?() })
        web.load(URLRequest(url: entry))
    }
    func stop() {
        stopped = true; tasks.values.forEach { $0.cancel() }; tasks.removeAll(); initial = nil
        web?.stopLoading(); web?.navigationDelegate = nil
        web = nil
    }
    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        let key = ObjectIdentifier(urlSchemeTask)
        guard !stopped, current(), tasks.count < 8, requests < 256, let url = urlSchemeTask.request.url, urlSchemeTask.request.httpMethod == "GET", let route = try? scope.route(url, owner: owner) else {
            diagnostic?(ResourceWebPreviewDiagnostic(.schemeAdmission, error: ResourceWebPreviewFailure.invalid))
            urlSchemeTask.didFailWithError(ResourceWebPreviewFailure.invalid); onFailure?(); return
        }
        requests += 1
        tasks[key] = Task { [weak self] in
            guard let self else { return }
            var stage = ResourceWebPreviewDiagnostic.Stage.schemeRoute
            do {
                let response: ResourceWebPreviewResponse
                let entryRoute = try scope.route(entry, owner: owner)
                if route == entryRoute, let initial { self.initial = nil; response = initial }
                else {
                    let limit = min(ResourceWebPreviewScope.responseLimit, ResourceWebPreviewScope.totalLimit - bytes)
                    guard limit > 0 else { throw ResourceWebPreviewFailure.limit }
                    stage = .subresourceRead; diagnostic?(ResourceWebPreviewDiagnostic(stage))
                    response = try await read(route, limit)
                }
                try Task.checkCancellation()
                guard tasks[key] != nil, !stopped, current() else { throw CancellationError() }
                stage = .responseValidate; diagnostic?(ResourceWebPreviewDiagnostic(stage))
                try ResourceWebPreviewScope.validate(response, document: route == entryRoute)
                guard response.data.count <= ResourceWebPreviewScope.totalLimit - bytes else { throw ResourceWebPreviewFailure.limit }
                bytes += response.data.count
                stage = .responseConstruct; diagnostic?(ResourceWebPreviewDiagnostic(stage))
                let head = try response.webResponse(for: url)
                stage = .responseDeliver; diagnostic?(ResourceWebPreviewDiagnostic(stage))
                urlSchemeTask.didReceive(head); urlSchemeTask.didReceive(response.data); urlSchemeTask.didFinish()
                tasks.removeValue(forKey: key)
            } catch {
                guard tasks.removeValue(forKey: key) != nil, !stopped else { return }
                diagnostic?(ResourceWebPreviewDiagnostic(stage, error: error))
                urlSchemeTask.didFailWithError(ResourceWebPreviewFailure.response)
                onFailure?()
            }
        }
    }
    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) { tasks.removeValue(forKey: ObjectIdentifier(urlSchemeTask))?.cancel() }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let permitted = !stopped && current() && navigationAction.targetFrame?.isMainFrame == true && navigationAction.request.httpMethod == "GET" && navigationAction.request.url.map { (try? scope.route($0, owner: owner)) != nil } == true
        diagnostic?(ResourceWebPreviewDiagnostic(.navigationPolicy, error: permitted ? nil : ResourceWebPreviewFailure.invalid))
        decisionHandler(permitted ? .allow : .cancel)
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { if !stopped { diagnostic?(ResourceWebPreviewDiagnostic(.navigationProvisional, error: error)); onFailure?() } }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { if !stopped { diagnostic?(ResourceWebPreviewDiagnostic(.navigationCommitted, error: error)); onFailure?() } }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { if !stopped { diagnostic?(ResourceWebPreviewDiagnostic(.contentProcess, error: ResourceWebPreviewFailure.response)); onFailure?() } }
}
#endif
