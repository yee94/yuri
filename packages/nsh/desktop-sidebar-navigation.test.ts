import { describe, expect, it, vi } from 'vitest';
import { createDesktopSidebarNavigation, createDesktopSidebarSwitcherSource, desktopSidebarNavigation } from './desktop-sidebar-navigation';
import type { ChatTarget } from './model';

const row = (id: string, directory = '/repo') => ({ id, directory, title: id, updated: 1 });
const switcherSource = { snapshot: () => ({ sessions: [], projects: [], pinnedSessionIDs: [], ready: false, loading: false, error: '' }) };
const snapshot = () => desktopSidebarNavigation({
  pinned: [row('pin')], inProgress: [row('running')], pinnedClosed: false, progressClosed: false,
  sections: [{ project: { id: 'z', path: '/repo', name: 'Z' }, groups: [
    { directory: '/repo', label: 'Z', rows: ['z', 'a', 'b', 'folded', 'running', 'current'].map(id => row(id)) },
    { directory: '/tree', label: 'Tree', tree: { path: '/tree', name: 'Tree', branch: 'main' }, rows: [row('tree', '/tree')] },
  ] }, { project: { id: 'hidden', path: '/hidden', name: 'Hidden' }, groups: [{ directory: '/hidden', label: '', rows: [row('hidden', '/hidden')] }] }],
  collapsed: new Set(['hidden']), expandedTrees: new Set(['/tree']), counts: {}, initialCount: 3, pins: new Set(['pin']), running: new Set(['running']),
  selected: { kind: 'session', ...row('current') },
});

describe('exact logical desktop row navigation', () => {
  it('publishes a lazy retained switcher source independently of shortcut/modal gates, and fences its retired Host', async () => {
    let current = true, navigationActive = false;
    const snapshotRead = vi.fn(() => ({ sessions: [row('retained')], projects: [], pinnedSessionIDs: ['retained'], ready: true, loading: false, error: '' }));
    const status = vi.fn(() => 'unread' as const), retry = vi.fn(async () => {});
    const source = createDesktopSidebarSwitcherSource({ current: () => current, snapshot: snapshotRead, status, retry });
    const owner = createDesktopSidebarNavigation({ current: () => navigationActive, snapshot, selected: () => null, activate: vi.fn(), switcherSource: source });
    for (let i = 0; i < 50; i++) { expect(owner.actions.switcherSource).toBe(source); owner.actions.targets(); }
    expect(snapshotRead).not.toHaveBeenCalled();
    expect(owner.actions.numbered(1)).toBe(false);
    expect(source.snapshot().sessions[0]?.id).toBe('retained'); expect(source.status?.(row('retained'))).toBe('unread');
    await source.retry?.(); expect(retry).toHaveBeenCalledOnce();
    current = false; snapshotRead.mockClear(); status.mockClear(); retry.mockClear();
    expect(source.snapshot()).toMatchObject({ ready: false, loading: false, error: '', sessions: [] });
    expect(source.status?.(row('retained'))).toBeNull(); await source.retry?.();
    expect(snapshotRead).not.toHaveBeenCalled(); expect(status).not.toHaveBeenCalled(); expect(retry).not.toHaveBeenCalled();
    navigationActive = true; owner.dispose();
  });
  it('uses pinned, in-progress, controller project rank and expanded worktrees; excludes folded rows', () => {
    const value = snapshot();
    expect(value.all.map(row => row.sessionId)).toEqual(['pin', 'running', 'z', 'a', 'b', 'running', 'current', 'tree']);
    expect(value.numbered).toEqual(value.all);
    expect(value.all.map(row => row.scope)).toEqual(['pinned', 'pinned', 'project', 'project', 'project', 'project', 'project', 'project']);
  });
  it('numbers at most nine without sorting by identity or reading hidden projects', () => {
    const input = snapshot();
    const many = desktopSidebarNavigation({ pinned: Array.from({ length: 15 }, (_, i) => row(`z-${15 - i}`)), inProgress: [], sections: [], pinnedClosed: false, progressClosed: false,
      collapsed: new Set(), expandedTrees: new Set(), counts: {}, initialCount: 3, pins: new Set(), running: new Set(), selected: null });
    expect(many.all).toHaveLength(15); expect(many.numbered.map(row => row.sessionId)).toEqual(many.all.slice(0, 9).map(row => row.sessionId));
    expect(input.all.some(row => row.sessionId === 'hidden' || row.sessionId === 'folded')).toBe(false);
  });
  it('cycles at both ends and remembers duplicate visual home before committing selection', () => {
    let selected: ChatTarget | null = null;
    const activate = vi.fn(target => { selected = target.row; });
    const owner = createDesktopSidebarNavigation({ current: () => true, snapshot, selected: () => selected, activate, switcherSource });
    expect(owner.actions.adjacent(-1)).toBe(true); expect(selected?.id).toBe('tree');
    owner.actions.adjacent(1); expect(selected?.id).toBe('pin');
    owner.actions.numbered(6); expect(selected?.id).toBe('running');
    owner.actions.adjacent(1); expect(selected?.id).toBe('current');
    owner.open('running', row('running')); owner.actions.adjacent(1); expect(selected?.id).toBe('z');
    expect(owner.actions.numbered(0)).toBe(false); expect(owner.actions.numbered(1.5)).toBe(false); expect(owner.actions.numbered(9)).toBe(false);
  });
  it('reads the latest fold snapshot, while inactive/disposed/Host-fenced owners do no projection or navigation', () => {
    let active = true, value = snapshot();
    const read = vi.fn(() => value), activate = vi.fn();
    const owner = createDesktopSidebarNavigation({ current: () => active, snapshot: read, selected: () => null, activate, switcherSource });
    owner.actions.numbered(1); expect(activate.mock.calls[0]?.[0].sessionId).toBe('pin');
    value = { all: [], numbered: [] }; expect(owner.actions.adjacent(1)).toBe(false);
    active = false; read.mockClear();
    for (let i = 0; i < 50; i++) { expect(owner.actions.numbered(1)).toBe(false); expect(owner.actions.targets()).toEqual([]); }
    expect(read).not.toHaveBeenCalled();
    active = true; owner.dispose(); expect(owner.actions.numbered(1)).toBe(false);
  });
  it('same IDs in distinct directories remain adjacent rows, and exact visual focus survives projection refresh', () => {
    const make = () => desktopSidebarNavigation({ pinned: [], inProgress: [], pinnedClosed: false, progressClosed: false,
      sections: [{ project: { id: 'project', path: '/one', name: 'Project' }, groups: [
        { directory: '/one', label: 'One', rows: [row('same', '/one')] },
        { directory: '/two', label: 'Two', tree: { path: '/two', name: 'Two', branch: 'two' }, rows: [row('same', '/two'), row('next', '/two')] },
      ] }], collapsed: new Set(), expandedTrees: new Set(['/two']), counts: {}, initialCount: 3, pins: new Set(), running: new Set(), selected: null });
    let selected: ChatTarget | null = null;
    const owner = createDesktopSidebarNavigation({ current: () => true, snapshot: make, selected: () => selected, activate: target => { selected = target.row; }, switcherSource });
    owner.actions.numbered(1); owner.actions.adjacent(1); expect(selected?.directory).toBe('/two');
    owner.actions.adjacent(1); expect(selected?.id).toBe('next');
    owner.actions.adjacent(-1); expect(selected?.id).toBe('same'); expect(selected?.directory).toBe('/two');
    owner.actions.adjacent(-1); expect(selected?.directory).toBe('/one');
  });
});
