import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi } from 'vitest';
import { createCliUpdateAdapter } from './cli.js';

const fixture = vi.hoisted(() => ({ fork: vi.fn(), inspect: vi.fn(), portableInspect: vi.fn(), reject: false, children: [], portable: false }));
vi.mock('node:child_process', () => ({ fork: (...args) => fixture.fork(...args) }));
vi.mock('node:fs', () => ({ existsSync: (file) => fixture.portable && file.endsWith('/portable.json') }));
vi.mock('./releases.js', () => ({
  discoverCliRelease: (...args) => fixture.inspect(...args),
  discoverPortableRelease: (...args) => fixture.portableInspect(...args),
}));

beforeEach(() => {
  fixture.reject = false; fixture.children = []; fixture.inspect.mockReset(); fixture.portableInspect.mockReset(); fixture.fork.mockReset();
  fixture.portable = false;
  fixture.fork.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      connected: true, unref: vi.fn(), kill: vi.fn(), disconnect: vi.fn(), send: vi.fn(),
    });
    child.send.mockImplementation((message) => {
      if (message.mode !== 'drain') queueMicrotask(() => child.emit('message', fixture.reject ? { error: 'preflight rejected' } : { ready: true }));
    });
    fixture.children.push(child);
    return child;
  });
});
const adapter = (shutdown) => createCliUpdateAdapter({ packageRoot: '/installation/node_modules/@yuriai/web', dataDir: '/data', getPort: () => 3000, currentVersion: '2.0.0', shutdown, env: {} });

it('checks install ownership outside the serving process and preserves beta discovery', async () => {
  const host = adapter(vi.fn());
  await host.assertReady();
  expect(fixture.fork.mock.calls[0][2]).toMatchObject({ windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  expect(fixture.children[0].send).toHaveBeenCalledWith(expect.objectContaining({ mode: 'probe', port: 3000, pid: process.pid }));
  await host.inspect('beta');
  expect(fixture.inspect).toHaveBeenCalledWith('beta', '2.0.0');
});

it('hands the exact accepted task to a detached helper before graceful shutdown', async () => {
  const shutdown = vi.fn(async () => {
    expect(fixture.children[0].send).toHaveBeenCalledWith({ mode: 'drain' });
  });
  const release = { version: '2.1.0-beta.3', kind: 'cli-package', integrity: 'sha512-test' };
  const report = vi.fn();
  await adapter(shutdown).execute({ release, stateFile: '/data/task.json', state: { operation: { id: 'op' } }, report });
  expect(fixture.fork.mock.calls[0][2].detached).toBe(true);
  expect(fixture.children[0].send.mock.calls[0][0]).toMatchObject({ mode: 'update', release, stateFile: '/data/task.json' });
  expect(report).toHaveBeenCalledWith({ status: 'installing' });
  expect(shutdown).toHaveBeenCalledOnce();
});

it('leaves the current Host running when helper preflight fails', async () => {
  fixture.reject = true;
  const shutdown = vi.fn();
  await expect(adapter(shutdown).execute({ release: { version: '2.0.1' }, state: {}, stateFile: '/data/task.json', report: vi.fn() })).rejects.toThrow('preflight');
  expect(shutdown).not.toHaveBeenCalled();
  expect(fixture.children[0].send).not.toHaveBeenCalledWith({ mode: 'drain' });
});

it('advertises development and externally supervised installations as unsupported', () => {
  const host = createCliUpdateAdapter({ packageRoot: '/source/web', dataDir: '/data', env: {} });
  expect(host.supported).toBe(false);
  expect(fixture.fork).not.toHaveBeenCalled();
});

it('advertises manual or service-managed self-contained installs as unsupported without probes or shutdown', async () => {
  fixture.portable = true;
  const shutdown = vi.fn();
  const host = createCliUpdateAdapter({ packageRoot: '/extracted/yuri/lib', dataDir: '/data', getPort: () => 3000, currentVersion: '2.0.0', shutdown, env: {} });
  expect(host.supported).toBe(false);
  expect(host.reason).toBe('portable_installation_requires_release');
  await host.refreshSupport();
  await expect(host.assertReady()).rejects.toThrow('installer');
  expect(fixture.fork).not.toHaveBeenCalled();
  expect(shutdown).not.toHaveBeenCalled();
});

it('updates installer-managed self-contained releases through the release archive, not npm', async () => {
  fixture.portable = true;
  const host = createCliUpdateAdapter({ packageRoot: '/share/yuri/versions/2.0.0-linux-x64/lib', dataDir: '/data', getPort: () => 3000, currentVersion: '2.0.0', shutdown: vi.fn(), env: {} });
  expect(host.supported).toBe(process.platform === 'linux');
  await host.inspect('stable');
  expect(fixture.portableInspect).toHaveBeenCalledWith('stable', '2.0.0');
  expect(fixture.inspect).not.toHaveBeenCalled();
  if (process.platform !== 'linux') return;
  await host.assertReady();
  expect(fixture.children[0].send).toHaveBeenCalledWith(expect.objectContaining({ mode: 'probe', installation: 'portable' }));
});

it('does not treat a container as unsupported, but still honors service managers', () => {
  const container = createCliUpdateAdapter({ packageRoot: '/installation/node_modules/@yuriai/web', dataDir: '/data', env: { container: 'docker', CONTAINER: '1' } });
  expect(container.supported).toBe(process.platform !== 'win32');
  const managed = createCliUpdateAdapter({ packageRoot: '/installation/node_modules/@yuriai/web', dataDir: '/data', env: { INVOCATION_ID: 'unit' } });
  expect(managed.supported).toBe(false);
  expect(managed.reason).toBe('managed_or_development_installation');
});
