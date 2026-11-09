import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('keeps native-only diagnostics red-capable without invoking recorder, app lifecycle, engine or device', () => {
  const result = spawnSync('python3', [path.join(path.dirname(fileURLToPath(import.meta.url)), 'native_diagnostic_test.py')], { encoding: 'utf8', timeout: 15000 });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stderr).toContain('Ran 28 tests');
});
