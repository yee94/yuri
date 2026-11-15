import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('actual native Markdown paints inline chips, keeps code literal and routes the current skill after replacement', () => {
  const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'message-text-fixture.tsx'], {
    cwd: path.dirname(fileURLToPath(import.meta.url)), encoding: 'utf8', timeout: 60_000,
    input: [
      'await app.waitFor("id:message-reference-skill");',
      'expect(app.texts().join(" ")).toContain("review");',
      'expect(app.texts().join(" ")).toContain("literal [skill:code]");',
      'await app.press("id:message-reference-skill");',
      'await app.waitFor("text:review");',
      'await app.press("id:replace-reference-text");',
      'await app.waitFor("text:build");',
      'await app.press("id:message-reference-skill");',
      'expect(app.texts().filter(text => text === "build").length).toBe(2);',
    ].join('\n'),
  });
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 65_000);
