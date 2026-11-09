import { expect, it, vi } from 'vitest';
import { createDesktopPanelTabs, createSourceFileIntent, desktopPanelFileScope, desktopPanelScopeKey, type DesktopPanelFileSource, type DesktopPanelScope } from './desktop-panel-model';
import { decodeDesktopPanelMetadata, encodeDesktopPanelMetadata } from './desktop-panel-tabs-persistence';
import { createDesktopEditors, type DesktopEditorOperation } from './desktop-files-editor-model';
import { createDesktopEditorJournal } from './desktop-files-journal';
import { desktopPanelContentRequest, renderDesktopPanelContent } from './desktop-panel-tabs-renderers';

const parent: DesktopPanelScope = { host: { hostID: 'A', lease: 'lease-A' }, authorityKey: 'public-authority', sessionID: 'parent', directory: '/parent' };
const source = { directory: '/other', sessionID: 'child' };

it('explicit source scopes only content, preserves authority/lease, dedupes exact target and line, and keeps old metadata identities', () => {
  const tabs = createDesktopPanelTabs(), target = { ...source };
  const id = tabs.open(parent, createSourceFileIntent(parent, target, 'a.ts', 3));
  target.directory = '/mutated';
  expect(tabs.open(parent, createSourceFileIntent(parent, source, '/other/a.ts', 9))).toBe(id);
  const file = tabs.snapshot(parent).tabs[0];
  expect(file).toEqual({ kind: 'file', id, path: '/other/a.ts', source, targetLine: 9 });
  const own = desktopPanelFileScope(parent, { source });
  expect(own).toEqual({ ...parent, directory: '/other', sessionID: 'child' }); expect(own.host).toBe(parent.host);
  expect(() => tabs.open(parent, { kind: 'file', path: '/other/a.ts' })).toThrow();
  expect(tabs.open(parent, createSourceFileIntent(parent, { ...source, sessionID: 'other' }, '/other/a.ts'))).not.toBe(id);
  const legacy = tabs.open(parent, { kind: 'file', path: 'a.ts', targetLine: 4 });
  expect(legacy).toBe(JSON.stringify(['file', '/parent/a.ts']));
  expect(tabs.open(parent, createSourceFileIntent(parent, { directory: '/parent', sessionID: 'parent' }, 'a.ts', 5))).toBe(legacy);
  const html = tabs.open(parent, createSourceFileIntent(parent, source, 'index.html'));
  const raw = encodeDesktopPanelMetadata(tabs.metadata());
  expect(raw).not.toContain('lease-A'); expect(raw).not.toContain('text');
  const restored = createDesktopPanelTabs(); restored.restoreMetadata(decodeDesktopPanelMetadata(raw));
  expect(restored.snapshot(parent)).toEqual(tabs.snapshot(parent)); expect(restored.snapshot(parent).selectedID).toBe(html);
  const request = desktopPanelContentRequest(restored.snapshot(parent).tabs.at(-1)!);
  expect(request).toMatchObject({ kind: 'preview', source, target: { kind: 'html', path: '/other/index.html' } });
  expect(renderDesktopPanelContent({ preview: value => value }, request, { scope: parent, tabID: html, active: () => true, current: () => true })).toEqual(request);
});

it.each([
  null, {}, { directory: '/other' }, { ...source, host: { hostID: 'B' } }, { ...source, authorityKey: 'forged' },
  { ...source, lease: 'new' }, { ...source, sessionID: '' }, { ...source, directory: 'relative' }, { ...source, directory: '/other\u0080' },
])('fails closed on malformed source in live and cold metadata %#', value => {
  const tabs = createDesktopPanelTabs(); tabs.open(parent, { kind: 'context' }); const prior = tabs.snapshot(parent);
  expect(() => tabs.open(parent, { kind: 'file', path: 'a.ts', source: value as DesktopPanelFileSource })).toThrow();
  expect(tabs.snapshot(parent)).toBe(prior);
  const raw = JSON.parse(encodeDesktopPanelMetadata(tabs.metadata()));
  raw.scopes[0].tabs[0] = { kind: 'file', path: '/other/a.ts', id: 'forged', source: value };
  expect(() => decodeDesktopPanelMetadata(JSON.stringify(raw))).toThrow();
});

it('source containment and target line validation never relax legacy file/diff rules', () => {
  expect(() => createSourceFileIntent(parent, undefined as unknown as DesktopPanelFileSource, 'a.ts')).toThrow();
  for (const path of ['../escape.ts', '/parent/a.ts', '/other']) expect(() => createSourceFileIntent(parent, source, path)).toThrow();
  for (const line of [0, -1, 1.5, NaN, Infinity]) expect(() => createSourceFileIntent(parent, source, 'a.ts', line)).toThrow();
  const tabs = createDesktopPanelTabs();
  expect(() => tabs.open(parent, { kind: 'diff', source: { kind: 'workspace', directory: '/other' } })).toThrow();
});

it('Windows drive and UNC own sources use the same exact resolver without widening parent containment', () => {
  for (const directory of ['D:/child', '//server/share/child']) {
    const intent = createSourceFileIntent({ ...parent, directory: 'C:/parent' }, { ...source, directory }, 'nested/a.ts', 2);
    expect(intent).toMatchObject({ path: directory + '/nested/a.ts', source: { directory, sessionID: 'child' } });
    expect(() => createSourceFileIntent(parent, { ...source, directory }, '..\\escape.ts')).toThrow();
  }
});

function fixture() {
  const model = createDesktopEditors(), own = desktopPanelFileScope(parent, { source }), rows = new Map<string, string>();
  const journal = createDesktopEditorJournal({ keys: async () => [...rows.keys()], getItem: async key => rows.get(key) ?? null, setItem: async (key, value) => { rows.set(key, value); }, removeItem: async key => { rows.delete(key); }, sync: async () => {} }, model);
  const document = model.acquire(own, '/other/a.ts')!.document;
  const request = vi.fn(async (path: string, method = 'GET') => {
    if (method !== 'GET') throw new Error('unknown POST');
    const url = new URL(path, 'https://example.invalid');
    expect(url.searchParams.get('directory')).toBe('/other');
    if (url.pathname === '/api/fs/stat') return { path: '/other/a.ts', isFile: true, size: 4, mtimeMs: 1, isBinary: false };
    if (url.pathname === '/api/fs/read') return 'base';
    throw new Error('unexpected request');
  });
  const operation: DesktopEditorOperation = { scope: own, current: () => true, request };
  return { model, own, rows, journal, document, operation };
}

it('source documents pin the parent 20-scope LRU, and dirty/unknown recovery remains own-scoped without replay', async () => {
  const f = fixture(); await f.journal.ready; await f.model.load(f.document, f.operation); f.model.edit(f.document, 'dirty');
  const tabs = createDesktopPanelTabs(() => {}, { tabProtected: (scope, tab) => tab.kind === 'file' && f.model.scopeProtected(desktopPanelScopeKey(desktopPanelFileScope(scope, tab))) });
  tabs.open(parent, createSourceFileIntent(parent, source, 'a.ts'));
  for (let index = 0; index < 25; index++) tabs.open({ ...parent, sessionID: 'other-' + index }, { kind: 'context' });
  expect(tabs.metadata()).toHaveLength(20); expect(tabs.snapshot(parent).tabs).toHaveLength(1); expect(tabs.dispose()).toBe(false);
  await f.journal.checkpoint(f.document, { ...f.document.state(), pending: { text: 'dirty', wire: 'dirty' } });
  const restored = createDesktopEditors(), recovery = createDesktopEditorJournal(f.journal.storage, restored); await recovery.ready;
  const document = restored.peek(f.own, '/other/a.ts')!;
  expect(document.state()).toMatchObject({ text: 'dirty', error: 'unknown', pending: { text: 'dirty' } });
  expect(restored.peek(parent, '/parent/a.ts')).toBeUndefined(); expect(await restored.discard(document)).toBe(false);
  await restored.save(document, f.operation); await restored.save(document, f.operation);
  expect(f.operation.request.mock.calls.every(([, method]) => !method || method === 'GET')).toBe(true);
  const wrong = { ...f.operation, scope: { ...f.own, authorityKey: 'retired-authority' } };
  const before = f.operation.request.mock.calls.length; expect(await restored.save(document, wrong)).toBe(false); expect(f.operation.request.mock.calls.length).toBe(before);
  recovery.stop(); f.journal.stop();
});

it('exclusive unknown writer and filesystem mutation locks are shared by absolute path, not source directory aliases', async () => {
  const f = fixture(); await f.journal.ready; await f.model.load(f.document, f.operation); f.model.edit(f.document, 'first');
  expect(await f.model.save(f.document, f.operation)).toBe(false);
  expect(f.document.state().error).toBe('unknown');
  const alias = { ...parent, directory: '/', sessionID: 'another' }, second = f.model.acquire(alias, '/other/a.ts')!.document;
  const operation = { ...f.operation, scope: alias, request: vi.fn(async (path: string, method = 'GET') => {
    if (method !== 'GET') throw new Error('must never post');
    return path.startsWith('/api/fs/stat') ? { path: '/other/a.ts', isFile: true, size: 4, mtimeMs: 1, isBinary: false } : 'base';
  }) };
  await f.model.load(second, operation); f.model.edit(second, 'second'); expect(await f.model.save(second, operation)).toBe(false);
  expect(second.state().detail).toBe('desktop_file_write_in_progress'); expect(f.model.beginMutation(alias, '/other/a.ts')).toBeNull();
  f.journal.stop();
});
