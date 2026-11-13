import { describe, expect, it, vi } from 'vitest';
import { createSessionConnections } from './session-connections.mjs';

const fixture = ({ inventory = { installed: true, available: true }, syncError = false, connectError = false } = {}) => {
  const instances = [];
  const statuses = new Map();
  const initial = new Map();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const manager = {
    readInstances: () => ({ instances }),
    readSettingsRoot: () => ({ desktopHosts: instances.map(({ id }) => ({ id, url: 'http://127.0.0.1:4321', clientToken: 'private-token' })) }),
    saveSessionConnection: vi.fn(async (input) => { const instance = { ...input, remoteYuri: { mode: 'managed' } }; instances.push(instance); return instance; }),
    statusSnapshotForInstance: (id) => ({ phase: statuses.get(id) ?? 'idle' }),
    connect: vi.fn(async (id) => { statuses.set(id, 'installing'); await gate; if (connectError || instances.find((row) => row.id === id)?.sshCommand.includes('broken')) { statuses.set(id, 'error'); throw new Error('secret diagnostic'); } statuses.set(id, 'ready'); }),
    applyOpencodeConfigSync: vi.fn(async () => { if (syncError) throw new Error('private sync data'); return { ok: true, magpieWarnings: [] }; }),
    setInitialConfigSyncPending: vi.fn(),
    resolveManagedReadySession: (id) => { if (statuses.get(id) !== 'ready') throw new Error('Not ready'); return { session: { initialConfigSyncResult: initial.get(id) } }; },
  };
  const fetchImpl = vi.fn(async (_url, options) => {
    if (String(_url).endsWith('/gateway')) return Response.json({ ready: true });
    expect(JSON.parse(options.body)).toMatchObject({ includeRelay: true, includeDirect: false });
    return Response.json({ pairing: { id: 'pair_one', secret: 'temporary', expiresAt: '2099-01-01', fingerprint: 'ABCD' },
      server: { label: 'Host', candidates: [{ type: 'relay', serverId: 'host', relayUrl: 'wss://relay.example.invalid/ws', hostEncPubJwk: {} }] } });
  });
  const adapter = createSessionConnections({ sshManager: manager,
    getLocalExecutor: () => ({ magpieInventory: async () => inventory }),
    getLocalHost: () => ({ apiUrl: 'http://127.0.0.1:5678', clientToken: 'local-token' }), fetchImpl });
  return { adapter, manager, fetchImpl, instances, release, initial };
};

describe('local session connection orchestration', () => {
  it('upserts equivalent addresses, joins active setup and handles three targets independently', async () => {
    const f = fixture();
    const first = await f.adapter.setup({ sshCommand: 'ssh user@one:2222' });
    expect(first.running).toBe(true);
    expect((await f.adapter.setup({ sshCommand: 'ssh user@one -p2222' })).id).toBe(first.id);
    await f.adapter.setup({ sshCommand: 'ssh user@broken' });
    await f.adapter.setup({ sshCommand: 'ssh user@three' });
    expect(f.manager.connect).toHaveBeenCalledTimes(3);
    expect(f.instances).toHaveLength(3);
    f.release();
    await vi.waitFor(async () => expect((await f.adapter.list()).instances.every((row) => !row.running)).toBe(true));
    const rows = (await f.adapter.list()).instances;
    expect(rows[0]).toMatchObject({ phase: 'ready', sync: 'complete', magpie: 'ready', warnings: [] });
    expect(rows[1]).toMatchObject({ phase: 'error', error: 'ssh_connection_failed' });
    expect(rows[2]).toMatchObject({ phase: 'ready', sync: 'complete', magpie: 'ready' });
    expect(f.manager.applyOpencodeConfigSync).toHaveBeenCalledWith(first.id, { direction: 'push', selections: { providerCredentials: false, magpie: true } });
    expect(JSON.stringify(rows)).not.toMatch(/secret diagnostic|private-token|temporary/);
  });

  it('preserves the SSH connection on sync/gateway failure and retries the saved ID', async () => {
    const f = fixture({ syncError: true });
    f.fetchImpl.mockRejectedValue(new Error('secret'));
    const { id } = await f.adapter.setup({ sshCommand: 'ssh host' });
    f.release();
    await vi.waitFor(async () => expect((await f.adapter.list()).instances[0].running).toBe(false));
    expect((await f.adapter.list()).instances[0]).toMatchObject({ phase: 'ready', sync: 'failed', magpie: 'failed', warnings: ['config_sync_failed', 'magpie_gateway_failed'] });
    await f.adapter.setup({ id });
    expect(f.manager.saveSessionConnection).toHaveBeenCalledTimes(1);
    await vi.waitFor(async () => expect((await f.adapter.list()).instances[0].running).toBe(false));
  });

  it.each([true, false])('uses installation rather than transferable config to choose Magpie: %s', async (installed) => {
    const f = fixture({ inventory: { installed, available: false } });
    const { id } = await f.adapter.setup({ sshCommand: 'host' });
    f.release();
    await vi.waitFor(async () => expect((await f.adapter.list()).instances[0].running).toBe(false));
    expect(f.manager.applyOpencodeConfigSync).toHaveBeenCalledWith(id, { direction: 'push', selections: { providerCredentials: !installed, magpie: false } });
    expect(f.fetchImpl).toHaveBeenCalledTimes(installed ? 1 : 0);
    expect((await f.adapter.list()).instances[0].warnings).toEqual(installed ? ['magpie_source_not_configured'] : []);
  });

  it('reuses the first-install transfer receipt instead of transferring twice', async () => {
    const f = fixture();
    const { id } = await f.adapter.setup({ sshCommand: 'host' });
    f.initial.set(id, { ok: true, magpieWarnings: ['sign_in_required'] });
    f.release();
    await vi.waitFor(async () => expect((await f.adapter.list()).instances[0].running).toBe(false));
    expect(f.manager.applyOpencodeConfigSync).not.toHaveBeenCalled();
    expect((await f.adapter.list()).instances[0].warnings).toEqual(['sign_in_required']);
  });

  it.each(['ssh host -oProxyCommand=evil', 'ssh host -F /file', 'ssh host command', 'ssh -p0 host', 'ssh bad;command'])('rejects arbitrary command/options: %s', async (sshCommand) => {
    const f = fixture();
    await expect(f.adapter.setup({ sshCommand })).rejects.toThrow();
    expect(f.manager.saveSessionConnection).not.toHaveBeenCalled();
  });

  it('creates a v2 Relay link on the local host or chosen ready SSH host without changing provenance', async () => {
    const f = fixture();
    const local = await f.adapter.pair({});
    const payload = JSON.parse(Buffer.from(new URL(local.url).searchParams.get('p'), 'base64url').toString());
    expect(payload).toMatchObject({ v: 2, pairingId: 'pair_one', secret: 'temporary', fingerprint: 'ABCD' });
    expect(f.fetchImpl.mock.calls[0][0].origin).toBe('http://127.0.0.1:5678');
    const { id } = await f.adapter.setup({ sshCommand: 'host' });
    await expect(f.adapter.pair({ id })).rejects.toThrow('Not ready');
    f.release();
    await vi.waitFor(async () => expect((await f.adapter.list()).instances[0].running).toBe(false));
    await f.adapter.pair({ id, relayUrl: 'wss://relay.example.invalid/ws' });
    const [url, options] = f.fetchImpl.mock.calls.at(-1);
    expect(url.origin).toBe('http://127.0.0.1:4321');
    expect(options.headers.Authorization).toBe('Bearer private-token');
    expect(f.instances[0]).not.toHaveProperty('relay');
  });
});
