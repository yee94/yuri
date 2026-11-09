import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { accessSync, constants, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
function nativeShellDistribution() {
  if (process.env.NSH_DIST) return path.resolve(process.env.NSH_DIST);
  const binary = process.env.NSH_BIN || 'nsh';
  const candidates = binary.includes('/') ? [path.resolve(binary)] : (process.env.PATH || '').split(path.delimiter).map(directory => path.join(directory, binary));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return path.resolve(path.dirname(realpathSync(candidate)), '..');
    } catch { /* Try the next PATH entry, as build-ios.mjs does. */ }
  }
  throw new Error('Cannot find NativeShell distribution; set NSH_DIST or NSH_BIN');
}
function run(args: string[]) {
  const result = spawnSync('xcrun', args, { encoding: 'utf8', timeout: 120_000 });
  expect(result.error, result.error?.message).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
  return result.stdout.trim();
}
it('runs the production Foundation allowlist, permission, foreground and payload policy without UserNotifications', () => {
  const temp = mkdtempSync(path.join(tmpdir(), 'notification-policy-'));
  try {
    const binary = path.join(temp, 'policy');
    run(['swiftc', '-swift-version', '5', path.join(root, 'ios/NotificationBridge.swift'), path.join(root, 'tests/notification-policy/main.swift'), '-o', binary]);
    const result = spawnSync(binary, [], { encoding: 'utf8', timeout: 10_000 });
    expect(result.status, result.stdout + result.stderr).toBe(0); expect(result.stdout).toContain('Notification Foundation policy passed');
  } finally { rmSync(temp, { force: true, recursive: true }); }
}, 150_000);

it('typechecks the whole iOS bridge and isolated fixture with the real Apple SDK, never executing them', () => {
  const temp = mkdtempSync(path.join(tmpdir(), 'notification-sdk-'));
  try {
    const sdk = run(['--sdk', 'iphonesimulator', '--show-sdk-path']);
    const flags = ['-swift-version', '5', '-sdk', sdk, '-target', 'arm64-apple-ios15.0-simulator'];
    const stub = path.join(temp, 'NativeShell.swift');
    writeFileSync(stub, `import UIKit
    @MainActor public final class NshHostReply {
      public func resolve(_ value: Any?) {}
      public func reject(_ value: String) {}
    }
    @MainActor public final class NshAppView: UIView {
      public var onError: ((String) -> Void)?
      public func handle(_ name: String, _ body: @escaping @MainActor (Any?) async throws -> Any?) {}
      public func handle(_ name: String, _ body: @escaping @MainActor (Any?, NshHostReply) -> Void) {}
      public func send(_ name: String, _ data: Any?) {}
      public func loadBundle(at url: URL) throws {}
      public static var preferredStatusBarStyle: UIStatusBarStyle { .default }
      public static var prefersStatusBarHidden: Bool { false }
      public static var preferredStatusBarUpdateAnimation: UIStatusBarAnimation { .none }
    }`);
    run(['swiftc', ...flags, '-emit-module', '-module-name', 'NativeShell', stub, '-emit-module-path', path.join(temp, 'NativeShell.swiftmodule')]);
    run(['swiftc', ...flags, '-I', temp, '-typecheck', path.join(root, 'ios/NotificationBridge.swift'), path.join(root, 'tests/notification-uikit/main.swift')]);
    const framework = path.join(nativeShellDistribution(), 'embed/ios/NativeShell.xcframework/ios-arm64-simulator');
    // Match build-ios.mjs source ownership, including component extensions used by main.swift.
    const sources = readdirSync(path.join(root, 'ios')).filter(name => name.endsWith('.swift')).sort().map(name => path.join(root, 'ios', name));
    sources.push(path.join(root, '../mobile/ios/App/App/YuriViewExportRenderer.swift'));
    run(['swiftc', ...flags, '-F', framework, '-typecheck', ...sources]);
    const source = readFileSync(path.join(root, 'ios/NotificationBridge.swift'), 'utf8');
    expect(source).not.toMatch(/URLSession|ConnectionStore|registerForRemoteNotifications|setMinimumBackgroundFetchInterval/);
    expect(source).toContain('content.userInfo = ["v": 1, "receipt": receipt]');
    expect(source).toContain('entry.revision == revision && entry.scope.isCurrent()');
    expect(source).toContain('center.removePendingNotificationRequests(withIdentifiers: identifiers)');
    expect(source).toContain('center.removeDeliveredNotifications(withIdentifiers: identifiers)');
  } finally { rmSync(temp, { force: true, recursive: true }); }
}, 150_000);
