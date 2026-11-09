import { beforeEach, expect, it, vi } from 'vitest';
import { createHost as commandHost } from './tests/settings-host.js';
import { createHost as outerHost } from './tests/settings-outer-host.js';
import { createHost as collectionsHost } from './tests/settings-collections-host.js';
import { createSettingsTransaction, readSettingsCollection, settingsObject, settingsProviderModelsPatch } from './settings-protocol';
import { nativeAgentEditor } from './settings-collections-core';
import { readProviderRemovalSnapshot } from './settings-provider-removal';
import { bindRequest } from './runtime';
import { createFeaturePicker } from './features-picker-core';

const h = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('nsh', () => ({ host: { available: () => true, call: h.call } }));
beforeEach(() => { h.call.mockReset(); });
function fixture(create: typeof outerHost) {
  const host = create(), snapshot = host.call('connection.list', {});
  h.call.mockImplementation((name, input) => host.call(name, input));
  const send = bindRequest(snapshot.runtimeScope);
  return { host, send, scope: snapshot.runtimeScope, transaction: createSettingsTransaction(send, () => true) };
}

it('Agent list response and metadata hydrate the actual production editor with stored prompt and object model/variant', async () => {
  const f = fixture(collectionsHost);
  const rows = await readSettingsCollection(f.send, 'agents', '/fixture/project');
  expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ name: 'review', scope: 'project' });
  expect(await nativeAgentEditor(f.send, rows[0], '/fixture/project')).toMatchObject({ name: 'review', model: 'example/model#deep', system: 'Stored fixture prompt' });
  expect(() => f.host.call('collections.fixture.audit', { expectedHost: f.scope })).toThrow('audit payload');
  expect(() => f.host.call('settings.fixture.scopeAudit', { expectedHost: f.scope })).toThrow('audit payload');
  expect(h.call.mock.calls.filter(([name]) => name === 'runtime.request').map(([, input]) => [input.path, input.method, input.body])).toEqual([
    ['/api/agent?location%5Bdirectory%5D=%2Ffixture%2Fproject', 'GET', undefined],
    ['/api/config/agents/metadata?directory=%2Ffixture%2Fproject', 'POST', { names: ['review'] }],
    ['/api/config/agents/review/config?directory=%2Ffixture%2Fproject', 'GET', undefined],
  ]);
  expect((await readSettingsCollection(f.send, 'providers', '/fixture/project'))[0]).toMatchObject({ id: 'example', models: { model: { variants: { deep: {} } } } });
});

it('command picker catalogs and preferences load through real controllers without writing commands or preferences', async () => {
  const f = fixture(commandHost);
  expect(await readSettingsCollection(f.send, 'agents', '/native/project')).toEqual([
    { name: 'build', mode: 'primary', scope: 'user', document: undefined },
    { name: 'plan', mode: 'primary', scope: 'user', document: undefined },
  ]);
  expect(await readSettingsCollection(f.send, 'providers', '/native/project')).toEqual([
    { id: 'example', name: 'Example provider', models: { model: { name: 'Example model', variants: { deep: {} }, capabilities: { tools: true, input: ['text'] } } } },
  ]);
  const picker = createFeaturePicker({ request: f.send, current: () => true, changed() {}, select() { throw new Error('Reading catalogs must not select a model'); }, close() {} });
  await picker.load();
  expect(picker.loaded()).toBe(true); expect(picker.error()).toBe('');
  expect(picker.preferences()).toEqual({ favoriteModels: [], recentModels: [], hiddenModels: [], chatRenderMode: 'sorted', messageStreamTransport: 'sse', diffLayoutPreference: 'inline' });
  expect(await f.send('/fixture/commands/audit')).toEqual({ attempts: 0 });
  expect(h.call.mock.calls.filter(([name, input]) => name === 'runtime.request' && !['GET', 'POST'].includes(input.method))).toHaveLength(0);
  expect(h.call.mock.calls.filter(([name, input]) => name === 'runtime.request' && input.method === 'POST').map(([, input]) => [input.path, input.body])).toEqual([
    ['/api/config/agents/metadata?directory=%2Fnative%2Fproject', { names: ['build', 'plan'] }],
  ]);
  for (const [route, method, body] of [
    ['/api/config/catalog/providers?directory=%2Fother', 'GET', undefined],
    ['/api/config/catalog/providers?directory=%2Fnative%2Fproject&extra=1', 'GET', undefined],
    ['/api/config/catalog/providers?directory=%2Fnative%2Fproject', 'POST', {}],
    ['/api/agent?directory=%2Fnative%2Fproject', 'GET', undefined],
    ['/api/agent?location%5Bdirectory%5D=%2Fother', 'GET', undefined],
    ['/api/config/agents/metadata?directory=%2Fnative%2Fproject', 'GET', undefined],
    ['/api/config/agents/metadata?directory=%2Fnative%2Fproject', 'POST', { names: ['other'] }],
    ['/api/config/agents/metadata?directory=%2Fnative%2Fproject', 'POST', { names: ['build', 'plan'], extra: true }],
    ['/api/config/settings', 'PUT', { recentModels: [] }],
    ['/api/config/settings?directory=%2Fnative%2Fproject', 'GET', undefined],
    ['/api/config/settings', 'GET', {}],
  ] as const) await expect(f.send(route, method, body)).rejects.toThrow();
  expect(await f.send('/fixture/commands/audit')).toEqual({ attempts: 0 });
});

it('notification audit uses a captured runtime scope; native status/configure retain their own exact payloads', async () => {
  const f = fixture(outerHost);
  expect(f.host.call('notification.status', {})).toMatchObject({ authorization: 'denied' });
  const configuration = { hostID: 'outer-settings-fixture', enabled: true, language: 'en', mode: 'hidden-only', events: ['completion', 'error', 'question', 'permission', 'schedule', 'assistant', 'goal'] };
  expect(f.host.call('notification.configure', configuration)).toEqual({ lease: 'outer-settings-memory-lease' });
  expect(await f.send('/fixture/notifications/audit')).toEqual({ enabled: true, notificationMode: 'hidden-only', template: 'Preserved Web template', writes: 0, configurations: 1, authorization: 'denied' });
  expect(() => f.host.call('runtime.request', { path: '/fixture/notifications/audit', method: 'GET' })).toThrow('Invalid synthetic scope payload');
  for (const name of ['notification.status', 'notification.openSettings']) expect(() => f.host.call(name, { expectedHost: f.scope })).toThrow('unexpected data');
  expect(() => f.host.call('notification.configure', { ...configuration, expectedHost: f.scope })).toThrow('Invalid synthetic notification configuration');
  expect(() => f.host.call('notification.configure', { ...configuration, hostID: 'other' })).toThrow();
  expect(await f.send('/fixture/notifications/audit')).toMatchObject({ configurations: 1, writes: 0 });
});

it('command audit counts exactly two actual PATCHes, rejects the first and round-trips the unchanged retried draft', async () => {
  const f = fixture(commandHost), body = { template: 'Native edited review' };
  const route = '/api/config/commands/review?directory=%2Fnative%2Fproject';
  await expect(f.transaction(route, 'PATCH', body)).rejects.toThrow('HTTP 409: Settings revision conflict');
  expect((await readSettingsCollection(f.send, 'commands', '/native/project'))[0].template).toBe('Original review template');
  await f.transaction(route, 'PATCH', body);
  expect(await f.send('/fixture/commands/audit')).toEqual({ attempts: 2 });
  expect((await readSettingsCollection(f.send, 'commands', '/native/project'))[0]).toMatchObject({ template: body.template, description: 'Read-back save attempts: 2' });
  expect(h.call.mock.calls.filter(([name, input]) => name === 'runtime.request' && input.method === 'PATCH')).toHaveLength(2);
  for (const request of [{ path: '/fixture/commands/audit?directory=%2Fother', method: 'GET' }, { path: '/fixture/commands/audit', method: 'POST' }, { path: '/fixture/commands/audit', method: 'GET', body: {} }]) {
    expect(() => f.host.call('runtime.request', { ...request, expectedHost: f.scope })).toThrow();
  }
});

it('provider visibility preflight fails only after explicit arming, makes zero PUTs and retains preferences before remove/add', async () => {
  const f = fixture(outerHost), original = settingsObject(await f.send('/api/config/settings'));
  await readSettingsCollection(f.send, 'providers', '/fixture/project');
  expect(await f.send('/api/config/settings')).toEqual(original);
  expect(await f.send('/fixture/providers/preflight', 'PUT', { mode: 'fail-next-settings-read' })).toEqual({ armed: true });
  await expect(f.send('/api/config/settings')).rejects.toThrow('HTTP 500: Failed to read settings');
  expect(await f.send('/fixture/providers/audit')).toEqual({ visibilityAttempts: 0, modelAttempts: 0 });
  expect(await f.send('/fixture/providers/state')).toMatchObject({ hiddenModels: original.hiddenModels });
  expect(h.call.mock.calls.filter(([name, input]) => name === 'runtime.request' && input.path === '/api/config/settings' && input.method === 'PUT')).toHaveLength(0);
  const fresh = await f.send('/api/config/settings');
  expect(fresh).toEqual(original);
  const patch = settingsProviderModelsPatch(fresh, 'fixture', ['model'], false);
  const result = await f.transaction('/api/config/settings', 'PUT', patch);
  expect(result).toMatchObject({ hiddenModels: [{ providerID: 'unrelated', modelID: 'preserved' }, { providerID: 'fixture', modelID: 'model' }], summaryCommitPrompt: 'Preserved prompt' });
  expect(await f.send('/api/config/settings')).toEqual(result);
  expect(await readProviderRemovalSnapshot(f.send, 'fixture', '/fixture/project')).toEqual({ present: true, integrationID: 'fixture', credentials: [], environment: false, files: ['/fixture/project/opencode.json'] });
  expect(await f.send('/fixture/providers/audit')).toEqual({ visibilityAttempts: 1, modelAttempts: 0 });
  await f.transaction('/api/config/settings', 'PUT', settingsProviderModelsPatch(await f.send('/api/config/settings'), 'fixture', ['model'], true));
  expect(await f.send('/api/config/settings')).toEqual(original);
  expect(await f.send('/fixture/providers/audit')).toEqual({ visibilityAttempts: 2, modelAttempts: 0 });
  expect(h.call.mock.calls.filter(([name, input]) => name === 'runtime.request' && input.path === '/api/config/settings' && input.method === 'PUT')).toHaveLength(2);
  await expect(f.send('/fixture/providers/preflight', 'PUT', { mode: 'fail-next-settings-read' })).rejects.toThrow('preflight stage');
});

it('model exact INVALID_MODEL wire does not mutate catalog; second explicit PUT returns exact receipt and merged model', async () => {
  const f = fixture(outerHost), before = await readSettingsCollection(f.send, 'providers', '/fixture/project');
  const body = { directory: '/fixture/project', providerId: 'fixture', modelId: 'model', name: ' Native model edit ', tools: true, vision: true, inputModalities: ['text'], context: 16000, output: 4000 };
  await expect(f.transaction('/api/config/providers/model', 'PUT', body)).rejects.toMatchObject({ status: 400, message: 'HTTP 400: Unable to save provider model' });
  expect(await f.send('/fixture/providers/audit')).toEqual({ visibilityAttempts: 0, modelAttempts: 1 });
  expect(await readSettingsCollection(f.send, 'providers', '/fixture/project')).toEqual(before);
  expect(await f.transaction('/api/config/providers/model', 'PUT', body)).toEqual({ providerId: 'fixture', modelId: 'model' });
  expect((await readSettingsCollection(f.send, 'providers', '/fixture/project'))[0].models).toEqual({ model: { name: 'Native model edit', variants: { high: {} }, limit: { context: 16000, output: 4000 }, capabilities: { tools: true, input: ['text', 'image'] } } });
  expect(await f.send('/fixture/providers/audit')).toEqual({ visibilityAttempts: 0, modelAttempts: 2 });
  await f.transaction('/api/config/providers/model', 'PUT', { ...body, context: null, output: null, vision: false, tools: false });
  expect((await readSettingsCollection(f.send, 'providers', '/fixture/project'))[0].models).toEqual({ model: { name: 'Native model edit', variants: { high: {} }, limit: {}, capabilities: { tools: false, input: ['text'] } } });
  for (const invalid of [{ ...body, directory: '/other' }, { ...body, extra: true }, { ...body, output: 20000 }, { ...body, inputModalities: ['unknown'] }]) {
    await expect(f.transaction('/api/config/providers/model', 'PUT', invalid)).rejects.toThrow('payload');
  }
  for (const route of ['/api/config/providers/sources?directory=%2Fother', '/api/config/providers/sources', '/api/provider?directory=%2Ffixture%2Fproject', '/api/integration?location%5Bdirectory%5D=%2Fother']) {
    await expect(f.send(route)).rejects.toThrow('Unexpected outer settings request');
  }
  expect(await f.send('/fixture/providers/audit')).toEqual({ visibilityAttempts: 0, modelAttempts: 3 });
});

it('visibility failure staging rejects malformed payloads, methods and query/scope changes before arming', async () => {
  const f = fixture(outerHost);
  for (const body of [{}, { mode: 'other' }, { mode: 'fail-next-settings-read', extra: true }]) {
    await expect(f.send('/fixture/providers/preflight', 'PUT', body)).rejects.toThrow('preflight stage');
  }
  for (const [route, method] of [['/fixture/providers/preflight', 'GET'], ['/fixture/providers/preflight', 'POST'], ['/fixture/providers/preflight?directory=%2Fother', 'PUT']] as const) {
    await expect(f.send(route, method, method === 'GET' ? undefined : { mode: 'fail-next-settings-read' })).rejects.toThrow();
  }
  expect(await f.send('/api/config/settings')).toMatchObject({ hiddenModels: [{ providerID: 'unrelated', modelID: 'preserved' }] });
  expect(await f.send('/fixture/providers/audit')).toEqual({ visibilityAttempts: 0, modelAttempts: 0 });
});
