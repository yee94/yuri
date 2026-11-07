import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Explicit opt-in only. Ordinary policy/SDK checks must never start an engine or touch a device.
it.skipIf(process.env.NSH_NOTIFICATION_ENGINE !== '1')('renders production SettingsNativeNotifications with synthetic permission and no OS bridge', () => {
  const steps = [
    'await app.waitFor("text:Not requested");',
    'await app.press("id:notification-request");',
    'await app.waitFor("text:enabled=false writes=0 requests=1 tests=0");',
    'await app.press("id:notification-fixture-authorize");',
    'await app.waitFor("text:Allowed");',
    'await app.press("id:notification-enable");',
    'await app.waitFor("text:enabled=true writes=1 requests=1 tests=0");',
    'await app.press("id:notification-test");',
    'await app.waitFor("text:enabled=true writes=1 requests=1 tests=1");',
    'await app.waitFor("id:notification-notice");',
    'expect(app.texts().join("\\n")).toContain("Remote push is not connected to APNs");',
  ].join('\n');
  const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'notification-test-app.tsx'], { cwd: path.dirname(fileURLToPath(import.meta.url)), input: steps, encoding: 'utf8', timeout: 60_000 });
  expect(result.error, result.stdout + result.stderr).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
}, 75_000);
