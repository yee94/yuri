import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
const directory = path.dirname(fileURLToPath(import.meta.url));

test('headless checks real native address input, changed same-tab intent, directory rejection and inactive admission; not a WK/WebView2 rendering claim', () => {
  const temporary = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'nsh-desktop-browser-'));
  try {
    writeFileSync(path.join(temporary, 'nsh.json'), JSON.stringify({ name: 'Browser fixture', id: 'example.yuri.browser', version: '0.1.0', build: 1, theme: path.join(directory, 'theme.json') }));
    writeFileSync(path.join(temporary, 'App.tsx'), `import ${JSON.stringify(path.join(directory, 'desktop-browser-fixture.tsx'))};\n`);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'App.tsx'], { cwd: temporary, encoding: 'utf8', timeout: 60_000, input: [
      'await app.waitFor("id:native-desktop-browser-pane");',
      'await app.press("id:fixture-preview");',
      'await app.waitFor("id:desktop-browser-viewport");',
      'expect(app.shows("text:browser-result:true")).toBe(true);',
      'await app.press("id:fixture-preview");',
      'expect(app.shows("text:browser-result:false")).toBe(true);',
      'await app.press("id:fixture-authority");',
      'await app.waitUntil(()=>!app.shows("id:desktop-browser-viewport"));',
      'await app.press("id:fixture-outside");',
      'expect(app.shows("id:desktop-browser-error")).toBe(true);',
      'await app.clear("id:desktop-browser-address"); await app.type("id:desktop-browser-address", "https://example.invalid/");',
      'await app.press("id:desktop-browser-go");',
      'await app.waitUntil(()=>!app.shows("id:desktop-browser-error"));',
      'await app.press("id:fixture-hide");',
      'await app.press("id:fixture-preview");',
      'expect(app.shows("text:browser-result:false")).toBe(true);',
    ].join('\n') });
    expect(result.error, result.stdout + result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 75_000);
