import { beforeEach, expect, it, vi } from 'vitest';

const memory = vi.hoisted(() => ({ files: new Map(), failRead: false, writes: 0, failSettingsAt: 0, failRollback: false, blockAuth: false }));
vi.mock('fs', () => ({ default: {
  existsSync: path => memory.files.has(path), mkdirSync: () => undefined, chmodSync: () => undefined,
  readFileSync: path => { if (memory.failRead) throw new Error('synthetic read failure'); if (!memory.files.has(path)) throw new Error('synthetic missing file'); return memory.files.get(path); },
  writeFileSync: (path, value) => { memory.writes++; memory.files.set(path, value); },
  renameSync: (from, to) => {
    if (to.endsWith('/settings.json') && memory.failSettingsAt > 0 && --memory.failSettingsAt === 0) { if (memory.failRollback) memory.blockAuth = true; throw new Error('synthetic settings commit failure'); }
    if (to.endsWith('/github-auth.json') && memory.blockAuth) throw new Error('synthetic rollback failure');
    memory.files.set(to, memory.files.get(from)); memory.files.delete(from);
  },
  unlinkSync: path => { memory.files.delete(path); },
  openSync: (path, mode) => { if (mode !== 'wx') throw new Error('Unexpected synthetic lock'); if (memory.files.has(path)) throw Object.assign(new Error('busy'), { code: 'EEXIST' }); memory.files.set(path, ''); return 1; },
  closeSync: () => undefined,
} }));

beforeEach(() => { vi.resetModules(); vi.stubEnv('YURI_DATA_DIR', '/synthetic/github'); memory.files.clear(); memory.failRead = false; memory.writes = 0; memory.failSettingsAt = 0; memory.failRollback = false; memory.blockAuth = false; });
const oauth = accountId => ({ accountId, accessToken: `synthetic-only-${accountId}`, user: { login: accountId } });

it('atomically admits exact source/id and expected-current; rejects stale selection without mutating another account', async () => {
  const auth = await import('./auth.js');
  auth.setGitHubAuth(oauth('alpha')); auth.setGitHubAuth(oauth('beta'));
  const before = new Map(memory.files);
  expect(() => auth.removeGitHubAuth({ selection: { source: 'oauth', accountId: 'alpha' }, expectedCurrent: { source: 'oauth', accountId: 'alpha' } })).toThrow();
  expect(memory.files).toEqual(before);
  auth.removeGitHubAuth({ selection: { source: 'oauth', accountId: 'alpha' }, expectedCurrent: { source: 'oauth', accountId: 'beta' } });
  expect(auth.getGitHubAuth().accountId).toBe('beta');
  expect(auth.getGitHubAuthAccounts().map(account => account.id)).toEqual(['beta']);
});

it('exact current removal does not silently select another OAuth account or CLI; legacy clear still promotes the next account', async () => {
  const auth = await import('./auth.js');
  auth.setGitHubAuth(oauth('alpha')); auth.setGitHubAuth(oauth('beta'));
  auth.removeGitHubAuth({ selection: { source: 'oauth', accountId: 'beta' }, expectedCurrent: { source: 'oauth', accountId: 'beta' } });
  expect(auth.getGitHubAuth()).toBeNull(); expect(auth.isGitHubAuthDisconnected()).toBe(true);
  expect(auth.getGitHubAuthAccounts()).toMatchObject([{ id: 'alpha', source: 'oauth', current: false }]);
  auth.activateGitHubAuth('alpha'); expect(auth.isGitHubAuthDisconnected()).toBe(false);
  auth.setGitHubAuth(oauth('beta')); expect(auth.clearGitHubAuth()).toBe(true); expect(auth.getGitHubAuth().accountId).toBe('alpha');
});

it('preserves exact source identity on an OAuth/CLI id collision and never deletes CLI credentials', async () => {
  const auth = await import('./auth.js'); auth.setGitHubAuth(oauth('gh-cli')); auth.setGhCliActive(true);
  expect(() => auth.removeGitHubAuth({ selection: { source: 'gh-cli', accountId: 'gh-cli' } })).toThrow('github_cli_managed_externally');
  auth.removeGitHubAuth({ selection: { source: 'oauth', accountId: 'gh-cli' }, expectedCurrent: { source: 'gh-cli', accountId: 'gh-cli' } });
  expect(auth.isGhCliActive()).toBe(true); expect(auth.getGitHubAuthAccounts()).toEqual([]);
});

it('new OAuth and explicit activation clear CLI ownership and explicit disconnected state', async () => {
  const auth = await import('./auth.js'); auth.setGitHubAuth(oauth('alpha')); auth.setGhCliActive(true);
  auth.setGitHubAuth(oauth('beta')); expect(auth.isGhCliActive()).toBe(false); expect(auth.getGitHubAuth().accountId).toBe('beta');
  auth.removeGitHubAuth({ selection: { source: 'oauth', accountId: 'beta' } }); auth.setGhCliActive(true);
  expect(auth.isGitHubAuthDisconnected()).toBe(false); expect(auth.isGhCliActive()).toBe(true);
});

it('fails closed on invalid selectors, corrupt reads and cross-writer admission contention', async () => {
  const auth = await import('./auth.js'); auth.setGitHubAuth(oauth('alpha'));
  for (const input of [{}, { selection: { source: 'oauth', id: 'alpha' } }, { selection: { source: 'oauth', accountId: 'alpha' }, ignored: true }, { selection: { source: 'oauth', accountId: 'missing' } }]) {
    const before = new Map(memory.files); expect(() => auth.removeGitHubAuth(input)).toThrow(); expect(memory.files).toEqual(before);
  }
  memory.failRead = true; expect(() => auth.removeGitHubAuth({ selection: { source: 'oauth', accountId: 'alpha' } })).toThrow('github_auth_storage_failed'); memory.failRead = false;
  memory.files.set('/synthetic/github/.github-auth.lock', 'synthetic-lock');
  for (const work of [() => auth.removeGitHubAuth({ selection: { source: 'oauth', accountId: 'alpha' } }), () => auth.activateGitHubAuth('alpha'), () => auth.setGitHubAuth(oauth('beta')), () => auth.setGhCliActive(true), () => auth.setGhCliDisabled(true)]) expect(work).toThrow('github_auth_busy');
  expect(() => auth.getGitHubAuth()).toThrow('github_auth_busy');
  memory.files.delete('/synthetic/github/.github-auth.lock');
  expect(auth.getGitHubAuth().accountId).toBe('alpha');
});

it('migrates legacy array/single-entry auth on mutation and keeps selection authoritative in the same auth file', async () => {
  const auth = await import('./auth.js');
  memory.files.set('/synthetic/github/github-auth.json', JSON.stringify({ ...oauth('alpha'), current: true }));
  expect(auth.getGitHubAuth().accountId).toBe('alpha');
  memory.files.set('/synthetic/github/github-auth.json', JSON.stringify([{ ...oauth('alpha'), current: true }, { ...oauth('beta'), current: false }]));
  auth.setGitHubAuth(oauth('beta'));
  expect(JSON.parse(memory.files.get('/synthetic/github/github-auth.json'))).toMatchObject({ version: 2, selection: { source: 'oauth', accountId: 'beta' } });
  memory.files.set('/synthetic/github/settings.json', JSON.stringify({ ghCliActive: true }));
  expect(auth.isGhCliActive()).toBe(false); expect(auth.getGitHubAuthContext().selection).toEqual({ source: 'oauth', accountId: 'beta' });
  auth.removeGitHubAuth({ selection: { source: 'oauth', accountId: 'beta' } });
  memory.files.set('/synthetic/github/settings.json', JSON.stringify({ ghCliActive: true }));
  expect(auth.getGitHubAuth()).toBeNull(); expect(auth.isGitHubAuthDisconnected()).toBe(true); expect(auth.getGitHubAuthAccounts().every(account => !account.current)).toBe(true);
});

it('rolls back ordinary mirror-write failure, but retains admission lock if rollback itself is uncertain', async () => {
  const auth = await import('./auth.js'); auth.setGitHubAuth(oauth('alpha')); auth.setGhCliActive(true);
  memory.failSettingsAt = 1;
  expect(() => auth.setGitHubAuth(oauth('beta'))).toThrow('github_auth_storage_failed');
  expect(auth.getGitHubAuthContext().selection).toEqual({ source: 'gh-cli', accountId: 'gh-cli' });
  expect(auth.getGitHubAuthAccounts().map(account => account.id)).toEqual(['alpha']);
  memory.failSettingsAt = 1; memory.failRollback = true;
  expect(() => auth.setGitHubAuth(oauth('beta'))).toThrow('github_auth_storage_uncertain');
  expect(() => auth.getGitHubAuth()).toThrow('github_auth_busy');
  expect(() => auth.activateGitHubAuth('alpha')).toThrow('github_auth_busy');
});

it('never derives a newly saved account id from a token prefix', async () => {
  const auth = await import('./auth.js');
  expect(() => auth.setGitHubAuth({ accessToken: 'synthetic-only-no-identity' })).toThrow('github_account_identity_required');
  expect(memory.writes).toBe(0);
});
