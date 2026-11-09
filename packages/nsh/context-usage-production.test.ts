import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readContextUsageMetadata } from './context-usage-authority';
import { createContextUsageOwner } from './context-usage-core';
import { contextUsageSnapshotFromChat } from './context-usage-source';
import { messagesFrom } from './model';
import { createNotificationSettingsTransport } from './notification-preferences-core';
import { appearanceFromSettings, createNativeAppearanceSync, nativeTypographyStyle, type AppliedNativeAppearance } from './appearance-core';
import { createAboutDiagnosticsRoot } from './settings-about-diagnostics';
import { bindRequest, connectionSnapshotFrom, connections, request as unboundRequest } from './runtime';
import type { RuntimeScope } from './runtime-scope';

const runtimeBridge = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('nsh', () => ({ host: { available: () => true, call: runtimeBridge.call } }));

const root = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(root, 'tests/context-usage-production');
type Reply = { status: number; body: unknown };
type Audit = { auditSequence: number; historyReads: number; metadataReads: number; catalogReads: number; goalReads: number; mutations: number; deltas: number; rejected: unknown[]; streams: unknown[]; stops: unknown[]; admittedStreams: unknown[]; admittedStops: unknown[]; notificationConfigurations: unknown[]; appearanceApplies: number; diagnosticsStatusReads: number; requests: Array<{ path: string; method: string; expectedHost?: RuntimeScope }> };
type Host = { call(name: string, input?: Record<string, unknown>): unknown };
let temporary: string, hostSource: string;

beforeAll(() => {
  const parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true }); temporary = mkdtempSync(path.join(parent, 'context-production-'));
  const output = path.join(temporary, 'host.cjs');
  const built = spawnSync('bun', ['build', path.join(fixture, 'host.js'), '--target=browser', '--format=cjs', '--outfile', output], { encoding: 'utf8', timeout: 30_000 });
  expect(built.error, built.stdout + built.stderr).toBeUndefined(); expect(built.status, built.stdout + built.stderr).toBe(0);
  hostSource = readFileSync(output, 'utf8');
});
afterAll(() => { if (temporary) rmSync(temporary, { recursive: true, force: true }); });

function syntheticHost() {
  const events: Array<{ name: string; value: unknown }> = [];
  const context = vm.createContext({ module: { exports: {} }, URL: undefined, URLSearchParams: undefined });
  vm.runInContext(hostSource, context);
  const factory = vm.runInContext('module.exports.createHost', context) as (player: { hostEvent: (name: string, value: unknown) => void }) => Host;
  const host = factory({ hostEvent: (name, value) => events.push({ name, value }) });
  const send = (resource: string, method = 'GET', body?: unknown, expectedHost?: RuntimeScope) => host.call('runtime.request', { path: resource, method, ...(body === undefined ? {} : { body }), ...(expectedHost === undefined ? {} : { expectedHost }) }) as Reply;
  const audit = () => host.call('context.production.audit', {}) as Audit;
  return { host, send, audit, events };
}

describe('production-context strict synthetic Host (pure VM; not production navigation)', () => {
  it('serves only exact scoped background jobs without tour job/scan or Chat history reads', () => {
    const { host, send, audit } = syntheticHost();
    const captured = connectionSnapshotFrom(host.call('connection.list')).runtimeScope!;
    expect(send('/api/yuri/history-import/jobs', 'GET', undefined, captured)).toEqual({ status: 200, body: [] });
    expect(audit()).toMatchObject({ historyReads: 0, mutations: 0, streams: [], rejected: [], requests: [
        { path: '/api/yuri/history-import/jobs', method: 'GET', expectedHost: captured },
    ] });
  });
  it('rejects background-import query/body/write/prefix drift and retired scopes without broadening read admission', () => {
    const { host, send, audit } = syntheticHost();
    const first = connectionSnapshotFrom(host.call('connection.list')).runtimeScope!;
    for (const path of ['/api/yuri/history-import/jobs']) {
      expect(() => send(path)).toThrow('runtime_host_scope_required');
      for (const query of ['?', '?id=unknown', '?directory=%2Ffixture%2Factual', '?x=1', '?x=1&x=1']) expect(() => send(path + query, 'GET', undefined, first)).toThrow();
      for (const body of [null, {}, [], '']) expect(() => send(path, 'GET', body, first)).toThrow('Unexpected context read body');
      expect(() => host.call('runtime.request', { path, method: 'GET', expectedHost: first, body: undefined })).toThrow('Unexpected context history import read body');
      expect(() => host.call('runtime.request', { path, method: 'GET', expectedHost: { ...first, extra: true } })).toThrow('runtime_host_scope_invalid');
      expect(() => host.call('runtime.request', { path, method: 'GET', expectedHost: first, extra: true })).toThrow('Invalid context request keys/method');
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(() => send(path, method, {}, first)).toThrow('forbids mutation');
    }
    for (const suffix of ['job', 'scan', 'imported', 'start', 'resume', 'cancel', 'dismiss', 'job/unknown', 'jobs/unknown', 'unknown']) {
      const path = '/api/yuri/history-import/' + suffix;
      expect(() => send(path, 'GET', undefined, first)).toThrow('Unexpected context production request');
      expect(() => send(path, 'POST', {}, first)).toThrow('forbids mutation');
    }
    host.call('connection.select', { id: 'context-other' });
    const second = connectionSnapshotFrom(host.call('connection.list')).runtimeScope!;
    host.call('connection.select', { id: 'context-production' });
    const before = audit().requests.length;
    for (const retired of [first, second]) for (const suffix of ['job', 'jobs']) expect(() => send('/api/yuri/history-import/' + suffix, 'GET', undefined, retired)).toThrow('runtime_host_scope_stale');
    expect(audit().requests).toHaveLength(before); expect(audit().historyReads).toBe(0);
    const current = connectionSnapshotFrom(host.call('connection.list')).runtimeScope!;
    expect(send('/api/yuri/history-import/jobs', 'GET', undefined, current)).toEqual({ status: 200, body: [] });
  });
  it('admits exact scoped global/chat stream and keyed stop payloads; malformed/stale A→B→A calls never reach stream ownership (forwarding only)', () => {
    const { host, audit } = syntheticHost();
    const first = connectionSnapshotFrom(host.call('connection.list')).runtimeScope!;
    const stream = (key: 'global' | 'chat', expectedHost: RuntimeScope) => ({ key, path: key === 'global' ? '/api/yuri/events' : '/api/event?directory=%2Ffixture%2Factual', expectedHost, ...(key === 'chat' ? { mode: 'sse', ownerID: 'fixture-chat' } : {}) });
    for (const key of ['global', 'chat'] as const) {
      expect(host.call('runtime.stream', stream(key, first))).toBe(true);
      expect(host.call('runtime.stop', { key, expectedHost: first, ...(key === 'chat' ? { ownerID: 'fixture-chat' } : {}) })).toBe(true);
    }
    const before = audit();
    for (const name of ['runtime.stream', 'runtime.stop']) {
      const payload = name === 'runtime.stream' ? stream('chat', first) : { key: 'chat', expectedHost: first, ownerID: 'fixture-chat' };
      for (const expectedHost of [null, undefined, {}, [], { ...first, extra: true }, { hostID: first.hostID }, { ...first, lease: 'invalid' }]) expect(() => host.call(name, { ...payload, expectedHost })).toThrow('runtime_host_scope_invalid');
      const { expectedHost: _scope, ...unbound } = payload;
      expect(() => host.call(name, unbound)).toThrow('runtime_host_scope_required');
      for (const extra of [{ extra: true }, { hostID: first.hostID }, { lease: first.lease }, { scope: first }]) expect(() => host.call(name, { ...payload, ...extra })).toThrow('Unexpected context stream');
      expect(() => host.call(name, { ...payload, key: 'context-overview' })).toThrow('Unexpected context stream');
    }
    expect(() => host.call('runtime.stop', { expectedHost: first })).toThrow('Unexpected context stream stop');
    expect(() => host.call('runtime.stop', { key: 'chat', path: '/api/event', expectedHost: first })).toThrow('Unexpected context stream stop');
    expect(() => host.call('runtime.stream', { ...stream('global', first), path: '/api/event?directory=%2Ffixture%2Factual' })).toThrow('Unexpected context stream');
    expect(() => host.call('runtime.stream', { ...stream('chat', first), path: '/api/event?directory=%2Ffixture%2Fdecoy' })).toThrow('Unexpected context stream');
    host.call('connection.select', { id: 'context-other' });
    const second = connectionSnapshotFrom(host.call('connection.list')).runtimeScope!;
    for (const key of ['global', 'chat'] as const) {
      expect(() => host.call('runtime.stream', stream(key, first))).toThrow('runtime_host_scope_stale');
      expect(() => host.call('runtime.stop', { key, expectedHost: first })).toThrow('runtime_host_scope_stale');
    }
    host.call('connection.select', { id: 'context-production' });
    const third = connectionSnapshotFrom(host.call('connection.list')).runtimeScope!;
    for (const retired of [first, second]) {
      expect(() => host.call('runtime.stream', stream('chat', retired))).toThrow('runtime_host_scope_stale');
      expect(() => host.call('runtime.stop', { key: 'chat', expectedHost: retired })).toThrow('runtime_host_scope_stale');
    }
    expect(audit().admittedStreams).toEqual(before.admittedStreams); expect(audit().admittedStops).toEqual(before.admittedStops);
    expect(audit().requests).toEqual([]); expect(audit().historyReads).toBe(0);
    expect(host.call('runtime.stream', stream('chat', third))).toBe(true);
    expect(host.call('runtime.stop', { key: 'chat', expectedHost: third, ownerID: 'fixture-chat' })).toBe(true);
    expect(audit().admittedStreams).toHaveLength(3); expect(audit().admittedStops).toHaveLength(3);
  });
  it('captures the real runtime request wrapper once and forwards that same lease across A→B→A without refreshing authority', async () => {
    const { host, audit } = syntheticHost();
    runtimeBridge.call.mockImplementation(async (name, input) => host.call(name, input));
    try {
      const first = await connections();
      expect(first.selected).toBe('context-production');
      expect(first.runtimeScope).toEqual({ hostID: 'context-production', lease: '00000000-0000-4000-8000-000000000001' });
      expect(await connections()).toEqual(first);
      runtimeBridge.call.mockClear();
      const ownerA = bindRequest(first.runtimeScope);
      expect(runtimeBridge.call).not.toHaveBeenCalled();
      await ownerA('/api/session/context-actual?directory=%2Ffixture%2Factual');
      const captured = runtimeBridge.call.mock.calls[0][1].expectedHost;
      expect(captured).toEqual(first.runtimeScope); expect(Object.isFrozen(captured)).toBe(true);
      expect(runtimeBridge.call.mock.calls[0]).toEqual(['runtime.request', { path: '/api/session/context-actual?directory=%2Ffixture%2Factual', method: 'GET', expectedHost: first.runtimeScope }]);
      const goal = '/api/rpc/opencode.goal/get?location%5Bdirectory%5D=%2Ffixture%2Factual', body = { input: { sessionID: 'context-actual' } };
      await ownerA(goal, 'POST', body);
      expect(runtimeBridge.call.mock.calls[1][1].expectedHost).toBe(captured);
      host.call('connection.select', { id: 'context-other' });
      const second = await connections();
      expect(second.runtimeScope).toEqual({ hostID: 'context-other', lease: '00000000-0000-4000-8000-000000000002' });
      const ownerB = bindRequest(second.runtimeScope), beforeRejected = audit().requests.length;
      runtimeBridge.call.mockClear();
      await expect(ownerA('/api/config/settings')).rejects.toThrow('runtime_host_scope_stale');
      await expect(ownerA(goal, 'POST', body)).rejects.toThrow('runtime_host_scope_stale');
      expect(audit().requests).toHaveLength(beforeRejected);
      expect(runtimeBridge.call.mock.calls.every(([name, input]) => name === 'runtime.request' && input.expectedHost === captured)).toBe(true);
      await ownerB('/api/config/settings');
      host.call('connection.select', { id: 'context-production' });
      const third = await connections();
      expect(third.runtimeScope).toEqual({ hostID: 'context-production', lease: '00000000-0000-4000-8000-000000000003' });
      expect(await connections()).toEqual(third);
      runtimeBridge.call.mockClear();
      const afterReturn = audit().requests.length;
      await expect(ownerA('/api/config/settings')).rejects.toThrow('runtime_host_scope_stale');
      await expect(ownerA(goal, 'POST', body)).rejects.toThrow('runtime_host_scope_stale');
      await expect(ownerB('/api/config/settings')).rejects.toThrow('runtime_host_scope_stale');
      expect(audit().requests).toHaveLength(afterReturn);
      expect(runtimeBridge.call.mock.calls.map(([name]) => name)).toEqual(['runtime.request', 'runtime.request', 'runtime.request']);
      expect(runtimeBridge.call.mock.calls[0][1].expectedHost).toBe(captured);
      await bindRequest(third.runtimeScope)(goal, 'POST', body);
      expect(audit()).toMatchObject({ goalReads: 2, mutations: 0 });
    } finally { runtimeBridge.call.mockReset(); }
  });
  it('rejects strict request/scope drift and unbound non-GET, while legacy unbound GET remains read-only', async () => {
    const { host, send, audit } = syntheticHost();
    const snapshot = connectionSnapshotFrom(host.call('connection.list'));
    expect(snapshot.runtimeScope).not.toBeNull();
    const expectedHost = snapshot.runtimeScope!;
    const resource = '/api/config/settings';
    expect(send(resource).status).toBe(200); expect(send(resource, 'GET', undefined, expectedHost).status).toBe(200);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(() => send(resource, method, {})).toThrow('runtime_host_scope_required');
    expect(() => send('/api/rpc/opencode.goal/get?location%5Bdirectory%5D=%2Ffixture%2Factual', 'POST', { input: { sessionID: 'context-actual' } })).toThrow('runtime_host_scope_required');
    const before = audit().requests.length;
    for (const value of [null, undefined, [], {}, { ...expectedHost, lease: '' }, { ...expectedHost, lease: 'not-a-lease' }, { ...expectedHost, extra: true }, { hostID: expectedHost.hostID }, { lease: expectedHost.lease }]) {
      expect(() => host.call('runtime.request', { path: resource, method: 'GET', expectedHost: value })).toThrow('runtime_host_scope_invalid');
    }
    for (const value of [{ hostID: 'context-other', lease: expectedHost.lease }, { ...expectedHost, lease: '00000000-0000-4000-8000-000000000999' }]) expect(() => host.call('runtime.request', { path: resource, method: 'GET', expectedHost: value })).toThrow('runtime_host_scope_stale');
    for (const extra of [{ hostID: expectedHost.hostID }, { lease: expectedHost.lease }, { scope: expectedHost }, { expectedHost, extra: true }]) expect(() => host.call('runtime.request', { path: resource, method: 'GET', ...extra })).toThrow('Invalid context request keys/method');
    expect(audit().requests).toHaveLength(before); expect(audit().mutations).toBe(0);
    runtimeBridge.call.mockImplementation(async (name, input) => host.call(name, input));
    try {
      runtimeBridge.call.mockClear();
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) await expect(unboundRequest(resource, method, {})).rejects.toThrow('scope_required');
      expect(runtimeBridge.call).not.toHaveBeenCalled();
      await unboundRequest(resource); expect(runtimeBridge.call).toHaveBeenCalledExactlyOnceWith('runtime.request', { path: resource, method: 'GET' });
    } finally { runtimeBridge.call.mockReset(); }
  });
  it('snapshot reads do not mint or mutate leases, and missing/null scope stays explicitly read-only in the real parser', () => {
    const { host } = syntheticHost();
    const first = connectionSnapshotFrom(host.call('connection.list'));
    expect(connectionSnapshotFrom({ ...first, runtimeScope: null }).runtimeScope).toBeNull();
    const { runtimeScope: _scope, ...legacy } = first;
    expect(connectionSnapshotFrom(legacy).runtimeScope).toBeNull();
    expect(() => connectionSnapshotFrom({ ...first, runtimeScope: { ...first.runtimeScope, extra: true } })).toThrow('invalid_runtime_scope');
    expect(() => connectionSnapshotFrom({ ...first, runtimeScope: { hostID: 'context-other', lease: first.runtimeScope!.lease } })).toThrow('Invalid connection runtime scope');
    const raw = host.call('connection.list') as { runtimeScope: { hostID: string; lease: string } };
    raw.runtimeScope.lease = '00000000-0000-4000-8000-000000000999';
    expect(connectionSnapshotFrom(host.call('connection.list'))).toEqual(first);
    expect(() => host.call('connection.select', { id: 'unknown' })).toThrow('Invalid context connection selection');
    expect(connectionSnapshotFrom(host.call('connection.list'))).toEqual(first);
  });
  it('supplies the complete Swift-shaped font result to the real root appearance sync, without querying OS fonts', async () => {
    const { host, send, audit } = syntheticHost();
    let applied: AppliedNativeAppearance | null = null;
    const errors: string[] = [];
    const sync = createNativeAppearanceSync({ readSettings: async () => send('/api/config/settings').body, readThemes: async () => send('/api/config/themes').body,
      reset: async scope => (host.call('appearance.reset', { hostID: scope?.hostID ?? null }) as { revision: number }).revision,
      apply: async (scope, revision, appearance) => host.call('appearance.apply', { hostID: scope.hostID, revision, mode: appearance.mode, cssVars: appearance.cssVars, fonts: appearance.fonts }) as Pick<AppliedNativeAppearance, 'uiFontFamily' | 'monoFontFamily' | 'assistantFontFamilies' | 'unsupportedFonts' | 'systemColorScheme'>,
      changed: value => { applied = value; }, failed: error => { if (error) errors.push(error); },
    });
    sync.setScope({ hostID: 'context-production', generation: 1, url: 'https://host.example' }); await sync.refresh();
    expect(errors).toEqual([]);
    expect(applied).toMatchObject({ uiFontFamily: 'system-ui', monoFontFamily: 'monospace', assistantFontFamilies: { light: 'monospace', dark: 'system-ui' }, systemColorScheme: 'light' });
    expect(nativeTypographyStyle(applied, 'markdown').fontFamily).toBe('system-ui');
    expect(audit()).toMatchObject({ appearanceApplies: 1, mutations: 0, rejected: [] });
  });
  it('fences appearance revisions and rejects malformed palettes/fonts/scope instead of accepting a blanket apply', async () => {
    const { host, send, audit } = syntheticHost();
    const appearance = await appearanceFromSettings(send('/api/config/settings').body, async () => send('/api/config/themes').body);
    const payload = { hostID: 'context-production', revision: 1, mode: appearance.mode, cssVars: appearance.cssVars, fonts: appearance.fonts };
    expect(() => host.call('appearance.apply', payload)).toThrow('Invalid context appearance apply');
    expect(host.call('appearance.reset', { hostID: null })).toEqual({ revision: 1 });
    for (const reset of [{}, { hostID: 'another-host' }, { hostID: null, extra: true }]) expect(() => host.call('appearance.reset', reset)).toThrow('Invalid context appearance reset');
    for (const value of [{}, { ...payload, hostID: 'another-host' }, { ...payload, revision: true }, { ...payload, revision: 0 },
      { ...payload, mode: 'unknown' }, { ...payload, cssVars: { light: appearance.cssVars.light } },
      { ...payload, cssVars: { ...appearance.cssVars, light: { ...appearance.cssVars.light, foreground: 'red' } } },
      { ...payload, cssVars: { ...appearance.cssVars, light: { ...appearance.cssVars.light, extra: '#ffffff' } } },
      { ...payload, fonts: { ...appearance.fonts, ui: 'bad; font' } }, { ...payload, fonts: { ...appearance.fonts, ui: 'A'.repeat(65) } },
      { ...payload, fonts: { ...appearance.fonts, extra: 'system-ui' } }, { ...payload, extra: true },
    ]) expect(() => host.call('appearance.apply', value)).toThrow('Invalid context appearance apply');
    expect(host.call('appearance.apply', { ...payload, fonts: { ui: 'Unavailable UI', mono: 'Unavailable Mono', assistantLight: 'Unavailable UI', assistantDark: 'Unavailable Assistant' } })).toEqual({
      uiFontFamily: 'system-ui', monoFontFamily: 'monospace', assistantFontFamilies: { light: 'system-ui', dark: 'system-ui' },
      unsupportedFonts: ['Unavailable Assistant', 'Unavailable Mono', 'Unavailable UI'], systemColorScheme: 'light',
    });
    expect(host.call('appearance.reset', { hostID: 'context-production' })).toEqual({ revision: 2 });
    expect(() => host.call('appearance.apply', payload)).toThrow('Invalid context appearance apply');
    expect(audit().appearanceApplies).toBe(1);
  });
  it('reports disabled diagnostics v2 to the real root; events never enable recording or append', async () => {
    const { host, audit } = syntheticHost();
    const expected = { schemaVersion: 2, mode: 'event-recorder', enabled: false, recordingLease: null, eventCount: 0, maxEntries: 500, maxBytes: 262144 };
    expect(host.call('native.diagnostics.status', {})).toEqual(expected);
    const scope = { hostID: 'context-production', generation: 1 };
    const root = createAboutDiagnosticsRoot({ scope: () => scope, call: async (name, body) => host.call(name, body) });
    try {
      await root.refresh();
      root.onEvent({ key: 'global', type: 'session.execution.succeeded', body: { sessionID: 'context-actual' }, directory: '/fixture/actual' }, scope);
      root.onEvent({ key: 'chat', type: 'session.text.delta', body: { sessionID: 'context-actual', delta: 'Synthetic token' }, directory: '/fixture/actual' }, scope);
      await root.flush();
      expect(audit()).toMatchObject({ diagnosticsStatusReads: 2, mutations: 0, rejected: [] });
    } finally { root.dispose(); }
    for (const value of [{ enabled: true }, { hostID: scope.hostID }, { lease: 'unexpected' }]) expect(() => host.call('native.diagnostics.status', value)).toThrow('Unexpected context control arguments');
    for (const name of ['native.diagnostics.setEnabled', 'native.diagnostics.append', 'native.diagnostics.export', 'native.diagnostics.unknown']) expect(() => host.call(name, {})).toThrow('Unexpected context production native call');
    expect(host.call('native.diagnostics.status')).toEqual(expected);
  });
  it('accepts the real root notification transport default with an idempotent safe lease, without permission or OS calls', async () => {
    const { host, send, audit } = syntheticHost();
    const scope = { hostID: 'context-production', generation: 1 };
    const transport = createNotificationSettingsTransport({ scope: () => scope, language: () => 'en',
      read: async () => send('/api/config/settings').body,
      write: async () => { throw new Error('Notification fixture must not write settings'); },
      call: async (name, body) => host.call(name, body),
    });
    await transport.refresh(); await transport.refresh();
    expect(transport.confirmed()).toEqual({ scope, preferences: {} });
    expect(audit()).toMatchObject({ mutations: 0, rejected: [], notificationConfigurations: [
      { hostID: scope.hostID, enabled: false, mode: 'hidden-only', language: 'en', events: ['completion', 'error', 'question', 'permission', 'schedule', 'assistant', 'goal'] },
      { hostID: scope.hostID, enabled: false, mode: 'hidden-only', language: 'en', events: ['completion', 'error', 'question', 'permission', 'schedule', 'assistant', 'goal'] },
    ] });
    expect(transport.delivery.route({ hostID: scope.hostID, lease: 'context-production-notification-lease', target: { kind: 'session', id: 'context-actual' } })).toEqual({ kind: 'session', id: 'context-actual' });
  });
  it('rejects notification scope/shape/event drift and every non-configure notification capability', () => {
    const { host, audit } = syntheticHost();
    const configuration = { hostID: 'context-production', enabled: false, mode: 'hidden-only', language: 'en', events: ['completion', 'error', 'question', 'permission', 'schedule', 'assistant', 'goal'] };
    for (const value of [undefined, null, [], {}, { ...configuration, hostID: 'another-host' }, { ...configuration, enabled: true }, { ...configuration, enabled: 0 },
      { ...configuration, mode: 'always' }, { ...configuration, language: 'unknown' }, { ...configuration, events: [] },
      { ...configuration, events: [...configuration.events.slice(0, -1), 'completion'] }, { ...configuration, events: [...configuration.events.slice(0, -1), 'unknown'] },
      { ...configuration, token: 'unexpected-field' }, { ...configuration, lease: 'unexpected-field' },
    ]) expect(() => host.call('notification.configure', value as Record<string, unknown> | undefined)).toThrow('Invalid context notification configuration');
    for (const name of ['notification.status', 'notification.request', 'notification.openSettings', 'notification.live', 'notification.test', 'notification.unknown']) expect(() => host.call(name, {})).toThrow('Unexpected context production native call');
    expect(audit().notificationConfigurations).toEqual([]);
    expect(host.call('notification.configure', configuration)).toEqual({ lease: 'context-production-notification-lease' });
    expect(host.call('notification.configure', { ...configuration, events: [...configuration.events].reverse() })).toEqual({ lease: 'context-production-notification-lease' });
  });
  it('drives real wire adapters with the actual second session/catalog, retaining unknown metrics and future JSON', async () => {
    const { send, audit } = syntheticHost();
    const scope = { hostID: 'context-production', generation: 1, sessionID: 'context-actual', directory: '/fixture/actual' };
    const metadata = await readContextUsageMetadata({ scope, read: async resource => send(resource).body });
    const page = messagesFrom(send('/api/session/context-actual/message?directory=%2Ffixture%2Factual&limit=20&order=desc').body);
    const snapshot = contextUsageSnapshotFromChat({ scope, ...metadata, messages: page.messages, messagesResolved: true });
    const owner = createContextUsageOwner(scope, { current: () => true, showAssistantTps: true }); owner.reset(snapshot);
    expect(owner.view()).toMatchObject({ sessionTitle: 'Actual context conversation', messagesCount: 2, providerModel: { providerName: 'Actual provider', modelName: 'Actual model', contextLimit: 400000 } });
    expect(owner.known()).toMatchObject({ cost: false, tokens: { total: false, input: false, output: true, cacheRead: false, cacheWrite: false } });
    expect(owner.view()?.sessionTpsLabel).toBeNull(); expect(owner.view()?.lastAssistantTpsLabel).toBeNull();
    expect(JSON.parse(owner.json('context-assistant'))).toMatchObject({ futureWireField: { retained: true } });
    expect(audit()).toMatchObject({ historyReads: 1, metadataReads: 1, catalogReads: 1, mutations: 0, rejected: [], streams: [] });
  });
  it('uses real hostEvent for synthetic tokens; no route, state, owner or second event channel is supplied by the fixture', () => {
    const { host, events, audit, send } = syntheticHost();
    const expectedHost = connectionSnapshotFrom(host.call('connection.list')).runtimeScope!;
    host.call('runtime.stream', { key: 'chat', path: '/api/event?directory=%2Ffixture%2Factual', expectedHost, mode: 'sse', ownerID: 'actual-stream-ticket' });
    host.call('context.production.delta', {});
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ name: 'runtime.event', value: { type: 'reconnected', ownerID: 'actual-stream-ticket', expectedHost } });
    expect(events[1].name).toBe('runtime.event');
    const value = events[1].value as { key: string; data: string };
    expect(value.key).toBe('chat'); expect(JSON.parse(value.data)).toEqual({ type: 'session.text.delta', data: { sessionID: 'context-actual', assistantMessageID: 'context-assistant', parentID: 'context-user', ordinal: 0, delta: ' synthetic-token-1' }, location: { directory: '/fixture/actual' } });
    const page = messagesFrom(send('/api/session/context-actual/message?directory=%2Ffixture%2Factual&limit=20&order=desc').body);
    expect(page.messages[1].text).toBe('Synthetic answer synthetic-token-1'); expect(audit().streams).toHaveLength(1);
  });
  it('a failed history response is a 503, not empty success; only the next read recovers the same rows', () => {
    const { host, send, audit } = syntheticHost();
    const resource = '/api/session/context-actual/message?directory=%2Ffixture%2Factual&limit=20&order=desc';
    const prior = send(resource); host.call('context.production.failHistory', {});
    expect(send(resource)).toEqual({ status: 503, body: { error: 'Synthetic context history unavailable' } });
    expect(send(resource)).toEqual(prior); expect(audit()).toMatchObject({ historyReads: 3, mutations: 0, rejected: [] });
  });
  it('fails closed for guessed scope, pagination, absolute URLs, malformed query/body, unrelated calls and all writes', () => {
    const { host, send, audit } = syntheticHost();
    for (const resource of [
      'https://host.example/api/config/settings', '//host.example/api/config/settings', '/api/config/settings?', '/api/config/settings#fragment',
      '/api/config/settings?x=1', '/api/config/settings?x=1?y=2',
      '/api/session/context-decoy?directory=%2Ffixture%2Fdecoy',
      '/api/config/catalog/providers?directory=%2Ffixture%2Fdecoy',
      '/api/config/catalog/providers?directory=%2Ffixture%2Factual&directory=%2Ffixture%2Factual',
      '/api/config/catalog/providers?directory=%ZZ',
      '/api/session/context-actual/message?directory=%2Ffixture%2Factual&limit=20&order=desc&cursor=opaque',
      '/api/session/context-actual/message/guessed?directory=%2Ffixture%2Factual',
    ]) expect(() => send(resource), resource).toThrow();
    expect(() => send('/api/config/settings', 'GET', {})).toThrow();
    expect(() => host.call('runtime.stream', { key: 'context-overview', path: '/api/event?directory=%2Ffixture%2Factual' })).toThrow();
    expect(() => host.call('context.production.delta', { sessionID: 'injected' })).toThrow();
    const captured = connectionSnapshotFrom(host.call('connection.list')).runtimeScope!;
    for (const resource of ['/api/session', '/api/session/context-actual/prompt', '/api/session/context-actual/command', '/api/fs/write']) expect(() => send(resource, 'POST', {}, captured)).toThrow('forbids mutation');
    expect(audit().mutations).toBe(4); expect(syntheticHost().audit().rejected).toEqual([]);
  });
});

it('own fixture statically bundles the unmodified production App/Chat/route without browser runtime, aliases or replacement owners (no engine)', () => {
  type Dependency = { path: string; original?: string; external?: boolean };
  type Graph = { inputs: Record<string, { imports: Dependency[] }>; outputs: Record<string, { imports: Dependency[] }> };
  const graphPath = path.join(temporary, 'graph.json');
  const built = spawnSync('bun', ['build', 'fixture.tsx', '--target=browser', '--external=nsh', '--external=nsh/*', '--metafile=' + graphPath, '--outdir', path.join(temporary, 'bundle')], { cwd: fixture, encoding: 'utf8', timeout: 30_000 });
  expect(built.error, built.stdout + built.stderr).toBeUndefined(); expect(built.status, built.stdout + built.stderr).toBe(0);
  const graph = JSON.parse(readFileSync(graphPath, 'utf8')) as Graph;
  const inputs = Object.keys(graph.inputs);
  for (const file of ['application.tsx', 'state.ts', 'context-usage-route.tsx', 'context-usage-route-core.ts', 'context-usage.tsx']) expect(inputs).toContain('../../' + file);
  expect(inputs.filter(file => /node_modules\/(?:\.bun\/)?(?:react(?:-dom)?(?:@|\/)|zustand(?:@|\/)|@tanstack\/react-query\/|@opencode-ai\/sdk\/|@capacitor\/)/.test(file))).toEqual([]);
  expect(Object.values(graph.inputs).flatMap(item => item.imports.filter(dependency => dependency.original?.startsWith('@/')))).toEqual([]);
  expect(Object.values(graph.outputs).flatMap(item => item.imports.filter(dependency => dependency.external && dependency.path !== 'nsh' && !dependency.path.startsWith('nsh/')))).toEqual([]);
  const source = readFileSync(path.join(fixture, 'fixture.tsx'), 'utf8');
  expect(source).not.toMatch(/createChat|createNavStack|ContextUsageRoute|\.routes\(|connection\.select/);
  const page = readFileSync(path.join(root, 'context-usage.tsx'), 'utf8');
  const route = readFileSync(path.join(root, 'context-usage-route.tsx'), 'utf8');
  expect(page.match(/<NavPage\b/g)).toHaveLength(1); expect(route).not.toMatch(/<NavPage\b/);
  const application = ts.createSourceFile('application.tsx', readFileSync(path.join(root, 'application.tsx'), 'utf8'), ts.ScriptTarget.ES2023, true, ts.ScriptKind.TSX);
  let overviewRoot: string | undefined;
  function findOverview(node: ts.Node) {
    if (ts.isIfStatement(node) && node.expression.getText(application) === "route.kind === 'context-usage'" && ts.isReturnStatement(node.thenStatement)) {
      const element = node.thenStatement.expression;
      if (element && ts.isJsxSelfClosingElement(element)) overviewRoot = element.tagName.getText(application);
    }
    ts.forEachChild(node, findOverview);
  }
  findOverview(application); expect(overviewRoot).toBe('ContextUsageRoute');
  const config = JSON.parse(readFileSync(path.join(fixture, 'nsh.json'), 'utf8'));
  expect(config.capabilities.host).not.toContain('connection.select');
  expect(config.capabilities.host.filter((name: string) => name.startsWith('notification.'))).toEqual(['notification.configure']);
  expect(config.capabilities.host.filter((name: string) => name.startsWith('native.diagnostics.'))).toEqual(['native.diagnostics.status']);
});

it('engine steps are syntactically valid before opt-in and use the real public keyboard entrance', () => {
  const source = ts.createSourceFile('production.test.ts', readFileSync(path.join(root, 'context-usage-production.test.ts'), 'utf8'), ts.ScriptTarget.ES2023, true);
  let steps: string[] | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'steps' && node.initializer && ts.isArrayLiteralExpression(node.initializer)) {
      steps = node.initializer.elements.map(item => { if (!ts.isStringLiteral(item)) throw new Error('Expected literal production engine step'); return item.text; });
    }
    ts.forEachChild(node, visit);
  }
  visit(source); expect(steps?.length).toBeGreaterThan(20);
  const script = steps!.join('\n');
  expect(() => new vm.Script('(async () => {\n' + script + '\n})')).not.toThrow();
  expect(script).toContain('app.keyboard.press("mod+p")');
  expect(script).not.toMatch(/pressAt|createNavStack|nav\.push|app\.evaluate|connection\.select/);
});

// Main alone opts in during its serialized engine window. Missing public entrance
// is a real failure: do not replace it with nav injection, coordinate presses or a header-ring shortcut.
it.skipIf(process.env.NSH_CONTEXT_PRODUCTION_ENGINE !== '1').each(['search', 'session-switcher'] as const)('production Projects → actual Chat → keyboard %s → command → one overview → same live Chat and draft on Back', entrance => {
  const host = path.join(temporary, 'engine-host.js');
  const built = spawnSync('bun', ['build', path.join(fixture, 'host.js'), '--target=browser', '--outfile', host], { encoding: 'utf8', timeout: 30_000 });
  expect(built.error, built.stdout + built.stderr).toBeUndefined(); expect(built.status, built.stdout + built.stderr).toBe(0);
  const steps = [
    'const inspect = async () => { const prior = app.texts().find(value => value.startsWith("{\\"auditSequence\\":")); const sequence = prior ? JSON.parse(prior).auditSequence : 0; await app.press("id:context-production-audit"); await app.waitUntil(() => app.texts().some(value => value.startsWith("{\\"auditSequence\\":") && JSON.parse(value).auditSequence > sequence)); return JSON.parse(app.texts().find(value => value.startsWith("{\\"auditSequence\\":"))); };',
    'const chatStreams = value => value.streams.filter(call => call.input.key === "chat").length;',
    'const chatStops = value => value.stops.filter(call => call.input.key === "chat").length;',
    'await app.waitFor("id:project-session-context-actual >> nth=0"); await app.press("id:project-session-context-actual >> nth=0");',
    'await app.waitFor("id:composer"); await app.waitFor("text:Synthetic answer");',
    'await app.type("id:composer", "Keep this exact unsent draft");',
    'const before = await inspect(); expect(chatStreams(before)).toBe(1); expect(before.rejected).toEqual([]); expect(before.notificationConfigurations.length).toBeGreaterThan(0); expect(app.shows("id:notification-root-feedback")).toBe(false);',
    'expect(before.requests.filter(call => call.path.split("?")[0] === "/api/yuri/history-import/job")).toEqual([]);',
    'await app.keyboard.press("mod+p");',
    'await app.waitFor("id:projects-global-search");',
    'await app.type("id:projects-global-search", "Show Context Usage");',
    'await app.waitFor("id:projects-search-command:show-context-usage"); await app.press("id:projects-search-command:show-context-usage");',
    'await app.waitFor("id:context-usage-total"); expect(app.count("id:context-usage-list")).toBe(1);',
    'expect(app.texts()).toContain("— / 400,000"); expect(app.texts().some(value => value.startsWith("Actual provider / Actual model"))).toBe(true);',
    'expect(app.shows("id:composer")).toBe(false); expect(app.shows("id:chat-goal-panel")).toBe(false); expect(app.shows("id:chat-header-options")).toBe(false); expect(app.shows("id:speech-context-assistant")).toBe(false);',
    'const overview = await inspect(); expect(chatStreams(overview)).toBe(chatStreams(before)); expect(chatStops(overview)).toBe(chatStops(before)); expect(overview.historyReads).toBe(before.historyReads); expect(overview.mutations).toBe(0); expect(overview.rejected).toEqual([]);',
    'await app.press("id:context-production-delta");',
    'for (let step = 0; step < 18 && !app.shows("id:context-usage-expand-context-assistant"); step++) await app.scroll("id:context-usage-list", 200);',
    'await app.waitFor("id:context-usage-expand-context-assistant"); await app.press("id:context-usage-expand-context-assistant");',
    'await app.waitFor("id:context-usage-copy-context-assistant"); await app.press("id:context-usage-copy-context-assistant");',
    'await app.waitUntil(() => app.clipboard() !== null && app.clipboard().includes("synthetic-token-1"));',
    'const raw = JSON.parse(app.clipboard()); expect(raw.received.futureWireField).toEqual({ retained: true }); expect(raw.currentContent[0].text).toContain("synthetic-token-1");',
    'const patched = await inspect(); expect(patched.historyReads).toBe(before.historyReads); expect(chatStreams(patched)).toBe(chatStreams(before)); expect(patched.mutations).toBe(0);',
    'await app.press("id:context-production-fail"); await app.waitFor("id:context-usage-error");',
    'expect(app.texts()).toContain("— / 400,000"); expect(app.texts()).toContain("Actual context conversation");',
    'await app.back(); await app.waitFor("id:composer");',
    'expect(app.value("id:composer")).toBe("Keep this exact unsent draft");',
    'await app.waitUntil(() => app.texts().some(value => value.includes("Synthetic answer synthetic-token-1")));',
    'const restored = await inspect(); expect(chatStreams(restored)).toBe(chatStreams(before)); expect(chatStops(restored)).toBe(chatStops(before)); expect(restored.mutations).toBe(0); expect(restored.rejected).toEqual([]);',
    'expect(restored.requests.filter(call => call.path.startsWith("/api/yuri/history-import/") && call.path !== "/api/yuri/history-import/jobs")).toEqual([]);',
  ];
  if (entrance === 'session-switcher') {
    const openIndex = steps.indexOf('await app.keyboard.press("mod+p");');
    steps[openIndex] = 'await app.keyboard.press("mod+b"); await app.waitFor("id:projects-open-search"); await app.press("id:projects-open-search");';
    const index = steps.indexOf('await app.back(); await app.waitFor("id:composer");');
    steps[index] = 'await app.back(); await app.waitFor("id:projects-open-search"); await app.keyboard.press("mod+b"); await app.waitFor("id:composer");';
  }
  const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'fixture.tsx', '--web-host', host], { cwd: fixture, encoding: 'utf8', input: steps.join('\n'), timeout: 90_000 });
  expect(result.error, result.stdout + result.stderr).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
}, 120_000);
