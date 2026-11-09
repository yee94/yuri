import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test('desktop Assistants presentation on NSH 0.4 macOS/Windows headless models, not native windows', () => {
  const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'desktop-assistants-engine.test.tsx', '--web-host', 'tests/desktop-assistants-host.js'], {
    cwd: path.dirname(fileURLToPath(import.meta.url)), encoding: 'utf8', timeout: 150_000,
  });
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 160_000);
