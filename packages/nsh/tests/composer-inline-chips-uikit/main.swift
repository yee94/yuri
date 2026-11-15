import Foundation
import UIKit
import NativeShell

@MainActor private final class Carrier: UIViewController {
    let surface = NshAppView()
    var audit: Timer?
    var phase = 0
    var rows: [[String: Any]] = []
    override func viewDidLoad() {
        super.viewDidLoad()
        surface.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(surface)
        NSLayoutConstraint.activate([surface.topAnchor.constraint(equalTo: view.topAnchor), surface.bottomAnchor.constraint(equalTo: view.bottomAnchor), surface.leadingAnchor.constraint(equalTo: view.leadingAnchor), surface.trailingAnchor.constraint(equalTo: view.trailingAnchor)])
        NativeComposerInlineChips.install(on: surface)
        surface.cacheOptions = NshCacheOptions(location: .off, images: .off)
        do {
            try surface.grantCapabilities("{}")
            try surface.loadBundle(at: Bundle.main.url(forResource: "bundle", withExtension: "nshc", subdirectory: "nsh")!)
        } catch { print("[inline-chips-carrier] bundle failed") }
        audit = Timer.scheduledTimer(withTimeInterval: 0.8, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.sample() }
        }
    }
    private func descendants(_ root: UIView) -> [UIView] { [root] + root.subviews.flatMap(descendants) }
    private func sample() {
        let editors = descendants(surface).filter { $0.accessibilityIdentifier == "chip-input" }.flatMap(descendants).compactMap { $0 as? UITextView }
        var attachments = 0
        var markers = 0
        if let editor = editors.first {
            let range = NSRange(location: 0, length: editor.textStorage.length)
            attachments = editor.subviews.filter { $0.accessibilityIdentifier == "yuri-inline-chip-icon" && !$0.isHidden }.count
            editor.textStorage.enumerateAttribute(NSAttributedString.Key("YuriComposerInlineChip"), in: range) { value, _, _ in if value != nil { markers += 1 } }
            rows.append(["phase": phase, "editors": editors.count, "attachments": attachments, "markers": markers, "text": editor.text ?? "", "selection": [editor.selectedRange.location, editor.selectedRange.length]])
        } else { rows.append(["phase": phase, "editors": 0, "attachments": 0, "markers": 0]) }
        let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        if phase == 2 || phase == 5 {
            let renderer = UIGraphicsImageRenderer(bounds: view.bounds)
            let image = renderer.image { _ in _ = view.drawHierarchy(in: view.bounds, afterScreenUpdates: true) }
            try? image.pngData()?.write(to: directory.appendingPathComponent("chips-phase\(phase).png"), options: .atomic)
        }
        if phase == 6 {
            audit?.invalidate(); audit = nil
            let geometry = descendants(surface).map { node -> [String: Any] in
                let frame = node.convert(node.bounds, to: surface)
                var value: [String: Any] = ["class": String(describing: type(of: node)), "id": node.accessibilityIdentifier ?? "", "frame": [frame.minX, frame.minY, frame.width, frame.height]]
                if let label = node as? UILabel { value["text"] = label.text ?? ""; value["font"] = label.font.pointSize }
                return value
            }
            if let data = try? JSONSerialization.data(withJSONObject: geometry, options: .prettyPrinted) { try? data.write(to: directory.appendingPathComponent("chip-geometry.json"), options: .atomic) }
            if let data = try? JSONSerialization.data(withJSONObject: rows, options: .prettyPrinted) { try? data.write(to: directory.appendingPathComponent("chip-audit.json"), options: .atomic) }
            return
        }
        phase += 1
        surface.send("fixture.chips.step", ["phase": phase])
    }
}

@main @MainActor final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.overrideUserInterfaceStyle = ProcessInfo.processInfo.environment["CHIP_SCHEME"] == "dark" ? .dark : .light
        window.rootViewController = Carrier(); window.makeKeyAndVisible(); self.window = window
        return true
    }
}
