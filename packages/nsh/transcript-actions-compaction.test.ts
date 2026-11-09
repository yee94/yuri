import { expect, it, vi } from 'vitest';
vi.mock('nsh', () => ({}));
import { createNativeCompactAction } from './transcript-actions-compaction';
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
function fixture(send = vi.fn(async () => ({ data: { id: 'c', sessionID: 's', type: 'compaction' } }))) {
  let generation = 0; const changed = vi.fn(), admitted = vi.fn();
  const action = createNativeCompactAction({ sessionID: 's', directory: '/repo', capture: () => { const captured = generation; return { current: () => generation === captured, send }; }, changed, admitted });
  return { action, send, changed, admitted, retire: () => { generation++; } };
}
it('uses the dedicated compact endpoint and exposes an admission barrier without waiting for execution', async () => {
  const f = fixture(); expect(await f.action.compact('queue')).toBe(true);
  expect(f.send).toHaveBeenCalledWith('/api/session/s/compact?directory=%2Frepo', 'POST', { delivery: 'queue' });
  expect(await f.action.waitForAdmission()).toBe(true); expect(f.action.barrier()).toBe(true);
  expect(await f.action.compact('steer')).toBe(false); expect(f.send).toHaveBeenCalledTimes(1);
  f.action.observe('session.compaction.ended'); expect(f.action.barrier()).toBe(true);
  await f.action.confirmAuthority({ items: [], running: false, idle: true }, f.action.revision());
  expect(f.action.barrier()).toBe(false); expect(f.action.receipt()).toBeNull();
});
it('captures admission immediately, so following work waits for the exact POST before dispatching', async () => {
  const gate = deferred<unknown>(); const f = fixture(vi.fn(() => gate.promise) as ReturnType<typeof fixture>['send']);
  const compact = f.action.compact('steer'), following = vi.fn();
  const followup = f.action.waitForAdmission().then(accepted => { if (accepted) following(); });
  await Promise.resolve(); expect(following).not.toHaveBeenCalled();
  gate.resolve({ id: 'c', sessionID: 's', type: 'compaction' }); await compact; await followup;
  expect(following).toHaveBeenCalledOnce();
});
it('an unidentified terminal before HTTP ACK cannot claim completion of the new inbox item', async () => {
  const gate = deferred<unknown>(); const f = fixture(vi.fn(() => gate.promise) as ReturnType<typeof fixture>['send']);
  const work = f.action.compact('queue'); f.action.observe('session.compaction.started'); f.action.observe('session.compaction.ended');
  gate.resolve({ id: 'c', sessionID: 's', type: 'compaction' }); expect(await work).toBe(true);
  expect(f.action.barrier()).toBe(true); expect(f.action.receipt()).toEqual({ status: 'acknowledged', inboxID: 'c' }); expect(f.admitted).toHaveBeenCalledOnce();
});
it('lost or malformed acknowledgement remains unknown and is never replayed by a terminal event', async () => {
  const f = fixture(vi.fn(async () => { throw new Error('lost ACK'); }));
  await expect(f.action.compact('queue')).rejects.toThrow('lost ACK');
  expect(f.action.receipt()?.status).toBe('unknown'); expect(await f.action.waitForAdmission()).toBe(false);
  f.action.observe('session.compaction.ended'); expect(await f.action.compact('queue')).toBe(false); expect(f.send).toHaveBeenCalledOnce();
});
it('late ACK from a retired lease does not publish or adopt into a resumed owner', async () => {
  const gate = deferred<unknown>(); const f = fixture(vi.fn(() => gate.promise) as ReturnType<typeof fixture>['send']);
  const work = f.action.compact('queue'); await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce()); const count = f.changed.mock.calls.length;
  f.retire(); gate.resolve({ id: 'c', sessionID: 's', type: 'compaction' }); expect(await work).toBe(false);
  expect(f.changed).toHaveBeenCalledTimes(count); expect(f.admitted).not.toHaveBeenCalled(); expect(await f.action.compact('queue')).toBe(false);
});
it('failed preflight performs zero writes and releases admission for later input', async () => {
  const f = fixture(); await expect(f.action.compact('queue', async () => { throw new Error('history unknown'); })).rejects.toThrow('history unknown');
  expect(f.send).not.toHaveBeenCalled(); expect(f.action.barrier()).toBe(false); expect(await f.action.waitForAdmission()).toBe(true);
});
it('durable unknown receipt survives remount without ever dispatching a replay', async () => {
  const send = vi.fn(async () => ({ id: 'c', sessionID: 's', type: 'compaction' }));
  const changed = vi.fn();
  const action = createNativeCompactAction({ sessionID: 's', directory: '/repo', capture: () => ({ current: () => true, send }), changed, admitted: vi.fn(),
    journal: { read: async () => ({ status: 'unknown' }), write: vi.fn(async () => {}) } });
  expect(await action.compact('queue')).toBe(false); expect(await action.waitForAdmission()).toBe(false);
  action.observe('session.compaction.ended'); expect(await action.compact('queue')).toBe(false); expect(send).not.toHaveBeenCalled();
});
it('atomic journal write failure retains unknown and cannot issue or retry the POST', async () => {
  const send = vi.fn(async () => ({}));
  const action = createNativeCompactAction({ sessionID: 's', directory: '/repo', capture: () => ({ current: () => true, send }), changed: vi.fn(), admitted: vi.fn(),
    journal: { read: async () => null, write: async () => { throw new Error('atomic write unknown'); } } });
  await expect(action.compact('queue')).rejects.toThrow('atomic write');
  expect(action.receipt()?.status).toBe('unknown'); expect(await action.compact('queue')).toBe(false); expect(send).not.toHaveBeenCalled();
});
it('acknowledged restoration allows follow-ups and authoritative missed-terminal recovery without replay', async () => {
  const send = vi.fn(async () => ({ id: 'new-c', sessionID: 's', type: 'compaction' })), writes = vi.fn(async () => {});
  const action = createNativeCompactAction({ sessionID: 's', directory: '/repo', capture: () => ({ current: () => true, send }), changed: vi.fn(), admitted: vi.fn(),
    journal: { read: async () => ({ status: 'acknowledged', inboxID: 'old-c' }), write: writes } });
  expect(await action.waitForAdmission()).toBe(true); expect(action.barrier()).toBe(true); expect(await action.compact('queue')).toBe(false);
  await action.confirmAuthority({ items: [], running: false, idle: true }, action.revision()); expect(action.barrier()).toBe(false);
  expect(await action.compact('queue')).toBe(true); expect(send).toHaveBeenCalledOnce();
});
it('unknown intent remains non-replayable while fresh authoritative idle/inbox admits new inputs', async () => {
  const send = vi.fn(async () => { throw new Error('lost ACK'); });
  const f = fixture(send); await expect(f.action.compact('queue')).rejects.toThrow();
  f.action.observe('session.compaction.ended'); expect(await f.action.waitForAdmission()).toBe(false);
  expect(await f.action.waitForAdmission(async () => { await f.action.confirmAuthority({ items: [], running: false, idle: true }, f.action.revision()); })).toBe(true);
  expect(f.action.receipt()?.status).toBe('unknown'); expect(f.action.barrier()).toBe(false);
  expect(await f.action.compact('queue')).toBe(false); expect(send).toHaveBeenCalledOnce();
});
it.each(['before', 'after'])('A terminal %s B ACK preserves queued B until an identity-checked authority snapshot', async order => {
  const gate = deferred<unknown>(), f = fixture(vi.fn(() => gate.promise) as ReturnType<typeof fixture>['send']);
  f.action.observe('session.compaction.started', { inputID: 'A' });
  // Compact B can be admitted while A is running: the caller's queue policy is captured.
  const work = f.action.compact('queue'); await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
  if (order === 'before') f.action.observe('session.compaction.ended', { inputID: 'A' });
  gate.resolve({ id: 'B', sessionID: 's', type: 'compaction' }); await work;
  if (order === 'after') f.action.observe('session.compaction.ended', { inputID: 'A' });
  expect(f.action.receipt()?.inboxID).toBe('B'); expect(f.action.barrier()).toBe(true);
  await f.action.confirmAuthority({ items: [{ id: 'B', sessionID: 's', type: 'compaction' }], running: false, idle: true }, f.action.revision());
  expect(f.action.receipt()?.inboxID).toBe('B'); expect(f.action.barrier()).toBe(true);
});
it('pending durable receipt clearing preserves ownership without sealing new ordinary input', async () => {
  const send = vi.fn(async () => ({ id: 'A', sessionID: 's', type: 'compaction' }));
  const clear = deferred<void>();
  const action = createNativeCompactAction({ sessionID: 's', directory: '/repo', capture: () => ({ current: () => true, send }), changed: vi.fn(), admitted: vi.fn(),
    journal: { read: async () => null, write: value => value ? Promise.resolve() : clear.promise } });
  await action.compact('queue');
  const settling = action.confirmAuthority({ items: [], running: false, idle: true }, action.revision());
  expect(await action.compact('queue')).toBe(false); expect(await action.waitForAdmission()).toBe(true);
  clear.resolve(); await settling; expect(action.receipt()).toBeNull();
});
it('a late failed clear cannot overwrite a newer receipt or erase its serialized write-ahead journal', async () => {
  let rejectSecond!: (error: Error) => void;
  const firstClear = deferred<void>(), secondClear = new Promise<void>((_resolve, reject) => { rejectSecond = reject; });
  let clears = 0; const durable: Array<string | null> = [];
  const send = vi.fn(async () => ({ id: send.mock.calls.length === 1 ? 'A' : 'B', sessionID: 's', type: 'compaction' }));
  const action = createNativeCompactAction({ sessionID: 's', directory: '/repo', capture: () => ({ current: () => true, send }), changed: vi.fn(), admitted: vi.fn(),
    journal: { read: async () => null, write: async value => { if (!value) await (++clears === 1 ? firstClear.promise : secondClear); durable.push(value?.status ?? null); } } });
  await action.compact('queue');
  const one = action.confirmAuthority({ items: [], running: false, idle: true }, action.revision());
  const two = action.confirmAuthority({ items: [], running: false, idle: true }, action.revision());
  const failure = expect(two).rejects.toThrow('late clear failure');
  firstClear.resolve(); await one;
  const next = action.compact('queue'); rejectSecond(new Error('late clear failure')); await failure;
  expect(await next).toBe(true); expect(action.receipt()).toEqual({ status: 'acknowledged', inboxID: 'B' });
  expect(durable.at(-1)).toBe('acknowledged'); expect(send).toHaveBeenCalledTimes(2);
});
