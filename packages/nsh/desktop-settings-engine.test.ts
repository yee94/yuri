import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test.skipIf(process.env.NSH_DESKTOP_SETTINGS_ENGINE !== '1')('native desktop Settings adapter on NSH headless engine (not visual/platform parity)', () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'desktop-settings-native.test.tsx'], { cwd: directory, encoding: 'utf8', timeout: 120_000 });
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 130_000);
