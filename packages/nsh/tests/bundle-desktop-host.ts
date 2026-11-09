import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** NSH 0.4's isolated page-host loader accepts one module, not filesystem imports. */
export function bundleDesktopHost(entry: string) {
  const parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(path.join(parent, 'desktop-synthetic-host-'));
  const outfile = path.join(directory, 'host.js');
  const dispose = () => rmSync(directory, { recursive: true, force: true });
  const result = spawnSync('bun', ['build', entry, '--target=browser', '--format=esm', '--env=disable', `--outfile=${outfile}`], { encoding: 'utf8', timeout: 30_000 });
  if (result.error || result.status !== 0) {
    dispose();
    throw new Error(result.error?.message || result.stdout + result.stderr);
  }
  return { outfile, dispose };
}
