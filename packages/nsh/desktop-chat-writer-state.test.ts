import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const h = vi.hoisted(() => ({ call: vi.fn(), get: vi.fn(), set: vi.fn(), storage: new Map<string, string>(),
  cleanups: [] as Array<() => void>, disposers: [] as Array<() => void>, effects: [] as Array<() => void | (() => void)>, listeners: new Map<string, Set<(input: unknown) => void>>() }));
vi.mock('nsh', () => ({ batch: <T>(work: () => T) => work(), untracked: <T>(work: () => T) => work(),
  signal: <T>(initial: T) => { let value = initial; return Object.assign(() => value, { set: (next: T) => { value = next; } }); },
  computed: <T>(work: () => T) => work, locale: () => 'en', lifecycle: () => 'active', platform: { desktop: true, os: 'macos' },
  cleanup: (work: () => void) => h.cleanups.push(work), effect: (work: () => void | (() => void)) => { h.effects.push(work); const stop = work(); if (stop) h.disposers.push(stop); },
  Storage: { getItem: h.get, setItem: h.set }, host: { available: () => true, call: h.call, on(name: string, listener: (input: unknown) => void) {
    const listeners = h.listeners.get(name) ?? new Set(); listeners.add(listener); h.listeners.set(name, listeners); return () => { listeners.delete(listener); };
  } } }));
const target = { kind: 'session', id: 'session/a', directory: '/workspace', title: 'Original state fixture' } as const;
const flush = async () => { for (let index = 0; index < 60; index++) await Promise.resolve(); };
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); h.storage.clear(); h.cleanups = []; h.disposers = []; h.effects = []; h.listeners.clear();
  h.get.mockReset().mockImplementation(async key => h.storage.get(key) ?? null);
  h.set.mockReset().mockImplementation(async (key, value) => { h.storage.set(key, value); });
});
afterEach(async () => { h.disposers.forEach(stop => stop()); h.cleanups.forEach(stop => stop()); await flush(); vi.useRealTimers(); });
async function fixture() {
  const { StrictWriterHost, writerTestScope } = await import('./desktop-writer-test-host'); const host = new StrictWriterHost();
  h.call.mockReset().mockImplementation(async (name, input) => {
    if (name === 'connection.list') return { selected: 'host-a', runtimeScope: host.scope, connections: [{ id: 'host-a', url: 'https://fixture.invalid', authorizationID: 'native-authorization-one' }] };
    if (name === 'runtime.request') {
      const path = String(input.path);
      host.runtimeReply = { status: 200, body: path.includes('/message?') ? { data: [] } : path.startsWith('/api/session/session%2Fa?') ? { id: target.id, location: { directory: target.directory } }
        : path === '/api/session/active' ? {} : path.includes('/inbox?') || path.includes('/permission/request?') || path.includes('/form?') ? [] : null };
      return host.call(name, input);
    }
    if (name.startsWith('desktop.writer.')) return host.call(name, input);
    return true;
  });
  const { loadDesktopWriterClient } = await import('./desktop-writer-core'), { createDesktopChatWriter } = await import('./desktop-chat-writer');
  const client = (await loadDesktopWriterClient({ source: () => host, current: () => true }))!;
  const state = await import('./state'); await state.loadConnections();
  const owner = createDesktopChatWriter({ client: () => client, capabilitiesReady: () => true, target, current: () => true,
    committedRuntimeScope: state.app.runtimeScope, stableAuthorityIdentity: () => 'fixture-origin-auth',
    renderChild: (writerGrant, writerUnknown) => state.createChat(target, { writerGrant, writerUnknown }) });
  await owner.ready(); const chat = owner.child()!; await chat.draftReady; await flush();
  return { owner, chat, host, state, writerTestScope };
}
test('actual createChat retirement flush succeeds while wrapper getter is null: no laneCurrent/grant self-lock', async () => {
  const f = await fixture(); expect(f.owner.grant()).not.toBeNull(); expect(f.chat.setDraftText('original retained draft')).toBe(true);
  f.chat.attachments.set([{ uri: 'attachment://keep', name: 'keep', mime: 'text/plain' }]);
  const stop = f.owner.bindBusiness(f.chat);
  const prepared = f.owner.prepareRetirement(); expect(f.owner.grant()).toBeNull(); expect(await prepared).toBe(true);
  expect(f.chat.canReleaseWriter()).toBe(true); expect(f.owner.canClose()).toBe(true); expect(f.chat.writerRetirement().reasons).toEqual([]);
  const record = [...h.storage.values()].map(value => JSON.parse(value)).find(value => value.draft === 'original retained draft');
  expect(record.attachments).toHaveLength(1); expect(f.chat.setDraftText('must be paused')).toBe(false);
  f.owner.cancel(); expect(f.chat.setDraftText('resumed same draft')).toBe(true); expect(f.owner.grant()).not.toBeNull(); stop();
  expect(f.host.calls.filter(row => row.name === 'desktop.writer.release')).toHaveLength(0);
});
test('actual pending/history protection survives wrapper prepare and cancel without releasing the native owner', async () => {
  const f = await fixture(); f.chat.historyBusy.set(true);
  expect(await f.owner.prepareRetirement(f.chat)).toBe(false); expect(f.owner.grant()).not.toBeNull();
  expect(f.chat.historyBusy()).toBe(true); expect(f.owner.canClose()).toBe(false);
  f.chat.historyBusy.set(false); expect(await f.owner.prepareRetirement(f.chat)).toBe(true);
  expect(await f.owner.release()).toBe(true); expect(f.owner.status().phase).toBe('released');
  expect(f.host.calls.filter(row => row.name === 'desktop.writer.release')).toHaveLength(1);
});
test('actual original durable flush failure leaves draft/claim usable and cannot release; retry is explicit prepare', async () => {
  const f = await fixture(); f.chat.setDraftText('Keep on disk failure'); h.set.mockRejectedValueOnce(new Error('synthetic Storage failure'));
  expect(await f.owner.prepareRetirement(f.chat)).toBe(false); expect(f.owner.canClose()).toBe(false); expect(f.owner.grant()).not.toBeNull();
  expect(f.chat.draft()).toBe('Keep on disk failure'); expect(f.host.calls.filter(row => row.name === 'desktop.writer.release')).toHaveLength(0);
  await f.chat.retryDraft(); expect(await f.owner.prepareRetirement(f.chat)).toBe(true); f.owner.cancel(); expect(f.chat.setDraftText('same owner')).toBe(true);
});
test('actual state mutation consumes the verified original grant and transport unknown prevents business release even after cancel', async () => {
  const f = await fixture(); f.chat.busy.set(true); await f.chat.stop();
  const write = f.host.calls.find(row => row.name === 'runtime.request' && row.input.method === 'POST' && String(row.input.path).includes('/interrupt?'));
  expect(write?.input.writerGrant).toBe('native_grant_1');
  f.host.errors['runtime.request'] = new Error('lost native write ACK'); f.chat.busy.set(true); await expect(f.chat.stop()).rejects.toThrow('lost native write ACK');
  expect(f.owner.status().phase).toBe('unknown'); expect(await f.owner.prepareRetirement(f.chat)).toBe(false); f.owner.cancel();
  expect(f.owner.grant()).toBeNull(); expect(f.owner.canClose()).toBe(false); expect(f.host.calls.filter(row => row.name === 'desktop.writer.release')).toHaveLength(0);
});
