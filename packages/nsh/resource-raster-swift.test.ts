import { expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.dirname(fileURLToPath(import.meta.url));

it('runs production raster lifetime/budget state without UIKit, engine, network or credentials', () => {
  const temp = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'raster-image-state-'));
  try {
    const binary = path.join(temp, 'contract');
    const sources = ['ios/RuntimeHostScope.swift', 'ios/ResourceWebPreviewBridge.swift', 'ios/ResourceRasterImage.swift', 'tests/resource-raster-image-contract.swift']
      .map(file => path.join(root, file));
    const compiled = spawnSync('xcrun', ['swiftc', '-swift-version', '5', ...sources, '-o', binary], { encoding: 'utf8', timeout: 120_000 });
    expect(compiled.error).toBeUndefined();
    expect(compiled.status, compiled.stdout + compiled.stderr).toBe(0);
    const result = spawnSync(binary, [], { encoding: 'utf8', timeout: 10_000 });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('Raster image Foundation lifetime/budget contract passed');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}, 150_000);

it('decodes only the verified private lease and never lets a path or original bytes reach JS', () => {
  const bridge = readFileSync(path.join(root, 'ios/ResourceBridge.swift'), 'utf8');
  const raster = readFileSync(path.join(root, 'ios/ResourceRasterImage.swift'), 'utf8');
  const component = readFileSync(path.join(root, 'ios/ResourceRasterImageComponent.swift'), 'utf8');
  const tsx = readFileSync(path.join(root, 'resource-raster.tsx'), 'utf8');
  const install = readFileSync(path.join(root, 'ios/main.swift'), 'utf8');

  // The resolver only accepts an existing, current image lease for the exact Host.
  expect(bridge).toContain('func rasterAsset(_ key: String, expectedHost: RuntimeHostScope) throws');
  expect(bridge).toContain('try imageAsset(key, kind: "image", expectedHost: expectedHost)');
  expect(bridge).toContain('guard let lease = leases[key], lease.kind == kind, lease.expectedHost == expectedHost, lease.current()');
  expect(bridge).toContain('self.leaseObservers[key, default: [:]][ticket] = retire');
  expect(bridge).toContain('result["width"] = decoded.1.width');
  expect(bridge).toContain('result["height"] = decoded.1.height');

  // The UIKit surface is a contain-only UIImageView with a bounded ImageIO decode.
  const view = raster.slice(raster.indexOf('@MainActor final class ResourceRasterImageView'));
  expect(raster).toContain('final class ResourceRasterImageView: UIImageView');
  expect(view).toContain('contentMode = .scaleAspectFit');
  expect(view).toContain('asset.observeRetirement');
  expect(view).toContain('self.lifetime.retire(); self.expire()');
  expect(view).toContain('self.lifetime.accepts(ticket)');
  expect(view).toContain('presentation.loaded(ticket)');
  expect(view).toContain('guard self.current() else { self.expire(); return }');
  expect(raster).toContain('kCGImageSourceCreateThumbnailWithTransform: true');
  expect(raster).toContain('kCGImageSourceThumbnailMaxPixelSize: ResourceRasterImagePolicy.maximumPixel');
  expect(raster).toContain('static let maximumPixelSize = 4096');
  expect(raster).toContain('static let maximumPixelCount = 8_000_000');
  expect(raster).not.toMatch(/loadHTMLString|WKWebView|URLSession|base64|FileHandle|resourceTransport|RuntimeBridge/);

  // The component forwards config and presentation events only.
  expect(component).toContain('surface.register(component: "yuri.resource.rasterImage")');
  expect(component).toContain('if name == "config" { image.update(value) }');
  expect(component).toContain('if name == "retry" { image.retry() }');
  expect(component).toContain('emit("size", ["width": width, "height": height])');
  expect(component).toContain('emit("load", ["width": width, "height": height])');
  expect(component).toContain('emit("error", ["code": code])');
  expect(component).not.toMatch(/URL|base64|resourceTransport|RuntimeBridge/);

  // The public TSX prop surface carries only the opaque lease receipt.
  expect(tsx).toContain("'yuri.resource.rasterImage'");
  expect(tsx).toContain('config: { lease: string; expectedHost: RuntimeScope | null; active: boolean }');
  expect(tsx).toContain("events: ['size', 'load', 'error']");
  expect(tsx).not.toMatch(/base64|data:image|file:\/\//);

  expect(install).toContain('ResourceRasterImageFactory.install(on: surface, resolve: rasterResolve)');
  expect(install).toContain('let rasterResolve: ResourceRasterImageFactory.Resolve');
});
