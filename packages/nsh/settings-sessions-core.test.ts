import { expect, test, vi } from 'vitest';
import { createSettingsSessions } from './settings-sessions-core';
import type { SettingsRequest } from './settings-protocol';

function fixture(send: SettingsRequest) {
  let current = true;
  const native = { authorizeManagement: vi.fn(async () => {}), register: vi.fn(async (): Promise<Record<string, unknown>> => ({ id: 'credential' })), cancel: vi.fn(async () => {}), authReset: vi.fn(async () => {}) };
  const owner = createSettingsSessions({ send, native, current: () => current, changed: () => {} });
  return { owner, native, retire: () => { current = false; } };
}
test('production CLI callback saves normalized path once and reloads once; a read failure only retries GET', async () => {
  let failed = true;
  const send = vi.fn<SettingsRequest>(async (path, method) => {
    if (method === 'PUT') return {};
    if (path === '/api/config/reload') return { success: true };
    if (failed) { failed = false; throw new Error('read failed'); }
    return { opencodeBinary: '/host/opencode' };
  });
  const { owner } = fixture(send);
  await expect(owner.saveCli('  "/host/opencode" ')).rejects.toThrow();
  await owner.saveCli('/new-draft/opencode');
  expect(send.mock.calls.map(([path, method]) => [path, method ?? 'GET'])).toEqual([
    ['/api/config/settings', 'PUT'], ['/api/config/reload', 'POST'], ['/api/config/settings', 'GET'], ['/api/config/settings', 'GET'],
  ]);
  expect(send.mock.calls[0][2]).toEqual({ opencodeBinary: '/host/opencode' });
});
test('unknown reload stays unknown after GET and cannot be certified or replayed', async () => {
  const send = vi.fn<SettingsRequest>(async (path, method) => {
    if (method === 'PUT') return {};
    if (path === '/api/config/reload') throw new Error('lost ACK');
    return { opencodeBinary: '/host/opencode' };
  });
  const { owner } = fixture(send);
  await expect(owner.saveCli('/host/opencode')).rejects.toThrow();
  await expect(owner.saveCli('/other')).rejects.toThrow('cli-reload-unconfirmed');
  expect(send.mock.calls.filter(([, method]) => method === 'POST')).toHaveLength(1);
});
test('real browser selection validates membership, preserves prior on failure and reconciles without a second PUT', async () => {
  let selected = 'one';
  const send = vi.fn<SettingsRequest>(async (_path, method, body) => {
    if (method === 'PUT') { selected = (body as { id: string }).id; throw new Error('lost ACK'); }
    return { providers: [{ id: 'one', name: 'One' }, { id: 'two', name: 'Two' }], selectedId: selected };
  });
  const { owner } = fixture(send); await owner.browsers(); await owner.selectBrowser('fake');
  await expect(owner.selectBrowser('two')).rejects.toThrow();
  expect(owner.snapshot().browsers?.selectedId).toBe('one');
  await owner.selectBrowser('one');
  expect(owner.snapshot().browsers?.selectedId).toBe('two');
  expect(send.mock.calls.filter(([, method]) => method === 'PUT')).toHaveLength(1);
});
test('passkey list is independent of registration capability; exact encoded delete retries only a list', async () => {
  let rows = [{ id: 'key/one', label: 'Phone', createdAt: 1, lastUsedAt: null }];
  const send = vi.fn<SettingsRequest>(async (path, method) => {
    if (method === 'DELETE') { rows = []; throw new Error('lost ACK'); }
    return path === '/auth/passkey/status' ? { enabled: true } : { passkeys: rows };
  });
  const { owner, native } = fixture(send); await owner.passkeys();
  await expect(owner.removePasskey('key/one')).rejects.toThrow();
  await owner.removePasskey('key/one');
  expect(owner.snapshot().passkeys).toEqual([]);
  expect(send.mock.calls.filter(([, method]) => method === 'DELETE')).toEqual([['/api/passkeys/key%2Fone', 'DELETE']]);
  expect(native.register).not.toHaveBeenCalled();
});
test('cancel during native ceremony fences verify and invokes exact system cancellation', async () => {
  const send = vi.fn<SettingsRequest>(async path => path === '/auth/passkey/status' ? { enabled: true } : path === '/api/passkeys' ? { passkeys: [] } : { requestId: 'challenge', optionsJSON: { rp: { id: 'host.example' } } });
  const { owner, native } = fixture(send); await owner.passkeys();
  let release!: (value: Record<string, unknown>) => void;
  let didEnter!: () => void;
  const entered = new Promise<void>(resolve => { didEnter = resolve; });
  native.register.mockImplementation(() => new Promise(resolve => { release = resolve; didEnter(); }));
  const registration = owner.register(); await entered;
  await owner.cancel(); release({ id: 'late' }); await registration;
  expect(native.cancel).toHaveBeenCalledWith('nsh-passkey-1');
  expect(send.mock.calls.some(([path]) => path.endsWith('/verify'))).toBe(false);
});
test('a retained CLI operation cannot borrow a replacement lane after an old write completes', async () => {
  let oldCurrent = true, resolve!: (value: unknown) => void;
  const old = vi.fn<SettingsRequest>(() => new Promise(done => { resolve = done; }));
  const replacement = vi.fn<SettingsRequest>(async (path, method) => method === 'POST' ? { success: true } : { opencodeBinary: '/host/opencode' });
  let lane = { request: old, current: () => oldCurrent };
  const native = { authorizeManagement: async () => {}, register: async () => ({}), cancel: async () => {}, authReset: async () => {} };
  const owner = createSettingsSessions({ send: old, current: () => true, capture: () => lane, native, changed: () => {} });
  const saving = owner.saveCli('/host/opencode');
  oldCurrent = false; lane = { request: replacement, current: () => true }; resolve({});
  await expect(saving).rejects.toThrow('stale');
  expect(replacement).not.toHaveBeenCalled();
  await owner.saveCli('/newer-draft');
  expect(replacement.mock.calls.filter(([, method]) => method === 'PUT')).toHaveLength(0);
  expect(replacement.mock.calls.filter(([, method]) => method === 'POST')).toHaveLength(1);
});
test('registration lost ACK reconciles the exact credential ID and never starts another ceremony', async () => {
  let rows: { id: string; label: string; createdAt: number; lastUsedAt: null }[] = [];
  const send = vi.fn<SettingsRequest>(async path => {
    if (path === '/auth/passkey/status') return { enabled: true };
    if (path === '/api/passkeys') return { passkeys: rows };
    if (path.endsWith('/options')) return { requestId: 'request', optionsJSON: {} };
    rows = [{ id: 'exact-key', label: 'Device', createdAt: 1, lastUsedAt: null }]; throw new Error('lost ACK');
  });
  const { owner, native } = fixture(send);
  native.register.mockResolvedValue({ id: 'exact-key', rawId: 'exact-key', type: 'public-key', response: { clientDataJSON: 'fixture-client', attestationObject: 'fixture-attestation' }, clientExtensionResults: {} });
  await owner.passkeys(); await expect(owner.register()).rejects.toThrow('lost ACK');
  await owner.register();
  expect(owner.snapshot().passkeys?.[0].id).toBe('exact-key');
  expect(native.register).toHaveBeenCalledTimes(1);
  expect(send.mock.calls.filter(([path]) => path.endsWith('/verify'))).toHaveLength(1);
});
test.each([true, false])('auth reset retains ACK/unknown journal and never repeats POST; acknowledged=%s', async acknowledged => {
  const send = vi.fn<SettingsRequest>(async () => { if (!acknowledged) throw new Error('lost ACK'); return { cleared: true, signedOutEverywhere: true }; });
  const { owner, native } = fixture(send);
  native.authReset.mockRejectedValueOnce(new Error('native cleanup'));
  await expect(owner.resetAuth()).rejects.toThrow();
  if (acknowledged) await owner.resetAuth();
  else await expect(owner.resetAuth()).rejects.toThrow('auth-reset-unconfirmed');
  expect(send).toHaveBeenCalledTimes(1);
  expect(native.authReset).toHaveBeenCalledTimes(acknowledged ? 2 : 0);
});
test('cover invalidates a delayed CLI write even when the same operation is current again', async () => {
  let finish!: (value: unknown) => void;
  const send = vi.fn<SettingsRequest>(async (_path, method) => method === 'PUT' ? new Promise(resolve => { finish = resolve; }) : { success: true, opencodeBinary: '/host/opencode' });
  const { owner } = fixture(send);
  const writing = owner.saveCli('/host/opencode'); await owner.invalidate(); finish({});
  await expect(writing).rejects.toThrow('stale');
  expect(send.mock.calls.filter(([, method]) => method === 'POST')).toHaveLength(0);
  await owner.saveCli('/new-draft');
  expect(send.mock.calls.filter(([, method]) => method === 'PUT')).toHaveLength(1);
  expect(send.mock.calls.filter(([, method]) => method === 'POST')).toHaveLength(1);
});
test('paired bearer is not management auth: 401 preserves the list and only explicit Retry invokes native full-session authorization', async () => {
  let authorized = false;
  const send = vi.fn<SettingsRequest>(async path => {
    if (path === '/auth/passkey/status') return { enabled: true };
    if (!authorized) throw Object.assign(new Error('management session required'), { status: 401 });
    return { passkeys: [{ id: 'real-credential-id', label: 'Device', createdAt: 1, lastUsedAt: null }] };
  });
  const { owner, native } = fixture(send);
  native.authorizeManagement.mockImplementation(async () => { authorized = true; });
  await expect(owner.passkeys()).rejects.toMatchObject({ status: 401 });
  expect(owner.snapshot().passkeys).toBeNull(); expect(native.authorizeManagement).not.toHaveBeenCalled();
  await owner.retryPasskeys();
  expect(owner.snapshot().passkeys?.[0].id).toBe('real-credential-id');
  expect(native.authorizeManagement).toHaveBeenCalledTimes(1);
  expect(send.mock.calls.every(([, method]) => !method || method === 'GET')).toBe(true);
});
