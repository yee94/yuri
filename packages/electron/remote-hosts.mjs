import { classifyManagedSshBootstrapError } from './ssh-manager.mjs';

/** Saved hosts belong to this server's computer, never the focused window. */
export function createDesktopRemoteHostsAdapter({ readHosts, sshManager, subscribe }) {
  return {
    subscribe,
    async listHosts() {
      const config = readHosts();
      const ssh = sshManager.readInstances().instances;
      const hosts = config.hosts.map((host) => ({ ...host,
        name: host.label || host.id,
        source: ssh.some((instance) => instance.id === host.id) ? 'ssh' : host.relay ? 'relay' : 'direct',
        pairingSource: host.source,
      }));
      for (const instance of ssh) if (!hosts.some((host) => host.id === instance.id)) {
        hosts.push({ id: instance.id, name: instance.name || instance.label || instance.id, source: 'ssh' });
      }
      for (const host of hosts) if (host.source === 'ssh' && host.pairingSource !== 'connect-link') delete host.relay;
      return hosts;
    },
    async prepareHost(id) {
      if (sshManager.readInstances().instances.some((instance) => instance.id === id)) {
        try { await sshManager.ensureConnected(id); }
        catch (error) {
          const reason = classifyManagedSshBootstrapError(error?.message);
          const code = reason === 'sshAuth' ? 'remote_ssh_authentication_failed'
            : reason === 'serverStart' ? 'remote_service_starting'
              : reason === 'yuriCliIncompatible' ? 'remote_incompatible' : 'remote_ssh_unavailable';
          throw Object.assign(new Error(code), { code, status: code === 'remote_incompatible' ? 409 : 503 });
        }
      }
      const host = (await this.listHosts()).find((entry) => entry.id === id);
      if (!host) throw Object.assign(new Error('host_unavailable'), { code: 'host_unavailable', status: 404 });
      if (host.source === 'ssh' && host.pairingSource !== 'connect-link') delete host.relay;
      return host;
    },
  };
}
