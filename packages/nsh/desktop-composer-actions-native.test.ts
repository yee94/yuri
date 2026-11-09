import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test('desktop composer action publishers run production components and synthetic Host in NSH headless only', () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true });
  const temporary = mkdtempSync(path.join(parent, 'desktop-composer-actions-'));
  try {
    const host = path.join(temporary, 'host.js');
    const build = spawnSync('bun', ['build', 'desktop-composer-actions-host.fixture.js', '--target=browser', '--outfile', host], { cwd: directory, encoding: 'utf8', timeout: 30_000 });
    expect(build.status, build.stdout + build.stderr).toBe(0);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'desktop-composer-actions.engine.test.tsx', '--web-host', host], { cwd: directory, encoding: 'utf8', timeout: 150_000 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 190_000);
