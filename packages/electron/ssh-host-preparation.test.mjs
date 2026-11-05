import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
const prepareSource = source.slice(source.indexOf('const prepareDesktopHost ='), source.indexOf('const handleInvoke ='));
const windowCases = source.slice(source.indexOf("    case 'desktop_new_window':"), source.indexOf("    case 'desktop_open_session_mini_chat_window':"));

const fixture = (ssh = true, packaged = true, local = true) => {
  let host = { id: 'ssh-test', url: 'http://127.0.0.1:4000', clientToken: 'old-test-token' };
  let finish;
  const connect = vi.fn(() => new Promise((resolve, reject) => {
    finish = (error) => {
      if (error) return reject(error);
      host = { ...host, url: 'http://127.0.0.1:5000', clientToken: 'new-test-token' };
      resolve();
    };
  }));
  const createWindow = vi.fn();
  const context = vm.createContext({
    URL,
    browserWindow: { webContents: {} },
    isLocalSender: () => local,
    readDesktopHostsConfig: () => ({ hosts: [host], defaultHostId: host.id }),
    sshManager: { readInstances: () => ({ instances: ssh ? [{ id: host.id }] : [] }), connect },
    LOCAL_HOST_ID: 'local',
    state: { localUiOrigin: 'http://localhost:5173', sidecarUrl: 'http://localhost:3000', unreachableHosts: new Set() },
    shouldUsePackagedUi: () => packaged,
    buildPackagedUiUrl: (route = '/index.html') => `yuri-ui://app${route}`,
    normalizeHostUrl: (url) => url,
    sanitizeClientTokenForStorage: (token) => token,
    sanitizeRuntimeRequestHeaders: (headers) => headers,
    resolveStoredClientTokenForUrl: () => '',
    readDesktopLocalClientToken: () => '',
    createAdditionalWindow: createWindow,
  });
  vm.runInContext(`${prepareSource}\nglobalThis.invoke = async (command, args = {}) => { switch (command) { ${windowCases} } };`, context);
  return { invoke: context.invoke, connect, createWindow, finish: (error) => finish(error) };
};

describe('SSH preparation before opening desktop windows', () => {
  for (const packaged of [false, true]) {
    for (const command of ['desktop_new_window', 'desktop_new_window_for_host', 'desktop_new_window_at_url']) {
      it(`${command} waits for preparation and fresh runtime (${packaged ? 'bundled' : 'HMR'})`, async () => {
        const f = fixture(true, packaged);
        const pending = f.invoke(command, { hostId: 'ssh-test', url: 'http://127.0.0.1:4000', clientToken: 'old-test-token' });
        expect(f.connect).toHaveBeenCalledWith('ssh-test');
        expect(f.createWindow).not.toHaveBeenCalled();
        f.finish();
        await pending;
        expect(f.createWindow).toHaveBeenCalledWith(
          packaged ? 'yuri-ui://app/index.html' : 'http://127.0.0.1:5000',
          expect.objectContaining({ apiBaseUrl: 'http://127.0.0.1:5000', clientToken: 'new-test-token' }),
        );
      });

      it(`${command} does not open on preparation failure (${packaged})`, async () => {
        const f = fixture(true, packaged);
        const pending = f.invoke(command, { hostId: 'ssh-test', url: 'http://127.0.0.1:4000' });
        f.finish(new Error('Update failed'));
        await expect(pending).rejects.toThrow('Update failed');
        expect(f.createWindow).not.toHaveBeenCalled();
      });
    }
  }

  it('leaves non-SSH hosts on their ordinary connection path', async () => {
    const f = fixture(false);
    await f.invoke('desktop_new_window_for_host', { hostId: 'ssh-test' });
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.createWindow).toHaveBeenCalledOnce();
  });

  it('preserves explicit credentials when opening a non-SSH URL', async () => {
    const f = fixture(false);
    await f.invoke('desktop_new_window_at_url', { url: 'http://127.0.0.1:4000', clientToken: 'explicit-test-token' });
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.createWindow).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ clientToken: 'explicit-test-token' }));
  });

  it('blocks SSH preparation through otherwise remote-safe window commands', async () => {
    const f = fixture(true, true, false);
    await expect(f.invoke('desktop_new_window_for_host', { hostId: 'ssh-test' })).rejects.toThrow('local desktop page');
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.createWindow).not.toHaveBeenCalled();
  });

  it('resolves a paired host in a window-only document without invoking SSH', async () => {
    const host = { id: 'paired-ssh', relay: { serverId: 'fixture' } };
    const connect = vi.fn();
    const context = vm.createContext({
      readDesktopHostsConfig: () => ({ hosts: [host] }), isLocalSender: () => false,
      sshManager: { readInstances: () => ({ instances: [{ id: host.id }] }), connect },
    });
    vm.runInContext(`${prepareSource}\nglobalThis.prepare = prepareDesktopHost;`, context);
    await expect(context.prepare(host.id, { webContents: {} })).resolves.toEqual(host);
    expect(connect).not.toHaveBeenCalled();
  });

  it.each([true, false])('opens an isolated local manager without giving its credentials to the remote caller (bundled: %s)', async (packaged) => {
    const f = fixture(true, packaged, false);
    await expect(f.invoke('desktop_open_local_host_settings', { clientToken: 'untrusted-token' })).resolves.toBeNull();
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.createWindow).toHaveBeenCalledWith(
      packaged ? 'yuri-ui://app/settings/remote-instances' : 'http://localhost:5173/settings/remote-instances',
      expect.objectContaining({ hostId: 'local', apiBaseUrl: 'http://localhost:3000', clientToken: '', relayHostId: '' }),
    );
  });

  it('restores the prior instance if the clean local navigation fails', async () => {
    const previous = { __yuriHostId: 'remote', __yuriRuntimeConfig: { apiBaseUrl: 'http://remote.invalid' },
      __yuriBootOutcome: { target: 'remote', status: 'ok' }, __yuriInitScript: 'remote-script' };
    const browserWindow = { ...previous, isDestroyed: () => false };
    const scheduled = [];
    const context = vm.createContext({
      browserWindow, URL, LOCAL_HOST_ID: 'local', state: { localOrigin: 'http://localhost:3000', localUiOrigin: 'http://localhost:5173' },
      shouldUsePackagedUi: () => false, buildRendererRuntimeConfig: (_url, runtime) => runtime,
      readDesktopLocalClientToken: () => 'fixture-local-token', buildInitScript: () => 'local-script',
      setImmediate: run => scheduled.push(run), navigateWindow: vi.fn(async () => { throw new Error('Navigation failed'); }), log: { warn: vi.fn() },
    });
    vm.runInContext(`globalThis.invoke = async () => { switch ('desktop_switch_to_local') { ${windowCases} } };`, context);
    await context.invoke();
    await context.invoke();
    expect(scheduled).toHaveLength(1);
    expect(browserWindow.__yuriHostId).toBe('local');
    scheduled[0]();
    await Promise.resolve();
    await Promise.resolve();
    expect(browserWindow).toMatchObject(previous);
    expect(browserWindow.__yuriLocalNavigation).toBeNull();
  });

  it('returns the refreshed host to the runtime switch only after preparation', async () => {
    const f = fixture();
    const pending = f.invoke('desktop_host_prepare', { hostId: 'ssh-test' });
    f.finish();
    await expect(pending).resolves.toMatchObject({ url: 'http://127.0.0.1:5000', clientToken: 'new-test-token' });
  });
});
