import { describe, expect, it, vi } from 'vitest';
import { createDesktopTabEventGate, desktopTabHitRect, type DesktopTabEventBinding } from './desktop-panel-tabs-events-core';
import { createDesktopPanelTabsInteraction } from './desktop-panel-tabs-core';
import { createDesktopPanelTabs } from './desktop-panel-model';

const expectedHost = { hostID: 'synthetic', lease: '00000000-0000-4000-8000-000000000001' };
const rect = { x: 10, y: 10, width: 60, height: 24 };
function fixture(windows = true) {
  let b: DesktopTabEventBinding = { owner: 'synthetic-owner', generation: 1, revision: 1, active: true, expectedHost, rect };
  let current = true, enabled = true, modal = false;
  const calls: string[] = [], middle = vi.fn(), focus = vi.fn(() => { calls.push('target.blur'); calls.push('focused:true'); }), blur = vi.fn();
  const gate = createDesktopTabEventGate({ binding: () => b, current: () => current, enabled: () => enabled, modal: () => modal, windows, middle, focus, blur });
  return { gate, middle, focus, blur, calls, value: (sequence = 1) => ({ owner: b.owner, generation: b.generation, revision: b.revision, expectedHost: b.expectedHost, sequence }),
    binding: (patch: Partial<DesktopTabEventBinding>) => { b = { ...b, ...patch }; }, retire: () => { current = false; }, disable: () => { enabled = false; }, modal: () => { modal = true; } };
}
describe('native tab event admission, not a close command', () => {
  it('clips actual tab targets to viewport, excludes close/rail areas and rejects invisible/nonfinite geometry', () => {
    expect(desktopTabHitRect(rect, { x: 20, y: 0, width: 30, height: 24 })).toEqual({ x: 20, y: 10, width: 30, height: 14 });
    expect(desktopTabHitRect(rect, { x: 70, y: 0, width: 30, height: 24 })).toBeNull();
    expect(desktopTabHitRect({ ...rect, x: NaN }, rect)).toBeNull();
  });
  it('accepts one increasing native receipt, refuses native-supplied ids and replay', () => {
    const f = fixture();
    expect(f.gate.event('middleClose', { ...f.value(), id: 'forged-tab' })).toBe(false);
    expect(f.gate.event('middleClose', f.value())).toBe(true); expect(f.middle).toHaveBeenCalledOnce();
    expect(f.gate.event('middleClose', f.value())).toBe(false); expect(f.middle).toHaveBeenCalledOnce();
  });
  it('checks current, active, enabled, modal, scope/lease, owner, generation and layout fences before close', () => {
    for (const mode of ['retire', 'disable', 'modal', 'inactive', 'owner', 'generation', 'revision', 'lease', 'host', 'dispose'] as const) {
      const f = fixture(), event = f.value();
      if (mode === 'retire' || mode === 'disable' || mode === 'modal') f[mode]();
      else if (mode === 'inactive') f.binding({ active: false });
      else if (mode === 'owner') f.binding({ owner: 'new-owner' });
      else if (mode === 'generation' || mode === 'revision') f.binding({ [mode]: 2 });
      else if (mode === 'lease') f.binding({ expectedHost: { ...expectedHost, lease: 'new-lease' } });
      else if (mode === 'host') f.binding({ expectedHost: { ...expectedHost, hostID: 'new-host' } });
      else f.gate.dispose();
      expect(f.gate.event('middleClose', event), mode).toBe(false); expect(f.middle).not.toHaveBeenCalled();
    }
  });
  it('native focus only clears Input editing and enables strip bindings on Windows, blur clears even when disabled; Mac does neither', () => {
    const f = fixture(); f.gate.event('tabFocus', f.value()); expect(f.calls).toEqual(['target.blur', 'focused:true']);
    f.disable(); f.gate.event('tabBlur', f.value(2)); expect(f.blur).toHaveBeenCalledOnce();
    const mac = fixture(false); mac.gate.event('tabFocus', mac.value()); mac.gate.event('tabBlur', mac.value(2));
    expect(mac.focus).not.toHaveBeenCalled(); expect(mac.blur).not.toHaveBeenCalled();
  });
  it('the captured closure delegates exact id through interaction.requestClose async guard; rejection retains the tab', async () => {
    const tabs = createDesktopPanelTabs(), scope = { host: expectedHost, authorityKey: 'auth', sessionID: 'session-a', directory: '/workspace' };
    const id = tabs.open(scope, { kind: 'file', path: 'dirty.ts' });
    const requestClose = vi.fn(async () => { await Promise.resolve(); return false; });
    const interaction = createDesktopPanelTabsInteraction({ tabs: { ...tabs, requestClose }, scope: () => scope, current: () => true });
    let done: Promise<unknown> | undefined;
    const b: DesktopTabEventBinding = { owner: 'owner', generation: 1, revision: 1, active: true, expectedHost, rect };
    const gate = createDesktopTabEventGate({ binding: () => b, current: () => true, enabled: () => true, modal: () => false, windows: true,
      middle: () => { done = interaction.pointerClose(id, 'middle'); }, focus: () => {}, blur: () => {} });
    gate.event('middleClose', { owner: 'owner', generation: 1, revision: 1, expectedHost, sequence: 1 });
    await done; expect(requestClose).toHaveBeenCalledExactlyOnceWith(scope, id); expect(tabs.snapshot(scope).tabs[0].id).toBe(id);
  });
});
