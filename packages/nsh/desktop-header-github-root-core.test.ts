import { afterEach, expect, it, vi } from 'vitest';
import { createDesktopHeaderGitHubRootController } from './desktop-header-github-root-core';
import { createSettingsGitHub } from './settings-github-core';
import { gitHubAccountKey } from './settings-github-protocol';

afterEach(() => vi.useRealTimers());
const host = { hostID: 'synthetic', lease: 'lease' };
const status = (id = 'a') => ({ connected: true, user: { login: id }, accounts: ['a', 'b'].map(value => ({ id: value, source: 'oauth', current: value === id, user: { login: value } })) });
const key = (id: string) => gitHubAccountKey({ id, source: 'oauth' });
function fixture() {
  let directory = '/a', lease = host.lease, modal = false, data: unknown = status();
  const request = vi.fn(async (path: string, method?: string, body?: unknown): Promise<unknown> => {
    if (path === '/api/github/auth/status') return data;
    if (path === '/api/github/auth/activate') return data = status((body as { accountId: string }).accountId);
    throw new Error('unexpected synthetic wire');
  });
  const headerOperation = { scope: host, current: () => !modal, request };
  const settingsOperation = { scope: host, current: () => true, request };
  const root = createDesktopHeaderGitHubRootController({ committed: () => ({ host: { ...host, lease }, authorityKey: 'actual-origin-and-auth', directory }),
    current: () => true, operation: () => headerOperation, active: () => !modal, interactive: () => !modal,
  });
  const guard = { current: () => true, active: () => true, interactive: () => true, operation: () => settingsOperation, directory: () => directory };
  return { root, request, guard, data: (value: unknown) => { data = value; }, modal: (value: boolean) => { modal = value; }, directory: (value: string) => { directory = value; }, lease: (value: string) => { lease = value; } };
}
it('root is lazy; one stable Header port survives fifty unrelated reads without another status read', async () => {
  const f = fixture(); expect(f.request).not.toHaveBeenCalled(); expect(f.root.header.visible()).toBe(false);
  await f.root.header.ensure(); const prior = f.root.state();
  for (let i = 0; i < 50; i++) { await f.root.header.ensure(); f.root.header.visible(); f.root.header.available(); f.root.canClose(); }
  expect(f.request).toHaveBeenCalledTimes(1); expect(f.root.state()).toBe(prior); expect(f.root.dispose()).toBe(true);
});
it('real Settings controller gets its own operation while Header is revoked, exact account change updates the shared Header', async () => {
  const f = fixture(); await f.root.header.ensure(); f.modal(true);
  const bridge = f.root.settings(f.guard, async () => false)!; expect(bridge).not.toBeNull();
  const controller = createSettingsGitHub(bridge.dependencies); await controller.setActive(true);
  expect(controller.state().status?.user?.login).toBe('a'); expect(f.root.header.available()).toBe(false);
  await controller.activate(controller.state().status!.accounts[1]);
  expect(f.root.state().projection?.login).toBe('b'); expect(controller.state().status?.user?.login).toBe('b');
  expect(f.request.mock.calls.filter(call => call[1] === 'POST')).toEqual([['/api/github/auth/activate', 'POST', { accountId: 'b' }]]);
  controller.dispose(); expect(bridge.detach()).toBe(true); expect(f.root.dispose()).toBe(true);
});
it('unknown activation cannot be laundered by directory/lease changes, disposal or a second Settings registration', async () => {
  const f = fixture(); await f.root.header.ensure(); f.request.mockRejectedValueOnce(new Error('lost receipt'));
  expect(await f.root.header.select(key('b'))).toEqual({ status: 'unknown' }); const prior = f.root.state();
  expect(f.root.canClose()).toBe(false); expect(f.root.dispose()).toBe(false);
  f.directory('/b'); expect(f.root.reconcile()).toBe(false); expect(f.root.header.visible()).toBe(false); expect(f.root.settings(f.guard, async () => false)).toBeNull();
  expect(await f.root.header.ensure()).toEqual({ status: 'unavailable' }); expect(f.root.state()).toBe(prior); expect(f.request).toHaveBeenCalledTimes(2);
  f.lease('replacement'); expect(f.root.reconcile()).toBe(false); f.lease('lease'); f.directory('/a');
  f.data(status('b')); await f.root.header.refresh(); expect(f.root.canClose()).toBe(true); expect(f.root.state().pending).toBeNull();
  f.directory('/b'); expect(f.root.reconcile()).toBe(true); await f.root.header.ensure(); expect(f.root.header.visible()).toBe(true);
  expect(f.request.mock.calls.filter(call => call[1] === 'POST')).toHaveLength(1);
});
it('a mounted idle Settings page is never rebuilt at a new directory; release is explicit and false cleanup retains the orphan lock', async () => {
  const f = fixture(); await f.root.header.ensure(); const bridge = f.root.settings(f.guard, async () => false)!;
  const controller = createSettingsGitHub(bridge.dependencies); await controller.setActive(true);
  expect(f.root.settings(f.guard, async () => false)).toBeNull(); f.directory('/b'); expect(f.root.reconcile()).toBe(false); f.directory('/a');
  f.request.mockRejectedValueOnce(new Error('unknown activation')); await controller.activate(controller.state().status!.accounts[1]);
  expect(bridge.canRelease()).toBe(false); expect(bridge.release()).toBe(false); expect(bridge.detach()).toBe(false);
  controller.dispose(); expect(f.root.canClose()).toBe(false); f.directory('/b'); expect(f.root.reconcile()).toBe(false); expect(f.root.dispose()).toBe(false);
});
it('original OAuth flow and cancellation unknown remain a single retained owner and block close/navigation', async () => {
  vi.useFakeTimers(); const f = fixture(); await f.root.header.ensure();
  const bridge = f.root.settings(f.guard, async () => false)!, controller = createSettingsGitHub(bridge.dependencies);
  await controller.setActive(true);
  f.request.mockImplementationOnce(async () => ({ deviceCode: 'synthetic-only', userCode: 'FAKE', verificationUri: 'https://github.com/login/device', expiresIn: 600, interval: 1, cancellable: true }));
  await controller.connect(); expect(controller.state().flow?.userCode).toBe('FAKE'); expect(f.root.canClose()).toBe(false); expect(vi.getTimerCount()).toBe(2);
  f.request.mockRejectedValueOnce(new Error('unknown cancellation')); await controller.cancel();
  expect(controller.state().cancellation).toBe('unknown'); expect(controller.state().pending?.kind).toBe('connect');
  f.directory('/b'); expect(f.root.reconcile()).toBe(false); expect(bridge.detach()).toBe(false); expect(f.root.dispose()).toBe(false); expect(vi.getTimerCount()).toBe(0);
  controller.dispose(); expect(f.root.canClose()).toBe(false);
});
it('failed shared reads preserve Header prior and never fabricate a second source', async () => {
  const f = fixture(); await f.root.header.ensure(); await f.root.header.select(key('b')); const prior = f.root.state().projection;
  f.request.mockRejectedValueOnce(new Error('read failure')); expect(await f.root.header.refresh()).toEqual({ status: 'failed' });
  expect(f.root.state().projection).toBe(prior); expect(f.root.state().issue).toBe('read'); expect(f.root.header.available()).toBe(false);
});
