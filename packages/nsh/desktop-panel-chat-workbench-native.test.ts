import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('production NativeDesktopPanel renders persisted native chat tabs with independent demand and no composer mutations', () => {
  const root = path.dirname(fileURLToPath(import.meta.url)), parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true }); const directory = mkdtempSync(path.join(parent, 'panel-chat-workbench-'));
  try {
    writeFileSync(path.join(directory, 'nsh.json'), JSON.stringify({ name: 'Workbench Chat fixture', id: 'example.yuri.workbench-chat', version: '0.1.0', build: 1, theme: path.join(root, 'theme.json'), capabilities: { clipboard: true, host: ['connection.list', 'runtime.request', 'runtime.stream', 'runtime.stop'] } }));
    writeFileSync(path.join(directory, 'App.tsx'), `import ${JSON.stringify(path.join(root, 'desktop-panel-chat-workbench.fixture.tsx'))};\n`);
    writeFileSync(path.join(directory, 'Workbench.test.tsx'), `
import { expect, open, test } from 'nsh/test';
function synthetic() {
  const requests = [], streams = [], stops = [], rejected = [];
  const user = (id, body) => ({ id, type: 'user', time: { created: 1000 }, content: [{ type: 'text', text: body }] });
  const handlers = {
    'connection.list': () => ({ selected: 'A', connections: [{ id: 'A', url: 'https://a.example', authorizationID: 'auth-A' }], runtimeScope: { hostID: 'A', lease: 'lease-A' } }),
    'runtime.stream': input => { streams.push(input); return true; }, 'runtime.stop': input => { stops.push(input); return true; },
    'runtime.request': input => {
      requests.push(input); if (input.method !== 'GET' || input.body !== undefined || input.expectedHost?.hostID !== 'A') { rejected.push(input); throw new Error('Writer forbidden'); }
      const url = new URL(input.path, 'https://a.example'), path = url.pathname;
      if (path === '/api/session/active') return { status: 200, body: {} };
      const match = /^\\/api\\/session\\/([^/]+)(?:\\/(message|inbox|form))?$/.exec(path);
      if (!match) { rejected.push(input); throw new Error('Unexpected wire ' + input.path); }
      const id = match[1], directory = id === 'parent' ? '/parent' : '/other';
      if (match[2] === undefined) return { status: 200, body: { id, title: id, location: { directory }, ...(id === 'child' ? { parentID: 'other' } : {}) } };
      if (match[2] === 'message') {
        if (url.searchParams.get('directory') !== directory) { rejected.push(input); throw new Error('Wrong target directory'); }
        if (id === 'tools') return { status: 200, body: { data: [{ id: 'toolmessage', type: 'assistant', finish: 'stop', content: [
          { type: 'tool', id: 'diff-snapshot', name: 'edit', state: { status: 'completed', input: { filePath: '/other/tool.ts', oldString: 'FIXED BEFORE', newString: 'FIXED AFTER' } } },
          { type: 'tool', id: 'file-snapshot', name: 'edit', state: { status: 'completed', input: { filePath: '/other/read.ts' } } },
          { type: 'text', text: 'TOOL BODY' },
        ] }], cursor: { next: null } } };
        const older = url.searchParams.has('cursor');
        return { status: 200, body: { data: older ? [user('old-' + id, 'OLDER ' + id)] : [user('new-' + id, 'BODY ' + id), ...Array.from({ length: 19 }, (_, i) => user('row-' + id + '-' + i, 'History ' + id + ' ' + i))], cursor: { next: older ? null : 'opaque-' + id } } };
      }
      return { status: 200, body: [] };
    },
  };
  // Primary blocking reads are expected; never allow a mutation or real service.
  const original = handlers['runtime.request']; handlers['runtime.request'] = input => input.path.startsWith('/api/permission/request?') ? { status: 200, body: [] } : original(input);
  return { handlers, requests, streams, stops, rejected };
}
const control = (app, action) => app.host.send('workbench.control', { action });
async function audit(app) { const before = app.texts().find(value => value.startsWith('workbench-audit:{')); await control(app, 'audit'); await app.waitUntil(() => app.texts().some(value => value.startsWith('workbench-audit:{') && value !== before)); return JSON.parse(app.texts().find(value => value.startsWith('workbench-audit:{')).slice('workbench-audit:'.length)); }
async function launch(platform = 'macos', storage = {}, params = {}) {
  const wire = synthetic(), app = await open('./App.tsx', { platform, width: 1600, height: 1000, storage, host: { params, handlers: wire.handlers } });
  await app.waitFor('id:native-desktop-panel'); return { app, wire };
}
for (const platform of ['macos', 'windows']) {
 test(platform + ' closing another tab restores the retained parent transcript body', async () => {
  const { app } = await launch(platform); await app.waitFor('text:BODY parent'); await control(app, 'other'); await app.waitFor('text:BODY other');
  await control(app, 'close'); await app.waitFor('text:BODY parent');
 });
 test(platform + ' background while another tab is selected must preserve the retained parent body', async () => {
  const { app } = await launch(platform); await app.waitFor('text:BODY parent'); await control(app, 'other'); await app.waitFor('text:BODY other');
  await app.setLifecycle('background'); await app.setLifecycle('active'); await control(app, 'close'); await app.waitFor('text:BODY parent');
 });
 test(platform + ' closing a tab after private navigation/back preserves the parent body', async () => {
  const { app } = await launch(platform); await app.waitFor('text:BODY parent'); await control(app, 'other'); await app.waitFor('text:BODY other');
  await app.press('id:workbench-child'); await app.waitFor('text:workbench-result:child'); await app.press('id:panel-chat-back');
  await control(app, 'close'); await app.waitFor('text:BODY parent');
 });
 test(platform + ' retained search and an explicitly focused history page survive tab hiding and background without another surface', async () => {
  const { app, wire } = await launch(platform); await app.waitFor('text:BODY parent');
  await app.type('id:panel-chat-search', 'retained query'); await app.press('id:workbench-focus'); await app.waitFor('text:workbench-result:focus'); await app.waitFor('text:OLDER parent');
  await control(app, 'other'); await app.waitFor('text:BODY other'); await app.setLifecycle('background'); await app.setLifecycle('active');
  await control(app, 'close'); await app.waitFor('text:OLDER parent'); expect(app.value('id:panel-chat-search')).toBe('retained query');
  const state = await audit(app); expect(state.registrations).toBe(2); expect(state.releases).toBe(1); expect(state.readers).toBe(1); expect(wire.rejected).toEqual([]);
 });
 test(platform + ' real workbench opens/reuses one same-target Chat, 50 writer edits add no stream/catalog plan, modal/hide retain owner and close only the reader', async () => {
  const { app, wire } = await launch(platform); await app.waitFor('text:BODY parent'); const before = wire.requests.length;
  expect(wire.streams.map(value => value.key)).toEqual(['chat']);
  await control(app, 'edit-50'); const state = await audit(app); expect(state.tabs).toBe(2); expect(state.registrations).toBe(1); expect(state.releases).toBe(0);
  expect(wire.requests.length).toBe(before); expect(wire.streams.length).toBe(1); expect(state.main).toBe('Workbench writer 49');
  const coveredReads = wire.requests.length, coveredStreams = wire.streams.length;
  await control(app, 'cover'); expect(app.enabled('id:panel-chat-search')).toBe(false); expect(app.enabled('id:desktop-panel-rail-files')).toBe(false); await app.press('id:workbench-child'); await app.waitFor('text:workbench-result:blocked'); expect(wire.stops).toEqual([]);
  await control(app, 'uncover'); expect(app.enabled('id:panel-chat-search')).toBe(true);
  expect(wire.requests.length).toBe(coveredReads); expect(wire.streams.length).toBe(coveredStreams);
  const uncovered = await audit(app); expect(uncovered.registrations).toBe(1); expect(uncovered.releases).toBe(0); expect(uncovered.readers).toBe(1);
  await control(app, 'hide'); const hidden = wire.requests.length; await control(app, 'edit-50'); expect(wire.requests.length).toBe(hidden); await control(app, 'show');
  await control(app, 'close'); await app.waitFor('text:Retained context'); expect(wire.stops).toEqual([]); expect(wire.rejected).toEqual([]);
 });
 test(platform + ' exact cross-directory target uses independent read stream, nested navigation/back preserves the tab, hide/background release only its lease', async () => {
  const { app, wire } = await launch(platform); await app.waitFor('text:BODY parent'); await control(app, 'other'); await app.waitFor('text:BODY other');
  const independent = wire.streams.find(value => value.key.startsWith('panel-chat:')); expect(independent).not.toBeUndefined(); expect(independent.path).toBe('/api/event?directory=%2Fother');
  await app.press('id:workbench-child'); await app.waitFor('text:workbench-result:child'); await app.waitFor('id:panel-chat-read-only-banner');
  await app.press('id:panel-chat-back'); await app.waitFor('text:BODY other');
  await control(app, 'cover'); const streams = wire.streams.length; expect(app.enabled('id:panel-chat-page:other >> id:panel-chat-search')).toBe(false); await control(app, 'uncover'); expect(wire.streams.length).toBe(streams);
  await control(app, 'hide'); expect(wire.stops.some(value => value.key.startsWith('panel-chat:'))).toBe(true); expect(wire.stops.every(value => value.key !== 'chat')).toBe(true);
  await control(app, 'show'); await app.waitFor('text:BODY other'); await app.setLifecycle('background'); const paused = wire.requests.length; await control(app, 'edit-50'); expect(wire.requests.length).toBe(paused); await app.setLifecycle('active');
  await control(app, 'close'); await app.waitFor('text:BODY parent'); expect(app.enabled('id:panel-chat-page:parent >> id:panel-chat-search')).toBe(true); expect(wire.rejected).toEqual([]);
 });
}
test('real metadata restoration admits chat target under parent owner scope and updated title/locator never adds another workbench tab', async () => {
 const first = await launch(); await first.app.waitFor('text:BODY parent'); await control(first.app, 'locate'); await first.app.waitFor('text:OLDER parent');
 const state = await audit(first.app); expect(state.tabs).toBe(2); expect(state.registrations).toBe(1); expect(state.releases).toBe(0);
 const envelope = JSON.parse(state.raw); const row = envelope.scopes[0]; expect(row.scope.directory).toBe('/parent'); expect(row.scope.sessionID).toBe('parent');
 expect(row.tabs.find(value => value.kind === 'chat').target).toEqual({ sessionID: 'parent', directory: '/parent', title: 'Retitled parent', messageID: 'old-parent' });
 const restored = await launch('macos', { 'desktop.panel-tabs.v1': state.raw }); await restored.app.waitFor('text:OLDER parent'); const next = await audit(restored.app); expect(next.tabs).toBe(2); expect(next.raw).toBe(state.raw); expect(restored.wire.rejected).toEqual([]);
});
 test('explicit disabled admission does not create a transcript reader merely because renderCard JSX exists; absent stream stays explicitly unsupported', async () => {
 const disabled = await launch('macos', {}, { disabled: true }); await disabled.app.waitFor('id:desktop-panel-chat-unavailable');
 const state = await audit(disabled.app); expect(state.registrations).toBe(0); expect(state.readers).toBe(0); expect(disabled.wire.streams.map(value => value.key)).toEqual(['chat']);
 const { app, wire } = await launch('macos', {}, { noStream: true }); await app.waitFor('text:BODY parent'); await control(app, 'other'); await app.waitFor('id:panel-chat-stream-unavailable');
 expect(wire.streams.map(value => value.key)).toEqual(['chat']); await control(app, 'disable'); await app.waitFor('id:desktop-panel-chat-unavailable');
 const before = wire.requests.length; await control(app, 'edit-50'); expect(wire.requests.length).toBe(before); expect(wire.rejected).toEqual([]);
});
test('actual transcript file/diff actions carry own target directory and fixed message snapshot, never parent scope Git', async () => {
 const id = JSON.stringify(['chat', '/other', 'tools']);
 const raw = JSON.stringify({ version: 1, scopes: [{ scope: { host: { hostID: 'A' }, authorityKey: JSON.stringify(['A', 'https://a.example', 'auth-A']), sessionID: 'parent', directory: '/parent' }, tabs: [{ kind: 'chat', id, target: { sessionID: 'tools', directory: '/other' } }], selectedID: id, rail: null, activeView: 'preview' }] });
 const { app, wire } = await launch('macos', { 'desktop.panel-tabs.v1': raw }); await app.waitFor('text:TOOL BODY');
  if (!app.shows('id:body-process:toolmessage:diff-snapshot')) await app.press('id:body-activity-toolmessage'); await app.press('id:body-process:toolmessage:diff-snapshot'); await app.waitFor('id:tool-expand-diff-snapshot'); await app.press('id:tool-expand-diff-snapshot');
 await app.waitUntil(() => app.texts().some(value => value.startsWith('diff-result:{')));
 const detail = JSON.parse(app.texts().find(value => value.startsWith('diff-result:{')).slice('diff-result:'.length));
 expect(detail.parent).toBe('parent'); expect(detail.source.sessionID).toBe('tools'); expect(detail.source.directory).toBe('/other'); expect(detail.source.messageID).toBe('toolmessage');
  expect(detail.source.files[0]).toEqual({ path: '/other/tool.ts', patch: '', before: 'FIXED BEFORE', after: 'FIXED AFTER' });
  await app.waitFor('id:desktop-native-diff'); await app.waitFor('text:FIXED AFTER');
  const persisted = await audit(app); expect(persisted.raw).not.toContain('FIXED BEFORE'); expect(persisted.raw).not.toContain('FIXED AFTER'); expect(persisted.raw).not.toContain('file-diff');
  await app.press('id:desktop-diff-open-file'); await app.waitUntil(() => app.texts().some(value => value.startsWith('file-result:{')));
  const preview = JSON.parse(app.texts().find(value => value.startsWith('file-result:{')).slice('file-result:'.length));
  expect(preview).toEqual({ directory: '/other', sessionID: 'tools', parent: 'parent', path: '/other/tool.ts' });
  await app.press('id:desktop-panel-tab-' + id);
  await app.press('id:tool-expand-file-snapshot'); await app.waitUntil(() => app.texts().some(value => value.startsWith('file-result:{')));
 const file = JSON.parse(app.texts().find(value => value.startsWith('file-result:{')).slice('file-result:'.length));
 expect(file).toEqual({ directory: '/other', sessionID: 'tools', parent: 'parent', path: '/other/read.ts' });
 expect(wire.requests.some(value => value.path.includes('/api/git/'))).toBe(false); expect(wire.rejected).toEqual([]);
});
`);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'Workbench.test.tsx'], { cwd: directory, encoding: 'utf8', timeout: 160_000 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 180_000);
