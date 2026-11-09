import UIKit
import NativeShell

@MainActor final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        NotificationLaunchDelegate.shared.install()
        let navigationAppearance = UINavigationBarAppearance()
        navigationAppearance.configureWithDefaultBackground()
        navigationAppearance.backgroundColor = .clear
        navigationAppearance.shadowColor = .clear
        let navigationBar = UINavigationBar.appearance()
        navigationBar.standardAppearance = navigationAppearance
        navigationBar.scrollEdgeAppearance = navigationAppearance
        navigationBar.compactAppearance = navigationAppearance
        navigationBar.compactScrollEdgeAppearance = navigationAppearance
        let tabAppearance = UITabBarAppearance()
        tabAppearance.configureWithDefaultBackground()
        tabAppearance.backgroundColor = .clear
        tabAppearance.shadowColor = .clear
        let tabBar = UITabBar.appearance()
        tabBar.standardAppearance = tabAppearance
        tabBar.scrollEdgeAppearance = tabAppearance
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = YuriController()
        window.makeKeyAndVisible(); self.window = window
        if let url = options?[.url] as? URL { (window.rootViewController as? YuriController)?.receive(url) }
        return true
    }
    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        (window?.rootViewController as? YuriController)?.receive(url) ?? false
    }
    func applicationDidEnterBackground(_ application: UIApplication) {
        (window?.rootViewController as? YuriController)?.suspendResourcePreview()
    }
    func applicationWillEnterForeground(_ application: UIApplication) {
        (window?.rootViewController as? YuriController)?.resumeRuntime()
    }
    func applicationWillTerminate(_ application: UIApplication) {
        (window?.rootViewController as? YuriController)?.shutdown()
    }
}

@MainActor final class YuriController: UIViewController {
    let surface = NshAppView()
    private var bridge: RuntimeBridge?
    private var attachments: AttachmentBridge?
    private var resources: ResourceBridge?
    private var resourceWebPreview: ResourceWebPreviewBridge?
    private var guiPluginPreview: GuiPluginPreviewBridge?
    private var guiPluginResources: GuiPluginPreviewResources?
    private var appearance: AppearanceBridge?
    private var speech: SpeechPlaybackBridge?
    private var recognition: VoiceRecognitionBridge?
    private var remoteDesktop: RemoteDesktopBridge?
    private var terminal: TerminalBridge?
    private var terminalPage: NativeTerminalPreview?
    private var scheduleDate: ScheduleDateBridge?
    private var diagnostics: DiagnosticsBridge?
    private var notifications: NotificationBridge?
    private var passkeys: PasskeyBridge?
    private var shutdownTask: Task<Void, Never>?
    private var authorizationCacheCleanup: AuthorizationCacheCleanupBridge?
    private var pendingLink: URL?
    private var visible = false
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        surface.onError = { [weak self] message in self?.showFailure(message) }
        NativeSheetPresentation.install(on: surface)
        NativeDatePicker.install(on: surface)
        NativeChatHeaderCollapse.install(on: surface)
        view.addSubview(surface); surface.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([surface.topAnchor.constraint(equalTo: view.topAnchor), surface.bottomAnchor.constraint(equalTo: view.bottomAnchor), surface.leadingAnchor.constraint(equalTo: view.leadingAnchor), surface.trailingAnchor.constraint(equalTo: view.trailingAnchor)])
        do {
            bridge = RuntimeBridge(app: surface, store: try ConnectionStore())
            if let bridge {
                bridge.setForeground(UIApplication.shared.applicationState != .background)
                let passkeys = PasskeyBridge(app: surface, presenter: self,
                    associatedDomains: Set(Bundle.main.object(forInfoDictionaryKey: "YuriWebcredentialsDomains") as? [String] ?? []),
                    capture: { [weak bridge] expectedHost in
                        guard let bridge else { throw CancellationError() }
                        return try bridge.passkeyTransport(expectedHost: expectedHost)
                    })
                self.passkeys = passkeys
                let appearance = AppearanceBridge(app: surface, selectedHost: { [weak bridge] in bridge?.store.selected?.id })
                self.appearance = appearance
                let scheduleDate = ScheduleDateBridge(app: surface, capture: { [weak bridge] in
                    guard let bridge, let hostID = bridge.store.selected?.id else { throw CancellationError() }
                    let transport = try bridge.resourceTransport()
                    return ScheduleDateScope(hostID: hostID, isCurrent: transport.isCurrent)
                })
                self.scheduleDate = scheduleDate
                let diagnostics = DiagnosticsBridge(app: surface, controller: self, capture: { [weak bridge] in
                    guard let bridge, let hostID = bridge.store.selected?.id else { throw CancellationError() }
                    let transport = try bridge.resourceTransport()
                    return DiagnosticsScope(hostID: hostID, isCurrent: transport.isCurrent)
                })
                self.diagnostics = diagnostics
                let notifications = NotificationBridge(app: surface, capture: { [weak bridge] in
                    guard let bridge, let selected = bridge.store.selected else { throw CancellationError() }
                    let transport = try bridge.resourceTransport()
                    return NotificationHostScope(hostID: selected.id, isCurrent: transport.isCurrent, authorizationID: selected.authorizationID)
                })
                self.notifications = notifications
                let cacheCleanup = AuthorizationCacheCleanupBridge(app: surface, pending: { [weak bridge] in
                    Set((bridge?.store.pendingAuthorizationRetirements ?? []).map {
                        AuthorizationCacheCleanup.Identity(connectionID: $0.connectionID, authorizationID: $0.authorizationID)
                    })
                }, afterSweep: { [weak bridge] in
                    guard let bridge else { throw CancellationError() }
                    await bridge.retryAuthorizationRetirements()
                    guard let failed = bridge.authorizationRetirementStatus["failed"] as? Int, failed == 0 else {
                        throw NativeFailure.message("authorization_cleanup_failed")
                    }
                })
                self.authorizationCacheCleanup = cacheCleanup
                bridge.onAuthorizationRetired = { [weak notifications, weak cacheCleanup] connectionID, authorizationID in
                    guard let notifications, let cacheCleanup else { throw CancellationError() }
                    cacheCleanup.requestSweep()
                    try cacheCleanup.requireCompletion(connectionID: connectionID, authorizationID: authorizationID)
                    try await notifications.retireAuthorization(connectionID: connectionID, authorizationID: authorizationID)
                }
                Task { [weak bridge] in await bridge?.retryAuthorizationRetirements() }
                let terminal = TerminalBridge(capture: { [weak bridge] expectedHost in
                    guard let bridge else { throw CancellationError() }
                    return try bridge.terminalTransport(expectedHost: expectedHost)
                }, emit: { [weak self] event in self?.surface.send("terminal.event", event) })
                terminal.setForeground(UIApplication.shared.applicationState != .background)
                terminal.register(app: surface)
                self.terminal = terminal
                let terminalPage = NativeTerminalPreview(presenter: self, bridge: terminal, emit: { [weak self] event in self?.surface.send("terminal.preview.event", event) })
                terminalPage.register(app: surface)
                self.terminalPage = terminalPage
                let resources = try ResourceBridge(controller: self, capture: { [weak bridge] expectedHost in
                    guard let bridge else { throw CancellationError() }
                    return try bridge.resourceTransport(expectedHost: expectedHost)
                })
                self.resources = resources
                resources.install(on: surface)
                resources.installPresentationAnchor(on: surface)
                let svgResolve: ResourceSVGImageFactory.Resolve = { [weak resources] lease, expectedHost in
                    guard let resources else { throw CancellationError() }
                    let asset = try resources.svgAsset(lease, expectedHost: expectedHost)
                    return ResourceSVGImageAsset(url: asset.url, current: asset.current, observeRetirement: asset.observe)
                }
                ResourceSVGImageFactory.install(on: surface, resolve: svgResolve)
                resources.makeSVGPreview = { lease, expectedHost in
                    try ResourceSVGImageFactory.controller(lease: lease, expectedHost: expectedHost, resolve: svgResolve)
                }
                let resourceWebPreview = ResourceWebPreviewBridge(controller: self, capture: { [weak bridge] expectedHost in
                    guard let bridge else { throw CancellationError() }
                    return try bridge.resourceWebPreviewTransport(expectedHost: expectedHost)
                })
                self.resourceWebPreview = resourceWebPreview
                resourceWebPreview.install(on: surface)
                resourceWebPreview.initialFile = { [weak resources] lease, path, expectedHost in
                    guard let resources else { throw CancellationError() }
                    let original = try resources.htmlInitial(lease, path: path, expectedHost: expectedHost)
                    return ResourceWebPreviewResponse(status: 200, mime: original.mime, data: original.data)
                }
                resourceWebPreview.installView(on: surface, covered: { [weak resources] owner in resources?.ownsPresentation(owner) == true })
                let guiPluginPreview = GuiPluginPreviewBridge(controller: self, capture: { [weak self, weak bridge] expectedHost in
                    guard let self, let bridge else { throw CancellationError() }
                    let io = try bridge.guiPluginPreviewCapture(expectedHost: expectedHost)
                    if self.guiPluginResources == nil {
                        guard let staged = Bundle.main.url(forResource: "gui-plugin-preview", withExtension: nil) else { throw GuiPluginPreviewFailure.unavailable }
                        let storage = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
                            .appendingPathComponent("gui-plugin-storage", isDirectory: true)
                        self.guiPluginResources = try GuiPluginPreviewResources(stagedDirectory: staged, storageDirectory: storage)
                    }
                    guard let resources = self.guiPluginResources else { throw GuiPluginPreviewFailure.unavailable }
                    var captured = try resources.capture(expectedHost: io.expectedHost,
                        isCurrent: { expected in expected == io.expectedHost && io.isCurrent() },
                        resource: io.resource, readGui: io.readGui, openGui: io.openGui)
                    captured.isHostResourceURL = io.isHostResourceURL
                    return captured
                })
                self.guiPluginPreview = guiPluginPreview
                guiPluginPreview.install(on: surface)
                let speech = SpeechPlaybackBridge(app: surface, captureVoices: { [weak bridge] expected in
                    guard let bridge else { throw CancellationError() }
                    let captured = try bridge.resourceTransport(expectedHost: expected)
                    return NativeSpeechVoiceScope(expectedHost: expected, isCurrent: captured.isCurrent)
                }, capture: { [weak bridge] in
                    guard let bridge else { throw CancellationError() }
                    return try bridge.resourceTransport()
                })
                self.speech = speech
                let recognition = VoiceRecognitionBridge(app: surface, capture: { [weak bridge] expectedHost in
                    guard let bridge else { throw CancellationError() }
                    return try bridge.voiceRecognitionTransport(expectedHost: expectedHost)
                }, beforeCapture: { [weak speech] in speech?.invalidate() })
                self.recognition = recognition
                let remoteDesktop = RemoteDesktopBridge(app: surface, capture: { [weak bridge] in
                    guard let bridge else { throw CancellationError() }
                    return try bridge.remoteDesktopTransport()
                })
                self.remoteDesktop = remoteDesktop
                bridge.onInvalidate = { [weak self, weak resources, weak appearance, weak speech, weak recognition, weak remoteDesktop, weak terminal, weak terminalPage, weak resourceWebPreview, weak guiPluginPreview, weak diagnostics, weak notifications] in
                    resources?.invalidate()
                    resourceWebPreview?.invalidate()
                    guiPluginPreview?.invalidate()
                    speech?.invalidate()
                    recognition?.invalidate()
                    remoteDesktop?.invalidate()
                    terminalPage?.invalidate()
                    terminal?.invalidate()
                    diagnostics?.invalidate()
                    notifications?.invalidate()
                    do { try appearance?.invalidate() } catch { self?.surface.send("appearance.error", ["message": "原生外观重置失败"]) }
                }
                let attachmentStorage = surface.storageDirectory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
                    .appendingPathComponent("nsh", isDirectory: true).appendingPathComponent(Bundle.main.bundleIdentifier ?? "com.yee94.yuri.nsh", isDirectory: true)
                let attachments = AttachmentBridge(controller: self, runtime: bridge, journal: AttachmentReceiptJournal(directory: attachmentStorage))
                self.attachments = attachments
                surface.handle("runtime.pickAttachment") { [weak attachments] input async throws -> Any? in
                    guard let attachments else { throw CancellationError() }
                    return try await attachments.pick(input)
                }
                surface.handle("runtime.cancelAttachment") { [weak attachments] input async throws -> Any? in
                    guard let attachments else { throw CancellationError() }
                    try await attachments.retirePick(input)
                    return nil
                }
                surface.handle("runtime.reconcileAttachment") { [weak attachments] input async throws -> Any? in
                    guard let attachments else { throw CancellationError() }
                    return try await attachments.reconcilePick(input)
                }
                surface.handle("runtime.pendingAttachments") { [weak attachments] input async throws -> Any? in
                    guard let attachments else { throw CancellationError() }
                    return try attachments.pendingReceipts(input)
                }
                surface.handle("runtime.acknowledgeAttachment") { [weak attachments] input async throws -> Any? in
                    guard let attachments else { throw CancellationError() }
                    try attachments.acknowledgePick(input)
                    return nil
                }
            }
            surface.handle("camera.scan") { [weak self] _, reply in
                guard let self else { reply.reject("应用已关闭"); return }
                self.scan(reply)
            }
            NavigationBridge.install(on: surface)
            FeedbackLayoutBridge.install(on: surface)
            NewSessionPickerOwners.install(on: surface)
            NativeInputMetadataOwner.install(on: surface)
            NativeComposerSpellcheck.install(on: surface)
            NativeComposerPress.install(on: surface)
            guard let bundle = Bundle.main.url(forResource: "bundle", withExtension: "nshc", subdirectory: "nsh") else { throw NativeFailure.message("未找到原生应用资源") }
            try surface.loadBundle(at: bundle)
        } catch {
            showFailure(error.localizedDescription)
        }
    }
    private func showFailure(_ value: String) {
        let message = UILabel(); message.numberOfLines = 0; message.text = value
        message.textColor = .label; message.backgroundColor = .systemBackground
        message.translatesAutoresizingMaskIntoConstraints = false; view.addSubview(message)
        NSLayoutConstraint.activate([message.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24), message.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24), message.centerYAnchor.constraint(equalTo: view.centerYAnchor)])
    }
    @discardableResult func receive(_ url: URL) -> Bool {
        guard url.scheme == "yuri", url.host == "connect", url.absoluteString.count <= 16384 else { return false }
        pendingLink = url
        confirmLinkIfReady()
        return true
    }
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated); visible = true; confirmLinkIfReady()
    }
    override func viewDidDisappear(_ animated: Bool) { super.viewDidDisappear(animated); visible = false }
    func suspendResourcePreview() { terminal?.setForeground(false); bridge?.setForeground(false); resourceWebPreview?.invalidate(); guiPluginPreview?.invalidate() }
    func resumeRuntime() {
        bridge?.setForeground(true); terminal?.setForeground(true)
        authorizationCacheCleanup?.requestSweep()
        Task { [weak bridge] in await bridge?.retryAuthorizationRetirements() }
    }
    func shutdown() {
        guard shutdownTask == nil else { return }
        let passkeys = passkeys
        Self.shutdown(bridge: bridge, notifications: notifications, diagnostics: diagnostics, recognition: recognition, terminal: terminal, terminalPage: terminalPage, guiPluginPreview: guiPluginPreview)
        shutdownTask = Task { @MainActor in await passkeys?.close() }
    }
    private static func shutdown(bridge: RuntimeBridge?, notifications: NotificationBridge?, diagnostics: DiagnosticsBridge?, recognition: VoiceRecognitionBridge?, terminal: TerminalBridge?, terminalPage: NativeTerminalPreview?, guiPluginPreview: GuiPluginPreviewBridge?) {
        withExtendedLifetime((notifications, diagnostics, recognition, terminal, terminalPage, guiPluginPreview)) {
            let installed = bridge?.onInvalidate != nil
            bridge?.stop()
            if !installed { notifications?.invalidate(); diagnostics?.invalidate(); recognition?.invalidate(); terminalPage?.invalidate(); terminal?.invalidate(); guiPluginPreview?.invalidate() }
        }
    }
    deinit {
        let bridge = bridge, notifications = notifications, diagnostics = diagnostics, recognition = recognition, terminal = terminal, terminalPage = terminalPage, guiPluginPreview = guiPluginPreview, passkeys = passkeys, pendingShutdown = shutdownTask
        Task { @MainActor in
            if let pendingShutdown { await pendingShutdown.value; return }
            Self.shutdown(bridge: bridge, notifications: notifications, diagnostics: diagnostics, recognition: recognition, terminal: terminal, terminalPage: terminalPage, guiPluginPreview: guiPluginPreview)
            await passkeys?.close()
        }
    }
    private func confirmLinkIfReady() {
        guard visible, presentedViewController == nil, let link = pendingLink else { return }
        pendingLink = nil
        let alert = UIAlertController(title: "导入配对链接？", message: "请确认链接来自你的 Yuri Host。导入后仍需在连接页点击连接，才会兑换授权。", preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "取消", style: .cancel) { [weak self] _ in self?.confirmNextLink() })
        alert.addAction(UIAlertAction(title: "导入", style: .default) { [weak self] _ in
            self?.surface.send("connection.link", ["url": link.absoluteString])
            self?.confirmNextLink()
        })
        present(alert, animated: true)
    }
    private func confirmNextLink() {
        // UIKit finishes dismissing an action's alert after invoking its handler.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in self?.confirmLinkIfReady() }
    }
    private func scan(_ reply: NshHostReply) {
        guard presentedViewController == nil else { reply.reject("请先关闭当前窗口"); return }
        let scanner = QRScanner()
        scanner.modalPresentationStyle = .fullScreen
        scanner.complete = { [weak scanner] value in
            scanner?.dismiss(animated: true)
            if let value { reply.resolve(value) } else { reply.reject("扫描已取消") }
        }
        present(scanner, animated: true)
    }
    override var preferredStatusBarStyle: UIStatusBarStyle { NshAppView.preferredStatusBarStyle }
    override var prefersStatusBarHidden: Bool { NshAppView.prefersStatusBarHidden }
    override var preferredStatusBarUpdateAnimation: UIStatusBarAnimation { NshAppView.preferredStatusBarUpdateAnimation }
}

UIApplicationMain(CommandLine.argc, CommandLine.unsafeArgv, nil, NSStringFromClass(AppDelegate.self))
