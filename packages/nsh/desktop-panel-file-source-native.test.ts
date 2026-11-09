import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('production file tabs use own editor/preview source, native private journal, close guards and cold unknown recovery', () => {
  const root = path.dirname(fileURLToPath(import.meta.url)), parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true }); const directory = mkdtempSync(path.join(parent, 'panel-file-source-'));
  try {
    writeFileSync(path.join(directory, 'nsh.json'), JSON.stringify({ name: 'File source fixture', id: 'example.yuri.file-source', version: '0.1.0', build: 1, theme: path.join(root, 'theme.json'), capabilities: { clipboard: true, host: ['runtime.request', 'resources.read', 'resources.release', 'resources.cancel', 'resources.close', 'resources.web.close', 'desktop.files.journal.snapshot', 'desktop.files.journal.commit', 'desktop.files.journal.sync'] } }));
    writeFileSync(path.join(directory, 'App.tsx'), `import ${JSON.stringify(path.join(root, 'desktop-panel-file-source.fixture.tsx'))};`);
    writeFileSync(path.join(directory, 'Source.test.tsx'), `
import { expect, open, test } from 'nsh/test';
const source = { directory: '/other', sessionID: 'child' };
const control = (app, action, extra = {}) => app.host.send('file-source.control', { action, ...extra });
async function audit(app) { const before = app.texts().find(value => value.startsWith('source-audit:{')); await control(app, 'audit'); await app.waitUntil(() => app.texts().some(value => value.startsWith('source-audit:{') && value !== before)); return JSON.parse(app.texts().find(value => value.startsWith('source-audit:{')).slice('source-audit:'.length)); }
function backend() {
  let version = 0, requestID = null, records = {}, statStatus = 0, unknown = false, denyJournal = false;
  const requests = [], resourceReads = [], files = new Map();
  const snapshot = () => ({ status: 'ready', version, requestID, records: { ...records } });
  const handlers = {
    'desktop.files.journal.snapshot': () => snapshot(),
    'desktop.files.journal.commit': input => {
      if (denyJournal) return { status: 'denied', code: 'file_journal_storage_failed' };
      if (input.expectedVersion !== version) throw new Error('bad native CAS');
      version++; requestID = input.requestID; records = { ...input.records }; return snapshot();
    },
    'desktop.files.journal.sync': input => {
      if (input.version !== version || input.requestID !== requestID) return { status: 'denied', code: 'file_journal_not_committed' };
      return snapshot();
    },
    'runtime.request': input => {
      requests.push(input);
      if (input.expectedHost?.hostID !== 'A' || input.expectedHost?.lease !== 'lease-A') throw new Error('Wrong Host authority');
      const url = new URL(input.path, 'https://a.example'), p = url.pathname, file = url.searchParams.get('path');
      if (!p.startsWith('/api/fs/')) throw new Error('No session attach or fallback ' + input.path);
      if (p === '/api/fs/write') { if (unknown) throw new Error('WRITE_UNKNOWN'); files.set(input.body.path, input.body.content); return { status: 200, body: { success: true, path: input.body.path } }; }
      if (url.searchParams.get('directory') !== (file?.startsWith('/other/') ? '/other' : '/parent')) throw new Error('Wrong owning directory');
      if (p === '/api/fs/list') return { status: 200, body: { entries: [{ path: '/parent/tree.ts', isDirectory: false }] } };
      if (p === '/api/fs/stat') {
        if (statStatus) return { status: statStatus, body: { error: 'STAT_REJECTED' } };
        return { status: 200, body: { path: file, isFile: true, size: 10, mtimeMs: 1, isBinary: false, mimeType: 'text/plain' } };
      }
      if (p === '/api/fs/read') return { status: 200, body: files.get(file) ?? (file.endsWith('.md') ? '[Relative next](next.ts)\\r\\nMIXED\\n' : 'OWN SOURCE\\nline two\\nline three') };
      throw new Error('unexpected request ' + input.path);
    },
    'resources.read': input => { resourceReads.push(input); return { kind: 'text', lease: 'resource-synthetic', size: 10, text: '[Relative next](next.ts)\\n' }; },
    'resources.release': () => true, 'resources.cancel': () => true, 'resources.close': () => true, 'resources.web.close': () => true,
  };
  return { handlers, requests, resourceReads, snapshot, setStatus: value => { statStatus = value; }, setUnknown: value => { unknown = value; }, deny: value => { denyJournal = value; } };
}
async function launch(wire, platform = 'macos', storage = {}) {
  const app = await open('./App.tsx', { platform, width: 1500, height: 1000, storage, host: { handlers: wire.handlers } });
  await app.waitFor('id:native-desktop-panel'); return app;
}
for (const platform of ['macos', 'windows']) {
  test(platform + ' own target text editor and HTML binding remain workspace tabs; locator dedupe and rail distinction', async () => {
    const wire = backend(), app = await launch(wire, platform);
    await control(app, 'open', { line: 2 }); await app.waitFor('id:desktop-file-editor');
    for (let i = 0; i < 50; i++) await control(app, 'open', { line: 3 });
    const state = await audit(app); expect(state.snapshot.tabs.length).toBe(2); expect(state.snapshot.rail).toBe(null);
    expect(state.docs[0].scope).toEqual({ host: { hostID: 'A' }, authorityKey: 'authority-A', directory: '/other', sessionID: 'child' });
    expect(state.snapshot.tabs.at(-1).targetLine).toBe(3); expect(app.shows('id:source-parent-content')).toBe(true);
    await control(app, 'tree'); await app.waitUntil(() => app.texts().some(value => value === '/parent/tree.ts'));
    const tree = await audit(app); expect(tree.snapshot.rail).toBe('files');
    await control(app, 'open', { path: 'index.html' }); await app.waitFor('id:native-desktop-browser-pane');
    const html = await audit(app); expect(html.snapshot.tabs.at(-1)).toMatchObject({ kind: 'preview', path: '/other/index.html', source });
    expect(wire.requests.every(value => value.method === 'GET')).toBe(true);
  });
  test(platform + ' dirty indicator and close cancel/discard guard operate on own document; native journal never leaks into NSH Storage', async () => {
    const wire = backend(), app = await launch(wire, platform); await control(app, 'open'); await app.waitFor('id:desktop-file-editor');
    await app.type('id:desktop-file-editor', 'SOURCE DIRTY'); await control(app, 'flush'); await app.waitFor('text:source-result:flush:true:true');
    const state = await audit(app), id = state.snapshot.selectedID;
    expect(app.shows('id:desktop-tab-dirty-' + id)).toBe(true); expect(JSON.stringify(wire.snapshot().records)).toContain('SOURCE DIRTY');
    expect(JSON.stringify(app.storage())).not.toContain('SOURCE DIRTY'); expect(JSON.stringify(app.storage())).not.toContain('desktop-file-journal-v1:');
    app.onDialog(() => 'Cancel'); await control(app, 'window'); await app.waitFor('text:source-result:window:false');
    app.onDialog(() => 'Cancel'); await control(app, 'close'); await app.waitFor('text:source-result:close:false');
    expect((await audit(app)).snapshot.selectedID).toBe(id);
    app.onDialog(() => 'Discard'); await control(app, 'close'); await app.waitFor('text:source-result:close:true');
    expect((await audit(app)).snapshot.tabs.length).toBe(1); expect(wire.requests.every(value => value.method === 'GET')).toBe(true);
  });
  test(platform + ' production document relative link keeps its own source rather than parent directory', async () => {
    const wire = backend(), app = await launch(wire, platform); await control(app, 'open', { path: 'readme.md' }); await app.waitFor('text:Relative next');
    expect(wire.resourceReads.at(-1).path).toBe('/other/readme.md'); expect(wire.resourceReads.at(-1).expectedHost).toEqual({ hostID: 'A', lease: 'lease-A' });
    await app.press('text:Relative next'); await app.waitFor('id:desktop-file-editor');
    const state = await audit(app); expect(state.snapshot.tabs.at(-1)).toMatchObject({ kind: 'file', path: '/other/next.ts', source });
    expect(state.docs.at(-1).scope.directory).toBe('/other'); expect(app.shows('id:source-parent-content')).toBe(true);
  });
}
test('cold source dirty and unknown are restored through private native journal + public metadata; failed verification never repeats POST', async () => {
  const wire = backend(); let app = await launch(wire); await control(app, 'open'); await app.waitFor('id:desktop-file-editor');
  await app.type('id:desktop-file-editor', 'COLD OWN DRAFT'); await control(app, 'flush'); await app.waitFor('text:source-result:flush:true:true');
  const metadata = app.storage(); app = await launch(wire, 'macos', metadata); await app.waitFor('id:desktop-file-editor');
  expect(app.texts().some(value => value.includes('COLD OWN DRAFT'))).toBe(true); expect((await audit(app)).docs[0].scope.directory).toBe('/other');
  wire.setUnknown(true); await control(app, 'save'); await app.waitFor('text:source-result:save:false'); expect(wire.requests.filter(value => value.method === 'POST').length).toBe(1);
  const saved = app.storage(), posts = wire.requests.filter(value => value.method === 'POST').length;
  app = await launch(wire, 'macos', saved); await app.waitFor('id:desktop-file-editor');
  expect((await audit(app)).docs[0].state.error).toBe('unknown');
  for (const status of [401, 404, 0]) { wire.setStatus(status); await control(app, 'save'); await app.waitFor('text:source-result:save:false'); }
  expect(wire.requests.filter(value => value.method === 'POST').length).toBe(posts);
  app.onDialog(() => 'Cancel'); await control(app, 'close'); await app.waitFor('text:source-result:close:false'); expect(app.dialogs().at(-1).buttons.includes('Discard')).toBe(false);
  expect((await audit(app)).snapshot.tabs.length).toBe(2);
});
test('orphaned own-source journal stays reachable without metadata, and explicit close-save uses the real own file editor permission', async () => {
  const wire = backend(); let app = await launch(wire); await control(app, 'open'); await app.waitFor('id:desktop-file-editor');
  await app.type('id:desktop-file-editor', 'ORPHAN SOURCE'); await control(app, 'flush'); await app.waitFor('text:source-result:flush:true:true');
  app = await launch(wire); await app.press('id:desktop-panel-recovery'); await app.press('text:A · /other/a.ts'); await app.waitFor('id:desktop-file-editor');
  expect(app.texts().some(value => value.includes('ORPHAN SOURCE'))).toBe(true); expect((await audit(app)).snapshot.tabs.at(-1).source).toEqual(source);
  app.onDialog(() => 'Save changes'); await control(app, 'close'); await app.waitFor('text:source-result:close:true');
  const post = wire.requests.find(value => value.method === 'POST'); expect(post.path).toBe('/api/fs/write?directory=%2Fother'); expect(post.body.path).toBe('/other/a.ts');
  expect(JSON.stringify(wire.snapshot().records)).not.toContain('ORPHAN SOURCE');
});
test('external modal and retired Host deny programmatic save; native journal failure preserves buffer and stops before POST', async () => {
  const wire = backend(), app = await launch(wire); await control(app, 'open'); await app.waitFor('id:desktop-file-editor'); await app.type('id:desktop-file-editor', 'RETAIN ON FAILURE');
  await control(app, 'cover'); await control(app, 'save'); await app.waitFor('text:source-result:save:false'); expect(wire.requests.some(value => value.method === 'POST')).toBe(false);
  await control(app, 'uncover'); wire.deny(true); await control(app, 'save'); await app.waitFor('id:desktop-editor-journal-retry');
  expect(wire.requests.some(value => value.method === 'POST')).toBe(false); expect(app.texts().some(value => value.includes('RETAIN ON FAILURE'))).toBe(true);
  await control(app, 'retire'); const before = wire.requests.length; await control(app, 'save'); expect(wire.requests.length).toBe(before);
});
`);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'Source.test.tsx'], { cwd: directory, encoding: 'utf8', timeout: 150_000, maxBuffer: 4 * 1024 * 1024 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout + result.stderr).not.toContain('error unhandled rejection');
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 170_000);
