import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test('desktop Schedule presentation on NSH 0.4 macOS/Windows headless models, not native windows', () => {
  const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'desktop-schedules-engine.test.tsx', '--web-host', 'tests/desktop-schedules-host.js'], {
    cwd: path.dirname(fileURLToPath(import.meta.url)), encoding: 'utf8', timeout: 90_000,
  });
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 100_000);
