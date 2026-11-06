import Capacitor
import UIKit
import WebKit

private final class GuiNetworkController: CAPBridgeViewController {
    override func capacitorDidLoad() { bridge?.registerPluginInstance(YuriGuiNetworkPlugin()) }
}

@main
final class GuiNetworkProbe: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        let controller = GuiNetworkController()
        window.rootViewController = controller
        window.makeKeyAndVisible()
        self.window = window
        var seen = 0
        Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { _ in
            controller.webView?.evaluateJavaScript("window.guiProbeLog || []") { result, _ in
                guard let values = result as? [String], values.count > seen else { return }
                for value in values.dropFirst(seen) {
                    print("GUI_NETWORK_PROBE \(value)"); fflush(stdout)
                    if value == "PASSED" || value.hasPrefix("FAILED") { exit(value == "PASSED" ? 0 : 1) }
                }
                seen = values.count
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 70) { print("GUI_NETWORK_PROBE FAILED timeout"); fflush(stdout); exit(1) }
        return true
    }
}
