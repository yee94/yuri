import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';

// Executes the exact fixture probe, not a WK/frame/security substitute. The App
// still calls the real production handler; these tests lock down wire parsing.
const root = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(root, 'tests/gui-wk-boundary/GuiPluginWKBoundaryFixture.swift'), 'utf8');
const marker = 'let rawProof = try await web.callAsyncJavaScript(#"""';
const start = source.indexOf(marker), end = source.indexOf('"""#, arguments:', start);
if (start < 0 || end < 0) throw Error('Missing actual fixture root probe');
const probe = source.slice(start + marker.length, end);
it.skipIf(process.platform !== 'darwin')('actual root call selects the SDK async result overload rather than the default nil completion handler', () => {
  const suffix = source.slice(end).split('\n')[0];
  const world = suffix.match(/, (in|contentWorld): \.page\)/)?.[1];
  expect(world).toBeDefined();
  const worlds = [world, ...Array.from(source.matchAll(/callAsyncJavaScript\("[^\n]+?, in: nil, (in|contentWorld): \.page\)/g), match => match[1])];
  expect(worlds).toHaveLength(3);
  const temporary = mkdtempSync(path.join(process.env.OPENCODE_TMP_DIR || tmpdir(), 'gui-wk-sdk-overload-'));
  try {
    const file = path.join(temporary, 'Probe.swift');
    writeFileSync(file, `import WebKit
${worlds.map((label, index) => `@MainActor func probe${index}(_ web: WKWebView) async throws -> Any? {
    let result = try await web.callAsyncJavaScript("return 'sdk-result'", arguments: [:], in: nil, ${label}: .page)
    return result
}`).join('\n')}`);
    const sdk = spawnSync('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path'], { encoding: 'utf8' });
    expect(sdk.status, sdk.stderr).toBe(0);
    const result = spawnSync('xcrun', ['--sdk', 'iphonesimulator', 'swiftc', '-typecheck', '-warnings-as-errors', '-swift-version', '5', '-sdk', sdk.stdout.trim(), '-target', 'arm64-apple-ios15.0-simulator', file], { encoding: 'utf8', timeout: 30_000 });
    expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
it('the exact WK function body explicitly returns the awaited proof result at top level', async () => {
  expect(probe).toMatch(/\breturn JSON\.stringify\(proof\);\s*$/);
  const missingReturn = probe.replace('return JSON.stringify(proof);', 'JSON.stringify(proof);');
  // Without an explicit return WK receives undefined, even when every operation
  // completes; the wire assertions below must continue to execute the full body.
  expect(await runInNewContext('(async()=>{' + missingReturn + '})()', {
    admittedScope: scope, expectedRuntimeKey: runtimeKey, expectedPreferenceKey: preferenceKey,
    window: { fixtureReady: true, fixtureScope: scope, webkit: { messageHandlers: { guiPluginPreview: { postMessage: async () => ({}) } } }, prompt: () => null },
  })).toBeUndefined();
});
const scope = { hostID: 'gui-boundary-host', lease: '11111111-1111-4111-8111-111111111111' };
const runtimeKey = 'nsh:gui-boundary-host', preferenceKey = 'fixture-preference-key';
type Change = 'none' | 'device-number' | 'device-rejected' | 'storage-failed' | 'storage-value' | 'bootstrap-key' | 'cached-scope' | 'rpc';
async function run(change: Change) {
  const calls: Record<string, unknown>[] = [];
  const input = {
    admittedScope: scope, expectedRuntimeKey: runtimeKey, expectedPreferenceKey: preferenceKey,
    window: {
      fixtureReady: true, fixtureScope: change === 'cached-scope' ? { ...scope, lease: 'retired-receipt' } : scope,
      webkit: { messageHandlers: { guiPluginPreview: { async postMessage(message: Record<string, unknown>) {
        calls.push(message);
        if (message.name === 'bootstrap') return { runtimeKey: change === 'bootstrap-key' ? 'unexpected' : runtimeKey, preferenceKey, intent: { expectedHost: scope } };
        expect(message.expectedHost).toEqual(scope);
        if (message.name === 'device') {
          expect(message).toEqual({ name: 'device', expectedHost: scope, method: 'capabilities', input: {} });
          return { ok: change === 'device-number' ? 1 : change !== 'device-rejected', value: { version: 1, exportPDF: true, exportLongImage: true } };
        }
        expect(message).toMatchObject({ name: 'request', id: '901', input: { method: 'POST', route: '/api/rpc/boundary/probe', headers: { 'content-type': 'application/json' } } });
        return { status: change === 'rpc' ? 403 : 200, mime: 'application/json', base64: 'e30=', headers: {} };
      } } } },
      prompt(name: string, text: string) {
        expect(name).toBe('yuri.gui.storage.v1');
        expect(JSON.parse(text)).toEqual({ expectedHost: scope, operation: { method: 'get', key: preferenceKey } });
        return JSON.stringify({ ok: change !== 'storage-failed', value: change === 'storage-value' ? [] : '[]' });
      },
    },
  };
  const result = await runInNewContext('(async()=>{' + probe + '})()', input);
  expect(typeof result).toBe('string');
  const proof = JSON.parse(result);
  expect(Object.values(proof).every(value => typeof value === 'boolean')).toBe(true);
  expect(calls.map(call => call.name)).toEqual(['bootstrap', 'device', 'request']);
  return proof;
}
it('root probe uses bare bootstrap, device envelope, synchronous Storage JSON and buffered RPC wire', async () => {
  const proof = await run('none');
  expect(proof).toMatchObject({ bootstrap: true, device: true, storage: true, rpc: true, cachedScopeMatched: true, deviceEnvelopeBoolean: true, storageEnvelopeBoolean: true });
  expect(proof).not.toHaveProperty('runtimeKey'); expect(proof).not.toHaveProperty('expectedHost'); expect(proof).not.toHaveProperty('value');
});
it.each([
  ['device-number', 'device', 'deviceEnvelopeBoolean'],
  ['device-rejected', 'device', 'deviceEnvelopeOK'],
  ['storage-failed', 'storage', 'storageEnvelopeOK'],
  ['storage-value', 'storage', 'storageValueMatched'],
  ['bootstrap-key', 'bootstrap', 'bootstrapRuntimeKeyMatched'],
  ['cached-scope', 'bootstrap', 'cachedScopeMatched'],
  ['rpc', 'rpc', 'rpcStatusMatched'],
] as const)('root probe keeps %s false and exposes only safe boolean diagnostics', async (change, group, detail) => {
  const proof = await run(change); expect(proof[group]).toBe(false); expect(proof[detail]).toBe(false);
});
