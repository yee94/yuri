import { describe, expect, test } from 'vitest';
import { createDesktopPanelTabs, DESKTOP_PANEL_SCOPE_LIMIT, desktopPanelFilePath, desktopPanelRailWidth, desktopPanelScopeKey, desktopPanelVisibility, type DesktopPanelScope } from './desktop-panel-model';
import { createChangesReader, type ChangesSource } from './chat-changes-model';

const scope: DesktopPanelScope = { host: { hostID: 'host-a', lease: 'lease-a' }, authorityKey: 'authority-a', sessionID: 'session-a', directory: '/workspace' };
describe('desktop panel tab owner', () => {
  test('explicit empty browser opens an address surface without guessing a URL or weakening nonempty URL admission', () => {
    const tabs = createDesktopPanelTabs();
    const id = tabs.open(scope, { kind: 'browser', url: '' });
    expect(tabs.open(scope, { kind: 'browser', url: '' })).toBe(id);
    expect(tabs.snapshot(scope).tabs).toEqual([{ kind: 'browser', url: '', id }]);
    for (const url of [' ', 'javascript:alert(1)', 'https://user:password@example.invalid/']) expect(() => tabs.open(scope, { kind: 'browser', url })).toThrow();
  });
  test('normalizes and deduplicates file tabs while updating line targets', () => {
    const tabs = createDesktopPanelTabs();
    const id = tabs.open(scope, { kind: 'file', path: 'folder/../source.ts' });
    tabs.open(scope, { kind: 'file', path: '/workspace/source.ts', targetLine: 81 });
    expect(tabs.snapshot(scope).tabs).toEqual([{ id, kind: 'file', path: '/workspace/source.ts', targetLine: 81 }]);
    expect(tabs.snapshot(scope).selectedID).toBe(id);
    expect(() => tabs.open(scope, { kind: 'file', path: '../../outside.ts' })).toThrow();
    expect(desktopPanelFilePath('/', 'a.ts')).toBe('/a.ts');
  });
  test('browser/HTML preview tabs deduplicate canonical intents, preserve authority partitions, and never admit arbitrary plugin formats', () => {
    const tabs = createDesktopPanelTabs();
    const html = tabs.open(scope, { kind: 'file', path: 'index.html' });
    expect(tabs.snapshot(scope).tabs[0]).toEqual({ kind: 'preview', path: '/workspace/index.html', id: html });
    expect(tabs.open(scope, { kind: 'preview', path: '/workspace/index.html' })).toBe(html);
    const browser = tabs.open(scope, { kind: 'browser', url: 'HTTPS://Example.invalid:443' });
    expect(tabs.open(scope, { kind: 'browser', url: 'https://example.invalid/' })).toBe(browser);
    const local = tabs.open(scope, { kind: 'browser', url: 'http://localhost:3000/' });
    expect(local).toBe(browser);
    expect(tabs.snapshot(scope).tabs.find(tab => tab.id === local)).toMatchObject({ kind: 'browser', url: 'http://localhost:3000/' });
    expect(tabs.snapshot({ ...scope, authorityKey: 'changed' }).tabs).toEqual([]);
    expect(tabs.snapshot({ ...scope, host: { ...scope.host, lease: 'renewed' } }).tabs).toHaveLength(2);
    for (const path of ['/outside/index.html', 'report.eficy', 'plugin.tsx']) expect(() => tabs.open(scope, { kind: 'preview', path })).toThrow();
    for (const url of ['file:///workspace/index.html', 'https://example.invalid/?token=secret', 'javascript:alert(1)']) expect(() => tabs.open(scope, { kind: 'browser', url })).toThrow();
  });
  test('isolates same files and rails by Host, session and effective directory; renewed leases keep UI identity', () => {
    const tabs = createDesktopPanelTabs(), id = tabs.open(scope, { kind: 'file', path: 'source.ts' });
    tabs.setRail(scope, 'files');
    const alternatives = [{ ...scope, sessionID: 'session-b' }, { ...scope, directory: '/worktree' }, { ...scope, host: { hostID: 'host-b', lease: 'lease-b' } }, { ...scope, authorityKey: 'changed-origin' }, { ...scope, authorityKey: 'changed-authorization' }, { ...scope, sessionID: null }];
    for (const other of alternatives) { expect(tabs.snapshot(other).tabs).toEqual([]); expect(tabs.snapshot(other).rail).toBe('git'); tabs.open(other, { kind: 'context' }); }
    expect(tabs.snapshot(scope).selectedID).toBe(id);
    expect(tabs.snapshot(scope).rail).toBe('files');
    expect(tabs.snapshot({ ...scope, host: { ...scope.host, lease: 'lease-new' } })).toBe(tabs.snapshot(scope));
    expect(desktopPanelScopeKey({ ...scope, directory: '/workspace/' })).toBe(desktopPanelScopeKey(scope));
  });
  test('missing or blank stable authority fails closed instead of falling back to Host ID', () => {
    for (const authorityKey of [undefined, '', ' ']) {
      expect(() => desktopPanelScopeKey({ ...scope, authorityKey } as DesktopPanelScope)).toThrow('Invalid desktop panel scope');
    }
  });
  test('closing falls back left, then right, never selects an unrelated tail; background close is stable', () => {
    const tabs = createDesktopPanelTabs();
    const ids = ['a', 'b', 'c', 'd'].map(path => tabs.open(scope, { kind: 'file', path }));
    tabs.select(scope, ids[1]); tabs.close(scope, ids[1]);
    expect(tabs.snapshot(scope).selectedID).toBe(ids[0]);
    tabs.close(scope, ids[3]); expect(tabs.snapshot(scope).selectedID).toBe(ids[0]);
    tabs.close(scope, ids[0]); expect(tabs.snapshot(scope).selectedID).toBe(ids[2]);
    tabs.setRail(scope, null); tabs.close(scope, ids[2]);
    expect(tabs.snapshot(scope)).toEqual({ tabs: [], selectedID: null, rail: 'git', activeView: 'rail' });
  });
  test('no-op open/select/close/rail changes preserve snapshots and issue no notifications', () => {
    let notifications = 0;
    const tabs = createDesktopPanelTabs(() => notifications++);
    const id = tabs.open(scope, { kind: 'context' }), snapshot = tabs.snapshot(scope);
    for (let i = 0; i < 50; i++) { tabs.open(scope, { kind: 'context' }); tabs.select(scope, id); tabs.close(scope, 'unknown'); }
    expect(notifications).toBe(1); expect(tabs.snapshot(scope)).toBe(snapshot);
  });
  test('empty workbenches are rail-only; compact open/select/rail transitions are synchronous and last close returns to rail', () => {
    const tabs = createDesktopPanelTabs();
    for (const width of [0, 320, 399, 400, 1400]) expect(desktopPanelVisibility(tabs.snapshot(scope), width)).toMatchObject({ rail: true, preview: false });
    tabs.setRail(scope, null); expect(tabs.snapshot(scope).rail).toBe('git');
    const id = tabs.open(scope, { kind: 'context' });
    expect(desktopPanelVisibility(tabs.snapshot(scope), 320)).toEqual({ compact: true, rail: false, preview: true });
    tabs.setRail(scope, 'files'); expect(desktopPanelVisibility(tabs.snapshot(scope), 320)).toMatchObject({ rail: true, preview: false });
    tabs.select(scope, id); expect(tabs.snapshot(scope).activeView).toBe('preview');
    tabs.setRail(scope, 'files'); tabs.open(scope, { kind: 'context' }); expect(tabs.snapshot(scope).activeView).toBe('preview');
    expect(desktopPanelVisibility(tabs.snapshot(scope), 800)).toEqual({ compact: false, rail: true, preview: true });
    tabs.close(scope, id); expect(tabs.snapshot(scope).activeView).toBe('rail');
    expect(desktopPanelVisibility(tabs.snapshot(scope), 320)).toMatchObject({ rail: true, preview: false });
    expect([undefined, 10, 1000, NaN].map(desktopPanelRailWidth)).toEqual([420, 240, 860, 420]);
  });
  test('Windows drive and UNC absolute files share the common resolver and cannot escape their workspace', () => {
    const tabs = createDesktopPanelTabs(), drive = { ...scope, directory: 'C:/workspace' };
    const id = tabs.open(drive, { kind: 'file', path: 'C:\\workspace\\source.ts' });
    expect(tabs.open(drive, { kind: 'file', path: 'source.ts' })).toBe(id);
    expect(tabs.snapshot(drive).tabs).toEqual([{ id, kind: 'file', path: 'C:/workspace/source.ts' }]);
    expect(() => tabs.open(drive, { kind: 'file', path: 'D:/workspace/source.ts' })).toThrow();
    expect(() => tabs.open(drive, { kind: 'file', path: '../outside.ts' })).toThrow();
    const unc = { ...scope, directory: '//host/share/project' };
    const uncID = tabs.open(unc, { kind: 'file', path: '\\\\host\\share\\project\\a.ts' });
    expect(tabs.open(unc, { kind: 'file', path: 'a.ts' })).toBe(uncID);
    expect(tabs.snapshot(unc).tabs[0]).toMatchObject({ path: '//host/share/project/a.ts' });
    expect(() => tabs.open(unc, { kind: 'file', path: '//other/share/project/a.ts' })).toThrow();
  });
  test('retains at most 20 scopes by actual access, without evicting a recently revisited scope', () => {
    const tabs = createDesktopPanelTabs();
    const scopes = Array.from({ length: DESKTOP_PANEL_SCOPE_LIMIT + 2 }, (_, index) => ({ ...scope, sessionID: 'session-' + index }));
    for (const item of scopes.slice(0, DESKTOP_PANEL_SCOPE_LIMIT)) tabs.open(item, { kind: 'context' });
    tabs.snapshot(scopes[0]);
    tabs.open(scopes[DESKTOP_PANEL_SCOPE_LIMIT], { kind: 'context' });
    expect(tabs.snapshot(scopes[1]).tabs).toEqual([]);
    expect(tabs.snapshot(scopes[0]).tabs.length).toBe(1);
    tabs.open(scopes[DESKTOP_PANEL_SCOPE_LIMIT + 1], { kind: 'context' });
    expect(tabs.snapshot(scopes[2]).tabs).toEqual([]);
    expect(tabs.snapshot(scopes[0]).tabs.length).toBe(1);
    tabs.dispose(); expect(tabs.snapshot(scopes[0]).tabs).toEqual([]);
  });
  test('workspace/staged/history/message/revision have independent identity and copied snapshots', async () => {
    const tabs = createDesktopPanelTabs();
    const files = [{ path: 'source.ts', before: 'old', after: 'HISTORICAL' }];
    const source: ChangesSource = { kind: 'turn', directory: scope.directory, sessionID: 'session-a', messageID: 'message-a', files, path: 'source.ts', revision: 1 };
    tabs.open(scope, { kind: 'diff', source });
    tabs.open(scope, { kind: 'diff', source });
    tabs.open(scope, { kind: 'diff', source: { ...source, messageID: 'message-b' } });
    tabs.open(scope, { kind: 'diff', source: { ...source, revision: 2 } });
    tabs.open(scope, { kind: 'diff', source: { kind: 'workspace', directory: scope.directory, path: 'source.ts' } });
    tabs.open(scope, { kind: 'diff', source: { kind: 'workspace', directory: scope.directory, path: 'source.ts', staged: true } });
    expect(tabs.snapshot(scope).tabs.length).toBe(5);
    files[0].after = 'CURRENT';
    const tab = tabs.snapshot(scope).tabs[0]; if (tab.kind !== 'diff') throw new Error('Expected diff');
    const reader = createChangesReader(tab.source, async () => { throw new Error('History must not read Git'); });
    await reader.select('source.ts');
    expect(reader.state().diff?.after).toBe('HISTORICAL');
    expect(() => tabs.open(scope, { kind: 'diff', source: { ...source, sessionID: 'other' } })).toThrow();
    expect(() => tabs.open(scope, { kind: 'diff', source: { ...source, directory: '/other' } })).toThrow();
  });
  test('same-message tool snapshots for one path do not overwrite history; exact reopen deduplicates', () => {
    const tabs = createDesktopPanelTabs();
    const source: ChangesSource = { kind: 'turn', directory: scope.directory, sessionID: 'session-a', messageID: 'message-a', files: [{ path: 'source.ts', before: 'one', after: 'two' }], path: 'source.ts' };
    const first = tabs.open(scope, { kind: 'diff', source });
    const second = tabs.open(scope, { kind: 'diff', source: { ...source, files: [{ path: 'source.ts', before: 'two', after: 'three' }] } });
    expect(first).not.toBe(second);
    expect(tabs.open(scope, { kind: 'diff', source })).toBe(first);
    expect(tabs.snapshot(scope).tabs.length).toBe(2);
  });
});
