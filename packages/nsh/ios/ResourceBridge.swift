import Foundation
import CryptoKit
import CoreFoundation

/// Contact preview is an opaque owned resource, never a Host filesystem path.
struct ContactAttachmentResource: Equatable {
    let route: String
    let generationRoute: String
    let assistantID: String
    let attachmentID: String
    let generation: Int?
    let filename: String?
    let name: String
    let size: Int
    let sha256: String
    let mime: String
    init(_ input: Any?) throws {
        guard let source = input as? [String: Any], Set(source.keys) == ["kind", "assistantID", "descriptor"], source["kind"] as? String == "contact",
              let assistant = source["assistantID"] as? String, !assistant.isEmpty, assistant.utf8.count <= 256,
              !assistant.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              let descriptor = source["descriptor"] as? [String: Any], Set(descriptor.keys).isSubset(of: ["type", "attachmentID", "sha256", "size", "mime", "filename", "generation"]),
              descriptor["type"] as? String == "file", let id = descriptor["attachmentID"] as? String,
              id.range(of: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$", options: .regularExpression) != nil,
              let digest = descriptor["sha256"] as? String, digest.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              let bytes = descriptor["size"] as? NSNumber, CFGetTypeID(bytes) != CFBooleanGetTypeID(), bytes.doubleValue == Double(bytes.intValue), bytes.intValue > 0, bytes.intValue <= 25 * 1024 * 1024,
              let mime = descriptor["mime"] as? String, mime.range(of: "^[a-zA-Z0-9!#$&^_.+-]+/[a-zA-Z0-9!#$&^_.+-]+$", options: .regularExpression) != nil,
              descriptor["filename"] == nil || descriptor["filename"] is String else { throw RuntimeHostScopeFailure.invalid }
        let name = descriptor["filename"] as? String ?? id
        guard !name.isEmpty, name.utf16.count <= 512, name.utf8.count <= 1024, name == name.trimmingCharacters(in: .whitespacesAndNewlines),
              !name.contains("/"), !name.contains("\\"), !name.contains(".."), !name.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { throw RuntimeHostScopeFailure.invalid }
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")
        guard let encoded = assistant.addingPercentEncoding(withAllowedCharacters: allowed) else { throw RuntimeHostScopeFailure.invalid }
        route = "/api/yuri/assistants/\(encoded)/contact/attachments/\(id)"
        generationRoute = "/api/yuri/assistants/\(encoded)/contact/messages?limit=1"
        assistantID = assistant; attachmentID = id; filename = descriptor["filename"] as? String
        generation = try descriptor["generation"].map(Self.safeGeneration)
        self.name = name; size = bytes.intValue; sha256 = digest; self.mime = mime
    }
    var descriptor: [String: Any] {
        var value: [String: Any] = ["type": "file", "attachmentID": attachmentID, "sha256": sha256, "size": size, "mime": mime]
        if let filename { value["filename"] = filename }
        if let generation { value["generation"] = generation }
        return value
    }
    private static func safeGeneration(_ raw: Any) throws -> Int {
        guard let value = raw as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(), value.doubleValue.isFinite,
              value.doubleValue >= 0, value.doubleValue <= 9007199254740991,
              value.doubleValue.rounded(.towardZero) == value.doubleValue else { throw RuntimeHostScopeFailure.invalid }
        return value.intValue
    }
    typealias Read = @MainActor (String, Int) async throws -> (status: Int, mime: String, data: Data)
    @MainActor func validateGeneration(current: () -> Bool, read: Read) async throws {
        guard let generation else { return } // Legacy descriptors retain their existing raw GET contract.
        try Task.checkCancellation()
        guard current() else { throw RuntimeHostScopeFailure.stale }
        let response = try await read(generationRoute, ResourceMediaPolicy.textLimit)
        try Task.checkCancellation()
        guard current(), response.status == 200, response.data.count <= ResourceMediaPolicy.textLimit,
              let body = try JSONSerialization.jsonObject(with: response.data) as? [String: Any],
              let raw = body["generation"], try Self.safeGeneration(raw) == generation else { throw RuntimeHostScopeFailure.stale }
    }
    @MainActor func readVerified(limit: Int, current: () -> Bool, read: Read) async throws -> (status: Int, mime: String, data: Data) {
        try await validateGeneration(current: current, read: read)
        guard current() else { throw RuntimeHostScopeFailure.stale }
        let response = try await read(route, limit)
        try Task.checkCancellation()
        guard current(), response.data.count <= limit else { throw RuntimeHostScopeFailure.stale }
        try verify(status: response.status, mime: response.mime, data: response.data)
        try await validateGeneration(current: current, read: read)
        return response
    }
    func verify(status: Int, mime: String, data: Data) throws {
        guard status == 200, data.count == size, mime.split(separator: ";", maxSplits: 1).first.map(String.init) == self.mime,
              SHA256.hash(data: data).map({ String(format: "%02x", $0) }).joined() == sha256 else { throw RuntimeHostScopeFailure.invalid }
    }
}

/// The same strict parser/admission is used by UIKit startRead and Foundation-only
/// tests. A queued old page cannot ask native to capture the latest Host implicitly.
struct ResourceReadRequest {
    let path: String
    let requestID: String?
    let expectedHost: RuntimeHostScope
    let contact: ContactAttachmentResource?
    init(_ input: Any?) throws {
        guard let value = input as? [String: Any], Set(value.keys).isSubset(of: ["path", "source", "requestId", "expectedHost"]),
              value["source"] == nil || value["path"] == nil else { throw RuntimeHostScopeFailure.invalid }
        contact = try value["source"].map { try ContactAttachmentResource($0) }
        guard let path = contact.map({ "/" + $0.name }) ?? value["path"] as? String, path.hasPrefix("/"), !path.contains("\\"),
              !path.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              !path.split(separator: "/").contains(where: { $0 == "." || $0 == ".." }),
              value["requestId"] == nil || value["requestId"] is String else { throw RuntimeHostScopeFailure.invalid }
        let requestID = value["requestId"] as? String
        if let requestID, requestID.isEmpty || requestID.utf8.count > 128 { throw RuntimeHostScopeFailure.invalid }
        self.path = path; self.requestID = requestID
        expectedHost = try RuntimeHostScope(value["expectedHost"])
    }
    @MainActor static func admit<Transport>(_ input: Any?, capture: (RuntimeHostScope) throws -> Transport) throws -> (request: Self, transport: Transport) {
        let request = try Self(input)
        return (request, try capture(request.expectedHost))
    }
}

/// Admission only; actual media codec support is probed on the protected local AVURLAsset.
enum ResourceMediaPolicy {
    static let binaryLimit = 25 * 1024 * 1024
    static let textLimit = 1_000_000
    static func kind(path: String, mime: String = "", binary: Bool = false, containsNull: Bool = false) -> String {
        let ext = (path as NSString).pathExtension.lowercased()
        let type = mime.components(separatedBy: ";")[0].trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if ["m3u", "m3u8", "pls", "mpd"].contains(ext) || ["application/vnd.apple.mpegurl", "application/x-mpegurl", "audio/mpegurl", "audio/x-mpegurl", "application/dash+xml"].contains(type) { return "binary" }
        if ["png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "bmp", "tiff"].contains(ext) { return "image" }
        if ext == "svg" || type == "image/svg+xml" { return "svg" }
        if ext == "pdf" { return "pdf" }
        if type.hasPrefix("video/") { return "video" }
        if type.hasPrefix("audio/") { return "audio" }
        if ["mp4", "m4v", "webm", "mov", "ogv", "ogg"].contains(ext) { return "video" }
        if ["mp3", "m4a", "aac", "wav", "wave", "aif", "aiff", "caf", "flac", "oga", "opus"].contains(ext) { return "audio" }
        return binary || containsNull ? "binary" : "text"
    }
}

#if canImport(UIKit)
import UIKit
import QuickLook
import ImageIO
import AVKit
import AVFoundation
import NativeShell

/// RuntimeBridge supplies a captured, generation-fenced transport. It must reject redirects,
/// inject Authorization itself, use its existing direct/Relay owner, and enforce limit while
/// receiving (including unknown Content-Length). Never return a fully buffered unbounded body.
@MainActor final class ResourceBridge: NSObject, QLPreviewControllerDataSource, @preconcurrency QLPreviewControllerDelegate, UIDocumentPickerDelegate, UIAdaptivePresentationControllerDelegate {
    private struct Lease { let url: URL; let current: () -> Bool; let expectedHost: RuntimeHostScope; let kind: String; let preview: String; let asset: AVURLAsset?; let sourcePath: String?; let mime: String; let contact: ContactAttachmentResource?; let transport: ResourceTransport? }
    private final class Presenter {
        weak var controller: UIViewController?
        let registration: UUID, expectedHost: RuntimeHostScope
        init(_ controller: UIViewController, _ registration: UUID, _ expectedHost: RuntimeHostScope) {
            self.controller = controller; self.registration = registration; self.expectedHost = expectedHost
        }
    }
    private var presenters: [String: Presenter] = [:]
    private var presentedOwner: String?
    private var presentationClosing = false
    private var presentationWaiters: [CheckedContinuation<Void, Never>] = []
    private weak var controller: UIViewController?
    private let capture: (RuntimeHostScope) throws -> ResourceTransport
    private var leases: [String: Lease] = [:]
    private var presented: String?
    private var completion: CheckedContinuation<Any?, Error>?
    private var reads: [UUID: Task<Any, Error>] = [:]
    private var requests: [String: UUID] = [:]
    private var generation = 0
    private var presentationID: UUID?
    private weak var sheet: UIViewController?
    private var player: AVPlayer?
    private var playerStatus: NSKeyValueObservation?
    private var playbackFailureObserver: NSObjectProtocol?
    private var pendingRelease = Set<String>()
    private var svgObservers: [String: [UUID: () -> Void]] = [:]
    var makeSVGPreview: ((String, RuntimeHostScope) throws -> UIViewController)?
    private let folder: URL
    init(controller: UIViewController, capture: @escaping (RuntimeHostScope) throws -> ResourceTransport) throws {
        self.controller = controller; self.capture = capture
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("resources-" + UUID().uuidString, isDirectory: true)
        super.init()
        NotificationCenter.default.addObserver(self, selector: #selector(suspend), name: UIApplication.willResignActiveNotification, object: nil)
    }
    deinit {
        NotificationCenter.default.removeObserver(self)
        if let playbackFailureObserver { NotificationCenter.default.removeObserver(playbackFailureObserver) }
        try? FileManager.default.removeItem(at: folder)
    }
    func install(on app: NshAppView) {
        app.handle("resources.read") { [weak self] input async throws -> Any? in
            guard let self else { throw CancellationError() }; return try await self.startRead(input)
        }
        app.handle("resources.present") { [weak self] input async throws -> Any? in
            guard let self else { throw CancellationError() }; return try await self.present(input)
        }
        app.handle("resources.release") { [weak self] input async throws -> Any? in
            if let key = (input as? [String: Any])?["lease"] as? String { self?.release(key) }; return true
        }
        app.handle("resources.cancel") { [weak self] input async throws -> Any? in
            if let id = (input as? [String: Any])?["requestId"] as? String, let ticket = self?.requests[id] { self?.reads[ticket]?.cancel() }; return true
        }
        app.handle("resources.close") { [weak self] input async throws -> Any? in
            if let key = (input as? [String: Any])?["lease"] as? String, let self {
                self.close(key)
                if self.presented == key { await withCheckedContinuation { self.presentationWaiters.append($0) } }
            }; return true
        }
    }
    /// Call synchronously whenever RuntimeBridge changes/stops its selected Host, and on teardown.
    func invalidate() {
        suspend()
        presenters.removeAll()
        for key in Array(leases.keys) { release(key) }
    }
    /// Background stops playback and pending reads, but a valid foreground lease can reopen.
    @objc private func suspend() {
        generation += 1
        for task in reads.values { task.cancel() }
        for key in Array(svgObservers.keys) { retireSVG(key) }
        closePresentation(.failure(CancellationError()))
    }
    /// Only opaque leases reach the SVG view. Contact descriptors are never paths.
    func svgAsset(_ key: String, expectedHost: RuntimeHostScope) throws -> (url: URL, current: () -> Bool, observe: (@escaping () -> Void) -> (() -> Void)) {
        guard let lease = leases[key], lease.kind == "svg", lease.expectedHost == expectedHost, lease.current() else { throw RuntimeHostScopeFailure.invalid }
        let url = lease.url
        let current = { [weak self] in self?.leases[key]?.url == url && lease.current() }
        return (url, current, { [weak self] retire in
            guard let self, current() else { retire(); return {} }
            let ticket = UUID(); self.svgObservers[key, default: [:]][ticket] = retire
            return { [weak self] in self?.svgObservers[key]?.removeValue(forKey: ticket) }
        })
    }
    private func retireSVG(_ key: String) {
        let observers = svgObservers.removeValue(forKey: key) ?? [:]
        for retire in observers.values { retire() }
    }
    /// Copy the original bounded read once. Watcher lease adoption/release must not
    /// reload or revoke an already prepared HTML document; transport still owns Host validity.
    func htmlInitial(_ key: String, path: String, expectedHost: RuntimeHostScope) throws -> (mime: String, data: Data) {
        guard let lease = leases[key], lease.kind == "text", lease.sourcePath == path,
              lease.expectedHost == expectedHost, lease.current(), ["html", "htm"].contains(lease.url.pathExtension.lowercased()) else { throw RuntimeHostScopeFailure.invalid }
        let file = try FileHandle(forReadingFrom: lease.url); defer { try? file.close() }
        let data = try file.read(upToCount: ResourceMediaPolicy.textLimit + 1) ?? Data()
        guard data.count <= ResourceMediaPolicy.textLimit else { throw RuntimeHostScopeFailure.invalid }
        return (lease.mime, data)
    }
    func registerPresenter(_ owner: String, registration: UUID, expectedHost: RuntimeHostScope, controller: UIViewController) throws {
        guard try capture(expectedHost).isCurrent(), controller.presentingViewController != nil,
              presenters[owner] == nil || presenters[owner]?.registration == registration else { throw RuntimeHostScopeFailure.invalid }
        presenters[owner] = Presenter(controller, registration, expectedHost)
    }
    func unregisterPresenter(_ owner: String, registration: UUID) {
        guard presenters[owner]?.registration == registration else { return }
        if presentedOwner == owner { closePresentation(.failure(CancellationError())) }
        presenters.removeValue(forKey: owner)
    }
    func ownsPresentation(_ owner: String?) -> Bool { completion != nil && presentedOwner == owner }
    /// Native-only fixture entry; the installed handler uses this same admission.
    func startRead(_ input: Any?) async throws -> Any {
        // Parse and synchronously admit BEFORE any HTTP/stat, task or file side effect.
        let admitted = try ResourceReadRequest.admit(input, capture: capture)
        guard admitted.transport.isCurrent() else { throw CancellationError() }
        guard reads.count < 2 else { throw failure("正在读取其他文件，请稍后重试") }
        let request = admitted.request.requestID
        if let request, requests[request] != nil { throw failure("无效或重复的文件请求") }
        let ticket = UUID(), scope = generation, transport = admitted.transport
        let task = Task { try await self.read(admitted.request, generation: scope, transport: transport) }
        reads[ticket] = task
        if let request { requests[request] = ticket }
        defer { reads.removeValue(forKey: ticket); if let request { requests.removeValue(forKey: request) } }
        let result = try await withTaskCancellationHandler(operation: { try await task.value }, onCancel: { task.cancel() })
        guard !Task.isCancelled, scope == generation, transport.isCurrent() else {
            if let lease = (result as? [String: Any])?["lease"] as? String { release(lease) }
            throw CancellationError()
        }
        return result
    }
    func close(_ key: String) {
        retireSVG(key)
        if key == presented { closePresentation(.failure(CancellationError())) }
    }
    func release(_ key: String) {
        retireSVG(key)
        if key == presented { pendingRelease.insert(key); return }
        guard let lease = leases.removeValue(forKey: key) else { return }
        lease.asset?.cancelLoading()
        try? FileManager.default.removeItem(at: lease.url.deletingLastPathComponent())
    }
    private func read(_ request: ResourceReadRequest, generation scope: Int, transport: ResourceTransport) async throws -> Any {
        try Task.checkCancellation()
        guard scope == generation, transport.isCurrent() else { throw CancellationError() }
        let path = request.path
        guard leases.count < 32 else { throw failure("打开文件过多，请关闭部分预览后重试") }
        let ext = (path as NSString).pathExtension.lowercased()
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")
        let metadata: [String: Any]
        if let contact = request.contact {
            metadata = ["isFile": true, "size": contact.size, "isBinary": !contact.mime.hasPrefix("text/") && contact.mime != "application/json"]
        } else {
            let stat = try await transport.read("/api/fs/stat?path=" + path.addingPercentEncoding(withAllowedCharacters: allowed)!, 64 * 1024)
            try Task.checkCancellation()
            guard scope == generation, transport.isCurrent() else { throw CancellationError() }
            guard (200..<300).contains(stat.status), stat.data.count <= 64 * 1024,
                  let fields = try JSONSerialization.jsonObject(with: stat.data) as? [String: Any], fields["isFile"] as? Bool == true else { throw failure("无法读取文件属性，请检查文件权限与 Host 连接后重试") }
            metadata = fields
        }
        let initialKind = ResourceMediaPolicy.kind(path: path, binary: metadata["isBinary"] as? Bool == true)
        let limit = ["text", "svg"].contains(initialKind) ? ResourceMediaPolicy.textLimit : ResourceMediaPolicy.binaryLimit
        if let size = metadata["size"] as? Int, size > limit { throw failure("文件超过原生预览限制：文本 1 MB，其他文件 25 MiB；未下载文件") }
        let route = request.contact?.route ?? "/api/fs/serve" + path.split(separator: "/", omittingEmptySubsequences: false).map { String($0).addingPercentEncoding(withAllowedCharacters: allowed)! }.joined(separator: "/")
        let response: (status: Int, mime: String, data: Data)
        if let contact = request.contact { response = try await contact.readVerified(limit: limit, current: transport.isCurrent, read: transport.read) }
        else { response = try await transport.read(route, limit) }
        try Task.checkCancellation()
        guard scope == generation, transport.isCurrent() else { throw CancellationError() }
        guard response.status == 200 else { throw failure("文件读取失败 (HTTP \(response.status))；原有预览保留，可重试") }
        guard response.data.count <= limit else { throw failure("文件超过原生预览限制：文本 1 MB，其他文件 25 MiB；未保存不完整文件") }
        guard !response.mime.lowercased().hasPrefix("text/html") || ["html", "htm"].contains(ext) else { throw failure("Host 返回了 HTML 而非所需文件") }
        let kind = ResourceMediaPolicy.kind(path: path, mime: response.mime, binary: metadata["isBinary"] as? Bool == true, containsNull: response.data.contains(0))
        let key = UUID().uuidString
        let directory = folder.appendingPathComponent(key, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent((path as NSString).lastPathComponent)
        do {
            try response.data.write(to: url, options: [.atomic, .completeFileProtection])
            var result: [String: Any] = ["kind": kind, "lease": key, "size": response.data.count]
            if request.contact == nil, let size = metadata["size"] as? NSNumber, let mtime = metadata["mtimeMs"] as? NSNumber, let binary = metadata["isBinary"] as? Bool {
                result["stat"] = ["size": size, "mtimeMs": mtime, "isBinary": binary]
            }
            var preview = "unsupported"
            var asset: AVURLAsset?
            if ["image", "pdf"].contains(kind), QLPreviewController.canPreview(url as NSURL) { preview = "quicklook" }
            if kind == "svg" { preview = "svg-image" }
            if ["video", "audio"].contains(kind) {
                // Even a local MOV can reference remote/local media. Do not follow any reference.
                let candidate = AVURLAsset(url: url, options: [AVURLAssetReferenceRestrictionsKey: NSNumber(value: AVAssetReferenceRestrictions.forbidAll.rawValue)])
                do {
                    let playable = try await withTaskCancellationHandler(operation: { try await candidate.load(.isPlayable) }, onCancel: { candidate.cancelLoading() })
                    if playable { asset = candidate; preview = "avkit" }
                } catch {
                    try Task.checkCancellation()
                }
                if preview == "unsupported" { result["previewError"] = "此媒体编码或容器无法由系统原生播放；可保存或分享原文件" }
            }
            result["preview"] = preview
            if kind == "text" {
                guard let text = String(data: response.data, encoding: .utf8) else { throw failure("文件不是有效的 UTF-8 文本，可按二进制文件导出") }
                result["text"] = text
            }
            if kind == "image" {
                let data = response.data
                let thumbnail = try await Task.detached(priority: .userInitiated) {
                    guard let source = CGImageSourceCreateWithData(data as CFData, nil), let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: 1024, kCGImageSourceCreateThumbnailWithTransform: true] as CFDictionary) else { throw NSError(domain: "Resources", code: 1, userInfo: [NSLocalizedDescriptionKey: "图片无法解码"]) }
                    return UIImage(cgImage: image).jpegData(compressionQuality: 0.85)
                }.value
                guard scope == generation, transport.isCurrent() else { throw CancellationError() }
                guard let thumbnail else { throw failure("无法生成缩略图") }
                // Only a bounded, downsampled thumbnail crosses JS; original bytes stay native.
                result["thumbnail"] = "data:image/jpeg;base64," + thumbnail.base64EncodedString()
            }
            try Task.checkCancellation()
            if let contact = request.contact { try await contact.validateGeneration(current: transport.isCurrent, read: transport.read) }
            guard scope == generation, transport.isCurrent() else { throw CancellationError() }
            guard leases.count < 32 else { throw failure("打开文件过多，请关闭部分预览后重试") }
            leases[key] = Lease(url: url, current: transport.isCurrent, expectedHost: request.expectedHost, kind: kind, preview: preview, asset: asset,
                sourcePath: request.contact == nil ? request.path : nil, mime: response.mime, contact: request.contact,
                transport: request.contact == nil ? nil : transport)
            return result
        } catch { try? FileManager.default.removeItem(at: directory); throw error }
    }
    private func present(_ input: Any?) async throws -> Any? {
        let args = input as? [String: Any] ?? [:]
        guard let key = args["lease"] as? String, let lease = leases[key], lease.current() else { throw failure("Host 已切换或文件已关闭，请重新加载") }
        guard let action = args["action"] as? String, ["preview", "save", "share"].contains(action) else { throw failure("无效的文件操作") }
        if let contact = lease.contact {
            guard let transport = lease.transport else { throw RuntimeHostScopeFailure.invalid }
            // A new presentation is a new admission, not an already-owned turn's
            // materialization. Keep the original descriptor and authenticated transport.
            _ = try await contact.readVerified(limit: contact.size, current: transport.isCurrent, read: transport.read)
            guard leases[key]?.url == lease.url, lease.current() else { throw RuntimeHostScopeFailure.stale }
        }
        let owner: String?
        let presenter: UIViewController?
        if let requested = args["presentationOwner"] {
            guard let requested = requested as? String, let registration = presenters[requested], registration.expectedHost == lease.expectedHost,
                  let exact = registration.controller, !exact.isBeingDismissed, exact.viewIfLoaded?.window != nil else { throw failure("请先关闭当前系统窗口") }
            owner = requested; presenter = exact
        } else { owner = nil; presenter = controller }
        guard let controller = presenter, controller.presentedViewController == nil, completion == nil else { throw failure("请先关闭当前系统窗口") }
        guard action != "preview" || lease.preview != "unsupported" else { throw failure("此格式或编码没有可用的原生预览；可保存或分享原文件") }
        try Task.checkCancellation()
        let id = UUID()
        presentedOwner = owner
        return try await withTaskCancellationHandler(operation: { try await self.show(key: key, lease: lease, action: action, controller: controller, id: id) }, onCancel: {
            Task { @MainActor [weak self] in
                guard self?.presentationID == id else { return }
                self?.closePresentation(.failure(CancellationError()))
            }
        })
    }
    private func show(key: String, lease: Lease, action: String, controller: UIViewController, id: UUID) async throws -> Any? {
        try Task.checkCancellation()
        return try await withCheckedThrowingContinuation { continuation in
            self.completion = continuation; self.presented = key; self.presentationID = id
            let sheet: UIViewController
            if action == "save" {
                let picker = UIDocumentPickerViewController(forExporting: [lease.url], asCopy: true)
                picker.delegate = self; sheet = picker
            } else if action == "share" {
                let share = UIActivityViewController(activityItems: [lease.url], applicationActivities: nil)
                share.completionWithItemsHandler = { [weak self] _, completed, _, error in
                    guard self?.presentationID == id else { return }
                    if let error { self?.closePresentation(.failure(error)) } else { self?.closePresentation(.success(["completed": completed])) }
                }
                share.popoverPresentationController?.sourceView = controller.view
                share.popoverPresentationController?.sourceRect = CGRect(x: controller.view.bounds.midX, y: controller.view.bounds.midY, width: 1, height: 1)
                sheet = share
            } else if lease.kind == "svg" {
                guard let makeSVGPreview else { self.finish(.failure(failure("SVG 预览不可用"))); return }
                do {
                    let svg = try makeSVGPreview(key, lease.expectedHost)
                    svg.navigationItem.title = lease.url.lastPathComponent
                    svg.navigationItem.rightBarButtonItem = UIBarButtonItem(barButtonSystemItem: .done, target: self, action: #selector(closeMedia))
                    sheet = UINavigationController(rootViewController: svg)
                } catch { self.finish(.failure(error)); return }
            } else if lease.preview == "avkit", let asset = lease.asset {
                let item = AVPlayerItem(asset: asset), player = AVPlayer()
                player.allowsExternalPlayback = false
                let media = ResourceMediaViewController()
                media.playerController.player = player
                media.navigationItem.title = lease.url.lastPathComponent
                media.navigationItem.rightBarButtonItem = UIBarButtonItem(barButtonSystemItem: .done, target: self, action: #selector(closeMedia))
                let navigation = UINavigationController(rootViewController: media)
                self.player = player
                self.playerStatus = item.observe(\.status, options: [.initial, .new]) { [weak self] item, _ in
                    guard item.status == .failed else { return }
                    Task { @MainActor [weak self] in
                        self?.mediaFailed(id)
                    }
                }
                self.playbackFailureObserver = NotificationCenter.default.addObserver(forName: AVPlayerItem.failedToPlayToEndTimeNotification, object: item, queue: .main) { [weak self] _ in
                    Task { @MainActor [weak self] in self?.mediaFailed(id) }
                }
                player.replaceCurrentItem(with: item)
                sheet = navigation
            } else {
                // QL uses the system's zoomable image viewer / PDF reader, not WKWebView.
                let preview = QLPreviewController(); preview.dataSource = self; preview.delegate = self; sheet = preview
            }
            self.sheet = sheet
            sheet.presentationController?.delegate = self
            controller.present(sheet, animated: true)
            sheet.presentationController?.delegate = self
        }
    }
    private func mediaFailed(_ id: UUID) {
        guard presentationID == id else { return }
        closePresentation(.failure(failure("媒体播放失败；原文件保留，可重试、保存或分享")))
    }
    @objc private func closeMedia() { closePresentation(.success(["completed": false])) }
    private func closePresentation(_ result: Result<Any?, Error>) {
        guard !presentationClosing, let id = presentationID else { return }
        presentationClosing = true
        let currentSheet = sheet
        player?.pause(); player?.replaceCurrentItem(with: nil)
        if let currentSheet, currentSheet.presentingViewController != nil {
            currentSheet.dismiss(animated: false) { [self] in finish(result, id: id) }
        } else { finish(result, id: id) }
    }
    private func finish(_ result: Result<Any?, Error>, id: UUID? = nil) {
        if let id, presentationID != id { return }
        playerStatus?.invalidate(); playerStatus = nil
        if let playbackFailureObserver { NotificationCenter.default.removeObserver(playbackFailureObserver) }
        playbackFailureObserver = nil
        player?.pause(); player?.replaceCurrentItem(with: nil); player = nil
        let continuation = completion, key = presented
        completion = nil; presented = nil; presentationID = nil; sheet = nil; presentedOwner = nil; presentationClosing = false
        if let key, pendingRelease.remove(key) != nil { release(key) }
        continuation?.resume(with: result)
        let waiters = presentationWaiters; presentationWaiters.removeAll(); waiters.forEach { $0.resume() }
    }
    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) { if presentationController.presentedViewController === sheet { finish(.success(["completed": false])) } }
    func previewControllerDidDismiss(_ controller: QLPreviewController) { if controller === sheet { finish(.success(["completed": false])) } }
    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { if controller === sheet { closePresentation(.success(["completed": false])) } }
    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) { if controller === sheet { closePresentation(.success(["completed": true])) } }
    func numberOfPreviewItems(in controller: QLPreviewController) -> Int { presented.flatMap { leases[$0] }?.current() == true ? 1 : 0 }
    func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
        guard let key = presented, let lease = leases[key], lease.current() else { return folder.appendingPathComponent("closed") as NSURL }
        return lease.url as NSURL
    }
    private func failure(_ message: String) -> NSError { NSError(domain: "Yuri.Resources", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
}

/// AVPlayerViewController is embedded, never subclassed; system controls own play/pause/seek.
@MainActor private final class ResourceMediaViewController: UIViewController {
    let playerController = AVPlayerViewController()
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        playerController.showsPlaybackControls = true
        playerController.allowsPictureInPicturePlayback = false
        addChild(playerController)
        playerController.view.frame = view.bounds
        playerController.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(playerController.view)
        playerController.didMove(toParent: self)
    }
    override func viewWillDisappear(_ animated: Bool) {
        if isBeingDismissed || navigationController?.isBeingDismissed == true { playerController.player?.pause() }
        super.viewWillDisappear(animated)
    }
}
#endif
