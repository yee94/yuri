import UIKit
import NativeShell

@MainActor final class TerminalDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = TerminalController()
        window.makeKeyAndVisible()
        self.window = window
        return true
    }
}

@MainActor final class TerminalController: UIViewController {
    private let surface = NshAppView()
    private var observer: TerminalObserver?
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        surface.onError = { [weak self] message in self?.failure(message) }
        surface.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(surface)
        NSLayoutConstraint.activate([
            surface.topAnchor.constraint(equalTo: view.topAnchor), surface.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            surface.leadingAnchor.constraint(equalTo: view.leadingAnchor), surface.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
        observer = TerminalObserver(surface: surface)
        guard let url = Bundle.main.url(forResource: "bundle", withExtension: "nshc", subdirectory: "nsh") else {
            failure("未找到独立终页 bundle"); return
        }
        guard let capabilitiesURL = Bundle.main.url(forResource: "capabilities", withExtension: "json", subdirectory: "nsh") else {
            failure("未找到独立终页 capabilities"); return
        }
        do {
            let capabilities = try String(contentsOf: capabilitiesURL, encoding: .utf8)
            try surface.grantCapabilities(capabilities)
            try surface.loadBundle(at: url)
        }
        catch { failure(error.localizedDescription) }
    }
    private func failure(_ message: String) {
        let label = UILabel(frame: view.bounds.insetBy(dx: 24, dy: 100))
        label.accessibilityIdentifier = "terminal-native-error"
        label.text = message; label.numberOfLines = 0
        label.textColor = .label; label.backgroundColor = .systemBackground
        view.addSubview(label)
    }
    override var preferredStatusBarStyle: UIStatusBarStyle { NshAppView.preferredStatusBarStyle }
    override var prefersStatusBarHidden: Bool { NshAppView.prefersStatusBarHidden }
}

UIApplicationMain(CommandLine.argc, CommandLine.unsafeArgv, nil, NSStringFromClass(TerminalDelegate.self))
