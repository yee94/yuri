import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test('native desktop composer submit and IME admission run on the real engine', () => {
  const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'tests/desktop-workspace/Keyboard.test.tsx'], {
    cwd: path.dirname(fileURLToPath(import.meta.url)), encoding: 'utf8', timeout: 60_000,
  });
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 75_000);
