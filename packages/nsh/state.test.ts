import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeLocalCommandInvocation } from './composer-local-commands';
import { captureIssuedStream, issuedStream, resetIssuedStreams } from './tests/session-stream-fixture';

const harness = vi.hoisted(() => ({
  listeners: new Map<string, Set<(payload: unknown) => void>>(), cleanups: [] as Array<() => void>,
  effects: [] as Array<() => void | (() => void)>, disposers: [] as Array<() => void>,
  lifecycle: 'active', locale: 'en-US', call: vi.fn(), storage: new Map<string, string>(), getItem: vi.fn(), setItem: vi.fn(),
}));
vi.mock('nsh', () => ({
  batch: <T>(work: () => T) => work(),
  Storage: { getItem: harness.getItem, setItem: harness.setItem },
  signal: <T>(initial: T) => { let value = initial; return Object.assign(() => value, { set: (next: T) => { value = next; } }); },
  lifecycle: () => harness.lifecycle,
  locale: () => harness.locale, computed: <T>(work: () => T) => work,
  untracked: <T>(work: () => T) => work(),
  effect: (work: () => void | (() => void)) => { harness.effects.push(work); const stop = work(); if (stop) harness.disposers.push(stop); },
  cleanup: (work: () => void) => harness.cleanups.push(work),
  host: {
    available: () => true, call: harness.call,
    on: (name: string, work: (payload: unknown) => void) => {
      const listeners = harness.listeners.get(name) ?? new Set(); listeners.add(work); harness.listeners.set(name, listeners);
      return () => { listeners.delete(work); };
    },
  },
}));
const emit = (type: string, body: Record<string, unknown>, key = 'chat', metadata?: { directory?: string; expectedHost?: { hostID: string; lease: string } }) => {
  const issued = key === 'chat' || key === 'global' ? issuedStream(harness.call, key) : {};
  if (type === 'server.connected') for (const listener of harness.listeners.get('runtime.event') ?? []) listener({ ...issued, key, ...(metadata?.expectedHost ? { expectedHost: metadata.expectedHost } : {}), type: 'reconnected' });
  for (const listener of harness.listeners.get('runtime.event') ?? []) listener({ ...issued, key, ...(metadata?.expectedHost ? { expectedHost: metadata.expectedHost } : {}), data: JSON.stringify({ type, data: body, ...(metadata?.directory ? { location: { directory: metadata.directory } } : {}) }) });
};
const flush = async () => { for (let count = 0; count < 40; count++) await Promise.resolve(); };
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const target = { kind: 'session' as const, id: 's', title: 'Session', directory: '/repo' };
let handle: (path: string, method: string, body: unknown) => unknown;
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); harness.lifecycle = 'active'; harness.locale = 'en-US';
  resetIssuedStreams(harness.call);
  harness.listeners.clear(); harness.cleanups = []; harness.effects = []; harness.disposers = [];
  harness.storage.clear();
  harness.getItem.mockReset().mockImplementation(async (key: string) => harness.storage.get(key) ?? null);
  harness.setItem.mockReset().mockImplementation(async (key: string, value: string) => { harness.storage.set(key, value); });
  handle = (path) => {
    if (path === '/api/debug/location') return [];
    if (path.includes('/message?')) return { data: [{ id: 'history', type: 'assistant', content: [{ type: 'tool', state: { status: 'running' } }] }] };
    if (path === '/api/session/active') return {};
    const session = path.match(/^\/api\/session\/([^/?]+)\?/);
    if (session) return { id: decodeURIComponent(session[1]!) };
    if (path.includes('/inbox?') || path.includes('/form?') || path.includes('/permission/request?')) return [];
    if (path.includes('/contact/messages')) return { messages: [], complete: true, generation: 1, revision: 1 };
    if (path.endsWith('/assistants/snapshot')) return { assistants: [{ id: 'bot', sessionID: null, sessionGeneration: 2, working: false }] };
    return null;
  };
  harness.call.mockReset().mockImplementation(async (name, input) => {
    if (name === 'runtime.stream') captureIssuedStream(harness.call, input);
    if (name === 'connection.list') return { connections: [{ id: 'one', url: 'https://host.example', label: 'Host', lastUsedAt: 0 }], selected: 'one', runtimeScope: { hostID: 'one', lease: 'one-lease' } };
    if (name === 'runtime.request') return { status: 200, body: await handle(input.path, input.method, input.body) };
    return true;
  });
});
afterEach(() => { harness.disposers.forEach(stop => stop()); harness.cleanups.forEach(stop => stop()); vi.useRealTimers(); });
const requests = () => harness.call.mock.calls.filter(([name]) => name === 'runtime.request').map(([, input]) => input);

function magicInvocation(chat: ReturnType<(typeof import('./state'))['createChat']>): NativeLocalCommandInvocation {
  return { command: 'explore', tail: '', resourcePolicy: 'preserve', current: () => chat.active(), snapshot: {
    scope: chat.referenceScope, authority: 'test-page', target, revision: chat.composerRevision(), text: chat.draft(), inputMode: 'normal', active: true, ready: true,
    pending: false, unknown: false, sending: false, queueEditing: false, hasReferences: !!chat.references().length, hasMessages: false, selection: {},
  } };
}
function compactInvocation(chat: ReturnType<(typeof import('./state'))['createChat']>): NativeLocalCommandInvocation {
  const invocation = magicInvocation(chat); return { ...invocation, command: 'compact' };
}
describe('local compact uses the existing writer and native inbox barrier', () => {
  it('POSTs only id/delivery, persists write-ahead, validates the typed receipt and preserves all current resources', async () => {
    const state = await import('./state'); await state.loadConnections(); const authorityKey = (await import('./desktop-git-dispatch')).desktopGitDraftAuthority(state.app.connection()!);
    const chat = state.createChat(target, { draftAuthorityKey: authorityKey }); await chat.draftReady; await flush();
    const normal = handle; let inputID = '';
    handle = (path, method, body) => {
      if (path.includes('/compact?')) {
        const wire = body as { id: string; delivery: string }; inputID = wire.id;
        expect(Object.keys(wire).sort()).toEqual(['delivery', 'id']); expect(wire.delivery).toBe('steer');
        expect([...harness.storage.values()].map(value => JSON.parse(value)).find(value => value.pendingSend?.id === inputID).pendingSend).toMatchObject({ text: '', files: [], uncertain: true, localCompact: { version: 1, resourcePolicy: 'preserve' } });
        return { data: { id: wire.id, sessionID: 's', type: 'compaction', delivery: 'steer' } };
      }
      return normal(path, method, body);
    };
    const context = { kind: 'checks' as const, instructionsText: 'retained context', payloadText: '{}' };
    expect(await chat.stageContext({ hostID: 'one', lease: 'one-lease', authorityKey, directory: target.directory, sessionID: target.id, visibleText: '/compact', context })).toEqual({ status: 'staged' });
    const file = { uri: 'attachment://keep', name: 'keep', mime: 'text/plain' }; chat.attachments.set([file]); chat.busy.set(true);
    const invocation = compactInvocation(chat); invocation.snapshot.selection = { model: { providerID: 'do-not-set', modelID: 'do-not-borrow' } };
    expect(await chat.admitLocalCompact(invocation)).toEqual({ status: 'accepted' });
    expect(chat.draft()).toBe('/compact'); expect(chat.attachments()).toEqual([file]); expect(chat.pendingSend()).toBeNull(); expect(chat.compactionBarrier()).toBe(true);
    expect(chat.context()).toEqual(context);
    const posts = requests().filter(input => input.method === 'POST'); expect(posts).toHaveLength(1); expect(posts[0].path).toContain('/compact?'); expect(inputID).not.toBe('');
    await chat.retrySend(); expect(requests().filter(input => input.method === 'POST')).toHaveLength(1);
  });
  it('accepts the exact shared-registry bare-command consumption and never consumes later edits after ACK', async () => {
    const state = await import('./state'); await state.loadConnections(); const chat = state.createChat(target); await chat.draftReady; await flush(); const normal = handle, gate = deferred<unknown>();
    let sentID = ''; handle = (path, method, body) => { if (path.includes('/compact?')) { sentID = (body as { id: string }).id; return gate.promise; } return normal(path, method, body); };
    chat.setDraftText('/compact'); const outcomes: unknown[] = [], { createNativeLocalCommands } = await import('./composer-local-commands');
    const registry = createNativeLocalCommands({ t: key => key, read: () => compactInvocation(chat).snapshot, replaceText: (snapshot, value) => chat.compareAndSetDraftText(snapshot.revision, value), actions: { compact: { run: invocation => chat.admitLocalCompact(invocation) } }, onBlocked: vi.fn(), onConflict: vi.fn(), onOutcome: (_invocation, outcome) => outcomes.push(outcome) });
    expect(registry.submit().kind).toBe('started'); await flush(); expect(sentID).not.toBe(''); expect(chat.draft()).toBe('');
    chat.setDraftText('later input'); gate.resolve({ id: sentID, sessionID: 's', type: 'compaction' }); await registry.settled();
    expect(outcomes).toEqual([{ status: 'accepted' }]); expect(chat.draft()).toBe('later input'); registry.dispose();
  });
  it('unknown survives module restart and ordinary send/retry only reads exact compaction authority', async () => {
    let state = await import('./state'); await state.loadConnections(); const first = state.createChat(target); await first.draftReady; await flush(); const normal = handle; let inputID = '';
    handle = (path, method, body) => {
      if (path.includes('/compact?')) { inputID = (body as { id: string }).id; throw new Error('private lost compact'); }
      if (path.includes('/message/msg_')) throw Object.assign(new Error('missing'), { status: 404 });
      return normal(path, method, body);
    };
    first.setDraftText('/compact'); expect(await first.admitLocalCompact(compactInvocation(first))).toEqual({ status: 'unknown' }); expect(first.error()).not.toContain('private lost'); await first.flushDraft();
    harness.disposers.forEach(stop => stop()); harness.cleanups.forEach(stop => stop()); harness.disposers = []; harness.cleanups = []; await flush();
    vi.resetModules(); state = await import('./state'); await state.loadConnections(); const second = state.createChat(target); await second.draftReady; await flush(); second.setDraftText('new draft');
    expect(second.pendingSend()?.id).toBe(inputID); await second.send(); await second.retrySend(); expect(requests().filter(input => input.path.includes('/compact?'))).toHaveLength(1);
    handle = (path, method, body) => path.includes('/inbox?') ? [{ id: inputID, sessionID: 's', type: 'user', payload: { text: 'wrong type' } }] : path.includes(`/message/${inputID}?`) ? { id: inputID, sessionID: 's', type: 'user' } : normal(path, method, body);
    expect(await second.recoverPendingSend()).toBe(false); expect(second.pendingSend()?.id).toBe(inputID);
    handle = (path, method, body) => path.includes(`/message/${inputID}?`) ? { id: inputID, sessionID: 's', type: 'compaction', status: 'completed' } : normal(path, method, body);
    expect(await second.recoverPendingSend()).toBe(true); expect(second.pendingSend()).toBeNull(); expect(second.draft()).toBe('new draft'); expect(second.compactionBarrier()).toBe(false);
  });
  it.each([null, { id: 'wrong-id', sessionID: 's', type: 'compaction' }, { id: 'other', sessionID: 'other-session', type: 'compaction' }])('missing/coalesced/wrong-session compact ACK stays unknown: %s', async response => {
    const state = await import('./state'); await state.loadConnections(); const chat = state.createChat(target); await chat.draftReady; await flush(); const normal = handle;
    handle = (path, method, body) => path.includes('/compact?') ? response : normal(path, method, body); chat.setDraftText('/compact');
    expect(await chat.admitLocalCompact(compactInvocation(chat))).toEqual({ status: 'unknown' }); expect(chat.pendingSend()?.localCompact?.resourcePolicy).toBe('preserve');
    expect(chat.compactionBarrier()).toBe(response?.sessionID === 's' && response.type === 'compaction');
    await chat.retrySend();
    expect(requests().filter(input => input.path.includes('/compact?'))).toHaveLength(1);
  });
  it.each([400, 408, 429, 503])('classifies HTTP %s without assuming all dispatch failures are rejections', async status => {
    const state = await import('./state'); await state.loadConnections(); const chat = state.createChat(target); await chat.draftReady; await flush(); const normal = handle;
    handle = (path, method, body) => { if (path.includes('/compact?')) throw Object.assign(new Error('unsafe server details'), { status }); return normal(path, method, body); }; chat.setDraftText('/compact');
    expect(await chat.admitLocalCompact(compactInvocation(chat))).toEqual({ status: status === 400 ? 'rejected' : 'unknown' }); expect(chat.draft()).toBe('/compact');
    expect(!!chat.pendingSend()).toBe(status !== 400); expect(chat.error()).not.toContain('unsafe server');
  });
  it('fences ABA, hidden/read-only, queue edit, tail text and failed write-ahead before compact POST', async () => {
    const state = await import('./state'); await state.loadConnections(); const chat = state.createChat(target); await chat.draftReady; await flush(); chat.setDraftText('/compact'); const old = compactInvocation(chat);
    chat.setDraftText('other'); chat.setDraftText('/compact'); expect(await chat.admitLocalCompact(old)).toEqual({ status: 'rejected' });
    chat.setDraftText('/compact unconfirmed tail'); expect(await chat.admitLocalCompact(compactInvocation(chat))).toEqual({ status: 'rejected' }); chat.setDraftText('/compact');
    chat.queueEdit.set({ id: 'queue', text: 'queued', files: [] }); expect(await chat.admitLocalCompact(compactInvocation(chat))).toEqual({ status: 'rejected' }); chat.queueEdit.set(null);
    chat.active.set(false); expect(await chat.admitLocalCompact(compactInvocation(chat))).toEqual({ status: 'rejected' }); chat.active.set(true);
    harness.setItem.mockRejectedValueOnce(new Error('disk')); expect(await chat.admitLocalCompact(compactInvocation(chat))).toEqual({ status: 'rejected' });
    const display = state.createChat(target, { readOnly: true }); expect(await display.admitLocalCompact(compactInvocation(display))).toEqual({ status: 'rejected' });
    expect(requests().filter(input => input.method === 'POST')).toEqual([]); expect(chat.draft()).toBe('/compact');
  });
  it('shares inbox and live compaction barrier with steer promotion, and ignores stale terminal events', async () => {
    const state = await import('./state'); await state.loadConnections(); const chat = state.createChat(target); await chat.draftReady; await flush(); const normal = handle;
    const user = { id: 'queued', sessionID: 's', type: 'user', delivery: 'queue', payload: { text: 'queue text' } }; let compact = true;
    handle = (path, method, body) => path.includes('/inbox?') ? [...(compact ? [{ id: 'compaction-current', sessionID: 's', type: 'compaction' }] : []), user] : normal(path, method, body);
    expect(await chat.steerInbox('queued')).toBe(false); expect(chat.compactionBarrier()).toBe(true); expect(requests().some(input => input.method === 'PATCH')).toBe(false);
    await chat.load(false, ['inbox']); expect(chat.inbox().map(item => item.id)).toEqual(['queued']);
    emit('session.compaction.ended', { sessionID: 's', inputID: 'older-compaction' }); expect(chat.compactionBarrier()).toBe(true);
    compact = false; emit('session.compaction.ended', { sessionID: 's', inputID: 'compaction-current' }); expect(chat.compactionBarrier()).toBe(false);
    expect(await chat.steerInbox('queued')).toBe(true); expect(requests().filter(input => input.method === 'PATCH')).toHaveLength(1);
  });
  it('ACK is final despite failed refresh and empty inbox does not erase a running native barrier', async () => {
    const state = await import('./state'); await state.loadConnections(); const chat = state.createChat(target); await chat.draftReady; await flush(); const normal = handle; let acknowledged = false;
    handle = (path, method, body) => { if (path.includes('/compact?')) { acknowledged = true; return { id: (body as { id: string }).id, sessionID: 's', type: 'compaction' }; } if (acknowledged && path.includes('/message?')) throw new Error('read failed'); return normal(path, method, body); };
    chat.setDraftText('/compact'); expect(await chat.admitLocalCompact(compactInvocation(chat))).toEqual({ status: 'accepted' }); expect(chat.pendingSend()).toBeNull(); expect(chat.compactionBarrier()).toBe(true);
    await chat.load(false, ['inbox']); expect(chat.compactionBarrier()).toBe(true); await chat.retrySend(); expect(requests().filter(input => input.path.includes('/compact?'))).toHaveLength(1);
  });
  it('a previous completed checkpoint cannot clear a newer pending compaction from the same authoritative inbox', async () => {
    const state = await import('./state'); await state.loadConnections(); const chat = state.createChat(target); await chat.draftReady; await flush(); const normal = handle;
    handle = (path, method, body) => path.includes('/inbox?') ? [{ id: 'new-pending', sessionID: 's', type: 'compaction' }] : path.includes('/message?') ? { data: [{ id: 'old-completed', sessionID: 's', type: 'compaction', status: 'completed' }] } : normal(path, method, body);
    await chat.load(false, ['inbox']); await chat.load(false, ['messages']); expect(chat.compactionBarrier()).toBe(true);
    emit('session.compaction.ended', { sessionID: 's', inputID: 'old-completed' }); expect(chat.compactionBarrier()).toBe(true);
    emit('session.compaction.failed', { sessionID: 's', inputID: 'new-pending' }); expect(chat.compactionBarrier()).toBe(false);
  });
  it('late inbox reads cannot re-activate a compaction after its exact live terminal event', async () => {
    const state = await import('./state'); await state.loadConnections(); const chat = state.createChat(target); await chat.draftReady; await flush(); const normal = handle, gate = deferred<unknown>();
    handle = (path, method, body) => path.includes('/inbox?') ? gate.promise : normal(path, method, body);
    const loading = chat.load(false, ['inbox']); await flush(); emit('session.compaction.started', { sessionID: 's', inputID: 'current' }); emit('session.compaction.ended', { sessionID: 's', inputID: 'current' });
    gate.resolve([{ id: 'current', sessionID: 's', type: 'compaction' }]); await loading; expect(chat.compactionBarrier()).toBe(false);
  });
});
describe('local magic real writer admission', () => {
  it('dispatches a stable steer receipt through history authority without consuming any composer resources or inbox', async () => {
    const state = await import('./state'); await state.loadConnections(); const authorityKey = (await import('./desktop-git-dispatch')).desktopGitDraftAuthority(state.app.connection()!);
    const chat = state.createChat(target, { draftAuthorityKey: authorityKey }); await chat.draftReady; await flush();
    const normal = handle;
    const existingQueue = [{ id: 'existing', sessionID: 's' }];
    handle = (path, method, body) => path.includes('/prompt?') ? { id: (body as Record<string, unknown>).id, sessionID: target.id } : path.includes('/inbox?') ? existingQueue : normal(path, method, body);
    const context = { kind: 'checks' as const, instructionsText: 'keep context', payloadText: '{}' };
    expect(await chat.stageContext({ hostID: 'one', authorityKey, lease: 'one-lease', directory: target.directory, sessionID: target.id, visibleText: '/explore ', context })).toEqual({ status: 'staged' });
    chat.insertReference({ kind: 'skill', value: 'review', label: 'Review' });
    const file = { uri: 'attachment://keep', name: 'keep.txt', mime: 'text/plain' }; chat.attachments.set([file]); chat.busy.set(true);
    const document = chat.referenceDocument(); chat.inbox.set(existingQueue);
    expect(await chat.admitLocalMagic({ text: '/goal NOT A COMMAND', files: [] }, magicInvocation(chat))).toEqual({ status: 'accepted' });
    const posts = requests().filter(input => input.method === 'POST');
    expect(posts).toHaveLength(1); expect(posts[0].path).toContain('/prompt?');
    expect(posts[0].body).toMatchObject({ text: '/goal NOT A COMMAND', delivery: 'steer' });
    expect(posts[0].body.files).toBeUndefined(); expect(posts[0].body.skills).toBeUndefined();
    expect(chat.referenceDocument()).toEqual(document); expect(chat.attachments()).toEqual([file]); expect(chat.pendingSend()).toBeNull();
    expect(chat.context()).toEqual(context); expect(chat.inbox()).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'existing' })]));
  });
  it('rejects ABA and resource-bearing compiled output before any write dispatch', async () => {
    const state = await import('./state'); await state.loadConnections(); const chat = state.createChat(target); await chat.draftReady; await flush();
    chat.setDraftText('/explore'); const invocation = magicInvocation(chat); chat.setDraftText('changed'); chat.setDraftText('/explore');
    expect(await chat.admitLocalMagic({ text: 'compiled', files: [] }, invocation)).toEqual({ status: 'rejected' });
    for (const compiled of [{ text: 'compiled' }, { text: 'compiled', files: [{ uri: 'file:///borrowed' }] }, { text: 'compiled', files: [], agents: [{ name: 'borrowed' }] }]) {
      expect(await chat.admitLocalMagic(compiled, magicInvocation(chat))).toEqual({ status: 'rejected' });
    }
    expect(requests().filter(input => input.method === 'POST')).toEqual([]); expect(chat.pendingSend()).toBeNull();
  });
  it('journals unknown before POST, survives module restart, and ordinary send/retry performs only exact reads', async () => {
    let state = await import('./state'); await state.loadConnections(); const first = state.createChat(target); await first.draftReady; await flush();
    const normal = handle; let inputID = '';
    handle = (path, method, body) => {
      if (path.includes('/prompt?')) {
        inputID = (body as { id: string }).id;
        expect([...harness.storage.values()].map(value => JSON.parse(value)).find(value => value.pendingSend?.id === inputID).pendingSend).toMatchObject({ uncertain: true, localMagic: { version: 1, resourcePolicy: 'preserve' }, compiled: { text: 'compiled', files: [] } });
        throw new Error('private unsafe error');
      }
      if (path.includes('/message/msg_')) throw Object.assign(new Error('not found'), { status: 404 });
      return normal(path, method, body);
    };
    first.setDraftText('/explore'); expect(await first.admitLocalMagic({ text: 'compiled', files: [] }, magicInvocation(first))).toEqual({ status: 'unknown' });
    expect(first.error()).not.toContain('private unsafe'); await first.flushDraft();
    harness.disposers.forEach(stop => stop()); harness.cleanups.forEach(stop => stop()); harness.disposers = []; harness.cleanups = []; await flush();
    vi.resetModules(); state = await import('./state'); await state.loadConnections(); const second = state.createChat(target); await second.draftReady; await flush();
    expect(second.pendingSend()?.id).toBe(inputID); second.setDraftText('new edit'); await second.send(); await second.retrySend();
    expect(requests().filter(input => input.path.includes('/prompt?'))).toHaveLength(1);
    handle = (path, method, body) => path.includes(`/message/${inputID}?`) ? { id: inputID, sessionID: 's' } : normal(path, method, body);
    expect(await second.recoverPendingSend()).toBe(true); expect(second.draft()).toBe('new edit'); expect(second.pendingSend()).toBeNull();
  });
  it('distinguishes definitive 400 from a void or mismatched prompt receipt', async () => {
    const state = await import('./state'); await state.loadConnections(); const chat = state.createChat(target); await chat.draftReady; await flush(); const normal = handle;
    chat.setDraftText('/explore'); handle = (path, method, body) => { if (path.includes('/prompt?')) throw Object.assign(new Error('denied'), { status: 400 }); return normal(path, method, body); };
    expect(await chat.admitLocalMagic({ text: 'compiled', files: [] }, magicInvocation(chat))).toEqual({ status: 'rejected' }); expect(chat.pendingSend()).toBeNull();
    handle = (path, method, body) => path.includes('/prompt?') ? undefined : normal(path, method, body);
    expect(await chat.admitLocalMagic({ text: 'compiled', files: [] }, magicInvocation(chat))).toEqual({ status: 'unknown' }); expect(chat.pendingSend()?.uncertain).toBe(true);
  });
  it('rechecks document and hidden authority after asynchronous pre-dispatch work', async () => {
    const state = await import('./state'); await state.loadConnections(); const chat = state.createChat(target); await chat.draftReady; await flush();
    const normal = handle, gate = deferred<unknown>();
    handle = (path, method, body) => path.startsWith('/api/session/s?') ? gate.promise : normal(path, method, body);
    chat.setDraftText('/explore'); const flight = chat.admitLocalMagic({ text: 'compiled', files: [] }, magicInvocation(chat)); await flush();
    chat.setDraftText('new'); chat.setDraftText('/explore'); gate.resolve({ id: 's' });
    expect(await flight).toEqual({ status: 'rejected' }); expect(chat.pendingSend()).toBeNull(); expect(requests().filter(input => input.method === 'POST')).toEqual([]);
    chat.active.set(false); expect(await chat.admitLocalMagic({ text: 'compiled', files: [] }, magicInvocation(chat))).toEqual({ status: 'rejected' });
  });
  it('readonly display cannot mutate or steal a journal through the new writer port', async () => {
    const state = await import('./state'); await state.loadConnections(); const chat = state.createChat(target, { readOnly: true }); await chat.draftReady; await flush();
    const before = harness.setItem.mock.calls.length;
    expect(await chat.admitLocalMagic({ text: 'compiled', files: [] }, magicInvocation(chat))).toEqual({ status: 'rejected' });
    expect(await chat.dispatchLocalMagicHandoff('forged')).toEqual({ status: 'rejected' });
    expect(harness.setItem.mock.calls).toHaveLength(before); expect(requests().filter(input => input.method === 'POST')).toEqual([]);
  });
  it('failed write-ahead rejects without a POST or consuming resources', async () => {
    const state = await import('./state'); await state.loadConnections(); const chat = state.createChat(target); await chat.draftReady; await flush();
    chat.setDraftText('/explore'); harness.setItem.mockRejectedValueOnce(new Error('disk'));
    expect(await chat.admitLocalMagic({ text: 'compiled', files: [] }, magicInvocation(chat))).toEqual({ status: 'rejected' });
    expect(chat.draft()).toBe('/explore'); expect(chat.pendingSend()).toBeNull(); expect(requests().filter(input => input.method === 'POST')).toEqual([]);
  });
  it('rejects resource ABA and existing pending/queue-edit locks without mutating their owners', async () => {
    const state = await import('./state'); await state.loadConnections(); const chat = state.createChat(target); await chat.draftReady; await flush(); chat.setDraftText('/explore');
    const invocation = magicInvocation(chat), file = { uri: 'attachment://temp', name: 'temp', mime: 'text/plain' };
    chat.attachments.set([file]); chat.attachments.set([]);
    expect(await chat.admitLocalMagic({ text: 'compiled', files: [] }, invocation)).toEqual({ status: 'rejected' });
    chat.queueEdit.set({ id: 'queued', text: 'original queue', files: [] });
    expect(await chat.admitLocalMagic({ text: 'compiled', files: [] }, magicInvocation(chat))).toEqual({ status: 'rejected' }); expect(chat.queueEdit()?.id).toBe('queued');
    chat.queueEdit.set(null); chat.pendingSend.set({ id: 'previous', text: 'old', files: [], uncertain: true, delivery: 'queue' });
    expect(await chat.admitLocalMagic({ text: 'compiled', files: [] }, magicInvocation(chat))).toEqual({ status: 'rejected' }); expect(chat.pendingSend()?.id).toBe('previous');
    expect(requests().filter(input => input.method === 'POST')).toEqual([]);
  });
  it('uses the original staged-history commit and fences late repair before the prompt dispatch', async () => {
    const state = await import('./state'); await state.loadConnections(); const chat = state.createChat(target); await chat.draftReady; await flush();
    const normal = handle, gate = deferred<unknown>(); let committed = false;
    handle = (path, method, body) => {
      if (path.startsWith('/api/session/s?')) return { id: 's', ...(committed ? {} : { revert: { messageID: 'not-loaded-boundary' } }) };
      if (path.includes('/revert/commit?')) { committed = true; return undefined; }
      if (path.includes('/message?') && committed) return gate.promise;
      return normal(path, method, body);
    };
    chat.setDraftText('/explore'); const flight = chat.admitLocalMagic({ text: 'compiled', files: [] }, magicInvocation(chat)); await flush();
    expect(committed).toBe(true); chat.setDraftText('new edit during repair'); gate.resolve({ data: [], complete: true });
    expect(await flight).toEqual({ status: 'rejected' }); expect(chat.draft()).toBe('new edit during repair'); expect(chat.pendingSend()).toBeNull();
    expect(requests().filter(input => input.method === 'POST').map(input => input.path)).toEqual([expect.stringContaining('/revert/commit?')]);
  });
});

describe('production root error ownership', () => {
  it('renders only localized safe summaries and never grants retry to an unknown mutation outcome', async () => {
    const state = await import('./state'); await state.loadConnections();
    await state.run(async () => { throw new Error('HTTP 500 https://private.example /host/path bearer=secret stack'); });
    expect(state.app.error()).toBe('The operation could not complete. Try again, or close this notice and recover from the original page.');
    expect(state.rootErrorFeedback()?.retry).toBeUndefined();
    state.rootErrorActions.dismiss(state.rootErrorFeedback()!.id);
    expect(state.rootErrorFeedback()?.visible).toBe(false);
    harness.locale = 'zh-CN';
    state.report(Object.assign(new Error("nsh/host: 'connection.list' not granted: add it to capabilities.host /host/private bearer=secret"), { code: 'ERR_ACCESS_DENIED' }));
    expect(state.app.error()).toBe('此版本缺少所需权限。请更新应用后重试。');
    expect(state.rootErrorFeedback()?.retry).toBeUndefined();
  }, 20_000);
  it('captures original recovery; another successful action does not clear the failure', async () => {
    const state = await import('./state'); await state.loadConnections();
    const recover = vi.fn(async () => {});
    await state.run(async () => { throw new Error('read failed'); }, { retry: recover });
    await state.run(async () => {});
    expect(state.rootErrorFeedback()?.retry).toBe(recover);
    await state.rootErrorActions.retry(state.rootErrorFeedback()!.id);
    expect(recover).toHaveBeenCalledTimes(1); expect(state.app.error()).toBe('');
  });
  it('rejects stale same-Host lease and A→B→A failures before they can replace a new notice', async () => {
    const state = await import('./state'); await state.loadConnections();
    let reject!: (error: unknown) => void;
    const old = state.run(() => new Promise((_resolve, no) => { reject = no; }));
    state.app.runtimeScope.set({ hostID: 'one', lease: 'two-lease' });
    await state.run(async () => { throw new Error('current failure'); });
    const latest = state.rootErrorFeedback(); reject(new Error('late old lease')); await old;
    expect(state.rootErrorFeedback()).toBe(latest);
    const aba = state.run(() => new Promise((_resolve, no) => { reject = no; }));
    state.app.runtimeScope.set({ hostID: 'two', lease: 'two' });
    state.app.runtimeScope.set({ hostID: 'one', lease: 'third-lease' });
    reject(new Error('late A')); await aba; expect(state.rootErrorFeedback()).toBe(latest);
  });
  it('captures page-operation lifetime at dispatch and rejects a callback after hide/reopen', async () => {
    const state = await import('./state'); await state.loadConnections();
    let generation = 1, reject!: (error: unknown) => void;
    const stop = state.registerFeedbackPageOwner(() => { const captured = generation; return () => captured === generation; });
    const pending = state.run(() => new Promise((_resolve, no) => { reject = no; }));
    generation += 2; reject(new Error('old page')); await pending;
    expect(state.rootErrorFeedback()).toBeNull(); stop();
  });
  it('a new captured attachment retirement failure replaces a closed notice and retries only its exact old cleanup', async () => {
    const state = await import('./state'), { createAttachmentPick } = await import('./attachment-pick'); await state.loadConnections();
    state.report(new Error('old failure')); const old = state.rootErrorFeedback()!; state.rootErrorActions.dismiss(old.id);
    const scope = state.app.runtimeScope()!, pending = deferred<unknown>(); let fails = true;
    const call = vi.fn(async (name: string, _body: Record<string, unknown>) => {
      if (name === 'runtime.pickAttachment') return pending.promise;
      if (name === 'runtime.cancelAttachment') { if (fails) throw new Error('private retirement stack'); return true; }
      throw new Error('Unexpected attachment call');
    });
    const picker = createAttachmentPick({ target: { kind: 'session', id: 's' }, current: () => true, call, busy: () => {},
      failed: (phase, failure, retirement) => { if (phase === 'cancel' && retirement) state.reportOwnedError(failure, retirement, 'chat.attachments.retirementPending'); } });
    const flight = picker.pick({ scope, current: () => true }, 'files'); await flush();
    picker.dispose(); await flush();
    const next = state.rootErrorFeedback()!;
    expect(next.id).not.toBe(old.id); expect(next.visible).toBe(true);
    expect(next.message).toBe('Attachment retirement is unconfirmed. Tap Attach again to retry. No files were deleted.');
    expect(next.retry).toBeTypeOf('function'); fails = false;
    await state.rootErrorActions.retry(next.id);
    const cancels = call.mock.calls.filter(([name]) => name === 'runtime.cancelAttachment');
    expect(cancels).toHaveLength(2); expect(cancels[1][1]).toEqual(cancels[0][1]); expect(cancels[1][1].expectedHost).toEqual(scope);
    expect(state.rootErrorFeedback()).toBeNull(); pending.resolve(null); await flight;
  });
  it('retirement reporting never captures a replacement Host or lease at failure time', async () => {
    const state = await import('./state'); await state.loadConnections();
    const scope = state.app.runtimeScope()!, retry = vi.fn(async () => {}), owner = { scope, current: () => true, retry };
    state.app.runtimeScope.set({ hostID: 'other', lease: 'B' });
    state.report(new Error('new Host failure')); const latest = state.rootErrorFeedback();
    state.reportOwnedError(new Error('old cleanup failure'), owner, 'chat.attachments.retirementPending');
    expect(state.rootErrorFeedback()).toBe(latest);
    state.app.runtimeScope.set({ hostID: scope.hostID, lease: 'A-new' });
    state.reportOwnedError(new Error('old cleanup failure'), owner, 'chat.attachments.retirementPending');
    expect(state.rootErrorFeedback()).toBe(latest); expect(retry).not.toHaveBeenCalled();
  });
});

describe('production contact attachment pipeline', () => {
  const botTarget = { kind: 'assistant' as const, id: 'bot', title: 'Bot', directory: '' };
  const descriptor = (mime: string, filename: string) => ({ type: 'file' as const, attachmentID: `att_${filename.replace(/\W/g, '_')}`, sha256: 'a'.repeat(64), size: 12, mime, filename, generation: 1 });
  it.each([['image/png', 'photo.png'], ['application/pdf', 'report.pdf']])('adopts %s picker descriptor, persists/remounts, sends exact parts and reads contact preview', async (mime, filename) => {
    const state = await import('./state'); await state.loadConnections();
    const first = state.createChat(botTarget); await first.draftReady; await first.load(false, ['messages']);
    const picked = descriptor(mime, filename), selection = first.captureAttachment();
    expect(selection.adopt(picked)).toBe(true);
    first.setDraftText('inspect'); await first.flushDraft();
    const chat = state.createChat(botTarget); await chat.draftReady;
    expect(chat.attachments()).toEqual(first.attachments());
    const file = chat.attachments()[0]!;
    expect(file.kind).toBe('contact'); expect(file.uri).toBeUndefined();
    const { bindContactAttachmentRead } = await import('./resources-request');
    const call = vi.fn(async () => ({ lease: 'preview', kind: 'image', size: 12 }));
    await bindContactAttachmentRead(state.app.runtimeScope(), call)(file, 'read-1');
    expect(call).toHaveBeenCalledWith('resources.read', expect.objectContaining({ source: { kind: 'contact', assistantID: 'bot', descriptor: picked }, expectedHost: state.app.runtimeScope(), requestId: 'read-1' }));
    const normal = handle;
    handle = (path, method, body) => path.endsWith('/bot/messages') && method === 'POST' ? { admitted: true, messageID: (body as { messageID: string }).messageID } : normal(path, method, body);
    const { compileNativePrompt } = await import('./composer');
    const sent = await chat.send({ prepare: input => compileNativePrompt(input, async () => { throw new Error('unexpected compiler GET'); }) });
    expect(sent, chat.error()).toBe(true);
    const posts = requests().filter(input => input.method === 'POST');
    expect(posts).toHaveLength(1); expect(posts[0].body.parts).toEqual([{ type: 'text', text: 'inspect' }, picked]);
    expect(JSON.stringify(posts[0].body)).not.toMatch(/file:\/\/|hostID|attachment_upload|"uri"/);
    expect(chat.attachments()).toEqual([]);
  });
  it('unknown send only reconciles, preserves descriptor on read failure/empty, and does not POST twice', async () => {
    const state = await import('./state'); await state.loadConnections(); const chat = state.createChat(botTarget); await chat.draftReady; await chat.load(false, ['messages']);
    chat.captureAttachment().adopt(descriptor('image/png', 'photo.png'));
    const normal = handle;
    handle = (path, method, body) => { if (method === 'POST') throw new Error('lost ACK'); return normal(path, method, body); };
    expect(await chat.send()).toBe(false); expect(chat.pendingSend()?.uncertain).toBe(true);
    const remount = state.createChat(botTarget); await remount.draftReady;
    const before = remount.attachments();
    handle = (path, method, body) => { if (path.includes('/contact/messages')) throw new Error('read failed'); return normal(path, method, body); };
    expect(await remount.retrySend()).toBe(false); expect(remount.attachments()).toEqual(before);
    handle = normal; expect(await remount.retrySend()).toBe(false);
    expect(requests().filter(input => input.method === 'POST')).toHaveLength(1);
    expect(remount.pendingSend()?.files).toEqual(before);
  });
  it('rejects cross assistant/Host and stale adoption without touching another draft', async () => {
    const state = await import('./state'); await state.loadConnections(); const chat = state.createChat(botTarget); await chat.draftReady; await chat.load(false, ['messages']);
    const selection = chat.captureAttachment();
    const other = state.createChat({ ...botTarget, id: 'other' }); await other.draftReady; other.setDraftText('keep'); await other.flushDraft();
    await state.loadConnections({ forceReconnect: true });
    expect(selection.adopt(descriptor('text/plain', 'a.txt'))).toBe(false);
    expect(other.draft()).toBe('keep'); expect(chat.attachments()).toEqual([]);
  });
  it('unknown receipt recovery keeps newer text and attachments while clearing only the admitted snapshot', async () => {
    const state = await import('./state'); await state.loadConnections(); const chat = state.createChat(botTarget); await chat.draftReady; await chat.load(false, ['messages']);
    chat.setDraftText('original'); chat.captureAttachment().adopt(descriptor('image/png', 'old.png'));
    const normal = handle;
    handle = (path, method, body) => { if (method === 'POST') throw new Error('lost ACK'); return normal(path, method, body); };
    expect(await chat.send()).toBe(false); const pending = chat.pendingSend()!;
    chat.setDraftText('newer'); chat.captureAttachment().adopt(descriptor('application/pdf', 'new.pdf'));
    const newer = chat.attachments().find(file => file.name === 'new.pdf');
    handle = (path, method, body) => path.includes('/contact/messages?messageID=') ? { messages: [{ messageID: pending.id, ordinal: 1, role: 'user', parts: [{ type: 'text', text: 'original' }] }], complete: true, generation: 1, revision: 1 } : normal(path, method, body);
    expect(await chat.recoverPendingSend()).toBe(true);
    expect(chat.pendingSend()).toBeNull(); expect(chat.draft()).toBe('newer'); expect(chat.attachments()).toEqual([newer]);
    expect(requests().filter(input => input.method === 'POST')).toHaveLength(1);
  });
  it('actual capture requires authoritative contact generation and rejects later text ABA, reset, and duplicate adoption', async () => {
    const normal = handle;
    let available = false, generation = 3;
    handle = (path, method, body) => {
      if (path.includes('/contact/messages')) { if (!available) throw new Error('unknown generation'); return { messages: [], complete: true, generation, revision: 1 }; }
      return normal(path, method, body);
    };
    const state = await import('./state'); await state.loadConnections(); const chat = state.createChat(botTarget); await chat.draftReady; await flush();
    await expect(chat.captureAttachment().prepare()).rejects.toThrow('capture_stale');
    available = true; await chat.load(false, ['messages']);
    const selected = chat.captureAttachment(), context = await selected.prepare();
    expect(context.contactGeneration).toBe(3); expect(context.draftRevision).toBeGreaterThanOrEqual(0);
    chat.setDraftText('later'); chat.setDraftText('');
    expect(selected.adopt({ ...descriptor('text/plain', 'edit.txt'), generation: 3 })).toBe(false);
    const reset = chat.captureAttachment(); await reset.prepare(); generation = 4; await chat.load(false, ['messages']);
    expect(reset.adopt({ ...descriptor('text/plain', 'reset.txt'), generation: 3 })).toBe(false);
    const current = chat.captureAttachment(); await current.prepare();
    const raw = { ...descriptor('text/plain', 'current.txt'), generation: 4 };
    expect(current.adopt(raw)).toBe(true); expect(current.adopt(raw)).toBe(false); expect(chat.attachments()).toHaveLength(1);
  });
  it('actual page-operation A-B-A and native late ACK cannot append to the original or replacement draft', async () => {
    const state = await import('./state'); await state.loadConnections(); const chat = state.createChat(botTarget); await chat.draftReady; await chat.load(false, ['messages']);
    const { createPageOperations } = await import('./page-operations'); let visible = true;
    const pages = createPageOperations(() => visible), update = harness.effects.at(-1)!;
    const lane = pages.capture(), selection = chat.captureAttachment(lane);
    const { createAttachmentPick } = await import('./attachment-pick'), ack = deferred<unknown>();
    const call = vi.fn(async (name: string) => name === 'runtime.pendingAttachments' ? [] : name === 'runtime.pickAttachment' ? ack.promise : null);
    const picker = createAttachmentPick({ target: botTarget, current: () => pages.current(), call, busy: () => {}, failed: () => {} });
    const flight = picker.pick(lane, 'files', selection); await flush();
    visible = false; update(); visible = true; update();
    expect(lane.current()).toBe(false); expect(pages.capture()).not.toBe(lane);
    ack.resolve(descriptor('text/plain', 'late.txt')); expect(await flight).toBe(false);
    expect(chat.attachments()).toEqual([]); expect(call.mock.calls.filter(([name]) => name === 'runtime.cancelAttachment')).toHaveLength(1);
  });
  it('explicit cold recovery adopts only the same durable checkpoint; newer edits keep their draft and reject recovery', async () => {
    const state = await import('./state'); await state.loadConnections(); const first = state.createChat(botTarget); await first.draftReady; await first.load(false, ['messages']);
    first.setDraftText('persisted'); const old = first.captureAttachment(), saved = await old.prepare(); old.retire();
    const second = state.createChat(botTarget); await second.draftReady; await second.load(false, ['messages']);
    const recovered = second.captureAttachment(); expect((await recovered.prepare()).draftRevision).toBe(saved.draftRevision);
    expect(recovered.recover(descriptor('text/plain', 'restored.txt'), saved.draftRevision)).toBe(true); await recovered.commit();
    expect(second.attachments()).toHaveLength(1);
    const changed = second.captureAttachment(); await changed.prepare(); second.setDraftText('new edit');
    expect(changed.recover(descriptor('text/plain', 'wrong.txt'), saved.draftRevision)).toBe(false);
    expect(second.draft()).toBe('new edit'); expect(second.attachments()).toHaveLength(1);
  });
  it('production picker recovery uses the actual durable adopter, persists before ACK and never opens another picker', async () => {
    const state = await import('./state'); await state.loadConnections();
    const first = state.createChat(botTarget); await first.draftReady; await first.load(false, ['messages']); first.setDraftText('original');
    const saved = await first.captureAttachment().prepare();
    const second = state.createChat(botTarget); await second.draftReady; await second.load(false, ['messages']);
    const lane = state.captureHostOperation(), selected = second.captureAttachment(lane), raw = descriptor('text/plain', 'recover.txt');
    const { createAttachmentPick } = await import('./attachment-pick');
    const call = vi.fn(async (name: string) => {
      if (name === 'runtime.pendingAttachments') return [{ requestId: 'original_request', assistantID: 'bot', uploadID: 'original_upload', generation: 1, draftRevision: saved.draftRevision, phase: 'unknown' }];
      if (name === 'runtime.reconcileAttachment') return raw;
      if (name === 'runtime.acknowledgeAttachment') expect([...harness.storage.values()].some(value => value.includes(raw.attachmentID))).toBe(true);
      return null;
    });
    const picker = createAttachmentPick({ target: botTarget, current: () => lane.current(), call, busy: () => {}, failed: () => {} });
    expect(await picker.pick(lane, 'images', selected)).toBe(true);
    expect(call.mock.calls.map(([name]) => name)).toEqual(['runtime.pendingAttachments', 'runtime.reconcileAttachment', 'runtime.acknowledgeAttachment']);
    expect(second.attachments()).toHaveLength(1); expect(second.draft()).toBe('original');
  });
  it('captured Host A-B-A never reauthorizes an older attachment adopter', async () => {
    const state = await import('./state'); await state.loadConnections(); const chat = state.createChat(botTarget); await chat.draftReady; await chat.load(false, ['messages']);
    const selected = chat.captureAttachment(state.captureHostOperation()); await selected.prepare();
    const originalCall = harness.call.getMockImplementation()!;
    let host = 'other', lease = 'other-lease';
    harness.call.mockImplementation(async (name, input) => name === 'connection.list' ? { selected: host, connections: [{ id: host, url: 'https://host.example', label: 'Fixture' }], runtimeScope: { hostID: host, lease } } : originalCall(name, input));
    await state.loadConnections(); host = 'one'; lease = 'one-new-lease'; await state.loadConnections();
    expect(selected.adopt(descriptor('text/plain', 'aba.txt'))).toBe(false); expect(chat.attachments()).toEqual([]);
  });
});

describe('root Projects attention observer', () => {
  it('1000-session root: 50 token events and draft events do zero identity lookups, index scans or requests', async () => {
    const state = await import('./state'); await state.loadConnections();
    const attention = await import('./projects-attention');
    const metadata = { directory: '/repo', expectedHost: { hostID: 'one', lease: 'one-lease' } };
    const rootEvent = (type: string, body: Record<string, unknown>) => emit(type, body, 'global', metadata);
    let scans = 0, rowReads = 0, lookups = 0, directoryReads = 0;
    const catalog = new Proxy(Array.from({ length: 1000 }, (_, index) => ({ id: `root-${index}`, title: `Root ${index}`, get directory() { directoryReads++; return '/repo'; }, updated: index })), { get(rows, key, receiver) {
      if (key === Symbol.iterator) scans++;
      if (typeof key === 'string' && /^\d+$/.test(key)) rowReads++;
      return Reflect.get(rows, key, receiver);
    } });
    state.app.sessions.set(catalog); const changed = vi.fn(); state.observeRuntime(changed);
    await flush(); expect(requests()).toEqual([expect.objectContaining({ path: '/api/debug/location', method: 'GET' })]); harness.call.mockClear();
    const originalGet = Map.prototype.get;
    const get = vi.spyOn(Map.prototype, 'get').mockImplementation(function (this: Map<unknown, unknown>, key: unknown) { if (key === 'root-500') lookups++; return originalGet.call(this, key); });
    const key = JSON.stringify([state.epoch(), state.app.connection()?.id]), unreadChanged = vi.fn();
    const stop = attention.projectsAttention.observe(key, unreadChanged);
    try {
      for (let index = 0; index < 50; index++) { rootEvent('session.text.delta', { sessionID: 'root-500', text: String(index) }); rootEvent('draft.changed', { sessionID: 'root-500' }); }
      expect({ scans, rowReads, lookups }).toEqual({ scans: 0, rowReads: 0, lookups: 0 }); expect(requests()).toEqual([]); expect(changed).not.toHaveBeenCalled();
      rootEvent('session.execution.started', { sessionID: 'root-500' });
      expect({ scans, rowReads, lookups }).toEqual({ scans: 1, rowReads: 1000, lookups: 1 });
      expect(directoryReads).toBe(0);
      expect(unreadChanged).not.toHaveBeenCalled();
      const running = state.desktopSidebarAuthority();
      rootEvent('session.execution.started', { sessionID: 'root-500' }); expect(state.desktopSidebarAuthority()).toBe(running);
      expect({ scans, rowReads, lookups }).toEqual({ scans: 1, rowReads: 1000, lookups: 2 });
      for (let index = 0; index < 50; index++) rootEvent('session.execution.failed', { sessionID: 'root-500', error: { message: 'Failed fixture turn' } });
      expect({ scans, rowReads, lookups }).toEqual({ scans: 1, rowReads: 1000, lookups: 52 });
      expect(attention.projectsAttention.snapshot(key).unseenBySession).toEqual({ 'root-500': 1 }); expect(unreadChanged).toHaveBeenCalledTimes(1);
      const settled = state.desktopSidebarAuthority(); rootEvent('session.idle', { sessionID: 'root-500' }); expect(state.desktopSidebarAuthority()).toBe(settled);
      expect(unreadChanged).toHaveBeenCalledTimes(1); expect(directoryReads).toBe(0);
      state.app.sessions.set([]); rootEvent('session.execution.started', { sessionID: 'root-500' });
      expect(lookups).toBe(54); expect(requests()).toEqual([]); expect(changed).not.toHaveBeenCalled();
    } finally { stop(); get.mockRestore(); }
  });
  it('the root observer deduplicates no-ID error aliases, honors real viewed/foreground and never invents unknown parents', async () => {
    const state = await import('./state'); await state.loadConnections(); const { projectsAttention } = await import('./projects-attention');
    state.app.sessions.set([{ id: 's', title: 'Root', directory: '/repo', updated: 1 }, { id: 'child', title: 'Child', directory: '/repo', updated: 2, parentID: 's' }]);
    state.observeRuntime(vi.fn()); const scope = JSON.stringify([state.epoch(), state.app.connection()?.id]);
    await flush(); expect(requests()).toEqual([expect.objectContaining({ path: '/api/debug/location', method: 'GET' })]); harness.call.mockClear();
    for (const listener of harness.listeners.get('runtime.event') ?? []) listener({ key: 'chat', data: JSON.stringify({ type: 'session.execution.failed', data: { sessionID: 's' } }) });
    harness.lifecycle = 'inactive'; emit('session.execution.failed', { sessionID: 's' }, 'global');
    expect(projectsAttention.snapshot(scope).unseenBySession).toEqual({});
    harness.lifecycle = 'active';
    emit('session.execution.failed', { sessionID: 'child' }, 'global'); emit('session.execution.failed', { sessionID: 'unknown' }, 'global');
    expect(projectsAttention.snapshot(scope).unseenBySession).toEqual({});
    for (const type of ['session.execution.failed', 'session.error', 'session.execution.failed', 'session.idle']) emit(type, { sessionID: 's' }, 'global');
    expect(projectsAttention.snapshot(scope).unseenBySession).toEqual({ s: 1 });
    projectsAttention.setViewedSession(scope, 's'); emit('session.execution.started', { sessionID: 's' }, 'global'); emit('session.execution.failed', { sessionID: 's' }, 'global');
    projectsAttention.setViewedSession(scope, null); emit('session.error', { sessionID: 's' }, 'global');
    expect(projectsAttention.snapshot(scope).unseenBySession).toEqual({});
    emit('session.status', { sessionID: 's', status: { type: 'busy' } }, 'global'); emit('session.execution.failed', { sessionID: 's' }, 'global');
    expect(projectsAttention.snapshot(scope).unseenBySession).toEqual({ s: 1 }); expect(requests()).toEqual([]);
  });
  it('directory-less compatibility builds its own fallback only once; scoped Location events never warm that index', async () => {
    const state = await import('./state'); await state.loadConnections(); const { projectsAttention } = await import('./projects-attention');
    const metadata = { directory: '/repo', expectedHost: { hostID: 'one', lease: 'one-lease' } };
    let scans = 0, directoryReads = 0;
    const catalog = new Proxy(Array.from({ length: 1000 }, (_, index) => ({ id: `root-${index}`, title: `Root ${index}`, get directory() { directoryReads++; return '/repo'; }, updated: index })), { get(rows, key, receiver) { if (key === Symbol.iterator) scans++; return Reflect.get(rows, key, receiver); } });
    state.app.sessions.set(catalog); state.observeRuntime(vi.fn()); await flush(); harness.call.mockClear();
    const scope = JSON.stringify([state.epoch(), state.app.connection()?.id]), notified = vi.fn(), stop = projectsAttention.observe(scope, notified);
    const { desktopSidebarSessionStateKey } = await import('./desktop-sidebar-projection');
    const liveKey = desktopSidebarSessionStateKey({ id: 'root-500', directory: '/repo' });
    try {
      emit('session.execution.started', { sessionID: 'root-500' }, 'global', metadata);
      expect({ scans, directoryReads }).toEqual({ scans: 1, directoryReads: 0 });
      // First missing-Location event pays one separate directory fallback build, not another attention build.
      emit('session.execution.failed', { sessionID: 'root-500' }, 'global');
      expect({ scans, directoryReads }).toEqual({ scans: 2, directoryReads: 1000 });
      expect(state.desktopSidebarAuthority()?.sessions?.get(liveKey)?.running).toBe(false);
      const settled = state.desktopSidebarAuthority();
      for (let i = 0; i < 50; i++) emit('session.execution.failed', { sessionID: 'root-500' }, 'global');
      expect(state.desktopSidebarAuthority()).toBe(settled); expect({ scans, directoryReads }).toEqual({ scans: 2, directoryReads: 1000 });
      expect(projectsAttention.snapshot(scope).unseenBySession).toEqual({ 'root-500': 1 }); expect(notified).toHaveBeenCalledTimes(1);
      state.app.sessions.set([]); emit('session.execution.started', { sessionID: 'root-500' }, 'global');
      expect(state.desktopSidebarAuthority()?.sessions?.get(liveKey)?.running).toBe(false);
      expect(requests()).toEqual([]);
    } finally { stop(); }
  });
  it('root Host-generation changes retire the old source and release it after the final Projects listener detaches', async () => {
    const state = await import('./state'); await state.loadConnections(); const { projectsAttention } = await import('./projects-attention');
    state.app.sessions.set([{ id: 's', title: 'Old root', directory: '/repo', updated: 1 }]); state.observeRuntime(vi.fn());
    const old = JSON.stringify([state.epoch(), state.app.connection()?.id]); const off = projectsAttention.observe(old, vi.fn());
    emit('session.execution.failed', { sessionID: 's' }, 'global'); expect(projectsAttention.snapshot(old).unseenBySession).toEqual({ s: 1 });
    harness.call.mockImplementation(async name => name === 'connection.list' ? { connections: [{ id: 'two', url: 'https://other.example' }], selected: 'two', runtimeScope: { hostID: 'two', lease: 'two-lease' } } : true);
    await state.loadConnections(); harness.effects.forEach(work => work());
    const next = JSON.stringify([state.epoch(), state.app.connection()?.id]);
    expect(projectsAttention.snapshot(old).unseenBySession).toEqual({}); expect(projectsAttention.snapshot(next).unseenBySession).toEqual({});
    expect(projectsAttention.retainedScopeCount()).toBe(2); off(); expect(projectsAttention.retainedScopeCount()).toBe(1);
    state.app.sessions.set([{ id: 's', title: 'New root', directory: '/other', updated: 2 }]); emit('session.execution.failed', { sessionID: 's' }, 'global');
    expect(projectsAttention.snapshot(next).unseenBySession).toEqual({ s: 1 });
    projectsAttention.ingest(old, { key: 'global', type: 'session.error', body: { sessionID: 's' }, directory: '/repo' }, { id: 's' });
    expect(projectsAttention.snapshot(old).unseenBySession).toEqual({});
    harness.cleanups.forEach(stop => stop()); expect(projectsAttention.retainedScopeCount()).toBe(0);
    emit('session.execution.failed', { sessionID: 's' }, 'global'); expect(projectsAttention.retainedScopeCount()).toBe(0);
  });
  it('keeps catalog coalescing and its foreground/epoch timer fence separate from attention-only events', async () => {
    const state = await import('./state'); await state.loadConnections(); const changed = vi.fn(); state.observeRuntime(changed);
    for (let index = 0; index < 50; index++) emit('yuri:assistants-changed', { revision: index }, 'global');
    await vi.advanceTimersByTimeAsync(119); expect(changed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(changed).toHaveBeenCalledTimes(1);
    emit('yuri:session-index-changed', {}, 'global'); harness.lifecycle = 'inactive'; await vi.advanceTimersByTimeAsync(120); expect(changed).toHaveBeenCalledTimes(1);
    emit('yuri:project-order-changed', {}, 'global'); harness.lifecycle = 'active'; await vi.advanceTimersByTimeAsync(120); expect(changed).toHaveBeenCalledTimes(1);
    emit('yuri:project-order-changed', {}, 'global');
    await state.loadConnections({ forceReconnect: true }); await vi.advanceTimersByTimeAsync(120); expect(changed).toHaveBeenCalledTimes(1);
  });
});

describe('original Chat safe writer retirement', () => {
  async function start() { const state = await import('./state'); await state.loadConnections(); const chat = state.createChat(target); await chat.draftReady; await flush(); return { state, chat }; }
  it('flushes the original draft/attachment journal, ignores server busy, pauses new writes and can cancel without closing the draft owner', async () => {
    const { chat } = await start(); chat.setDraftText('Keep the original draft'); chat.attachments.set([{ uri: 'attachment://kept', name: 'kept', mime: 'text/plain' }]); chat.busy.set(true);
    expect(chat.canReleaseWriter()).toBe(false); expect(chat.writerRetirement().needsFlush).toBe(true);
    expect(await chat.prepareWriterRetirement()).toBe(true); expect(chat.canReleaseWriter()).toBe(true);
    expect([...harness.storage.values()].map(value => JSON.parse(value))).toContainEqual(expect.objectContaining({ draft: 'Keep the original draft', attachments: [{ uri: 'attachment://kept', name: 'kept', mime: 'text/plain' }] }));
    const before = requests().length; expect(chat.setDraftText('cannot replace')).toBe(false); expect(await chat.send()).toBe(false); expect(requests()).toHaveLength(before);
    chat.cancelWriterRetirement(); expect(chat.canReleaseWriter()).toBe(false); expect(chat.setDraftText('Resume same owner')).toBe(true);
    expect(await chat.prepareWriterRetirement()).toBe(true); expect(chat.draft()).toBe('Resume same owner');
    expect(harness.call.mock.calls.some(([name]) => String(name).includes('writer'))).toBe(false);
  });
  it.each(['pending-send', 'queue-edit', 'sending', 'history-unresolved', 'queue-busy'] as const)('preserves the original %s protection instead of cleaning up to gain release', async reason => {
    const { chat } = await start();
    if (reason === 'pending-send') chat.pendingSend.set({ id: 'uncertain', text: 'uncertain', files: [], delivery: 'steer', uncertain: true });
    if (reason === 'queue-edit') chat.queueEdit.set({ id: 'editing', text: 'retained', files: [] });
    if (reason === 'sending') chat.sending.set(true);
    if (reason === 'history-unresolved') chat.historyBusy.set(true);
    if (reason === 'queue-busy') chat.queueBusy.set('item');
    const before = [chat.pendingSend(), chat.queueEdit(), chat.sending(), chat.historyBusy(), chat.queueBusy()];
    expect(await chat.prepareWriterRetirement()).toBe(false); expect(chat.writerRetirement().reasons).toContain(reason);
    expect([chat.pendingSend(), chat.queueEdit(), chat.sending(), chat.historyBusy(), chat.queueBusy()]).toEqual(before);
  });
  it('does not accept a stale flush ACK or failure; explicit retry keeps the original resources and owner', async () => {
    const { chat } = await start(), gate = deferred<void>(); let entered = false;
    harness.setItem.mockImplementationOnce(async (key: string, value: string) => { entered = true; await gate.promise; harness.storage.set(key, value); });
    chat.setDraftText('before flush'); const pending = chat.prepareWriterRetirement(); await flush(); expect(entered).toBe(true);
    chat.draft.set('changed during native flush'); gate.resolve(); expect(await pending).toBe(false); expect(chat.writerRetirement().needsFlush).toBe(true);
    harness.setItem.mockRejectedValueOnce(new Error('Synthetic Storage unavailable'));
    expect(await chat.prepareWriterRetirement()).toBe(false); expect(chat.draft()).toBe('changed during native flush'); expect(chat.draftStatus()).toBe('error');
    await chat.retryDraft(); expect(await chat.prepareWriterRetirement()).toBe(true);
  });
  it.each([undefined, 403] as const)('covers a real interrupt in-flight and distinguishes unknown transport from explicit rejection %s', async status => {
    const { chat } = await start(), gate = deferred<unknown>(), normal = handle;
    handle = (path, method, body) => path.includes('/interrupt?') ? gate.promise : normal(path, method, body);
    const stopping = chat.stop(); await flush(); expect(chat.writerRetirement().reasons).toContain('write-in-flight'); expect(await chat.prepareWriterRetirement()).toBe(false);
    gate.resolve(Promise.reject(Object.assign(new Error('Synthetic interrupt response lost'), status === undefined ? {} : { status })));
    await expect(stopping).rejects.toThrow();
    expect(chat.writerRetirement().reasons.includes('write-unconfirmed')).toBe(status === undefined);
    expect(await chat.prepareWriterRetirement()).toBe(status !== undefined);
  });
  it('reuses pendingSend recovery rather than retaining a second unknown journal after authoritative admission', async () => {
    const { chat } = await start(), normal = handle; let inputID = '';
    handle = (path, method, body) => {
      if (path.includes('/prompt?')) { inputID = (body as { id: string }).id; throw new Error('Synthetic lost admission'); }
      return normal(path, method, body);
    };
    chat.setDraftText('Recover once'); expect(await chat.send()).toBe(false); expect(chat.pendingSend()?.uncertain).toBe(true);
    expect(await chat.prepareWriterRetirement()).toBe(false); expect(chat.writerRetirement().reasons).not.toContain('write-unconfirmed');
    handle = (path, method, body) => path.includes(`/message/${inputID}?`) ? { id: inputID } : normal(path, method, body);
    expect(await chat.recoverPendingSend()).toBe(true); expect(chat.pendingSend()).toBeNull(); expect(await chat.prepareWriterRetirement()).toBe(true);
  });
});

describe('original Chat verified native writer consumer', () => {
  async function start(kind: 'session' | 'assistant' = 'session', readOnly = false, contactOptimistic = false) {
    const { StrictWriterHost } = await import('./desktop-writer-test-host'), core = await import('./desktop-writer-core');
    const producer = new StrictWriterHost(); let ownerLive = true;
    const client = (await core.loadDesktopWriterClient({ source: () => producer, current: () => true }))!;
    const entity = { ...target, kind, id: kind === 'session' ? 's' : 'bot' };
    const claim = client.claim({ expectedHost: producer.scope, target: { kind, id: entity.id }, current: () => ownerLive });
    expect(await claim.ready()).not.toBeNull();
    const grant = vi.fn(claim.grant), unknown = vi.fn(claim.markUnknown);
    const queued = ['q1', 'q2', 'q3'].map(id => ({ id, sessionID: entity.id, type: 'user', delivery: 'queue', payload: { text: 'Queued ' + id } }));
    handle = (path, method, body) => {
      if (path === '/api/session/active') return {};
      if (path.startsWith('/api/rpc/opencode.goal/get?')) return { output: null };
      if (path.includes('/message?')) return { data: [], cursor: { next: null } };
      if (path.includes('/message/')) throw Object.assign(new Error('Synthetic exact message not found'), { status: 404 });
      if (path.includes('/contact/messages')) return { messages: [], complete: true, generation: 1, revision: 1 };
      if (path.endsWith('/assistants/snapshot')) return { assistants: [{ id: 'bot', sessionID: 'assistant-bound', sessionGeneration: 2, working: false }] };
      if (path.includes('/messages') && method === 'POST') return { admitted: true, messageID: (body as { messageID: string }).messageID };
      if (path.includes('/prompt?')) return { id: (body as { id: string }).id, sessionID: entity.id, type: 'user', payload: { text: (body as { text: string }).text } };
      if (path.includes('/compact?')) return { id: (body as { id: string }).id, sessionID: entity.id, type: 'compaction', delivery: 'steer' };
      if (method === 'DELETE' && /\/inbox\/[^?]+\?/.test(path)) { const index = queued.findIndex(item => path.includes(`/inbox/${item.id}?`)); if (index >= 0) queued.splice(index, 1); return null; }
      if (path.includes('/inbox?')) return queued;
      if (path.startsWith('/api/session/s?')) return { id: 's', location: { directory: '/repo' } };
      if (path.startsWith('/api/command?')) return [{ name: 'build' }];
      if (method === 'GET') return [];
      return null;
    };
    harness.call.mockImplementation(async (name, input) => {
      if (name === 'connection.list') return { connections: [{ id: producer.scope.hostID, url: 'https://fixture.invalid', authorizationID: 'fixture-auth' }], selected: producer.scope.hostID, runtimeScope: producer.scope };
      if (name === 'runtime.request') { await producer.call(name, input); return { status: 200, body: await handle(input.path, input.method, input.body) }; }
      if (name === 'runtime.stream' || name === 'runtime.stop') return true;
      throw new Error('Unexpected Chat writer native call: ' + name);
    });
    const state = await import('./state'); await state.loadConnections();
    let recoveryReadOperation: ReturnType<typeof state.captureHostOperation> | null = null;
    const setReadAdmission = (enabled: boolean) => {
      if (!enabled) { recoveryReadOperation = null; return; }
      const captured = state.captureHostOperation();
      const assigned = Object.freeze({ ...captured, current: () => recoveryReadOperation === assigned && captured.current() }); recoveryReadOperation = assigned;
    };
    setReadAdmission(true);
    const chat = state.createChat(entity, { readOnly, contactOptimistic, writerGrant: grant, writerUnknown: unknown, recoveryReadOperation: () => recoveryReadOperation }); await chat.draftReady; await flush();
    return { state, chat, claim, client, producer, grant, unknown, setReadAdmission, ownerOff: () => { ownerLive = false; } };
  }
  async function localUnknown(kind: 'compact' | 'magic', malformedACK = false) {
    const f = await start(), normal = handle; let causalID = '';
    handle = (path, method, body) => {
      if (method === 'POST' && (path.includes('/compact?') || path.includes('/prompt?'))) { causalID = (body as { id: string }).id; if (malformedACK) return {}; throw new Error('Synthetic lost local command ACK'); }
      return normal(path, method, body);
    };
    if (kind === 'compact') { f.chat.setDraftText('/compact'); expect((await f.chat.admitLocalCompact(compactInvocation(f.chat))).status).toBe('unknown'); }
    else { f.chat.setDraftText('/explore retained'); expect((await f.chat.admitLocalMagic({ text: 'Compiled magic', files: [] }, magicInvocation(f.chat))).status).toBe('unknown'); }
    expect(f.chat.pendingSend()?.id).toBe(causalID); expect(f.claim.status()).toMatchObject({ unknown: true, hasGrant: true });
    f.chat.active.set(false); f.chat.syncActive.set(false);
    const receipt = () => kind === 'compact' ? { id: causalID, sessionID: 's', type: 'compaction', status: 'completed' } : { id: causalID, sessionID: 's', type: 'user', delivery: 'steer', payload: { text: 'Compiled magic' } };
    return { ...f, normal, causalID, receipt };
  }
  it.each(['prompt', 'command', 'shell', 'goal', 'compact', 'revert-commit', 'interrupt', 'permission', 'form-reply', 'form-cancel', 'queue-cancel', 'queue-steer', 'queue-edit'] as const)('forwards the verified producer grant through the original %s lane without acquiring per send', async action => {
    const f = await start();
    if (action === 'prompt') { f.chat.setDraftText('Original wire text'); expect(await f.chat.send()).toBe(true); }
    if (action === 'command') expect(await f.chat.command('build', 'original args')).toBe(true);
    if (action === 'shell') { f.chat.setDraftText('printf fixture'); expect(await f.chat.send({ inputMode: 'shell' })).toBe(true); }
    if (action === 'goal') expect(await f.chat.command('goal', 'pause')).toBe(true);
    if (action === 'compact') { f.chat.setDraftText('/compact'); expect((await f.chat.admitLocalCompact(compactInvocation(f.chat))).status).toBe('accepted'); }
    if (action === 'revert-commit') {
      const normal = handle; let staged = true;
      handle = (path, method, body) => { if (path.startsWith('/api/session/s?')) return { id: 's', ...(staged ? { revert: { messageID: 'staged-boundary' } } : {}) }; if (path.includes('/revert/commit?')) { staged = false; return null; } return normal(path, method, body); };
      f.chat.setDraftText('Commit original staged revert'); expect(await f.chat.send()).toBe(true);
      expect(requests().some(input => input.path.includes('/revert/commit?') && input.method === 'POST')).toBe(true);
    }
    if (action === 'interrupt') await f.chat.stop();
    if (action === 'permission') await f.chat.replyPermission('permission/a', 'once');
    if (action === 'form-reply') await f.chat.replyForm('form/a', { answers: [] });
    if (action === 'form-cancel') await f.chat.cancelForm('form/a');
    if (action === 'queue-cancel') expect(await f.chat.cancelInbox('q1')).toBe(true);
    if (action === 'queue-steer') expect(await f.chat.steerInbox('q2')).toBe(true);
    if (action === 'queue-edit') { expect(await f.chat.editInbox('q3')).toBe(true); expect(f.chat.draft()).toBe('Queued q3'); expect(f.chat.queueEdit()).toBeNull(); }
    const writes = requests().filter(input => input.method !== 'GET' && !input.path.startsWith('/api/rpc/opencode.goal/get?'));
    expect(writes.length).toBeGreaterThan(0);
    const nativeID = [...f.producer.ledger.rows.values()][0].grantID;
    expect(writes.every(input => input.writerGrant === nativeID && JSON.stringify(input.expectedHost) === JSON.stringify(f.producer.scope))).toBe(true);
    expect(requests().filter(input => input.method === 'GET').every(input => input.writerGrant === undefined)).toBe(true);
    expect(f.producer.calls.filter(call => call.name.startsWith('desktop.writer.')).map(call => call.name)).toEqual(['desktop.writer.capabilities', 'desktop.writer.acquire']);
    expect(f.unknown).not.toHaveBeenCalled(); expect(f.claim.status()).toMatchObject({ pending: 0, unknown: false });
  });
  it('assistant messages/abort use their verified target and keep the original request bodies', async () => {
    const f = await start('assistant'); f.chat.setDraftText('Assistant payload'); expect(await f.chat.send()).toBe(true); await f.chat.stop();
    const writes = requests().filter(input => input.method !== 'GET');
    expect(writes.map(input => [input.path, input.body])).toEqual([
      ['/api/yuri/assistants/bot/messages', { messageID: expect.any(String), parts: [{ type: 'text', text: 'Assistant payload' }], language: 'en' }],
      ['/api/yuri/assistants/bot/session/abort', { sessionID: 'assistant-bound', sessionGeneration: 2 }],
    ]);
    expect(writes.every(input => input.writerGrant === [...f.producer.ledger.rows.values()][0].grantID)).toBe(true);
  });
  it('contact optimistic user row keeps the original message ID through admission, failed refresh and authoritative reconciliation', async () => {
    const f = await start('assistant', false, true), normal = handle, ack = deferred<unknown>();
    let inputID = '', failedRead = false, authoritative = false;
    handle = (path, method, body) => {
      if (path.endsWith('/bot/messages') && method === 'POST') { inputID = (body as { messageID: string }).messageID; return ack.promise; }
      if (path.includes('/contact/messages')) {
        if (failedRead) throw new Error('Synthetic read failure');
        return { generation: 1, revision: 2, complete: true, messages: authoritative ? [{ messageID: inputID, role: 'user', assistantID: 'bot', turnID: inputID, ordinal: 9, createdAt: 1234, status: 'complete', parts: [{ type: 'text', text: 'Original user message' }] }] : [] };
      }
      return normal(path, method, body);
    };
    f.chat.setDraftText('Original user message'); const sending = f.chat.send(); await flush();
    expect(f.chat.messages()).toEqual([]);
    expect(f.chat.visibleMessages()).toMatchObject([{ id: inputID, contact: { kind: 'user', status: 'sending' }, content: [{ type: 'text', text: 'Original user message' }] }]);
    expect(f.chat.contactReadPosition()).toBeNull();
    f.chat.setDraftText('New draft during flight'); ack.resolve({ admitted: true, messageID: inputID }); expect(await sending).toBe(true);
    expect(f.chat.visibleMessages()[0]).toMatchObject({ id: inputID, contact: { status: 'admitted' } }); expect(f.chat.draft()).toBe('New draft during flight');
    failedRead = true; await f.chat.load(false, ['messages']); expect(f.chat.visibleMessages()).toHaveLength(1);
    failedRead = false; authoritative = true; await f.chat.load(false, ['messages']);
    expect(f.chat.visibleMessages()).toHaveLength(1); expect(f.chat.visibleMessages()[0]).toBe(f.chat.messages()[0]);
    expect(f.chat.contactOptimistic()).toEqual([]); expect(f.chat.contactReadPosition()).toEqual({ generation: 1, ordinal: 9, messageID: inputID });
  });
  it('message-scoped contact retry only proves the exact lost ACK and never replays it or restores an unknown writer', async () => {
    const f = await start('assistant', false, true), normal = handle; let inputID = '';
    handle = (path, method, body) => {
      if (path.endsWith('/bot/messages') && method === 'POST') { inputID = (body as { messageID: string }).messageID; throw new Error('Synthetic lost message ACK'); }
      return normal(path, method, body);
    };
    f.chat.setDraftText('Original contact intent'); expect(await f.chat.send()).toBe(false);
    expect(f.chat.visibleMessages()[0]).toMatchObject({ id: inputID, contact: { kind: 'user', status: 'failed' } });
    expect(f.chat.error()).toBe('');
    expect(f.claim.status().unknown).toBe(true); f.chat.active.set(false);
    handle = (path, method, body) => path.includes('/contact/messages?messageID=' + encodeURIComponent(inputID)) ? { generation: 1, revision: 2, complete: true, messages: [{ messageID: inputID, role: 'user', ordinal: 4, parts: [{ type: 'text', text: 'Original contact intent' }] }] } : normal(path, method, body);
    expect(await f.chat.retryContactMessage('different-input')).toBe(false);
    expect(await f.chat.retryContactMessage(inputID)).toBe(true);
    expect(f.chat.pendingSend()).toBeNull(); expect(f.chat.contactOptimistic()[0].status).toBe('admitted');
    expect(requests().filter(input => input.method === 'POST' && input.path.endsWith('/bot/messages'))).toHaveLength(1);
    expect(f.claim.status().unknown).toBe(true); expect(f.claim.grant()).toBeNull();
  });
  it('contact retry preserves captured attachment parts and a later draft after a proven native rejection', async () => {
    const f = await start('assistant', false, true), normal = handle;
    const contact = { type: 'file' as const, assistantID: 'bot', attachmentID: 'original', sha256: 'a'.repeat(64), size: 17, mime: 'text/plain', filename: 'original.txt' };
    const { assistantAttachmentURI } = await import('./assistant-attachment-model');
    const file = { uri: assistantAttachmentURI('bot', 'original'), name: 'original.txt', mime: contact.mime, contact };
    let reject = true;
    handle = (path, method, body) => {
      if (path.endsWith('/bot/messages') && method === 'POST' && reject) throw Object.assign(new Error('native_host_busy'), { code: 'ERR_NSH_HOST_ERROR' });
      return normal(path, method, body);
    };
    f.chat.attachments.set([file]); expect(await f.chat.send()).toBe(false);
    const messageID = f.chat.contactOptimistic()[0].messageID;
    expect(f.chat.pendingSend()).toBeNull(); expect(f.chat.error()).toBe(''); expect(f.claim.status().unknown).toBe(false);
    f.chat.setDraftText('A later draft'); reject = false;
    expect(await f.chat.retryContactMessage(messageID)).toBe(true);
    const writes = requests().filter(input => input.method === 'POST' && input.path.endsWith('/bot/messages'));
    expect(writes).toHaveLength(2); expect(writes[1].body).toEqual(writes[0].body);
    expect(f.chat.draft()).toBe('A later draft'); expect(f.chat.attachments()).toEqual([]);
    expect(f.chat.contactOptimistic()).toHaveLength(1); expect(f.chat.contactOptimistic()[0].status).toBe('admitted');
    expect(await f.chat.retryContactMessage(messageID)).toBe(false);
    expect(requests().filter(input => input.method === 'POST' && input.path.endsWith('/bot/messages'))).toHaveLength(2);
  });
  it.each(['peer', 'assistant', 'other-assistant'] as const)('contact lost-ACK readback rejects a same-ID %s record without clearing pending or unlocking the writer', async wrong => {
    const f = await start('assistant', false, true), normal = handle; let inputID = '';
    handle = (path, method, body) => {
      if (path.endsWith('/bot/messages') && method === 'POST') { inputID = (body as { messageID: string }).messageID; throw new Error('Synthetic lost ACK'); }
      if (path.includes('/contact/messages?messageID=')) return { generation: 1, revision: 2, complete: true, messages: [{ messageID: inputID, role: wrong === 'other-assistant' ? 'user' : wrong, assistantID: wrong === 'other-assistant' ? 'elsewhere' : 'bot', ordinal: 4, parts: [{ type: 'text', text: 'Not the owned user receipt' }] }] };
      return normal(path, method, body);
    };
    f.chat.setDraftText('Keep exact intent'); expect(await f.chat.send()).toBe(false);
    const pending = f.chat.pendingSend();
    expect(await f.chat.retryContactMessage(inputID)).toBe(false); expect(f.chat.pendingSend()).toBe(pending);
    expect(f.chat.contactOptimistic()[0].status).toBe('failed'); expect(f.claim.status().unknown).toBe(true);
    expect(requests().filter(input => input.method === 'POST' && input.path.endsWith('/bot/messages'))).toHaveLength(1);
  });
  it('contact lost-ACK proof with a failed journal ACK retains the exact pending for read-only recovery', async () => {
    const f = await start('assistant', false, true), normal = handle; let inputID = '', rejectFlush = false;
    const persist = harness.setItem.getMockImplementation()!;
    harness.setItem.mockImplementation(async (key: string, value: string) => {
      if (rejectFlush && key.startsWith('nsh:chat-draft:') && JSON.parse(value).pendingSend === null) throw new Error('Synthetic recovery journal failure');
      return persist(key, value);
    });
    handle = (path, method, body) => {
      if (path.endsWith('/bot/messages') && method === 'POST') { inputID = (body as { messageID: string }).messageID; throw new Error('Synthetic lost ACK'); }
      if (path.includes('/contact/messages?messageID=')) return { generation: 1, revision: 2, complete: true, messages: [{ messageID: inputID, role: 'user', assistantID: 'bot', ordinal: 4, parts: [{ type: 'text', text: 'Keep exact intent' }] }] };
      return normal(path, method, body);
    };
    f.chat.setDraftText('Keep exact intent'); expect(await f.chat.send()).toBe(false);
    const pending = f.chat.pendingSend(); rejectFlush = true;
    await expect(f.chat.retryContactMessage(inputID)).rejects.toThrow('recovery journal failure'); expect(f.chat.pendingSend()).toBe(pending);
    rejectFlush = false; expect(await f.chat.retryContactMessage(inputID)).toBe(true); expect(f.chat.pendingSend()).toBeNull();
    expect(f.claim.status().unknown).toBe(true); expect(f.claim.grant()).toBeNull();
    expect(requests().filter(input => input.method === 'POST' && input.path.endsWith('/bot/messages'))).toHaveLength(1);
  });
  it('an acknowledged contact with a failed journal flush stays admitted and retries only exact readback, not the message POST', async () => {
    const f = await start('assistant', false, true), normal = handle; let inputID = '', rejectFlush = false;
    const persist = harness.setItem.getMockImplementation()!;
    harness.setItem.mockImplementation(async (key: string, value: string) => {
      if (rejectFlush && key.startsWith('nsh:chat-draft:') && JSON.parse(value).pendingSend === null) throw new Error('Synthetic journal commit failure');
      return persist(key, value);
    });
    handle = (path, method, body) => {
      if (path.endsWith('/bot/messages') && method === 'POST') { inputID = (body as { messageID: string }).messageID; rejectFlush = true; }
      if (path.includes('/contact/messages?messageID=')) return { generation: 1, revision: 2, complete: true, messages: [{ messageID: inputID, role: 'user', ordinal: 4, parts: [{ type: 'text', text: 'Original journal intent' }] }] };
      return normal(path, method, body);
    };
    f.chat.setDraftText('Original journal intent'); expect(await f.chat.send()).toBe(false);
    expect(f.chat.contactOptimistic()[0].status).toBe('admitted'); expect(f.chat.pendingSend()).toMatchObject({ id: inputID, uncertain: true });
    expect(f.chat.error()).toContain('journal commit failure'); expect(f.claim.status().unknown).toBe(false);
    rejectFlush = false; expect(await f.chat.retrySend()).toBe(true);
    expect(f.chat.pendingSend()).toBeNull(); expect(await f.chat.retryContactMessage(inputID)).toBe(false);
    expect(requests().filter(input => input.method === 'POST' && input.path.endsWith('/bot/messages'))).toHaveLength(1);
  });
  it('contact shadow admission is bounded without dropping unconfirmed rows; a real new history generation clears old shadows', async () => {
    const f = await start('assistant', false, true), normal = handle;
    for (let index = 0; index < 64; index++) { f.chat.setDraftText('Contact ' + index); expect(await f.chat.send()).toBe(true); }
    expect(f.chat.contactOptimistic()).toHaveLength(64); expect(f.chat.visibleMessages()).toHaveLength(64);
    const before = requests().length;
    f.chat.setDraftText('Retain overflow'); expect(await f.chat.send()).toBe(false);
    expect(f.chat.draft()).toBe('Retain overflow'); expect(f.chat.contactOptimistic()).toHaveLength(64); expect(requests()).toHaveLength(before);
    handle = (path, method, body) => path.includes('/contact/messages') ? { generation: 2, revision: 1, complete: true, messages: [] } : normal(path, method, body);
    await f.chat.load(false, ['messages']); expect(f.chat.contactOptimistic()).toEqual([]); expect(f.chat.contactReadPosition()).toBeNull();
    expect(await f.chat.send()).toBe(true); expect(f.chat.contactOptimistic()).toHaveLength(1);
  });
  it.each(['system', 'ja', 'zh-TW'])('assistant sends current %s locale and canonical attachment references through its original grant', async selected => {
    const f = await start('assistant'); const { language } = await import('./i18n'); language.set(selected);
    const { assistantAttachmentURI } = await import('./assistant-attachment-model');
    const contact = { type: 'file' as const, assistantID: 'bot', attachmentID: 'uploaded', sha256: 'a'.repeat(64), size: 17, mime: 'text/plain', filename: 'note.txt' };
    f.chat.attachments.set([{ uri: assistantAttachmentURI('bot', 'uploaded'), name: 'note.txt', mime: contact.mime, contact }]);
    expect(await f.chat.send()).toBe(true);
    const writes = requests().filter(input => input.method !== 'GET');
    expect(writes).toHaveLength(1); const { assistantID: _owner, ...part } = contact;
    expect(writes[0].body).toEqual({ messageID: expect.any(String), parts: [part], language: selected === 'system' ? 'en' : selected });
    expect(writes[0].writerGrant).toBe([...f.producer.ledger.rows.values()][0].grantID);
  });
  it.each(['other-bot', 'local-uri', 'legacy'] as const)('assistant rejects %s attachments before any native write and retains the draft', async invalid => {
    const f = await start('assistant');
    const contact = { type: 'file' as const, assistantID: invalid === 'other-bot' ? 'other-bot' : 'bot', attachmentID: 'uploaded', sha256: 'a'.repeat(64), size: 17, mime: 'text/plain' };
    const file = { uri: invalid === 'local-uri' ? 'file:///bad' : '/api/yuri/assistants/' + contact.assistantID + '/contact/attachments/uploaded', name: 'note.txt', mime: contact.mime, ...(invalid === 'legacy' ? {} : { contact }) };
    f.chat.setDraftText('Retain this'); f.chat.attachments.set([file]);
    expect(await f.chat.send()).toBe(false);
    expect(requests().filter(input => input.method !== 'GET')).toEqual([]);
    expect(f.chat.draft()).toBe('Retain this'); expect(f.chat.attachments()).toEqual([file]);
    expect(f.unknown).not.toHaveBeenCalled();
  });
  it('fifty draft/GET updates never read the grant; readOnly never reads it or writes even when one is mistakenly injected', async () => {
    const f = await start(); f.grant.mockClear(); const before = f.producer.calls.filter(call => call.name.startsWith('desktop.writer.')).length;
    for (let i = 0; i < 50; i++) { f.chat.setDraftText('draft ' + i); await f.chat.load(false, ['status']); }
    await f.chat.goal.controller.refresh(); expect(f.grant).not.toHaveBeenCalled();
    expect(f.producer.calls.filter(call => call.name.startsWith('desktop.writer.'))).toHaveLength(before);
    const readOnlyGrant = vi.fn(f.claim.grant), state = f.state;
    const reader = state.createChat(target, { readOnly: true, writerGrant: readOnlyGrant, writerUnknown: f.unknown }); await reader.draftReady; await flush();
    const writes = requests().filter(input => input.method !== 'GET').length;
    expect(await reader.send()).toBe(false); await reader.stop(); await expect(reader.replyPermission('p', 'once')).rejects.toThrow('read_only');
    await reader.load(false, ['status']); expect(readOnlyGrant).not.toHaveBeenCalled(); expect(requests().filter(input => input.method !== 'GET')).toHaveLength(writes);
  });
  it.each(['prompt', 'assistant', 'compact'] as const)('a 2xx malformed %s domain ACK marks the same native claim sticky unknown and cleanup never releases it', async kind => {
    const f = await start(kind === 'assistant' ? 'assistant' : 'session'), normal = handle;
    handle = (path, method, body) => method === 'POST' && (/\/(prompt|messages|compact)(\?|$)/.test(path)) ? {} : normal(path, method, body);
    if (kind === 'compact') { f.chat.setDraftText('/compact'); expect((await f.chat.admitLocalCompact(compactInvocation(f.chat))).status).toBe('unknown'); }
    else { f.chat.setDraftText('Keep unknown'); expect(await f.chat.send()).toBe(false); }
    expect(f.unknown).toHaveBeenCalledTimes(1); expect(f.claim.status()).toMatchObject({ unknown: true, hasGrant: true }); expect(f.claim.grant()).toBeNull();
    expect(f.chat.pendingSend()?.uncertain).toBe(true); expect(await f.chat.prepareWriterRetirement()).toBe(false);
    harness.cleanups.forEach(stop => stop()); harness.cleanups = [];
    expect(f.claim.phase()).toBe('unknown'); expect(f.producer.ledger.rows.size).toBe(1); expect(f.producer.calls.filter(call => call.name === 'desktop.writer.release')).toEqual([]);
  });
  it('passive renew preserves one original draft owner; null renewal gap is not unknown and new-scope send uses the renewed grant', async () => {
    const f = await start(), { writerDeferred } = await import('./desktop-writer-test-host');
    f.chat.setDraftText('Retained through renew'); const draftReady = f.chat.draftReady;
    const before = harness.effects.length; f.state.runtimeLifecycle(); await flush(); const lifecycle = harness.effects[before]!;
    harness.lifecycle = 'background'; lifecycle();
    f.producer.scope = { ...f.producer.scope, lease: 'lease-two' };
    const gate = writerDeferred(); f.producer.gates['desktop.writer.renew'] = gate.promise;
    const renewing = f.claim.renew({ expectedHost: f.producer.scope }); expect(f.claim.grant()).toBeNull();
    harness.lifecycle = 'active'; lifecycle(); await flush();
    const count = requests().filter(input => input.method !== 'GET').length;
    expect(await f.chat.send()).toBe(false); expect(requests().filter(input => input.method !== 'GET')).toHaveLength(count); expect(f.claim.status().unknown).toBe(false);
    expect(f.chat.pendingSend()).toBeNull(); expect(f.chat.writerRetirement().reasons).not.toContain('write-unconfirmed');
    gate.resolve(); expect(await renewing).not.toBeNull(); expect(f.chat.draftReady).toBe(draftReady); expect(f.chat.draft()).toBe('Retained through renew');
    expect(await f.chat.send()).toBe(true); expect(requests().filter(input => input.method === 'POST' && input.path.includes('/prompt?')).at(-1).expectedHost).toEqual(f.producer.scope);
    expect(f.producer.calls.filter(call => call.name === 'desktop.writer.acquire')).toHaveLength(1);
  });
  it.each([true, false])('committed same-authority lease renew causality: original resume before ACK=%s, scopeReady is explicit and never remounts/restores', async resumeBeforeACK => {
    const f = await start(), { writerDeferred } = await import('./desktop-writer-test-host');
    f.chat.setDraftText('Exact original draft'); f.chat.attachments.set([{ uri: 'attachment://original', name: 'original', mime: 'text/plain' }]); await f.chat.flushDraft();
    const ready = f.chat.draftReady, referenceScope = f.chat.referenceScope, files = f.chat.attachments(), oldScope = f.chat.messageScope, oldGrant = f.claim.grant();
    const restores = harness.getItem.mock.calls.length, ownerID = f.claim.ownerID;
    f.producer.scope = { ...f.producer.scope, lease: 'lease-two' };
    const gate = writerDeferred(); f.producer.gates['desktop.writer.renew'] = gate.promise;
    const renewing = f.claim.renew({ expectedHost: f.producer.scope }); expect(f.claim.grant()).toBeNull();
    await f.state.loadConnections(); expect(f.state.app.runtimeScope()).toEqual(f.producer.scope);
    if (resumeBeforeACK) expect(f.state.resumeChatOperations()).toBe(1);
    const beforeACK = f.chat.messageScope, writes = requests().filter(input => input.method !== 'GET').length;
    if (resumeBeforeACK) { await expect(f.chat.stop()).rejects.toThrow('desktop_writer_required'); expect(beforeACK.generation).toBe(f.state.epoch()); }
    else await f.chat.stop();
    expect(requests().filter(input => input.method !== 'GET')).toHaveLength(writes); expect(f.claim.status().unknown).toBe(false);
    gate.resolve(); expect(await renewing).not.toBeNull(); expect(f.claim.grant()).not.toBe(oldGrant);
    expect(f.chat.rebuildOperationLane()).toBe(!resumeBeforeACK);
    const rebound = f.chat.messageScope; expect(rebound.generation).toBe(f.state.epoch()); expect(rebound.generation).not.toBe(oldScope.generation);
    if (resumeBeforeACK) expect(rebound).toBe(beforeACK);
    await f.state.loadConnections(); expect(f.chat.rebuildOperationLane()).toBe(false); expect(f.chat.messageScope).toBe(rebound);
    expect(f.chat.draftReady).toBe(ready); expect(f.chat.referenceScope).toBe(referenceScope); expect(f.chat.attachments()).toBe(files); expect(f.chat.draft()).toBe('Exact original draft');
    expect(harness.getItem.mock.calls).toHaveLength(restores); expect(f.claim.ownerID).toBe(ownerID);
    await f.chat.stop(); expect(requests().filter(input => input.path.includes('/interrupt?')).at(-1).expectedHost).toEqual(f.producer.scope); expect(f.chat.workStatus().activity).toBe('idle');
    expect(await f.chat.send()).toBe(true); expect(await f.chat.command('goal', 'pause')).toBe(true);
    expect(f.producer.calls.filter(call => call.name.startsWith('desktop.writer.')).map(call => call.name)).toEqual(['desktop.writer.capabilities', 'desktop.writer.acquire', 'desktop.writer.renew']);
  });
  it.each(['origin', 'authorization'] as const)('a new lease with changed %s never reuses the original Chat/draft authority', async field => {
    const f = await start(); f.chat.setDraftText('Prior authority draft'); await f.chat.flushDraft();
    const nativeDispatch = harness.call.getMockImplementation()!, initialScope = f.chat.messageScope, ready = f.chat.draftReady, restores = harness.getItem.mock.calls.length;
    f.producer.scope = { ...f.producer.scope, lease: 'lease-two' }; f.producer.authority = 'https://changed.invalid|changed-native-authorization';
    harness.call.mockImplementation(async (name, input) => {
      const result = await nativeDispatch(name, input);
      if (name !== 'connection.list') return result;
      return { ...result, connections: result.connections.map(connection => ({ ...connection, ...(field === 'origin' ? { url: 'https://changed.invalid' } : { authorizationID: 'changed-auth' }) })) };
    });
    await f.state.loadConnections(); expect(f.state.resumeChatOperations()).toBe(0); expect(f.chat.rebuildOperationLane()).toBe(false); expect(f.chat.messageScope).toBe(initialScope);
    const writes = requests().filter(input => input.method !== 'GET').length; expect(await f.chat.send()).toBe(false); await f.chat.stop(); expect(requests().filter(input => input.method !== 'GET')).toHaveLength(writes);
    expect(f.chat.draft()).toBe('Prior authority draft'); expect(f.chat.draftReady).toBe(ready); expect(harness.getItem.mock.calls).toHaveLength(restores);
    expect(f.producer.calls.filter(call => call.name === 'desktop.writer.acquire')).toHaveLength(1);
    expect(await f.claim.renew({ expectedHost: f.producer.scope })).toBeNull(); expect(f.claim.status().unknown).toBe(true);
  });
  it('same-authority lease rebind preserves pending, queue-edit and old history unknown protection without an extra restore or renewed authority', async () => {
    const f = await start(); f.chat.setDraftText('Unresolved original owner');
    f.chat.pendingSend.set({ id: 'unknown-original', text: 'Unresolved original owner', files: [], delivery: 'steer', uncertain: true });
    f.chat.queueEdit.set({ id: 'unknown-queue', text: 'Queued original', files: [] }); f.chat.historyBusy.set(true); await f.chat.flushDraft();
    f.claim.markUnknown(new Error('Synthetic original history receipt unresolved'));
    const pending = f.chat.pendingSend(), edit = f.chat.queueEdit(), ready = f.chat.draftReady, restores = harness.getItem.mock.calls.length;
    f.producer.scope = { ...f.producer.scope, lease: 'lease-two' }; await f.state.loadConnections();
    expect(f.state.resumeChatOperations()).toBe(1); expect(f.chat.pendingSend()).toBe(pending); expect(f.chat.queueEdit()).toBe(edit);
    expect(f.chat.writerRetirement().reasons).toEqual(expect.arrayContaining(['pending-send', 'queue-edit', 'history-unresolved']));
    expect(f.chat.rebuildOperationLane()).toBe(false); expect(await f.chat.prepareWriterRetirement()).toBe(false);
    expect(f.chat.pendingSend()).toBe(pending); expect(f.chat.queueEdit()).toBe(edit); expect(f.claim.status()).toMatchObject({ unknown: true, hasGrant: true });
    expect(f.chat.draftReady).toBe(ready); expect(harness.getItem.mock.calls).toHaveLength(restores);
    expect(await f.claim.renew({ expectedHost: f.producer.scope })).toBeNull(); expect(f.producer.calls.filter(call => call.name.startsWith('desktop.writer.'))).toHaveLength(2);
  });
  it('a same-authority rebind cannot wash a real in-flight write; a confirmed old ACK still leaves the original pending receipt for explicit reconciliation', async () => {
    const f = await start(), gate = deferred<void>(), normal = handle; let entered = false;
    handle = async (path, method, body) => { if (path.includes('/prompt?')) { entered = true; await gate.promise; } return normal(path, method, body); };
    f.chat.setDraftText('In-flight original send'); const sending = f.chat.send(); await flush(); expect(entered).toBe(true); expect(f.claim.status().pending).toBe(1);
    const pending = f.chat.pendingSend(); f.producer.scope = { ...f.producer.scope, lease: 'lease-two' }; await f.state.loadConnections(); expect(f.state.resumeChatOperations()).toBe(1);
    expect(f.chat.writerRetirement().reasons).toContain('write-in-flight'); expect(f.chat.pendingSend()).toBe(pending); expect(await f.chat.prepareWriterRetirement()).toBe(false);
    expect(await f.claim.renew({ expectedHost: f.producer.scope })).toBeNull(); expect(f.producer.calls.filter(call => call.name === 'desktop.writer.renew')).toEqual([]);
    gate.resolve(); expect(await sending).toBe(false); expect(f.chat.pendingSend()).toBe(pending); expect(f.chat.pendingSend()?.uncertain).toBe(true); expect(f.chat.canReleaseWriter()).toBe(false);
  });
  it('a held old-scope preparation cannot dispatch with the renewed grant; the same original pending draft retries on the new lane', async () => {
    const f = await start(), preparing = deferred<{ text: string }>(); f.chat.setDraftText('Captured before lease change');
    const sending = f.chat.send({ prepare: () => preparing.promise }); await flush(); expect(f.chat.pendingSend()).not.toBeNull();
    const before = harness.effects.length; f.state.runtimeLifecycle(); await flush(); const lifecycle = harness.effects[before]!;
    harness.lifecycle = 'background'; lifecycle(); f.producer.scope = { ...f.producer.scope, lease: 'lease-two' };
    expect(await f.claim.renew({ expectedHost: f.producer.scope })).not.toBeNull();
    harness.lifecycle = 'active'; lifecycle(); await flush();
    const writes = requests().filter(input => input.method !== 'GET').length;
    preparing.resolve({ text: 'Late compiled body' }); expect(await sending).toBe(false);
    expect(requests().filter(input => input.method !== 'GET')).toHaveLength(writes); expect(f.chat.pendingSend()?.uncertain).toBe(false);
    expect(await f.chat.retrySend()).toBe(true);
    expect(requests().filter(input => input.method === 'POST' && input.path.includes('/prompt?')).at(-1).expectedHost).toEqual(f.producer.scope);
    expect(f.producer.calls.filter(call => call.name === 'desktop.writer.acquire')).toHaveLength(1);
  });
  it('a wrong-target verified producer grant is not guessed into a claim, not dispatched and not marked unknown', async () => {
    const f = await start();
    const other = f.client.claim({ expectedHost: f.producer.scope, target: { kind: 'session', id: 'different-session' }, current: () => true }); expect(await other.ready()).not.toBeNull();
    f.grant.mockImplementation(other.grant); const before = requests().filter(input => input.method !== 'GET').length;
    await expect(f.chat.stop()).rejects.toThrow('desktop_writer_required');
    expect(requests().filter(input => input.method !== 'GET')).toHaveLength(before); expect(other.status().unknown).toBe(false); expect(f.unknown).not.toHaveBeenCalled();
    expect(f.chat.writerRetirement().reasons).not.toContain('write-unconfirmed');
  });
  it('Host retirement fences a held original send and never dispatches through an owner that has retired', async () => {
    const f = await start(), preparing = deferred<unknown>(); f.chat.setDraftText('Original pending'); f.chat.attachments.set([{ uri: 'attachment://retained', name: 'retained', mime: 'text/plain' }]);
    const sending = f.chat.send({ prepare: () => preparing.promise as Promise<{ text: string }> }); await flush();
    const before = requests().filter(input => input.method !== 'GET').length;
    f.ownerOff(); await f.state.loadConnections({ forceReconnect: true });
    preparing.resolve({ text: 'Late compiled text' }); expect(await sending).toBe(false);
    expect(requests().filter(input => input.method !== 'GET')).toHaveLength(before); expect(f.chat.pendingSend()).not.toBeNull(); expect(f.chat.canReleaseWriter()).toBe(false);
    expect(f.chat.draft()).toBe('Original pending'); expect(f.chat.attachments()).toEqual([{ uri: 'attachment://retained', name: 'retained', mime: 'text/plain' }]);
  });
  it('a verified native not-dispatched rejection retains the draft and permits a later send without sticky unknown', async () => {
    const f = await start(), { writerNativeError } = await import('./desktop-writer-test-host');
    const nativeDispatch = harness.call.getMockImplementation()!; let blocked = true;
    harness.call.mockImplementation(async (name, input) => { if (blocked && name === 'runtime.request' && input.method === 'POST' && input.path.includes('/prompt?')) { blocked = false; throw writerNativeError('native_host_busy'); } return nativeDispatch(name, input); });
    f.chat.setDraftText('Retry original draft');
    expect(await f.chat.send()).toBe(false); expect(f.claim.status().unknown).toBe(false); expect(f.chat.pendingSend()).toBeNull(); expect(f.chat.draft()).toBe('Retry original draft');
    expect(f.chat.writerRetirement().reasons).not.toContain('write-unconfirmed'); expect(f.unknown).not.toHaveBeenCalled();
    expect(f.grant).toHaveBeenCalledTimes(1); expect(await f.chat.send()).toBe(true);
  });
  it.each(['compact', 'magic'] as const)('lost %s ACK can verify the same causal receipt while writable active is false, without replay or native unlock', async kind => {
    const f = await localUnknown(kind);
    handle = (path, method, body) => path.includes('/inbox?') ? [f.receipt()] : f.normal(path, method, body);
    const writes = requests().filter(input => input.method !== 'GET').length, nativeCalls = f.producer.calls.filter(call => call.name.startsWith('desktop.writer.')).length;
    f.grant.mockClear(); expect(await f.chat.retrySend()).toBe(true); expect(f.chat.pendingSend()).toBeNull();
    expect(f.claim.status()).toMatchObject({ unknown: true, hasGrant: true }); expect(f.claim.grant()).toBeNull(); expect(f.claim.canRelease()).toBe(false);
    expect(f.grant).not.toHaveBeenCalled(); expect(requests().filter(input => input.method !== 'GET')).toHaveLength(writes);
    expect(f.producer.calls.filter(call => call.name.startsWith('desktop.writer.'))).toHaveLength(nativeCalls);
    expect(await f.chat.send()).toBe(false); expect(f.chat.draft()).toBe(kind === 'compact' ? '/compact' : '/explore retained');
    expect(await f.chat.prepareWriterRetirement()).toBe(true); expect(f.chat.canReleaseWriter()).toBe(true);
    expect(await f.claim.release({ allowed: () => true })).toBe(false); expect(f.claim.status().unknown).toBe(true); expect(f.producer.calls.filter(call => call.name.startsWith('desktop.writer.'))).toHaveLength(nativeCalls);
  });
  for (const kind of ['compact', 'magic'] as const) {
    it.each(['promoted', '404', 'offline', 'wrong-session', 'wrong-causal', 'malformed'] as const)(kind + ' read-only receipt verification distinguishes %s without clearing unknown on failure', async outcome => {
      const f = await localUnknown(kind), pending = f.chat.pendingSend(), before = requests().length;
      handle = (path, method, body) => {
        if (path.includes('/inbox?')) { if (outcome === 'offline') throw new Error('Synthetic receipt offline'); return []; }
        if (path.includes(`/message/${f.causalID}?`)) {
          if (outcome === 'offline') throw new Error('Synthetic receipt offline');
          if (outcome === '404') throw Object.assign(new Error('Synthetic missing receipt'), { status: 404 });
          if (outcome === 'malformed') return {};
          return { ...f.receipt(), ...(outcome === 'wrong-session' ? { sessionID: 'other' } : {}), ...(outcome === 'wrong-causal' ? { id: 'other-causal-id' } : {}) };
        }
        return f.normal(path, method, body);
      };
      f.grant.mockClear();
      if (outcome === 'offline') await expect(f.chat.recoverPendingSend()).rejects.toThrow('offline');
      else expect(await f.chat.recoverPendingSend()).toBe(outcome === 'promoted');
      expect(f.chat.pendingSend()).toBe(outcome === 'promoted' ? null : pending); expect(f.claim.status()).toMatchObject({ unknown: true, hasGrant: true });
      expect(requests().slice(before).every(input => input.method === 'GET' && input.writerGrant === undefined && JSON.stringify(input.expectedHost) === JSON.stringify(f.producer.scope))).toBe(true); expect(f.grant).not.toHaveBeenCalled();
    });
    it.each(['background', 'Settings', 'other-route', 'scope', 'origin', 'authorization'] as const)(kind + ' recovery refuses %s admission before GET and keeps the exact pending', async boundary => {
      const f = await localUnknown(kind), pending = f.chat.pendingSend(); handle = (path, method, body) => path.includes('/inbox?') ? [f.receipt()] : f.normal(path, method, body);
      if (boundary === 'background') harness.lifecycle = 'background';
      if (boundary === 'Settings') f.setReadAdmission(false);
      if (boundary === 'other-route') { f.state.createChat({ ...target, id: 'another-route' }); await flush(); }
      if (boundary === 'scope') f.state.app.runtimeScope.set({ ...f.producer.scope, lease: 'not-captured-lease' });
      if (boundary === 'origin') f.state.app.connection.set({ ...f.state.app.connection()!, url: 'https://other.invalid' });
      if (boundary === 'authorization') f.state.app.connection.set({ ...f.state.app.connection()!, authorizationID: 'other-auth' });
      const before = requests().length; f.grant.mockClear(); expect(await f.chat.retrySend()).toBe(false); expect(requests()).toHaveLength(before); expect(f.chat.pendingSend()).toBe(pending); expect(f.grant).not.toHaveBeenCalled();
    });
    it.each([false, true])(kind + ' held GET loses admission across a modal/route retirement; resumed=%s cannot adopt old proof', async resume => {
      const f = await localUnknown(kind), pending = f.chat.pendingSend(), gate = deferred<unknown>(); let entered = false;
      handle = (path, method, body) => { if (path.includes('/inbox?')) { entered = true; return gate.promise; } return f.normal(path, method, body); };
      const recovery = f.chat.recoverPendingSend(); await flush(); expect(entered).toBe(true); const before = requests().length;
      f.setReadAdmission(false); if (resume) f.setReadAdmission(true); gate.resolve([f.receipt()]);
      expect(await recovery).toBe(false); expect(f.chat.pendingSend()).toBe(pending); expect(requests()).toHaveLength(before); expect(f.claim.status().unknown).toBe(true);
    });
    it(kind + ' valid causal proof clears only its pending journal, preserves unrelated edits/history unknown and cannot unlock a malformed domain ACK', async () => {
      const f = await localUnknown(kind, true); f.chat.draft.set('Unrelated later draft'); f.chat.attachments.set([{ uri: 'attachment://later', name: 'later', mime: 'text/plain' }]); f.chat.historyBusy.set(true);
      handle = (path, method, body) => path.includes('/inbox?') ? [f.receipt()] : f.normal(path, method, body);
      expect(await f.chat.recoverPendingSend()).toBe(true); expect(f.chat.pendingSend()).toBeNull(); expect(f.chat.draft()).toBe('Unrelated later draft'); expect(f.chat.attachments()).toHaveLength(1); expect(f.chat.historyBusy()).toBe(true);
      expect(f.chat.writerRetirement().reasons).toEqual(expect.arrayContaining(['write-unconfirmed', 'history-unresolved'])); expect(await f.chat.prepareWriterRetirement()).toBe(false);
      expect(f.claim.status()).toMatchObject({ unknown: true, hasGrant: true }); expect(await f.claim.release({ allowed: f.chat.canReleaseWriter })).toBe(false); expect(f.producer.calls.filter(call => call.name === 'desktop.writer.release')).toEqual([]);
    });
    it(kind + ' failed journal flush restores the original local pending instead of claiming read-only recovery completed', async () => {
      const f = await localUnknown(kind), pending = f.chat.pendingSend(); handle = (path, method, body) => path.includes('/inbox?') ? [f.receipt()] : f.normal(path, method, body);
      harness.setItem.mockRejectedValueOnce(new Error('Synthetic recovery journal offline'));
      await expect(f.chat.recoverPendingSend()).rejects.toThrow('journal offline'); expect(f.chat.pendingSend()).toBe(pending); expect(f.claim.status().unknown).toBe(true); expect(f.chat.canReleaseWriter()).toBe(false);
    });
    it(kind + ' held receipt cannot clear a replaced pending object even when its causal ID is the same', async () => {
      const f = await localUnknown(kind), pending = f.chat.pendingSend()!, gate = deferred<unknown>();
      handle = (path, method, body) => path.includes('/inbox?') ? gate.promise : f.normal(path, method, body);
      const recovery = f.chat.recoverPendingSend(); await flush(); const replacement = { ...pending, preparedText: 'Updated original journal' }; f.chat.pendingSend.set(replacement); gate.resolve([f.receipt()]);
      expect(await recovery).toBe(false); expect(f.chat.pendingSend()).toBe(replacement); expect(f.claim.status().unknown).toBe(true);
    });
  }
  it('a readOnly/shared Chat never receives receipt-recovery ownership, reads admission or clears the original pending', async () => {
    const f = await localUnknown('compact'), pending = f.chat.pendingSend(), admission = vi.fn(() => f.state.captureHostOperation());
    const reader = f.state.createChat(target, { readOnly: true, writerGrant: f.grant, recoveryReadOperation: admission }); await reader.draftReady; await flush();
    const before = requests().length; f.grant.mockClear(); expect(await reader.recoverPendingSend()).toBe(false); expect(await reader.retrySend()).toBe(false);
    expect(requests()).toHaveLength(before); expect(admission).not.toHaveBeenCalled(); expect(f.grant).not.toHaveBeenCalled(); expect(f.chat.pendingSend()).toBe(pending);
  });
});

describe('native chat authority and lifecycle', () => {
  it('exact Activity uses encoded native GET and CAS, then 50 slim polls never downgrade or repeat the read', async () => {
    const state = await import('./state'); await state.loadConnections();
    const normal = handle, messageID = 'a/b';
    const slim = { id: messageID, type: 'assistant', finish: 'stop', content: [{ id: 'call', type: 'tool', name: 'bash', slim: true, state: { status: 'completed', time: { start: 1, end: 2 } } }] };
    handle = (path, method, body) => path.includes('/message?') ? { data: [slim] } : path.includes('/message/a%2Fb?') ? { ...slim, content: [{ ...slim.content[0], slim: false, state: { ...slim.content[0]!.state, output: 'EXACT OUTPUT' } }] } : normal(path, method, body);
    const chat = state.createChat({ ...target, directory: '/repo/work tree' }); await chat.draftReady; await flush(); await chat.load(false, ['messages']);
    await chat.activityMaterialization.request([messageID]);
    const exact = () => requests().filter(input => input.path.includes('/message/a%2Fb?'));
    expect(exact()).toEqual([expect.objectContaining({ path: '/api/session/s/message/a%2Fb?directory=%2Frepo%2Fwork%20tree', method: 'GET' })]);
    const previous = chat.messages();
    for (let i = 0; i < 50; i++) { await chat.load(false, ['messages']); await chat.activityMaterialization.request([messageID], { automatic: true }); }
    expect(chat.messages()).toBe(previous); expect(exact()).toHaveLength(1);
    expect(chat.messages()[0]!.tools[0]!.state).toMatchObject({ output: 'EXACT OUTPUT' });
  });
  it.each(['hidden', 'background', 'host', 'revert'] as const)('in-flight exact Activity cannot write after %s authority changes', async boundary => {
    const state = await import('./state'); await state.loadConnections(); const normal = handle;
    const source = { id: 'exact', type: 'assistant', finish: 'stop', content: [{ id: 'call', type: 'tool', name: 'read', slim: true, state: { status: 'completed' } }] };
    const gate = deferred<unknown>();
    handle = (path, method, body) => path.includes('/message?') ? { data: [source] } : path.includes('/message/exact?') ? gate.promise : normal(path, method, body);
    const chat = state.createChat(target); await chat.draftReady; await flush(); await chat.load(false, ['messages']);
    const expected = chat.messages()[0], reading = chat.activityMaterialization.request(['exact']); await flush();
    expect(chat.activityMaterialization.state(['exact']).loading).toBe(true);
    if (boundary === 'host') await state.loadConnections({ forceReconnect: true });
    else if (boundary === 'revert') chat.revert.set({ messageID: 'exact' });
    else if (boundary === 'background') harness.lifecycle = 'inactive';
    else chat.active.set(false);
    if (boundary !== 'revert') harness.effects.forEach(work => work());
    gate.resolve({ ...source, content: [{ ...source.content[0], slim: false, state: { status: 'completed', output: 'STALE' } }] });
    await reading; await flush(); expect(chat.messages()[0]).toBe(expected);
    expect(chat.activityMaterialization.state(['exact']).loading).toBe(false);
    const count = requests().filter(input => input.path.includes('/message/exact?')).length;
    await chat.activityMaterialization.request(['exact']); expect(requests().filter(input => input.path.includes('/message/exact?'))).toHaveLength(count);
  });
  it('an unchanged authority refresh preserves the published message array and records for native scroll measurement', async () => {
    const state = await import('./state'); await state.loadConnections();
    const chat = state.createChat(target); await chat.draftReady; await flush();
    await chat.load(false, ['messages']);
    const previous = chat.messages();
    expect(previous.length).toBeGreaterThan(0);
    await chat.load(false, ['messages']);
    expect(chat.messages()[0]).toBe(previous[0]);
    expect(chat.messages()).toBe(previous);
  });
  it('200 production setDraftText edits and the coalesced 300ms save add zero runtime requests or candidate enumeration', async () => {
    const references = await import('./composer-references');
    const enumerate = vi.spyOn(references, 'referenceCandidates');
    const state = await import('./state'); await state.loadConnections(); state.observeRuntime(() => {});
    const chat = state.createChat(target); await chat.draftReady; await flush();
    chat.insertReference({ kind: 'file', value: 'src/a.ts', label: 'src/a.ts' });
    await chat.flushDraft(); await flush();
    let catalogReads = 0;
    const guarded = <T>(rows: T[]) => new Proxy(rows, { get(array, key, receiver) {
      if (key === Symbol.iterator || typeof key === 'string' && /^\d+$/.test(key)) catalogReads++;
      return Reflect.get(array, key, receiver);
    } });
    state.app.sessions.set(guarded(Array.from({ length: 300 }, (_, index) => ({ id: `catalog-${index}`, title: `Session ${index}`, directory: target.directory, updated: index }))));
    chat.commands.set(guarded(Array.from({ length: 300 }, (_, index) => ({ name: `command-${index}`, description: `Command ${index}` }))));
    const baseline = requests().length;
    // Prove the measured boundary is live: createChat has already made actual runtime.request calls.
    expect(baseline).toBeGreaterThan(0);
    harness.getItem.mockClear(); harness.setItem.mockClear(); enumerate.mockClear();
    const original = chat.draft();
    for (let index = 0; index < 200; index++) expect(chat.setDraftText(`input ${index} ${original}`)).toBe(true);
    expect(chat.references()).toHaveLength(1);
    expect(requests().length - baseline).toBe(0);
    expect(catalogReads).toBe(0); expect(enumerate).not.toHaveBeenCalled();
    expect(harness.getItem).not.toHaveBeenCalled(); expect(harness.setItem).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(299);
    expect(harness.setItem).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await flush();
    expect(harness.getItem).toHaveBeenCalledTimes(1); expect(harness.setItem).toHaveBeenCalledTimes(1);
    expect(requests().length - baseline).toBe(0);
    expect(catalogReads).toBe(0); expect(enumerate).not.toHaveBeenCalled();
    const saved = JSON.parse(harness.storage.get(chat.referenceScope.draft)!);
    expect(saved.draft).toBe(`input 199 ${original}`); expect(saved.references).toHaveLength(1);
    enumerate.mockRestore();
  });
  it('restores a scoped native draft and attachment metadata through the public chat interface', async () => {
    let state = await import('./state'); await state.loadConnections(); const first = state.createChat(target); await first.draftReady;
    first.draft.set('persisted draft'); first.attachments.set([{ uri: 'attachment://one', name: 'note.txt', mime: 'text/plain' }]);
    await first.flushDraft();
    vi.resetModules(); state = await import('./state'); await state.loadConnections();
    const second = state.createChat(target); await second.draftReady;
    expect(second.draft()).toBe('persisted draft'); expect(second.attachments()).toHaveLength(1);
    expect(second.draftStatus()).toBe('ready');
  });
  it('holds the sending lock across async compilation, preserves newer draft edits, and bypasses slash command for compiled text', async () => {
    const state = await import('./state'); await state.loadConnections(); const chat = state.createChat(target); await chat.draftReady; await flush();
    const compilation = deferred<{ text: string }>(), prepare = vi.fn(() => compilation.promise), normal = handle;
    handle = (path, method, body) => path.includes('/prompt?') ? { id: (body as Record<string, unknown>).id, sessionID: 's', type: 'user', payload: { text: (body as Record<string, unknown>).text } } : normal(path, method, body);
    chat.draft.set('/explore original'); const sending = chat.send({ prepare }); await flush();
    expect(chat.sending()).toBe(true); expect(await chat.send({ prepare })).toBe(false);
    chat.draft.set('new draft'); compilation.resolve({ text: 'visible\ninstructions' });
    expect(await sending).toBe(true);
    expect(prepare).toHaveBeenCalledOnce(); expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ text: '/explore original', files: [], references: expect.objectContaining({ text: '/explore original', references: [] }), scope: expect.objectContaining({ host: 'one', directory: '/repo' }), isCurrentScope: expect.any(Function) }));
    expect(chat.draft()).toBe('new draft');
    expect(requests().filter(input => input.method === 'POST')).toEqual([expect.objectContaining({ path: '/api/session/s/prompt?directory=%2Frepo', body: expect.objectContaining({ text: 'visible\ninstructions' }) })]);
  });
  it('owns five-domain reference documents in the production chat draft and restores them with Host/draft scope', async () => {
    let state = await import('./state'); await state.loadConnections(); const first = state.createChat(target); await first.draftReady;
    first.setDraftText('Read ');
    for (const kind of ['file', 'directory', 'agent', 'skill', 'session'] as const) expect(() => first.insertReference({ kind, value: kind, label: kind, scope: { ...first.referenceScope, host: 'other' } })).toThrow('scope-mismatch');
    for (const kind of ['file', 'directory', 'agent', 'skill', 'session'] as const) first.insertReference({ kind, value: kind === 'file' ? 'src/a.ts' : kind, label: kind });
    const doc = first.referenceDocument(); expect(doc.references).toHaveLength(5);
    expect(first.referenceScope).toMatchObject({ host: 'one', directory: target.directory });
    expect(first.referenceScope.draft).toContain('nsh:chat-draft:v1:');
    first.setDraftText(`Please ${first.draft()}`); expect(first.references()[0].start).toBe(doc.references[0].start + 7);
    await first.flushDraft(); const saved = first.referenceDocument();
    vi.resetModules(); state = await import('./state'); await state.loadConnections(); const second = state.createChat(target); await second.draftReady;
    expect(second.referenceDocument()).toEqual(saved);
    const other = state.createChat({ ...target, id: 'other' }); await other.draftReady;
    expect(other.references()).toEqual([]); expect(other.referenceScope.draft).not.toBe(second.referenceScope.draft);
  });
  it('journals the captured document before prepare and does not clear newer references with identical visible text', async () => {
    const state = await import('./state'); await state.loadConnections(); const chat = state.createChat(target); await chat.draftReady;
    chat.insertReference({ kind: 'skill', value: 'old-id', label: 'Same' }); const captured = chat.referenceDocument();
    const gate = deferred<{ text: string; skills: Array<{ id: string }> }>();
    const prepare = vi.fn(async (input: import('./state').SendPreparationInput) => {
      const journal = JSON.parse(harness.storage.get(chat.referenceScope.draft)!);
      expect(journal.pendingSend.references).toEqual(captured); expect(input.references).toEqual(captured);
      expect(input.scope).toEqual(chat.referenceScope); expect(input.isCurrentScope()).toBe(true);
      return gate.promise;
    });
    const normal = handle;
    handle = (path, method, body) => path.includes('/prompt?') ? { id: (body as Record<string, unknown>).id, sessionID: 's', payload: { text: (body as Record<string, unknown>).text } } : normal(path, method, body);
    const sending = chat.send({ prepare }); await flush();
    const ref = chat.references()[0]; chat.insertReference({ kind: 'skill', value: 'new-id', label: 'Same' }, ref.start, ref.end);
    expect(chat.draft()).toBe(captured.text); gate.resolve({ text: '[skill:old-id]', skills: [{ id: 'old-id' }] });
    expect(await sending).toBe(true); expect(chat.references()[0].value).toBe('new-id'); expect(chat.draft()).toBe(captured.text);
    const post = requests().find(input => input.method === 'POST' && input.path.includes('/prompt?'));
    expect(post.body.skills).toEqual([{ id: 'old-id' }]); expect(chat.pendingSend()).toBeNull();
  });
  it('preparation failure retains the stable uncompiled reference document; retry never swaps the edited draft', async () => {
    let state = await import('./state'); await state.loadConnections(); const first = state.createChat(target); await first.draftReady;
    first.insertReference({ kind: 'skill', value: 'old', label: 'Original' }); const captured = first.referenceDocument();
    expect(await first.send({ prepare: async () => { throw new Error('temporary preparation failure'); } })).toBe(false);
    const pendingID = first.pendingSend()?.id; expect(first.pendingSend()?.references).toEqual(captured); expect(first.pendingSend()?.compiled).toBeUndefined();
    first.setDraftText('New '); first.insertReference({ kind: 'agent', value: 'new', label: 'New' }); const edited = first.referenceDocument(); await first.flushDraft();
    vi.resetModules(); state = await import('./state'); await state.loadConnections(); const second = state.createChat(target); await second.draftReady;
    const normal = handle;
    handle = (path, method, body) => path.includes('/prompt?') ? { id: (body as Record<string, unknown>).id, sessionID: 's', payload: { text: (body as Record<string, unknown>).text } } : normal(path, method, body);
    expect(await second.retrySend({ prepare: async input => {
      expect(second.referenceDocument()).toEqual(edited); expect(input.references).toEqual(captured);
      return { text: '[skill:old]', skills: [{ id: 'old' }] };
    } })).toBe(true);
    expect(second.referenceDocument()).toEqual(edited);
    const posts = requests().filter(input => input.method === 'POST'); expect(posts).toHaveLength(1);
    expect(posts[0].body).toMatchObject({ id: pendingID, skills: [{ id: 'old' }] });
  });
  it('default reference preparation emits real file/directory/agent/skill wire and clears only the admitted document', async () => {
    const state = await import('./state'); await state.loadConnections(); const chat = state.createChat(target); await chat.draftReady;
    chat.insertReference({ kind: 'file', value: 'src/a b.ts', label: 'src/a b.ts' });
    chat.insertReference({ kind: 'directory', value: 'src/', label: 'src/' });
    chat.insertReference({ kind: 'agent', value: 'reviewer', label: 'reviewer' });
    chat.insertReference({ kind: 'skill', value: 'real-id', label: 'Displayed' });
    const normal = handle;
    handle = (path, method, body) => path.includes('/prompt?') ? { id: (body as Record<string, unknown>).id, sessionID: 's', payload: { text: (body as Record<string, unknown>).text } } : normal(path, method, body);
    expect(await chat.send()).toBe(true);
    const post = requests().find(input => input.method === 'POST');
    expect(post.body).toMatchObject({ files: [{ uri: 'file:///repo/src/a%20b.ts', name: 'a b.ts' }, { uri: 'file:///repo/src', name: 'src' }], agents: [{ name: 'reviewer' }], skills: [{ id: 'real-id' }] });
    expect(post.body.text).toContain('[skill:real-id]'); expect(chat.draft()).toBe(''); expect(chat.references()).toEqual([]);
    const journal = JSON.parse(harness.storage.get(chat.referenceScope.draft)!); expect(journal.references).toEqual([]); expect(journal.pendingSend).toBeNull();
  });
  it('unknown reference sends reuse the durable compiled payload and ID, while preserving newly edited references', async () => {
    let state = await import('./state'); await state.loadConnections(); const first = state.createChat(target); await first.draftReady;
    first.insertReference({ kind: 'skill', value: 'old', label: 'Old' }); const captured = first.referenceDocument();
    const normal = handle;
    handle = (path, method, body) => {
      if (path.includes('/prompt?')) {
        const saved = JSON.parse(harness.storage.get(first.referenceScope.draft)!);
        expect(saved.pendingSend.references).toEqual(captured); expect(saved.pendingSend.uncertain).toBe(true);
        throw new Error('lost acknowledgement');
      }
      return normal(path, method, body);
    };
    expect(await first.send()).toBe(false); const pending = first.pendingSend()!;
    first.setDraftText('New '); first.insertReference({ kind: 'skill', value: 'new', label: 'New' }); const edited = first.referenceDocument(); await first.flushDraft();
    vi.resetModules(); state = await import('./state'); await state.loadConnections(); const second = state.createChat(target); await second.draftReady;
    handle = (path, method, body) => path.includes('/prompt?') ? { id: (body as Record<string, unknown>).id, sessionID: 's', payload: { text: (body as Record<string, unknown>).text } } : normal(path, method, body);
    const prepare = vi.fn(); expect(await second.retrySend({ prepare })).toBe(true); expect(prepare).not.toHaveBeenCalled();
    const posts = requests().filter(input => input.method === 'POST'); expect(posts).toHaveLength(2);
    expect(posts[1].body).toMatchObject({ id: pending.id, text: pending.compiled?.text, skills: [{ id: 'old' }] });
    expect(second.referenceDocument()).toEqual(edited);
  });
  it('reference write failure blocks preparation/admission and preserves the selected document', async () => {
    const state = await import('./state'); await state.loadConnections(); const chat = state.createChat(target); await chat.draftReady;
    chat.insertReference({ kind: 'file', value: 'a.ts', label: 'a.ts' }); const captured = chat.referenceDocument();
    harness.setItem.mockRejectedValue(new Error('quota')); const prepare = vi.fn();
    expect(await chat.send({ prepare })).toBe(false); expect(prepare).not.toHaveBeenCalled();
    expect(chat.referenceDocument()).toEqual(captured); expect(chat.pendingSend()?.references).toEqual(captured);
    expect(requests().filter(input => input.method === 'POST')).toHaveLength(0);
  });
  it('rejects forged pending scopes, Host changes during preparation, Shell references and Bot references before POST', async () => {
    const state = await import('./state'); await state.loadConnections(); const chat = state.createChat(target); await chat.draftReady;
    chat.insertReference({ kind: 'skill', value: 'review', label: 'Review' }); const captured = chat.referenceDocument();
    expect(await chat.send({ inputMode: 'shell' })).toBe(false); expect(chat.referenceDocument()).toEqual(captured);
    chat.pendingSend.set({ id: 'forged', text: captured.text, files: [], delivery: 'steer', uncertain: false, references: { ...captured, scope: { ...captured.scope, host: 'other' } } });
    expect(await chat.retrySend()).toBe(false); expect(chat.error()).toContain('scope-mismatch'); chat.pendingSend.set(null);
    const gate = deferred<{ text: string; skills: Array<{ id: string }> }>(); const sending = chat.send({ prepare: () => gate.promise }); await flush();
    state.app.connection.set({ id: 'other', label: 'Other', url: 'https://other.example', lastUsedAt: 0 }); gate.resolve({ text: '[skill:review]', skills: [{ id: 'review' }] });
    expect(await sending).toBe(false); expect(chat.referenceDocument()).toEqual(captured);
    expect(chat.insertReference({ kind: 'file', value: 'old.ts', label: 'old.ts' })).toBe(false);
    await state.loadConnections();
    const bot = state.createChat({ ...target, id: 'bot', kind: 'assistant' }); await bot.draftReady;
    expect(() => bot.insertReference({ kind: 'skill', value: 'review', label: 'Review' })).toThrow('not supported');
    bot.setDraftText('Bot input'); expect(await bot.send({ prepare: async () => ({ text: 'Bot input', skills: [{ id: 'review' }] }) })).toBe(false);
    expect(bot.error()).toContain('not supported'); expect(bot.draft()).toBe('Bot input');
    expect(requests().filter(input => input.method === 'POST')).toHaveLength(0);
  });
  it('durably journals compiled unknown sends before POST and reuses their ID/payload after restart without compiling again', async () => {
    let state = await import('./state'); await state.loadConnections(); const first = state.createChat(target); await first.draftReady; await flush();
    const normal = handle; let postedID = '', postedText = '';
    handle = (path, method, body) => {
      if (path.includes('/prompt?')) {
        const input = body as Record<string, unknown>; postedID = String(input.id); postedText = String(input.text);
        const saved = [...harness.storage.values()].map(value => JSON.parse(value)).find(value => value.pendingSend?.id === postedID);
        expect(saved.pendingSend).toMatchObject({ id: postedID, text: '/explore original', uncertain: true, preparedText: 'prepared', compiled: { text: 'prepared', agents: [{ name: 'explore' }], skills: [{ id: 'review' }] } });
        throw new Error('response lost');
      }
      if (path.includes('/message/msg_')) throw Object.assign(new Error('not found'), { status: 404 });
      return normal(path, method, body);
    };
    first.draft.set('/explore original');
    await first.send({ prepare: async () => ({ text: 'prepared', agents: [{ name: 'explore' }], skills: [{ id: 'review' }] }) });
    await first.flushDraft();
    vi.resetModules(); state = await import('./state'); await state.loadConnections(); const second = state.createChat(target); await second.draftReady; await flush();
    handle = (path, method, body) => {
      if (path.includes('/prompt?')) return { id: (body as Record<string, unknown>).id, sessionID: 's', type: 'user', payload: { text: (body as Record<string, unknown>).text } };
      if (path.includes('/message/msg_')) throw Object.assign(new Error('not found'), { status: 404 });
      return normal(path, method, body);
    };
    expect(second.pendingSend()?.id).toBe(postedID); await second.retrySend();
    const posts = requests().filter(input => input.method === 'POST');
    expect(posts).toHaveLength(2); expect(posts[1].body).toMatchObject({ id: postedID, text: postedText, agents: [{ name: 'explore' }], skills: [{ id: 'review' }] });
    expect(posts.some(input => input.path.includes('/command?'))).toBe(false);
    expect(second.draft()).toBe(''); expect(second.pendingSend()).toBeNull();
  });
  it('restored consumed input is reconciled without reposting and does not erase a newly typed draft', async () => {
    let state = await import('./state'); await state.loadConnections(); const first = state.createChat(target); await first.draftReady;
    first.draft.set('old'); first.pendingSend.set({ id: 'msg_consumed', text: 'old', files: [], delivery: 'queue', uncertain: true }); await first.flushDraft();
    const normal = handle;
    handle = (path, method, body) => path.includes('/message/msg_consumed?') ? { data: { id: 'msg_consumed', type: 'user', text: 'old' } } : normal(path, method, body);
    vi.resetModules(); state = await import('./state'); await state.loadConnections(); const second = state.createChat(target);
    second.draft.set('new user input'); await second.draftReady; await second.recoverPendingSend(); await flush();
    expect(second.pendingSend()).toBeNull(); expect(second.draft()).toBe('new user input');
    expect(requests().filter(input => input.method === 'POST')).toHaveLength(0);
  });
  it('dispatches native shell using verified command-only body and never replays an unknown shell after restart', async () => {
    let state = await import('./state'); await state.loadConnections(); const first = state.createChat(target); await first.draftReady;
    const normal = handle;
    handle = (path, method, body) => { if (path.includes('/shell?')) throw new Error('lost shell acknowledgement'); return normal(path, method, body); };
    first.draft.set('printf TEST'); expect(await first.send({ inputMode: 'shell' })).toBe(false); await first.flushDraft();
    expect(requests().filter(input => input.method === 'POST')).toEqual([{ path: '/api/session/s/shell?directory=%2Frepo', method: 'POST', body: { command: 'printf TEST' }, expectedHost: { hostID: 'one', lease: 'one-lease' } }]);
    vi.resetModules(); state = await import('./state'); await state.loadConnections(); const second = state.createChat(target); await second.draftReady; await flush();
    await second.retrySend(); expect(second.pendingSend()?.inputMode).toBe('shell'); expect(second.draft()).toBe('printf TEST');
    expect(requests().filter(input => input.method === 'POST')).toHaveLength(1);
  });
  it('blocks network admission on durable write failure and keeps draft/attachments intact', async () => {
    const state = await import('./state'); await state.loadConnections(); const chat = state.createChat(target); await chat.draftReady; await flush();
    chat.draft.set('keep this'); harness.setItem.mockRejectedValue(new Error('quota'));
    expect(await chat.send()).toBe(false); expect(chat.draft()).toBe('keep this'); expect(chat.draftError()).not.toBe('');
    expect(requests().filter(input => input.method === 'POST')).toHaveLength(0);
  });
  it('edits queued text/files only after a durable recovery record and verifies cancellation without posting', async () => {
    const state = await import('./state'); await state.loadConnections();
    let queued = true; const normal = handle;
    const item = { id: 'q', sessionID: 's', type: 'user', delivery: 'queue', payload: { text: 'queued text', files: [{ source: { type: 'uri', uri: 'attachment://queue' }, name: 'q.txt', mime: 'text/plain' }] } };
    handle = (path, method, body) => {
      if (path.includes('/inbox?')) return queued ? [item] : [];
      if (path.includes('/inbox/q?') && method === 'DELETE') {
        const saved = [...harness.storage.values()].map(value => JSON.parse(value)).find(value => value.queueEdit?.id === 'q');
        expect(saved.draft).toBe('queued text'); expect(saved.attachments[0].uri).toBe('attachment://queue');
        queued = false; return null;
      }
      if (path.includes('/message/q?')) throw Object.assign(new Error('not found'), { status: 404 });
      return normal(path, method, body);
    };
    const chat = state.createChat(target); await chat.draftReady; await flush();
    expect(await chat.editInbox('q')).toBe(true);
    expect(chat.draft()).toBe('queued text'); expect(chat.attachments()[0]?.uri).toBe('attachment://queue');
    expect(chat.queueEdit()).toBeNull(); expect(chat.inbox()).toEqual([]);
    expect(requests().filter(input => input.method === 'POST')).toHaveLength(0);
  });
  it('reconciles a lost queue-edit DELETE acknowledgement before retrying the mutation', async () => {
    const state = await import('./state'); await state.loadConnections(); const normal = handle;
    const file = { uri: 'attachment://queue', name: 'queued.txt', mime: 'text/plain' };
    const item = { id: 'q', sessionID: 's', type: 'user', delivery: 'queue', payload: { text: 'queued text', files: [file] } };
    let queued = true, deletes = 0;
    handle = (path, method, body) => {
      if (path.includes('/inbox?')) return queued ? [item] : [];
      if (path.includes('/inbox/q?') && method === 'DELETE') {
        deletes++;
        if (!queued) throw Object.assign(new Error('already removed'), { status: 404 });
        queued = false; throw new Error('lost DELETE acknowledgement');
      }
      if (path.includes('/message/q?')) throw Object.assign(new Error('not found'), { status: 404 });
      return normal(path, method, body);
    };
    const chat = state.createChat(target); await chat.draftReady; await flush();
    expect(await chat.editInbox('q')).toBe(false);
    expect(chat.queueEdit()).toMatchObject({ id: 'q', text: 'queued text', files: [file] });
    expect(await chat.send()).toBe(false);
    expect(await chat.editInbox('q')).toBe(true);
    expect(deletes).toBe(1); expect(chat.queueEdit()).toBeNull();
    expect(chat.draft()).toBe('queued text'); expect(chat.attachments()).toEqual([file]);
    expect(chat.inbox()).toEqual([]); expect(chat.queueError()).toBe('');
    expect(requests().filter(input => input.method === 'POST')).toHaveLength(0);
  });
  it.each([false, true])('queue-edit retry detects promoted input without DELETE or resend (later edit=%s)', async laterEdit => {
    const state = await import('./state'); await state.loadConnections(); const normal = handle;
    let queued = true, delivered = false, deletes = 0;
    handle = (path, method, body) => {
      if (path.includes('/inbox?')) return queued ? [{ id: 'q', sessionID: 's', type: 'user', delivery: 'queue', payload: { text: 'queued text' } }] : [];
      if (path.includes('/inbox/q?') && method === 'DELETE') {
        deletes++; queued = false; delivered = true; throw new Error('lost DELETE acknowledgement');
      }
      if (path.includes('/message/q?')) {
        if (delivered) return { data: { id: 'q', type: 'user', text: 'queued text' } };
        throw Object.assign(new Error('not found'), { status: 404 });
      }
      return normal(path, method, body);
    };
    const chat = state.createChat(target); await chat.draftReady; await flush();
    expect(await chat.editInbox('q')).toBe(false);
    if (laterEdit) chat.setDraftText('Later unrelated edit');
    expect(await chat.editInbox('q')).toBe(false);
    expect(deletes).toBe(1); expect(chat.inbox()).toEqual([]);
    expect(chat.draft()).toBe(laterEdit ? 'Later unrelated edit' : '');
    if (laterEdit) expect(chat.queueEdit()?.id).toBe('q');
    else expect(chat.queueEdit()).toBeNull();
    expect(await chat.send()).toBe(false);
    expect(requests().filter(input => input.method === 'POST')).toHaveLength(0);
  });
  it.each(['message', 'inbox'])('queue-edit retry retains unknown authority on %s read failure, then reconciles with GET only', async failedRead => {
    const state = await import('./state'); await state.loadConnections(); const normal = handle;
    let queued = true, unreadable = false, deletes = 0;
    handle = (path, method, body) => {
      if (path.includes('/inbox?')) {
        if (unreadable && failedRead === 'inbox') throw Object.assign(new Error('read unavailable'), { status: 503 });
        return queued ? [{ id: 'q', sessionID: 's', type: 'user', delivery: 'queue', payload: { text: 'queued text' } }] : [];
      }
      if (path.includes('/inbox/q?') && method === 'DELETE') { deletes++; queued = false; throw new Error('lost DELETE acknowledgement'); }
      if (path.includes('/message/q?')) {
        const failed = unreadable && failedRead === 'message';
        throw Object.assign(new Error(failed ? 'read unavailable' : 'not found'), { status: failed ? 503 : 404 });
      }
      return normal(path, method, body);
    };
    const chat = state.createChat(target); await chat.draftReady; await flush();
    expect(await chat.editInbox('q')).toBe(false); unreadable = true;
    expect(await chat.editInbox('q')).toBe(false);
    expect(chat.queueEdit()?.id).toBe('q'); expect(chat.draft()).toBe('queued text');
    expect(chat.queueError()).toBe('read unavailable'); expect(await chat.send()).toBe(false);
    unreadable = false; expect(await chat.editInbox('q')).toBe(true);
    expect(chat.queueEdit()).toBeNull(); expect(deletes).toBe(1);
    expect(requests().filter(input => input.method === 'POST')).toHaveLength(0);
  });
  it('queue-edit retry may DELETE again only when both reads confirm the same input is still pending', async () => {
    const state = await import('./state'); await state.loadConnections(); const normal = handle;
    let queued = true, deletes = 0;
    handle = (path, method, body) => {
      if (path.includes('/inbox?')) return queued ? [{ id: 'q', sessionID: 's', type: 'user', delivery: 'queue', payload: { text: 'queued text' } }] : [];
      if (path.includes('/inbox/q?') && method === 'DELETE') {
        deletes++; if (deletes === 1) throw new Error('DELETE unavailable');
        queued = false; return null;
      }
      if (path.includes('/message/q?')) throw Object.assign(new Error('not found'), { status: 404 });
      return normal(path, method, body);
    };
    const chat = state.createChat(target); await chat.draftReady; await flush();
    expect(await chat.editInbox('q')).toBe(false);
    expect(await chat.editInbox('q')).toBe(true);
    expect(deletes).toBe(2); expect(chat.queueEdit()).toBeNull(); expect(chat.error()).toBe('');
    expect(chat.draft()).toBe('queued text');
    expect(requests().filter(input => input.method === 'POST')).toHaveLength(0);
  });
  it('queue-edit recovery does not adopt a late read after the runtime lease changes', async () => {
    const state = await import('./state'); await state.loadConnections(); const normal = handle;
    let queued = true, deletes = 0;
    const gate = deferred<unknown>(); let gateRead = false;
    handle = (path, method, body) => {
      if (path.includes('/inbox?')) return queued ? [{ id: 'q', sessionID: 's', type: 'user', delivery: 'queue', payload: { text: 'queued text' } }] : [];
      if (path.includes('/inbox/q?') && method === 'DELETE') { deletes++; queued = false; throw new Error('lost DELETE acknowledgement'); }
      if (path.includes('/message/q?')) {
        if (gateRead) return gate.promise;
        throw Object.assign(new Error('not found'), { status: 404 });
      }
      return normal(path, method, body);
    };
    const chat = state.createChat(target); await chat.draftReady; await flush();
    expect(await chat.editInbox('q')).toBe(false); gateRead = true;
    const retry = chat.editInbox('q'); await flush();
    state.app.runtimeScope.set({ hostID: 'one', lease: 'replacement-lease' });
    gate.resolve({ data: { id: 'q', type: 'user', text: 'queued text' } });
    expect(await retry).toBe(false);
    expect(chat.queueEdit()?.id).toBe('q'); expect(chat.draft()).toBe('queued text');
    expect(deletes).toBe(1); expect(requests().filter(input => input.method === 'POST')).toHaveLength(0);
  });
  it('queue-edit retry cannot DELETE until its recovery record is durably stored', async () => {
    const state = await import('./state'); await state.loadConnections(); const normal = handle;
    let queued = true, deletes = 0;
    handle = (path, method, body) => {
      if (path.includes('/inbox?')) return queued ? [{ id: 'q', sessionID: 's', type: 'user', delivery: 'queue', payload: { text: 'queued text' } }] : [];
      if (path.includes('/inbox/q?') && method === 'DELETE') { deletes++; queued = false; return null; }
      if (path.includes('/message/q?')) throw Object.assign(new Error('not found'), { status: 404 });
      return normal(path, method, body);
    };
    const chat = state.createChat(target); await chat.draftReady; await flush();
    harness.setItem.mockRejectedValue(new Error('storage unavailable'));
    expect(await chat.editInbox('q')).toBe(false); expect(deletes).toBe(0);
    expect(await chat.editInbox('q')).toBe(false); expect(deletes).toBe(0);
    expect(chat.queueEdit()?.id).toBe('q'); expect(chat.draft()).toBe('queued text');
    harness.setItem.mockImplementation(async (key: string, value: string) => { harness.storage.set(key, value); });
    expect(await chat.editInbox('q')).toBe(true); expect(deletes).toBe(1);
    expect(chat.queueEdit()).toBeNull(); expect(chat.draft()).toBe('queued text');
  });
  it('cold queue-edit recovery confirms a lost DELETE with GET only and preserves the attachment draft', async () => {
    let state = await import('./state'); await state.loadConnections(); const normal = handle;
    const file = { uri: 'attachment://queue', name: 'queued.txt', mime: 'text/plain' };
    let queued = true, deletes = 0;
    handle = (path, method, body) => {
      if (path.includes('/inbox?')) return queued ? [{ id: 'q', sessionID: 's', type: 'user', delivery: 'queue', payload: { text: 'queued text', files: [file] } }] : [];
      if (path.includes('/inbox/q?') && method === 'DELETE') { deletes++; queued = false; throw new Error('lost DELETE acknowledgement'); }
      if (path.includes('/message/q?')) throw Object.assign(new Error('not found'), { status: 404 });
      return normal(path, method, body);
    };
    const first = state.createChat(target); await first.draftReady; await flush();
    expect(await first.editInbox('q')).toBe(false); await first.flushDraft();
    harness.disposers.forEach(stop => stop()); harness.cleanups.forEach(stop => stop());
    harness.disposers = []; harness.cleanups = []; harness.listeners.clear();
    vi.resetModules(); state = await import('./state'); await state.loadConnections();
    const restored = state.createChat(target); await restored.draftReady; await flush();
    expect(restored.queueEdit()).toBeNull(); expect(deletes).toBe(1);
    expect(restored.draft()).toBe('queued text'); expect(restored.attachments()).toEqual([file]);
    expect(requests().filter(input => input.method === 'POST')).toHaveLength(0);
  });
  it('detects consumption during queue editing and never turns the consumed item into a sendable duplicate', async () => {
    const state = await import('./state'); await state.loadConnections(); const normal = handle;
    let queued = true;
    handle = (path, method, body) => {
      if (path.includes('/inbox?')) return queued ? [{ id: 'q', sessionID: 's', type: 'user', delivery: 'queue', payload: { text: 'old queued' } }] : [];
      if (path.includes('/inbox/q?') && method === 'DELETE') { queued = false; emit('session.inbox.delivered', { sessionID: 's', inboxID: 'q' }); return null; }
      if (path.includes('/message/q?')) return { data: { id: 'q', type: 'user', text: 'old queued' } };
      return normal(path, method, body);
    };
    const chat = state.createChat(target); await chat.draftReady; await flush();
    expect(await chat.editInbox('q')).toBe(false); expect(chat.draft()).toBe('');
    expect(await chat.send()).toBe(false); expect(chat.inbox()).toEqual([]);
    expect(requests().filter(input => input.method === 'POST')).toHaveLength(0);
  });
  it('steers/cancels only revalidated inbox IDs with the native PATCH/DELETE contract', async () => {
    const state = await import('./state'); await state.loadConnections(); const normal = handle;
    let items = [{ id: 'q', sessionID: 's', type: 'user', delivery: 'queue', payload: { text: 'queued' } }];
    handle = (path, method, body) => {
      if (path.includes('/inbox?')) return items;
      if (path.includes('/inbox/q?') && method === 'DELETE') { items = []; return null; }
      return normal(path, method, body);
    };
    const chat = state.createChat(target); await chat.draftReady; await flush();
    expect(await chat.steerInbox('q')).toBe(true); expect(await chat.cancelInbox('q')).toBe(true);
    expect(await chat.steerInbox('q')).toBe(false);
    expect(requests().filter(input => input.method === 'PATCH' || input.method === 'DELETE')).toEqual([
      { path: '/api/session/s/inbox/q?directory=%2Frepo', method: 'PATCH', body: { delivery: 'steer' }, expectedHost: { hostID: 'one', lease: 'one-lease' } },
      { path: '/api/session/s/inbox/q?directory=%2Frepo', method: 'DELETE', expectedHost: { hostID: 'one', lease: 'one-lease' } },
    ]);
  });
  it('keeps queue mutation errors visible across successful background snapshot reads', async () => {
    const state = await import('./state'); await state.loadConnections(); const normal = handle;
    let rejecting = true;
    handle = (path, method, body) => {
      if (path.includes('/inbox?')) return [{ id: 'q', sessionID: 's', type: 'user', delivery: 'queue', payload: { text: 'queued' } }];
      if (path.includes('/inbox/q?') && method === 'DELETE' && rejecting) throw new Error('queue unavailable');
      return normal(path, method, body);
    };
    const chat = state.createChat(target); await chat.draftReady; await flush();
    expect(await chat.cancelInbox('q')).toBe(false);
    await chat.load();
    expect(chat.queueError()).toBe('queue unavailable'); expect(chat.inbox()).toHaveLength(1);
    rejecting = false; expect(await chat.cancelInbox('q')).toBe(true); expect(chat.queueError()).toBe('');
  });
  it('uses native interrupt without treating its acknowledgement as authoritative idle', async () => {
    const state = await import('./state'); await state.loadConnections(); const chat = state.createChat(target); await flush();
    const normal = handle;
    handle = (path, method, body) => path === '/api/session/active' ? { s: { type: 'running' } } : normal(path, method, body);
    emit('session.execution.started', { sessionID: 's' });
    await chat.stop();
    expect(requests().filter(input => input.method === 'POST')).toEqual([{ path: '/api/session/s/interrupt?directory=%2Frepo', method: 'POST', body: {}, expectedHost: { hostID: 'one', lease: 'one-lease' } }]);
    expect(chat.busy()).toBe(true);
    emit('session.execution.interrupted', { sessionID: 's', reason: 'user' }); expect(chat.busy()).toBe(false);
  });
  it('retains native execution failure before an assistant row exists until a new execution starts', async () => {
    const state = await import('./state'); await state.loadConnections(); const chat = state.createChat(target); await flush();
    emit('session.execution.failed', { sessionID: 's', error: { type: 'provider.auth', message: 'Provider rejected' } });
    expect(chat.busy()).toBe(false); expect(chat.error()).toBe('Provider rejected');
    await vi.advanceTimersByTimeAsync(120);
    expect(chat.executionError()).toBe('Provider rejected'); expect(chat.error()).toBe('Provider rejected');
    emit('session.execution.started', { sessionID: 's' });
    expect(chat.executionError()).toBe(''); expect(chat.error()).toBe(''); expect(chat.busy()).toBe(true);
  });
  it('publishes retry/transport state and clears retry only on resumed output or authority', async () => {
    const state = await import('./state'); await state.loadConnections(); const chat = state.createChat(target); await flush();
    expect(chat.streamState()).toBe('connecting');
    emit('server.connected', {}); expect(chat.streamState()).toBe('live');
    emit('session.retry.scheduled', { sessionID: 's', attempt: 2, at: 9000, error: { message: 'temporary' } });
    expect(chat.busy()).toBe(true); expect(chat.retry()).toMatchObject({ attempt: 2, at: 9000 });
    emit('session.tool.progress', { sessionID: 's', assistantMessageID: 'm', id: 'call', metadata: {} });
    expect(chat.retry()).not.toBeNull();
    emit('session.reasoning.delta', { sessionID: 's', assistantMessageID: 'm', ordinal: 0, delta: 'resumed' });
    expect(chat.retry()).toBeNull(); expect(chat.busy()).toBe(true);
    for (const listener of harness.listeners.get('runtime.disconnected') ?? []) listener(issuedStream(harness.call));
    expect(chat.streamState()).toBe('disconnected'); expect(chat.busy()).toBe(true);
    for (const listener of harness.listeners.get('runtime.event') ?? []) listener({ ...issuedStream(harness.call), type: 'reconnected' });
    await vi.advanceTimersByTimeAsync(120); expect(chat.streamState()).toBe('live'); expect(chat.busy()).toBe(false);
  });
  it('routes registered slash commands to native command, never prompt, including while busy', async () => {
    const state = await import('./state'); await state.loadConnections(); const chat = state.createChat(target); await flush();
    const normal = handle;
    handle = (path, method, body) => path.startsWith('/api/command?') ? { data: [{ name: 'goal', description: 'Goal' }] } : normal(path, method, body);
    emit('session.execution.started', { sessionID: 's' });
    chat.draft.set('/GOAL pause'); expect(await chat.send()).toBe(true);
    const posts = requests().filter(input => input.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ path: '/api/session/s/command?directory=%2Frepo', body: { name: 'goal', text: 'pause', delivery: 'queue' } });
    expect(posts[0].body).not.toHaveProperty('id');
    expect(chat.draft()).toBe(''); expect(chat.pendingSend()).toBeNull();
    expect(await chat.command('explore', 'inspect')).toBe(false);
    expect(chat.draft()).toBe('/explore inspect'); expect(chat.error()).not.toBe('');
    expect(requests().filter(input => input.method === 'POST')).toHaveLength(1);
  });
  it('preserves ambiguous commands and never retries a non-idempotent native 204 operation', async () => {
    const state = await import('./state'); await state.loadConnections(); const chat = state.createChat(target); await flush();
    const normal = handle;
    handle = (path, method, body) => {
      if (path.startsWith('/api/command?')) return { data: [{ name: 'goal' }] };
      if (path.includes('/command?')) throw new Error('lost 204 response');
      return normal(path, method, body);
    };
    expect(await chat.command('goal', 'clear')).toBe(false);
    expect(chat.pendingSend()?.uncertain).toBe(true); expect(chat.draft()).toBe('/goal clear');
    chat.draft.set('later draft'); await chat.retrySend();
    expect(chat.draft()).toBe('later draft'); expect(chat.pendingSend()?.command).toEqual({ name: 'goal', text: 'clear' });
    expect(requests().filter(input => input.method === 'POST')).toHaveLength(1);
  });
  it('catalog failures preserve command draft without marking an undispatched command uncertain', async () => {
    const state = await import('./state'); await state.loadConnections(); const chat = state.createChat(target); await flush();
    const normal = handle;
    handle = (path, method, body) => { if (path.startsWith('/api/command?')) throw new Error('offline catalog'); return normal(path, method, body); };
    expect(await chat.command('explore', 'inspect')).toBe(false);
    expect(chat.pendingSend()?.uncertain).toBe(false); expect(chat.draft()).toBe('/explore inspect');
    expect(requests().filter(input => input.method === 'POST')).toHaveLength(0);
  });
  it('renders native text/reasoning/tool deltas without token-frequency GETs and deduplicates event IDs', async () => {
    const state = await import('./state'); await state.loadConnections(); const chat = state.createChat(target); await flush();
    const history = chat.messages()[0]; harness.call.mockClear();
    emit('session.step.started', { sessionID: 's', assistantMessageID: 'new' });
    emit('session.text.started', { sessionID: 's', assistantMessageID: 'new', ordinal: 0 });
    for (let count = 0; count < 100; count++) emit('session.text.delta', { sessionID: 's', assistantMessageID: 'new', ordinal: 0, delta: 'a' });
    const payload = { ...issuedStream(harness.call), data: JSON.stringify({ id: 'evt_once', created: 10, type: 'session.text.delta', data: { sessionID: 's', assistantMessageID: 'new', ordinal: 0, delta: 'b' } }) };
    for (let count = 0; count < 2; count++) for (const listener of harness.listeners.get('runtime.event') ?? []) listener(payload);
    emit('session.reasoning.delta', { sessionID: 's', assistantMessageID: 'new', ordinal: 0, delta: 'think' });
    emit('session.tool.input.started', { sessionID: 's', assistantMessageID: 'new', id: 'call_z', name: 'shell' });
    emit('session.tool.called', { sessionID: 's', assistantMessageID: 'new', id: 'call_z', input: { command: 'printf OK' } });
    emit('session.tool.success', { sessionID: 's', assistantMessageID: 'new', id: 'call_z', content: [{ type: 'text', text: 'OK' }] });
    await vi.advanceTimersByTimeAsync(120);
    expect(requests()).toHaveLength(0);
    expect(chat.messages()[0]).toBe(history);
    expect(chat.messages()[1]).toMatchObject({ id: 'new', text: 'a'.repeat(100) + 'b', reasoning: 'think', tools: [{ id: 'call_z', state: { status: 'completed', output: 'OK' } }] });
    expect(chat.busy()).toBe(true);
  });
  it('publishes merged deltas in one 32ms frame and never replays intermediate text', async () => {
    const state = await import('./state'); await state.loadConnections(); const chat = state.createChat(target); await flush();
    emit('session.execution.started', { sessionID: 's' }); harness.call.mockClear();
    emit('session.text.started', { sessionID: 's', assistantMessageID: 'frame', ordinal: 0 });
    for (let count = 0; count < 8; count++) emit('session.text.delta', { sessionID: 's', assistantMessageID: 'frame', ordinal: 0, delta: 'x' });
    expect(chat.messages().find(message => message.id === 'frame')).toBeUndefined();
    await vi.advanceTimersByTimeAsync(31);
    expect(chat.messages().find(message => message.id === 'frame')).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(chat.messages().find(message => message.id === 'frame')?.text).toBe('x'.repeat(8));
    expect(requests()).toHaveLength(0);
    emit('session.text.delta', { sessionID: 's', assistantMessageID: 'frame', ordinal: 0, delta: 'y' });
    await vi.advanceTimersByTimeAsync(32);
    expect(chat.messages().find(message => message.id === 'frame')?.text).toBe('x'.repeat(8) + 'y');
    expect(requests()).toHaveLength(0);
  });
  it('keeps content compensation for a busy turn whose live stream never became ready', async () => {
    const state = await import('./state'); await state.loadConnections(); const chat = state.createChat(target); await flush();
    emit('session.execution.started', { sessionID: 's' }); harness.call.mockClear();
    await vi.advanceTimersByTimeAsync(4100);
    expect(requests().filter(input => input.path.includes('/message?')).length).toBeGreaterThan(0);
  });
  it('refreshes terminal turn authority immediately when the live stream never became ready', async () => {
    const state = await import('./state'); await state.loadConnections(); const chat = state.createChat(target); await flush();
    emit('session.execution.started', { sessionID: 's' });
    const normal = handle;
    handle = (path, method, body) => path.includes('/message?') ? { data: [{ id: 'answer', type: 'assistant', content: [{ type: 'text', text: 'done' }] }] } : normal(path, method, body);
    emit('session.execution.succeeded', { sessionID: 's' });
    await flush(); await vi.advanceTimersByTimeAsync(0); await flush();
    expect(chat.messages().some(message => message.id === 'answer')).toBe(true);
  });
  it('protects live native content from stale GET completion and repairs it on terminal authority', async () => {
    const state = await import('./state'); await state.loadConnections(); const chat = state.createChat(target); await flush();
    emit('server.connected', {}); await vi.advanceTimersByTimeAsync(120);
    const late = deferred<unknown>(), normal = handle;
    handle = (path, method, body) => path.includes('/message?') ? late.promise : normal(path, method, body);
    const read = chat.load();
    emit('session.text.delta', { sessionID: 's', assistantMessageID: 'new', ordinal: 0, delta: 'live' });
    late.resolve({ data: [{ id: 'new', type: 'assistant', content: [{ type: 'text', text: 'old' }] }] }); await read;
    expect(chat.messages().find(message => message.id === 'new')?.text).toBe('live');
    handle = (path, method, body) => path.includes('/message?') ? { data: [{ id: 'new', type: 'assistant', content: [{ type: 'text', text: 'final' }] }] } : normal(path, method, body);
    emit('session.execution.succeeded', { sessionID: 's' }); await vi.advanceTimersByTimeAsync(120);
    expect(chat.messages().find(message => message.id === 'new')?.text).toBe('final');
    expect(chat.busy()).toBe(false);
  });
  it('keeps global disconnect offline through old HTTP completions and only recovers after a successful reconnect snapshot', async () => {
    const state = await import('./state'); await state.loadConnections();
    const normal = handle;
    handle = (path, method, body) => {
      if (path === '/api/config/settings') return { projects: [] };
      if (path === '/api/yuri/session-index') return { available: true, directories: [] };
      if (path === '/api/yuri/scheduled-tasks') return { tasks: [] };
      return normal(path, method, body);
    };
    state.runtimeLifecycle(); await flush(); expect(state.app.online()).toBe(true);
    for (const listener of harness.listeners.get('runtime.disconnected') ?? []) listener({ key: 'chat' });
    expect(state.app.online()).toBe(true);
    const late = deferred<unknown>(), healthy = handle;
    handle = (path, method, body) => path === '/api/yuri/session-index' ? late.promise : healthy(path, method, body);
    const oldRead = state.refresh();
    for (const listener of harness.listeners.get('runtime.disconnected') ?? []) listener({ key: 'global' });
    expect(state.app.online()).toBe(false);
    late.resolve({ available: true, directories: [] }); await oldRead;
    expect(state.app.online()).toBe(false);
    await state.refresh(); expect(state.app.online()).toBe(false);
    handle = () => { throw new Error('offline'); };
    for (const listener of harness.listeners.get('runtime.event') ?? []) listener({ type: 'reconnected', key: 'global' });
    await flush(); expect(state.app.online()).toBe(false);
    handle = healthy;
    for (const listener of harness.listeners.get('runtime.event') ?? []) listener({ type: 'reconnected', key: 'global' });
    expect(state.app.online()).toBe(false);
    await flush(); expect(state.app.online()).toBe(true);
    harness.disposers[0]!();
    expect(harness.listeners.get('runtime.disconnected')?.size).toBe(0);
  });
  it('ignores an old global subscription after the connection generation changes', async () => {
    const state = await import('./state'); await state.loadConnections(); state.runtimeLifecycle(); await flush();
    harness.call.mockResolvedValueOnce({ connections: [{ id: 'two', url: 'https://other.example' }], selected: 'two' });
    await state.loadConnections(); state.app.online.set(true);
    for (const listener of harness.listeners.get('runtime.disconnected') ?? []) listener({ key: 'global' });
    expect(state.app.online()).toBe(true);
    harness.call.mockClear();
    for (const listener of harness.listeners.get('runtime.event') ?? []) listener({ type: 'reconnected', key: 'global' });
    expect(harness.call).not.toHaveBeenCalled();
  });
  it('preserves busy across chat disconnect and rejects unissued stale frames until ready compensation', async () => {
    const state = await import('./state'); await state.loadConnections(); const chat = state.createChat(target); await flush();
    emit('session.execution.started', { sessionID: 's' }); expect(chat.busy()).toBe(true);
    const late = deferred<unknown>(), normal = handle;
    handle = (path, method, body) => path === '/api/session/active' ? late.promise : normal(path, method, body);
    const read = chat.load();
    for (const listener of harness.listeners.get('runtime.disconnected') ?? []) listener(issuedStream(harness.call));
    late.resolve({}); await read;
    for (const listener of harness.listeners.get('runtime.event') ?? []) listener({ key: 'chat', data: JSON.stringify({ type: 'session.idle', data: { sessionID: 's' } }) });
    expect(chat.busy()).toBe(true);
    for (const listener of harness.listeners.get('runtime.event') ?? []) listener({ ...issuedStream(harness.call), type: 'reconnected' });
    await vi.advanceTimersByTimeAsync(120); expect(chat.busy()).toBe(false);
  });
  it('reselecting the current connection never stops or replaces live streams', async () => {
    const state = await import('./state'); await state.loadConnections();
    state.runtimeLifecycle(); const chat = state.createChat(target); await flush();
    const connection = state.app.connection(), epoch = state.epoch(); harness.call.mockClear();
    await state.switchConnection('one');
    expect(harness.call).not.toHaveBeenCalled();
    expect(state.app.connection()).toBe(connection); expect(state.epoch()).toBe(epoch);
    emit('session.execution.started', { sessionID: 's' }); expect(chat.busy()).toBe(true);
  });
  it('ordinary metadata reads do not invalidate a connection when lastUsedAt changes', async () => {
    const state = await import('./state'); await state.loadConnections();
    const connection = state.app.connection(), epoch = state.epoch();
    harness.call.mockResolvedValueOnce({ connections: [{ ...connection, lastUsedAt: 500 }], selected: 'one', runtimeScope: { hostID: 'one', lease: 'one-lease' } });
    await state.loadConnections();
    expect(state.app.connection()).toBe(connection); expect(state.epoch()).toBe(epoch);
    expect(state.app.connections()[0]?.lastUsedAt).toBe(500);
  });
  it('explicit same-host reconnect fences old requests immediately and changes the stream binding', async () => {
    const state = await import('./state'); await state.loadConnections(); const chat = state.createChat(target); await flush();
    const connection = state.app.connection(), epoch = state.epoch();
    state.app.projects.set([{ id: 'p', name: 'Project', path: '/repo' }]);
    const late = deferred<unknown>(), snapshot = deferred<unknown>(), normal = handle;
    handle = (path, method, body) => path.includes('/message?') ? late.promise : normal(path, method, body);
    const read = chat.load();
    harness.call.mockImplementationOnce(() => snapshot.promise);
    const reconnect = state.loadConnections({ forceReconnect: true });
    expect(state.epoch()).toBe(epoch + 1);
    late.resolve({ data: [{ id: 'stale', type: 'user', text: 'old authorization' }] }); await read;
    expect(chat.messages().map(message => message.id)).toEqual(['history']);
    snapshot.resolve({ connections: [{ ...connection, lastUsedAt: 500 }], selected: 'one', runtimeScope: { hostID: 'one', lease: 'renewed-lease' } }); await reconnect;
    expect(state.app.connection()).toEqual({ ...connection, lastUsedAt: 500 });
    expect(state.app.connection()).not.toBe(connection); expect(state.epoch()).toBe(epoch + 1);
    expect(state.app.projects()).toEqual([{ id: 'p', name: 'Project', path: '/repo' }]);
    harness.call.mockClear(); state.runtimeLifecycle(); await flush();
    expect(harness.call.mock.calls).toContainEqual(['runtime.stream', { path: '/api/yuri/events', key: 'global', expectedHost: { hostID: 'one', lease: 'renewed-lease' } }]);
  });
  it('a newer ordinary snapshot retains a pending explicit reconnect boundary', async () => {
    const state = await import('./state'); await state.loadConnections();
    const connection = state.app.connection(), epoch = state.epoch(), snapshot = deferred<unknown>();
    harness.call.mockImplementationOnce(() => snapshot.promise);
    const forced = state.loadConnections({ forceReconnect: true });
    await state.loadConnections();
    expect(state.app.connection()).not.toBe(connection); expect(state.epoch()).toBe(epoch + 1);
    const rebound = state.app.connection();
    snapshot.resolve({ connections: [{ ...connection, label: 'stale metadata' }], selected: 'one', runtimeScope: { hostID: 'one', lease: 'stale-lease' } }); await forced;
    expect(state.app.connection()).toBe(rebound); expect(state.epoch()).toBe(epoch + 1);
  });
  it('never infers busy from history; live events beat an older active snapshot', async () => {
    const state = await import('./state'); await state.loadConnections();
    const active = deferred<unknown>(), normal = handle;
    handle = (path, method, body) => path === '/api/session/active' ? active.promise : normal(path, method, body);
    const chat = state.createChat(target); await flush();
    expect(chat.busy()).toBe(false);
    emit('session.execution.started', { sessionID: 's' });
    expect(chat.busy()).toBe(true);
    active.resolve({}); await flush();
    expect(chat.busy()).toBe(true);
    emit('session.execution.succeeded', { sessionID: 's' }); expect(chat.busy()).toBe(false);
  });
  it('ignores 100 unrelated stream events and coalesces relevant events at 120ms', async () => {
    const state = await import('./state'); await state.loadConnections();
    const chat = state.createChat(target); await flush(); emit('server.connected', {}); await vi.advanceTimersByTimeAsync(120); harness.call.mockClear();
    for (let count = 0; count < 100; count++) emit('message.updated', { info: { sessionID: 'other' } });
    await vi.advanceTimersByTimeAsync(120); expect(requests()).toHaveLength(0);
    for (let count = 0; count < 100; count++) emit('message.updated', { info: { sessionID: 's' } });
    await vi.advanceTimersByTimeAsync(119); expect(requests()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1); expect(requests().filter(input => input.path.includes('/message?'))).toHaveLength(1); expect(requests().filter(input => input.path.startsWith('/api/session/s?'))).toHaveLength(1);
    expect(chat.messages()).toHaveLength(1);
  });
  it('preserves prior data on failed refresh and successful empty authority clears it', async () => {
    const state = await import('./state'); await state.loadConnections(); const chat = state.createChat(target); await flush();
    const previous = chat.messages(); handle = () => { throw new Error('offline'); };
    await chat.load(); expect(chat.messages()).toBe(previous); expect(chat.error()).toContain('offline');
    handle = path => path.includes('/message?') ? { data: [] } : path.startsWith('/api/session/s?') ? { id: 's' } : path === '/api/session/active' ? {} : [];
    await chat.load(); expect(chat.messages()).toEqual([]); expect(chat.error()).toBe('');
  });
  it('keeps stable ID, delivery and draft across ambiguous prompt failures', async () => {
    const state = await import('./state'); await state.loadConnections(); const chat = state.createChat(target); await flush();
    emit('session.execution.started', { sessionID: 's' });
    const normal = handle; let attempts = 0;
    handle = (path, method, body) => {
      if (path.includes('/prompt?')) {
        attempts++;
        if (attempts === 1) throw new Error('lost response');
        const input = body as Record<string, unknown>;
        return { id: input.id, sessionID: 's', type: 'user', delivery: input.delivery, payload: { text: input.text } };
      }
      return normal(path, method, body);
    };
    chat.draft.set('hello'); await chat.send(); expect(chat.draft()).toBe('hello');
    const pending = chat.pendingSend(); expect(pending?.uncertain).toBe(true);
    emit('session.execution.succeeded', { sessionID: 's' });
    await chat.send();
    const posts = requests().filter(input => input.path.includes('/prompt?'));
    expect(posts.map(input => input.body)).toEqual([{ id: pending!.id, text: 'hello', delivery: 'queue' }, { id: pending!.id, text: 'hello', delivery: 'queue' }]);
    expect(chat.draft()).toBe(''); expect(chat.pendingSend()).toBeNull();
  });
  it('reconciles a consumed prompt without a second POST', async () => {
    const state = await import('./state'); await state.loadConnections(); const chat = state.createChat(target); await flush();
    const normal = handle;
    handle = (path, method, body) => path.includes('/prompt?') ? Promise.reject(new Error('timeout')) : normal(path, method, body);
    chat.draft.set('hello'); await chat.send(); const submission = chat.pendingSend()!;
    handle = (path, method, body) => path.includes(`/message/${submission.id}?`) ? { info: { id: submission.id, role: 'user' }, parts: [] } : normal(path, method, body);
    await chat.send(); expect(requests().filter(input => input.path.includes('/prompt?'))).toHaveLength(1); expect(chat.pendingSend()).toBeNull();
  });
  it('uses real assistant parts/admission and abort binding', async () => {
    const state = await import('./state'); await state.loadConnections(); const chat = state.createChat({ ...target, kind: 'assistant', id: 'bot' }); await flush();
    const normal = handle;
    handle = (path, method, body) => path.endsWith('/bot/messages') ? { admitted: true, messageID: (body as Record<string, unknown>).messageID } : normal(path, method, body);
    chat.draft.set('hello'); await chat.send(); await chat.stop();
    expect(requests().find(input => input.path.endsWith('/bot/messages')).body).toMatchObject({ parts: [{ type: 'text', text: 'hello' }] });
    expect(requests().find(input => input.path.endsWith('/session/abort')).body).toEqual({ sessionID: null, sessionGeneration: 2 });
  });
  it('exposes permission/form replies with the native wire and rejects the full pending set', async () => {
    const state = await import('./state'); await state.loadConnections();
    const normal = handle; let replied = false;
    handle = (path, method, body) => {
      if (method === 'POST') { replied = true; return null; }
      if (path.includes('/permission/request?')) return replied ? [] : [{ id: 'p1', sessionID: 's' }, { id: 'p2', sessionID: 's' }, { id: 'p3', sessionID: 'other' }];
      return normal(path, method, body);
    };
    const chat = state.createChat(target); await flush(); expect(chat.permissions()).toHaveLength(2);
    await chat.replyPermission('p1', 'reject', 'no'); expect(chat.permissions()).toEqual([]);
    await chat.replyForm('frm_1', { accept: true }); await chat.cancelForm('frm_2');
    expect(requests().filter(input => input.method === 'POST').map(input => [input.path, input.body])).toEqual([
      ['/api/session/s/permission/p1/reply?directory=%2Frepo', { decision: 'reject', message: 'no' }],
      ['/api/session/s/form/frm_1/reply?directory=%2Frepo', { answer: { accept: true } }],
      ['/api/session/s/form/frm_2/cancel?directory=%2Frepo', undefined],
    ]);
  });
  it('polls only the latest chat and never polls while backgrounded', async () => {
    const state = await import('./state'); await state.loadConnections(); state.createChat(target); await flush();
    state.createChat({ ...target, id: 's2' }); await flush(); harness.call.mockClear();
    await vi.advanceTimersByTimeAsync(4000);
    expect(requests().filter(input => input.path.includes('/message?')).map(input => input.path)).toEqual(['/api/session/s2/message?directory=%2Frepo&limit=20&order=desc']);
    harness.lifecycle = 'background'; harness.call.mockClear(); await vi.advanceTimersByTimeAsync(8000); expect(requests()).toHaveLength(0);
  });
  it('discards responses from a previous connection and preserves data on failed selection', async () => {
    const state = await import('./state'); await state.loadConnections(); const chat = state.createChat(target); await flush();
    const late = deferred<unknown>(), normal = handle;
    handle = (path, method, body) => path.includes('/message?') ? late.promise : normal(path, method, body);
    const read = chat.load();
    harness.call.mockImplementation(async (name, input) => {
      if (name === 'connection.list') return { connections: [{ id: 'two', url: 'https://other.example' }], selected: 'two' };
      if (name === 'runtime.request') return { status: 200, body: await handle(input.path, input.method, input.body) };
      return true;
    });
    await state.loadConnections(); late.resolve({ data: [{ id: 'stale', type: 'user', text: 'wrong connection' }] }); await read;
    expect(chat.messages().map(message => message.id)).toEqual(['history']);
    state.app.projects.set([{ id: 'p', name: 'Project', path: '/repo' }]);
    harness.call.mockRejectedValueOnce(new Error('bad selection'));
    await expect(state.switchConnection('missing')).rejects.toThrow('bad selection');
    expect(state.app.projects()).toHaveLength(1); expect(state.app.connection()?.id).toBe('two');
  });
  it('clears contact history on a newer empty generation and rejects a stale generation', async () => {
    const state = await import('./state'); await state.loadConnections(); const normal = handle;
    let page = { messages: [{ messageID: 'a', role: 'user', ordinal: 1, parts: [{ type: 'text', text: 'old' }] }], complete: true, generation: 1, revision: 1 };
    handle = (path, method, body) => path.includes('/contact/messages') ? page : normal(path, method, body);
    const chat = state.createChat({ ...target, kind: 'assistant', id: 'bot' }); await flush(); expect(chat.messages()).toHaveLength(1);
    expect(chat.contactReadPosition()).toEqual({ generation: 1, ordinal: 1, messageID: 'a' });
    page = { ...page, messages: [], generation: 2, revision: 2 }; await chat.load(); expect(chat.messages()).toEqual([]);
    expect(chat.contactReadPosition()).toBeNull();
    page = { ...page, messages: [{ messageID: 'stale', role: 'user', ordinal: 1, parts: [] }], generation: 1, revision: 3 };
    await chat.load(); expect(chat.messages()).toEqual([]);
    expect(chat.contactReadPosition()).toBeNull();
  });
  it('keeps newer contact stream text when an older GET resolves', async () => {
    const state = await import('./state'); await state.loadConnections();
    await harness.call('runtime.stream', { key: 'global', path: '/api/yuri/events', expectedHost: state.app.runtimeScope() });
    const chat = state.createChat({ ...target, kind: 'assistant', id: 'bot' }); await flush();
    const late = deferred<unknown>(), normal = handle;
    handle = (path, method, body) => path.includes('/contact/messages') ? late.promise : normal(path, method, body);
    const read = chat.load();
    emit('yuri:contact-bubble-delta', { assistantID: 'bot', turnID: 'turn', bubbleIndex: 0, delta: 'new text', done: false, occurredAt: 1234 }, 'global');
    late.resolve({ messages: [{ messageID: 'turn:bubble:1', role: 'assistant', ordinal: 1, parts: [{ type: 'text', text: 'old' }] }], complete: true, generation: 1, revision: 2 });
    await read; expect(chat.messages()[0]?.text).toBe('new text');
    expect(chat.messages()[0]).toMatchObject({ contact: { kind: 'assistant', assistantID: 'bot', turnID: 'turn', bubbleIndex: 0, createdAt: 1234, status: 'streaming' }, content: [{ type: 'text', text: 'new text' }] });
  });
  it('keeps authoritative contact wire order across tail overlap with tied ordinals instead of ranking identities', async () => {
    const state = await import('./state'); await state.loadConnections(); const normal = handle;
    const row = (messageID: string, ordinal: number) => ({ messageID, role: 'assistant', ordinal, parts: [{ type: 'text', text: messageID }] });
    let page = { messages: [row('z-first', 1), row('a-second', 1), row('tail', 2)], nextCursor: 'older', complete: false, generation: 1, revision: 1 };
    handle = (path, method, body) => path.includes('/contact/messages') ? page : normal(path, method, body);
    const chat = state.createChat({ ...target, kind: 'assistant', id: 'bot' }); await flush();
    page = { ...page, messages: [row('a-second', 1), row('tail', 2), row('new', 3)], revision: 2 };
    await chat.load(); expect(chat.messages().map(message => message.id)).toEqual(['z-first', 'a-second', 'tail', 'new']);
  });
  it('catalog tips fetch only their owning domain; token events never fetch catalogs', async () => {
    const state = await import('./state'); await state.loadConnections(); state.observeRuntime(() => { void state.refresh(); });
    await flush(); expect(requests()).toEqual([expect.objectContaining({ path: '/api/debug/location', method: 'GET' })]); harness.call.mockClear();
    for (let count = 0; count < 100; count++) emit('message.updated', { sessionID: 's' }, 'global');
    await vi.advanceTimersByTimeAsync(120); expect(requests()).toHaveLength(0);
    for (let count = 0; count < 100; count++) emit('yuri:assistants-changed', { revision: count }, 'global');
    await vi.advanceTimersByTimeAsync(120); expect(requests().map(input => input.path)).toEqual(['/api/yuri/assistants/snapshot']);
  });
  it('sends attachment-only prompts and clears only captured files on success', async () => {
    const state = await import('./state'); await state.loadConnections(); const chat = state.createChat(target); await flush();
    const first = { uri: 'attachment://first', name: 'one.png', mime: 'image/png' };
    const later = { uri: 'attachment://later', name: 'two.pdf', mime: 'application/pdf' };
    chat.attachments.set([first]);
    const admission = deferred<unknown>(), normal = handle;
    handle = (path, method, body) => path.includes('/prompt?') ? admission.promise : normal(path, method, body);
    const sending = chat.send(); await flush();
    const post = requests().find(input => input.path.includes('/prompt?'));
    expect(post.body).toMatchObject({ text: '', files: [{ uri: first.uri, name: first.name }] });
    expect(post.body.files[0]).not.toHaveProperty('mime');
    chat.attachments.set([first, later]);
    admission.resolve({ id: post.body.id, sessionID: 's', type: 'user', payload: { text: '' } }); await sending;
    expect(chat.attachments()).toEqual([later]);
  });
  it('keeps failed files, blocks payload drift, and retries with the same files and ID', async () => {
    const state = await import('./state'); await state.loadConnections(); const chat = state.createChat(target); await flush();
    const file = { uri: 'attachment://first', name: 'one.png', mime: 'image/png' };
    chat.attachments.set([file]); const normal = handle;
    handle = (path, method, body) => path.includes('/prompt?') ? Promise.reject(new Error('ambiguous')) : normal(path, method, body);
    await chat.send(); const pending = chat.pendingSend()!;
    expect(chat.attachments()).toEqual([file]);
    chat.attachments.set([{ ...file, name: 'changed.png' }]); await chat.send();
    expect(requests().filter(input => input.path.includes('/prompt?'))).toHaveLength(1);
    await chat.retrySend();
    const posts = requests().filter(input => input.path.includes('/prompt?'));
    expect(posts).toHaveLength(2); expect(posts[0].body).toEqual(posts[1].body); expect(posts[1].body.id).toBe(pending.id);
    expect(chat.attachments()[0]?.name).toBe('changed.png');
  });
});
