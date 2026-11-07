import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { notificationRecoveryRecord } from './notification-global-recovery';

const root = path.dirname(fileURLToPath(import.meta.url));
function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 120_000 });
  expect(result.error, result.error?.message).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
  return result.stdout.trim();
}
it('executes durable cold-launch ingress, replay/atomic failure and APNs fences with Foundation only', () => {
  const temp = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'notification-launch-'));
  try {
    const binary = path.join(temp, 'launch');
    run('xcrun', ['swiftc', '-swift-version', '5', path.join(root, 'ios/NotificationBridge.swift'), path.join(root, 'ios/NotificationLaunchAPNS.swift'), path.join(root, 'tests/notification-launch/main.swift'), '-parse-as-library', '-o', binary]);
    expect(run(binary, [temp])).toContain('no OS or network calls');
    const persisted = JSON.parse(readFileSync(path.join(temp, 'receipts.json'), 'utf8')) as { records: unknown[] };
    expect(persisted.records.length).toBeGreaterThan(0);
    for (const record of persisted.records) expect(notificationRecoveryRecord(record)).not.toBeNull();
  } finally { rmSync(temp, { recursive: true, force: true }); }
}, 150_000);
it('typechecks the notification OS delegate against the Apple SDK without executing UIKit, main or the engine', () => {
  const temp = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'notification-launch-sdk-'));
  try {
    const sdk = run('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path']);
    const flags = ['-swift-version', '5', '-sdk', sdk, '-target', 'arm64-apple-ios15.0-simulator'];
    const stub = path.join(temp, 'NativeShell.swift');
    writeFileSync(stub, `import UIKit
@MainActor public final class NshAppView: UIView {
  public func handle(_ name: String, _ body: @escaping @MainActor (Any?) async throws -> Any?) {}
  public func send(_ name: String, _ data: Any?) {}
}`);
    run('xcrun', ['swiftc', ...flags, '-emit-module', '-module-name', 'NativeShell', stub, '-emit-module-path', path.join(temp, 'NativeShell.swiftmodule')]);
    run('xcrun', ['swiftc', ...flags, '-I', temp, '-typecheck', path.join(root, 'ios/NotificationBridge.swift'), path.join(root, 'ios/NotificationLaunchAPNS.swift')]);
  } finally { rmSync(temp, { recursive: true, force: true }); }
}, 150_000);
