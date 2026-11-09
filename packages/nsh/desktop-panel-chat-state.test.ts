import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ call: vi.fn(), get: vi.fn(), set: vi.fn(), listeners: new Map<string, Set<(value: unknown) => void>>(), stops: [] as Array<() => void>, effects: [] as Array<() => unknown>, cleanups: [] as Array<() => void> }));
vi.mock('nsh', () => ({
  batch: <T>(work: () => T) => work(), untracked: <T>(work: () => T) => work(), lifecycle: () => 'active',
  signal: <T>(initial: T) => { let value = initial; return Object.assign(() => value, { set: (next: T) => { value = next; }, update: (work: (value: T) => T) => { value = work(value); } }); },
  computed: <T>(work: () => T) => work,
  effect: (work: () => void | (() => void)) => { h.effects.push(work); const stop = work(); if (stop) h.stops.push(stop); },
  cleanup: (work: () => void) => h.cleanups.push(work), Storage: { getItem: h.get, setItem: h.set },
  host: { available: () => true, call: h.call, on: (name: string, work: (value: unknown) => void) => { const set = h.listeners.get(name) ?? new Set(); set.add(work); h.listeners.set(name, set); return () => { set.delete(work); }; } },
}));
const target = { kind: 'session' as const, id: 's', title: 'Session', directory: '/repo' };
const tick = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
const calls = (name: string) => h.call.mock.calls.filter(([key]) => key === name).map(([, value]) => value);
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); h.listeners.clear(); h.stops = []; h.cleanups = []; h.effects = [];
  h.get.mockReset().mockResolvedValue(null); h.set.mockReset().mockResolvedValue(undefined);
  h.call.mockReset().mockImplementation(async (name, input) => {
    if (name === 'connection.list') return { selected: 'A', connections: [{ id: 'A', url: 'https://a.example', authorizationID: 'auth-A' }], runtimeScope: { hostID: 'A', lease: 'lease-1' } };
    if (name !== 'runtime.request') return true;
    const path = input.path;
    return { status: 200, body: path.includes('/message?') ? { data: [{ id: 'm', type: 'assistant', content: [{ type: 'text', text: 'Authoritative body' }] }] } : path === '/api/session/active' ? {} : path.startsWith('/api/session/s?') ? { id: 's', location: { directory: '/repo' } } : [] };
  });
});
afterEach(() => { h.stops.forEach(stop => stop()); h.cleanups.forEach(stop => stop()); vi.useRealTimers(); });

it('a real main Chat plus readOnly display owner never transfers writer/durable authority or replays pending sends', async () => {
  const state = await import('./state'); await state.loadConnections();
  const main = state.createChat(target); await main.draftReady; await tick(); main.setDraftText('Main private draft'); await main.flushDraft();
  const reads = h.get.mock.calls.length;
  const panel = state.createChat(target, { readOnly: true, displayConsumer: { surfaceID: 'panel-1', current: () => true } });
  await panel.draftReady; await tick();
  expect(h.get.mock.calls.length).toBe(reads);
  expect(panel.draft()).toBe(''); expect(main.draft()).toBe('Main private draft');
  for (const listener of h.listeners.get('runtime.event') ?? []) listener({ key: 'chat', data: JSON.stringify({ type: 'session.execution.started', data: { sessionID: 's' } }) });
  expect(main.busy()).toBe(true);
  expect(await main.flushDraft()).toBeUndefined();
  expect(calls('runtime.request').filter(input => input.method !== 'GET')).toEqual([]);
});

it('readOnly core refuses every public writer including raw signal setters and Goal/history gates', async () => {
  const state = await import('./state'); await state.loadConnections();
  const panel = state.createChat(target, { readOnly: true, displayConsumer: { surfaceID: 'panel', current: () => true } }); await tick(); h.call.mockClear();
  expect(panel.setDraftText('forbidden')).toBe(false);
  expect(panel.composerRevision()).toBe(0); expect(panel.compareAndSetDraftText(panel.composerRevision(), 'forbidden')).toBe(false);
  expect(panel.insertReference({ kind: 'file', value: '/repo/file', label: 'file', display: '@file' })).toBe(false);
  expect(panel.setReferenceDocument(panel.referenceDocument())).toBe(false); expect(panel.clearContext()).toBe(false);
  expect(() => panel.draft.set('forbidden')).toThrow('chat_read_only');
  expect(() => panel.attachments.set([])).toThrow('chat_read_only');
  expect(() => panel.pendingSend.set(null)).toThrow('chat_read_only');
  expect(() => panel.queueEdit.set(null)).toThrow('chat_read_only');
  expect(() => panel.revert.set(null)).toThrow('chat_read_only');
  expect(() => panel.historyBusy.set(true)).toThrow('chat_read_only'); expect(panel.historyBusy()).toBe(false);
  expect(await panel.send()).toBe(false); expect(await panel.retrySend()).toBe(false); expect(await panel.command('compact')).toBe(false);
  await panel.stop(); await expect(panel.replyPermission('p', 'once')).rejects.toThrow('chat_read_only');
  await expect(panel.replyForm('f', {})).rejects.toThrow('chat_read_only'); await expect(panel.cancelForm('f')).rejects.toThrow('chat_read_only');
  expect(await panel.cancelInbox('q')).toBe(false); expect(await panel.editInbox('q')).toBe(false); expect(await panel.steerInbox('q')).toBe(false);
  expect(await panel.recoverQueueEdit()).toBe(false); expect(await panel.discardQueueEdit()).toBe(false); expect(await panel.recoverPendingSend()).toBe(false);
  panel.goal.controller.setArmed(true); expect(panel.goal.controller.captureArm().armed).toBe(false); expect(await panel.goal.controller.toggle()).toBe('blocked');
  expect(calls('runtime.request')).toEqual([]); expect(h.set).not.toHaveBeenCalled();
});

it('standalone display streams use an owner-scoped key and their cleanup never stops main chat or PTY', async () => {
  const state = await import('./state'); await state.loadConnections();
  const main = state.createChat(target); await tick();
  const stopIndex = h.stops.length;
  state.createChat({ ...target, id: 'other' }, { readOnly: true, displayConsumer: { surfaceID: 'panel', current: () => true, stream: { start: input => h.call('runtime.stream', input), stop: input => h.call('runtime.stop', input) } } }); await tick();
  expect(calls('runtime.stream').map(input => input.key)).toEqual(['chat', expect.stringMatching(/^panel-chat:/)]);
  h.stops.splice(stopIndex).forEach(stop => stop());
  expect(calls('runtime.stop').map(input => input.key)).not.toContain('chat');
  expect(calls('runtime.stop').every(input => input.key.startsWith('panel-chat:'))).toBe(true);
  expect(main.active()).toBe(true);
});

it('without an explicitly supported independent-stream port the core never sends an unsupported Host key', async () => {
  const state = await import('./state'); await state.loadConnections();
  const panel = state.createChat(target, { readOnly: true, displayConsumer: { surfaceID: 'panel', current: () => true } }); await tick();
  expect(calls('runtime.stream')).toEqual([]); expect(calls('runtime.stop')).toEqual([]);
  expect(panel.displayStreamError()).toBe('chat_display_stream_unavailable'); expect(panel.messagesResolved()).toBe(true);
  expect(panel.messages()[0]?.text).toBe('Authoritative body');
});

it('the real transcript-action mutation gate refuses accidental readOnly revert/edit/redo/fork before even a GET', async () => {
  const state = await import('./state'); await state.loadConnections(); const panel = state.createChat(target, { readOnly: true }); await tick();
  const { createTranscriptActions } = await import('./transcript-actions-core');
  const send = vi.fn(async () => ({}));
  const actions = createTranscriptActions({ target, send, scope: { key: 'display-history', current: () => true, busy: () => false, message: () => panel.messages()[0] },
    onPending: value => panel.historyBusy.set(value), onEditDraft: async () => {}, onOpenChat: () => {} });
  await expect(actions.revert()).rejects.toThrow('chat_read_only'); await expect(actions.edit()).rejects.toThrow('chat_read_only');
  await expect(actions.redo()).rejects.toThrow('chat_read_only'); await expect(actions.fork()).rejects.toThrow('chat_read_only'); expect(send).not.toHaveBeenCalled();
});

it('wrong-directory GET authority is not allowed to publish even a successful message page', async () => {
  const previous = h.call.getMockImplementation()!;
  h.call.mockImplementation(async (name, input) => name === 'runtime.request' && input.path.startsWith('/api/session/s?') ? { status: 200, body: { id: 's', location: { directory: '/another-project' } } } : previous(name, input));
  const state = await import('./state'); await state.loadConnections();
  const panel = state.createChat(target, { readOnly: true }); await tick();
  expect(panel.messagesResolved()).toBe(false); expect(panel.messages()).toEqual([]); expect(panel.messageReadError()).toBeTruthy();
  expect(calls('runtime.request').filter(input => input.path.includes('/message?'))).toEqual([]);
});

it('a pending display GET cannot publish after its captured Host/surface is retired', async () => {
  let release!: (value: unknown) => void, current = true;
  const gate = new Promise<unknown>(resolve => { release = resolve; }), previous = h.call.getMockImplementation()!;
  h.call.mockImplementation(async (name, input) => name === 'runtime.request' && input.path.includes('/message?') ? gate : previous(name, input));
  const state = await import('./state'); await state.loadConnections();
  const panel = state.createChat(target, { readOnly: true, displayConsumer: { surfaceID: 'pending', current: () => current } }); await tick();
  current = false; release({ status: 200, body: { data: [{ id: 'late', type: 'user', text: 'Forbidden late snapshot' }] } }); await tick();
  expect(panel.messages()).toEqual([]); expect(panel.messagesResolved()).toBe(false);
});

it('composer CAS uses the durable whole-resource revision, preserves attachments/queue/pending and relocates references atomically', async () => {
  const state = await import('./state'); await state.loadConnections(); const main = state.createChat(target); await main.draftReady; await tick();
  main.insertReference({ kind: 'file', value: '/repo/file', label: 'file', display: '@file' });
  const files = [{ uri: 'file:///synthetic/attachment', name: 'attachment', mime: 'text/plain' }]; main.attachments.set(files);
  const queue = { id: 'queued', text: 'Queued composer', files: [] }; main.queueEdit.set(queue);
  const pending = { id: 'pending', text: 'Pending composer', files: [], delivery: 'queue' as const, uncertain: true }; main.pendingSend.set(pending);
  const document = main.referenceDocument(), revision = main.composerRevision();
  expect(main.compareAndSetDraftText(revision, `prefix ${document.text}`)).toBe(true);
  expect(main.attachments()).toBe(files); expect(main.queueEdit()).toBe(queue); expect(main.pendingSend()).toBe(pending);
  expect(main.references()[0]?.start).toBe(document.references[0]!.start + 7);
  expect(main.references()[0]?.end).toBe(document.references[0]!.end + 7);
  expect(main.composerRevision()).toBeGreaterThan(revision);
  expect(calls('runtime.request').every(input => input.method === 'GET')).toBe(true);
});

it('composer CAS rejects text/resource ABA and hidden/sync-only, stale Host and preempted writer authority', async () => {
  const state = await import('./state'); await state.loadConnections(); const main = state.createChat(target); await main.draftReady; await tick();
  main.setDraftText('A'); let revision = main.composerRevision(); main.setDraftText('B'); main.setDraftText('A');
  expect(main.compareAndSetDraftText(revision, 'Must not replace')).toBe(false); expect(main.draft()).toBe('A');
  revision = main.composerRevision(); main.attachments.set([{ uri: 'file:///synthetic/ABA', name: 'ABA', mime: 'text/plain' }]); main.attachments.set([]);
  expect(main.compareAndSetDraftText(revision, 'Resource ABA')).toBe(false);
  revision = main.composerRevision(); main.active.set(false); main.syncActive.set(true);
  expect(main.compareAndSetDraftText(revision, 'Hidden')).toBe(false); main.active.set(true); main.syncActive.set(false);
  expect(main.compareAndSetDraftText(revision, 'Visible')).toBe(true);
  revision = main.composerRevision(); state.createChat({ ...target, id: 'new-writer' }); await tick();
  expect(main.compareAndSetDraftText(revision, 'Preempted')).toBe(false);
  state.app.runtimeScope.set({ hostID: 'A', lease: 'stale-lease' }); expect(main.compareAndSetDraftText(revision, 'Stale')).toBe(false);
  expect(main.draft()).toBe('Visible');
});
