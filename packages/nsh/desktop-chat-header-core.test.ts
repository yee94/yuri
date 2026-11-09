import { describe, expect, test } from 'vitest';
import { createDesktopChatHeaderActions, desktopChatHeaderLayout, desktopHeaderContext, type DesktopChatHeaderActions, type DesktopChatHeaderResult } from './desktop-chat-header-core';

describe('desktop header action admission', () => {
  test('unknown/unsupported is never a successful void action', async () => {
    let calls = 0;
    const actions: DesktopChatHeaderActions = { context: { available: true, run: () => { calls++; return undefined as unknown as DesktopChatHeaderResult; } } };
    const owner = createDesktopChatHeaderActions({ scope: () => 'A', current: () => true, actions: () => actions });
    expect(await owner.run('terminal')).toEqual({ status: 'unsupported' });
    expect(await owner.run('context')).toEqual({ status: 'unknown' });
    expect(calls).toBe(1);
  });
  test('real consumer receives exact current/scope/value and explicit accepted result', async () => {
    const scope = {}; let received: unknown;
    const actions: DesktopChatHeaderActions = { 'github-account': { available: true, run: intent => {
      expect(intent.current()).toBe(true); expect(intent.scope).toBe(scope); received = intent.value; return { status: 'accepted' };
    } } };
    const owner = createDesktopChatHeaderActions({ scope: () => scope, current: () => true, actions: () => actions });
    expect(await owner.run('github-account', 'account-b')).toEqual({ status: 'accepted' }); expect(received).toBe('account-b');
  });
  for (const boundary of ['current', 'scope', 'invalidate', 'port', 'dispose'] as const) test(`${boundary} revokes delayed consumer before side effects`, async () => {
    let scope = 'A', active = true, calls = 0, continueAction!: () => void;
    const actions: DesktopChatHeaderActions = { browser: { available: true, run: async intent => {
      await new Promise<void>(resolve => { continueAction = resolve; });
      if (!intent.current()) return { status: 'unsupported' };
      calls++; return { status: 'accepted' };
    } } };
    const owner = createDesktopChatHeaderActions({ scope: () => scope, current: () => active, actions: () => actions });
    const flight = owner.run('browser');
    if (boundary === 'current') active = false;
    if (boundary === 'scope') scope = 'B';
    if (boundary === 'invalidate') owner.invalidate();
    if (boundary === 'dispose') owner.dispose();
    if (boundary === 'port') actions.browser = { available: true, run: () => ({ status: 'accepted' }) };
    continueAction(); expect(await flight).toEqual({ status: 'stale' }); expect(calls).toBe(0);
  });
  test('one pending action; stale finally does not clear a resumed lane', async () => {
    const resolves: Array<() => void> = [], changed: boolean[] = [];
    const actions: DesktopChatHeaderActions = { terminal: { available: true, run: async () => { await new Promise<void>(resolve => resolves.push(resolve)); return { status: 'accepted' }; } } };
    const owner = createDesktopChatHeaderActions({ scope: () => 'A', current: () => true, actions: () => actions, changed: value => changed.push(value) });
    const old = owner.run('terminal'); expect(await owner.run('terminal')).toEqual({ status: 'unsupported' });
    owner.invalidate(); const next = owner.run('terminal');
    resolves[0](); expect(await old).toEqual({ status: 'stale' }); expect(changed.at(-1)).toBe(true);
    resolves[1](); expect(await next).toEqual({ status: 'accepted' }); expect(changed).toEqual([true, false, true, false]);
  });
  test('same scope, still-current replacement operation revokes an old action', async () => {
    let operation = { current: () => true }, release!: () => void, commits = 0;
    const actions: DesktopChatHeaderActions = { context: { available: true, run: async intent => {
      await new Promise<void>(resolve => { release = resolve; });
      if (intent.current()) commits++; return { status: 'accepted' };
    } } };
    const owner = createDesktopChatHeaderActions({ scope: () => 'A', current: () => true, operation: () => operation, actions: () => actions });
    const flight = owner.run('context'); operation = { current: () => true }; release();
    expect(await flight).toEqual({ status: 'stale' }); expect(commits).toBe(0);
  });
  test('throw means unknown; no retry or fabricated acknowledgement', async () => {
    let calls = 0;
    const owner = createDesktopChatHeaderActions({ scope: () => 'A', current: () => true, actions: () => ({
      context: { available: true, run: () => { calls++; throw new Error('lost receipt'); } },
    }) });
    // Production consumers keep a stable port. A replaceable port is stale rather than guessed accepted.
    expect((await owner.run('context')).status).toBe('stale'); expect(calls).toBe(0);
    const actions: DesktopChatHeaderActions = { context: { available: true, run: () => { calls++; throw new Error('lost receipt'); } } };
    const stable = createDesktopChatHeaderActions({ scope: () => 'A', current: () => true, actions: () => actions });
    expect(await stable.run('context')).toEqual({ status: 'unknown' }); expect(calls).toBe(1);
  });
});

test('real context values only; neutral pending, never stale/invalid zero', () => {
  expect(desktopHeaderContext(undefined)).toBeNull();
  expect(desktopHeaderContext({ loading: false, errors: [], tokens: 0 })).toBeNull();
  expect(desktopHeaderContext({ loading: false, errors: [], tokens: 50, limit: 100, contextStale: true })).toBeNull();
  expect(desktopHeaderContext({ loading: false, errors: [], tokens: Number.NaN, limit: 100 })).toBeNull();
  expect(desktopHeaderContext({ loading: false, errors: [], tokens: 0, limit: 100 })).toMatchObject({ percentage: 0, progress: 0 });
  expect(desktopHeaderContext({ loading: false, errors: [], tokens: 100_000, limit: 1 })).toMatchObject({ percentage: 999, progress: 1 });
  expect(desktopHeaderContext({ loading: false, errors: [], pending: true })).toEqual({ pending: true, tokens: null, limit: null, percentage: null, progress: 0 });
});

test('desktop geometry is Web 48px chrome, not phone 36px circular buttons', () => {
  expect(desktopChatHeaderLayout).toMatchObject({ height: 48, gap: 4, menuButton: 32, iconButton: 28, contextRing: 16, ringViewBox: 18, ringStroke: 2, splitButton: 48, menuWidth: 224, servicesWidth: 432 });
});
