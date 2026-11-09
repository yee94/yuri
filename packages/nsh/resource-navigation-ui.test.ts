import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

for (const route of ['files', 'preview']) test(`real synthetic NSH ${route} Back keeps the parent page through failure/retry and delayed lease retirement`, () => {
  const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'resource-navigation-test-app.tsx', '--web-host', 'tests/resource-navigation-host.js'], {
    cwd: path.dirname(fileURLToPath(import.meta.url)), encoding: 'utf8', timeout: 60_000,
    input: [
      'const audit = () => JSON.parse(app.texts().find(value => value.startsWith("{\\"synthetic\\":")) || "{}");',
      `await app.press("id:route-open-${route}");`,
      'await app.waitFor("text:source-parent-fixture");',
      'await app.press("id:route-fail-close"); await app.waitUntil(() => audit().failNext === true);',
      'await app.back();',
      'await app.waitFor("id:resource-route-retire-retry");',
      'expect(app.shows("text:source-parent-fixture")).toBe(true);',
      'await app.press("id:resource-route-retire-retry");',
      'await app.press("id:route-inspect"); await app.waitUntil(() => audit().pending === 1);',
      'expect(app.shows("text:source-parent-fixture")).toBe(true);',
      'expect(audit().reads).toBe(1); expect(audit().closes).toBe(2); expect(audit().releases).toBe(0);',
      'await app.back(); await app.press("id:route-inspect");',
      'expect(audit().closes).toBe(2);',
      'await app.press("id:route-release-close");',
      'await app.waitFor("id:route-home");',
      'await app.press("id:route-inspect"); await app.waitUntil(() => audit().releases === 1);',
      'expect(audit().reads).toBe(1); expect(audit().pending).toBe(0);',
    ].join('\n'),
  });
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 75_000);

test('real NSH HTML Dialog mounts navigation/source controls and returns inline through a synthetic native completion port', () => {
  const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'resource-html-dialog-test-app.tsx'], {
    cwd: path.dirname(fileURLToPath(import.meta.url)), encoding: 'utf8', timeout: 60_000,
    input: [
      'await app.waitFor("text:inline");',
      'await app.press("id:resource-html-fullscreen");',
      'await app.waitFor("id:resource-html-back");',
      'await app.waitFor("text:fullScreen");',
      'await app.press("id:resource-html-mode");',
      'await app.waitFor("id:html-dialog-source");',
      'await app.press("id:resource-html-mode");',
      'await app.waitFor("text:fullScreen");',
      'await app.press("id:resource-html-back");',
      'await app.waitFor("text:inline");',
      'await app.waitFor("id:resource-html-fullscreen");',
    ].join('\n'),
  });
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 75_000);
