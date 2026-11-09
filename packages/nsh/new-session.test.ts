import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeNewSessionHandoff } from './new-session';
import type { Row } from './model';
import type { NativeLocalCommandInvocation } from './composer-local-commands';

const harness = vi.hoisted(() => ({
  storage: new Map<string, string>(), get: vi.fn(), set: vi.fn(), call: vi.fn(),
  cleanups: [] as Array<() => void>, disposers: [] as Array<() => void>,
}));
vi.mock('nsh', () => ({
  platform: { os: 'ios', desktop: false },
  batch: <T>(work: () => T) => work(), untracked: <T>(work: () => T) => work(),
  signal: <T>(initial: T) => { let value = initial; return Object.assign(() => value, { set: (next: T) => { value = next; } }); },
  Storage: { getItem: harness.get, setItem: harness.set }, lifecycle: () => 'active',
  locale: () => 'en',
  effect: (work: () => void | (() => void)) => { const stop = work(); if (stop) harness.disposers.push(stop); },
  cleanup: (work: () => void) => harness.cleanups.push(work),
  host: { available: () => true, call: harness.call, on: () => () => {} },
}));
const project = { id: 'project', name: 'Project', path: '/repo' };
const file = { uri: 'attachment://note', name: 'note.txt', mime: 'text/plain' };
type Draft = ReturnType<(typeof import('./new-session'))['openNativeNewSession']>;
let stores: Draft[], selected: string, authority: Row, inbox: Row[], handle: (path: string, method: string, body: Row) => unknown;
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const requests = () => harness.call.mock.calls.filter(([name]) => name === 'runtime.request').map(([, input]) => input as { path: string; method: string; body: Row });
const creates = () => requests().filter(input => input.path === '/api/session' && input.method === 'POST');
const prompts = () => requests().filter(input => input.path.includes('/prompt?'));
const receiptEntry = () => [...harness.storage.entries()].find(([key]) => key.startsWith('nsh:new-session:v1:'))!;
const flush = async () => { for (let index = 0; index < 80; index++) await Promise.resolve(); };
async function open(options: Parameters<(typeof import('./new-session'))['openNativeNewSession']>[0] = { project, active: () => true }) {
  const api = await import('./new-session'); const store = api.openNativeNewSession(options); stores.push(store); return store;
}
async function mountChat(handoff: NativeNewSessionHandoff) {
  const state = await import('./state'); const chat = state.createChat(handoff.target); await chat.draftReady; await flush(); return chat;
}
beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers(); stores = []; selected = 'one'; authority = { id: 'created', title: 'New session' }; inbox = [];
  harness.storage.clear(); harness.cleanups = []; harness.disposers = [];
  harness.get.mockReset().mockImplementation(async (key: string) => harness.storage.get(key) ?? null);
  harness.set.mockReset().mockImplementation(async (key: string, value: string) => { harness.storage.set(key, value); });
  handle = (path, method, body) => {
    if (path === '/api/session' && method === 'POST') return { data: { ...authority } };
    if (path.includes('/model?') && method === 'POST') { authority.model = body.model; return null; }
    if (path.includes('/agent?') && method === 'POST') { authority.agent = body.agent; return null; }
    if (path.includes('/prompt?')) { const item = { id: body.id, sessionID: 'created', type: 'user', payload: { text: body.text } }; inbox.push(item); return item; }
    if (path.includes('/message?')) return { data: [] };
    if (path === '/api/session/active') return {};
    if (path.includes('/inbox?')) return inbox;
    if (path.includes('/permission/request?') || path.includes('/form?')) return [];
    if (path.startsWith('/api/session/created?')) return { ...authority };
    if (path === '/api/magic-prompts') return { version: 1, overrides: {} };
    if (path.startsWith('/api/command?')) return [{ name: 'custom' }];
    return null;
  };
  harness.call.mockReset().mockImplementation(async (name, input) => {
    if (name === 'connection.list') return { selected, connections: [{ id: selected, label: 'Host', url: `https://${selected}.example`, lastUsedAt: 0 }], runtimeScope: { hostID: selected, lease: `lease-${selected}` } };
    if (name === 'runtime.request') return { status: 200, body: await handle(input.path, input.method, input.body ?? {}) };
    return true;
  });
  const state = await import('./state'); await state.loadConnections();
});
afterEach(async () => {
  harness.disposers.forEach(stop => stop()); harness.cleanups.forEach(stop => stop());
  await Promise.allSettled(stores.map(store => store.close())); await flush(); vi.useRealTimers();
});

function magicInvocation(draft: Draft): NativeLocalCommandInvocation {
  const selection = draft.selection();
  return { command: 'explore', tail: '', resourcePolicy: 'preserve', current: draft.current, snapshot: {
    scope: draft.durable.scope, authority: 'draft-page', target: { kind: 'draft', id: 'new-session-draft', directory: draft.directory },
    revision: draft.composerRevision(), text: draft.durable.draft(), inputMode: 'normal', active: true, ready: true, pending: false, unknown: false, sending: false, queueEditing: false, hasReferences: !!draft.durable.references().length, hasMessages: false,
    selection: { ...(selection.agent ? { agent: selection.agent } : {}), ...(selection.model ? { model: { providerID: selection.model.providerID, modelID: selection.model.id, variant: selection.model.variant } } : {}) },
  } };
}
describe('local magic new-session admission', () => {
  it('uses existing create/handoff and preserves the source document/resources after actual Chat admission', async () => {
    const draft = await open(); await draft.ready; draft.setDraftText('/explore '); draft.insertReference({ kind: 'skill', value: 'keep', label: 'Keep' }); draft.setAttachments([file]);
    const context = { kind: 'checks' as const, instructionsText: 'keep context', payloadText: '{}' }; draft.durable.context.set(context);
    await draft.select({ agent: 'build', model: { providerID: 'p', id: 'm', variant: 'high' } });
    const document = draft.durable.document(), outcome = await draft.admitLocalMagic({ text: 'compiled only', files: [] }, magicInvocation(draft));
    expect(outcome.status).toBe('accepted'); expect(outcome.handoff).toBeDefined(); expect(creates()).toHaveLength(1); expect(prompts()).toEqual([]);
    expect(draft.durable.pendingSend()?.localMagic).toMatchObject({ resourcePolicy: 'preserve', selection: { agent: 'build', model: { modelID: 'm' } } });
    const chat = await mountChat(outcome.handoff!); expect(chat.draft()).toBe(''); expect(chat.attachments()).toEqual([]); expect(chat.references()).toEqual([]);
    expect(await chat.send()).toBe(false); expect(prompts()).toEqual([]);
    const api = await import('./new-session'); expect(await api.sendNewSessionHandoff(chat, outcome.handoff!)).toBe(true);
    expect(prompts()).toHaveLength(1); expect(prompts()[0].body).toMatchObject({ text: 'compiled only', delivery: 'steer' }); expect(prompts()[0].body.files).toBeUndefined(); expect(prompts()[0].body.skills).toBeUndefined();
    await draft.complete(outcome.handoff!); expect(draft.durable.document()).toEqual(document); expect(draft.durable.attachments()).toEqual([file]); expect(draft.durable.context()).toEqual(context); expect(draft.durable.pendingSend()).toBeNull(); expect(draft.phase()).toBe('draft');
  });
  it('unknown creation persists the preserving marker across restart and never repeats create', async () => {
    const draft = await open(); await draft.ready; draft.setDraftText('/explore'); draft.setAttachments([file]); const normal = handle;
    handle = (path, method, body) => { if (path === '/api/session') throw new Error('lost'); return normal(path, method, body); };
    expect(await draft.admitLocalMagic({ text: 'compiled', files: [] }, magicInvocation(draft))).toEqual({ status: 'unknown' });
    await draft.close(); vi.resetModules(); const state = await import('./state'); await state.loadConnections();
    const next = await open(); await next.ready; expect(next.creationUnknown()).toBe(true); expect(next.durable.pendingSend()?.localMagic?.resourcePolicy).toBe('preserve');
    expect(await next.admitLocalMagic({ text: 'compiled AGAIN', files: [] }, magicInvocation(next))).toEqual({ status: 'rejected' });
    await expect(next.submit()).rejects.toThrow('create-outcome-unknown'); expect(creates()).toHaveLength(1); expect(next.durable.attachments()).toEqual([file]);
  });
  it('rejects text ABA, hidden owner, wrong selection and failed durability before creation', async () => {
    let active = true; const draft = await open({ project, active: () => active }); await draft.ready; draft.setDraftText('/explore');
    const old = magicInvocation(draft); draft.setDraftText('different'); draft.setDraftText('/explore');
    expect(await draft.admitLocalMagic({ text: 'compiled', files: [] }, old)).toEqual({ status: 'rejected' });
    const selected = magicInvocation(draft); await draft.select({ agent: 'plan' }); expect(await draft.admitLocalMagic({ text: 'compiled', files: [] }, selected)).toEqual({ status: 'rejected' });
    active = false; expect(await draft.admitLocalMagic({ text: 'compiled', files: [] }, magicInvocation(draft))).toEqual({ status: 'rejected' }); active = true;
    harness.set.mockRejectedValueOnce(new Error('disk')); expect(await draft.admitLocalMagic({ text: 'compiled', files: [] }, magicInvocation(draft))).toEqual({ status: 'rejected' });
    expect(creates()).toEqual([]); expect(draft.durable.draft()).toBe('/explore'); expect(draft.durable.pendingSend()).toBeNull();
  });
  it('an unknown target prompt cannot be replayed through ordinary send or handoff after reopen', async () => {
    const draft = await open(); await draft.ready; draft.setDraftText('/explore');
    const outcome = await draft.admitLocalMagic({ text: 'compiled', files: [] }, magicInvocation(draft)), chat = await mountChat(outcome.handoff!);
    const normal = handle; handle = (path, method, body) => { if (path.includes('/prompt?')) throw new Error('lost'); return normal(path, method, body); };
    const api = await import('./new-session'); expect(await api.sendNewSessionHandoff(chat, outcome.handoff!)).toBe(false); await chat.flushDraft(); await draft.close();
    harness.disposers.forEach(stop => stop()); harness.cleanups.forEach(stop => stop()); harness.disposers = []; harness.cleanups = []; await flush();
    vi.resetModules(); const state = await import('./state'); await state.loadConnections(); const next = await open(); await next.ready; const restored = (await next.submit())!, nextChat = await mountChat(restored);
    const nextAPI = await import('./new-session'); expect(await nextAPI.sendNewSessionHandoff(nextChat, restored)).toBe(false); await nextChat.retrySend();
    expect(creates()).toHaveLength(1); expect(prompts()).toHaveLength(1); expect(next.durable.draft()).toBe('/explore');
  });
  it('definitive creation rejection resets the same receipt while preserving source resources', async () => {
    const draft = await open(); await draft.ready; draft.setDraftText('/explore'); draft.setAttachments([file]); const normal = handle;
    handle = (path, method, body) => { if (path === '/api/session') throw Object.assign(new Error('private validation details'), { status: 400 }); return normal(path, method, body); };
    expect(await draft.admitLocalMagic({ text: 'compiled', files: [] }, magicInvocation(draft))).toEqual({ status: 'rejected' });
    expect(draft.phase()).toBe('draft'); expect(draft.durable.pendingSend()).toBeNull(); expect(draft.error()).not.toContain('private validation');
    expect(draft.durable.draft()).toBe('/explore'); expect(draft.durable.attachments()).toEqual([file]); expect(creates()).toHaveLength(1);
  });
});

describe('native new-session durable draft and handoff', () => {
  const deviceChatPreferences = () => ({ allowPromptingSubagentSessions: false, persistChatDraft: false });
  it('disabled ordinary persistence preserves created receipt, frozen sidecars and actual Chat handoff after reopening', async () => {
    const draft = await open({ project, active: () => true, deviceChatPreferences }); await draft.ready;
    draft.setDraftText('Read '); draft.insertReference({ kind: 'file', value: 'a.ts', label: 'a.ts', scope: draft.durable.scope }); draft.setAttachments([file]);
    const normal = harness.set.getMockImplementation()!;
    harness.set.mockImplementation(async (key: string, value: string) => {
      if (key.startsWith('nsh:new-session:') && JSON.parse(value).phase === 'installed') throw new Error('installed receipt quota');
      return normal(key, value);
    });
    await expect(draft.submit()).rejects.toThrow('installed receipt quota'); expect(creates()).toHaveLength(1);
    const frozenID = draft.inputID(); await draft.close(); harness.set.mockImplementation(normal);
    const reopened = await open({ project, active: () => true, deviceChatPreferences }); await reopened.ready;
    expect(reopened.durable.draft()).toBe(''); expect(reopened.durable.pendingSend()?.id).toBe(frozenID); expect(reopened.phase()).toBe('created');
    const handoff = (await reopened.submit())!; expect(creates()).toHaveLength(1);
    const state = await import('./state'); const chat = state.createChat(handoff.target, { deviceChatPreferences }); await chat.draftReady; await flush();
    expect(chat.draft()).toBe(''); expect(chat.pendingSend()?.references?.references).toHaveLength(1);
    const { sendNewSessionHandoff } = await import('./new-session'); expect(await sendNewSessionHandoff(chat, handoff)).toBe(true);
    expect(prompts()).toHaveLength(1); expect(prompts()[0].body.text).toContain('Read'); await reopened.complete(handoff);
  });
  it('a pending frozen submission before creating receipt still resumes when ordinary draft restore is disabled', async () => {
    const first = await open({ project, active: () => true, deviceChatPreferences }); await first.ready; first.setDraftText('Frozen create intent');
    const normal = harness.set.getMockImplementation()!;
    harness.set.mockImplementation(async (key: string, value: string) => {
      if (key.startsWith('nsh:new-session:') && JSON.parse(value).phase === 'creating') throw new Error('creating quota');
      return normal(key, value);
    });
    await expect(first.submit()).rejects.toThrow('creating quota'); expect(creates()).toHaveLength(0); const frozenID = first.inputID(); await first.close();
    harness.set.mockImplementation(normal); const second = await open({ project, active: () => true, deviceChatPreferences }); await second.ready;
    expect(second.durable.draft()).toBe(''); expect(second.inputID()).toBe(frozenID);
    const handoff = await second.submit(); expect(handoff?.inputID).toBe(frozenID); expect(creates()).toHaveLength(1);
  });
  it('the own UI fixture bridge supports real create/unknown recovery/config/Chat admission without running an engine', async () => {
    const fake = (await import('./tests/new-session-host.js')).createHost();
    harness.call.mockImplementation(async (name, input) => fake.call(name, input));
    await (await import('./state')).loadConnections();
    fake.call('runtime.request', { path: '/__fixture/new-session/lose-create', method: 'GET' });
    const draft = await open(); await draft.ready; draft.setDraftText('fixture pipeline'); await draft.select({ agent: 'plan', model: { providerID: 'fixture', id: 'gpt-model', variant: 'high' } });
    await expect(draft.submit()).rejects.toThrow('lost session creation response'); await draft.recoverCreatedSession('ses_draft_1');
    const token = (await draft.submit())!, chat = await mountChat(token), { sendNewSessionHandoff } = await import('./new-session');
    expect(await sendNewSessionHandoff(chat, token)).toBe(true); await draft.complete(token);
    const stats = fake.call('runtime.request', { path: '/__fixture/new-session/stats', method: 'GET' }); expect(stats.body.creates).toBe(1); expect(stats.body.prompts).toHaveLength(1);
  });
  it('opening, 200 edits and local configuration have zero runtime requests and coalesced text writes', async () => {
    const draft = await open(); await draft.ready; harness.get.mockClear(); harness.set.mockClear();
    let catalogReads = 0;
    const guarded = <T>(rows: T[]) => new Proxy(rows, { get(array, key, receiver) { if (key === Symbol.iterator || typeof key === 'string' && /^\d+$/.test(key)) catalogReads++; return Reflect.get(array, key, receiver); } });
    const state = await import('./state');
    state.app.projects.set(guarded(Array.from({ length: 300 }, (_, index) => ({ id: `p${index}`, name: `P${index}`, path: `/p${index}` }))));
    state.app.sessions.set(guarded(Array.from({ length: 300 }, (_, index) => ({ id: `s${index}`, title: `S${index}`, directory: '/repo', updated: index }))));
    for (let index = 0; index < 200; index++) draft.setDraftText(`input ${index}`);
    expect(harness.get).not.toHaveBeenCalled(); expect(harness.set).not.toHaveBeenCalled(); expect(requests()).toEqual([]);
    expect(catalogReads).toBe(0);
    await vi.advanceTimersByTimeAsync(300); await draft.durable.flush();
    expect(harness.set).toHaveBeenCalledTimes(1);
    await draft.select({ model: { providerID: 'provider', id: 'model', variant: 'high' }, agent: 'build' });
    expect(requests()).toEqual([]); expect(draft.phase()).toBe('draft');
  });
  it('reopens Host/directory draft text, attachments, sidecars and local model/Agent/variant', async () => {
    const first = await open(); await first.ready;
    first.setDraftText('Read '); first.insertReference({ kind: 'file', value: 'a.ts', label: 'a.ts', scope: first.durable.scope }); first.durable.attachments.set([file]);
    await first.select({ agent: 'build', model: { providerID: 'p', id: 'm', variant: '' } }); await first.close();
    const second = await open(); await second.ready;
    expect(second.durable.draft()).toBe('Read @a.ts '); expect(second.durable.references()).toHaveLength(1); expect(second.durable.attachments()).toEqual([file]);
    expect(second.selection()).toEqual({ agent: 'build', model: { providerID: 'p', id: 'm', variant: '' } });
    const other = await open({ directory: '/other', active: () => true }); await other.ready; expect(other.durable.draft()).toBe('');
    selected = 'two'; const state = await import('./state'); await state.loadConnections();
    const host = await open(); await host.ready; expect(host.durable.draft()).toBe(''); expect(host.selection()).toEqual({}); expect(creates()).toEqual([]);
  });
  it('empty or unbound drafts cannot create a session', async () => {
    const draft = await open(); await draft.ready; expect(await draft.submit()).toBeNull();
    const unbound = await open({ active: () => true }); await unbound.ready; unbound.setDraftText('text');
    await expect(unbound.submit()).rejects.toThrow('directory-required'); expect(creates()).toEqual([]);
  });
  it('an explicit worktree directory wins over project.path and attachment-only drafts can send', async () => {
    const draft = await open({ project, directory: '/repo/worktree', active: () => true }); await draft.ready; draft.setAttachments([file]);
    const token = (await draft.submit())!; expect(token.target.directory).toBe('/repo/worktree');
    expect(creates()[0]?.body).toEqual({ location: { directory: '/repo/worktree' } });
    const chat = await mountChat(token), { sendNewSessionHandoff } = await import('./new-session'); expect(await sendNewSessionHandoff(chat, token)).toBe(true);
    expect(prompts()[0]?.path).toContain('directory=%2Frepo%2Fworktree'); expect(prompts()[0]?.body.files).toEqual([{ uri: file.uri, name: file.name }]);
  });
  it('invalid attachment bodies fail persistence before any session creation', async () => {
    const draft = await open(); await draft.ready; draft.setAttachments([{ ...file, uri: 'data:text/plain;base64,YQ==' }]);
    await expect(draft.submit()).rejects.toThrow(); expect(creates()).toEqual([]); expect(draft.durable.attachments()[0]?.uri).toContain('data:');
  });
  it('first submit is single-flight, creates only once, stages full data and delegates admission to real createChat', async () => {
    const draft = await open(); await draft.ready;
    draft.setDraftText('Read '); draft.insertReference({ kind: 'file', value: 'src/a.ts', label: 'src/a.ts', scope: draft.durable.scope });
    draft.insertReference({ kind: 'agent', value: 'explore', label: 'explore' }); draft.insertReference({ kind: 'skill', value: 'review', label: 'Review' }); draft.durable.attachments.set([file]);
    await draft.select({ agent: 'build', model: { providerID: 'p', id: 'm', variant: 'high' } });
    const first = draft.submit(); expect(draft.submit()).toBe(first); const token = (await first)!;
    expect(creates()).toHaveLength(1); expect(creates()[0]?.body).toEqual({ location: { directory: '/repo' } }); expect(prompts()).toEqual([]);
    const chat = await mountChat(token);
    expect(chat.pendingSend()?.id).toBe(token.inputID); expect(chat.references()).toHaveLength(3); expect(chat.attachments()).toEqual([file]);
    expect(chat.referenceDocument().scope).toEqual(chat.referenceScope); expect(chat.pendingSend()?.references?.scope).toEqual(chat.referenceScope);
    const { sendNewSessionHandoff } = await import('./new-session'); expect(await sendNewSessionHandoff(chat, token)).toBe(true);
    expect(prompts()).toHaveLength(1); expect(prompts()[0]?.body).toMatchObject({ id: token.inputID, delivery: 'steer', agents: [{ name: 'explore' }], skills: [{ id: 'review' }] });
    expect(prompts()[0]?.body.files).toContainEqual({ uri: file.uri, name: file.name });
    expect(prompts()[0]?.body.files).toContainEqual({ uri: 'file:///repo/src/a.ts', name: 'a.ts' });
    expect(await sendNewSessionHandoff(chat, token)).toBe(true); expect(prompts()).toHaveLength(1);
    await draft.complete(token); expect(draft.phase()).toBe('draft'); expect(draft.durable.draft()).toBe('');
  });
  it('configuration failure resumes the same created session using the frozen snapshot', async () => {
    const draft = await open(); await draft.ready; draft.setDraftText('text'); await draft.select({ agent: 'build' });
    const original = handle; let fail = true;
    handle = (path, method, body) => { if (path.includes('/agent?') && fail) throw new Error('offline'); return original(path, method, body); };
    await expect(draft.submit()).rejects.toThrow('offline'); expect(draft.phase()).toBe('created');
    await expect(draft.select({ agent: 'plan' })).rejects.toThrow('selection-frozen');
    draft.setDraftText('later edit'); fail = false;
    await expect(draft.submit()).rejects.toThrow('selection-not-confirmed');
    expect(requests().filter(input => input.path.includes('/agent?') && input.method === 'POST')).toHaveLength(1);
    authority.agent = 'build';
    const token = (await draft.submit())!; expect(creates()).toHaveLength(1);
    const chat = await mountChat(token); expect(chat.draft()).toBe('text'); expect(authority.agent).toBe('build');
    const { sendNewSessionHandoff } = await import('./new-session'); expect(await sendNewSessionHandoff(chat, token)).toBe(true);
    await draft.complete(token); expect(draft.durable.draft()).toBe('later edit');
  });
  it('a completed configuration POST is not accepted without matching authority', async () => {
    const draft = await open(); await draft.ready; draft.setDraftText('text'); await draft.select({ agent: 'build' });
    const original = handle; handle = (path, method, body) => path.includes('/agent?') ? null : original(path, method, body);
    await expect(draft.submit()).rejects.toThrow('selection-not-confirmed'); expect(draft.phase()).toBe('created'); expect(prompts()).toEqual([]);
    handle = original; await expect(draft.submit()).rejects.toThrow('selection-not-confirmed');
    expect(requests().filter(input => input.path.includes('/agent?') && input.method === 'POST')).toHaveLength(1);
    authority.agent = 'build'; expect((await draft.submit())?.target.id).toBe('created'); expect(creates()).toHaveLength(1);
  });
  it('explicit default variant remains local intent but follows ChatModels wire omission', async () => {
    const draft = await open(); await draft.ready; draft.setDraftText('text'); await draft.select({ model: { providerID: 'p', id: 'm', variant: '' } }); await draft.submit();
    expect(draft.selection().model?.variant).toBe(''); expect(requests().find(input => input.path.includes('/model?'))?.body).toEqual({ model: { providerID: 'p', id: 'm' } });
  });
  it('unknown session creation stays blocked across reopen rather than issuing another POST', async () => {
    const draft = await open(); await draft.ready; draft.setDraftText('text');
    const original = handle; handle = (path, method, body) => { if (path === '/api/session') throw new Error('lost response'); return original(path, method, body); };
    await expect(draft.submit()).rejects.toThrow('lost response'); expect(draft.phase()).toBe('creating');
    await expect(draft.submit()).rejects.toThrow('create-outcome-unknown'); await draft.close();
    const reopened = await open(); await reopened.ready; await expect(reopened.submit()).rejects.toThrow('create-outcome-unknown');
    expect(creates()).toHaveLength(1); expect(reopened.durable.draft()).toBe('text'); expect(reopened.durable.pendingSend()?.id).toBe(draft.durable.pendingSend()?.id);
  });
  it('explicit recovery binds only an authoritative empty idle session in the same directory', async () => {
    const draft = await open(); await draft.ready; draft.setDraftText('text'); const original = handle;
    handle = (path, method, body) => { if (path === '/api/session') throw new Error('lost'); return original(path, method, body); };
    await expect(draft.submit()).rejects.toThrow('lost'); const inputID = draft.inputID();
    handle = original; authority.location = { directory: '/wrong' };
    await expect(draft.recoverCreatedSession('created')).rejects.toThrow('directory-mismatch'); expect(draft.creationUnknown()).toBe(true);
    authority.location = { directory: '/repo' }; inbox.push({ id: 'other', sessionID: 'created' });
    await expect(draft.recoverCreatedSession('created')).rejects.toThrow('not-empty'); expect(draft.inputID()).toBe(inputID);
    inbox = []; await draft.recoverCreatedSession('created'); expect(draft.phase()).toBe('created');
    const token = (await draft.submit())!; expect(token.inputID).toBe(inputID); expect(creates()).toHaveLength(1);
    const chat = await mountChat(token), { sendNewSessionHandoff } = await import('./new-session'); expect(await sendNewSessionHandoff(chat, token)).toBe(true);
  });
  it('Host switch during recovery never adopts the old Host candidate', async () => {
    const draft = await open(); await draft.ready; draft.setDraftText('text'); const original = handle;
    handle = (path, method, body) => { if (path === '/api/session') throw new Error('lost'); return original(path, method, body); };
    await expect(draft.submit()).rejects.toThrow('lost'); authority.location = { directory: '/repo' };
    const gate = deferred<unknown>(); handle = (path, method, body) => path.startsWith('/api/session/created?') ? gate.promise : original(path, method, body);
    const recovery = draft.recoverCreatedSession('created'); await flush(); selected = 'two'; const state = await import('./state'); await state.loadConnections(); gate.resolve({ ...authority });
    await expect(recovery).rejects.toThrow('scope-changed'); expect(draft.phase()).toBe('creating'); expect(creates()).toHaveLength(1);
  });
  it('transferred owner survives page unmount, confirms admission and releases explicitly once', async () => {
    const api = await import('./new-session'), page = api.createNativeNewSessionOwnership({ project, active: () => true }); stores.push(page.owner); await page.owner.ready;
    page.owner.setDraftText('handoff'); const receipt = (await page.owner.submit())!, transfer = page.transfer(receipt);
    expect(page.owner.current()).toBe(false); await page.disposePage(); expect(transfer.released()).toBe(false);
    const chat = await mountChat(receipt); expect(await api.sendNewSessionHandoff(chat, receipt)).toBe(true);
    await transfer.owner.complete(receipt); expect(transfer.owner.phase()).toBe('draft');
    const released = transfer.release(); expect(transfer.release()).toBe(released); await released; expect(transfer.released()).toBe(true);
  });
  it('page-only cleanup saves unsent drafts; releasing failed transfer preserves its installed receipt', async () => {
    const api = await import('./new-session'), page = api.createNativeNewSessionOwnership({ project, active: () => true }); stores.push(page.owner); await page.owner.ready; page.owner.setDraftText('text'); await page.disposePage();
    const next = api.createNativeNewSessionOwnership({ project, active: () => true }); stores.push(next.owner); await next.owner.ready; expect(next.owner.durable.draft()).toBe('text');
    const receipt = (await next.owner.submit())!, transfer = next.transfer(receipt); await next.disposePage(); await transfer.release();
    const reopened = await open(); await reopened.ready; const restored = (await reopened.submit())!;
    expect(restored.inputID).toBe(receipt.inputID); expect(creates()).toHaveLength(1);
  });
  it('a known create response survives a receipt-write failure in memory and retries only local handoff', async () => {
    const draft = await open(); await draft.ready; draft.setDraftText('text');
    const persist = harness.set.getMockImplementation()!; let fail = true;
    harness.set.mockImplementation(async (key: string, raw: string) => { if (key.startsWith('nsh:new-session:') && JSON.parse(raw).phase === 'created' && fail) throw new Error('disk'); return persist(key, raw); });
    await expect(draft.submit()).rejects.toThrow('disk'); expect(draft.phase()).toBe('creating'); fail = false;
    expect((await draft.submit())?.target.id).toBe('created'); expect(creates()).toHaveLength(1);
  });
  it('a later failed create never reuses the preceding completed session target', async () => {
    const draft = await open(); await draft.ready; draft.setDraftText('first'); const token = (await draft.submit())!;
    const chat = await mountChat(token), { sendNewSessionHandoff } = await import('./new-session'); expect(await sendNewSessionHandoff(chat, token)).toBe(true); await draft.complete(token);
    draft.setDraftText('second'); const original = handle;
    handle = (path, method, body) => { if (path === '/api/session') throw new Error('lost second create'); return original(path, method, body); };
    await expect(draft.submit()).rejects.toThrow('lost second create'); await expect(draft.submit()).rejects.toThrow('create-outcome-unknown');
    expect(creates()).toHaveLength(2); expect(prompts()).toHaveLength(1); expect(draft.target()).toBeNull(); expect(draft.durable.draft()).toBe('second');
  });
  it('Host switch during create never configures or hands old scope to the new Host', async () => {
    const draft = await open(); await draft.ready; draft.setDraftText('text'); await draft.select({ agent: 'build' });
    const gate = deferred<unknown>(), original = handle; handle = (path, method, body) => path === '/api/session' ? gate.promise : original(path, method, body);
    const flight = draft.submit(); await flush(); expect(creates()).toHaveLength(1);
    selected = 'two'; const state = await import('./state'); await state.loadConnections(); gate.resolve({ id: 'created' });
    await expect(flight).rejects.toThrow('scope-changed');
    expect(requests().some(input => input.path.includes('/agent?'))).toBe(false); expect(prompts()).toEqual([]); expect(draft.setDraftText('wrong Host')).toBe(false);
    selected = 'one'; await state.loadConnections(); const reopened = await open(); await reopened.ready;
    await expect(reopened.submit()).rejects.toThrow('create-outcome-unknown'); expect(creates()).toHaveLength(1);
  });
  it('page hiding during create preserves the known target without applying config', async () => {
    let active = true; const draft = await open({ project, active: () => active }); await draft.ready; draft.setDraftText('text');
    const gate = deferred<unknown>(), original = handle; handle = (path, method, body) => path === '/api/session' ? gate.promise : original(path, method, body);
    const flight = draft.submit(); await flush(); active = false; gate.resolve({ id: 'created' });
    await expect(flight).rejects.toThrow('scope-changed'); expect(draft.phase()).toBe('created');
    active = true; expect((await draft.submit())?.target.id).toBe('created'); expect(creates()).toHaveLength(1);
  });
  it('unknown prompt sends retry the same message ID, sidecars and files, never another create', async () => {
    const draft = await open(); await draft.ready; draft.setDraftText('Read '); draft.insertReference({ kind: 'skill', value: 'review', label: 'Review' }); draft.durable.attachments.set([file]);
    const token = (await draft.submit())!, chat = await mountChat(token), original = handle; let fail = true;
    handle = (path, method, body) => { if (path.includes('/prompt?') && fail) throw new Error('lost'); return original(path, method, body); };
    const { sendNewSessionHandoff } = await import('./new-session'); expect(await sendNewSessionHandoff(chat, token)).toBe(false);
    expect(chat.pendingSend()).toMatchObject({ id: token.inputID, uncertain: true });
    chat.setDraftText('later chat edit'); fail = false; expect(await sendNewSessionHandoff(chat, token)).toBe(false);
    expect(prompts()).toHaveLength(1); expect(chat.pendingSend()).toMatchObject({ id: token.inputID, uncertain: true });
    expect(chat.pendingSend()?.files).toEqual([file]); expect(chat.pendingSend()?.references?.references).toHaveLength(1);
    inbox.push({ id: token.inputID, sessionID: token.target.id });
    expect(await sendNewSessionHandoff(chat, token)).toBe(true);
    expect(prompts()).toHaveLength(1); expect(creates()).toHaveLength(1); expect(chat.draft()).toBe('later chat edit');
  });
  it('installed handoff survives process/module restart without restaging a consumed command', async () => {
    const draft = await open(); await draft.ready; draft.setDraftText('/custom args'); const token = (await draft.submit())!;
    const chat = await mountChat(token), api = await import('./new-session'); expect(await api.sendNewSessionHandoff(chat, token)).toBe(true);
    expect(requests().filter(input => input.path.includes('/command?') && input.method === 'POST')).toHaveLength(1);
    await draft.close(); harness.disposers.forEach(stop => stop()); harness.cleanups.forEach(stop => stop()); harness.cleanups = []; harness.disposers = [];
    await flush(); vi.resetModules(); const state = await import('./state'); await state.loadConnections();
    const reopened = await open(); await reopened.ready; const resumed = (await reopened.submit())!;
    const nextChat = await mountChat(resumed); const next = await import('./new-session'); expect(await next.sendNewSessionHandoff(nextChat, resumed)).toBe(false);
    expect(creates()).toHaveLength(1); expect(requests().filter(input => input.path.includes('/command?') && input.method === 'POST')).toHaveLength(1);
  });
  it('source cleanup interrupted after admission is resumed by exact authority, not a missing-pending guess', async () => {
    const draft = await open(); await draft.ready; draft.setDraftText('accepted before source cleanup'); const token = (await draft.submit())!;
    const chat = await mountChat(token), api = await import('./new-session'); expect(await api.sendNewSessionHandoff(chat, token)).toBe(true); await draft.close();
    const reopened = await open(); await reopened.ready; const resumed = (await reopened.submit())!, nextChat = await mountChat(resumed);
    expect(nextChat.pendingSend()).toBeNull(); expect(await api.sendNewSessionHandoff(nextChat, resumed)).toBe(true); await reopened.complete(resumed);
    expect(reopened.phase()).toBe('draft'); expect(prompts()).toHaveLength(1); expect(creates()).toHaveLength(1);
  });
  it('a failed installed-receipt write resumes the existing staged destination without data loss', async () => {
    const draft = await open(); await draft.ready; draft.setDraftText('text');
    const persist = harness.set.getMockImplementation()!; let fail = true;
    harness.set.mockImplementation(async (key: string, raw: string) => { if (key.startsWith('nsh:new-session:') && JSON.parse(raw).phase === 'installed' && fail) throw new Error('disk'); return persist(key, raw); });
    await expect(draft.submit()).rejects.toThrow('disk'); expect(draft.phase()).toBe('created');
    const inputID = draft.durable.pendingSend()?.id; fail = false; const token = (await draft.submit())!;
    expect(token.inputID).toBe(inputID); expect(creates()).toHaveLength(1); const chat = await mountChat(token); expect(chat.draft()).toBe('text');
  });
  it('failed write-ahead storage prevents POST session and keeps current draft', async () => {
    const draft = await open(); await draft.ready; draft.setDraftText('text'); const persist = harness.set.getMockImplementation()!;
    harness.set.mockImplementation(async (key: string, raw: string) => { if (key.startsWith('nsh:new-session:')) throw new Error('disk'); return persist(key, raw); });
    await expect(draft.submit()).rejects.toThrow('disk'); expect(creates()).toEqual([]); expect(draft.durable.draft()).toBe('text');
  });
  it('does not overwrite an unrelated persisted destination draft', async () => {
    const { openDraft } = await import('./drafts'), destination = openDraft('one', { kind: 'session', id: 'created', title: 'New session', directory: '/repo' });
    await destination.ready; destination.setDraftText('unrelated input'); await destination.close();
    const draft = await open(); await draft.ready; draft.setDraftText('new input');
    await expect(draft.submit()).rejects.toThrow('destination-not-empty'); expect(draft.phase()).toBe('created');
    const saved = JSON.parse(harness.storage.get(destination.key)!); expect(saved.draft).toBe('unrelated input'); expect(saved.pendingSend).toBeNull();
  });
  it('handoff rejects a different Chat scope and late Host tokens before sending', async () => {
    const draft = await open(); await draft.ready; draft.setDraftText('text'); const token = (await draft.submit())!;
    const state = await import('./state'), other = state.createChat({ ...token.target, id: 'other' }); await other.draftReady;
    const { sendNewSessionHandoff } = await import('./new-session'); await expect(sendNewSessionHandoff(other, token)).rejects.toThrow('scope-mismatch');
    selected = 'two'; await state.loadConnections(); expect(await sendNewSessionHandoff(other, token)).toBe(false); expect(prompts()).toEqual([]);
  });
  it('malformed receipt is not overwritten; explicit storage recovery can later submit', async () => {
    const first = await open(); await first.ready; await first.select({ agent: 'build' }); await first.close();
    const [key] = receiptEntry(); harness.storage.set(key, '{broken');
    const draft = await open(); await expect(draft.ready).rejects.toThrow(); draft.setDraftText('new input');
    await expect(draft.submit()).rejects.toThrow(); expect(harness.storage.get(key)).toBe('{broken'); expect(creates()).toEqual([]);
    harness.storage.delete(key); await draft.retryStorage(); expect((await draft.submit())?.target.id).toBe('created');
  });
  it('a newer page retires the previous draft owner and blocks duplicate plus/create', async () => {
    const first = await open(); await first.ready; first.setDraftText('text'); const next = await open(); await next.ready;
    await expect(first.submit()).rejects.toThrow('scope-changed'); expect(first.setDraftText('stale')).toBe(false);
    expect((await next.submit())?.target.id).toBe('created'); expect(creates()).toHaveLength(1);
  });
  it('native Host selection fences submit before the public generation changes', async () => {
    const draft = await open(); await draft.ready; draft.setDraftText('text');
    const state = await import('./state'), select = deferred<unknown>(), call = harness.call.getMockImplementation()!;
    harness.call.mockImplementation((name: string, input: Row) => name === 'connection.select' ? select.promise : call(name, input));
    const switchFlight = state.switchConnection('two');
    await expect(draft.submit()).rejects.toThrow('scope-changed'); expect(creates()).toEqual([]); expect(draft.setAttachments([file])).toBe(false);
    selected = 'two'; select.resolve(true); await switchFlight.catch(() => {});
  });
  it('completion while the draft page is hidden preserves retyped text and newly added attachments', async () => {
    let active = true; const draft = await open({ project, active: () => active }); await draft.ready;
    draft.setDraftText('same text'); draft.setAttachments([file]); const token = (await draft.submit())!;
    draft.setDraftText('changed'); draft.setDraftText('same text'); const added = { ...file, uri: 'attachment://new' }; draft.setAttachments([file, added]);
    const chat = await mountChat(token), { sendNewSessionHandoff } = await import('./new-session'); expect(await sendNewSessionHandoff(chat, token)).toBe(true);
    active = false; await draft.complete(token); expect(draft.durable.draft()).toBe('same text'); expect(draft.durable.attachments()).toEqual([added]);
  });
  it('normal magic commands retain the native compiler path, not the command endpoint', async () => {
    const draft = await open(); await draft.ready; draft.setDraftText('/summary bugs'); const token = (await draft.submit())!, chat = await mountChat(token);
    const { sendNewSessionHandoff } = await import('./new-session'); expect(await sendNewSessionHandoff(chat, token)).toBe(true);
    expect(prompts()[0]?.body.text).not.toBe('/summary bugs'); expect(requests().filter(input => input.path === '/api/magic-prompts')).toHaveLength(1);
    expect(requests().some(input => input.path.includes('/command?') && input.method === 'POST')).toBe(false);
  });
  it('shell rejects sidecars before create and preserves unknown command non-replay semantics', async () => {
    const draft = await open(); await draft.ready; draft.setDraftText('run '); draft.insertReference({ kind: 'file', value: 'a.ts', label: 'a.ts' });
    await expect(draft.submit({ inputMode: 'shell' })).rejects.toThrow('shell-references-unsupported'); expect(creates()).toEqual([]);
    draft.setDraftText('pwd'); const token = (await draft.submit({ inputMode: 'shell' }))!, chat = await mountChat(token), original = handle;
    handle = (path, method, body) => { if (path.includes('/shell?')) throw new Error('unknown'); return original(path, method, body); };
    const { sendNewSessionHandoff } = await import('./new-session'); expect(await sendNewSessionHandoff(chat, token)).toBe(false); expect(await sendNewSessionHandoff(chat, token)).toBe(false);
    expect(requests().filter(input => input.path.includes('/shell?'))).toHaveLength(1);
  });
});
