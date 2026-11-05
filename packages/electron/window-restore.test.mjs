import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
const fixture = () => {
  const root = { desktopDefaultHostId: 'local' };
  const windows = [];
  const state = { mainWindow: null, sidecarUrl: 'http://localhost:3000', localOrigin: 'http://localhost:3000', quitRequested: false };
  const context = vm.createContext({
    state, URL, Number, readSettingsRoot: () => root,
    readDesktopHostsConfig: () => ({ hosts: [{ id: 'remote', url: 'http://remote.example:3000' }] }),
    BrowserWindow: { getAllWindows: () => windows },
    mutateSettingsRoot: async (mutate) => mutate(root),
    MIN_WINDOW_WIDTH: 350, MIN_WINDOW_HEIGHT: 400,
    isLocalRuntimeUrl: (url) => url === state.sidecarUrl,
    normalizeHostUrl: (url) => url,
    sameOrigin: (a, b) => Boolean(a && b && new URL(a).origin === new URL(b).origin),
  });
  const start = source.indexOf('const readWindowState =');
  const end = source.indexOf('const debounceWindowStatePersist =');
  vm.runInContext(`${source.slice(start, end)}\nglobalThis.save = writeWindowState; globalThis.read = typeof readWindowStates === 'function' ? readWindowStates : () => [];`, context);
  const addWindow = (id, hostId, route) => {
    const win = {
      id, __yuriHostId: hostId, __yuriLabel: id === 1 ? 'main' : `main-${id}`,
      __yuriRuntimeConfig: { apiBaseUrl: hostId === 'local' ? state.sidecarUrl : 'http://remote.example:3000' },
      isDestroyed: () => false, isMaximized: () => id === 2, isFullScreen: () => id === 1,
      getBounds: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
      getNormalBounds: () => ({ x: id * 20, y: 30, width: 900, height: 700 }),
      webContents: { getURL: () => `yuri-ui://app${route}` },
    };
    windows.push(win);
    state.mainWindow ||= win;
    return win;
  };
  return { root, windows, state, context, addWindow, save: context.save, read: context.read };
};

describe('desktop window session persistence', () => {
  it('keeps each window host, route, normal geometry and display mode across restart', async () => {
    const f = fixture();
    const main = f.addWindow(1, 'remote', '/session/session-one');
    f.addWindow(2, 'local', '/assistant/bot-two?token=not-persisted');
    await f.save(main);
    expect(f.read()).toEqual([
      expect.objectContaining({ hostId: 'remote', route: '/session/session-one', x: 20, width: 900, fullscreen: true }),
      expect.objectContaining({ hostId: 'local', route: '/assistant/bot-two', x: 40, maximized: true }),
    ]);
    expect(JSON.stringify(f.root)).not.toContain('not-persisted');
    expect(f.root.desktopDefaultHostId).toBe('local');
  });

  it('persists additional windows instead of discarding their changes', async () => {
    const f = fixture();
    f.addWindow(1, 'local', '/index.html');
    const remote = f.addWindow(2, 'remote', '/session/second');
    await f.save(remote);
    expect(f.read()).toHaveLength(2);
    expect(f.read()[1].hostId).toBe('remote');
  });

  it('restores independent plugin page identities without query or hash state', async () => {
    const f = fixture();
    const main = f.addWindow(1, 'remote', '/plugins/%40example%2Fplugin.js/report.json?view=private#detail');
    await f.save(main);
    expect(f.read()[0]).toMatchObject({ hostId: 'remote', route: '/plugins/%40example%2Fplugin.js/report.json' });
    expect(JSON.stringify(f.root)).not.toContain('private');
    expect(JSON.stringify(f.root)).not.toContain('detail');
  });

  it('retains legacy single-window geometry when there is no saved window session', () => {
    const f = fixture();
    f.root.desktopWindowState = { width: 1000, height: 750 };
    expect(f.read()).toEqual([]);
  });

  it('ignores malformed saved entries and removes credentials from routes', () => {
    const f = fixture();
    f.root.desktopWindowStates = [null, { hostId: 'remote' }, { hostId: 'remote', width: -1, height: 500 },
      { hostId: 'remote', width: 900, height: 700, route: '/session/one?token=secret#private', clientToken: 'secret' }];
    expect(f.read()).toEqual([expect.objectContaining({ hostId: 'remote', route: '/session/one' })]);
    expect(JSON.stringify(f.read())).not.toContain('secret');
  });

  it('does not replace the snapshot while windows are being restored or closed for quit', async () => {
    const f = fixture();
    const main = f.addWindow(1, 'remote', '/session/one');
    await f.save(main);
    const saved = JSON.stringify(f.root);
    vm.runInContext('windowSessionFrozen = true;', f.context);
    f.windows.pop();
    await f.save(main);
    expect(JSON.stringify(f.root)).toBe(saved);
  });

  it('failed persistence preserves the previous snapshot and can be retried', async () => {
    const f = fixture();
    const main = f.addWindow(1, 'remote', '/session/one');
    await f.save(main);
    const saved = JSON.stringify(f.root);
    f.context.mutateSettingsRoot = async () => { throw new Error('disk unavailable'); };
    main.__yuriHostId = 'local';
    await expect(f.save(main)).rejects.toThrow('disk unavailable');
    expect(JSON.stringify(f.root)).toBe(saved);
    f.context.mutateSettingsRoot = async (mutate) => mutate(f.root);
    await f.save(main);
    expect(f.read()[0].hostId).toBe('local');
  });
});

describe('committed window runtime', () => {
  const runtimeFixture = () => {
    const f = fixture();
    const main = f.addWindow(1, 'local', '/session/one');
    Object.assign(f.context, {
      LOCAL_HOST_ID: 'local', guiPluginHost: { invalidateWindow: vi.fn() },
      readDesktopLocalClientToken: () => 'fixture-local-token', sanitizeRuntimeRequestHeaders: (value) => value,
      computeBootOutcome: ({ config }) => ({ target: config.defaultHostId === 'local' ? 'local' : 'remote', status: 'ok' }),
      buildInitScript: () => 'fixture-init',
    });
    const commands = source.slice(source.indexOf("    case 'desktop_window_runtime_set':"), source.indexOf("    case 'desktop_hosts_get':"));
    vm.runInContext(`globalThis.invoke = async (browserWindow, args) => { switch ('desktop_window_runtime_set') { ${commands} } };`, f.context);
    return { ...f, main, invoke: (args) => f.context.invoke(main, args) };
  };

  it('persists only the Host identity and uses saved credentials rather than renderer input', async () => {
    const f = runtimeFixture();
    await f.invoke({ runtimeKey: 'host:remote', apiBaseUrl: 'http://remote.example:3000', clientToken: 'untrusted-token' });
    expect(f.main.__yuriHostId).toBe('remote');
    expect(f.read()[0].hostId).toBe('remote');
    expect(f.main.__yuriRuntimeConfig.clientToken).toBe('');
    expect(JSON.stringify(f.root)).not.toContain('untrusted-token');
  });

  it.each([
    { runtimeKey: 'host:missing', apiBaseUrl: 'http://remote.example:3000' },
    { runtimeKey: 'host:remote', apiBaseUrl: 'http://unknown.example:3000' },
    { runtimeKey: 'local', apiBaseUrl: 'http://remote.example:3000' },
  ])('rejects an unknown Host/endpoint without changing the saved instance: $runtimeKey', async (args) => {
    const f = runtimeFixture();
    await expect(f.invoke(args)).rejects.toThrow();
    expect(f.main.__yuriHostId).toBe('local');
    expect(f.read()).toEqual([]);
  });
});

describe('startup instance resolution', () => {
  it.each([
    { saved: [{ hostId: 'remote' }], expected: 'remote' },
    { saved: [], expected: 'local' },
  ])('initial startup uses $expected without overwriting the explicit default', async ({ saved, expected }) => {
    const resolveTarget = vi.fn(async (hostId) => ({ hostId }));
    const context = vm.createContext({
      process: { env: {} }, URL, isDev: false, state: {},
      spawnLocalServer: async () => 'http://localhost:3000',
      shouldUsePackagedUi: () => true, buildPackagedUiUrl: () => 'yuri-ui://app/index.html', packagedUiOrigin: () => 'yuri-ui://app',
      urlIdentityKey: (url) => new URL(url).origin,
      readDesktopLocalClientToken: () => '', normalizeHostUrl: (url) => url,
      readDesktopHostsConfig: () => ({ hosts: [], defaultHostId: 'local' }),
      readWindowStates: () => saved, resolveDesktopStartupTarget: resolveTarget,
    });
    vm.runInContext(`${source.slice(source.indexOf('const resolveInitialUrl ='), source.indexOf('let desktopUpdateActionBusy ='))}\nglobalThis.start = resolveInitialUrl;`, context);
    expect(await context.start()).toMatchObject({ hostId: expected });
    expect(resolveTarget).toHaveBeenCalledWith(expected, expect.objectContaining({ localUrl: 'http://localhost:3000' }));
  });

  const startup = (mode, hostOverrides = {}) => {
    const host = { id: 'remote', url: 'http://remote.example:3000', clientToken: 'fixture-token', ...hostOverrides };
    const connect = vi.fn(async () => {});
    const probe = vi.fn(async () => ({ status: 'ok' }));
    const context = vm.createContext({
      readDesktopHostsConfig: () => ({ hosts: [host], defaultHostId: 'local' }),
      sshManager: { readInstances: () => ({ instances: hostOverrides.ssh ? [{ id: host.id }] : [] }), connect },
      readDesktopLocalClientToken: () => 'fixture-local-token',
      sanitizeRuntimeRequestHeaders: (headers) => headers,
      shouldUsePackagedUi: () => mode === 'bundled', probeHostWithTimeout: probe,
      computeBootOutcome: ({ config, probe }) => ({ target: config.defaultHostId === 'local' ? 'local' : 'remote', status: probe?.status || 'ok', hostId: config.defaultHostId }),
    });
    vm.runInContext(`${source.slice(source.indexOf('const resolveDesktopStartupTarget ='), source.indexOf('const restoreAdditionalDesktopWindows ='))}\nglobalThis.resolve = resolveDesktopStartupTarget;`, context);
    return { connect, probe, resolve: (id) => context.resolve(id, { localUrl: 'http://localhost:3000', localUiUrl: mode === 'bundled' ? 'yuri-ui://app/index.html' : 'http://localhost:5173', localOrigin: 'http://localhost:3000' }) };
  };

  for (const mode of ['HMR', 'bundled']) {
    it(`restores a remote window instead of the local default (${mode})`, async () => {
      const f = startup(mode, { ssh: true });
      expect(await f.resolve('remote')).toMatchObject({ hostId: 'remote', apiBaseUrl: 'http://remote.example:3000', bootOutcome: { target: 'remote', status: 'ok' } });
      expect(f.connect).toHaveBeenCalledWith('remote');
      expect(f.probe).toHaveBeenCalledOnce();
    });

    it(`defers Relay authentication to this window renderer without probing relay URLs (${mode})`, async () => {
      const f = startup(mode, { relay: { serverId: 'fixture-server' } });
      expect(await f.resolve('remote')).toMatchObject({ relayHostId: 'remote', apiBaseUrl: 'http://localhost:3000' });
      expect(f.probe).not.toHaveBeenCalled();
    });

    it(`restores a paired SSH host over Relay without requiring a new SSH connection (${mode})`, async () => {
      const f = startup(mode, { ssh: true, relay: { serverId: 'fixture-server' } });
      f.connect.mockRejectedValue(new Error('SSH unavailable on this network'));
      expect(await f.resolve('remote')).toMatchObject({ relayHostId: 'remote', bootOutcome: { target: 'remote', status: 'ok' } });
      expect(f.connect).not.toHaveBeenCalled();
      expect(f.probe).not.toHaveBeenCalled();
    });

    it(`failed SSH restoration remains a remote failure, not a successful local connection (${mode})`, async () => {
      const f = startup(mode, { ssh: true });
      f.connect.mockRejectedValue(new Error('offline'));
      expect(await f.resolve('remote')).toMatchObject({ hostId: 'remote', bootOutcome: { target: 'remote', status: 'unreachable' } });
      expect(f.probe).not.toHaveBeenCalled();
    });
  }
});

describe('first window preload after the startup splash', () => {
  const preload = readFileSync(new URL('./preload.mjs', import.meta.url), 'utf8');
  it.each(['yuri-ui://app/session/one', 'http://localhost:5173/session/one'])('reads the resolved window target before renderer modules execute: %s', (href) => {
    const globals = {};
    const runtime = {
      localOrigin: 'http://localhost:3000', apiBaseUrl: 'http://localhost:3000',
      clientToken: 'fixture-local-token', requestHeaders: {}, relayHostId: 'remote', localUiOrigin: 'http://localhost:5173',
      bootOutcome: { target: 'remote', status: 'ok', hostId: 'remote' },
    };
    const context = vm.createContext({
      process: { argv: ['electron', '--yuri-local-origin=', '--yuri-api-base-url=', '--yuri-boot-outcome=null'], platform: 'darwin' },
      location: { origin: new URL(href).origin, protocol: new URL(href).protocol, hostname: new URL(href).hostname, host: new URL(href).host },
      contextBridge: { exposeInMainWorld: (key, value) => { globals[key] = value; } },
      ipcRenderer: { sendSync: vi.fn(() => runtime), on: vi.fn() },
      window: { addEventListener() {} }, URL,
    });
    vm.runInContext(preload.slice(preload.indexOf('const eventListeners ='), preload.indexOf("window.addEventListener('yuri:runtime-endpoint-changed'")), context);
    expect(globals.__YURI_RELAY_HOST_ID__).toBe('remote');
    expect(globals.__YURI_LOCAL_ORIGIN__).toBe(runtime.localOrigin);
    expect(globals.__YURI_CLIENT_TOKEN__).toBe(runtime.clientToken);
    expect(globals.__YURI_DESKTOP_BOOT__.getOutcome()).toEqual(runtime.bootOutcome);
  });
});
