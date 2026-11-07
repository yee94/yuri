import { it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.dirname(fileURLToPath(import.meta.url));
const temporaryRoot = process.env.TMPDIR || tmpdir();
function run(args: string[]) {
  const result = spawnSync('xcrun', args, { encoding: 'utf8', timeout: 120_000 });
  expect(result.error, result.error?.message).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  return result.stdout.trim();
}

it('executes production Foundation media admission without UIKit, NSH engine, network or credentials', () => {
  const temp = mkdtempSync(path.join(temporaryRoot, 'resource-media-'));
  try {
    const binary = path.join(temp, 'contract');
    run(['swiftc', '-swift-version', '5', path.join(root, 'ios/RuntimeHostScope.swift'), path.join(root, 'ios/ResourceBridge.swift'), path.join(root, 'tests/resource-media-contract.swift'), '-o', binary]);
    const result = spawnSync(binary, [], { encoding: 'utf8', timeout: 10_000 });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('Resource media Foundation contract passed');
  } finally { rmSync(temp, { recursive: true, force: true }); }
}, 150_000);

it('typechecks the complete UIKit/AVKit bridge against the real iOS SDK without an app or NSH engine', () => {
  const temp = mkdtempSync(path.join(temporaryRoot, 'resource-media-ios-contract-'));
  try {
    const sdk = run(['--sdk', 'iphonesimulator', '--show-sdk-path']);
    const stub = path.join(temp, 'NativeShell.swift');
    writeFileSync(stub, `@MainActor public final class NshAppView {
      public func handle(_ name: String, _ body: @escaping @MainActor (Any?) async throws -> Any?) {}
    }`);
    const flags = ['-swift-version', '5', '-sdk', sdk, '-target', 'arm64-apple-ios15.0-simulator'];
    run(['swiftc', ...flags, '-emit-module', '-module-name', 'NativeShell', stub, '-emit-module-path', path.join(temp, 'NativeShell.swiftmodule')]);
    const transport = path.join(temp, 'ResourceTransport.swift');
    const runtime = readFileSync(path.join(root, 'ios/RuntimeBridge.swift'), 'utf8');
    writeFileSync(transport, 'import Foundation\n' + runtime.slice(runtime.indexOf('struct SpeechResourceResponse'), runtime.indexOf('private actor ResourceBytesBuffer')));
    run(['swiftc', ...flags, '-I', temp, '-typecheck', path.join(root, 'ios/RuntimeHostScope.swift'), path.join(root, 'ios/ResourceBridge.swift'), transport]);
  } finally { rmSync(temp, { recursive: true, force: true }); }
}, 150_000);

it('guards native-only local media, bounded captured transport and lifecycle wiring at the source boundary', () => {
  const source = readFileSync(path.join(root, 'ios/ResourceBridge.swift'), 'utf8');
  expect(source).not.toMatch(/WKWebView\s*\(|URLSession\s*\(|URLSession\.shared|RelayTunnel\s*\(|AVPlayer\(url:/);
  expect(source).toContain('AVURLAssetReferenceRestrictionsKey: NSNumber(value: AVAssetReferenceRestrictions.forbidAll.rawValue)');
  expect(source).toContain('QLPreviewController.canPreview(url as NSURL)');
  expect(source).toContain('reads.count < 2');
  expect(source).toContain('ResourceReadRequest.admit(input, capture: capture)');
  expect(source).toContain('self.read(admitted.request, generation: scope, transport: transport)');
  expect(source).toContain('transport.read(route, limit)');
  expect(source).toContain('guard response.status == 200');
  expect(source).toContain('key == self?.presented');
  expect(source).toContain('UIApplication.willResignActiveNotification');
  expect(source).toContain('for task in reads.values { task.cancel() }');
  expect(source).toContain('player?.replaceCurrentItem(with: nil)');
  expect(source).toContain('AVPlayerItem.failedToPlayToEndTimeNotification');
  expect(source).toContain('NotificationCenter.default.removeObserver(playbackFailureObserver)');
  expect(source).toContain('pendingRelease.remove(key)');
  expect(source).toContain('player.allowsExternalPlayback = false');
  expect(source).toContain('playerController.allowsPictureInPicturePlayback = false');
});

it('typechecks the updated synthetic UIKit resource capture fixture without executing UIKit or NSH', () => {
  const temp = mkdtempSync(path.join(temporaryRoot, 'resource-fixture-sdk-'));
  try {
    const sdk = run(['--sdk', 'iphonesimulator', '--show-sdk-path']);
    const flags = ['-swift-version', '5', '-sdk', sdk, '-target', 'arm64-apple-ios15.0-simulator'];
    const stub = path.join(temp, 'NativeShell.swift');
    writeFileSync(stub, `import UIKit
@MainActor public final class NshAppView: UIView {
 public var onError: ((String) -> Void)?
 public var params: [String: Any] = [:]
 public static var preferredStatusBarStyle: UIStatusBarStyle { .default }
 public func handle(_ name: String, _ body: @escaping @MainActor (Any?) async throws -> Any?) {}
 public func send(_ name: String, _ data: Any? = nil) {}
 public func loadBundle(at url: URL) throws {}
}`);
    run(['swiftc', ...flags, '-emit-module', '-module-name', 'NativeShell', stub, '-emit-module-path', path.join(temp, 'NativeShell.swiftmodule')]);
    run(['swiftc', ...flags, '-I', temp, '-typecheck', path.join(root, 'ios/RuntimeHostScope.swift'), path.join(root, 'ios/ResourceBridge.swift'), path.join(root, 'tests/resource-media/uikit-main.swift')]);
  } finally { rmSync(temp, { recursive: true, force: true }); }
}, 150_000);
