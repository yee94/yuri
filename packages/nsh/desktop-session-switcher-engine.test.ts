import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test.skipIf(process.env.NSH_DESKTOP_SWITCHER_ENGINE !== '1')('cross-platform headless production Overlay (no native window or Host)', () => {
  const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'desktop-session-switcher-native.test.tsx'], {
    cwd: path.dirname(fileURLToPath(import.meta.url)), encoding: 'utf8', timeout: 120000,
  });
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 130000);
