import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const read = (name: string) => readFileSync(path.join(root, name), 'utf8');
describe('isolated resource page fixture ownership', () => {
  it.skipIf(process.platform !== 'darwin')('runs actual synthetic transport and production Foundation parsers with strict scope/read/write contracts', () => {
    const output = mkdtempSync(path.join(process.env.OPENCODE_TMP_DIR || tmpdir(), 'resource-page-wire-'));
    const packageRoot = path.resolve(root, '../..');
    const inputs = ['ios/RuntimeHostScope.swift', 'ios/ResourceWebPreviewBridge.swift', 'ios/GuiPluginPreviewBridge.swift', 'ios/GuiPluginDeviceBridge.swift', 'ios/GuiPluginResourceResolver.swift', 'tests/resource-page-uikit/SyntheticHost.swift', 'tests/resource-page-uikit/wire-contract.swift'];
    // Freeze this contract run too; never compile mutable production files in place.
    const frozen = inputs.map(file => {
      const target = path.join(output, file); mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(path.join(packageRoot, file))); return target;
    });
    const binary = path.join(output, 'contract');
    const compile = spawnSync('xcrun', ['swiftc', '-swift-version', '5', '-parse-as-library', ...frozen, '-o', binary], { encoding: 'utf8', timeout: 120_000 });
    expect(compile.status, compile.stdout + compile.stderr).toBe(0);
    const run = spawnSync(binary, [], { encoding: 'utf8', timeout: 10_000 });
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.stdout).toContain('strict wire contract passed');
  }, 150_000);
  it('uses production page/navigation and connection admission without copying UI', () => {
    const source = read('fixture.tsx');
    expect(source).toContain("from '../../resource-navigation'");
    expect(source).toContain('loadConnections({ forceReconnect: true })');
    expect(source).not.toMatch(/app\.(?:connection|runtimeScope)\.set/);
    expect(source).not.toContain('ResourceHTMLView');
    expect(source).toContain('NativeAppearanceSync');
  });
  it('installs actual bridges and exact anchor with captured production transport', () => {
    const source = read('uikit-main.swift');
    for (const port of ['ResourceTransport(read:', 'resources.installPresentationAnchor(on: surface)', 'html.initialFile', 'html.installView(on: surface', 'ResourceSVGImageFactory.install', 'GuiPluginPreviewBridge(controller:']) expect(source).toContain(port);
    expect(source).not.toMatch(/(?:struct|class)\s+(?:ResourceTransport|NshAppView)\b/);
    expect(source).not.toContain('ConnectionStore(');
    expect(source).not.toContain('URLSession');
  });
});
