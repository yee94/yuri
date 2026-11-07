import { describe, expect, it, vi } from 'vitest';
import { createGoalController, createGoalTransport, decodeNativeGoal, planGoalSubmission, type GoalTransport, type NativeGoal } from './chat-goal-model';
import type { RuntimeEvent } from './model';

const scope = { sessionID: 'session/one', directory: '/workspace/with space' };
const goal: NativeGoal = { id: 'g', objective: 'Verify every change', status: 'active', rounds: 2, maxRounds: 20, boot: 'process', updatedAt: 10 };
const deferred = <T>() => { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const changed = (value: unknown, other: Partial<RuntimeEvent> = {}): RuntimeEvent => ({ key: 'global', directory: scope.directory, type: 'rpc.opencode.goal.changed', body: { sessionID: scope.sessionID, goal: value }, ...other });

describe('native Goal transport and submission boundary', () => {
  it('uses official raw RPC output and command, never prompt/inbox or a caller-generated id', async () => {
    const send = vi.fn(async () => ({ output: goal }));
    const transport = createGoalTransport(send);
    expect(await transport.get(scope)).toEqual(goal);
    expect(send).toHaveBeenNthCalledWith(1, '/api/rpc/opencode.goal/get?location%5Bdirectory%5D=%2Fworkspace%2Fwith%20space', 'POST', { input: { sessionID: 'session/one' } });
    await transport.command(scope, { name: 'goal', text: 'pause' });
    expect(send).toHaveBeenNthCalledWith(2, '/api/session/session%2Fone/command?directory=%2Fworkspace%2Fwith%20space', 'POST', { name: 'goal', text: 'pause' });
    await expect(createGoalTransport(async () => ({})).get(scope)).rejects.toThrow('RPC');
  });
  it('distinguishes absent, malformed and successful empty goal', () => {
    expect(decodeNativeGoal(null)).toBeNull();
    expect(decodeNativeGoal({ ...goal, reason: 'Review passed', stalls: 0 })).toMatchObject({ reason: 'Review passed', stalls: 0 });
    for (const value of [undefined, {}, { ...goal, status: 'blocked' }, { ...goal, rounds: NaN }, { ...goal, boot: undefined }, { ...goal, reason: 2 }]) expect(() => decodeNativeGoal(value)).toThrow();
  });
  it.each(['pause', 'resume', 'clear', 'Ship the complete implementation'])('preserves native /goal %s command semantics and chosen delivery', text => {
    expect(planGoalSubmission({ text: `/GoAl ${text}`, armed: false, delivery: 'queue' })).toEqual({ kind: 'command', command: { name: 'goal', text, delivery: 'queue' } });
  });
  it('keeps empty native /goal, validates 4000 characters without truncation or distillation', () => {
    expect(planGoalSubmission({ text: '/goal', armed: false })).toEqual({ kind: 'command', command: { name: 'goal', text: '' } });
    expect(planGoalSubmission({ text: 'x'.repeat(4000), armed: true }).kind).toBe('command');
    expect(planGoalSubmission({ text: 'x'.repeat(4001), armed: true })).toEqual({ kind: 'invalid', reason: 'limit' });
    expect(planGoalSubmission({ text: ' ', armed: true })).toEqual({ kind: 'invalid', reason: 'empty' });
  });
  it('preserves resources/override and does not hijack assistant or shell sends', () => {
    const resources = { files: [{ uri: 'file:///fixture.txt', name: 'fixture' }], agents: [{ name: 'build' }], skills: [{ id: 'review' }] };
    expect(planGoalSubmission({ text: 'Implement this plan', armed: true, objectiveOverride: 'Complete plan', delivery: 'steer', ...resources })).toEqual({ kind: 'command', command: { name: 'goal', text: 'Complete plan', delivery: 'steer', ...resources } });
    expect(planGoalSubmission({ text: '/goal inspect', armed: true, inputMode: 'shell' })).toEqual({ kind: 'ordinary' });
    expect(planGoalSubmission({ text: '/goal inspect', armed: true, sessionKind: 'assistant' })).toEqual({ kind: 'ordinary' });
    expect(planGoalSubmission({ text: 'ordinary', armed: false })).toEqual({ kind: 'ordinary' });
  });
});

describe('page-owned native Goal controller', () => {
  it('coalesces reads, preserves prior authority on failure, then accepts explicit null', async () => {
    const pending = deferred<unknown>();
    const get = vi.fn<GoalTransport['get']>().mockImplementationOnce(() => pending.promise).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(null);
    const owner = createGoalController(scope, { get, command: vi.fn() });
    const first = owner.refresh(), second = owner.refresh();
    expect(second).toBe(first); expect(get).toHaveBeenCalledTimes(1);
    pending.resolve(goal); await first;
    await owner.refresh(); expect(owner.state()).toMatchObject({ goal, resolved: true, readError: true, loading: false });
    await owner.refresh(); expect(owner.state()).toMatchObject({ goal: null, resolved: true, readError: false });
  });
  it('a changed event fences an older GET, including authoritative clear', async () => {
    const pending = deferred<unknown>();
    const owner = createGoalController(scope, { get: () => pending.promise, command: vi.fn() });
    const read = owner.refresh();
    expect(owner.event(changed({ ...goal, status: 'paused', updatedAt: 11 }))).toBe(true);
    pending.resolve(goal); await read;
    expect(owner.state().goal?.status).toBe('paused'); expect(owner.state().loading).toBe(false);
    owner.event(changed(null)); expect(owner.state().goal).toBeNull();
  });
  it('ignores malformed/unrelated events and fences Host/active cancellation', async () => {
    let current = true;
    const pending = deferred<unknown>();
    const owner = createGoalController(scope, { get: () => pending.promise, command: vi.fn() }, () => current);
    const read = owner.refresh();
    expect(owner.event(changed(goal, { directory: '/other' }))).toBe(false);
    expect(owner.event(changed(goal, { body: { sessionID: 'other', goal } }))).toBe(false);
    expect(owner.event(changed({}))).toBe(true); expect(owner.state().resolved).toBe(false);
    current = false; owner.cancel(); pending.resolve(goal); await read;
    expect(owner.state()).toMatchObject({ goal: null, resolved: false, loading: false });
  });
  it('pause/resume/clear have no delivery, no optimistic goal or interrupt, complete cannot toggle', async () => {
    const command = vi.fn<GoalTransport['command']>().mockResolvedValue(undefined);
    const owner = createGoalController(scope, { get: async () => ({ ...goal, status: 'paused' }), command });
    owner.event(changed(goal)); await owner.toggle();
    expect(command).toHaveBeenLastCalledWith(scope, { name: 'goal', text: 'pause' });
    await owner.toggle(); expect(command).toHaveBeenLastCalledWith(scope, { name: 'goal', text: 'resume' });
    await owner.clear(); expect(command).toHaveBeenLastCalledWith(scope, { name: 'goal', text: 'clear' });
    owner.event(changed({ ...goal, status: 'complete' }));
    expect(await owner.toggle()).toBe('blocked'); expect(command).toHaveBeenCalledTimes(3);
  });
  it('invalidates pre-command reads and treats failed reread as acknowledged, not permission to resend', async () => {
    const initial = deferred<unknown>();
    const get = vi.fn<GoalTransport['get']>().mockImplementationOnce(() => initial.promise).mockRejectedValueOnce(new Error('read failed'));
    const command = vi.fn<GoalTransport['command']>().mockResolvedValue(undefined);
    const owner = createGoalController(scope, { get, command });
    const read = owner.refresh(); owner.setArmed(true, 'Objective');
    expect(await owner.command({ name: 'goal', text: 'Objective', delivery: 'queue' }, true)).toBe('acknowledged');
    initial.resolve(goal); await read;
    expect(command).toHaveBeenCalledTimes(1); expect(get).toHaveBeenCalledTimes(2);
    expect(owner.state()).toMatchObject({ armed: false, goal: null, readError: true, resolved: false, busy: false });
  });
  it('failed command preserves arm/snapshot, deduplicates busy actions, and does not silently retry', async () => {
    const pending = deferred<unknown>(), command = vi.fn(() => pending.promise), get = vi.fn();
    const owner = createGoalController(scope, { get, command });
    owner.event(changed(goal)); owner.setArmed(true, 'Objective');
    const first = owner.command({ name: 'goal', text: 'Objective' }, true);
    expect(await owner.clear()).toBe('blocked');
    pending.reject(new Error('ambiguous transport')); expect(await first).toBe('failed');
    expect(owner.state()).toMatchObject({ armed: true, objectiveOverride: 'Objective', goal, actionError: true, busy: false });
    expect(command).toHaveBeenCalledTimes(1); expect(get).not.toHaveBeenCalled();
  });
  it('does not reuse a reconnect read started before command acknowledgement', async () => {
    const write = deferred<unknown>(), reconnect = deferred<unknown>();
    const get = vi.fn<GoalTransport['get']>().mockImplementationOnce(() => reconnect.promise).mockResolvedValueOnce({ ...goal, status: 'paused' });
    const owner = createGoalController(scope, { get, command: () => write.promise });
    owner.event(changed(goal)); const command = owner.toggle();
    const oldRead = owner.refresh(); write.resolve(undefined);
    expect(await command).toBe('acknowledged'); expect(get).toHaveBeenCalledTimes(2);
    reconnect.resolve(goal); await oldRead;
    expect(owner.state().goal?.status).toBe('paused');
  });
  it('does not consume newly rearmed UI state or write after cancellation', async () => {
    const pending = deferred<unknown>(); let current = true;
    const owner = createGoalController(scope, { get: async () => goal, command: () => pending.promise }, () => current);
    owner.setArmed(true, 'Old'); const first = owner.command({ name: 'goal', text: 'Old' }, true);
    owner.setArmed(true, 'New'); pending.resolve(undefined); await first;
    expect(owner.state()).toMatchObject({ armed: true, objectiveOverride: 'New' });
    const later = deferred<unknown>();
    const secondOwner = createGoalController(scope, { get: vi.fn(), command: () => later.promise }, () => current);
    secondOwner.setArmed(true); const second = secondOwner.clear(); current = false; secondOwner.cancel(); later.resolve(undefined);
    expect(await second).toBe('stale'); expect(secondOwner.state()).toMatchObject({ busy: false, armed: true });
  });
  it('inactive and unmaterialized draft owners do no IO', async () => {
    const transport = { get: vi.fn(), command: vi.fn() };
    const hidden = createGoalController(scope, transport, () => false);
    const draft = createGoalController({ ...scope, sessionID: '' }, transport);
    await hidden.refresh(); await draft.refresh();
    expect(await hidden.clear()).toBe('blocked'); expect(await draft.clear()).toBe('blocked');
    expect(transport.get).not.toHaveBeenCalled(); expect(transport.command).not.toHaveBeenCalled();
  });
  it('enforces the objective ceiling at the controller too, not only in the UI planner', async () => {
    const transport = { get: vi.fn(), command: vi.fn() };
    const owner = createGoalController(scope, transport);
    expect(await owner.command({ name: 'goal', text: 'x'.repeat(4001) })).toBe('blocked');
    expect(transport.command).not.toHaveBeenCalled(); expect(owner.state().actionError).toBe(true);
  });
  it('a captured arm from another owner cannot consume a matching local revision or objective', async () => {
    const transport = { get: async () => goal, command: vi.fn(async () => undefined) };
    const first = createGoalController(scope, transport), second = createGoalController(scope, transport);
    first.setArmed(true, 'Same'); second.setArmed(true, 'Same');
    expect(await second.command({ name: 'goal', text: 'Same' }, true, { armSnapshot: first.captureArm() })).toBe('acknowledged');
    expect(second.state()).toMatchObject({ armed: true, objectiveOverride: 'Same' });
  });
});
