import { afterEach, beforeEach, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { detectSourceInstallations } from './installations.js';

let home;
beforeEach(async () => { home = await fs.mkdtemp(path.join(os.tmpdir(), 'yuri-installation-test-')); });
afterEach(async () => { await fs.rm(home, { recursive: true, force: true }); });

test('installation is detected from executables without executing them; history folders alone are not evidence', async () => {
  const bin = path.join(home, 'bin'); await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'claude'), 'this fixture must never execute', { mode: 0o700 });
  await fs.mkdir(path.join(home, '.codex', 'sessions'), { recursive: true });
  await fs.mkdir(path.join(home, '.cursor'), { recursive: true });
  expect(await detectSourceInstallations(undefined, { home, env: { PATH: bin }, platform: 'linux' })).toEqual({ claude: true, codex: false, cursor: false, dsh: false });
});
test('user-local executable symlinks count as installed; denied probes remain unknown', async () => {
  const bin = path.join(home, '.local', 'bin'); await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(home, 'dsh'), 'fixture', { mode: 0o700 });
  await fs.symlink(path.join(home, 'dsh'), path.join(bin, 'dsh'));
  await fs.writeFile(path.join(bin, 'codex'), 'not executable', { mode: 0o600 });
  expect(await detectSourceInstallations(['dsh', 'codex'], { home, env: { PATH: '' }, platform: 'linux' })).toEqual({ dsh: true, codex: null });
});
