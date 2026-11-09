import { afterEach, expect, it, vi } from 'vitest';
import { createDesktopHeaderGitHubSource, desktopHeaderGitHubAvatar } from './desktop-header-github-core';
import { createSettingsGitHub, type GitHubStatusSnapshot } from './settings-github-core';
import { gitHubAccountKey } from './settings-github-protocol';

afterEach(() => vi.useRealTimers());
const host = { hostID: 'synthetic', lease: 'lease' };
const user = (login: string) => ({ login, name: login === 'a' ? ' Name A ' : '', avatarUrl: 'https://avatars.githubusercontent.com/u/123?v=4', email: 'not-in-header', token: 'never-retain' });
const account = (id: string, source: 'oauth' | 'gh-cli' = 'oauth', current = false) => ({ id, source, current, user: user(id) });
const status = (selected = 'a') => ({ connected: true, user: user(selected), accounts: [account('a', 'oauth', selected === 'a'), account('b', 'gh-cli', selected === 'b')], token: 'never-retain' });
const key = (id: string, source: 'oauth' | 'gh-cli' = 'oauth') => gitHubAccountKey({ id, source });
function fixture(initial: unknown = status()) {
  let data = initial, active = true, interactive = true, authority = true, opCurrent = true;
  const changed = vi.fn(), request = vi.fn(async (path: string, method?: string, body?: unknown): Promise<unknown> => {
    if (path === '/api/github/auth/status' && method === 'GET') return data;
    if (path === '/api/github/auth/activate' && method === 'POST') { data = status((body as { accountId: string }).accountId); return data; }
    throw new Error('Unexpected wire');
  });
  let operation = { scope: host, current: () => opCurrent, request };
  const source = createDesktopHeaderGitHubSource({ scope: { host, directory: '/fixture', authorityKey: 'authority' }, current: () => authority, operation: () => operation, changed });
  const guard = { current: () => true, active: () => active, interactive: () => interactive, directory: () => '/fixture' }, port = source.header(guard);
  return { source, port, guard, request, changed, data: (value: unknown) => { data = value; }, active: (value: boolean) => { active = value; }, interactive: (value: boolean) => { interactive = value; }, authority: (value: boolean) => { authority = value; }, opCurrent: (value: boolean) => { opCurrent = value; }, newOperation: () => { opCurrent = true; operation = { ...operation }; } };
}
it('Web contract: unknown or disconnected has no Header control; connected zero/single account is avatar-only data', async () => {
  const f = fixture({ connected: false, accounts: [] }); expect(f.port.visible()).toBe(false); expect(f.request).not.toHaveBeenCalled();
  await f.port.ensure(); expect(f.port.visible()).toBe(false);
  f.data({ connected: true, accounts: [], user: user('a') }); await f.port.refresh(); expect(f.port.visible()).toBe(true); expect(f.port.state().projection?.accounts).toEqual([]);
  expect(f.port.state().projection?.login).toBe('a');
  f.data({ connected: true, user: user('a') }); await f.port.refresh(); expect(f.port.visible()).toBe(true); expect(f.port.state().projection?.accounts).toEqual([]);
});
it('one shared known source coalesces demand; fifty inputs/ensure/read projections neither enumerate accounts nor fetch or set timers', async () => {
  vi.useFakeTimers(); let enumerations = 0;
  const data = status(); data.accounts = new Proxy(data.accounts, { get(target, property, receiver) { if (property === 'map') enumerations++; return Reflect.get(target, property, receiver); } });
  const f = fixture(data); f.active(false);
  for (let index = 0; index < 50; index++) await f.port.ensure(); expect(f.request).not.toHaveBeenCalled();
  f.active(true); await Promise.all([f.port.ensure(), f.port.ensure()]); expect(f.request).toHaveBeenCalledTimes(1);
  const before = enumerations, snapshot = f.port.state();
  for (let index = 0; index < 50; index++) { await f.port.ensure(); f.port.state(); f.port.visible(); f.port.available(); }
  expect(f.port.state()).toBe(snapshot); expect(enumerations).toBe(before); expect(f.request).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  expect(snapshot.projection?.accounts.map(account => [account.label, account.login, account.source, account.current])).toEqual([['Name A', 'a', 'oauth', true], ['b', 'b', 'gh-cli', false]]);
  expect(JSON.stringify(snapshot)).not.toMatch(/never-retain|not-in-header|email|token/);
});
it('shared status/selection uses the original Settings pure controller and exact wire; no parallel status or OAuth engine', async () => {
  const f = fixture(); await f.port.ensure();
  const registration = f.source.settings(f.guard, async () => false);
  const controller = createSettingsGitHub(registration.dependencies);
  await controller.setActive(true); expect(f.request.mock.calls.map(call => call[0])).toEqual(['/api/github/auth/status', '/api/github/auth/status']);
  expect(controller.state().status?.accounts).toHaveLength(2);
  await controller.activate(controller.state().status!.accounts[1]);
  expect(f.request.mock.calls.filter(call => call[1] === 'POST')).toEqual([['/api/github/auth/activate', 'POST', { accountId: 'b' }]]);
  expect(f.port.state().projection?.login).toBe('b'); expect(controller.state().status?.user?.login).toBe('b');
  const count = f.request.mock.calls.length; await f.port.ensure(); expect(f.request).toHaveBeenCalledTimes(count);
  expect(() => f.source.settings(f.guard, async () => false)).toThrow('already_registered');
  await controller.setActive(false); controller.dispose(); expect(registration.dispose()).toBe(true);
});
it('select is real POST with ACK, current account is noop; ambiguous source IDs and reserved OAuth CLI IDs never write', async () => {
  const f = fixture(); await f.port.ensure(); expect(await f.port.select(key('a'))).toEqual({ status: 'noop' });
  expect(await f.port.select(key('b', 'gh-cli'))).toEqual({ status: 'accepted' }); expect(f.port.state().projection?.login).toBe('b');
  for (const accounts of [[account('same'), account('same', 'gh-cli')], [account('gh-cli'), account('a', 'oauth', true)]]) {
    const g = fixture({ connected: true, accounts }); await g.port.ensure(); expect(await g.port.select(gitHubAccountKey(accounts[0]))).toEqual({ status: 'identity' }); expect(g.request).toHaveBeenCalledTimes(1);
  }
});
it('shared adapter preserves the original Settings ability to activate a stored account while disconnected; Header remains absent until ACK', async () => {
  const f = fixture({ connected: false, accounts: [account('a'), account('b', 'gh-cli')] }); await f.port.ensure();
  expect(f.port.visible()).toBe(false); expect(f.port.available()).toBe(false);
  const registration = f.source.settings(f.guard, async () => false), controller = createSettingsGitHub(registration.dependencies);
  await controller.setActive(true); await controller.activate(controller.state().status!.accounts[1]);
  expect(f.port.visible()).toBe(true); expect(f.port.state().projection?.login).toBe('b');
  controller.dispose(); expect(registration.dispose()).toBe(true);
});
it('Settings demand during an issued Header selection waits for that exact lane, then reads the same authoritative result without a parallel cache', async () => {
  const f = fixture(); await f.port.ensure(); let resolve!: (value: unknown) => void;
  f.request.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const selecting = f.port.select(key('b', 'gh-cli'));
  const registration = f.source.settings(f.guard, async () => false), controller = createSettingsGitHub(registration.dependencies);
  const opening = controller.setActive(true); expect(f.request).toHaveBeenCalledTimes(2);
  f.data(status('b')); resolve(status('b')); await selecting; await opening;
  expect(f.port.state().projection?.login).toBe('b'); expect(controller.state().status?.user?.login).toBe('b'); expect(f.request).toHaveBeenCalledTimes(3);
  controller.dispose(); expect(registration.dispose()).toBe(true);
});
it('a coalesced Header GET revoked by a modal hands off once to the actual active Settings operation, not a poll', async () => {
  const f = fixture(); let resolve!: (value: unknown) => void;
  f.request.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const initial = f.port.ensure(); const registration = f.source.settings({ ...f.guard, active: () => true }, async () => false);
  const controller = createSettingsGitHub(registration.dependencies), opening = controller.setActive(true);
  f.active(false); resolve(status()); expect(await initial).toEqual({ status: 'stale' }); await opening;
  expect(controller.state().status?.user?.login).toBe('a'); expect(f.request).toHaveBeenCalledTimes(2);
  controller.dispose(); expect(registration.dispose()).toBe(true);
});
it.each(['reject', 'malformed', 'wrong-ack'])('selection %s retains prior, blocks blind retry and only exact authoritative current resolves unknown', async kind => {
  const f = fixture(); await f.port.ensure();
  f.request.mockImplementationOnce(async () => { if (kind === 'reject') throw new Error('secret error'); return kind === 'malformed' ? {} : status('a'); });
  expect(await f.port.select(key('b', 'gh-cli'))).toEqual({ status: 'unknown' }); expect(f.port.state().projection?.login).toBe('a');
  const count = f.request.mock.calls.length; expect(await f.port.select(key('b', 'gh-cli'))).toEqual({ status: 'unavailable' }); expect(f.request).toHaveBeenCalledTimes(count);
  await f.port.refresh(); expect(f.port.state().pending).toBe(key('b', 'gh-cli')); expect(f.source.dispose()).toBe(false);
  f.data(status('b')); await f.port.refresh(); expect(f.port.state().pending).toBeNull(); expect(f.port.state().projection?.login).toBe('b');
  expect(f.request.mock.calls.filter(call => call[1] === 'POST')).toHaveLength(1);
});
it('read failures/malformed status retain prior, do not fabricate connected, and malformed sibling accounts are not silently trimmed', async () => {
  const f = fixture(); await f.port.ensure(); const prior = f.port.state().projection;
  for (const value of [{ connected: true, accounts: [{}] }, { connected: true, accounts: [account('a', 'oauth', true), account('b', 'gh-cli', true)] }, { connected: true, accounts: Array.from({ length: 201 }, (_, index) => account(String(index))) }]) {
    f.data(value); expect(await f.port.refresh()).toEqual({ status: 'failed' }); expect(f.port.state().projection).toBe(prior); expect(f.port.available()).toBe(false);
  }
  const empty = fixture({}); await empty.port.ensure(); expect(empty.port.visible()).toBe(false);
});
it('owner gates modal/inactive, retains prior and rejects late read/Host authority; wrong lease does no IO', async () => {
  const f = fixture(); await f.port.ensure(); const prior = f.port.state().projection;
  f.interactive(false); expect(await f.port.select(key('b', 'gh-cli'))).toEqual({ status: 'unavailable' }); expect(f.port.state().projection).toBe(prior);
  f.active(false); expect(await f.port.refresh()).toEqual({ status: 'unavailable' }); f.active(true); f.interactive(true);
  let resolve!: (value: unknown) => void; f.request.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const read = f.port.refresh(); f.active(false); resolve(status('b')); expect(await read).toEqual({ status: 'stale' }); expect(f.port.state().projection).toBe(prior);
  f.authority(false); expect(f.port.visible()).toBe(false); f.authority(true); expect(f.port.visible()).toBe(false);
  const g = fixture(); const wrong = g.source.header({ ...g.guard, operation: () => ({ scope: { ...host, lease: 'wrong' }, current: () => true, request: g.request }) });
  expect(await wrong.ensure()).toEqual({ status: 'unavailable' }); expect(g.request).not.toHaveBeenCalled();
  const otherDirectory = g.source.header({ ...g.guard, directory: () => '/other' });
  expect(await otherDirectory.ensure()).toEqual({ status: 'unavailable' }); expect(otherDirectory.visible()).toBe(false); expect(g.request).not.toHaveBeenCalled();
});
it('late selection ACK through a retired PageOperation is unknown, not an optimistic success; new same-Host lane only reconciles GET', async () => {
  const f = fixture(); await f.port.ensure(); let resolve!: (value: unknown) => void;
  f.request.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const selecting = f.port.select(key('b', 'gh-cli')); f.opCurrent(false); resolve(status('b')); expect(await selecting).toEqual({ status: 'unknown' }); expect(f.port.state().projection?.login).toBe('a');
  f.newOperation(); f.data(status('b')); await f.port.refresh(); expect(f.port.state().projection?.login).toBe('b'); expect(f.request.mock.calls.filter(call => call[1] === 'POST')).toHaveLength(1);
});
it('actual owner destruction revokes late callbacks without pretending an in-flight write is settled', async () => {
  const f = fixture(); await f.port.ensure(); let resolve!: (value: unknown) => void;
  f.request.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const selecting = f.port.select(key('b', 'gh-cli')); expect(f.source.dispose()).toBe(false);
  const notifications = f.changed.mock.calls.length; f.source.retire(); resolve(status('b')); await selecting;
  expect(f.changed).toHaveBeenCalledTimes(notifications); expect(f.port.visible()).toBe(false); expect(f.port.state().pending).toBe(key('b', 'gh-cli')); expect(f.source.dispose()).toBe(false);
});
it('Settings OAuth forwarding stays in its original engine and cancellation is not blocked behind an in-flight complete', async () => {
  const f = fixture(); await f.port.ensure(); const registration = f.source.settings(f.guard, async () => false);
  let resolve!: (value: unknown) => void;
  f.request.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const completing = registration.dependencies.request('/api/github/auth/complete', 'POST', { deviceCode: 'synthetic-code' });
  f.request.mockResolvedValueOnce({ cancelled: true, status: 'cancelled', providerRevoked: false }); f.active(false); f.interactive(false);
  await registration.dependencies.request('/api/github/auth/cancel', 'POST', { deviceCode: 'synthetic-code' });
  resolve({ connected: false, status: 'authorization_pending' }); await completing;
  expect(f.request.mock.calls.slice(-2)).toEqual([['/api/github/auth/complete', 'POST', { deviceCode: 'synthetic-code' }], ['/api/github/auth/cancel', 'POST', { deviceCode: 'synthetic-code' }]]);
  expect(JSON.stringify(f.source.state())).not.toContain('synthetic-code'); expect(registration.dispose()).toBe(true);
});
it('original Settings device flow exclusively locks Header writes, with no second OAuth lease/timer owner', async () => {
  vi.useFakeTimers();
  const f = fixture(); await f.port.ensure(); expect(vi.getTimerCount()).toBe(0);
  const registration = f.source.settings(f.guard, async () => true), controller = createSettingsGitHub(registration.dependencies);
  await controller.setActive(true);
  f.request.mockResolvedValueOnce({ deviceCode: 'synthetic-code', userCode: 'code', verificationUri: 'https://github.com/login/device', expiresIn: 600, interval: 5, cancellable: true });
  await controller.connect(); expect(controller.state().flow).not.toBeNull(); expect(f.port.available()).toBe(false); expect(registration.dispose()).toBe(false);
  expect(await f.port.select(key('b', 'gh-cli'))).toEqual({ status: 'unavailable' });
  f.request.mockResolvedValueOnce({ cancelled: true, status: 'cancelled', providerRevoked: false }); await controller.cancel();
  expect(vi.getTimerCount()).toBe(0); expect(controller.state().flow).toBeNull();
  await f.port.ensure(); expect(f.port.available()).toBe(true); controller.dispose(); expect(registration.dispose()).toBe(true);
  expect(f.request.mock.calls.filter(call => call[0] === '/api/github/auth/start')).toHaveLength(1);
});
it.each([true, false])('Settings negative receipt codes are preserved when supplied, never guessed when PageOperation drops them (%s)', async typed => {
  const data = { ...status(), capabilities: { exactAccountRemoval: true, deviceFlowCancellation: true } };
  const f = fixture(data); await f.port.ensure();
  f.request.mockImplementation(async (path, method) => {
    if (path === '/api/github/auth/status') return data;
    if (path === '/api/github/auth' && method === 'DELETE') throw Object.assign(new Error('Rejected'), typed ? { code: 'github_account_changed', status: 409 } : { status: 409 });
    throw new Error('Unexpected wire');
  });
  const registration = f.source.settings(f.guard, async () => false), controller = createSettingsGitHub(registration.dependencies);
  await controller.setActive(true); controller.requestRemoval(controller.state().status!.accounts[0]); await controller.confirmRemoval();
  expect(controller.state().issue).toBe(typed ? 'identity' : 'unknown'); expect(controller.state().pending === null).toBe(typed);
  expect(f.request.mock.calls.filter(call => call[1] === 'DELETE')).toHaveLength(1); expect(f.port.available()).toBe(typed);
  expect(registration.dispose()).toBe(typed); controller.dispose();
});
it('avatars use the original public allowlist; credentials, alternate origins, auth query, data and file URLs are refused', () => {
  expect(desktopHeaderGitHubAvatar('https://avatars.githubusercontent.com/u/123?v=4&s=48')).toContain('/u/123');
  for (const url of ['https://avatars.githubusercontent.com/u/123?token=secret', 'https://user:secret@avatars.githubusercontent.com/u/123', 'https://evil.example/u/123', '/api/avatar?token=secret', 'data:image/png;base64,a', 'file:///private/avatar', 'http://avatars.githubusercontent.com/u/123']) expect(desktopHeaderGitHubAvatar(url)).toBeUndefined();
});
it('Header ACK seeds the original Settings controller before its first GET; failed first read retains current + stale, never empty success', async () => {
  const f = fixture(); await f.port.ensure(); await f.port.select(key('b', 'gh-cli'));
  const reads = f.request.mock.calls.length, registration = f.source.settings(f.guard, async () => false);
  const controller = createSettingsGitHub(registration.dependencies);
  expect(f.request).toHaveBeenCalledTimes(reads); expect(controller.state().status?.user?.login).toBe('b');
  expect(JSON.stringify(controller.state().status)).not.toContain('never-retain');
  f.request.mockRejectedValueOnce(new Error('Synthetic GET failure')); await controller.setActive(true);
  expect(controller.state()).toMatchObject({ stale: true, issue: 'read', pending: null, reconciled: false });
  expect(controller.state().status?.accounts.find(account => account.current)?.id).toBe('b');
  const count = f.request.mock.calls.length; await controller.activate(controller.state().status!.accounts[0]); await controller.connect();
  expect(f.request).toHaveBeenCalledTimes(count);
  await controller.refresh(); expect(controller.state().stale).toBe(false); expect(controller.state().issue).toBeNull();
  await controller.activate(controller.state().status!.accounts[0]); expect(f.port.state().projection?.login).toBe('a');
  controller.dispose(); expect(registration.dispose()).toBe(true);
});
it('status subscription changes display only: OAuth lease/timers, cleanup lock and the original flow remain untouched', async () => {
  vi.useFakeTimers(); const f = fixture(); await f.port.ensure();
  const registration = f.source.settings(f.guard, async () => true), controller = createSettingsGitHub(registration.dependencies);
  await controller.setActive(true);
  f.request.mockResolvedValueOnce({ deviceCode: 'synthetic-code', userCode: 'code', verificationUri: 'https://github.com/login/device', expiresIn: 600, interval: 5, cancellable: true });
  await controller.connect(); const before = controller.state(), timers = vi.getTimerCount();
  f.data(status('b')); await f.port.refresh();
  expect(controller.state().status?.user?.login).toBe('b'); expect(controller.state().flow).toBe(before.flow);
  expect(controller.state()).toMatchObject({ pending: before.pending, cancellation: before.cancellation, needsReadback: before.needsReadback, reconciled: before.reconciled });
  expect(vi.getTimerCount()).toBe(timers); expect(registration.dispose()).toBe(false); expect(f.port.available()).toBe(false);
  f.request.mockResolvedValueOnce({ cancelled: true, status: 'cancelled', providerRevoked: false }); await controller.cancel();
  controller.dispose(); expect(registration.dispose()).toBe(true); expect(vi.getTimerCount()).toBe(0);
});
it('unknown Settings activation survives temporary closure and shared adoption; only its successful existing GET reconciles', async () => {
  const f = fixture(); await f.port.ensure();
  const registration = f.source.settings(f.guard, async () => false), controller = createSettingsGitHub(registration.dependencies);
  await controller.setActive(true); f.request.mockRejectedValueOnce(new Error('Lost activate receipt'));
  await controller.activate(controller.state().status!.accounts[1]); const pending = controller.state().pending;
  await controller.setActive(false); expect(registration.dispose()).toBe(false);
  f.data(status('b')); await f.port.refresh();
  expect(controller.state().status?.user?.login).toBe('b'); expect(controller.state().pending).toBe(pending);
  expect(controller.state()).toMatchObject({ issue: 'unknown', reconciled: false }); expect(registration.dispose()).toBe(false);
  f.request.mockRejectedValueOnce(new Error('Read failed after display adoption')); await controller.setActive(true); controller.acknowledgeUnknown();
  expect(controller.state().pending).toBe(pending); expect(controller.state()).toMatchObject({ stale: true, issue: 'unknown', reconciled: false });
  await controller.refresh(); expect(controller.state().pending).toBeNull(); expect(controller.state().stale).toBe(false);
  expect(f.request.mock.calls.filter(call => call[1] === 'POST')).toHaveLength(1);
  controller.dispose(); expect(registration.dispose()).toBe(true);
});
it('failed GET with source unknown cannot return the prior as a successful Settings read or enable unknown acknowledgement', async () => {
  const f = fixture(); await f.port.ensure();
  const registration = f.source.settings(f.guard, async () => false), controller = createSettingsGitHub(registration.dependencies);
  await controller.setActive(true); f.request.mockRejectedValueOnce(new Error('Lost activate receipt'));
  await controller.activate(controller.state().status!.accounts[1]); const pending = controller.state().pending;
  f.request.mockRejectedValueOnce(new Error('Failed read')); await controller.refresh();
  expect(controller.state()).toMatchObject({ stale: true, issue: 'unknown', reconciled: false }); controller.acknowledgeUnknown();
  expect(controller.state().pending).toBe(pending); expect(registration.dispose()).toBe(false);
  f.data(status('b')); await controller.refresh(); controller.dispose(); expect(registration.dispose()).toBe(true);
});
it('shared status port gates current, directory, registration and retire; failed/busy states never broadcast status', async () => {
  const f = fixture(); await f.port.ensure(); let current = true, directory = '/fixture';
  const registration = f.source.settings({ ...f.guard, current: () => current, directory: () => directory }, async () => false);
  const shared = registration.dependencies.sharedStatus!, listener = vi.fn(), unsubscribe = shared.subscribe(listener);
  expect(shared.snapshot()?.status?.user?.login).toBe('a'); expect(listener).not.toHaveBeenCalled();
  f.request.mockRejectedValueOnce(new Error('Failed read')); await f.port.refresh(); expect(listener).not.toHaveBeenCalled(); expect(shared.snapshot()?.stale).toBe(true);
  current = false; expect(shared.snapshot()).toBeNull(); f.data(status('b')); await f.port.refresh(); expect(listener).not.toHaveBeenCalled();
  current = true; directory = '/other'; expect(shared.snapshot()).toBeNull(); await f.port.refresh(); expect(listener).not.toHaveBeenCalled();
  directory = '/fixture'; await f.port.refresh(); expect(listener).toHaveBeenCalledTimes(1);
  unsubscribe(); await f.port.refresh(); expect(listener).toHaveBeenCalledTimes(1);
  shared.subscribe(listener); expect(registration.dispose()).toBe(true); expect(shared.snapshot()).toBeNull(); await f.port.refresh(); expect(listener).toHaveBeenCalledTimes(1);
  const next = f.source.settings(f.guard, async () => false); next.dependencies.sharedStatus!.subscribe(listener); f.source.retire();
  expect(next.dependencies.sharedStatus!.snapshot()).toBeNull(); expect(listener).toHaveBeenCalledTimes(1);
});
it('fifty unrelated reads with a mounted subscribed controller perform zero projection/notification/I/O/timer work; disposal removes observation', async () => {
  vi.useFakeTimers(); const f = fixture(); await f.port.ensure(); const listener = vi.fn();
  const registration = f.source.settings(f.guard, async () => false), shared = registration.dependencies.sharedStatus!;
  const subscribe = vi.fn(shared.subscribe), unsubscribed = vi.fn();
  const controller = createSettingsGitHub({ ...registration.dependencies, sharedStatus: { ...shared, subscribe(callback) { const off = subscribe(callback); return () => { unsubscribed(); off(); }; } }, changed(next) { listener(next); registration.dependencies.changed?.(next); } });
  await controller.setActive(true); const state = controller.state(), projection = f.port.state().projection, commits = f.changed.mock.calls.length, changes = listener.mock.calls.length, requests = f.request.mock.calls.length;
  for (let i = 0; i < 50; i++) { controller.state(); f.port.state(); f.port.available(); await f.port.ensure(); }
  expect(controller.state()).toBe(state); expect(f.port.state().projection).toBe(projection); expect(f.changed).toHaveBeenCalledTimes(commits);
  expect(listener).toHaveBeenCalledTimes(changes); expect(f.request).toHaveBeenCalledTimes(requests); expect(subscribe).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  controller.dispose(); expect(unsubscribed).toHaveBeenCalledTimes(1); const disposed = controller.state(); f.data(status('b')); await f.port.refresh(); expect(controller.state()).toBe(disposed);
  expect(registration.dispose()).toBe(true);
});
it('lane replacement unsubscribes the old status observation and disposed callbacks cannot update the retained controller', () => {
  const request = vi.fn(), changed = vi.fn(), off = vi.fn(); let oldReceive!: (value: GitHubStatusSnapshot) => void, nextReceive!: (value: GitHubStatusSnapshot) => void;
  const dependencies = { current: () => true, request, open: async () => false, changed };
  const controller = createSettingsGitHub({ ...dependencies, sharedStatus: { snapshot: () => ({ status: status(), stale: false }), subscribe(receive) { oldReceive = receive; return off; } } });
  expect(changed).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
  controller.replaceLane({ ...dependencies, sharedStatus: { snapshot: () => ({ status: status('b'), stale: true }), subscribe(receive) { nextReceive = receive; return off; } } });
  expect(off).toHaveBeenCalledTimes(1); const next = controller.state(); oldReceive({ status: status(), stale: false });
  expect(controller.state()).toBe(next); expect(controller.state().stale).toBe(true); expect(controller.state().status?.user?.login).toBe('b');
  controller.dispose(); const disposed = controller.state(); nextReceive({ status: status(), stale: false });
  expect(off).toHaveBeenCalledTimes(2); expect(controller.state()).toBe(disposed); expect(request).not.toHaveBeenCalled();
});
