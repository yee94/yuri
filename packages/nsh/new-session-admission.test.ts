import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Row } from './model';
import type { NewSessionAdmissionState } from './new-session-admission';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

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
type Request = { path: string; method: string; body?: Row; expectedHost?: { hostID: string; lease: string } };
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
  const host = (await import('./tests/new-session-host.js')).createHost({ hostID: 'one', lease: 'lease-one' });
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

function productionRetry(f: Awaited<ReturnType<typeof fixture>>) {
  const source = ts.createSourceFile('application.tsx', readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'application.tsx'), 'utf8'), ts.ScriptTarget.ES2023, true, ts.ScriptKind.TSX);
  let callback: ts.Expression | undefined;
  const find = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const attributes = node.attributes.properties;
      if (attributes.some(attribute => ts.isJsxAttribute(attribute) && attribute.name.getText(source) === 'testID' && attribute.initializer && ts.isStringLiteral(attribute.initializer) && attribute.initializer.text === 'chat-send-retry')) {
        const press = attributes.find((attribute): attribute is ts.JsxAttribute => ts.isJsxAttribute(attribute) && attribute.name.getText(source) === 'onPress');
        if (press?.initializer && ts.isJsxExpression(press.initializer)) callback = press.initializer.expression;
      }
    }
    ts.forEachChild(node, find);
  };
  find(source); if (!callback) throw new Error('Missing production admission Retry callback');
  const expression = ts.createPrinter().printNode(ts.EmitHint.Expression, callback, source);
  return vm.runInNewContext(ts.transpileModule(`(${expression})`, { compilerOptions: { target: ts.ScriptTarget.ES2023 } }).outputText,
    { admission: f.admission, admissionState: () => f.states.at(-1) ?? 'idle', chat: f.chat }) as () => void;
}

describe('navigation-owned new-session admission', () => {
  it.each(['failed', 'malformed'] as const)('production Retry recovers %s compact metadata on the same receipt/inputID with exactly one first dispatch', async failure => {
    const f = await fixture('/compact topic'), original = dispatch; let fail = true, reads = 0;
    dispatch = input => {
      if (input.path.startsWith('/api/command?')) { reads++; if (fail) return failure === 'failed' ? { status: 503, body: { error: 'Metadata offline' } } : { status: 200, body: { malformed: true } }; }
      return original(input);
    };
    await f.admission.run();
    expect(f.states.at(-1)).toBe('error'); expect(posts('/prompt')).toEqual([]); expect(posts('/command')).toEqual([]);
    expect(f.chat.pendingSend()).toMatchObject({ id: f.receipt.inputID, uncertain: false, command: { name: 'compact' } });
    fail = false; productionRetry(f)(); await flush();
    expect(reads).toBe(2); expect(f.states.at(-1)).toBe('complete');
    expect(posts('/session')).toHaveLength(1); expect(posts('/prompt')).toHaveLength(1);
    expect(posts('/prompt')[0].body?.id).toBe(f.receipt.inputID); expect(f.complete).toHaveBeenCalledTimes(1);
  });

  it.each(['command', 'prompt'] as const)('production Retry never replays compact %s after dispatch loses its ACK', async endpoint => {
    const f = await fixture('/compact topic'), original = dispatch;
    dispatch = input => {
      if (endpoint === 'command' && input.path.startsWith('/api/command?')) return { status: 200, body: { data: [{ name: 'compact', isBuiltIn: true }] } };
      if (input.method === 'POST' && input.path.includes(`/${endpoint}?`)) throw new Error('Lost dispatch ACK');
      return original(input);
    };
    await f.admission.run(); expect(posts(`/${endpoint}`)).toHaveLength(1); expect(f.chat.pendingSend()?.uncertain).toBe(true);
    productionRetry(f)(); await flush(); expect(posts(`/${endpoint}`)).toHaveLength(1); expect(posts('/session')).toHaveLength(1);
    expect(f.states.at(-1)).toBe('unconfirmed'); expect(f.complete).not.toHaveBeenCalled();
  });

  it('legacy unknown source admission never becomes safe preparation merely because pending.uncertain is false', async () => {
    const f = await fixture('/compact topic');
    await f.page.owner.noteAdmission(f.receipt, 'unknown', f.page.owner.captureOperation(false));
    expect(f.chat.pendingSend()?.uncertain).toBe(false); productionRetry(f)(); await flush();
    expect(f.states.at(-1)).toBe('unconfirmed'); expect(f.page.owner.admission()).toBe('unknown');
    expect(requests().some(input => input.path.startsWith('/api/command?'))).toBe(false);
    expect(posts('/command')).toEqual([]); expect(posts('/prompt')).toEqual([]); expect(posts('/session')).toHaveLength(1);
  });

  it('uncertain preparation journal write blocks dispatch and cannot be treated as safe preparation on Retry', async () => {
    const f = await fixture('/compact topic'), persist = harness.set.getMockImplementation()!;
    let fail = true;
    harness.set.mockImplementation(async (key: string, raw: string) => {
      await persist(key, raw);
      if (fail && key.startsWith('nsh:new-session:') && JSON.parse(raw).admission) throw new Error('Receipt write result unknown');
    });
    await f.admission.run(); expect(posts('/prompt')).toEqual([]); expect(posts('/command')).toEqual([]);
    fail = false; productionRetry(f)(); await flush();
    expect(posts('/prompt')).toEqual([]); expect(posts('/command')).toEqual([]); expect(posts('/session')).toHaveLength(1);
    expect(f.states.at(-1)).not.toBe('complete'); expect(f.complete).not.toHaveBeenCalled();
  });

  it('destination preparation Storage failure cannot authorize Retry from an uncertain in-memory pending flag', async () => {
    const f = await fixture('/compact topic'), persist = harness.set.getMockImplementation()!;
    harness.set.mockImplementation(async (key: string, raw: string) => {
      await persist(key, raw);
      if (key === f.chat.referenceScope.draft && JSON.parse(raw).pendingSend?.compiled) throw new Error('Destination Storage result unknown');
    });
    await f.admission.run(); expect(f.chat.draftStatus()).toBe('error'); expect(f.chat.pendingSend()?.uncertain).toBe(false);
    expect(f.page.owner.admission()).toBe('preparing');
    productionRetry(f)(); await flush();
    expect(posts('/prompt')).toEqual([]); expect(posts('/command')).toEqual([]); expect(posts('/session')).toHaveLength(1);
    expect(f.complete).not.toHaveBeenCalled(); expect(f.states.at(-1)).toBe('unconfirmed');
  });

  it('late metadata under a retired Host never writes preparation into a new scope or dispatches the captured input', async () => {
    const f = await fixture('/compact topic'), original = dispatch, gate = deferred<unknown>();
    dispatch = input => input.path.startsWith('/api/command?') ? gate.promise : original(input);
    const first = f.admission.run(); await flush(); expect(f.page.owner.admission()).toBe('preparing');
    selected = 'two'; await (await import('./state')).loadConnections(); const writes = harness.set.mock.calls.length;
    gate.resolve({ status: 200, body: { data: [] } }); await first;
    expect(harness.set.mock.calls).toHaveLength(writes); expect(f.chat.pendingSend()).toMatchObject({ id: f.receipt.inputID, uncertain: false, command: { name: 'compact' } });
    expect(posts('/prompt')).toEqual([]); expect(posts('/command')).toEqual([]); expect(posts('/session')).toHaveLength(1);
    expect(f.complete).not.toHaveBeenCalled(); expect(f.states).not.toContain('complete');
  });

  it('preparing receipt survives close/reopen and permits only explicit first admission with the original session/inputID', async () => {
    const f = await fixture('/compact topic'), original = dispatch;
    dispatch = input => input.path.startsWith('/api/command?') ? { status: 503, body: { error: 'Metadata offline' } } : original(input);
    await f.admission.run(); await f.admission.close(); expect(f.page.owner.admission()).toBe('preparing');
    dispatch = original;
    const api = await import('./new-session'), state = await import('./state'), reopened = api.createNativeNewSessionOwnership({ project, active: () => true }); pages.push(reopened);
    await reopened.owner.ready; const receipt = (await reopened.owner.submit())!, handoff = reopened.transfer(receipt);
    expect(receipt.target).toEqual(f.receipt.target); expect(receipt.inputID).toBe(f.receipt.inputID); expect(reopened.owner.admission()).toBe('preparing');
    const chat = state.createChat(receipt.target); await chat.draftReady; await flush();
    const states: NewSessionAdmissionState[] = [], { createNewSessionAdmission } = await import('./new-session-admission');
    const resumed = createNewSessionAdmission({ chat, handoff, current: () => chat.active(), changed: value => states.push(value) });
    await resumed.reconcile(); expect(posts('/prompt')).toEqual([]);
    await resumed.run(); expect(states.at(-1)).toBe('complete'); expect(posts('/prompt')).toHaveLength(1);
    expect(posts('/prompt')[0].body?.id).toBe(f.receipt.inputID); expect(posts('/session')).toHaveLength(1);
  });
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
    const expectedHost = host.call('connection.list', {}).runtimeScope;
    const read = (path: string) => host.call('runtime.request', { path, method: 'GET' }).body;
    expect(read('/api/config/settings').projects).toEqual([project]);
    expect(read('/__fixture/new-session-production/audit')).toEqual({ writes: 0, creates: 0, prompts: 0 });
    const created = host.call('runtime.request', { path: '/api/session', method: 'POST', expectedHost, body: { location: { directory: project.path } } }).body.data;
    host.call('runtime.request', { path: `/api/session/${created.id}/prompt?directory=%2Ffixture%2Fproject`, method: 'POST', expectedHost, body: { id: 'audit-input', text: 'Fixture only', delivery: 'steer' } });
    expect(read('/__fixture/new-session-production/audit')).toEqual({ writes: 2, creates: 1, prompts: 1 });
  });
});
