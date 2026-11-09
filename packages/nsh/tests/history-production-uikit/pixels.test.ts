import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';

const root = path.dirname(fileURLToPath(import.meta.url));
let temporary: string, writer: string, measure: string;
beforeAll(() => {
  temporary = mkdtempSync(path.join(tmpdir(), 'history-production-pixel-calibration-')); writer = path.join(temporary, 'writer'); measure = path.join(temporary, 'measure');
  const source = path.join(temporary, 'Calibration.swift');
  writeFileSync(source, `import Foundation
import AVFoundation
import CoreVideo
let output = URL(fileURLWithPath: CommandLine.arguments[1]), shifted = CommandLine.arguments[2] == "shift"
let writer = try AVAssetWriter(outputURL: output, fileType: .mov)
let input = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: 320, AVVideoHeightKey: 480, AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 50000000, AVVideoAllowFrameReorderingKey: false]])
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA, kCVPixelBufferWidthKey as String: 320, kCVPixelBufferHeightKey as String: 480])
writer.add(input); guard writer.startWriting() else { fatalError("writer start") }; writer.startSession(atSourceTime: .zero)
for index in 0..<240 {
  while !input.isReadyForMoreMediaData { Thread.sleep(forTimeInterval: 0.001) }
  var optional: CVPixelBuffer?; CVPixelBufferCreate(kCFAllocatorDefault, 320, 480, kCVPixelFormatType_32BGRA, nil, &optional)
  let buffer = optional!; CVPixelBufferLockBaseAddress(buffer, [])
  let bytes = CVPixelBufferGetBaseAddress(buffer)!.assumingMemoryBound(to: UInt8.self), stride = CVPixelBufferGetBytesPerRow(buffer)
  for y in 0..<480 { for x in 0..<320 {
    let sourceY = y - (shifted && index == 100 ? 53 : 0)
    let code = ((sourceY / 7) &* 73856093) ^ ((x / 5) &* 19349663)
    let gray = UInt8(32 + abs(code % 192))
    let at = y * stride + x * 4; bytes[at] = gray; bytes[at+1] = gray; bytes[at+2] = gray; bytes[at+3] = 255
  } }
  CVPixelBufferUnlockBaseAddress(buffer, [])
  guard adaptor.append(buffer, withPresentationTime: CMTime(value: Int64(index), timescale: 60)) else { fatalError("append") }
}
input.markAsFinished(); let finished = DispatchSemaphore(value: 0); writer.finishWriting { finished.signal() }; finished.wait()
guard writer.status == .completed else { fatalError("finish") }
`);
  for (const [sourceFile, binary] of [[source, writer], [path.join(root, 'PixelMeasure.swift'), measure]]) {
    const compiled = spawnSync('xcrun', ['--sdk', 'macosx', 'swiftc', '-O', '-swift-version', '5', sourceFile, '-o', binary], { encoding: 'utf8', timeout: 110000 });
    expect(compiled.status, compiled.stderr).toBe(0);
  }
}, 120000);
afterAll(() => { if (temporary) rmSync(temporary, { recursive: true, force: true }); });
it('decodes actual calibration movies: stable frames can pass, a one-coded-frame 53pt shift goes red despite a stable final frame', () => {
  const plan = path.join(temporary, 'plan.json');
  writeFileSync(plan, JSON.stringify({ width: 320, height: 480, pixelsPerPoint: 1, referencePTS: 0, startPTS: 0, endPTS: 4000, rois: [{ x: 24, y: 100, width: 100, height: 32 }, { x: 120, y: 230, width: 100, height: 32 }, { x: 160, y: 340, width: 100, height: 32 }] }));
  for (const mode of ['stable', 'shift']) {
    const movie = path.join(temporary, mode + '.mov');
    const recorded = spawnSync(writer, [movie, mode], { encoding: 'utf8', timeout: 20000 }); expect(recorded.status, recorded.stderr).toBe(0);
    const measured = spawnSync(measure, [movie, plan], { encoding: 'utf8', timeout: 30000 }); expect(measured.status, measured.stderr).toBe(0);
    const result = JSON.parse(measured.stdout);
    expect(result).toMatchObject({ verdict: mode === 'stable' ? 'within-coded-pixel-window' : 'red', worstPt: mode === 'stable' ? 0 : 53, decodedFrames: 240, measuredFrames: 240, readerCompleted: true });
  }
}, 60000);
