import { describe, expect, it, vi } from 'vitest';
import { createDesktopPanelTabs, desktopPanelFileScope, desktopPanelScopeKey, desktopPanelTabKey, type DesktopPanelMetadata, type DesktopPanelScope } from './desktop-panel-model';
import { createDesktopEditors } from './desktop-files-editor-model';
import { createDesktopBrowserBinding } from './desktop-browser-core';
import { createDesktopPanelTabsPersistence, decodeDesktopPanelMetadata, encodeDesktopPanelMetadata } from './desktop-panel-tabs-persistence';

const scope: DesktopPanelScope = { host: { hostID: 'synthetic', lease: 'lease-a' }, authorityKey: 'authority-a', sessionID: 'session-a', directory: '/workspace' };
const legacyBrowser = (url: string) => ({ id: JSON.stringify(['browser', url]), kind: 'browser' as const, url });
const legacyRow = (): DesktopPanelMetadata => ({
  scope: { ...scope, host: { hostID: scope.host.hostID } },
  tabs: [
    { id: JSON.stringify(['file', '/workspace/a.ts']), kind: 'file', path: '/workspace/a.ts' },
    legacyBrowser('https://first.invalid/'),
    { id: 'context', kind: 'context' },
    legacyBrowser('http://localhost:3000/last'),
    { id: JSON.stringify(['file', '/other', 'source-session', '/other/dirty.ts']), kind: 'file', path: '/other/dirty.ts', source: { directory: '/other', sessionID: 'source-session' }, targetLine: 17 },
  ], selectedID: JSON.stringify(['browser', 'https://first.invalid/']), rail: 'files', activeView: 'preview',
});
const rawRow = (row: DesktopPanelMetadata) => JSON.stringify({ version: 1, scopes: [row] });

describe('single browser identity per exact parent workbench', () => {
  it('opens Header empty, repeated URL and changed URL in one stable tab, updating intent/selection without moving unrelated tabs', () => {
    const notify = vi.fn(), tabs = createDesktopPanelTabs(notify);
    const file = tabs.open(scope, { kind: 'file', path: 'a.ts' });
    const id = tabs.open(scope, { kind: 'browser', url: '' });
    expect(id).toBe(desktopPanelTabKey({ kind: 'browser', url: 'https://different.invalid/' }));
    const context = tabs.open(scope, { kind: 'context' }), before = tabs.snapshot(scope);
    expect(tabs.open(scope, { kind: 'browser', url: ' HTTPS://First.invalid:443 ' })).toBe(id);
    expect(tabs.snapshot(scope).tabs).toEqual([before.tabs[0], { id, kind: 'browser', url: 'https://first.invalid/' }, before.tabs[2]]);
    expect(tabs.snapshot(scope).tabs[0]).toBe(before.tabs[0]); expect(tabs.snapshot(scope).tabs[2]).toBe(before.tabs[2]);
    tabs.select(scope, file); tabs.setRail(scope, 'files');
    expect(tabs.open(scope, { kind: 'browser', url: 'http://localhost:3000/new' })).toBe(id);
    expect(tabs.snapshot(scope)).toMatchObject({ selectedID: id, activeView: 'preview', rail: 'files' });
    expect(tabs.snapshot(scope).tabs.map(tab => tab.id)).toEqual([file, id, context]);
    expect(tabs.snapshot(scope).tabs[1]).toEqual({ id, kind: 'browser', url: 'http://localhost:3000/new' });
    const current = tabs.snapshot(scope), count = notify.mock.calls.length;
    for (let index = 0; index < 50; index++) {
      expect(tabs.open(scope, { kind: 'browser', url: 'http://LOCALHOST:3000/new' })).toBe(id);
      expect(tabs.open(scope, { kind: 'browser', url: '' })).toBe(id);
    }
    expect(tabs.snapshot(scope)).toBe(current); expect(notify).toHaveBeenCalledTimes(count);
  });

  it('invalid URLs fail closed, preserving prior URL, selected file, scope order and notification count', () => {
    const notify = vi.fn(), tabs = createDesktopPanelTabs(notify);
    tabs.open(scope, { kind: 'browser', url: 'https://prior.invalid/' }); tabs.open(scope, { kind: 'file', path: 'a.ts' });
    const before = tabs.snapshot(scope), count = notify.mock.calls.length;
    for (const url of [' ', 'javascript:alert(1)', 'file:///workspace/a.html', 'http://127.1/', 'https://u:p@private.invalid/', 'https://safe.invalid/?token=forbidden', 'https://safe.invalid/%5c']) {
      expect(() => tabs.open(scope, { kind: 'browser', url }), url).toThrow();
      expect(tabs.snapshot(scope)).toBe(before);
    }
    expect(notify).toHaveBeenCalledTimes(count);
  });

  it('validated navigation receipts replace persisted URL without stealing selection or treating typed/empty addresses as navigation', () => {
    const notify = vi.fn(), tabs = createDesktopPanelTabs(notify);
    const id = tabs.open(scope, { kind: 'browser', url: 'https://prior.invalid/' }), file = tabs.open(scope, { kind: 'file', path: 'a.ts' });
    const before = tabs.snapshot(scope), count = notify.mock.calls.length;
    expect(tabs.setBrowserURL(scope, id, 'http://localhost:3000/navigated')).toBe(true);
    expect(tabs.snapshot(scope)).toMatchObject({ selectedID: file, rail: before.rail, activeView: before.activeView });
    expect(tabs.snapshot(scope).tabs[1]).toBe(before.tabs[1]);
    const navigated = tabs.snapshot(scope);
    expect(tabs.setBrowserURL(scope, id, '')).toBe(false);
    expect(tabs.setBrowserURL(scope, id, 'http://LOCALHOST:3000/navigated')).toBe(false);
    expect(tabs.setBrowserURL(scope, file, 'https://not-a-browser.invalid/')).toBe(false);
    expect(tabs.setBrowserURL({ ...scope, authorityKey: 'retired' }, id, 'https://other.invalid/')).toBe(false);
    expect(() => tabs.setBrowserURL(scope, id, 'javascript:alert(1)')).toThrow();
    expect(tabs.snapshot(scope)).toBe(navigated); expect(notify).toHaveBeenCalledTimes(count + 1);
    expect(tabs.metadata()).toHaveLength(1);
    const restored = createDesktopPanelTabs(); restored.restoreMetadata(decodeDesktopPanelMetadata(encodeDesktopPanelMetadata(tabs.metadata())));
    expect(restored.snapshot(scope).tabs[0]).toEqual({ id, kind: 'browser', url: 'http://localhost:3000/navigated' });
    restored.open(scope, { kind: 'browser', url: '' }); expect(restored.snapshot(scope).tabs[0]).toEqual(navigated.tabs[0]);
    restored.open(scope, { kind: 'browser', url: 'https://prior.invalid/' }); expect(restored.snapshot(scope).tabs[0]).toEqual({ id, kind: 'browser', url: 'https://prior.invalid/' });
  });

  it('Host/authority/session/directory remain exact partitions and lease renewal does not replace identity', () => {
    const tabs = createDesktopPanelTabs(), id = tabs.open(scope, { kind: 'browser', url: 'https://prior.invalid/' });
    for (const other of [{ ...scope, host: { hostID: 'other', lease: 'lease-b' } }, { ...scope, authorityKey: 'other' }, { ...scope, sessionID: 'other' }, { ...scope, sessionID: null }, { ...scope, directory: '/other' }]) {
      expect(tabs.snapshot(other).tabs).toEqual([]); tabs.open(other, { kind: 'browser', url: 'https://other.invalid/' });
      expect(tabs.snapshot(scope).tabs).toEqual([{ id, kind: 'browser', url: 'https://prior.invalid/' }]);
    }
    const renewed = { ...scope, host: { ...scope.host, lease: 'renewed' } };
    expect(tabs.open(renewed, { kind: 'browser', url: 'https://renewed.invalid/' })).toBe(id);
    expect(tabs.snapshot(scope)).toBe(tabs.snapshot(renewed));
  });

  it('keeps a real own-source dirty document and its parent pinned through browser replacement, close and 20-scope LRU', async () => {
    const editors = createDesktopEditors();
    const tabs = createDesktopPanelTabs(() => {}, { scopeProtected: editors.scopeProtected, tabProtected: (parent, tab) => tab.kind === 'file' && editors.scopeProtected(desktopPanelScopeKey(desktopPanelFileScope(parent, tab))) });
    const intent = { kind: 'file' as const, path: '/other/dirty.ts', source: { directory: '/other', sessionID: 'source-session' } };
    const file = tabs.open(scope, intent), ownScope = desktopPanelFileScope(scope, intent), acquired = editors.acquire(ownScope, intent.path)!;
    const request = vi.fn(async (path: string) => path.includes('/stat?') ? { path: intent.path, size: 4, mtimeMs: 1, isFile: true, isBinary: false, mimeType: 'text/plain' } : 'BASE');
    await editors.load(acquired.document, { scope: ownScope, current: () => true, request }); editors.edit(acquired.document, 'DIRTY');
    const dirty = acquired.document.state(), id = tabs.open(scope, { kind: 'browser', url: 'https://first.invalid/' });
    for (let index = 0; index < 50; index++) tabs.open(scope, { kind: 'browser', url: 'https://next.invalid/' + index });
    expect(tabs.close(scope, id)).toBe(true); expect(tabs.snapshot(scope).selectedID).toBe(file);
    for (let index = 0; index < 21; index++) tabs.open({ ...scope, sessionID: 'lru-' + index }, { kind: 'browser', url: '' });
    expect(tabs.metadata()).toHaveLength(20); expect(tabs.snapshot(scope).tabs[0].id).toBe(file);
    expect(editors.peek(ownScope, intent.path)).toBe(acquired.document); expect(acquired.document.state()).toBe(dirty); expect(tabs.dispose()).toBe(false);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('a changed model intent can update the retained binding with Host loopback; late receipts cannot overwrite the replacement', () => {
    const tabs = createDesktopPanelTabs(), changed = vi.fn(), command = vi.fn();
    const binding = createDesktopBrowserBinding({ scope: scope.host, directory: scope.directory, owner: 'retained-browser', current: () => true, changed, command });
    binding.update(true);
    const apply = () => { const tab = tabs.snapshot(scope).tabs.find(tab => tab.kind === 'browser'); if (tab?.kind === 'browser' && tab.url) return binding.request(tab); };
    const id = tabs.open(scope, { kind: 'browser', url: 'https://first.invalid/' }); expect(apply()).toBe(true);
    const old = binding.binding()!;
    expect(tabs.open(scope, { kind: 'browser', url: 'http://localhost:3000/new' })).toBe(id); expect(apply()).toBe(true);
    const next = binding.binding()!; expect(next.owner).toBe(old.owner); expect(next.generation).toBe(old.generation + 1); expect(next.intent).toEqual({ kind: 'loopback', url: 'http://localhost:3000/new' });
    expect(binding.event({ ...old, phase: 'ready', url: 'https://old.invalid/', canBack: false, canForward: false, error: null })).toBe(false);
    tabs.open(scope, { kind: 'browser', url: '' }); expect(apply()).toBe(false);
    expect(binding.command('external')).toBe(false); expect(command).not.toHaveBeenCalled(); expect(changed).toHaveBeenCalledTimes(2);
  });
});

describe('v1 URL-keyed browser metadata compatibility', () => {
  it('takes the selected legacy browser URL/position, remaps selection, and preserves unrelated own-source file metadata', () => {
    const row = legacyRow(), decoded = decodeDesktopPanelMetadata(rawRow(row));
    expect(decoded[0]).toMatchObject({ selectedID: 'desktop-browser', rail: 'files', activeView: 'preview' });
    expect(decoded[0].tabs).toEqual([row.tabs[0], { id: 'desktop-browser', kind: 'browser', url: 'https://first.invalid/' }, row.tabs[2], row.tabs[4]]);
    const tabs = createDesktopPanelTabs(); expect(tabs.restoreMetadata([row])).toBe(true);
    expect(tabs.metadata()).toEqual(decoded); expect(decodeDesktopPanelMetadata(encodeDesktopPanelMetadata(tabs.metadata()))).toEqual(decoded);
    expect(tabs.open(scope, { kind: 'browser', url: 'https://new.invalid/' })).toBe('desktop-browser'); expect(tabs.snapshot(scope).tabs).toHaveLength(4);
  });

  it('uses last saved browser order when a file is selected, keeping that file selection and all other order unchanged', () => {
    const row = legacyRow(); row.selectedID = row.tabs[4].id;
    const [decoded] = decodeDesktopPanelMetadata(rawRow(row));
    expect(decoded.tabs).toEqual([row.tabs[0], row.tabs[2], { id: 'desktop-browser', kind: 'browser', url: 'http://localhost:3000/last' }, row.tabs[4]]);
    expect(decoded.selectedID).toBe(row.selectedID);
  });

  it('supports mixed current/legacy and selected empty records without guessing a URL; malformed, forged or duplicate IDs remain rejected', () => {
    const row = legacyRow(); row.tabs.splice(2, 0, { id: 'desktop-browser', kind: 'browser', url: '' }); row.selectedID = 'desktop-browser';
    const [decoded] = decodeDesktopPanelMetadata(rawRow(row));
    expect(decoded.tabs.filter(tab => tab.kind === 'browser')).toEqual([{ id: 'desktop-browser', kind: 'browser', url: '' }]);
    for (const alter of [
      (row: DesktopPanelMetadata) => { row.tabs[1].id = JSON.stringify(['browser', 'https://forged.invalid/']); },
      (row: DesktopPanelMetadata) => { row.tabs.push({ ...row.tabs[1] }); },
      (row: DesktopPanelMetadata) => { row.tabs[1] = legacyBrowser('javascript:alert(1)'); },
      (row: DesktopPanelMetadata) => { row.selectedID = 'missing'; },
    ]) { const invalid = legacyRow(); alter(invalid); expect(() => decodeDesktopPanelMetadata(rawRow(invalid))).toThrow(); }
  });

  it('reads legacy prior without rewriting, rolls failed conversion back to exact prior, and explicitly retries latest URL only', async () => {
    const prior = rawRow(legacyRow()); let stored = prior;
    const storage = { getItem: vi.fn(async () => stored), setItem: vi.fn(async (_key: string, value: string) => { stored = value; }), removeItem: vi.fn(async () => {}) };
    const tabs = createDesktopPanelTabs(), lane = createDesktopPanelTabsPersistence(tabs, storage);
    expect(await lane.restore()).toBe(true); expect(storage.setItem).not.toHaveBeenCalled(); expect(stored).toBe(prior);
    storage.setItem.mockImplementationOnce(async (_key, value) => { stored = value; throw new Error('synthetic failed ACK'); });
    const id = tabs.open(scope, { kind: 'browser', url: 'https://next.invalid/' });
    expect(await lane.flush()).toBe(false); expect(stored).toBe(prior); expect(lane.state().error).toBe('write');
    tabs.open(scope, { kind: 'browser', url: 'https://latest.invalid/' }); expect(storage.setItem).toHaveBeenCalledTimes(2);
    expect(await lane.retry()).toBe(true); const [saved] = decodeDesktopPanelMetadata(stored);
    expect(saved.selectedID).toBe(id); expect(saved.tabs.filter(tab => tab.kind === 'browser')).toEqual([{ id, kind: 'browser', url: 'https://latest.invalid/' }]);
    lane.dispose();
  });

  it('late legacy restore cannot replace live browser intent, selected file or adopted owner in the same scope', async () => {
    let resolve!: (value: string) => void; let stored = rawRow(legacyRow());
    const storage = { getItem: vi.fn(async () => stored), setItem: vi.fn(async (_key: string, value: string) => { stored = value; }), removeItem: vi.fn(async () => {}) };
    storage.getItem.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const tabs = createDesktopPanelTabs(), lane = createDesktopPanelTabsPersistence(tabs, storage), reading = lane.restore();
    const browser = tabs.open(scope, { kind: 'browser', url: 'https://live.invalid/' }), file = tabs.open(scope, { kind: 'file', path: 'live.ts' });
    const live = tabs.snapshot(scope); resolve(stored); expect(await reading).toBe(true);
    expect(tabs.snapshot(scope)).toBe(live); expect(tabs.snapshot(scope).selectedID).toBe(file);
    expect(tabs.snapshot(scope).tabs).toEqual([{ id: browser, kind: 'browser', url: 'https://live.invalid/' }, { id: file, kind: 'file', path: '/workspace/live.ts' }]); lane.dispose();
  });
});
