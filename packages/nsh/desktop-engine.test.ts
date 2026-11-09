import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test('real NSH imports desktop APIs off-native, updates locale and retires/reinstalls root ownership', () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const parent = path.join(process.env.TMPDIR || tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true });
  const temporary = mkdtempSync(path.join(parent, 'desktop-chrome-'));
  try {
    writeFileSync(path.join(temporary, 'nsh.json'), JSON.stringify({ name: 'Yuri', id: 'example.yuri.desktop-fixture', version: '0.1.0', build: 1, theme: path.join(root, 'theme.json') }));
    writeFileSync(path.join(temporary, 'App.tsx'), `import ${JSON.stringify(path.join(root, 'desktop-fixture.tsx'))};\n`);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'App.tsx'], { cwd: temporary, encoding: 'utf8', timeout: 60_000, input: [
      'await app.waitFor("id:desktop-fixture-state");',
      'expect(app.texts().join("\\n")).toContain("\\\"available\\\":false");',
      'expect(app.shows("id:native-desktop-titlebar")).toBe(false);',
      'expect(app.texts()).toContain("Yuri|Sessions|Edit");',
      'await app.press("id:desktop-fixture-language");',
      'await app.waitFor("text:Yuri|会话|编辑");',
      'await app.press("id:desktop-fixture-toggle");',
      'await app.waitUntil(() => !app.shows("id:desktop-fixture-labels"));',
      'await app.press("id:desktop-fixture-toggle");',
      'await app.waitFor("text:Yuri|会话|编辑");',
      'await app.press("id:desktop-fixture-language");',
      'await app.waitFor("text:Yuri|Sessions|Edit");',
      'expect(app.texts().join("\\n")).toContain("\\\"calls\\\":0");',
    ].join('\n') });
    expect(result.error, result.stdout + result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 75_000);

test('menu overrides and precise native/headless accelerator ownership share the real shortcut engine', () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const temporary = mkdtempSync(path.join(process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode'), 'desktop-menu-shortcuts-'));
  try {
    writeFileSync(path.join(temporary, 'nsh.json'), JSON.stringify({ name: 'Menu fixture', id: 'example.yuri.menu-shortcuts', version: '0.1.0', build: 1, theme: path.join(root, 'theme.json') }));
    writeFileSync(path.join(temporary, 'App.tsx'), `import ${JSON.stringify(path.join(root, 'desktop-shortcuts-menu-fixture.tsx'))};\n`);
    writeFileSync(path.join(temporary, 'Menu.test.tsx'), `
import { expect, open, test } from 'nsh/test';
for (const os of ['macos', 'windows']) test(os + ' menu/keymap ownership model', async () => {
  const app = await open('./App.tsx', { platform: os, width: 900, height: 600 });
  await app.waitFor('text:ready');
  const mod = os === 'macos' ? 'cmd' : 'ctrl';
  expect(app.texts()).toContain('owned:[]');
  expect(app.texts()).toContain('shortcuts:' + JSON.stringify([mod + '+,', mod + '+p']));
  await app.keyboard.press('mod+p'); expect(app.texts()).toContain('calls:1');
  await app.press('id:override');
  expect(app.texts()).toContain('shortcuts:' + JSON.stringify([mod + '+,', 'alt+f8']));
  await app.keyboard.press('mod+p'); expect(app.texts()).toContain('fallback:1');
  await app.keyboard.press('alt+f8'); expect(app.texts()).toContain('calls:2');
  await app.press('id:unassign');
  expect(app.texts()).toContain('shortcuts:' + JSON.stringify([mod + '+,', null]));
  await app.keyboard.press('alt+f8'); expect(app.texts()).toContain('calls:2');
  await app.press('id:restore'); await app.press('id:claim');
  expect(app.texts()).toContain('owned:' + JSON.stringify([mod + '+,', mod + '+p']));
  await app.keyboard.press('mod+p'); expect(app.texts()).toContain('calls:2'); expect(app.texts()).toContain('fallback:2');
  await app.press('id:menu'); await app.chooseMenuItem('Sessions > Search sessions');
  expect(app.texts()).toContain('calls:3');
  await app.press('id:settings');
  expect(app.texts()).toContain('owned:' + JSON.stringify([mod + '+,']));
  await app.press('id:menu'); expect(app.menu().find(item => item.label === 'Sessions > Search sessions').disabled).toBe(true); await app.closeMenu();
  await app.keyboard.press('mod+p'); expect(app.texts()).toContain('calls:3');
  await app.press('id:settings'); await app.press('id:claim');
  expect(app.texts()).toContain('owned:[]');
  await app.keyboard.press('mod+p'); expect(app.texts()).toContain('calls:4');
});
`);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'Menu.test.tsx'], { cwd: temporary, encoding: 'utf8', timeout: 60_000 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 75_000);

test('real NSH desktop headless keeps leading, heading and actions separate through resize and opens one grouped App popup', () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const parent = path.join(process.env.TMPDIR || tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true });
  const temporary = mkdtempSync(path.join(parent, 'desktop-chrome-slots-'));
  try {
    writeFileSync(path.join(temporary, 'nsh.json'), JSON.stringify({ name: 'Yuri', id: 'example.yuri.desktop-slots', version: '0.1.0', build: 1, theme: path.join(root, 'theme.json') }));
    writeFileSync(path.join(temporary, 'App.tsx'), `import ${JSON.stringify(path.join(root, 'desktop-fixture.tsx'))};\n`);
    writeFileSync(path.join(temporary, 'Chrome.test.tsx'), `
import { expect, open, test } from 'nsh/test';
for (const os of ['macos', 'windows']) {
  test(os + ' desktop slot layout and application menu (headless model only)', async () => {
    const app = await open('./App.tsx', { platform: os, width: 1100, height: 700 });
    await app.waitFor('id:native-desktop-titlebar');
    expect(app.shows('id:native-desktop-title')).toBe(true);
    expect(app.count('id:native-desktop-app-menu')).toBe(os === 'windows' ? 1 : 0);
    expect(app.shows('id:native-desktop-menu-0')).toBe(false);
    await app.press('id:desktop-fixture-slots');
    await app.waitFor('id:desktop-fixture-heading');
    expect(app.shows('id:native-desktop-title')).toBe(false);
    expect(app.shows('id:desktop-fixture-search')).toBe(true);
    expect(app.shows('id:desktop-fixture-right-action')).toBe(true);
    const measure = async () => {
      await app.press('id:desktop-fixture-measure');
      return JSON.parse(app.texts().find(text => text.startsWith('CHROME_METRICS ')).slice('CHROME_METRICS '.length));
    };
    const wide = await measure();
    expect(Math.abs(wide[1].pagePosition.x - 260) < 1).toBe(true);
    expect(wide[0].pagePosition.x < wide[1].pagePosition.x).toBe(true);
    expect(wide[1].pagePosition.x + wide[1].bounds.size.width <= wide[2].pagePosition.x).toBe(true);
    await app.setViewport(520, 700);
    const narrow = await measure();
    expect(Math.abs(narrow[1].pagePosition.x - 260) < 1).toBe(true);
    expect(narrow[1].bounds.size.width < wide[1].bounds.size.width).toBe(true);
    expect(narrow[1].pagePosition.x + narrow[1].bounds.size.width <= narrow[2].pagePosition.x).toBe(true);
    expect(narrow[2].pagePosition.x + narrow[2].bounds.size.width <= 512).toBe(true);
    expect(narrow[2].bounds.size.width).toBe(112);
    await app.press('id:desktop-fixture-width');
    const changed = await measure();
    expect(Math.abs(changed[1].pagePosition.x - 180) < 1).toBe(true);
    await app.press('id:desktop-fixture-heading');
    await app.press('id:desktop-fixture-right-action');
    expect(app.texts().join('\\n')).toContain('"calls":2');
    if (os === 'windows') {
      await app.press('label:Open Yuri menu');
      expect(app.menu().map(item => item.label)).toContain('Sessions > Search sessions');
      expect(app.menu().filter(item => item.label.startsWith('Edit > ')).length).toBe(6);
      await app.chooseMenuItem('Sessions > Search sessions');
      expect(app.menu()).toBe(null);
      expect(app.texts().join('\\n')).toContain('"calls":3');
      await app.press('id:native-desktop-app-menu');
      await app.closeMenu();
      await app.press('id:desktop-fixture-language');
      await app.press('id:native-desktop-app-menu');
      expect(app.menu().map(item => item.label)).toContain('会话 > 搜索会话');
      await app.closeMenu();
    }
    await app.press('id:desktop-fixture-toggle');
    expect(app.shows('id:native-desktop-titlebar')).toBe(false);
    await app.press('id:desktop-fixture-toggle');
    await app.waitFor('id:desktop-fixture-heading');
  });
}
`);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'Chrome.test.tsx'], { cwd: temporary, encoding: 'utf8', timeout: 60_000 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 75_000);
