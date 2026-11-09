@main struct AnchorContract {
    @MainActor static func main() {
        func emit(_ name: String, _ fields: [String: Any] = [:]) {
            let data = try! JSONSerialization.data(withJSONObject: fields.merging(["event": name]) { _, new in new }, options: [.sortedKeys])
            print(String(data: data, encoding: .utf8)!); fflush(stdout)
        }
        let bridge = ResourceBridge()
        _ = bridge.authority.setForeground(true, hostID: bridge.hostID)
        let expected = bridge.authority.scope(hostID: bridge.hostID)!
        let context = NshComponentContext(emit: { emit($0, $1) })
        let anchor = ResourcePresentationAnchor(bridge: bridge, context: context)
        let presenter = UIViewController(), controller = UIViewController(), foreign = UIViewController()
        controller.presentingViewController = presenter; presenter.presentedViewController = controller
        let root = controller.viewIfLoaded!
        root.next = controller
        while let line = readLine() {
            let parts = line.split(separator: " ").map(String.init)
            switch parts.first {
            case "configure": anchor.setProp("config", ["owner": parts[1], "expectedHost": expected.publicValue])
            case "revoke": _ = bridge.authority.setForeground(false, hostID: bridge.hostID)
            case "restoreAuthority": _ = bridge.authority.setForeground(true, hostID: bridge.hostID)
            case "request": anchor.setProp("closeAttempt", Int(parts[1])!); anchor.setProp("closing", true)
            case "attach":
                anchor.view.superview = root; anchor.view.next = root; anchor.view.window = root
                anchor.view.didMoveToWindow()
            case "layout": anchor.view.layoutSubviews()
            case "foreign": presenter.presentedViewController = foreign
            case "restoreController": presenter.presentedViewController = controller
            case "open": controller.isBeingPresented = false; controller.transitionCoordinator?.complete()
            case "cancelOpening": controller.isBeingPresented = false; controller.transitionCoordinator?.complete(cancelled: true)
            case "complete": controller.completeDismiss()
            case "replaceAncestry":
                foreign.viewIfLoaded?.next = foreign; foreign.presentingViewController = presenter
                anchor.view.superview = foreign.viewIfLoaded; anchor.view.next = foreign.viewIfLoaded
                anchor.view.layoutSubviews()
            case "quit": return
            default: fatalError("Unknown native contract command")
            }
            emit("ack", ["command": parts[0], "dismissCalls": controller.dismissCalls, "foreignDismissCalls": foreign.dismissCalls,
                         "captures": bridge.captures, "presenters": bridge.presenters.count])
        }
    }
}
