import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test('credential-free production root renders home and Session on both desktop platform models', () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'dev/desktop-ui/Preview.test.tsx'], {
    cwd: root, encoding: 'utf8', timeout: 90_000,
  });
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout + result.stderr).toMatch(/2 tests: 2 passed/);
}, 95_000);
