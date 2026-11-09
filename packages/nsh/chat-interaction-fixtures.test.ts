import { expect, test, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHost as goalHost } from './tests/goal-tasks-chat-host.js';
import { createHost as referenceHost } from './tests/composer-references-chat-host.js';
import { createHost as headerHost } from './tests/chat-header-host.js';
import { authorizationCacheCleanupBridge, createAuthorizationCacheCleanupRoot } from './authorization-cache-cleanup';
import { connectionSnapshotFrom, bindRequest } from './runtime';
import { prepareInteractionEngineDriver } from './tests/chat-interaction-engine-driver';
import { createChatHeaderMetadata, type ChatHeaderMetadata } from './chat-header-metadata';

const boundary = vi.hoisted(() => ({ call: vi.fn(), storage: new Map<string, string>(), cleanups: [] as Array<() => void>, stops: [] as Array<() => void> }));
vi.mock('nsh', () => ({
  batch: <T>(work: () => T) => work(), untracked: <T>(work: () => T) => work(),
  signal: <T>(initial: T) => { let value = initial; return Object.assign(() => value, { set: (next: T) => { value = next; } }); },
  locale: () => 'en', lifecycle: () => 'active',
  effect: (work: () => void | (() => void)) => { const stop = work(); if (stop) boundary.stops.push(stop); },
  cleanup: (work: () => void) => boundary.cleanups.push(work),
  Storage: { getItem: async (key: string) => boundary.storage.get(key) ?? null, setItem: async (key: string, value: string) => { boundary.storage.set(key, value); }, removeItem: async (key: string) => { boundary.storage.delete(key); } },
  host: { available: () => true, call: boundary.call, on: () => () => {} },
}));

test('Goal production App bootstrap accepts the real empty native cleanup handshake and rejects forged cleanup operations', async () => {
  const host = goalHost();
  const bridge = authorizationCacheCleanupBridge(async (name, input) => host.call(name, input));
  const onReady = vi.fn(), retire = vi.fn();
  const root = createAuthorizationCacheCleanupRoot({ bridge, retire, subscribe: () => () => {}, onReady, onState: () => {} });
  try {
    await root.start(); expect(onReady).toHaveBeenCalledTimes(1); expect(retire).not.toHaveBeenCalled();
    await root.retry(); expect(onReady).toHaveBeenCalledTimes(1);
    expect(() => host.call('authorization.cache.list', { owner: 'foreign' })).toThrow();
    expect(() => host.call('authorization.cache.claim', { owner: 'foreign', ticket: 'forged' })).toThrow();
    expect(() => host.call('authorization.cache.ack', { owner: 'foreign', ticket: 'forged' })).toThrow();
  } finally { root.dispose(); }
});

test.each([['references', referenceHost, '/api/session/active'], ['header', headerHost, '/fixture/request-count'], ['goal', goalHost, '/api/config/settings']] as const)('%s dedicated Host supplies opaque lease and rejects missing/foreign request authority', (_, factory, route) => {
  const host = factory(), snapshot = connectionSnapshotFrom(host.call('connection.list', {}));
  expect(snapshot.runtimeScope).toMatchObject({ hostID: snapshot.selected, lease: expect.any(String) });
  for (const expectedHost of [undefined, { ...snapshot.runtimeScope, lease: 'foreign' }, { ...snapshot.runtimeScope, hostID: 'foreign' }]) {
    expect(() => host.call('runtime.request', { path: route, method: 'GET', expectedHost })).toThrow();
  }
  expect(host.call('runtime.request', { path: route, method: 'GET', expectedHost: snapshot.runtimeScope }).status).toBe(200);
});

test('references prompt requires real captured runtime scope and rejects Goal/selection/unrelated writes', async () => {
  const host = referenceHost(), snapshot = connectionSnapshotFrom(host.call('connection.list', {}));
  boundary.call.mockImplementation(host.call);
  const request = bindRequest(snapshot.runtimeScope);
  await expect(request('/api/session/reference-chat/prompt?directory=%2Fworkspace', 'POST', {})).rejects.toThrow('Reference wire was incomplete');
  for (const route of ['/api/session/reference-chat/model?directory=%2Fworkspace', '/api/session/reference-chat/command?directory=%2Fworkspace', '/api/git/stage?directory=%2Fworkspace']) {
    await expect(request(route, 'POST', {})).rejects.toThrow();
  }
});

test.each([
  ['App.tsx', 'tests/goal-tasks-chat-host.js'],
  ['composer-references-chat-fixture.tsx', 'tests/composer-references-chat-host.js'],
  ['chat-header-test-app.tsx', 'tests/chat-header-host.js'],
])('%s driver preserves full steps under nsh.json and bundles a loadable dedicated scoped Host', async (entry, host) => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const steps = ['await app.waitFor("id:fixture-ready");', 'expect(app.count("id:closed-row")).toBe(0);'];
  const first = prepareInteractionEngineDriver(directory, entry, host, steps), second = prepareInteractionEngineDriver(directory, entry, host, []);
  try {
    expect(first.directory).not.toBe(second.directory);
    let ancestor = path.dirname(first.testFile);
    while (!existsSync(path.join(ancestor, 'nsh.json')) && path.dirname(ancestor) !== ancestor) ancestor = path.dirname(ancestor);
    expect(ancestor).toBe(directory);
    const source = readFileSync(first.testFile, 'utf8');
    expect(source).toContain('platform: "macos", storage: {}, network: {}');
    expect(source).toContain('await app.wait(1200)'); expect(source).toContain('finally { app.dispose(); }');
    for (const step of steps) expect(source).toContain(step);
    const bundle = first.bundleHost(); expect(bundle).toBe(first.hostFile);
    expect(readFileSync(bundle, 'utf8')).not.toMatch(/^\s*import\s/m);
    const loaded = await import(/* @vite-ignore */ pathToFileURL(bundle).href), bridge = loaded.createHost();
    const saved = connectionSnapshotFrom(bridge.call('connection.list', {}));
    expect(saved.runtimeScope?.hostID).toBe(saved.selected);
    expect(() => bridge.call('runtime.request', { path: '/api/config/settings', method: 'GET', expectedHost: { ...saved.runtimeScope, lease: 'foreign' } })).toThrow();
  } finally { first.dispose(); second.dispose(); }
  expect(existsSync(first.directory)).toBe(false); expect(existsSync(second.directory)).toBe(false);
});

test('dedicated header Host satisfies production metadata tokens, branch, model limit and quotas with captured lease', async () => {
  const host = headerHost(), snapshot = connectionSnapshotFrom(host.call('connection.list', {}));
  boundary.call.mockImplementation(host.call);
  let metadata: ChatHeaderMetadata = { loading: false, errors: [] };
  const controller = createChatHeaderMetadata({ target: { kind: 'session', id: 'ses_header', directory: '/workspace/header', title: 'Header fixture' }, current: () => true, read: bindRequest(snapshot.runtimeScope), changed: value => { metadata = value; } });
  try {
    await controller.refresh(); await controller.refreshQuotas();
    expect(metadata).toMatchObject({ branch: 'feature/header', tokens: 700, limit: 1000, errors: [] });
    expect(JSON.stringify(metadata.quota)).toContain('Account Alpha');
    expect(JSON.stringify(metadata.quota)).toContain('Cursor · Fixture');
  } finally { controller.dispose(); }
});

test('dedicated references Host drives actual createChat durable five-domain remount and captured prompt admission', async () => {
  vi.useFakeTimers(); vi.resetModules(); boundary.storage.clear();
  const host = referenceHost(); boundary.call.mockReset().mockImplementation(host.call);
  const flush = async () => { for (let index = 0; index < 100; index++) await Promise.resolve(); };
  const dispose = () => { boundary.stops.splice(0).reverse().forEach(stop => stop()); boundary.cleanups.splice(0).reverse().forEach(stop => stop()); };
  const target = { kind: 'session' as const, id: 'reference-chat', title: 'References', directory: '/workspace' };
  try {
    let state = await import('./state'); await state.loadConnections();
    const first = state.createChat(target); await first.draftReady; await flush();
    expect(first.draftStatus()).toBe('ready'); expect(first.error()).toBe(''); first.setDraftText('Read ');
    for (const candidate of [
      { kind: 'file' as const, value: 'src/neutral.ts', label: 'src/neutral.ts' },
      { kind: 'directory' as const, value: 'src/', label: 'src/' },
      { kind: 'agent' as const, value: 'reviewer', label: 'reviewer' },
      { kind: 'skill' as const, value: 'real-skill', label: 'Displayed skill' },
      { kind: 'session' as const, value: 'prior', label: 'Prior neutral work', directory: '/other' },
    ]) first.insertReference({ ...candidate, scope: first.referenceScope });
    expect(first.references()).toHaveLength(5); await first.flushDraft(); const saved = first.referenceDocument();
    dispose(); vi.resetModules(); state = await import('./state'); await state.loadConnections();
    const second = state.createChat(target); await second.draftReady; await flush();
    expect(second.referenceDocument()).toEqual({ ...saved, references: saved.references.map(({ scope: _candidateScope, ...reference }) => reference) }); expect(second.draft()).toContain('@Displayed skill');
    expect(await second.send()).toBe(true); await flush();
    expect(second.references()).toEqual([]); expect(second.draft()).toBe('');
    const posts = boundary.call.mock.calls.filter(([name, input]) => name === 'runtime.request' && input.method !== 'GET');
    expect(posts).toHaveLength(1); expect(posts[0][1]).toMatchObject({ path: '/api/session/reference-chat/prompt?directory=%2Fworkspace', expectedHost: host.call('connection.list', {}).runtimeScope });
    expect(boundary.call.mock.calls.some(([name, input]) => name === 'runtime.request' && /\/(model|agent|command)\?/.test(input.path) && input.method !== 'GET')).toBe(false);
  } finally { dispose(); await flush(); vi.clearAllTimers(); vi.useRealTimers(); }
});
