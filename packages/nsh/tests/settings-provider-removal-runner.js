import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** NSH loads one Host script and keys headless Storage by its path. Keep both scenario-local. */
export function withProviderRemovalHost(directory, run) {
  const parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true });
  const temporary = mkdtempSync(path.join(parent, 'nsh-provider-removal-'));
  try {
    const host = path.join(temporary, 'host.js');
    const build = spawnSync('bun', ['build', 'tests/settings-provider-removal-host.js', '--target=browser', '--outfile', host], { cwd: directory, encoding: 'utf8', timeout: 30_000 });
    if (build.error) throw build.error;
    if (build.status !== 0) throw new Error('Provider fixture Host bundle failed: ' + build.stdout + build.stderr);
    return run(host);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
