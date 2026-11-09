import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopGitAgentRequest, DesktopGitContextInput } from './desktop-git-dispatch';
import type { Row } from './model';

const h = vi.hoisted(() => ({ storage: new Map<string, string>(), get: vi.fn(), set: vi.fn(), call: vi.fn(),
  cleanups: [] as Array<() => void>, disposers: [] as Array<() => void> }));
vi.mock('nsh', () => ({
  batch: <T>(work: () => T) => work(), untracked: <T>(work: () => T) => work(),
  signal: <T>(initial: T) => { let value = initial; return Object.assign(() => value, { set: (next: T) => { value = next; } }); },
  Storage: { getItem: h.get, setItem: h.set }, lifecycle: () => 'active',
  effect: (work: () => void | (() => void)) => { const stop = work(); if (stop) h.disposers.push(stop); },
  cleanup: (work: () => void) => h.cleanups.push(work),
  host: { available: () => true, call: h.call, on: () => () => {} },
}));
const target = { kind: 'session' as const, id: 's', directory: '/repo', title: 'Session' };
const connection = { id: 'host', url: 'https://host.example', authorizationID: 'auth-a', label: 'Host', lastUsedAt: 0 };
const file = { uri: 'attachment://note', name: 'note.txt', mime: 'text/plain' };
type Draft = ReturnType<(typeof import('./drafts'))['openDraft']>;
type NewOwner = ReturnType<(typeof import('./new-session'))['openNativeNewSession']>;
let drafts: Draft[], owners: NewOwner[], handle: (path: string, method: string, body: Row) => unknown;
let authorityKey: string, received: Row[];
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 90; i++) await Promise.resolve(); };
const requests = () => h.call.mock.calls.filter(([name]) => name === 'runtime.request').map(([, value]) => value as { path: string; method: string; body: Row });
const prompts = () => requests().filter(row => row.path.includes('/prompt?'));
async function input(changes: Partial<DesktopGitAgentRequest> = {}): Promise<DesktopGitContextInput> {
  const { desktopGitContextInput } = await import('./desktop-git-dispatch');
  return desktopGitContextInput({ scope: { host: { hostID: 'host', lease: 'lease-a' }, authorityKey, directory: '/repo', sessionID: 's' },
    directory: '/repo', target: 'current', kind: 'conflict', visibleText: 'Resolve conflict', instructionsText: 'Use the captured conflict, not a different workspace.', payload: { diff: 'original diff', files: ['a.ts'] }, ...changes });
}
async function openDraft(key = authorityKey, chat = target) { const api = await import('./drafts'); const draft = api.openDraft('host', chat, key); drafts.push(draft); await draft.ready; return draft; }
async function chat() { const state = await import('./state'); const value = state.createChat(target, { draftAuthorityKey: authorityKey }); await value.draftReady; await flush(); return value; }
async function newOwner() { const api = await import('./new-session'); const owner = api.openNativeNewSession({ directory: '/repo', active: () => true, draftAuthorityKey: authorityKey }); owners.push(owner); await owner.ready; return owner; }
beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers(); h.storage.clear(); h.cleanups = []; h.disposers = []; drafts = []; owners = []; received = [];
  h.get.mockReset().mockImplementation(async (key: string) => h.storage.get(key) ?? null);
  h.set.mockReset().mockImplementation(async (key: string, value: string) => { h.storage.set(key, value); });
  handle = (path, method, body) => {
    if (path === '/api/session' && method === 'POST') return { id: 's', title: 'Created' };
    if (path.includes('/prompt?')) { const receipt = { id: body.id, sessionID: 's', type: 'user', payload: { text: body.text } }; received.push(receipt); return receipt; }
    if (path.includes('/message?')) return { data: [] };
    if (path.includes('/message/')) throw Object.assign(new Error('not found'), { status: 404 });
    if (path.includes('/inbox?')) return received;
    if (path === '/api/session/active') return {};
    if (path.includes('/permission/request?') || path.includes('/form?')) return [];
    if (path.startsWith('/api/session/s?')) return { id: 's' };
    if (path === '/api/magic-prompts') return { version: 1, overrides: {} };
    return null;
  };
  h.call.mockReset().mockImplementation(async (name, args) => {
    if (name === 'connection.list') return { connections: [connection], selected: 'host', runtimeScope: { hostID: 'host', lease: 'lease-a' } };
    if (name === 'runtime.request') return { status: 200, body: await handle(args.path, args.method, args.body ?? {}) };
    return true;
  });
  const core = await import('./desktop-git-dispatch'); authorityKey = core.desktopGitDraftAuthority(connection);
  const state = await import('./state'); await state.loadConnections();
});
afterEach(async () => { h.disposers.forEach(stop => stop()); h.cleanups.forEach(stop => stop()); await Promise.allSettled([...drafts, ...owners].map(owner => owner.close())); await flush(); vi.useRealTimers(); });

describe('desktop Git captured synthetic draft boundary', () => {
  it('captures unknown payload immediately, separates visible text, and preserves compiled sidecars', async () => {
    const api = await import('./desktop-git-dispatch'); const payload = { nested: [{ diff: 'captured' }] };
    const context = await input({ payload }); payload.nested[0]!.diff = 'later';
    expect(context.context.payloadText).toContain('captured'); expect(context.context.payloadText).not.toContain('later');
    const compiled = { text: 'authored', files: [{ uri: file.uri }], agents: [{ name: 'build' }], skills: [{ id: 'review' }], metadata: { retained: true } };
    const wire = api.compileDesktopGitContext(compiled, context.context);
    expect(wire.text).toBe(`authored\n${context.context.instructionsText}\n${context.context.payloadText}`);
    expect(wire.files).toBe(compiled.files); expect(wire.agents).toBe(compiled.agents); expect(wire.skills).toBe(compiled.skills); expect(wire.metadata).toBe(compiled.metadata);
    await expect(input({ payload: { accessToken: 'never-store' } })).rejects.toThrow('credentials');
    await expect(input({ payload: undefined })).rejects.toThrow('payload');
  });
  it('stages without creating/sending, and typing 200 times performs no synchronous Storage or runtime work', async () => {
    const owner = await newOwner(); const value = await input({ target: 'new' });
    expect(await owner.stageContext(value)).toEqual({ status: 'staged' });
    expect(owner.durable.draft()).toBe(value.visibleText); expect(owner.context()).toEqual(value.context); expect(requests()).toEqual([]);
    h.get.mockClear(); h.set.mockClear();
    const json = vi.spyOn(JSON, 'stringify');
    for (let i = 0; i < 200; i++) owner.setDraftText(`edited ${i}`);
    expect(json).not.toHaveBeenCalled(); json.mockRestore();
    expect(owner.context()).toEqual(value.context); expect(h.get).not.toHaveBeenCalled(); expect(h.set).not.toHaveBeenCalled(); expect(requests()).toEqual([]);
    await vi.advanceTimersByTimeAsync(300); await owner.durable.flush(); expect(h.set).toHaveBeenCalledTimes(1);
    owner.setDraftText(''); expect(owner.context()).toEqual(value.context); owner.clearContext(); expect(owner.context()).toBeUndefined();
  });
  it('integration current uses the actual Chat directory while new uses the temp-worktree override', async () => {
    const current = await input({ kind: 'integration', directory: '/temp-worktree' });
    expect(current.directory).toBe('/repo'); expect(current.sessionID).toBe('s');
    const next = await input({ kind: 'integration', directory: '/temp-worktree', target: 'new' });
    expect(next.directory).toBe('/temp-worktree'); expect(next.sessionID).toBeNull();
    const state = await import('./new-session'); const owner = state.openNativeNewSession({ directory: '/temp-worktree', active: () => true, draftAuthorityKey: authorityKey }); owners.push(owner); await owner.ready;
    expect(await owner.stageContext(next)).toEqual({ status: 'staged' }); expect(owner.context()).toEqual(next.context);
    await expect(input({ directory: '/unrelated' })).rejects.toThrow('directory-mismatch');
  });
  it('requires an explicit revision CAS before replacing nonempty text/references; keeps attachments', async () => {
    const draft = await openDraft(); draft.setDraftText('Read '); draft.insertReference({ kind: 'skill', value: 'review', label: 'Review' }); draft.attachments.set([file]);
    const value = await input(); const staged = await draft.stageContext(value, () => true);
    expect(staged.status).toBe('requires-confirmation'); if (staged.status !== 'requires-confirmation') throw new Error('missing confirmation');
    expect(draft.references()).toHaveLength(1); draft.setDraftText('newer user work');
    expect(await draft.stageContext(value, () => true, staged.confirmation)).toEqual({ status: 'stale' }); expect(draft.draft()).toBe('newer user work');
    const retry = await draft.stageContext(value, () => true); if (retry.status !== 'requires-confirmation') throw new Error('missing confirmation');
    expect(await draft.stageContext(value, () => true, retry.confirmation)).toEqual({ status: 'staged' });
    expect(draft.references()).toEqual([]); expect(draft.attachments()).toEqual([file]);
  });
  it('blocks pending/unknown receipts and unconfirmed queue edits without losing any data', async () => {
    const draft = await openDraft(); draft.setDraftText('prior');
    draft.pendingSend.set({ id: 'stable', text: 'pending', files: [file], delivery: 'queue', uncertain: true, compiled: { text: 'complete compiled snapshot' } });
    const value = await input(); expect(await draft.stageContext(value, () => true)).toEqual({ status: 'blocked' });
    expect(draft.pendingSend()).toMatchObject({ id: 'stable', compiled: { text: 'complete compiled snapshot' } }); expect(draft.draft()).toBe('prior');
    draft.pendingSend.set(null); draft.queueEdit.set({ id: 'queue', text: 'queue draft', files: [file] });
    expect(await draft.stageContext(value, () => true)).toEqual({ status: 'blocked' }); expect(draft.queueEdit()?.id).toBe('queue');
  });
  it('failed Storage and oversized snapshots preserve the prior durable bytes and can retry the same captured input', async () => {
    const draft = await openDraft(); draft.draft.set('prior'); await draft.flush(); const prior = h.storage.get(draft.key);
    const value = await input(); const confirmation = await draft.stageContext(value, () => true); if (confirmation.status !== 'requires-confirmation') throw new Error('missing confirmation');
    h.set.mockRejectedValueOnce(new Error('disk unavailable'));
    await expect(draft.stageContext(value, () => true, confirmation.confirmation)).rejects.toThrow('disk unavailable');
    expect(draft.draft()).toBe('prior'); expect(draft.context()).toBeUndefined(); expect(h.storage.get(draft.key)).toBe(prior);
    await expect(draft.stageContext({ ...value, visibleText: 'x'.repeat(750_001) }, () => true, confirmation.confirmation)).rejects.toThrow('容量');
    expect(h.storage.get(draft.key)).toBe(prior);
    expect(await draft.stageContext(value, () => true, confirmation.confirmation)).toEqual({ status: 'staged' });
  });
  it('fences delayed reads/writes against edits, lost authority, and successor owners', async () => {
    const draft = await openDraft(); const value = await input(); const gate = deferred<string | null>(); h.get.mockImplementationOnce(() => gate.promise);
    const staging = draft.stageContext(value, () => true); await flush(); draft.setDraftText('typed while staging'); gate.resolve(null);
    expect(await staging).toEqual({ status: 'stale' }); expect(draft.draft()).toBe('typed while staging'); expect(draft.context()).toBeUndefined();
    await draft.flush(); const ticket = await draft.stageContext(value, () => true); if (ticket.status !== 'requires-confirmation') throw new Error('missing confirmation');
    const write = h.set.getMockImplementation()!, written = deferred<void>(); let valid = true;
    h.set.mockImplementationOnce(async (key, json) => { await written.promise; await write(key, json); });
    const late = draft.stageContext(value, () => valid, ticket.confirmation); await flush(); draft.setDraftText('new during write'); valid = false; written.resolve();
    expect(await late).toEqual({ status: 'stale' }); expect(draft.draft()).toBe('new during write'); expect(draft.context()).toBeUndefined();
    expect(JSON.parse(h.storage.get(draft.key)!).draft).toBe('new during write'); expect(JSON.parse(h.storage.get(draft.key)!).context).toBeUndefined();
    await draft.flush(); const next = await openDraft(); expect(next.draft()).toBe('new during write');
    expect(await draft.stageContext(value, () => true)).toEqual({ status: 'stale' });
  });
  it('durably isolates stable authority/directory/session and rejects cross-scope staging', async () => {
    const draft = await openDraft(); const value = await input(); await draft.stageContext(value, () => true); await draft.close();
    const restored = await openDraft(); expect(restored.context()).toEqual(value.context); expect(restored.draft()).toBe(value.visibleText);
    for (const [key, scope] of [[`${authorityKey}-other-origin`, target], [`${authorityKey}-other-auth`, target], [authorityKey, { ...target, directory: '/tree' }], [authorityKey, { ...target, id: 'other-session' }]] as const) {
      const other = await openDraft(key, scope); expect(other.context()).toBeUndefined(); expect(other.draft()).toBe('');
      await expect(other.stageContext(value, () => true)).rejects.toThrow('scope-mismatch');
    }
    const { draftKey } = await import('./drafts'); expect(draftKey('host', target)).not.toBe(draft.key);
  });
  it('malformed persisted context fails closed and preserves the prior bytes instead of silently dropping synthetic parts', async () => {
    const { openDraft: open, draftKey } = await import('./drafts'); const key = draftKey('host', target, authorityKey);
    const raw = JSON.stringify({ version: 1, revision: 1, draft: 'prior', references: [], attachments: [], pendingSend: null, queueEdit: null, context: { kind: 'conflict', payloadText: 'missing instructions' } }); h.storage.set(key, raw);
    const draft = open('host', target, authorityKey); drafts.push(draft); await expect(draft.ready).rejects.toThrow('git-context-invalid');
    draft.setDraftText('current input'); await expect(draft.stageContext(await input(), () => true)).rejects.toThrow('git-context-invalid'); await expect(draft.flush()).rejects.toThrow();
    expect(h.storage.get(key)).toBe(raw); expect(draft.draft()).toBe('current input');
  });
});

describe('desktop Git production Chat/send/new-session handoff composition', () => {
  it('stages current Chat with no POST, then compiles editable visible text plus synthetic context and native references/files', async () => {
    const current = await chat(); const value = await input(); h.call.mockClear();
    expect(await current.stageContext(value)).toEqual({ status: 'staged' }); expect(prompts()).toEqual([]); expect(current.draft()).toBe(value.visibleText);
    current.setDraftText('Please fix '); current.insertReference({ kind: 'skill', value: 'review', label: 'Review' }); current.attachments.set([file]);
    expect(await current.send()).toBe(true); expect(prompts()).toHaveLength(1);
    expect(prompts()[0]!.body).toMatchObject({ text: `Please fix [skill:review] \n${value.context.instructionsText}\n${value.context.payloadText}`, files: [{ uri: file.uri, name: file.name }], skills: [{ id: 'review' }] });
    expect(current.draft()).toBe(''); expect(current.context()).toBeUndefined();
  });
  it('captures synthetic context before awaiting prepare; later clear/edit cannot alter the pending wire or erase new edits', async () => {
    const current = await chat(); const value = await input(); await current.stageContext(value);
    const gate = deferred<{ text: string; agents: { name: string }[]; metadata: { retained: boolean } }>(); const prepare = vi.fn(() => gate.promise);
    const sending = current.send({ prepare }); await flush(); expect(prepare).toHaveBeenCalledTimes(1);
    expect(current.pendingSend()?.context).toEqual(value.context);
    expect(await current.stageContext(await input({ visibleText: 'new request' }))).toEqual({ status: 'stale' });
    current.clearContext(); current.setDraftText('new user edit'); gate.resolve({ text: 'prepared authored', agents: [{ name: 'build' }], metadata: { retained: true } });
    expect(await sending).toBe(true); expect(prompts()[0]!.body).toMatchObject({ text: `prepared authored\n${value.context.instructionsText}\n${value.context.payloadText}`, agents: [{ name: 'build' }], metadata: { retained: true } });
    expect(current.draft()).toBe('new user edit'); expect(current.context()).toBeUndefined();
  });
  it('unknown send survives restart with original compiled snapshot and same inputID, never rereads Git or prepare', async () => {
    const first = await chat(); const value = await input(); await first.stageContext(value);
    const originalHandle = handle; handle = (path, method, body) => { if (path.includes('/prompt?')) throw new Error('lost response'); return originalHandle(path, method, body); };
    const prepare = vi.fn(async () => ({ text: 'compiled original', skills: [{ id: 'review' }] })); expect(await first.send({ prepare })).toBe(false);
    const pending = first.pendingSend()!; expect(pending.uncertain).toBe(true); expect(pending.context).toEqual(value.context);
    expect(await first.stageContext(value)).toEqual({ status: 'blocked' }); first.setDraftText('new draft after unknown'); await first.flushDraft();
    h.cleanups.forEach(stop => stop()); h.disposers.forEach(stop => stop()); h.cleanups = []; h.disposers = []; await flush(); vi.resetModules();
    const state = await import('./state'); await state.loadConnections(); const recovered = await chat(); expect(recovered.pendingSend()).toMatchObject(pending);
    handle = originalHandle; const neverPrepare = vi.fn(async () => { throw new Error('must not compile twice'); });
    expect(await recovered.retrySend({ prepare: neverPrepare })).toBe(true); expect(neverPrepare).not.toHaveBeenCalled(); expect(prepare).toHaveBeenCalledTimes(1);
    expect(prompts()).toHaveLength(2); expect(prompts()[1]!.body).toEqual(prompts()[0]!.body); expect(prompts()[1]!.body.id).toBe(pending.id);
    expect(recovered.draft()).toBe('new draft after unknown'); expect(requests().filter(row => row.path.startsWith('/api/git'))).toEqual([]);
  });
  it('rejects a changed lease/authorization and never publishes late staging across authorization', async () => {
    const current = await chat(); const value = await input(); expect(await current.stageContext({ ...value, lease: 'old-lease' })).toEqual({ status: 'stale' });
    const gate = deferred<string | null>(); h.get.mockImplementationOnce(() => gate.promise); const staging = current.stageContext(value); await flush();
    const state = await import('./state'); state.app.connection.set({ ...connection, authorizationID: 'auth-b' }); gate.resolve(null);
    expect(await staging).toEqual({ status: 'stale' }); expect(current.draft()).toBe(''); expect(current.context()).toBeUndefined(); expect(await current.send()).toBe(false);
  });
  it('new-session stages locally, captures full compilation before create, transfers same ID/context and consumes once', async () => {
    const source = await newOwner(); const value = await input({ target: 'new', kind: 'integration' }); await source.stageContext(value);
    source.setDraftText('Integrate '); source.insertReference({ kind: 'skill', value: 'review', label: 'Review' }); source.setAttachments([file]);
    expect(requests()).toEqual([]); const handoff = (await source.submit())!;
    const sourcePending = source.durable.pendingSend()!; expect(sourcePending.compiled?.text).toContain(value.context.payloadText); expect(sourcePending.context).toEqual(value.context);
    expect(requests().filter(row => row.method === 'POST').map(row => row.path)).toEqual(['/api/session']);
    const destination = await chat(); expect(destination.pendingSend()?.id).toBe(handoff.inputID); expect(destination.pendingSend()?.context).toEqual(value.context); expect(destination.context()).toEqual(value.context);
    const { sendNewSessionHandoff } = await import('./new-session'); expect(await sendNewSessionHandoff(destination, handoff)).toBe(true); await source.complete(handoff);
    expect(prompts()).toHaveLength(1); expect(prompts()[0]!.body.text).toBe(sourcePending.compiled?.text); expect(prompts()[0]!.body.skills).toEqual([{ id: 'review' }]);
    expect(source.context()).toBeUndefined(); expect(source.durable.pendingSend()).toBeNull(); expect(destination.context()).toBeUndefined();
    expect(await sendNewSessionHandoff(destination, handoff)).toBe(true); expect(prompts()).toHaveLength(1);
  });
  it('new-session preparation failure leaves exact source snapshot retryable without creating any session', async () => {
    const source = await newOwner(); const value = await input({ target: 'new', visibleText: '/explore' }); await source.stageContext(value);
    const originalHandle = handle; let fail = true; handle = (path, method, body) => { if (path === '/api/magic-prompts' && fail) throw new Error('template unavailable'); return originalHandle(path, method, body); };
    await expect(source.submit()).rejects.toThrow('template unavailable'); expect(source.phase()).toBe('draft'); expect(requests().filter(row => row.method === 'POST')).toEqual([]);
    const stable = source.inputID(); source.setDraftText('subsequent edit'); expect(await source.stageContext(value)).toEqual({ status: 'blocked' });
    fail = false; const handoff = (await source.submit())!; expect(handoff.inputID).toBe(stable); expect(source.durable.pendingSend()?.text).toBe('/explore'); expect(source.durable.pendingSend()?.compiled?.text).toContain(value.context.payloadText);
  });
  it('create outcome unknown restores the complete context/compiled snapshot and refuses both restaging and a second create', async () => {
    const source = await newOwner(); const value = await input({ target: 'new' }); await source.stageContext(value); source.setAttachments([file]);
    const originalHandle = handle; handle = (path, method, body) => { if (path === '/api/session' && method === 'POST') throw new Error('create response lost'); return originalHandle(path, method, body); };
    await expect(source.submit()).rejects.toThrow('create response lost'); const stable = source.inputID(), captured = source.durable.pendingSend();
    expect(captured?.compiled?.text).toContain(value.context.payloadText); await source.close();
    const restored = await newOwner(); expect(restored.creationUnknown()).toBe(true); expect(restored.inputID()).toBe(stable);
    expect(restored.durable.pendingSend()).toEqual({ ...captured, compiled: { ...captured!.compiled, files: [{ uri: file.uri, name: file.name }] } });
    expect(await restored.stageContext(value)).toEqual({ status: 'stale' }); await expect(restored.submit()).rejects.toThrow('create-outcome-unknown');
    expect(requests().filter(row => row.path === '/api/session' && row.method === 'POST')).toHaveLength(1);
  });
  it('a failed write-ahead never sends; retry preserves the complete captured sidecars and compiles only once', async () => {
    const current = await chat(); const value = await input(); await current.stageContext(value); current.attachments.set([file]);
    const write = h.set.getMockImplementation()!; let fail = true;
    h.set.mockImplementation(async (key, raw) => { if (JSON.parse(raw).pendingSend?.uncertain && fail) throw new Error('write-ahead unavailable'); await write(key, raw); });
    const prepare = vi.fn(async () => ({ text: 'prepared', files: [{ uri: file.uri, name: file.name }], skills: [{ id: 'review' }] }));
    expect(await current.send({ prepare })).toBe(false); expect(prompts()).toEqual([]); expect(current.draft()).toBe(value.visibleText); expect(current.context()).toEqual(value.context);
    expect(current.pendingSend()?.compiled?.text).toContain(value.context.payloadText); const stable = current.pendingSend()!.id;
    fail = false; expect(await current.retrySend({ prepare })).toBe(true); expect(prepare).toHaveBeenCalledTimes(1); expect(prompts()[0]!.body.id).toBe(stable); expect(prompts()[0]!.body.files).toEqual([{ uri: file.uri, name: file.name }]);
  });
});
