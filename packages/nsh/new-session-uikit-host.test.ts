import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProjectIdFromPath } from '../ui/src/lib/projectId';

const root = path.dirname(fileURLToPath(import.meta.url)), fixtures = path.join(root, 'tests/new-session-uikit');
const seed = JSON.parse(readFileSync(path.join(fixtures, 'seed.json'), 'utf8'));
const canonical = `/fixture/home/.config/yuri/projects/${createProjectIdFromPath('/fixture/project')}.json`;
const expectedHost = { hostID: 'new-session-uikit-synthetic', lease: 'new-session-uikit-memory-lease' };
type Call = { name: string; input: Record<string, unknown> };
type Result = { ok: boolean; value: unknown; error?: string; snapshot: Record<string, unknown> };
const request = (resource: string, method = 'GET', body?: unknown): Call => ({ name: 'runtime.request', input: { path: resource, method, expectedHost, ...(body === undefined ? {} : { body }) } });
const audit: Call = { name: 'fixture.newSession.audit', input: {} };
let temporary: string, binary: string;
beforeAll(() => {
  const parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode'); mkdirSync(parent, { recursive: true });
  temporary = mkdtempSync(path.join(parent, 'new-session-swift-pure-')); binary = path.join(temporary, 'synthetic-host');
  const driver = path.join(temporary, 'Driver.swift');
  writeFileSync(driver, `import Foundation
@main struct Driver {
  static func main() throws {
    let data = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
    let seed = try JSONSerialization.jsonObject(with: data) as! [String: Any]
    let host = try NewSessionSyntheticHost(seed: seed)
    let calls = try JSONSerialization.jsonObject(with: FileHandle.standardInput.readDataToEndOfFile()) as! [[String: Any]]
    var results: [[String: Any]] = []
    for call in calls {
      do { let value = try host.call(call["name"] as! String, call["input"]); results.append(["ok": true, "value": value, "snapshot": host.snapshot]) }
      catch { results.append(["ok": false, "error": error.localizedDescription, "snapshot": host.snapshot]) }
    }
    print(try NewSessionSyntheticHost.json(results))
  }
}
`);
  const compiled = spawnSync('xcrun', ['--sdk', 'macosx', 'swiftc', '-swift-version', '5', '-parse-as-library', path.join(fixtures, 'SyntheticHost.swift'), driver, '-o', binary], { encoding: 'utf8', timeout: 120_000 });
  expect(compiled.error, compiled.stderr).toBeUndefined(); expect(compiled.status, compiled.stderr).toBe(0);
}, 125_000);
afterAll(() => { if (temporary) rmSync(temporary, { recursive: true, force: true }); });
function run(calls: Call[]): Result[] {
  const result = spawnSync(binary, [path.join(fixtures, 'seed.json')], { input: JSON.stringify(calls), encoding: 'utf8', timeout: 10_000 });
  expect(result.error, result.stderr).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

describe('Foundation-only new-session UIKit Host (no NSH engine/device)', () => {
  it('provides the real connection.list adoption snapshot and rejects every absent, stale or augmented runtime scope', () => {
    const responses = run([
      { name: 'connection.list', input: {} }, request('/api/fs/home'),
      { name: 'runtime.request', input: { path: '/api/fs/home', method: 'GET' } },
      { name: 'runtime.request', input: { path: '/api/config/settings', method: 'PUT', body: { draftStarters: [] }, expectedHost: { ...expectedHost, lease: 'old-lease' } } },
      { name: 'runtime.request', input: { path: '/api/fs/home', expectedHost: { ...expectedHost, hostID: 'other' } } },
      { name: 'runtime.request', input: { path: '/api/fs/home', expectedHost: { ...expectedHost, extra: true } } }, audit,
    ]);
    expect(responses[0]).toMatchObject({ ok: true, value: { selected: expectedHost.hostID, runtimeScope: expectedHost,
      connections: [{ id: expectedHost.hostID, url: 'https://synthetic.invalid', authorizationID: 'fixture-memory-authorization' }] } });
    expect(responses.map(result => result.ok)).toEqual([true, true, false, false, false, false, true]);
    expect(responses.at(-1)?.snapshot).toMatchObject({ settingsWrites: 0, configWrites: 0, reads: 1, rejected: 4, networkEnabled: false });
  });
  it('serves strict real wire envelopes and the long synthetic native catalogs', () => {
    const responses = run([
      request('/api/fs/home'), request(`/api/fs/read?path=${encodeURIComponent(canonical)}&optional=true`),
      request('/api/config/settings'), request('/api/config/catalog/providers?directory=%2Ffixture%2Fproject'),
      request('/api/agent?location%5Bdirectory%5D=%2Ffixture%2Fproject'),
      request('/api/config/commands/metadata?directory=%2Ffixture%2Fproject', 'POST', { catalog: true }),
      request('/api/config/skills?directory=%2Ffixture%2Fproject&summary=true'),
    ]);
    expect(responses.every(result => result.ok)).toBe(true);
    expect(responses[0].value).toEqual({ status: 200, body: { home: '/fixture/home' } });
    const config = (responses[1].value as { body: string }).body;
    expect(JSON.parse(config)).toEqual(seed.projectConfigs['/fixture/project']);
    expect(responses[3].value).toEqual({ status: 200, body: { schemaVersion: 1, providers: seed.providers } });
    expect(responses[4].value).toEqual({ status: 200, body: { data: seed.agents } });
    expect(responses[5].value).toEqual({ status: 200, body: { commands: seed.commands } });
    expect(responses[6].value).toEqual({ status: 200, body: { skills: seed.skills } });
    expect(seed.settings.draftStarters.length).toBeGreaterThan(5);
    expect(seed.commands.some((row: { name: string }) => row.name.length > 40)).toBe(true);
    expect(responses.at(-1)?.snapshot).toMatchObject({ reads: 7, captures: 0, settingsWrites: 0, configWrites: 0, rejected: 0 });
  });

  it('counts only actual captures/writes; favorite patches preserve other settings and do not select a model', () => {
    const favoriteModels = [{ providerID: 'fixture', modelID: 'claude-model', variant: 'high' }];
    const results = run([
      { name: 'fixture.newSession.capture', input: { directory: '/fixture/project', selection: { providerID: 'fixture', modelID: 'gpt-model', variant: 'low' }, agent: 'plan' } },
      request('/api/config/settings', 'PUT', { favoriteModels }), audit, request('/api/config/settings'), audit,
    ]);
    expect(results.every(result => result.ok)).toBe(true);
    expect(results.at(-1)?.value).toMatchObject({ captures: 1, settingsWrites: 1, auditReads: 2, configWrites: 0,
      lastCapture: { directory: '/fixture/project', agent: 'plan', selection: { modelID: 'gpt-model', variant: 'low' } },
      settings: { ...seed.settings, favoriteModels } });
  });

  it('records project reorder/delete writes with exact text; malformed writes preserve the last valid snapshot', () => {
    const next = { ...seed.projectConfigs['/fixture/project'], draftStarters: [{ type: 'skill', name: 'fixture-review' }] }, content = JSON.stringify(next);
    const results = run([
      request('/api/fs/mkdir', 'POST', { path: '/fixture/home/.config/yuri/projects' }),
      request('/api/fs/write', 'POST', { path: canonical, content }),
      request('/api/fs/write', 'POST', { path: canonical, content: '{malformed' }),
      request(`/api/fs/read?path=${encodeURIComponent(canonical)}&optional=true`), audit,
    ]);
    expect(results.map(result => result.ok)).toEqual([true, true, false, true, true]);
    expect(results[3].value).toEqual({ status: 200, body: content });
    expect(results[4].value).toMatchObject({ configWrites: 1, mkdirCalls: 1, rejected: 1, settings: seed.settings });
    expect(results[4].snapshot.journal).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'config-write', detail: { path: canonical, content } })]));
  });

  it('clears the old model on an actual empty capture in a new directory', () => {
    const results = run([
      { name: 'fixture.newSession.capture', input: { directory: '/fixture/project', selection: { providerID: 'fixture', modelID: 'gpt-model' } } },
      { name: 'fixture.newSession.capture', input: { directory: '/fixture/other' } }, audit,
    ]);
    expect(results[2].value).toMatchObject({ captures: 2, lastCapture: { directory: '/fixture/other', selection: null, agent: null } });
  });

  it.each([
    request('/api/fs/home?unknown=1'), request('/api/fs/home', 'POST'), request('/api/path'),
    request('https://host.example/api/config/settings'), request('//host.example/api/config/settings'),
    request('/api/config/settings#ignored'), request('/api/fs/read?path=a&path=b&optional=true'),
    request('/api/fs/read?path=%ZZ&optional=true'), request('/api/fs/read?path=%2Foutside&optional=true'),
    request('/api/config/skills?directory=%2Ffixture%2Fproject&summary=false'),
    request('/api/config/catalog/providers'), request('/api/agent?directory=%2Ffixture%2Fproject'),
    request('/api/config/commands/metadata?directory=%2Ffixture%2Fproject', 'POST', { catalog: 1 }),
    request('/api/config/commands/metadata?directory=%2Ffixture%2Fproject', 'POST', { catalog: true, extra: true }),
    request('/api/config/settings', 'PUT', {}), request('/api/config/settings', 'PUT', { favoriteModels: [{ providerID: 'fixture' }] }),
    request('/api/config/settings', 'PUT', { draftStarters: [{ type: 'other', name: 'x' }] }),
    request('/api/fs/mkdir', 'POST', { path: '/outside' }),
    request('/api/session', 'POST', { location: { directory: '/fixture/project' } }),
    request('/api/session/real/prompt?directory=%2Ffixture%2Fproject', 'POST', { text: 'Never invoke a model' }),
    { name: 'connection.list', input: { connect: true } }, { name: 'runtime.stream', input: {} },
  ])('fails closed for unsupported/malformed protocol: %j', call => {
    const result = run([call])[0];
    expect(result.ok).toBe(false); expect(result.snapshot).toMatchObject({ rejected: 1, captures: 0, settingsWrites: 0, configWrites: 0, networkEnabled: false, keychainEnabled: false });
  });

  it('embeds production UI directly; Swift registration and grants contain no real transport or credentials', () => {
    const fixture = readFileSync(path.join(fixtures, 'fixture.tsx'), 'utf8');
    expect(fixture).toContain("import { NativeNewSessionPage } from '../../new-session-page'");
    expect(fixture).toContain('loadConnections().then('); expect(fixture).not.toContain('app.connection.set');
    expect(fixture).not.toMatch(/WebView|WKWebView|host\.call\s*=/);
    const swift = readFileSync(path.join(fixtures, 'uikit-main.swift'), 'utf8') + readFileSync(path.join(fixtures, 'SyntheticHost.swift'), 'utf8') + readFileSync(path.join(root, 'ios/NewSessionPickerOwners.swift'), 'utf8');
    expect(swift).not.toMatch(/URLSession|SecItem|import Security|import Network|WKWebView|RuntimeBridge\(|ConnectionStore\(/);
    expect(swift).toContain('surface.grantCapabilities'); expect(swift).toContain('surface.storageDirectory = storage');
    expect(swift).toContain('NewSessionPickerOwners.install(on: surface)');
    expect(swift).not.toMatch(/UIApplication\.shared|\.windows|method_exchangeImplementations/);
    const build = readFileSync(path.join(root, 'scripts/build-new-session-uikit.mjs'), 'utf8');
    expect(build).not.toMatch(/simctl|\['test'|\.nsh\/out/);
    expect(build).toContain('.nsh/new-session-uikit'); expect(build).toContain('sourceSHA256');
    expect(build).toContain("'connection.list'"); expect(swift).toContain('"connection.list"');
    expect(swift).toContain('NativeSheetPresentation.install(on: surface)'); expect(build).toContain("'ios/SheetPresentation.swift'");
  });
});
