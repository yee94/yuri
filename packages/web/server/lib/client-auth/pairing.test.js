import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { createClientPairingRuntime } from './pairing.js';
import { createRemoteClientAuthRuntime } from './remote-clients.js';

const makeRuntime = async (options = {}) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yuri-pairing-test-'));
  const createdClients = [];
  const remoteClientAuthRuntime = options.remoteClientAuthRuntime || {
    createClient: vi.fn(async (input) => {
      const client = {
        id: `client-${createdClients.length + 1}`,
        label: input.label,
        clientKind: input.clientKind,
        authMethod: input.authMethod,
        pairingId: input.pairingId,
        deviceName: input.deviceName ?? null,
      };
      createdClients.push(client);
      return { client, token: `token-${createdClients.length}` };
    }),
  };
  const runtime = createClientPairingRuntime({
    fsPromises: fs,
    path,
    crypto,
    storePath: path.join(dir, 'pairing.json'),
    remoteClientAuthRuntime,
    ttlMs: options.ttlMs ?? 10 * 60 * 1000,
  });
  return { dir, runtime, remoteClientAuthRuntime, createdClients };
};

describe('client auth pairing runtime', () => {
  it('keeps the same device paired through different relays independently across restart', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yuri-pairing-relays-test-'));
    const authOptions = { fsPromises: fs, path, crypto, storePath: path.join(dir, 'clients.json') };
    const clients = createRemoteClientAuthRuntime(authOptions);
    const pairingOptions = {
      fsPromises: fs, path, crypto, storePath: path.join(dir, 'pairing.json'), remoteClientAuthRuntime: clients,
    };
    const pair = async (relayUrl, label) => {
      const { pairing } = await createClientPairingRuntime(pairingOptions).createPairingSession({
        label, usesRelay: Boolean(relayUrl), relayUrl,
      });
      return createClientPairingRuntime(pairingOptions).redeemPairingSession({
        pairingId: pairing.id, secret: pairing.secret, clientKind: 'mobile', dedupeKey: 'same-device',
      });
    };
    try {
      const first = await pair('wss://relay-one.example/ws', 'Phone via first relay');
      const second = await pair('wss://relay-two.example/ws', 'Phone via second relay');
      const reopened = createRemoteClientAuthRuntime(authOptions);
      expect((await reopened.listClients()).map((client) => client.id)).toEqual([first.client.id, second.client.id]);
      expect((await reopened.authenticateBearerToken(first.token))?.ok).toBe(true);
      expect((await reopened.authenticateBearerToken(second.token))?.ok).toBe(true);

      const replacement = await pair('wss://relay-one.example/ws', 'Phone via first relay again');
      expect(await reopened.authenticateBearerToken(first.token)).toBe(null);
      expect((await reopened.authenticateBearerToken(second.token))?.ok).toBe(true);
      expect((await reopened.authenticateBearerToken(replacement.token))?.ok).toBe(true);
      expect(await reopened.listClients()).toHaveLength(2);

      const direct = await pair(null, 'Phone via LAN');
      expect(await reopened.listClients()).toHaveLength(3);
      await reopened.revokeClient(second.client.id);
      expect(await reopened.authenticateBearerToken(second.token)).toBe(null);
      expect((await reopened.authenticateBearerToken(replacement.token))?.ok).toBe(true);
      expect((await reopened.authenticateBearerToken(direct.token))?.ok).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('redeems a pairing session once and propagates client metadata', async () => {
    const { runtime, remoteClientAuthRuntime } = await makeRuntime();
    const created = await runtime.createPairingSession({ allowedClientKinds: ['mobile'] });

    const result = await runtime.redeemPairingSession({
      pairingId: created.pairing.id,
      secret: created.pairing.secret,
      clientLabel: 'Iryna iPhone',
      clientKind: 'mobile',
      deviceName: 'Iryna iPhone',
      dedupeKey: 'device-key',
    });

    expect(result.token).toBe('token-1');
    expect(result.client).toMatchObject({
      label: 'Iryna iPhone',
      clientKind: 'mobile',
      authMethod: 'pairing',
      pairingId: created.pairing.id,
      deviceName: 'Iryna iPhone',
    });
    expect(remoteClientAuthRuntime.createClient).toHaveBeenCalledWith(expect.objectContaining({
      authMethod: 'pairing',
      pairingId: created.pairing.id,
      clientKind: 'mobile',
      dedupeKey: 'device-key',
    }));

    await expect(runtime.redeemPairingSession({
      pairingId: created.pairing.id,
      secret: created.pairing.secret,
      clientKind: 'mobile',
    })).rejects.toThrow('Invalid or expired pairing session');
  });

  it('rejects expired, cancelled, wrong-secret, and disallowed-kind redemption', async () => {
    const { runtime: expiredRuntime } = await makeRuntime({ ttlMs: -1000 });
    const expired = await expiredRuntime.createPairingSession();
    await expect(expiredRuntime.redeemPairingSession({
      pairingId: expired.pairing.id,
      secret: expired.pairing.secret,
      clientKind: 'mobile',
    })).rejects.toThrow('Invalid or expired pairing session');

    const { runtime } = await makeRuntime();
    const cancelled = await runtime.createPairingSession();
    await runtime.cancelPairingSession(cancelled.pairing.id);
    await expect(runtime.redeemPairingSession({
      pairingId: cancelled.pairing.id,
      secret: cancelled.pairing.secret,
      clientKind: 'mobile',
    })).rejects.toThrow('Invalid or expired pairing session');

    const wrongSecret = await runtime.createPairingSession();
    await expect(runtime.redeemPairingSession({
      pairingId: wrongSecret.pairing.id,
      secret: 'wrong',
      clientKind: 'mobile',
    })).rejects.toThrow('Invalid or expired pairing session');

    const desktopOnly = await runtime.createPairingSession({ allowedClientKinds: ['desktop'] });
    await expect(runtime.redeemPairingSession({
      pairingId: desktopOnly.pairing.id,
      secret: desktopOnly.pairing.secret,
      clientKind: 'mobile',
    })).rejects.toThrow('Invalid or expired pairing session');
  });

  it('does not consume the pairing session if client issuance fails', async () => {
    const createClient = vi.fn()
      .mockRejectedValueOnce(new Error('disk failed'))
      .mockResolvedValueOnce({ client: { id: 'client-1' }, token: 'token-1' });
    const { runtime } = await makeRuntime({ remoteClientAuthRuntime: { createClient } });
    const created = await runtime.createPairingSession();

    await expect(runtime.redeemPairingSession({
      pairingId: created.pairing.id,
      secret: created.pairing.secret,
      clientKind: 'mobile',
    })).rejects.toThrow('disk failed');

    await expect(runtime.redeemPairingSession({
      pairingId: created.pairing.id,
      secret: created.pairing.secret,
      clientKind: 'mobile',
    })).resolves.toMatchObject({ token: 'token-1' });
    expect(createClient).toHaveBeenLastCalledWith(expect.objectContaining({
      dedupeKey: `pairing:${created.pairing.id}`,
    }));
  });

  it('sweeps expired never-used sessions from the store on the next create', async () => {
    const { dir, runtime } = await makeRuntime({ ttlMs: -1000 });
    // Immediately expired (negative TTL), never used or cancelled.
    const expired = await runtime.createPairingSession({ label: 'stale' });

    // The next create sweeps the store; only the fresh session should remain.
    const storePath = path.join(dir, 'pairing.json');
    await runtime.createPairingSession({ label: 'fresh' });
    const store = JSON.parse(await fs.readFile(storePath, 'utf8'));
    const ids = store.sessions.map((session) => session.id);
    expect(ids).not.toContain(expired.pairing.id);
    expect(ids).toHaveLength(1);
  });
});
