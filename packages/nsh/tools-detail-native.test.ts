import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test('shell detail is compact literal native text, toggles independently and reads same-ID replacements (headless)', () => {
  const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'tools-detail-fixture.tsx'], {
    cwd: path.dirname(fileURLToPath(import.meta.url)), encoding: 'utf8', timeout: 60_000,
    input: [
      'await app.waitFor("id:tool-expand-literal-shell");',
      'expect(app.shows("text:**literal output**")).toBe(false);',
      'await app.press("id:tool-expand-literal-shell");',
      'await app.waitFor("id:tool-shell-output-literal-shell");',
      'expect(app.texts()).toContain("**literal output**");',
      'expect(app.texts().filter(text => text === "printf **literal**").length).toBe(2);',
      'expect(app.texts()).not.toContain("Completed");',
      'expect(app.texts()).not.toContain("Output");',
      'expect(app.texts()).not.toContain("timeout");',
      'await app.press("id:tool-expand-literal-shell");',
      'expect(app.shows("id:tool-shell-output-literal-shell")).toBe(false);',
      'await app.press("id:tool-expand-literal-shell");',
      'await app.press("id:replace-tool");',
      'await app.waitFor("text:fixture failure");',
      'expect(app.texts()).not.toContain("**literal output**");',
      'expect(app.texts()).toContain("printf replacement");',
      'await app.press("id:expire-page");',
      'expect(app.enabled("id:tool-expand-literal-shell")).toBe(false);',
    ].join('\n'),
  });
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 75_000);
