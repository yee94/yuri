import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, test } from 'vitest';

// Main alone owns NSH engine/device execution. This diagnostic is not the three
// functional UI acceptance tests and cannot turn their missing decoder green.
test.skipIf(process.env.NSH_REMOTE_DESKTOP_IMAGE_PROBE !== '1')('headless Image primitive reports its lack of image decode events explicitly', () => {
  const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tests/remote-desktop');
  const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'image-probe.tsx'], {
    cwd: directory, encoding: 'utf8', timeout: 30_000,
    input: readFileSync(path.join(directory, 'image-probe.steps.js'), 'utf8'),
  });
  console.log(result.stdout);
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 45_000);
