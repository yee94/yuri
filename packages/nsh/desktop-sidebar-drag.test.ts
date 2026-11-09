import { describe, expect, it, vi } from 'vitest';
import { createDesktopSidebarDrag, desktopSidebarDragKey, type DesktopSidebarDragTarget } from './desktop-sidebar-drag';

const row = (id: string, scope = '/synthetic', kind: DesktopSidebarDragTarget['kind'] = 'session'): DesktopSidebarDragTarget => ({ id, scope, kind });
const source = row('z'), target = row('a');
function fixture() {
  let live = true, generation = 'first', targets = [source, target, row('other', '/other'), row('tree', '/synthetic', 'worktree')];
  const measure = vi.fn(async (value: DesktopSidebarDragTarget) => ({ left: 10, top: value.id === 'z' ? 10 : 50, width: 200, height: 30 }));
  const changed = vi.fn(), commit = vi.fn();
  const owner = createDesktopSidebarDrag({ current: () => live, generation: () => generation, targets: () => targets, measure, changed, commit });
  return { owner, measure, changed, commit, retire: () => { live = false; }, switchHost: () => { generation = 'other'; }, removeTarget: () => { targets = [source]; } };
}
describe('desktop native mouse/pan drag owner', () => {
  it('measures only compatible rows, gives live feedback, commits the actual release target once', async () => {
    const f = fixture(); f.owner.arm(source, { x: 100, y: 25 }); f.owner.begin();
    await f.owner.move({ x: 100, y: 65 }, 'left');
    expect(f.changed).toHaveBeenLastCalledWith({ active: desktopSidebarDragKey(source), over: desktopSidebarDragKey(target) });
    expect(f.measure.mock.calls.map(([value]) => value)).toEqual([source, target]);
    expect(f.commit).not.toHaveBeenCalled();
    await f.owner.end({ x: 0, y: 40 }, false); await f.owner.end({ x: 0, y: 40 }, false);
    expect(f.commit).toHaveBeenCalledExactlyOnceWith({ kind: 'session', scope: '/synthetic', active: 'z', over: 'a' });
  });
  it('uses release translation even with no final mouse move, while a click is never a drag', async () => {
    const f = fixture(); f.owner.arm(source, { x: 100, y: 25 });
    await f.owner.end({ x: 0, y: 40 }, false); expect(f.commit).not.toHaveBeenCalled();
    f.owner.arm(source, { x: 100, y: 25 }); f.owner.begin();
    await f.owner.end({ x: 0, y: 40 }, false); expect(f.commit).toHaveBeenCalledOnce();
  });
  it('outside rect, cancelled, released button and removed row all reject drop', async () => {
    for (const mode of ['outside', 'cancelled', 'released', 'removed', 'leave'] as const) {
      const f = fixture(); f.owner.arm(source, { x: 100, y: 25 }); f.owner.begin();
      if (mode === 'released') await f.owner.move({ x: 100, y: 65 }, null);
      if (mode === 'removed') f.removeTarget();
      if (mode === 'leave') f.owner.cancel();
      await f.owner.end({ x: mode === 'outside' ? 500 : 0, y: 40 }, mode === 'cancelled');
      expect(f.commit).not.toHaveBeenCalled();
    }
  });
  it('fences deferred geometry after Host/background/structure retirement', async () => {
    for (const mode of ['retire', 'switchHost', 'cancel'] as const) {
      const f = fixture(); let release!: () => void;
      const deferred = new Promise<void>(resolve => { release = resolve; });
      f.measure.mockImplementation(async () => { await deferred; return { left: 10, top: 50, width: 200, height: 30 }; });
      f.owner.arm(source, { x: 100, y: 25 }); f.owner.begin();
      const ending = f.owner.end({ x: 0, y: 40 }, false);
      if (mode === 'cancel') f.owner.cancel(); else f[mode]();
      const notifications = f.changed.mock.calls.length; release(); await ending;
      expect(f.commit).not.toHaveBeenCalled(); expect(f.changed).toHaveBeenCalledTimes(notifications);
    }
  });
  it('caps measurement concurrency at two and does no layout work on repeated mouse moves', async () => {
    const targets = Array.from({ length: 100 }, (_, i) => row(String(i)));
    let pending = 0, maximum = 0;
    const measure = vi.fn(async (value: DesktopSidebarDragTarget) => {
      pending++; maximum = Math.max(maximum, pending); await Promise.resolve(); pending--;
      return { left: 0, top: Number(value.id) * 30, width: 200, height: 30 };
    });
    const owner = createDesktopSidebarDrag({ current: () => true, generation: () => 'first', targets: () => targets, measure, changed: () => {}, commit: () => {} });
    owner.arm(targets[0]!, { x: 100, y: 15 }); owner.begin();
    await owner.move({ x: 100, y: 65 }, 'left');
    for (let i = 0; i < 50; i++) await owner.move({ x: 100, y: 65 }, 'left');
    expect(maximum).toBe(2); expect(measure).toHaveBeenCalledTimes(100);
  });
  it('measurement errors and missing sources never produce a write', async () => {
    const f = fixture(); f.owner.arm(row('missing'), { x: 100, y: 25 }); f.owner.begin();
    expect(f.measure).not.toHaveBeenCalled();
    f.measure.mockRejectedValueOnce(new Error('unmounted')); f.owner.arm(source, { x: 100, y: 25 }); f.owner.begin();
    await f.owner.end({ x: 0, y: 40 }, false); expect(f.commit).not.toHaveBeenCalled();
  });
});
