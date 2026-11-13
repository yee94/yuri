import { describe, expect, it, vi } from 'vitest';
import { createDesktopRemoteHostsAdapter } from './remote-hosts.mjs';
import { ElectronSshManager } from './ssh-manager.mjs';

describe('native Hub host adapter', () => {
  it.each([false, true])('projects only live safe preparation phases and cleans up on failure=%s', async (fail) => {
    const manager = new ElectronSshManager({ emit: () => {} });
    manager.readInstances = () => ({ instances: [{ id: 'ssh' }] });
    manager.ensureConnected = async () => {
      for (const phase of ['remote_probe', 'installing', 'updating', 'server_starting', 'forwarding']) {
        manager.setStatus('other', 'updating', 'private other-host detail');
        manager.setStatus('ssh', phase, 'private path and credentials');
      }
      if (fail) throw new Error('Permission denied (publickey): private detail');
    };
    const adapter = createDesktopRemoteHostsAdapter({ sshManager: manager,
      readHosts: () => ({ hosts: [{ id: 'ssh', apiUrl: 'http://forward.invalid' }] }) });
    const onProgress = vi.fn();
    const result = adapter.prepareHost('ssh', { onProgress });
    if (fail) await expect(result).rejects.toMatchObject({ code: 'remote_ssh_authentication_failed' });
    else await result;
    expect(onProgress.mock.calls).toEqual(['checking', 'installing', 'updating', 'starting', 'connecting'].map((phase) => [phase]));
    manager.setStatus('ssh', 'updating');
    expect(onProgress).toHaveBeenCalledTimes(5);
  });

  it('reuses a live ready SSH forward for directory requests instead of restarting initialization', async () => {
    const connect = vi.fn(async () => { throw new Error('Ready SSH must not be disconnected'); });
    const adapter = createDesktopRemoteHostsAdapter({
      readHosts: () => ({ hosts: [{ id: 'ssh', apiUrl: 'http://forward.invalid', clientToken: 'private' }] }),
      sshManager: { readInstances: () => ({ instances: [{ id: 'ssh' }] }),
        ensureConnected: vi.fn(async () => {}), connect },
    });
    for (let request = 0; request < 3; request++) await adapter.prepareHost('ssh');
    expect(connect).not.toHaveBeenCalled();
  });

  it('reports safe SSH failure codes without forwarding native error details', async () => {
    const adapter = createDesktopRemoteHostsAdapter({ readHosts: () => ({ hosts: [] }),
      sshManager: { readInstances: () => ({ instances: [{ id: 'ssh' }] }),
        ensureConnected: async () => { throw new Error('Permission denied (publickey): private remote detail'); } } });
    await expect(adapter.prepareHost('ssh')).rejects.toMatchObject({ code: 'remote_ssh_authentication_failed', message: 'remote_ssh_authentication_failed' });
  });

  it('uses its own saved host catalog, not the focused window runtime', async () => {
    const connect = vi.fn(async () => {});
    const adapter = createDesktopRemoteHostsAdapter({
      readHosts: () => ({ hosts: [{ id: 'direct', label: 'Direct', apiUrl: 'http://direct.invalid', clientToken: 'private' },
        { id: 'paired', label: 'Paired', relay: { serverId: 'server' }, source: 'connect-link' }] }),
      sshManager: { readInstances: () => ({ instances: [{ id: 'ssh', name: 'SSH' }] }), ensureConnected: connect },
    });
    expect((await adapter.listHosts()).map(({ id, source }) => ({ id, source })))
      .toEqual([{ id: 'direct', source: 'direct' }, { id: 'paired', source: 'relay' }, { id: 'ssh', source: 'ssh' }]);
    await adapter.prepareHost('direct');
    expect(connect).not.toHaveBeenCalled();
  });

  it('prepares SSH once through the existing native manager and never grants unpaired Relay', async () => {
    const connect = vi.fn(async () => {});
    const adapter = createDesktopRemoteHostsAdapter({
      readHosts: () => ({ hosts: [{ id: 'ssh', apiUrl: 'http://forward.invalid', clientToken: 'private', relay: { serverId: 'discovered' } }] }),
      sshManager: { readInstances: () => ({ instances: [{ id: 'ssh' }] }), ensureConnected: connect },
    });
    const prepared = await adapter.prepareHost('ssh');
    expect(prepared).toEqual((await adapter.listHosts())[0]);
    expect(connect).toHaveBeenCalledExactlyOnceWith('ssh');
    expect(prepared.source).toBe('ssh');
    expect(prepared.relay).toBeUndefined();
  });

  it('retains explicit pairing provenance for SSH+Relay and reports deleted hosts', async () => {
    const adapter = createDesktopRemoteHostsAdapter({
      readHosts: () => ({ hosts: [{ id: 'ssh', source: 'connect-link', relay: { serverId: 'paired' } }] }),
      sshManager: { readInstances: () => ({ instances: [{ id: 'ssh' }] }), ensureConnected: async () => {} },
    });
    expect((await adapter.prepareHost('ssh')).relay.serverId).toBe('paired');
    await expect(adapter.prepareHost('deleted')).rejects.toMatchObject({ code: 'host_unavailable', status: 404 });
  });
});
