import { beforeEach, describe, expect, test, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  runtimeKey: 'host:ssh',
  apiBaseUrl: 'http://127.0.0.1:4000',
  bearer: 'old-token',
  config: null as null | Record<string, unknown>,
  invoke: vi.fn(async () => null),
  switchRuntimeEndpoint: vi.fn(),
}));

vi.mock('@/lib/desktop', () => ({
  isElectronShell: () => true,
  invokeDesktop: hoisted.invoke,
}));
vi.mock('@/lib/desktopBoot', () => ({ getInjectedBootOutcome: () => null }));
vi.mock('@/lib/desktopHosts', () => ({
  desktopHostsGet: async () => hoisted.config,
  getDesktopHostApiUrl: (host: { apiUrl?: string; url?: string }) => host.apiUrl || host.url || '',
  normalizeHostUrl: (url: string) => url || null,
}));
vi.mock('@/lib/desktopHostSwitch', () => ({ runtimeKeyForDesktopHost: (host: { id: string }) => `host:${host.id}` }));
vi.mock('@/lib/relay/runtime-tunnel', () => ({ getActiveRelayTunnel: () => null }));
vi.mock('@/lib/runtime-auth', () => ({ getRuntimeAuthGeneration: () => 0, getRuntimeBearerTokenSync: () => hoisted.bearer }));
vi.mock('@/lib/runtime-switch', () => ({
  getRuntimeApiBaseUrl: () => hoisted.apiBaseUrl,
  getRuntimeGeneration: () => 0,
  getRuntimeKey: () => hoisted.runtimeKey,
  switchRuntimeEndpoint: hoisted.switchRuntimeEndpoint,
}));

const { findBoundDesktopSshHost, resyncDesktopSshHostRuntime } = await import('./desktopSshHostRuntime');

const sshConfig = (host: Record<string, unknown>) => ({ hosts: [{ id: 'ssh', ...host }], sshHostIds: ['ssh'] });

beforeEach(() => {
  hoisted.runtimeKey = 'host:ssh';
  hoisted.apiBaseUrl = 'http://127.0.0.1:4000';
  hoisted.bearer = 'old-token';
  hoisted.invoke.mockReset().mockResolvedValue(null);
  hoisted.switchRuntimeEndpoint.mockReset();
});

describe('resyncDesktopSshHostRuntime', () => {
  test('adopts the replacement token stored by an SSH reconnect without re-minting', async () => {
    hoisted.config = sshConfig({ url: 'http://127.0.0.1:5000', clientToken: 'new-token' });
    await expect(resyncDesktopSshHostRuntime({ hostId: 'ssh' })).resolves.toBe('switched');
    expect(hoisted.invoke).not.toHaveBeenCalled();
    expect(hoisted.switchRuntimeEndpoint).toHaveBeenCalledWith({
      apiBaseUrl: 'http://127.0.0.1:5000', clientToken: 'new-token', requestHeaders: null, runtimeKey: 'host:ssh',
    });
  });

  test('is a no-op when the window already holds the stored credential', async () => {
    hoisted.config = sshConfig({ url: 'http://127.0.0.1:4000', clientToken: 'old-token' });
    await expect(resyncDesktopSshHostRuntime()).resolves.toBe('unchanged');
    expect(hoisted.switchRuntimeEndpoint).not.toHaveBeenCalled();
  });

  test('ignores other hosts, local windows and non-SSH hosts', async () => {
    hoisted.config = sshConfig({ url: 'http://127.0.0.1:5000', clientToken: 'new-token' });
    await expect(resyncDesktopSshHostRuntime({ hostId: 'other' })).resolves.toBe('not-ssh');
    hoisted.runtimeKey = 'local';
    await expect(resyncDesktopSshHostRuntime({ refresh: true })).resolves.toBe('not-ssh');
    hoisted.runtimeKey = 'host:ssh';
    hoisted.config = { hosts: [{ id: 'ssh', url: 'http://remote', clientToken: 'x' }], sshHostIds: [] };
    await expect(resyncDesktopSshHostRuntime({ refresh: true })).resolves.toBe('not-ssh');
    expect(hoisted.invoke).not.toHaveBeenCalled();
    expect(hoisted.switchRuntimeEndpoint).not.toHaveBeenCalled();
  });

  test('recognizes a reloaded window by its SSH tunnel endpoint when the host key is gone', async () => {
    hoisted.runtimeKey = 'local';
    hoisted.config = sshConfig({ url: 'http://127.0.0.1:4000', clientToken: 'new-token', label: 'Build box' });
    await expect(resyncDesktopSshHostRuntime()).resolves.toBe('switched');
    expect(hoisted.switchRuntimeEndpoint).toHaveBeenCalledWith(expect.objectContaining({ clientToken: 'new-token', runtimeKey: 'host:ssh' }));
    await expect(findBoundDesktopSshHost()).resolves.toEqual({ id: 'ssh', label: 'Build box' });
  });

  test('refresh asks the shell to renew a rejected token, and reports shell failure', async () => {
    hoisted.config = sshConfig({ url: 'http://127.0.0.1:4000', clientToken: 'old-token' });
    hoisted.invoke.mockImplementationOnce(async () => {
      hoisted.config = sshConfig({ url: 'http://127.0.0.1:4000', clientToken: 'renewed-token' });
      return null;
    });
    await expect(resyncDesktopSshHostRuntime({ refresh: true })).resolves.toBe('switched');
    expect(hoisted.invoke).toHaveBeenCalledWith('desktop_ssh_host_token_refresh', { hostId: 'ssh' });

    hoisted.invoke.mockRejectedValueOnce(new Error('tunnel down'));
    await expect(resyncDesktopSshHostRuntime({ refresh: true })).resolves.toBe('failed');
  });
});
