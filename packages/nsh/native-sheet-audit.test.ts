import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = path.dirname(fileURLToPath(import.meta.url));
function run(args: string[]) {
  const result = spawnSync('xcrun', args, { encoding: 'utf8', timeout: 120000 });
  expect(result.status, result.stdout + result.stderr).toBe(0); return result.stdout.trim();
}

it('runs the exact Swift audit projection/ring: default OFF, closed schema, bounded bytes and content-free events', () => {
  const folder = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'sheet-audit-'));
  try {
    const source = readFileSync(path.join(root, 'ios/SheetPresentation.swift'), 'utf8');
    const core = source.slice(source.indexOf('final class NativeSheetLifecycleAudit'), source.indexOf('@MainActor enum NativeSheetPresentation'));
    const audit = path.join(folder, 'Audit.swift'), driver = path.join(folder, 'Driver.swift'), binary = path.join(folder, 'audit');
    writeFileSync(audit, 'import Foundation\nimport CoreFoundation\n' + core);
    writeFileSync(driver, `import Foundation
@main struct Driver {
 static func main() throws {
  let audit = NativeSheetLifecycleAudit()
  precondition(audit.ticket() == 0)
  audit.record("ready", ticket: 1, generation: 1, metadata: [:])
  precondition((audit.snapshot["sequence"] as! Int) == 0)
  audit.setEnabled(true)
  let ticket = audit.ticket()
  let metadata: [String: Any] = ["owner": 1, "ticket": 1, "intent": 1, "ownerGeneration": 1, "revision": 2, "open": true, "active": true, "current": true, "status": "complete"]
  precondition(NativeSheetLifecycleAudit.project(metadata) != nil)
  for extra in [["prompt": "PRIVATE_BODY"], ["status": "PRIVATE_BODY"], ["owner": true], ["revision": -1], ["active": 1]] as [[String: Any]] {
   var bad = metadata; bad.merge(extra) { _, next in next }
   precondition(NativeSheetLifecycleAudit.project(bad) == nil)
   audit.record("metadata", ticket: ticket, generation: 1, metadata: bad)
  }
  audit.record("PRIVATE_BODY", ticket: ticket, generation: 1, metadata: metadata)
  precondition((audit.snapshot["sequence"] as! Int) == 0)
  for _ in 0..<200 { audit.record("metadata", ticket: ticket, generation: 1, metadata: metadata, flags: ["window": true]) }
  let snapshot = audit.snapshot
  precondition((snapshot["events"] as! [[String: Any]]).count <= 32)
  precondition((snapshot["bytes"] as! Int) <= 8192)
  precondition((snapshot["dropped"] as! Int) > 0)
  print(String(decoding: try JSONSerialization.data(withJSONObject: snapshot), as: UTF8.self))
 }
}`);
    run(['--sdk', 'macosx', 'swiftc', '-swift-version', '5', '-parse-as-library', audit, driver, '-o', binary]);
    const result = spawnSync(binary, [], { encoding: 'utf8', timeout: 10000 });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain('PRIVATE_BODY'); expect(result.stdout).not.toContain('prompt');
    expect(JSON.parse(result.stdout)).toMatchObject({ enabled: true, sequence: 200 });
  } finally { rmSync(folder, { recursive: true, force: true }); }
}, 150000);

it('typechecks the real SheetPresentation and SyntheticHost using iOS SDK and declaration-only NSH boundary without running UIKit', () => {
  const folder = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'sheet-audit-sdk-'));
  try {
    const sdk = run(['--sdk', 'iphonesimulator', '--show-sdk-path']);
    const flags = ['-swift-version', '5', '-sdk', sdk, '-target', 'arm64-apple-ios15.0-simulator'];
    const stub = path.join(folder, 'NativeShell.swift');
    writeFileSync(stub, `import UIKit
@MainActor public protocol NshComponent: AnyObject { var view: UIView { get }; func setProp(_ name: String, _ value: Any?); func command(_ name: String, _ value: Any?) }
@MainActor public struct NshComponentContext { public func emit(_ name: String, _ body: [String: Any]) {} }
@MainActor public final class NshAppView { public func register(component: String, factory: @escaping @MainActor (NshComponentContext) -> any NshComponent) {} }
`);
    run(['swiftc', ...flags, '-emit-module', '-module-name', 'NativeShell', stub, '-emit-module-path', path.join(folder, 'NativeShell.swiftmodule')]);
    run(['swiftc', ...flags, '-I', folder, '-typecheck', path.join(root, 'ios/SheetPresentation.swift'), path.join(root, 'tests/history-production-uikit/SyntheticHost.swift')]);
  } finally { rmSync(folder, { recursive: true, force: true }); }
}, 150000);

it('enables the native audit only in the explicit UI fixture branch and retains fresh artifact/process identity on export', () => {
  const source = readFileSync(path.join(root, 'tests/history-production-uikit/main.swift'), 'utf8');
  const branch = source.slice(source.indexOf('if host.observerDisabled {'), source.indexOf('observer = try HistoryProductionObserver'));
  expect(branch).toContain('NativeSheetLifecycleAudit.shared.setEnabled(true)');
  expect(branch).toContain('host.sheetLifecycleAudit = { NativeSheetLifecycleAudit.shared.snapshot }');
  expect(source).toContain('audit["processNonce"] = uiParityProcessNonce');
  expect(source).toContain('audit["artifact"] = ["bundleID":');
  expect(source).toContain('auditTrigger');
});
