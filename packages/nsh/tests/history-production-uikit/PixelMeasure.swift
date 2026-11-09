import Foundation
import AVFoundation
import CoreVideo

// Offline actual coded-frame registration, not a display-frame interpolation or native-box stand-in.
let arguments = CommandLine.arguments
guard arguments.count == 3 else { fatalError("Usage: pixel-measure movie plan.json") }
let plan = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: arguments[2]))) as! [String: Any]
let rois = plan["rois"] as! [[String: Int]], scale = plan["pixelsPerPoint"] as! Double
let start = plan["startPTS"] as! Double, end = plan["endPTS"] as! Double, referencePTS = plan["referencePTS"] as! Double
let width = plan["width"] as! Int, height = plan["height"] as! Int
guard rois.count == 3, scale.isFinite, scale > 0 else { fatalError("Invalid pixel plan") }
let asset = AVURLAsset(url: URL(fileURLWithPath: arguments[1]))
guard let track = asset.tracks(withMediaType: .video).first else { fatalError("No video") }
let reader = try AVAssetReader(asset: asset)
let output = AVAssetReaderTrackOutput(track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
reader.add(output); guard reader.startReading() else { fatalError("Decode could not start") }
func gray(_ buffer: CVPixelBuffer) -> [UInt8] {
    precondition(CVPixelBufferGetWidth(buffer) == width && CVPixelBufferGetHeight(buffer) == height)
    CVPixelBufferLockBaseAddress(buffer, .readOnly); defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
    let bytes = CVPixelBufferGetBaseAddress(buffer)!.assumingMemoryBound(to: UInt8.self), stride = CVPixelBufferGetBytesPerRow(buffer)
    var value = [UInt8](repeating: 0, count: width * height)
    for y in 0..<height { for x in 0..<width { value[y * width + x] = bytes[y * stride + x * 4 + 1] } }
    return value
}
func score(_ current: [UInt8], _ reference: [UInt8], _ shift: Int, _ coarse: Bool) -> Double {
    var total = 0, count = 0
    for roi in rois {
        let x = roi["x"]!, y = roi["y"]!, w = roi["width"]!, h = roi["height"]!
        if x < 0 || w <= 0 || h <= 0 || x + w > width || y < 0 || y + h > height || y + shift < 0 || y + h + shift > height { return 1000 }
        for row in stride(from: y, to: y + h, by: coarse ? 4 : 1) {
            for column in stride(from: x, to: x + w, by: coarse ? 8 : 2) {
                total += abs(Int(current[(row + shift) * width + column]) - Int(reference[row * width + column])); count += 1
            }
        }
    }
    return count == 0 ? 1000 : Double(total) / Double(count)
}
var reference: [UInt8]?, pending: [(Double, [UInt8])] = [], rows: [[String: Any]] = []
var decoded = 0, previousPTS: Double?, worst = 0.0, invalid = false
func measure(_ pts: Double, _ image: [UInt8], _ reference: [UInt8]) {
    let coarse = stride(from: -height, through: height, by: 2).map { ($0, score(image, reference, $0, true)) }.sorted { $0.1 < $1.1 }
    var candidates: Set<Int> = []
    for item in coarse.prefix(5) { for dy in (item.0 - 3)...(item.0 + 3) { candidates.insert(dy) } }
    let ranked = candidates.map { ($0, score(image, reference, $0, false)) }.sorted { $0.1 < $1.1 }
    guard let best = ranked.first else { invalid = true; return }
    let alternative = (-6...6).filter { abs($0) >= 3 }.map { score(image, reference, best.0 + $0, false) }.min() ?? 1000
    let credible = best.1 <= 1.5 && alternative >= best.1 + 1
    if !credible { invalid = true }
    if credible { worst = max(worst, abs(Double(best.0) / scale)) }
    rows.append(["ptsMs": pts, "shiftPx": best.0, "mae": best.1, "alternativeAtLeast3pxMAE": alternative, "credible": credible])
}
while let sample = output.copyNextSampleBuffer() {
    let pts = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sample)) * 1000
    if !pts.isFinite || previousPTS.map({ pts <= $0 }) == true { invalid = true }
    previousPTS = pts; decoded += 1
    guard pts >= start - 0.01 && pts <= end + 0.01 || abs(pts - referencePTS) < 0.01 else { continue }
    guard let buffer = CMSampleBufferGetImageBuffer(sample) else { invalid = true; continue }
    let image = gray(buffer)
    if abs(pts - referencePTS) < 0.01 {
        reference = image
        for (time, before) in pending { measure(time, before, image) }; pending.removeAll()
    }
    if let reference { measure(pts, image, reference) }
    else { pending.append((pts, image)); if pending.count > 60 { invalid = true; break } }
}
if reader.status != .completed || reference == nil || !pending.isEmpty || rows.count < 180 { invalid = true }
let result: [String: Any] = ["verdict": worst > 1.1 ? "red" : invalid ? "invalid" : "within-coded-pixel-window", "worstPt": worst, "decodedFrames": decoded, "measuredFrames": rows.count,
                             "referencePTS": referencePTS, "readerCompleted": reader.status == .completed, "frames": rows,
                             "scope": "Actual coded pixels only; integer-pixel resolution, no interpolation, no unobserved compositor-frame claim"]
print(String(decoding: try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]), as: UTF8.self))
