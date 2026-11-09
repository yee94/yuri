import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test.skipIf(process.env.NSH_DESKTOP_SETTINGS_ENGINE !== '1')('injected real shortcut page publishes draft/capture/storage guards and is absent from mobile SettingsHome', () => {
  const root = path.dirname(fileURLToPath(import.meta.url)), parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(path.join(parent, 'settings-shortcuts-slot-'));
  try {
    writeFileSync(path.join(directory, 'nsh.json'), JSON.stringify({ name: 'Shortcuts slot fixture', id: 'example.yuri.shortcuts-slot', version: '0.1.0', build: 1, theme: path.join(root, 'theme.json') }));
    writeFileSync(path.join(directory, 'App.tsx'), `import ${JSON.stringify(path.join(root, 'settings-shortcuts-slot-fixture.tsx'))};`);
    writeFileSync(path.join(directory, 'Slot.test.tsx'), `import { expect, open, test } from 'nsh/test';
test('actual slot, preferences and publisher feedback', async () => {
const app = await open('./App.tsx', { platform: 'macos', width: 1280, height: 1000 });
expect(app.texts()).not.toContain('Shortcuts'); expect(app.texts()).not.toContain('Keyboard Shortcuts');
expect(app.texts()).toContain('registry-shortcuts=true');
await app.press('id:shortcut-window-open'); await app.waitFor('id:desktop-shortcuts-settings'); await app.waitFor('text:protection=ready;pending=false;dirty=false;picker=false');
expect(app.texts()).toContain('slot-mounts=1;stored={}'); expect(app.texts()).toContain('Shortcuts');
await app.press('id:desktop-shortcut-capture-open_command_palette'); await app.waitFor('text:protection=ready;pending=false;dirty=false;picker=true');
expect(app.enabled('id:desktop-settings-close')).toBe(false); await app.keyboard.press('escape'); await app.waitFor('text:protection=ready;pending=false;dirty=false;picker=false'); expect(app.shows('id:desktop-settings-window')).toBe(true);
await app.press('id:desktop-shortcut-capture-open_command_palette'); await app.keyboard.press('alt+f8'); await app.waitFor('text:protection=ready;pending=false;dirty=true;picker=false');
app.onDialog(() => 'Cancel'); await app.press('id:desktop-settings-close'); expect(app.shows('id:desktop-shortcuts-settings')).toBe(true); expect(app.texts()).toContain('slot-mounts=1;stored={}');
await app.press('id:shortcut-write-hold'); await app.press('id:desktop-shortcut-save-open_command_palette'); await app.waitFor('text:protection=ready;pending=true;dirty=true;picker=false'); expect(app.enabled('id:desktop-settings-close')).toBe(false);
await app.press('id:shortcut-write-release'); await app.waitFor('text:protection=ready;pending=false;dirty=false;picker=false'); expect(app.texts()).toContain('slot-mounts=1;stored={"open_command_palette":"alt+f8"}');
await app.press('id:desktop-shortcut-capture-open_command_palette'); await app.keyboard.press('alt+f9'); await app.waitFor('text:protection=ready;pending=false;dirty=true;picker=false');
app.onDialog(() => 'Discard'); await app.press('id:desktop-settings-close'); await app.waitFor('id:desktop-settings-window', {state:'gone'});
await app.press('id:shortcut-window-open'); await app.waitFor('text:protection=ready;pending=false;dirty=false;picker=false'); expect(app.texts()).toContain('slot-mounts=2;stored={"open_command_palette":"alt+f8"}');
await app.press('id:desktop-settings-close'); await app.waitFor('id:desktop-settings-window', {state:'gone'});
});
test('iOS registry and SettingsHome never expose a desktop-only shortcut entry', async () => {
const app = await open('./App.tsx', { platform: 'ios', width: 390, height: 844 });
expect(app.texts()).toContain('registry-shortcuts=false'); expect(app.texts()).not.toContain('Shortcuts'); expect(app.texts()).not.toContain('Keyboard Shortcuts');
});
test('modal-disabled session actions and leader remain configurable without capture executing them', async () => {
const app = await open('./App.tsx', { platform: 'macos', width: 1280, height: 1000 });
await app.waitFor('text:executions=0'); await app.keyboard.press('mod+up'); await app.waitFor('text:executions=1');
await app.press('id:shortcut-window-open'); await app.waitFor('text:protection=ready;pending=false;dirty=false;picker=false');
await app.keyboard.press('mod+up'); expect(app.texts()).toContain('executions=1');
expect(app.enabled('id:desktop-shortcut-capture-open_model_selector')).toBe(false); expect(app.enabled('id:desktop-shortcut-reset-open_model_selector')).toBe(false);
expect(app.enabled('id:desktop-shortcut-capture-cycle_agent')).toBe(false);
for (let index = 1; index <= 9; index++) expect(app.shows('id:desktop-shortcut-capture-switch_tab_' + index)).toBe(false);
await app.press('id:desktop-shortcut-capture-previous_session'); await app.keyboard.press('mod+up'); expect(app.texts()).toContain('executions=1');
const ids = ['previous_session', 'next_session', 'leader_key'];
for (let index = 0; index < ids.length; index++) {
  const id = ids[index]; expect(app.enabled('id:desktop-shortcut-capture-' + id)).toBe(true); expect(app.enabled('id:desktop-shortcut-reset-' + id)).toBe(true);
  await app.press('id:desktop-shortcut-capture-' + id); await app.keyboard.press('mod+ctrl+shift+f' + (index + 1));
  await app.waitFor('text:protection=ready;pending=false;dirty=true;picker=false'); expect(app.enabled('id:desktop-shortcut-save-' + id)).toBe(true);
  await app.press('id:desktop-shortcut-save-' + id); await app.waitFor('text:protection=ready;pending=false;dirty=false;picker=false');
  expect(app.texts().some(text => text.includes('"' + id + '":"mod+ctrl+shift+f' + (index + 1) + '"'))).toBe(true);
  await app.press('id:desktop-shortcut-reset-' + id);
  if (app.shows('id:desktop-shortcuts-overwrite')) await app.press('id:desktop-shortcuts-overwrite');
  await app.waitFor('text:protection=ready;pending=false;dirty=false;picker=false'); expect(app.texts()).toContain('executions=1');
}
await app.press('id:desktop-settings-close'); await app.waitFor('id:desktop-settings-window', {state:'gone'});
await app.keyboard.press('mod+up'); await app.waitFor('text:executions=2');
});`);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'Slot.test.tsx'], { cwd: directory, encoding: 'utf8', timeout: 95_000 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 120_000);
