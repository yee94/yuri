import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('keeps synthetic v3 token navigation separate from complete-body and strict acceptance', () => {
  const result = spawnSync('python3', [path.join(path.dirname(fileURLToPath(import.meta.url)), 'native_diagnostic_v3_test.py')], { encoding: 'utf8', timeout: 15000 });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stderr).toContain('Ran 11 tests');
});
