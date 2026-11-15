import Foundation
import CoreGraphics
import ImageIO

let directory = URL(fileURLWithPath: CommandLine.arguments[1])
let geometry = try JSONSerialization.jsonObject(with: Data(contentsOf: directory.appendingPathComponent("chip-geometry.json"))) as! [[String: Any]]
let source = CGImageSourceCreateWithURL(directory.appendingPathComponent("chips-phase5.png") as CFURL, nil)!
let image = CGImageSourceCreateImageAtIndex(source, 0, nil)!
let message = geometry.first { $0["id"] as? String == "chip-message" }!["frame"] as! [Double]
let scale = Double(image.width) / (message[0] * 2 + message[2])
let width = image.width, height = image.height
var pixels = [UInt8](repeating: 0, count: width * height * 4)
pixels.withUnsafeMutableBytes { bytes in
    let context = CGContext(data: bytes.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
}
let background = [Int(pixels[0]), Int(pixels[1]), Int(pixels[2])]
func ink(_ rect: [Double]) -> (center: Double, chroma: Int) {
    var ys: [Int] = [], chroma = 0
    for y in max(0, Int(rect[1] * scale))..<min(height, Int((rect[1] + rect[3]) * scale)) {
        for x in max(0, Int(rect[0] * scale))..<min(width, Int((rect[0] + rect[2]) * scale)) {
            let i = (y * width + x) * 4
            let rgb = [Int(pixels[i]), Int(pixels[i + 1]), Int(pixels[i + 2])]
            if zip(rgb, background).map({ abs($0.0 - $0.1) }).max()! > 60 { ys.append(y) }
            if rgb.max()! - rgb.min()! > 50 { chroma += 1 }
        }
    }
    precondition(!ys.isEmpty, "Expected visible glyphs")
    return (Double(ys.min()! + ys.max()!) / (2 * scale), chroma)
}
let skill = geometry.first { $0["id"] as? String == "message-reference-skill" }!["frame"] as! [Double]
let plain = ink([message[0], message[1], skill[0] - message[0] - 2, message[3]])
var failed = false
for id in ["message-reference-skill", "message-reference-image"] {
    let frame = geometry.first { $0["id"] as? String == id }!["frame"] as! [Double]
    let chip = ink([frame[0], message[1], frame[2], message[3]])
    let delta = abs(plain.center - chip.center)
    print("\(id): prose-center=\(plain.center), chip-center=\(chip.center), delta=\(delta)pt, colored-pixels=\(chip.chroma)")
    if delta > 2 || chip.chroma <= 20 { failed = true }
}
if failed { print("FAIL: expected centered inline glyphs and a semantic highlight color"); exit(1) }
let input = geometry.first { $0["id"] as? String == "chip-input" }!["frame"] as! [Double]
let inputInk = ink(input)
print("input colored-pixels=\(inputInk.chroma)")
if inputInk.chroma <= 20 { print("FAIL: input reference lost its highlight color"); exit(1) }

let detailSource = CGImageSourceCreateWithURL(directory.appendingPathComponent("chips-phase2.png") as CFURL, nil)!
let detail = CGImageSourceCreateImageAtIndex(detailSource, 0, nil)!
let owner = geometry.first { $0["id"] as? String == "chip-owner" }!["frame"] as! [Double]
let top = max(0, owner[1] - 12)
let bottom = message[1] + message[3] + 12
let crop = detail.cropping(to: CGRect(x: (message[0] - 12) * scale, y: top * scale, width: (message[2] + 24) * scale, height: (bottom - top) * scale))!
let output = CGImageDestinationCreateWithURL(directory.appendingPathComponent("chip-detail.png") as CFURL, "public.png" as CFString, 1, nil)!
CGImageDestinationAddImage(output, crop, nil)
precondition(CGImageDestinationFinalize(output))
