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

/// SVG is decoded only as an image inside a fixed wrapper, never as a top-level
/// document. Preserve the complete source (CSS, SMIL, filters and data images).
enum ResourceSVGImageDocument {
    static let byteLimit = 1_000_000
    static let policy = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
    static let networkRules = """
    [{"trigger":{"url-filter":".*"},"action":{"type":"block"}},
     {"trigger":{"url-filter":"^data:"},"action":{"type":"ignore-previous-rules"}},
     {"trigger":{"url-filter":"^about:blank$"},"action":{"type":"ignore-previous-rules"}}]
    """
    static func wrapper(_ data: Data) throws -> String {
        guard data.count <= byteLimit else { throw ResourceWebPreviewFailure.limit }
        return """
        <!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="\(policy)"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}img{display:block;width:100%;height:100%;object-fit:contain}</style></head><body><img id="image" alt="SVG" src="data:image/svg+xml;base64,\(data.base64EncodedString())"></body></html>
        """
    }
    static func load(_ url: URL) throws -> String {
        guard url.isFileURL else { throw ResourceWebPreviewFailure.invalid }
        let file = try FileHandle(forReadingFrom: url); defer { try? file.close() }
        return try wrapper(file.read(upToCount: byteLimit + 1) ?? Data())
    }
}

struct ResourceSVGImageRequest: Equatable {
    let lease: String
    let expectedHost: RuntimeHostScope
    let active: Bool
    init(_ input: Any?) throws {
        guard let value = input as? [String: Any], Set(value.keys) == ["lease", "expectedHost", "active"],
              let lease = value["lease"] as? String, UUID(uuidString: lease) != nil,
              let active = value["active"] as? NSNumber, CFGetTypeID(active) == CFBooleanGetTypeID() else { throw ResourceWebPreviewFailure.invalid }
        self.lease = lease; expectedHost = try RuntimeHostScope(value["expectedHost"]); self.active = active.boolValue
    }
}

/// Shared by pure state tests and UIKit's asynchronous rules/local-byte preparation.
struct ResourceSVGImageLifetime {
    private(set) var request: ResourceSVGImageRequest?
    private(set) var generation = 0
    private(set) var retired = false
    mutating func update(_ value: Any?) -> Bool {
        let next = try? ResourceSVGImageRequest(value)
        guard next != request else { return false }
        request = next; retired = false; generation += 1; return true
    }
    mutating func stop() { generation += 1 }
    mutating func retire() { retired = true; stop() }
    func accepts(_ ticket: Int) -> Bool { ticket == generation && request?.active == true && !retired }
}

struct ResourceSVGImagePresentation {
    enum Phase { case stopped, loading, decoding, ready, failed, expired }
    private(set) var phase: Phase = .stopped
    private var ticket: Int?
    mutating func begin(_ generation: Int) { ticket = generation; phase = .loading }
    @discardableResult mutating func wrapperFinished(_ generation: Int) -> Bool {
        guard ticket == generation, phase == .loading else { return false }
        phase = .decoding; return true
    }
    @discardableResult mutating func decoded(_ generation: Int, success: Bool) -> Bool {
        guard ticket == generation, phase == .decoding else { return false }
        phase = success ? .ready : .failed; return true
    }
    @discardableResult mutating func fail(_ generation: Int, expired: Bool = false) -> Bool {
        guard ticket == generation else { return false }
        ticket = nil; phase = expired ? .expired : .failed; return true
    }
    mutating func stop() { ticket = nil; phase = .stopped }
    mutating func expire() { ticket = nil; phase = .expired }
}

/// Fixed wrapper inspection only. No source interpolation, page-world execution,
/// event bridge, network, SVG DOM traversal or SVG text leaves this private world.
enum ResourceSVGImageDecodeProbe {
    static let script = """
    const image = document.getElementById('image');
    if (!(image instanceof HTMLImageElement) || document.images.length !== 1 || image.parentElement !== document.body || !image.getAttribute('src')?.startsWith('data:image/svg+xml;base64,')) return false;
    try { await image.decode(); return image.complete && image.naturalWidth > 0 && image.naturalHeight > 0; }
    catch { return false; }
    """
}

/// Native UIKit controls follow the system language, like Save/Share system UI.
/// All supported app languages have real copy; no raw WK error/path is displayed.
struct ResourceSVGImageCopy {
    let loading: String, failed: String, expired: String, retry: String, image: String
    static func localized(_ language: String = Locale.preferredLanguages.first ?? "en") -> Self {
        let key = language.lowercased().replacingOccurrences(of: "_", with: "-")
        if key.hasPrefix("zh-hant") || key.hasPrefix("zh-tw") || key.hasPrefix("zh-hk") || key.hasPrefix("zh-mo") { return .init(loading: "正在載入 SVG…", failed: "SVG 預覽失敗。請重試，或儲存／分享原始檔案。", expired: "預覽已失效，請重新開啟檔案。", retry: "重試", image: "SVG 圖片") }
        if key.hasPrefix("zh") { return .init(loading: "正在加载 SVG…", failed: "SVG 预览失败。请重试，或保存／分享原文件。", expired: "预览已失效，请重新打开文件。", retry: "重试", image: "SVG 图片") }
        if key.hasPrefix("ja") { return .init(loading: "SVG を読み込み中…", failed: "SVG をプレビューできません。再試行するか、元のファイルを保存・共有してください。", expired: "プレビューは無効になりました。ファイルを開き直してください。", retry: "再試行", image: "SVG 画像") }
        if key.hasPrefix("ko") { return .init(loading: "SVG 불러오는 중…", failed: "SVG 미리보기에 실패했습니다. 다시 시도하거나 원본 파일을 저장하거나 공유하세요.", expired: "미리보기가 만료되었습니다. 파일을 다시 여세요.", retry: "다시 시도", image: "SVG 이미지") }
        if key.hasPrefix("fr") { return .init(loading: "Chargement du SVG…", failed: "Échec de l’aperçu SVG. Réessayez ou enregistrez ou partagez le fichier original.", expired: "L’aperçu a expiré. Rouvrez le fichier.", retry: "Réessayer", image: "Image SVG") }
        if key.hasPrefix("es") { return .init(loading: "Cargando SVG…", failed: "No se pudo mostrar el SVG. Reinténtalo o guarda o comparte el archivo original.", expired: "La vista previa ha caducado. Abre el archivo de nuevo.", retry: "Reintentar", image: "Imagen SVG") }
        if key.hasPrefix("pl") { return .init(loading: "Wczytywanie SVG…", failed: "Nie udało się wyświetlić SVG. Spróbuj ponownie lub zapisz albo udostępnij oryginalny plik.", expired: "Podgląd wygasł. Otwórz plik ponownie.", retry: "Spróbuj ponownie", image: "Obraz SVG") }
        if key.hasPrefix("pt") { return .init(loading: "Carregando SVG…", failed: "Não foi possível visualizar o SVG. Tente novamente ou salve ou compartilhe o arquivo original.", expired: "A visualização expirou. Abra o arquivo novamente.", retry: "Tentar novamente", image: "Imagem SVG") }
        if key.hasPrefix("uk") { return .init(loading: "Завантаження SVG…", failed: "Не вдалося переглянути SVG. Повторіть спробу або збережіть чи поширте оригінальний файл.", expired: "Термін дії перегляду минув. Відкрийте файл знову.", retry: "Повторити", image: "Зображення SVG") }
        return .init(loading: "Loading SVG…", failed: "SVG preview failed. Retry, or save or share the original file.", expired: "This preview has expired. Reopen the file.", retry: "Retry", image: "SVG image")
    }
}

#if canImport(UIKit) && canImport(WebKit) && canImport(NativeShell)
import UIKit
import WebKit
import NativeShell

/// The resolver only returns an already verified private local lease. It has no
/// Host request capability and exposes neither raw SVG nor a filesystem path to JS.
@MainActor struct ResourceSVGImageAsset {
    let url: URL
    let current: () -> Bool
    let observeRetirement: (@escaping () -> Void) -> (() -> Void)
}

@MainActor enum ResourceSVGImageFactory {
    typealias Resolve = (String, RuntimeHostScope) throws -> ResourceSVGImageAsset
    static func controller(lease: String, expectedHost: RuntimeHostScope, resolve: @escaping Resolve) throws -> UIViewController {
        _ = try resolve(lease, expectedHost)
        let image = ResourceSVGImageView(resolve: resolve)
        image.update(["lease": lease, "expectedHost": expectedHost.publicValue, "active": true])
        return ResourceSVGImageController(image: image)
    }
}

@MainActor private final class ResourceSVGImageController: UIViewController {
    let image: ResourceSVGImageView
    init(image: ResourceSVGImageView) { self.image = image; super.init(nibName: nil, bundle: nil) }
    required init?(coder: NSCoder) { fatalError("init(coder:) unavailable") }
    override func loadView() { view = image }
    override func viewDidDisappear(_ animated: Bool) { super.viewDidDisappear(animated); image.stop() }
}

/// SVG has no native URLRequest navigation: the only document is its fixed local
/// wrapper loaded with loadHTMLString. Reject before WK can open a speculative
/// TCP connection, including calls dispatched through a WKWebView reference.
@MainActor final class ResourceSVGImageWebView: WKWebView {
    var nativeRequestBlocked: (() -> Void)?
    override func load(_ request: URLRequest) -> WKNavigation? {
        nativeRequestBlocked?()
        return nil
    }
}

/// One narrow WK image mode, shared by inline Files and the fullscreen controller.
/// HTML mode below retains its own configuration, scheme handler and scripting.
@MainActor final class ResourceSVGImageView: UIView, WKNavigationDelegate {
    enum Event { case wrapperLoaded, loaded, failed, stopped, navigationBlocked, nativeLoadBlocked, delegateNavigationBlocked }
    typealias Prepare = (URL) async throws -> (WKContentRuleList, String)
    var event: ((Event) -> Void)?
    private let resolve: ResourceSVGImageFactory.Resolve
    private let prepare: Prepare
    private var lifetime = ResourceSVGImageLifetime()
    private(set) var presentation = ResourceSVGImagePresentation()
    private var admittedEntry = false
    private var operation: Task<Void, Never>?
    private var decodeDeadline: Task<Void, Never>?
    private var unsubscribe: (() -> Void)?
    private var observers: [NSObjectProtocol] = []
    private var resourceCurrent: (() -> Bool)?
    private let copy = ResourceSVGImageCopy.localized()
    private let statusPanel = UIStackView(), statusLabel = UILabel(), spinner = UIActivityIndicatorView(style: .medium)
    private let retryButton = UIButton(type: .system)
    private(set) var webView: WKWebView?
    init(prepare: Prepare? = nil, resolve: @escaping ResourceSVGImageFactory.Resolve) {
        self.resolve = resolve; self.prepare = prepare ?? Self.prepareDocument; super.init(frame: .zero)
        isOpaque = false; backgroundColor = .clear
        statusLabel.numberOfLines = 0; statusLabel.textAlignment = .center
        statusLabel.font = .preferredFont(forTextStyle: .body); statusLabel.adjustsFontForContentSizeCategory = true
        statusLabel.textColor = .secondaryLabel; statusLabel.accessibilityIdentifier = "resource-svg-status"
        spinner.isAccessibilityElement = false
        var button = UIButton.Configuration.filled(); button.title = copy.retry
        button.baseBackgroundColor = .secondarySystemFill; button.baseForegroundColor = .label
        retryButton.configuration = button; retryButton.accessibilityIdentifier = "resource-svg-retry"
        retryButton.addTarget(self, action: #selector(retry), for: .touchUpInside)
        statusPanel.axis = .vertical; statusPanel.spacing = 12; statusPanel.alignment = .center
        for item in [spinner, statusLabel, retryButton] { statusPanel.addArrangedSubview(item) }
        addSubview(statusPanel); statusPanel.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([statusPanel.centerXAnchor.constraint(equalTo: centerXAnchor), statusPanel.centerYAnchor.constraint(equalTo: centerYAnchor),
            statusPanel.widthAnchor.constraint(lessThanOrEqualTo: widthAnchor, constant: -32), statusPanel.topAnchor.constraint(greaterThanOrEqualTo: topAnchor, constant: 12),
            statusPanel.bottomAnchor.constraint(lessThanOrEqualTo: bottomAnchor, constant: -12), retryButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 44)])
        renderStatus()
        for name in [UIApplication.willResignActiveNotification, UIApplication.didBecomeActiveNotification] {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] notification in
                MainActor.assumeIsolated {
                    if notification.name == UIApplication.willResignActiveNotification { self?.stop() }
                    else { self?.reconcile() }
                }
            })
        }
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) unavailable") }
    deinit { operation?.cancel(); decodeDeadline?.cancel(); unsubscribe?(); for observer in observers { NotificationCenter.default.removeObserver(observer) } }
    override func didMoveToWindow() { super.didMoveToWindow(); if window == nil { stop() } else { reconcile() } }
    override func layoutSubviews() { super.layoutSubviews(); webView?.frame = bounds }
    func update(_ value: Any?) {
        guard lifetime.update(value) else {
            if (try? ResourceSVGImageRequest(value)) == nil { expire() }
            return
        }
        stop()
        if lifetime.request == nil { expire() } else { reconcile() }
    }
    static func prepareDocument(_ url: URL) async throws -> (WKContentRuleList, String) {
        guard let rules = try await WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "yuri-resource-svg-image-no-network", encodedContentRuleList: ResourceSVGImageDocument.networkRules) else { throw ResourceWebPreviewFailure.response }
        let wrapper = try await Task.detached(priority: .userInitiated) { try ResourceSVGImageDocument.load(url) }.value
        return (rules, wrapper)
    }
    private func renderStatus() {
        let phase = presentation.phase, loading = phase == .loading || phase == .decoding, failure = phase == .failed || phase == .expired
        statusPanel.isHidden = !loading && !failure
        statusLabel.text = phase == .expired ? copy.expired : failure ? copy.failed : copy.loading
        spinner.isHidden = !loading; if loading { spinner.startAnimating() } else { spinner.stopAnimating() }
        retryButton.isHidden = !failure; retryButton.isEnabled = failure
        webView?.isHidden = phase != .ready
        if phase == .ready, let webView { accessibilityElements = [webView] }
        else { accessibilityElements = failure ? [statusLabel, retryButton] : loading ? [statusLabel] : [] }
        bringSubviewToFront(statusPanel)
    }
    /// A retry changes only the local attempt; the captured lease/Host receipt stay
    /// identical. There is no request, fresh Host capture or path fallback here.
    @objc func retry() {
        guard presentation.phase == .failed || presentation.phase == .expired else { return }
        guard !lifetime.retired, lifetime.request?.active == true, window != nil, UIApplication.shared.applicationState == .active else { expire(); return }
        clearWork(); presentation.stop(); reconcile()
    }
    private func reconcile() {
        guard operation == nil, webView == nil, let request = lifetime.request, request.active,
               window != nil, UIApplication.shared.applicationState == .active else { return }
        guard !lifetime.retired else { expire(); return }
        guard presentation.phase != .failed && presentation.phase != .expired else { renderStatus(); return }
        let ticket = lifetime.generation
        presentation.begin(ticket); renderStatus()
        let asset: ResourceSVGImageAsset
        do { asset = try resolve(request.lease, request.expectedHost) }
        catch { expire(); return }
        guard asset.current() else { expire(); return }
        resourceCurrent = asset.current
        unsubscribe = asset.observeRetirement { [weak self] in
            guard let self, self.lifetime.request == request else { return }
            self.lifetime.retire(); self.expire()
        }
        guard !lifetime.retired, asset.current() else { expire(); return }
        decodeDeadline = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 10_000_000_000) } catch { return }
            guard !Task.isCancelled, let self, self.lifetime.accepts(ticket), self.presentation.phase == .loading || self.presentation.phase == .decoding else { return }
            if self.current() { self.fail(ticket) } else { self.expire() }
        }
        let prepare = self.prepare
        operation = Task { [weak self] in
            do {
                let (rules, wrapper) = try await prepare(asset.url)
                try Task.checkCancellation()
                guard let self, self.lifetime.accepts(ticket) else { return }
                guard self.current() else { self.expire(); return }
                let configuration = WKWebViewConfiguration()
                configuration.websiteDataStore = .nonPersistent()
                configuration.defaultWebpagePreferences.allowsContentJavaScript = false
                configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
                configuration.userContentController = WKUserContentController()
                configuration.userContentController.add(rules)
                configuration.allowsAirPlayForMediaPlayback = false
                let web = ResourceSVGImageWebView(frame: self.bounds, configuration: configuration)
                self.webView = web; web.isOpaque = false; web.backgroundColor = .clear
                web.nativeRequestBlocked = { [weak self, weak web] in
                    guard let self, let web, self.webView === web else { return }
                    self.event?(.nativeLoadBlocked); self.event?(.navigationBlocked)
                }
                web.isAccessibilityElement = true; web.accessibilityLabel = self.copy.image; web.accessibilityTraits = .image
                web.scrollView.backgroundColor = .clear; web.scrollView.isScrollEnabled = false
                web.navigationDelegate = self; self.admittedEntry = false
                self.addSubview(web)
                self.renderStatus()
                web.loadHTMLString(wrapper, baseURL: nil)
                self.operation = nil
            } catch {
                guard let self, self.lifetime.generation == ticket else { return }
                self.fail(ticket)
            }
        }
    }
    private func current() -> Bool {
        !lifetime.retired && lifetime.request?.active == true && resourceCurrent?() == true && window != nil && UIApplication.shared.applicationState == .active
    }
    func stop() {
        clearWork(); presentation.stop(); renderStatus(); event?(.stopped)
    }
    private func clearWork(keepAsset: Bool = false) {
        lifetime.stop(); operation?.cancel(); operation = nil
        decodeDeadline?.cancel(); decodeDeadline = nil
        if !keepAsset { let cancel = unsubscribe; unsubscribe = nil; cancel?(); resourceCurrent = nil }
        webView?.stopLoading(); webView?.navigationDelegate = nil; webView?.removeFromSuperview(); webView = nil
        admittedEntry = false
    }
    private func fail(_ ticket: Int) {
        guard presentation.fail(ticket) else { return }
        clearWork(keepAsset: true); renderStatus(); event?(.failed)
    }
    private func expire() {
        clearWork(); presentation.expire(); renderStatus(); event?(.failed)
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if self.webView === webView && !current() { expire(); decisionHandler(.cancel); return }
        let permitted = self.webView === webView && current() && !admittedEntry && navigationAction.navigationType == .other
            && navigationAction.targetFrame?.isMainFrame == true && navigationAction.request.url?.absoluteString == "about:blank"
        if permitted { admittedEntry = true } else { event?(.delegateNavigationBlocked); event?(.navigationBlocked) }
        decisionHandler(permitted ? .allow : .cancel)
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        let ticket = lifetime.generation
        guard self.webView === webView else { return }
        guard current() else { expire(); return }
        guard presentation.wrapperFinished(ticket) else { return }
        renderStatus(); event?(.wrapperLoaded)
        webView.callAsyncJavaScript(ResourceSVGImageDecodeProbe.script, arguments: [:], in: nil,
            in: WKContentWorld.world(name: "yuri.resource.svgImage.decode")) { [weak self, weak webView] result in
            guard let self, let webView, self.webView === webView, self.lifetime.accepts(ticket) else { return }
            guard self.current() else { self.expire(); return }
            self.decodeDeadline?.cancel(); self.decodeDeadline = nil
            let decoded: Bool
            switch result { case .success(let value): decoded = value as? Bool == true; case .failure: decoded = false }
            if decoded, self.presentation.decoded(ticket, success: true) { self.renderStatus(); self.event?(.loaded) }
            else { self.fail(ticket) }
        }
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { if self.webView === webView { fail(lifetime.generation) } }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { if self.webView === webView { fail(lifetime.generation) } }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { if self.webView === webView { fail(lifetime.generation) } }
}

/// WKWebView owns only the presented resource surface; the application stays NSH/UIKit.
@MainActor final class ResourceWebPreviewBridge: NSObject, UIAdaptivePresentationControllerDelegate {
    private weak var controller: UIViewController?
    private let capture: (RuntimeHostScope) throws -> ResourceWebPreviewTransport
    private let ownership = ResourceWebPreviewOwnership()
    private weak var navigation: UINavigationController?
    private var preview: ResourceWebPreviewSurface?
    private weak var embedded: ResourceWebPreviewMountView?
    var initialFile: ((String, String, RuntimeHostScope) throws -> ResourceWebPreviewResponse)?
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
    /// The component reserves the very same native gate as modal/loopback HTML.
    func mount(_ input: Any?, in host: ResourceWebPreviewMountView) throws {
        guard let args = input as? [String: Any], Set(args.keys) == ["owner", "expectedHost", "directory", "path", "lease"],
              let lease = args["lease"] as? String, let path = args["path"] as? String,
              let initialFile, UIApplication.shared.applicationState == .active else { throw ResourceWebPreviewFailure.invalid }
        var intent = args; intent.removeValue(forKey: "lease"); intent["kind"] = "html"
        let ticket = try ownership.begin(intent, capture: capture)
        do {
            let initial = try initialFile(lease, path, ticket.request.expectedHost)
            embedded = host
            let work = Task<Any?, Error> { [weak self, weak host] in
                guard let self, let host else { throw CancellationError() }
                do {
                    let prepared = try await self.prepare(ticket, initial: initial)
                    try Task.checkCancellation()
                    guard self.ownership.matches(ticket), prepared.current(), host.window != nil else { throw CancellationError() }
                    let content = ResourceHTMLContentView(prepared)
                    content.onFailure = { [weak self, weak host] in
                        host?.failed(ticket.request.owner)
                        self?.terminate(ticket, result: .failure(ResourceWebPreviewFailure.response), animated: false)
                    }
                    host.adopt(content, owner: ticket.request.owner)
                    return nil
                } catch {
                    if self.ownership.matches(ticket) {
                        host.failed(ticket.request.owner)
                        self.terminate(ticket, result: .failure(error), animated: false)
                    }
                    throw error
                }
            }
            operation = work
            Task { _ = try? await work.value }
        } catch {
            terminate(ticket, result: .failure(error), animated: false); throw error
        }
    }
    func detach(owner: String) {
        guard let ticket = ownership.active, ticket.request.owner == owner else { return }
        terminate(ticket, result: .failure(CancellationError()), animated: false)
    }
    private func prepare(_ ticket: ResourceWebPreviewOwnership.Ticket, initial adopted: ResourceWebPreviewResponse? = nil) async throws -> ResourceHTMLPrepared {
        try Task.checkCancellation()
        guard UIApplication.shared.applicationState == .active else { throw CancellationError() }
        guard ownership.matches(ticket) else { throw ResourceWebPreviewFailure.stale }
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
        if adopted == nil, let path = request.path, scope.directory != nil {
            enter(.statRead)
            let stat = try await read(ResourceWebPreviewScope.statRoute(path), 65536)
            try Task.checkCancellation(); guard current() else { throw CancellationError() }
            enter(.statValidate)
            try ResourceWebPreviewScope.validateStat(stat)
        }
        enter(.entryRead)
        let initial: ResourceWebPreviewResponse
        if let adopted { initial = adopted }
        else { initial = try await read(scope.route(entry, owner: owner), ResourceWebPreviewScope.responseLimit) }
        try Task.checkCancellation(); guard current() else { throw CancellationError() }
        enter(.entryValidate)
        try ResourceWebPreviewScope.validate(initial, document: true)
        enter(.rulesCompile)
        guard let rules = try await WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "yuri-resource-no-network", encodedContentRuleList: ResourceWebPreviewScope.networkRules) else { throw ResourceWebPreviewFailure.response }
        try Task.checkCancellation(); guard current() else { throw CancellationError() }
        return ResourceHTMLPrepared(scope: scope, owner: owner, entry: entry, initial: initial, rules: rules, current: current, read: read,
            diagnostic: { [weak self] event in if self?.ownership.matches(ticket) == true { self?.report(event) } })
    }
    private func prepareAndPresent(_ ticket: ResourceWebPreviewOwnership.Ticket) async throws -> Any? {
        guard preview == nil, completion == nil, let controller, controller.presentedViewController == nil else { throw ResourceWebPreviewFailure.busy }
        let prepared = try await prepare(ticket)
        try Task.checkCancellation(); guard prepared.current(), controller.presentedViewController == nil else { throw CancellationError() }
        let surface = ResourceWebPreviewSurface(content: ResourceHTMLContentView(prepared))
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
        let embedded = embedded; self.embedded = nil
        let navigation = navigation; self.navigation = nil
        surface?.stop(); embedded?.stop(owner: ticket.request.owner); navigation?.presentationController?.delegate = nil
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

@MainActor private final class ResourceWebPreviewSurface: UIViewController {
    private let content: ResourceHTMLContentView
    var onClose: (() -> Void)?
    var onFailure: (() -> Void)? { didSet { content.onFailure = onFailure } }
    init(content: ResourceHTMLContentView) {
        self.content = content
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) unavailable") }
    override func loadView() {
        view = content
        navigationItem.rightBarButtonItem = UIBarButtonItem(systemItem: .done, primaryAction: UIAction { [weak self] _ in self?.onClose?() })
    }
    func stop() {
        content.stop()
    }
}
#endif
