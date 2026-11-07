import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, test } from 'vitest';

function fixture(steps: string[]) {
  const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'native-auto-read-fixture.tsx', '--web-host', 'native-auto-read-host.js'], {
    cwd: path.dirname(fileURLToPath(import.meta.url)), encoding: 'utf8', timeout: 45000, input: steps.join('\n'),
  });
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}
test('committed NSH body admits only completed new replies, queues on the one shared owner, and manual stop disables', () => {
  fixture([
    'await app.waitFor("id:committed-reply-body");',
    'await app.press("id:auto-toggle");',
    'await app.waitFor("text:on:armed:none");',
    'await app.press("id:auto-metrics");',
    'await app.waitFor("text:segments:0 owners:1 prepares:1");',
    'await app.press("id:auto-stream");',
    'await app.press("id:auto-metrics");',
    'expect(app.shows("text:segments:0 owners:1 prepares:1")).toBe(true);',
    'await app.press("id:auto-settle");',
    'await app.waitFor("text:on:armed:reply-1");',
    'await app.press("id:auto-next");',
    'await app.press("id:auto-metrics");',
    'await app.waitFor("text:segments:1 owners:1 prepares:1");',
    'await app.press("id:auto-finish");',
    'await app.waitFor("text:on:armed:reply-2");',
    'await app.press("id:auto-stop");',
    'await app.waitFor("text:off:halted:none");',
    'await app.press("id:auto-metrics");',
    'await app.waitFor("text:segments:2 owners:1 prepares:1");',
  ]);
}, 60000);
test('unmounted bodies never enqueue, and synthesis failure is visible without automatic retry', () => {
  fixture([
    'await app.waitFor("id:committed-reply-body");',
    'await app.press("id:auto-toggle");',
    'await app.waitFor("text:on:armed:none");',
    'await app.press("id:auto-hide");',
    'await app.press("id:auto-next");',
    'await app.press("id:auto-hide");',
    'await app.waitFor("id:committed-reply-body");',
    'await app.press("id:auto-metrics");',
    'await app.waitFor("text:segments:0 owners:1 prepares:1");',
    'await app.press("id:auto-fail");',
    'await app.press("id:auto-next");',
    'await app.waitFor("text:mobile.menu.autoReadFailed");',
    'await app.waitFor("text:on:halted:none");',
    'await app.press("id:auto-next");',
    'await app.press("id:auto-metrics");',
    'await app.waitFor("text:segments:1 owners:1 prepares:1");',
    'expect(app.texts().join(" ")).not.toContain("Private fixture audio failure");',
  ]);
}, 60000);
