import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, test } from 'vitest';

test('NSH production assistant action starts loading, stops, and retains copy action', () => {
  const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'speech-test-app.tsx', '--web-host', 'speech-host.js'], {
    cwd: path.dirname(fileURLToPath(import.meta.url)), encoding: 'utf8', timeout: 45000,
    input: [
      'await app.waitFor("id:speech-neutral-message");',
      'await app.waitFor("id:history-copy-neutral-message");',
      'await app.press("id:speech-neutral-message");',
      'await app.waitFor("text:loading");',
      'await app.press("id:speech-neutral-message");',
      'await app.waitFor("text:idle");',
      'app.onDialog(dialog => dialog.buttons.includes("Resume playback") ? "Resume playback" : null);',
      'await app.press("id:speech-neutral-message");',
      'await app.waitFor("id:speech-error-neutral-message");',
      'await app.press("id:speech-neutral-message");',
      'await app.waitFor("text:loading");',
      'await app.press("id:speech-hide");',
      'await app.waitFor("text:idle");',
    ].join('\n'),
  });
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 60000);
