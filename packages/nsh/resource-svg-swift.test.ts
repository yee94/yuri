import { expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.dirname(fileURLToPath(import.meta.url));
function run(args: string[]) {
  const result = spawnSync('xcrun', args, { encoding: 'utf8', timeout: 120_000 });
  expect(result.error).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0); return result.stdout.trim();
}
it('runs production SVG image lifetime/document state without UIKit, engine, network or credentials', () => {
  const temp = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'svg-image-state-'));
  try {
    const binary = path.join(temp, 'contract');
    run(['swiftc', '-swift-version', '5', path.join(root, 'ios/RuntimeHostScope.swift'), path.join(root, 'ios/ResourceWebPreviewBridge.swift'), path.join(root, 'tests/resource-svg-image/probe-request.swift'), path.join(root, 'tests/resource-svg-image-contract.swift'), '-o', binary]);
    const result = spawnSync(binary, [], { encoding: 'utf8', timeout: 10_000 });
    expect(result.status, result.stdout + result.stderr).toBe(0); expect(result.stdout).toContain('SVG image Foundation lifetime/document contract passed');
  } finally { rmSync(temp, { recursive: true, force: true }); }
}, 150_000);

it('typechecks the real iOS WK image/component/ResourceBridge and runnable WK fixture, without executing them', () => {
  const temp = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'svg-image-sdk-'));
  try {
    const sdk = run(['--sdk', 'iphonesimulator', '--show-sdk-path']), flags = ['-swift-version', '5', '-sdk', sdk, '-target', 'arm64-apple-ios15.0-simulator'];
    const stub = path.join(temp, 'NativeShell.swift');
    writeFileSync(stub, `import UIKit
@MainActor public protocol NshComponent: AnyObject { var view: UIView { get }; func setProp(_ name: String, _ value: Any?) }
extension NshComponent { public func setProp(_ name: String, _ value: Any?) {} }
@MainActor public struct NshComponentContext { public func emit(_ name: String, _ body: [String: Any]) {} }
@MainActor public final class NshAppView {
 public func handle(_ name: String, _ body: @escaping @MainActor (Any?) async throws -> Any?) {}
 public func register(component: String, factory: @escaping @MainActor (NshComponentContext) -> any NshComponent) {}
}`);
    run(['swiftc', ...flags, '-emit-module', '-module-name', 'NativeShell', stub, '-emit-module-path', path.join(temp, 'NativeShell.swiftmodule')]);
    run(['swiftc', ...flags, '-I', temp, '-typecheck', ...['ios/RuntimeHostScope.swift', 'ios/ResourceBridge.swift', 'ios/ResourceWebPreviewBridge.swift', 'ios/ResourceWebPreviewView.swift', 'ios/ResourceSVGImageComponent.swift', 'tests/resource-svg-image/probe-request.swift', 'tests/resource-svg-image/uikit-main.swift'].map(file => path.join(root, file))]);
    const dispatch = path.join(temp, 'BaseDispatch.swift');
    writeFileSync(dispatch, `import Foundation
import WebKit
@MainActor func loadThroughBase(_ web: WKWebView, _ request: URLRequest) -> WKNavigation? { web.load(request) }
`);
    const sil = run(['swiftc', ...flags, '-parse-as-library', '-emit-silgen', dispatch]);
    expect(sil).toMatch(/objc_method[^\n]*#WKWebView\.load/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
}, 150_000);

it('keeps SVG mode independent from HTML scripting and reads only opaque original leases', () => {
  const source = readFileSync(path.join(root, 'ios/ResourceWebPreviewBridge.swift'), 'utf8');
  const image = source.slice(source.indexOf('@MainActor final class ResourceSVGImageView'), source.indexOf('/// WKWebView owns only'));
  const guardedWeb = source.slice(source.indexOf('@MainActor final class ResourceSVGImageWebView'), source.indexOf('/// One narrow WK image mode'));
  expect(guardedWeb).toContain('override func load(_ request: URLRequest) -> WKNavigation?');
  expect(guardedWeb).toContain('nativeRequestBlocked?()');
  expect(guardedWeb).toContain('return nil');
  expect(guardedWeb).not.toMatch(/super\.load\(|override func loadHTMLString/);
  expect(image).toContain('let web = ResourceSVGImageWebView(frame: self.bounds, configuration: configuration)');
  expect(image).toContain('web.loadHTMLString(wrapper, baseURL: nil)');
  expect(image).toContain('self.event?(.nativeLoadBlocked); self.event?(.navigationBlocked)');
  expect(image).toContain('event?(.delegateNavigationBlocked); event?(.navigationBlocked)');
  expect(image).toContain('defaultWebpagePreferences.allowsContentJavaScript = false');
  expect(image).toContain('configuration.websiteDataStore = .nonPersistent()');
  expect(image).toContain('configuration.userContentController = WKUserContentController()');
  expect(image).not.toMatch(/evaluateJavaScript|addScriptMessageHandler|URLSession|readFile|readFileSync|contentWorld:\s*\.page/);
  expect([...image.matchAll(/\.callAsyncJavaScript\(/g)]).toHaveLength(1);
  expect(image).toContain('callAsyncJavaScript(ResourceSVGImageDecodeProbe.script, arguments: [:], in: nil,');
  expect(image).toContain('in: WKContentWorld.world(name: "yuri.resource.svgImage.decode")');
  expect(image).toContain('value as? Bool == true');
  expect(image).toContain('presentation.wrapperFinished(ticket)');
  expect(image).toContain('presentation.decoded(ticket, success: true)');
  expect(image).toContain('retryButton.addTarget(self, action: #selector(retry)');
  expect(image).toContain('accessibilityElements = failure ? [statusLabel, retryButton]');
  expect(image).toContain('resolve(request.lease, request.expectedHost)');
  const retry = image.slice(image.indexOf('@objc func retry()'), image.indexOf('private func reconcile()'));
  expect(retry).not.toMatch(/RuntimeBridge|RuntimeHostAuthority|resourceTransport|readFile|statRoute/);
  expect(retry).toContain('!lifetime.retired');
  expect([...image.matchAll(/event\?\(\.loaded\)/g)]).toHaveLength(1);
  const probe = source.slice(source.indexOf('enum ResourceSVGImageDecodeProbe'), source.indexOf('/// Native UIKit controls'));
  expect(probe).toContain('await image.decode()');
  expect(probe).toContain('image.naturalWidth > 0 && image.naturalHeight > 0');
  expect(probe).not.toMatch(/\\\(|getSVGDocument|contentDocument|outerHTML|innerHTML|fetch\(|XMLHttpRequest|\.src\s*=/);
  expect(source.slice(source.indexOf('@MainActor private final class ResourceWebPreviewSurface'))).not.toContain('allowsContentJavaScript = false');
  const bridge = readFileSync(path.join(root, 'ios/ResourceBridge.swift'), 'utf8');
  expect(bridge).not.toContain('ResourceSVGPolicy');
  expect(bridge).toContain('lease.expectedHost == expectedHost');
  expect(bridge).toContain('if kind == "svg" { preview = "svg-image" }');
  expect(bridge).toContain('if let contact = request.contact { try contact.verify');
  const install = readFileSync(path.join(root, 'ios/main.swift'), 'utf8');
  expect(install).toContain('ResourceSVGImageFactory.install(on: surface, resolve: svgResolve)');
  expect(install).toContain('resources.makeSVGPreview =');
  const fixture = readFileSync(path.join(root, 'tests/resource-svg-image/uikit-main.swift'), 'utf8');
  expect(fixture).toContain('x.getImageData'); expect(fixture).toContain('a[4] != b[4]'); expect(fixture).toContain('bridge.close(lease)');
  expect(fixture).toContain('nestedDataSVG');
  expect(fixture).toContain('invalidSVGShowsAccessibleFailure');
  expect(fixture).toContain('processTerminationCallbackShowsFailure');
  expect(fixture).toContain('expiredRetryRemainsExplicitFailure');
  expect(fixture).toContain('fullscreenConsumesSameAccessibleFailureAndRetry');
  expect(fixture).toContain('startProbe("svg-subresources")');
  expect(fixture).toContain('startProbe("native-navigation")');
  expect(fixture).toContain('connectionsBeforeNativeNavigation');
  expect(fixture).toContain('blocked > 0 && connections == 0');
  expect(fixture).toContain('connections += 1 // Every TCP accept counts');
  expect(fixture).toContain('let nativeBase: WKWebView = web');
  expect(fixture).toContain('nativeBase.load(URLRequest');
  expect(fixture).toContain('navigation == nil && nativeBlocked == 1 && delegateBlocked == 0');
  expect(fixture).toContain('nativeRequestRejectedBeforeWebKitThroughBaseType');
  expect(fixture).not.toMatch(/NshAppView\s*\(|RuntimeBridge\s*\(|ConnectionStore\s*\(|URLSession\s*\(|\.loadBundle\(/);
});
