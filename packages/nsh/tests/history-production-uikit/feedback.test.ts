import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('checks moving red-only bounds and smoke failure cleanup without any device or engine', () => {
  const result = spawnSync('python3', [path.join(path.dirname(fileURLToPath(import.meta.url)), 'feedback_test.py')], { encoding: 'utf8', timeout: 15000 });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stderr).toContain('Ran 16 tests');
});
