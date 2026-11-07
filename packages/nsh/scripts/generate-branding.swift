import AppKit
import Foundation

// Resource generation uses macOS system frameworks; no image tooling dependency is needed.
let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let catalog = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
let brand = root.appendingPathComponent("assets/brand/yuri", isDirectory: true)
let files = FileManager.default

func json(_ value: Any, at url: URL) throws {
    try files.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys]).write(to: url)
}

func color(_ hex: String) throws -> CGColor {
    guard let value = UInt32(hex.trimmingCharacters(in: CharacterSet(charactersIn: "#")), radix: 16) else {
        throw NSError(domain: "YuriBrand", code: 1, userInfo: [NSLocalizedDescriptionKey: "Invalid brand color"])
    }
    return CGColor(srgbRed: CGFloat((value >> 16) & 255) / 255, green: CGFloat((value >> 8) & 255) / 255, blue: CGFloat(value & 255) / 255, alpha: 1)
}

func image(_ url: URL) throws -> CGImage {
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil), let result = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        throw NSError(domain: "YuriBrand", code: 2, userInfo: [NSLocalizedDescriptionKey: "Cannot decode \(url.lastPathComponent)"])
    }
    return result
}

func png(width: Int, height: Int, opaque: Bool = false, at url: URL, draw: (CGContext) throws -> Void) throws {
    let alpha: CGImageAlphaInfo = opaque ? .noneSkipLast : .premultipliedLast
    guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: alpha.rawValue) else {
        throw NSError(domain: "YuriBrand", code: 3)
    }
    context.interpolationQuality = .high
    try draw(context)
    guard let rendered = context.makeImage(), let destination = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) else {
        throw NSError(domain: "YuriBrand", code: 4)
    }
    CGImageDestinationAddImage(destination, rendered, nil)
    guard CGImageDestinationFinalize(destination) else { throw NSError(domain: "YuriBrand", code: 5) }
}

func matches(_ pattern: String, in text: String) throws -> [String] {
    let expression = try NSRegularExpression(pattern: pattern)
    return expression.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap {
        Range($0.range(at: 1), in: text).map { String(text[$0]) }
    }
}

let info: [String: Any] = ["author": "yuri", "version": 1]
try files.createDirectory(at: catalog, withIntermediateDirectories: true)
try json(["info": info], at: catalog.appendingPathComponent("Contents.json"))
let iconDirectory = catalog.appendingPathComponent("AppIcon.appiconset", isDirectory: true)
try files.createDirectory(at: iconDirectory, withIntermediateDirectories: true)
let mask = try image(brand.appendingPathComponent("yuri-b-mark-black-1024.png"))
var icons: [[String: Any]] = []
for appearance in ["light", "dark"] {
    let svg = try String(contentsOf: brand.appendingPathComponent("yuri-b-icon-\(appearance).svg"), encoding: .utf8)
    let stops = try matches("stop-color=\"(#[0-9A-Fa-f]{6})\"", in: svg)
    let fills = try matches("<path fill=\"(#[0-9A-Fa-f]{6})\"", in: svg)
    guard stops.count == 2, let fill = fills.first else { throw NSError(domain: "YuriBrand", code: 6) }
    let filename = "AppIcon-\(appearance).png"
    try png(width: 1024, height: 1024, opaque: true, at: iconDirectory.appendingPathComponent(filename)) { context in
        // Keep the approved tile's gradient and exact mark scale; iOS supplies the outer mask.
        let gradient = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: try stops.map { try color($0) } as CFArray, locations: [0, 1])!
        context.drawLinearGradient(gradient, start: CGPoint(x: 512, y: 1024), end: CGPoint(x: 512, y: 0), options: [])
        let extent = 640.0 / 824.0 * 1024.0
        let rect = CGRect(x: (1024 - extent) / 2, y: (1024 - extent) / 2, width: extent, height: extent)
        context.saveGState()
        context.clip(to: rect, mask: mask)
        context.setFillColor(try color(fill))
        context.fill(rect)
        context.restoreGState()
    }
    var entry: [String: Any] = ["filename": filename, "idiom": "universal", "platform": "ios", "size": "1024x1024"]
    if appearance == "dark" { entry["appearances"] = [["appearance": "luminosity", "value": "dark"]] }
    icons.append(entry)
}
try json(["images": icons, "info": info], at: iconDirectory.appendingPathComponent("Contents.json"))

for (name, basename, width) in [("YuriMark", "yuri-b-mark", 96), ("YuriWordmark", "yuri-wordmark", 112)] {
    let directory = catalog.appendingPathComponent("\(name).imageset", isDirectory: true)
    try files.createDirectory(at: directory, withIntermediateDirectories: true)
    var images: [[String: Any]] = []
    for (appearance, ink) in [("light", "black"), ("dark", "white")] {
        let source = try image(brand.appendingPathComponent("\(basename)-\(ink)\(name == "YuriMark" ? "-1024" : "").png"))
        for scale in 1...3 {
            let filename = "\(name)-\(appearance)@\(scale)x.png"
            let height = Int((Double(width) * Double(source.height) / Double(source.width)).rounded())
            try png(width: width * scale, height: height * scale, at: directory.appendingPathComponent(filename)) { context in
                context.draw(source, in: CGRect(x: 0, y: 0, width: width * scale, height: height * scale))
            }
            var entry: [String: Any] = ["filename": filename, "idiom": "universal", "scale": "\(scale)x"]
            if appearance == "dark" { entry["appearances"] = [["appearance": "luminosity", "value": "dark"]] }
            images.append(entry)
        }
    }
    try json(["images": images, "info": info], at: directory.appendingPathComponent("Contents.json"))
}

let theme = try JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent("packages/nsh/theme.json"))) as! [String: Any]
let variables = theme["cssVars"] as! [String: Any]
var colors: [[String: Any]] = []
for appearance in ["light", "dark"] {
    let value = try color((variables[appearance] as! [String: Any])["background"] as! String)
    let channels = value.components!
    var entry: [String: Any] = ["idiom": "universal", "color": ["color-space": "srgb", "components": ["red": String(format: "%.8f", channels[0]), "green": String(format: "%.8f", channels[1]), "blue": String(format: "%.8f", channels[2]), "alpha": "1.000"]]]
    if appearance == "dark" { entry["appearances"] = [["appearance": "luminosity", "value": "dark"]] }
    colors.append(entry)
}
try json(["colors": colors, "info": info], at: catalog.appendingPathComponent("YuriLaunchBackground.colorset/Contents.json"))
print("Generated native Yuri brand catalog: \(catalog.path)")
