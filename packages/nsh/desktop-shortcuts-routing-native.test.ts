import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test('native routed bindings use the actual NSH dispatcher headlessly without a Host', () => {
  const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'desktop-shortcuts-routing.engine.test.tsx'], {
    cwd: path.dirname(fileURLToPath(import.meta.url)), encoding: 'utf8', timeout: 120_000,
  });
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 150_000);
