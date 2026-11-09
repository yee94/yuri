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

it('typechecks every production iOS source against the real NativeShell SDK without engine, app or network execution', () => {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/check-resource-html-sdk.mjs')], { encoding: 'utf8', timeout: 180_000 });
  expect(result.error).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(JSON.parse(result.stdout.trim())).toMatchObject({ typechecked: true, changedAfterSnapshot: [] });
  const source = readFileSync(path.join(root, 'ios/ResourceWebPreviewView.swift'), 'utf8');
  expect(source).not.toMatch(/URLSession\s*\(|URLSession\.shared|RelayTunnel\s*\(/);
  expect(source).toContain('let head = try response.webResponse(for: url)');
  expect(source).toContain('task.didReceive(head); task.didReceive(response.data)');
}, 190_000);

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
