import Foundation

enum GuiPluginResourceFailure: String, Error {
    case invalid = "GUI_RESOURCE_INVALID", outside = "GUI_RESOURCE_OUTSIDE_WORKSPACE"
    case unavailable = "GUI_RESOURCE_PREVIEW_TRANSPORT_CORE_GAP", stale = "GUI_RESOURCE_STALE", limit = "GUI_RESOURCE_LIMIT"
    case hostIdentity = "GUI_RESOURCE_HOST_IDENTITY_CORE_GAP"
}

/// Scoped URL handler for file and loopback iframe/font/image/style resources.
/// Its only IO is the already captured ResourceWebPreviewTransport; preview
/// tokens stay inside that transport and never enter WK URLs or JavaScript.
@MainActor final class GuiPluginResourceResolver {
    private let directory: String
    private let transport: ResourceWebPreviewTransport
    private let isHostResourceURL: ((URL) -> Bool)?
    private var proxies: [String: ResourceWebPreviewProxy] = [:]
    private var preparing: [String: Task<ResourceWebPreviewProxy, Error>] = [:]
    private var stopped = false
    init(directory: String, transport: ResourceWebPreviewTransport, isHostResourceURL: ((URL) -> Bool)? = nil) throws {
        guard ResourceWebPreviewScope.canonicalFile(directory) else { throw GuiPluginResourceFailure.invalid }
        self.directory = directory; self.transport = transport; self.isHostResourceURL = isHostResourceURL
    }
    private func check() throws {
        try Task.checkCancellation(); guard !stopped, transport.isCurrent() else { throw GuiPluginResourceFailure.stale }
    }
    func read(_ url: URL, owner: String) async throws -> ResourceWebPreviewResponse {
        try check()
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false), parts.scheme == GuiPluginPreviewScope.scheme,
              parts.host == owner, parts.port == nil, parts.user == nil, parts.password == nil else { throw GuiPluginResourceFailure.invalid }
        let result: ResourceWebPreviewResponse
        if parts.percentEncodedPath.hasPrefix("/__gui/host/") {
            guard parts.query == nil, let isHostResourceURL else { throw GuiPluginResourceFailure.hostIdentity }
            let remainder = String(parts.percentEncodedPath.dropFirst("/__gui/host/".count))
            guard let separator = remainder.firstIndex(of: "/") else { throw GuiPluginResourceFailure.invalid }
            let encoded = String(remainder[..<separator]), suffix = String(remainder[separator...])
            var base64 = encoded.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
            base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
            guard encoded.utf8.count <= 16384, let data = Data(base64Encoded: base64), let value = String(data: data, encoding: .utf8),
                  let origin = URLComponents(string: value), ["https", "http"].contains(origin.scheme?.lowercased() ?? ""),
                  origin.host?.isEmpty == false, origin.percentEncodedPath.isEmpty, origin.user == nil, origin.password == nil, origin.query == nil, origin.fragment == nil,
                  let target = URLComponents(string: value + suffix),
                  target.percentEncodedPath.hasPrefix("/api/fs/serve/"), let targetURL = target.url,
                  isHostResourceURL(targetURL) else { throw GuiPluginResourceFailure.invalid }
            let localPath = String(target.percentEncodedPath.dropFirst("/api/fs/serve".count))
            guard let local = URL(string: GuiPluginPreviewScope.scheme + "://" + owner + "/__gui/files" + localPath) else { throw GuiPluginResourceFailure.invalid }
            return try await read(local, owner: owner)
        } else if parts.percentEncodedPath.hasPrefix("/__gui/files/") {
            guard parts.query == nil, let path = String(parts.percentEncodedPath.dropFirst("/__gui/files".count)).removingPercentEncoding,
                  !path.contains("%"), ResourceWebPreviewScope.canonicalFile(path), ResourceWebPreviewScope.within(path, directory) else { throw GuiPluginResourceFailure.outside }
            result = try await transport.readFile("/api/fs/serve" + ResourceWebPreviewScope.encodePath(path), ResourceWebPreviewScope.responseLimit)
        } else if parts.percentEncodedPath.hasPrefix("/__gui/loopback/") {
            let remainder = String(parts.percentEncodedPath.dropFirst("/__gui/loopback/".count))
            guard let separator = remainder.firstIndex(of: "/") else { throw GuiPluginResourceFailure.invalid }
            let encoded = String(remainder[..<separator]), suffix = String(remainder[separator...])
            var base64 = encoded.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
            base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
            guard let data = Data(base64Encoded: base64), let origin = String(data: data, encoding: .utf8) else { throw GuiPluginResourceFailure.invalid }
            let parsed = try ResourceWebPreviewScope.loopback(origin)
            guard parsed.percentEncodedPath.isEmpty || parsed.percentEncodedPath == "/", parsed.query == nil, parsed.fragment == nil else { throw GuiPluginResourceFailure.invalid }
            let target = try ResourceWebPreviewScope.loopback(origin + suffix + (parts.percentEncodedQuery.map { "?" + $0 } ?? ""))
            let proxy: ResourceWebPreviewProxy
            if let cached = proxies[origin], cached.expiresAt > Date() { proxy = cached }
            else {
                guard let prepare = transport.prepareLoopback else { throw GuiPluginResourceFailure.unavailable }
                guard proxies.count + preparing.count < 16 || preparing[origin] != nil || proxies[origin] != nil else { throw GuiPluginResourceFailure.limit }
                let task = preparing[origin] ?? Task { try await prepare(origin + "/") }
                preparing[origin] = task
                do { proxy = try await task.value; try check(); proxies[origin] = proxy; preparing.removeValue(forKey: origin) }
                catch { preparing.removeValue(forKey: origin); throw error }
            }
            let scope = try ResourceWebPreviewScope.proxy(basePath: proxy.basePath, target: target)
            guard let request = URL(string: ResourceWebPreviewScope.scheme + "://" + owner + scope.entryPath) else { throw GuiPluginResourceFailure.invalid }
            result = try await proxy.read(scope.route(request, owner: owner), ResourceWebPreviewScope.responseLimit)
        } else if parts.percentEncodedPath.hasPrefix("/api/preview/proxy/") {
            guard let proxy = proxies.values.first(where: { parts.percentEncodedPath.hasPrefix($0.basePath + "/") }), proxy.expiresAt > Date() else { throw GuiPluginResourceFailure.stale }
            // read itself validates the exact prepared target and strips any legacy scoped token.
            result = try await proxy.read(parts.percentEncodedPath + (parts.percentEncodedQuery.map { "?" + $0 } ?? ""), ResourceWebPreviewScope.responseLimit)
        } else { throw GuiPluginResourceFailure.invalid }
        try check(); try ResourceWebPreviewScope.validate(result, document: false); return result
    }
    func stop() { stopped = true; preparing.values.forEach { $0.cancel() }; preparing.removeAll(); proxies.removeAll() }
}
