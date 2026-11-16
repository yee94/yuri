import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { enableStartupService } from './cli-startup.js';

vi.mock('child_process', () => ({ spawnSync: vi.fn(() => ({ status: 0, stdout: 'active\n' })) }));
vi.mock('../../server/lib/portable-installation.js', () => ({
  readPortableInstallation: () => ({ root: '/install/versions/1.2.3', launcher: '/install/current/yuri' }),
}));

it('systemd uses the stable portable launcher so libraries and private Node survive minimal environments and updates', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'yuri-portable-startup-'));
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const spy = vi.spyOn(os, 'homedir').mockReturnValue(home);
  vi.stubEnv('YURI_DATA_DIR', path.join(home, 'data'));
  Object.defineProperty(process, 'platform', { value: 'linux' });
  try {
    enableStartupService({ envSnapshot: false, port: 4321 });
    const unit = fs.readFileSync(path.join(home, '.config/systemd/user/yuri.service'), 'utf8');
    expect(unit).toContain('ExecStart="/install/current/yuri" "serve" "--foreground" "--port" "4321"');
    expect(unit).not.toContain('/versions/');
    expect(unit).not.toContain('bin/cli.js');
  } finally {
    Object.defineProperty(process, 'platform', platform);
    spy.mockRestore();
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
