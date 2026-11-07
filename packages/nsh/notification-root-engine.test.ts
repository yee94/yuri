import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Prepared, never run by the notification pure suite. Requires a separate explicit engine authorization.
it.skipIf(process.env.NSH_NOTIFICATION_ROOT_ENGINE !== '1')('mounts the real notification root with only synthetic transports', () => {
  const steps = [
    'await app.waitFor("text:sends=0 opens=0 acks=0 reads=1 ready=true");',
    'await app.press("id:notification-root-fixture-admit");',
    'await app.waitFor("text:sends=8 opens=0 acks=0 reads=1 ready=true");',
    'await app.press("id:notification-root-fixture-raw");',
    'expect(app.texts().join("\\n")).toContain("sends=8 opens=0 acks=0 reads=1 ready=true");',
    'await app.press("id:notification-root-fixture-cold");',
    'await app.waitFor("text:sends=8 opens=1 acks=1 reads=1 ready=true");',
    'await app.press("id:notification-root-fixture-rebind");',
    'await app.waitFor("text:sends=8 opens=1 acks=1 reads=2 ready=true");',
  ].join('\n');
  const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'notification-root-fixture.tsx'], { cwd: path.dirname(fileURLToPath(import.meta.url)), input: steps, encoding: 'utf8', timeout: 60_000 });
  expect(result.error, result.stdout + result.stderr).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
}, 75_000);
