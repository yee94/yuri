import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
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
    const dependencies = path.join(temp, 'MainDependencies.swift');
    writeFileSync(dependencies, `import UIKit
import NativeShell
struct SavedConnection { let id: String; let authorizationID: String? }
final class ConnectionStore { var selected: SavedConnection?; init() throws {} }
enum NativeFailure: Error { case message(String) }
@MainActor struct ResourceTransport { let isCurrent: () -> Bool }
@MainActor final class RuntimeBridge {
  let store: ConnectionStore; var onInvalidate: (() -> Void)?
  var onAuthorizationRetired: ((String, String) async throws -> Void)?
  init(app: NshAppView, store: ConnectionStore) { self.store = store }
  func resourceTransport(expectedHost: RuntimeHostScope? = nil) throws -> ResourceTransport { ResourceTransport(isCurrent: { true }) }
  func resourceWebPreviewTransport(expectedHost: RuntimeHostScope? = nil) throws -> ResourceTransport { try resourceTransport(expectedHost: expectedHost) }
  func remoteDesktopTransport() throws -> ResourceTransport { try resourceTransport() }
  func setForeground(_ active: Bool) {}
  func voiceRecognitionTransport(expectedHost: RuntimeHostScope) throws -> ResourceTransport { try resourceTransport() }
  func terminalTransport(expectedHost: RuntimeHostScope) throws -> ResourceTransport { try resourceTransport(expectedHost: expectedHost) }
  func retryAuthorizationRetirements() async {}
  func stop() { onInvalidate?() }
}
@MainActor final class AppearanceBridge { init(app: NshAppView, selectedHost: @escaping () -> String?) {} func invalidate() throws {} }
@MainActor struct ScheduleDateScope { let hostID: String; let isCurrent: () -> Bool }
@MainActor final class ScheduleDateBridge { init(app: NshAppView, capture: @escaping () throws -> ScheduleDateScope) {} }
@MainActor final class ResourceBridge { init(controller: UIViewController, capture: @escaping (RuntimeHostScope) throws -> ResourceTransport) throws {} func install(on app: NshAppView) {} func invalidate() {} }
@MainActor final class ResourceWebPreviewBridge { init(controller: UIViewController, capture: @escaping (RuntimeHostScope) throws -> ResourceTransport) {} func install(on app: NshAppView) {} func invalidate() {} }
@MainActor final class SpeechPlaybackBridge { init(app: NshAppView, capture: @escaping () throws -> ResourceTransport) {} func invalidate() {} }
struct RuntimeHostScope {}
@MainActor final class VoiceRecognitionBridge { init(app: NshAppView, capture: @escaping (RuntimeHostScope) throws -> ResourceTransport, beforeCapture: @escaping () -> Void) {} func invalidate() {} }
@MainActor final class RemoteDesktopBridge { init(app: NshAppView, capture: @escaping () throws -> ResourceTransport) {} func invalidate() {} }
@MainActor final class TerminalBridge { init(capture: @escaping (RuntimeHostScope) throws -> ResourceTransport, emit: @escaping ([String: Any]) -> Void) {} func register(app: NshAppView) {} func setForeground(_ active: Bool) {} func invalidate() {} }
@MainActor final class NativeTerminalPreview { init(presenter: UIViewController, bridge: TerminalBridge, emit: @escaping ([String: Any]) -> Void) {} func register(app: NshAppView) {} func invalidate() {} }
@MainActor final class AttachmentBridge { init(controller: UIViewController, runtime: RuntimeBridge) {} func pick(_ input: Any?) async throws -> Any? { nil } }
@MainActor enum NavigationBridge { static func install(on app: NshAppView) {} }
@MainActor enum NewSessionPickerOwners { static func install(on app: NshAppView) {} }
@MainActor enum NativeSheetPresentation { static func install(on app: NshAppView) {} }
@MainActor enum NativeDatePicker { static func install(on app: NshAppView) {} }
@MainActor enum NativeChatHeaderCollapse { static func install(on app: NshAppView) {} }
@MainActor final class QRScanner: UIViewController { var complete: ((String?) -> Void)? }
`.replaceAll('} func', '}; func'));
    run(['swiftc', ...flags, '-I', temp, '-typecheck', path.join(root, 'ios/NotificationBridge.swift'), path.join(root, 'ios/DiagnosticsBridge.swift'), dependencies, path.join(root, 'ios/main.swift')]);
    const source = readFileSync(path.join(root, 'ios/NotificationBridge.swift'), 'utf8');
    expect(source).not.toMatch(/URLSession|ConnectionStore|registerForRemoteNotifications|setMinimumBackgroundFetchInterval/);
    expect(source).toContain('content.userInfo = ["v": 1, "receipt": receipt]');
    expect(source).toContain('entry.revision == revision && entry.scope.isCurrent()');
    expect(source).toContain('center.removePendingNotificationRequests(withIdentifiers: identifiers)');
    expect(source).toContain('center.removeDeliveredNotifications(withIdentifiers: identifiers)');
  } finally { rmSync(temp, { force: true, recursive: true }); }
}, 150_000);
