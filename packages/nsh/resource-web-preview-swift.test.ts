import { it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.dirname(fileURLToPath(import.meta.url));
function run(args: string[]) {
  const result = spawnSync('xcrun', args, { encoding: 'utf8', timeout: 120_000 });
  expect(result.error, result.error?.message).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  return result.stdout.trim();
}

it('compiles the exact production network-block rules with real WebKit before any document or subresource delivery', () => {
  const temp = mkdtempSync(path.join(tmpdir(), 'resource-web-preview-rules-'));
  try {
    const source = readFileSync(path.join(root, 'ios/ResourceWebPreviewBridge.swift'), 'utf8');
    const rules = /(?:encodedContentRuleList:|static let networkRules =)\s*"""\s*([\s\S]*?)\s*"""/.exec(source)?.[1];
    expect(rules).toBeDefined();
    expect(source).toContain('encodedContentRuleList: ResourceWebPreviewScope.networkRules');
    const filters = JSON.parse(rules!).map((rule: { trigger: { 'url-filter': string }; action: { type: string } }) => {
      expect(rule.action.type).toBe('block');
      return new RegExp(rule.trigger['url-filter'], 'i');
    });
    for (const url of ['http://outside.invalid', 'https://outside.invalid', 'ws://outside.invalid', 'wss://outside.invalid', 'ftp://outside.invalid', 'file:///private']) expect(filters.some((filter: RegExp) => filter.test(url))).toBe(true);
    expect(filters.some((filter: RegExp) => filter.test('yuri-resource://fixture/index.html'))).toBe(false);
    writeFileSync(path.join(temp, 'rules.json'), rules!);
    const probe = path.join(temp, 'RuleCompile.swift');
    writeFileSync(probe, `import Foundation
import WebKit
@main struct RuleCompile {
  @MainActor static func main() async {
    do {
      let rules = try String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8)
      guard let store = WKContentRuleListStore(url: URL(fileURLWithPath: CommandLine.arguments[2])) else { exit(2) }
      guard try await store.compileContentRuleList(forIdentifier: "fixture-rules", encodedContentRuleList: rules) != nil else { exit(3) }
      print("rules compiled before entry delivery")
    } catch { let value = error as NSError; print("rules.compile \\(value.domain) \\(value.code)"); exit(1) }
  }
}`);
    const binary = path.join(temp, 'rule-compile');
    run(['swiftc', '-swift-version', '5', '-parse-as-library', '-framework', 'WebKit', probe, '-o', binary]);
    const result = spawnSync(binary, [path.join(temp, 'rules.json'), temp], { encoding: 'utf8', timeout: 20_000 });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('rules compiled before entry delivery');
  } finally { rmSync(temp, { recursive: true, force: true }); }
}, 150_000);

it('compiles and runs production Foundation scope without UIKit, NSH engine, network or credentials', () => {
  const temp = mkdtempSync(path.join(tmpdir(), 'resource-web-preview-'));
  try {
    const binary = path.join(temp, 'contract');
    run(['swiftc', '-swift-version', '5', path.join(root, 'ios/RuntimeHostScope.swift'), path.join(root, 'ios/ResourceWebPreviewBridge.swift'), path.join(root, 'tests/resource-web-preview-contract.swift'), '-o', binary]);
    const result = spawnSync(binary, [], { encoding: 'utf8', timeout: 10_000 });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('Foundation contract passed');
  } finally { rmSync(temp, { recursive: true, force: true }); }
}, 150_000);

it('typechecks the full iOS WKWebView bridge using a minimal NativeShell contract, without an app build', () => {
  const temp = mkdtempSync(path.join(tmpdir(), 'resource-web-preview-ios-contract-'));
  try {
    const sdk = run(['--sdk', 'iphonesimulator', '--show-sdk-path']);
    const stub = path.join(temp, 'NativeShell.swift');
    writeFileSync(stub, `@MainActor public final class NshAppView {
      public func handle(_ name: String, _ body: @escaping @MainActor (Any?) async throws -> Any?) {}
      public func send(_ name: String, _ data: Any?) {}
    }`);
    const flags = ['-swift-version', '5', '-sdk', sdk, '-target', 'arm64-apple-ios26.0-simulator'];
    run(['swiftc', ...flags, '-emit-module', '-module-name', 'NativeShell', stub, '-emit-module-path', path.join(temp, 'NativeShell.swiftmodule')]);
    run(['swiftc', ...flags, '-I', temp, '-typecheck', path.join(root, 'ios/RuntimeHostScope.swift'), path.join(root, 'ios/ResourceWebPreviewBridge.swift')]);
    const desktop = readFileSync(path.join(root, 'ios/RemoteDesktopBridge.swift'), 'utf8');
    const desktopContract = path.join(temp, 'DesktopContract.swift');
    writeFileSync(desktopContract, 'import Foundation\n' + desktop.slice(desktop.indexOf('enum RemoteDesktopWireMessage'), desktop.indexOf('/// A deadline')));
    run(['swiftc', ...flags, '-I', temp, '-typecheck', path.join(root, 'ios/ResourceWebPreviewBridge.swift'), path.join(root, 'ios/GuiPluginPreviewBridge.swift'), path.join(root, 'ios/GuiPluginRuntime.swift'), path.join(root, 'ios/RuntimeHostScope.swift'), path.join(root, 'ios/VoiceRecognitionCore.swift'), path.join(root, 'ios/VoiceRecognitionRuntime.swift'), path.join(root, 'ios/RuntimeBridge.swift'), path.join(root, 'ios/TerminalBridge.swift'), path.join(root, 'ios/TerminalTransport.swift'), path.join(root, 'ios/ConnectionStore.swift'), path.join(root, 'ios/connection-editor.swift'), path.join(root, 'ios/RelayTunnel.swift'), desktopContract]);
    run(['swiftc', ...flags, '-I', temp, '-typecheck', path.join(root, 'ios/RuntimeHostScope.swift'), path.join(root, 'ios/ResourceWebPreviewBridge.swift'), path.join(root, 'tests/resource-web-preview/uikit-main.swift')]);
    const source = readFileSync(path.join(root, 'ios/ResourceWebPreviewBridge.swift'), 'utf8');
    expect(source).not.toMatch(/URLSession\s*\(|URLSession\.shared|RelayTunnel\s*\(/);
    expect(source).toContain('let head = try response.webResponse(for: url)');
    expect(source).toContain('urlSchemeTask.didReceive(head); urlSchemeTask.didReceive(response.data)');
  } finally { rmSync(temp, { recursive: true, force: true }); }
}, 150_000);

it('keeps the UIKit fixture isolated from production products, NSH execution and native page bridges', () => {
  const fixture = readFileSync(path.join(root, 'tests/resource-web-preview/uikit-main.swift'), 'utf8');
  const build = readFileSync(path.join(root, 'scripts/build-resource-web-preview-uikit.mjs'), 'utf8');
  expect(fixture).not.toMatch(/URLSession\s*\(|ConnectionStore\s*\(|RelayTunnel\s*\(|NshAppView\s*\(|\.install\(on:|\.loadBundle\(|evaluateJavaScript\(|addScriptMessageHandler/);
  expect(fixture).toContain('bridge.present(args)');
  expect(fixture).toContain('bridge?.invalidate()');
  expect(fixture).toContain('image.src=\'https://outside.invalid/never-load.png\'');
  expect(build).toContain("'.nsh/resource-web-preview-uikit'");
  expect(build).toContain('randomUUID()');
  expect(build).toContain("'example.yuri.resource-web-preview-uikit'");
  expect(build).not.toMatch(/simctl|\.nsh\/out|\.nsh\/bundle|\brm\(|run\(nsh/);
});

it('declares the UTF-8 encoding of synthetic HTML, CSS and JavaScript without adding a document meta override', () => {
  const fixture = readFileSync(path.join(root, 'tests/resource-web-preview/uikit-main.swift'), 'utf8');
  for (const type of ['text/html', 'text/css', 'text/javascript']) expect(fixture.includes(`mime: "${type}; charset=utf-8"`), `${type} synthetic UTF-8 declaration`).toBe(true);
  expect(fixture).toContain('mime: "image/png"');
  expect(fixture).not.toContain('<meta charset=');
});
