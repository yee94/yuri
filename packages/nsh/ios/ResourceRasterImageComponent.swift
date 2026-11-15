import UIKit
import NativeShell

@MainActor extension ResourceRasterImageFactory {
    /// Only the component receives `config` and emits presentation events; it has no
    /// transport, path resolution or file bytes and can never mint Host authority.
    static func install(on surface: NshAppView, resolve: @escaping Resolve) {
        surface.register(component: "yuri.resource.rasterImage") { context in
            ResourceRasterImageComponent(resolve: resolve, emit: { name, body in context.emit(name, body) })
        }
    }
}

@MainActor private final class ResourceRasterImageComponent: NshComponent {
    let image: ResourceRasterImageView
    var view: UIView { image }
    init(resolve: @escaping ResourceRasterImageFactory.Resolve, emit: @escaping (String, [String: Any]) -> Void) {
        image = ResourceRasterImageView(resolve: resolve)
        image.event = { event in
            switch event {
            case .sized(let width, let height): emit("size", ["width": width, "height": height])
            case .loaded(let width, let height): emit("load", ["width": width, "height": height])
            case .failed(let code): emit("error", ["code": code])
            case .stopped: break
            }
        }
    }
    func setProp(_ name: String, _ value: Any?) { if name == "config" { image.update(value) } }
    func command(_ name: String, _ args: Any?) { if name == "retry" { image.retry() } }
}
