import { createHash } from 'node:crypto';
import { parseSshCommand } from './ssh-manager.mjs';

// Session input names destinations, not arbitrary SSH options or local commands.
const normalizeCommand = (value) => {
  if (typeof value !== 'string' || value.length > 1024) throw new Error('invalid_input');
  let parsed;
  try { parsed = parseSshCommand(value); } catch { throw new Error('invalid_input'); }
  const { destination, args } = parsed;
  if (!/^(?:[\w.-]+@)?(?:[\w.-]+|\[[\da-fA-F:]+\])$/.test(destination)) throw new Error('invalid_input');
  let port;
  for (let i = 0; i < args.length; i++) {
    if (port !== undefined || !/^-p(?:\d+)?$/.test(args[i])) throw new Error('invalid_input');
    port = args[i] === '-p' ? args[++i] : args[i].slice(2);
    if (!/^\d+$/.test(port ?? '') || Number(port) < 1 || Number(port) > 65535) throw new Error('invalid_input');
  }
  return `ssh ${destination}${port && Number(port) !== 22 ? ` -p ${Number(port)}` : ''}`;
};

/** Native operations for the local session bridge, independent of any window's runtime. */
export function createSessionConnections({ sshManager, getLocalExecutor, getLocalHost, fetchImpl = fetch }) {
  const work = new Map();
  const remoteHost = (id) => {
    sshManager.resolveManagedReadySession(id);
    const host = sshManager.readSettingsRoot().desktopHosts?.find((row) => row.id === id);
    if (!host?.url || !host.clientToken) throw new Error('instance_not_ready');
    return { apiUrl: host.url, clientToken: host.clientToken };
  };
  const snapshot = (id) => {
    const status = sshManager.statusSnapshotForInstance(id);
    const job = work.get(id);
    return { id, phase: status.phase, running: job?.running === true,
      ...(status.errorCode ? { errorCode: status.errorCode } : {}),
      ...(job?.sync ? { sync: job.sync } : {}), ...(job?.magpie ? { magpie: job.magpie } : {}),
      warnings: job?.warnings ?? [], ...(job?.error ? { error: job.error } : {}) };
  };
  const request = async (host, route, input) => {
    const response = await fetchImpl(new URL(route, host.apiUrl), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(240_000),
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${host.clientToken}` },
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error('host_operation_failed');
    return response.json();
  };
  return {
    async list() {
      return { instances: sshManager.readInstances().instances.map(({ id, nickname, sshParsed }) => ({
        ...snapshot(id), nickname, destination: sshParsed?.destination,
      })) };
    },
    async setup(input) {
      let instance;
      if (input.id) {
        instance = sshManager.readInstances().instances.find(({ id }) => id === input.id);
        if (!instance) throw new Error('instance_not_found');
      } else {
        const sshCommand = normalizeCommand(input.sshCommand);
        const existing = sshManager.readInstances().instances.find((entry) => {
          try { return normalizeCommand(entry.sshCommand) === sshCommand; } catch { return false; }
        });
        instance = existing ?? await sshManager.saveSessionConnection({
          id: `ssh-${createHash('sha256').update(sshCommand).digest('hex').slice(0, 24)}`,
          sshCommand, ...(input.nickname ? { nickname: input.nickname } : {}),
        });
      }
      if (instance.remoteYuri?.mode === 'external') throw new Error('external_instance');
      const { id } = instance;
      if (work.get(id)?.running) return snapshot(id);
      const job = { running: true, warnings: [] };
      work.set(id, job);
      // Setup is polled through list; an HTTP/tool deadline never cancels SSH bootstrap.
      void (async () => {
        try {
          await sshManager.connect(id);
          let inventory;
          try { inventory = await getLocalExecutor().magpieInventory(); }
          catch { job.warnings.push('source_inventory_failed'); }
          if (inventory) {
            job.magpie = inventory.installed ? 'pending' : 'not_installed';
            try {
              const initial = sshManager.resolveManagedReadySession(id).session.initialConfigSyncResult;
              const result = initial ?? await sshManager.applyOpencodeConfigSync(id, { direction: 'push',
                selections: { providerCredentials: !inventory.installed, magpie: inventory.installed && inventory.available } });
              job.sync = 'complete';
              job.warnings.push(...(result.magpieWarnings ?? []));
              await sshManager.setInitialConfigSyncPending(id, false);
            } catch { job.sync = 'failed'; job.warnings.push('config_sync_failed'); }
            if (inventory.installed) {
              if (!inventory.available) job.warnings.push('magpie_source_not_configured');
              try {
                const result = await request(remoteHost(id), '/api/yuri/config-sync/magpie/gateway', {});
                if (result?.ready !== true) throw new Error('gateway_not_ready');
                job.magpie = 'ready';
              } catch { job.magpie = 'failed'; job.warnings.push('magpie_gateway_failed'); }
            }
          } else job.sync = 'not_started';
        } catch { job.error = 'ssh_connection_failed'; }
        finally { job.running = false; }
      })();
      return snapshot(id);
    },
    async pair(input) {
      let host = getLocalHost();
      if (input.id) host = remoteHost(input.id);
      const result = await request(host, '/api/client-auth/pairing/sessions', {
        includeRelay: true, includeDirect: false,
        ...(input.relayUrl ? { relayUrl: input.relayUrl } : {}), ...(input.label ? { label: input.label } : {}),
      });
      const { pairing, server } = result;
      if (!pairing?.id || !pairing.secret || !pairing.expiresAt || !server?.candidates?.some((row) => row.type === 'relay')) throw new Error('pairing_unavailable');
      const payload = { v: 2, pairingId: pairing.id, secret: pairing.secret, label: server.label,
        fingerprint: pairing.fingerprint, expiresAt: pairing.expiresAt, candidates: server.candidates };
      return { url: `yuri://connect?v=2&p=${Buffer.from(JSON.stringify(payload)).toString('base64url')}`,
        expiresAt: pairing.expiresAt, fingerprint: pairing.fingerprint };
    },
  };
}
