import { expect, it, vi } from 'vitest';
import { createNativeAvatarClock } from './assistants-avatar-clock';

function setup() {
  let now = 0, serial = 0;
  const pending = new Map<number, () => void>();
  const sources: Array<{ sample: ReturnType<typeof vi.fn>; setResting: ReturnType<typeof vi.fn>; settled: ReturnType<typeof vi.fn>; still: ReturnType<typeof vi.fn> }> = [];
  const frames = vi.fn((seed: string) => {
    let frame = 0;
    const source = { sample: vi.fn(() => `${seed}:${frame++}`), setResting: vi.fn(), settled: vi.fn(() => false), still: vi.fn(() => `${seed}:still`) };
    sources.push(source); return source;
  });
  const clock = createNativeAvatarClock({ frames, clock: { now: () => now, schedule: work => { const id = ++serial; pending.set(id, work); return id; }, cancel: handle => { pending.delete(handle as number); } } });
  function step(ms = 1000 / 30) { now += ms; const callbacks = [...pending.values()]; pending.clear(); callbacks.forEach(work => work()); }
  return { clock, pending, sources, frames, step };
}
it('twenty same-Bot faces share one player, one model and one SVG per paint, independent of consumer count', () => {
  const s = setup(), consumers = Array.from({ length: 20 }, () => vi.fn());
  const leases = consumers.map(paint => s.clock.subscribe('host', 'bot', 'seed', paint));
  expect(s.frames).toHaveBeenCalledTimes(1); expect(s.sources[0].sample).toHaveBeenCalledTimes(1); expect(s.pending.size).toBe(1);
  s.step(); expect(s.sources[0].sample).toHaveBeenCalledTimes(2);
  consumers.forEach(paint => expect(paint.mock.calls.at(-1)?.[0]).toEqual({ uri: 'seed:1', settled: false }));
  leases.forEach(lease => lease.release()); expect(s.pending.size).toBe(0);
});
it('a newly visible face joins the exact current URI without advancing/restarting the timeline', () => {
  const s = setup(), first = vi.fn(), next = vi.fn();
  s.clock.subscribe('host', 'bot', 'seed', first); s.step(); s.step();
  s.clock.subscribe('host', 'bot', 'seed', next);
  expect(next.mock.calls[0][0]).toEqual(first.mock.calls.at(-1)?.[0]); expect(s.sources[0].sample).toHaveBeenCalledTimes(3);
});
it('different Hosts, identities and recipes never reuse another Bot timeline, but use one timer', () => {
  const s = setup();
  s.clock.subscribe('A', 'one', 'seed', () => {}); s.clock.subscribe('B', 'one', 'seed', () => {});
  s.clock.subscribe('A', 'two', 'seed', () => {}); s.clock.subscribe('A', 'one', 'new-seed', () => {});
  expect(s.frames).toHaveBeenCalledTimes(4); expect(s.pending.size).toBe(1);
  s.step(); s.sources.forEach(source => expect(source.sample).toHaveBeenCalledTimes(2));
});
it('work completion settles only after every sharer stops, then returns canonical still and stops scheduling', () => {
  const s = setup(), first = vi.fn(), second = vi.fn();
  const a = s.clock.subscribe('host', 'bot', 'seed', first), b = s.clock.subscribe('host', 'bot', 'seed', second);
  a.working(false); expect(s.sources[0].setResting).not.toHaveBeenCalled();
  b.working(false); expect(s.sources[0].setResting).toHaveBeenLastCalledWith(true);
  s.sources[0].settled.mockReturnValue(true); s.step();
  expect(first.mock.calls.at(-1)?.[0]).toEqual({ uri: 'seed:still', settled: true });
  expect(second.mock.calls.at(-1)?.[0]).toEqual({ uri: 'seed:still', settled: true });
  expect(s.pending.size).toBe(0);
});
it('resumed work preserves the same player and removes resting state without an independent blink', () => {
  const s = setup(), lease = s.clock.subscribe('host', 'bot', 'seed', () => {});
  lease.working(false); s.step(); lease.working(true); s.step();
  expect(s.frames).toHaveBeenCalledTimes(1); expect(s.sources[0].setResting.mock.calls).toEqual([[true], [false]]);
});
it('all hidden/unmounted releases all timer work; foreground resumes without replaying background time', () => {
  const s = setup(), lease = s.clock.subscribe('host', 'bot', 'seed', () => {});
  lease.release(); lease.release(); expect(s.pending.size).toBe(0);
  s.step(60000); expect(s.sources[0].sample).toHaveBeenCalledTimes(1);
  const next = s.clock.subscribe('host', 'bot', 'seed', () => {});
  expect(s.frames).toHaveBeenCalledTimes(2); expect(s.sources[1].sample.mock.calls[0]).toEqual([0]);
  s.step(3000); expect(s.sources[1].sample.mock.calls[1]).toEqual([0.1]); next.release();
});
