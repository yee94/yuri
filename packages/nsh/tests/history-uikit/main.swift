import UIKit
import NativeShell

@MainActor final class FixtureDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = FixtureController()
        window.makeKeyAndVisible()
        self.window = window
        return true
    }
}

@MainActor final class FixtureController: UIViewController {
    private let surface = NshAppView()
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        surface.onError = { [weak self] message in self?.showFailure(message) }
        surface.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(surface)
        NSLayoutConstraint.activate([
            surface.topAnchor.constraint(equalTo: view.topAnchor),
            surface.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            surface.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            surface.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
        guard let url = Bundle.main.url(forResource: "bundle", withExtension: "nshc", subdirectory: "nsh") else {
            showFailure("未找到历史专项夹具 bundle")
            return
        }
        do { try surface.loadBundle(at: url) }
        catch { showFailure(error.localizedDescription) }
    }
    private func showFailure(_ text: String) {
        let label = UILabel()
        label.accessibilityIdentifier = "history-uikit-native-error"
        label.text = text
        label.numberOfLines = 0
        label.textColor = .label
        label.backgroundColor = .systemBackground
        label.frame = view.bounds.insetBy(dx: 24, dy: 100)
        label.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(label)
    }
    override var preferredStatusBarStyle: UIStatusBarStyle { NshAppView.preferredStatusBarStyle }
    override var prefersStatusBarHidden: Bool { NshAppView.prefersStatusBarHidden }
    override var preferredStatusBarUpdateAnimation: UIStatusBarAnimation { NshAppView.preferredStatusBarUpdateAnimation }
}

UIApplicationMain(CommandLine.argc, CommandLine.unsafeArgv, nil, NSStringFromClass(FixtureDelegate.self))
