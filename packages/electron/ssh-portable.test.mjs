import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { ElectronSshManager, buildRemoteManagedRuntimePrefix } from './ssh-manager.mjs';
import { buildRemotePortableInstallScript } from './ssh-portable.mjs';

const temporary = [];
afterEach(() => { for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

it('uses the same packaged installer with an exact version and persists only portable ownership', async () => {
  const manager = new ElectronSshManager({ settingsFilePath: '/unused', appVersion: '1.2.3', emit() {} });
  manager.runManagedRemoteCommand = vi.fn();
  manager.currentRemoteYuriVersion = async () => '1.2.3-beta.1';
  await manager.installYuriManaged({}, '', '1.2.3-beta.1', 'download_release');
  const script = manager.runManagedRemoteCommand.mock.calls[0][2];
  expect(script).toContain("--version '1.2.3-beta.1'");
  expect(script).toContain('--no-link');
  expect(script).toContain('YURI_SSH_PORTABLE=');
  expect(script).toContain('Release checksum mismatch');
  expect(script).not.toContain('npm install');
  manager.currentRemoteYuriVersion = async () => '1.2.2';
  await expect(manager.installYuriManaged({}, '', '1.2.3', 'download_release')).rejects.toThrow('version verification');
  expect(() => buildRemotePortableInstallScript("1.2.3'; exit")).toThrow('Invalid');
});

it('installs on a bare managed Host without probing Node or trying native rebuilds', async () => {
  const manager = new ElectronSshManager({ settingsFilePath: '/unused', appVersion: '1.2.3', emit() {} });
  manager.ensureManagedNodeRuntime = vi.fn(() => { throw new Error('No system Node'); });
  manager.currentRemoteYuriVersion = async () => null;
  manager.remoteCommandExists = async () => false;
  manager.runManagedRemoteCommand = vi.fn(async (_p, _c, script) => script.includes('echo yes || echo no') ? 'no' : '');
  manager.setInitialConfigSyncPending = vi.fn();
  manager.installYuriManaged = vi.fn();
  manager.ensureRemoteYuriNativeBinding = vi.fn();
  manager.ensureRemoteOpenCodeCli = vi.fn();
  manager.startRemoteServerManaged = vi.fn(async () => ({ port: 4000, uiPassword: 'fixture' }));
  manager.remoteServerRunning = async () => true;
  await expect(manager.ensureRemoteServer({
    id: 'bare', remoteYuri: { mode: 'managed', installMethod: 'download_release' },
  }, {}, '')).resolves.toMatchObject({ remotePort: 4000 });
  expect(manager.installYuriManaged).toHaveBeenCalledWith({}, '', '1.2.3', 'download_release');
  expect(manager.ensureManagedNodeRuntime).not.toHaveBeenCalled();
  expect(manager.ensureRemoteYuriNativeBinding).not.toHaveBeenCalled();
  expect(manager.ensureRemoteOpenCodeCli).not.toHaveBeenCalled();
});

it('resolves the private launcher without putting its Node on PATH or editing shell profiles', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'yuri-portable-ssh-'));
  temporary.push(home);
  const root = path.join(home, '.local/share/yuri');
  fs.mkdirSync(path.join(root, 'current/bin'), { recursive: true });
  fs.mkdirSync(path.join(home, '.config/yuri'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config/yuri/ssh-runtime.sh'), 'YURI_SSH_PORTABLE="$HOME/.local/share/yuri"\n');
  fs.writeFileSync(path.join(root, 'current/yuri'), '#!/bin/sh\necho 1.2.3\n', { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'current/bin/opencode'), '#!/bin/sh\necho 2.0.23\n', { mode: 0o755 });
  const result = spawnSync('/bin/sh', ['-c', `${buildRemoteManagedRuntimePrefix()}
yuri --version
opencode --version
printf '%s\\n' "$PATH"
`], { encoding: 'utf8', env: { HOME: home, PATH: '/usr/bin:/bin' } });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('1.2.3\n2.0.23');
  expect(result.stdout).not.toContain('/runtime');
  expect(fs.existsSync(path.join(home, '.profile'))).toBe(false);
});

const upgradeFixture = (registered) => {
  const manager = new ElectronSshManager({ settingsFilePath: '/unused', appVersion: '1.2.3', emit() {} });
  const calls = [];
  manager.currentRemoteYuriVersion = async () => '1.2.2';
  manager.runManagedRemoteCommand = async (_p, _c, script) => {
    if (script.includes('echo yes || echo no')) return registered ? 'yes' : 'no';
    if (script.includes('verify.mjs')) throw new Error('Native preflight failed');
    throw new Error('Unexpected command');
  };
  manager.discoverManagedRemoteServers = async () => [{ port: 4000, info: { yuriVersion: '1.2.2' } }];
  manager.stopRemoteServer = async () => { calls.push('stop'); };
  manager.installYuriManaged = async () => { calls.push('install'); };
  manager.startRemoteServerManaged = vi.fn();
  const run = () => manager.ensureRemoteServer({
    id: 'upgrade', remoteYuri: { mode: 'managed', installMethod: 'download_release' },
  }, {}, '');
  return { manager, calls, run };
};

it('drains the old SSH daemon before a blocking release change and never starts after failed verification', async () => {
  const { manager, calls, run } = upgradeFixture(false);
  await expect(run()).rejects.toThrow('Native preflight failed');
  expect(calls).toEqual(['stop', 'install']);
  expect(manager.startRemoteServerManaged).not.toHaveBeenCalled();
});

it('a registered outdated portable release defers installation and still never starts after failed verification', async () => {
  const { manager, calls, run } = upgradeFixture(true);
  await expect(run()).rejects.toThrow('Native preflight failed');
  expect(calls).toEqual(['stop']);
  expect(manager.startRemoteServerManaged).not.toHaveBeenCalled();
});

it('keeps the existing package-manager path for macOS SSH targets', async () => {
  const manager = new ElectronSshManager({ settingsFilePath: '/unused', appVersion: '1.2.3', emit() {} });
  manager.ensureManagedNodeRuntime = vi.fn();
  manager.currentRemoteYuriVersion = async () => null;
  manager.remoteCommandExists = async () => false;
  manager.setInitialConfigSyncPending = vi.fn();
  manager.installYuriManaged = vi.fn();
  manager.ensureRemoteYuriNativeBinding = vi.fn();
  manager.ensureRemoteOpenCodeCli = vi.fn();
  manager.startRemoteServerManaged = async () => ({ port: 4000, uiPassword: 'fixture' });
  manager.remoteServerRunning = async () => true;
  await manager.ensureRemoteServer({
    id: 'mac', remoteYuri: { mode: 'managed', installMethod: 'download_release' },
  }, {}, '', 'darwin');
  expect(manager.ensureManagedNodeRuntime).toHaveBeenCalledOnce();
  expect(manager.installYuriManaged).toHaveBeenCalledWith({}, '', '1.2.3', 'bun');
});
