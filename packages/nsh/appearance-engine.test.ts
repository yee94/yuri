import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { nativeThemeTokens } from './appearance-core';
import { getThemeById } from '../ui/src/lib/theme/themes';

test('actual NSH engine bundles the shared pure theme graph and applies Host typography and message foreground (headless fixture only)', () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const temporary = mkdtempSync(path.join(tmpdir(), 'nsh-appearance-engine-'));
  try {
    const fixture = path.join(temporary, 'host.js');
    const bundled = spawnSync('bun', ['build', 'appearance-test-host.ts', '--target=browser', '--outfile', fixture], { cwd: directory, encoding: 'utf8', timeout: 60_000 });
    expect(bundled.status, bundled.stderr).toBe(0);
    const color = nativeThemeTokens(getThemeById('jetbrains-dark')!)['chat-user-foreground'].toLowerCase();
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'appearance-test-app.tsx', '--web-host', fixture], {
      cwd: directory, encoding: 'utf8', timeout: 60_000,
      input: [
        'await app.waitFor("text:dark");',
        'expect(app.spanStyle("text:Native user body").fontSize).toBe(18);',
        'expect(app.spanStyle("text:Native code body").fontSize).toBe(13);',
        `expect(app.spanStyle("text:Native user body").color).toBe(${JSON.stringify(color.length === 7 ? `${color}ff` : color)});`,
      ].join('\n'),
    });
    expect(result.error, result.stderr + result.stdout).toBeUndefined();
    expect(result.status, result.stderr + result.stdout).toBe(0);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 90_000);

test('root appearance feedback hides raw Host errors and retries the same canonical read (headless fixture only)', () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const temporary = mkdtempSync(path.join(tmpdir(), 'nsh-appearance-feedback-'));
  try {
    const fixture = path.join(temporary, 'host.js');
    const bundled = spawnSync('bun', ['build', 'appearance-feedback-host.ts', '--target=browser', '--outfile', fixture], { cwd: directory, encoding: 'utf8', timeout: 60_000 });
    expect(bundled.status, bundled.stderr).toBe(0);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'appearance-test-app.tsx', '--web-host', fixture], {
      cwd: directory, encoding: 'utf8', timeout: 60_000,
      input: [
        'await app.waitFor("id:appearance-feedback");',
        'expect(app.texts().join("\\n")).not.toContain("raw-url-and-settings-sensitive-sentinel");',
        'expect(app.texts().join("\\n")).toContain("Failed to reload configuration");',
        'await app.press("id:appearance-retry");',
        'await app.waitFor("text:dark");',
        'await app.waitUntil(() => !app.shows("id:appearance-feedback"));',
      ].join('\n'),
    });
    expect(result.error, result.stderr + result.stdout).toBeUndefined(); expect(result.status, result.stderr + result.stdout).toBe(0);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 90_000);
