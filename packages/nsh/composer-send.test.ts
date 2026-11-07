import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test('native send uses ghost only when disabled, filled arrow when ready and keeps its disc through admission', () => {
  const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'composer-send-test-app.tsx'], {
    cwd: path.dirname(fileURLToPath(import.meta.url)), encoding: 'utf8', timeout: 60_000,
    input: [
      'expect(app.enabled("id:send")).toBe(false);',
      'expect(app.shows("id:send-ghost")).toBe(true);',
      'expect(app.shows("id:send-disc")).toBe(false);',
      'await app.press("id:send-fixture-busy");',
      'expect(app.shows("id:stop-disc")).toBe(true);',
      'expect(app.shows("id:send")).toBe(false);',
      'await app.type("id:send-fixture-draft", "Follow-up");',
      'expect(app.shows("id:send-disc")).toBe(true);',
      'expect(app.shows("id:stop")).toBe(false);',
      'await app.clear("id:send-fixture-draft");',
      'expect(app.shows("id:stop-disc")).toBe(true);',
      'await app.press("id:stop");',
      'expect(app.shows("id:send-ghost")).toBe(true);',
      'await app.type("id:send-fixture-draft", "Native draft");',
      'expect(app.enabled("id:send")).toBe(true);',
      'expect(app.shows("id:send-disc")).toBe(true);',
      'expect(app.shows("id:send-arrow")).toBe(true);',
      'expect(app.shows("id:send-ghost")).toBe(false);',
      'await app.press("id:send");',
      'expect(app.enabled("id:send")).toBe(false);',
      'expect(app.shows("id:send-disc")).toBe(true);',
      'expect(app.shows("id:send-loading")).toBe(true);',
      'expect(app.shows("text:admissions:1")).toBe(true);',
      'expect(app.value("id:send-fixture-draft")).toBe("");',
      'await app.press("id:send-fixture-complete");',
      'expect(app.shows("id:send-ghost")).toBe(true);',
      'expect(app.shows("id:send-disc")).toBe(false);',
    ].join('\n'),
  });
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 75_000);
