#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, cp, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('node packages/nsh/scripts/build-resource-media-uikit.mjs [--bundle-only]\nNSH_BIN: compiler executable; NSH_DIST: distribution root (optional). Unique arm64 simulator app, production ResourceBridge + ResourcePreview, synthetic local media only. Compiles bytecode/Swift; never starts an NSH engine, installs, launches or accesses a Host/Keychain/network.');
  process.exit(0);
}
if (args.some(arg => arg !== '--bundle-only')) throw new Error('Only --bundle-only is supported');
const buildID = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
const bundleID = 'example.yuri.resource-media-uikit';
const name = 'ResourceMediaUIKitFixture';
const output = path.join(root, '.nsh/resource-media-uikit', buildID);
const project = path.join(output, 'project'), bundle = path.join(output, 'bundle');
await mkdir(project, { recursive: true });
function run(command, argv, capture = false) {
  const result = spawnSync(command, argv, { cwd: project, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', timeout: 240_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} failed (${result.status})${capture ? `: ${result.stderr}` : ''}`);
  return result.stdout?.trim();
}
async function executable(value) {
  const candidates = value.includes('/') ? [path.resolve(value)] : (process.env.PATH ?? '').split(path.delimiter).map(dir => path.join(dir, value));
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return await realpath(candidate); } catch { /* Try the next executable. */ }
  }
  throw new Error('Cannot find NSH compiler; set NSH_BIN');
}
const nsh = await executable(process.env.NSH_BIN || 'nsh');
const capabilities = ['resources.read', 'resources.present', 'resources.cancel', 'resources.close', 'resources.release', 'fixture.media.control'];
await writeFile(path.join(project, 'nsh.json'), JSON.stringify({
  name, id: bundleID, version: '0.1.0', build: 1, appearance: 'system',
  theme: path.relative(project, path.join(root, 'theme.json')), capabilities: { clipboard: true, host: capabilities },
}));
await writeFile(path.join(project, 'App.tsx'), `import ${JSON.stringify(path.relative(project, path.join(root, 'tests/resource-media/fixture.tsx')))};\n`);
run(nsh, ['build', path.join(project, 'App.tsx'), '--release', '--out', bundle]);
await access(path.join(bundle, 'bundle.nshc'));
if (args.includes('--bundle-only')) {
  console.log(JSON.stringify({ bundleID, bundle: path.relative(root, bundle), engineStarted: false, installed: false, launched: false }, null, 2));
  process.exit(0);
}
const dist = process.env.NSH_DIST ? path.resolve(process.env.NSH_DIST) : path.resolve(path.dirname(nsh), '..');
const framework = path.join(dist, 'embed/ios/NativeShell.xcframework/ios-arm64-simulator');
await access(path.join(framework, 'NativeShell.framework/NativeShell'));
const sdk = run('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path'], true);
if (Number(run('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-version'], true).split('.')[0]) < 26) throw new Error('iOS 26+ SDK required');
const staging = path.join(output, `${name}.staging.app`), app = path.join(output, `${name}.app`);
await mkdir(staging); await cp(bundle, path.join(staging, 'nsh'), { recursive: true });
const media = path.join(staging, 'media'); await mkdir(media);
// Eight seconds of actual PCM16 silence. No microphone, service, user audio or dependency.
const samples = 16_000 * 8, wav = Buffer.alloc(44 + samples * 2);
wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(16_000, 24); wav.writeUInt32LE(32_000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
await writeFile(path.join(media, 'silent.wav'), wav);
// System AVAssetWriter creates a small moving neutral test frame. The executable
// runs only on macOS at build time; no app/NSH engine or simulator is launched.
const generator = path.join(output, 'GenerateMedia.swift');
await writeFile(generator, `import Foundation
import AVFoundation
import CoreGraphics
import CoreVideo
@main struct GenerateMedia {
  static func main() async throws {
    let url = URL(fileURLWithPath: CommandLine.arguments[1])
    let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
    let input = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: 320, AVVideoHeightKey: 180,
      AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 120_000]])
    input.expectsMediaDataInRealTime = false
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32ARGB,
      kCVPixelBufferWidthKey as String: 320, kCVPixelBufferHeightKey as String: 180, kCVPixelBufferCGImageCompatibilityKey as String: true, kCVPixelBufferCGBitmapContextCompatibilityKey as String: true])
    guard writer.canAdd(input) else { throw NSError(domain: "MediaGenerator", code: 1) }
    writer.add(input)
    guard writer.startWriting() else { throw writer.error ?? NSError(domain: "MediaGenerator", code: 2) }
    writer.startSession(atSourceTime: .zero)
    for frame in 0..<96 {
      let deadline = Date().addingTimeInterval(10)
      while !input.isReadyForMoreMediaData {
        guard writer.status == .writing, Date() < deadline else { throw writer.error ?? NSError(domain: "MediaGenerator", code: 3) }
        try await Task.sleep(nanoseconds: 5_000_000)
      }
      try autoreleasepool {
        var value: CVPixelBuffer?
        guard CVPixelBufferCreate(kCFAllocatorDefault, 320, 180, kCVPixelFormatType_32ARGB,
          [kCVPixelBufferCGImageCompatibilityKey: true, kCVPixelBufferCGBitmapContextCompatibilityKey: true] as CFDictionary, &value) == kCVReturnSuccess, let pixel = value else { throw NSError(domain: "MediaGenerator", code: 4) }
        CVPixelBufferLockBaseAddress(pixel, [])
        defer { CVPixelBufferUnlockBaseAddress(pixel, []) }
        guard let context = CGContext(data: CVPixelBufferGetBaseAddress(pixel), width: 320, height: 180, bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(pixel),
          space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue) else { throw NSError(domain: "MediaGenerator", code: 5) }
        context.setFillColor(gray: 0.35, alpha: 1); context.fill(CGRect(x: 0, y: 0, width: 320, height: 180))
        context.setFillColor(gray: 0.7, alpha: 1); context.fill(CGRect(x: (frame * 3) % 280, y: 60, width: 40, height: 60))
        context.setFillColor(gray: 0.9, alpha: 1); context.fill(CGRect(x: 0, y: 12, width: Double(frame + 1) / 96 * 320, height: 8))
        guard adaptor.append(pixel, withPresentationTime: CMTime(value: Int64(frame), timescale: 12)) else { throw writer.error ?? NSError(domain: "MediaGenerator", code: 6) }
      }
    }
    writer.endSession(atSourceTime: CMTime(value: 8, timescale: 1)); input.markAsFinished()
    await writer.finishWriting()
    guard writer.status == .completed else { throw writer.error ?? NSError(domain: "MediaGenerator", code: 7) }
    let asset = AVURLAsset(url: url, options: [AVURLAssetReferenceRestrictionsKey: NSNumber(value: AVAssetReferenceRestrictions.forbidAll.rawValue)])
    guard try await asset.load(.isPlayable) else { throw NSError(domain: "MediaGenerator", code: 8) }
    print("Generated 320x180 H.264 MP4, 8 seconds, 12 fps, no audio track")
  }
}
`);
const generatorBinary = path.join(output, 'generate-media');
run('xcrun', ['--sdk', 'macosx', 'swiftc', '-swift-version', '5', '-parse-as-library', generator, '-o', generatorBinary]);
run(generatorBinary, [path.join(media, 'neutral.mp4')]);
const assets = {};
for (const file of ['silent.wav', 'neutral.mp4']) {
  const bytes = await readFile(path.join(media, file));
  if (!bytes.length || bytes.length > 1_000_000) throw new Error('Generated fixture media must be nonempty and <=1 MB');
  assets[file] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}
const frameworks = ['UIKit', 'Foundation', 'Security', 'AVFoundation', 'AVKit', 'QuickLook', 'Speech', 'CoreMedia', 'CoreVideo', 'CoreGraphics', 'CoreText', 'QuartzCore', 'ImageIO', 'Photos', 'PhotosUI', 'UniformTypeIdentifiers', 'WebKit', 'SafariServices', 'Network', 'SystemConfiguration', 'AudioToolbox'];
const swiftSources = ['ios/RuntimeHostScope.swift', 'ios/ResourceBridge.swift', 'tests/resource-media/uikit-main.swift'];
run('xcrun', ['--sdk', 'iphonesimulator', 'swiftc', '-swift-version', '5', '-parse-as-library', '-O', '-sdk', sdk, '-target', 'arm64-apple-ios15.0-simulator', '-F', framework,
  '-framework', 'NativeShell', ...frameworks.flatMap(value => ['-framework', value]), '-lc++', '-lz', '-lsqlite3', '-Xlinker', '-ObjC',
  ...swiftSources.map(value => path.join(root, value)), '-o', path.join(staging, name)]);
await writeFile(path.join(staging, 'Info.plist'), JSON.stringify({
  CFBundleDevelopmentRegion: 'en', CFBundleDisplayName: 'Resource Media QA', CFBundleExecutable: name,
  CFBundleIdentifier: bundleID, CFBundleInfoDictionaryVersion: '6.0', CFBundleName: name,
  CFBundlePackageType: 'APPL', CFBundleShortVersionString: '0.1.0', CFBundleVersion: '1',
  CFBundleSupportedPlatforms: ['iPhoneSimulator'], MinimumOSVersion: '15.0', LSRequiresIPhoneOS: true, UIDeviceFamily: [1, 2],
  UILaunchScreen: {}, UISupportedInterfaceOrientations: ['UIInterfaceOrientationPortrait', 'UIInterfaceOrientationLandscapeLeft', 'UIInterfaceOrientationLandscapeRight'],
}));
run('plutil', ['-convert', 'xml1', path.join(staging, 'Info.plist')]);
run('codesign', ['--force', '--sign', '-', '--timestamp=none', staging]);
await rename(staging, app);
const manifest = { bundleID, app: path.relative(root, app), bundle: path.relative(root, bundle), entry: 'tests/resource-media/fixture.tsx',
  swiftSources, sourceSHA256: Object.fromEntries(await Promise.all([...swiftSources, 'resources.tsx', 'resources-model.ts', 'tests/resource-media/fixture.tsx'].map(async source => [source, createHash('sha256').update(await readFile(path.join(root, source))).digest('hex')]))),
  capabilities, assets, syntheticOnly: true, engineStarted: false, installed: false, launched: false, network: false, keychain: false };
await writeFile(path.join(output, 'fixture-build.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest, null, 2));
