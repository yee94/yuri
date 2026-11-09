import { createHost as createBaseHost } from '../desktop-application/host.js';
import { desktopJournalMethods } from '../desktop-journal-host.js';
import { StrictNativeSshHost, nativeSshCapabilities, nativeSshInstance } from '../../desktop-remote-connections-native-test-host.mjs';

export const sshMethods = ['capabilities', 'read', 'save', 'remove', 'start', 'cancel'].map(name => 'desktop.ssh.' + name);
const clone = value => JSON.parse(JSON.stringify(value));

/** Actual App root, synthetic transport leaves only. No native SSH, Vault or disk. */
export function createRemoteConnectionsApplicationHost(mode = 'ready') {
  const base = createBaseHost(), ssh = new StrictNativeSshHost(), rejected = [], nativeCalls = [], runtimeCalls = [];
  if (mode === 'unsupported') ssh.capability = { ...nativeSshCapabilities, connections: { supported: false, phase: 'unsupported', maxPending: 16 } };
  if (mode === 'starting') ssh.capability = { ...nativeSshCapabilities, connections: { supported: false, phase: 'starting', maxPending: 16 } };
  const ready = { ...nativeSshInstance, id: 'native-ready', label: 'Local native ready SSH', host: 'local-service.example.invalid' };
  ssh.value = { ...ssh.value, instances: [nativeSshInstance, ready], statuses: [{ id: ready.id, attempt: 1, requestID: 'native-initial', phase: 'ready', error: null, retry: 0, running: false, connectionID: 'native-owned-connection' }] };
  const names = [...desktopJournalMethods, 'appearance.reset', 'appearance.apply', 'native.diagnostics.status', 'notification.status', 'notification.launch.peek', 'connection.list', 'connection.select', 'runtime.stream', 'runtime.stop', 'runtime.request', 'desktop.window.closeDecision', ...sshMethods];
  const handlers = Object.fromEntries(names.map(name => [name, async input => {
    try {
      if (sshMethods.includes(name)) {
        nativeCalls.push({ name, input: clone(input) });
        return await ssh.call(name, input, { timeout: name === 'desktop.ssh.capabilities' ? 5000 : 30000 });
      }
      if (name === 'connection.list' || name === 'connection.select') {
        const snapshot = await base.call(name, input);
        return { ...snapshot, connections: snapshot.connections.map(row => ({ ...row, authorizationID: 'remote-runtime-authorization-' + row.id })) };
      }
      if (name === 'runtime.request') {
        runtimeCalls.push(clone(input));
        if (input.method !== 'GET') throw new Error('remote_runtime_mutation_forbidden');
        if (!input.expectedHost || !['desktop-fixture', 'other-fixture'].includes(input.expectedHost.hostID)) throw new Error('remote_runtime_identity_required');
        const path = input.path.split('?')[0];
        if (path.startsWith('/api/ssh') || path.includes('/ssh/') || path.includes('/sync')) throw new Error('native_service_cannot_use_remote_runtime');
        const ok = body => ({ status: 200, body });
        if (path === '/api/debug/location') return ok([]);
        if (path === '/api/client-auth/clients') return ok({ clients: [], currentClientId: null });
        if (path === '/api/client-auth/pairing/sessions') return ok({ pending: [] });
        if (path === '/api/client-auth/pairing/transports') return ok({ local: 'https://pairing.example.invalid', lan: null, relayAvailable: false });
      }
      return await base.call(name, input);
    } catch (error) {
      rejected.push({ name, message: error instanceof Error ? error.message : 'unknown' });
      throw error;
    }
  }]));
  return {
    handlers, nativeCalls, runtimeCalls, rejected,
    support() { ssh.capability = nativeSshCapabilities; },
    loseSave() { ssh.loseNextSave = true; },
    recoverReceipt() { ssh.value = ssh.withheld; },
  };
}

export function createHost() {
  const fixture = createRemoteConnectionsApplicationHost();
  return { call(name, input) { const handler = fixture.handlers[name]; if (!handler) throw new Error('unsupported_synthetic_root_method'); return handler(input); } };
}
