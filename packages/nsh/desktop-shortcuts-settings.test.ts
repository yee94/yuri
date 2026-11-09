import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, test } from 'vitest';

function headless(steps: string[], fixture = 'desktop-shortcuts-settings-fixture.tsx') {
  const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', fixture], {
    cwd: path.dirname(fileURLToPath(import.meta.url)), encoding: 'utf8', timeout: 60_000,
    input: ['await app.waitFor("text:ready");', ...steps].join('\n'),
  });
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}

test('real settings captures keys, confirms conflicts across aliases, persists overwrite and resets defaults', () => headless([
  'await app.press("id:desktop-shortcut-capture-open_command_palette");',
  'await app.keyboard.press("mod+i");',
  'await app.press("id:desktop-shortcut-save-open_command_palette");',
  'await app.waitFor("id:desktop-shortcuts-overwrite");',
  'await app.press("id:desktop-shortcuts-overwrite");',
  'await app.waitFor("text:stored:{\\"open_command_palette\\":\\"mod+i\\",\\"focus_input\\":\\"__unassigned__\\"}");',
  'expect(app.texts()).toContain("calls:0");',
  'await app.press("id:desktop-shortcuts-reset-all");',
  'await app.waitFor("text:stored:{}");',
  'expect(app.shows("id:desktop-shortcuts-overwrite")).toBe(false);',
]), 75_000);

test('Dialog adapter lazily mounts injected search content, closes before navigation and fences stale selection', () => headless([
  'expect(app.texts()).toContain("mounts:0");',
  'await app.keyboard.press("mod+p");', 'await app.waitFor("id:search-content-input");',
  'expect(app.texts()).toContain("mounts:1");',
  'await app.press("id:search-content-select");', 'await app.waitFor("id:search-content-input", {state:"gone"});',
  'expect(app.texts()).toContain("selected:1");',
  'await app.press("id:stale");', 'expect(app.texts()).toContain("selected:1");',
  'await app.keyboard.press("mod+p");', 'await app.waitFor("id:search-content-input");',
  'await app.keyboard.press("escape");', 'await app.waitFor("id:search-content-input", {state:"gone"});',
  'expect(app.texts()).toContain("mounts:2");',
], 'desktop-command-palette-fixture.tsx'), 75_000);

test('Dialog adapter closes on Host scope and background changes without mounting a hidden search', () => headless([
  'await app.keyboard.press("mod+p");', 'await app.waitFor("id:search-content-input");',
  'await app.press("id:scope");', 'await app.waitFor("id:search-content-input", {state:"gone"});',
  'await app.press("id:stale");', 'expect(app.texts()).toContain("selected:0");',
  'await app.keyboard.press("mod+p");', 'await app.waitFor("id:search-content-input");',
  'await app.setLifecycle("background");', 'await app.waitFor("id:search-content-input", {state:"gone"});',
  'await app.setLifecycle("active");', 'expect(app.texts()).toContain("open:false");', 'expect(app.texts()).toContain("mounts:2");',
], 'desktop-command-palette-fixture.tsx'), 75_000);

test('real settings preserves prior after failed write and exposes exact retry', () => headless([
  'await app.press("id:desktop-shortcut-capture-open_command_palette");',
  'await app.keyboard.press("alt+f8");',
  'await app.press("id:failure");',
  'await app.press("id:desktop-shortcut-save-open_command_palette");',
  'await app.waitFor("id:desktop-shortcuts-retry");',
  'expect(app.texts()).toContain("stored:{}");',
  'await app.press("id:failure");',
  'await app.press("id:desktop-shortcuts-retry");',
  'await app.waitFor("text:stored:{\\"open_command_palette\\":\\"alt+f8\\"}");',
]), 75_000);
