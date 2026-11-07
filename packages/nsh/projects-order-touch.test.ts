import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProjectsSessionDrag, type ProjectsSessionDragProjection } from './projects-order-touch';

const touch = (y: number, x = 20, count = 1, identifier = 1) => ({ identifier, pageX: x, pageY: y, touches: Array.from({ length: count }, (_, i) => ({ identifier: i + 1 })) });
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function fixture(count = 3) {
  let generation = 1, current = true, offset = 0, locked = false, max = 1000;
  const members = Array.from({ length: count }, (_, i) => `s${i}`);
  const frames = members.map((id, i) => ({ id, y: i * 68, height: i % 2 ? 80 : 48 }));
  // Variable natural row heights with 12pt gaps.
  for (let i = 1; i < frames.length; i++) frames[i]!.y = frames[i - 1]!.y + frames[i - 1]!.height + 12;
  const measures = frames.map(frame => vi.fn(async () => ({ pagePosition: { x: 12, y: frame.y }, bounds: { size: { width: 300, height: frame.height } } })));
  const geometry = new Map(members.map((id, i) => [id, { measure: measures[i]! }]));
  const ids = vi.fn(() => [...members]), commit = vi.fn(), changed = vi.fn<(value: ProjectsSessionDragProjection | null) => void>();
  const scrollTo = vi.fn((y: number) => { offset = y; });
  const viewport = vi.fn(async () => ({ top: 0, height: 200 }));
  const release = vi.fn(() => { locked = false; });
  const claim = vi.fn(() => { if (locked) return null; locked = true; return release; });
  const options = { ids, geometry, current: () => current, generation: () => generation, changed, commit,
    scroll: { viewport, offset: () => offset, max: () => max, scrollTo, claim } };
  const drag = createProjectsSessionDrag(options);
  return { drag, options, commit, changed, measures, viewport, ids, members, geometry, frames, scrollTo, release, claim,
    retire: () => { generation++; }, hide: () => { current = false; }, offset: (y: number) => { offset = y; }, max: (value: number) => { max = value; }, locked: () => locked,
    last: () => changed.mock.calls.at(-1)?.[0], hold: async (id = 's0', y = 24) => { drag.start(id, touch(y)); await vi.advanceTimersByTimeAsync(350); await settle(); } };
}
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('homepage body hold-to-sort production owner', () => {
  it('arms at 350ms, measures natural rectangles once and takes native scrolling only after hold', async () => {
    const f = fixture(); f.drag.start('s0', touch(24));
    await vi.advanceTimersByTimeAsync(349); expect(f.claim).not.toHaveBeenCalled(); expect(f.measures[0]).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await settle();
    expect(f.drag.claimed('s0')).toBe(true); expect(f.last()).toMatchObject({ id: 's0', x: 12, y: 0, width: 300, height: 48 });
    expect(f.claim).toHaveBeenCalledOnce(); expect(f.viewport).toHaveBeenCalledOnce(); f.measures.forEach(measure => expect(measure).toHaveBeenCalledOnce());
    f.drag.dispose(); expect(f.release).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it.each([[0, 7], [7, 0], [5, 5]])('lets a quick swipe/scroll exceeding 6pt cancel the candidate (%s,%s)', async (dx, dy) => {
    const f = fixture(); f.drag.start('s0', touch(24)); f.drag.move('s0', touch(24 + dy, 20 + dx));
    await vi.advanceTimersByTimeAsync(500);
    expect(f.claim).not.toHaveBeenCalled(); expect(f.commit).not.toHaveBeenCalled(); expect(f.drag.claimed('s0')).toBe(false); expect(vi.getTimerCount()).toBe(0);
  });
  it('keeps the 6pt tolerance inclusive and does not turn a tap into a menu or drag', async () => {
    const f = fixture(); f.drag.start('s0', touch(24)); f.drag.move('s0', touch(30));
    f.drag.finish('s0', touch(30, 20, 0)); await vi.advanceTimersByTimeAsync(500);
    expect(f.drag.consumeClick('s0')).toBe(false); expect(f.commit).not.toHaveBeenCalled(); expect(f.claim).not.toHaveBeenCalled();
  });
  it('drops against measured variable heights, shifts siblings, and suppresses only the drag click', async () => {
    const f = fixture(); await f.hold();
    f.drag.move('s0', touch(100));
    expect(f.last()?.over).toBe('s1'); expect(f.last()?.shifts.get('s1')).toBe(-60);
    f.drag.finish('s0', touch(100, 20, 0)); f.drag.finish('s0', touch(100, 20, 0));
    expect(f.commit).toHaveBeenCalledExactlyOnceWith('s0', 's1');
    expect(f.drag.consumeClick('s0')).toBe(true); expect(f.drag.consumeClick('s0')).toBe(false); expect(f.locked()).toBe(false);
  });
  it('does not shift dimensions or recompute sibling shifts until the closest target changes', async () => {
    const f = fixture(); await f.hold(); f.drag.move('s0', touch(100)); const shifts = f.last()?.shifts;
    f.drag.move('s0', touch(101)); expect(f.last()?.shifts).toBe(shifts); expect(f.last()).toMatchObject({ x: 12, width: 300, height: 48 });
    f.drag.dispose();
  });
  it.each(['generation', 'hide', 'cancel', 'dispose', 'membership', 'order', 'multitouch', 'finger'])('cancels %s without a write or a stranded scroll lock', async reason => {
    const f = fixture(); await f.hold(); f.drag.move('s0', touch(100));
    if (reason === 'generation') f.retire();
    if (reason === 'hide') f.hide();
    if (reason === 'cancel') f.drag.cancel();
    if (reason === 'dispose') f.drag.dispose();
    if (reason === 'membership') { f.members.pop(); f.drag.reconcile(f.members); }
    if (reason === 'order') { f.members.reverse(); f.drag.reconcile(f.members); }
    if (reason === 'multitouch') f.drag.move('s0', touch(100, 20, 2));
    if (reason === 'finger') f.drag.move('s0', touch(100, 20, 1, 2));
    f.drag.finish('s0', touch(100, 20, 0)); await vi.advanceTimersByTimeAsync(50);
    expect(f.commit).not.toHaveBeenCalled(); expect(f.locked()).toBe(false); expect(vi.getTimerCount()).toBe(0);
  });
  it('rejects missing geometry and never falls back to a guessed row stride', async () => {
    const f = fixture(); f.geometry.delete('s1'); await f.hold();
    expect(f.drag.claimed('s0')).toBe(false); expect(f.locked()).toBe(false); expect(f.commit).not.toHaveBeenCalled();
  });
  it('does not let late measurement revive a released, closed, or newer gesture', async () => {
    const f = fixture(); let resolve!: (value: Awaited<ReturnType<typeof f.viewport>>) => void;
    f.viewport.mockImplementation(() => new Promise(done => { resolve = done; }));
    f.drag.start('s0', touch(24)); await vi.advanceTimersByTimeAsync(350);
    f.drag.finish('s0', touch(100, 20, 0)); f.drag.start('s1', touch(100));
    resolve({ top: 0, height: 200 }); await settle();
    expect(f.changed).not.toHaveBeenCalled(); expect(f.commit).not.toHaveBeenCalled(); expect(f.locked()).toBe(false); f.drag.dispose();
  });
  it('has a bounded move/drop budget with 500 loaded rows and 240 moves', async () => {
    const f = fixture(500); await f.hold(); const reads = f.ids.mock.calls.length;
    for (let i = 0; i < 240; i++) f.drag.move('s0', touch(100 + i / 1000));
    expect(f.ids).toHaveBeenCalledTimes(reads); f.measures.forEach(measure => expect(measure).toHaveBeenCalledOnce());
    expect(f.commit).not.toHaveBeenCalled(); f.drag.finish('s0', touch(100, 20, 0)); expect(f.commit).toHaveBeenCalledOnce();
  });
  it('scrolls at the measured viewport edge and updates collision from adopted scroll offset while the finger stays held', async () => {
    const f = fixture(12); await f.hold(); f.drag.move('s0', touch(190));
    await vi.advanceTimersByTimeAsync(16); const initial = f.last()?.over;
    expect(f.scrollTo).toHaveBeenCalledOnce(); expect(f.scrollTo.mock.calls[0]![0]).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(320); expect(f.last()?.over).not.toBe(initial);
    f.drag.finish('s0', touch(190, 20, 0)); expect(f.commit).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it('awaits actual native offset before issuing another scroll command', async () => {
    const f = fixture(12); f.scrollTo.mockImplementation(() => {}); await f.hold(); f.drag.move('s0', touch(190));
    await vi.advanceTimersByTimeAsync(160); expect(f.scrollTo).toHaveBeenCalledOnce();
    f.offset(f.scrollTo.mock.calls[0]![0]); await vi.advanceTimersByTimeAsync(16); expect(f.scrollTo).toHaveBeenCalledTimes(2);
    f.drag.cancel();
  });
  it('clamps top and bottom autoscroll and does not run an idle hold loop', async () => {
    const f = fixture(); f.max(0); await f.hold(); f.drag.move('s0', touch(190)); await vi.advanceTimersByTimeAsync(64);
    expect(f.scrollTo).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0); f.drag.cancel();
    const top = fixture(); top.offset(100); await top.hold('s1', 100); top.drag.move('s1', touch(10)); await vi.advanceTimersByTimeAsync(16);
    expect(top.scrollTo.mock.calls[0]![0]).toBeLessThan(100); top.drag.cancel();
  });
  it('keeps independent scopes and refuses another group while the root scroll is owned', async () => {
    const f = fixture(); await f.hold();
    const otherCommit = vi.fn(), other = createProjectsSessionDrag({ ...f.options, ids: () => ['x', 'y'], commit: otherCommit });
    other.start('x', touch(20)); await vi.advanceTimersByTimeAsync(350);
    expect(other.claimed('x')).toBe(false); other.finish('x', touch(120, 20, 0)); expect(otherCommit).not.toHaveBeenCalled();
    expect(f.locked()).toBe(true); f.drag.cancel(); other.dispose();
  });
  it('does not arm a single-row or foreign-identity list', async () => {
    const f = fixture(1); await f.hold(); expect(f.claim).not.toHaveBeenCalled();
    const other = fixture(); await other.hold('foreign'); expect(other.claim).not.toHaveBeenCalled();
  });
});
