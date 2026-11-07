import { describe, expect, test } from 'vitest';
import { createProviderRemoval, providerRemovalBlock, readProviderRemovalSnapshot } from './settings-provider-removal';
import type { SettingsRequest } from './settings-protocol';

function fixture(directory?: string) {
  const data = { configured: true, credentials: ['account/a', 'account-b'], environment: false, runtime: false, current: true,
    configFailures: 0, credentialFailure: '', lostCredentialReply: '', refreshFailures: 0, malformed: '', configReply: undefined as unknown };
  const calls: { path: string; method: string }[] = [];
  let writes = 0;
  const send: SettingsRequest = async (path, method = 'GET') => {
    calls.push({ path, method });
    const url = new URL(path, 'http://fixture.invalid');
    const present = data.configured || data.credentials.length > 0 || data.environment || data.runtime;
    if (method === 'GET') {
      if (writes && data.refreshFailures > 0) { data.refreshFailures--; throw new Error('fixture read failure'); }
      if (data.malformed === url.pathname) return {};
      if (url.pathname === '/api/provider') return { data: present ? [{ id: 'provider/fixture', integrationID: 'integration/fixture' }] : [] };
      if (url.pathname === '/api/integration') return { data: [{ id: 'integration/fixture', connections: [
        ...data.credentials.map(id => ({ type: 'credential', id })), ...(data.environment ? [{ type: 'env', name: 'FIXTURE_KEY' }] : []),
      ] }] };
      if (url.pathname === '/api/config/providers/sources') return present ? { 'provider/fixture': { files: data.configured ? [{ path: '/fixture/opencode.jsonc', scope: 'user' }] : [], origin: data.configured ? 'config' : 'runtime' } } : {};
    }
    if (method === 'DELETE' && url.pathname === '/api/provider/provider%2Ffixture/auth') {
      writes++;
      expect(url.searchParams.get('scope')).toBe('config');
      expect(url.searchParams.get('directory')).toBe(directory ?? null);
      if (data.configFailures > 0) { data.configFailures--; throw new Error('fixture partial file failure'); }
      data.configured = false;
      return data.configReply ?? { success: true, removed: true, requiresReload: false };
    }
    if (method === 'DELETE' && url.pathname.startsWith('/api/credential/')) {
      writes++;
      expect(url.search).toBe('');
      const id = decodeURIComponent(url.pathname.slice('/api/credential/'.length));
      if (data.credentialFailure === id) { data.credentialFailure = ''; throw new Error('fixture credential failure'); }
      data.credentials = data.credentials.filter(item => item !== id);
      if (data.lostCredentialReply === id) { data.lostCredentialReply = ''; throw new Error('fixture lost reply'); }
      return null;
    }
    throw new Error(`Unexpected fixture request: ${method} ${path}`);
  };
  const removal = createProviderRemoval(send, { providerID: 'provider/fixture', directory, current: () => data.current });
  const deletes = () => calls.filter(call => call.method === 'DELETE').map(call => call.path);
  return { data, calls, send, removal, deletes };
}

describe('NSH provider destructive protocol', () => {
  test.each([undefined, '/fixture/project'])('removes config then scoped integration credential IDs and verifies absence (%s)', async directory => {
    const f = fixture(directory);
    const consent = await f.removal.inspect();
    expect(providerRemovalBlock(consent)).toBeNull();
    await f.removal.remove(consent);
    expect(f.deletes()).toEqual([
      `/api/provider/provider%2Ffixture/auth?scope=config${directory ? '&directory=%2Ffixture%2Fproject' : ''}`,
      '/api/credential/account%2Fa', '/api/credential/account-b',
    ]);
    expect(f.calls.filter(call => call.path.startsWith('/api/integration?')).every(call => call.path.endsWith('location%5Bdirectory%5D=%2Ffixture%2Fproject'))).toBe(true);
    expect(f.calls.some(call => call.path === '/api/credential' || call.path.includes('reload'))).toBe(false);
    expect((await f.removal.inspect()).present).toBe(false);
  });

  test('inspection/cancel performs only safe metadata reads', async () => {
    const f = fixture(); await f.removal.inspect();
    expect(f.deletes()).toEqual([]); expect(f.removal.started()).toBe(false);
  });

  test('environment sources are blocked even when files and credentials coexist', async () => {
    const f = fixture(); f.data.environment = true;
    const consent = await f.removal.inspect();
    expect(providerRemovalBlock(consent)).toBe('environment');
    await expect(f.removal.remove(consent)).rejects.toMatchObject({ reason: 'environment' });
    expect(f.deletes()).toEqual([]);
  });

  test('rechecks environment after confirmation before the first destructive request', async () => {
    const f = fixture(); const consent = await f.removal.inspect(); f.data.environment = true;
    await expect(f.removal.remove(consent)).rejects.toMatchObject({ reason: 'environment' });
    expect(f.deletes()).toEqual([]);
  });

  test('runtime-only providers cannot be removed with an auth shortcut', async () => {
    const f = fixture(); Object.assign(f.data, { configured: false, credentials: [], runtime: true });
    const consent = await f.removal.inspect();
    expect(providerRemovalBlock(consent)).toBe('unavailable');
    await expect(f.removal.remove(consent)).rejects.toMatchObject({ reason: 'unavailable' });
    expect(f.deletes()).toEqual([]);
  });

  test.each(['/api/provider', '/api/integration', '/api/config/providers/sources'])('malformed authority at %s fails closed', async malformed => {
    const f = fixture(); f.data.malformed = malformed;
    await expect(f.removal.inspect()).rejects.toMatchObject({ reason: 'metadata' });
    expect(f.deletes()).toEqual([]);
  });

  test('missing sources, missing connections, unknown connection kinds and missing credential IDs are not empty success', async () => {
    const rows = [
      { sources: {}, integration: { connections: [] } },
      { sources: { fixture: { files: [] } }, integration: {} },
      { sources: { fixture: { files: [] } }, integration: { connections: [{ type: 'unknown' }] } },
      { sources: { fixture: { files: [] } }, integration: { connections: [{ type: 'credential' }] } },
    ];
    for (const row of rows) {
      const send: SettingsRequest = async path => path === '/api/provider' ? { data: [{ id: 'fixture' }] }
        : path === '/api/integration' ? { data: [{ id: 'fixture', ...row.integration }] } : row.sources;
      await expect(readProviderRemovalSnapshot(send, 'fixture')).rejects.toThrow();
    }
  });

  test('partial config failure keeps the intent and safely retries before touching credentials', async () => {
    const f = fixture(); f.data.configFailures = 1;
    const consent = await f.removal.inspect();
    await expect(f.removal.remove(consent)).rejects.toMatchObject({ reason: 'failed' });
    expect(f.deletes()).toHaveLength(1); expect(f.data.credentials).toHaveLength(2);
    expect(f.removal.started()).toBe(true);
    await f.removal.remove();
    expect(f.deletes().filter(path => path.includes('/auth?'))).toHaveLength(2);
  });

  test('credential partial failure retries only the unfinished credential, not ACKed config/accounts', async () => {
    const f = fixture(); f.data.credentialFailure = 'account-b';
    await expect(f.removal.remove(await f.removal.inspect())).rejects.toMatchObject({ reason: 'failed' });
    expect(f.data.configured).toBe(false); expect(f.data.credentials).toEqual(['account-b']);
    await f.removal.remove();
    expect(f.deletes().filter(path => path.includes('/auth?'))).toHaveLength(1);
    expect(f.deletes().filter(path => path.endsWith('account%2Fa'))).toHaveLength(1);
    expect(f.deletes().filter(path => path.endsWith('account-b'))).toHaveLength(2);
  });

  test('lost credential ACK is reconciled from integration metadata without repeating DELETE', async () => {
    const f = fixture(); f.data.lostCredentialReply = 'account/a';
    await expect(f.removal.remove(await f.removal.inspect())).rejects.toThrow();
    await f.removal.remove();
    expect(f.deletes().filter(path => path.endsWith('account%2Fa'))).toHaveLength(1);
  });

  test('failed verification preserves intent and retries GETs only after all writes have ACKed', async () => {
    const f = fixture(); const consent = await f.removal.inspect(); f.data.refreshFailures = 1;
    await expect(f.removal.remove(consent)).rejects.toMatchObject({ reason: 'metadata' });
    const before = f.deletes();
    await f.removal.remove();
    expect(f.deletes()).toEqual(before);
  });

  test('provider still registered is not success; retry only verifies after the runtime catches up', async () => {
    const f = fixture(); f.data.runtime = true;
    await expect(f.removal.remove(await f.removal.inspect())).rejects.toMatchObject({ reason: 'failed' });
    const before = f.deletes(); f.data.runtime = false;
    await f.removal.remove(); expect(f.deletes()).toEqual(before);
  });

  test('does not widen confirmed consent to a newly registered credential', async () => {
    const f = fixture(); const consent = await f.removal.inspect(); f.data.credentials.push('new-account');
    await expect(f.removal.remove(consent)).rejects.toMatchObject({ reason: 'failed' });
    expect(f.deletes()).toEqual([]);
  });

  test.each(['files', 'credentials'])('removes a provider backed only by %s', async source => {
    const f = fixture();
    if (source === 'files') f.data.credentials = [];
    else f.data.configured = false;
    await f.removal.remove(await f.removal.inspect());
    expect((await f.removal.inspect()).present).toBe(false);
    expect(f.deletes().filter(path => path.startsWith('/api/credential/'))).toHaveLength(source === 'files' ? 0 : 2);
  });

  test('new source files require new consent before the config endpoint can remove them', async () => {
    const f = fixture(); f.data.configured = false;
    const consent = await f.removal.inspect(); f.data.configured = true;
    await expect(f.removal.remove(consent)).rejects.toMatchObject({ reason: 'failed' });
    expect(f.deletes()).toEqual([]);
  });

  test('an environment source introduced after partial failure blocks the retry without more mutations', async () => {
    const f = fixture(); f.data.credentialFailure = 'account-b';
    await expect(f.removal.remove(await f.removal.inspect())).rejects.toThrow();
    const before = f.deletes(); f.data.environment = true;
    await expect(f.removal.remove()).rejects.toMatchObject({ reason: 'environment' });
    expect(f.deletes()).toEqual(before);
    f.data.environment = false; await f.removal.remove();
  });

  test('Host/page fence blocks late work before any follow-up writes', async () => {
    const f = fixture(); const consent = await f.removal.inspect();
    const send: SettingsRequest = async (path, method, body) => {
      const reply = await f.send(path, method, body);
      if (method === 'DELETE') f.data.current = false;
      return reply;
    };
    const removal = createProviderRemoval(send, { providerID: 'provider/fixture', current: () => f.data.current });
    await expect(removal.remove(consent)).rejects.toMatchObject({ reason: 'stale' });
    expect(f.deletes()).toHaveLength(1); expect(f.data.credentials).toHaveLength(2);
  });

  test('logical config failure stops before credential deletion and is not checkpointed', async () => {
    const f = fixture(); f.data.configReply = { success: false, removed: true };
    await expect(f.removal.remove(await f.removal.inspect())).rejects.toMatchObject({ reason: 'failed' });
    expect(f.data.credentials).toHaveLength(2);
    f.data.configReply = undefined; await f.removal.remove();
    expect(f.deletes().filter(path => path.includes('/auth?'))).toHaveLength(2);
  });
});
