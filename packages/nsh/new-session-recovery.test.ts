import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageOperation } from './page-operations';

const reactive = vi.hoisted(() => {
  type Reaction = { run: () => void; dependencies: Set<Set<Reaction>>; stop?: () => void; disposed: boolean };
  let tracking: Reaction | undefined, batching = 0, flushing = false;
  const queue = new Set<Reaction>(), disposers: Array<() => void> = [], cleanups: Array<() => void> = [];
  const drain = () => { if (batching || flushing) return; flushing = true; let turns = 0; try { while (queue.size) { if (++turns > 1000) throw new Error('reaction loop'); const reaction = queue.values().next().value!; queue.delete(reaction); if (!reaction.disposed) reaction.run(); } } finally { flushing = false; } };
  const untracked = <T>(work: () => T) => { const previous = tracking; tracking = undefined; try { return work(); } finally { tracking = previous; } };
  function signal<T>(initial: T) {
    let value = initial; const dependencies = new Set<Reaction>();
    const read = () => { if (tracking) { dependencies.add(tracking); tracking.dependencies.add(dependencies); } return value; };
    const set = (next: T) => { if (Object.is(next, value)) return; value = next; dependencies.forEach(reaction => queue.add(reaction)); drain(); };
    return Object.assign(read, { set, update: (work: (value: T) => T) => set(work(value)) });
  }
  function effect(work: () => void | (() => void)) {
    const reaction: Reaction = { dependencies: new Set(), disposed: false, run() {
      untracked(() => reaction.stop?.()); reaction.stop = undefined;
      reaction.dependencies.forEach(dependencies => dependencies.delete(reaction)); reaction.dependencies.clear();
      const previous = tracking; tracking = reaction;
      try { const stop = work(); if (typeof stop === 'function') reaction.stop = stop; } finally { tracking = previous; }
    } };
    disposers.push(() => { reaction.disposed = true; reaction.dependencies.forEach(dependencies => dependencies.delete(reaction)); reaction.stop?.(); }); reaction.run();
  }
  return { signal, effect, untracked, batch: <T>(work: () => T) => { batching++; try { return work(); } finally { batching--; drain(); } }, cleanups,
    dispose() { disposers.splice(0).forEach(stop => stop()); cleanups.splice(0).reverse().forEach(stop => stop()); queue.clear(); },
    storage: new Map<string, string>(), get: vi.fn(), set: vi.fn(),
  };
});
const root = vi.hoisted(() => {
  const connection = reactive.signal({ id: 'A', url: 'https://a.example', authorizationID: 'auth-a' });
  const scope = reactive.signal<{ hostID: string; lease: string } | null>({ hostID: 'A', lease: 'same-lease' });
  const epoch = reactive.signal(1), ready = reactive.signal(true), lifecycle = reactive.signal('active');
  const requests: Array<{ path: string; method: string; body: any; generation: number; lease?: string }> = [];
  const respond = vi.fn();
  function captureHostOperation() {
    const generation = epoch(), captured = scope(), identity = connection(), admitted = ready() && lifecycle() === 'active';
    const current = () => admitted && ready() && lifecycle() === 'active' && epoch() === generation && scope() === captured && connection() === identity;
    return Object.freeze({ generation, scope: captured, current, request: async (path: string, method = 'GET', body?: unknown) => {
      if (!current() || method !== 'GET' && !captured) throw new Error('host_operation_stale');
      requests.push({ path, method, body, generation, lease: captured?.lease });
      const result = await respond(path, method, body);
      if (!current()) throw new Error('host_operation_stale');
      return result;
    } });
  }
  return { connection, scope, epoch, ready, lifecycle, requests, respond, captureHostOperation };
});
vi.mock('nsh', () => ({ ...reactive, Storage: { getItem: reactive.get, setItem: reactive.set }, lifecycle: root.lifecycle, cleanup: (work: () => void) => reactive.cleanups.push(work) }));
vi.mock('./state', () => ({ app: { connection: root.connection, runtimeScope: root.scope }, epoch: root.epoch,
  captureHostOperation: root.captureHostOperation, captureHostRequest: () => root.captureHostOperation().request,
  isCurrentHostScope: (generation: number, hostID: string) => root.epoch() === generation && root.connection().id === hostID,
}));

const project = { id: 'project', name: 'Project', path: '/repo' };
const file = { uri: 'attachment://original', name: 'original.txt', mime: 'text/plain' };
const flush = async () => { for (let index = 0; index < 120; index++) await Promise.resolve(); };
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const owners: Array<{ close: () => Promise<void> }> = [];
function background() { reactive.batch(() => { root.ready.set(false); root.epoch.set(root.epoch() + 1); root.scope.set(null); root.lifecycle.set('background'); }); }
function foreground() { root.lifecycle.set('active'); }
function confirm() { reactive.batch(() => { root.scope.set({ hostID: 'A', lease: 'same-lease' }); root.ready.set(true); }); }
function fresh() { background(); foreground(); confirm(); }
beforeEach(() => {
  vi.useFakeTimers(); root.requests.length = 0; reactive.storage.clear();
  reactive.batch(() => { root.connection.set({ id: 'A', url: 'https://a.example', authorizationID: 'auth-a' }); root.epoch.set(1); root.scope.set({ hostID: 'A', lease: 'same-lease' }); root.lifecycle.set('active'); root.ready.set(true); });
  reactive.get.mockReset().mockImplementation(async (key: string) => reactive.storage.get(key) ?? null);
  reactive.set.mockReset().mockImplementation(async (key: string, value: string) => { reactive.storage.set(key, value); });
  root.respond.mockReset().mockImplementation(async (path: string, method: string) => path === '/api/session' && method === 'POST' ? { id: 'created', location: { directory: '/repo' } } : path.startsWith('/api/session/created?') ? { id: 'created', location: { directory: '/repo' } } : []);
});
afterEach(async () => { await Promise.allSettled(owners.splice(0).map(owner => owner.close())); reactive.dispose(); vi.useRealTimers(); });
async function open() {
  const api = await import('./new-session'), owner = api.openNativeNewSession({ project, active: () => true }); owners.push(owner); await owner.ready; return owner;
}

describe('retained new-session production owners with dependency-tracked lifecycle and strict operation tokens', () => {
  it('keeps the draft object, references, files, selection and input ID across a readiness gap with a repeated lease', async () => {
    const owner = await open(), durable = owner.durable;
    owner.setDraftText('Read '); owner.insertReference({ kind: 'file', value: 'a.ts', label: 'a.ts', scope: durable.scope }); owner.setAttachments([file]);
    await owner.select({ agent: 'build' });
    const old = owner.captureOperation(), before = root.requests.length;
    background(); foreground(); const gap = root.captureHostOperation();
    expect(owner.current()).toBe(false); expect(owner.operation()).toBeNull(); expect(owner.setDraftText('forbidden')).toBe(false);
    confirm(); expect(owner.current()).toBe(true); expect(owner.durable).toBe(durable); expect(owner.selection()).toEqual({ agent: 'build' });
    expect(durable.draft()).toBe('Read @a.ts '); expect(durable.references()).toHaveLength(1); expect(durable.attachments()).toEqual([file]);
    await expect(old.request('/mutation', 'POST')).rejects.toThrow('scope-changed'); await expect(gap.request('/mutation', 'POST')).rejects.toThrow('stale');
    expect(root.requests).toHaveLength(before);
  });

  it.each(['host', 'origin', 'authorization'])('permanently retires source authority after %s changes, including A-B-A', async kind => {
    const owner = await open(), original = root.connection(); owner.setDraftText('retained');
    root.connection.set(kind === 'host' ? { ...original, id: 'B' } : kind === 'origin' ? { ...original, url: 'https://other.example' } : { ...original, authorizationID: 'auth-new' });
    root.connection.set(original); fresh();
    expect(owner.replaceOperation(root.captureHostOperation())).toBe(false); expect(owner.current()).toBe(false); expect(owner.durable.draft()).toBe('retained');
    await expect(owner.submit()).rejects.toThrow('scope-changed'); expect(root.requests).toEqual([]);
  });

  it('does not poison never-dispatched configuration when suspension interrupts the initial draft flush', async () => {
    const owner = await open(); owner.setDraftText('frozen'); await owner.select({ agent: 'build' });
    const gate = deferred<void>(), persist = reactive.set.getMockImplementation()!; let delayed = false;
    reactive.set.mockImplementation(async (key: string, raw: string) => { if (!delayed && key.startsWith('nsh:chat-draft:')) { delayed = true; await gate.promise; } return persist(key, raw); });
    const flight = owner.submit(); await flush(); fresh(); gate.resolve(); await expect(flight).rejects.toThrow('scope-changed');
    let agent: string | undefined;
    root.respond.mockImplementation(async (path: string, method: string, body: any) => {
      if (path.includes('/agent?') && method === 'POST') agent = body.agent;
      return path === '/api/session' || path.startsWith('/api/session/created?') ? { id: 'created', agent } : [];
    });
    const handoff = await owner.submit(); expect(handoff?.target.id).toBe('created');
    expect(root.requests.filter(item => item.method === 'POST').map(item => item.path)).toEqual(['/api/session', '/api/session/created/agent?directory=%2Frepo']);
  });

  it('an interrupted create keeps its frozen input and never guesses a latest session or creates twice', async () => {
    const owner = await open(); owner.setDraftText('frozen'); owner.setAttachments([file]);
    const gate = deferred<unknown>(); root.respond.mockImplementation((path: string) => path === '/api/session' ? gate.promise : []);
    const flight = owner.submit(); await flush(); const inputID = owner.inputID(); fresh(); gate.resolve({ id: 'created' });
    await expect(flight).rejects.toThrow('scope-changed'); await expect(owner.submit()).rejects.toThrow('create-outcome-unknown');
    expect(owner.inputID()).toBe(inputID); expect(owner.durable.pendingSend()?.files).toEqual([file]); expect(owner.durable.draft()).toBe('frozen');
    expect(root.requests.map(item => [item.path, item.method, item.generation])).toEqual([['/api/session', 'POST', 1]]);
  });

  it('does not replay unknown model configuration or start the next Agent write under a replacement operation', async () => {
    const owner = await open(); owner.setDraftText('frozen'); await owner.select({ model: { providerID: 'p', id: 'm' }, agent: 'build' });
    const gate = deferred<unknown>(); let model: unknown;
    root.respond.mockImplementation((path: string, method: string, body: any) => {
      if (path.includes('/model?') && method === 'POST') { model = body.model; return gate.promise; }
      return path === '/api/session' || path.startsWith('/api/session/created?') ? { id: 'created', model } : [];
    });
    const first = owner.submit(); await flush(); const inputID = owner.inputID(); fresh(); gate.resolve(null);
    await expect(first).rejects.toThrow('scope-changed'); await expect(owner.submit()).rejects.toThrow('selection-not-confirmed');
    expect(owner.selection()).toEqual({ model: { providerID: 'p', id: 'm' }, agent: 'build' }); expect(owner.inputID()).toBe(inputID);
    expect(root.requests.filter(item => item.method === 'POST').map(item => item.path)).toEqual(['/api/session', '/api/session/created/model?directory=%2Frepo']);
    expect(root.requests.filter(item => item.generation === 2).every(item => item.method === 'GET')).toBe(true);
  });

  it('the same operation can dispatch an unstarted Agent after its write-ahead Storage failure without replaying the ACK Model', async () => {
    const owner = await open(); owner.setDraftText('frozen'); await owner.select({ model: { providerID: 'p', id: 'm' }, agent: 'build' });
    const persist = reactive.set.getMockImplementation()!; let fail = true, model: unknown, agent: unknown;
    reactive.set.mockImplementation(async (key: string, raw: string) => {
      if (key.startsWith('nsh:new-session:') && JSON.parse(raw).configuration?.agent === 'unknown' && fail) throw new Error('disk');
      return persist(key, raw);
    });
    root.respond.mockImplementation(async (path: string, method: string, body: any) => {
      if (path.includes('/model?') && method === 'POST') model = body.model;
      if (path.includes('/agent?') && method === 'POST') agent = body.agent;
      return path === '/api/session' || path.startsWith('/api/session/created?') ? { id: 'created', model, agent } : [];
    });
    await expect(owner.submit()).rejects.toThrow('disk'); expect(owner.phase()).toBe('created');
    expect(root.requests.filter(item => item.method === 'POST').map(item => item.path)).toEqual(['/api/session', '/api/session/created/model?directory=%2Frepo']);
    fail = false; const receipt = await owner.submit(); expect(receipt?.target.id).toBe('created');
    expect(root.requests.filter(item => item.method === 'POST').map(item => item.path)).toEqual(['/api/session', '/api/session/created/model?directory=%2Frepo', '/api/session/created/agent?directory=%2Frepo']);
  });

  it('a reopened created receipt only verifies configuration, including an Agent that the previous owner never dispatched', async () => {
    const owner = await open(); owner.setDraftText('frozen'); await owner.select({ model: { providerID: 'p', id: 'm' }, agent: 'build' });
    const persist = reactive.set.getMockImplementation()!; let model: unknown;
    reactive.set.mockImplementation(async (key: string, raw: string) => {
      if (key.startsWith('nsh:new-session:') && JSON.parse(raw).configuration?.agent === 'unknown') throw new Error('disk');
      return persist(key, raw);
    });
    root.respond.mockImplementation(async (path: string, method: string, body: any) => {
      if (path.includes('/model?') && method === 'POST') model = body.model;
      return path === '/api/session' || path.startsWith('/api/session/created?') ? { id: 'created', model } : [];
    });
    await expect(owner.submit()).rejects.toThrow('disk'); const inputID = owner.inputID(); await owner.close();
    reactive.set.mockImplementation(persist); const reopened = await open(), before = root.requests.length;
    await expect(reopened.submit()).rejects.toThrow('selection-not-confirmed');
    expect(root.requests.slice(before).map(item => item.method)).toEqual(['GET']);
    expect(reopened.inputID()).toBe(inputID); expect(reopened.durable.pendingSend()?.text).toBe('frozen'); expect(reopened.phase()).toBe('created');
  });

  async function admissionFixture(command = false) {
    const api = await import('./new-session'), admissionAPI = await import('./new-session-admission'), drafts = await import('./drafts');
    const owner = await open(); owner.setDraftText(command ? '/goal once' : 'frozen'); owner.setAttachments(command ? [] : [file]);
    const receipt = (await owner.submit())!, destination = drafts.openDraft('A', receipt.target); owners.push(destination); await destination.ready;
    const pageCleanups = reactive.cleanups.splice(0); pageCleanups.forEach(stop => stop());
    const operation = reactive.signal<PageOperation | null>(root.captureHostOperation()); let released = false;
    const release = vi.fn(async () => { released = true; await owner.close(); });
    const handoff = { receipt, owner, released: () => released, release }, states: string[] = [];
    const chat = { active: () => true, draftReady: destination.ready, referenceScope: destination.scope, get messageScope() { return { hostID: 'A', generation: root.epoch() }; },
      pendingSend: destination.pendingSend, recoverPendingSend: vi.fn(async () => false), retrySend: vi.fn(async () => false),
    };
    const admission = admissionAPI.createNewSessionAdmission({ chat: chat as any, handoff, current: () => true, operation, changed: value => states.push(value) });
    return { owner, receipt, destination, operation, release, handoff, chat, admission, states };
  }

  it.each([false, true])('retains handoff after page cleanup and only GET reconciles an unknown first admission after replacement, command=%s', async command => {
    const f = await admissionFixture(command), gate = deferred<boolean>(); f.chat.retrySend.mockImplementation(() => gate.promise);
    const original = f.owner.durable, first = f.admission.run(); await flush(); expect(f.chat.retrySend).toHaveBeenCalledTimes(1);
    expect(f.owner.admission()).toBe('unknown');
    background(); f.operation.set(null); foreground(); expect(f.owner.ownedScope()).toBe(true);
    confirm(); f.operation.set(root.captureHostOperation());
    const resumed = f.admission.reconcile(); gate.resolve(false); await Promise.all([first, resumed]);
    expect(f.owner.durable).toBe(original); expect(f.owner.inputID()).toBe(f.receipt.inputID); expect(f.owner.phase()).toBe('installed');
    expect(f.chat.retrySend).toHaveBeenCalledTimes(1); expect(f.release).not.toHaveBeenCalled();
    expect(root.requests.filter(item => item.generation === 2).every(item => item.method === 'GET')).toBe(true);
    expect(f.destination.pendingSend()?.id).toBe(f.receipt.inputID);
    f.destination.setDraftText('later draft');
    root.respond.mockImplementation(async (path: string) => path.includes('/inbox?') ? [{ id: f.receipt.inputID, sessionID: f.receipt.target.id }] : []);
    await f.admission.reconcile();
    expect(f.chat.retrySend).toHaveBeenCalledTimes(1); expect(f.destination.draft()).toBe('later draft');
    expect(f.release).toHaveBeenCalledTimes(command ? 0 : 1); expect(f.owner.phase()).toBe(command ? 'installed' : 'draft');
  });

  it('records completed local cleanup before checking a retired operation, so a foreground lane can finish release', async () => {
    const f = await admissionFixture(), gate = deferred<void>(), persist = reactive.set.getMockImplementation()!;
    f.chat.retrySend.mockResolvedValue(true);
    reactive.set.mockImplementation(async (key: string, raw: string) => { if (key.startsWith('nsh:new-session:') && JSON.parse(raw).phase === 'draft') await gate.promise; return persist(key, raw); });
    const first = f.admission.run(); await flush(); expect(f.owner.admission()).toBe('acknowledged');
    background(); f.operation.set(null); foreground(); confirm(); f.operation.set(root.captureHostOperation()); gate.resolve(); await first;
    expect(f.owner.phase()).toBe('draft'); await f.admission.reconcile();
    expect(f.release).toHaveBeenCalledTimes(1); expect(f.chat.retrySend).toHaveBeenCalledTimes(1); expect(f.states.at(-1)).toBe('complete');
  });

  it.each(['unknown', 'acknowledged'])('a delayed %s receipt write never dispatches through a replacement permission', async phase => {
    const f = await admissionFixture(), gate = deferred<void>(), persist = reactive.set.getMockImplementation()!;
    f.chat.retrySend.mockResolvedValue(true);
    reactive.set.mockImplementation(async (key: string, raw: string) => { if (key.startsWith('nsh:new-session:') && JSON.parse(raw).admission === phase) await gate.promise; return persist(key, raw); });
    const first = f.admission.run(); await flush();
    expect(f.chat.retrySend).toHaveBeenCalledTimes(phase === 'unknown' ? 0 : 1);
    background(); f.operation.set(null); foreground(); confirm(); f.operation.set(root.captureHostOperation());
    const next = f.admission.reconcile(); gate.resolve(); await Promise.all([first, next]);
    expect(f.chat.retrySend).toHaveBeenCalledTimes(phase === 'unknown' ? 0 : 1);
    expect(root.requests.filter(item => item.generation === 2).every(item => item.method === 'GET')).toBe(true);
    expect(f.release).toHaveBeenCalledTimes(phase === 'unknown' ? 0 : 1);
    expect(f.owner.phase()).toBe(phase === 'unknown' ? 'installed' : 'draft');
    expect(f.owner.durable.draft()).toBe(phase === 'unknown' ? 'frozen' : '');
  });
});
