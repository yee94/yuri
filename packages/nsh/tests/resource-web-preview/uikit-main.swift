import Foundation
import UIKit

/// Linked only into the isolated fixture. No RuntimeBridge, ConnectionStore,
/// URLSession, Relay, NSH engine, script injection or script message handler.
@MainActor private final class PreviewFixtureCounters {
    var captures = 0, releases = 0, reads = 0, pending = 0, cancelled = 0, rejected = 0
    var css = 0, javascript = 0, images = 0, result = "尚未打开"
    var stage = "尚未开始", failure = "无"
    var changed: (() -> Void)?
    func publish() { changed?() }
    var text: String {
        "结果：\(result)\n捕获/释放：\(captures)/\(releases) · 在途：\(pending) · 取消：\(cancelled)\n读取：\(reads) · CSS/JS/图片：\(css)/\(javascript)/\(images) · 拒绝：\(rejected)\n阶段：\(stage)\n首次失败：\(failure)"
    }
    func record(_ event: ResourceWebPreviewDiagnostic) {
        stage = event.stage.rawValue
        if let domain = event.domain, let code = event.code, failure == "无" { failure = "\(stage) \(domain) \(code)" }
        publish()
    }
}

@MainActor private final class PreviewFixtureLease {
    let counters: PreviewFixtureCounters
    init(_ counters: PreviewFixtureCounters) { self.counters = counters; counters.captures += 1; counters.publish() }
    deinit { let value = counters; Task { @MainActor in value.releases += 1; value.publish() } }
    func read(_ route: String, _ limit: Int) async throws -> ResourceWebPreviewResponse {
        counters.reads += 1; counters.pending += 1; counters.publish()
        defer { counters.pending -= 1; counters.publish() }
        let path: String
        if route.hasPrefix("/api/fs/stat?") {
            let data = Data("{\"isFile\":true,\"size\":2048}".utf8)
            return ResourceWebPreviewResponse(status: 200, mime: "application/json", data: data)
        } else if route.hasPrefix("/api/fs/serve/fixture/") {
            path = String(route.dropFirst("/api/fs/serve/fixture/".count))
        } else if route.hasPrefix(Self.base + "/") {
            path = String(route.dropFirst((Self.base + "/").count))
        } else { counters.rejected += 1; throw ResourceWebPreviewFailure.invalid }
        let response: ResourceWebPreviewResponse
        switch path {
        case "index.html", "outside.html", "slow.html":
            let extra = path == "outside.html" ? "<img src='../private.png' alt='此越界请求必须结束预览'>" : ""
            let slow = path == "slow.html" ? "<img src='./slow.png' alt='等待中的合成图片'>" : ""
            response = ResourceWebPreviewResponse(status: 200, mime: "text/html; charset=utf-8", data: Data(Self.html(extra + slow).utf8))
        case "style.css":
            counters.css += 1
            response = ResourceWebPreviewResponse(status: 200, mime: "text/css; charset=utf-8", data: Data("body{font:18px -apple-system;padding:20px;color:#212121;background:#fff}button{padding:14px;margin:6px}#css{border:4px solid #167d42;padding:12px}#css:after{content:'：相对 CSS 已加载'}img{width:48px;height:48px;image-rendering:pixelated}".utf8))
        case "app.js":
            counters.javascript += 1
            response = ResourceWebPreviewResponse(status: 200, mime: "text/javascript; charset=utf-8", data: Data(Self.javascript.utf8))
        case "pixel.png", "slow.png":
            if path == "slow.png" {
                do { try await Task.sleep(nanoseconds: 8_000_000_000) }
                catch { counters.cancelled += 1; throw error }
            }
            counters.images += 1
            let format = UIGraphicsImageRendererFormat(); format.scale = 1
            let image = UIGraphicsImageRenderer(size: CGSize(width: 12, height: 12), format: format).image { context in
                UIColor.systemGreen.setFill(); context.fill(CGRect(x: 0, y: 0, width: 12, height: 12))
            }
            guard let data = image.pngData() else { throw ResourceWebPreviewFailure.response }
            response = ResourceWebPreviewResponse(status: 200, mime: "image/png", data: data)
        default: counters.rejected += 1; throw ResourceWebPreviewFailure.invalid
        }
        guard response.data.count <= limit else { throw ResourceWebPreviewFailure.limit }
        try Task.checkCancellation()
        return response
    }
    static let base = "/api/preview/proxy/0123456789abcdef0123456789abcdef"
    static func html(_ extra: String) -> String { """
    <!doctype html><html lang="zh"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="./style.css"><script src="./app.js" defer></script></head>
    <body><h1>资源 WKWebView 验收</h1><p id="css">绿色边框</p><p id="js">JS 尚未运行</p><img id="pixel" src="./pixel.png" alt="相对 PNG"><p id="image">图片待解码</p>
    <button id="change">点击改变 DOM</button><p id="count">点击次数：0</p><button id="external">尝试外域图片</button><p id="external-result">尚未尝试</p>
    <button id="outside">尝试目录越界</button><button id="slow">开始慢图片（用于关闭取消）</button><p id="slow-result"></p>\(extra)</body></html>
    """ }
    static let javascript = """
    document.getElementById('js').textContent='相对 JS 已执行';
    let count=0;document.getElementById('change').onclick=()=>{document.getElementById('count').textContent='点击次数：'+(++count)};
    const pixel=document.getElementById('pixel');const decoded=()=>{document.getElementById('image').textContent=pixel.naturalWidth===12?'相对 PNG 已解码':'PNG 解码失败'};
    if(pixel.complete)decoded();else pixel.onload=decoded;
    document.getElementById('external').onclick=()=>{const image=new Image();image.onload=()=>{document.getElementById('external-result').textContent='失败：外域竟然加载'};image.onerror=()=>{document.getElementById('external-result').textContent='外域图片已阻断'};image.src='https://outside.invalid/never-load.png';document.body.appendChild(image)};
    document.getElementById('outside').onclick=()=>{const image=new Image();image.src='../private.png';document.body.appendChild(image)};
    document.getElementById('slow').onclick=()=>{const image=new Image();image.src='./slow.png';document.body.appendChild(image);document.getElementById('slow-result').textContent='8 秒合成等待中，现在点系统完成以取消'};
    """
}

@MainActor private final class PreviewFixtureController: UIViewController {
    private let counters = PreviewFixtureCounters()
    private let status = UILabel()
    private var generation = 0
    private var expectedHost: RuntimeHostScope {
        RuntimeHostScope(hostID: "synthetic-preview", lease: UUID(uuidString: String(format: "00000000-0000-4000-8000-%012d", generation + 1))!)
    }
    private var bridge: ResourceWebPreviewBridge!
    private var work: Task<Void, Never>?
    private var invalidation: Task<Void, Never>?
    override func viewDidLoad() {
        super.viewDidLoad(); view.backgroundColor = .systemBackground
        bridge = ResourceWebPreviewBridge(controller: self, capture: { [weak self] expected in
            guard let self else { throw CancellationError() }
            guard expected == self.expectedHost else { throw RuntimeHostScopeFailure.stale }
            let scope = self.generation, lease = PreviewFixtureLease(self.counters)
            return ResourceWebPreviewTransport.authorized(readFile: { try await lease.read($0, $1) }, isCurrent: { [weak self] in self?.generation == scope }, send: { route, method, body, headers, limit in
                if route == "/api/preview/targets", method == "POST" {
                    guard headers == ["X-Yuri-Native-Preview": "1"], let body,
                          let object = try JSONSerialization.jsonObject(with: body) as? [String: Any], object["allowExternal"] as? Bool == false else { throw ResourceWebPreviewFailure.invalid }
                    let metadata: [String: Any] = ["id": "0123456789abcdef0123456789abcdef", "proxyBasePath": PreviewFixtureLease.base, "previewToken": String(repeating: "a", count: 32), "expiresAt": Date().addingTimeInterval(290).timeIntervalSince1970 * 1000]
                    return ResourceWebPreviewResponse(status: 200, mime: "application/json", data: try JSONSerialization.data(withJSONObject: metadata))
                }
                guard method == "GET", headers["X-Yuri-Preview-Token"] == String(repeating: "a", count: 32) else { throw ResourceWebPreviewFailure.invalid }
                return try await lease.read(route, limit)
            })
        }, diagnostic: { [weak self] event in self?.counters.record(event) })
        let title = UILabel(); title.text = "隔离 HTML / Host proxy 验收"; title.font = .preferredFont(forTextStyle: .headline)
        let description = UILabel(); description.text = "仅合成数据。页面没有 NativeShell 桥。关闭后检查捕获=释放、在途=0；失败也必须释放。"; description.numberOfLines = 0
        status.numberOfLines = 0; status.font = .monospacedSystemFont(ofSize: 14, weight: .regular); status.accessibilityIdentifier = "resource-preview-counters"
        counters.changed = { [weak self] in self?.status.text = self?.counters.text }; counters.publish()
        let stack = UIStackView(arrangedSubviews: [title, description,
            button("打开 HTML", "resource-preview-open-html") { [weak self] in self?.open("index.html") },
            button("打开合成 Host proxy", "resource-preview-open-proxy") { [weak self] in self?.open("index.html", proxy: true) },
            button("打开越界子资源（预期失败）", "resource-preview-open-outside") { [weak self] in self?.open("outside.html") },
            button("打开慢资源，2 秒后 Host 失效", "resource-preview-open-invalidate") { [weak self] in self?.open("slow.html", invalidate: true) },
            button("失效并释放", "resource-preview-invalidate") { [weak self] in self?.invalidate() }, status])
        stack.axis = .vertical; stack.spacing = 16; stack.translatesAutoresizingMaskIntoConstraints = false; view.addSubview(stack)
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 20), stack.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -20), stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 20)])
    }
    private func button(_ title: String, _ id: String, _ action: @escaping () -> Void) -> UIButton {
        let button = UIButton(type: .system); button.setTitle(title, for: .normal); button.accessibilityIdentifier = id
        button.addAction(UIAction { _ in action() }, for: .touchUpInside); return button
    }
    private func open(_ file: String, proxy: Bool = false, invalidate: Bool = false) {
        guard work == nil else { return }
        counters.result = "打开中"; counters.stage = "尚未开始"; counters.failure = "无"; counters.publish()
        let receipt = expectedHost, owner = UUID().uuidString
        work = Task { [weak self] in
            guard let self else { return }
            defer { self.work = nil; self.invalidation?.cancel(); self.invalidation = nil; self.counters.publish() }
            do {
                var args: [String: Any] = proxy ? ["kind": "loopback", "url": "http://localhost:3000/index.html"] : ["kind": "html", "directory": "/fixture", "path": "/fixture/" + file]
                args["expectedHost"] = receipt.publicValue; args["owner"] = owner
                _ = try await bridge.present(args); counters.result = "用户关闭"
            } catch is CancellationError { counters.result = "已取消/Host 失效" }
            catch let failure as ResourceWebPreviewFailure { counters.result = "拒绝：" + failure.rawValue }
            catch { counters.result = "失败（未透传底层错误）" }
        }
        if invalidate {
            invalidation = Task { [weak self] in
                do { try await Task.sleep(nanoseconds: 2_000_000_000) } catch { return }
                self?.invalidate()
            }
        }
    }
    func invalidate() { generation += 1; work?.cancel(); bridge?.invalidate() }
}

@MainActor private final class PreviewFixtureDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds); window.rootViewController = PreviewFixtureController(); window.makeKeyAndVisible(); self.window = window; return true
    }
    func applicationDidEnterBackground(_ application: UIApplication) { (window?.rootViewController as? PreviewFixtureController)?.invalidate() }
}

@main private struct PreviewFixtureMain {
    static func main() { UIApplicationMain(CommandLine.argc, CommandLine.unsafeArgv, nil, NSStringFromClass(PreviewFixtureDelegate.self)) }
}
