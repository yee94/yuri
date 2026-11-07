import { describe, expect, test, vi } from 'vitest';
import { aboutBuild, aboutReadResponse, aboutSafeSnapshot, aboutVersion, createSettingsAbout, parseAboutClient, parseAboutHost, parseAboutHostUpdate, parseAboutOpenCode } from './settings-about-core';

const metadata = { schemaVersion: 1, version: '0.1.0', build: '1', updates: { status: 'unsupported' } };
const update = { supported: true, serverId: 'private-server', host: 'cli', currentVersion: '2.3.0', available: false, update: null, operation: null, checkError: null };
const operation = { id: 'private-id', status: 'restarting', version: '2.4.0', channel: 'stable', kind: 'cli-package', progress: null };
function fixture() {
  let current = true;
  const read = vi.fn(async (path: string): Promise<unknown> => path === '/api/system/info' ? { yuriVersion: '2.3.0', runtime: 'node', pid: 99, startedAt: 'private' }
    : path === '/api/opencode/upgrade-status' ? { serveVersion: '2.1.7', cliVersion: '2.9.0', management: 'manual-external', canManage: false, guidance: 'private-guidance' }
    : update);
  const call = vi.fn(async (name: string, input?: Record<string, unknown>): Promise<unknown> => name === 'native.clientMetadata' ? metadata
    : name === 'native.diagnostics.export' ? { outcome: 'shared', path: '/private/ignored' }
    : { schemaVersion: 2, mode: 'event-recorder', enabled: name === 'native.diagnostics.setEnabled' ? input?.enabled : true });
  const changed = vi.fn();
  const controller = createSettingsAbout({ read, call, current: () => current, hostID: 'private-connection', changed });
  return { controller, read, call, changed, invalidate: () => { current = false; } };
}
describe('three independently authoritative About versions', () => {
  test('Bundle identity is never the Host, CLI discovery or a bundled JS package', async () => {
    const { controller } = fixture(); await controller.refresh();
    expect(controller.state().client.value).toEqual({ version: '0.1.0', build: '1', update: 'unsupported' });
    expect(controller.state().host.value).toEqual({ version: '2.3.0' });
    expect(controller.state().opencode.value).toEqual({ version: '2.1.7', management: 'manual-external', canManage: false });
  });
  test('missing native identity remains unknown, not filled from package or Host', () => {
    expect(parseAboutClient({ schemaVersion: 1, yuriVersion: '9.0.0', updates: { status: 'unsupported' } })).toEqual({ version: null, build: null, update: 'unsupported' });
    expect(parseAboutHost({ version: '4.0.0' })).toEqual({ version: null });
    expect(parseAboutOpenCode({ cliVersion: '7.0.0' }).version).toBeNull();
    expect(parseAboutOpenCode({ currentVersion: '2.2.0', serveVersion: '' }).version).toBe('2.2.0');
  });
  test('untrusted paths, URLs, errors and malformed build strings are not versions', () => {
    for (const value of [null, {}, 'unknown', 'file:///private', 'Bearer fixture', '1.2.3\n/path', '1.2.3'.repeat(30)]) expect(aboutVersion(value)).toBeNull();
    expect(aboutVersion(' v1.2.3-beta.4+abc ')).toBe('v1.2.3-beta.4+abc');
    expect(aboutBuild('370.2')).toBe('370.2');
    for (const value of [1, '370oops', '-1', '', '1e3', '1.2.3.4', '370\n']) expect(aboutBuild(value)).toBeNull();
    expect(() => parseAboutClient({ ...metadata, updates: { status: 'available', url: 'https://example.test' } })).toThrow();
  });
  test('one failed resource cannot erase an unrelated version; failed refresh preserves confirmed value', async () => {
    const { controller, read } = fixture(); await controller.refresh();
    read.mockImplementation(async path => { if (path === '/api/system/info') throw new Error('/private/credential'); return path.includes('upgrade') ? { serveVersion: '2.1.8' } : update; });
    await controller.refresh();
    expect(controller.state().host).toEqual({ value: { version: '2.3.0' }, status: 'failed', refreshing: false });
    expect(controller.state().opencode.value?.version).toBe('2.1.8');
    expect(JSON.stringify(controller.state())).not.toContain('/private');
  });
  test('late responses after scope change never publish to the new Host', async () => {
    const { controller, read, invalidate, changed } = fixture();
    let done!: (value: unknown) => void;
    read.mockImplementation(() => new Promise(resolve => { done = resolve; }));
    const loading = controller.host(); const writes = changed.mock.calls.length;
    invalidate(); done({ yuriVersion: '8.8.8' }); await loading;
    expect(changed).toHaveBeenCalledTimes(writes); expect(controller.state().host.value).toBeNull();
  });
  test('deduplicates each in-flight read without blocking independent domains', async () => {
    const { controller, read } = fixture(); let done!: (value: unknown) => void;
    read.mockImplementation(() => new Promise(resolve => { done = resolve; }));
    const loading = controller.host(); await controller.host(); expect(read).toHaveBeenCalledTimes(1);
    done({ yuriVersion: '2.0.0' }); await loading;
  });
});
describe('truthful read-only discovery never implicitly executes an update', () => {
  test('checks only actual read endpoints, never applies, downloads, changes channel or restarts', async () => {
    const { controller, read, call } = fixture(); await controller.refresh(); await controller.hostUpdate();
    expect(new Set(read.mock.calls.map(([path]) => path))).toEqual(new Set(['/api/system/info', '/api/opencode/upgrade-status', '/api/system/update']));
    expect(call.mock.calls.map(([name]) => name)).toEqual(['native.clientMetadata', 'native.diagnostics.status']);
  });
  test('502 keeps authoritative operation status and marks discovery failed', () => {
    const value = aboutReadResponse('/api/system/update', { status: 502, body: { ...update, operation: { ...operation, error: '/private' } } });
    expect(parseAboutHostUpdate(value)).toMatchObject({ operation: 'restarting', checkFailed: true });
    expect(() => aboutReadResponse('/api/system/info', { status: 502, body: {} })).toThrow();
  });
  test.each([404, 501])('HTTP %s is explicit unsupported, not latest', async status => {
    const { controller, read } = fixture();
    read.mockImplementation(async () => aboutReadResponse('/api/system/update', { status, body: { error: 'not here' } }));
    await controller.hostUpdate(); expect(controller.state().hostUpdate.value?.supported).toBe(false);
  });
  test.each([401, 403, 500, 504])('HTTP %s is failure, not unsupported or latest', async status => {
    const { controller, read } = fixture(); read.mockImplementation(async () => aboutReadResponse('/api/system/update', { status }));
    await controller.hostUpdate(); expect(controller.state().hostUpdate.status).toBe('failed'); expect(controller.state().hostUpdate.value).toBeNull();
  });
  test('restart-gap 404 preserves the running operation, never reclassifies it unsupported', async () => {
    const { controller, read } = fixture(); read.mockResolvedValue({ ...update, operation }); await controller.hostUpdate();
    read.mockImplementation(async () => aboutReadResponse('/api/system/update', { status: 404 })); await controller.hostUpdate();
    expect(controller.state().hostUpdate).toMatchObject({ status: 'failed', value: { operation: 'restarting', supported: true } });
  });
  test('invalid status is not accepted as success', () => {
    for (const value of [{}, [], { ...update, operation: { status: 'pretend-complete' } }]) expect(() => parseAboutHostUpdate(value)).toThrow();
    const incomplete = { supported: true, host: 'cli', serverId: 'fixture', currentVersion: '2.3.0', available: false };
    expect(() => parseAboutHostUpdate(incomplete)).toThrow();
    expect(parseAboutHostUpdate({ ...update, available: true, update: { version: '/private/invalid' } }).checkFailed).toBe(true);
  });
});
describe('snapshot privacy and explicit share outcomes', () => {
  test('allowlist strips server IDs, paths, credentials, guidance, errors and raw event bodies', async () => {
    const { controller, read, call } = fixture(); await controller.refresh();
    read.mockResolvedValue({ ...update, checkError: '/private/credential', token: 'private-token', messages: ['private-message'], operation: { ...operation, status: 'failed', error: 'private-error' } });
    await controller.hostUpdate(); await controller.exportDiagnostics();
    const exported = call.mock.calls.find(([name]) => name === 'native.diagnostics.export')?.[1];
    expect(exported?.hostID).toBe('private-connection');
    const safe = JSON.stringify(exported?.snapshot);
    expect(safe).not.toMatch(/private|token|message|path|guidance|serverId|pid|startedAt/);
    expect(safe).toContain('2.1.7'); expect(safe).toContain('failed');
    expect(controller.state().exportOutcome).toBe('shared');
    expect(JSON.stringify(aboutSafeSnapshot(controller.state()))).not.toContain('0.1.0'); // Swift owns client metadata.
  });
  test.each(['shared', 'cancelled', 'failed'])('settles %s without leaving busy state', async outcome => {
    const { controller, call } = fixture(); await controller.refresh(); call.mockResolvedValue({ outcome });
    await controller.exportDiagnostics(); expect(controller.state()).toMatchObject({ exporting: false, exportOutcome: outcome });
  });
  test('disabled diagnostics prevents export at the domain boundary', async () => {
    const { controller, call } = fixture(); await controller.refresh(); await controller.setDiagnostics(false); await controller.exportDiagnostics();
    expect(call.mock.calls.filter(([name]) => name === 'native.diagnostics.export')).toHaveLength(0);
  });
  test('failed preference write keeps old preference and is retryable', async () => {
    const { controller, call } = fixture(); await controller.refresh(); call.mockRejectedValue(new Error('private'));
    await controller.setDiagnostics(false); expect(controller.state()).toMatchObject({ diagnosticsFailed: true, diagnosticsBusy: false, diagnostics: { value: { enabled: true } } });
    call.mockResolvedValue({ schemaVersion: 2, mode: 'event-recorder', enabled: false }); await controller.setDiagnostics(false);
    expect(controller.state()).toMatchObject({ diagnosticsFailed: false, diagnostics: { value: { enabled: false } } });
  });
  test('duplicate export and preference changes during sharing are rejected', async () => {
    const { controller, call } = fixture(); await controller.refresh(); let done!: (value: unknown) => void;
    call.mockImplementation(() => new Promise(resolve => { done = resolve; }));
    const exporting = controller.exportDiagnostics(); await controller.exportDiagnostics(); await controller.setDiagnostics(false);
    expect(call.mock.calls.filter(([name]) => name === 'native.diagnostics.export')).toHaveLength(1);
    expect(call.mock.calls.filter(([name]) => name === 'native.diagnostics.setEnabled')).toHaveLength(0);
    done({ outcome: 'cancelled' }); await exporting; expect(controller.state().exporting).toBe(false);
  });
});
