import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

// NSH 0.4 headless measure() does not reflect UIKit's inverted-list scroll compensation.
test.skipIf(process.env.NSH_HISTORY_IOS !== '1')('UIKit history adopts eight delayed pages while preserving a released reading anchor', () => {
  const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'history-layout-fixture.tsx', '--target', 'ios'], {
    cwd: path.dirname(fileURLToPath(import.meta.url)), encoding: 'utf8', timeout: 60_000,
    input: [
      'await app.scroll("id:history-layout-list", -900);',
      'await app.waitFor("text:adoptions:1");',
      'for (let page = 2; page <= 8; page++) {',
      'await app.press("id:history-layout-manual");',
      'await app.waitFor("text:adoptions:" + page);',
      'expect(Number(app.texts().find(text => text.startsWith("drift:")).slice(6)) <= 1.1).toBe(true);',
      '}',
      'expect(app.texts()).toContain("measurements:240");',
    ].join('\n'),
  });
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 75_000);

test.skipIf(process.env.NSH_HISTORY_IOS !== '1')('UIKit keeps an inner reading anchor when eight pages extend the same assistant group', () => {
  const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'history-grouped-layout-fixture.tsx', '--target', 'ios'], {
    cwd: path.dirname(fileURLToPath(import.meta.url)), encoding: 'utf8', timeout: 60_000,
    input: [
      'await app.scroll("id:grouped-list", -600);',
      'for (let page = 1; page <= 8; page++) {',
      'await app.press("id:grouped-load-older");',
      'await app.waitFor("text:adoptions:" + page);',
      'expect(Number(app.texts().find(text => text.startsWith("drift:")).slice(6)) <= 1.1).toBe(true);',
      '}',
      'expect(app.texts()).toContain("measurements:240");',
    ].join('\n'),
  });
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 75_000);
