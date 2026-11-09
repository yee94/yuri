import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('real SettingsPreferences and NativeDesktopPanel share one device diff preference owner without Host preference writes', () => {
  const root = path.dirname(fileURLToPath(import.meta.url)), parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true }); const temporary = mkdtempSync(path.join(parent, 'diff-preferences-'));
  try {
    writeFileSync(path.join(temporary, 'nsh.json'), JSON.stringify({ name: 'Diff preferences fixture', id: 'example.yuri.diff-preferences', version: '0.1.0', build: 1, theme: path.join(root, 'theme.json'), capabilities: { clipboard: true, host: ['connection.list', 'runtime.request'] } }));
    writeFileSync(path.join(temporary, 'App.tsx'), `import ${JSON.stringify(path.join(root, 'desktop-diff-preferences.fixture.tsx'))};`);
    writeFileSync(path.join(temporary, 'Preferences.test.tsx'), `
import { expect, open, test } from 'nsh/test';
const key = 'desktop.diff-preferences.v1';
const control = (app, action) => app.host.send('diff-preferences.control', { action });
async function audit(app) { const before = app.texts().find(value => value.startsWith('diff-pref-audit:{')); await control(app, 'audit'); await app.waitUntil(() => app.texts().some(value => value.startsWith('diff-pref-audit:{') && value !== before)); return JSON.parse(app.texts().find(value => value.startsWith('diff-pref-audit:{')).slice('diff-pref-audit:'.length)); }
async function launch(platform = 'macos', storage = {}, params = {}) {
  const requests = [], rejected = [];
  const app = await open('./App.tsx', { platform, width: 1400, height: 1100, storage, host: { params, handlers: {
    'connection.list': () => ({ selected: 'A', connections: [{ id: 'A', url: 'https://a.example', authorizationID: 'auth-A' }], runtimeScope: { hostID: 'A', lease: 'lease-A' } }),
    'runtime.request': input => {
      requests.push(input); if (input.method !== 'GET' || input.body !== undefined || input.expectedHost?.hostID !== 'A') { rejected.push(input); throw new Error('No Host mutation'); }
      if (input.path === '/api/config/settings') return { status: 200, body: { diffLayoutPreference: 'dynamic', showReasoningTraces: true } };
      if (input.path.startsWith('/api/git/diff?')) return { status: 200, body: { diff: '@@ -1,3 +1,3 @@\\n SAME\\n-BEFORE_WORKSPACE\\n+AFTER_WORKSPACE\\n TAIL\\n' } };
       const url = new URL(input.path, 'https://a.example');
       if (url.pathname === '/api/git/status') return { status: 200, body: { isClean: false, files: [{ path: url.searchParams.get('directory') === '/parent' ? 'a.ts' : 'b.ts', index: ' ', working_dir: 'M' }] } };
      if (url.pathname === '/api/fs/stat') return { status: 200, body: { path: url.searchParams.get('path'), isFile: true, size: 12, mtimeMs: 1, isBinary: false } };
      if (url.pathname === '/api/fs/read') return { status: 200, body: 'line one\\nline two\\nline three' };
      rejected.push(input); throw new Error('Unexpected route ' + input.path);
    },
  } } });
  await app.waitFor('id:settings-preference-diffLayoutPreference'); return { app, requests, rejected };
}
async function choose(app, label) { await app.press('id:settings-preference-diffLayoutPreference'); await app.waitFor('text:' + label); await app.press('text:' + label); }
for (const platform of ['macos', 'windows']) {
 test(platform + ' actual local Settings save drives retained native diff, per-file override, wrap, multi-scope and exact editor action', async () => {
  const { app, requests, rejected } = await launch(platform); const initial = await audit(app); expect(initial.state.value.layoutPreference).toBe('inline');
  const settingsReads = requests.length; for (let i = 0; i < 50; i++) await app.type('id:diff-preferences-input', 'x');
  const untouched = await audit(app); expect(untouched.reads).toBe(initial.reads); expect(untouched.writes).toBe(0); expect(requests.length).toBe(settingsReads);
  await control(app, 'duplicate'); await app.waitFor('text:diff-pref-result:duplicate:rejected');
  await choose(app, 'Always side-by-side'); await app.press('id:settings-preferences-save'); await app.waitFor('text:Saved');
  const saved = await audit(app); expect(saved.sameOwner).toBe(true); expect(saved.writes).toBe(1); expect(saved.state.value.layoutPreference).toBe('side-by-side'); expect(saved.canClose).toBe(true);
  expect(JSON.parse(app.storage()[key])).toEqual({ version: 1, layoutPreference: 'side-by-side', wrapLines: false });
  await control(app, 'panel'); await app.waitFor('text:AFTER_WORKSPACE'); expect(app.texts().filter(value => value === 'SAME').length).toBe(2);
   expect(app.shows('id:desktop-diff-list-files')).toBe(false); await app.press('id:desktop-diff-list-layout'); expect(app.texts().filter(value => value === 'SAME').length).toBe(1);
   await app.press('id:desktop-diff-list-wrap'); await app.waitUntil(() => JSON.parse(app.storage()[key]).wrapLines === true);
  const before = await audit(app), requestCount = requests.length;
  for (let i = 0; i < 50; i++) await app.type('id:diff-preferences-input', 'x');
  const after = await audit(app); expect(after.reads).toBe(before.reads); expect(after.writes).toBe(before.writes); expect(requests.length).toBe(requestCount);
  expect(after.a.fileLayout).toBe('inline'); expect(after.state.value.layoutPreference).toBe('side-by-side');
  await control(app, 'scope'); await app.waitFor('text:AFTER_WORKSPACE'); expect(app.texts().filter(value => value === 'SAME').length).toBe(2); expect((await audit(app)).b.wrapLines).toBe(true);
  await app.press('id:desktop-diff-open-editor'); await app.waitFor('id:desktop-file-editor');
  const file = (await audit(app)).tabs.tabs.at(-1); expect(file).toMatchObject({ kind: 'file', path: '/second/b.ts', targetLine: 2 });
  expect(rejected).toEqual([]); expect(requests.every(row => row.method === 'GET')).toBe(true);
 });
 test(platform + ' file-diff uses singleFileView, no extra sidebar/controls, while consuming the same global projection', async () => {
  const { app, rejected } = await launch(platform, { [key]: JSON.stringify({ version: 1, layoutPreference: 'side-by-side', wrapLines: true }) });
  await control(app, 'file-diff'); await app.waitFor('text:AFTER_HISTORY'); expect(app.texts().filter(value => value === 'SAME').length).toBe(2);
  expect(app.shows('id:desktop-diff-wrap')).toBe(false); expect(app.shows('id:desktop-diff-layout')).toBe(false); expect(app.shows('id:desktop-diff-open-editor')).toBe(false); expect(app.shows('id:desktop-diff-files')).toBe(false);
  const snapshot = await audit(app); expect(snapshot.writes).toBe(0); expect(snapshot.state.value.wrapLines).toBe(true); expect(rejected).toEqual([]);
 });
}
test('Settings failure preserves prior preference and its draft, explicit retry is local-only; malformed restore stays unavailable', async () => {
 const { app, requests, rejected } = await launch(); await choose(app, 'Always side-by-side'); await control(app, 'fail-preflight'); await app.press('id:settings-preferences-save'); await app.waitFor('id:settings-diff-preferences-error');
 let state = await audit(app); expect(state.state.value.layoutPreference).toBe('inline'); expect(state.writes).toBe(0); expect(app.shows('id:settings-preference-diffLayoutPreference >> text:Always side-by-side')).toBe(true);
 await app.press('id:settings-diff-preferences-retry'); await app.waitUntil(() => !app.shows('id:settings-diff-preferences-error')); state = await audit(app); expect(state.state.value.layoutPreference).toBe('side-by-side'); expect(state.writes).toBe(1); expect(rejected).toEqual([]);
 const bad = await launch('macos', { [key]: '{malformed' }); await bad.app.waitFor('id:settings-diff-preferences-error'); expect((await audit(bad.app)).state.hydrated).toBe(false); expect(bad.app.storage()[key]).toBe('{malformed');
 await control(bad.app, 'restore-valid'); await bad.app.waitFor('text:diff-pref-result:retry:true'); expect((await audit(bad.app)).state.value.layoutPreference).toBe('dynamic');
 expect(requests.every(row => row.method === 'GET')).toBe(true);
});
test('unknown local write only reconciles reads and keeps close veto until its exact candidate is observed', async () => {
 const { app, requests } = await launch(); await choose(app, 'Always side-by-side'); await control(app, 'lose-ack'); await app.press('id:settings-preferences-save'); await app.waitFor('id:settings-diff-preferences-error');
 const before = await audit(app); expect(before.state.error).toBe('unknown'); expect(before.canClose).toBe(false); expect(before.state.value.layoutPreference).toBe('inline'); expect(before.writes).toBe(1);
 await app.press('id:settings-diff-preferences-retry'); await app.waitUntil(() => !app.shows('id:settings-diff-preferences-error')); const after = await audit(app); expect(after.writes).toBe(1); expect(after.state.value.layoutPreference).toBe('side-by-side'); expect(after.canClose).toBe(true); expect(requests.every(row => row.method === 'GET')).toBe(true);
});
test('held production Settings save keeps the close veto and flush waits for its late API ACK', async () => {
 const { app, requests } = await launch(); await choose(app, 'Always side-by-side'); await control(app, 'hold-write'); await app.press('id:settings-preferences-save');
 const pending = await audit(app); expect(pending.state.writing).toBe(true); expect(pending.canClose).toBe(false); expect(pending.available).toBe(false); expect(pending.state.value.layoutPreference).toBe('inline');
 await control(app, 'flush'); expect(app.shows('text:diff-pref-result:flush:true')).toBe(false); await control(app, 'release-write'); await app.waitFor('text:diff-pref-result:flush:true');
 const done = await audit(app); expect(done.canClose).toBe(true); expect(done.state.value.layoutPreference).toBe('side-by-side'); expect(requests.every(row => row.method === 'GET')).toBe(true);
});
test('multi-Engine without native coordination remains explicit unavailable and performs zero preference IO', async () => {
 const { app } = await launch('macos', {}, { multiEngine: true }); await app.waitFor('id:settings-diff-preferences-error'); const state = await audit(app);
 expect(state.state.error).toBe('unsupported'); expect(state.reads).toBe(0); expect(state.writes).toBe(0); expect(state.sameOwner).toBe(true);
  await control(app, 'panel'); await app.waitFor('text:AFTER_WORKSPACE'); expect(app.shows('id:desktop-diff-list-layout')).toBe(false); expect(app.shows('id:desktop-diff-list-wrap')).toBe(false);
});
test('existing mobile diff setting stays unavailable even if a desktop root instance exists; no extra setting or local write is admitted', async () => {
 const { app, requests } = await launch('ios'); const before = await audit(app);
 try { await app.press('id:settings-preference-diffLayoutPreference'); } catch {}
 expect(app.shows('text:Always side-by-side')).toBe(false); expect(app.enabled('id:settings-preferences-save')).toBe(false);
 const after = await audit(app); expect(after.writes).toBe(0); expect(after.reads).toBe(before.reads); expect(requests.every(row => row.method === 'GET')).toBe(true);
});
`);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'Preferences.test.tsx'], { cwd: temporary, encoding: 'utf8', timeout: 160_000, maxBuffer: 4 * 1024 * 1024 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout + result.stderr).not.toContain('error unhandled rejection');
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 180_000);
