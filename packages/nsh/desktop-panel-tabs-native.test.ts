import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const directory = path.dirname(fileURLToPath(import.meta.url));
test('independent production tabs/binding pass real NSH headless gestures, dirty dialogs and public Storage failures', () => {
  const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'desktop-panel-tabs-engine.test.tsx'], {
    cwd: directory, encoding: 'utf8', timeout: 90_000, maxBuffer: 2 * 1024 * 1024,
  });
  const output = result.stdout + result.stderr;
  expect(result.error, output).toBeUndefined(); expect(result.status, output).toBe(0);
}, 100_000);
