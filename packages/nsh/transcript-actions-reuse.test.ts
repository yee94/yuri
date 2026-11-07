import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
const directory = path.dirname(fileURLToPath(import.meta.url));
function run(steps: string[]) {
  const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'transcript-actions-reuse-fixture.tsx', '--web-host', 'tests/host.js'], { cwd: directory, encoding: 'utf8', timeout: 60_000, input: ['await app.waitFor("id:history-edit-u");', ...steps].join('\n') });
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}
it('production JSX actions/header/body keep current identity after two-role replacement and reorder', () => {
  run([
    'expect(app.shows("id:body-u-user")).toBe(true);',
    'expect(app.shows("id:history-actions-u-user")).toBe(true);',
    'expect(app.shows("id:history-actions-a-assistant")).toBe(true);',
    'expect(app.shows("id:history-edit-a")).toBe(false);',
    'await app.press("id:reuse");',
    'await app.waitFor("id:history-actions-u-assistant");',
    'expect(app.shows("id:history-edit-u")).toBe(false);',
    'expect(app.shows("id:body-u-assistant")).toBe(true);',
    'expect(app.shows("id:turn-header-u")).toBe(true);',
    'expect(app.shows("id:body-a-user")).toBe(true);',
    'expect(app.shows("id:history-edit-a")).toBe(true);',
    'await app.press("id:reverse");',
    'expect(app.shows("id:history-actions-u-assistant")).toBe(true);',
    'expect(app.shows("id:history-actions-a-user")).toBe(true);',
  ]);
}, 75_000);
it('production List virtualizes 40 mixed-role rows and remounts tail actions with matching identity', () => {
  run([
    'await app.press("id:grow");',
    'await app.press("id:start");',
    'await app.waitFor("id:body-filler-0-user");',
    'expect(app.shows("id:history-edit-filler-0")).toBe(true);',
    'expect(app.shows("id:history-edit-filler-1")).toBe(false);',
    'await app.press("id:tail");',
    'await app.waitFor("id:body-a-assistant");',
    'expect(app.shows("id:history-actions-a-assistant")).toBe(true);',
    'expect(app.shows("id:history-edit-a")).toBe(false);',
    'await app.press("id:reuse");',
    'await app.press("id:tail");',
    'await app.waitFor("id:body-a-user");',
    'expect(app.shows("id:history-actions-a-user")).toBe(true);',
    'expect(app.shows("id:history-edit-a")).toBe(true);',
    'await app.press("id:start");',
    'await app.waitFor("id:body-filler-0-assistant");',
    'expect(app.shows("id:history-edit-filler-0")).toBe(false);',
    'expect(app.shows("id:history-actions-filler-0-assistant")).toBe(true);',
  ]);
}, 75_000);
