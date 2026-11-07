import Foundation
import CryptoKit

enum GuiPluginPreviewFailure: String, Error { case invalid, stale, unavailable, unsupported, response, busy, limit }

struct GuiPluginPreviewIntent {
    let owner: String
    let expectedHost: RuntimeHostScope
    let sessionID: String
    let directory: String
    let path: String
    let context: GuiPluginNativeContext?
    init(_ input: Any?) throws {
        let identity = try Self.identity(input)
        let required: Set<String> = ["sessionId", "directory", "path", "expectedHost", "owner"]
        guard let args = input as? [String: Any], Set(args.keys) == required || Set(args.keys) == required.union(["context"]),
              let session = args["sessionId"] as? String, !session.isEmpty, session.count <= 1024,
              let directory = args["directory"] as? String, let path = args["path"] as? String,
              Self.valid(directory), Self.valid(path), !session.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else { throw GuiPluginPreviewFailure.invalid }
        self.expectedHost = identity.0; self.owner = identity.1
        self.sessionID = session; self.directory = directory; self.path = path
        context = try args.keys.contains("context") ? GuiPluginNativeContext(args["context"], expectedHost: identity.0) : nil
    }
    private static func valid(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 8192 && !value.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 })
        && (value.range(of: "^[a-z][a-z0-9+.-]*:", options: [.regularExpression, .caseInsensitive]) == nil
            || value.lowercased().hasPrefix("file:") || value.range(of: "^[a-z]:[/\\\\]", options: [.regularExpression, .caseInsensitive]) != nil)
    }
    static func identity(_ input: Any?) throws -> (RuntimeHostScope, String) {
        guard let args = input as? [String: Any], let owner = args["owner"] as? String, !owner.isEmpty, owner.utf8.count <= 128,
              owner.range(of: "^[a-zA-Z0-9_-]+$", options: .regularExpression) != nil else { throw GuiPluginPreviewFailure.invalid }
        return (try RuntimeHostScope(args["expectedHost"]), owner)
    }
    var json: [String: Any] { ["sessionId": sessionID, "directory": directory, "path": path, "expectedHost": expectedHost.publicValue, "owner": owner] }
}

/// Exact presentation tickets, including opening and native dismissal. Kept in
/// Foundation so the production admission/late-cleanup gates have offline tests.
@MainActor final class GuiPluginPreviewOwnership {
    final class Ticket {
        let intent: GuiPluginPreviewIntent
        let captured: GuiPluginPreviewCapture
        var closing = false
        var closed: [CheckedContinuation<Void, Never>] = []
        init(_ intent: GuiPluginPreviewIntent, _ captured: GuiPluginPreviewCapture) { self.intent = intent; self.captured = captured }
    }
    private(set) var active: Ticket?
    private var closedOwners: [String: Set<String>] = [:]
    private var overflowScopes = Set<String>()
    private func key(_ scope: RuntimeHostScope) -> String { scope.hostID + ":" + scope.lease.uuidString }
    private func keepCurrentProof(_ scope: RuntimeHostScope) {
        // Only reached after native admission. An expired receipt cannot re-admit;
        // retain the active old ticket too, so its late cleanup cannot evict this scope.
        var keep = Set([key(scope)])
        if let ticket = active { keep.insert(key(ticket.intent.expectedHost)) }
        closedOwners = closedOwners.filter { keep.contains($0.key) }
        overflowScopes.formIntersection(keep)
    }
    private func remember(_ scope: RuntimeHostScope, _ owner: String) {
        let scopeKey = key(scope)
        if closedOwners[scopeKey]?.contains(owner) == true { return }
        guard (closedOwners[scopeKey]?.count ?? 0) < 4096 else { overflowScopes.insert(scopeKey); return }
        closedOwners[scopeKey, default: []].insert(owner)
    }
    func begin(_ input: Any?, capture: (RuntimeHostScope) throws -> GuiPluginPreviewCapture, requireContext: Bool = false) throws -> Ticket {
        let intent = try GuiPluginPreviewIntent(input)
        if requireContext && intent.context == nil { throw GuiPluginPreviewFailure.unavailable }
        guard active == nil else { throw GuiPluginPreviewFailure.busy }
        var captured = try capture(intent.expectedHost)
        guard captured.expectedHost == intent.expectedHost, captured.isCurrent(intent.expectedHost), captured.resource.isCurrent() else { throw GuiPluginPreviewFailure.stale }
        if let context = intent.context { captured = try captured.applying(context) }
        keepCurrentProof(intent.expectedHost)
        if overflowScopes.contains(key(intent.expectedHost)) || closedOwners[key(intent.expectedHost)]?.contains(intent.owner) == true { throw GuiPluginPreviewFailure.stale }
        if Task.isCancelled { remember(intent.expectedHost, intent.owner); throw CancellationError() }
        let ticket = Ticket(intent, captured); active = ticket; return ticket
    }
    func matches(_ ticket: Ticket) -> Bool { active === ticket && !ticket.closing }
    func startClosing(_ ticket: Ticket) -> Bool {
        guard matches(ticket) else { return false }
        remember(ticket.intent.expectedHost, ticket.intent.owner); ticket.closing = true; return true
    }
    @discardableResult func retire(_ ticket: Ticket) -> Bool {
        guard active === ticket else { return false }
        active = nil; let pending = ticket.closed; ticket.closed.removeAll(); pending.forEach { $0.resume() }; return true
    }
    func waitClosed(_ ticket: Ticket) async {
        guard active === ticket else { return }
        await withCheckedContinuation { ticket.closed.append($0) }
    }
    func closing(_ input: Any?, capture: (RuntimeHostScope) throws -> GuiPluginPreviewCapture) throws -> Ticket? {
        let (scope, owner) = try GuiPluginPreviewIntent.identity(input)
        guard let args = input as? [String: Any], Set(args.keys) == ["expectedHost", "owner"] else { throw GuiPluginPreviewFailure.invalid }
        if let ticket = active, ticket.intent.expectedHost == scope, ticket.intent.owner == owner { return ticket }
        let captured = try capture(scope)
        guard captured.expectedHost == scope, captured.isCurrent(scope), captured.resource.isCurrent() else { throw GuiPluginPreviewFailure.stale }
        keepCurrentProof(scope)
        remember(scope, owner); return nil
    }
}

/// The application supplies only its separately built, trusted content adapter.
/// This is not a plugin HTML endpoint: /api/plugin/gui remains official CJS+options.
/// resource privately owns current Host auth/authorized Relay; no second network owner.
@MainActor struct GuiPluginPreviewCapture {
    let expectedHost: RuntimeHostScope
    /// Checks the exact native admission lease, not just selected connection ID.
    let isCurrent: (_ expectedHost: RuntimeHostScope) -> Bool
    let resource: ResourceWebPreviewTransport
    let readAsset: (_ path: String, _ limit: Int) async throws -> ResourceWebPreviewResponse
    var labels: GuiPluginPreviewLabels? = nil
    var bootstrap: GuiPluginPreviewBootstrap? = nil
    var storage: GuiPluginPreviewStorage? = nil
    /// Current resource.readFile only allows fs/stat and fs/serve. The Runtime
    /// owner must explicitly capture the same authorized Host for GUI GET/RPC.
    /// Missing wiring fails unsupported; never bypass its existing allowlist.
    var readGui: ((_ expectedHost: RuntimeHostScope, _ request: GuiPluginPreviewRequest, _ limit: Int) async throws -> GuiPluginPreviewResponse)? = nil
    /// Optional lossless pull lane. At most 64 KiB per read, no aggregate 32 MiB
    /// ceiling or token URL. The Runtime owner still owns auth and Relay bytes.
    var openGui: ((_ expectedHost: RuntimeHostScope, _ request: GuiPluginPreviewRequest) async throws -> GuiPluginPreviewByteStream)? = nil
    func applying(_ context: GuiPluginNativeContext) throws -> Self {
        guard isCurrent(expectedHost), resource.isCurrent(), context.runtimeKey == GuiPluginNativeContext.runtimeKey(hostID: expectedHost.hostID),
              context.preferenceKey == GuiPluginNativeContext.preferenceKey(runtimeKey: context.runtimeKey) else { throw GuiPluginPreviewFailure.stale }
        guard let storage, storage.matches(runtimeKey: context.runtimeKey, preferenceKey: context.preferenceKey) else { throw GuiPluginPreviewFailure.unavailable }
        var next = self; next.labels = context.labels; next.bootstrap = context.bootstrap; return next
    }
}

struct GuiPluginPreviewResponse {
    let status: Int
    let mime: String
    let data: Data
    var headers: [String: String] = [:]
}

/// App-owned paths enter here once. JS can only select its already admitted Host
/// and present data; it cannot choose an asset root or persistent store path.
@MainActor final class GuiPluginPreviewResources {
    private let assets: GuiPluginPreviewAssets
    private let storageDirectory: URL
    private var selectedStorage: (String, GuiPluginPreviewStorage)?
    init(stagedDirectory: URL, storageDirectory: URL) throws {
        guard storageDirectory.isFileURL else { throw GuiPluginPreviewFailure.invalid }
        assets = try GuiPluginPreviewAssets(stagedDirectory: stagedDirectory)
        self.storageDirectory = storageDirectory
    }
    func capture(expectedHost: RuntimeHostScope, isCurrent: @escaping (RuntimeHostScope) -> Bool, resource: ResourceWebPreviewTransport,
                 readGui: ((RuntimeHostScope, GuiPluginPreviewRequest, Int) async throws -> GuiPluginPreviewResponse)?,
                 openGui: ((RuntimeHostScope, GuiPluginPreviewRequest) async throws -> GuiPluginPreviewByteStream)?) throws -> GuiPluginPreviewCapture {
        guard isCurrent(expectedHost), resource.isCurrent() else { throw GuiPluginPreviewFailure.stale }
        let storage: GuiPluginPreviewStorage
        if let (host, existing) = selectedStorage, host == expectedHost.hostID { storage = existing }
        else {
            storage = try GuiPluginPreviewStorage(directory: storageDirectory, connectionID: expectedHost.hostID)
            selectedStorage = (expectedHost.hostID, storage)
        }
        let assets = self.assets
        var captured = GuiPluginPreviewCapture(expectedHost: expectedHost, isCurrent: isCurrent, resource: resource, readAsset: { path, limit in try assets.read(path, limit: limit) })
        captured.storage = storage; captured.readGui = readGui; captured.openGui = openGui
        return captured
    }
}

enum GuiPluginPreviewResponseHeaders {
    static func checked(_ values: [String: String]) throws -> [String: String] {
        var result: [String: String] = [:]
        for (key, value) in values {
            let name = key.lowercased()
            guard ["x-yuri-file-exists", "x-yuri-gui-revision", "x-yuri-gui-code"].contains(name), result[name] == nil,
                  value.utf8.count <= 1024, !value.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }),
                  name != "x-yuri-file-exists" || ["true", "false"].contains(value),
                  name != "x-yuri-gui-revision" || value.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
                  name != "x-yuri-gui-code" || ["cached", "full"].contains(value) else { throw GuiPluginPreviewFailure.response }
            result[name] = value
        }
        return result
    }
}

@MainActor struct GuiPluginPreviewByteStream {
    let status: Int
    let mime: String
    let read: (_ limit: Int) async throws -> Data?
    let cancel: () -> Void
    var headers: [String: String] = [:]
}

@MainActor final class GuiPluginPreviewStreamLease {
    let status: Int
    let mime: String
    let headers: [String: String]
    private let stream: GuiPluginPreviewByteStream
    private let check: () throws -> Void
    private var closed = false, reading = false
    init(_ stream: GuiPluginPreviewByteStream, check: @escaping () throws -> Void) throws {
        try check()
        guard (200...599).contains(stream.status), !(300..<400).contains(stream.status), !stream.mime.contains("\r"), !stream.mime.contains("\n") else { throw GuiPluginPreviewFailure.response }
        headers = try GuiPluginPreviewResponseHeaders.checked(stream.headers)
        self.stream = stream; self.check = check; status = stream.status; mime = stream.mime
    }
    func next() async throws -> Data? {
        try check(); guard !closed, !reading else { throw GuiPluginPreviewFailure.stale }
        reading = true; defer { reading = false }
        do {
            let bytes = try await stream.read(65536)
            try Task.checkCancellation(); try check(); guard !closed else { throw GuiPluginPreviewFailure.stale }
            if let bytes { guard !bytes.isEmpty, bytes.count <= 65536 else { throw GuiPluginPreviewFailure.limit } }
            else { stop() }
            return bytes
        } catch { stop(); throw error }
    }
    func stop() { if closed { return }; closed = true; stream.cancel() }
    /// Retry can reuse request IDs. Always stop this captured instance; remove
    /// only when this document and read task still own its registry slot.
    func retire(from registry: inout [String: GuiPluginPreviewStreamLease], requestID: String, document: String, currentDocument: String, task: UUID, currentTask: UUID?) {
        stop()
        guard document == currentDocument, currentTask == task, registry[requestID] === self else { return }
        registry.removeValue(forKey: requestID)
    }
}

struct GuiPluginPreviewBootstrap {
    let runtimeKey: String
    let locale: String
    let mode: String
    let themeCSS: String
    /// Exact existing guiPreferencesKey(runtimeKey), supplied by the application.
    let preferenceKey: String
    var json: [String: Any] { ["runtimeKey": runtimeKey, "locale": locale, "mode": mode, "themeCSS": themeCSS, "preferenceKey": preferenceKey] }
}

/// Data from the operation owner, independently checked against native admission.
/// Never evaluate it as JavaScript or interpolate it into HTML/script/style tags.
struct GuiPluginNativeContext {
    let runtimeKey: String
    let preferenceKey: String
    let locale: String
    let mode: String
    let themeCSS: String
    let labels: GuiPluginPreviewLabels
    static func runtimeKey(hostID: String) -> String { "nsh:" + hostID }
    static func preferenceKey(runtimeKey: String) -> String {
        let identity = Data(runtimeKey.utf8).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        return "yuri.inst." + identity + ".gui-plugins.disabled"
    }
    init(_ input: Any?, expectedHost: RuntimeHostScope) throws {
        guard let args = input as? [String: Any], Set(args.keys) == ["runtimeKey", "preferenceKey", "locale", "mode", "themeCSS", "labels"],
              let runtimeKey = args["runtimeKey"] as? String, runtimeKey == Self.runtimeKey(hostID: expectedHost.hostID), runtimeKey.utf8.count <= 2048,
              let preferenceKey = args["preferenceKey"] as? String, preferenceKey == Self.preferenceKey(runtimeKey: runtimeKey),
              let locale = args["locale"] as? String, ["en", "zh-CN", "zh-TW", "ja", "ko", "fr", "es", "pl", "pt-BR", "uk"].contains(locale),
              let mode = args["mode"] as? String, ["light", "dark"].contains(mode),
              let css = args["themeCSS"] as? String, !css.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, css.utf8.count <= 512 * 1024,
              !css.contains("\0"), css.range(of: "</(?:script|style)\\b", options: [.regularExpression, .caseInsensitive]) == nil,
              let rawLabels = args["labels"] as? [String: String], Set(rawLabels.keys) == ["loading", "failed", "back", "close", "retry", "source", "preview"],
              rawLabels.values.allSatisfy({ !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && $0.utf8.count <= 2048 && !$0.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) }) else { throw GuiPluginPreviewFailure.invalid }
        self.runtimeKey = runtimeKey; self.preferenceKey = preferenceKey; self.locale = locale; self.mode = mode; themeCSS = css
        labels = GuiPluginPreviewLabels(loading: rawLabels["loading"]!, failed: rawLabels["failed"]!, back: rawLabels["back"]!, close: rawLabels["close"]!, retry: rawLabels["retry"]!, source: rawLabels["source"]!, preview: rawLabels["preview"]!)
    }
    var bootstrap: GuiPluginPreviewBootstrap { GuiPluginPreviewBootstrap(runtimeKey: runtimeKey, locale: locale, mode: mode, themeCSS: themeCSS, preferenceKey: preferenceKey) }
}

/// Native persistent backend for the official synchronous GUI storage API.
/// Only this Host's plugin state/preferences live here; bootstrap/options do not.
@MainActor final class GuiPluginPreviewStorage {
    private let file: URL
    private let preferenceKey: String
    private let runtimeKey: String
    private var values: [String: String]
    convenience init(directory: URL, connectionID: String) throws {
        let runtimeKey = GuiPluginNativeContext.runtimeKey(hostID: connectionID)
        try self.init(directory: directory, runtimeKey: runtimeKey, preferenceKey: GuiPluginNativeContext.preferenceKey(runtimeKey: runtimeKey))
    }
    func matches(runtimeKey: String, preferenceKey: String) -> Bool { self.runtimeKey == runtimeKey && self.preferenceKey == preferenceKey }
    init(directory: URL, runtimeKey: String, preferenceKey: String) throws {
        guard directory.isFileURL, !runtimeKey.isEmpty, !preferenceKey.isEmpty else { throw GuiPluginPreviewFailure.invalid }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let name = Data(runtimeKey.utf8).base64EncodedString().replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "+", with: "-")
        file = directory.appendingPathComponent(name + ".json")
        self.preferenceKey = preferenceKey
        self.runtimeKey = runtimeKey
        if FileManager.default.fileExists(atPath: file.path) {
            guard let stored = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: String] else { throw GuiPluginPreviewFailure.response }
            values = stored
        } else { values = [:] }
    }
    func transact(_ input: Any?) throws -> Any {
        guard let args = input as? [String: Any], let method = args["method"] as? String else { throw GuiPluginPreviewFailure.invalid }
        if method == "keys" { return values.keys.sorted() }
        if method == "clear" { try commit([:]); return true }
        guard let key = args["key"] as? String else { throw GuiPluginPreviewFailure.invalid }
        if key != preferenceKey {
            guard key.hasPrefix("yuri.gui-plugin."), let data = String(key.dropFirst("yuri.gui-plugin.".count)).data(using: .utf8),
                  let identity = try JSONSerialization.jsonObject(with: data) as? [Any], identity.first as? String == runtimeKey else { throw GuiPluginPreviewFailure.invalid }
        }
        if method == "get" { return values[key].map { $0 as Any } ?? NSNull() }
        var next = values
        if method == "set", let value = args["value"] as? String { next[key] = value }
        else if method == "remove" { next.removeValue(forKey: key) }
        else { throw GuiPluginPreviewFailure.invalid }
        try commit(next); return true
    }
    private func commit(_ next: [String: String]) throws {
        let bytes = try JSONSerialization.data(withJSONObject: next, options: [.sortedKeys])
        #if os(iOS)
        try bytes.write(to: file, options: [.atomic, .completeFileProtection])
        #else
        try bytes.write(to: file, options: [.atomic])
        #endif
        values = next
    }
}

/// Resolved by the owning NSH i18n caller, not a second native translation table.
struct GuiPluginPreviewLabels {
    let loading: String
    let failed: String
    let back: String
    let close: String
    let retry: String
    var source: String? = nil
    var preview: String? = nil
}

/// Immutable, bounded snapshot of explicitly staged application assets. No scan,
/// plugin download, inferred entrypoint or fallback HTML. The build owner passes
/// the actual separate browser composition manifest from its trusted bundle.
struct GuiPluginPreviewAssets {
    private let entries: [String: ResourceWebPreviewResponse]
    init(stagedDirectory: URL) throws {
        let file = stagedDirectory.appendingPathComponent("manifest.json")
        let handle = try FileHandle(forReadingFrom: file)
        let data: Data
        do { data = try handle.read(upToCount: 131073) ?? Data(); try handle.close() }
        catch { try? handle.close(); throw error }
        guard data.count <= 131072, let root = try JSONSerialization.jsonObject(with: data) as? [String: Any], root["version"] as? Int == 1,
              root["entry"] as? String == GuiPluginPreviewScope.entry, let assets = root["assets"] as? [String: [String: Any]] else { throw GuiPluginPreviewFailure.invalid }
        var types: [String: String] = [:]
        for (path, value) in assets { guard let mime = value["mime"] as? String else { throw GuiPluginPreviewFailure.invalid }; types[path] = mime }
        try self.init(directory: stagedDirectory, manifest: types)
        for (path, value) in assets {
            guard let response = entries[path], let count = value["bytes"] as? Int, count == response.data.count,
                  let digest = value["sha256"] as? String,
                  digest == SHA256.hash(data: response.data).map({ String(format: "%02x", $0) }).joined() else { throw GuiPluginPreviewFailure.response }
        }
    }
    init(directory: URL, manifest: [String: String]) throws {
        guard directory.isFileURL, manifest[GuiPluginPreviewScope.entry]?.split(separator: ";").first == "text/html",
              !manifest.isEmpty, manifest.count <= 256 else { throw GuiPluginPreviewFailure.invalid }
        let root = directory.resolvingSymlinksInPath().standardizedFileURL
        var entries: [String: ResourceWebPreviewResponse] = [:], total = 0
        for (path, mime) in manifest {
            guard let url = URL(string: GuiPluginPreviewScope.scheme + "://bundle" + path),
                  try GuiPluginPreviewScope.asset(url, owner: "bundle") == path,
                  !mime.isEmpty, !mime.contains("\r"), !mime.contains("\n") else { throw GuiPluginPreviewFailure.invalid }
            let file = root.appendingPathComponent(String(path.dropFirst())).resolvingSymlinksInPath().standardizedFileURL
            guard file.path.hasPrefix(root.path + "/") else { throw GuiPluginPreviewFailure.invalid }
            let handle = try FileHandle(forReadingFrom: file)
            let data: Data
            do { data = try handle.read(upToCount: GuiPluginPreviewScope.limit + 1) ?? Data(); try handle.close() }
            catch { try? handle.close(); throw error }
            guard data.count <= GuiPluginPreviewScope.limit, data.count <= ResourceWebPreviewScope.totalLimit - total else { throw GuiPluginPreviewFailure.limit }
            total += data.count
            entries[path] = ResourceWebPreviewResponse(status: 200, mime: mime, data: data)
        }
        self.entries = entries
    }
    func read(_ path: String, limit: Int) throws -> ResourceWebPreviewResponse {
        guard limit > 0, limit <= GuiPluginPreviewScope.limit, let response = entries[path] else { throw GuiPluginPreviewFailure.unavailable }
        guard response.data.count <= limit else { throw GuiPluginPreviewFailure.limit }
        return response
    }
}

struct GuiPluginPreviewScope {
    static let scheme = "yuri-plugin"
    static let entry = "/index.html"
    static let limit = ResourceWebPreviewScope.responseLimit
    static let replyLimit = 32 * 1024 * 1024
    // The existing host evaluates official CJS. CSP permits that operation only
    // inside this isolated, ephemeral content document; it grants no native main.
    static let policy = "default-src 'none'; script-src 'self' 'unsafe-eval' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'; frame-src 'self' blob:; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
    static func asset(_ url: URL, owner: String) throws -> String {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false), parts.scheme == scheme, parts.host == owner,
              parts.user == nil, parts.password == nil, parts.port == nil, parts.query == nil, parts.fragment == nil,
              let path = parts.percentEncodedPath.removingPercentEncoding, ResourceWebPreviewScope.canonicalFile(path),
              !path.contains("%"), path == entry || path.hasPrefix("/assets/") else { throw GuiPluginPreviewFailure.invalid }
        return path
    }
    /// Exact bootstrap GETs and the installed official SDK's POST RPC route.
    /// Other SDK requests still fail explicitly rather than gaining a general proxy.
    static func request(_ input: Any?) throws -> String {
        try GuiPluginPreviewRequest(input).route
    }
}

struct GuiPluginPreviewRequest {
    let method: String
    let route: String
    let headers: [String: String]
    let body: Data?
    init(_ input: Any?) throws {
        guard let args = input as? [String: Any], Set(args.keys).isSubset(of: ["method", "route", "headers", "body"]), let method = args["method"] as? String,
              let route = args["route"] as? String, route.utf8.count <= 16384, route.hasPrefix("/api/"), !route.hasPrefix("//"),
              !route.contains("\\"), !route.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }),
              let url = URLComponents(string: route), url.scheme == nil, url.host == nil, url.fragment == nil,
              let decoded = url.percentEncodedPath.removingPercentEncoding,
              !decoded.contains("\\"), !decoded.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else { throw GuiPluginPreviewFailure.invalid }
        let read = method == "GET" && ["/api/plugin", "/api/plugin/gui", "/api/fs/stat", "/api/fs/read", "/api/fs/list", "/api/fs/find"].contains(url.percentEncodedPath)
        let rpc = method == "POST" && url.percentEncodedPath.range(of: "^/api/rpc/[^/]+/[^/]+$", options: .regularExpression) != nil
        guard read || rpc, !url.percentEncodedPath.split(separator: "/").contains(where: { [".", ".."].contains(String($0).removingPercentEncoding ?? "..") }) else { throw GuiPluginPreviewFailure.unsupported }
        let forbidden: Set<String> = ["authorization", "token", "access_token", "api_key", "apikey", "oc_client_token", "yuri_client_token", "yuri_url_token", "yuri_preview_token"]
        guard !(url.queryItems ?? []).contains(where: { forbidden.contains($0.name.lowercased()) || ($0.value ?? "").unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) }) else { throw GuiPluginPreviewFailure.invalid }
        let rawHeaders = args["headers"] ?? [String: String]()
        guard let headers = rawHeaders as? [String: String] else { throw GuiPluginPreviewFailure.invalid }
        let allowed: Set<String> = ["accept", "content-type", "x-opencode-directory", "x-opencode-workspace", "x-yuri-gui-revision"]
        var normalized: [String: String] = [:]
        for (key, value) in headers {
            let name = key.lowercased()
            guard allowed.contains(name), normalized[name] == nil, !value.contains("\r"), !value.contains("\n"), !value.contains("\0") else { throw GuiPluginPreviewFailure.invalid }
            normalized[name] = value
        }
        if let value = args["body"] {
            guard !read, let text = value as? String, text.utf8.count <= GuiPluginPreviewScope.replyLimit else { throw GuiPluginPreviewFailure.invalid }
            body = Data(text.utf8)
        } else { body = nil }
        self.method = method; self.route = route; self.headers = normalized
    }
}

/// Foundation lifecycle is also exercised without WebKit, UIKit or an engine.
@MainActor final class GuiPluginPreviewLease {
    private let transport: ResourceWebPreviewTransport
    let expectedHost: RuntimeHostScope
    private let isCurrent: (RuntimeHostScope) -> Bool
    private let readGui: ((RuntimeHostScope, GuiPluginPreviewRequest, Int) async throws -> GuiPluginPreviewResponse)?
    private(set) var closed = false
    init(_ transport: ResourceWebPreviewTransport, expectedHost: RuntimeHostScope, isCurrent: @escaping (RuntimeHostScope) -> Bool, readGui: ((RuntimeHostScope, GuiPluginPreviewRequest, Int) async throws -> GuiPluginPreviewResponse)? = nil) { self.transport = transport; self.expectedHost = expectedHost; self.isCurrent = isCurrent; self.readGui = readGui }
    func check() throws {
        try Task.checkCancellation()
        guard !closed, isCurrent(expectedHost), transport.isCurrent() else { throw GuiPluginPreviewFailure.stale }
    }
    func read(_ input: Any?) async throws -> GuiPluginPreviewResponse {
        try check()
        let request = try GuiPluginPreviewRequest(input)
        var result: GuiPluginPreviewResponse
        if request.method == "GET", URLComponents(string: request.route)?.path == "/api/fs/stat", request.headers.isEmpty {
            let response = try await transport.readFile(request.route, GuiPluginPreviewScope.limit)
            result = GuiPluginPreviewResponse(status: response.status, mime: response.mime, data: response.data)
        } else {
            guard let readGui else { throw GuiPluginPreviewFailure.unsupported }
            result = try await readGui(expectedHost, request, GuiPluginPreviewScope.replyLimit)
        }
        try check()
        guard (200...599).contains(result.status), !(300..<400).contains(result.status), result.data.count <= GuiPluginPreviewScope.replyLimit,
              !result.mime.contains("\r"), !result.mime.contains("\n") else { throw GuiPluginPreviewFailure.response }
        result.headers = try GuiPluginPreviewResponseHeaders.checked(result.headers)
        return result
    }
    func close() { closed = true }
}

#if canImport(UIKit) && canImport(WebKit)
import UIKit
import WebKit

@MainActor final class GuiPluginPreviewBridge: NSObject, UIAdaptivePresentationControllerDelegate {
    private weak var controller: UIViewController?
    private let capture: (RuntimeHostScope) throws -> GuiPluginPreviewCapture
    private let ownership = GuiPluginPreviewOwnership()
    private var surface: GuiPluginPreviewSurface?
    private weak var navigation: UINavigationController?
    private var operation: Task<Any?, Error>?
    private var completion: CheckedContinuation<Any?, Error>?
    init(controller: UIViewController, capture: @escaping (RuntimeHostScope) throws -> GuiPluginPreviewCapture) {
        self.controller = controller; self.capture = capture
    }
    func present(_ input: Any?) async throws -> Any? {
        guard UIApplication.shared.applicationState == .active else { throw GuiPluginPreviewFailure.stale }
        let ticket = try ownership.begin(input, capture: capture, requireContext: true)
        let work = Task { try await self.prepareAndPresent(ticket) }
        operation = work
        defer { if ownership.matches(ticket) { terminate(ticket, result: .failure(CancellationError()), animated: false) } }
        return try await withTaskCancellationHandler(operation: { try await work.value }, onCancel: {
            work.cancel()
            Task { @MainActor [weak self] in self?.terminate(ticket, result: .failure(CancellationError()), animated: false) }
        })
    }
    private func prepareAndPresent(_ ticket: GuiPluginPreviewOwnership.Ticket) async throws -> Any? {
        try Task.checkCancellation()
        guard ownership.matches(ticket), surface == nil, completion == nil, let controller, controller.presentedViewController == nil else { throw GuiPluginPreviewFailure.busy }
        let intent = ticket.intent, captured = ticket.captured
        guard captured.readGui != nil || captured.openGui != nil else { throw GuiPluginPreviewFailure.unsupported }
        guard captured.bootstrap != nil, captured.storage != nil, let labels = captured.labels, labels.source != nil, labels.preview != nil else { throw GuiPluginPreviewFailure.unavailable }
        let lease = GuiPluginPreviewLease(captured.resource, expectedHost: intent.expectedHost, isCurrent: captured.isCurrent, readGui: captured.readGui)
        let current = { [weak self] in self?.ownership.matches(ticket) == true && captured.isCurrent(intent.expectedHost) && captured.resource.isCurrent() && UIApplication.shared.applicationState == .active }
        try lease.check()
        // Never generate an empty/static placeholder if the real browser entry is missing.
        let entry = try await captured.readAsset(GuiPluginPreviewScope.entry, GuiPluginPreviewScope.limit)
        try Task.checkCancellation(); guard current() else { throw GuiPluginPreviewFailure.stale }
        try ResourceWebPreviewScope.validate(entry, document: true)
        guard let rules = try await WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "yuri-plugin-no-network", encodedContentRuleList: ResourceWebPreviewScope.networkRules) else { throw GuiPluginPreviewFailure.response }
        try Task.checkCancellation(); guard current(), controller.presentedViewController == nil else { throw GuiPluginPreviewFailure.stale }
        let surface = GuiPluginPreviewSurface(intent: intent, capture: captured, labels: labels, lease: lease, entry: entry, rules: rules, current: current)
        surface.onClose = { [weak self] in self?.terminate(ticket, result: .success(["closed": true]), animated: true) }
        return try await withTaskCancellationHandler(operation: {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                self.surface = surface; completion = continuation
                let nav = UINavigationController(rootViewController: surface)
                navigation = nav
                controller.present(nav, animated: true); nav.presentationController?.delegate = self
            }
        }, onCancel: { Task { @MainActor [weak self] in self?.terminate(ticket, result: .failure(CancellationError()), animated: false) } })
    }
    func invalidate() {
        if let ticket = ownership.active { terminate(ticket, result: .failure(GuiPluginPreviewFailure.stale), animated: false) }
    }
    func close(_ input: Any?) async throws {
        if let ticket = try ownership.closing(input, capture: capture) {
            terminate(ticket, result: .failure(CancellationError()), animated: false)
            await ownership.waitClosed(ticket)
        }
    }
    private func terminate(_ ticket: GuiPluginPreviewOwnership.Ticket, result: Result<Any?, Error>, animated: Bool) {
        guard ownership.startClosing(ticket) else { return }
        let work = operation; operation = nil
        let pending = completion; completion = nil
        let old = surface; surface = nil
        let nav = navigation; navigation = nil
        old?.stop(); nav?.presentationController?.delegate = nil; work?.cancel()
        let settled = { [self] in if ownership.retire(ticket) { pending?.resume(with: result) } }
        if let nav, nav.presentingViewController != nil { nav.dismiss(animated: animated, completion: settled) }
        else { settled() }
    }
    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        guard let ticket = ownership.active, presentationController.presentedViewController === navigation else { return }
        terminate(ticket, result: .success(["closed": true]), animated: false)
    }
}

@MainActor private final class GuiPluginPreviewChannel: NSObject, WKURLSchemeHandler, WKScriptMessageHandlerWithReply {
    weak var surface: GuiPluginPreviewSurface?
    init(_ surface: GuiPluginPreviewSurface) { self.surface = surface }
    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) { surface?.start(urlSchemeTask) }
    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) { surface?.cancel(urlSchemeTask) }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        guard let surface else { replyHandler(nil, GuiPluginPreviewFailure.stale.rawValue); return }
        surface.receive(message, reply: replyHandler)
    }
}

@MainActor private final class GuiPluginPreviewSurface: UIViewController, WKNavigationDelegate, WKUIDelegate {
    private let labels: GuiPluginPreviewLabels
    private let intent: GuiPluginPreviewIntent, captured: GuiPluginPreviewCapture, lease: GuiPluginPreviewLease
    private let initial: ResourceWebPreviewResponse, rules: WKContentRuleList, current: () -> Bool
    private var owner = UUID().uuidString.lowercased()
    private var web: WKWebView?
    private var tasks: [UUID: Task<Void, Never>] = [:]
    private var requestsByID: [String: UUID] = [:]
    private var streams: [String: GuiPluginPreviewStreamLease] = [:]
    private var schemes: [ObjectIdentifier: UUID] = [:]
    private var stopped = false
    private var bytes = 0, requests = 0
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let failureLabel = UILabel()
    private var retryButton: UIBarButtonItem?
    var onClose: (() -> Void)?
    init(intent: GuiPluginPreviewIntent, capture: GuiPluginPreviewCapture, labels: GuiPluginPreviewLabels, lease: GuiPluginPreviewLease, entry: ResourceWebPreviewResponse, rules: WKContentRuleList, current: @escaping () -> Bool) {
        self.labels = labels
        self.intent = intent; self.captured = capture; self.lease = lease; self.initial = entry; self.rules = rules; self.current = current
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) unavailable") }
    override func loadView() {
        let configuration = WKWebViewConfiguration(), channel = GuiPluginPreviewChannel(self)
        configuration.websiteDataStore = .nonPersistent()
        configuration.setURLSchemeHandler(channel, forURLScheme: GuiPluginPreviewScope.scheme)
        configuration.userContentController.add(rules)
        configuration.userContentController.addScriptMessageHandler(channel, contentWorld: .page, name: "guiPluginPreview")
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.allowsAirPlayForMediaPlayback = false
        let web = WKWebView(frame: .zero, configuration: configuration); self.web = web
        web.navigationDelegate = self; web.uiDelegate = self; view = web
        navigationItem.leftBarButtonItem = UIBarButtonItem(image: UIImage(systemName: "chevron.backward"), style: .plain, target: self, action: #selector(back))
        navigationItem.rightBarButtonItem = UIBarButtonItem(systemItem: .close, primaryAction: UIAction { [weak self] _ in self?.onClose?() })
        retryButton = UIBarButtonItem(systemItem: .refresh, primaryAction: UIAction { [weak self] _ in self?.retry() })
        navigationItem.leftBarButtonItem?.accessibilityLabel = labels.back
        navigationItem.rightBarButtonItem?.accessibilityLabel = labels.close
        retryButton?.accessibilityLabel = labels.retry
        spinner.accessibilityLabel = labels.loading
        failureLabel.text = labels.failed; failureLabel.numberOfLines = 2
        failureLabel.font = .preferredFont(forTextStyle: .caption1); failureLabel.adjustsFontForContentSizeCategory = true
        spinner.translatesAutoresizingMaskIntoConstraints = false; view.addSubview(spinner)
        NSLayoutConstraint.activate([spinner.centerXAnchor.constraint(equalTo: view.centerXAnchor), spinner.centerYAnchor.constraint(equalTo: view.centerYAnchor)])
        retry()
    }
    @objc private func back() { if web?.canGoBack == true { web?.goBack() } else { onClose?() } }
    private func retry() {
        guard !stopped, current() else { onClose?(); return }
        cancelAll(); bytes = 0; requests = 0; owner = UUID().uuidString.lowercased()
        navigationItem.titleView = spinner; spinner.startAnimating(); navigationItem.rightBarButtonItems = [navigationItem.rightBarButtonItem].compactMap { $0 }
        if let url = URL(string: GuiPluginPreviewScope.scheme + "://" + owner + GuiPluginPreviewScope.entry) { web?.load(URLRequest(url: url)) }
    }
    private func failed() {
        spinner.stopAnimating(); navigationItem.titleView = failureLabel
        // Native system controls supply localized labels; raw plugin errors never cross to UIKit.
        if let close = navigationItem.rightBarButtonItems?.first, let retryButton { navigationItem.rightBarButtonItems = [close, retryButton] }
    }
    private func cancelAll() { tasks.values.forEach { $0.cancel() }; tasks.removeAll(); schemes.removeAll(); requestsByID.removeAll(); streams.values.forEach { $0.stop() }; streams.removeAll(); web?.stopLoading() }
    func stop() {
        guard !stopped else { return }; stopped = true; lease.close(); cancelAll()
        web?.configuration.userContentController.removeScriptMessageHandler(forName: "guiPluginPreview", contentWorld: .page)
        web?.navigationDelegate = nil; web?.uiDelegate = nil; web?.removeFromSuperview(); web = nil
    }
    func checkAdmission(_ expectedHost: RuntimeHostScope) throws {
        guard !stopped, current(), lease.expectedHost == expectedHost else { throw GuiPluginPreviewFailure.stale }
        try lease.check()
    }
    func start(_ scheme: WKURLSchemeTask) {
        guard !stopped, current(), tasks.count < 8, requests < 256, scheme.request.httpMethod == "GET", let url = scheme.request.url,
              let path = try? GuiPluginPreviewScope.asset(url, owner: owner) else { scheme.didFailWithError(GuiPluginPreviewFailure.invalid); return }
        let key = ObjectIdentifier(scheme), id = UUID(), generation = owner
        schemes[key] = id; requests += 1
        tasks[id] = Task { [weak self] in
            guard let self else { return }
            do {
                let response = path == GuiPluginPreviewScope.entry ? initial : try await captured.readAsset(path, GuiPluginPreviewScope.limit)
                try Task.checkCancellation(); try lease.check()
                guard !stopped, current(), owner == generation, schemes[key] == id else { throw GuiPluginPreviewFailure.stale }
                try ResourceWebPreviewScope.validate(response, document: path == GuiPluginPreviewScope.entry)
                guard response.data.count <= ResourceWebPreviewScope.totalLimit - bytes else { throw GuiPluginPreviewFailure.limit }
                bytes += response.data.count
                let headers = ["Content-Type": response.mime, "Content-Security-Policy": GuiPluginPreviewScope.policy + (response.contentSecurityPolicy.map { ", " + $0 } ?? ""), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff"]
                guard let head = HTTPURLResponse(url: url, statusCode: response.status, httpVersion: "HTTP/1.1", headerFields: headers) else { throw GuiPluginPreviewFailure.response }
                scheme.didReceive(head); scheme.didReceive(response.data); scheme.didFinish()
            } catch { if schemes[key] == id, !stopped { scheme.didFailWithError(GuiPluginPreviewFailure.response); failed() } }
            schemes.removeValue(forKey: key); tasks.removeValue(forKey: id)
        }
    }
    func cancel(_ scheme: WKURLSchemeTask) { if let id = schemes.removeValue(forKey: ObjectIdentifier(scheme)) { tasks.removeValue(forKey: id)?.cancel() } }
    func receive(_ message: WKScriptMessage, reply: @escaping (Any?, String?) -> Void) {
        guard !stopped, current(), message.frameInfo.isMainFrame, message.webView === web,
              let url = message.frameInfo.request.url, (try? GuiPluginPreviewScope.asset(url, owner: owner)) == GuiPluginPreviewScope.entry,
              let args = message.body as? [String: Any], let name = args["name"] as? String else { reply(nil, GuiPluginPreviewFailure.stale.rawValue); return }
        if name == "intent" { reply(intent.json, nil); return }
        if name == "bootstrap" {
            guard let bootstrap = captured.bootstrap, captured.storage != nil, !bootstrap.runtimeKey.isEmpty,
                  ["light", "dark"].contains(bootstrap.mode), !bootstrap.locale.isEmpty, !bootstrap.themeCSS.isEmpty,
                  let source = labels.source, let preview = labels.preview else { reply(nil, GuiPluginPreviewFailure.unavailable.rawValue); return }
            var value = bootstrap.json
            value["intent"] = intent.json
            value["labels"] = ["loading": labels.loading, "failed": labels.failed, "retry": labels.retry, "source": source, "preview": preview]
            reply(value, nil); return
        }
        guard let expectedHost = try? RuntimeHostScope(args["expectedHost"]), expectedHost == lease.expectedHost else { reply(nil, GuiPluginPreviewFailure.stale.rawValue); return }
        if name == "cancel" {
            guard let requestID = args["id"] as? String else { reply(nil, GuiPluginPreviewFailure.invalid.rawValue); return }
            if let taskID = requestsByID.removeValue(forKey: requestID) { tasks[taskID]?.cancel() }
            streams.removeValue(forKey: requestID)?.stop()
            reply(true, nil); return
        }
        if name == "chunk" {
            guard let requestID = args["id"] as? String, let stream = streams[requestID], tasks.count < 8, requestsByID[requestID] == nil else { reply(nil, GuiPluginPreviewFailure.stale.rawValue); return }
            let taskID = UUID(), generation = owner
            requestsByID[requestID] = taskID
            tasks[taskID] = Task { [weak self] in
                guard let self else { reply(nil, GuiPluginPreviewFailure.stale.rawValue); return }
                defer { tasks.removeValue(forKey: taskID); if requestsByID[requestID] == taskID { requestsByID.removeValue(forKey: requestID) } }
                do {
                    let data = try await stream.next()
                    try Task.checkCancellation(); guard !stopped, current(), owner == generation else { throw GuiPluginPreviewFailure.stale }
                    if data == nil { stream.retire(from: &streams, requestID: requestID, document: generation, currentDocument: owner, task: taskID, currentTask: requestsByID[requestID]) }
                    reply(["done": data == nil, "base64": data?.base64EncodedString() ?? ""], nil)
                } catch { stream.retire(from: &streams, requestID: requestID, document: generation, currentDocument: owner, task: taskID, currentTask: requestsByID[requestID]); reply(nil, GuiPluginPreviewFailure.response.rawValue) }
            }
            return
        }
        if name == "state" {
            guard let phase = args["phase"] as? String, ["loading", "mounted", "source", "unmatched", "error", "closed"].contains(phase) else { reply(nil, GuiPluginPreviewFailure.invalid.rawValue); return }
            if phase == "loading" { spinner.startAnimating() }
            else { spinner.stopAnimating(); navigationItem.titleView = nil }
            if phase == "error" || phase == "unmatched" { failed() }
            reply(true, nil); return
        }
        guard name == "request", tasks.count + streams.count < 8, let requestID = args["id"] as? String, requestID.utf8.count <= 64,
              requestID.range(of: "^[0-9]+$", options: .regularExpression) != nil, requestsByID[requestID] == nil, streams[requestID] == nil else { reply(nil, GuiPluginPreviewFailure.unsupported.rawValue); return }
        let id = UUID(), generation = owner
        requestsByID[requestID] = id
        tasks[id] = Task { [weak self] in
            guard let self else { reply(nil, GuiPluginPreviewFailure.stale.rawValue); return }
            defer { tasks.removeValue(forKey: id); if requestsByID[requestID] == id { requestsByID.removeValue(forKey: requestID) } }
            do {
                if let open = captured.openGui {
                    try lease.check()
                    let raw = try await open(lease.expectedHost, GuiPluginPreviewRequest(args["input"]))
                    do {
                        try Task.checkCancellation(); try lease.check()
                        guard !stopped, current(), owner == generation else { throw GuiPluginPreviewFailure.stale }
                        let stream = try GuiPluginPreviewStreamLease(raw, check: { [weak self] in
                            guard let self, !self.stopped, self.current(), self.owner == generation else { throw GuiPluginPreviewFailure.stale }
                            try self.lease.check()
                        })
                        streams[requestID] = stream
                        reply(["status": stream.status, "mime": stream.mime, "headers": stream.headers, "stream": true], nil)
                    } catch { raw.cancel(); throw error }
                    return
                }
                let result = try await lease.read(args["input"])
                try Task.checkCancellation(); guard !stopped, current(), owner == generation else { throw GuiPluginPreviewFailure.stale }
                // Bytes/options only in this main-frame reply, never in a URL, script literal or snapshot.
                reply(["status": result.status, "mime": result.mime, "headers": result.headers, "base64": result.data.base64EncodedString()], nil)
            } catch { reply(nil, GuiPluginPreviewFailure.response.rawValue) }
        }
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let allowed = !stopped && current() && navigationAction.targetFrame?.isMainFrame == true && navigationAction.request.httpMethod == "GET"
            && navigationAction.request.url.map { (try? GuiPluginPreviewScope.asset($0, owner: owner)) == GuiPluginPreviewScope.entry } == true
        decisionHandler(allowed ? .allow : .cancel)
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { if !stopped { failed() } }
    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        guard prompt == "yuri.gui.storage.v1", !stopped, current(), webView === web, frame.isMainFrame,
              let url = frame.request.url, (try? GuiPluginPreviewScope.asset(url, owner: owner)) == GuiPluginPreviewScope.entry,
              let text = defaultText, let data = text.data(using: .utf8), let storage = captured.storage else { completionHandler(nil); return }
        do {
            let request = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            let expected = try RuntimeHostScope(request?["expectedHost"])
            try checkAdmission(expected)
            let result = try storage.transact(request?["operation"])
            try checkAdmission(expected)
            let reply = try JSONSerialization.data(withJSONObject: ["ok": true, "value": result], options: [.fragmentsAllowed])
            completionHandler(String(data: reply, encoding: .utf8))
        } catch { completionHandler("{\"ok\":false}") }
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { if !stopped { failed() } }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { if !stopped { failed() } }
}

#if canImport(NativeShell)
import NativeShell
extension GuiPluginPreviewBridge {
    func install(on app: NshAppView) {
        app.handle("plugins.preview.present") { [weak self] input async throws -> Any? in
            guard let self else { throw GuiPluginPreviewFailure.unavailable }; return try await self.present(input)
        }
        app.handle("plugins.preview.close") { [weak self] input async throws -> Any? in
            guard let self else { throw GuiPluginPreviewFailure.unavailable }; try await self.close(input); return true
        }
    }
}
#endif
#endif
