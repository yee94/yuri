import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

import { createUpdateCommand } from './commands-update.js';

const portableFixture = vi.hoisted(() => ({ installation: null }));
const lifecycle = vi.hoisted(() => ({
  discoverRunningInstances: vi.fn(async () => []),
  requestServerShutdown: vi.fn(async () => true),
  stopInstanceProcess: vi.fn(async () => true),
}));
vi.mock('../../server/lib/portable-installation.js', async (original) => ({
  ...await original(),
  readPortableInstallation: () => portableFixture.installation,
}));
vi.mock('./cli-lifecycle.js', () => ({ discoverRunningInstances: lifecycle.discoverRunningInstances }));
vi.mock('./cli-http.js', () => ({ requestServerShutdown: lifecycle.requestServerShutdown }));
vi.mock('./cli-process.js', async (original) => ({
  ...await original(),
  stopInstanceProcess: lifecycle.stopInstanceProcess,
}));

async function withTempYuriDataDir(fn) {
  const previous = process.env.YURI_DATA_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuri-update-test-'));
  process.env.YURI_DATA_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (typeof previous === 'string') {
      process.env.YURI_DATA_DIR = previous;
    } else {
      delete process.env.YURI_DATA_DIR;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('update command', () => {
  it('rejects a portable update before discovering or stopping daemons or loading a package manager', async () => {
    const importFromFilePath = vi.fn();
    const serveCommand = vi.fn();
    portableFixture.installation = { root: '/portable/yuri' };
    try {
      const update = createUpdateCommand({ importFromFilePath, serveCommand });
      await expect(update({ json: true })).rejects.toThrow('self-contained Yuri installation');
      expect(importFromFilePath).not.toHaveBeenCalled();
      expect(serveCommand).not.toHaveBeenCalled();
    } finally { portableFixture.installation = null; }
  });

  it('updates a managed daemon and restarts it from saved Relay settings without replaying the opt-in', async () => {
    await withTempYuriDataDir(async (dir) => {
      const originalWrite = process.stdout.write;
      process.stdout.write = vi.fn(() => true);
      const instanceFilePath = path.join(dir, 'instance.json');
      const port = 3100;
      fs.writeFileSync(instanceFilePath, JSON.stringify({ port, host: '127.0.0.1' }));
      lifecycle.discoverRunningInstances.mockResolvedValueOnce([
        { port, host: '127.0.0.1', pid: 500, runtime: 'ssh-remote', instanceFilePath, pidFilePath: path.join(dir, 'instance.pid') },
      ]);
      const executeUpdate = vi.fn(() => ({ success: true, exitCode: 0 }));
      const serveCommand = vi.fn();
      const updateCommand = createUpdateCommand({
        packageManagerPath: '/fake/package-manager.js',
        serveCommand,
        importFromFilePath: vi.fn(async () => ({
          checkForUpdates: vi.fn(async () => ({ available: true, version: '9.9.9' })),
          detectPackageManager: vi.fn(() => 'npm'),
          executeUpdate,
          getCurrentVersion: vi.fn(() => '1.0.0'),
        })),
      });

      try {
        await updateCommand({ json: true });

        expect(executeUpdate).toHaveBeenCalledWith('npm', { silent: true });
        expect(serveCommand).toHaveBeenCalledWith(expect.objectContaining({ port, restartRuntime: 'ssh-remote' }));
        expect(serveCommand.mock.calls[0][0]).not.toHaveProperty('relayHost');
      } finally {
        process.stdout.write = originalWrite;
      }
    });
  });
});
