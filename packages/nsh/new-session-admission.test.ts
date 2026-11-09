import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Row } from './model';
import type { NewSessionAdmissionState } from './new-session-admission';

const harness = vi.hoisted(() => ({
  storage: new Map<string, string>(), get: vi.fn(), set: vi.fn(), call: vi.fn(),
  cleanups: [] as Array<() => void>, stops: [] as Array<() => void>,
}));
vi.mock('nsh', () => ({
  platform: { os: 'ios', desktop: false },
  batch: <T>(work: () => T) => work(), untracked: <T>(work: () => T) => work(),
  signal: <T>(initial: T) => { let value = initial; return Object.assign(() => value, { set: (next: T) => { value = next; } }); },
  Storage: { getItem: harness.get, setItem: harness.set }, lifecycle: () => 'active',
  effect: (work: () => void | (() => void)) => { const stop = work(); if (stop) harness.stops.push(stop); },
  cleanup: (work: () => void) => harness.cleanups.push(work),
  host: { available: () => true, call: harness.call, on: () => () => {} },
}));

type Page = ReturnType<(typeof import('./new-session'))['createNativeNewSessionOwnership']>;
type Request = { path: string; method: string; body?: Row };
const project = { id: 'fixture-project', name: 'Native draft project', path: '/fixture/project' };
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const flush = async () => { for (let index = 0; index < 160; index++) await Promise.resolve(); };
const requests = () => harness.call.mock.calls.filter(([name]) => name === 'runtime.request').map(([, input]) => input as Request);
const posts = (suffix: string) => requests().filter(input => input.method === 'POST' && new URL(input.path, 'https://host.example').pathname.endsWith(suffix));
let pages: Page[], selected: string, dispatch: (input: Request) => unknown;

beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers(); pages = []; selected = 'one';
  harness.storage.clear(); harness.cleanups = []; harness.stops = [];
  harness.get.mockReset().mockImplementation(async (key: string) => harness.storage.get(key) ?? null);
  harness.set.mockReset().mockImplementation(async (key: string, raw: string) => { harness.storage.set(key, raw); });
  const host = (await import('./tests/new-session-host.js')).createHost();
  dispatch = input => host.call('runtime.request', input);
  harness.call.mockReset().mockImplementation(async (name, input) => {
    if (name === 'connection.list') return { selected, connections: [{ id: selected, label: 'Fixture Host', url: 'https://host.example', lastUsedAt: 0 }], runtimeScope: { hostID: selected, lease: `lease-${selected}` } };
    if (name === 'runtime.request') return dispatch(input);
    if (name === 'runtime.stream' || name === 'runtime.stop') return true;
    throw new Error(`Unexpected admission fixture call: ${name}`);
  });
  await (await import('./state')).loadConnections();
});
afterEach(async () => {
  harness.stops.forEach(stop => stop()); harness.cleanups.forEach(stop => stop());
  await Promise.allSettled(pages.map(page => page.handoff()?.release() ?? page.disposePage()));
  await flush(); vi.useRealTimers();
});

/** Real durable source, installed destination, Chat recovery/send, and admission owner. */
async function fixture(text = 'Admit the captured first message') {
  const api = await import('./new-session'), state = await import('./state');
  const page = api.createNativeNewSessionOwnership({ project, active: () => true }); pages.push(page);
  await page.owner.ready; page.owner.setDraftText(text);
  const receipt = (await page.owner.submit())!, handoff = page.transfer(receipt);
  await page.disposePage();
  const chat = state.createChat(receipt.target); await chat.draftReady; await flush();
  const states: NewSessionAdmissionState[] = [], send = vi.fn(api.sendNewSessionHandoff);
  const complete = vi.spyOn(handoff.owner, 'complete'), close = vi.spyOn(handoff.owner, 'close');
  const { createNewSessionAdmission } = await import('./new-session-admission');
  const admission = createNewSessionAdmission({ chat, handoff, send, current: () => state.isCurrentHostScope(receipt.generation, receipt.hostID) && chat.active(), changed: value => states.push(value) });
  return { page, receipt, handoff, chat, admission, states, send, complete, close };
}

describe('navigation-owned new-session admission', () => {
  it('shares the exact first-send flight and admits/cleans/releases only once', async () => {
    const f = await fixture(), gate = deferred<unknown>(), original = dispatch;
    dispatch = input => input.path.includes('/prompt?') ? gate.promise : original(input);
    const first = f.admission.run(); expect(f.admission.run()).toBe(first);
    await flush(); expect(posts('/prompt')).toHaveLength(1); expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.states).toEqual(['sending']); expect(f.complete).not.toHaveBeenCalled(); expect(f.handoff.released()).toBe(false);
    const request = posts('/prompt')[0]!; gate.resolve(original(request)); await first;
    expect(f.states).toEqual(['sending', 'complete']); expect(f.complete).toHaveBeenCalledTimes(1); expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.page.owner.phase()).toBe('draft'); expect(f.handoff.released()).toBe(true);
    await f.admission.run(); expect(f.send).toHaveBeenCalledTimes(1); expect(posts('/session')).toHaveLength(1); expect(posts('/prompt')).toHaveLength(1);
  });

  it('keeps an unknown result installed until explicit retry, retaining stable ID and later Chat edits', async () => {
    const f = await fixture(), original = dispatch; let fail = true;
    dispatch = input => { if (input.path.includes('/prompt?') && fail) throw new Error('Lost first admission response'); return original(input); };
    await f.admission.run();
    expect(f.states).toEqual(['sending', 'unconfirmed']); expect(f.complete).not.toHaveBeenCalled(); expect(f.handoff.released()).toBe(false);
    expect(f.page.owner.phase()).toBe('installed'); expect(f.chat.pendingSend()).toMatchObject({ id: f.receipt.inputID, uncertain: true });
    await vi.advanceTimersByTimeAsync(300); await flush(); expect(posts('/prompt')).toHaveLength(1);
    f.chat.setDraftText('A newer unsent Chat draft'); fail = false; await f.admission.run();
    expect(f.states).toEqual(['sending', 'unconfirmed', 'sending', 'unconfirmed']); expect(f.complete).not.toHaveBeenCalled();
    expect(f.chat.pendingSend()).toMatchObject({ id: f.receipt.inputID, uncertain: true });
    const beforeConfirm = dispatch;
    dispatch = input => input.method === 'GET' && input.path.includes('/inbox?') ? { status: 200, body: { data: [{ id: f.receipt.inputID, sessionID: f.receipt.target.id }] } } : beforeConfirm(input);
    await f.admission.reconcile(); expect(f.states.at(-1)).toBe('complete'); expect(f.chat.draft()).toBe('A newer unsent Chat draft');
    expect(posts('/prompt')).toHaveLength(1);
    expect(f.complete).toHaveBeenCalledTimes(1); expect(posts('/session')).toHaveLength(1);
  });

  it.each([
    { text: 'A normal first prompt', endpoint: '/prompt' },
    { text: '/fixture-command once', endpoint: '/command' },
  ])('retries only failed source cleanup, never replays $endpoint after acknowledgement', async ({ text, endpoint }) => {
    const f = await fixture(text), persist = harness.set.getMockImplementation()!; let fail = true;
    harness.set.mockImplementation(async (key: string, raw: string) => {
      if (key.startsWith('nsh:new-session:') && JSON.parse(raw).phase === 'draft' && fail) throw new Error('Source cleanup disk failure');
      return persist(key, raw);
    });
    await f.admission.run();
    expect(f.states).toEqual(['sending', 'error']); expect(f.complete).toHaveBeenCalledTimes(1); expect(f.handoff.released()).toBe(false);
    expect(f.page.owner.phase()).toBe('installed'); expect(f.chat.pendingSend()).toBeNull(); expect(posts(endpoint)).toHaveLength(1);
    fail = false; await f.admission.run();
    expect(f.states).toEqual(['sending', 'error', 'sending', 'complete']); expect(f.complete).toHaveBeenCalledTimes(2);
    expect(f.send).toHaveBeenCalledTimes(1); expect(posts(endpoint)).toHaveLength(1); expect(posts('/session')).toHaveLength(1);
    expect(f.page.owner.phase()).toBe('draft'); expect(f.handoff.released()).toBe(true);
  });

  it('close waits for first send and source cleanup before releasing, and does not publish after disposal', async () => {
    const f = await fixture(), gate = deferred<unknown>(), original = dispatch;
    dispatch = input => input.path.includes('/prompt?') ? gate.promise : original(input);
    const first = f.admission.run(); await flush(); expect(posts('/prompt')).toHaveLength(1);
    const closing = f.admission.close(); expect(f.admission.close()).toBe(closing);
    let closed = false; void closing.then(() => { closed = true; }); await flush();
    expect(closed).toBe(false); expect(f.complete).not.toHaveBeenCalled(); expect(f.close).not.toHaveBeenCalled(); expect(f.handoff.released()).toBe(false);
    gate.resolve(original(posts('/prompt')[0]!)); await Promise.all([first, closing]);
    expect(closed).toBe(true); expect(f.complete).toHaveBeenCalledTimes(1); expect(f.close).toHaveBeenCalledTimes(1); expect(f.handoff.released()).toBe(true);
    expect(f.page.owner.phase()).toBe('draft'); expect(f.states).toEqual(['sending']);
    await f.admission.run(); expect(f.send).toHaveBeenCalledTimes(1);
  });

  it('closing an unconfirmed admission retains the installed source for a later owner, without creating again', async () => {
    const f = await fixture(), original = dispatch;
    dispatch = input => { if (input.path.includes('/prompt?')) throw new Error('Unknown send'); return original(input); };
    await f.admission.run(); await f.admission.close();
    expect(f.states).toEqual(['sending', 'unconfirmed']); expect(f.complete).not.toHaveBeenCalled(); expect(f.handoff.released()).toBe(true);
    const api = await import('./new-session'), reopened = api.createNativeNewSessionOwnership({ project, active: () => true }); pages.push(reopened);
    await reopened.owner.ready; const resumed = (await reopened.owner.submit())!;
    expect(resumed.inputID).toBe(f.receipt.inputID); expect(resumed.target).toEqual(f.receipt.target); expect(reopened.owner.durable.draft()).toBe('Admit the captured first message');
    expect(posts('/session')).toHaveLength(1); expect(posts('/prompt')).toHaveLength(1);
  });

  it('Host invalidation before entry performs no send or source cleanup and still permits disposal', async () => {
    const f = await fixture(); selected = 'two'; await (await import('./state')).loadConnections();
    await f.admission.run(); expect(f.states).toEqual([]); expect(f.send).not.toHaveBeenCalled(); expect(posts('/prompt')).toHaveLength(0);
    expect(f.complete).not.toHaveBeenCalled(); expect(f.page.owner.phase()).toBe('installed');
    await f.admission.close(); expect(f.handoff.released()).toBe(true); expect(f.close).toHaveBeenCalledTimes(1);
  });

  it('Host switch during first send never clears the old source or sends it into the new Host', async () => {
    const f = await fixture(), gate = deferred<unknown>(), original = dispatch;
    dispatch = input => input.path.includes('/prompt?') ? gate.promise : original(input);
    const first = f.admission.run(); await flush(); selected = 'two'; await (await import('./state')).loadConnections();
    gate.resolve(original(posts('/prompt')[0]!)); await first; await f.admission.run();
    expect(f.states).not.toContain('complete'); expect(f.page.owner.phase()).toBe('installed'); expect(f.page.owner.durable.draft()).toBe('Admit the captured first message');
    expect(posts('/prompt')).toHaveLength(1); expect(f.send).toHaveBeenCalledTimes(1); expect(f.handoff.released()).toBe(false);
    await f.admission.close(); expect(f.handoff.released()).toBe(true);
  });

  it('a temporary navigation cover is not disposal: the retained owner can admit on return', async () => {
    const f = await fixture(); f.chat.active.set(false); await f.admission.run();
    expect(f.send).not.toHaveBeenCalled(); expect(f.close).not.toHaveBeenCalled(); expect(f.handoff.released()).toBe(false);
    expect(f.page.owner.phase()).toBe('installed');
    f.chat.active.set(true); await f.admission.run();
    expect(f.states).toEqual(['sending', 'complete']); expect(f.send).toHaveBeenCalledTimes(1); expect(f.complete).toHaveBeenCalledTimes(1);
    expect(posts('/prompt')).toHaveLength(1); expect(posts('/session')).toHaveLength(1);
  });

  it('an unknown first-send result arriving under a temporary cover retains the owner for explicit retry on return', async () => {
    const f = await fixture(), gate = deferred<unknown>(), original = dispatch;
    dispatch = input => input.path.includes('/prompt?') ? gate.promise : original(input);
    const first = f.admission.run(); await flush(); expect(posts('/prompt')).toHaveLength(1);
    f.chat.active.set(false); gate.resolve({ status: 503, body: { message: 'Covered send outcome unknown' } }); await first;
    expect(f.states).toEqual(['sending', 'unconfirmed']); expect(f.complete).not.toHaveBeenCalled(); expect(f.close).not.toHaveBeenCalled(); expect(f.handoff.released()).toBe(false);
    expect(f.page.owner.phase()).toBe('installed'); expect(f.chat.pendingSend()?.id).toBe(f.receipt.inputID);
    f.chat.active.set(true); dispatch = input => input.method === 'GET' && input.path.includes('/inbox?') ? { status: 200, body: { data: [{ id: f.receipt.inputID, sessionID: f.receipt.target.id }] } } : original(input); await f.admission.run();
    expect(f.states.at(-1)).toBe('complete'); expect(posts('/prompt')).toHaveLength(1); expect(posts('/session')).toHaveLength(1);
    expect(f.complete).toHaveBeenCalledTimes(1); expect(f.close).toHaveBeenCalledTimes(1);
  });

  it('the production-navigation fake Host audit observes writes rather than relying on engine host.calls recording', async () => {
    const host = (await import('./tests/new-session-production-host.js')).createHost();
    const read = (path: string) => host.call('runtime.request', { path, method: 'GET' }).body;
    expect(read('/api/config/settings').projects).toEqual([project]);
    expect(read('/__fixture/new-session-production/audit')).toEqual({ writes: 0, creates: 0, prompts: 0 });
    const created = host.call('runtime.request', { path: '/api/session', method: 'POST', body: { location: { directory: project.path } } }).body.data;
    host.call('runtime.request', { path: `/api/session/${created.id}/prompt?directory=%2Ffixture%2Fproject`, method: 'POST', body: { id: 'audit-input', text: 'Fixture only', delivery: 'steer' } });
    expect(read('/__fixture/new-session-production/audit')).toEqual({ writes: 2, creates: 1, prompts: 1 });
  });
});
