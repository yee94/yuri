import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeGoal } from './chat-goal-model';
import { captureIssuedStream, issuedStream, resetIssuedStreams } from './tests/session-stream-fixture';

const harness = vi.hoisted(() => ({
  listeners: new Map<string, Set<(payload: unknown) => void>>(), cleanups: [] as Array<() => void>,
  effects: [] as Array<() => void | (() => void)>, disposers: [] as Array<() => void>,
  lifecycle: 'active', call: vi.fn(), storage: new Map<string, string>(), getItem: vi.fn(), setItem: vi.fn(),
  writes: [] as Array<{ source: unknown; value: unknown }>,
}));
vi.mock('nsh', () => ({
  batch: <T>(work: () => T) => work(),
  Storage: { getItem: harness.getItem, setItem: harness.setItem },
  signal: <T>(initial: T) => { let value = initial; const source = Object.assign(() => value, { set: (next: T) => { value = next; harness.writes.push({ source, value }); } }); return source; },
  locale: () => 'en', lifecycle: () => harness.lifecycle,
  untracked: <T>(work: () => T) => work(),
  effect: (work: () => void | (() => void)) => { harness.effects.push(work); const stop = work(); if (stop) harness.disposers.push(stop); },
  cleanup: (work: () => void) => harness.cleanups.push(work),
  host: { available: () => true, call: harness.call,
    on: (name: string, work: (payload: unknown) => void) => { const listeners = harness.listeners.get(name) ?? new Set(); listeners.add(work); harness.listeners.set(name, listeners); return () => { listeners.delete(work); }; },
  },
}));
const scope = { kind: 'session' as const, id: 's', title: 'Session', directory: '/repo' };
const initialGoal: NativeGoal = { id: 'g', objective: 'Verify everything', status: 'active', rounds: 1, maxRounds: 20, boot: 'process', updatedAt: 1 };
const deferred = <T>() => { let resolve!: (value: T) => void, reject!: (failure: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let count = 0; count < 50; count++) await Promise.resolve(); };
const emit = (type: string, body: Record<string, unknown> = {}, key = 'chat', directory?: string) => {
  const ticket = issuedStream(harness.call, key);
  if (type === 'server.connected') for (const listener of harness.listeners.get('runtime.event') ?? []) listener({ ...ticket, type: 'reconnected' });
  for (const listener of harness.listeners.get('runtime.event') ?? []) listener({ ...ticket, data: JSON.stringify({ type, data: body, ...(directory ? { location: { directory } } : {}) }) });
};
const requests = () => harness.call.mock.calls.filter(([name]) => name === 'runtime.request').map(([, input]) => input);
const commands = () => requests().filter(input => input.path.includes('/command?'));
const reads = () => requests().filter(input => input.path.startsWith('/api/rpc/opencode.goal/get?'));
let handle: (path: string, method: string, body: unknown) => unknown;
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); harness.lifecycle = 'active'; harness.writes = [];
  resetIssuedStreams(harness.call);
  harness.listeners.clear(); harness.cleanups = []; harness.effects = []; harness.disposers = []; harness.storage.clear();
  harness.getItem.mockReset().mockImplementation(async (key: string) => harness.storage.get(key) ?? null);
  harness.setItem.mockReset().mockImplementation(async (key: string, value: string) => { harness.storage.set(key, value); });
  handle = path => {
    if (path.startsWith('/api/rpc/')) return { output: initialGoal };
    if (path.includes('/message?')) return { data: [] };
    if (path === '/api/session/active') return {};
    if (/^\/api\/session\/[^/?]+\?/.test(path)) return { id: decodeURIComponent(path.split('/')[3].split('?')[0]) };
    if (path.includes('/inbox?') || path.includes('/form?') || path.includes('/permission/request?') || path.startsWith('/api/command?')) return [];
    return null;
  };
  harness.call.mockReset().mockImplementation(async (name, input) => {
    if (name === 'runtime.stream') captureIssuedStream(harness.call, input);
    if (name === 'connection.list') return { connections: [{ id: 'one', url: 'https://host.example', label: 'Host', lastUsedAt: 0 }], selected: 'one', runtimeScope: { hostID: 'one', lease: 'one-lease' } };
    if (name === 'runtime.request') return { status: input.method === 'POST' && input.path.includes('/command?') ? 204 : 200, body: await handle(input.path, input.method, input.body) };
    return true;
  });
});
afterEach(() => { harness.disposers.forEach(stop => stop()); harness.cleanups.forEach(stop => stop()); vi.restoreAllMocks(); vi.useRealTimers(); });
async function chatOwner(observe = false, dependencies: Parameters<(typeof import('./state'))['createChat']>[1] = {}) {
  const state = await import('./state'); await state.loadConnections();
  await harness.call('runtime.stream', { key: 'global', path: '/api/yuri/events', expectedHost: state.app.runtimeScope() });
  const chat = state.createChat(scope, dependencies); await chat.draftReady; await flush();
  if (observe) { chat.goal.observe(); await flush(); }
  return { state, chat };
}

describe('production follow-up delivery snapshots', () => {
  const prompts = () => requests().filter(input => input.path.includes('/prompt?'));
  function acceptPrompts() {
    const normal = handle;
    handle = (path, method, body) => path.includes('/prompt?') ? { id: (body as { id: string }).id, sessionID: 's' } : normal(path, method, body);
  }
  describe('final write-ahead child admission', () => {
    const modes = ['prompt', 'command', 'shell', 'goal'] as const;
    async function scenario(mode: typeof modes[number], initialChild: boolean) {
      let allowed = initialChild, child = initialChild;
      const normal = handle;
      let finalRead: (() => Promise<unknown>) | undefined;
      handle = (path, method, body) => /^\/api\/session\/s\?/.test(path) ? finalRead ? finalRead() : { id: 's', ...(child ? { parentID: 'parent' } : {}) }
        : path.startsWith('/api/command?') ? [{ name: 'custom' }]
        : path.includes('/prompt?') ? { id: (body as { id: string }).id, sessionID: 's' } : normal(path, method, body);
      const { chat } = await chatOwner(false, { deviceChatPreferences: () => ({ allowPromptingSubagentSessions: allowed, persistChatDraft: false }) });
      const text = mode === 'command' ? '/custom original' : mode === 'shell' ? 'printf original' : mode === 'goal' ? '/goal Verify original' : 'Original prompt';
      const files = mode === 'shell' ? [] : [{ uri: 'attachment://original', name: 'original.txt', mime: 'text/plain' }];
      chat.setDraftText(text); chat.attachments.set(files);
      return { chat, text, files, setAllowed: (value: boolean) => { allowed = value; }, setChild: () => { child = true; },
        gateFinalRead: (read: () => Promise<unknown>) => { finalRead = read; },
        start: () => mode === 'command' ? chat.command('custom', 'original') : chat.send(mode === 'shell' ? { inputMode: 'shell' } : {}),
      };
    }
    const outbound = () => requests().filter(input => input.method === 'POST' && /\/(prompt|command|shell)\?/.test(input.path));
    async function assertRetained(input: Awaited<ReturnType<typeof scenario>>, capturedID: string) {
      expect(outbound()).toHaveLength(0);
      expect(input.chat.error()).toBe('subagent-prompting-disabled');
      expect(input.chat.sendAdmission()).toBe('subagent-prompting-disabled');
      expect(input.chat.draft()).toBe(input.text); expect(input.chat.attachments()).toEqual(input.files);
      expect(input.chat.pendingSend()).toMatchObject({ id: capturedID, text: input.text, files: input.files, uncertain: false });
      const saved = JSON.parse(harness.storage.get(input.chat.referenceScope.draft)!);
      expect(saved.draft).toBe(''); expect(saved.attachments).toEqual(input.files);
      expect(saved.pendingSend).toMatchObject({ id: capturedID, text: input.text, files: input.files, uncertain: false });
      input.setAllowed(true);
      expect(await input.chat.retrySend()).toBe(true); expect(outbound()).toHaveLength(1);
      expect(input.chat.pendingSend()).toBeNull();
      if (input.text === 'Original prompt') expect(outbound()[0].body.id).toBe(capturedID);
    }
    it.each(modes)('final session GET changes parent to forbidden child before %s dispatch', async mode => {
      const input = await scenario(mode, false), entered = deferred<void>(), gate = deferred<unknown>();
      input.gateFinalRead(() => { entered.resolve(); return gate.promise; });
      const flight = input.start(); await entered.promise;
      const capturedID = input.chat.pendingSend()!.id;
      input.setChild(); gate.resolve({ id: 's', parentID: 'parent' });
      expect(await flight).toBe(false); await assertRetained(input, capturedID);
    });
    it.each(modes)('child preference becomes false during final session GET before %s dispatch', async mode => {
      const input = await scenario(mode, true), entered = deferred<void>(), gate = deferred<unknown>();
      input.gateFinalRead(() => { entered.resolve(); return gate.promise; });
      const flight = input.start(); await entered.promise;
      const capturedID = input.chat.pendingSend()!.id;
      input.setAllowed(false); gate.resolve({ id: 's', parentID: 'parent' });
      expect(await flight).toBe(false); await assertRetained(input, capturedID);
    });
    it.each(modes)('child preference becomes false during write-ahead Storage before %s dispatch', async mode => {
      const input = await scenario(mode, true), entered = deferred<void>(), gate = deferred<void>();
      const originalSet = harness.setItem.getMockImplementation()!;
      let held = false;
      harness.setItem.mockImplementation(async (key: string, json: string) => {
        if (!held && key === input.chat.referenceScope.draft && JSON.parse(json).pendingSend?.uncertain === true) {
          held = true; entered.resolve(); await gate.promise;
        }
        await originalSet(key, json);
      });
      const flight = input.start(); await entered.promise;
      const capturedID = input.chat.pendingSend()!.id;
      input.setAllowed(false); gate.resolve();
      expect(await flight).toBe(false); await assertRetained(input, capturedID);
    });
  });
  it.each([false, null])('blocks actual child prompt and command at unknown/disabled preference %s without altering input', async allowed => {
    const normal = handle;
    handle = (path, method, body) => /^\/api\/session\/s\?/.test(path) ? { id: 's', parentID: 'parent' } : normal(path, method, body);
    let preference = allowed === null ? null : { allowPromptingSubagentSessions: allowed, persistChatDraft: true };
    const { chat } = await chatOwner(false, { deviceChatPreferences: () => preference }); acceptPrompts();
    chat.setDraftText('Keep this'); expect(chat.canSend()).toBe(false);
    expect(chat.sendAdmission()).toBe(allowed === null ? 'subagent-preference-unknown' : 'subagent-prompting-disabled');
    expect(await chat.send()).toBe(false); expect(await chat.command('review', 'args')).toBe(false);
    expect(chat.draft()).toBe('Keep this'); expect(chat.pendingSend()).toBe(null); expect(prompts()).toHaveLength(0); expect(commands()).toHaveLength(0);
    preference = { allowPromptingSubagentSessions: true, persistChatDraft: true };
    expect(chat.canSend()).toBe(true); expect(await chat.send()).toBe(true); expect(prompts()).toHaveLength(1);
    preference = { ...preference, allowPromptingSubagentSessions: false };
    chat.setDraftText('Next'); expect(await chat.send()).toBe(false); expect(prompts()).toHaveLength(1);
  });
  it('uses parent session authority rather than message parents and allows parent prompts before preferences load', async () => {
    const { chat } = await chatOwner(false, { deviceChatPreferences: () => null }); acceptPrompts();
    chat.messages.set([{ id: 'reply', role: 'assistant', text: 'x', parentID: 'message-parent' }]);
    expect(chat.canSend()).toBe(true); chat.setDraftText('Parent prompt'); expect(await chat.send()).toBe(true);
  });
  it('Bot admission does not depend on child-session preference or a session parent lookup', async () => {
    const normal = handle;
    handle = (path, method, body) => path.includes('/assistants/bot/') && method === 'POST' ? { admitted: true, messageID: (body as { messageID: string }).messageID }
      : path === '/api/yuri/assistants/snapshot' ? { assistants: [{ id: 'bot', working: false }] }
      : path.includes('/contact/messages') ? { messages: [], generation: 1, revision: 1, complete: true } : normal(path, method, body);
    const state = await import('./state'); await state.loadConnections();
    const chat = state.createChat({ ...scope, id: 'bot', kind: 'assistant' }, { deviceChatPreferences: () => null }); await chat.draftReady; await flush();
    expect(chat.canSend()).toBe(true); chat.setDraftText('Bot input'); expect(await chat.send()).toBe(true);
    expect(requests().some(input => input.method === 'POST' && input.path.includes('/assistants/bot/'))).toBe(true);
    expect(requests().some(input => /^\/api\/session\/bot\?/.test(input.path))).toBe(false);
  });
  it('blocks outbound child dispatch if authority changes while preparing and never replays via retry', async () => {
    const normal = handle;
    handle = (path, method, body) => /^\/api\/session\/s\?/.test(path) ? { id: 's', parentID: 'parent' } : normal(path, method, body);
    let allowed = true;
    const { chat } = await chatOwner(false, { deviceChatPreferences: () => ({ allowPromptingSubagentSessions: allowed, persistChatDraft: false }) }); acceptPrompts();
    chat.setDraftText('Captured'); const gate = deferred<import('./model').CompiledSubmission>();
    const flight = chat.send({ prepare: () => gate.promise }); await flush(); allowed = false; gate.resolve({ text: 'Compiled' });
    expect(await flight).toBe(false); expect(prompts()).toHaveLength(0); expect(chat.draft()).toBe('Captured'); expect(chat.pendingSend()?.uncertain).toBe(false);
    expect(await chat.retrySend()).toBe(false); expect(prompts()).toHaveLength(0);
    const saved = [...harness.storage.entries()].find(([key]) => key.includes('chat-draft'))!;
    expect(JSON.parse(saved[1]).draft).toBe(''); expect(JSON.parse(saved[1]).pendingSend.text).toBe('Captured');
  });
  it('device draft preference reaches the actual Chat owner and null never writes ordinary input', async () => {
    let preference: { allowPromptingSubagentSessions: boolean; persistChatDraft: boolean } | null = null;
    const { chat } = await chatOwner(false, { deviceChatPreferences: () => preference });
    chat.setDraftText('Live editor'); await chat.flushDraft(); expect(harness.storage.size).toBe(0);
    preference = { allowPromptingSubagentSessions: false, persistChatDraft: false }; await chat.flushDraft();
    expect(chat.draft()).toBe('Live editor');
    const saved = () => JSON.parse([...harness.storage.entries()].find(([key]) => key.includes('chat-draft'))![1]);
    expect(saved().draft).toBe(''); preference = { ...preference, persistChatDraft: true }; await chat.flushDraft();
    expect(saved().draft).toBe('Live editor');
  });
  it('100 text/status events and draft edits never read the preference or request settings', async () => {
    const followUpBehavior = vi.fn(() => 'steer' as const);
    const { chat } = await chatOwner(false, { followUpBehavior });
    const baseline = requests().length;
    for (let count = 0; count < 100; count++) {
      emit('session.text.delta', { sessionID: 's', assistantMessageID: 'stream', ordinal: 0, delta: 'x' });
      emit('session.status', { sessionID: 's', status: count % 2 ? 'busy' : 'idle' });
      chat.setDraftText(`edit ${count}`);
    }
    await vi.advanceTimersByTimeAsync(32);
    expect(followUpBehavior).not.toHaveBeenCalled(); expect(requests()).toHaveLength(baseline);
    await vi.advanceTimersByTimeAsync(4100);
    expect(followUpBehavior).not.toHaveBeenCalled(); expect(requests().some(input => /settings|appearance/.test(input.path))).toBe(false);
  });
  it.each(['queue', 'steer', null, undefined] as const)('busy preference %s is captured once for a new ordinary prompt', async preference => {
    const followUpBehavior = vi.fn(() => preference ?? null);
    const { chat } = await chatOwner(false, preference === undefined ? {} : { followUpBehavior }); acceptPrompts();
    emit('session.execution.started', { sessionID: 's' }); chat.setDraftText('Follow up');
    expect(await chat.send()).toBe(true);
    expect(prompts()[0].body.delivery).toBe(preference === 'steer' ? 'steer' : 'queue');
    expect(followUpBehavior).toHaveBeenCalledTimes(preference === undefined ? 0 : 1);
    expect(commands()).toHaveLength(0);
  });
  it('invalid untyped preference falls back to queue rather than silently steering', async () => {
    // @ts-expect-error Exercise an invalid external value at the runtime boundary.
    const { chat } = await chatOwner(false, { followUpBehavior: () => 'invalid' }); acceptPrompts();
    emit('session.execution.started', { sessionID: 's' }); chat.setDraftText('Follow up');
    expect(await chat.send()).toBe(true); expect(prompts()[0].body.delivery).toBe('queue');
  });
  it('idle submission is steer without reading a busy-only preference', async () => {
    const followUpBehavior = vi.fn(() => 'queue' as const);
    const { chat } = await chatOwner(false, { followUpBehavior }); acceptPrompts(); chat.setDraftText('Start');
    expect(await chat.send()).toBe(true); expect(prompts()[0].body.delivery).toBe('steer'); expect(followUpBehavior).not.toHaveBeenCalled();
  });
  it.each(['queue', 'steer'] as const)('ordinary %s does not change when busy/preference changes during compilation', async delivery => {
    let preference = delivery;
    const followUpBehavior = vi.fn(() => preference);
    const { chat } = await chatOwner(false, { followUpBehavior }); acceptPrompts();
    emit('session.execution.started', { sessionID: 's' }); chat.setDraftText('Captured input');
    const gate = deferred<import('./model').CompiledSubmission>();
    const sending = chat.send({ prepare: () => gate.promise }); await flush();
    expect(chat.pendingSend()?.delivery).toBe(delivery);
    preference = delivery === 'queue' ? 'steer' : 'queue'; emit('session.status', { sessionID: 's', status: 'idle' });
    gate.resolve({ text: 'Compiled original', files: [{ uri: 'file:///repo/proof.ts' }] });
    expect(await sending).toBe(true); expect(prompts()[0].body).toMatchObject({ text: 'Compiled original', delivery, files: [{ uri: 'file:///repo/proof.ts' }] });
    expect(followUpBehavior).toHaveBeenCalledTimes(1);
  });
  it.each(['queue', 'steer'] as const)('unknown %s keeps delivery, stable ID and compiled resources through preference changes, retry and restart', async delivery => {
    let preference = delivery;
    const followUpBehavior = vi.fn(() => preference);
    const { chat } = await chatOwner(false, { followUpBehavior }); const normal = handle;
    handle = (path, method, body) => { if (path.includes('/prompt?')) throw new Error('lost ack'); return normal(path, method, body); };
    emit('session.execution.started', { sessionID: 's' }); chat.setDraftText('Captured input');
    const compiled = { text: 'Compiled original', files: [{ uri: 'file:///repo/original.ts', name: 'original.ts' }], agents: [{ name: 'reviewer' }], skills: [{ id: 'verify' }], metadata: { source: 'fixture' } };
    expect(await chat.send({ prepare: async () => compiled })).toBe(false);
    const pending = chat.pendingSend()!, originalBody = prompts()[0].body;
    expect(pending).toMatchObject({ delivery, uncertain: true, compiled });
    expect(JSON.parse(harness.storage.get(chat.referenceScope.draft)!).pendingSend).toMatchObject({ id: pending.id, delivery, compiled });
    preference = delivery === 'queue' ? 'steer' : 'queue'; emit('session.status', { sessionID: 's', status: 'idle' });
    chat.setDraftText('New unrelated draft');
    const prepare = vi.fn(async () => ({ text: 'Must not compile new input' }));
    expect(await chat.retrySend({ prepare })).toBe(false);
    expect(prompts()[1].body).toEqual(originalBody); expect(followUpBehavior).toHaveBeenCalledTimes(1); expect(prepare).not.toHaveBeenCalled();
    await chat.flushDraft(); vi.resetModules();
    const state = await import('./state'); await state.loadConnections();
    const restoredGetter = vi.fn(() => preference), restored = state.createChat(scope, { followUpBehavior: restoredGetter });
    await restored.draftReady; await flush(); emit('session.execution.started', { sessionID: 's' });
    expect(restored.pendingSend()).toMatchObject({ id: pending.id, delivery, uncertain: true, compiled });
    handle = (path, method, body) => path.includes('/prompt?') ? { id: (body as { id: string }).id, sessionID: 's' }
      : path.includes(`/message/${pending.id}?`) ? (() => { throw Object.assign(new Error('not found'), { status: 404 }); })() : normal(path, method, body);
    expect(await restored.retrySend({ prepare })).toBe(true);
    expect(prompts()[2].body).toEqual(originalBody); expect(restoredGetter).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
    expect(restored.draft()).toBe('New unrelated draft'); expect(restored.pendingSend()).toBeNull();
  });
  it.each(['queue', 'steer'] as const)('preparation failure preserves captured %s even before compilation', async delivery => {
    let preference = delivery;
    const followUpBehavior = vi.fn(() => preference);
    const { chat } = await chatOwner(false, { followUpBehavior }); acceptPrompts();
    emit('session.execution.started', { sessionID: 's' }); chat.setDraftText('Original');
    expect(await chat.send({ prepare: async () => { throw new Error('compiler offline'); } })).toBe(false);
    expect(chat.pendingSend()).toMatchObject({ delivery, uncertain: false });
    preference = delivery === 'queue' ? 'steer' : 'queue';
    expect(await chat.retrySend({ prepare: async () => ({ text: 'Compiled original' }) })).toBe(true);
    expect(prompts()[0].body.delivery).toBe(delivery); expect(followUpBehavior).toHaveBeenCalledTimes(1);
  });
  it.each([['typed', 'queue'], ['typed', 'steer'], ['armed', 'queue'], ['armed', 'steer']] as const)('busy %s Goal captures %s before prepare and preference changes never replay an unknown command', async (mode, delivery) => {
    let preference = delivery;
    const followUpBehavior = vi.fn(() => preference);
    const { chat } = await chatOwner(false, { followUpBehavior }); const normal = handle;
    handle = (path, method, body) => { if (path.includes('/command?')) throw new Error('lost Goal ack'); return normal(path, method, body); };
    emit('session.execution.started', { sessionID: 's' });
    chat.setDraftText(mode === 'typed' ? '/goal Verify original' : 'Verify original');
    if (mode === 'armed') chat.goal.controller.setArmed(true);
    const gate = deferred<import('./model').CompiledSubmission>(), prepare = vi.fn(() => gate.promise);
    const sending = chat.send({ prepare }); await flush();
    expect(chat.pendingSend()?.delivery).toBe(delivery);
    preference = delivery === 'queue' ? 'steer' : 'queue'; emit('session.status', { sessionID: 's', status: 'idle' });
    gate.resolve({ text: mode === 'typed' ? '/goal Compiled objective' : 'Compiled objective', files: [{ uri: 'file:///repo/proof.ts' }], skills: [{ id: 'verify' }] });
    expect(await sending).toBe(false);
    expect(commands().at(-1)?.body).toMatchObject({ name: 'goal', text: 'Compiled objective', delivery, files: [{ uri: 'file:///repo/proof.ts' }], skills: [{ id: 'verify' }] });
    const beforeRetry = requests().length;
    expect(await chat.retrySend({ prepare })).toBe(false); expect(await chat.recoverPendingSend()).toBe(false);
    expect(requests()).toHaveLength(beforeRetry); expect(followUpBehavior).toHaveBeenCalledTimes(1); expect(prepare).toHaveBeenCalledTimes(1);
    await chat.flushDraft(); vi.resetModules();
    const state = await import('./state'); await state.loadConnections();
    const restoredGetter = vi.fn(() => preference), restored = state.createChat(scope, { followUpBehavior: restoredGetter });
    await restored.draftReady; await flush(); const baseline = requests().length;
    expect(restored.pendingSend()).toMatchObject({ delivery, uncertain: true, command: { name: 'goal', text: 'Compiled objective' } });
    expect(await restored.retrySend()).toBe(false); expect(requests()).toHaveLength(baseline); expect(restoredGetter).not.toHaveBeenCalled();
    expect(prompts()).toHaveLength(0); expect(commands()).toHaveLength(1);
  });
  it('queue leaves authoritative model/agent selection untouched and sends no composer selection overrides', async () => {
    const selection = { model: { providerID: 'host-provider', modelID: 'host-model' }, agent: 'host-agent', variant: 'host-variant' };
    const normal = handle;
    handle = (path, method, body) => /^\/api\/session\/s\?/.test(path) ? { id: 's', ...selection } : normal(path, method, body);
    const { chat } = await chatOwner(false, { followUpBehavior: () => 'queue' }); acceptPrompts();
    emit('session.execution.started', { sessionID: 's' }); chat.setDraftText('Queued input');
    const baseline = requests().length;
    expect(await chat.send({ prepare: async () => ({ text: 'Queued compiled', metadata: { composerModel: 'diagnostic-only' } }) })).toBe(true);
    expect(requests().slice(baseline).filter(input => input.method !== 'GET')).toEqual([expect.objectContaining({ method: 'POST', body: { id: expect.any(String), text: 'Queued compiled', delivery: 'queue', metadata: { composerModel: 'diagnostic-only' } } })]);
    expect(prompts()[0].body).not.toHaveProperty('model'); expect(prompts()[0].body).not.toHaveProperty('agent'); expect(prompts()[0].body).not.toHaveProperty('variant');
  });
  it('installed initial-session steer remains authoritative even when the session is now busy with queue preference', async () => {
    const followUpBehavior = vi.fn(() => 'queue' as const);
    const { chat } = await chatOwner(false, { followUpBehavior }); acceptPrompts();
    chat.setDraftText('First input');
    chat.pendingSend.set({ id: 'installed-first-input', text: 'First input', files: [], delivery: 'steer', uncertain: false, inputMode: 'normal', references: { text: 'First input', references: [], scope: chat.referenceScope }, compiled: { text: 'Compiled first input' } });
    emit('session.execution.started', { sessionID: 's' });
    expect(await chat.retrySend()).toBe(true);
    expect(prompts()[0].body).toEqual({ id: 'installed-first-input', text: 'Compiled first input', delivery: 'steer' }); expect(followUpBehavior).not.toHaveBeenCalled();
  });
  it('panel Goal controls never read the composer follow-up preference', async () => {
    const followUpBehavior = vi.fn(() => 'queue' as const);
    const { chat } = await chatOwner(true, { followUpBehavior }); emit('session.execution.started', { sessionID: 's' });
    expect(await chat.goal.controller.clear()).toBe('acknowledged');
    expect(commands()[0].body).toEqual({ name: 'goal', text: 'clear' }); expect(followUpBehavior).not.toHaveBeenCalled();
  });
});

describe('production state Goal owner', () => {
  it('provides the exact UI owner without a second store, and no Goal reads on input, busy or safety poll', async () => {
    const { chat } = await chatOwner(); expect(reads()).toHaveLength(0);
    const stop = chat.goal.observe(); await flush();
    expect(chat.goal.state()).toMatchObject({ goal: initialGoal, resolved: true }); expect(reads()).toHaveLength(1);
    const streams = harness.call.mock.calls.filter(([name]) => name === 'runtime.stream').length;
    for (let index = 0; index < 200; index++) chat.setDraftText(`input ${index}`);
    emit('session.status', { sessionID: 's', status: 'busy' });
    await vi.advanceTimersByTimeAsync(4100);
    expect(reads()).toHaveLength(1); expect(harness.call.mock.calls.filter(([name]) => name === 'runtime.stream')).toHaveLength(streams);
    stop(); stop(); emit('server.connected', {}); await vi.advanceTimersByTimeAsync(120); expect(reads()).toHaveLength(1);
  });
  it('changed on the existing scoped SSE wins against GET; invalid/other scopes never clear or load messages', async () => {
    const late = deferred<unknown>(), normal = handle;
    handle = (path, method, body) => path.startsWith('/api/rpc/') ? late.promise : normal(path, method, body);
    const { chat } = await chatOwner(); chat.goal.observe(); await flush();
    const baseline = requests().length;
    emit('rpc.opencode.goal.changed', { sessionID: 's', goal: { ...initialGoal, status: 'paused' } });
    emit('rpc.opencode.goal.changed', { sessionID: 's', goal: null }, 'global');
    emit('rpc.opencode.goal.changed', { sessionID: 's', goal: null }, 'chat', '/other');
    emit('rpc.opencode.goal.changed', { sessionID: 'other', goal: null });
    emit('rpc.opencode.goal.changed', { sessionID: 's', goal: {} });
    late.resolve({ output: initialGoal }); await flush();
    expect(chat.goal.state().goal?.status).toBe('paused');
    expect(requests()).toHaveLength(baseline);
    emit('rpc.opencode.goal.changed', { sessionID: 's', goal: null }, 'global', '/repo');
    expect(chat.goal.state()).toMatchObject({ goal: null, resolved: true });
  });
  it('coalesces reconnects in the existing scheduler, preserves refresh failure, and accepts null', async () => {
    const { chat } = await chatOwner(true); const normal = handle;
    handle = (path, method, body) => { if (path.startsWith('/api/rpc/')) throw new Error('offline'); return normal(path, method, body); };
    for (let count = 0; count < 50; count++) emit('server.connected', {});
    await vi.advanceTimersByTimeAsync(120); await flush();
    expect(reads()).toHaveLength(2); expect(chat.goal.state()).toMatchObject({ goal: initialGoal, readError: true });
    handle = (path, method, body) => path.startsWith('/api/rpc/') ? { output: null } : normal(path, method, body);
    emit('global.disposed', {}, 'global'); await vi.advanceTimersByTimeAsync(120); await flush();
    expect(chat.goal.state()).toMatchObject({ goal: null, readError: false });
  });
  it('hides stale replies on inactive scope and retires Goal/arm on a real Host generation change', async () => {
    const { state, chat } = await chatOwner(true); const normal = handle, late = deferred<unknown>();
    chat.goal.controller.setArmed(true, 'Do this');
    handle = (path, method, body) => path.startsWith('/api/rpc/') ? late.promise : normal(path, method, body);
    const read = chat.goal.controller.refresh(); chat.active.set(false);
    emit('rpc.opencode.goal.changed', { sessionID: 's', goal: null });
    late.resolve({ output: { ...initialGoal, status: 'complete' } }); await read;
    expect(chat.goal.state().goal?.status).toBe('active');
    await state.loadConnections({ forceReconnect: true });
    expect(chat.goal.state()).toMatchObject({ goal: null, armed: false, resolved: false });
    chat.active.set(true); expect(await chat.goal.controller.clear()).toBe('blocked');
  });
  it('panel actions share the send lane and preserve unrelated drafts, attachments, references and staged history', async () => {
    const normal = handle;
    handle = (path, method, body) => /^\/api\/session\/s\?/.test(path) ? { id: 's', revert: { messageID: 'boundary' } } : normal(path, method, body);
    const { chat } = await chatOwner(true);
    chat.setDraftText('Unrelated '); chat.insertReference({ kind: 'skill', value: 'keep', label: 'Keep' });
    chat.attachments.set([{ uri: 'attachment://keep', name: 'keep', mime: 'text/plain' }]);
    const doc = chat.referenceDocument(), files = chat.attachments();
    expect(await chat.goal.controller.toggle()).toBe('acknowledged');
    expect(commands().at(-1)?.body).toEqual({ name: 'goal', text: 'pause' });
    expect(chat.referenceDocument()).toEqual(doc); expect(chat.attachments()).toBe(files); expect(chat.revert()?.messageID).toBe('boundary');
    expect(requests().some(input => /revert\/commit|\/interrupt\?|\/prompt\?/.test(input.path))).toBe(false);
    chat.historyBusy.set(true); expect(await chat.goal.controller.clear()).toBe('blocked'); chat.historyBusy.set(false);
    chat.queueEdit.set({ id: 'q', text: 'Recovered', files: [] }); expect(await chat.goal.controller.clear()).toBe('blocked'); chat.queueEdit.set(null);
    expect(commands()).toHaveLength(1);
  });
});

describe('production Goal send and durable resource safety', () => {
  it.each(['/goal ship the fix', '/GOAL pause', '/\u2003goal resume', '/goal'])('dispatches %s natively while busy without catalog, prompt, inbox chip or optimistic user', async text => {
    const { chat } = await chatOwner(); const normal = handle;
    handle = (path, method, body) => { if (path.startsWith('/api/command?')) throw new Error('catalog has no Goal'); return normal(path, method, body); };
    emit('session.execution.started', { sessionID: 's' });
    chat.inbox.set([{ id: 'queued', sessionID: 's' }]); chat.setDraftText(text);
    expect(await chat.send()).toBe(true);
    expect(commands()).toHaveLength(1); expect(commands()[0].body).toMatchObject({ name: 'goal', delivery: 'queue' });
    expect(commands()[0].body).not.toHaveProperty('id'); expect(chat.messages().some(message => message.role === 'user')).toBe(false);
    expect(requests().some(input => /\/prompt\?|\/interrupt\?|^\/api\/command\?/.test(input.path))).toBe(false);
    expect(chat.pendingSend()).toBeNull(); expect(chat.draft()).toBe('');
  });
  it('snapshots arm before prepare, sends true compiled resources, consumes only old resources and never a newer arm/document', async () => {
    const { chat } = await chatOwner();
    chat.setDraftText('Implement '); chat.insertReference({ kind: 'skill', value: 'old', label: 'Plan' });
    chat.attachments.set([{ uri: 'attachment://old', name: 'old.txt', mime: 'text/plain' }]);
    chat.goal.controller.setArmed(true); const arm = chat.goal.controller.captureArm();
    const gate = deferred<import('./model').CompiledSubmission>();
    const sending = chat.send({ goalArm: arm, prepare: () => gate.promise }); await flush();
    expect(chat.pendingSend()?.command?.name).toBe('goal');
    emit('session.execution.started', { sessionID: 's' });
    chat.setDraftText('New '); chat.insertReference({ kind: 'skill', value: 'new', label: 'New' }); const edited = chat.referenceDocument();
    chat.attachments.set([...chat.attachments(), { uri: 'attachment://new', name: 'new.txt', mime: 'text/plain' }]);
    chat.goal.controller.setArmed(true, 'New objective');
    gate.resolve({ text: 'Complete the captured plan', files: [{ uri: 'file:///repo/ref.ts', name: 'ref.ts' }], agents: [{ name: 'reviewer' }], skills: [{ id: 'old' }], metadata: { source: 'fixture' } });
    expect(await sending).toBe(true);
    expect(commands()[0].body).toEqual({ name: 'goal', text: 'Complete the captured plan', delivery: 'steer', files: [{ uri: 'file:///repo/ref.ts', name: 'ref.ts' }], agents: [{ name: 'reviewer' }], skills: [{ id: 'old' }] });
    expect(chat.referenceDocument()).toEqual(edited); expect(chat.attachments()).toEqual([{ uri: 'attachment://new', name: 'new.txt', mime: 'text/plain' }]);
    expect(chat.goal.state()).toMatchObject({ armed: true, objectiveOverride: 'New objective' });
  });
  it('typed Goal with default reference compiler keeps real files/agents/skills and strips only its captured command prefix', async () => {
    const { chat } = await chatOwner();
    chat.setDraftText('/goal Verify ');
    chat.insertReference({ kind: 'file', value: 'a b.ts', label: 'a b.ts' });
    chat.insertReference({ kind: 'agent', value: 'reviewer', label: 'reviewer' });
    chat.insertReference({ kind: 'skill', value: 'review', label: 'review' });
    expect(await chat.send()).toBe(true);
    expect(commands()[0].body).toMatchObject({ name: 'goal', files: [{ uri: 'file:///repo/a%20b.ts', name: 'a b.ts' }], agents: [{ name: 'reviewer' }], skills: [{ id: 'review' }] });
    expect(commands()[0].body.text).toContain('Verify'); expect(commands()[0].body.text).not.toMatch(/^\/goal/);
    expect(chat.references()).toEqual([]);
  });
  it('compiled ordinary text cannot promote Goal and a referenced /goal token is not authored command provenance', async () => {
    const { chat } = await chatOwner(); const normal = handle;
    handle = (path, method, body) => path.includes('/prompt?') ? { id: (body as { id: string }).id, sessionID: 's' } : normal(path, method, body);
    chat.setDraftText('ordinary'); expect(await chat.send({ prepare: async () => ({ text: '/goal not a command' }) })).toBe(true);
    expect(() => chat.setReferenceDocument({ text: '/goal inspect', scope: chat.referenceScope, references: [{ kind: 'skill', value: 'ref', label: 'Goal', display: '/goal', start: 0, end: 5 }] })).toThrow('native-reference-invalid');
    expect(commands()).toHaveLength(0);
    expect(requests().filter(input => input.path.includes('/prompt?'))).toHaveLength(1);
  });
  it('preparation failure freezes Goal identity/override across retry and restart instead of borrowing a new draft/arm', async () => {
    const { chat } = await chatOwner(); chat.setDraftText('Implement plan'); chat.goal.controller.setArmed(true, 'Complete original plan');
    expect(await chat.send({ prepare: async () => { throw new Error('preparation unavailable'); } })).toBe(false);
    expect(chat.pendingSend()).toMatchObject({ command: { name: 'goal', text: 'Complete original plan' }, preparedText: 'Complete original plan', uncertain: false });
    chat.setDraftText('New unrelated'); await chat.flushDraft();
    vi.resetModules(); const state = await import('./state'); await state.loadConnections(); const restored = state.createChat(scope); await restored.draftReady; await flush();
    expect(await restored.retrySend({ goalArm: { armed: true, objectiveOverride: 'Do not use' }, prepare: async input => {
      expect(input.text).toBe('Implement plan'); return { text: 'compiled old input', skills: [{ id: 'captured' }] };
    } })).toBe(true);
    expect(commands()[0].body).toMatchObject({ text: 'Complete original plan', skills: [{ id: 'captured' }] }); expect(restored.draft()).toBe('New unrelated');
  });
  it('lost Goal 204 acknowledgement remains unknown and is never reconciled/replayed as stable-ID prompt, including after restart', async () => {
    const { chat } = await chatOwner(); const normal = handle;
    handle = (path, method, body) => { if (path.includes('/command?')) throw new Error('lost ack'); return normal(path, method, body); };
    chat.setDraftText('Captured objective'); chat.goal.controller.setArmed(true);
    expect(await chat.send()).toBe(false); expect(chat.pendingSend()).toMatchObject({ command: { name: 'goal', text: 'Captured objective' }, uncertain: true });
    expect(chat.goal.state().armed).toBe(true); chat.setDraftText('New draft'); await chat.flushDraft(); const baseline = requests().length;
    expect(await chat.retrySend()).toBe(false); expect(await chat.recoverPendingSend()).toBe(false); expect(requests()).toHaveLength(baseline);
    vi.resetModules(); const state = await import('./state'); await state.loadConnections(); const restored = state.createChat(scope); await restored.draftReady; await flush();
    const beforeRetry = requests().length; expect(await restored.retrySend()).toBe(false); expect(requests()).toHaveLength(beforeRetry);
    expect(commands()).toHaveLength(1); expect(restored.draft()).toBe('New draft'); expect(restored.pendingSend()?.uncertain).toBe(true);
  });
  it('ACK followed by failed Goal RPC read consumes only the confirmed submission and never resends command', async () => {
    const { chat } = await chatOwner(true); const normal = handle;
    handle = (path, method, body) => { if (path.startsWith('/api/rpc/')) throw new Error('read offline'); return normal(path, method, body); };
    chat.setDraftText('Confirmed objective'); chat.goal.controller.setArmed(true);
    expect(await chat.send()).toBe(true); await flush();
    expect(chat.pendingSend()).toBeNull(); expect(chat.draft()).toBe(''); expect(chat.goal.state()).toMatchObject({ armed: false, readError: true, goal: initialGoal });
    await chat.retrySend(); expect(commands()).toHaveLength(1);
    expect(JSON.parse(harness.storage.get(chat.referenceScope.draft)!).pendingSend).toBeNull();
  });
  it('preserves definite transport status and arm, blocks IO on durable failure, enforces raw/compiled objective ceiling', async () => {
    const { chat } = await chatOwner(); const normal = handle;
    handle = (path, method, body) => { if (path.includes('/command?')) throw Object.assign(new Error('denied'), { status: 400 }); return normal(path, method, body); };
    chat.setDraftText('Retain me'); chat.goal.controller.setArmed(true);
    expect(await chat.send()).toBe(false); expect(chat.pendingSend()).toBeNull(); expect(chat.goal.state().armed).toBe(true); expect(chat.draft()).toBe('Retain me');
    handle = normal; harness.setItem.mockRejectedValueOnce(new Error('quota'));
    expect(await chat.send()).toBe(false); expect(commands()).toHaveLength(1); expect(chat.pendingSend()?.uncertain).toBe(false);
    chat.pendingSend.set(null); chat.setDraftText('x'.repeat(4001)); expect(await chat.send()).toBe(false); expect(commands()).toHaveLength(1);
    chat.setDraftText('short'); expect(await chat.send({ prepare: async () => ({ text: 'x'.repeat(4001) }) })).toBe(false);
    expect(chat.pendingSend()?.uncertain).toBe(false); expect(commands()).toHaveLength(1); expect(chat.draft()).toBe('short');
  });
  it('Goal composer preserves revert commit ordering and queueEdit/history fences', async () => {
    let marker = true; const normal = handle;
    handle = (path, method, body) => {
      if (/^\/api\/session\/s\?/.test(path)) return { id: 's', ...(marker ? { revert: { messageID: 'boundary' } } : {}) };
      if (path.includes('/revert/commit?')) { marker = false; return null; }
      return normal(path, method, body);
    };
    const { chat } = await chatOwner(); chat.setDraftText('/goal verify');
    chat.historyBusy.set(true); expect(await chat.send()).toBe(false); chat.historyBusy.set(false);
    chat.queueEdit.set({ id: 'q', text: 'queue', files: [] }); expect(await chat.send()).toBe(false); chat.queueEdit.set(null);
    expect(await chat.send()).toBe(true);
    const mutations = requests().filter(input => input.method === 'POST').map(input => input.path);
    expect(mutations).toEqual(['/api/session/s/revert/commit?directory=%2Frepo', '/api/session/s/command?directory=%2Frepo']);
  });
  it('an unknown ordinary prompt stays ordinary after later arming and retry uses its captured stable ID/resources', async () => {
    const { chat } = await chatOwner(); const normal = handle;
    handle = (path, method, body) => { if (path.includes('/prompt?')) throw new Error('unknown prompt'); return normal(path, method, body); };
    chat.setDraftText('Ordinary'); expect(await chat.send()).toBe(false); const pending = chat.pendingSend()!;
    chat.goal.controller.setArmed(true, 'New goal'); chat.setDraftText('New draft');
    handle = (path, method, body) => path.includes('/prompt?') ? { id: (body as { id: string }).id, sessionID: 's' } : path.includes(`/message/${pending.id}?`) ? (() => { throw Object.assign(new Error('not found'), { status: 404 }); })() : normal(path, method, body);
    expect(await chat.retrySend({ goalArm: chat.goal.controller.captureArm() })).toBe(true);
    expect(commands()).toHaveLength(0); expect(requests().filter(input => input.path.includes('/prompt?')).at(-1)?.body.id).toBe(pending.id);
    expect(chat.goal.state()).toMatchObject({ armed: true, objectiveOverride: 'New goal' }); expect(chat.draft()).toBe('New draft');
  });
  it('Host replacement during plain Goal preparation blocks every subsequent old-scope read/write without needing references', async () => {
    const { state, chat } = await chatOwner(); const gate = deferred<{ text: string }>();
    chat.setDraftText('Plain objective'); chat.goal.controller.setArmed(true);
    const sending = chat.send({ prepare: () => gate.promise }); await flush(); const baseline = requests().length;
    state.app.connection.set({ id: 'other', url: 'https://other.example', label: 'Other', lastUsedAt: 0 });
    gate.resolve({ text: 'Prepared objective' }); expect(await sending).toBe(false);
    expect(requests()).toHaveLength(baseline); expect(commands()).toHaveLength(0); expect(chat.draft()).toBe('Plain objective');
  });
  it('unknown panel action preserves unrelated content and is never replayed by generic retry', async () => {
    const { chat } = await chatOwner(true); const normal = handle;
    chat.setDraftText('Keep unrelated'); chat.attachments.set([{ uri: 'attachment://keep', name: 'keep', mime: 'text/plain' }]);
    handle = (path, method, body) => { if (path.includes('/command?')) throw new Error('panel ack lost'); return normal(path, method, body); };
    expect(await chat.goal.controller.clear()).toBe('failed'); expect(chat.draft()).toBe('Keep unrelated'); expect(chat.attachments()).toHaveLength(1);
    expect(chat.pendingSend()).toMatchObject({ text: '', files: [], command: { name: 'goal', text: 'clear' }, uncertain: true });
    expect(await chat.retrySend()).toBe(false); expect(commands()).toHaveLength(1); expect(chat.draft()).toBe('Keep unrelated');
  });
});

describe('production state Tasks authority and hot-path isolation', () => {
  const tool = (content: string, id = 'write') => ({ type: 'tool', id, name: 'todowrite', state: { status: 'completed', input: JSON.stringify({ todos: [{ content, status: 'in_progress', priority: 'medium' }] }) } });
  async function measuredTasks() {
    const module = await import('./chat-tasks-model');
    const scan = vi.fn(module.createTasksProjection());
    vi.spyOn(module, 'createTasksProjection').mockImplementation(() => scan);
    return { scan, summarize: module.summarizeTasks };
  }
  it('100 text deltas, 200 draft edits and busy-only status updates do zero extra projection scans or publications', async () => {
    const { scan, summarize } = await measuredTasks(); const normal = handle;
    const rawHistory = [{ id: 'stream-tail', type: 'assistant', content: [] }, ...Array.from({ length: 2000 }, (_, index) => ({ id: `history-${index}`, type: 'assistant', content: [{ type: 'text', text: `Body ${index}` }] })), { id: 'history', type: 'assistant', content: [tool('Historical task')] }];
    handle = (path, method, body) => path.includes('/message?') ? { data: rawHistory } : normal(path, method, body);
    const { chat } = await chatOwner();
    const tasks = chat.tasks(), baseline = scan.mock.calls.length;
    expect(tasks[0].content).toBe('Historical task'); expect(chat.busy()).toBe(false);
    const taskSource = harness.writes.findLast(write => write.value === tasks)!.source;
    const publications = harness.writes.filter(write => write.source === taskSource).length;
    for (let count = 0; count < 100; count++) emit('session.text.delta', { sessionID: 's', assistantMessageID: 'stream-tail', ordinal: 0, delta: 'x' });
    for (let count = 0; count < 200; count++) chat.setDraftText(`edit ${count}`);
    emit('session.status', { sessionID: 's', status: 'busy' });
    expect(summarize(chat.tasks(), chat.busy()).spinning).toBe(true); expect(chat.tasks()).toBe(tasks);
    emit('session.status', { sessionID: 's', status: 'idle' });
    expect(summarize(chat.tasks(), chat.busy()).spinning).toBe(false);
    await vi.advanceTimersByTimeAsync(350);
    expect(chat.messages().at(-1)?.text).toBe('x'.repeat(100)); expect(chat.tasks()).toBe(tasks);
    expect(scan).toHaveBeenCalledTimes(baseline);
    expect(harness.writes.filter(write => write.source === taskSource)).toHaveLength(publications);
    await chat.load(false, ['status']); expect(scan).toHaveBeenCalledTimes(baseline);
  });
  it('tool-domain updates project once per published batch; explicit empty clears and task states never set execution busy', async () => {
    const { scan } = await measuredTasks(); const normal = handle;
    handle = (path, method, body) => path.includes('/message?') ? { data: [{ id: 'history', type: 'assistant', content: [tool('Old plan')] }] } : normal(path, method, body);
    const { chat } = await chatOwner(); const baseline = scan.mock.calls.length;
    emit('session.tool.input.started', { sessionID: 's', assistantMessageID: 'new', id: 'write-new', name: 'todowrite' });
    emit('session.tool.called', { sessionID: 's', assistantMessageID: 'new', id: 'write-new', name: 'todowrite', input: { todos: [{ content: 'New plan', status: 'in_progress' }] } });
    await vi.advanceTimersByTimeAsync(32);
    expect(scan).toHaveBeenCalledTimes(baseline + 1); expect(chat.tasks()[0].content).toBe('New plan'); expect(chat.busy()).toBe(false);
    emit('session.tool.input.started', { sessionID: 's', assistantMessageID: 'new', id: 'write-clear', name: 'todowrite' });
    emit('session.tool.called', { sessionID: 's', assistantMessageID: 'new', id: 'write-clear', name: 'todowrite', input: { todos: [] } });
    await vi.advanceTimersByTimeAsync(32);
    expect(scan).toHaveBeenCalledTimes(baseline + 2); expect(chat.tasks()).toEqual([]); expect(chat.busy()).toBe(false);
  });
  it('failed history hydration preserves the derived list; successful empty authority clears it', async () => {
    const { scan } = await measuredTasks(); const normal = handle;
    handle = (path, method, body) => path.includes('/message?') ? { data: [{ id: 'history', type: 'assistant', content: [tool('Keep on failure')] }] } : normal(path, method, body);
    const { chat } = await chatOwner(); const previous = chat.tasks(), baseline = scan.mock.calls.length;
    handle = (path, method, body) => { if (path.includes('/message?')) throw new Error('read failure'); return normal(path, method, body); };
    await chat.load(false, ['messages']); expect(scan).toHaveBeenCalledTimes(baseline); expect(chat.tasks()).toBe(previous);
    handle = normal; await chat.load(false, ['messages']);
    expect(scan).toHaveBeenCalledTimes(baseline + 1); expect(chat.tasks()).toEqual([]);
  });
  it('projects real revert boundaries and clears on reset/Host retirement without using task history as activity', async () => {
    const { scan } = await measuredTasks(); const normal = handle;
    handle = (path, method, body) => path.includes('/message?') ? { data: [{ id: 'second', type: 'assistant', content: [tool('Later', 'two')] }, { id: 'first', type: 'assistant', content: [tool('Earlier', 'one')] }] } : normal(path, method, body);
    const { state, chat } = await chatOwner(); const baseline = scan.mock.calls.length;
    expect(chat.tasks()[0].content).toBe('Later');
    chat.revert.set({ messageID: 'second' }); expect(chat.tasks()[0].content).toBe('Earlier'); expect(scan).toHaveBeenCalledTimes(baseline + 1);
    chat.revert.set(null); expect(chat.tasks()).toEqual([]); expect(chat.historyRepairPending()).toBe(true);
    await chat.load(false, ['messages']); expect(chat.tasks()[0].content).toBe('Later');
    await state.loadConnections({ forceReconnect: true }); expect(chat.tasks()).toEqual([]); expect(chat.goal.state().goal).toBeNull();
    expect(chat.busy()).toBe(false);
  });
});
