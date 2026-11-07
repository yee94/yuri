import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';

const directory = path.dirname(fileURLToPath(import.meta.url));
let temporary: string, fixture: string;
beforeAll(() => {
  temporary = mkdtempSync(path.join(tmpdir(), 'nsh-queue-ui-'));
  fixture = path.join(temporary, 'host.js');
  // The headless Host loader accepts one module, not a filesystem module graph.
  const result = spawnSync('bun', ['build', 'tests/queue-host.js', '--target=browser', '--outfile', fixture], { cwd: directory, encoding: 'utf8' });
  expect(result.status, result.stdout + result.stderr).toBe(0);
});
afterAll(() => { if (temporary) rmSync(temporary, { recursive: true, force: true }); });

function run(steps: string[]) {
  const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'App.tsx', '--web-host', fixture], {
    cwd: directory, encoding: 'utf8', timeout: 60_000,
    input: ['await app.waitFor("text:Native conversation");', 'await app.press("text:Native conversation");', 'await app.waitFor("id:queue-steer-q-steer");', ...steps].join('\n'),
  });
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}

test('production native chat steers and removes authoritative queue rows without touching the draft', () => {
  run([
    'await app.type("id:composer", "Keep this new draft");',
    'await app.press("id:queue-steer-q-steer");',
    'await app.waitFor("text:Steering…");',
    'expect(app.shows("id:queue-steer-q-steer")).toBe(false);',
    'expect(app.value("id:composer")).toBe("Keep this new draft");',
    'await app.waitUntil(() => app.enabled("id:queue-remove-q-remove"));',
    'await app.press("id:queue-remove-q-remove");',
    'await app.waitFor("text:HTTP 503: Neutral queue retry required");',
    'expect(app.shows("id:queue-remove-q-remove")).toBe(true);',
    'await app.press("id:queue-remove-q-remove");',
    'await app.waitUntil(() => !app.shows("id:queue-remove-q-remove"));',
    'expect(app.value("id:composer")).toBe("Keep this new draft");',
    'expect(app.shows("id:queue-edit-q-edit")).toBe(true);',
  ]);
}, 75_000);

test('production native queue edit preserves files and exposes recovery before allowing resend', () => {
  run([
    'await app.press("id:queue-edit-q-edit");',
    'await app.waitFor("id:queue-edit-recovery");',
    'expect(app.value("id:composer")).toBe("Neutral editable input");',
    'expect(app.texts()).toContain("queued.txt");',
    'await expect(app.press("id:send")).rejects.toMatchObject({ code: "ERR_NSH_TEST_DISABLED" });',
    'await app.press("id:queue-edit-retry");',
    'await app.waitUntil(() => !app.shows("id:queue-edit-recovery"));',
    'expect(app.shows("id:queue-edit-q-edit")).toBe(false);',
    'expect(app.value("id:composer")).toBe("Neutral editable input");',
    'await app.press("id:send");',
    'await app.waitFor("text:Message accepted by native transport");',
    'expect(app.value("id:composer")).toBe("");',
    'expect(app.texts().join("\\n")).not.toMatch(/Unexpected queue|Unsafe queue/);',
  ]);
}, 75_000);
