import { describe, expect, it, vi } from 'vitest';
import { createDesktopSettingsContentProtection, createSettingsNavigationOwner, desktopSettingsIntegratedPages, requestDesktopSettingsContentLeave, type SettingsNavigationOwner } from './desktop-settings-content-core';
import { createDesktopSettingsGuard } from './desktop-settings-core';

function fixture() {
  let active = true, dirty = false, pending = false, picker = false, stamp: object = {}, scope: object = {};
  const confirm = vi.fn(async () => true), unavailable = vi.fn(async () => {}), changed = vi.fn();
  const protection = createDesktopSettingsContentProtection({ page: 'appearance', active: () => active, changed, unavailable });
  const owner: SettingsNavigationOwner = { dirty: () => dirty, pending: () => pending, nestedPickerOpen: () => false, requestLeave: confirm, stamp: () => [stamp], scope: () => scope };
  return { protection, owner, confirm, unavailable, changed, register: () => protection.registerOwner(owner),
    setDirty: (value: boolean) => { dirty = value; }, setPending: (value: boolean) => { pending = value; },
    setPicker: (value: boolean) => { picker = value; }, registerPicker: () => protection.registerPicker(() => picker),
    setActive: (value: boolean) => { active = value; }, edit: () => { stamp = {}; }, switchScope: () => { scope = {}; },
  };
}
describe('desktop content protection from actual owner publishers', () => {
  it('lists real integrated owners and keeps the injected desktop slot opt-in', () => {
    expect(desktopSettingsIntegratedPages).toEqual(expect.arrayContaining(['appearance', 'chat', 'notifications', 'projects', 'providers', 'agents', 'commands', 'mcp', 'plugins', 'skills.installed', 'sessions', 'summary-ai', 'behavior', 'voice', 'instances', 'git', 'usage', 'about', 'archived-sessions', 'magic-prompts']));
    expect(desktopSettingsIntegratedPages).not.toContain('shortcuts');
    const f = fixture();
    expect(f.protection.snapshot()).toMatchObject({ status: 'unavailable', dirty: null, pending: null, nestedPickerOpen: null });
  });
  it('allows clean pages to close and navigate, without even opening a discard confirmation', async () => {
    const f = fixture(); f.register(); const close = vi.fn(), navigate = vi.fn();
    expect(f.protection.snapshot()).toMatchObject({ status: 'ready', blocked: false, pending: false, dirty: false, nestedPickerOpen: false });
    expect(await requestDesktopSettingsContentLeave(f.protection.snapshot(), close)).toBe(true);
    expect(await requestDesktopSettingsContentLeave(f.protection.snapshot(), navigate)).toBe(true);
    expect(close).toHaveBeenCalledOnce(); expect(navigate).toHaveBeenCalledOnce(); expect(f.confirm).not.toHaveBeenCalled();
  });
  it('uses the real owner confirmation; a denial retains the same draft and never commits navigation', async () => {
    const f = fixture(); f.register(); f.setDirty(true); f.confirm.mockResolvedValueOnce(false);
    const commit = vi.fn();
    expect(await requestDesktopSettingsContentLeave(f.protection.snapshot(), commit)).toBe(false);
    expect(commit).not.toHaveBeenCalled(); expect(f.protection.snapshot().dirty).toBe(true);
    expect(await requestDesktopSettingsContentLeave(f.protection.snapshot(), commit)).toBe(true);
    expect(f.confirm).toHaveBeenCalledTimes(2); expect(commit).toHaveBeenCalledOnce();
  });
  it('aggregates independent shared lifetime pending and picker owners, removing them on cleanup', async () => {
    const f = fixture(); f.register(); let otherPending = true;
    const stopPending = f.protection.registerPending(() => otherPending), stopPicker = f.registerPicker();
    expect(await f.protection.requestLeave()).toBe(false);
    otherPending = false; f.setPicker(true);
    expect(f.protection.snapshot()).toMatchObject({ pending: false, nestedPickerOpen: true });
    expect(await f.protection.requestLeave()).toBe(false);
    stopPicker(); stopPending(); expect(await f.protection.requestLeave()).toBe(true);
    f.setPending(true); expect(await f.protection.requestLeave()).toBe(false);
  });
  it('unknown draft coverage gives feedback rather than fake clean or an invented pending lock', async () => {
    const f = fixture(); f.protection.registerPending(() => false);
    expect(f.protection.snapshot()).toMatchObject({ pending: false, dirty: null, status: 'unavailable' });
    expect(await f.protection.requestLeave()).toBe(false); expect(f.unavailable).toHaveBeenCalledOnce();
    f.register(); expect(await f.protection.requestLeave()).toBe(true);
  });
  it.each(['edit', 'pending', 'picker', 'inactive', 'retired', 'unregistered', 'scope'] as const)('fences late confirmation after %s', async kind => {
    const f = fixture(), remove = f.register(); f.registerPicker(); f.setDirty(true);
    let resolve!: (value: boolean) => void;
    f.confirm.mockImplementation(() => new Promise<boolean>(done => { resolve = done; }));
    const waiting = f.protection.requestLeave();
    if (kind === 'edit') f.edit();
    if (kind === 'pending') f.setPending(true);
    if (kind === 'picker') f.setPicker(true);
    if (kind === 'inactive') f.setActive(false);
    if (kind === 'retired') f.protection.dispose();
    if (kind === 'unregistered') remove();
    if (kind === 'scope') f.switchScope();
    resolve(true); expect(await waiting).toBe(false);
  });
  it('accepts normal approved draft cleanup without accepting a changed Host scope', async () => {
    const f = fixture(); f.register(); f.setDirty(true);
    f.confirm.mockImplementationOnce(async () => { f.setDirty(false); f.edit(); return true; });
    expect(await f.protection.requestLeave()).toBe(true);
    f.setDirty(true);
    f.confirm.mockImplementationOnce(async () => { f.setDirty(false); f.edit(); f.switchScope(); return true; });
    expect(await f.protection.requestLeave()).toBe(false);
  });
  it('deduplicates confirmation and unlocks after failure', async () => {
    const f = fixture(); f.register(); f.setDirty(true);
    let resolve!: (value: boolean) => void;
    f.confirm.mockImplementationOnce(() => new Promise<boolean>(done => { resolve = done; }));
    const waiting = f.protection.requestLeave();
    expect(await f.protection.requestLeave()).toBe(false); resolve(true); expect(await waiting).toBe(true);
    f.confirm.mockRejectedValueOnce(new Error('confirmation failed'));
    await expect(f.protection.requestLeave()).rejects.toThrow('confirmation failed');
    expect(await f.protection.requestLeave()).toBe(true);
  });
  it('integrates Window.confirmDiscard without marking the discard dialog as a pending write', async () => {
    const f = fixture(); f.register(); f.setDirty(true); const close = vi.fn();
    const guard = createDesktopSettingsGuard({ snapshot: () => ({ open: true, active: true, pending: f.protection.snapshot().pending === true, dirty: f.protection.snapshot().dirty !== false, nestedPickerOpen: f.protection.snapshot().nestedPickerOpen === true, route: { page: 'appearance' } }), confirmDiscard: f.protection.requestLeave, onClose: close, onNavigate: () => {} });
    expect(await guard.request({ kind: 'close' })).toBe(true); expect(close).toHaveBeenCalledOnce();
  });
});

describe('shared real editor confirmation owner', () => {
  it('keeps a denied draft and rejects changed input or scope during confirmation', async () => {
    let draft = 'edited', scope: object = {}, pending = false, active = true;
    const confirm = vi.fn(async () => false);
    const owner = createSettingsNavigationOwner({ current: () => active, scope: () => scope, stamp: () => [draft], dirty: () => draft !== 'saved', pending: () => pending, nestedPickerOpen: () => false, confirm });
    expect(await owner.requestLeave()).toBe(false); expect(draft).toBe('edited');
    confirm.mockImplementationOnce(async () => { draft = 'newer input'; return true; });
    expect(await owner.requestLeave()).toBe(false);
    confirm.mockImplementationOnce(async () => { scope = {}; return true; });
    expect(await owner.requestLeave()).toBe(false);
    confirm.mockResolvedValue(true); expect(await owner.requestLeave()).toBe(true);
    pending = true; expect(await owner.requestLeave()).toBe(false);
    pending = false; active = false; expect(await owner.requestLeave()).toBe(false);
  });
  it('does not prompt for clean input; permits approved own cleanup but never overlaps confirmations', async () => {
    let dirty = false, stamp: object = {};
    const confirm = vi.fn(async () => true);
    const owner = createSettingsNavigationOwner({ current: () => true, scope: () => null, stamp: () => [stamp], dirty: () => dirty, pending: () => false, nestedPickerOpen: () => false, confirm });
    expect(await owner.requestLeave()).toBe(true); expect(confirm).not.toHaveBeenCalled();
    dirty = true;
    let resolve!: (value: boolean) => void;
    confirm.mockImplementationOnce(() => new Promise<boolean>(done => { resolve = done; }));
    const first = owner.requestLeave(); expect(await owner.requestLeave()).toBe(false);
    dirty = false; stamp = {}; resolve(true); expect(await first).toBe(true);
  });
});
