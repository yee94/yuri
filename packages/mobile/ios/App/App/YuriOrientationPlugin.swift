import Capacitor
import UIKit

@objc(YuriOrientationPlugin)
class YuriOrientationPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "YuriOrientationPlugin"
    let jsName = "YuriOrientation"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "lock", returnType: CAPPluginReturnPromise)
    ]

    /// Read by YuriBridgeViewController; the app stays portrait except while the remote desktop page asks for landscape.
    static var mask: UIInterfaceOrientationMask = .portrait

    @objc func lock(_ call: CAPPluginCall) {
        let landscape = call.getString("orientation") == "landscape"
        DispatchQueue.main.async { [weak self] in
            YuriOrientationPlugin.mask = landscape ? .landscape : .portrait
            guard let controller = self?.bridge?.viewController else { call.reject("Orientation host unavailable"); return }
            controller.setNeedsUpdateOfSupportedInterfaceOrientations()
            if #available(iOS 16.0, *), let scene = controller.view.window?.windowScene {
                // Allow both landscape sides so the system keeps the way the phone is already held instead of flipping 180°.
                scene.requestGeometryUpdate(.iOS(interfaceOrientations: landscape ? .landscape : .portrait)) { _ in }
            } else {
                // UIDeviceOrientation left/right are mirrored relative to UIInterfaceOrientation.
                let device = UIDevice.current.orientation
                let target: UIInterfaceOrientation = !landscape ? .portrait
                    : device == .landscapeRight ? .landscapeLeft : .landscapeRight
                UIDevice.current.setValue(target.rawValue, forKey: "orientation")
                UIViewController.attemptRotationToDeviceOrientation()
            }
            call.resolve()
        }
    }
}
