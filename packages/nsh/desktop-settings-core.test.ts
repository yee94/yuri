import { describe, expect, it, vi } from 'vitest';
import { clampDesktopSettingsNavigation, createDesktopSettingsGuard, desktopSettingsDestination, desktopSettingsGeometry, desktopSettingsRows, type DesktopSettingsGuardSnapshot } from './desktop-settings-core';
import { createSelectKeyboard } from './select-keyboard';
import { dict as en } from '../ui/src/lib/i18n/messages/en';
import { dict as uk } from '../ui/src/lib/i18n/messages/uk';

const entries = [
  { page: 'appearance', title: 'settings.page.appearance.title', group: 'personalization' },
  { page: 'chat', title: 'settings.page.chat.title', group: 'personalization' },
  { page: 'git', title: 'settings.page.git.title', group: 'workspace' },
  { page: 'plugins', title: 'settings.page.plugins.title', group: 'opencode' },
] as const;
const translate = (key: keyof typeof en) => en[key];
describe('desktop Settings pure geometry, catalog and keyboard', () => {
  it('uses 90vw/85vh with independent maximums, with no mobile page sizing', () => {
    expect(desktopSettingsGeometry(1000, 800)).toEqual({ width: 900, height: 680 });
    expect(desktopSettingsGeometry(2400, 1600)).toEqual({ width: 1200, height: 900 });
    expect(desktopSettingsGeometry(400, 300)).toEqual({ width: 360, height: 255 });
    expect(desktopSettingsGeometry(-1, NaN)).toEqual({ width: 0, height: 0 });
    expect([100, 176, 224, 280, 400, NaN].map(clampDesktopSettingsNavigation)).toEqual([176, 176, 224, 280, 280, 224]);
  });
  it('preserves registry/group order, all pages on empty query, and configured plugins', () => {
    const rows = desktopSettingsRows(entries, '   ', translate);
    expect(rows.map(row => row.value)).toEqual(['page:appearance', 'page:chat', 'page:git', 'page:plugins']);
    expect(rows.map(row => row.group)).toEqual(['personalization', 'personalization', 'workspace', 'opencode']);
    expect(new Set(rows.map(row => row.value)).size).toBe(rows.length);
  });
  it('reuses field keywords and stable targets; page and field availability agree', () => {
    expect(desktopSettingsRows(entries, 'messageStreamTransport', translate)).toEqual([
      expect.objectContaining({ value: 'field:chat.message-transport', route: { page: 'chat', target: 'chat.message-transport' }, subtitle: en['settings.page.chat.title'] }),
    ]);
    expect(desktopSettingsRows(entries, 'messageStreamTransport', translate, ['appearance'])).toEqual([]);
    expect(desktopSettingsRows(entries, 'definitely-no-result', translate)).toEqual([]);
    expect(desktopSettingsRows(entries, '', translate, [])).toEqual([]);
  });
  it('uses real translated labels, including non-English multiword queries', () => {
    const rows = desktopSettingsRows(entries, '', key => uk[key]);
    expect(rows[0].title).toBe(uk['settings.page.appearance.title']);
    expect(rows[0].title).not.toBe(en['settings.page.appearance.title']);
    expect(desktopSettingsRows(entries, uk['settings.page.appearance.title'].toLocaleUpperCase(), key => uk[key])).toContainEqual(expect.objectContaining({ value: 'page:appearance' }));
  });
  it('clears stale entity/create/target without changing the captured directory', () => {
    expect(desktopSettingsDestination({ page: 'agents', entity: 'old', create: true, target: 'old', directory: '/worktree' }, { page: 'chat', target: 'chat.message-transport' })).toEqual({ page: 'chat', target: 'chat.message-transport', directory: '/worktree' });
    expect(desktopSettingsDestination({ page: 'git' }, { page: 'chat' })).toEqual({ page: 'chat', directory: undefined });
  });
  it('preserves an archived session explicit directory instead of the settings entry directory', () => {
    expect(desktopSettingsDestination({ page: 'archived-sessions', directory: '/workspace-a' }, { page: 'archived-sessions', entity: 'session-b', directory: '/workspace-b' }))
      .toEqual({ page: 'archived-sessions', entity: 'session-b', directory: '/workspace-b' });
  });
  it('moves/wraps and Enter chooses the highlighted result, not a stale filtered row', () => {
    let rows = desktopSettingsRows(entries, '', translate), highlighted: string | null = null;
    const choose = vi.fn();
    const keyboard = createSelectKeyboard({ items: () => rows, selected: () => 'page:appearance', choose, focus: value => { highlighted = value; } });
    keyboard.sync(); keyboard.move('up'); expect(highlighted).toBe('page:plugins');
    keyboard.move('down'); expect(highlighted).toBe('page:appearance');
    rows = desktopSettingsRows(entries, 'messageStreamTransport', translate);
    keyboard.choose(); expect(choose).toHaveBeenLastCalledWith('field:chat.message-transport');
    rows = []; keyboard.choose(); expect(choose).toHaveBeenCalledTimes(1);
  });
});

function setup(dirty = false, confirmDiscard?: () => boolean | Promise<boolean>) {
  let snapshot: DesktopSettingsGuardSnapshot = { open: true, active: true, pending: false, dirty, nestedPickerOpen: false, route: { page: 'appearance', directory: '/worktree' } };
  const close = vi.fn(), navigate = vi.fn(), error = vi.fn(), busy = vi.fn();
  const guard = createDesktopSettingsGuard({ snapshot: () => snapshot, confirmDiscard, onClose: close, onNavigate: navigate, onError: error, onBusy: busy });
  return { guard, close, navigate, error, busy, change: (patch: Partial<DesktopSettingsGuardSnapshot>) => { snapshot = { ...snapshot, ...patch }; } };
}
describe('owner-only closing and dirty navigation', () => {
  it('calls the upper owner but never mutates open or the route itself', async () => {
    const s = setup();
    expect(await s.guard.request({ kind: 'navigate', route: { page: 'chat', target: 'chat.message-transport' } })).toBe(true);
    expect(s.navigate).toHaveBeenCalledWith({ page: 'chat', target: 'chat.message-transport', directory: '/worktree' });
    expect(await s.guard.request({ kind: 'close' })).toBe(true);
    expect(s.close).toHaveBeenCalledTimes(1);
    expect(s.navigate).toHaveBeenCalledTimes(1);
  });
  it.each([{ pending: true }, { open: false }, { active: false }, { nestedPickerOpen: true }])('fails closed for %j', async patch => {
    const s = setup(); s.change(patch);
    expect(await s.guard.request({ kind: 'close' })).toBe(false);
    expect(await s.guard.request({ kind: 'navigate', route: { page: 'chat' } })).toBe(false);
    expect(s.close).not.toHaveBeenCalled(); expect(s.navigate).not.toHaveBeenCalled();
  });
  it('requires explicit dirty approval and suppresses no-op navigation', async () => {
    const missing = setup(true), denied = setup(true, () => false), approved = setup(true, () => true);
    expect(await missing.guard.request({ kind: 'close' })).toBe(false);
    expect(await denied.guard.request({ kind: 'navigate', route: { page: 'chat' } })).toBe(false);
    expect(await approved.guard.request({ kind: 'close' })).toBe(true);
    expect(await approved.guard.request({ kind: 'navigate', route: { page: 'appearance' } })).toBe(false);
  });
  it('isolates rejection and allows a later retry', async () => {
    let fail = true;
    const s = setup(true, () => { if (fail) throw new Error('confirmation failed'); return true; });
    expect(await s.guard.request({ kind: 'close' })).toBe(false);
    expect(s.error).toHaveBeenCalledTimes(1); expect(s.close).not.toHaveBeenCalled();
    fail = false; expect(await s.guard.request({ kind: 'close' })).toBe(true);
  });
  it('deduplicates concurrent attempts and rejects late approval after scope/route changes', async () => {
    let resolve!: (value: boolean) => void;
    const confirm = vi.fn(() => new Promise<boolean>(done => { resolve = done; }));
    const s = setup(true, confirm);
    const first = s.guard.request({ kind: 'close' });
    expect(await s.guard.request({ kind: 'close' })).toBe(false); expect(confirm).toHaveBeenCalledTimes(1);
    s.change({ route: { page: 'git', directory: '/other' } }); s.guard.invalidate(); resolve(true);
    expect(await first).toBe(false); expect(s.close).not.toHaveBeenCalled();
  });
  it('fences close/reopen ABA and never lets old completion clear a newer guard', async () => {
    const resolves: ((value: boolean) => void)[] = [];
    const s = setup(true, () => new Promise<boolean>(done => { resolves.push(done); }));
    const first = s.guard.request({ kind: 'close' });
    s.change({ open: false }); s.guard.invalidate(); s.change({ open: true }); s.guard.invalidate();
    const second = s.guard.request({ kind: 'close' });
    resolves[0](true); expect(await first).toBe(false);
    expect(s.busy).toHaveBeenLastCalledWith(true);
    resolves[1](true); expect(await second).toBe(true); expect(s.close).toHaveBeenCalledTimes(1);
    expect(s.busy).toHaveBeenLastCalledWith(false);
  });
  it('refuses late dirty approval after disposal or a pending save', async () => {
    for (const dispose of [true, false]) {
      let resolve!: (value: boolean) => void;
      const s = setup(true, () => new Promise<boolean>(done => { resolve = done; }));
      const result = s.guard.request({ kind: 'close' });
      if (dispose) s.guard.dispose(); else s.change({ pending: true });
      resolve(true); expect(await result).toBe(false); expect(s.close).not.toHaveBeenCalled();
    }
  });
  it('fences Host/editor changes even when the route and directory are identical', async () => {
    let resolve!: (value: boolean) => void;
    const s = setup(true, () => new Promise<boolean>(done => { resolve = done; }));
    s.change({ scopeKey: 'host-a:1' });
    const first = s.guard.request({ kind: 'close' });
    s.change({ scopeKey: 'host-b:1' }); resolve(true);
    expect(await first).toBe(false); expect(s.close).not.toHaveBeenCalled();
  });
  it('accepts an owner-approved dirty→clean transition without treating it as a route generation', async () => {
    let resolve!: (value: boolean) => void;
    const s = setup(true, () => new Promise<boolean>(done => { resolve = done; }));
    const first = s.guard.request({ kind: 'close' });
    s.change({ dirty: false }); resolve(true);
    expect(await first).toBe(true); expect(s.close).toHaveBeenCalledOnce();
  });
});
