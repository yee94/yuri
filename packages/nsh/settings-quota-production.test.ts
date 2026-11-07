import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { createQuotaCredentials, quotaCredentialProviderFor, quotaCredentialResponse } from './settings-quota-credentials-core';
import { readSettingsCollection } from './settings-protocol';
import { createAboutDiagnosticsRoot } from './settings-about-diagnostics';
import { bindRawRequest, connectionSnapshotFrom } from './runtime';
import { quotaProductionCapabilities, withQuotaProductionFixture } from './tests/settings-quota-production-runner.mjs';
import { openQuotaProvider, quotaRoundTrip, quotaScopedSettings, quotaVisibilityAndHost, type QuotaProductionAudit } from './tests/settings-quota-production-scenarios';

const root = path.dirname(fileURLToPath(import.meta.url));
const actual = '/fixture/second/.worktrees/topic';
type Fixture = { directory: string; entry: string; host: string };
type Host = { call(name: string, input: unknown): unknown; setForeground(active: boolean): void };
// Only the native JS call boundary is replaced; production bindRawRequest still constructs every request.
const nativeBoundary = vi.hoisted(() => ({ call: (_name: string, _input: unknown): unknown => { throw new Error('No synthetic quota Host installed'); } }));
vi.mock('nsh', () => ({ host: { available: () => true, call: (name: string, input: unknown) => nativeBoundary.call(name, input) } }));
function evaluateHost(fixture: Fixture) {
  const artifact = readFileSync(fixture.host, 'utf8');
  const syntax = ts.createSourceFile(fixture.host, artifact, ts.ScriptTarget.ES2023, true, ts.ScriptKind.JS);
  expect(syntax.statements.some(node => ts.isImportDeclaration(node) || ts.isExportDeclaration(node) && !!node.moduleSpecifier)).toBe(false);
  const output = ts.transpileModule(artifact, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 }, reportDiagnostics: true });
  expect(output.diagnostics ?? []).toEqual([]);
  const context = vm.createContext({}), exports: Record<string, unknown> = {};
  expect(vm.runInContext('typeof URL + ":" + typeof URLSearchParams + ":" + typeof fetch', context)).toBe('undefined:undefined:undefined');
  vm.runInContext(`(function(exports) { ${output.outputText}\n})`, context)(exports);
  const host = (exports.createHost as () => Host)();
  nativeBoundary.call = (name, input) => host.call(name, input);
  const audit = () => host.call('quotaProduction.fixture.audit', {}) as QuotaProductionAudit;
  const snapshot = () => connectionSnapshotFrom(host.call('connection.list', {}));
  const bindSend = () => {
    const raw = bindRawRequest(snapshot().runtimeScope);
    return async (resource: string, method = 'GET', body?: unknown) => quotaCredentialResponse(await raw(resource, method, body));
  };
  const scenario = (mode: string) => host.call('quotaProduction.fixture.scenario', { mode });
  return { host, send: bindSend(), bindSend, snapshot, audit, scenario };
}
const isolatedHost = (): ReturnType<typeof evaluateHost> => withQuotaProductionFixture(root, (fixture: Fixture) => evaluateHost(fixture));

describe('quota production strict synthetic Host (pure VM; not production navigation evidence)', () => {
  it('admits only the empty background jobs GET at the captured current scope with one read and zero job/scan reads', async () => {
    const { send, audit } = isolatedHost();
    expect(await send('/api/yuri/history-import/jobs')).toEqual([]);
    const value = audit();
    expect(value.nativeCounts['runtime.request']).toBe(1);
    expect(value.requests.map(row => [row.resource, row.method, row.expectedHost])).toEqual([
      ['/api/yuri/history-import/jobs', 'GET', value.runtimeScope],
    ]);
    expect(value.requests.filter(row => ['/api/yuri/history-import/job', '/api/yuri/history-import/scan'].includes(row.path))).toHaveLength(0);
    expect(value.writes).toEqual([]); expect(value.rejected).toEqual([]);
    expect(value.actions).toEqual({ validates: 0, imports: 0, deletes: 0 });
  });

  it('rejects stale monitor scopes, query/body injection, scan and every other history prefix or write without admission', async () => {
    const { host, snapshot, audit } = isolatedHost(), oldScope = snapshot().runtimeScope;
    host.call('connection.select', { id: 'quota-production-secondary' });
    host.call('connection.select', { id: 'settings-navigation-production' });
    const expectedHost = snapshot().runtimeScope;
    expect(expectedHost).not.toEqual(oldScope);
    const invalid: Array<Record<string, unknown>> = [];
    for (const path of ['/api/yuri/history-import/jobs']) {
      invalid.push(
        { path, method: 'GET', expectedHost: oldScope },
        { path, method: 'GET' },
        { path, method: 'GET', expectedHost, body: {} },
        { path, method: 'GET', expectedHost, body: undefined },
        { path, method: 'GET', expectedHost, extra: true },
        ...['?', '?id=synthetic', '?directory=' + encodeURIComponent(actual), '?unknown=1'].map(query => ({ path: path + query, method: 'GET', expectedHost })),
        ...['POST', 'PUT', 'PATCH', 'DELETE'].map(method => ({ path, method, expectedHost })),
      );
    }
    for (const suffix of ['job', 'scan', 'start', 'resume', 'dismiss', 'cancel', 'job/extra', 'jobs/extra', 'unknown']) {
      for (const method of ['GET', 'POST']) invalid.push({ path: '/api/yuri/history-import/' + suffix, method, expectedHost });
    }
    for (const input of invalid) expect(() => host.call('runtime.request', input)).toThrow();
    expect(audit().nativeCounts['runtime.request']).toBe(invalid.length);
    expect(audit().rejected).toHaveLength(invalid.length);
    expect(audit().requests).toEqual([]); expect(audit().writes).toEqual([]);
    expect(audit().actions).toEqual({ validates: 0, imports: 0, deletes: 0 });
  });

  it('one snapshot authority admits current streams and scoped reads on A → B → A; old cleanup never releases a replacement stream', async () => {
    const { host, snapshot, audit, bindSend } = isolatedHost();
    const scopes = [];
    for (const id of ['settings-navigation-production', 'quota-production-secondary', 'settings-navigation-production']) {
      if (scopes.length) host.call('connection.select', { id });
      const scope = snapshot().runtimeScope!; scopes.push(scope);
      expect(scope.hostID).toBe(id);
      for (const [key, path] of [['global', '/api/yuri/events'], ['chat', '/api/event?directory=' + encodeURIComponent(actual)]]) {
        expect(host.call('runtime.stream', { key, path, expectedHost: scope })).toBe(true);
      }
      await bindSend()('/api/config/settings');
      expect(audit().streams.global.expectedHost).toEqual(scope);
      expect(audit().streams.chat.expectedHost).toEqual(scope);
      expect(audit().requests.at(-1)?.expectedHost).toEqual(scope);
    }
    expect(new Set(scopes.map(scope => scope.lease)).size).toBe(3);
    const before = audit();
    for (const expectedHost of scopes.slice(0, 2)) {
      expect(() => host.call('runtime.stream', { key: 'global', path: '/api/yuri/events', expectedHost })).toThrow('stale_runtime_scope');
      expect(host.call('runtime.stop', { key: 'global', expectedHost })).toBe(true);
      expect(audit().streams).toEqual(before.streams);
    }
    expect(audit().rejected).toHaveLength(2);
    expect(audit().nativeCounts['runtime.stream']).toBe(8);
    expect(audit().nativeCounts['runtime.stop']).toBe(2);
    expect(audit().streamCalls.filter(call => call.name === 'runtime.stop').map(call => call.released)).toEqual([false, false]);
    expect(host.call('runtime.stop', { key: 'global', expectedHost: scopes[2] })).toBe(true);
    expect(audit().streams.global).toBeUndefined(); expect(audit().streams.chat.expectedHost).toEqual(scopes[2]);
    expect(host.call('runtime.stop', { key: 'chat', expectedHost: scopes[2] })).toBe(true);
    expect(audit().streams).toEqual({});
    expect(audit().streamCalls.filter(call => call.name === 'runtime.stop').map(call => call.released)).toEqual([false, false, true, true]);
    expect(audit().writes).toEqual([]); expect(audit().actions).toEqual({ validates: 0, imports: 0, deletes: 0 });
  });

  it('foreground snapshots, HTTP admission and stream admission use the same scope, with no lifecycle native capability', async () => {
    const { host, snapshot, audit, bindSend } = isolatedHost(), before = snapshot().runtimeScope!;
    expect(host.call('runtime.stream', { key: 'global', path: '/api/yuri/events', expectedHost: before })).toBe(true);
    const oldSend = bindSend();
    host.setForeground(false);
    expect(snapshot().runtimeScope).toBeNull(); expect(audit().runtimeScope).toBeNull(); expect(audit().streams).toEqual({});
    await expect(oldSend('/api/config/settings')).rejects.toThrow('stale_runtime_scope');
    expect(() => host.call('runtime.stream', { key: 'global', path: '/api/yuri/events', expectedHost: before })).toThrow('stale_runtime_scope');
    host.setForeground(true);
    const fresh = snapshot().runtimeScope!;
    expect(fresh.hostID).toBe(before.hostID); expect(fresh.lease).not.toBe(before.lease);
    expect(host.call('runtime.stream', { key: 'global', path: '/api/yuri/events', expectedHost: fresh })).toBe(true);
    expect(host.call('runtime.stop', { key: 'global', expectedHost: before })).toBe(true);
    expect(audit().streams.global.expectedHost).toEqual(fresh);
    await bindSend()('/api/config/settings');
    expect(audit().requests.at(-1)?.expectedHost).toEqual(fresh);
    expect(audit().nativeCounts['runtime.stream']).toBe(3); expect(audit().nativeCounts['runtime.stop']).toBe(1);
    expect(audit().rejected).toHaveLength(2);
    const allowed = [...quotaProductionCapabilities];
    for (const name of ['runtime.foreground', 'quotaProduction.fixture.foreground', 'connection.setForeground']) expect(() => host.call(name, { active: true })).toThrow();
    expect(audit().rejected).toHaveLength(5); expect(quotaProductionCapabilities).toEqual(allowed);
    expect(audit().writes).toEqual([]);
  });

  it('stream and cleanup enforce exact keys, UUID scope and known paths/keys instead of adopting or stripping caller authority', () => {
    const { host, snapshot, audit } = isolatedHost(), expectedHost = snapshot().runtimeScope;
    const stream = { key: 'global', path: '/api/yuri/events', expectedHost }, stop = { key: 'global', expectedHost };
    host.call('runtime.stream', stream); const before = audit().streams;
    const invalid: Array<[string, unknown]> = [
      ['runtime.stream', { path: stream.path, key: stream.key }], ['runtime.stop', { key: stop.key }],
      ['runtime.stream', { ...stream, extra: true }], ['runtime.stop', { ...stop, path: stream.path }],
      ['runtime.stream', { ...stream, path: '/api/unknown' }], ['runtime.stream', { ...stream, key: 'chat' }],
      ['runtime.stream', { ...stream, path: '/api/event?directory=' + encodeURIComponent('/fixture/first'), key: 'chat' }],
      ['runtime.stop', { ...stop, key: 'unknown' }],
      ...[null, [], {}, { ...expectedHost, lease: 'not-a-uuid' }, { ...expectedHost, directory: actual }].flatMap(scope => [
        ['runtime.stream', { ...stream, expectedHost: scope }], ['runtime.stop', { ...stop, expectedHost: scope }],
      ] as Array<[string, unknown]>),
    ];
    for (const [name, input] of invalid) expect(() => host.call(name, input)).toThrow();
    expect(audit().rejected).toHaveLength(invalid.length); expect(audit().streams).toEqual(before);
    expect(audit().streamCalls).toHaveLength(1); expect(audit().requests).toEqual([]); expect(audit().writes).toEqual([]);
  });

  it('returns only the exact disabled native diagnostics v2 status and rejects all injected input and other diagnostics calls', () => {
    const { host, audit } = isolatedHost();
    const status = { schemaVersion: 2, mode: 'event-recorder', enabled: false, recordingLease: null, eventCount: 0, maxEntries: 500, maxBytes: 262144 };
    expect(audit().nativeCounts['native.diagnostics.status'] ?? 0).toBe(0);
    expect(host.call('native.diagnostics.status', {})).toEqual(status);
    expect(audit().nativeCounts['native.diagnostics.status']).toBe(1);
    const invalid = [undefined, null, [], false, { hostID: audit().selected }, { directory: actual }, { enabled: false }, { recordingLease: null }, { events: [] }];
    for (const input of invalid) expect(() => host.call('native.diagnostics.status', input)).toThrow();
    const forbidden = ['native.diagnostics.setEnabled', 'native.diagnostics.append', 'native.diagnostics.export', 'native.diagnostics.unknown', 'native.clientMetadata'];
    for (const name of forbidden) expect(() => host.call(name, {})).toThrow();
    const rejected = audit();
    expect(rejected.nativeCounts['native.diagnostics.status']).toBe(1 + invalid.length);
    for (const name of forbidden) expect(rejected.nativeCounts[name]).toBe(1);
    expect(rejected.rejected).toHaveLength(invalid.length + forbidden.length);
    expect(host.call('native.diagnostics.status', {})).toEqual(status);
    expect(audit().nativeCounts['native.diagnostics.status']).toBe(2 + invalid.length);
    expect(audit().requests).toEqual([]); expect(audit().writes).toEqual([]);
  });

  it('the real pure diagnostics root reads once per explicit scope refresh and stays closed without event writes or OS calls', async () => {
    const { host, audit } = isolatedHost();
    let scope: { hostID: string; generation: number } | null = { hostID: audit().selected, generation: 1 };
    const root = createAboutDiagnosticsRoot({ call: async (name, input = {}) => host.call(name, input), scope: () => scope });
    const event = { key: 'global' as const, type: 'session.status', directory: actual, body: { sessionID: 'synthetic-quota-session' } };
    try {
      await root.refresh();
      expect(audit().nativeCounts).toEqual({ 'connection.list': 1, 'native.diagnostics.status': 1 });
      for (let index = 0; index < 10; index++) root.onEvent(event, scope!);
      await root.flush();
      expect(audit().nativeCounts).toEqual({ 'connection.list': 1, 'native.diagnostics.status': 1 });
      host.call('connection.select', { id: 'quota-production-secondary' });
      scope = { hostID: audit().selected, generation: 2 };
      await root.refresh(); root.onEvent(event, scope); await root.flush();
      expect(audit().nativeCounts).toEqual({ 'connection.list': 1, 'native.diagnostics.status': 2, 'connection.select': 1 });
      scope = null; await root.refresh(); await root.flush();
      expect(audit().nativeCounts).toEqual({ 'connection.list': 1, 'native.diagnostics.status': 2, 'connection.select': 1 });
      expect(audit().requests).toEqual([]); expect(audit().writes).toEqual([]); expect(audit().rejected).toEqual([]);
    } finally { root.dispose(); }
  });

  it.each(['opencode', 'ollama', 'cursor'])('%s uses the actual mapped usage controller and separate Host-global wire', async provider => {
    const { send, audit, scenario } = isolatedHost();
    const rows = await readSettingsCollection(send, 'providers', actual);
    expect(rows.find(row => row.id === provider)).toMatchObject({ id: provider, integrationID: provider });
    const quota = quotaCredentialProviderFor(provider)!;
    const controller = createQuotaCredentials({ providerId: quota, send, current: () => true });
    controller.setActive(true); await controller.read(); controller.open();
    expect(controller.state().status?.configured).toBe(false);
    await controller.act('save'); expect(audit().writes).toEqual([]);
    const field = quota === 'opencode-go' ? 'authCookie' : quota === 'ollama-cloud' ? 'cookie' : 'accessToken';
    controller.change(field, 'fixture-only-input');
    scenario('reject'); await controller.act('save');
    expect(controller.state()).toMatchObject({ open: true, error: 'operation', values: { [field]: 'fixture-only-input' } });
    scenario('ok'); await controller.act('save');
    expect(controller.state()).toMatchObject({ open: false, values: {}, notice: 'save', status: { configured: true } });
    await controller.read(); controller.open();
    expect(controller.state().values[field]).toBeUndefined();
    expect(audit().writes.map(row => row.accepted)).toEqual([false, true]);
    expect(audit().requests.filter(row => row.path.startsWith('/api/quota/')).every(row => row.resource === row.path)).toBe(true);
    expect(JSON.stringify(audit())).not.toContain('fixture-only-input');
    expect(audit().rejected).toEqual([]); controller.dispose();
  });

  it('scoped provider metadata follows the second project worktree, never first/recent; unscoped calls stay global', async () => {
    const { send, audit } = isolatedHost();
    const settings = await send('/api/config/settings') as { projects: Array<{ path: string }>; lastDirectory: string };
    expect(settings.projects.map(project => project.path)).toEqual(['/fixture/first', '/fixture/second']);
    expect(settings.lastDirectory).not.toBe(actual);
    await readSettingsCollection(send, 'providers'); await readSettingsCollection(send, 'providers', actual);
    for (const suffix of ['', '?location%5Bdirectory%5D=' + encodeURIComponent(actual)]) {
      const result = await send('/api/integration/ollama' + suffix) as { data: { methods: unknown[] } };
      expect(result.data.methods).toEqual([{ id: 'key', type: 'key' }]);
    }
    expect(audit().requests.filter(row => row.path === '/api/config/catalog/providers').map(row => row.resource)).toEqual(['/api/config/catalog/providers', '/api/config/catalog/providers?directory=' + encodeURIComponent(actual)]);
    expect(audit().writes).toEqual([]); expect(audit().rejected).toEqual([]);
  });

  it('hidden and retired Host owners clear synthetic drafts; the second Host starts with independent authority', async () => {
    const { host, send, bindSend, audit } = isolatedHost();
    const captured = audit().selected;
    const controller = createQuotaCredentials({ providerId: 'cursor', send, current: () => audit().selected === captured });
    controller.setActive(true); await controller.read(); controller.open(); controller.change('accessToken', 'fixture-only-input');
    controller.setActive(false); expect(controller.state().values).toEqual({});
    controller.setActive(true); await controller.read(); controller.open();
    expect(controller.state().values).toEqual({}); controller.change('accessToken', 'fixture-only-input');
    host.call('connection.select', { id: 'quota-production-secondary' }); controller.dispose();
    await controller.act('save'); expect(audit().writes).toEqual([]); expect(controller.state().values).toEqual({});
    expect(await bindSend()('/api/quota/credentials/cursor')).toEqual({ configured: false });
    expect(audit().rejected).toEqual([]);
  });

  it('forwards an immutable captured snapshot scope; rename preserves it but A → B → A issues a different synthetic UUID', async () => {
    const { host, snapshot, audit } = isolatedHost();
    const initial = snapshot(), captured = initial.runtimeScope;
    if (!captured) throw new Error('Synthetic scope missing');
    expect(captured.lease).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(connectionSnapshotFrom({ ...initial, runtimeScope: null }).runtimeScope).toBeNull();
    expect(() => connectionSnapshotFrom({ ...initial, runtimeScope: { ...captured, hostID: 'other' } })).toThrow();
    const source = { ...captured }, raw = bindRawRequest(source);
    source.lease = '00000000-0000-4000-8000-ffffffffffff';
    await raw('/api/config/settings');
    const renamed = connectionSnapshotFrom(host.call('connection.rename', { id: captured.hostID, version: 'synthetic-quota-version-0', label: 'Renamed synthetic quota Host' }));
    expect(renamed.runtimeScope).toEqual(captured);
    expect(renamed.connections[0].label).toBe('Renamed synthetic quota Host');
    await raw('/api/quota/credentials/cursor');
    for (const row of audit().requests) {
      expect(row.expectedHost).toEqual(captured); expect(row.expectedHost).toEqual(row.runtimeScope);
    }
    const next = connectionSnapshotFrom(host.call('connection.select', { id: 'quota-production-secondary' }));
    expect(next.runtimeScope?.hostID).toBe('quota-production-secondary');
    const returned = connectionSnapshotFrom(host.call('connection.select', { id: captured.hostID }));
    expect(returned.runtimeScope?.hostID).toBe(captured.hostID);
    expect(new Set([captured.lease, next.runtimeScope?.lease, returned.runtimeScope?.lease]).size).toBe(3);
    await expect(raw('/api/quota/credentials/cursor')).rejects.toThrow('stale_runtime_scope');
    await expect(raw('/api/quota/credentials/cursor', 'PUT', { accessToken: 'fixture-only-input', refreshToken: '' })).rejects.toThrow('stale_runtime_scope');
    expect(audit().writes).toEqual([]); expect(audit().actions).toEqual({ validates: 0, imports: 0, deletes: 0 });
  });

  it('requires scope on every non-GET, checks scoped GET too, and rejects malformed/extra scope keys and unknown requests', async () => {
    const { host, snapshot, audit } = isolatedHost(), captured = snapshot().runtimeScope;
    const unbound = bindRawRequest(null), before = audit().nativeCounts['runtime.request'] ?? 0;
    for (const method of ['PUT', 'POST', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']) {
      await expect(unbound('/api/quota/credentials/cursor', method)).rejects.toThrow('scope_required');
    }
    expect(audit().nativeCounts['runtime.request'] ?? 0).toBe(before);
    for (const [path, method] of [['/api/quota/credentials/cursor', 'PUT'], ['/api/quota/credentials/cursor/validate', 'POST'], ['/api/quota/credentials/cursor/import', 'POST'], ['/api/quota/credentials/cursor', 'DELETE']]) {
      expect(() => host.call('runtime.request', { path, method })).toThrow('scope_required');
    }
    for (const expectedHost of [undefined, null, [], {}, { hostID: audit().selected }, { lease: captured?.lease }, { ...captured, directory: actual }, { ...captured, lease: '00000000-0000-4000-8000-ffffffffffff' }, { ...captured, hostID: 'other' }]) {
      expect(() => host.call('runtime.request', { path: '/api/config/settings', method: 'GET', expectedHost })).toThrow();
    }
    expect(() => host.call('runtime.request', { path: '/api/config/settings', method: 'GET', expectedHost: captured, extra: true })).toThrow();
    await expect(bindRawRequest(captured)('/api/unknown')).rejects.toThrow();
    expect(audit().requests).toEqual([]); expect(audit().writes).toEqual([]);
    expect(audit().actions).toEqual({ validates: 0, imports: 0, deletes: 0 });
    // Legacy unbound GET remains read-only compatibility, not inferred mutation authority.
    expect((await unbound('/api/config/settings')).status).toBe(200);
  });

  it('accepts only the known current-scope Cursor validate/import/delete wire, so stale-scope tests cannot pass by unknown-route rejection', async () => {
    const { send, audit } = isolatedHost();
    await send('/api/quota/credentials/cursor', 'PUT', { accessToken: 'fixture-only-input', refreshToken: '' });
    expect(await send('/api/quota/credentials/cursor/validate', 'POST')).toEqual({ valid: true });
    expect(await send('/api/quota/credentials/cursor/import', 'POST')).toEqual({ configured: true });
    expect(await send('/api/quota/credentials/cursor', 'DELETE')).toEqual({ configured: false });
    expect(audit().actions).toEqual({ validates: 1, imports: 1, deletes: 1 });
    expect(audit().rejected).toEqual([]);
    for (const row of audit().requests) { expect(row.expectedHost).toEqual(row.runtimeScope); expect(row.resource).toBe(row.path); }
  });

  for (const returned of [false, true]) it.each(['validate', 'import', 'delete'] as const)(`old owner after await rejects %s with zero action admission (A → B${returned ? ' → A' : ''}; JS forwarding only)`, async action => {
    const { host, snapshot, send, audit } = isolatedHost();
    await send('/api/quota/credentials/cursor', 'PUT', { accessToken: 'fixture-only-input', refreshToken: '' });
    const captured = snapshot().runtimeScope, raw = bindRawRequest(captured), baseline = audit();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const continuation = (async () => {
      await gate;
      return raw('/api/quota/credentials/cursor' + (action === 'delete' ? '' : '/' + action), action === 'delete' ? 'DELETE' : 'POST');
    })();
    host.call('connection.select', { id: 'quota-production-secondary' });
    if (returned) host.call('connection.select', { id: baseline.selected });
    release();
    await expect(continuation).rejects.toThrow('stale_runtime_scope');
    await expect(raw('/api/quota/credentials/cursor')).rejects.toThrow('stale_runtime_scope');
    expect(audit().requests).toEqual(baseline.requests); expect(audit().writes).toEqual(baseline.writes);
    expect(audit().actions).toEqual({ validates: 0, imports: 0, deletes: 0 });
    expect(audit().rejected).toHaveLength(2);
  });

  it.each(['save', 'import', 'delete'] as const)('unknown %s ACK followed by failed status read never replays the Host-global write', async action => {
    const { send, scenario, audit } = isolatedHost();
    if (action === 'delete') await send('/api/quota/credentials/cursor', 'PUT', { accessToken: 'fixture-only-input', refreshToken: '' });
    const controller = createQuotaCredentials({ providerId: 'cursor', current: () => true, send });
    try {
      controller.setActive(true); await controller.read(); controller.open();
      if (action === 'save') controller.change('accessToken', 'fixture-only-input');
      if (action === 'delete') controller.confirmDelete(true);
      const baseline = audit(); scenario('lost-ack'); await controller.act(action);
      expect(controller.state().recovery).toBe('read-required');
      const unknown = audit(); expect(unknown.writes).toHaveLength(baseline.writes.length + 1);
      await controller.act(action);
      expect(audit().nativeCounts['runtime.request']).toBe(unknown.nativeCounts['runtime.request']);
      scenario('read-fail'); await controller.read();
      expect(controller.state()).toMatchObject({ error: 'load', recovery: 'read-required' });
      await controller.act(action); expect(audit().writes).toEqual(unknown.writes);
      scenario('ok'); await controller.read(); await controller.read();
      expect(controller.state()).toMatchObject({ recovery: 'review', status: { configured: action !== 'delete' } });
      expect(audit().writes).toEqual(unknown.writes); expect(audit().actions).toEqual(unknown.actions);
      for (const row of audit().requests) { expect(row.resource).toBe(row.path); expect(row.expectedHost).toEqual(row.runtimeScope); }
    } finally { controller.dispose(); }
  });

  it('fails closed on model-key substitution, extra fields, scoped usage calls, guessed directories and all unknown writes/native calls', async () => {
    const { host, send, audit } = isolatedHost();
    const invalid = [
      ['/api/quota/credentials/cursor?directory=' + encodeURIComponent(actual), 'GET'],
      ['/api/quota/credentials/cursor?location%5Bdirectory%5D=' + encodeURIComponent(actual), 'GET'],
      ['/api/quota/credentials/cursor?', 'GET'], ['/api/quota/credentials/cursor#fragment', 'GET'],
      ['https://external.example.invalid/api/quota/credentials/cursor', 'GET'],
      ['/api/quota/credentials/cursor', 'GET', {}],
      ['/api/quota/credentials/cursor', 'PUT', { accessToken: 'synthetic-model-access-only', refreshToken: '' }],
      ['/api/quota/credentials/cursor', 'PUT', { accessToken: 'fixture-only-input', refreshToken: '', directory: actual }],
      ['/api/quota/credentials/opencode-go', 'PUT', { apiKey: 'synthetic-model-access-only' }],
      ['/api/integration/cursor/connect/key', 'POST', { key: 'synthetic-model-access-only' }],
      ['/api/config/settings', 'PUT', {}], ['/api/credential/model-key', 'GET'], ['/api/unknown', 'GET'],
      ...['/fixture/first', '/fixture/second', '/fixture/recent-decoy'].map(directory => ['/api/config/catalog/providers?directory=' + encodeURIComponent(directory), 'GET']),
      ['/api/config/catalog/providers?directory=%ZZ', 'GET'],
      ['/api/config/catalog/providers?directory=' + encodeURIComponent(actual) + '&%64irectory=' + encodeURIComponent(actual), 'GET'],
    ] as Array<[string, string, unknown?]>;
    for (const args of invalid) await expect(send(...args)).rejects.toThrow();
    for (const name of ['connection.connect', 'camera.scan', 'notification.request', 'notification.status', 'quota.fixture.audit', 'unknown.call']) expect(() => host.call(name, {})).toThrow();
    expect(audit().rejected).toHaveLength(invalid.length + 6); expect(audit().writes).toEqual([]);
  });

  it('audit/scenario cannot inject state, reset errors or select an unknown Host', () => {
    const { host, audit } = isolatedHost();
    for (const input of [undefined, null, [], { reset: true }]) expect(() => host.call('quotaProduction.fixture.audit', input)).toThrow();
    expect(() => host.call('quotaProduction.fixture.scenario', { mode: 'ok', selected: 'other' })).toThrow();
    expect(() => host.call('connection.select', { id: 'unknown' })).toThrow();
    expect(audit().selected).toBe('settings-navigation-production'); expect(audit().rejected).toHaveLength(6);
  });
});

it('isolates production App/config/Storage identity and cleans only its own temporary artifacts on success and failure', () => {
  const production = readFileSync(path.join(root, 'nsh.json'), 'utf8');
  let first = '', second = '';
  withQuotaProductionFixture(root, (fixture: Fixture) => {
    first = fixture.directory;
    const config = JSON.parse(readFileSync(path.join(first, 'nsh.json'), 'utf8'));
    expect(config.id).toMatch(/^example\.yuri\.quota-production\./);
    expect(config.capabilities.host).toEqual(quotaProductionCapabilities);
    expect(config.capabilities.host.some((name: string) => name.includes('*') || name.startsWith('quotaProduction.'))).toBe(false);
    expect(config.capabilities.host).not.toContain('connection.connect');
    expect(config.capabilities.host.filter((name: string) => name.startsWith('native.diagnostics.'))).toEqual(['native.diagnostics.status']);
    expect(readFileSync(path.join(first, fixture.entry), 'utf8')).toBe(`import ${JSON.stringify(path.join(root, 'App.tsx'))};\n`);
    expect(path.dirname(fixture.host)).toBe(first);
  });
  expect(existsSync(first)).toBe(false);
  expect(() => withQuotaProductionFixture(root, (fixture: Fixture) => { second = fixture.directory; throw new Error('Deliberate quota fixture failure'); })).toThrow('Deliberate quota fixture failure');
  expect(first).not.toBe(second); expect(existsSync(second)).toBe(false);
  expect(readFileSync(path.join(root, 'nsh.json'), 'utf8')).toBe(production);
});

type EngineCase = 'opencode' | 'ollama' | 'cursor' | 'visibility-host' | 'non-first-worktree';
function engineScript(testCase: EngineCase) {
  const pairs = { opencode: ['OpenCode', 'opencode-go'], ollama: ['Ollama', 'ollama-cloud'], cursor: ['Cursor', 'cursor'] };
  const body = testCase === 'visibility-host' ? 'await quotaVisibilityAndHost(app, audit, expect, active => host.setForeground(active));'
    : testCase === 'non-first-worktree' ? 'await quotaScopedSettings(app, audit, expect, scenario);'
      : `await quotaRoundTrip(app, audit, expect, scenario, ${JSON.stringify(pairs[testCase][0])}, ${JSON.stringify(pairs[testCase][1])});`;
  return `import { test, open, expect } from 'nsh/test';
import { createHost } from './host.js';
${openQuotaProvider.toString()}
${quotaRoundTrip.toString()}
${quotaVisibilityAndHost.toString()}
${quotaScopedSettings.toString()}
test('production quota: ${testCase}', async () => {
  const host = createHost();
  const audit = () => host.call('quotaProduction.fixture.audit', {});
  const scenario = mode => host.call('quotaProduction.fixture.scenario', { mode });
  const handlers = Object.fromEntries(${JSON.stringify(quotaProductionCapabilities)}.map(name => [name, input => host.call(name, input)]));
  const app = await open(${JSON.stringify(testCase === 'non-first-worktree' ? './App.tsx' : './RootSettings.tsx')}, { storage: { language: 'en' }, host: { handlers } });
  try {
    await app.waitUntil(() => audit().configurations.length > 0 && audit().nativeCounts['native.diagnostics.status'] === 1);
    ${body}
    expect(audit().rejected).toEqual([]);
    expect(audit().requests.filter(row => row.path === '/api/yuri/history-import/job' || row.path === '/api/yuri/history-import/scan')).toHaveLength(0);
    for (const row of audit().requests.filter(row => row.path.startsWith('/api/yuri/history-import/'))) {
      expect(row.resource).toBe('/api/yuri/history-import/jobs');
      expect(row.method).toBe('GET');
      expect(row.expectedHost).toEqual(row.runtimeScope);
    }
    expect(app.requests()).toEqual([]);
    expect(app.openedUrls()).toEqual([]);
    expect(app.shows('id:notification-root-feedback')).toBe(false);
    expect(app.texts().join('\\n')).not.toMatch(/Unexpected quota|ReferenceError|TypeError|capability.*denied/i);
  } finally { app.dispose(); }
}, 90000);
`;
}

it('statically compiles every prepared driver plus the real App → Providers → sole quota page graph, without running NSH', () => {
  withQuotaProductionFixture(root, (fixture: Fixture) => {
    const entries = ['opencode', 'ollama', 'cursor', 'visibility-host', 'non-first-worktree'].map(testCase => {
      const entry = testCase + '.test.ts', source = engineScript(testCase as EngineCase);
      const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 }, reportDiagnostics: true });
      expect(output.diagnostics ?? []).toEqual([]); writeFileSync(path.join(fixture.directory, entry), source); return entry;
    });
    const metadata = path.join(fixture.directory, 'graph.json');
    const result = spawnSync('bun', ['build', fixture.entry, 'RootSettings.tsx', ...entries, '--target=browser', '--external=nsh', '--external=nsh/*', '--metafile=' + metadata, '--outdir', path.join(fixture.directory, 'graph')], { cwd: fixture.directory, encoding: 'utf8', timeout: 30_000 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
    const graph = JSON.parse(readFileSync(metadata, 'utf8')) as { inputs: Record<string, { imports: Array<{ original?: string }> }>; outputs: Record<string, { imports: Array<{ path: string; external?: boolean }> }> };
    const files = Object.keys(graph.inputs);
    for (const file of ['App.tsx', 'application.tsx', 'settings.tsx', 'settings-collections.tsx', 'settings-providers.tsx', 'settings-quota-credentials.tsx', 'state.ts']) expect(files.some(value => value.endsWith('/' + file))).toBe(true);
    expect(files.filter(file => /\/node_modules\/(?:\.bun\/)?(?:react(?:-dom)?(?:@|\/)|zustand(?:@|\/)|@tanstack\/react-query\/)/.test(file))).toEqual([]);
    expect(Object.values(graph.inputs).flatMap(file => file.imports.filter(item => item.original?.startsWith('@/')))).toEqual([]);
    expect(Object.values(graph.outputs).flatMap(file => file.imports.filter(item => item.external && item.path !== 'nsh' && !item.path.startsWith('nsh/')))).toEqual([]);
  });
});

// Main runs these serially. Default and all pure/static checks never start an NSH engine.
const engine = it.skipIf(process.env.NSH_QUOTA_PRODUCTION_ENGINE !== '1');
for (const testCase of ['opencode', 'ollama', 'cursor', 'visibility-host', 'non-first-worktree'] as const) engine(`prepared actual production navigation: ${testCase} (headless only, not UIKit)`, () => {
  withQuotaProductionFixture(root, (fixture: Fixture) => {
    const entry = 'quota-production.test.ts';
    writeFileSync(path.join(fixture.directory, entry), engineScript(testCase));
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', entry], { cwd: fixture.directory, encoding: 'utf8', timeout: 110_000 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
  });
}, 125_000);
