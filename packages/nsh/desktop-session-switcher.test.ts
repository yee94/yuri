import { describe, expect, test, vi } from 'vitest';
import { createDesktopSwitcherOwner, desktopSwitcherCatalog, desktopSwitcherDate, desktopSwitcherKey, desktopSwitcherRows, type DesktopSwitcherSession, type DesktopSwitcherSnapshot } from './desktop-session-switcher-core';
import { desktopSessionSwitcherProjectsSource, type DesktopSwitcherProjectsReader } from './desktop-session-switcher-projects';

const session = (id: string, updated: number, extra: Partial<DesktopSwitcherSession> = {}): DesktopSwitcherSession => ({ id, title: id, directory: '/workspace/project', updated, ...extra });
const snapshot = (sessions: DesktopSwitcherSession[], extra: Partial<DesktopSwitcherSnapshot> = {}): DesktopSwitcherSnapshot => ({ sessions, projects: [{ id: 'p', name: 'Custom label is not the Web basename', path: '/workspace/project' }], pinnedSessionIDs: [], ready: true, loading: false, error: '', ...extra });

describe('Web recent seven-parent menu tree', () => {
  test('pinned creation time precedes activity; archived and children do not consume the seven roots', () => {
    const rows = [session('pin-old', 9000, { created: 1 }), session('pin-new', 1, { created: 2 }),
      ...Array.from({ length: 300 }, (_, i) => session(`s${i}`, i)), session('child', 10000, { parentID: 's299' }), session('archive', 20000, { archived: true })];
    const catalog = desktopSwitcherCatalog(snapshot(rows, { pinnedSessionIDs: ['pin-old', 'pin-new'] }));
    const visible = desktopSwitcherRows(catalog, new Set());
    expect(visible.map(row => row.node.session.id)).toEqual(['pin-new', 'pin-old', 's299', 's298', 's297', 's296', 's295']);
    expect(catalog.find(row => row.session.id === 's299')?.children.map(row => row.session.id)).toEqual(['child']);
    expect(desktopSwitcherRows(catalog, new Set([desktopSwitcherKey(rows[301]!)])).filter(row => row.depth === 1)).toHaveLength(1);
  });
  test('only expanded descendants follow their recent root; no hidden search can expose an eighth root', () => {
    const rows = Array.from({ length: 300 }, (_, i) => session(`session-${i}`, i));
    rows.push(session('child', 301, { title: '中文目标', parentID: 'session-299' }), session('grandchild', 302, { title: 'nested', parentID: 'child' }));
    const catalog = desktopSwitcherCatalog(snapshot(rows));
    expect(desktopSwitcherRows(catalog, new Set())).toHaveLength(7);
    const rootKey = desktopSwitcherKey(rows[299]!), childKey = desktopSwitcherKey(rows[300]!);
    expect(desktopSwitcherRows(catalog, new Set([rootKey])).slice(0, 3).map(row => [row.node.session.id, row.depth])).toEqual([['session-299', 0], ['child', 1], ['session-298', 0]]);
    expect(desktopSwitcherRows(catalog, new Set([rootKey, childKey])).slice(0, 3).map(row => row.node.session.id)).toEqual(['session-299', 'child', 'grandchild']);
    expect(desktopSwitcherRows(catalog, new Set([desktopSwitcherKey(rows[0]!)])).some(row => row.node.session.id === 'session-0')).toBe(false);
  });
  test('project matching uses longest normalized segment prefix and hides HEAD/duplicate branches', () => {
    const value = snapshot([session('a', 2, { directory: 'c:\\workspace\\project\\nested\\tree' }), session('b', 1, { directory: 'C:/workspace/project-other' })], {
      projects: [{ id: 'root', name: 'root', path: 'C:/workspace/project' }, { id: 'nested', name: 'label', path: 'C:/workspace/project/nested' }],
      branches: new Map([['C:/workspace/project/nested/tree', 'HEAD']]),
    });
    const catalog = desktopSwitcherCatalog(value, 'nested');
    expect(catalog).toHaveLength(1); expect(catalog[0]).toMatchObject({ projectLabel: 'nested', branchLabel: null });
    expect(desktopSwitcherCatalog({ ...value, branches: new Map([['C:/workspace/project/nested/tree', 'feature']]) }, 'nested')[0]?.branchLabel).toBe('feature');
  });
  test('malformed ancestry cannot recurse forever; no incomplete/error snapshot is turned into a successful empty state', () => {
    const value = snapshot([session('a', 1, { parentID: 'b' }), session('b', 1, { parentID: 'a' })], { ready: false, error: 'offline' });
    expect(desktopSwitcherCatalog(value)).toEqual([]); expect(value.ready).toBe(false); expect(value.error).toBe('offline');
  });
  test('compact dates match Web thresholds and use existing i18n keys', () => {
    expect(desktopSwitcherDate(100, 100)).toEqual({ key: 'common.relative.minutesAgoCompact', count: 1 });
    expect(desktopSwitcherDate(0, 3600000)).toEqual({ key: 'common.relative.hoursAgoCompact', count: 1 });
    expect(desktopSwitcherDate(0, 8 * 86400000)).toEqual({ key: 'common.relative.weeksAgoCompact', count: 1 });
  });
  test('authoritative pin IDs override stale row flags and do not inherit saved drag order', () => {
    const catalog = desktopSwitcherCatalog(snapshot([session('stale', 1, { pinned: true, created: 100 }), session('recent', 2)]));
    expect(catalog.map(node => node.session.id)).toEqual(['recent', 'stale']);
  });
});

test('existing Projects owner adapter is lazy/read-only, keeps loaded children, shares live status and delegates only explicit recovery', async () => {
  const root = { ...session('root', 1), pinned: false, archived: false }, child = { ...session('child', 2, { parentID: 'root' }), pinned: false, archived: false };
  const sidebar = vi.fn(() => ({ children: { root: { rows: [child], cursor: null, loaded: true } }, archived: {}, folders: null, pending: [], errors: {}, unknown: [] }));
  const refresh = vi.fn(async () => {}), sessions = vi.fn(() => [root]);
  const reader: DesktopSwitcherProjectsReader = { sidebar: { snapshot: sidebar }, sessions, hiddenSessionIDs: () => new Set(), worktrees: () => ({ '/workspace/project': [{ path: '/workspace/project', name: 'project', branch: 'main' }] }),
    pins: () => ['root'], loading: () => false, error: () => 'offline', running: () => ['root'], attention: () => ({ unseenBySession: { root: 2, child: 2 }, currentSessionID: null, blockingByDirectory: {} }), refresh };
  const source = desktopSessionSwitcherProjectsSource(reader, () => [], () => false);
  expect(sessions).not.toHaveBeenCalled(); expect(sidebar).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled();
  const value = source.snapshot(); expect(value.sessions).toEqual([root, child]); expect(value).toMatchObject({ ready: false, loading: false, error: 'offline', pinnedSessionIDs: ['root'] });
  expect(value.branches?.get('/workspace/project')).toBe('main');
  expect(source.status?.(root)).toBe('running'); expect(source.status?.(child)).toBeNull();
  expect(sessions).toHaveBeenCalledTimes(1); expect(sidebar).toHaveBeenCalledTimes(1);
  await source.retry?.(); expect(refresh).toHaveBeenCalledTimes(1);
});

describe('exact presentation/Host owner and local draft actions', () => {
  function fixture() {
    let owns = true, current = true;
    const calls: string[] = [], changed = vi.fn();
    const owner = createDesktopSwitcherOwner({ owns: () => owns, current: () => current, currentTarget: () => ({ kind: 'session', id: 'a', title: 'a', directory: '/workspace/project' }),
      close: () => { calls.push('close'); current = false; }, openChat: target => calls.push(`open:${target.directory}:${target.id}`), newSession: () => calls.push('draft'), changed });
    return { owner, calls, changed, retire: () => { owns = false; }, inactive: () => { current = false; } };
  }
  test('current selection only closes, other selection closes before one explicit navigation', () => {
    const same = fixture(); same.owner.select(session('a', 1)); same.owner.select(session('b', 1)); expect(same.calls).toEqual(['close']);
    const other = fixture(); other.owner.select(session('b', 1)); expect(other.calls).toEqual(['close', 'open:/workspace/project:b']);
    const path = fixture(); path.owner.select(session('a', 1, { directory: '/workspace/other' })); expect(path.calls).toEqual(['close', 'open:/workspace/other:a']);
  });
  test('new session only invokes local draft callback once and retired/inactive owners cannot navigate', () => {
    const draft = fixture(); draft.owner.newSession(); draft.owner.newSession(); expect(draft.calls).toEqual(['close', 'draft']);
    for (const end of ['retire', 'inactive'] as const) { const old = fixture(); old[end](); old.owner.select(session('b', 1)); old.owner.newSession(); expect(old.calls).toEqual([]); }
    const old = fixture(); old.retire(); old.owner.close(); expect(old.calls).toEqual([]);
  });
  test('explicit recovery deduplicates and preserves errors; a late old-Host completion never publishes or closes the next popup', async () => {
    const first = fixture(), work = vi.fn(async () => { throw new Error('offline'); });
    await first.owner.retry(work); expect(first.changed).toHaveBeenLastCalledWith({ retrying: false, error: 'offline' });
    let release!: () => void;
    const late = fixture(), delayed = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const flight = late.owner.retry(delayed); await late.owner.retry(delayed); expect(delayed).toHaveBeenCalledTimes(1);
    late.retire(); late.owner.dispose(); release(); await flight;
    expect(late.changed).toHaveBeenCalledTimes(1); expect(late.calls).toEqual([]);
  });
  test('synchronous Host replacement during close cannot navigate/create a draft on the next Host', () => {
    let host = 1;
    const openChat = vi.fn(), newSession = vi.fn();
    const create = () => createDesktopSwitcherOwner({ owns: () => true, current: () => host === 1, currentTarget: () => undefined,
      navigationCurrent: () => host === 1, close: () => { host = 2; }, openChat, newSession });
    create().select(session('a', 1)); expect(openChat).not.toHaveBeenCalled();
    host = 1; create().newSession(); expect(newSession).not.toHaveBeenCalled();
  });
});
