import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, test } from 'vitest';

test('NSH executes the production BTW owner with zero open-time requests, single generate, cancellation and explicit retry', () => {
  const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'desktop-btw-fixture.tsx'], { cwd: path.dirname(fileURLToPath(import.meta.url)), encoding: 'utf8', timeout: 90_000,
    input: [
      'await app.waitFor("id:ask");', 'expect(app.texts()).toContain("calls:0 applies:0 turns:0 pending:false aborted:false");',
      'await app.press("id:quote");', 'await app.press("id:ask");', 'expect(app.texts()).toContain("calls:1 applies:1 turns:1 pending:true aborted:false");',
      'expect(app.texts()).toContain("quoted:true");', 'await app.press("id:cancel");', 'expect(app.texts()).toContain("calls:1 applies:1 turns:1 pending:false aborted:true");',
      'await app.press("id:finish");', 'expect(app.texts()).not.toContain("question:synthetic answer");',
      'await app.press("id:retry");', 'expect(app.texts()).toContain("calls:2 applies:2 turns:1 pending:true aborted:false");',
      'await app.press("id:finish");', 'expect(app.texts()).toContain("question:synthetic answer");',
      'await app.press("id:ask");', 'await app.press("id:clear");', 'await app.press("id:finish");',
      'expect(app.texts().some(text => text.includes("turns:0 pending:false"))).toBe(true);',
    ].join('\n') });
  expect(result.error, result.stdout + result.stderr).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
}, 100_000);
