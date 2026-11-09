import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { captureIssuedStream, issuedStream, resetIssuedStreams } from './tests/session-stream-fixture';
const h = vi.hoisted(() => ({ call: vi.fn(), storage: new Map<string, string>(), storageWrite: null as null | ((key: string, value: string) => Promise<void>), cleanups: [] as Array<() => void>, disposers: [] as Array<() => void>, listeners: new Map<string, Set<(value: unknown) => void>>() }));
vi.mock('nsh', () => ({
  signal: <T>(value: T) => Object.assign(() => value, { set: (next: T) => { value = next; }, update: (work: (old: T) => T) => { value = work(value); } }),
  batch: (work: () => void) => work(), untracked: <T>(work: () => T) => work(), lifecycle: () => 'active',
  cleanup: (work: () => void) => h.cleanups.push(work), effect: (work: () => unknown) => { const dispose = work(); if (typeof dispose === 'function') h.disposers.push(dispose as () => void); },
  Storage: { getItem: async (key: string) => h.storage.get(key) ?? null, setItem: async (key: string, value: string) => { if (h.storageWrite) return h.storageWrite(key, value); h.storage.set(key, value); } },
  host: { available: () => true, call: h.call, on: (name: string, listener: (value: unknown) => void) => { const entries = h.listeners.get(name) ?? new Set(); entries.add(listener); h.listeners.set(name, entries); return () => { entries.delete(listener); }; } },
}));
const target = { kind: 'session' as const, id: 's', title: 'Fixture history', directory: '/repo' };
let staged: { messageID: string } | null, rows: Array<Record<string, unknown>>, handle: (path: string, method: string, body: unknown) => unknown;
const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
const requests = () => h.call.mock.calls.filter(([name]) => name === 'runtime.request').map(([, body]) => body as { path: string; method: string; body?: Record<string, unknown> });
const emit = (type: string, data: Record<string, unknown>) => { for (const listener of h.listeners.get('runtime.event') ?? []) listener({ ...issuedStream(h.call), data: JSON.stringify({ type, data }) }); };
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
beforeEach(() => {
  resetIssuedStreams(h.call);
  vi.resetModules(); vi.useFakeTimers(); h.storage.clear(); h.storageWrite = null; h.cleanups = []; h.disposers = []; h.listeners.clear();
  staged = { messageID: 'a-boundary' };
  rows = [{ id: 'z-before', type: 'user', text: 'Before' }, { id: 'a-boundary', type: 'user', text: 'Boundary' }, { id: 'm-tail', type: 'assistant', text: 'Tail' }];
  handle = (path, method, body) => {
    if (path === '/api/session/s?directory=%2Frepo') return { id: 's', revert: staged };
    if (path.includes('/message?')) return { data: [...rows].reverse(), cursor: { next: null } };
    if (path === '/api/session/active') return {};
    if (path.includes('/inbox?') || path.includes('/form?') || path.includes('/permission/request?')) return [];
    if (path.includes('/revert/commit?')) { staged = null; rows = rows.slice(0, 1); return null; }
    if (path.includes('/prompt?')) { const value = body as Record<string, unknown>; return { id: value.id, sessionID: 's', type: 'user', payload: { text: value.text } }; }
    return null;
  };
  h.call.mockReset().mockImplementation(async (name, input) => { if (name === 'runtime.stream') captureIssuedStream(h.call, input); return name === 'connection.list'
    ? { selected: 'fixture', runtimeScope: { hostID: 'fixture', lease: 'fixture-lease' }, connections: [{ id: 'fixture', url: 'https://host.example', label: 'Fixture' }] }
    : name === 'runtime.request' ? { status: 200, body: await handle(input.path, input.method, input.body) } : true; });
});
afterEach(() => { h.disposers.forEach(work => work()); h.cleanups.forEach(work => work()); vi.useRealTimers(); });
async function chat() { const state = await import('./state'); await state.loadConnections(); const chat = state.createChat(target); await chat.draftReady; await flush(); await chat.load(); return { state, chat }; }

it('compact releases composer sending immediately and orders follow-up queue admission behind its POST ACK', async () => {
  staged = null; const { chat: c } = await chat(), original = handle, gate = deferred<unknown>();
  handle = (path, method, body) => path.includes('/compact?') ? gate.promise : original(path, method, body);
  const compact = c.compact();
  expect(c.sending()).toBe(false); expect(c.compactionBarrier()).toBe(true);
  c.draft.set('Follow up'); const followup = c.send(); await flush();
  expect(requests().filter(input => input.path.includes('/compact?'))).toHaveLength(1);
  expect(requests().some(input => input.path.includes('/prompt?'))).toBe(false);
  gate.resolve({ id: 'compact-one', sessionID: 's', type: 'compaction' });
  expect(await compact).toBe(true); expect(await followup).toBe(true);
  expect(requests().find(input => input.path.includes('/prompt?'))?.body?.delivery).toBe('queue');
  expect(c.sending()).toBe(false); expect(c.compactReceipt()?.status).toBe('acknowledged');
  expect(requests().some(input => input.path.includes('/command?'))).toBe(false);
});
it('compaction follows explicit steer preference and does not send the slash text as a prompt', async () => {
  staged = null; const { state } = await chat(), original = handle;
  handle = (path, method, body) => path.includes('/compact?') ? { id: 'compact-two', sessionID: 's', type: 'compaction' } : original(path, method, body);
  const c = state.createChat(target, { followUpBehavior: () => 'steer' }); await c.draftReady; await flush(); await c.load();
  expect(await c.compact()).toBe(true); c.draft.set('Immediate follow up'); expect(await c.send()).toBe(true);
  expect(requests().find(input => input.path.includes('/prompt?'))?.body?.delivery).toBe('steer');
  expect(c.inbox().some(item => item.type === 'compaction')).toBe(false);
});
it('unknown compact ACK never replays and failed history preflight preserves the reverted tail', async () => {
  const { chat: c } = await chat(), original = handle;
  expect(await c.compact()).toBe(false); expect(c.revert()).toEqual(staged); expect(requests().some(input => input.path.includes('/compact?'))).toBe(false);
  staged = null;
  handle = (path, method, body) => { if (path.includes('/compact?')) throw new Error('Lost compact ACK'); return original(path, method, body); };
  expect(await c.compact()).toBe(false); expect(c.compactReceipt()?.status).toBe('unknown'); expect(c.sending()).toBe(false);
  expect(await c.compact()).toBe(false); expect(requests().filter(input => input.path.includes('/compact?'))).toHaveLength(1);
});
it.each(['lost-ack', 'journal-unknown'])('ordinary input recovers from %s using authoritative idle/inbox without replaying compact', async failure => {
  staged = null; const { state, chat: c } = await chat(), original = handle;
  handle = (path, method, body) => {
    if (path.includes('/compact?')) throw new Error('Lost ACK');
    if (path.includes('/delivery?')) return { data: [], compactionRunning: false };
    return original(path, method, body);
  };
  if (failure === 'journal-unknown') h.storageWrite = async (key, value) => {
    h.storage.set(key, value);
    if (key.startsWith('nsh:compact:')) throw new Error('Atomic write result unknown');
  };
  expect(await c.compact()).toBe(false); expect(c.compactReceipt()?.status).toBe('unknown');
  const posts = requests().filter(input => input.path.includes('/compact?')).length;
  expect(posts).toBe(failure === 'lost-ack' ? 1 : 0);
  h.storageWrite = null;
  emit('session.compaction.ended', { sessionID: 's', inputID: 'unidentified-old-turn' });
  c.draft.set('Safe new ordinary input'); expect(await c.send()).toBe(true);
  expect(c.sending()).toBe(false); expect(c.compactReceipt()?.status).toBe('unknown'); expect(c.compactionBarrier()).toBe(false);
  expect(await c.compact()).toBe(false);
  const resumed = state.createChat(target); await resumed.draftReady; await flush(); await resumed.load();
  expect(resumed.compactReceipt()?.status).toBe('unknown');
  resumed.draft.set('Safe after remount'); expect(await resumed.send()).toBe(true);
  expect(await resumed.compact()).toBe(false);
  expect(requests().filter(input => input.path.includes('/compact?'))).toHaveLength(posts);
  expect(requests().filter(input => input.path.includes('/prompt?'))).toHaveLength(2);
});
it.each(['before', 'after'])('A terminal %s queued B ACK cannot clear B receipt or queue barrier in actual state', async order => {
  staged = null; const { chat: c } = await chat(), original = handle, ack = deferred<unknown>();
  const B = { id: 'compact-B', sessionID: 's', type: 'compaction', delivery: 'queue' };
  let completedB = false;
  handle = (path, method, body) => {
    if (path.includes('/compact?')) return ack.promise;
    if (path.includes('/delivery?')) return { data: completedB ? [] : [B], compactionRunning: !completedB };
    if (path.includes('/inbox?')) return completedB ? [] : [B];
    return original(path, method, body);
  };
  c.busy.set(true); emit('session.compaction.started', { sessionID: 's', inputID: 'compact-A' });
  const work = c.compact(); await flush();
  if (order === 'before') emit('session.compaction.ended', { sessionID: 's', inputID: 'compact-A' });
  ack.resolve(B); expect(await work).toBe(true);
  if (order === 'after') emit('session.compaction.ended', { sessionID: 's', inputID: 'compact-A' });
  await c.load(false, ['inbox']);
  expect(c.compactReceipt()).toEqual({ status: 'acknowledged', inboxID: 'compact-B' }); expect(c.compactionBarrier()).toBe(true);
  c.busy.set(false); c.draft.set('Behind B'); expect(await c.send()).toBe(true);
  expect(requests().find(input => input.path.includes('/prompt?'))?.body?.delivery).toBe('queue');
  expect(c.compactReceipt()?.inboxID).toBe('compact-B');
  completedB = true; emit('session.compaction.ended', { sessionID: 's', inputID: 'compact-B' });
  expect(c.compactReceipt()?.inboxID).toBe('compact-B');
  await c.load(false, ['inbox']); expect(c.compactReceipt()).toBeNull(); expect(c.compactionBarrier()).toBe(false);
  expect(requests().filter(input => input.path.includes('/compact?'))).toHaveLength(1);
});
it('production action journals use the complete captured Host URL/auth/session/directory tuple', async () => {
  staged = null; const { state, chat: c } = await chat();
  const base = state.app.connection()!;
  const original = handle;
  handle = (path, method, body) => path.includes('/compact?') ? { id: 'scope-proof', sessionID: 's', type: 'compaction' } : original(path, method, body);
  expect(await c.compact()).toBe(true);
  expect(h.storage.get(`nsh:compact:v1:${c.historyActionStorageKey}`)).toBe(JSON.stringify({ status: 'acknowledged', inboxID: 'scope-proof' }));
  const scope = (host: typeof base, change = target) => { state.app.connection.set(host); return state.createChat(change).historyActionStorageKey; };
  expect(JSON.parse(decodeURIComponent(c.historyActionStorageKey!))).toEqual(['fixture', 'https://host.example', null, 'session', '/repo', 's']);
  const keys = [c.historyActionStorageKey, scope({ ...base, id: 'other-host' }), scope({ ...base, url: 'https://other.example' }), scope({ ...base, authorizationID: 'other-auth' }),
    scope(base, { ...target, id: 'other-session' }), scope(base, { ...target, directory: '/other-directory' })];
  expect(new Set(keys).size).toBe(keys.length);
  state.app.connection.set(base);
});
it('failed compact receipt clearing keeps the old intent non-replayable while new ordinary inputs remain recoverable', async () => {
  staged = null; const { chat: c } = await chat(), original = handle;
  handle = (path, method, body) => {
    if (path.includes('/compact?')) return { id: 'clear-failure', sessionID: 's', type: 'compaction' };
    if (path.includes('/delivery?')) return { data: [], compactionRunning: false };
    return original(path, method, body);
  };
  expect(await c.compact()).toBe(true);
  h.storageWrite = async (key, value) => {
    if (key.startsWith('nsh:compact:') && value === 'null') throw new Error('Clear storage result unknown');
    h.storage.set(key, value);
  };
  await c.load(false, ['inbox']);
  expect(c.compactReceipt()?.status).toBe('unknown'); expect(c.compactionBarrier()).toBe(false);
  c.draft.set('Not sealed by old receipt'); expect(await c.send()).toBe(true);
  expect(await c.compact()).toBe(false); expect(requests().filter(input => input.path.includes('/compact?'))).toHaveLength(1);
});
it('slash undo crosses multiple full native pages through production loadOlder before selecting a user', async () => {
  const original = handle;
  const middle = Array.from({ length: 20 }, (_, i) => ({ id: `middle-${i}`, type: 'assistant', text: 'Context' }));
  const tail = [{ id: 'a-boundary', type: 'user', text: 'Boundary' }, ...Array.from({ length: 19 }, (_, i) => ({ id: `tail-${i}`, type: 'assistant', text: 'Tail' }))];
  handle = (path, method, body) => {
    if (path.includes('/message?')) {
      if (path.includes('cursor=opaque-two')) return { data: [{ id: 'z-authoritative-before', type: 'user', text: 'Before' }], cursor: { next: null } };
      if (path.includes('cursor=opaque-one')) return { data: [...middle].reverse(), cursor: { next: 'opaque-two' } };
      return { data: [...tail].reverse(), cursor: { next: 'opaque-one' } };
    }
    if (path.includes('/revert/stage?')) return { messageID: (body as { messageID: string }).messageID };
    return original(path, method, body);
  };
  const { state, chat: c } = await chat();
  const { createTranscriptActions } = await import('./transcript-actions-core');
  let receipt: import('./transcript-actions-core').NativeSessionHistoryReceipt | null = null;
  const actions = createTranscriptActions({ target, send: state.captureHostRequest(), scope: { key: 'production-full-pages', current: () => true, busy: c.busy, message: () => undefined },
    onRevert: value => c.revert.set(value), sessionHistory: { refresh: () => c.prepareHistoryAction(() => true), snapshot: c.historyActionSnapshot, loadOlder: c.loadOlder,
      receipt: () => receipt, setReceipt: value => { receipt = value; } } });
  await actions.undoTurn();
  expect(c.revert()?.messageID).toBe('z-authoritative-before');
  expect(requests().filter(input => input.path.includes('/message?') && input.path.includes('cursor='))).toHaveLength(2);
  expect(requests().find(input => input.path.includes('/revert/stage?'))?.body?.messageID).toBe('z-authoritative-before');
});
it('a second slash undo retries its failed older boundary through the actual adapter without a scroll gesture', async () => {
  const original = handle;
  const tail = [{ id: 'a-boundary', type: 'user', text: 'Boundary' }, ...Array.from({ length: 19 }, (_, i) => ({ id: `tail-${i}`, type: 'assistant', text: 'Tail' }))];
  const middle = Array.from({ length: 20 }, (_, i) => ({ id: `middle-${i}`, type: 'assistant', text: 'Context' }));
  let failed = false;
  handle = (path, method, body) => {
    if (path.includes('/message?')) {
      if (path.includes('cursor=opaque-two')) {
        if (!failed) { failed = true; throw new Error('Recoverable second page failure'); }
        return { data: [{ id: 'previous-authoritative-user', type: 'user', text: 'Previous' }], cursor: { next: null } };
      }
      if (path.includes('cursor=opaque-one')) return { data: [...middle].reverse(), cursor: { next: 'opaque-two' } };
      return { data: [...tail].reverse(), cursor: { next: 'opaque-one' } };
    }
    if (path.includes('/revert/stage?')) return { messageID: (body as { messageID: string }).messageID };
    return original(path, method, body);
  };
  const { state, chat: c } = await chat(), { createTranscriptActions } = await import('./transcript-actions-core');
  let receipt: import('./transcript-actions-core').NativeSessionHistoryReceipt | null = null;
  const action = createTranscriptActions({ target, send: state.captureHostRequest(), scope: { key: 'retry-native-boundary', current: () => true, busy: c.busy, message: () => undefined },
    onRevert: value => c.revert.set(value), sessionHistory: { refresh: () => c.prepareHistoryAction(() => true), snapshot: c.historyActionSnapshot, loadOlder: c.loadOlder,
      receipt: () => receipt, setReceipt: value => { receipt = value; } } });
  await expect(action.undoTurn()).rejects.toThrow('authority');
  expect(c.historyError()).toContain('second page'); expect(requests().some(input => input.path.includes('/revert/stage?'))).toBe(false);
  await action.undoTurn(); expect(c.revert()?.messageID).toBe('previous-authoritative-user');
  expect(c.historyError()).toBe(''); expect(requests().filter(input => input.path.includes('cursor=opaque-one'))).toHaveLength(1);
  expect(requests().filter(input => input.path.includes('cursor=opaque-two'))).toHaveLength(2);
  expect(requests().filter(input => input.path.includes('/revert/stage?'))).toHaveLength(1);
});

it('loads authoritative revert and hides the inclusive tail by sequence, not ID order', async () => {
  const { chat: c } = await chat();
  expect(c.revert()).toEqual(staged);
  expect(c.messages().map(message => message.id)).toEqual(['z-before', 'a-boundary', 'm-tail']);
  expect(c.visibleMessages().map(message => message.id)).toEqual(['z-before']);
  staged = null; await c.load();
  expect(c.revert()).toBeNull(); expect(c.visibleMessages()).toHaveLength(3);
});
it('commits before prompt and permanently retires tail only after confirmed commit', async () => {
  const { chat: c } = await chat(); c.draft.set('Replacement');
  expect(await c.send()).toBe(true);
  const writes = requests().filter(input => input.method === 'POST');
  expect(writes.map(input => input.path)).toEqual(['/api/session/s/revert/commit?directory=%2Frepo', '/api/session/s/prompt?directory=%2Frepo']);
  expect(c.revert()).toBeNull(); expect(c.messages().map(message => message.id)).toEqual(['z-before']); expect(c.draft()).toBe('');
});
it('preserves revert, draft, files and pending stable ID on commit failure without dispatching prompt', async () => {
  const { chat: c } = await chat(); const original = handle;
  handle = (path, method, body) => { if (path.includes('/revert/commit?')) throw new Error('Neutral commit failure'); return original(path, method, body); };
  c.draft.set('Keep draft'); c.attachments.set([{ uri: 'file:///host/keep', name: 'keep', mime: 'text/plain' }]);
  expect(await c.send()).toBe(false);
  const id = c.pendingSend()?.id;
  expect(c.revert()).toEqual(staged); expect(c.draft()).toBe('Keep draft'); expect(c.attachments()).toHaveLength(1);
  expect(requests().some(input => input.path.includes('/prompt?'))).toBe(false);
  expect(c.visibleMessages()).toHaveLength(1);
  handle = original; expect(await c.retrySend()).toBe(true);
  expect(requests().find(input => input.path.includes('/prompt?'))?.body?.id).toBe(id);
});
it('does not restore an already committed marker when prompt admission fails', async () => {
  const { chat: c } = await chat(); const original = handle;
  handle = (path, method, body) => { if (path.includes('/prompt?')) throw new Error('Neutral prompt failure'); return original(path, method, body); };
  c.draft.set('Keep replacement'); expect(await c.send()).toBe(false);
  expect(c.revert()).toBeNull(); expect(c.draft()).toBe('Keep replacement'); expect(c.pendingSend()).not.toBeNull();
  expect(c.visibleMessages().map(message => message.id)).toEqual(['z-before']);
});
it('blocks send/retry while history owns the session, including another mounted chat', async () => {
  const { state, chat: c } = await chat(); const other = state.createChat(target); await other.draftReady; await flush();
  c.historyBusy.set(true); other.draft.set('Do not send');
  expect(await other.send()).toBe(false);
  expect(requests().some(input => input.method === 'POST')).toBe(false);
  c.historyBusy.set(false); expect(other.historyBusy()).toBe(false);
});
it('a rejected action acquisition cannot release another in-flight history recovery owner', async () => {
  const { state, chat: c } = await chat(); const { createTranscriptActions } = await import('./transcript-actions-core');
  c.historyBusy.set(true);
  const actions = createTranscriptActions({ target, send: state.captureHostRequest(), scope: { key: 'fixture-shared-lock', current: () => true, busy: () => false, message: () => c.messages()[1] }, onPending: value => c.historyBusy.set(value) });
  await expect(actions.redo()).rejects.toThrow('pending');
  expect(c.historyBusy()).toBe(true); c.historyBusy.set(false);
  expect(requests().some(input => input.method === 'DELETE')).toBe(false);
});
it('blocks history mutation during async send preparation and releases the shared lane after failure', async () => {
  staged = null; const { state, chat: c } = await chat(); c.draft.set('Preparing');
  const gate = deferred<{ text: string }>(); const sending = c.send({ prepare: () => gate.promise }); await flush();
  const other = state.createChat(target); await other.draftReady;
  expect(() => other.historyBusy.set(true)).toThrow('pending');
  gate.resolve({ text: 'Prepared' }); await sending;
  expect(() => other.historyBusy.set(true)).not.toThrow(); other.historyBusy.set(false);
});
it('does not overwrite a newer staged marker with an older in-flight session snapshot', async () => {
  const { chat: c } = await chat(); const original = handle, gate = deferred<unknown>();
  handle = (path, method, body) => path === '/api/session/s?directory=%2Frepo' ? gate.promise : original(path, method, body);
  const loading = c.load(); await flush(); c.revert.set({ messageID: 'newer-boundary' });
  gate.resolve({ id: 's', revert: { messageID: 'a-boundary' } }); await loading;
  expect(c.revert()?.messageID).toBe('newer-boundary');
});
it('preserves current reference document under history-restore CAS and rejects another Host scope', async () => {
  staged = null; const { chat: c } = await chat();
  c.insertReference({ kind: 'file', value: '/repo/a', label: 'a', scope: c.referenceScope });
  const expected = c.referenceDocument();
  c.insertReference({ kind: 'agent', value: 'explore', label: 'explore', scope: c.referenceScope });
  expect(c.setReferenceDocument({ text: 'Historical', references: [], scope: c.referenceScope }, expected)).toBe(false);
  expect(c.references()).toHaveLength(2);
  expect(() => c.setReferenceDocument({ text: '', references: [], scope: { ...c.referenceScope, host: 'other' } })).toThrow('scope');
});

it('round-trips all five reference domains through the actual history backup and durable draft owner', async () => {
  staged = null; const { chat: c } = await chat();
  const backup = await import('./transcript-actions-backup');
  for (const kind of ['file', 'directory', 'agent', 'skill', 'session'] as const) c.insertReference({ kind, value: kind === 'file' || kind === 'directory' ? `/repo/${kind}` : `${kind}-value`, label: `${kind}-label`, scope: c.referenceScope });
  c.attachments.set([{ uri: 'file:///host/original', name: 'original.txt', mime: 'text/plain' }]);
  const original = backup.historyDraftSnapshot(c);
  const decoded = backup.historyDraftBackupFrom(backup.historyDraftBackupJSON([original]), c.referenceScope)[0]!;
  const historical = { text: 'Historical text', files: [], references: { text: 'Historical text', references: [], scope: c.referenceScope } };
  expect(backup.replaceHistoryDraft(c, historical, original)).toBe(true);
  expect(c.references()).toEqual([]);
  expect(backup.replaceHistoryDraft(c, decoded, backup.historyDraftSnapshot(c))).toBe(true);
  expect(c.references().map(ref => ref.kind)).toEqual(['file', 'directory', 'agent', 'skill', 'session']);
  expect(c.attachments()).toEqual(original.files); await c.flushDraft();
  vi.resetModules(); const next = await chat();
  expect(next.chat.references().map(ref => ref.value)).toEqual(original.references.references.map(ref => ref.value));
  expect(next.chat.attachments()).toEqual(original.files);
});
it('history backup accepts legacy text/files without inventing references and rejects another saved scope', async () => {
  const { chat: c } = await chat(); const backup = await import('./transcript-actions-backup');
  expect(backup.historyDraftBackupFrom(JSON.stringify({ text: '@not-a-reference', files: [] }), c.referenceScope)[0]?.references.references).toEqual([]);
  const original = backup.historyDraftSnapshot(c);
  const foreign = { ...original, references: { ...original.references, scope: { ...c.referenceScope, host: 'foreign' } } };
  expect(() => backup.historyDraftBackupFrom(backup.historyDraftBackupJSON([foreign]), c.referenceScope)).toThrow('scope');
});
it('history replacement CAS detects a new sidecar with identical visible text and never drops its file', async () => {
  staged = null; const { chat: c } = await chat(); const backup = await import('./transcript-actions-backup');
  c.insertReference({ kind: 'skill', value: 'old', label: 'same', scope: c.referenceScope });
  const original = backup.historyDraftSnapshot(c);
  c.setDraftText(''); c.insertReference({ kind: 'skill', value: 'new', label: 'same', scope: c.referenceScope });
  c.attachments.set([{ uri: 'file:///host/new', name: 'new', mime: 'text/plain' }]);
  expect(c.draft()).toBe(original.text);
  expect(backup.replaceHistoryDraft(c, original, { ...original, files: c.attachments() })).toBe(false);
  expect(c.references()[0]?.value).toBe('new'); expect(c.attachments()).toHaveLength(1);
});
it('repairs an ambiguously committed boundary from authority, retaining the replacement until retry admission', async () => {
  const { chat: c } = await chat(); const original = handle;
  handle = (path, method, body) => {
    if (path.includes('/revert/commit?')) { staged = null; rows = rows.slice(0, 1); throw new Error('Neutral lost commit response'); }
    return original(path, method, body);
  };
  c.draft.set('Replacement'); expect(await c.send()).toBe(false);
  expect(c.revert()).toBeNull(); expect(c.visibleMessages().map(message => message.id)).toEqual(['z-before']);
  const id = c.pendingSend()?.id; expect(c.draft()).toBe('Replacement');
  handle = original; expect(await c.retrySend()).toBe(true);
  expect(requests().filter(input => input.path.includes('/revert/commit?'))).toHaveLength(1);
  expect(requests().find(input => input.path.includes('/prompt?'))?.body?.id).toBe(id);
});
it('retains draft and sidecars when the page hides during commit and never dispatches a prompt', async () => {
  const { chat: c } = await chat(); const original = handle, gate = deferred<unknown>();
  handle = (path, method, body) => path.includes('/revert/commit?') ? gate.promise : original(path, method, body);
  c.insertReference({ kind: 'skill', value: 'keep', label: 'keep', scope: c.referenceScope });
  const input = c.referenceDocument(); const sending = c.send({ prepare: async () => ({ text: 'Prepared', skills: [{ id: 'keep' }] }) });
  await flush(); c.active.set(false); gate.resolve(null); expect(await sending).toBe(false);
  expect(c.referenceDocument()).toEqual(input);
  expect(requests().some(input => input.path.includes('/prompt?'))).toBe(false);
});
it('blocks admission and hides stale tail when a committed off-window boundary cannot yet be repaired', async () => {
  staged = { messageID: 'outside-loaded-window' }; const { chat: c } = await chat();
  expect(c.visibleMessages()).toEqual([]); expect(c.historyBoundaryMissing()).toBe(true);
  const original = handle;
  handle = (path, method, body) => {
    if (path.includes('/message?') && staged === null) throw new Error('Neutral history repair failure');
    return original(path, method, body);
  };
  c.draft.set('Keep until repaired'); expect(await c.send()).toBe(false);
  expect(c.revert()).toBeNull(); expect(c.historyRepairPending()).toBe(true); expect(c.visibleMessages()).toEqual([]);
  expect(c.draft()).toBe('Keep until repaired'); expect(requests().some(input => input.path.includes('/prompt?'))).toBe(false);
  handle = original; expect(await c.retrySend()).toBe(true); expect(c.historyRepairPending()).toBe(false);
  expect(requests().filter(input => input.path.includes('/revert/commit?'))).toHaveLength(1);
});
it('applies authoritative commit SSE and rejects late content from the retired tail without crashing on malformed stage metadata', async () => {
  const { chat: c } = await chat();
  expect(() => emit('session.revert.staged', { sessionID: 's', revert: { messageID: 'a-boundary', files: [{}] } })).not.toThrow();
  expect(c.revert()?.messageID).toBe('a-boundary');
  staged = null; rows = rows.slice(0, 1);
  emit('session.revert.committed', { sessionID: 's', to: 'a-boundary' });
  emit('session.text.delta', { sessionID: 's', assistantMessageID: 'm-tail', delta: 'Late stale tail' });
  await vi.advanceTimersByTimeAsync(32);
  expect(c.messages().map(message => message.id)).toEqual(['z-before']);
  expect(c.revert()).toBeNull();
});
