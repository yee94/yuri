import { expect, it, vi } from 'vitest';
import { messageFrom, type Message } from './model';
import { nativeHistoryStep, type NativeHistoryRead } from './transcript-history-operation';

const user = (id: string) => messageFrom({ id, type: 'user', text: id })!;
function fixture(initial: NativeHistoryRead) {
  let state = initial;
  const stage = vi.fn(async (_message: Message) => ({ status: 'accepted' as const })), clear = vi.fn(async () => ({ status: 'accepted' as const }));
  return { stage, clear, set: (value: NativeHistoryRead) => { state = value; }, run: (redo: boolean, loadOlder?: () => Promise<void>, current = () => true) => nativeHistoryStep({ redo, invocation: { current }, read: () => state, loadOlder, stage, clear }) };
}
const full = (ids: string[], marker?: string): NativeHistoryRead => ({ messages: ids.map(user), revertMessageID: marker, complete: true, more: false, loading: false, error: false });
it('uses conversation sequence for successive undo/redo, not string ID order', async () => {
  const f = fixture(full(['z', 'a', 'm'], 'a'));
  expect((await f.run(false)).status).toBe('accepted'); expect(f.stage.mock.calls[0]?.[0]).toEqual(user('z'));
  expect((await f.run(true)).status).toBe('accepted'); expect(f.stage.mock.calls[1]?.[0]).toEqual(user('m')); expect(f.clear).not.toHaveBeenCalled();
  f.set(full(['z', 'a', 'm'], 'm')); await f.run(true); expect(f.clear).toHaveBeenCalledOnce();
});
it('loads actual older pages serially before deciding that redo may clear', async () => {
  const f = fixture({ ...full(['m'], 'missing'), complete: false, more: true });
  let inflight = 0, maximum = 0, calls = 0;
  const load = vi.fn(async () => {
    inflight++; maximum = Math.max(maximum, inflight); await Promise.resolve();
    f.set(++calls === 1 ? { ...full(['a', 'm'], 'missing'), complete: false, more: true } : full(['missing', 'a', 'm'], 'missing'));
    inflight--;
  });
  expect((await f.run(true, load)).status).toBe('accepted'); expect(load).toHaveBeenCalledTimes(2); expect(maximum).toBe(1);
  expect(f.stage.mock.calls[0]?.[0]).toEqual(user('a')); expect(f.clear).not.toHaveBeenCalled();
});
it.each(['absent', 'failed', 'stalled', 'missing-marker'] as const)('rejects incomplete history (%s) instead of fabricating the last redo step', async mode => {
  const f = fixture({ ...full(['tail'], 'missing'), complete: mode === 'missing-marker', more: true });
  const load = mode === 'absent' ? undefined : async () => { if (mode === 'failed') throw new Error('Read failed'); };
  expect(await f.run(true, load)).toEqual({ status: 'rejected', reason: 'history-incomplete' });
  expect(f.stage).not.toHaveBeenCalled(); expect(f.clear).not.toHaveBeenCalled();
});
it('does not mutate after invocation retirement during an older-page read', async () => {
  const f = fixture({ ...full(['tail']), complete: false, more: true }); let current = true;
  expect(await f.run(false, async () => { f.set(full(['prior', 'tail'])); current = false; }, () => current)).toEqual({ status: 'rejected', reason: 'stale' });
  expect(f.stage).not.toHaveBeenCalled(); expect(f.clear).not.toHaveBeenCalled();
});
