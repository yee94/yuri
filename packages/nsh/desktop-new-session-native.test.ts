import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test('desktop new-session production components on NSH macOS-idiom headless engine', () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true });
  const temporary = mkdtempSync(path.join(parent, 'desktop-new-session-'));
  try {
    const host = path.join(temporary, 'host.js');
    const build = spawnSync('bun', ['build', 'desktop-new-session-host.fixture.js', '--target=browser', '--outfile', host], { cwd: directory, encoding: 'utf8', timeout: 30_000 });
    expect(build.status, build.stdout + build.stderr).toBe(0);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'desktop-new-session.test.tsx', '--web-host', host], { cwd: directory, encoding: 'utf8', timeout: 120_000 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 160_000);
