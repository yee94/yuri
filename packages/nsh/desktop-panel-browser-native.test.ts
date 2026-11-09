import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('production NativeDesktopPanel: same identity, drafts, authority, selection and 50 input edits (not application/OS page loading)', () => {
  const root = path.dirname(fileURLToPath(import.meta.url)), parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true }); const directory = mkdtempSync(path.join(parent, 'panel-browser-'));
  try {
    writeFileSync(path.join(directory, 'nsh.json'), JSON.stringify({ name: 'Panel browser fixture', id: 'example.yuri.panel-browser', version: '0.1.0', build: 1, theme: path.join(root, 'theme.json') }));
    writeFileSync(path.join(directory, 'App.tsx'), `import ${JSON.stringify(path.join(root, 'desktop-panel-browser.fixture.tsx'))};\n`);
    writeFileSync(path.join(directory, 'Browser.test.tsx'), `
import { expect, open, test } from 'nsh/test';
const control = (app, action, url) => app.host.send('browser.test.control', { action, url });
const audit = async app => { await control(app, 'audit'); return JSON.parse(app.texts().find(text => text.startsWith('{"snapshot"'))); };
const launch = async platform => { const app = await open('./App.tsx', { platform, width: 1000, height: 800 }); await app.waitFor('text:browser-fixture-ready:true'); return app; };
for (const platform of ['macos', 'windows']) {
  test(platform + ' Header empty and 50 real input edits keep one browser, draft, selection and zero metadata/source work', async () => {
    const app = await launch(platform); await control(app, 'header');
    await app.waitFor('id:desktop-browser-address'); const before = await audit(app);
    await app.type('id:desktop-browser-address', 'a'.repeat(50)); await app.type('id:browser-fixture-main-input', 'b'.repeat(50));
    const typed = await audit(app);
    expect(typed.reads).toBe(before.reads); expect(typed.writes).toBe(before.writes); expect(typed.notifications).toBe(before.notifications);
    expect(app.count('id:native-desktop-panel')).toBe(1); expect(app.count('id:native-desktop-browser-pane')).toBe(1); expect(app.requests()).toEqual([]); expect(app.openedUrls()).toEqual([]);
    await control(app, 'header'); expect(app.value('id:desktop-browser-address')).toBe('a'.repeat(50));
    await control(app, 'context'); await control(app, 'header'); expect(app.value('id:desktop-browser-address')).toBe('a'.repeat(50));
    expect(app.value('id:browser-fixture-main-input')).toBe('b'.repeat(50));
    const after = await audit(app); expect(after.snapshot.tabs.filter(tab => tab.kind === 'browser').length).toBe(1); expect(app.count('id:native-desktop-browser-pane')).toBe(1);
    expect(after.snapshot.tabs.find(tab => tab.kind === 'browser').url).toBe('');
  });
  test(platform + ' reactive changed intent reaches same native browser owner; invalid prior and Header reopen retain the address', async () => {
    const app = await launch(platform); await control(app, 'url', 'https://first.invalid/');
    await app.waitFor('id:desktop-browser-viewport'); expect(app.value('id:desktop-browser-address')).toBe('https://first.invalid/');
    const first = await audit(app); await control(app, 'url', 'http://localhost:3000/second');
    expect(app.value('id:desktop-browser-address')).toBe('http://localhost:3000/second');
    const next = await audit(app); expect(next.snapshot.selectedID).toBe(first.snapshot.selectedID); expect(next.snapshot.tabs.length).toBe(1); expect(app.count('id:native-desktop-browser-pane')).toBe(1);
    await control(app, 'url', 'javascript:alert(1)'); const invalid = await audit(app); expect(invalid.snapshot).toEqual(next.snapshot); expect(invalid.error.length > 0).toBe(true);
    await control(app, 'header'); expect(app.value('id:desktop-browser-address')).toBe('http://localhost:3000/second');
    await control(app, 'cover'); expect(app.enabled('id:desktop-browser-go')).toBe(false); await control(app, 'cover');
    expect(app.value('id:desktop-browser-address')).toBe('http://localhost:3000/second'); expect(app.requests()).toEqual([]); expect(app.openedUrls()).toEqual([]);
  });
  test(platform + ' address-bar navigation survives Header selection while Host partitions remain exact', async () => {
    const app = await launch(platform); await control(app, 'header');
    await app.type('id:desktop-browser-address', 'https://typed.invalid/'); await app.press('id:desktop-browser-go');
    const requested = await audit(app); expect(requested.snapshot.tabs[0].url).toBe(''); expect(requested.metadata[0].tabs[0].url).toBe(''); expect(requested.stored.scopes[0].tabs[0].url).toBe('');
    await control(app, 'context'); await control(app, 'header'); expect(app.value('id:desktop-browser-address')).toBe('https://typed.invalid/');
    await control(app, 'host'); expect(app.shows('id:native-desktop-browser-pane')).toBe(false); await control(app, 'header'); expect(app.value('id:desktop-browser-address')).toBe('');
    const other = await audit(app); expect(other.snapshot.tabs).toEqual([{ kind: 'browser', url: '', id: 'desktop-browser' }]);
    await control(app, 'host'); await control(app, 'header'); await app.waitFor('id:native-desktop-browser-pane'); const back = await audit(app);
    expect(back.snapshot.tabs.length).toBe(2); expect(back.snapshot.selectedID).toBe('desktop-browser'); expect(app.requests()).toEqual([]); expect(app.openedUrls()).toEqual([]);
  });
}
`);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'Browser.test.tsx'], { cwd: directory, encoding: 'utf8', timeout: 150_000 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 170_000);
