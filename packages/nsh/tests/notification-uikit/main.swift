import UIKit

/// Synthetic Host only. No NSH engine, Keychain, transport, APNs registration or automatic OS mutation.
/// Permission/settings/test buttons require an explicit launch opt-in, then an explicit tap.
@MainActor private final class NotificationFixtureController: UIViewController {
    private var bridge: NotificationBridge!
    private var generation = 0
    private var hostID = "fixture-host-a"
    private var lease = ""
    private var mode = "hidden-only"
    private let label = UILabel()
    private let allowLocal = ProcessInfo.processInfo.environment["NSH_NOTIFICATION_FIXTURE_ALLOW_LOCAL"] == "1"
    override func viewDidLoad() {
        super.viewDidLoad(); view.backgroundColor = .systemBackground
        bridge = NotificationBridge(app: nil, capture: { [weak self] in
            guard let self else { throw CancellationError() }
            let host = self.hostID, generation = self.generation
            return NotificationHostScope(hostID: host, isCurrent: { [weak self] in self?.hostID == host && self?.generation == generation })
        }, route: { [weak self] host, lease, target in
            self?.label.text = "安全点击路由：\(host) / \(target.kind) / \(target.id)\n当前 lease 相同：\(self?.lease == lease)"
        })
        label.numberOfLines = 0; label.textColor = .label
        label.text = "仅合成 Host。读取状态不请求权限；系统写操作需启动开关并手动点击。\n本地测试不代表 APNs 或挂起后送达。"
        let stack = UIStackView(); stack.axis = .vertical; stack.spacing = 12; stack.translatesAutoresizingMaskIntoConstraints = false
        stack.addArrangedSubview(label)
        action("读取真实权限（不弹窗）", stack) { [weak self] in self?.work { [weak self] in guard let self else { return }; self.label.text = String(describing: await self.bridge.status()) } }
        action("请求真实系统权限", stack) { [weak self] in self?.mutate { [weak self] in guard let self else { return }; self.label.text = String(describing: try await self.bridge.requestPermission()) } }
        action("打开 iOS 通知设置", stack) { [weak self] in self?.mutate { [weak self] in try await self?.bridge.openSettings() } }
        action("发送真实本地测试（无点击路由）", stack) { [weak self] in self?.mutate { [weak self] in guard let self else { return }; self.label.text = String(describing: try await self.bridge.test(["hostID": self.hostID, "language": "zh-CN"])) } }
        action("切换共享模式（原生前台仍抑制）", stack) { [weak self] in
            guard let self else { return }; self.mode = self.mode == "always" ? "hidden-only" : "always"; self.configure()
        }
        action("发送合成 live 事件（点击返回此页）", stack) { [weak self] in self?.mutate { [weak self] in
            guard let self else { return }; if self.lease.isEmpty { self.configure() }
            self.label.text = String(describing: try await self.bridge.live(["lease": self.lease, "eventID": UUID().uuidString, "kind": "completion", "target": ["kind": "session", "id": "fixture-session"]]))
        } }
        action("1 秒后合成 live（切后台；不验证 APNs）", stack) { [weak self] in self?.mutate { [weak self] in
            guard let self else { return }; if self.lease.isEmpty { self.configure() }
            let lease = self.lease
            self.label.text = "仅当进程仍运行时，在 1 秒后投影合成事件。请切后台。若被挂起，不会执行；这不是推送。"
            try await Task.sleep(nanoseconds: 1_000_000_000)
            self.label.text = String(describing: try await self.bridge.live(["lease": lease, "eventID": UUID().uuidString, "kind": "completion", "target": ["kind": "session", "id": "fixture-session"]]))
        } }
        action("切换合成 Host 并清理旧通知", stack) { [weak self] in
            guard let self else { return }; self.generation += 1; self.bridge.invalidate(); self.lease = ""
            self.hostID = self.hostID == "fixture-host-a" ? "fixture-host-b" : "fixture-host-a"; self.configure()
        }
        view.addSubview(stack)
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 20), stack.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -20), stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 16)])
    }
    private func configure() {
        do {
            let response = try bridge.configure(["hostID": hostID, "enabled": true, "mode": mode, "events": ["completion"], "language": "zh-CN"])
            lease = response["lease"] ?? ""; label.text = "合成 Host：\(hostID)\n聚焦策略：\(mode)\n旧通知已清理；没有发送新通知。"
        } catch { label.text = error.localizedDescription }
    }
    private func action(_ title: String, _ stack: UIStackView, _ body: @escaping () -> Void) {
        let button = UIButton(type: .system); button.setTitle(title, for: .normal); button.titleLabel?.numberOfLines = 0
        button.addAction(UIAction { _ in body() }, for: .touchUpInside); stack.addArrangedSubview(button)
    }
    private func work(_ body: @escaping () async throws -> Void) {
        Task { @MainActor in do { try await body() } catch { label.text = error.localizedDescription } }
    }
    private func mutate(_ body: @escaping () async throws -> Void) {
        guard allowLocal else { label.text = "系统写操作已锁定。仅验收者明确同意后，以 NSH_NOTIFICATION_FIXTURE_ALLOW_LOCAL=1 启动再手动点击。"; return }
        work(body)
    }
}
@MainActor private final class NotificationFixtureDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds); window.rootViewController = NotificationFixtureController(); window.makeKeyAndVisible(); self.window = window; return true
    }
}
UIApplicationMain(CommandLine.argc, CommandLine.unsafeArgv, nil, NSStringFromClass(NotificationFixtureDelegate.self))
