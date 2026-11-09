import { describe, expect, it, vi } from 'vitest';
import { createDesktopPanelTabs, desktopPanelScopeKey, type DesktopPanelScope } from './desktop-panel-model';
import { createDesktopPanelTabsPersistence, decodeDesktopPanelMetadata, DESKTOP_PANEL_METADATA_KEY, encodeDesktopPanelMetadata } from './desktop-panel-tabs-persistence';
const scope: DesktopPanelScope = { host: { hostID: 'synthetic', lease: 'not-persisted' }, authorityKey: 'stable-auth', sessionID: 'session-a', directory: '/workspace' };
function fixture(prior: string | null = null) {
  let value = prior;
  const storage = { getItem: vi.fn(async () => value), setItem: vi.fn(async (_key: string, next: string) => { value = next; }), removeItem: vi.fn(async () => { value = null; }) };
  const tabs = createDesktopPanelTabs(), persistence = createDesktopPanelTabsPersistence(tabs, storage);
  return { tabs, persistence, storage, value: () => value, external: (raw: string) => { value = raw; } };
}
describe('bounded panel metadata, separate from file journal', () => {
  it('roundtrips an explicit empty browser without creating a URL, transport credential or callback', async () => {
    const f = fixture(); await f.persistence.restore();
    const id = f.tabs.open(scope, { kind: 'browser', url: '' }); await f.persistence.flush();
    const next = fixture(f.value()); await next.persistence.restore();
    expect(next.tabs.snapshot(scope).tabs).toEqual([{ id, kind: 'browser', url: '' }]);
    expect(next.storage.setItem).not.toHaveBeenCalled();
  });
  it('binds metadata after existing tabs were opened without losing that initial local intent on restore', async () => {
    const tabs = createDesktopPanelTabs(); const id = tabs.open(scope, { kind: 'file', path: 'already-open.ts' });
    let stored: string | null = null;
    const persistence = createDesktopPanelTabsPersistence(tabs, { getItem: async () => stored, setItem: async (_key, raw) => { stored = raw; }, removeItem: async () => {} });
    expect(persistence.state().pending).toBe(true); await persistence.restore();
    expect(decodeDesktopPanelMetadata(stored!)[0].selectedID).toBe(id);
  });
  it('roundtrips order/selection/rail with stable identities, no leases/content/history callbacks, no Host reads or writes', async () => {
    const f = fixture(); await f.persistence.restore();
    const a = f.tabs.open(scope, { kind: 'file', path: 'a.ts', targetLine: 12 }), b = f.tabs.open(scope, { kind: 'preview', path: 'index.html' });
    f.tabs.open(scope, { kind: 'browser', url: 'https://example.invalid/' }); f.tabs.open(scope, { kind: 'context' });
    f.tabs.open(scope, { kind: 'diff', source: { kind: 'workspace', directory: '/workspace', path: 'a.ts', staged: true } });
    f.tabs.reorder(scope, b, a); f.tabs.select(scope, a); f.tabs.setRail(scope, 'files'); await f.persistence.flush();
    const raw = f.value()!; expect(raw).not.toContain('not-persisted'); expect(raw).not.toContain('content');
    const next = fixture(raw); await next.persistence.restore(); expect(next.tabs.snapshot({ ...scope, host: { ...scope.host, lease: 'renewed' } })).toEqual(f.tabs.snapshot(scope));
    for (const alternative of [{ ...scope, authorityKey: 'different-auth' }, { ...scope, directory: '/other' }, { ...scope, sessionID: 'other' }, { ...scope, host: { ...scope.host, hostID: 'other' } }]) expect(next.tabs.snapshot(alternative).tabs).toEqual([]);
    expect(next.storage.setItem).not.toHaveBeenCalled();
  });
  it('omits only transient historical snapshots without destroying live history or guessing current Git content', () => {
    const tabs = createDesktopPanelTabs(); tabs.open(scope, { kind: 'diff', source: { kind: 'turn', directory: '/workspace', sessionID: 'session-a', messageID: 'message-a', files: [{ path: 'a.ts', before: 'SECRET_OLD', after: 'SECRET_NEW' }], loadFile: async () => ({ after: 'SECRET_LOAD' }) } });
    expect(tabs.snapshot(scope).tabs).toHaveLength(1); const raw = encodeDesktopPanelMetadata(tabs.metadata()); expect(raw).not.toContain('SECRET'); expect(decodeDesktopPanelMetadata(raw)[0].tabs).toEqual([]); expect(tabs.snapshot(scope).tabs).toHaveLength(1);
  });
  it('retains 20 scopes by true access and refuses to evict protected work', async () => {
    const f = fixture(); await f.persistence.restore();
    for (let index = 0; index < 20; index++) f.tabs.open({ ...scope, sessionID: 'session-' + index }, { kind: 'context' });
    f.tabs.snapshot({ ...scope, sessionID: 'session-0' }); f.tabs.open({ ...scope, sessionID: 'session-20' }, { kind: 'context' }); await f.persistence.flush();
    const rows = decodeDesktopPanelMetadata(f.value()!); expect(rows).toHaveLength(20); expect(rows.some(row => row.scope.sessionID === 'session-1')).toBe(false); expect(rows.at(-2)?.scope.sessionID).toBe('session-0');
    const pinned = createDesktopPanelTabs(() => {}, { scopeProtected: () => true }); for (let index = 0; index < 20; index++) pinned.open({ ...scope, sessionID: 'pinned-' + index }, { kind: 'context' });
    expect(() => pinned.open(scope, { kind: 'context' })).toThrow('desktop_panel_scope_capacity'); expect(pinned.dispose()).toBe(false);
  });
  it('late restore merges absent scopes but cannot replace local actions or a protected recovered editor scope', async () => {
    const old = createDesktopPanelTabs(); old.open(scope, { kind: 'context' }); const other = { ...scope, sessionID: 'other' }; old.open(other, { kind: 'context' });
    const f = fixture(encodeDesktopPanelMetadata(old.metadata())); let resolve!: (value: string) => void; f.storage.getItem.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const reading = f.persistence.restore(); const id = f.tabs.open(scope, { kind: 'file', path: 'new.ts' }); resolve(encodeDesktopPanelMetadata(old.metadata())); await reading;
    expect(f.tabs.snapshot(scope).selectedID).toBe(id); expect(f.tabs.snapshot(other).selectedID).toBe('context');
    const pinned = createDesktopPanelTabs(() => {}, { scopeProtected: key => key === desktopPanelScopeKey(scope) }); pinned.restoreMetadata(old.metadata()); expect(pinned.snapshot(scope).tabs).toEqual([]);
  });
  it('failed writes keep usable live state and prior storage; only explicit retry persists the latest intent', async () => {
    const old = createDesktopPanelTabs(); old.open(scope, { kind: 'context' }); const raw = encodeDesktopPanelMetadata(old.metadata()), f = fixture(raw); await f.persistence.restore();
    f.storage.setItem.mockRejectedValueOnce(new Error('never show raw path')); const id = f.tabs.open(scope, { kind: 'file', path: 'new.ts' });
    expect(await f.persistence.flush()).toBe(false); expect(f.value()).toBe(raw); expect(f.tabs.snapshot(scope).selectedID).toBe(id); expect(f.persistence.state().error).toBe('write');
    f.tabs.select(scope, 'context'); expect(f.storage.setItem).toHaveBeenCalledTimes(1); expect(await f.persistence.retry()).toBe(true); expect(decodeDesktopPanelMetadata(f.value()!)[0].selectedID).toBe('context');
  });
  it('rolls back a write that updated memory then rejected, without claiming crash-safe journal durability', async () => {
    const f = fixture(); await f.persistence.restore();
    f.storage.setItem.mockImplementationOnce(async (_key, next) => { f.external(next); throw new Error('after memory change'); }); f.tabs.open(scope, { kind: 'context' });
    expect(await f.persistence.flush()).toBe(false); expect(f.value()).toBeNull(); expect(f.storage.removeItem).toHaveBeenCalledWith(DESKTOP_PANEL_METADATA_KEY); expect(await f.persistence.retry()).toBe(true);
  });
  it('read failure/corrupt metadata never masquerades as empty or overwrites unread prior, retry reuses live state', async () => {
    const f = fixture('{corrupt'); expect(await f.persistence.restore()).toBe(false); f.tabs.open(scope, { kind: 'context' }); expect(await f.persistence.flush()).toBe(false); expect(f.storage.setItem).not.toHaveBeenCalled(); expect(f.value()).toBe('{corrupt');
    f.external(encodeDesktopPanelMetadata([])); expect(await f.persistence.retry()).toBe(true); expect(f.tabs.snapshot(scope).selectedID).toBe('context');
  });
  it('foreign changes fail closed and cannot be blindly overwritten by retry', async () => {
    const f = fixture(); await f.persistence.restore(); f.external('foreign'); f.tabs.open(scope, { kind: 'context' }); expect(await f.persistence.flush()).toBe(false); expect(f.persistence.state().error).toBe('conflict'); expect(await f.persistence.retry()).toBe(false); expect(f.value()).toBe('foreign');
  });
  it('serializes and coalesces newer revisions while a metadata write is awaiting its ACK', async () => {
    const f = fixture(); await f.persistence.restore(); let finish!: () => void;
    f.storage.setItem.mockImplementationOnce(async (_key, raw) => { await new Promise<void>(done => { finish = done; }); f.external(raw); });
    const first = f.tabs.open(scope, { kind: 'file', path: 'a.ts' }); const saving = f.persistence.flush();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    for (let index = 0; index < 30; index++) f.tabs.open(scope, { kind: 'file', path: 'b.ts', targetLine: index + 1 });
    f.tabs.select(scope, first); finish(); expect(await saving).toBe(true); expect(f.storage.setItem).toHaveBeenCalledTimes(2);
    const row = decodeDesktopPanelMetadata(f.value()!)[0]; expect(row.tabs).toHaveLength(2); expect(row.selectedID).toBe(first);
  });
  it('re-restored LRU ordering evicts the oldest scope, not a recently selected or protected scope', async () => {
    const source = createDesktopPanelTabs(); const scopes = Array.from({ length: 20 }, (_, index) => ({ ...scope, sessionID: 'session-' + index }));
    for (const value of scopes) source.open(value, { kind: 'context' });
    const f = fixture(encodeDesktopPanelMetadata(source.metadata())); await f.persistence.restore(); f.tabs.snapshot(scopes[0]);
    f.tabs.open({ ...scope, sessionID: 'new' }, { kind: 'context' }); expect(f.tabs.snapshot(scopes[1]).tabs).toEqual([]); expect(f.tabs.snapshot(scopes[0]).tabs).toHaveLength(1);
  });
  it('strictly rejects cross-scope paths, arbitrary kinds, callback/content extras, wrong IDs, duplicate roots and oversized payloads', () => {
    const tabs = createDesktopPanelTabs(); tabs.open(scope, { kind: 'file', path: 'a.ts' }); const rows = tabs.metadata();
    for (const mutate of [
      (row: any) => { row.tabs[0].path = '/outside/a.ts'; }, (row: any) => { row.scope.host.lease = 'forbidden'; },
      (row: any) => { row.tabs[0].text = 'forbidden'; }, (row: any) => { row.tabs[0].kind = 'plugin'; }, (row: any) => { row.tabs[0].id = 'forged'; },
    ]) { const value = JSON.parse(JSON.stringify(rows)); mutate(value[0]); expect(() => decodeDesktopPanelMetadata(JSON.stringify({ version: 1, scopes: value }))).toThrow(); }
    expect(() => encodeDesktopPanelMetadata([...rows, ...rows])).toThrow(); expect(() => decodeDesktopPanelMetadata('x'.repeat(512 * 1024 + 1))).toThrow();
  });
});
