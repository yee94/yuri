import UIKit
import NativeShell

@MainActor extension ResourceSVGImageFactory {
    static func install(on surface: NshAppView, resolve: @escaping Resolve) {
        surface.register(component: "yuri.resource.svgImage") { _ in ResourceSVGImageComponent(resolve: resolve) }
    }
}

@MainActor private final class ResourceSVGImageComponent: NshComponent {
    let image: ResourceSVGImageView
    var view: UIView { image }
    init(resolve: @escaping ResourceSVGImageFactory.Resolve) { image = ResourceSVGImageView(resolve: resolve) }
    func setProp(_ name: String, _ value: Any?) { if name == "config" { image.update(value) } }
}
