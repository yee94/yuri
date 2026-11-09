import { describe, expect, it, vi } from 'vitest';
import { createDesktopPanelTabs, desktopPanelScopeKey, type DesktopPanelScope } from './desktop-panel-model';
import { createDesktopPanelTabDrag, createDesktopPanelTabsInteraction, desktopPanelTabPresentation, desktopPanelTabsKeymapAllowed } from './desktop-panel-tabs-core';
const scope: DesktopPanelScope = { host: { hostID: 'synthetic', lease: 'lease-a' }, authorityKey: 'auth-a', sessionID: 'session-a', directory: '/workspace' };
function fixture() {
  let current = true, activeScope = scope;
  const tabs = createDesktopPanelTabs(), ids = ['a.ts', 'b.ts', 'c.ts', 'd.ts'].map(path => tabs.open(scope, { kind: 'file', path }));
  const requestClose = vi.fn(async (captured: DesktopPanelScope, id: string) => tabs.close(captured, id));
  const owner = createDesktopPanelTabsInteraction({ tabs: { ...tabs, requestClose }, scope: () => activeScope, current: () => current });
  return { tabs, ids, owner, requestClose, retire: () => { current = false; }, switch: (next: DesktopPanelScope) => { activeScope = next; } };
}
describe('single-owner panel strip interactions', () => {
  it('preserves the existing file/browser/preview/context/diff icons and staged only for staged workspace sources', () => {
    const tabs = createDesktopPanelTabs();
    for (const intent of [
      { kind: 'file' as const, path: 'a.ts' }, { kind: 'browser' as const, url: 'https://example.invalid/' },
      { kind: 'preview' as const, path: 'index.html' }, { kind: 'context' as const },
      { kind: 'chat' as const, target: { sessionID: 'readonly-session', directory: '/workspace', title: 'Synthetic session' } },
      { kind: 'diff' as const, source: { kind: 'workspace' as const, directory: '/workspace', staged: true } },
      { kind: 'diff' as const, source: { kind: 'workspace' as const, directory: '/workspace', staged: false } },
      { kind: 'diff' as const, source: { kind: 'turn' as const, directory: '/workspace', sessionID: 'session-a', messageID: 'turn-a', files: [] } },
    ]) tabs.open(scope, intent);
    expect(tabs.snapshot(scope).tabs.map(desktopPanelTabPresentation)).toEqual([
      { icon: 'file-code', staged: false }, { icon: 'globe', staged: false }, { icon: 'eye', staged: false },
      { icon: 'pie-chart', staged: false }, { icon: 'chat-thread', staged: false }, { icon: 'file-edit', staged: true }, { icon: 'file-edit', staged: false }, { icon: 'file-edit', staged: false },
    ]);
  });
  it('excludes native menu physical strokes including platform mod and reordered/case aliases, not unrelated shortcuts', () => {
    for (const apple of [true, false]) {
      for (const owned of ['mod+w', apple ? 'CMD+W' : 'CTRL+W']) expect(desktopPanelTabsKeymapAllowed('mod+w', [owned], apple)).toBe(false);
      expect(desktopPanelTabsKeymapAllowed('mod+w', [apple ? 'ctrl+w' : 'ctrl+shift+w'], apple)).toBe(true);
      expect(desktopPanelTabsKeymapAllowed('alt+shift+left', ['SHIFT+ALT+ArrowLeft'], apple)).toBe(false);
      expect(desktopPanelTabsKeymapAllowed('right', ['ArrowRight'], apple)).toBe(false);
      expect(desktopPanelTabsKeymapAllowed('home', ['mod+w'], apple)).toBe(true);
      expect(desktopPanelTabsKeymapAllowed('mod+w', [], apple)).toBe(true);
    }
  });
  it('reorders by position, preserves tab/source references and selection; invalid moves are no-ops', () => {
    const f = fixture(), value = f.tabs.snapshot(scope), spy = vi.fn(); f.tabs.subscribe(spy);
    expect(f.owner.reorder(f.ids[0], f.ids[2])).toBe(true);
    expect(f.tabs.snapshot(scope).tabs).toEqual([value.tabs[1], value.tabs[2], value.tabs[0], value.tabs[3]]);
    expect(f.tabs.snapshot(scope).tabs[2]).toBe(value.tabs[0]); expect(f.tabs.snapshot(scope).selectedID).toBe(value.selectedID);
    expect(f.owner.reorder('missing', f.ids[2])).toBe(false); expect(f.owner.reorder(f.ids[1], f.ids[1])).toBe(false); expect(spy).toHaveBeenCalledOnce();
  });
  it('bulk close serially delegates every real async guard, retains refusals/errors and never rolls back completed items', async () => {
    const f = fixture(), calls: string[] = [];
    f.requestClose.mockImplementation(async (captured, id) => { calls.push(id); await Promise.resolve(); if (id === f.ids[1]) return false; if (id === f.ids[2]) throw new Error('guard failed'); return f.tabs.close(captured, id); });
    const result = await f.owner.close(f.ids[0], 'all');
    expect(calls).toEqual(f.ids); expect(result).toEqual({ closed: [f.ids[0], f.ids[3]], retained: [f.ids[1], f.ids[2]], interrupted: false });
    expect(f.tabs.snapshot(scope).tabs.map(tab => tab.id)).toEqual([f.ids[1], f.ids[2]]);
  });
  it('others/right use captured order (including reorder) and ignore tabs opened during a guard', async () => {
    const f = fixture(); f.owner.reorder(f.ids[3], f.ids[0]);
    f.requestClose.mockImplementation(async (captured, id) => { f.tabs.open(scope, { kind: 'context' }); return f.tabs.close(captured, id); });
    const result = await f.owner.close(f.ids[0], 'right'); expect(result.closed).toEqual([f.ids[1], f.ids[2]]);
    expect(f.tabs.snapshot(scope).tabs.map(tab => tab.id)).toEqual([f.ids[3], f.ids[0], 'context']);
    expect((await f.owner.close(f.ids[0], 'others')).closed).toEqual([f.ids[3], 'context']);
  });
  it('shares bulk flight, prevents concurrent selection/reorder, stops future guards on stale scope/lease, preserving partial result', async () => {
    const f = fixture(); let release!: () => void;
    f.requestClose.mockImplementation(async (captured, id) => { await new Promise<void>(done => { release = done; }); return f.tabs.close(captured, id); });
    const result = f.owner.close(f.ids[0], 'all'); await Promise.resolve();
    expect(f.owner.close(f.ids[2], 'close')).toBe(result); expect(f.owner.select(f.ids[1])).toBe(false); expect(f.owner.reorder(f.ids[1], f.ids[2])).toBe(false);
    f.switch({ ...scope, host: { ...scope.host, lease: 'renewed' } }); release();
    expect(await result).toEqual({ closed: [f.ids[0]], retained: f.ids.slice(1), interrupted: true }); expect(f.requestClose).toHaveBeenCalledTimes(1);
    expect(f.tabs.snapshot({ ...scope, sessionID: 'other' }).tabs).toEqual([]);
  });
  it('supports scoped keyboard selection/reorder and middle action port only through requestClose', async () => {
    const f = fixture(); f.owner.navigate('first'); expect(f.tabs.snapshot(scope).selectedID).toBe(f.ids[0]);
    f.owner.navigate('previous'); expect(f.tabs.snapshot(scope).selectedID).toBe(f.ids[3]);
    f.owner.navigate('previous', true); expect(f.tabs.snapshot(scope).tabs[2].id).toBe(f.ids[3]);
    expect(f.owner.pointerClose(f.ids[0], 'left')).toBeUndefined(); await f.owner.pointerClose(f.ids[0], 'middle'); expect(f.requestClose).toHaveBeenCalledWith(scope, f.ids[0]);
    f.retire(); f.owner.navigate('first'); expect(f.owner.select(f.ids[1])).toBe(false); expect((await f.owner.close(f.ids[1])).interrupted).toBe(true);
  });
});
describe('native pan geometry and cancellation', () => {
  function dragFixture() {
    let current = true, generation = desktopPanelScopeKey(scope), ids = ['a', 'b', 'c'];
    const measure = vi.fn(async (id: string) => ({ x: ids.indexOf(id) * 100, y: 10, width: 100, height: 30 }));
    const changed = vi.fn(), reorder = vi.fn();
    const drag = createDesktopPanelTabDrag({ current: () => current, generation: () => generation, ids: () => ids, measure, changed, reorder });
    return { drag, measure, changed, reorder, retire: () => { current = false; }, generation: () => { generation = 'other'; }, mutate: () => { ids = ['b', 'a', 'c']; } };
  }
  it('measures once, follows actual release translation without a final move, and preserves exact intended order', async () => {
    const f = dragFixture(); f.drag.arm('a', { x: 50, y: 25 }); f.drag.begin(); await f.drag.move({ x: 150, y: 25 }, 'left');
    await f.drag.end({ x: 200, y: 0 }, false); expect(f.reorder).toHaveBeenCalledWith('a', 'c'); expect(f.measure).toHaveBeenCalledTimes(3);
  });
  it('cancels on actual cancel, changed membership/order, generation/authority loss or non-left movement', async () => {
    for (const mode of ['cancel', 'mutate', 'generation', 'retire', 'middle'] as const) {
      const f = dragFixture(); f.drag.arm('a', { x: 50, y: 25 }); f.drag.begin();
      if (mode === 'mutate' || mode === 'generation' || mode === 'retire') f[mode]();
      if (mode === 'middle') await f.drag.move({ x: 250, y: 25 }, 'middle');
      await f.drag.end({ x: 200, y: 0 }, mode === 'cancel'); expect(f.reorder).not.toHaveBeenCalled();
    }
  });
  it('256-tab gesture bounds measurement concurrency and never remeasures on high-frequency moves', async () => {
    const ids = Array.from({ length: 256 }, (_, index) => String(index)); let running = 0, peak = 0;
    const measure = vi.fn(async (id: string) => { running++; peak = Math.max(peak, running); await Promise.resolve(); running--; return { x: Number(id) * 40, y: 0, width: 40, height: 24 }; });
    const drag = createDesktopPanelTabDrag({ current: () => true, generation: () => 'stable', ids: () => ids, measure, changed: vi.fn(), reorder: vi.fn() });
    drag.arm('0', { x: 20, y: 12 }); drag.begin(); for (let index = 0; index < 30; index++) await drag.move({ x: 60 + index, y: 12 }, 'left');
    await drag.end({ x: 80, y: 0 }, false); expect(measure).toHaveBeenCalledTimes(256); expect(peak).toBeLessThanOrEqual(2);
  });
});
