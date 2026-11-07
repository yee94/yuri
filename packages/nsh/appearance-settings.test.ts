import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test('real Settings color-mode picker ignores obsolete local light, preserves dark on failed Host write and persists confirmed light (headless fixture only)', () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const temporary = mkdtempSync(path.join(tmpdir(), 'nsh-appearance-settings-'));
  try {
    const fixture = path.join(temporary, 'host.js');
    const bundled = spawnSync('bun', ['build', 'appearance-settings-host.ts', '--target=browser', '--outfile', fixture], { cwd: directory, encoding: 'utf8', timeout: 60_000 });
    expect(bundled.status, bundled.stderr).toBe(0);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'appearance-settings-test-app.tsx', '--web-host', fixture], {
      cwd: directory, encoding: 'utf8', timeout: 60_000,
      input: [
        'await app.waitFor("text:dark");',
        'await app.waitFor("text:Dark");',
        'expect(app.storage().appearance).toBe("light");',
        'await app.press("text:Dark");',
        'await app.waitFor("text:Light");',
        'await app.press("text:Light");',
        'await app.waitFor("id:appearance-feedback");',
        'expect(app.texts()).toContain("dark");',
        'expect(app.texts().join("\\n")).not.toContain("raw-sensitive-appearance-save-sentinel");',
        'await app.press("text:Dark");',
        'await app.waitFor("text:Light");',
        'await app.press("text:Light");',
        'await app.waitFor("text:light");',
        'await app.press("id:appearance-authority-refresh");',
        'await app.waitUntil(() => !app.shows("id:appearance-feedback"));',
        'expect(app.texts()).toContain("Light");',
        'expect(app.texts()).not.toContain("Dark");',
      ].join('\n'),
    });
    expect(result.error, result.stderr + result.stdout).toBeUndefined(); expect(result.status, result.stderr + result.stdout).toBe(0);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 90_000);
