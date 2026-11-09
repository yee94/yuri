import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

// Main owns the engine lane. Ordinary pure test runs never start an NSH engine.
test.skipIf(process.env.NSH_CHANGES_ENGINE !== '1')('mock-only production callbacks: generation, highlights, directory groups and durable write uncertainty', () => {
  const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'chat-changes-callback-engine.test.tsx'], {
    cwd: path.dirname(fileURLToPath(import.meta.url)), encoding: 'utf8', timeout: 60_000,
  });
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 75_000);
