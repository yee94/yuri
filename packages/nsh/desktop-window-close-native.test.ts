import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test('native close commit lock retains and disables real NSH inputs until rejection', () => {
  const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'tests/desktop-workspace/CloseCommit.test.tsx'], {
    cwd: path.dirname(fileURLToPath(import.meta.url)), encoding: 'utf8', timeout: 60_000,
  });
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 75_000);
