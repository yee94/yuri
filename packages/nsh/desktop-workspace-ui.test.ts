import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test('native resizable desktop regions hide without remounting the composer', () => {
  const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'tests/desktop-workspace/App.tsx'], {
    cwd: path.dirname(fileURLToPath(import.meta.url)), encoding: 'utf8', timeout: 60_000,
    input: [
      'await app.waitFor("id:desktop-draft");',
      'await app.type("id:desktop-draft", "保留原生草稿");',
      'await app.press("id:toggle-sidebar");',
      'expect(app.value("id:desktop-draft")).toBe("保留原生草稿");',
      'await app.press("id:toggle-panel");',
      'expect(app.shows("text:panel-content")).toBe(true);',
      'await app.press("id:toggle-panel");',
      'expect(app.value("id:desktop-draft")).toBe("保留原生草稿");',
      'expect(app.shows("text:mounts:1")).toBe(true);',
      'await app.press("id:toggle-terminal");',
      'expect(app.shows("text:terminal-content")).toBe(true);',
      'expect(app.value("id:desktop-draft")).toBe("保留原生草稿");',
    ].join('\n'),
  });
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 75_000);
